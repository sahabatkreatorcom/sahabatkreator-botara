import { Hono } from "hono";
import { z } from "zod";
import {
  AcceptInvitationResponseSchema,
  CreateInvitationRequestSchema,
  InvitationListResponseSchema,
  InvitationPreviewResponseSchema,
  InvitationResponseSchema,
  TeamMemberListResponseSchema,
  UpdateMemberRoleRequestSchema,
  type InvitationResponse,
  type TeamMemberResponse,
} from "@sahabat-kreator/contracts";
import {
  acceptInvitation,
  createInvitation,
  findInvitationByToken,
  invitationStatus,
  isTeamManager,
  listInvitations,
  listTeamMembers,
  queueInvitationEmail,
  removeMember,
  resolveEmailConfig,
  revokeInvitation,
  updateMemberRole,
  type Invitation,
  type PlatformSettingsOptions,
  type TeamMemberRow,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul team (Fase 9C) — tim workspace & undangan:
 *   GET    /tenants/:tenantId/team/members              daftar member + peran (semua member)
 *   GET    /tenants/:tenantId/team/invitations          daftar undangan (owner/admin)
 *   POST   /tenants/:tenantId/team/invitations          undang via email (owner/admin) → tautan sekali lihat
 *   DELETE /tenants/:tenantId/team/invitations/:id      cabut undangan pending (owner/admin)
 *   PATCH  /tenants/:tenantId/team/members/:userId      ganti peran (owner/admin)
 *   DELETE /tenants/:tenantId/team/members/:userId      keluarkan member (owner/admin)
 *   GET    /invitations/:token                          pratinjau undangan (sesi login)
 *   POST   /invitations/:token/accept                   terima undangan (sesi login, email harus sama)
 *
 * Gerbang peran: membaca daftar member untuk semua member; seluruh
 * mutasi tim owner/admin (route memeriksa `tenant.role`, invariant
 * owner & larangan self-action ditegakkan di core `team.ts`).
 * Tautan dikembalikan SEKALI pada respons pembuatan untuk disalin
 * pengundang — server hanya menyimpan hash tokennya.
 * Email undangan (Fase 11B): bila email platform (Resend) terkonfigurasi,
 * pembuatan juga mengantrekan pengiriman email lewat outbox → job
 * worker (respons TIDAK menunggu pengiriman) dan respons menyatakan
 * `emailDelivery: "queued"`; tanpa konfigurasi email, respons
 * menyatakan `"not_configured"` dan tautan salin tetap satu-satunya
 * jalur — sama seperti perilaku 9C.
 */
export interface TeamRoutesOptions {
  /** Basis URL publik web (untuk merakit tautan undangan utuh). */
  publicBaseUrl?: string;
  /**
   * Opsi resolver Panel Admin (Fase 11B): dipakai untuk memutuskan
   * apakah email undangan bisa diantrekan (konfigurasi Resend efektif).
   * Tanpa opsi ini pengiriman email selalu "not_configured".
   */
  platform?: PlatformSettingsOptions;
  /**
   * Secret env untuk mengenkripsi token undangan ke payload outbox
   * (CHANNEL_TOKEN_SECRET) — token mentah tidak pernah disimpan.
   */
  channelTokenSecret?: string;
}

function serializeMember(
  row: TeamMemberRow,
  selfUserId: string,
): TeamMemberResponse {
  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    isSelf: row.userId === selfUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeInvitation(
  row: Invitation,
  inviteUrl: string | null,
  emailDelivery: "queued" | "not_configured" | null = null,
): InvitationResponse {
  return InvitationResponseSchema.parse({
    id: row.id,
    email: row.email,
    // Peran undangan di DB adalah enum member penuh; undangan tidak
    // pernah berperan owner (dijaga core + kontrak buat).
    role: row.role === "owner" ? "agent" : row.role,
    status: invitationStatus(row),
    inviteUrl,
    emailDelivery,
    emailSentAt: row.emailSentAt?.toISOString() ?? null,
    emailError: row.emailError ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}

export function createTeamRoutes(
  bundle: AuthBundle | null,
  opts: TeamRoutesOptions = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const membersBase = "/tenants/:tenantId/team/members";
  const invitationsBase = "/tenants/:tenantId/team/invitations";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(membersBase, unavailable);
    app.get(invitationsBase, unavailable);
    app.post(invitationsBase, unavailable);
    app.delete(`${invitationsBase}/:id`, unavailable);
    app.patch(`${membersBase}/:userId`, unavailable);
    app.delete(`${membersBase}/:userId`, unavailable);
    app.get("/invitations/:token", unavailable);
    app.post("/invitations/:token/accept", unavailable);
    return app;
  }

  const auth = requireAuth(bundle);
  app.use("/invitations/*", auth);

  type GuardOk = {
    tenant: NonNullable<Awaited<ReturnType<typeof resolveTenantForUser>>>;
    appUser: { id: string; email: string };
  };
  async function guard(c: AppContext): Promise<GuardOk | { error: Response }> {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle!,
      c.req.param("tenantId") ?? "",
      appUser.id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      };
    }
    return { tenant, appUser: { id: appUser.id, email: appUser.email } };
  }

  function parseUuidParam(c: AppContext, name: string): string | null {
    const id = c.req.param(name);
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  // ---- Daftar member --------------------------------------------------------
  app.get(membersBase, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    const rows = await listTeamMembers(bundle.db, { tenantId: g.tenant.id });
    const body = TeamMemberListResponseSchema.parse({
      members: rows.map((row) => serializeMember(row, g.appUser.id)),
    });
    return c.json(body);
  });

  // ---- Daftar undangan (owner/admin) ----------------------------------------
  app.get(invitationsBase, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    if (!isTeamManager(g.tenant.role)) {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can view invitations");
    }
    const rows = await listInvitations(bundle.db, { tenantId: g.tenant.id });
    const body = InvitationListResponseSchema.parse({
      // Tautan hanya ada pada respons pembuatan (sekali lihat) — daftar
      // selalu inviteUrl null karena server hanya menyimpan hash token.
      invitations: rows.map((row) => serializeInvitation(row, null)),
    });
    return c.json(body);
  });

  // ---- Buat undangan (owner/admin) -------------------------------------------
  app.post(invitationsBase, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    if (!isTeamManager(g.tenant.role)) {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can invite members");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateInvitationRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid invitation payload");
    }
    const result = await createInvitation(bundle.db, {
      tenantId: g.tenant.id,
      actorUserId: g.appUser.id,
      email: parsed.data.email,
      role: parsed.data.role,
    });
    if (result.kind === "already_member") {
      return apiError(
        c,
        409,
        "INVITATION_ALREADY_MEMBER",
        "That email already belongs to a member of this workspace",
      );
    }
    const base = (opts.publicBaseUrl ?? "").replace(/\/+$/, "");
    const inviteUrl = `${base}/invite/${result.token}`;
    // Fase 11B: antrekan email undangan bila email platform
    // terkonfigurasi. Keputusan dibuat di sini (bukan di job) agar
    // respons bisa menyatakan statusnya dengan jujur; event outbox
    // membawa token sebagai ciphertext (lihat core email.ts).
    // Kegagalan antre tidak menggagalkan undangan yang sudah tercipta.
    let emailDelivery: "queued" | "not_configured" = "not_configured";
    if (opts.platform) {
      try {
        const emailConfig = await resolveEmailConfig(bundle.db, opts.platform);
        if (emailConfig) {
          const queued = await queueInvitationEmail(bundle.db, {
            tenantId: g.tenant.id,
            invitationId: result.invitation.id,
            token: result.token,
            encryptionSecret: opts.channelTokenSecret,
          });
          if (queued) emailDelivery = "queued";
        }
      } catch (err) {
        console.error(
          "[api] antre email undangan gagal (undangan tetap sah):",
          err,
        );
      }
    }
    return c.json(
      serializeInvitation(result.invitation, inviteUrl, emailDelivery),
      201,
    );
  });

  // ---- Cabut undangan (owner/admin) ------------------------------------------
  app.delete(`${invitationsBase}/:id`, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    if (!isTeamManager(g.tenant.role)) {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can revoke invitations");
    }
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Invitation not found");
    const result = await revokeInvitation(bundle.db, {
      tenantId: g.tenant.id,
      actorUserId: g.appUser.id,
      invitationId: id,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Invitation not found");
    }
    if (result.kind === "not_pending") {
      return apiError(
        c,
        422,
        "INVITATION_REVOKED",
        "Only a pending invitation can be revoked",
      );
    }
    return c.body(null, 204);
  });

  // ---- Ganti peran (owner/admin) ----------------------------------------------
  app.patch(`${membersBase}/:userId`, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    if (!isTeamManager(g.tenant.role)) {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can change roles");
    }
    const userId = parseUuidParam(c, "userId");
    if (!userId) return apiError(c, 404, "NOT_FOUND", "Member not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateMemberRoleRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid role payload");
    }
    const result = await updateMemberRole(bundle.db, {
      tenantId: g.tenant.id,
      actorUserId: g.appUser.id,
      targetUserId: userId,
      role: parsed.data.role,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Member not found");
    }
    if (result.kind === "owner_protected") {
      return apiError(c, 422, "TEAM_OWNER_PROTECTED", "The workspace owner's role cannot be changed");
    }
    if (result.kind === "self_action") {
      return apiError(c, 422, "TEAM_SELF_ACTION", "You cannot change your own role");
    }
    const rows = await listTeamMembers(bundle.db, { tenantId: g.tenant.id });
    const updated = rows.find((row) => row.userId === userId);
    if (!updated) return apiError(c, 404, "NOT_FOUND", "Member not found");
    return c.json(serializeMember(updated, g.appUser.id));
  });

  // ---- Keluarkan member (owner/admin) -------------------------------------------
  app.delete(`${membersBase}/:userId`, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    if (!isTeamManager(g.tenant.role)) {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can remove members");
    }
    const userId = parseUuidParam(c, "userId");
    if (!userId) return apiError(c, 404, "NOT_FOUND", "Member not found");
    const result = await removeMember(bundle.db, {
      tenantId: g.tenant.id,
      actorUserId: g.appUser.id,
      targetUserId: userId,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Member not found");
    }
    if (result.kind === "owner_protected") {
      return apiError(c, 422, "TEAM_OWNER_PROTECTED", "The workspace owner cannot be removed");
    }
    if (result.kind === "self_action") {
      return apiError(c, 422, "TEAM_SELF_ACTION", "You cannot remove yourself");
    }
    return c.body(null, 204);
  });

  // ---- Sisi penerima: pratinjau + terima -----------------------------------------
  app.get("/invitations/:token", async (c) => {
    const appUser = c.get("appUser");
    const lookup = await findInvitationByToken(bundle.db, c.req.param("token") ?? "");
    if (!lookup) return apiError(c, 404, "NOT_FOUND", "Invitation not found");
    const { invitation, tenantName } = lookup;
    const body = InvitationPreviewResponseSchema.parse({
      tenantId: invitation.tenantId,
      tenantName,
      email: invitation.email,
      role: invitation.role === "owner" ? "agent" : invitation.role,
      status: invitationStatus(invitation),
      emailMatches:
        invitation.email.toLowerCase() === appUser.email.toLowerCase(),
      expiresAt: invitation.expiresAt.toISOString(),
    });
    return c.json(body);
  });

  app.post("/invitations/:token/accept", async (c) => {
    const appUser = c.get("appUser");
    const result = await acceptInvitation(bundle.db, {
      token: c.req.param("token") ?? "",
      userId: appUser.id,
      email: appUser.email,
    });
    switch (result.kind) {
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Invitation not found");
      case "already_accepted":
        return apiError(c, 422, "INVITATION_ALREADY_ACCEPTED", "This invitation has already been accepted");
      case "revoked":
        return apiError(c, 422, "INVITATION_REVOKED", "This invitation has been revoked");
      case "expired":
        return apiError(c, 422, "INVITATION_EXPIRED", "This invitation has expired");
      case "email_mismatch":
        return apiError(
          c,
          403,
          "INVITATION_EMAIL_MISMATCH",
          "This invitation was issued to a different email address",
        );
      case "accepted":
        return c.json(
          AcceptInvitationResponseSchema.parse({
            tenantId: result.tenantId,
            role: result.role,
          }),
        );
    }
  });

  return app;
}
