/**
 * Tipe dan konstanta bersama halaman Broadcasts.
 *
 * Semua yang dipakai lebih dari satu bagian halaman tinggal di sini:
 * nama brand provider, daftar provider yang didukung, peta label status,
 * alasan lewati, dan galat dispatch. Menaruhnya di modul sendiri membuat
 * "dipakai bersama" terbaca sebagai impor, bukan sebagai kebetulan satu
 * berkas.
 */
import type { BroadcastStatus, ChannelProvider } from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";

export type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

export interface BroadcastsPageProps {
  t: Translate;
  locale: Locale;
}

/** Nama brand provider = kata benda nama diri, sama di kedua bahasa. */
export const PROVIDER_NAMES: Record<ChannelProvider, string> = {
  telegram: "Telegram",
  messenger: "Messenger",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  webchat: "Webchat",
  // Nama tampil saja: Threads tetap tidak masuk SUPPORTED_PROVIDERS
  // karena ia bukan channel broadcast/inbox.
  threads: "Threads",
  // Nama tampil saja: Bluesky juga khusus content schedule, bukan
  // channel broadcast/inbox.
  bluesky: "Bluesky",
  // Nama tampil saja: YouTube juga khusus content schedule, bukan
  // channel broadcast/inbox.
  youtube: "YouTube",
  // Nama tampil saja: LinkedIn juga khusus content schedule, bukan
  // channel broadcast/inbox.
  linkedin: "LinkedIn",
  // Nama tampil saja: Pinterest juga khusus content schedule, bukan
  // channel broadcast/inbox.
  pinterest: "Pinterest",
};

export const SUPPORTED_PROVIDERS: ReadonlySet<ChannelProvider> = new Set([
  "telegram",
  "messenger",
  "instagram",
  // Fase 10A: WhatsApp didukung lewat template resmi (pemilih template
  // di formulir); webchat tetap satu-satunya yang tidak didukung.
  "whatsapp",
]);

export const STATUS_CHIP: Record<
  BroadcastStatus,
  { labelKey: TranslationKey; className: string }
> = {
  draft: {
    labelKey: "broadcasts.statusDraft",
    className: "bg-surface-2 text-muted",
  },
  scheduled: {
    labelKey: "broadcasts.statusScheduled",
    className: "bg-warning-soft text-warning",
  },
  sending: {
    labelKey: "broadcasts.statusSending",
    className: "bg-warning-soft text-warning",
  },
  completed: {
    labelKey: "broadcasts.statusCompleted",
    className: "bg-success-soft text-success",
  },
  partially_failed: {
    labelKey: "broadcasts.statusPartiallyFailed",
    className: "bg-warning-soft text-warning",
  },
  failed: {
    labelKey: "broadcasts.statusFailed",
    className: "bg-danger-soft text-danger",
  },
  cancelled: {
    labelKey: "broadcasts.statusCancelled",
    className: "bg-surface-2 text-muted",
  },
};

export const RECIPIENT_STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  queued: "broadcasts.recipientStatusQueued",
  sent: "broadcasts.recipientStatusSent",
  delivered: "broadcasts.recipientStatusDelivered",
  read: "broadcasts.recipientStatusRead",
  failed: "broadcasts.recipientStatusFailed",
  skipped: "broadcasts.recipientStatusSkipped",
  cancelled: "broadcasts.recipientStatusCancelled",
};

export const SKIP_REASON_LABEL_KEYS: Record<string, TranslationKey> = {
  opted_out: "broadcasts.skipReasonOptedOut",
  not_opted_in: "broadcasts.skipReasonNotOptedIn",
  outside_24h_window: "broadcasts.skipReasonOutside24h",
  message_deleted: "broadcasts.skipReasonMessageDeleted",
  template_variable_missing: "broadcasts.skipReasonTemplateVariableMissing",
  template_component_unsupported:
    "broadcasts.skipReasonTemplateComponentUnsupported",
  missing_phone_number: "broadcasts.skipReasonMissingPhone",
};

export const DISPATCH_ERROR_LABEL_KEYS: Record<string, TranslationKey> = {
  CHANNEL_DISCONNECTED: "broadcasts.dispatchErrorCHANNEL_DISCONNECTED",
  AUDIENCE_EMPTY: "broadcasts.dispatchErrorAUDIENCE_EMPTY",
  CHANNEL_UNSUPPORTED: "broadcasts.dispatchErrorCHANNEL_UNSUPPORTED",
  BROADCAST_TEMPLATE_REQUIRED: "broadcasts.dispatchErrorBROADCAST_TEMPLATE_REQUIRED",
  BROADCAST_TEMPLATE_NOT_APPROVED:
    "broadcasts.dispatchErrorBROADCAST_TEMPLATE_NOT_APPROVED",
};
