import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./identity";
import { channelAccounts } from "./channels";
import { contacts, conversations, messages } from "./inbox";
import { whatsappTemplates } from "./whatsapp-templates";

/**
 * Kelompok Campaign (Fase 7C — Broadcasts v1):
 * - broadcasts           : satu kampanye siaran teks ke audiens kontak pada
 *                          SATU akun channel (telegram/messenger/instagram
 *                          di v1; WhatsApp menunggu manajemen template,
 *                          webchat tidak punya semantik push).
 * - broadcast_recipients : baris per penerima, dimaterialisasi SAAT
 *                          dispatch oleh worker (bukan saat dibuat) —
 *                          sumber kebenaran statistik broadcast. Statusnya
 *                          mengikuti status pesan keluarnya (disinkronkan
 *                          worker), kecuali terminal lokal: skipped
 *                          (opt-out / di luar jendela 24 jam Meta) dan
 *                          cancelled (pesan queued-nya dihapus).
 * Semua tabel tenant-scoped: tenant_id + index, dilindungi RLS
 * (migrasi 0030).
 */

export const broadcastStatusEnum = pgEnum("broadcast_status", [
  "draft",
  "scheduled",
  "sending",
  "completed",
  "partially_failed",
  "failed",
  "cancelled",
]);

export const broadcastRecipientStatusEnum = pgEnum(
  "broadcast_recipient_status",
  [
    "queued",
    "sent",
    "delivered",
    "read",
    "failed",
    "skipped",
    "cancelled",
  ],
);

export const broadcasts = pgTable(
  "broadcasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    /** Judul internal kampanye (tidak dikirim ke penerima). */
    name: varchar("name", { length: 255 }).notNull(),
    /** Isi pesan teks; placeholder {name} disubstitusi per penerima. Untuk broadcast WhatsApp kolom ini menampung teks BODY template (snapshot saat dibuat). */
    messageText: varchar("message_text", { length: 4096 }).notNull(),
    /**
     * Template WhatsApp resmi untuk broadcast provider whatsapp
     * (Fase 10A): wajib terisi (dan berstatus APPROVED) untuk channel
     * WhatsApp; NULL untuk provider lain. SET NULL: template yang
     * dihapus dari cermin membuat broadcast-nya kembali wajib memilih
     * template (jadwal/dispatch menolak dengan kode template).
     */
    whatsappTemplateId: uuid("whatsapp_template_id").references(
      () => whatsappTemplates.id,
      { onDelete: "set null" },
    ),
    /**
     * Sumber nilai variabel BODY template per posisi (Fase 10A):
     * array sepanjang variable_count template; entri "name" = nama
     * kontak, entri lain = kunci `contacts.custom_fields` penerima.
     * Posisi tanpa sumber (array lebih pendek) membuat penerima
     * di-skip `template_variable_missing` saat dispatch — kecuali
     * posisi 1 yang jatuh kembali ke "name".
     */
    templateVariableSources: jsonb("template_variable_sources")
      .notNull()
      .default([])
      .$type<string[]>(),
    /**
     * Filter audiens: { audience?: "all"|"tag"|"segment", tags?,
     * stages?, segmentId? } — mode "tag": kontak cocok bila punya
     * SALAH SATU tag terdaftar (OR dalam kelompok tag) DAN stage-nya
     * termasuk salah satu stage terdaftar; kedua kelompok digabung
     * AND. Mode "segment" (Fase 13C): keanggotaan ditentukan evaluator
     * segmen tunggal di core. Baris lama tanpa `audience` diturunkan
     * modenya dari isi filter (segmentId → segment; tags/stages
     * non-kosong → tag; selain itu all) — regresi nol.
     */
    audienceFilter: jsonb("audience_filter").notNull().default({}),
    /**
     * Gerbang opt-in (Fase 13C): TRUE = hanya kontak berstatus opt-in
     * EFEKTIF ("opted_in") yang dikirimi; yang belum opt-in dicatat
     * sebagai penerima `skipped` beralasan `not_opted_in` saat
     * dispatch. Bawaan dihitung core saat buat: TRUE untuk broadcast
     * WhatsApp (selalu bertemplate resmi), FALSE selain itu; pemilik
     * bisa mengubahnya selama broadcast masih draft. NOT NULL — setiap
     * broadcast selalu punya keputusan gerbang yang eksplisit.
     */
    requireOptIn: boolean("require_opt_in").notNull().default(false),
    /**
     * Uji A/B broadcast (Fase 13D): persen penerima yang masuk varian
     * B (1..99); varian A menerima sisanya. NULL = TANPA uji A/B
     * (semua penerima varian "a") — nullable karena memang keadaan
     * kondisional: hanya broadcast yang mengaktifkan A/B yang punya
     * angka ini. Penugasan varian per penerima DETERMINISTIK
     * (hash stabil broadcast+kontak) dan disimpan di baris penerima,
     * jadi materialisasi ulang tidak pernah membalik varian.
     */
    abSplitPercentB: integer("ab_split_percent_b"),
    /**
     * Isi varian B untuk broadcast TEKS (Fase 13D). Untuk WhatsApp
     * kolom ini menampung snapshot teks BODY template B (persis
     * perlakuan message_text terhadap template A). NULL bila A/B
     * tidak aktif.
     */
    variantBMessageText: varchar("variant_b_message_text", { length: 4096 }),
    /**
     * Template WhatsApp varian B (Fase 13D): wajib terisi (dan
     * APPROVED, gerbang yang sama seperti template A) untuk broadcast
     * WhatsApp ber-A/B; NULL selain itu. SET NULL selaras template A.
     */
    variantBWhatsappTemplateId: uuid("variant_b_whatsapp_template_id").references(
      () => whatsappTemplates.id,
      { onDelete: "set null" },
    ),
    /**
     * Sumber variabel BODY template B per posisi (Fase 13D) —
     * semantik identik template_variable_sources untuk varian A.
     */
    variantBTemplateVariableSources: jsonb("variant_b_template_variable_sources")
      .notNull()
      .default([])
      .$type<string[]>(),
    status: broadcastStatusEnum("status").notNull().default("draft"),
    /** Waktu kirim yang diminta; NULL selama draft. */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    /** Kapan dispatch worker mulai mengeksekusi. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Kapan broadcast mencapai status terminal. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Kode kegagalan tingkat dispatch (mis. CHANNEL_DISCONNECTED, AUDIENCE_EMPTY). */
    errorCode: varchar("error_code", { length: 128 }),
    /** User pembuat (dibuat oleh) — informasional, SET NULL bila user hilang. */
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
    index("broadcasts_tenant_id_idx").on(t.tenantId),
    index("broadcasts_tenant_status_idx").on(t.tenantId, t.status),
    index("broadcasts_channel_account_id_idx").on(t.channelAccountId),
  ],
);

export const broadcastRecipients = pgTable(
  "broadcast_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * Percakapan 1:1 tujuan (yang sudah ada atau dibuat saat dispatch).
     * SET NULL: penghapusan percakapan tidak menghapus jejak penerima.
     */
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    /**
     * Pesan keluar yang dibuat untuk penerima ini. SET NULL disengaja:
     * cancel broadcast menghapus pesan `queued` yang belum terkirim —
     * baris penerima tetap ada sebagai cancelled, tautannya lepas.
     */
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    status: broadcastRecipientStatusEnum("status").notNull().default("queued"),
    /**
     * Varian uji A/B penerima ini (Fase 13D): "a" | "b". NOT NULL
     * dengan bawaan "a" — broadcast tanpa A/B menugaskan semua
     * penerima ke "a", jadi kolom ini selalu punya jawaban. Ditulis
     * sekali saat materialisasi dari hash deterministik
     * (broadcast+kontak); baris yang sudah ada tidak pernah ditulis
     * ulang, jadi varian tidak bisa berbalik pada retry dispatch.
     */
    variant: varchar("variant", { length: 8 }).notNull().default("a"),
    /** Alasan skipped: 'opted_out' | 'outside_24h_window' | 'message_deleted'. */
    skipReason: varchar("skip_reason", { length: 64 }),
    /** Kode error provider untuk penerima failed (disalin dari pesan). */
    errorCode: varchar("error_code", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("broadcast_recipients_broadcast_contact_unique").on(
      t.broadcastId,
      t.contactId,
    ),
    index("broadcast_recipients_tenant_id_idx").on(t.tenantId),
    index("broadcast_recipients_contact_id_idx").on(t.contactId),
    index("broadcast_recipients_conversation_id_idx").on(t.conversationId),
    index("broadcast_recipients_broadcast_status_idx").on(
      t.broadcastId,
      t.status,
    ),
    index("broadcast_recipients_broadcast_variant_idx").on(
      t.broadcastId,
      t.variant,
    ),
    index("broadcast_recipients_message_id_idx").on(t.messageId),
  ],
);

export type Broadcast = typeof broadcasts.$inferSelect;
export type NewBroadcast = typeof broadcasts.$inferInsert;
export type BroadcastRecipient = typeof broadcastRecipients.$inferSelect;
export type NewBroadcastRecipient = typeof broadcastRecipients.$inferInsert;

/**
 * Broadcast Berulang (G9 — Tier 2 butir 9):
 * - broadcast_recurrence_rules       : aturan berulang milik tenant.
 *   Menyimpan SNAPSHOT definisi broadcast (kolom definisi yang sama
 *   seperti `broadcasts`) + pola pengulangan. `source_broadcast_id`
 *   mencatat broadcast asal salinan (SET NULL — aturan tidak mati
 *   bersama sumbernya). `next_run_at` = slot berikutnya yang belum
 *   diproses; NULL pada aturan terminal (completed/cancelled).
 * - broadcast_recurrence_occurrences : ledger per slot. UNIQUE
 *   (rule_id, slot_at) adalah kunci idempotensi materialisasi.
 * Materialisasi memanggil jalur createBroadcast + scheduleBroadcast
 * yang ada — tidak ada mesin kirim kedua.
 */

export const broadcastRecurrenceFrequencyEnum = pgEnum(
  "broadcast_recurrence_frequency",
  ["daily", "weekly", "monthly"],
);

export const broadcastRecurrenceStatusEnum = pgEnum(
  "broadcast_recurrence_status",
  ["active", "paused", "completed", "cancelled"],
);

export const broadcastRecurrenceOccurrenceStatusEnum = pgEnum(
  "broadcast_recurrence_occurrence_status",
  ["claimed", "created", "skipped", "missed"],
);

export const broadcastRecurrenceRules = pgTable(
  "broadcast_recurrence_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    /**
     * Broadcast asal definisi disalin (provenance). SET NULL: aturan
     * adalah snapshot — menghapus sumber tidak menghapus jadwal.
     */
    sourceBroadcastId: uuid("source_broadcast_id").references(
      () => broadcasts.id,
      { onDelete: "set null" },
    ),
    /** Nama aturan; broadcast anak dinamai dari nama ini + tanggal slot. */
    name: varchar("name", { length: 255 }).notNull(),
    /** Sama seperti broadcasts.message_text (snapshot BODY untuk WhatsApp). */
    messageText: varchar("message_text", { length: 4096 }).notNull(),
    whatsappTemplateId: uuid("whatsapp_template_id").references(
      () => whatsappTemplates.id,
      { onDelete: "set null" },
    ),
    templateVariableSources: jsonb("template_variable_sources")
      .notNull()
      .default([])
      .$type<string[]>(),
    /** Sama seperti broadcasts.audience_filter (BroadcastAudienceFilter). */
    audienceFilter: jsonb("audience_filter").notNull().default({}),
    requireOptIn: boolean("require_opt_in").notNull().default(false),
    abSplitPercentB: integer("ab_split_percent_b"),
    variantBMessageText: varchar("variant_b_message_text", { length: 4096 }),
    variantBWhatsappTemplateId: uuid(
      "variant_b_whatsapp_template_id",
    ).references(() => whatsappTemplates.id, { onDelete: "set null" }),
    variantBTemplateVariableSources: jsonb(
      "variant_b_template_variable_sources",
    )
      .notNull()
      .default([])
      .$type<string[]>(),
    frequency: broadcastRecurrenceFrequencyEnum("frequency").notNull(),
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
    /** Batas jumlah broadcast anak yang dibuat; NULL = tanpa batas jumlah. */
    maxOccurrences: integer("max_occurrences"),
    /** Jumlah broadcast anak yang sudah benar-benar dibuat (ledger 'created'). */
    occurrencesCreated: integer("occurrences_created").notNull().default(0),
    status: broadcastRecurrenceStatusEnum("status").notNull().default("active"),
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
    index("broadcast_recurrence_rules_tenant_id_idx").on(t.tenantId),
    index("broadcast_recurrence_rules_tenant_status_idx").on(
      t.tenantId,
      t.status,
    ),
    index("broadcast_recurrence_rules_due_idx").on(t.nextRunAt),
  ],
);

export const broadcastRecurrenceOccurrences = pgTable(
  "broadcast_recurrence_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => broadcastRecurrenceRules.id, { onDelete: "cascade" }),
    /** Instan slot (UTC) — bersama rule_id membentuk kunci idempotensi. */
    slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
    status: broadcastRecurrenceOccurrenceStatusEnum("status").notNull(),
    /**
     * Alasan untuk skipped/missed: 'rule_paused' | 'slot_expired' |
     * 'claim_stale' | kode gerbang buat/jadwalkan (channel_not_found,
     * channel_disconnected, channel_unsupported, template_required,
     * template_not_approved, segment_not_found, message_required,
     * ab_incomplete). NULL untuk created/claimed.
     */
    reason: varchar("reason", { length: 64 }),
    /** Broadcast anak yang lahir dari slot ini (hanya status created). */
    broadcastId: uuid("broadcast_id").references(() => broadcasts.id, {
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
    uniqueIndex("broadcast_recurrence_occurrences_rule_slot_unique").on(
      t.ruleId,
      t.slotAt,
    ),
    index("broadcast_recurrence_occurrences_tenant_id_idx").on(t.tenantId),
    index("broadcast_recurrence_occurrences_rule_slot_idx").on(
      t.ruleId,
      t.slotAt,
    ),
  ],
);

export type BroadcastRecurrenceRule =
  typeof broadcastRecurrenceRules.$inferSelect;
export type NewBroadcastRecurrenceRule =
  typeof broadcastRecurrenceRules.$inferInsert;
export type BroadcastRecurrenceOccurrence =
  typeof broadcastRecurrenceOccurrences.$inferSelect;
export type NewBroadcastRecurrenceOccurrence =
  typeof broadcastRecurrenceOccurrences.$inferInsert;
