import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./identity";
import { channelAccounts, channelProviderEnum } from "./channels";

/**
 * Kelompok Audience & Inbox (Fase 1D, RANCANGAN §6):
 * - contacts      : audiens milik tenant (lintas channel).
 * - media         : file media yang disimpan di Cloudflare R2 (object key).
 * - conversations : satu utas percakapan kontak pada satu akun channel.
 * - messages      : pesan dalam percakapan; `provider_message_id` unik parsial
 *                   (hanya bila tidak NULL) untuk dedup pesan provider.
 * Semua tabel tenant-scoped: tenant_id + index, dilindungi RLS.
 */

export const optInStatusEnum = pgEnum("opt_in_status", [
  "unknown",
  "opted_in",
  "opted_out",
]);

export const conversationStatusEnum = pgEnum("conversation_status", [
  "open",
  "pending",
  "closed",
]);

export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);

export const messageSenderTypeEnum = pgEnum("message_sender_type", [
  "contact",
  "user",
  "agent",
  "system",
]);

export const messageTypeEnum = pgEnum("message_type", [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "template",
  "other",
]);

export const messageStatusEnum = pgEnum("message_status", [
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "received",
]);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 32 }),
    tags: text("tags").array().notNull().default([]),
    customFields: jsonb("custom_fields").notNull().default({}),
    /** Tahap pipeline penjualan, mis. 'new' | 'engaged' | 'qualified' | 'customer'. */
    pipelineStage: varchar("pipeline_stage", { length: 64 }).notNull().default("new"),
    /**
     * Sumber perolehan kontak (Fase 13B): diisi jalur atribusi growth
     * link sebagai `growth:<slug>` saat kontak pertama kali teratribusi
     * ke sebuah tautan. NULL = tidak teratribusi (keadaan normal
     * mayoritas kontak) — memang kondisional, bukan field wajib.
     * Atribusi pertama menang: nilai yang sudah terisi tidak ditimpa
     * tautan berikutnya (lihat attributeContactToGrowthLink di core).
     */
    source: varchar("source", { length: 128 }),
    optInStatus: optInStatusEnum("opt_in_status").notNull().default("unknown"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    /**
     * Jejak opt-in pemasaran (Fase 13C): kapan & lewat jalur apa kontak
     * terakhir memberi persetujuan broadcast. Keduanya NULL selama
     * kontak belum pernah opt-in — memang kondisional (aturan NOT NULL
     * user 2026-11-03). Opt-out TIDAK menghapus kedua kolom ini
     * (riwayat persetujuan dipertahankan); status EFEKTIF diturunkan
     * di core: opt_in_status='opted_out' → "opted_out"; selain itu
     * opt_in_at terisi (atau status 'opted_in') → "opted_in"; selain
     * itu "none". `opt_in_source`: 'keyword' | 'manual'.
     */
    optInSource: varchar("opt_in_source", { length: 64 }),
    optInAt: timestamp("opt_in_at", { withTimezone: true }),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contacts_tenant_id_idx").on(t.tenantId),
    index("contacts_tenant_phone_idx").on(t.tenantId, t.phone),
    index("contacts_tenant_email_idx").on(t.tenantId, t.email),
  ],
);

export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Object key di bucket Cloudflare R2 tenant/lingkungan ini. */
    r2Key: varchar("r2_key", { length: 512 }).notNull(),
    fileName: varchar("file_name", { length: 255 }),
    mimeType: varchar("mime_type", { length: 128 }),
    sizeBytes: integer("size_bytes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("media_tenant_id_idx").on(t.tenantId)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Denormalisasi dari channel_accounts.provider agar daftar inbox murah. */
    provider: channelProviderEnum("provider").notNull(),
    /**
     * Id chat di sisi provider = ALAMAT BALASAN percakapan ini (Fase 6A.1).
     * Pada Telegram: `chat.id` sebagai string — positif untuk chat privat
     * (== id user), negatif untuk grup/supergrup. Sampai 6A poller
     * menganggap alamat balasan = identitas kontak, yang hanya benar untuk
     * privat; kolom ini memisahkan keduanya. NULL untuk baris lama /
     * provider lain — poller jatuh kembali ke external_id identitas kontak.
     */
    providerChatId: varchar("provider_chat_id", { length: 255 }),
    /**
     * Judul percakapan di provider (Fase 6A.1) — diisi untuk percakapan
     * grup & channel Telegram (`chat.title`); percakapan privat & provider
     * lain NULL dan tampil memakai nama kontak. (Sampai 6A.1 kehadiran
     * judul adalah penanda grup; sejak 6A.2 penanda jenis adalah kolom
     * `kind` di bawah — judul kini murni label tampilan.)
     */
    title: varchar("title", { length: 255 }),
    /**
     * Jenis percakapan di provider (Fase 6A.2): 'private' (1:1), 'group'
     * (banyak anggota, dua arah), atau 'channel' (siaran satu arah —
     * linimasa postingan Telegram, BUKAN antrean kerja). Sampai 6A.1
     * jenis disimpulkan dari kehadiran `title`; kolom eksplisit ini
     * menjadi sumber kebenaran tunggal: `isGroup`/`isChannel` di API
     * diturunkan darinya, dan jalur evaluasi automation/agent MENOLAK
     * memproses pesan percakapan 'channel'. Default 'private' juga
     * berlaku untuk provider lain (webchat selalu privat).
     */
    kind: varchar("kind", { length: 16 }).notNull().default("private"),
    status: conversationStatusEnum("status").notNull().default("open"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Apakah AI agent boleh membalas otomatis di percakapan ini. */
    agentEnabled: boolean("agent_enabled").notNull().default(true),
    /**
     * Jendela cap balasan AI PER PERCAKAPAN (Gelombang G6): awal
     * jendela bergulir 24 jam + jumlah slot balasan yang sudah diklaim
     * di jendela itu. Klaim dilakukan runtime agent lewat SATU UPDATE
     * kondisional ber-RETURNING pada baris percakapan ini (kunci baris
     * Postgres menserialkan klaim bersamaan — lihat
     * `claimConversationReplySlot` di core/agent-guards.ts). NULL =
     * belum pernah ada klaim (jendela belum mulai). Kolom ini murni
     * penghitung penegakan; riwayat balasan yang otoritatif tetap
     * tabel `messages` + `usage_ledger`.
     */
    agentReplyWindowStartedAt: timestamp("agent_reply_window_started_at", {
      withTimezone: true,
    }),
    agentReplyWindowCount: integer("agent_reply_window_count")
      .notNull()
      .default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conversations_tenant_id_idx").on(t.tenantId),
    // Fase 9C: filter inbox "milik saya / belum ditugaskan".
    index("conversations_tenant_assignee_idx").on(t.tenantId, t.assigneeUserId),
    index("conversations_tenant_status_last_message_idx").on(
      t.tenantId,
      t.status,
      t.lastMessageAt,
    ),
    index("conversations_contact_id_idx").on(t.contactId),
    index("conversations_channel_account_id_idx").on(t.channelAccountId),
    check(
      "conversations_kind_valid",
      sql`${t.kind} IN ('private', 'group', 'channel')`,
    ),
  ],
);

/**
 * Sinyal pemicu pada satu pesan masuk (G5) — bentuk kolom
 * `messages.trigger_signal`. `payload` adalah string mesin dari
 * platform (dicocokkan PERSIS ke trigger_config.payloads aturan);
 * `title` adalah label tombol yang terlihat pengguna (Meta/WA),
 * null untuk Telegram callback_query yang hanya membawa data.
 */
export interface MessageTriggerSignal {
  kind: "postback" | "quick_reply";
  payload: string;
  title: string | null;
}

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: messageDirectionEnum("direction").notNull(),
    senderType: messageSenderTypeEnum("sender_type").notNull(),
    /**
     * Nama pengirim per pesan (Fase 6A.1) — snapshot nama anggota saat
     * pesan grup Telegram masuk. Percakapan grup menampung banyak
     * pengirim, sedangkan baris percakapan hanya menunjuk SATU kontak,
     * jadi atribusi penulis per pesan hidup di sini. NULL di luar grup
     * (privat: pengirimnya ya kontak percakapan itu sendiri).
     */
    senderName: varchar("sender_name", { length: 255 }),
    type: messageTypeEnum("type").notNull().default("text"),
    contentText: text("content_text"),
    mediaId: uuid("media_id").references(() => media.id, { onDelete: "set null" }),
    /** Id pesan di provider; dipakai untuk dedup webhook & rekonsiliasi status. */
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    status: messageStatusEnum("status").notNull().default("received"),
    errorCode: varchar("error_code", { length: 128 }),
    /**
     * Klaim pengiriman (Hotfix analisis 2026-11-03): diisi poller tepat
     * sebelum mengirim lewat `claimOutboundMessage` (UPDATE atomik).
     * Mencegah dua replica API mengirim baris `queued` yang sama tanpa
     * menambah nilai enum status baru — status tetap `queued` sampai
     * provider menjawab, sehingga reconcile broadcast & UI tidak berubah.
     * Klaim yang lebih tua dari OUTBOUND_CLAIM_STALE_MS dianggap basi
     * (proses mati di tengah pengiriman) dan boleh diambil alih poller
     * lain. NULL = belum pernah diklaim.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** User pengirim untuk pesan outbound manual dari inbox (sender_type='user'). */
    sentByUserId: uuid("sent_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * Pesan yang dikutip pesan ini (Fase 7B.5 — reply quote): tautan ke
     * baris `messages` LAIN dalam percakapan yang sama. ID provider dari
     * pesan target TIDAK disalin ke sini — poller menurunkannya saat
     * kirim dari `provider_message_id` baris target (sumber kebenaran
     * tunggal, tidak bisa basi). ON DELETE SET NULL: purge channel
     * (Fase 6I) menghapus baris target tanpa menggagalkan penghapusan
     * dan tanpa menghapus balasan — kutipannya lepas dengan anggun
     * (kolom menjadi NULL, persis perilaku tautan integration_log).
     */
    replyToMessageId: uuid("reply_to_message_id").references(
      (): AnyPgColumn => messages.id,
      { onDelete: "set null" },
    ),
    /**
     * Snapshot kutipan cadangan (Hotfix 7B.6): salinan ringkas isi pesan
     * yang dikutip SEBAGAIMANA dikirim provider di dalam payload webhook
     * (Telegram menyertakan teks + penulis pesan asal pada
     * `reply_to_message`). Diisi saat ingest Telegram SETIAP kali payload
     * membawa pesan yang dikutip — bukan hanya saat tautan gagal — agar
     * kutipan tetap terlihat bila baris target kelak terhapus (tautan di
     * atas menjadi NULL oleh SET NULL, snapshot ini bertahan). Serializer
     * & UI SELALU mendahulukan tautan `replyToMessageId` yang teresolusi;
     * snapshot hanya cadangan tampil. NULL untuk pesan yang tidak
     * mengutip, dan untuk provider yang payload kutipannya hanya membawa
     * id tanpa teks (WhatsApp & Meta — memang tidak bisa di-snapshot).
     */
    replyToSnapshot: jsonb("reply_to_snapshot").$type<{
      authorLabel: string | null;
      contentPreview: string | null;
    }>(),
    /**
     * Sinyal pemicu ketukan tombol (G5, migrasi 0030): diisi parser
     * channel saat pesan masuk ini SEBENARNYA adalah ketukan tombol,
     * bukan ketikan teks:
     * - 'postback'    — Meta messaging postback (payload + title) atau
     *                   Telegram callback_query (payload = data tombol;
     *                   Telegram tidak memisahkan judul, title null).
     * - 'quick_reply' — pesan teks yang membawa payload quick reply
     *                   (Meta message.quick_reply.payload; WhatsApp
     *                   interactive button/list reply id).
     * NULL untuk semua pesan lain. Evaluator automation/flow membaca
     * kolom ini untuk mengklasifikasikan pesan ke kelas pemicu —
     * urutan prioritasnya hidup di packages/core/src/trigger-priority.ts.
     * `contentText` baris yang sama tetap memuat teks yang manusiawi
     * (judul tombol Meta/WA; data payload untuk Telegram) agar inbox
     * menampilkan apa yang diketuk pengguna.
     */
    triggerSignal: jsonb("trigger_signal").$type<MessageTriggerSignal>(),
    /**
     * Muatan template WhatsApp (Fase 10A) untuk pesan keluar bertipe
     * 'template': nama + bahasa template Meta dan parameter BODY yang
     * SUDAH terisi untuk penerima pesan ini. Poller Meta membaca kolom
     * ini untuk memutuskan mengirim `type: "template"` (Cloud API)
     * alih-alih teks bebas; `content_text` baris yang sama menampung
     * render pratinjau BODY dengan parameter terisi (yang dibaca
     * manusia di inbox). NULL untuk semua pesan non-template. Sengaja
     * disimpan di baris pesan (bukan diturunkan poller dari broadcast)
     * agar scan pengiriman lintas tenant tetap satu tabel seperti pola
     * replyToMessageId 7B.5.
     */
    templatePayload: jsonb("template_payload").$type<{
      name: string;
      languageCode: string;
      bodyParams: string[];
      /**
       * Variabel HEADER teks (Fase 17) — maks satu, `{{1}}`. Kosong/absen
       * untuk template tanpa header ber-variabel. Tanpa ini, template
       * ber-header `{{1}}` ditolak Meta meski body-nya sudah lengkap.
       */
      headerParams?: string[];
      /**
       * Variabel tombol URL (Fase 17). `index` = posisi tombol pada array
       * `buttons` template (0-based), persis yang dibaca Meta.
       */
      buttonParams?: Array<{ index: number; text: string }>;
      /**
       * Lampiran header media (Fase 18C) — id baris `media` milik tenant.
       * Poller mengunggahnya ke Meta saat mengirim, karena Cloud API
       * menuntut media id milik Meta, bukan id kita.
       */
      headerMediaId?: string;
    }>(),
    /**
     * Id komentar Meta yang menjadi alamat kirim pesan ini (Fase 10B):
     * DM privat balasan-atas-komentar (private reply) dikirim Send API
     * dengan `recipient: { comment_id }`, BUKAN id pengguna — itulah
     * satu-satunya cara mendahului percakapan dengan penulis komentar
     * yang belum pernah DM. Poller Meta membaca kolom ini: terisi →
     * kirim sebagai private reply; sesudah penulis membalas, percakapan
     * berlanjut normal (identitas kontak sama, alamat provider_chat_id).
     * NULL untuk semua pesan selain DM comment-to-DM pertama.
     */
    providerCommentId: varchar("provider_comment_id", { length: 255 }),
    /**
     * Referensi media MASUK milik provider (Fase 18).
     *
     * Untuk WhatsApp, webhook hanya membawa `image.id` (media id), BUKAN
     * isi berkasnya. Id itu harus ditukar dulu menjadi URL unduhan
     * sementara (valid ±5 menit) lewat `GET /{media-id}`, baru byte-nya
     * bisa diambil dengan header Authorization. Dua alasan id ini
     * disimpan di baris pesan, bukan diunduh saat webhook:
     *   1. unduhan video 16 MB akan menahan ack webhook, dan Meta
     *      MENGIRIM ULANG payload bila ack lambat — unduhan pun diulang;
     *   2. kegagalan jaringan sesaat tidak boleh menghilangkan pesan.
     * Baris pesan tetap tercatat lebih dulu (dengan caption bila ada),
     * lalu ingest media menyusul dan mengisi `media_id`.
     */
    providerMediaId: varchar("provider_media_id", { length: 255 }),
    /** MIME dari provider (`image/jpeg`, `application/pdf`, …); null bila tak disebut. */
    providerMediaMime: varchar("provider_media_mime", { length: 128 }),
    /** Nama berkas asli — hanya WhatsApp document yang menyertakannya. */
    providerMediaFileName: varchar("provider_media_file_name", { length: 255 }),
    /**
     * Penghitung percobaan ingest media (Fase 18). Media yang gagal
     * diunduh SELAMANYA (mis. id kedaluwarsa >30 hari, berkas dihapus
     * pengirim) tidak boleh dipindai tiap tick selamanya: setelah
     * `MEDIA_INGEST_MAX_ATTEMPTS` baris berhenti dipindai dan alasannya
     * tersimpan di `media_ingest_error` untuk dibaca operator.
     */
    mediaIngestAttempts: integer("media_ingest_attempts").notNull().default(0),
    /** Alasan kegagalan ingest terakhir (dipotong 500 char), null bila belum pernah gagal. */
    mediaIngestError: varchar("media_ingest_error", { length: 500 }),
    /**
     * Waktu percobaan ingest terakhir (Fase 18).
     *
     * Tanpa ini, siklus worker 5 detik menghabiskan seluruh jatah
     * percobaan dalam 25 detik: gangguan jaringan semenit membuat media
     * hilang permanen padahal berkasnya masih ada di Meta. Pemindai
     * memakai kolom ini untuk memberi jarak antar-percobaan.
     */
    mediaIngestAttemptedAt: timestamp("media_ingest_attempted_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_tenant_id_idx").on(t.tenantId),
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    index("messages_reply_to_message_id_idx").on(t.replyToMessageId),
    // Hotfix analisis 2026-11-03: index parsial untuk pindai antrean
    // pengiriman lintas tenant (listQueuedMetaDeliveries &
    // listQueuedTelegramDeliveries di core) yang dijalankan poller API
    // tiap ±2 detik dengan filter persis ini + ORDER BY created_at.
    // Tanpa index ini setiap tick = full scan tabel messages terbesar.
    index("messages_outbound_queued_created_idx")
      .on(t.createdAt)
      .where(sql`${t.direction} = 'outbound' AND ${t.status} = 'queued'`),
    uniqueIndex("messages_provider_message_id_unique")
      .on(t.providerMessageId)
      .where(sql`${t.providerMessageId} IS NOT NULL`),
    // Fase 18: pindai ingest media (lintas tenant, dijalankan worker tiap
    // beberapa detik). Predikatnya sengaja hanya "belum ada media_id tetapi
    // punya referensi provider" — batas percobaan TIDAK ikut masuk predikat
    // index karena angkanya konstanta kode (`MEDIA_INGEST_MAX_ATTEMPTS`)
    // yang bisa berubah; menyaringnya di query tetap memakai index ini
    // untuk bagian yang menyeleksi, lalu membuang sedikit baris yang sudah
    // menyerah. Tanpa index, tiap tick = full scan tabel messages.
    index("messages_pending_media_idx")
      .on(t.createdAt)
      .where(
        sql`${t.mediaId} IS NULL AND ${t.providerMediaId} IS NOT NULL`,
      ),
  ],
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

/**
 * Catatan internal percakapan (Fase 9C) — tabel TERPISAH dari `messages`
 * secara sengaja: semua jalur keluar (poller provider, flush webchat,
 * broadcast, agent) hanya membaca `messages`, jadi catatan di sini tidak
 * bisa terkirim ke kontak — bukan difilter, melainkan tidak berada di
 * tabel yang dibaca pengirim. `author_user_id` ON DELETE SET NULL:
 * catatan bertahan walau penulis keluar/terhapus (UI menampilkan label
 * cadangan untuk penulis null).
 */
export const conversationNotes = pgTable(
  "conversation_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conversation_notes_tenant_id_idx").on(t.tenantId),
    index("conversation_notes_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
  ],
);

export type ConversationNote = typeof conversationNotes.$inferSelect;
export type NewConversationNote = typeof conversationNotes.$inferInsert;

/**
 * Catatan internal KONTAK (Gelombang G8) — saudara `conversation_notes`
 * yang menempel pada kontak, bukan percakapan: hal yang perlu diingat
 * tim tentang ORANGNYA (lintas semua percakapan & kanal), bukan tentang
 * satu utas. Tabelnya sendiri dengan alasan yang sama seperti 9C —
 * tidak ada jalur pengiriman yang membaca tabel ini, jadi catatan tidak
 * bisa terkirim ke kontak. `author_user_id` ON DELETE SET NULL seperti
 * catatan percakapan (penulis yatim hanya bisa dihapus owner/admin).
 * Keduanya SENGAJA tidak dicampur: catatan kontak tidak tampil di
 * daftar catatan percakapan dan sebaliknya; linimasa kontak hanya
 * mencatat PERISTIWA "catatan ditambahkan" dari keduanya sebagai dua
 * jenis peristiwa yang berbeda label.
 */
export const contactNotes = pgTable(
  "contact_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contact_notes_tenant_id_idx").on(t.tenantId),
    index("contact_notes_contact_created_idx").on(t.contactId, t.createdAt),
  ],
);

export type ContactNote = typeof contactNotes.$inferSelect;
export type NewContactNote = typeof contactNotes.$inferInsert;
export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    provider: channelProviderEnum("provider").notNull(),
    /** Id user di provider untuk akun channel ini (PSID/IGSID/wa_id/chat_id/...). */
    externalUserId: varchar("external_user_id", { length: 255 }).notNull(),
    username: varchar("username", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_identities_account_external_user_unique").on(
      t.channelAccountId,
      t.externalUserId,
    ),
    index("channel_identities_tenant_id_idx").on(t.tenantId),
    index("channel_identities_contact_id_idx").on(t.contactId),
  ],
);

export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type NewChannelIdentity = typeof channelIdentities.$inferInsert;
