import {
  index,
  integer,
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

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
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

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type PostMedia = typeof postMedia.$inferSelect;
export type PostStatus = Post["status"];
