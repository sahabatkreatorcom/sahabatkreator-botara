/**
 * channel-core — antarmuka standar semua channel (RANCANGAN §4).
 * Core & worker hanya bicara dengan tipe di file ini; kekhususan tiap
 * provider (format webhook, token, error code) hidup di adapter masing-masing.
 */

// Kerangka klien Meta Graph bersama (Fase 13D) — dipakai channel-messenger
// (Messenger + Instagram) dan channel-whatsapp supaya plumbing HTTP tidak
// disalin dua kali.
export {
  DEFAULT_META_API_BASE,
  DEFAULT_META_GRAPH_API_VERSION,
  GraphApiError,
  GraphHttpClient,
  type GraphClientOptions,
} from "./graph";

export type ChannelProvider =
  | "whatsapp"
  | "instagram"
  | "messenger"
  | "telegram"
  | "webchat"
  /**
   * Khusus content schedule (Gelombang 1): Threads tidak
   * mengimplementasikan ChannelAdapter inbox dan tidak boleh dipilih
   * jalur pengiriman pesan mana pun. Nilai ini ada agar akun/sasaran
   * linimasanya memakai identitas provider yang sama dengan kontrak.
   */
  | "threads"
  /**
   * Khusus content schedule (Gelombang 1.5): Bluesky (AT Protocol)
   * sama seperti Threads — tidak mengimplementasikan ChannelAdapter
   * inbox dan tidak boleh dipilih jalur pengiriman pesan mana pun.
   */
  | "bluesky"
  /**
   * Khusus content schedule (Gelombang 2): YouTube (Data API v3)
   * sama seperti Threads/Bluesky — tidak mengimplementasikan
   * ChannelAdapter inbox; kredensialnya hidup di koneksi Google
   * tenant, bukan di baris akun channel ini.
   */
  | "youtube";

export interface ChannelAccountRef {
  id: string;
  tenantId: string;
  provider: ChannelProvider;
  /** ID akun di sisi provider (nomor WABA, IG user id, Page id, bot id, site id). */
  externalId: string;
}

export type MessageDirection = "inbound" | "outbound";
export type StandardMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "reaction"
  | "unknown";

/**
 * Jenis percakapan di provider: privat 1:1, grup (banyak anggota, dua
 * arah), atau channel (siaran satu arah, Fase 6A.2).
 */
export type StandardConversationKind = "private" | "group" | "channel";

/**
 * Snapshot kutipan cadangan (Hotfix 7B.6): isi pesan yang dikutip
 * sebagaimana dikirim provider di payload webhook-nya. Hanya provider
 * yang payload kutipannya memuat isi pesan asal yang bisa mengisinya
 * (Telegram lewat `reply_to_message`); WhatsApp & Meta hanya membawa id
 * kutipan, jadi bidang ini tidak pernah terisi dari mereka. Bentuknya
 * sama persis dengan kontrak API `MessageReplyToSnapshot`.
 */
export interface ReplyToSnapshot {
  /** Nama penulis pesan asal bila provider mengirimnya; null bila tidak ada. */
  authorLabel: string | null;
  /** Cuplikan teks/caption pesan asal (terpotong wajar); null untuk media tanpa caption. */
  contentPreview: string | null;
}

/** Pesan yang sudah dinormalisasi dari format provider apa pun. */
export interface StandardMessage {
  providerMessageId?: string;
  conversationExternalId: string;
  /**
   * Jenis percakapan sumber pesan (Fase 6A.1). Opsional: adapter yang
   * belum membedakan mengosongkannya dan pemanggil menganggap privat.
   * Untuk grup, `conversationExternalId` adalah id GRUP (alamat balasan),
   * yang berbeda dari `senderExternalId` anggota yang menulis.
   */
  conversationKind?: StandardConversationKind;
  /** Judul percakapan di provider (judul grup/channel); privat tidak punya. */
  conversationTitle?: string;
  senderExternalId: string;
  direction: MessageDirection;
  type: StandardMessageType;
  text?: string;
  /**
   * Id provider pesan yang dikutip pesan ini (Fase 7B.5), dalam satuan
   * mentah yang sama seperti `providerMessageId` (Telegram: message_id;
   * Meta: mid; WhatsApp: wamid dari context.id). Lapisan core menyusun
   * bentuk majemuknya dan menautkan ke baris target bila ditemukan.
   */
  replyToProviderMessageId?: string;
  /**
   * Snapshot isi pesan yang dikutip (Hotfix 7B.6), bila provider
   * mengirim isinya di payload (Telegram). Cadangan tampil untuk
   * kutipan yang targetnya tidak tertaut ke baris kita; tautan tetap
   * prioritas di lapisan core/serializer.
   */
  replyToSnapshot?: ReplyToSnapshot | null;
  /** Kunci objek media di R2 setelah diunduh (URL media provider kedaluwarsa). */
  mediaObjectKey?: string;
  sentAt: string;
}

export type StandardEventType =
  | "message.received"
  | "message.status"
  | "comment.created"
  | "unknown";

/** Event webhook yang sudah dinormalisasi; `raw` disimpan untuk dedup & audit. */
export interface StandardEvent {
  type: StandardEventType;
  provider: ChannelProvider;
  providerEventId?: string;
  message?: StandardMessage;
  raw: unknown;
  receivedAt: string;
}

export interface SendMessageInput {
  account: ChannelAccountRef;
  toExternalId: string;
  text: string;
  /** Mencegah kirim ganda pada retry (idempotency, RANCANGAN §2). */
  idempotencyKey: string;
}

export interface SendMessageResult {
  providerMessageId: string;
}

export interface VerifyWebhookInput {
  rawBody: string;
  signatureHeader: string | undefined;
}

/** Kontrak yang wajib diimplementasikan setiap adapter channel. */
export interface ChannelAdapter {
  readonly provider: ChannelProvider;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  verifyWebhookSignature(input: VerifyWebhookInput): boolean | Promise<boolean>;
  parseWebhookEvents(payload: unknown): StandardEvent[];
}

/** Kebijakan jendela pesan per channel untuk policy engine (RANCANGAN §12.7). */
export interface MessagingWindowPolicy {
  provider: ChannelProvider;
  /** null = tidak ada jendela free-form. */
  freeFormWindowHours: number | null;
  humanAgentWindowHours?: number | null;
  notes: string;
}

export const MESSAGING_WINDOW_POLICIES: Record<ChannelProvider, MessagingWindowPolicy> = {
  whatsapp: {
    provider: "whatsapp",
    freeFormWindowHours: 24,
    notes: "Di luar 24 jam wajib template message. Jendela free-entry iklan: 72 jam.",
  },
  instagram: {
    provider: "instagram",
    freeFormWindowHours: 24,
    humanAgentWindowHours: 24 * 7,
    notes: "Tag HUMAN_AGENT s/d 7 hari hanya untuk support, bukan promosi.",
  },
  messenger: {
    provider: "messenger",
    freeFormWindowHours: 24,
    humanAgentWindowHours: 24 * 7,
    notes: "Tag HUMAN_AGENT s/d 7 hari hanya untuk support, bukan promosi.",
  },
  telegram: { provider: "telegram", freeFormWindowHours: null, notes: "Bot API: tidak ada jendela pesan." },
  webchat: { provider: "webchat", freeFormWindowHours: null, notes: "Channel milik sendiri: sesi & consent diatur sendiri." },
  threads: {
    provider: "threads",
    freeFormWindowHours: null,
    notes: "Bukan channel inbox: khusus publikasi content schedule; tidak ada jendela pesan atau pengiriman DM.",
  },
  bluesky: {
    provider: "bluesky",
    freeFormWindowHours: null,
    notes: "Bukan channel inbox: khusus publikasi content schedule (AT Protocol); tidak ada jendela pesan atau pengiriman DM.",
  },
  youtube: {
    provider: "youtube",
    freeFormWindowHours: null,
    notes: "Bukan channel inbox: khusus publikasi content schedule (unggah video YouTube Data API v3); tidak ada jendela pesan atau pengiriman DM.",
  },
};
