import {
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
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./identity";
import { channelAccounts } from "./channels";
import { conversations, media } from "./inbox";

/**
 * Content Schedule (Fase 23) — menjadwalkan POSTINGAN ke linimasa channel,
 * bukan pesan ke kontak.
 *
 * Kenapa tabel sendiri, bukan menumpang `broadcasts`:
 * - broadcast punya PENERIMA. Baris `broadcast_recipients` dimaterialisasi
 *   per kontak, dan statistiknya "terkirim/dibaca". Postingan channel tidak
 *   punya penerima sama sekali — ia satu baris di linimasa publik, dan
 *   metriknya jangkauan, bukan status per orang.
 * - Satu tabel untuk keduanya akan berakhir dengan separuh kolom NULL dan
 *   dua arti berbeda pada kolom `status` yang sama.
 *
 * Model:
 * - `posts`      : satu baris per postingan. Sasaran = SATU percakapan
 *                  `kind='channel'` (Fase 6A.2 sudah membuat percakapan
 *                  per channel Telegram beserta `provider_chat_id`-nya),
 *                  jadi tidak ada kolom alamat chat duplikat di sini.
 * - `post_media` : lampiran berurutan (album). Media-nya baris `media`
 *                  yang sudah diunggah lewat jalur unggah yang ada —
 *                  `media-gc` WAJIB tahu rujukan ini, kalau tidak aset
 *                  postingan terjadwal dihapus sebelum jam tayangnya.
 *
 * Status (lihat postStatusEnum): draft → scheduled → publishing →
 * published | failed, dan cancelled dari draft/scheduled. `publishing`
 * adalah klaim atomik: satu-satunya keadaan yang boleh mengirim.
 */

export const postStatusEnum = pgEnum("post_status", [
  "draft",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
]);

/**
 * Cermin struktural `PostPublishOptions` (packages/contracts) untuk
 * kolom `posts.publish_options` — lihat komentar kolomnya. Semua
 * field opsional: kelengkapan yang diwajibkan platform ditegakkan
 * core saat penjadwalan, bukan oleh tipe ini.
 */
export interface PostPublishOptionsRecord {
  youtubePrivacyStatus?: "private" | "unlisted" | "public";
  tiktokPrivacyLevel?:
    | "PUBLIC_TO_EVERYONE"
    | "MUTUAL_FOLLOW_FRIENDS"
    | "FOLLOWER_OF_CREATOR"
    | "SELF_ONLY";
  aiGenerated?: boolean;
  madeForKids?: boolean;
  tiktokAllowComment?: boolean;
  tiktokAllowDuet?: boolean;
  tiktokAllowStitch?: boolean;
  tiktokBrandOrganic?: boolean;
  tiktokBrandContent?: boolean;
}

/**
 * Grup multi-target (migrasi 0013, Gelombang 0 butir 3): satu konten
 * induk yang diterbitkan ke N sasaran sekaligus.
 *
 * Kenapa grup adalah tabel PENGGELOMPOK, bukan kolom target jamak di
 * `posts`: state machine dan klaim atomik publikasi hidup per baris
 * `posts` (satu baris = satu linimasa = satu status). Grup hanya
 * menamai kebersamaan mereka — anggota dibuat bersama, tetapi terjadwal,
 * terbit, dan gagal secara independen per platform, karena memang
 * begitulah kenyataan di provider. Menghapus grup TIDAK menghapus
 * anggota (`group_id` di-null-kan): riwayat terbit tidak boleh hilang
 * karena labelnya dicabut.
 */
export const postGroups = pgTable("post_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** Judul internal konten induk; disalin ke tiap post anggota. */
  title: varchar("title", { length: 255 }).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * Grup multi-target pemilik baris ini (migrasi 0013); NULL = post
     * tunggal. `set null`, bukan cascade — lihat komentar postGroups.
     */
    groupId: uuid("group_id").references(() => postGroups.id, {
      onDelete: "set null",
    }),
    /** Akun bot pengirim (Telegram dulu; provider lain menyusul). */
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    /**
     * Sasaran: percakapan `kind='channel'`. Alamat kirim diambil dari
     * `conversations.provider_chat_id` saat publikasi — satu sumber
     * kebenaran, bukan salinan yang bisa menyimpang.
     */
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Judul internal untuk kalender; TIDAK dikirim ke channel. */
    title: varchar("title", { length: 255 }).notNull(),
    /**
     * Teks postingan (caption). Kosong diperbolehkan HANYA bila ada media —
     * divalidasi di core saat penjadwalan, bukan di sini, karena aturannya
     * milik provider (Telegram menolak pesan kosong tanpa media).
     */
    caption: text("caption").notNull().default(""),
    status: postStatusEnum("status").notNull().default("draft"),
    /** Jam tayang; NULL selama draft. */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** message_id dari provider sesudah terbit (Telegram: numerik sebagai string). */
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    /**
     * Kode error aman saat `failed` (mis. `telegram_http_400`). Tidak pernah
     * memuat token atau URL bertoken.
     */
    errorCode: varchar("error_code", { length: 128 }),
    /**
     * Opsi penerbitan per target (migrasi 0026): pilihan PENGGUNA pada
     * formulir postingan — privasi + pengungkapan AI + field resmi
     * per platform. Bentuk sahnya adalah `PostPublishOptions` pada
     * kontrak; paket db tidak bergantung pada kontrak, jadi di sini
     * ia tipe struktural cermin — validasi & pembersihannya di core
     * (PostPublishOptionsSchema), bukan di lapisan skema. NULL =
     * belum dipilih (resolusi publish jatuh ke bawaan platform).
     */
    publishOptions: jsonb("publish_options").$type<PostPublishOptionsRecord>(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Daftar & kalender: satu workspace, urut jam tayang.
    index("posts_tenant_scheduled_idx").on(t.tenantId, t.scheduledAt),
    // Saringan status di daftar (draft/scheduled/...).
    index("posts_tenant_status_idx").on(t.tenantId, t.status),
    // Sasaran per channel (dipakai saat disconnect: apa yang masih terjadwal).
    index("posts_conversation_idx").on(t.conversationId),
    // Anggota satu grup dibaca bersama (kartu grup di kalender).
    index("posts_group_idx").on(t.groupId),
  ],
);

export const postMedia = pgTable(
  "post_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      // RESTRICT, bukan CASCADE: kalau `media-gc` suatu saat salah menghitung
      // rujukan, penghapusan HARUS gagal berisik di sini — bukan diam-diam
      // mengosongkan lampiran sebuah postingan yang sudah terjadwal.
      .references(() => media.id, { onDelete: "restrict" }),
    /** Urutan album; 0 = lampiran pertama. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("post_media_post_position_unique").on(t.postId, t.position),
    // `media-gc` memeriksa rujukan per media id — tanpa index ini sapuan
    // menjadi pemindaian penuh tabel untuk setiap kandidat.
    index("post_media_media_id_idx").on(t.mediaId),
    index("post_media_tenant_id_idx").on(t.tenantId),
  ],
);

export type PostGroup = typeof postGroups.$inferSelect;
export type NewPostGroup = typeof postGroups.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type PostMedia = typeof postMedia.$inferSelect;
export type PostStatus = Post["status"];
