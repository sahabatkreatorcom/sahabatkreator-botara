import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  AssignConversationRequestSchema,
  ConversationListResponseSchema,
  ConversationResponseSchema,
  ConversationStatusSchema,
  MessageListResponseSchema,
  SendMessageRequestSchema,
  SendTemplateMessageRequestSchema,
  SetAgentEnabledRequestSchema,
  UpdateConversationStatusRequestSchema,
  type ConversationResponse,
} from "@sahabat-kreator/contracts";
import {
  assignConversation,
  computeMessagingWindow,
  listConversations,
  listMessagesPage,
  listProfilePhotoOwnerIds,
  markConversationRead,
  queueOutboundMessage,
  queueTemplateMessage,
  setConversationAgentEnabled,
  setConversationStatus,
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
  // Fase 16C: keadaan jendela pesan bebas dihitung server — UI memakai
  // ini untuk mematikan kotak balasan LEBIH DULU, bukan menunggu
  // penolakan provider.
  const window = computeMessagingWindow(row.provider, row.lastInboundAt);
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
    messagingWindow: {
      enforced: window.enforced,
      open: window.open,
      lastInboundAt: window.lastInboundAt?.toISOString() ?? null,
      expiresAt: window.expiresAt?.toISOString() ?? null,
    },
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
  // Fase 16C: pencarian nama kontak / nomor / judul percakapan.
  q: z.string().trim().min(1).max(120).optional(),
});

const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /**
   * Kursor "muat pesan lebih lama" (Fase 16C): id pesan TERTUA yang sudah
   * tampil. Kembalian = pesan yang lebih tua darinya.
   */
  before: z.string().uuid().optional(),
});

/**
 * Modul inbox (Fase 1D) — route bersarang di workspace:
 *   GET   /tenants/:tenantId/conversations                 daftar + nama kontak + cuplikan pesan terakhir (?status=, ?assignment=mine|unassigned)
 *   GET   /tenants/:tenantId/conversations/:id/messages    pesan kronologis (?limit=, ?before=<messageId> untuk halaman lebih lama) + `hasMore`
 *   POST  /tenants/:tenantId/conversations/:id/messages    balasan manual → pesan outbound status `queued`
 *   POST  /tenants/:tenantId/conversations/:id/assign      tetapkan/lepas penerima tugas (Fase 9C)
 *   PATCH /tenants/:tenantId/conversations/:id             ubah status kerja open|pending|closed (Fase 16C)
 *   POST  /tenants/:tenantId/conversations/:id/agent       nyalakan/matikan AI percakapan (Fase 16C)
 *   POST  /tenants/:tenantId/conversations/:id/template    kirim template WhatsApp (Fase 16C) — satu-satunya
 *                                                          jalan setelah jendela 24 jam tertutup
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
    app.post(`${base}/:id/template`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.patch(`${base}/:id`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/:id/agent`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    return app;
  }

  /**
   * Ambil ulang satu percakapan lewat jalur DAFTAR lalu serialisasi —
   * agar bentuk respons mutasi (assign / status / toggle agent) sama
   * persis dengan item daftar: nama kontak, nama penerima tugas, foto,
   * dan keadaan jendela pesan. Satu tempat, tiga pemakai.
   */
  const respondWithConversation = async (
    c: Context<{ Variables: AppVariables }>,
    tenantId: string,
    id: string,
  ) => {
    const rows = await listConversations(
      bundle.db,
      { tenantId },
      { assignmentUserId: c.get("appUser").id },
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
      { tenantId },
      "contact",
      [updated.contactId],
    );
    return c.json(
      serializeConversation(
        updated,
        withPhoto.has(updated.contactId)
          ? contactAvatarUrl(tenantId, updated.contactId)
          : null,
      ),
    );
  };


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
        status: query.data.status,
        assignment: query.data.assignment,
        search: query.data.q,
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
    const page = await listMessagesPage(
      bundle.db,
      { tenantId: tenant.id },
      id,
      query.data,
    );
    if (page.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    if (page.kind === "invalid_cursor") {
      // Kursor menunjuk pesan yang bukan milik percakapan ini (mis. utas
      // baru dibuka, id lama). Menolak terang-terangan lebih baik daripada
      // menampilkan "sudah sampai awal" yang keliru.
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "`before` must be a message id from this conversation",
      );
    }
    // Membuka utas dari inbox = membaca: bersihkan unread_count agar chip
    // daftar & badge navigasi konsisten (bug QA-1 — sebelumnya unread
    // tidak pernah turun). Hanya jalur manusia ini; agent membaca riwayat
    // lewat core langsung dan tidak menandai terbaca. Pemuatan halaman
    // lama (`before`) tetap dihitung membaca — utasnya sama.
    await markConversationRead(bundle.db, { tenantId: tenant.id }, id);
    const body = MessageListResponseSchema.parse({
      messages: page.messages.map(serializeMessage),
      hasMore: page.hasMore,
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
    if (result.kind === "messaging_window_closed") {
      // Fase 16C: WhatsApp menolak pesan bebas di luar 24 jam sejak pesan
      // masuk terakhir. Kita menolak lebih dulu, dengan waktu yang bisa
      // ditampilkan UI — bukan membiarkan pengguna menunggu pesan `failed`.
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

  /**
   * Fase 16C: kirim template WhatsApp. Pasangan dari
   * `MESSAGING_WINDOW_CLOSED` — setelah jendela 24 jam tertutup ini
   * satu-satunya pesan yang boleh keluar, jadi tanpa endpoint ini
   * kotak balasan yang dimatikan meninggalkan pengguna tanpa jalan.
   */
  app.post(`${base}/:id/template`, async (c) => {
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
    const parsed = SendTemplateMessageRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid template payload");
    }
    const result = await queueTemplateMessage(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      id,
      parsed.data,
    );
    if (result.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    if (result.kind === "provider_unsupported") {
      return apiError(
        c,
        422,
        "MESSAGE_TEMPLATE_UNSUPPORTED",
        "This channel does not use message templates",
      );
    }
    if (result.kind === "template_not_found") {
      // Template milik WABA lain juga sampai di sini: bagi nomor ini
      // template itu memang tidak ada.
      return apiError(
        c,
        404,
        "MESSAGE_TEMPLATE_NOT_FOUND",
        "Template not found for this channel",
      );
    }
    if (result.kind === "template_not_approved") {
      return apiError(
        c,
        422,
        "MESSAGE_TEMPLATE_NOT_APPROVED",
        "Template is not approved by Meta yet",
        { status: result.status },
      );
    }
    if (result.kind === "template_params_invalid") {
      return apiError(
        c,
        422,
        "MESSAGE_TEMPLATE_PARAMS_INVALID",
        "Template variables do not match the template",
        { expected: result.expected, received: result.received },
      );
    }
    if (publisher) {
      await publisher.publishNudge({
        kind: "message.queued",
        tenantId: tenant.id,
        conversationId: id,
      });
    }
    return c.json(serializeMessage(result.message), 201);
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
    return respondWithConversation(c, tenant.id, id);
  });

  // Fase 16C: ubah status kerja percakapan. Tanpa ini filter `closed` di
  // daftar selalu kosong dan tidak ada cara menandai pekerjaan selesai.
  app.patch(`${base}/:id`, async (c) => {
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
    const parsed = UpdateConversationStatusRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid status payload");
    }
    const result = await setConversationStatus(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      id,
      parsed.data.status,
    );
    if (result.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    return respondWithConversation(c, tenant.id, id);
  });

  // Fase 16C: nyalakan/matikan AI untuk percakapan ini. Satu-satunya
  // jalan mengembalikan `agent_enabled` ke true setelah handoff.
  app.post(`${base}/:id/agent`, async (c) => {
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
    const parsed = SetAgentEnabledRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid agent payload");
    }
    const result = await setConversationAgentEnabled(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      id,
      parsed.data.agentEnabled,
    );
    if (result.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    return respondWithConversation(c, tenant.id, id);
  });

  return app;
}
