import { Hono } from "hono";
import { z } from "zod";
import {
  AssignConversationRequestSchema,
  ConversationListResponseSchema,
  ConversationResponseSchema,
  ConversationStatusSchema,
  MessageListResponseSchema,
  SendMessageRequestSchema,
  type ConversationResponse,
} from "@sahabat-kreator/contracts";
import {
  assignConversation,
  listConversations,
  listMessages,
  listProfilePhotoOwnerIds,
  markConversationRead,
  queueOutboundMessage,
  type ConversationWithSummary,
} from "@sahabat-kreator/core";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { contactAvatarUrl } from "../avatars/routes";
import { serializeMessage } from "../messages-serialize";
import { resolveTenantForUser } from "../tenants/guard";

export function serializeConversation(
  row: ConversationWithSummary,
  contactAvatarUrlValue: string | null = null,
): ConversationResponse {
  return ConversationResponseSchema.parse({
    id: row.id,
    channelAccountId: row.channelAccountId,
    contactId: row.contactId,
    contactName: row.contactName,
    contactAvatarUrl: contactAvatarUrlValue,
    title: row.title,
    isGroup: row.isGroup,
    isChannel: row.isChannel,
    provider: row.provider,
    status: row.status,
    assigneeUserId: row.assigneeUserId,
    assigneeName: row.assigneeName,
    agentEnabled: row.agentEnabled,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageDirection: row.lastMessageDirection,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

const ListConversationsQuerySchema = z.object({
  status: ConversationStatusSchema.optional(),
  // Fase 9C: filter penugasan — mine (milik user sesi) | unassigned.
  assignment: z.enum(["mine", "unassigned"]).optional(),
});

const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Modul inbox (Fase 1D) — route bersarang di workspace:
 *   GET  /tenants/:tenantId/conversations                 daftar + nama kontak + cuplikan pesan terakhir (?status=, ?assignment=mine|unassigned)
 *   GET  /tenants/:tenantId/conversations/:id/messages    pesan kronologis (?limit=)
 *   POST /tenants/:tenantId/conversations/:id/messages    balasan manual → pesan outbound status `queued`
 *   POST /tenants/:tenantId/conversations/:id/assign      tetapkan/lepas penerima tugas (Fase 9C)
 * POST adalah fondasi inbox manual: pesan diantrekan + diaudit
 * (message.queued). Pengiriman sungguhannya: Telegram lewat poller Bot
 * API; webchat sejak Fase 6G lewat apps/realtime — route ini cukup
 * menerbitkan nudge `message.queued` setelah pesan ter-commit, dan
 * realtime mem-flush (→ `sent`) + mendorong nudge ke pengunjung yang
 * sedang terhubung. Pengunjung offline tetap `queued` sampai reconnect.
 * Wajib sesi + membership (pola Fase 1B/1D).
 */
export function createInboxRoutes(
  bundle: AuthBundle | null,
  publisher?: RealtimePublisher | null,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/conversations";

  if (!bundle) {
    app.get(base, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/:id/messages`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/:id/messages`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/:id/assign`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    return app;
  }


  app.get(base, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const query = ListConversationsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const rows = await listConversations(
      bundle.db,
      { tenantId: tenant.id },
      {
        ...query.data,
        assignmentUserId: c.get("appUser").id,
      },
    );
    // Fase 6D: foto kontak jangkar tiap percakapan (endpoint avatar kita
    // sendiri) — himpunan pemilik berfoto dihitung sekali per daftar.
    const withPhoto = await listProfilePhotoOwnerIds(
      bundle.db,
      { tenantId: tenant.id },
      "contact",
      rows.map((row) => row.contactId),
    );
    const body = ConversationListResponseSchema.parse({
      conversations: rows.map((row) =>
        serializeConversation(
          row,
          withPhoto.has(row.contactId)
            ? contactAvatarUrl(tenant.id, row.contactId)
            : null,
        ),
      ),
    });
    return c.json(body);
  });

  app.get(`${base}/:id/messages`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    const query = ListMessagesQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const rows = await listMessages(bundle.db, { tenantId: tenant.id }, id, query.data);
    if (!rows) return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    // Membuka utas dari inbox = membaca: bersihkan unread_count agar chip
    // daftar & badge navigasi konsisten (bug QA-1 — sebelumnya unread
    // tidak pernah turun). Hanya jalur manusia ini; agent membaca riwayat
    // lewat core langsung dan tidak menandai terbaca.
    await markConversationRead(bundle.db, { tenantId: tenant.id }, id);
    const body = MessageListResponseSchema.parse({
      messages: rows.map(serializeMessage),
    });
    return c.json(body);
  });

  app.post(`${base}/:id/messages`, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = SendMessageRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid message payload");
    }
    const result = await queueOutboundMessage(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      id,
      parsed.data,
    );
    if (result.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    if (result.kind === "reply_target_invalid") {
      // Fase 7B.5: target kutipan harus pesan di percakapan yang sama.
      return apiError(
        c,
        422,
        "MESSAGE_REPLY_TARGET_INVALID",
        "Reply target must be a message in this conversation",
      );
    }
    const queued = result.message;

    // Fase 6G: nudge setelah commit — apps/realtime mem-flush pesan ini
    // ke pengunjung webchat yang terhubung (→ `sent`) dan dashboard
    // lain di tenant yang sama menyegar. Respons tetap membawa baris
    // `queued` apa adanya; status final dibaca dari GET berikutnya
    // (sumber kebenaran REST, seperti jalur automation/agent).
    if (publisher) {
      await publisher.publishNudge({
        kind: "message.queued",
        tenantId: tenant.id,
        conversationId: id,
      });
    }
    return c.json(serializeMessage(queued), 201);
  });

  // Fase 9C: tetapkan / lepas penerima tugas. Semua member boleh
  // menugaskan (ke member mana pun, termasuk diri sendiri); penerima
  // yang bukan member → 422 ASSIGNEE_NOT_MEMBER dari core. Respons =
  // percakapan terbarui dalam bentuk serializer daftar yang sama (baris
  // tunggal diambil ulang lewat getConversation + resolusi nama kontak/
  // penerima agar bentuknya identik dengan item daftar).
  app.post(`${base}/:id/assign`, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = AssignConversationRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid assignment payload");
    }
    const result = await assignConversation(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      id,
      parsed.data.assigneeUserId,
    );
    if (result.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    if (result.kind === "assignee_not_member") {
      return apiError(
        c,
        422,
        "ASSIGNEE_NOT_MEMBER",
        "Assignee must be a member of this workspace",
      );
    }
    const rows = await listConversations(
      bundle.db,
      { tenantId: tenant.id },
      { assignmentUserId: appUser.id },
    );
    const updated = rows.find((row) => row.id === id);
    if (!updated) {
      // Hanya terjadi bila channel percakapan ini berada di Sampah —
      // permukaan inbox memang tidak menampilkannya (pola Fase 6I),
      // jadi bagi inbox percakapan itu tidak ada.
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    const withPhoto = await listProfilePhotoOwnerIds(
      bundle.db,
      { tenantId: tenant.id },
      "contact",
      [updated.contactId],
    );
    return c.json(
      serializeConversation(
        updated,
        withPhoto.has(updated.contactId)
          ? contactAvatarUrl(tenant.id, updated.contactId)
          : null,
      ),
    );
  });

  return app;
}
