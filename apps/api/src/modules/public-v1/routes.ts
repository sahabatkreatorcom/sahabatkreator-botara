import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  AgentListResponseSchema,
  AutomationListResponseSchema,
  BroadcastListResponseSchema,
  ChannelAccountListResponseSchema,
  CommentListResponseSchema,
  ContactListResponseSchema,
  ConversationListResponseSchema,
  ConversationStatusSchema,
  CreateContactRequestSchema,
  FLOW_TEMPLATES,
  FlowListResponseSchema,
  FlowTemplateListResponseSchema,
  KbDocumentListResponseSchema,
  KbStatsResponseSchema,
  GrowthLinkListResponseSchema,
  SegmentListResponseSchema,
  OrderListResponseSchema,
  AppointmentServiceListResponseSchema,
  BookingListResponseSchema,
  V1ListAppointmentsQuerySchema,
  MessageListResponseSchema,
  ProductListResponseSchema,
  PublicMeResponseSchema,
  SendMessageRequestSchema,
  UpdateContactRequestSchema,
  V1ListBroadcastsQuerySchema,
  V1ListCommentsQuerySchema,
  V1ListFlowsQuerySchema,
  V1ListWhatsAppTemplatesQuerySchema,
  WhatsAppTemplateListResponseSchema,
  type ApiKeyScope,
} from "@sahabat-kreator/contracts";
import {
  ContactCustomFieldValidationError,
  createContact,
  getAgent,
  getBroadcast,
  getChannelAccount,
  getChannelHealthMap,
  getKbDocument,
  getKbEmbeddingStats,
  getTenantNameById,
  hashApiKey,
  IDLE_CHANNEL_HEALTH,
  listAgents,
  listAutomations,
  listBroadcasts,
  listChannelAccounts,
  listComments,
  listContacts,
  listConversations,
  listFlows,
  getFlow,
  getGrowthLink,
  listGrowthLinks,
  getSegment,
  listSegments,
  getOrder,
  listOrders,
  listBookings,
  listAppointmentServices,
  listKbDocuments,
  listMessagesPage,
  listProducts,
  listProfilePhotoOwnerIds,
  listWhatsAppTemplates,
  queueOutboundMessageForApiKey,
  resolveApiKeyByHash,
  resolveEmbeddingProvider,
  touchApiKeyLastUsed,
  updateContact,
  API_KEY_DISPLAY_PREFIX,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";
import { apiError, type ApiKeyAuthContext, type AppVariables } from "../../http";
import type { RateLimiter } from "../../rate-limit";
import { serializeAgent } from "../agents/routes";
import { serializeAutomation } from "../automations/routes";
import { channelAvatarUrl } from "../avatars/routes";
import { serializeBroadcast } from "../broadcasts/routes";
import { serializeChannel } from "../channels/routes";
import {
  performCommentModeration,
  serializeComment,
  type CommentsModuleOptions,
} from "../comments/routes";
import { serializeContact } from "../contacts/routes";
import { serializeFlow } from "../flows/routes";
import { serializeGrowthLink } from "../growth/routes";
import { serializeSegment } from "../segments/routes";
import { serializeOrder } from "../products/routes";
import {
  serializeAppointmentService,
  serializeBooking,
} from "../appointments/routes";
import { serializeConversation } from "../inbox/routes";
import { serializeDocument } from "../knowledge/routes";
import { serializeMessage } from "../messages-serialize";
import { serializeProduct } from "../products/routes";
import { serializeTemplate } from "../whatsapp-templates/routes";

const ListContactsQuerySchema = z.object({
  search: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ListConversationsQuerySchema = z.object({
  status: ConversationStatusSchema.optional(),
});

const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Kursor halaman lebih lama (Fase 16C) — paritas dengan endpoint dashboard. */
  before: z.string().uuid().optional(),
});

/** Mengambil kunci mentah dari `Authorization: Bearer ...` atau header `X-API-Key`. */
function extractPresentedKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const xKey = headers.get("x-api-key")?.trim();
  return xKey ? xKey : null;
}

/**
 * Modul API publik /v1 (Fase 5A, RANCANGAN §5.4) — permukaan untuk SDK,
 * MCP server, dan integrasi pihak ketiga. TIDAK memakai sesi dashboard:
 * autentikasi = API key per tenant (`Authorization: Bearer sk_live_...`
 * atau `X-API-Key`). Tenant TIDAK PERNAH datang dari URL — selalu
 * diturunkan dari baris kunci, dan semua data dibaca lewat service core
 * dalam konteks RLS tenant pemilik kunci.
 *   GET  /v1/me                                  identitas tenant + scopes kunci
 *   GET  /v1/contacts          (contacts:read)   daftar + ?search=&limit=&offset=
 *   POST /v1/contacts          (contacts:write)  buat kontak → 201
 *   PATCH /v1/contacts/:id     (contacts:write)  ubah kontak (Fase 13A —
 *                                                termasuk customFields,
 *                                                digabung per kunci)
 *   GET  /v1/conversations     (conversations:read)
 *   GET  /v1/conversations/:id/messages          (conversations:read)
 *   POST /v1/conversations/:id/messages          (messages:write) → pesan queued
 *   GET  /v1/products          (products:read)
 *   GET  /v1/comments          (comments:read)   komentar IG/Messenger
 *                                                tercatat (Fase 10B)
 *   POST /v1/comments/:id/hide   (comments:write) moderasi manual —
 *   POST /v1/comments/:id/unhide (comments:write) Graph dulu, lokal
 *                                                sesudahnya (helper yang
 *                                                sama dengan dashboard)
 *   --- Fase 15A: permukaan BACA untuk sumber daya yang sebelumnya
 *       hanya dashboard (aturan sinkronisasi kontrak; tulis tetap
 *       dashboard-only — lihat docs/COVERAGE-MATRIX.md) ---
 *   GET  /v1/broadcasts          (broadcasts:read)  daftar (kursor)
 *   GET  /v1/broadcasts/:id      (broadcasts:read)  detail + statistik
 *   GET  /v1/flows               (flows:read)       daftar (kursor)
 *   GET  /v1/flows/:id           (flows:read)       detail + graf
 *   GET  /v1/flow-templates      (flows:read)       katalog template
 *   GET  /v1/automations         (automations:read) daftar
 *   GET  /v1/automations/:id     (automations:read) detail
 *   GET  /v1/agents              (agents:read)      daftar
 *   GET  /v1/agents/:id          (agents:read)      detail
 *   GET  /v1/channels            (channels:read)    daftar + kesehatan
 *   GET  /v1/channels/:id        (channels:read)    detail + kesehatan
 *   GET  /v1/whatsapp-templates  (whatsapp_templates:read)
 *                                                 cermin per akun (?channelAccountId=)
 *   GET  /v1/knowledge/documents (knowledge:read)   entri KB
 *   GET  /v1/knowledge/documents/:id (knowledge:read)
 *   GET  /v1/knowledge/stats     (knowledge:read)   cakupan embedding
 *   --- Fase 13B: growth links — permukaan BACA ---
 *   GET  /v1/growth-links        (growth_links:read) daftar + statistik
 *   GET  /v1/growth-links/:id    (growth_links:read) detail
 *   --- Fase 13C: segmen — permukaan BACA ---
 *   GET  /v1/segments            (segments:read)    daftar definisi
 *   GET  /v1/segments/:id        (segments:read)    detail
 *   --- Fase 13F: order commerce — permukaan BACA ---
 *   GET  /v1/orders              (orders:read)      daftar order checkout
 *   GET  /v1/orders/:id          (orders:read)      detail + item + tautan
 * Penolakan: tanpa/bukan kunci → 401 API_KEY_INVALID; kunci dicabut → 401
 * API_KEY_REVOKED; scope kurang → 403 API_KEY_SCOPE_DENIED.
 * Registry kanonis permukaan ini: PUBLIC_V1_SURFACE di
 * @sahabat-kreator/contracts (dijaga skrip check:drift).
 */

/**
 * Dependensi status semantik KB (Fase 15A): resolver Panel Admin proses
 * API + env embedding — deps yang sama seperti modul knowledge, agar
 * /v1/knowledge/stats melaporkan provider yang benar-benar di-resolve
 * proses ini. Tanpa deps, status dilaporkan nonaktif.
 */
export interface PublicV1KbDeps {
  platform?: PlatformSettingsOptions;
  embeddingProviderEnv?: string;
  embeddingModelEnv?: string;
}

/**
 * Batas laju PER KUNCI API (G10). Lapisan per-IP di index.ts berjalan
 * pra-autentikasi dan berbagi satu bucket untuk semua kunci di balik
 * IP yang sama; lapisan ini berjalan SESUDAH `requireApiKey` dengan
 * bucket = id kunci, sehingga kuota benar-benar milik kunci itu.
 * Opsional: tanpa deps, modul berperilaku seperti sebelumnya.
 */
export interface PublicV1RateLimitDeps {
  limiter: RateLimiter;
  /** Nama aturan di limiter; bawaan "v1-key". */
  rule?: string;
}

export function createPublicV1Routes(
  bundle: AuthBundle | null,
  publisher?: RealtimePublisher | null,
  commentOpts: CommentsModuleOptions = {},
  kbDeps: PublicV1KbDeps = {},
  rateLimitDeps?: PublicV1RateLimitDeps,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  if (!bundle) {
    app.all("/v1/*", (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    return app;
  }

  const requireApiKey: MiddlewareHandler<{ Variables: AppVariables }> =
    async (c, next) => {
      const presented = extractPresentedKey(c.req.raw.headers);
      if (!presented || !presented.startsWith(API_KEY_DISPLAY_PREFIX)) {
        return apiError(c, 401, "API_KEY_INVALID", "Missing or malformed API key");
      }
      const row = await resolveApiKeyByHash(bundle.db, hashApiKey(presented));
      if (!row) {
        return apiError(c, 401, "API_KEY_INVALID", "API key not recognized");
      }
      if (row.revokedAt) {
        return apiError(c, 401, "API_KEY_REVOKED", "API key has been revoked");
      }
      c.set("apiKeyAuth", {
        apiKey: row,
        tenantId: row.tenantId,
        scopes: row.scopes as ApiKeyScope[],
      });
      // last_used_at best-effort: kegagalan update tidak boleh menggagalkan request.
      void touchApiKeyLastUsed(bundle.db, row.tenantId, row.id).catch(() => {});
      await next();
    };

  app.use("/v1/*", requireApiKey);

  // Batas laju per kunci (G10) — SESUDAH autentikasi, bucket = id
  // kunci. Kunci yang tidak dikenal/dicabut sudah ditolak di atas,
  // jadi lapisan ini hanya menghitung trafik kunci yang sah.
  if (rateLimitDeps) {
    app.use(
      "/v1/*",
      rateLimitDeps.limiter.middleware(rateLimitDeps.rule ?? "v1-key", {
        keyFrom: (c) => c.get("apiKeyAuth")?.apiKey.id ?? null,
      }),
    );
  }

  function requireScope(
    c: { get: (k: "apiKeyAuth") => ApiKeyAuthContext },
    scope: ApiKeyScope,
  ) {
    return c.get("apiKeyAuth").scopes.includes(scope)
      ? null
      : apiError(c as Parameters<typeof apiError>[0], 403, "API_KEY_SCOPE_DENIED", `Missing scope: ${scope}`);
  }

  app.get("/v1/me", async (c) => {
    const auth = c.get("apiKeyAuth");
    const tenantName = await getTenantNameById(bundle.db, auth.tenantId);
    const body = PublicMeResponseSchema.parse({
      tenantId: auth.tenantId,
      tenantName: tenantName ?? "",
      scopes: auth.scopes,
    });
    return c.json(body);
  });

  app.get("/v1/contacts", async (c) => {
    const denied = requireScope(c, "contacts:read");
    if (denied) return denied;
    const query = ListContactsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const auth = c.get("apiKeyAuth");
    const result = await listContacts(bundle.db, { tenantId: auth.tenantId }, query.data);
    const body = ContactListResponseSchema.parse({
      contacts: result.contacts.map((row) => serializeContact(row)),
      total: result.total,
    });
    return c.json(body);
  });

  app.post("/v1/contacts", async (c) => {
    const denied = requireScope(c, "contacts:write");
    if (denied) return denied;
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateContactRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid contact payload");
    }
    const auth = c.get("apiKeyAuth");
    try {
      const contact = await createContact(bundle.db, { tenantId: auth.tenantId }, parsed.data);
      return c.json(serializeContact(contact), 201);
    } catch (err) {
      // G18: nilai field kustom melanggar skema bertipe tenant.
      if (err instanceof ContactCustomFieldValidationError) {
        return apiError(c, 400, "CONTACT_FIELD_INVALID", "Custom field values violate the field schema", { issues: err.issues });
      }
      throw err;
    }
  });

  app.patch("/v1/contacts/:id", async (c) => {
    const denied = requireScope(c, "contacts:write");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateContactRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid contact payload");
    }
    const auth = c.get("apiKeyAuth");
    let contact;
    try {
      contact = await updateContact(
        bundle.db,
        { tenantId: auth.tenantId },
        id,
        parsed.data,
      );
    } catch (err) {
      // G18: nilai field kustom melanggar skema bertipe tenant.
      if (err instanceof ContactCustomFieldValidationError) {
        return apiError(c, 400, "CONTACT_FIELD_INVALID", "Custom field values violate the field schema", { issues: err.issues });
      }
      throw err;
    }
    if (!contact) return apiError(c, 404, "NOT_FOUND", "Contact not found");
    return c.json(serializeContact(contact));
  });

  app.get("/v1/conversations", async (c) => {
    const denied = requireScope(c, "conversations:read");
    if (denied) return denied;
    const query = ListConversationsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const auth = c.get("apiKeyAuth");
    const rows = await listConversations(bundle.db, { tenantId: auth.tenantId }, query.data);
    const body = ConversationListResponseSchema.parse({
      conversations: rows.map((row) => serializeConversation(row)),
    });
    return c.json(body);
  });

  app.get("/v1/conversations/:id/messages", async (c) => {
    const denied = requireScope(c, "conversations:read");
    if (denied) return denied;
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    const query = ListMessagesQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const auth = c.get("apiKeyAuth");
    // Jalur mesin: membaca riwayat TIDAK menandai percakapan terbaca —
    // itu semantik khusus inbox manusia (perbaikan QA-1).
    const page = await listMessagesPage(
      bundle.db,
      { tenantId: auth.tenantId },
      id,
      query.data,
    );
    if (page.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    if (page.kind === "invalid_cursor") {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "`before` must be a message id from this conversation",
      );
    }
    const body = MessageListResponseSchema.parse({
      messages: page.messages.map(serializeMessage),
      hasMore: page.hasMore,
    });
    return c.json(body);
  });
  app.post("/v1/conversations/:id/messages", async (c) => {
    const denied = requireScope(c, "messages:write");
    if (denied) return denied;
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
    const auth = c.get("apiKeyAuth");
    const result = await queueOutboundMessageForApiKey(
      bundle.db,
      { tenantId: auth.tenantId },
      id,
      parsed.data,
      auth.apiKey.id,
    );
    if (result.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    if (result.kind === "reply_target_invalid") {
      // Fase 7B.5: paritas dengan endpoint balas dashboard.
      return apiError(
        c,
        422,
        "MESSAGE_REPLY_TARGET_INVALID",
        "Reply target must be a message in this conversation",
      );
    }
    if (result.kind === "messaging_window_closed") {
      // Fase 16C: aturannya milik provider, bukan milik UI — jalur API
      // mendapat penolakan yang sama dengan jalur dashboard.
      return apiError(
        c,
        422,
        "MESSAGING_WINDOW_CLOSED",
        "The messaging window is closed; send an approved template instead",
        {
          lastInboundAt: result.window.lastInboundAt?.toISOString() ?? null,
          expiresAt: result.window.expiresAt?.toISOString() ?? null,
        },
      );
    }
    // Varian media tidak mungkin di jalur ini (API publik belum punya
    // unggahan lampiran). Dinyatakan eksplisit supaya perubahan kelak
    // memunculkan error, bukan lampiran yang hilang diam-diam.
    if (result.kind !== "queued") {
      return apiError(c, 500, "INTERNAL_ERROR", "Unexpected queue result");
    }
    const queued = result.message;

    // Jalur pengiriman sama persis dengan balasan dashboard: Fase 6G
    // menerbitkan nudge `message.queued` — apps/realtime mem-flush ke
    // pengunjung webchat yang terhubung (→ `sent`); selain itu pesan
    // tetap `queued` sampai pengunjung reconnect / poller Telegram.
    if (publisher) {
      await publisher.publishNudge({
        kind: "message.queued",
        tenantId: auth.tenantId,
        conversationId: id,
      });
    }
    return c.json(serializeMessage(queued), 201);
  });

  app.get("/v1/products", async (c) => {
    const denied = requireScope(c, "products:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const rows = await listProducts(bundle.db, { tenantId: auth.tenantId });
    const body = ProductListResponseSchema.parse({
      products: rows.map(serializeProduct),
    });
    return c.json(body);
  });

  app.get("/v1/comments", async (c) => {
    const denied = requireScope(c, "comments:read");
    if (denied) return denied;
    const query = V1ListCommentsQuerySchema.safeParse({
      channelAccountId: c.req.query("channelAccountId") || undefined,
      automationId: c.req.query("automationId") || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const auth = c.get("apiKeyAuth");
    const rows = await listComments(
      bundle.db,
      { tenantId: auth.tenantId },
      query.data,
    );
    const body = CommentListResponseSchema.parse({
      comments: rows.map(serializeComment),
    });
    return c.json(body);
  });

  const moderateComment = (hidden: boolean) => async (c: {
    req: { param: (k: string) => string | undefined };
    get: (k: "apiKeyAuth") => ApiKeyAuthContext;
    json: (v: unknown) => Response;
  }) => {
    const denied = requireScope(c, "comments:write");
    if (denied) return denied;
    const id = c.req.param("id") ?? "";
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(
        c as Parameters<typeof apiError>[0],
        404,
        "NOT_FOUND",
        "Comment not found",
      );
    }
    const auth = c.get("apiKeyAuth");
    const outcome = await performCommentModeration(bundle, commentOpts, {
      tenantId: auth.tenantId,
      actorId: auth.apiKey.id,
      actorType: "api_key",
      commentId: id,
      hidden,
    });
    if (outcome.kind === "not_found") {
      return apiError(
        c as Parameters<typeof apiError>[0],
        404,
        "NOT_FOUND",
        "Comment not found",
      );
    }
    if (outcome.kind === "failed") {
      return apiError(
        c as Parameters<typeof apiError>[0],
        422,
        "META_COMMENT_ACTION_FAILED",
        "Meta rejected the moderation request",
      );
    }
    return c.json(serializeComment(outcome.comment));
  };

  app.post("/v1/comments/:id/hide", moderateComment(true));
  app.post("/v1/comments/:id/unhide", moderateComment(false));

  // ---------------------------------------------------------------------
  // Fase 15A — permukaan BACA baru. Semua endpoint di bawah ini murni
  // membaca lewat service core dalam konteks tenant pemilik kunci, dan
  // memakai serializer yang SAMA dengan dashboard (tidak ada bentuk
  // respons kedua yang bisa drift). Paginasi mengikuti pola sumber
  // dayanya di dashboard: broadcast & flow berkursor; sisanya daftar
  // penuh (daftar dashboard-nya memang tak berpaginasi).
  // ---------------------------------------------------------------------

  const parseUuidParam = (c: { req: { param: (k: string) => string } }) => {
    const id = c.req.param("id");
    return z.string().uuid().safeParse(id).success ? id : null;
  };

  app.get("/v1/broadcasts", async (c) => {
    const denied = requireScope(c, "broadcasts:read");
    if (denied) return denied;
    const query = V1ListBroadcastsQuerySchema.safeParse({
      status: c.req.query("status") || undefined,
      cursor: c.req.query("cursor") || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const auth = c.get("apiKeyAuth");
    const page = await listBroadcasts(bundle.db, {
      tenantId: auth.tenantId,
      status: query.data.status,
      cursor: query.data.cursor,
      limit: query.data.limit,
    });
    const body = BroadcastListResponseSchema.parse({
      broadcasts: page.broadcasts.map((b) => serializeBroadcast(b, b.stats)),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  app.get("/v1/broadcasts/:id", async (c) => {
    const denied = requireScope(c, "broadcasts:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    const auth = c.get("apiKeyAuth");
    const result = await getBroadcast(bundle.db, {
      tenantId: auth.tenantId,
      broadcastId: id,
    });
    if (!result) return apiError(c, 404, "NOT_FOUND", "Broadcast not found");
    return c.json(serializeBroadcast(result.broadcast, result.stats));
  });

  app.get("/v1/flows", async (c) => {
    const denied = requireScope(c, "flows:read");
    if (denied) return denied;
    const query = V1ListFlowsQuerySchema.safeParse({
      status: c.req.query("status") || undefined,
      cursor: c.req.query("cursor") || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const auth = c.get("apiKeyAuth");
    const page = await listFlows(bundle.db, {
      tenantId: auth.tenantId,
      status: query.data.status,
      cursor: query.data.cursor,
      limit: query.data.limit,
    });
    const body = FlowListResponseSchema.parse({
      flows: page.flows.map(serializeFlow),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  app.get("/v1/flows/:id", async (c) => {
    const denied = requireScope(c, "flows:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const auth = c.get("apiKeyAuth");
    const flow = await getFlow(bundle.db, { tenantId: auth.tenantId, flowId: id });
    if (!flow) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    return c.json(serializeFlow(flow));
  });

  app.get("/v1/flow-templates", async (c) => {
    const denied = requireScope(c, "flows:read");
    if (denied) return denied;
    // Katalog statis dari kontrak (sumber kebenaran bersama, Fase 12B) —
    // ringkasan yang sama seperti endpoint dashboard.
    const body = FlowTemplateListResponseSchema.parse({
      templates: FLOW_TEMPLATES.map((tpl) => ({
        slug: tpl.slug,
        nameKey: tpl.nameKey,
        descriptionKey: tpl.descriptionKey,
        category: tpl.category,
        nodeCount: tpl.graph.nodes.length,
        needs: tpl.needs,
      })),
    });
    return c.json(body);
  });

  app.get("/v1/automations", async (c) => {
    const denied = requireScope(c, "automations:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const rows = await listAutomations(bundle.db, { tenantId: auth.tenantId });
    const body = AutomationListResponseSchema.parse({
      automations: rows.map(serializeAutomation),
    });
    return c.json(body);
  });

  app.get("/v1/automations/:id", async (c) => {
    const denied = requireScope(c, "automations:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    const auth = c.get("apiKeyAuth");
    // Pola yang sama seperti PATCH dashboard: bentuk WithRunCount hanya
    // dihasilkan listAutomations — ambil dari daftar tenant sendiri.
    const rows = await listAutomations(bundle.db, { tenantId: auth.tenantId });
    const row = rows.find((r) => r.id === id);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    return c.json(serializeAutomation(row));
  });

  app.get("/v1/agents", async (c) => {
    const denied = requireScope(c, "agents:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const rows = await listAgents(bundle.db, { tenantId: auth.tenantId });
    const body = AgentListResponseSchema.parse({
      agents: rows.map(serializeAgent),
    });
    return c.json(body);
  });

  app.get("/v1/agents/:id", async (c) => {
    const denied = requireScope(c, "agents:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Agent not found");
    const auth = c.get("apiKeyAuth");
    const agent = await getAgent(bundle.db, { tenantId: auth.tenantId }, id);
    if (!agent) return apiError(c, 404, "NOT_FOUND", "Agent not found");
    return c.json(serializeAgent(agent));
  });

  app.get("/v1/channels", async (c) => {
    const denied = requireScope(c, "channels:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const rows = await listChannelAccounts(bundle.db, {
      tenantId: auth.tenantId,
    });
    // Sama seperti daftar dashboard: avatarUrl dari foto tersimpan +
    // kesehatan agregat satu peta. Perbedaan sadar: jalur v1 TIDAK
    // memicu backfill malas foto bot Telegram (efek samping penulisan
    // tidak boleh lahir dari bacaan API key).
    const withPhoto = await listProfilePhotoOwnerIds(
      bundle.db,
      { tenantId: auth.tenantId },
      "channel_account",
      rows.map((r) => r.id),
    );
    const healthMap = await getChannelHealthMap(
      bundle.db,
      { tenantId: auth.tenantId },
      rows,
    );
    const body = ChannelAccountListResponseSchema.parse({
      channels: rows.map((row) =>
        serializeChannel(
          row,
          withPhoto.has(row.id)
            ? channelAvatarUrl(auth.tenantId, row.id)
            : null,
          healthMap.get(row.id) ?? IDLE_CHANNEL_HEALTH,
        ),
      ),
    });
    return c.json(body);
  });

  app.get("/v1/channels/:id", async (c) => {
    const denied = requireScope(c, "channels:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Channel not found");
    const auth = c.get("apiKeyAuth");
    const row = await getChannelAccount(
      bundle.db,
      { tenantId: auth.tenantId },
      id,
    );
    // Akun di Sampah tidak terekspos permukaan publik (selaras daftar).
    if (!row || row.trashedAt) {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    const withPhoto = await listProfilePhotoOwnerIds(
      bundle.db,
      { tenantId: auth.tenantId },
      "channel_account",
      [row.id],
    );
    const healthMap = await getChannelHealthMap(
      bundle.db,
      { tenantId: auth.tenantId },
      [row],
    );
    return c.json(
      serializeChannel(
        row,
        withPhoto.has(row.id) ? channelAvatarUrl(auth.tenantId, row.id) : null,
        healthMap.get(row.id) ?? IDLE_CHANNEL_HEALTH,
      ),
    );
  });

  app.get("/v1/whatsapp-templates", async (c) => {
    const denied = requireScope(c, "whatsapp_templates:read");
    if (denied) return denied;
    const query = V1ListWhatsAppTemplatesQuerySchema.safeParse({
      channelAccountId: c.req.query("channelAccountId") || undefined,
    });
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const auth = c.get("apiKeyAuth");
    // Gerbang yang sama seperti dashboard: akun harus milik tenant ini,
    // tidak di Sampah, dan provider WhatsApp.
    const account = await getChannelAccount(
      bundle.db,
      { tenantId: auth.tenantId },
      query.data.channelAccountId,
    );
    if (!account || account.trashedAt) {
      return apiError(c, 404, "NOT_FOUND", "Channel account not found");
    }
    if (account.provider !== "whatsapp") {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Channel account is not a WhatsApp account",
      );
    }
    const rows = await listWhatsAppTemplates(bundle.db, {
      tenantId: auth.tenantId,
      channelAccountId: query.data.channelAccountId,
    });
    const body = WhatsAppTemplateListResponseSchema.parse({
      templates: rows.map(serializeTemplate),
    });
    return c.json(body);
  });

  app.get("/v1/knowledge/documents", async (c) => {
    const denied = requireScope(c, "knowledge:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const rows = await listKbDocuments(bundle.db, { tenantId: auth.tenantId });
    const body = KbDocumentListResponseSchema.parse({
      documents: rows.map(serializeDocument),
    });
    return c.json(body);
  });

  app.get("/v1/knowledge/documents/:id", async (c) => {
    const denied = requireScope(c, "knowledge:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Document not found");
    const auth = c.get("apiKeyAuth");
    const doc = await getKbDocument(bundle.db, { tenantId: auth.tenantId }, id);
    if (!doc) return apiError(c, 404, "NOT_FOUND", "Document not found");
    return c.json(serializeDocument(doc));
  });

  app.get("/v1/knowledge/stats", async (c) => {
    const denied = requireScope(c, "knowledge:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const stats = await getKbEmbeddingStats(bundle.db, {
      tenantId: auth.tenantId,
    });
    // Semantik persis endpoint dashboard /kb/stats: status provider
    // di-resolve dari deps proses API (panel → env), bukan ditebak.
    let semanticSearch = {
      active: false,
      provider: null as string | null,
      model: null as string | null,
    };
    if (kbDeps.platform) {
      const provider = await resolveEmbeddingProvider(bundle.db, {
        platform: kbDeps.platform,
        providerEnv: kbDeps.embeddingProviderEnv,
        modelEnv: kbDeps.embeddingModelEnv,
      }).catch(() => null);
      if (provider) {
        semanticSearch = {
          active: true,
          provider: provider.name,
          model: provider.model,
        };
      }
    }
    return c.json(KbStatsResponseSchema.parse({ ...stats, semanticSearch }));
  });

  // --- Fase 13B: growth links — permukaan BACA (growth_links:read).
  // Tulis tetap dashboard-only: slug publik + branding adalah artefak
  // kurasi UI (lihat docs/COVERAGE-MATRIX.md). Serializer yang sama
  // persis dengan modul growth dashboard.
  app.get("/v1/growth-links", async (c) => {
    const denied = requireScope(c, "growth_links:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const links = await listGrowthLinks(bundle.db, { tenantId: auth.tenantId });
    return c.json(
      GrowthLinkListResponseSchema.parse({
        links: links.map(serializeGrowthLink),
      }),
    );
  });

  app.get("/v1/growth-links/:id", async (c) => {
    const denied = requireScope(c, "growth_links:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    const auth = c.get("apiKeyAuth");
    const link = await getGrowthLink(bundle.db, { tenantId: auth.tenantId }, id);
    if (!link) return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    return c.json(serializeGrowthLink(link));
  });

  // --- Fase 13C: segmen — permukaan BACA (segments:read). Tulis tetap
  // dashboard-only: segmen adalah artefak kurasi UI dengan definisi
  // kondisi kompleks (lihat docs/COVERAGE-MATRIX.md). Serializer yang
  // sama persis dengan modul segments dashboard.
  app.get("/v1/segments", async (c) => {
    const denied = requireScope(c, "segments:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const rows = await listSegments(bundle.db, auth.tenantId);
    return c.json(
      SegmentListResponseSchema.parse({
        segments: rows.map(serializeSegment),
      }),
    );
  });

  app.get("/v1/segments/:id", async (c) => {
    const denied = requireScope(c, "segments:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Segment not found");
    const auth = c.get("apiKeyAuth");
    const row = await getSegment(bundle.db, auth.tenantId, id);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Segment not found");
    return c.json(serializeSegment(row));
  });

  // --- Fase 13F: order commerce — permukaan BACA (orders:read). Order
  // lahir dari checkout flow (node cart_checkout); keranjang sendiri
  // SENGAJA tidak punya permukaan publik (keadaan sesi percakapan,
  // lihat docs/COVERAGE-MATRIX.md). Serializer yang sama persis dengan
  // modul products dashboard (url pembayaran relatif /pay/<kode>).
  app.get("/v1/orders", async (c) => {
    const denied = requireScope(c, "orders:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const rows = await listOrders(bundle.db, { tenantId: auth.tenantId });
    return c.json(
      OrderListResponseSchema.parse({
        orders: rows.map((r) => serializeOrder(r)),
      }),
    );
  });

  app.get("/v1/orders/:id", async (c) => {
    const denied = requireScope(c, "orders:read");
    if (denied) return denied;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Order not found");
    const auth = c.get("apiKeyAuth");
    const row = await getOrder(bundle.db, { tenantId: auth.tenantId }, id);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Order not found");
    return c.json(serializeOrder(row));
  });

  // --- Fase 13G: janji temu — permukaan BACA (appointments:read).
  // Booking lahir dari flow (node book_appointment) atau dashboard;
  // tulis (layanan/ketersediaan/booking manual/batal) SENGAJA
  // dashboard/flow-only — lihat docs/COVERAGE-MATRIX.md. Serializer
  // yang sama persis dengan modul appointments dashboard.
  app.get("/v1/appointments", async (c) => {
    const denied = requireScope(c, "appointments:read");
    if (denied) return denied;
    const query = V1ListAppointmentsQuerySchema.safeParse({
      from: c.req.query("from"),
      to: c.req.query("to"),
      status: c.req.query("status"),
    });
    if (!query.success) {
      // 400 seperti semua validasi query lain di /v1 (G10: envelope
      // yang konsisten termasuk statusnya, bukan hanya bentuk badan).
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid appointments query");
    }
    const auth = c.get("apiKeyAuth");
    const rows = await listBookings(bundle.db, auth.tenantId, {
      from: query.data.from ? new Date(query.data.from) : undefined,
      to: query.data.to ? new Date(query.data.to) : undefined,
      status: query.data.status,
    });
    return c.json(
      BookingListResponseSchema.parse({
        bookings: rows.map((r) => serializeBooking(r)),
      }),
    );
  });

  app.get("/v1/appointment-services", async (c) => {
    const denied = requireScope(c, "appointments:read");
    if (denied) return denied;
    const auth = c.get("apiKeyAuth");
    const rows = await listAppointmentServices(bundle.db, auth.tenantId);
    return c.json(
      AppointmentServiceListResponseSchema.parse({
        services: rows.map((r) => serializeAppointmentService(r)),
      }),
    );
  });

  return app;
}
