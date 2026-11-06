import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  channelIdentities,
  contacts,
  conversations,
  messages,
  outboxEvents,
  type ChannelAccount,
  type Database,
  type Message,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";
import { resolveInboundReplyTargetId } from "./conversations";
import { outboundClaimStale } from "./outbound-claim";

/**
 * Service domain Telegram (Fase 6A, RANCANGAN §4) — channel Bot API.
 *
 * Pola mengikuti webchat (Fase 1F) dengan perbedaan sumber kepercayaan:
 * - Webchat: siteKey publik mengidentifikasi channel.
 * - Telegram: URL webhook memuat id akun channel (UUID); autentikasi
 *   sesungguhnya adalah header secret token Telegram yang hash-nya
 *   tersimpan di baris akun. Resolusi akun memakai lengan RLS
 *   `telegram_webhook_lookup` (migrasi 0018).
 *
 * Pesan masuk ditulis PERSIS seperti webchat: baris pesan inbound +
 * unread + event outbox `message.received` dalam satu transaksi tenant —
 * jadi relay worker, automation, sequence, dan agent AI bekerja tanpa
 * tahu-menahu soal Telegram.
 *
 * Chat privat & grup (Fase 6A.1): identitas kontak selalu per PENGIRIM
 * (`from.id`), tetapi alamat balasan adalah id CHAT
 * (`conversations.provider_chat_id` = `chat.id`; negatif untuk grup).
 * Percakapan grup: SATU per (akun, chat grup), berlabel judul grup
 * (`conversations.title`), menampung pesan banyak anggota — atribusi
 * penulis per pesan disimpan di `messages.sender_name`. Kontak jangkar
 * percakapan grup = pengirim pertama (semantik sequence per-kontak tetap
 * menunjuk kontak percakapan, sama seperti privat).
 *
 * Channel siaran (Fase 6A.2): channel adalah chat bertipe "channel" —
 * satu arah, penulisnya channel itu sendiri. Ia diwakili SATU percakapan
 * `kind='channel'` per (akun, channel): linimasa postingan, BUKAN antrean
 * kerja. Karena itu postingan channel (a) TIDAK menaikkan unread,
 * (b) TIDAK menulis event outbox `message.received`, dan (c) tetap
 * ditolak jalur evaluasi automation/agent lewat penjaga `kind` di core
 * (automations.ts & agent-runtime.ts) bila ada event liar yang mengarah
 * ke sana. Kontak jangkar percakapan channel = CHANNEL ITU SENDIRI
 * (keputusan yang disengaja, meniru semantik Telegram `sender_chat`):
 * satu kontak per channel, bernama judul channel, dengan identitas
 * `external_user_id` = id chat channel — bukan orang, melainkan entitas
 * siaran; pola ini membuat resolusi alamat poller (coalesce
 * provider_chat_id → identitas) bekerja tanpa jalur khusus.
 * Postingan kita sendiri yang terkirim via sendMessage memantul kembali
 * sebagai `channel_post` dengan message_id yang sama; poller menyimpan
 * id itu di pesan outbound (`telegram:<botId>:<message_id>`), sehingga
 * pantulannya ter-dedup dan linimasa menampilkan postingan itu SATU kali
 * sebagai kiriman kita.
 */

export interface CreateTelegramChannelInput {
  displayName?: string;
  /** Id numerik bot dari getMe — menjadi external_id akun. */
  botId: string;
  /** Username bot dari getMe (tanpa '@'); null bila bot tak ber-username. */
  botUsername: string | null;
  /** Envelope enkripsi token bot (lihat channel-secrets.ts) — BUKAN token mentah. */
  encryptedBotToken: string;
  /** Hash SHA-256 hex secret webhook akun ini. */
  webhookSecretHash: string;
}

export async function createTelegramChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreateTelegramChannelInput,
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: "telegram",
        externalId: input.botId,
        displayName: input.displayName ?? null,
        status: "connected",
        accessTokenEncrypted: input.encryptedBotToken,
        webhookSecret: input.webhookSecretHash,
        botUsername: input.botUsername,
      })
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "channel.created",
      // Metadata aman: username bot memang publik; token/secret tidak dicatat.
      meta: {
        channelAccountId: row.id,
        provider: "telegram",
        botUsername: input.botUsername,
      },
    });

    return row;
  });
}

export type TelegramAccountRef = Pick<
  ChannelAccount,
  | "id"
  | "tenantId"
  | "provider"
  | "externalId"
  | "displayName"
  | "status"
  | "webhookSecret"
  | "botUsername"
  | "accessTokenEncrypted"
>;

/**
 * Resolusi akun channel dari id di URL webhook TANPA konteks tenant:
 * transaksi men-set `app.telegram_channel_account_id` dan policy
 * `telegram_webhook_lookup` (0018) hanya membuka baris telegram ber-id itu.
 * Null bila id tidak dikenal / bukan akun telegram.
 */
export async function resolveTelegramAccountById(
  db: Database,
  channelAccountId: string,
): Promise<TelegramAccountRef | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.telegram_channel_account_id', ${channelAccountId}, true)`,
    );
    const [row] = await tx
      .select({
        id: channelAccounts.id,
        tenantId: channelAccounts.tenantId,
        provider: channelAccounts.provider,
        externalId: channelAccounts.externalId,
        displayName: channelAccounts.displayName,
        status: channelAccounts.status,
        webhookSecret: channelAccounts.webhookSecret,
        botUsername: channelAccounts.botUsername,
        accessTokenEncrypted: channelAccounts.accessTokenEncrypted,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, "telegram"),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Hasil pencatatan pesan masuk (Fase 6D memperluas kembalian Fase 6A):
 * selain pesan, pemanggil menerima kontak pengirim dan apakah identitas
 * Telegram-nya BARU saja dibuat oleh panggilan ini — pemicu satu-satunya
 * pengambilan foto profil kontak (best-effort, tidak diulang per pesan).
 */
export interface RecordTelegramInboundResult {
  message: Message;
  contactId: string;
  identityCreated: boolean;
  /**
   * Fase 7B.1: true bila pesan ini KEMBARAN yang sudah tercatat
   * (retry webhook) — route webhook mencatatnya ke log integrasi
   * sebagai outcome `duplicate`, bukan `recorded`.
   */
  duplicate: boolean;
}

/**
 * Normalisasi snapshot kutipan sebelum disimpan (Hotfix 7B.6):
 * snapshot yang KEDUA bidangnya kosong (payload provider hanya
 * membawa id kutipan tanpa penulis/teks — hanya terjadi pada payload
 * minimal) disetara dengan tidak ada snapshot: blok kutipan berisi
 * label cadangan umum akan menyesatkan untuk kutipan yang isinya
 * memang tidak kita ketahui sama sekali.
 */
function normalizeReplyToSnapshot(
  snapshot:
    | { authorLabel: string | null; contentPreview: string | null }
    | null
    | undefined,
): { authorLabel: string | null; contentPreview: string | null } | null {
  if (!snapshot) return null;
  if (snapshot.authorLabel === null && snapshot.contentPreview === null) {
    return null;
  }
  return snapshot;
}

export interface RecordTelegramInboundInput {
  /** Id user Telegram pengirim (`from.id`) — identitas kontak (atribusi). */
  senderExternalId: string;
  senderName: string;
  senderUsername?: string;
  /** Id chat Telegram (`chat.id`) — ALAMAT BALASAN; negatif untuk grup. */
  chatExternalId: string;
  /** Grup/supergrup → satu percakapan per grup; privat → per kontak. */
  isGroup: boolean;
  /** Judul grup (`chat.title`); hanya untuk grup. */
  chatTitle?: string | null;
  /** Id pesan unik global untuk dedup webhook: `telegram:<botId>:<message_id>`. */
  providerMessageId: string;
  /**
   * Id majemuk pesan yang dikutip pesan ini (Fase 7B.5):
   * `telegram:<botId>:<reply_to_message.message_id>` — ditautkan ke
   * baris target bila ditemukan di percakapan yang sama; selain itu
   * pesan tetap tercatat tanpa tautan.
   */
  replyToProviderMessageId?: string | null;
  /**
   * Snapshot isi pesan yang dikutip (Hotfix 7B.6) sebagaimana dikirim
   * Telegram di `reply_to_message` — disimpan SELALU saat ada (bukan
   * hanya saat tautan gagal) agar kutipan tetap terlihat bila baris
   * target kelak terhapus; serializer/UI tetap mendahulukan tautan.
   */
  replyToSnapshot?: {
    authorLabel: string | null;
    contentPreview: string | null;
  } | null;
  text: string;
}

/**
 * Menyimpan pesan inbound Telegram: temukan/buat kontak pengirim
 * (identitas = user id pengirim pada akun bot ini) + percakapan terbuka,
 * lalu baris pesan + unread + event outbox `message.received` dalam SATU
 * transaksi tenant (pola webchat persis). Idempoten terhadap retry
 * webhook Telegram: provider_message_id yang sama mengembalikan pesan
 * yang sudah ada. Mengembalikan NULL hanya bila kembaran pesan itu
 * dimiliki tenant/akun lain (bot sama terhubung ganda) — pesan sudah
 * tercatat di sana, pemanggil cukup mengakui webhook (200) tanpa
 * memproses ulang.
 *
 * Resolusi percakapan (Fase 6A.1):
 * - Grup: berdasarkan `provider_chat_id` (= id grup) pada akun ini —
 *   SATU percakapan per grup, siapa pun anggotanya yang menulis. Kontak
 *   baris percakapan = pengirim PERTAMA (jangkar); pesan berikutnya dari
 *   anggota lain TIDAK memindahkan jangkar itu.
 * - Privat: berdasarkan kontak pengirim (perilaku 6A), dan
 *   `provider_chat_id` diisi/dirapikan ke id chat (= id pengirim).
 */
export async function recordTelegramInboundMessage(
  db: Database,
  account: Pick<TelegramAccountRef, "id" | "tenantId">,
  input: RecordTelegramInboundInput,
): Promise<RecordTelegramInboundResult | null> {
  return withTenantDb(db, account.tenantId, async (tx) => {
    const [identity] = await tx
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channelAccountId, account.id),
          eq(channelIdentities.externalUserId, input.senderExternalId),
        ),
      )
      .limit(1);

    let contactId: string;
    let identityCreated = false;
    if (identity) {
      contactId = identity.contactId;
    } else {
      const [contact] = await tx
        .insert(contacts)
        .values({
          tenantId: account.tenantId,
          name: input.senderName,
        })
        .returning();
      contactId = contact.id;
      identityCreated = true;
      await tx.insert(channelIdentities).values({
        tenantId: account.tenantId,
        contactId,
        channelAccountId: account.id,
        provider: "telegram",
        externalUserId: input.senderExternalId,
        username: input.senderUsername ?? null,
      });
    }

    const [existingConv] = input.isGroup
      ? await tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, account.tenantId),
              eq(conversations.channelAccountId, account.id),
              eq(conversations.providerChatId, input.chatExternalId),
            ),
          )
          .orderBy(desc(conversations.createdAt))
          .limit(1)
      : await tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, account.tenantId),
              eq(conversations.channelAccountId, account.id),
              eq(conversations.contactId, contactId),
              // WAJIB (6A.1): batasi ke percakapan PRIVAT kontak ini.
              // Kontak yang sama bisa menjadi jangkar percakapan GRUP
              // (pengirim pertama) — tanpa syarat alamat chat ini, pesan
              // privat anggota akan nyasar masuk utas grup. Baris lama
              // pra-0019 bisa masih NULL provider_chat_id-nya dan pasti
              // privat (grup belum ada di era 6A), jadi NULL diterima.
              or(
                eq(conversations.providerChatId, input.chatExternalId),
                isNull(conversations.providerChatId),
              ),
            ),
          )
          .orderBy(desc(conversations.createdAt))
          .limit(1);

    // Fase 6A.2: `kind` adalah sumber kebenaran jenis percakapan kini
    // (bukan lagi kehadiran judul) — diselaraskan juga pada baris lama.
    const wantKind = input.isGroup ? "group" : "private";
    let conversationId: string;
    if (existingConv && existingConv.status !== "closed") {
      conversationId = existingConv.id;
      // Rapikan kolom 6A.1 pada percakapan lama: judul grup bisa berubah
      // di Telegram; provider_chat_id privat lama bisa masih NULL.
      const patch: { title?: string; providerChatId?: string; kind?: string } = {};
      if (input.isGroup && input.chatTitle && existingConv.title !== input.chatTitle) {
        patch.title = input.chatTitle;
      }
      if (existingConv.providerChatId !== input.chatExternalId) {
        patch.providerChatId = input.chatExternalId;
      }
      if (existingConv.kind !== wantKind) {
        patch.kind = wantKind;
      }
      if (Object.keys(patch).length > 0) {
        await tx
          .update(conversations)
          .set(patch)
          .where(eq(conversations.id, existingConv.id));
      }
    } else {
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId: account.tenantId,
          channelAccountId: account.id,
          contactId,
          provider: "telegram",
          providerChatId: input.chatExternalId,
          title: input.isGroup ? (input.chatTitle ?? null) : null,
          kind: wantKind,
          status: "open",
        })
        .returning();
      conversationId = conv.id;
    }

    // Dedup retry webhook: pesan yang sama tidak boleh ganda (index unik
    // global provider_message_id adalah penjaga terakhir). Identitas
    // untuk pesan kembaran ini PASTI sudah ada dari upaya pertama, jadi
    // identityCreated dilaporkan false — foto kontak tidak diambil ulang.
    const [dupe] = await tx
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, input.providerMessageId))
      .limit(1);
    if (dupe)
      return { message: dupe, contactId, identityCreated: false, duplicate: true };

    // Fase 7B.5: tautkan kutipan bila targetnya ada di percakapan ini.
    const replyToMessageId = input.replyToProviderMessageId
      ? await resolveInboundReplyTargetId(
          tx,
          conversationId,
          input.replyToProviderMessageId,
        )
      : null;

    // ON CONFLICT DO NOTHING (tanpa target = semua index unik; satu-
    // satunya index unik di messages adalah provider_message_id):
    // SELECT dedup di atas berjalan dalam konteks RLS tenant ini,
    // sedangkan index-nya GLOBAL — bila bot yang sama pernah terhubung
    // di tenant/akun lain, baris kembarannya tak terlihat oleh SELECT
    // tetapi tetap ditolak index. Tanpa penjaga ini insert melempar
    // 23505 → webhook 500 → Telegram me-retry update yang sama selamanya
    // (poison pill). Semantik dedup tidak berubah: tepat satu baris
    // tersimpan per provider_message_id.
    const [message] = await tx
      .insert(messages)
      .values({
        tenantId: account.tenantId,
        conversationId,
        direction: "inbound",
        senderType: "contact",
        // Atribusi penulis per pesan HANYA untuk grup (banyak penulis);
        // privat NULL karena penulisnya ya kontak percakapan itu.
        senderName: input.isGroup ? input.senderName : null,
        type: "text",
        contentText: input.text,
        providerMessageId: input.providerMessageId,
        replyToMessageId,
        replyToSnapshot: normalizeReplyToSnapshot(input.replyToSnapshot),
        status: "received",
      })
      .onConflictDoNothing()
      .returning();
    if (!message) {
      // Kembaran dimiliki tenant/akun lain (tak terlihat RLS di sini):
      // pesan sudah tercatat di tempat yang benar — akui & lewati tanpa
      // unread/outbox ganda. Route tetap menjawab 200.
      return null;
    }

    const now = new Date();
    await tx
      .update(conversations)
      .set({
        unreadCount: sql`${conversations.unreadCount} + 1`,
        lastMessageAt: now,
        updatedAt: now,
      })
      .where(eq(conversations.id, conversationId));

    await tx.insert(outboxEvents).values({
      tenantId: account.tenantId,
      type: "message.received",
      payload: {
        provider: "telegram",
        channelAccountId: account.id,
        conversationId,
        messageId: message.id,
      },
    });

    return { message, contactId, identityCreated, duplicate: false };
  });
}

/**
 * Temukan/buat pasangan kontak + percakapan untuk SATU channel Telegram
 * (Fase 6A.2). Kontak jangkar = channel itu sendiri: identitas
 * (akun, external_user_id = id chat channel) menunjuk kontak bernama
 * judul channel — meniru semantik `sender_chat` Telegram (penulis
 * postingan adalah channel-nya, bukan admin perorangan). Nama kontak &
 * judul percakapan mengikuti judul channel terbaru. Percakapan yang
 * 'closed' tidak dihidupkan lagi di sini (sama seperti resolusi lain:
 * baris tertutup berarti pemilik menutupnya dengan sengaja) — fungsi ini
 * mengembalikan percakapan terbuka yang ada atau membuat yang baru.
 */
async function ensureTelegramChannelConversation(
  tx: DbTx,
  account: Pick<TelegramAccountRef, "id" | "tenantId">,
  input: { chatExternalId: string; chatTitle?: string | null },
): Promise<{ conversationId: string; contactId: string; created: boolean }> {
  const fallbackName = "Telegram Channel";
  const [identity] = await tx
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channelAccountId, account.id),
        eq(channelIdentities.externalUserId, input.chatExternalId),
      ),
    )
    .limit(1);

  let contactId: string;
  if (identity) {
    contactId = identity.contactId;
    // Channel berganti judul → nama kontak (label siaran) ikut diperbarui
    // (hanya bila memang berubah — postingan rutin tidak menulis ulang).
    if (input.chatTitle) {
      const [contact] = await tx
        .select({ name: contacts.name })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      if (contact && contact.name !== input.chatTitle) {
        await tx
          .update(contacts)
          .set({ name: input.chatTitle })
          .where(eq(contacts.id, contactId));
      }
    }
  } else {
    const [contact] = await tx
      .insert(contacts)
      .values({
        tenantId: account.tenantId,
        name: input.chatTitle ?? fallbackName,
      })
      .returning();
    contactId = contact.id;
    await tx.insert(channelIdentities).values({
      tenantId: account.tenantId,
      contactId,
      channelAccountId: account.id,
      provider: "telegram",
      externalUserId: input.chatExternalId,
      username: null,
    });
  }

  const [existing] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, account.tenantId),
        eq(conversations.channelAccountId, account.id),
        eq(conversations.providerChatId, input.chatExternalId),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (existing && existing.status !== "closed") {
    const patch: { title?: string; kind?: string } = {};
    if (input.chatTitle && existing.title !== input.chatTitle) {
      patch.title = input.chatTitle;
    }
    if (existing.kind !== "channel") patch.kind = "channel";
    if (Object.keys(patch).length > 0) {
      await tx.update(conversations).set(patch).where(eq(conversations.id, existing.id));
    }
    return { conversationId: existing.id, contactId, created: false };
  }

  const [conv] = await tx
    .insert(conversations)
    .values({
      tenantId: account.tenantId,
      channelAccountId: account.id,
      contactId,
      provider: "telegram",
      providerChatId: input.chatExternalId,
      title: input.chatTitle ?? null,
      kind: "channel",
      status: "open",
    })
    .returning();
  return { conversationId: conv.id, contactId, created: true };
}

export interface RecordTelegramChannelPostInput {
  /** Id chat channel (`chat.id`, negatif) — penulis sekaligus alamat. */
  chatExternalId: string;
  /** Judul channel dari payload `channel_post`. */
  chatTitle?: string | null;
  /** Id dedup global: `telegram:<botId>:<message_id>` (pola jalur pesan). */
  providerMessageId: string;
  /** Id majemuk postingan yang dikutip postingan ini (Fase 7B.5), bila ada. */
  replyToProviderMessageId?: string | null;
  /** Snapshot isi postingan yang dikutip (Hotfix 7B.6), bila payload membawanya. */
  replyToSnapshot?: {
    authorLabel: string | null;
    contentPreview: string | null;
  } | null;
  text: string;
}

/**
 * Hasil pencatatan channel_post (Fase 7B.1): `duplicate` menandai
 * pantulan/retry yang menemukan baris yang sudah ada, agar route
 * webhook bisa mencatat outcome log integrasi yang jujur.
 */
export interface RecordTelegramChannelPostResult {
  message: Message;
  duplicate: boolean;
}

/**
 * Mencatat satu `channel_post` Telegram ke linimasa percakapan channel
 * (Fase 6A.2). Semantik BERBEDA dari pesan percakapan biasa, disengaja:
 *
 * - **Dedup pantulan lebih dulu:** postingan yang KITA kirim dari
 *   dashboard memantul kembali dengan message_id yang sama, dan poller
 *   sudah menyimpannya di pesan outbound → baris itu ditemukan di sini
 *   dan dikembalikan apa adanya; linimasa tetap menampilkan SATU baris
 *   (kiriman kita, arah outbound). Retry webhook Telegram untuk
 *   postingan orang lain ter-dedup dengan cara yang sama.
 * - **Tanpa unread & tanpa outbox:** channel adalah linimasa siaran,
 *   bukan antrean kerja — postingan tidak menaikkan badge agen dan tidak
 *   memicu automation/sequence/agent (penjaga `kind` di jalur evaluasi
 *   adalah lapis kedua bila ada event liar).
 *
 * Mengembalikan pesan yang tersimpan/ ditemukan, atau NULL bila
 * kembarannya dimiliki tenant/akun lain (akui webhook, jangan ganda).
 */
export async function recordTelegramChannelPost(
  db: Database,
  account: Pick<TelegramAccountRef, "id" | "tenantId">,
  input: RecordTelegramChannelPostInput,
): Promise<RecordTelegramChannelPostResult | null> {
  return withTenantDb(db, account.tenantId, async (tx) => {
    // (1) Dedup: pantulan postingan sendiri / retry update yang sama.
    const [dupe] = await tx
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, input.providerMessageId))
      .limit(1);
    if (dupe) return { message: dupe, duplicate: true };

    const { conversationId } = await ensureTelegramChannelConversation(
      tx,
      account,
      { chatExternalId: input.chatExternalId, chatTitle: input.chatTitle },
    );

    // Fase 7B.5: postingan channel juga bisa mengutip postingan lain di
    // channel yang sama — tautkan bila targetnya ada di linimasa ini.
    const replyToMessageId = input.replyToProviderMessageId
      ? await resolveInboundReplyTargetId(
          tx,
          conversationId,
          input.replyToProviderMessageId,
        )
      : null;

    // (2) Simpan postingan sebagai pesan masuk linimasa. sender_name =
    // judul channel: penulisnya channel itu sendiri (sender_chat).
    // ON CONFLICT DO NOTHING melindungi balapan index unik global
    // (pola yang sama seperti jalur pesan 6A.1).
    const [message] = await tx
      .insert(messages)
      .values({
        tenantId: account.tenantId,
        conversationId,
        direction: "inbound",
        senderType: "contact",
        senderName: input.chatTitle ?? null,
        type: "text",
        contentText: input.text,
        providerMessageId: input.providerMessageId,
        replyToMessageId,
        replyToSnapshot: normalizeReplyToSnapshot(input.replyToSnapshot),
        status: "received",
      })
      .onConflictDoNothing()
      .returning();
    if (!message) return null;

    const now = new Date();
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, conversationId));

    return { message, duplicate: false };
  });
}

export interface TelegramQueuedDelivery {
  tenantId: string;
  messageId: string;
  conversationId: string;
  contentText: string | null;
  /**
   * Id baris pesan yang dikutip pesan ini (Fase 7B.5), atau null.
   * Poller menurunkan id numerik Telegram targetnya dari baris itu
   * dalam konteks tenant (getMessageProviderMessageId) — id provider
   * TIDAK ikut disalin ke hasil pindai lintas tenant ini.
   */
  replyToMessageId: string | null;
  channelAccountId: string;
  /**
   * external_id akun = id numerik bot (Fase 6A.2): poller menyusun
   * provider_message_id majemuk `telegram:<botId>:<message_id>` untuk
   * pesan yang baru terkirim agar pantulan `channel_post`-nya ter-dedup.
   */
  botExternalId: string;
  /** Envelope enkripsi token bot akun pemilik (dekripsi di lapisan pengirim). */
  encryptedBotToken: string | null;
  /**
   * Alamat balasan (Fase 6A.1): `conversations.provider_chat_id` — id grup
   * (negatif) untuk percakapan grup, id user untuk privat. Baris lama
   * yang belum ter-backfill jatuh kembali ke external_user_id identitas
   * kontak percakapan.
   */
  chatExternalId: string;
}

/**
 * Pindai antrean pengiriman Telegram LINTAS tenant untuk poller API:
 * pesan outbound `queued` pada percakapan telegram, lengkap dengan token
 * terenkripsi akunnya dan alamat chat tujuannya. Berjalan dalam transaksi
 * yang men-set `app.system_delivery='telegram'` — policy
 * `system_delivery_scan` (0018) membuka tepat baris-baris ini (baca saja);
 * penandaan sent/failed tetap dalam konteks tenant masing-masing.
 */
export async function listQueuedTelegramDeliveries(
  db: Database,
  limit = 25,
): Promise<TelegramQueuedDelivery[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.system_delivery', 'telegram', true)`,
    );
    // Alamat chat: `provider_chat_id` percakapan lebih dulu, identitas
    // kontak sebagai cadangan (Fase 16G). Lihat catatan panjang di
    // `listQueuedMetaDeliveries`: INNER JOIN ke channel_identities
    // membuang percakapan yang alamatnya sudah pasti hanya karena baris
    // identitasnya tidak ada, dan JOIN itu juga menggandakan baris pesan
    // (tidak ada unique index pada pasangan akun+kontak).
    const chatExternalId = sql<string>`coalesce(
      ${conversations.providerChatId},
      (
        SELECT ci.external_user_id
          FROM channel_identities ci
         WHERE ci.channel_account_id = ${channelAccounts.id}
           AND ci.contact_id = ${conversations.contactId}
         ORDER BY ci.created_at ASC
         LIMIT 1
      )
    )`;
    const rows = await tx
      .select({
        tenantId: messages.tenantId,
        messageId: messages.id,
        conversationId: messages.conversationId,
        contentText: messages.contentText,
        replyToMessageId: messages.replyToMessageId,
        channelAccountId: channelAccounts.id,
        botExternalId: channelAccounts.externalId,
        encryptedBotToken: channelAccounts.accessTokenEncrypted,
        chatExternalId,
      })
      .from(messages)
      .innerJoin(
        conversations,
        eq(messages.conversationId, conversations.id),
      )
      .innerJoin(
        channelAccounts,
        eq(conversations.channelAccountId, channelAccounts.id),
      )
      .where(
        and(
          eq(messages.direction, "outbound"),
          eq(messages.status, "queued"),
          // Hanya baris yang bisa diklaim: belum diklaim, atau klaimnya
          // basi (pengirim sebelumnya mati). Baris yang sedang dikirim
          // poller lain tidak ikut dipindai — cegah kirim ganda.
          or(
            isNull(messages.claimedAt),
            lt(messages.claimedAt, outboundClaimStale),
          ),
          eq(conversations.provider, "telegram"),
          sql`${chatExternalId} IS NOT NULL`,
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(limit);
    return rows;
  });
}

export interface TelegramMyChatMemberInput {
  /** Id chat tempat status bot berubah (grup/channel: negatif). */
  chatExternalId: string;
  chatTitle?: string | null;
  /** Status baru bot di chat itu dari Telegram (member/administrator/kicked/left/...). */
  memberStatus: string;
  /**
   * Tipe chat Telegram (Fase 6A.2): 'channel' mengubah perilaku — bot
   * yang menjadi admin channel membuat channel itu langsung tampil
   * sebagai percakapan linimasa walau belum ada postingan.
   */
  chatType?: string | null;
}

/** Status keanggotaan yang berarti bot AKTIF di chat (bisa menerima update). */
const TELEGRAM_ACTIVE_MEMBER_STATUSES = new Set([
  "creator",
  "administrator",
  "member",
]);

/**
 * Mencatat update `my_chat_member` (Fase 6A.1): bot dimasukkan/dikeluarkan
 * dari sebuah chat. BUKAN pesan — untuk grup cukup satu baris audit agar
 * pemilik punya jejak kapan botnya masuk grup.
 *
 * Fase 6A.2 — chat bertipe channel: bot yang menjadi ADMIN channel
 * (status aktif) sekaligus membuat percakapan channel-nya tampil di
 * dashboard (find-or-create lewat pola yang sama seperti channel_post),
 * supaya pemilik bisa langsung memposting tanpa menunggu postingan
 * pertama dari admin lain. Bot dikeluarkan dari channel → audit saja;
 * riwayat linimasa tetap tersimpan.
 * Tidak fatal bila gagal: pemanggil (route webhook) mengabaikan error-nya
 * agar webhook tetap menjawab 200.
 */
export async function recordTelegramMyChatMember(
  db: Database,
  account: Pick<TelegramAccountRef, "id" | "tenantId">,
  input: TelegramMyChatMemberInput,
): Promise<void> {
  await withTenantDb(db, account.tenantId, async (tx) => {
    let channelConversationId: string | null = null;
    if (
      input.chatType === "channel" &&
      TELEGRAM_ACTIVE_MEMBER_STATUSES.has(input.memberStatus)
    ) {
      const ensured = await ensureTelegramChannelConversation(tx, account, {
        chatExternalId: input.chatExternalId,
        chatTitle: input.chatTitle,
      });
      channelConversationId = ensured.conversationId;
    }
    await tx.insert(auditLogs).values({
      tenantId: account.tenantId,
      actorType: "system",
      actorId: "telegram-webhook",
      action: "telegram.my_chat_member",
      meta: {
        channelAccountId: account.id,
        chatId: input.chatExternalId,
        chatTitle: input.chatTitle ?? null,
        chatType: input.chatType ?? null,
        memberStatus: input.memberStatus,
        ...(channelConversationId
          ? { channelConversationId }
          : {}),
      },
    });
  });
}
