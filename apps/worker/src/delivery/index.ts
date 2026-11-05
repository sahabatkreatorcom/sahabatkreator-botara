/**
 * Poller pengiriman pesan outbound (Telegram + Meta) — milik proses
 * WORKER.
 *
 * Diekspor sebagai satu pintu agar `src/index.ts` tidak perlu tahu
 * pembagian internalnya, dan agar skrip verifikasi di `apps/worker/scripts`
 * mengimpor dari sini (bukan menembus berkas implementasi).
 */
export {
  startDeliveryPoller,
  type DeliveryPoller,
  type DeliveryPollerOptions,
  type DeliveryPollerSpec,
  type QueuedDeliveryBase,
} from "./runner";
export {
  startTelegramDeliveryPoller,
  type TelegramDeliveryPoller,
  type TelegramPollerOptions,
} from "./telegram";
export {
  instagramSendVariantFromTokenType,
  metaSendSpecIsAuthError,
  pickInstagramSendObjectId,
  resolveInstagramSendObjectId,
  startMetaDeliveryPoller,
  type MetaDeliveryPoller,
  type MetaPollerOptions,
} from "./meta";
