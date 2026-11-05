import { Hono } from "hono";
import { z } from "zod";
import {
  recordIntegrationLog,
  resolveTelegramAccountById,
  verifyChannelWebhookSecret,
  type RecordIntegrationLogInput,
} from "@sahabat-kreator/core";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { processTelegramUpdate } from "./process";

/**
 * Modul telegram publik (Fase 6A) — webhook Bot API. TANPA sesi dashboard.
 *
 *   POST /telegram/webhook/:channelAccountId
 *
 * Kepercayaan berlapis:
 * 1. Id akun di URL (UUID acak) menyelesaikan tenant lewat lengan RLS
 *    `telegram_webhook_lookup` — id saja tidak membuktikan apa pun.
 * 2. Header `X-Telegram-Bot-Api-Secret-Token` diverifikasi terhadap hash
 *    secret yang tersimpan di baris akun (secret dibuat server saat
 *    connect dan didaftarkan ke Telegram via setWebhook). Salah/tidak
 *    ada → 401 generik, tanpa membocorkan apakah akunnya ada.
 *
 * Handler menjawab cepat: update non-pesan-teks dijawab 200 dan diabaikan;
 * pesan teks disimpan lewat core (kontak + percakapan + pesan + outbox
 * `message.received` dalam satu transaksi) — pemrosesan berat (automation,
 * agent) terjadi di worker lewat relay outbox, bukan di request ini.
 * Update `channel_post` (Fase 6A.2) punya jalur sendiri ke linimasa
 * channel dan SENGAJA tidak menghasilkan event outbox itu.
 *
 * Fase 7B.1: SETIAP hit (termasuk 404 akun tak dikenal, 401 secret
 * salah, akun disconnected, duplikat, update non-pesan) menulis satu
 * baris `integration_log` dengan outcome jujur per titik keluar —
 * best-effort, tidak pernah mengubah respons di atas.
 */
export interface TelegramModuleOptions {
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Bot API (env TELEGRAM_API_BASE; default api.telegram.org). */
  telegramApiBase?: string;
}

export function createTelegramRoutes(
  bundle: AuthBundle | null,
  publisher?: RealtimePublisher | null,
  opts: TelegramModuleOptions = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();

  /**
   * Fase 7B.1: pencatatan log integrasi untuk SETIAP hit webhook —
   * best-effort murni. `recordIntegrationLog` sendiri tidak pernah
   * melempar; pembungkus ini lapis kedua agar kegagalan observabilitas
   * tidak pernah mengubah respons webhook (200 tetap 200, 401 tetap 401).
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

  app.post("/telegram/webhook/:channelAccountId", async (c) => {
    if (!bundle) {
      return apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    }
    const channelAccountId = c.req.param("channelAccountId");
    if (!z.string().uuid().safeParse(channelAccountId).success) {
      await logIntegration({
        direction: "in",
        provider: "telegram",
        outcome: "unresolved_account",
        summary: `webhook hit for malformed account id ${channelAccountId}`,
      });
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    const account = await resolveTelegramAccountById(
      bundle.db,
      channelAccountId,
    );
    if (!account) {
      // Payload dibaca best-effort untuk log (parse gagal → null);
      // Hono meng-cache body sehingga pembacaan jalur normal tidak
      // terpengaruh. Akun tak dikenal → baris platform (tenant NULL).
      const rawForLog = await c.req.json().catch(() => null);
      await logIntegration({
        direction: "in",
        provider: "telegram",
        outcome: "unresolved_account",
        summary: `webhook hit for unknown account ${channelAccountId}`,
        payload: rawForLog,
      });
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    const presented = c.req.header("x-telegram-bot-api-secret-token");
    if (
      !presented ||
      !verifyChannelWebhookSecret(presented, account.webhookSecret)
    ) {
      const rawForLog = await c.req.json().catch(() => null);
      await logIntegration({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: false,
        outcome: "rejected_signature",
        summary: "webhook secret token mismatch",
        payload: rawForLog,
      });
      return apiError(c, 401, "UNAUTHORIZED", "Invalid webhook secret");
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      // Body rusak dari pengirim yang lolos secret: jawab 200 agar
      // Telegram tidak me-retry selamanya; tidak ada yang disimpan.
      await logIntegration({
        direction: "in",
        provider: "telegram",
        tenantId: account.tenantId,
        channelAccountId: account.id,
        signatureValid: true,
        outcome: "error",
        errorCode: "invalid_json",
        summary: "webhook body is not valid JSON",
      });
      return c.json({ ok: true });
    }
    // Pemrosesan update yang sudah lolos gerbang (Fase 7B.2:
    // diekstrak ke process.ts agar jalur yang sama persis dipakai
    // replay log integrasi). Error core per event dicatat di sana
    // lalu dilempar ulang — perilaku respons route tidak berubah.
    await processTelegramUpdate(
      {
        db: bundle.db,
        publisher,
        channelTokenSecret: opts.channelTokenSecret,
        telegramApiBase: opts.telegramApiBase,
        log: logIntegration,
      },
      account,
      payload,
    );
    return c.json({ ok: true });
  });

  return app;
}
