/**
 * Penerjemah kode error pesan (G13 butir 6) — katalog MURNI yang
 * dipakai web untuk mengubah `messages.error_code` (kode aman ringkas
 * yang ditulis jalur pengiriman) menjadi penjelasan bahasa awam.
 *
 * Bentuk kode yang benar-benar ditulis sistem (sumber kebenaran =
 * pemanggil `markOutboundMessageFailed` + webhook status WhatsApp):
 * - `meta_graph_<kode>`    — Graph API lewat jalur WhatsApp & webhook
 *                            status Meta (whatsapp.ts).
 * - `graph_<kode>`         — Graph API lewat jalur Messenger/Instagram
 *                            (channel-messenger `errorCode`).
 * - `threads_graph_<kode>` — Graph Threads (comments.ts memakai awalan
 *                            provider yang sama polanya).
 * - `http_<status>`        — Graph menjawab non-2xx tanpa kode Graph.
 * - `telegram_http_<status>` — Bot API Telegram menolak.
 * - `<provider>_empty_text` / `<provider>_missing_credentials` /
 *   `<provider>_token_undecryptable` — kegagalan LOKAL sebelum kirim
 *   (delivery runner).
 * - `network_error`        — jaringan/timeout (channel-core).
 *
 * Kode yang tidak dikenal TIDAK ditebak artinya: `messageErrorI18nKey`
 * mengembalikan kunci generik per keluarga agar UI tetap berkata jujur
 * ("Meta menolak pengiriman — lihat detail teknis") alih-alih
 * mengarang sebab. Kode mentah + detail teknis (deskripsi Graph,
 * fbtrace_id) selalu ditampilkan terpisah oleh UI.
 */

export type MessageErrorFamily =
  | "meta"
  | "telegram"
  | "local"
  | "network"
  | "unknown";

export interface ParsedMessageError {
  family: MessageErrorFamily;
  /** Kode numerik Graph (keluarga meta); null bila bukan kode Graph. */
  graphCode: number | null;
  /** Status HTTP (bentuk `http_<n>` / `telegram_http_<n>`); null selain itu. */
  httpStatus: number | null;
  /** Sisa kode lokal (`empty_text`, `missing_credentials`, …); null selain itu. */
  localKind: string | null;
}

const GRAPH_CODE_RE = /^(?:[a-z]+_)?graph_(\d+)$/;
const HTTP_CODE_RE = /^(?:([a-z]+)_)?http_(\d+)$/;
const LOCAL_CODE_RE = /^([a-z]+)_(empty_text|missing_credentials|token_undecryptable)$/;

/** Mengurai satu `messages.error_code` menjadi bagian-bagiannya. */
export function parseMessageErrorCode(
  code: string | null | undefined,
): ParsedMessageError | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  if (trimmed === "network_error") {
    return { family: "network", graphCode: null, httpStatus: null, localKind: null };
  }
  const graph = GRAPH_CODE_RE.exec(trimmed);
  if (graph) {
    return {
      family: "meta",
      graphCode: Number(graph[1]),
      httpStatus: null,
      localKind: null,
    };
  }
  const http = HTTP_CODE_RE.exec(trimmed);
  if (http) {
    return {
      family: http[1] === "telegram" ? "telegram" : "meta",
      graphCode: null,
      httpStatus: Number(http[2]),
      localKind: null,
    };
  }
  const local = LOCAL_CODE_RE.exec(trimmed);
  if (local) {
    return { family: "local", graphCode: null, httpStatus: null, localKind: local[2] ?? null };
  }
  return { family: "unknown", graphCode: null, httpStatus: null, localKind: null };
}

/**
 * Kode Graph Meta/WhatsApp yang DOKUMENTASINYA PUBLIK dan stabil →
 * kunci i18n penjelasannya (di bawah namespace `messageErrors.meta.*`
 * pada paket i18n). Kode di luar peta ini jatuh ke penjelasan generik
 * keluarga Meta — tidak ada tebakan.
 */
export const META_GRAPH_ERROR_KEYS: Readonly<Record<number, string>> = {
  // WhatsApp Cloud API — jendela & kelayakan penerima.
  131047: "messageErrors.meta.windowExpired",
  131026: "messageErrors.meta.undeliverable",
  131030: "messageErrors.meta.recipientNotAllowed",
  131031: "messageErrors.meta.accountLocked",
  131042: "messageErrors.meta.paymentEligibility",
  133010: "messageErrors.meta.numberNotRegistered",
  // WhatsApp — media & tipe pesan.
  131051: "messageErrors.meta.unsupportedType",
  131052: "messageErrors.meta.mediaDownload",
  131053: "messageErrors.meta.mediaUpload",
  // WhatsApp — batas laju.
  130429: "messageErrors.meta.rateLimit",
  131048: "messageErrors.meta.spamRateLimit",
  131056: "messageErrors.meta.pairRateLimit",
  80007: "messageErrors.meta.accountRateLimit",
  // WhatsApp — template.
  132000: "messageErrors.meta.templateGeneric",
  132001: "messageErrors.meta.templateNotExist",
  132005: "messageErrors.meta.templateTooLong",
  132007: "messageErrors.meta.templatePolicy",
  132012: "messageErrors.meta.templateParamFormat",
  132015: "messageErrors.meta.templatePaused",
  132016: "messageErrors.meta.templateDisabled",
  // Graph umum.
  100: "messageErrors.meta.invalidParameter",
  190: "messageErrors.meta.tokenInvalid",
  200: "messageErrors.meta.permission",
  10: "messageErrors.meta.permission",
  368: "messageErrors.meta.temporarilyBlocked",
  // Messenger Send API.
  551: "messageErrors.meta.personUnavailable",
  613: "messageErrors.meta.tooManyCalls",
  1200: "messageErrors.meta.temporaryFailure",
};

/**
 * Kunci i18n penjelasan bahasa awam untuk satu kode error pesan, atau
 * null bila tidak ada kode. Pemanggil (web) menerjemahkan kunci ini;
 * untuk keluarga tanpa penjelasan spesifik dikembalikan kunci generik
 * keluarganya — tetap jujur, tidak mengarang sebab.
 */
export function messageErrorI18nKey(
  code: string | null | undefined,
): string | null {
  const parsed = parseMessageErrorCode(code);
  if (!parsed) return null;
  switch (parsed.family) {
    case "meta": {
      if (parsed.graphCode !== null) {
        return META_GRAPH_ERROR_KEYS[parsed.graphCode] ?? "messageErrors.meta.generic";
      }
      if (parsed.httpStatus !== null) {
        return parsed.httpStatus >= 500
          ? "messageErrors.meta.serverError"
          : "messageErrors.meta.generic";
      }
      return "messageErrors.meta.generic";
    }
    case "telegram": {
      switch (parsed.httpStatus) {
        case 400:
          return "messageErrors.telegram.badRequest";
        case 401:
          return "messageErrors.telegram.tokenInvalid";
        case 403:
          return "messageErrors.telegram.blocked";
        case 429:
          return "messageErrors.telegram.rateLimit";
        default:
          return "messageErrors.telegram.generic";
      }
    }
    case "local":
      return parsed.localKind === "empty_text"
        ? "messageErrors.local.emptyText"
        : "messageErrors.local.credentials";
    case "network":
      return "messageErrors.network";
    default:
      return "messageErrors.unknown";
  }
}

/**
 * Kemampuan reaksi keluar per provider (G13 butir 11) — SUMBER
 * KEBENARAN yang dipakai API (gerbang) dan web (menawarkan pemilih
 * emoji). Hanya provider yang API resminya mendukung pengiriman
 * reaksi dari akun bisnis/bot yang bernilai true:
 * - whatsapp : Cloud API `type: "reaction"` pada endpoint pesan.
 * - telegram : Bot API `setMessageReaction`.
 * Messenger/Instagram tidak menyediakan pengiriman reaksi untuk
 * Page/akun IG bisnis; webchat adalah kanal milik sendiri tanpa
 * permukaan reaksi di widget pengunjung — ketiganya false dan API
 * menolaknya dengan REACTION_NOT_SUPPORTED.
 */
export const PROVIDER_REACTION_SUPPORTED: Readonly<Record<string, boolean>> = {
  whatsapp: true,
  telegram: true,
  messenger: false,
  instagram: false,
  webchat: false,
  threads: false,
};

/** Emoji reaksi yang ditawarkan pemilih Inbox (samakan dengan provider). */
export const MESSAGE_REACTION_EMOJIS: readonly string[] = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🙏",
];
