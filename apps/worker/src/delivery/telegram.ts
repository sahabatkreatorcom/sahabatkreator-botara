import type { Database } from "@sahabat-kreator/db";
import {
  extractRawProviderMessageId,
  getMessageProviderMessageId,
  listQueuedTelegramDeliveries,
  type TelegramQueuedDelivery,
} from "@sahabat-kreator/core";
import {
  TelegramApiError,
  TelegramBotApiClient,
} from "@sahabat-kreator/channel-telegram";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import {
  startDeliveryPoller,
  type DeliveryPoller,
  type QueuedDeliveryBase,
} from "./runner";

/**
 * Poller pengiriman Telegram (Fase 6A) — berupa SPESIFIKASI di atas
 * runner bersama `./runner.ts` (Hotfix analisis 2026-11-03: siklus
 * klaim/kirim/tandai/log/nudge sebelumnya diduplikasi dengan poller
 * Meta).
 *
 * Semua balasan (dashboard, automation, sequence, agent AI) untuk
 * percakapan Telegram berakhir sebagai pesan outbound `queued` di DB.
 * Runner memindai antrean lintas tenant, mengklaim tiap baris, lalu
 * memanggil `send` di bawah (Bot API `sendMessage`).
 *
 * Token TIDAK PERNAH dicatat: log hanya memuat kode error aman
 * (`telegram_http_<status>`) — pesan error klien Bot API kita memang
 * dirancang bebas token/URL.
 */

type TelegramDelivery = TelegramQueuedDelivery & QueuedDeliveryBase;

export interface TelegramPollerOptions {
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret: string | undefined;
  /** Base URL Bot API (env TELEGRAM_API_BASE; default api.telegram.org). */
  telegramApiBase: string | undefined;
  /** Penerbit nudge realtime (Fase 6G). */
  publisher?: RealtimePublisher | null;
}

export type TelegramDeliveryPoller = DeliveryPoller;

export function startTelegramDeliveryPoller(
  db: Database,
  opts: TelegramPollerOptions,
  intervalMs = 2_000,
): TelegramDeliveryPoller {
  return startDeliveryPoller<TelegramDelivery>(
    db,
    {
      name: "telegram",
      scan: async (conn) =>
        (await listQueuedTelegramDeliveries(conn)).map((delivery) => ({
          ...delivery,
          encryptedToken: delivery.encryptedBotToken,
          recipientLabel: `chat ${delivery.chatExternalId}`,
          logProvider: "telegram",
        })),
      emptyTextCode: "telegram_empty_text",
      missingCredentialsCode: "telegram_missing_credentials",
      undecryptableCode: "telegram_token_undecryptable",
      async send(delivery, token, conn) {
        // Fase 7B.5: kutipan native — turunkan message_id numerik pesan
        // target dari barisnya dalam konteks tenant ini (id provider
        // kutipan tidak disimpan duplikat; antrean lintas tenant hanya
        // membawa id baris target). Target tanpa id provider yang bisa
        // diuraikan (mis. pesan webchat lama) → kirim polos tanpa
        // reply_parameters.
        let replyToMessageId: number | undefined;
        if (delivery.replyToMessageId) {
          const composite = await getMessageProviderMessageId(
            conn,
            { tenantId: delivery.tenantId },
            delivery.replyToMessageId,
          );
          const raw = extractRawProviderMessageId(composite);
          const numeric = raw !== null ? Number(raw) : Number.NaN;
          if (Number.isSafeInteger(numeric)) replyToMessageId = numeric;
        }
        const client = new TelegramBotApiClient({
          baseUrl: opts.telegramApiBase,
          token,
        });
        // G18: tombol aksi natif (node send_action_buttons) —
        // keyboard inline copy_text / URL tel: dari muatan pesan.
        const inlineButtons =
          delivery.interactivePayload?.kind === "telegram_inline_buttons"
            ? delivery.interactivePayload.buttons.map((b) => ({
                text: b.label,
                ...(b.copyText !== undefined ? { copyText: b.copyText } : {}),
                ...(b.url !== undefined ? { url: b.url } : {}),
              }))
            : undefined;
        return (
          await client.sendMessage({
            chatId: delivery.chatExternalId,
            text: delivery.contentText!,
            ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
            ...(inlineButtons ? { inlineButtons } : {}),
          })
        ).providerMessageId;
      },
      compositeProviderMessageId: (delivery, rawProviderId) =>
        `telegram:${delivery.botExternalId}:${rawProviderId}`,
      errorCode(err) {
        if (!(err instanceof TelegramApiError)) return "telegram_send_error";
        return err.status === 0
          ? "telegram_network_error"
          : `telegram_http_${err.status}`;
      },
    },
    {
      channelTokenSecret: opts.channelTokenSecret,
      publisher: opts.publisher,
    },
    intervalMs,
  );
}
