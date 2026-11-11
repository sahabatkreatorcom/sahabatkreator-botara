import { timingSafeEqual, createHash } from "node:crypto";
import { Hono } from "hono";
import {
  getProviderSecret,
  recordIntegrationLog,
  type PlatformSettingsOptions,
  type RecordIntegrationLogInput,
} from "@sahabat-kreator/core";
import { verifyMetaWebhookSignature } from "@sahabat-kreator/channel-messenger";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { processMetaWebhookPayload } from "./process";

/**
 * Modul meta publik (Fase 7A; WhatsApp Fase 7B) — webhook TUNGGAL Meta
 * untuk Messenger + Instagram + WhatsApp. TANPA sesi dashboard.
 *
 *   GET  /meta/webhook   handshake verifikasi (hub.mode/hub.verify_token/
 *                        hub.challenge dari dashboard Meta App)
 *   POST /meta/webhook   event messaging bertanda tangan
 *
 * Kepercayaan berlapis (berbeda dari Telegram yang per-akun):
 * 1. Handshake: `hub.verify_token` harus sama persis dengan token
 *    verifikasi efektif (nilai yang KITA tentukan dan ditempel pemilik
 *    platform ke Meta App; diselesaikan Panel Admin → env
 *    `META_WEBHOOK_VERIFY_TOKEN` per request). Selain itu 403.
 * 2. Event: header `X-Hub-Signature-256` = HMAC-SHA256(raw body, App
 *    Secret Meta). Secret diselesaikan panel → env (Fase 7A.1, resolver
 *    Panel Admin 6C: panel menang, env `META_APP_SECRET` fallback, cache
 *    ±60 dtk — perubahan panel berlaku TANPA restart). App secret belum
 *    diset di mana pun → 503 META_NOT_CONFIGURED (fail-closed: tanpa
 *    secret, tidak ada payload yang bisa dipercaya); tanda tangan salah
 *    → 401 META_SIGNATURE_INVALID.
 * 3. Sesudah tanda tangan lolos, akun diselesaikan dari `entry.id`
 *    payload per (provider, external_id) lewat lengan RLS 0020;
 *    objek `page` → messenger, `instagram` → instagram. Akun tak
 *    dikenal / tidak 'connected' → event diabaikan (tetap 200 agar Meta
 *    tidak me-retry; disconnect di sisi kita memang memutus arus ini).
 *
 * Handler menjawab cepat: event non-teks & echo (pantulan kiriman kita
 * sendiri, `message.is_echo`) dilewati; DM teks disimpan lewat core
 * (kontak + percakapan + pesan + outbox `message.received` dalam satu
 * transaksi) — automation/agent bekerja di worker lewat relay outbox.
 * Identitas yang BARU pertama kali terlihat memicu pengambilan profil
 * Graph kontaknya (nama + foto, pola Fase 6D) secara fire-and-forget.
 *
 * Fase 7B.1: setiap hit & event menulis baris `integration_log` dengan
 * outcome jujur per titik keluar (termasuk 503 belum terkonfigurasi &
 * 401 tanda tangan salah di gerbang bersama, provider 'meta'); payload
 * per baris event = seluruh payload hit (dibatasi ±32KB di core).
 * Handshake GET yang SUKSES sengaja tidak dicatat (bukan event).
 */
export interface MetaModuleOptions {
  /**
   * Opsi resolver Panel Admin (Fase 7A.1): bila ada, App Secret untuk
   * verifikasi tanda tangan diselesaikan per request lewat core
   * `getProviderSecret(db, "meta_app_secret", platform)` — panel → env
   * `META_APP_SECRET` → null, cache ±60 dtk per proses.
   */
  platform?: PlatformSettingsOptions;
  /**
   * Secret statis (env META_APP_SECRET) — hanya dipakai bila `platform`
   * tidak diberikan (pemanggil langsung/uji lama).
   */
  appSecret?: string;
  /**
   * Verify token handshake statis (env META_WEBHOOK_VERIFY_TOKEN) —
   * hanya dipakai bila `platform` tidak diberikan (pemanggil
   * langsung/uji lama). Dengan `platform`, token diselesaikan per
   * request lewat resolver Panel Admin (panel `meta_webhook_verify_token`
   * → env → statis ini), persis pola app secret Fase 7A.1.
   */
  verifyToken?: string;
  /** Material kunci dekripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string;
  /** Versi Graph ter-pin (dari @sahabat-kreator/config). */
  graphApiVersion: string;
}

export function createMetaRoutes(
  bundle: AuthBundle | null,
  publisher: RealtimePublisher | null,
  opts: MetaModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  /**
   * Fase 7B.1: pencatatan log integrasi untuk hit webhook Meta —
   * best-effort murni (tidak pernah mengubah respons). Baris pra-rute
   * (handshake gagal, secret belum terpasang, tanda tangan buruk)
   * memakai provider 'meta' dan tenant NULL; baris per event memakai
   * provider konkret sesudah resolusi akun.
   */
  const logIntegration = async (
    entry: RecordIntegrationLogInput,
  ): Promise<void> => {
    if (!bundle) return;
    try {
      await recordIntegrationLog(bundle.db, entry);
    } catch {
      // Sengaja ditelan: log tidak boleh menjatuhkan webhook.
    }
  };

  app.get("/meta/webhook", async (c) => {
    // Token efektif per request (instruksi pemilik 2026-11-12): resolver
    // Panel Admin → env dengan cache ±60 dtk, pola yang sama seperti
    // app secret di POST — perubahan panel berlaku TANPA restart.
    const verifyToken =
      opts.platform && bundle
        ? ((await getProviderSecret(
            bundle.db,
            "meta_webhook_verify_token",
            opts.platform,
          )) ?? opts.verifyToken)
        : opts.verifyToken;
    if (!verifyToken) {
      await logIntegration({
        direction: "in",
        provider: "meta",
        outcome: "rejected_unconfigured",
        summary: "GET handshake rejected: verify token not configured",
      });
      return apiError(
        c,
        503,
        "META_NOT_CONFIGURED",
        "Meta webhook verify token is not configured",
      );
    }
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    // Perbandingan timing-safe (Hotfix analisis 2026-11-03): token di-hash
    // dulu agar panjangnya selalu sama (timingSafeEqual melempar bila beda
    // panjang), lalu dibandingkan konstanta-waktu — token verify ini
    // rahasia statis jangka panjang, jadi banding biasa === bocor panjang
    // prefix lewat pengukuran waktu.
    const expectedDigest = createHash("sha256").update(verifyToken).digest();
    const presentedDigest = createHash("sha256").update(token ?? "").digest();
    if (
      mode === "subscribe" &&
      timingSafeEqual(expectedDigest, presentedDigest) &&
      challenge
    ) {
      // Handshake sukses SENGAJA tidak dicatat (bukan event; menghindari
      // derau dari pemeriksaan berkala Meta) — yang dicatat hanya
      // penolakannya.
      return c.text(challenge, 200);
    }
    await logIntegration({
      direction: "in",
      provider: "meta",
      signatureValid: false,
      outcome: "rejected_signature",
      summary: "GET handshake rejected: verify token mismatch",
    });
    return apiError(c, 403, "FORBIDDEN", "Webhook verification failed");
  });

  app.post("/meta/webhook", async (c) => {
    if (!bundle) {
      return apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    }
    // Secret efektif per request (Fase 7A.1): resolver panel → env dengan
    // cache ±60 dtk — nilai panel terbaru dipakai tanpa restart; set/clear
    // dari Panel Admin di proses ini membuang cache-nya seketika.
    const appSecret = opts.platform
      ? await getProviderSecret(bundle.db, "meta_app_secret", opts.platform)
      : opts.appSecret;
    if (!appSecret) {
      await logIntegration({
        direction: "in",
        provider: "meta",
        outcome: "rejected_unconfigured",
        summary: "POST rejected: meta app secret not configured",
      });
      return apiError(
        c,
        503,
        "META_NOT_CONFIGURED",
        "Meta app secret is not configured",
      );
    }
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (!verifyMetaWebhookSignature(rawBody, signature, appSecret)) {
      // Payload untuk log dibaca best-effort dari body mentah (JSON
      // rusak → null). Nilai tanda tangan TIDAK PERNAH ditulis.
      let rawForLog: unknown = null;
      try {
        rawForLog = JSON.parse(rawBody);
      } catch {
        rawForLog = null;
      }
      await logIntegration({
        direction: "in",
        provider: "meta",
        signatureValid: false,
        outcome: "rejected_signature",
        summary: "POST rejected: signature verification failed",
        payload: rawForLog,
      });
      return apiError(
        c,
        401,
        "META_SIGNATURE_INVALID",
        "Invalid webhook signature",
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // Body rusak dari pengirim yang lolos tanda tangan: jawab 200 agar
      // Meta tidak me-retry selamanya; tidak ada yang disimpan.
      await logIntegration({
        direction: "in",
        provider: "meta",
        signatureValid: true,
        outcome: "error",
        errorCode: "invalid_json",
        summary: "POST body is not valid JSON",
      });
      return c.json({ ok: true });
    }

    // Pemrosesan payload yang sudah lolos gerbang (Fase 7B.2:
    // diekstrak ke process.ts agar jalur yang sama persis dipakai
    // replay log integrasi — dispatch WhatsApp vs messaging Page/IG
    // terjadi di sana). Error core per event dicatat di sana lalu
    // dilempar ulang — perilaku respons route tidak berubah.
    await processMetaWebhookPayload(
      {
        db: bundle.db,
        publisher,
        channelTokenSecret: opts.channelTokenSecret,
        metaApiBase: opts.metaApiBase,
        graphApiVersion: opts.graphApiVersion,
        log: logIntegration,
      },
      payload,
    );
    return c.json({ ok: true });
  });

  return app;
}
