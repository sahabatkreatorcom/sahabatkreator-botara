import {
  boolean,
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
 * Keadaan persetujuan postingan (Fase Susulan S1, migrasi 0046).
 *
 * Mesin statusnya terpisah dari `post_status` dengan sengaja: status
 * publikasi menjawab "sudah tayang atau belum", status persetujuan
 * menjawab "sudah boleh tayang atau belum". Nilai:
 * - `draft`             : belum diajukan (keadaan awal; juga hasil
 *                         reset saat isi postingan disunting).
 * - `pending_review`    : diajukan, menunggu keputusan peninjau.
 * - `approved`          : disetujui — satu-satunya keadaan yang boleh
 *                         melewati gerbang penerbitan saat tenant
 *                         mengaktifkan persetujuan wajib.
 * - `rejected`          : ditolak; `approval_note` wajib terisi.
 * - `changes_requested` : diminta revisi; catatan wajib terisi.
 *
 * Keadaan hidup per baris `posts`, tetapi transisi di core selalu
 * bekerja pada UNIT grup multi-target (satu keputusan per konten
 * induk) — lihat komentar kolom `tenants.postApprovalRequired`.
 */
export const postApprovalStatusEnum = pgEnum("post_approval_status", [
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "changes_requested",
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
  pinterestBoardId?: string;
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
    /**
     * Persetujuan (Fase Susulan S1, migrasi 0046). Kolom-kolom ini
     * hanya MAKNA bila tenant mengaktifkan `post_approval_required`;
     * bila tidak, semuanya tetap pada keadaan awal dan tidak dibaca
     * gerbang mana pun. `approval_note` = catatan keputusan terakhir
     * (penolakan / minta revisi) — tampil ke pembuat; riwayat
     * keputusan lengkap hidup di `audit_logs`, bukan disalin ke sini.
     */
    approvalStatus: postApprovalStatusEnum("approval_status")
      .notNull()
      .default("draft"),
    approvalNote: text("approval_note"),
    approvalSubmittedByUserId: uuid("approval_submitted_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    approvalSubmittedAt: timestamp("approval_submitted_at", {
      withTimezone: true,
    }),
    approvalReviewedByUserId: uuid("approval_reviewed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    approvalReviewedAt: timestamp("approval_reviewed_at", {
      withTimezone: true,
    }),
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
    // Antrean tinjauan: saringan daftar per status persetujuan (S1).
    index("posts_tenant_approval_idx").on(t.tenantId, t.approvalStatus),
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
export type PostApprovalStatus = Post["approvalStatus"];

// ---------------------------------------------------------------------------
// Jadwal postingan berulang + antrean rutin (Fase Susulan S2, migrasi 0047)
//
// Dua mekanisme keteraturan PENERBITAN KONTEN, keduanya lapisan
// penjadwal DI ATAS state machine postingan yang ada — bukan mesin
// penerbit kedua, dan BUKAN broadcast berulang G9 (itu keteraturan
// SIARAN ke penerima; di sini tidak ada penerima sama sekali):
//
// - `post_recurrence_rules` + `post_recurrence_occurrences`: aturan
//   menyimpan SNAPSHOT templat postingan (judul, caption, media,
//   himpunan sasaran — bentuk yang sama seperti pembuatan grup
//   komposer) + pola pengulangan yang kolomnya meniru aturan G9
//   karena matematikanya memang dibagi (core/recurrence-pattern).
//   Penyapu worker mematerialisasi tiap slot menjadi postingan
//   terjadwal NYATA lewat jalur pembuatan + penjadwalan yang ada
//   (createPost/createPostGroup → schedulePost → outbox
//   post.publish_due). Ledger per (aturan, slot) adalah kunci
//   idempotensi materialisasi.
// - `post_queue_items` + `post_queue_slots` +
//   `post_queue_slot_firings`: antrean konten berurutan milik tenant
//   + slot rutin mingguan (hari aktif + jam dinding per himpunan
//   sasaran). Saat slot menembak, item antrean TERATAS ditarik
//   menjadi postingan terjadwal pada slot itu; antrean kosong
//   tercatat sebagai firing `empty` — tidak ada postingan karangan.
//   Item yang tertarik keluar dari antrean (status `pulled`) dengan
//   tautan ke postingan hasilnya, jadi riwayatnya tidak hilang.
//
// Postingan hasil kedua mekanisme lahir dengan `approval_status`
// bawaan `draft`: interaksi dengan persetujuan S1 apa adanya —
// gerbang penerbitan worker yang memutuskan di jam tayang, tanpa
// jalur pintas apa pun di lapisan ini.
// ---------------------------------------------------------------------------

/**
 * Satu sasaran pada snapshot templat — cermin struktural target
 * pembuatan grup komposer (`CreatePostGroupRequest.targets`):
 * caption per sasaran adalah override opsional di atas caption
 * induk, dan opsi penerbitan memang melekat per sasaran.
 */
export interface PostRecurrenceTargetRecord {
  conversationId: string;
  caption?: string;
  publishOptions?: PostPublishOptionsRecord;
}

export const postRecurrenceFrequencyEnum = pgEnum(
  "post_recurrence_frequency",
  ["daily", "weekly", "monthly"],
);

export const postRecurrenceStatusEnum = pgEnum("post_recurrence_status", [
  "active",
  "paused",
  "completed",
  "cancelled",
]);

export const postRecurrenceOccurrenceStatusEnum = pgEnum(
  "post_recurrence_occurrence_status",
  ["claimed", "created", "skipped", "missed"],
);

export const postRecurrenceRules = pgTable(
  "post_recurrence_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Nama aturan (tampil di daftar); postingan anak dinamai dari `title`. */
    name: varchar("name", { length: 255 }).notNull(),
    /**
     * Postingan asal templat disalin (provenance). SET NULL: aturan
     * adalah snapshot — menghapus sumber tidak menghapus jadwal.
     */
    sourcePostId: uuid("source_post_id").references(() => posts.id, {
      onDelete: "set null",
    }),
    /** Judul internal konten (sama seperti kolom `posts.title`). */
    title: varchar("title", { length: 255 }).notNull(),
    /** Caption induk; override per sasaran ada di `targets`. */
    caption: text("caption").notNull().default(""),
    /**
     * Media bersama templat (id baris `media`, urutan = urutan album).
     * Rujukan jsonb ini WAJIB dihitung media-gc selama aturan belum
     * terminal — tanpa itu aset templat bisa terhapus sebelum slotnya.
     */
    mediaIds: jsonb("media_ids").notNull().default([]).$type<string[]>(),
    /** Himpunan sasaran templat (bentuk target grup komposer). */
    targets: jsonb("targets")
      .notNull()
      .default([])
      .$type<PostRecurrenceTargetRecord[]>(),
    frequency: postRecurrenceFrequencyEnum("frequency").notNull(),
    /** Setiap N (hari/minggu/bulan sesuai frequency). */
    interval: integer("interval").notNull().default(1),
    /**
     * Hari aktif mingguan (0=Minggu..6=Sabtu); hanya bermakna untuk
     * frequency 'weekly'. Kosong = hari yang sama dengan starts_at.
     */
    daysOfWeek: jsonb("days_of_week").notNull().default([]).$type<number[]>(),
    /**
     * Tanggal bulanan (1..31); hanya bermakna untuk 'monthly'.
     * Tanggal melampaui akhir bulan dijepit ke hari terakhir bulan
     * itu. NULL (dan last_day_of_month false) = tanggal starts_at.
     */
    dayOfMonth: integer("day_of_month"),
    /** Monthly: slot selalu di hari terakhir bulan. */
    lastDayOfMonth: boolean("last_day_of_month").notNull().default(false),
    /** Zona waktu IANA aturan — semua perhitungan slot dalam zona ini. */
    timezone: varchar("timezone", { length: 64 }).notNull(),
    /** Jangkar: slot pertama; jam dindingnya (di timezone) dipakai semua slot. */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** Slot terakhir yang masih boleh lahir (inklusif); NULL = tanpa batas tanggal. */
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** Batas jumlah kejadian yang dibuat; NULL = tanpa batas jumlah. */
    maxOccurrences: integer("max_occurrences"),
    /** Jumlah kejadian yang sudah benar-benar dibuat (ledger 'created'). */
    occurrencesCreated: integer("occurrences_created").notNull().default(0),
    status: postRecurrenceStatusEnum("status").notNull().default("active"),
    /** Slot berikutnya yang belum diproses; NULL bila aturan terminal. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
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
    index("post_recurrence_rules_tenant_id_idx").on(t.tenantId),
    index("post_recurrence_rules_tenant_status_idx").on(t.tenantId, t.status),
    // Indeks pemindaian penyapu: aturan jatuh tempo lintas tenant.
    index("post_recurrence_rules_due_idx").on(t.nextRunAt),
  ],
);

export const postRecurrenceOccurrences = pgTable(
  "post_recurrence_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => postRecurrenceRules.id, { onDelete: "cascade" }),
    /** Instan slot (UTC) — bersama rule_id membentuk kunci idempotensi. */
    slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
    status: postRecurrenceOccurrenceStatusEnum("status").notNull(),
    /**
     * Alasan untuk skipped/missed: 'rule_paused' | 'slot_expired' |
     * 'claim_stale' | kode PostDomainError gerbang buat/jadwalkan
     * (mis. 'POST_TARGET_NOT_CONNECTED'). NULL untuk created/claimed.
     */
    reason: varchar("reason", { length: 64 }),
    /** Grup postingan anak yang lahir dari slot ini (hanya status created). */
    postGroupId: uuid("post_group_id").references(() => postGroups.id, {
      onDelete: "set null",
    }),
    /** Id semua postingan anak slot ini (satu untuk aturan satu sasaran). */
    postIds: jsonb("post_ids").notNull().default([]).$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("post_recurrence_occurrences_rule_slot_unique").on(
      t.ruleId,
      t.slotAt,
    ),
    index("post_recurrence_occurrences_tenant_id_idx").on(t.tenantId),
    index("post_recurrence_occurrences_rule_slot_idx").on(t.ruleId, t.slotAt),
  ],
);

export const postQueueItemStatusEnum = pgEnum("post_queue_item_status", [
  "queued",
  "pulled",
]);

export const postQueueItems = pgTable(
  "post_queue_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Urutan dalam antrean (kecil = lebih dulu ditarik). */
    position: integer("position").notNull(),
    /** Judul internal konten (sama seperti kolom `posts.title`). */
    title: varchar("title", { length: 255 }).notNull(),
    caption: text("caption").notNull().default(""),
    /** Media item (id baris `media`, urutan = urutan album). */
    mediaIds: jsonb("media_ids").notNull().default([]).$type<string[]>(),
    status: postQueueItemStatusEnum("status").notNull().default("queued"),
    /**
     * Reservasi penarikan: firing slot yang sedang mematerialisasi
     * item ini. Diisi dalam transaksi klaim yang sama dengan klaim
     * firing agar dua slot bersamaan tidak menarik item yang sama;
     * dibersihkan saat firing final (berhasil → status `pulled`,
     * gagal → item kembali murni `queued`). UUID polos tanpa FK:
     * baris firing menunjuk balik ke item (`queue_item_id`), jadi
     * FK dua arah hanya akan menyulitkan urutan migrasi — integritas
     * dijaga transaksi klaim/finalisasi di core.
     */
    reservedFiringId: uuid("reserved_firing_id"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }),
    /** Kapan item tertarik keluar dari antrean (status `pulled`). */
    pulledAt: timestamp("pulled_at", { withTimezone: true }),
    /** Grup postingan hasil penarikan; SET NULL agar riwayat antrean bertahan. */
    pulledPostGroupId: uuid("pulled_post_group_id").references(
      () => postGroups.id,
      { onDelete: "set null" },
    ),
    /** Id semua postingan hasil penarikan item ini. */
    pulledPostIds: jsonb("pulled_post_ids")
      .notNull()
      .default([])
      .$type<string[]>(),
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
    // Penarikan teratas + daftar antrean: satu pemindaian terurut.
    index("post_queue_items_tenant_status_position_idx").on(
      t.tenantId,
      t.status,
      t.position,
    ),
    index("post_queue_items_tenant_id_idx").on(t.tenantId),
  ],
);

export const postQueueSlotStatusEnum = pgEnum("post_queue_slot_status", [
  "active",
  "paused",
  "cancelled",
]);

export const postQueueSlots = pgTable(
  "post_queue_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Nama slot (mis. "Pagi — kanal utama"). */
    name: varchar("name", { length: 255 }).notNull(),
    /** Himpunan sasaran slot (bentuk target yang sama seperti aturan). */
    targets: jsonb("targets")
      .notNull()
      .default([])
      .$type<PostRecurrenceTargetRecord[]>(),
    /** Hari aktif mingguan (0=Minggu..6=Sabtu); wajib non-kosong untuk slot. */
    daysOfWeek: jsonb("days_of_week").notNull().default([]).$type<number[]>(),
    /** Zona waktu IANA slot. */
    timezone: varchar("timezone", { length: 64 }).notNull(),
    /**
     * Jangkar pola mingguan bersama: instan tembakan pertama —
     * jam dindingnya (di `timezone`) adalah jam slot untuk semua
     * tembakan berikutnya. Jam slot diturunkan dari kolom ini,
     * bukan disimpan dua kali.
     */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    status: postQueueSlotStatusEnum("status").notNull().default("active"),
    /** Tembakan berikutnya yang belum diproses; NULL bila slot terminal (cancelled). */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
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
    index("post_queue_slots_tenant_id_idx").on(t.tenantId),
    index("post_queue_slots_tenant_status_idx").on(t.tenantId, t.status),
    index("post_queue_slots_due_idx").on(t.nextRunAt),
  ],
);

export const postQueueSlotFiringStatusEnum = pgEnum(
  "post_queue_slot_firing_status",
  ["claimed", "pulled", "empty", "skipped", "missed"],
);

export const postQueueSlotFirings = pgTable(
  "post_queue_slot_firings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => postQueueSlots.id, { onDelete: "cascade" }),
    /** Instan tembakan (UTC) — bersama slot_id membentuk kunci idempotensi. */
    slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
    status: postQueueSlotFiringStatusEnum("status").notNull(),
    /**
     * Alasan untuk skipped/missed: 'slot_paused' | 'slot_expired' |
     * 'claim_stale' | kode PostDomainError gerbang buat/jadwalkan.
     * NULL untuk pulled/empty/claimed.
     */
    reason: varchar("reason", { length: 64 }),
    /** Item antrean yang ditarik tembakan ini (hanya status pulled). */
    queueItemId: uuid("queue_item_id").references(() => postQueueItems.id, {
      onDelete: "set null",
    }),
    /** Grup postingan hasil penarikan (hanya status pulled). */
    postGroupId: uuid("post_group_id").references(() => postGroups.id, {
      onDelete: "set null",
    }),
    /** Id semua postingan hasil penarikan tembakan ini. */
    postIds: jsonb("post_ids").notNull().default([]).$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("post_queue_slot_firings_slot_slot_unique").on(
      t.slotId,
      t.slotAt,
    ),
    index("post_queue_slot_firings_tenant_id_idx").on(t.tenantId),
    index("post_queue_slot_firings_slot_slot_idx").on(t.slotId, t.slotAt),
  ],
);

export type PostRecurrenceRule = typeof postRecurrenceRules.$inferSelect;
export type NewPostRecurrenceRule = typeof postRecurrenceRules.$inferInsert;
export type PostRecurrenceOccurrence =
  typeof postRecurrenceOccurrences.$inferSelect;
export type NewPostRecurrenceOccurrence =
  typeof postRecurrenceOccurrences.$inferInsert;
export type PostRecurrenceFrequency = PostRecurrenceRule["frequency"];
export type PostRecurrenceStatus = PostRecurrenceRule["status"];
export type PostRecurrenceOccurrenceStatus =
  PostRecurrenceOccurrence["status"];
export type PostQueueItem = typeof postQueueItems.$inferSelect;
export type NewPostQueueItem = typeof postQueueItems.$inferInsert;
export type PostQueueItemStatus = PostQueueItem["status"];
export type PostQueueSlot = typeof postQueueSlots.$inferSelect;
export type NewPostQueueSlot = typeof postQueueSlots.$inferInsert;
export type PostQueueSlotStatus = PostQueueSlot["status"];
export type PostQueueSlotFiring = typeof postQueueSlotFirings.$inferSelect;
export type NewPostQueueSlotFiring = typeof postQueueSlotFirings.$inferInsert;
export type PostQueueSlotFiringStatus = PostQueueSlotFiring["status"];

/**
 * Keadaan satu penarikan metrik postingan (Fase Susulan S3):
 * - `ok`          : API platform mengembalikan angka; `metrics` terisi
 *                   (hanya kunci yang benar-benar dilaporkan).
 * - `unavailable` : platform memang tidak menawarkan metrik postingan
 *                   organik lewat API resmi (Telegram, Google
 *                   Business) — terminal, ditulis sekali per postingan.
 * - `failed`      : penarikan dicoba dan gagal (izin/scope belum ada,
 *                   token bermasalah, provider menolak); `reason`
 *                   membawa kode persisnya dan penyapu mencoba lagi
 *                   sesudah jeda yang lebih panjang.
 */
export const postMetricSnapshotStatusEnum = pgEnum(
  "post_metric_snapshot_status",
  ["ok", "unavailable", "failed"],
);

/**
 * Snapshot DERET WAKTU metrik satu target postingan (Fase Susulan S3,
 * migrasi 0048). Satu baris `posts` = satu sasaran = satu postingan
 * platform, dan tiap penarikan penyapu worker MENAMBAH satu baris di
 * sini — tidak pernah menimpa — supaya tren bisa dirakit dari
 * riwayat, bukan dari satu angka terakhir saja.
 *
 * - `provider` didenormalisasi dari percakapan sasaran saat
 *   penarikan: agregat per platform tidak perlu join, dan riwayat
 *   tetap benar walau percakapan berubah sesudahnya.
 * - `metrics` jsonb bentuk `PostMetricValues` kontrak: kunci metrik
 *   ternormalisasi → hitungan kumulatif platform. NULL kecuali
 *   status `ok`. Kunci yang tidak dilaporkan platform ABSEN dari
 *   objek — bukan 0 (0 karangan dilarang di seluruh gelombang ini).
 * - `reason` varchar 128 cermin `posts.error_code`: kode aman tanpa
 *   token/URL. Pada status `ok` boleh terisi sebagai catatan parsial
 *   (mis. tayangan Facebook tak terbaca tanpa izin insights).
 */
export const postMetricSnapshots = pgTable(
  "post_metric_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    /** Provider sasaran saat penarikan (varchar — cermin conversations.provider). */
    provider: varchar("provider", { length: 32 }).notNull(),
    status: postMetricSnapshotStatusEnum("status").notNull(),
    reason: varchar("reason", { length: 128 }),
    metrics: jsonb("metrics").$type<Record<string, number>>(),
    /** Stempel penarikan; deret waktu diurutkan kolom ini. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("post_metric_snapshots_tenant_id_idx").on(t.tenantId),
    // Snapshot terbaru per postingan + riwayat satu postingan.
    index("post_metric_snapshots_post_fetched_idx").on(
      t.postId,
      t.fetchedAt,
    ),
    // Agregat per platform pada jendela waktu.
    index("post_metric_snapshots_tenant_provider_fetched_idx").on(
      t.tenantId,
      t.provider,
      t.fetchedAt,
    ),
  ],
);

export type PostMetricSnapshot = typeof postMetricSnapshots.$inferSelect;
export type NewPostMetricSnapshot = typeof postMetricSnapshots.$inferInsert;
export type PostMetricSnapshotStatus = PostMetricSnapshot["status"];
