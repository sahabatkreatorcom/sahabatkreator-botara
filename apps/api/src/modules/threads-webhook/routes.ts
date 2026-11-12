import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  getProviderSecret,
  recordIntegrationLog,
  type PlatformSettingsOptions,
  type RecordIntegrationLogInput,
} from "@sahabat-kreator/core";
import { verifyMetaWebhookSignature } from "@sahabat-kreator/channel-messenger";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";

/**
 * Modul Webhook Threads — endpoint webhook aplikasi THREADS tingkat
 * platform (bukan per-tenant):
 *
 *   GET  /webhooks/threads   handshake verifikasi (hub.mode /
 *                            hub.verify_token / hub.challenge)
 *   POST /webhooks/threads   penerimaan event bertanda tangan
 *   (URL publik kanonis keduanya: /api/webhooks/threads)
 *
 * Aplikasi Threads TERPISAH dari Meta App utama, jadi gerbangnya pun
 * kredensial Threads sendiri — BUKAN kredensial Meta:
 *   - verify token handshake = kunci panel `threads_webhook_verify_token`
 *     (resolver Panel Admin → fallback env THREADS_WEBHOOK_VERIFY_TOKEN),
 *     pola persis `meta_webhook_verify_token`;
 *   - tanda tangan POST = header `X-Hub-Signature-256` (HMAC-SHA256
 *     atas raw body, format Meta) dikunci `threads_app_secret` dari
 *     resolver yang sama.
 *
 * Consumer (jujur, sebatas yang didefinisikan platform secara resmi):
 * Threads mendefinisikan topik webhook mentions / replies / publish /
 * delete — pemberitahuan aktivitas konten. TIDAK ada event resmi
 * pencabutan otorisasi/kedaluwarsa token akun di webhook Threads
 * (berbeda dari TikTok), jadi modul ini TIDAK mengubah state akun:
 * setiap pengiriman yang lolos verifikasi dicatat ke log integrasi
 * (provider 'threads', payload utuh kecuali body raksasa yang
 * ditandai terpotong) dan dijawab 200. Kesegaran token Threads tetap
 * diurus worker lifecycle refresh yang sudah ada.
 */

export interface ThreadsWebhookModuleOptions {
  /**
   * Opsi pengaturan platform — verify token + app secret dibaca per
   * request dari Panel Admin (fallback env). Bila diisi, nilai statis
   * di bawah diabaikan.
   */
  platform?: PlatformSettingsOptions;
  /** Verify token statis (mode uji / fallback tanpa resolver). */
  verifyToken?: string;
  /** App secret statis (mode uji / fallback tanpa resolver). */
  appSecret?: string;
}

/** Payload log dipotong di atas ukuran ini (payload Threads wajarnya kecil). */
const LOG_PAYLOAD_MAX_CHARS = 8192;

/** Perbandingan string aman-timing via hash (pola modul meta). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function createThreadsWebhookRoutes(
  bundle: AuthBundle | null,
  opts: ThreadsWebhookModuleOptions,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  async function logIntegration(
    input: Omit<RecordIntegrationLogInput, "direction" | "provider">,
  ): Promise<void> {
    if (!bundle) return;
    try {
      await recordIntegrationLog(bundle.db, {
        direction: "in",
        provider: "threads",
        ...input,
      });
    } catch {
      // Log observabilitas tidak boleh menjatuhkan webhook.
    }
  }

  async function resolveKey(
    key: "threads_webhook_verify_token" | "threads_app_secret",
    staticValue: string | undefined,
  ): Promise<string | null> {
    if (!bundle) return staticValue ?? null;
    return opts.platform
      ? getProviderSecret(bundle.db, key, opts.platform)
      : (staticValue ?? null);
  }

  app.get("/webhooks/threads", async (c) => {
    if (!bundle) {
      return apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    }
    const verifyToken = await resolveKey(
      "threads_webhook_verify_token",
      opts.verifyToken,
    );
    if (!verifyToken) {
      await logIntegration({
        outcome: "rejected_unconfigured",
        summary: "Threads webhook handshake rejected: verify token not configured",
      });
      return apiError(
        c,
        503,
        "THREADS_NOT_CONFIGURED",
        "Threads webhook verify token is not configured",
      );
    }
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (
      mode === "subscribe" &&
      token !== undefined &&
      safeEqual(token, verifyToken) &&
      challenge !== undefined
    ) {
      await logIntegration({
        signatureValid: true,
        outcome: "recorded",
        summary: "Threads webhook verification handshake succeeded",
      });
      return c.text(challenge, 200);
    }
    await logIntegration({
      signatureValid: false,
      outcome: "rejected_signature",
      summary: "Threads webhook verification handshake rejected",
    });
    return apiError(c, 403, "FORBIDDEN", "Webhook verification failed");
  });

  app.post("/webhooks/threads", async (c) => {
    if (!bundle) {
      return apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    }
    const appSecret = await resolveKey("threads_app_secret", opts.appSecret);
    if (!appSecret) {
      await logIntegration({
        outcome: "rejected_unconfigured",
        summary: "Threads webhook rejected: app secret not configured",
      });
      return apiError(
        c,
        503,
        "THREADS_NOT_CONFIGURED",
        "Threads app secret is not configured",
      );
    }
    const rawBody = await c.req.text();
    if (
      !verifyMetaWebhookSignature(
        rawBody,
        c.req.header("x-hub-signature-256"),
        appSecret,
      )
    ) {
      await logIntegration({
        signatureValid: false,
        outcome: "rejected_signature",
        summary: "Threads webhook rejected: signature invalid",
      });
      return apiError(
        c,
        401,
        "THREADS_SIGNATURE_INVALID",
        "Invalid X-Hub-Signature-256",
      );
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      await logIntegration({
        signatureValid: true,
        outcome: "error",
        errorCode: "invalid_json",
        summary: "Threads webhook accepted but body is not valid JSON",
      });
      return c.json({ ok: true });
    }
    const objectKind =
      typeof parsed.object === "string" ? parsed.object : "(unknown)";
    await logIntegration({
      signatureValid: true,
      outcome: "recorded",
      summary: `Threads webhook event recorded (object=${objectKind})`,
      payload:
        rawBody.length > LOG_PAYLOAD_MAX_CHARS
          ? { truncated: true, object: objectKind }
          : parsed,
    });
    return c.json({ ok: true });
  });

  return app;
}
