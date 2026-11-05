import { Hono } from "hono";
import { z } from "zod";
import {
  BroadcastAbResultsResponseSchema,
  BroadcastAudiencePreviewQuerySchema,
  BroadcastAudiencePreviewResponseSchema,
  BroadcastListQuerySchema,
  BroadcastListResponseSchema,
  BroadcastRecipientListQuerySchema,
  BroadcastRecipientListResponseSchema,
  BroadcastResponseSchema,
  CreateBroadcastRequestSchema,
  OptInSettingsResponseSchema,
  ScheduleBroadcastRequestSchema,
  UpdateBroadcastRequestSchema,
  UpdateOptInSettingsRequestSchema,
  type BroadcastResponse,
} from "@sahabat-kreator/contracts";
import {
  DEFAULT_OPT_OUT_KEYWORDS,
  cancelBroadcast,
  createBroadcast,
  deleteBroadcast,
  getBroadcast,
  getBroadcastAbResults,
  getOptInSettings,
  listBroadcastRecipients,
  listBroadcasts,
  previewBroadcastAudience,
  scheduleBroadcast,
  updateBroadcast,
  updateOptInSettings,
  type BroadcastStats,
  type BroadcastWithChannel,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul broadcasts (Fase 7C) — kampanye siaran teks per channel:
 *   GET    /tenants/:tenantId/broadcasts                 daftar + statistik
 *   POST   /tenants/:tenantId/broadcasts                 buat draft
 *   GET    /tenants/:tenantId/broadcasts/audience-preview  pratinjau audiens (13C)
 *   GET    /tenants/:tenantId/opt-in-settings            pengaturan opt-in (13C)
 *   PATCH  /tenants/:tenantId/opt-in-settings            ubah (owner/admin)
 *   GET    /tenants/:tenantId/broadcasts/:id             detail + statistik
 *   PATCH  /tenants/:tenantId/broadcasts/:id             edit (draft saja)
 *   DELETE /tenants/:tenantId/broadcasts/:id             hapus (draft saja)
 *   POST   /tenants/:tenantId/broadcasts/:id/schedule    jadwalkan / kirim sekarang
 *   POST   /tenants/:tenantId/broadcasts/:id/cancel      batalkan
 *   GET    /tenants/:tenantId/broadcasts/:id/recipients  penerima berpaginasi
 *   GET    /tenants/:tenantId/broadcasts/:id/ab-results  rincian per varian A/B (13D)
 *
 * Eksekusi pengiriman BUKAN di sini: schedule menulis event outbox
 * `broadcast.dispatch_due`; worker yang men-dispatch (materialisasi
 * penerima + pesan `queued`) dan poller telegram/meta yang mengirim.
 *
 * AKSES (keputusan Fase 7C, terdokumentasi): mutasi (buat/edit/hapus/
 * jadwalkan/batalkan) = OWNER/ADMIN — broadcast adalah pengiriman
 * massal keluar, setara sensitivitasnya dengan mengelola channel.
 * Baca (daftar/detail/penerima/estimasi) = semua member workspace —
 * data kampanye bersama, selaras daftar kontak/automation. Non-member
 * selalu 404 TENANT_NOT_FOUND agar eksistensi tenant tidak bocor.
 *
 * Gerbang channel ditegakkan core: provider webchat →
 * 422 BROADCAST_CHANNEL_UNSUPPORTED (tanpa semantik push);
 * WhatsApp (Fase 10A) hanya lewat template: tanpa template →
 * 422 BROADCAST_TEMPLATE_REQUIRED, template belum APPROVED →
 * 422 BROADCAST_TEMPLATE_NOT_APPROVED (diperiksa saat buat/edit/
 * jadwalkan); jadwalkan pada channel yang tidak `connected` →
 * 409 CHANNEL_DISCONNECTED; transisi status tidak sah →
 * 409 BROADCAST_INVALID_STATE.
 */

export function serializeBroadcast(
  broadcast: BroadcastWithChannel,
  stats: BroadcastStats,
): BroadcastResponse {
  return BroadcastResponseSchema.parse({
    id: broadcast.id,
    channelAccountId: broadcast.channelAccountId,
    provider: broadcast.provider,
    channelDisplayName: broadcast.channelDisplayName,
    name: broadcast.name,
    messageText: broadcast.messageText,
    whatsappTemplateId: broadcast.whatsappTemplateId ?? null,
    templateVariableSources: broadcast.templateVariableSources ?? [],
    audienceFilter: broadcast.audienceFilter ?? {},
    requireOptIn: broadcast.requireOptIn ?? false,
    status: broadcast.status,
    scheduledAt: broadcast.scheduledAt?.toISOString() ?? null,
    startedAt: broadcast.startedAt?.toISOString() ?? null,
    completedAt: broadcast.completedAt?.toISOString() ?? null,
    errorCode: broadcast.errorCode,
    createdByUserId: broadcast.createdByUserId,
    createdAt: broadcast.createdAt.toISOString(),
    updatedAt: broadcast.updatedAt.toISOString(),
    stats,
  });
}

const EMPTY_STATS: BroadcastStats = {
  total: 0,
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
};

export function createBroadcastsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/broadcasts";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.get(`${base}/audience-preview`, unavailable);
    app.get("/tenants/:tenantId/opt-in-settings", unavailable);
    app.patch("/tenants/:tenantId/opt-in-settings", unavailable);
    app.get(`${base}/:id`, unavailable);
    app.patch(`${base}/:id`, unavailable);
    app.delete(`${base}/:id`, unavailable);
    app.post(`${base}/:id/schedule`, unavailable);
    app.post(`${base}/:id/cancel`, unavailable);
    app.get(`${base}/:id/recipients`, unavailable);
    app.get(`${base}/:id/ab-results`, unavailable);
    return app;
  }

  const auth = requireAuth(bundle);
  app.use("/tenants/*", auth);

  type GuardOk = {
    tenant: NonNullable<Awaited<ReturnType<typeof resolveTenantForUser>>>;
    appUser: { id: string };
  };
  async function guard(
    c: AppContext,
    opts: { ownerAdmin: boolean },
  ): Promise<GuardOk | { error: Response }> {
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
    if (opts.ownerAdmin && tenant.role !== "owner" && tenant.role !== "admin") {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage broadcasts",
        ),
      };
    }
    return { tenant, appUser: { id: appUser.id } };
  }

  function parseBroadcastId(c: AppContext): string | null {
    const id = c.req.param("id");
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  function invalidState(c: AppContext, status: string) {
    return apiError(
      c,
      409,
      "BROADCAST_INVALID_STATE",
      `Broadcast in status '${status}' cannot perform this action`,
    );
  }

  // ---- Daftar -------------------------------------------------------------
  app.get(base, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const parsed = BroadcastListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid broadcast list query");
    }
    const page = await listBroadcasts(bundle.db, {
      tenantId: g.tenant.id,
      status: parsed.data.status,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    const body = BroadcastListResponseSchema.parse({
      broadcasts: page.broadcasts.map((b) => serializeBroadcast(b, b.stats)),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  // ---- Pratinjau audiens (sebelum route :id agar tidak tertangkap) -----
  // Fase 13C: menggantikan estimasi 7C — rincian kirim/skip dihitung
  // klasifikasi yang sama seperti dispatch di core.
  app.get(`${base}/audience-preview`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const parsed = BroadcastAudiencePreviewQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid audience preview query");
    }
    const splitList = (raw: string | undefined): string[] | undefined => {
      if (!raw) return undefined;
      const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
      return items.length > 0 ? items : undefined;
    };
    const result = await previewBroadcastAudience(bundle.db, {
      tenantId: g.tenant.id,
      channelAccountId: parsed.data.channelAccountId,
      filter: {
        tags: splitList(parsed.data.tags),
        stages: splitList(parsed.data.stages),
        segmentId: parsed.data.segmentId,
      },
      requireOptIn:
        parsed.data.requireOptIn === undefined
          ? undefined
          : parsed.data.requireOptIn === "true",
      whatsappTemplateId: parsed.data.whatsappTemplateId,
      templateVariableSources: splitList(parsed.data.templateVariableSources),
    });
    switch (result.kind) {
      case "ok":
        return c.json(
          BroadcastAudiencePreviewResponseSchema.parse(result.preview),
        );
      case "channel_not_found":
        return apiError(c, 404, "NOT_FOUND", "Channel account not found");
      case "segment_not_found":
        return apiError(c, 404, "NOT_FOUND", "Segment not found");
      case "template_required":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_REQUIRED",
          "WhatsApp broadcasts require an approved message template",
        );
      case "template_not_approved":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_NOT_APPROVED",
          `WhatsApp template is not approved (status '${result.status}')`,
        );
      case "template_not_found":
        return apiError(c, 404, "NOT_FOUND", "WhatsApp template not found");
    }
  });

  // ---- Pengaturan opt-in tenant (Fase 13C) --------------------------------
  // Kartu "Opt-in Broadcast" di halaman Broadcasts. Baca = semua
  // member; ubah = owner/admin (konfigurasi yang memengaruhi siapa
  // boleh dikirimi pesan pemasaran).
  app.get("/tenants/:tenantId/opt-in-settings", async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const settings = await getOptInSettings(bundle.db, g.tenant.id);
    return c.json(
      OptInSettingsResponseSchema.parse({
        ...settings,
        defaultOptOutKeywords: [...DEFAULT_OPT_OUT_KEYWORDS],
      }),
    );
  });

  app.patch("/tenants/:tenantId/opt-in-settings", async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateOptInSettingsRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid opt-in settings payload");
    }
    const settings = await updateOptInSettings(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      patch: parsed.data,
    });
    return c.json(
      OptInSettingsResponseSchema.parse({
        ...settings,
        defaultOptOutKeywords: [...DEFAULT_OPT_OUT_KEYWORDS],
      }),
    );
  });

  // ---- Buat draft -----------------------------------------------------------
  app.post(base, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateBroadcastRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid broadcast payload");
    }
    const result = await createBroadcast(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      name: parsed.data.name,
      channelAccountId: parsed.data.channelAccountId,
      messageText: parsed.data.messageText,
      whatsappTemplateId: parsed.data.whatsappTemplateId,
      templateVariableSources: parsed.data.templateVariableSources,
      filter: parsed.data.audienceFilter,
      requireOptIn: parsed.data.requireOptIn,
      abSplitPercentB: parsed.data.abSplitPercentB,
      variantBMessageText: parsed.data.variantBMessageText,
      variantBWhatsappTemplateId: parsed.data.variantBWhatsappTemplateId,
      variantBTemplateVariableSources:
        parsed.data.variantBTemplateVariableSources,
    });
    switch (result.kind) {
      case "created":
        return c.json(serializeBroadcast(result.broadcast, EMPTY_STATS), 201);
      case "ab_incomplete":
        return apiError(
          c,
          422,
          "BROADCAST_AB_INCOMPLETE",
          "A/B test is enabled but variant B content is missing or invalid for this channel",
        );
      case "segment_not_found":
        return apiError(c, 404, "NOT_FOUND", "Segment not found");
      case "channel_not_found":
        return apiError(c, 404, "NOT_FOUND", "Channel account not found");
      case "channel_unsupported":
        return apiError(
          c,
          422,
          "BROADCAST_CHANNEL_UNSUPPORTED",
          `Broadcasts are not supported for provider '${result.provider}' yet`,
        );
      case "template_required":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_REQUIRED",
          "WhatsApp broadcasts require an approved message template",
        );
      case "template_not_approved":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_NOT_APPROVED",
          `WhatsApp template is not approved (status '${result.status}')`,
        );
      case "template_not_found":
        return apiError(c, 404, "NOT_FOUND", "WhatsApp template not found");
      case "message_required":
        return apiError(
          c,
          400,
          "VALIDATION_ERROR",
          "Message text is required for this provider",
        );
    }
  });

  // ---- Detail ---------------------------------------------------------------
  app.get(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseBroadcastId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    const result = await getBroadcast(bundle.db, {
      tenantId: g.tenant.id,
      broadcastId: id,
    });
    if (!result) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    return c.json(serializeBroadcast(result.broadcast, result.stats));
  });

  // ---- Edit draft -------------------------------------------------------------
  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseBroadcastId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateBroadcastRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid broadcast payload");
    }
    const result = await updateBroadcast(bundle.db, {
      tenantId: g.tenant.id,
      broadcastId: id,
      userId: g.appUser.id,
      patch: {
        name: parsed.data.name,
        channelAccountId: parsed.data.channelAccountId,
        messageText: parsed.data.messageText,
        whatsappTemplateId: parsed.data.whatsappTemplateId,
        templateVariableSources: parsed.data.templateVariableSources,
        filter: parsed.data.audienceFilter,
        requireOptIn: parsed.data.requireOptIn,
        abSplitPercentB: parsed.data.abSplitPercentB,
        variantBMessageText: parsed.data.variantBMessageText,
        variantBWhatsappTemplateId: parsed.data.variantBWhatsappTemplateId,
        variantBTemplateVariableSources:
          parsed.data.variantBTemplateVariableSources,
      },
    });
    switch (result.kind) {
      case "ab_incomplete":
        return apiError(
          c,
          422,
          "BROADCAST_AB_INCOMPLETE",
          "A/B test is enabled but variant B content is missing or invalid for this channel",
        );
      case "segment_not_found":
        return apiError(c, 404, "NOT_FOUND", "Segment not found");
      case "updated": {
        const detail = await getBroadcast(bundle.db, {
          tenantId: g.tenant.id,
          broadcastId: id,
        });
        return c.json(
          serializeBroadcast(result.broadcast, detail?.stats ?? EMPTY_STATS),
        );
      }
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
      case "invalid_state":
        return invalidState(c, result.status);
      case "channel_not_found":
        return apiError(c, 404, "NOT_FOUND", "Channel account not found");
      case "channel_unsupported":
        return apiError(
          c,
          422,
          "BROADCAST_CHANNEL_UNSUPPORTED",
          `Broadcasts are not supported for provider '${result.provider}' yet`,
        );
      case "template_required":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_REQUIRED",
          "WhatsApp broadcasts require an approved message template",
        );
      case "template_not_approved":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_NOT_APPROVED",
          `WhatsApp template is not approved (status '${result.status}')`,
        );
      case "template_not_found":
        return apiError(c, 404, "NOT_FOUND", "WhatsApp template not found");
    }
  });

  // ---- Hapus draft ------------------------------------------------------------
  app.delete(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseBroadcastId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    const result = await deleteBroadcast(bundle.db, {
      tenantId: g.tenant.id,
      broadcastId: id,
      userId: g.appUser.id,
    });
    switch (result.kind) {
      case "deleted":
        return c.body(null, 204);
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
      case "invalid_state":
        return invalidState(c, result.status);
    }
  });

  // ---- Jadwalkan / kirim sekarang --------------------------------------------
  app.post(`${base}/:id/schedule`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseBroadcastId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    let json: unknown = {};
    try {
      json = await c.req.json();
    } catch {
      // Body kosong sah = kirim sekarang.
      json = {};
    }
    const parsed = ScheduleBroadcastRequestSchema.safeParse(json ?? {});
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid schedule payload");
    }
    const result = await scheduleBroadcast(bundle.db, {
      tenantId: g.tenant.id,
      broadcastId: id,
      userId: g.appUser.id,
      scheduledAt: parsed.data.scheduledAt
        ? new Date(parsed.data.scheduledAt)
        : null,
    });
    switch (result.kind) {
      case "scheduled": {
        const detail = await getBroadcast(bundle.db, {
          tenantId: g.tenant.id,
          broadcastId: id,
        });
        return c.json(
          serializeBroadcast(result.broadcast, detail?.stats ?? EMPTY_STATS),
        );
      }
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
      case "invalid_state":
        return invalidState(c, result.status);
      case "channel_disconnected":
        return apiError(
          c,
          409,
          "CHANNEL_DISCONNECTED",
          "Channel is not connected",
        );
      case "channel_unsupported":
        return apiError(
          c,
          422,
          "BROADCAST_CHANNEL_UNSUPPORTED",
          `Broadcasts are not supported for provider '${result.provider}' yet`,
        );
      case "template_required":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_REQUIRED",
          "WhatsApp broadcasts require an approved message template",
        );
      case "template_not_approved":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_NOT_APPROVED",
          `WhatsApp template is not approved (status '${result.status}')`,
        );
    }
  });

  // ---- Batalkan -----------------------------------------------------------------
  app.post(`${base}/:id/cancel`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseBroadcastId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    const result = await cancelBroadcast(bundle.db, {
      tenantId: g.tenant.id,
      broadcastId: id,
      userId: g.appUser.id,
    });
    switch (result.kind) {
      case "cancelled": {
        const detail = await getBroadcast(bundle.db, {
          tenantId: g.tenant.id,
          broadcastId: id,
        });
        return c.json(
          serializeBroadcast(result.broadcast, detail?.stats ?? EMPTY_STATS),
        );
      }
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
      case "invalid_state":
        return invalidState(c, result.status);
    }
  });

  // ---- Penerima -------------------------------------------------------------------
  app.get(`${base}/:id/recipients`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseBroadcastId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    const parsed = BroadcastRecipientListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid recipient list query");
    }
    const result = await listBroadcastRecipients(bundle.db, {
      tenantId: g.tenant.id,
      broadcastId: id,
      status: parsed.data.status,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    }
    const body = BroadcastRecipientListResponseSchema.parse({
      recipients: result.recipients.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        contactName: r.contactName,
        conversationId: r.conversationId,
        messageId: r.messageId,
        status: r.status,
        variant: r.variant === "b" ? "b" : "a",
        skipReason: r.skipReason,
        errorCode: r.errorCode,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    });
    return c.json(body);
  });

  // ---- Rincian per varian A/B (Fase 13D, dashboard saja) --------------------
  // Gema konfigurasi A/B (untuk panel hasil + prefill formulir edit)
  // + statistik per varian dari broadcast_recipients. Broadcast tanpa
  // A/B → abTest null dan hanya varian "a". Baca = semua member.
  app.get(`${base}/:id/ab-results`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseBroadcastId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    const result = await getBroadcastAbResults(bundle.db, {
      tenantId: g.tenant.id,
      broadcastId: id,
    });
    if (!result) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    return c.json(BroadcastAbResultsResponseSchema.parse(result));
  });

  return app;
}
