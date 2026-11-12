import { Hono } from "hono";
import {
  getProviderSecret,
  lookupChannelAccountsByProviderExternalId,
  recordIntegrationLog,
  updateTikTokChannelAccountCredentials,
  type PlatformSettingsOptions,
  type RecordIntegrationLogInput,
} from "@sahabat-kreator/core";
import { verifyTikTokWebhookSignature } from "@sahabat-kreator/channel-tiktok";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";

/**
 * Modul Webhook TikTok — endpoint webhook MANAJEMEN TikTok tingkat
 * platform (bukan per-tenant, pola webhook Meta):
 *
 *   POST /webhooks/tiktok   (URL publik kanonis: /api/webhooks/tiktok)
 *
 * Bentuk resmi TikTok (dokumentasi Webhooks TikTok): TIDAK ada
 * handshake GET — URL didaftarkan di portal aplikasi dan setiap
 * pengiriman adalah POST JSON bertanda tangan header
 * `TikTok-Signature: t=<unix>,s=<hex>` = HMAC-SHA256 atas
 * `<t>.<raw body>` dikunci CLIENT SECRET aplikasi (di sini:
 * `tiktok_client_secret` lewat resolver Panel Admin → fallback env).
 * Cap waktu di luar ±5 menit ditolak (jendela resmi TikTok).
 * Pengiriman bersifat at-least-once (TikTok mencoba ulang s/d ±72
 * jam), jadi consumer di bawah IDEMPOTEN.
 *
 * Event resmi dan consumer-nya (jujur, tanpa mengada-ada):
 *   - `authorization.removed` — pengguna mencabut otorisasi aplikasi:
 *     akun TikTok yang `external_id`-nya = `user_openid` payload
 *     ditandai 'disconnected' + errorCode
 *     'tiktok_authorization_removed' agar UI meminta hubungkan ulang.
 *     `content` payload adalah STRING JSON berisi `reason` (kode
 *     resmi 0–5: dicabut pengguna, token kedaluwarsa, dsb.).
 *   - `video.publish.completed`, `video.upload.failed`,
 *     `portability.download.ready` — DICATAT ke log integrasi saja:
 *     publisher content schedule MEMOLLING status/fetch sebagai
 *     sumber kebenaran status postingan, webhook TIDAK mengubah
 *     state postingan (menghindarkan transisi ganda).
 *   - Event lain → diterima 200 + dicatat sebagai diterima-diabaikan.
 *
 * Tanda tangan tidak sah/kedaluwarsa → ditolak TANPA efek apa pun
 * (hanya baris log gerbang). Tidak ada secret/token yang masuk log:
 * payload yang dicatat hanya untuk event yang lolos verifikasi dan
 * bentuknya metadata platform (open_id + content event), bukan
 * kredensial.
 */

export interface TikTokWebhookModuleOptions {
  /**
   * Opsi pengaturan platform — client secret dibaca per request dari
   * Panel Admin (fallback env). Bila diisi, `clientSecret` statis
   * diabaikan.
   */
  platform?: PlatformSettingsOptions;
  /** Client secret statis (mode uji / fallback tanpa resolver). */
  clientSecret?: string;
}

/** Jendela toleransi cap waktu tanda tangan (detik) — resmi TikTok ±5 menit. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Envelope webhook TikTok sebagaimana didokumentasikan platform. */
interface TikTokWebhookEnvelope {
  event?: unknown;
  client_key?: unknown;
  create_time?: unknown;
  user_openid?: unknown;
  content?: unknown;
}

export function createTikTokWebhookRoutes(
  bundle: AuthBundle | null,
  opts: TikTokWebhookModuleOptions,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  async function logIntegration(
    input: Omit<RecordIntegrationLogInput, "direction" | "provider">,
  ): Promise<void> {
    if (!bundle) return;
    try {
      await recordIntegrationLog(bundle.db, {
        direction: "in",
        provider: "tiktok",
        ...input,
      });
    } catch {
      // Log observabilitas tidak boleh menjatuhkan webhook.
    }
  }

  app.post("/webhooks/tiktok", async (c) => {
    if (!bundle) {
      return apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    }
    const clientSecret = opts.platform
      ? await getProviderSecret(bundle.db, "tiktok_client_secret", opts.platform)
      : opts.clientSecret;
    if (!clientSecret) {
      await logIntegration({
        outcome: "rejected_unconfigured",
        summary: "TikTok webhook rejected: client secret not configured",
      });
      return apiError(
        c,
        503,
        "TIKTOK_NOT_CONFIGURED",
        "TikTok client secret is not configured",
      );
    }

    const rawBody = await c.req.text();
    const { valid, timestampSeconds } = verifyTikTokWebhookSignature(
      rawBody,
      c.req.header("tiktok-signature"),
      clientSecret,
    );
    if (!valid || timestampSeconds === null) {
      await logIntegration({
        signatureValid: false,
        outcome: "rejected_signature",
        summary: "TikTok webhook rejected: signature invalid",
      });
      return apiError(
        c,
        401,
        "TIKTOK_SIGNATURE_INVALID",
        "Invalid TikTok-Signature header",
      );
    }
    const ageSeconds = Math.abs(
      Math.floor(Date.now() / 1000) - timestampSeconds,
    );
    if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) {
      await logIntegration({
        signatureValid: false,
        outcome: "rejected_signature",
        errorCode: "stale_timestamp",
        summary: "TikTok webhook rejected: signature timestamp stale",
      });
      return apiError(
        c,
        401,
        "TIKTOK_SIGNATURE_INVALID",
        "Stale TikTok-Signature timestamp",
      );
    }

    let envelope: TikTokWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody) as TikTokWebhookEnvelope;
    } catch {
      await logIntegration({
        signatureValid: true,
        outcome: "error",
        errorCode: "invalid_json",
        summary: "TikTok webhook rejected: body is not valid JSON",
      });
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid JSON body");
    }
    const event = typeof envelope.event === "string" ? envelope.event : "";
    const openId =
      typeof envelope.user_openid === "string" ? envelope.user_openid : null;

    if (event === "authorization.removed") {
      if (!openId) {
        await logIntegration({
          signatureValid: true,
          outcome: "recorded",
          errorCode: "missing_open_id",
          summary:
            "TikTok authorization.removed without user_openid; nothing to disconnect",
          payload: envelope as Record<string, unknown>,
        });
        return c.json({ ok: true });
      }
      const accounts = await lookupChannelAccountsByProviderExternalId(
        bundle.db,
        "tiktok",
        openId,
      );
      if (accounts.length === 0) {
        await logIntegration({
          signatureValid: true,
          outcome: "recorded",
          summary:
            "TikTok authorization.removed for an open_id with no local account",
          payload: envelope as Record<string, unknown>,
        });
        return c.json({ ok: true });
      }
      for (const account of accounts) {
        if (account.status !== "disconnected") {
          await updateTikTokChannelAccountCredentials(
            bundle.db,
            { tenantId: account.tenantId },
            account.id,
            {
              status: "disconnected",
              errorCode: "tiktok_authorization_removed",
            },
          );
        }
        await logIntegration({
          tenantId: account.tenantId,
          channelAccountId: account.id,
          signatureValid: true,
          outcome: "recorded",
          summary:
            account.status === "disconnected"
              ? "TikTok authorization.removed (already disconnected; idempotent)"
              : "TikTok authorization.removed: account marked disconnected",
          payload: envelope as Record<string, unknown>,
        });
      }
      return c.json({ ok: true });
    }

    // Event resmi non-pencabutan + event tak dikenal: catat saja.
    // Status publikasi SENGAJA tidak diubah dari sini — polling
    // status/fetch oleh publisher adalah sumber kebenarannya.
    await logIntegration({
      signatureValid: true,
      outcome: "recorded",
      summary:
        event === "video.publish.completed" ||
        event === "video.upload.failed" ||
        event === "portability.download.ready"
          ? `TikTok webhook event recorded (no state change; publisher polling is authoritative): ${event}`
          : `TikTok webhook event received and ignored: ${event || "(empty)"}`,
      payload: envelope as Record<string, unknown>,
    });
    return c.json({ ok: true });
  });

  return app;
}
