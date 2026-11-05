import { Hono } from "hono";
import {
  MessageListResponseSchema,
  WebchatSendMessageRequestSchema,
  WebchatSessionRequestSchema,
  WebchatSessionResponseSchema,
} from "@sahabat-kreator/contracts";
import {
  attributeContactToGrowthLink,
  getWebchatChannelAccountStatus,
  listMessages,
  openWebchatSession,
  recordWebchatInboundMessage,
  resolveWebchatAccountBySiteKey,
} from "@sahabat-kreator/core";
import {
  createWebchatVisitorToken,
  verifyWebchatVisitorToken,
  type WebchatVisitorTokenPayload,
} from "@sahabat-kreator/channel-webchat";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { serializeMessage } from "../messages-serialize";

/**
 * Modul webchat publik (Fase 1F) — API widget untuk PENGUNJUNG situs tenant.
 * TANPA sesi dashboard. Autentikasi dua lapis:
 * - siteKey publik (`wc_...` di URL sesi) mengidentifikasi channel/tenant;
 * - token pengunjung HMAC (Bearer) mengidentifikasi kontak + percakapan.
 *
 * Route (di-mount di root DAN di bawah /api seperti modul lain):
 *   POST /webchat/:siteKey/session   buka/temukan sesi → {token, ...pesan}
 *   GET  /webchat/messages           pesan percakapan (Bearer; sinkronisasi)
 *   POST /webchat/messages           kirim pesan inbound (Bearer)
 *
 * WebSocket pengunjung BUKAN lagi di proses ini (Fase 6G): socket widget
 * kini terhubung ke apps/realtime (`/realtime/webchat?token=...`). Modul
 * ini hanya menerbitkan nudge `message.received` ke Redis setelah pesan
 * inbound ter-commit, agar dashboard agen menyegar seketika; widget
 * sendiri tetap membaca lewat REST (polling + nudge dari realtime).
 *
 * Gerbang disconnect (hotfix Webchat Disconnect Gate): selama akun
 * channel tidak 'connected', arus pengunjung berhenti TOTAL — sesi baru
 * memang sudah 404 (route sesi di bawah), dan kini jalur berbasis token
 * juga digerbangi: kirim pesan digerbangi di dalam transaksi core, dan
 * daftar pesan digerbangi di route ini sebelum membaca. Keduanya
 * menjawab **409 `CHANNEL_DISCONNECTED`** — 409 mengikuti pola konflik
 * keadaan yang sudah ada di API ini (TELEGRAM_BOT_ALREADY_CONNECTED,
 * PRODUCT_HAS_LINKS): token pengunjung SAH dan percakapan ADA, yang
 * berkonflik adalah keadaan channel-nya. Token TIDAK dibatalkan —
 * menghubungkan lagi channel yang sama membuatnya berlaku lagi.
 */

export interface WebchatModuleOptions {
  /** Secret HMAC token pengunjung (env WEBCHAT_SECRET). */
  secret: string | undefined;
  /** Penerbit nudge realtime (Fase 6G); null bila Redis tidak diatur. */
  publisher: RealtimePublisher | null;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function createWebchatRoutes(
  bundle: AuthBundle | null,
  opts: WebchatModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  /**
   * CORS permisif KHUSUS endpoint publik webchat (hotfix 2026-11-02).
   *
   * Widget ini memang dirancang dipasang di website LAIN (kasus utama
   * produk — pemilik workspace menempel snippet di situsnya sendiri) dan
   * juga dibuka dari halaman file:// (Origin: null). Tanpa
   * `Access-Control-Allow-Origin` pada respons aktual, browser memblokir
   * SEMUA panggilan widget lintas-origin walau preflight-nya lolos —
   * widget macet di "Connecting…" di situs tenant.
   *
   * Permisif aman di sini karena endpoint ini publik BY DESIGN:
   * autentikasinya siteKey publik + token pengunjung HMAC (header
   * Bearer), BUKAN cookie sesi dashboard — tidak ada kredensial ambient
   * yang bisa disalahgunakan lintas origin. Header dipasang juga pada
   * respons error (404/401/…) agar browser menyampaikan error yang benar
   * ke widget, bukan kegagalan jaringan yang buram. Endpoint
   * tenant/dashboard TIDAK mendapat perlakuan ini.
   */
  app.use("/webchat/*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      c.header("Access-Control-Max-Age", "86400");
      return c.body(null, 204);
    }
    await next();
  });

  const notConfigured = (c: Parameters<typeof apiError>[0]) =>
    apiError(c, 503, "INTERNAL_ERROR", "Webchat is not configured");
  const configured = Boolean(bundle && opts.secret);

  function visitorPayload(c: {
    req: { header: (name: string) => string | undefined };
  }): WebchatVisitorTokenPayload | null {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !opts.secret) return null;
    return verifyWebchatVisitorToken(opts.secret, token);
  }

  app.post("/webchat/:siteKey/session", async (c) => {
    if (!configured || !bundle || !opts.secret) return notConfigured(c);
    const siteKey = c.req.param("siteKey");
    const account = await resolveWebchatAccountBySiteKey(bundle.db, siteKey);
    if (!account || account.status !== "connected") {
      return apiError(c, 404, "NOT_FOUND", "Webchat site not found");
    }
    let json: unknown = {};
    const raw = await c.req.text();
    if (raw.trim()) {
      try {
        json = JSON.parse(raw);
      } catch {
        return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
      }
    }
    const parsed = WebchatSessionRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid session payload");
    }
    const session = await openWebchatSession(bundle.db, account, parsed.data);
    // Fase 13B: sesi yang dibuka dari tautan growth (/go/<slug> →
    // halaman chat ?src=<slug> → widget meneruskan `src`) mengatribusi-
    // kan kontak ke tautan itu. Best-effort PENUH: slug asing/nonaktif/
    // bukan milik channel ini adalah no-op beralasan di core, dan
    // kegagalan DB di sini tidak pernah menggagalkan sesi pengunjung.
    if (parsed.data.src) {
      try {
        await attributeContactToGrowthLink(bundle.db, {
          tenantId: account.tenantId,
          contactId: session.contactId,
          slug: parsed.data.src,
          channelAccountId: account.id,
        });
      } catch (err) {
        console.error("[webchat] atribusi growth link gagal", err);
      }
    }
    const token = createWebchatVisitorToken(opts.secret, {
      tid: account.tenantId,
      acc: account.id,
      con: session.contactId,
      cv: session.conversationId,
    });
    const body = WebchatSessionResponseSchema.parse({
      token,
      contactId: session.contactId,
      conversationId: session.conversationId,
      messages: session.messages.map(serializeMessage),
    });
    return c.json(body);
  });

  app.get("/webchat/messages", async (c) => {
    if (!configured || !bundle) return notConfigured(c);
    const payload = visitorPayload(c);
    if (!payload) return apiError(c, 401, "UNAUTHORIZED", "Invalid visitor token");
    // Gerbang disconnect (lihat komentar modul): token lama tidak cukup
    // — akun channel pemilik token harus sedang 'connected'. Akun yang
    // sudah tidak ada diperlakukan sama seperti percakapan tak ditemukan.
    const accountStatus = await getWebchatChannelAccountStatus(
      bundle.db,
      { tenantId: payload.tid },
      payload.acc,
    );
    if (accountStatus === null) {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    if (accountStatus !== "connected") {
      return apiError(c, 409, "CHANNEL_DISCONNECTED", "Channel is disconnected");
    }
    const rows = await listMessages(
      bundle.db,
      { tenantId: payload.tid },
      payload.cv,
      { limit: 100 },
    );
    if (!rows) return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    const body = MessageListResponseSchema.parse({
      messages: rows.map(serializeMessage),
    });
    return c.json(body);
  });

  app.post("/webchat/messages", async (c) => {
    if (!configured || !bundle) return notConfigured(c);
    const payload = visitorPayload(c);
    if (!payload) return apiError(c, 401, "UNAUTHORIZED", "Invalid visitor token");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = WebchatSendMessageRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid message payload");
    }
    const result = await recordWebchatInboundMessage(
      bundle.db,
      { tenantId: payload.tid, conversationId: payload.cv },
      parsed.data,
    );
    if (result.outcome === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    if (result.outcome === "channel_disconnected") {
      // Gerbang disconnect di core menolak SEBELUM tulisan apa pun:
      // tidak ada pesan/unread/outbox dari upaya ini, dan nudge tidak
      // diterbitkan. 409 — pola konflik keadaan (lihat komentar modul).
      return apiError(c, 409, "CHANNEL_DISCONNECTED", "Channel is disconnected");
    }
    const message = result.message;
    // Fase 6G: pesan sudah ter-commit — terbitkan nudge agar dashboard
    // agen menyegar seketika (fail-soft; polling dashboard menutupi
    // kegagalan Redis).
    if (opts.publisher) {
      await opts.publisher.publishNudge({
        kind: "message.received",
        tenantId: payload.tid,
        conversationId: payload.cv,
      });
    }
    return c.json(serializeMessage(message), 201);
  });

  return app;
}
