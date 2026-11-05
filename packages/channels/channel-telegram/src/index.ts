import type {
  ChannelAdapter,
  ReplyToSnapshot,
  SendMessageInput,
  SendMessageResult,
  StandardEvent,
  VerifyWebhookInput,
} from "@sahabat-kreator/channel-core";

/** Bentuk snapshot kutipan (kanonis di channel-core; diekspor ulang di sini untuk pemakai paket ini). */
export type { ReplyToSnapshot } from "@sahabat-kreator/channel-core";

/**
 * @sahabat-kreator/channel-telegram — adapter Telegram Bot API (Fase 6A).
 *
 * Telegram bukan Meta: tidak ada jendela pesan, tidak ada template, dan
 * autentikasi webhook BUKAN signature atas body melainkan header secret
 * token (`X-Telegram-Bot-Api-Secret-Token`) yang kita tentukan sendiri
 * saat setWebhook. Pembagian kerja (meniru pola webchat):
 *
 * - Paket ini memiliki KLIEN Bot API tipis (getMe / setWebhook /
 *   getWebhookInfo / deleteWebhook / sendMessage) + normalisasi update
 *   → StandardEvent (fungsi murni).
 * - Logika DB (kontak/percakapan/pesan/outbox) hidup di
 *   @sahabat-kreator/core (`telegram.ts`).
 * - Verifikasi secret webhook dilakukan route API terhadap hash yang
 *   tersimpan di baris akun (core `verifyChannelWebhookSecret`) — karena
 *   itu `verifyWebhookSignature` adapter SELALU false: jangan pernah ada
 *   jalur yang menganggap payload Telegram tepercaya hanya dari adapter.
 *
 * KEAMANAN: token bot adalah kredensial penuh dan tertanam di URL Bot
 * API (`/bot<token>/...`). URL itu TIDAK PERNAH masuk pesan error/log di
 * paket ini — `TelegramApiError` hanya membawa status HTTP + deskripsi
 * resmi Telegram (yang tidak memuat token).
 */

export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

// ---------------------------------------------------------------------------
// Tipe subset Bot API yang dipakai (bukan skema lengkap Telegram)
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  /** Judul grup/supergrup (chat privat tidak punya title). */
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/** Anggota chat dalam update `my_chat_member` (status bot di chat itu). */
export interface TelegramChatMember {
  user?: TelegramUser;
  status?: string;
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from?: TelegramUser;
  new_chat_member?: TelegramChatMember;
  old_chat_member?: TelegramChatMember;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  /**
   * Chat atas nama siapa pesan ini terbit (Fase 6A.2): pada `channel_post`,
   * penulisnya adalah channel itu sendiri — field ini menunjuk chat
   * channel-nya, dan `from` biasanya kosong (admin anonim) atau berisi
   * admin yang memposting atas nama pribadi.
   */
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  date?: number;
  text?: string;
  /**
   * Pesan yang dibalas pesan ini (Fase 7B.5): `message_id`-nya dipakai
   * untuk menautkan ke baris kita sendiri. Hotfix 7B.6: Telegram juga
   * mengirim ISI pesan asal di sini (`from`/`sender_chat` + `text`/
   * `caption`) — dipakai membangun snapshot kutipan cadangan untuk
   * kutipan yang targetnya tidak tertaut ke baris kita.
   */
  reply_to_message?: {
    message_id: number;
    from?: TelegramUser;
    sender_chat?: TelegramChat;
    text?: string;
    caption?: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  /** Bot dimasukkan/dikeluarkan dari grup — BUKAN pesan; ditangani route. */
  my_chat_member?: TelegramChatMemberUpdated;
  [key: string]: unknown;
}

export interface TelegramBotIdentity {
  /** Id numerik bot (menjadi external_id akun channel). */
  id: string;
  username: string | null;
  firstName: string | null;
}

/** Subset `getWebhookInfo` yang dipakai (URL webhook aktif bot ini). */
export interface TelegramWebhookInfo {
  /** URL webhook yang sedang aktif di Telegram; string kosong = tidak ada. */
  url: string;
}

/** Error Bot API yang AMAN dicatat: tanpa token, tanpa URL. */
export class TelegramApiError extends Error {
  readonly status: number;
  readonly description: string;

  constructor(status: number, description: string) {
    super(`Telegram Bot API error (HTTP ${status}): ${description}`);
    this.name = "TelegramApiError";
    this.status = status;
    this.description = description;
  }
}

type FetchLike = typeof fetch;

export interface TelegramBotApiClientOptions {
  /** Base URL Bot API — default https://api.telegram.org (override untuk mock uji). */
  baseUrl?: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Klien Bot API tipis di atas fetch. Satu instance per token bot. */
export class TelegramBotApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: TelegramBotApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_TELEGRAM_API_BASE).replace(
      /\/+$/,
      "",
    );
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      // Error jaringan/timeout: JANGAN teruskan error asli — pesan fetch
      // bisa memuat URL bertoken. Lempar error aman generik.
      throw new TelegramApiError(0, "network_error");
    }
    let body: { ok?: boolean; result?: T; description?: string } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new TelegramApiError(response.status, "invalid_response");
    }
    if (!response.ok || body.ok !== true) {
      throw new TelegramApiError(
        response.status,
        typeof body.description === "string"
          ? body.description.slice(0, 200)
          : "telegram_error",
      );
    }
    return body.result as T;
  }

  /** Identitas bot pemilik token — dipakai memvalidasi token saat connect. */
  async getMe(): Promise<TelegramBotIdentity> {
    const me = await this.call<TelegramUser>("getMe", {});
    return {
      id: String(me.id),
      username: me.username ?? null,
      firstName: me.first_name ?? null,
    };
  }

  /** Daftarkan URL webhook + secret token untuk akun bot ini. */
  async setWebhook(input: {
    url: string;
    secretToken: string;
  }): Promise<void> {
    await this.call<boolean>("setWebhook", {
      url: input.url,
      secret_token: input.secretToken,
      // `my_chat_member` agar bot tahu saat dimasukkan/dikeluarkan grup
      // (Fase 6A.1) — update itu bukan pesan dan hanya dicatat audit.
      // `channel_post` (Fase 6A.2): postingan channel tempat bot menjadi
      // ADMIN — termasuk pantulan postingan yang bot kirim sendiri.
      allowed_updates: ["message", "my_chat_member", "channel_post"],
    });
  }

  /**
   * Webhook yang SEDANG aktif untuk bot ini menurut Telegram. Dipakai
   * saat disconnect: webhook hanya boleh dicabut bila URL-nya menunjuk
   * ke akun channel yang sedang diputuskan (satu bot = satu webhook;
   * akun duplikat yang bukan pemilik tidak boleh mencabut webhook
   * pemilik sah).
   */
  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    const info = await this.call<{ url?: string }>("getWebhookInfo", {});
    return { url: typeof info.url === "string" ? info.url : "" };
  }

  /** Cabut webhook bot ini di Telegram (pesan berhenti masuk). */
  async deleteWebhook(): Promise<void> {
    await this.call<boolean>("deleteWebhook", {});
  }

  /**
   * Kirim pesan teks ke chat. `chat_id` adalah alamat chat tujuan:
   * id user pada chat privat, id grup (negatif) pada grup — pemanggil
   * mengambilnya dari `conversations.provider_chat_id`, BUKAN dari
   * identitas pengirim pesan terakhir (Fase 6A.1).
   *
   * `replyToMessageId` (Fase 7B.5): message_id NUMERIK pesan yang
   * dikutip dalam chat yang sama → dikirim sebagai
   * `reply_parameters: { message_id }` (parameter Bot API saat ini;
   * menggantikan `reply_to_message_id` lama). Tanpa nilai ini body
   * tidak berubah sama sekali dari perilaku sebelumnya.
   */
  async sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: number;
  }): Promise<{ providerMessageId: string }> {
    const result = await this.call<TelegramMessage>("sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      ...(input.replyToMessageId !== undefined
        ? { reply_parameters: { message_id: input.replyToMessageId } }
        : {}),
    });
    return { providerMessageId: String(result.message_id) };
  }
}

// ---------------------------------------------------------------------------
// Snapshot kutipan cadangan (Hotfix 7B.6)
// ---------------------------------------------------------------------------

/** Batas cuplikan teks pesan asal pada snapshot kutipan. */
export const TELEGRAM_REPLY_SNAPSHOT_PREVIEW_CHARS = 200;

/** Nama tampil user Telegram: nama lengkap, jatuh ke @username, lalu null. */
function telegramUserDisplayName(user: TelegramUser): string | null {
  const name = [user.first_name, user.last_name]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ")
    .trim();
  if (name) return name;
  return user.username ? `@${user.username}` : null;
}

/**
 * Membangun snapshot kutipan dari `reply_to_message` mentah Telegram.
 * Dipakai parser pesan & channel_post saat ingest, dan script backfill
 * 7B.6 atas payload lama di log integrasi — SATU sumber semantik label
 * penulis & cuplikan. Aturan label: pengirim bot → `@username` bila ada
 * (identitas publik bot), selain itu nama tampilnya; pengirim manusia →
 * nama tampil (nama lengkap, jatuh ke @username); tanpa `from` →
 * `sender_chat` (postingan channel/admin anonim): judul chat, jatuh ke
 * @username. Cuplikan: `text`, jatuh ke `caption` (media berketerangan),
 * terpotong 200 karakter; media tanpa caption → null.
 */
export function buildTelegramReplyToSnapshot(
  replyTo: NonNullable<TelegramMessage["reply_to_message"]>,
): ReplyToSnapshot {
  let authorLabel: string | null = null;
  if (replyTo.from) {
    authorLabel =
      replyTo.from.is_bot && replyTo.from.username
        ? `@${replyTo.from.username}`
        : telegramUserDisplayName(replyTo.from);
  }
  if (!authorLabel && replyTo.sender_chat) {
    authorLabel =
      replyTo.sender_chat.title ??
      (replyTo.sender_chat.username
        ? `@${replyTo.sender_chat.username}`
        : null);
  }
  const rawText = replyTo.text ?? replyTo.caption;
  return {
    authorLabel,
    contentPreview:
      rawText && rawText.trim()
        ? rawText.slice(0, TELEGRAM_REPLY_SNAPSHOT_PREVIEW_CHARS)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Normalisasi update → StandardEvent (fungsi murni, bisa dites)
// ---------------------------------------------------------------------------

/**
 * Postingan channel yang dinormalisasi (Fase 6A.2). Channel adalah siaran
 * satu arah: tidak ada pengirim perorangan — penulisnya adalah channel
 * itu sendiri (`sender_chat`), jadi `chatExternalId` sekaligus identitas
 * penulisnya. Diproses route webhook lewat fungsi core khusus channel,
 * BUKAN jalur pesan masuk biasa (tanpa unread, tanpa automation/agent).
 */
export interface TelegramChannelPost {
  /** Id pesan di channel (message_id Telegram, belum disematkan id bot). */
  providerMessageId: string;
  /** Id chat channel (negatif) — alamat siaran & alamat balasan posting. */
  chatExternalId: string;
  /** Judul channel saat postingan terbit. */
  chatTitle: string | null;
  /** message_id postingan yang dikutip postingan ini (Fase 7B.5); null bila tidak mengutip. */
  replyToProviderMessageId: string | null;
  /** Snapshot isi postingan yang dikutip (Hotfix 7B.6); null bila tidak mengutip. */
  replyToSnapshot: ReplyToSnapshot | null;
  text: string;
  sentAt: string;
}

/**
 * Menormalkan update `channel_post` TEKS menjadi TelegramChannelPost.
 * Null untuk update lain / postingan non-teks / bentuk tak dikenal —
 * pemanggil menjawab 200 dan mengabaikannya seperti pola update lain.
 * Sengaja TIDAK lewat parseTelegramUpdate: channel_post tidak punya
 * `from` pengguna dan semantiknya berbeda total dari pesan percakapan.
 */
export function parseTelegramChannelPost(
  payload: unknown,
): TelegramChannelPost | null {
  if (typeof payload !== "object" || payload === null) return null;
  const post = (payload as TelegramUpdate).channel_post;
  if (!post || typeof post.text !== "string" || !post.text.trim()) {
    return null;
  }
  if (!post.chat || typeof post.chat.id !== "number") return null;
  if (post.chat.type !== "channel") return null;
  if (typeof post.message_id !== "number") return null;
  // Hotfix 7B.6: snapshot kutipan antar-postingan. Penulis postingan
  // yang dikutip adalah channel itu sendiri — bila payload tidak
  // membawa label penulis (from/sender_chat kosong), jatuh ke judul
  // channel dari chat postingan ini.
  let replyToSnapshot: ReplyToSnapshot | null = null;
  if (typeof post.reply_to_message?.message_id === "number") {
    replyToSnapshot = buildTelegramReplyToSnapshot(post.reply_to_message);
    if (!replyToSnapshot.authorLabel) {
      replyToSnapshot = {
        ...replyToSnapshot,
        authorLabel: post.chat.title ?? null,
      };
    }
  }
  return {
    providerMessageId: String(post.message_id),
    chatExternalId: String(post.chat.id),
    chatTitle: post.chat.title ?? null,
    replyToProviderMessageId:
      typeof post.reply_to_message?.message_id === "number"
        ? String(post.reply_to_message.message_id)
        : null,
    replyToSnapshot,
    text: post.text,
    sentAt:
      typeof post.date === "number"
        ? new Date(post.date * 1000).toISOString()
        : new Date().toISOString(),
  };
}

/**
 * Menormalkan satu update Telegram menjadi StandardEvent. Hanya pesan
 * teks (`message.text`) yang menjadi `message.received`; update lain
 * (edited, channel post — jalur khusus parseTelegramChannelPost,
 * my_chat_member, callback, non-teks) menghasilkan array kosong agar
 * pemanggil menjawab 200 dan mengabaikannya dengan aman.
 *
 * Grup (Fase 6A.1): `chat.type` group/supergroup → conversationKind
 * "group" + conversationTitle dari `chat.title`. Perhatikan pemisahan
 * yang menjadi inti dukungan grup: `conversationExternalId` = id CHAT
 * (grup: negatif, alamat balasan), `senderExternalId` = id ANGGOTA yang
 * menulis — keduanya hanya sama pada chat privat.
 */
export function parseTelegramUpdate(payload: unknown): StandardEvent[] {
  if (typeof payload !== "object" || payload === null) return [];
  const update = payload as TelegramUpdate;
  const message = update.message;
  if (!message || typeof message.text !== "string" || !message.text.trim()) {
    return [];
  }
  if (!message.from || typeof message.from.id !== "number") return [];
  if (!message.chat || typeof message.chat.id !== "number") return [];
  const sentAt =
    typeof message.date === "number"
      ? new Date(message.date * 1000).toISOString()
      : new Date().toISOString();
  const isGroup =
    message.chat.type === "group" || message.chat.type === "supergroup";
  return [
    {
      type: "message.received",
      provider: "telegram",
      providerEventId: String(update.update_id),
      message: {
        providerMessageId: String(message.message_id),
        conversationExternalId: String(message.chat.id),
        conversationKind: isGroup ? "group" : "private",
        conversationTitle: isGroup
          ? (message.chat.title ?? undefined)
          : undefined,
        senderExternalId: String(message.from.id),
        direction: "inbound",
        type: "text",
        text: message.text,
        replyToProviderMessageId:
          typeof message.reply_to_message?.message_id === "number"
            ? String(message.reply_to_message.message_id)
            : undefined,
        // Hotfix 7B.6: snapshot isi pesan yang dikutip (cadangan bila
        // targetnya tidak tertaut ke baris kita di core).
        replyToSnapshot:
          typeof message.reply_to_message?.message_id === "number"
            ? buildTelegramReplyToSnapshot(message.reply_to_message)
            : undefined,
        sentAt,
      },
      raw: payload,
      receivedAt: new Date().toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Adapter channel-core
// ---------------------------------------------------------------------------

/**
 * Adapter Telegram untuk satu akun bot (satu klien = satu token).
 * `sendMessage` meneruskan ke Bot API; pengiriman produksi kita tetap
 * lewat antrean pesan `queued` + poller API (yang memakai klien yang
 * sama), adapter ini adalah pintu standar bagi pemanggil berbasis
 * channel-core.
 */
export class TelegramChannelAdapter implements ChannelAdapter {
  readonly provider = "telegram" as const;
  private readonly client: TelegramBotApiClient;

  constructor(client: TelegramBotApiClient) {
    this.client = client;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const result = await this.client.sendMessage({
      chatId: input.toExternalId,
      text: input.text,
    });
    return { providerMessageId: result.providerMessageId };
  }

  /**
   * Telegram tidak menandatangani body webhook; keaslian dibuktikan
   * header secret token terhadap hash tersimpan (route + core). Selalu
   * false agar tidak ada jalur yang melewatkan verifikasi itu.
   */
  verifyWebhookSignature(_input: VerifyWebhookInput): boolean {
    return false;
  }

  parseWebhookEvents(payload: unknown): StandardEvent[] {
    return parseTelegramUpdate(payload);
  }
}
