import { and, desc, eq, sql } from "drizzle-orm";
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
  type MessageTriggerSignal,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";
import { resolveInboundReplyTargetId } from "./conversations";
import type { MetaChannelTokenType } from "./meta";

/**
 * Service domain WhatsApp (Fase 7B, RANCANGAN §4 & §12) — WhatsApp
 * Cloud API di atas rel Meta Fase 7A (Graph API v26.0, webhook tunggal
 * platform, tanda tangan app secret yang sama, token terenkripsi
 * envelope yang sama). Perbedaan bentuk dari Messenger/Instagram:
 *
 * - Objek webhook ketiga: `whatsapp_business_account`. `entry.id` =
 *   WABA ID (akun bisnis INDUK), sedangkan nomor pengirim dipilih dari
 *   `value.metadata.phone_number_id`. Resolusi akun di sini SELALU dari
 *   phone_number_id — satu WABA sah menaungi banyak nomor di banyak
 *   tenant, jadi entry.id tidak pernah jadi kunci.
 * - Model akun: external_id = phone_number_id; WABA ID disimpan di
 *   `parent_external_id` (migrasi 0027) sebagai konteks induk;
 *   `public_handle` = display_phone_number terformat dari Graph.
 * - Webhook membawa NAMA pengirim (value.contacts[].profile.name) —
 *   tidak seperti Meta DM yang webhook-nya anonim — jadi kontak lahir
 *   langsung bernama; foto profil kontak TIDAK disediakan WhatsApp API
 *   (privasi) → kontak WA selalu inisial berwarna BY DESIGN.
 * - Status pengiriman adalah warga kelas satu: `value.statuses[]`
 *   memperbarui pesan keluar kita (sent → delivered → read, hanya
 *   maju; failed terminal) — lihat `applyWhatsAppMessageStatus`.
 *
 * Id pesan provider disimpan MAJEMUK `meta:<phoneNumberId>:<wamid>`
 * (pola 7A) karena index unik provider_message_id bersifat global.
 */

export const WHATSAPP_CONTACT_FALLBACK_NAME = "WhatsApp user";

/** Bentuk majemuk id pesan provider untuk baris `messages` (pola 7A). */
export function whatsAppProviderMessageId(
  phoneNumberId: string,
  wamid: string,
): string {
  return `meta:${phoneNumberId}:${wamid}`;
}

export interface CreateWhatsAppChannelInput {
  /** Phone Number ID — menjadi external_id akun. */
  phoneNumberId: string;
  /** WABA ID — disimpan di parent_external_id (konteks induk). */
  wabaId: string;
  /** verified_name dari Graph (`GET /{phone_number_id}`). */
  verifiedName: string | null;
  /** display_phone_number terformat dari Graph → public_handle. */
  displayPhoneNumber: string | null;
  /** Nama tampilan pilihan pemilik workspace (menang atas verified_name). */
  displayName?: string;
  /** Envelope enkripsi Access Token (System User) — BUKAN token mentah. */
  encryptedAccessToken: string;
  /** Versi Graph API ter-pin untuk akun ini (dari packages/config). */
  graphApiVersion: string;
  /**
   * Lifecycle token (0010): varian (umumnya business_token hasil
   * Embedded Signup) + jadwal kedaluwarsa dari `expires_in` Graph.
   * Default varian: business_token.
   */
  tokenType?: MetaChannelTokenType | null;
  tokenExpiresAt?: Date | null;
}

export async function createWhatsAppChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreateWhatsAppChannelInput,
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: "whatsapp",
        externalId: input.phoneNumberId,
        parentExternalId: input.wabaId,
        displayName: input.displayName ?? input.verifiedName,
        status: "connected",
        accessTokenEncrypted: input.encryptedAccessToken,
        publicHandle: input.displayPhoneNumber,
        graphApiVersion: input.graphApiVersion,
        tokenType: input.tokenType ?? "business_token",
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        tokenHealth: "ok",
        errorCode: null,
      })
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "channel.created",
      // Metadata aman: WABA/nomor memang pengenal bisnis publik; token
      // tidak dicatat.
      meta: {
        channelAccountId: row.id,
        provider: "whatsapp",
        parentExternalId: input.wabaId,
        publicHandle: input.displayPhoneNumber,
      },
    });

    return row;
  });
}

export interface UpdateWhatsAppCredentialsInput {
  encryptedAccessToken?: string;
  wabaId?: string;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  displayName?: string;
  status?: ChannelAccount["status"];
  /** Lifecycle 0010: varian + jadwal token baru saat revive. */
  tokenType?: MetaChannelTokenType | null;
  tokenExpiresAt?: Date | null;
  tokenRefreshedAt?: Date | null;
}

/**
 * Menulis ulang kredensial/status akun WhatsApp yang SUDAH ada di
 * tenant ini — jalur "revive" connect (pola Meta 7A): akun tenant yang
 * sama berstatus 'disconnected'/'error' dihubungkan lagi tanpa baris
 * duplikat. Menghubungkan lagi selalu mengeluarkan akun dari Sampah.
 */
export async function updateWhatsAppChannelAccountCredentials(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  input: UpdateWhatsAppCredentialsInput,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = { updatedAt: new Date() };
    if (input.encryptedAccessToken !== undefined) {
      patch.accessTokenEncrypted = input.encryptedAccessToken;
      // Kredensial baru = siklus token dimulai ulang (lifecycle 0010).
      patch.tokenHealth = "ok";
      patch.errorCode = null;
    }
    if (input.wabaId !== undefined) {
      patch.parentExternalId = input.wabaId;
    }
    if (input.tokenType !== undefined) patch.tokenType = input.tokenType;
    if (input.tokenExpiresAt !== undefined) {
      patch.tokenExpiresAt = input.tokenExpiresAt;
    }
    if (input.tokenRefreshedAt !== undefined) {
      patch.tokenRefreshedAt = input.tokenRefreshedAt;
    }
    if (input.displayPhoneNumber !== undefined) {
      patch.publicHandle = input.displayPhoneNumber;
    }
    if (input.displayName !== undefined) {
      patch.displayName = input.displayName;
    } else if (input.verifiedName) {
      const [current] = await tx
        .select({ displayName: channelAccounts.displayName })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.tenantId, ctx.tenantId),
            eq(channelAccounts.id, channelAccountId),
          ),
        )
        .limit(1);
      if (current && !current.displayName) {
        patch.displayName = input.verifiedName;
      }
    }
    if (input.status !== undefined) patch.status = input.status;
    if (input.status === "connected") {
      patch.trashedAt = null;
      patch.errorCode = null;
    }

    const [row] = await tx
      .update(channelAccounts)
      .set(patch)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export type WhatsAppAccountRef = Pick<
  ChannelAccount,
  | "id"
  | "tenantId"
  | "provider"
  | "externalId"
  | "parentExternalId"
  | "displayName"
  | "status"
  | "accessTokenEncrypted"
  | "publicHandle"
>;

/**
 * Resolusi akun WhatsApp dari phone_number_id payload webhook TANPA
 * konteks tenant — lengan RLS `provider_external_lookup` (0020) yang
 * sama seperti Meta (generik per provider+external_id). phone_number_id
 * berasal dari payload yang SUDAH lolos verifikasi tanda tangan app
 * secret di route. Null bila tak dikenal.
 */
export async function resolveWhatsAppAccountByPhoneNumberId(
  db: Database,
  phoneNumberId: string,
): Promise<WhatsAppAccountRef | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.channel_provider', 'whatsapp', true)`,
    );
    await tx.execute(
      sql`SELECT set_config('app.channel_external_id', ${phoneNumberId}, true)`,
    );
    const [row] = await tx
      .select({
        id: channelAccounts.id,
        tenantId: channelAccounts.tenantId,
        provider: channelAccounts.provider,
        externalId: channelAccounts.externalId,
        parentExternalId: channelAccounts.parentExternalId,
        displayName: channelAccounts.displayName,
        status: channelAccounts.status,
        accessTokenEncrypted: channelAccounts.accessTokenEncrypted,
        publicHandle: channelAccounts.publicHandle,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, "whatsapp"),
          eq(channelAccounts.externalId, phoneNumberId),
        ),
      )
      // Fase 7C: dahulukan akun connected (penjaga 0020 menjamin
      // maks. satu per external_id) — alasan lengkap di
      // resolveMetaAccountByExternalId (meta.ts).
      .orderBy(
        sql`case when ${channelAccounts.status} = 'connected' then 0 else 1 end`,
        desc(channelAccounts.createdAt),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Resolusi SEMUA akun WhatsApp milik satu WABA — dipakai event webhook
 * tingkat WABA yang tidak menyebut nomor telepon sama sekali
 * (`message_template_status_update`).
 *
 * Berbeda dari `resolveWhatsAppAccountByPhoneNumberId`, kuncinya
 * `parent_external_id` (WABA id), bukan `external_id` (phone_number_id),
 * lewat lengan RLS `whatsapp_waba_lookup` (migrasi 0004). Satu WABA bisa
 * menaungi beberapa nomor dan — secara teori — beberapa tenant, jadi
 * hasilnya daftar: setiap cermin template per akun harus ikut diperbarui,
 * bukan hanya yang pertama ditemukan.
 */
export async function resolveWhatsAppAccountsByWabaId(
  db: Database,
  wabaId: string,
): Promise<WhatsAppAccountRef[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.whatsapp_waba_id', ${wabaId}, true)`,
    );
    return tx
      .select({
        id: channelAccounts.id,
        tenantId: channelAccounts.tenantId,
        provider: channelAccounts.provider,
        externalId: channelAccounts.externalId,
        parentExternalId: channelAccounts.parentExternalId,
        displayName: channelAccounts.displayName,
        status: channelAccounts.status,
        accessTokenEncrypted: channelAccounts.accessTokenEncrypted,
        publicHandle: channelAccounts.publicHandle,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, "whatsapp"),
          eq(channelAccounts.parentExternalId, wabaId),
        ),
      );
  });
}

export interface RecordWhatsAppInboundResult {
  message: Message;
  contactId: string;
  identityCreated: boolean;
  /** Fase 7B.1: true bila wamid ini kembaran yang sudah tercatat. */
  duplicate: boolean;
}

export interface RecordWhatsAppInboundInput {
  /** wa_id pengirim (nomor telepon internasional tanpa '+'). */
  senderWaId: string;
  /** Nama profil dari webhook (contacts[].profile.name); null bila tak ada. */
  contactName: string | null;
  /** wamid pesan masuk — id dedup provider. */
  providerMessageId: string;
  /**
   * Wamid pesan yang dikutip pesan ini (`messages[].context.id`, Fase
   * 7B.5) — ditautkan ke baris target bila ditemukan di percakapan yang
   * sama; selain itu pesan tetap tercatat tanpa tautan.
   */
  replyToProviderMessageId?: string | null;
  /** Tipe pesan ternormalisasi (enum message_type kita). */
  type: Message["type"];
  /** Isi teks; untuk media = caption bila ada, selain itu null. */
  text: string | null;
  /**
   * Referensi media provider (Fase 18). Disimpan di baris pesan, BUKAN
   * diunduh di sini: unduhan terjadi di worker (`ingestMessageMedia`)
   * karena webhook harus di-ack cepat. Null untuk pesan teks atau bila
   * payload tidak membawa media id.
   */
  media?: {
    id: string;
    mimeType: string | null;
    fileName: string | null;
  } | null;
  /**
   * Sinyal pemicu (G5): balasan tombol/daftar interaktif WhatsApp
   * dinormalkan parser menjadi sinyal quick_reply (payload = id
   * tombol/baris). Ditulis ke messages.trigger_signal apa adanya.
   */
  triggerSignal?: MessageTriggerSignal | null;
}

/**
 * Menyimpan pesan WhatsApp masuk: temukan/buat kontak pengirim +
 * percakapan privat terbuka, lalu baris pesan + unread + event outbox
 * `message.received` dalam SATU transaksi tenant (pola meta/telegram).
 * Nama kontak datang dari webhook: kontak baru lahir dengan nama itu;
 * kontak lama yang masih berlabel cadangan diganti nama webhook (nama
 * yang sudah disunting pemilik tidak ditimpa). Pesan non-teks tetap
 * dicatat dengan tipenya (caption sebagai contentText bila ada) agar
 * linimasa inbox jujur — media-nya sendiri tidak diunduh di v1.
 * Idempoten terhadap retry webhook: wamid yang sama mengembalikan
 * pesan yang sudah ada; NULL hanya bila kembarannya milik tenant lain.
 */
export async function recordWhatsAppInboundMessage(
  db: Database,
  account: Pick<WhatsAppAccountRef, "id" | "tenantId" | "externalId">,
  input: RecordWhatsAppInboundInput,
): Promise<RecordWhatsAppInboundResult | null> {
  const compositeId = whatsAppProviderMessageId(
    account.externalId,
    input.providerMessageId,
  );
  return withTenantDb(db, account.tenantId, async (tx) => {
    const [identity] = await tx
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channelAccountId, account.id),
          eq(channelIdentities.externalUserId, input.senderWaId),
        ),
      )
      .limit(1);

    let contactId: string;
    let identityCreated = false;
    if (identity) {
      contactId = identity.contactId;
      if (input.contactName) {
        const [contact] = await tx
          .select({ name: contacts.name })
          .from(contacts)
          .where(eq(contacts.id, contactId))
          .limit(1);
        if (contact && contact.name === WHATSAPP_CONTACT_FALLBACK_NAME) {
          await tx
            .update(contacts)
            .set({ name: input.contactName })
            .where(eq(contacts.id, contactId));
        }
      }
    } else {
      const [contact] = await tx
        .insert(contacts)
        .values({
          tenantId: account.tenantId,
          name: input.contactName ?? WHATSAPP_CONTACT_FALLBACK_NAME,
        })
        .returning();
      contactId = contact.id;
      identityCreated = true;
      await tx.insert(channelIdentities).values({
        tenantId: account.tenantId,
        contactId,
        channelAccountId: account.id,
        provider: "whatsapp",
        externalUserId: input.senderWaId,
      });
    }

    const [existingConv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, account.tenantId),
          eq(conversations.channelAccountId, account.id),
          eq(conversations.contactId, contactId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);

    let conversationId: string;
    if (existingConv && existingConv.status !== "closed") {
      conversationId = existingConv.id;
      if (existingConv.providerChatId !== input.senderWaId) {
        await tx
          .update(conversations)
          .set({ providerChatId: input.senderWaId })
          .where(eq(conversations.id, existingConv.id));
      }
    } else {
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId: account.tenantId,
          channelAccountId: account.id,
          contactId,
          provider: "whatsapp",
          providerChatId: input.senderWaId,
          kind: "private",
          status: "open",
        })
        .returning();
      conversationId = conv.id;
    }

    // Dedup webhook retry (pola meta): wamid yang sama tidak ganda.
    const [dupe] = await tx
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, compositeId))
      .limit(1);
    if (dupe)
      return { message: dupe, contactId, identityCreated: false, duplicate: true };

    // Fase 7B.5: tautkan kutipan (context.id) bila targetnya ada di
    // percakapan ini — id majemuk target disusun dengan helper yang sama.
    const replyToMessageId = input.replyToProviderMessageId
      ? await resolveInboundReplyTargetId(
          tx,
          conversationId,
          whatsAppProviderMessageId(
            account.externalId,
            input.replyToProviderMessageId,
          ),
        )
      : null;

    // ON CONFLICT DO NOTHING: index uniknya global sedangkan SELECT
    // dedup terkurung RLS tenant ini (pelajaran 6A.1/7A).
    const [message] = await tx
      .insert(messages)
      .values({
        tenantId: account.tenantId,
        conversationId,
        direction: "inbound",
        senderType: "contact",
        type: input.type,
        contentText: input.text,
        // Fase 18: simpan referensi media supaya worker bisa mengunduh
        // nanti. Tanpa ini media id hilang bersama request dan berkas
        // pelanggan tidak bisa diambil lagi (URL Meta hanya ±5 menit).
        providerMediaId: input.media?.id ?? null,
        providerMediaMime: input.media?.mimeType ?? null,
        providerMediaFileName: input.media?.fileName ?? null,
        providerMessageId: compositeId,
        replyToMessageId,
        triggerSignal: input.triggerSignal ?? null,
        status: "received",
      })
      .onConflictDoNothing()
      .returning();
    if (!message) return null;

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
        provider: "whatsapp",
        channelAccountId: account.id,
        conversationId,
        messageId: message.id,
      },
    });

    return { message, contactId, identityCreated, duplicate: false };
  });
}

// ---------------------------------------------------------------------------
// Echo coexistence (smb_message_echoes) — pesan dikirim dari HP
// ---------------------------------------------------------------------------

export interface RecordWhatsAppEchoInput {
  /** wa_id PELANGGAN penerima (sudah dinormalkan tanpa '+'). */
  customerWaId: string;
  /** wamid pesan yang dikirim dari aplikasi WhatsApp Business. */
  providerMessageId: string;
  type: Message["type"];
  text: string | null;
}

export interface RecordWhatsAppEchoResult {
  message: Message;
  conversationId: string;
  duplicate: boolean;
}

/**
 * Mencatat pesan yang dikirim bisnis lewat aplikasi WhatsApp Business /
 * perangkat tertaut (mode coexistence) sebagai pesan KELUAR di inbox.
 *
 * Tanpa ini, jawaban yang diketik staf dari HP tidak pernah muncul di
 * linimasa — agen lain melihat percakapan seolah pelanggan tidak pernah
 * dibalas, lalu membalas lagi. Itu sebabnya echo dicatat, bukan dibuang.
 *
 * TIGA PERBEDAAN yang disengaja dari `recordWhatsAppInboundMessage`:
 * 1. `direction: "outbound"`, `senderType: "user"`, `status: "sent"` —
 *    pesan ini memang sudah terkirim dari perangkat, bukan dari antrean
 *    kita, jadi tidak ada status `queued` dan tidak akan pernah ada
 *    receipt `delivered/read` dari Cloud API untuk wamid ini.
 * 2. `unread_count` TIDAK dinaikkan — pesan keluar bukan beban belum
 *    dibaca.
 * 3. TIDAK menulis outbox `message.received`. Event itu yang membuat
 *    worker menjalankan `automation.evaluate`; memicunya di sini berarti
 *    agent AI/automation membalas pesan yang barusan diketik manusia —
 *    persis kebalikan dari yang diinginkan.
 *
 * Idempoten seperti jalur masuk: wamid yang sama mengembalikan baris
 * yang sudah ada (`duplicate: true`).
 */
export async function recordWhatsAppEchoMessage(
  db: Database,
  account: Pick<WhatsAppAccountRef, "id" | "tenantId" | "externalId">,
  input: RecordWhatsAppEchoInput,
): Promise<RecordWhatsAppEchoResult | null> {
  const compositeId = whatsAppProviderMessageId(
    account.externalId,
    input.providerMessageId,
  );
  return withTenantDb(db, account.tenantId, async (tx) => {
    const [identity] = await tx
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channelAccountId, account.id),
          eq(channelIdentities.externalUserId, input.customerWaId),
        ),
      )
      .limit(1);

    let contactId: string;
    if (identity) {
      contactId = identity.contactId;
    } else {
      // Nama pelanggan tidak ada di payload echo — kontak lahir dengan
      // label cadangan dan akan berganti nama saat pelanggan membalas.
      const [contact] = await tx
        .insert(contacts)
        .values({
          tenantId: account.tenantId,
          name: WHATSAPP_CONTACT_FALLBACK_NAME,
        })
        .returning();
      contactId = contact.id;
      await tx.insert(channelIdentities).values({
        tenantId: account.tenantId,
        contactId,
        channelAccountId: account.id,
        provider: "whatsapp",
        externalUserId: input.customerWaId,
      });
    }

    const [existingConv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, account.tenantId),
          eq(conversations.channelAccountId, account.id),
          eq(conversations.contactId, contactId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);

    let conversationId: string;
    if (existingConv && existingConv.status !== "closed") {
      conversationId = existingConv.id;
    } else {
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId: account.tenantId,
          channelAccountId: account.id,
          contactId,
          provider: "whatsapp",
          providerChatId: input.customerWaId,
          kind: "private",
          status: "open",
        })
        .returning();
      conversationId = conv.id;
    }

    const [dupe] = await tx
      .select()
      .from(messages)
      .where(eq(messages.providerMessageId, compositeId))
      .limit(1);
    if (dupe) return { message: dupe, conversationId, duplicate: true };

    const [message] = await tx
      .insert(messages)
      .values({
        tenantId: account.tenantId,
        conversationId,
        direction: "outbound",
        senderType: "user",
        type: input.type,
        contentText: input.text,
        providerMessageId: compositeId,
        status: "sent",
      })
      .onConflictDoNothing()
      .returning();
    if (!message) return null;

    const now = new Date();
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, conversationId));

    return { message, conversationId, duplicate: false };
  });
}

// ---------------------------------------------------------------------------
// Status pengiriman (statuses webhook) — ciri khas WhatsApp
// ---------------------------------------------------------------------------

export type WhatsAppDeliveryStatus = "sent" | "delivered" | "read" | "failed";

/** Peringkat kemajuan status; status hanya boleh bergerak MAJU. */
const WHATSAPP_STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

export interface ApplyWhatsAppMessageStatusInput {
  /** wamid pesan KELUAR kita (statuses[].id). */
  providerMessageId: string;
  status: WhatsAppDeliveryStatus;
  /** Kode error numerik Graph dari statuses[].errors[0].code (status failed). */
  graphErrorCode?: number | null;
}

export interface ApplyWhatsAppMessageStatusResult {
  messageId: string;
  conversationId: string;
  /** Status pesan sesudah upaya penerapan. */
  status: Message["status"];
  /** true bila baris benar-benar berubah (bukan status basi/duplikat). */
  applied: boolean;
}

/**
 * Menerapkan satu status pengiriman WhatsApp ke pesan keluar kita yang
 * cocok (dicocokkan lewat wamid majemuk akun ini). Aturan gerak:
 * - sent → delivered → read: HANYA maju. Status basi (mis. `sent`
 *   datang sesudah `read`, atau duplikat) diabaikan tanpa perubahan.
 * - failed: terminal — diterapkan dari queued/sent/delivered dengan
 *   kode error Graph disimpan sebagai `meta_graph_<kode>` di
 *   `messages.error_code` (format yang sama seperti kegagalan poller
 *   Meta); sesudah failed tidak ada status lain yang berlaku, dan
 *   read tidak pernah diturunkan menjadi failed.
 * Mengembalikan null bila tidak ada pesan keluar yang cocok (status
 * untuk pesan yang tidak kita kenal — webhook tetap diakui 200).
 */
export async function applyWhatsAppMessageStatus(
  db: Database,
  account: Pick<WhatsAppAccountRef, "id" | "tenantId" | "externalId">,
  input: ApplyWhatsAppMessageStatusInput,
): Promise<ApplyWhatsAppMessageStatusResult | null> {
  const compositeId = whatsAppProviderMessageId(
    account.externalId,
    input.providerMessageId,
  );
  return withTenantDb(db, account.tenantId, async (tx) => {
    const [message] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, account.tenantId),
          eq(messages.providerMessageId, compositeId),
          eq(messages.direction, "outbound"),
        ),
      )
      .limit(1);
    if (!message) return null;

    const current = message.status;
    const unchanged: ApplyWhatsAppMessageStatusResult = {
      messageId: message.id,
      conversationId: message.conversationId,
      status: current,
      applied: false,
    };
    // failed & read adalah keadaan akhir untuk arah gerak ini.
    if (current === "failed" || current === "received") return unchanged;

    if (input.status === "failed") {
      if (current === "read") return unchanged;
      const errorCode =
        input.graphErrorCode != null
          ? `meta_graph_${input.graphErrorCode}`
          : "whatsapp_delivery_failed";
      const [updated] = await tx
        .update(messages)
        .set({ status: "failed", errorCode: errorCode.slice(0, 128) })
        .where(eq(messages.id, message.id))
        .returning();
      await tx.insert(auditLogs).values({
        tenantId: account.tenantId,
        actorType: "system",
        actorId: "whatsapp-webhook",
        action: "message.failed",
        meta: {
          conversationId: message.conversationId,
          messageId: message.id,
          via: "whatsapp-webhook",
          errorCode,
        },
      });
      return {
        messageId: message.id,
        conversationId: message.conversationId,
        status: updated.status,
        applied: true,
      };
    }

    const currentRank = WHATSAPP_STATUS_RANK[current] ?? 0;
    const nextRank = WHATSAPP_STATUS_RANK[input.status] ?? 0;
    if (nextRank <= currentRank) return unchanged;

    const [updated] = await tx
      .update(messages)
      .set({ status: input.status })
      .where(eq(messages.id, message.id))
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: account.tenantId,
      actorType: "system",
      actorId: "whatsapp-webhook",
      action: "message.status",
      meta: {
        conversationId: message.conversationId,
        messageId: message.id,
        via: "whatsapp-webhook",
        from: current,
        to: input.status,
      },
    });
    return {
      messageId: message.id,
      conversationId: message.conversationId,
      status: updated.status,
      applied: true,
    };
  });
}
