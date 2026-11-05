import {
  index,
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
import { channelAccounts } from "./channels";
import { contacts, conversations } from "./inbox";
import { automations } from "./automations";

/**
 * Komentar publik Instagram & Messenger (Fase 10B) — buku besar
 * komentar yang masuk lewat webhook Meta (`changes` field `comments`
 * pada objek instagram; field `feed` item `comment` pada objek page):
 * - Satu baris per komentar provider. Index unik
 *   (channel_account_id, provider_comment_id) adalah penjaga dedup:
 *   pengiriman ulang webhook Meta (dan replay log integrasi Fase 7B.2)
 *   menabrak index yang sama dan TIDAK menghasilkan baris atau aksi
 *   kedua — evaluasi aturan hanya berjalan untuk baris yang benar-benar
 *   baru (event outbox `comment.received` hanya ditulis saat insert
 *   berhasil di core).
 * - `moderation_status` mencerminkan keadaan terakhir yang kita tahu:
 *   'visible' saat lahir; 'hidden' sesudah aksi sembunyikan (aturan
 *   comment-to-DM atau moderasi manual dashboard) berhasil di Graph.
 * - `contact_id`/`conversation_id` terisi bila penulis sudah dikenal
 *   (identitas channel yang sama) saat komentar tiba, atau saat aksi DM
 *   sebuah aturan membuat/menemukan kontak + percakapannya. DM balasan
 *   aturan hidup sebagai baris `messages` biasa di percakapan itu
 *   (dengan `messages.provider_comment_id` terisi) — jadi riwayat
 *   percakapan tidak terbelah dan pesan masuk berikutnya dari orang
 *   yang sama mendarat di percakapan yang sama.
 * - `matched_automation_id` + `actions` (jsonb) adalah jejak evaluasi:
 *   aturan yang cocok dan hasil tiap aksinya
 *   ({ dm?: {status, messageId?, reason?},
 *      publicReply?: {status, replyId?, errorCode?},
 *      hide?: {status, errorCode?},
 *      skipped?: 'own_comment', evaluatedAt?: string }).
 *   Daftar komentar dashboard membaca tabel ini + audit `comment.*`.
 * Semua tenant-scoped: tenant_id + index, dilindungi RLS (migrasi 0037).
 */

export const commentModerationStatusEnum = pgEnum(
  "comment_moderation_status",
  ["visible", "hidden"],
);

export interface CommentActions {
  /** DM privat terkirim sebagai pesan `queued` (poller yang mengirim). */
  dm?: {
    status: "queued" | "skipped" | "failed";
    messageId?: string;
    reason?: string;
  };
  /** Balasan publik pada komentar (Graph, dieksekusi worker). */
  publicReply?: {
    status: "sent" | "failed";
    replyId?: string | null;
    errorCode?: string;
  };
  /** Sembunyikan komentar (Graph, dieksekusi worker / route manual). */
  hide?: { status: "hidden" | "failed"; errorCode?: string };
  /** Evaluasi dilewati: komentar ditulis akun itu sendiri (anti-loop). */
  skipped?: "own_comment";
  /** Cap waktu ISO selesainya evaluasi (penanda idempotensi job). */
  evaluatedAt?: string;
}

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Akun IG/Page pemilik komentar (entry.id webhook). */
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    /** 'instagram' | 'messenger' — denormalisasi dari akun, sejajar conversations.provider. */
    provider: varchar("provider", { length: 32 }).notNull(),
    /** Id komentar di Meta (value.id / value.comment_id) — kunci dedup bersama akun. */
    providerCommentId: varchar("provider_comment_id", { length: 255 }).notNull(),
    /** Id media IG yang dikomentari (value.media.id); null untuk Page. */
    mediaId: varchar("media_id", { length: 255 }),
    /** Id postingan Page yang dikomentari (value.post_id); null untuk IG. */
    postId: varchar("post_id", { length: 255 }),
    /** Id komentar induk bila komentar ini balasan atas komentar lain. */
    parentId: varchar("parent_id", { length: 255 }),
    /** IGSID (instagram) / PSID (messenger) penulis komentar. */
    authorExternalId: varchar("author_external_id", { length: 255 }).notNull(),
    /**
     * Label penulis dari payload: username IG, atau nama Page/orang
     * untuk Messenger (payload feed hanya membawa `from.name`). Murni
     * label tampilan + sumber {name} cadangan; identitas tetap id.
     */
    authorUsername: varchar("author_username", { length: 255 }),
    text: text("text").notNull(),
    /** Waktu komentar menurut provider (created_time payload), bila ada. */
    providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
    moderationStatus: commentModerationStatusEnum("moderation_status")
      .notNull()
      .default("visible"),
    /** Kontak penulis bila dikenal/ dibuat aksi DM; null selain itu. */
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /** Percakapan DM penulis pada akun ini, bila ada. */
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    /** Aturan comment yang cocok saat evaluasi; null = tidak ada yang cocok. */
    matchedAutomationId: uuid("matched_automation_id").references(
      () => automations.id,
      { onDelete: "set null" },
    ),
    /** Jejak hasil evaluasi per aksi (lihat CommentActions). */
    actions: jsonb("actions").$type<CommentActions>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("comments_tenant_id_idx").on(t.tenantId),
    index("comments_tenant_account_created_idx").on(
      t.tenantId,
      t.channelAccountId,
      t.createdAt,
    ),
    index("comments_tenant_automation_idx").on(t.tenantId, t.matchedAutomationId),
    index("comments_contact_id_idx").on(t.contactId),
    index("comments_conversation_id_idx").on(t.conversationId),
    uniqueIndex("comments_account_provider_comment_unique").on(
      t.channelAccountId,
      t.providerCommentId,
    ),
  ],
);

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
