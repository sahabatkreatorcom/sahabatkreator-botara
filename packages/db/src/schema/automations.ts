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
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { contacts, conversations, messages } from "./inbox";
import { users } from "./identity";

/**
 * Kelompok Automation (Fase 2A, RANCANGAN §6; diperluas Fase 2C):
 * - automations      : aturan otomatis milik tenant. Fase 2A memakai
 *                      trigger_type='keyword' + action_type='send_message';
 *                      konfigurasi trigger/aksi disimpan sebagai jsonb agar
 *                      trigger & aksi berikutnya tidak mengubah skema inti.
 *                      trigger_config: { keywords: string[],
 *                                        match: 'exact' | 'contains' }
 *                      action_config : { text: string } — mendukung
 *                                        placeholder {name} (nama kontak).
 *                      Fase 2C menambah kolom `kind`:
 *                        'keyword'  — balasan tunggal langsung (perilaku 2A).
 *                        'sequence' — keyword yang cocok MENDAFTARKAN kontak
 *                                     ke rangkaian langkah di automation_steps;
 *                                     trigger_config tetap dipakai (keyword
 *                                     pemicu), action_config.text tidak
 *                                     dipakai untuk kind ini.
 * - automation_steps : langkah rangkaian sequence (Fase 2C): posisi 1..n,
 *                      jeda (menit) SEBELUM langkah itu dikirim relatif
 *                      terhadap langkah sebelumnya (langkah pertama: relatif
 *                      terhadap pendaftaran), dan teks (placeholder {name}).
 * - sequence_enrollments : satu pendaftaran kontak ke satu sequence.
 *                      current_step = berapa langkah yang SUDAH terkirim
 *                      (0 = belum ada). Index unik parsial menjamin satu
 *                      enrollment 'active' per (automation, kontak).
 * - automation_runs  : satu baris per eksekusi automation untuk satu pesan
 *                      pemicu. Index unik parsial
 *                      (automation_id, trigger_message_id) adalah penjaga
 *                      idempotensi terakhir: relay/worker yang memproses
 *                      event yang sama dua kali tidak bisa menembak dua kali
 *                      untuk pesan pemicu yang sama.
 * - sequence_templates : templat sequence PRIBADI tenant (gelombang G2,
 *                      migrasi 0028): salinan keadaan formulir sequence
 *                      (nama + kata kunci + mode cocok + langkah jsonb)
 *                      yang disimpan pemilik untuk dipakai ulang dari
 *                      galeri. Bukan tabel bersama dengan templat agen —
 *                      yang dibagi adalah POLA simpan-pribadinya saja.
 * Semua tabel tenant-scoped: tenant_id + index, dilindungi RLS
 * (migrasi 0008 & 0014).
 */

export const automationTriggerTypeEnum = pgEnum("automation_trigger_type", [
  "keyword",
  // Fase 10B: pemicu komentar publik IG/Messenger (aturan comment-to-DM).
  "comment",
  // G5 (migrasi 0030): pemicu ketukan tombol & pesan pertama. 'kind'
  // tetap keluarga aksi ('keyword' balasan langsung / 'sequence'
  // pendaftaran); trigger_config.payloads memuat payload tombol yang
  // dicocokkan PERSIS untuk 'postback' & 'quick_reply'; 'welcome'
  // tidak membawa syarat tambahan (menyala untuk pesan pertama kontak).
  "postback",
  "quick_reply",
  "welcome",
]);

export const automationKindEnum = pgEnum("automation_kind", [
  "keyword",
  "sequence",
  // Fase 10B: aturan komentar (trigger_type='comment'); tanpa langkah.
  "comment",
]);

export const sequenceEnrollmentStatusEnum = pgEnum(
  "sequence_enrollment_status",
  ["active", "completed", "cancelled"],
);

export const automationActionTypeEnum = pgEnum("automation_action_type", [
  "send_message",
]);

export const automationRunStatusEnum = pgEnum("automation_run_status", [
  "completed",
  "failed",
  "skipped",
]);

export interface AutomationTriggerConfig {
  keywords: string[];
  match: "exact" | "contains";
  /**
   * Fase 10B — hanya untuk trigger_type='comment': akun channel
   * (uuid channel_accounts) tempat aturan ini berlaku. Aturan komentar
   * selalu terikat SATU akun IG/Messenger; aturan pesan tidak
   * mengisinya (undefined).
   */
  channelAccountId?: string;
  /**
   * G5 — hanya untuk trigger_type='postback' / 'quick_reply': daftar
   * payload tombol yang mengaktifkan aturan ini. Pencocokan PERSIS
   * dan case-sensitive (payload adalah string mesin platform).
   * Aturan keyword/comment/welcome tidak mengisinya (undefined);
   * `keywords` untuk aturan sinyal selalu array kosong.
   */
  payloads?: string[];
}

export interface AutomationActionConfig {
  text: string;
  /**
   * Fase 10B — hanya untuk trigger_type='comment' (untuk aturan pesan
   * semua field ini absen):
   * - sendDm: kirim DM privat ke penulis komentar; teksnya `text`.
   * - publicReplyText: teks balasan publik pada komentar; null = mati.
   * - hideComment: sembunyikan komentar sesudah aksi lain berjalan.
   * Mode moderasi murni = sendDm false + publicReplyText null +
   * hideComment true.
   */
  sendDm?: boolean;
  publicReplyText?: string | null;
  hideComment?: boolean;
}

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    triggerType: automationTriggerTypeEnum("trigger_type")
      .notNull()
      .default("keyword"),
    triggerConfig: jsonb("trigger_config")
      .$type<AutomationTriggerConfig>()
      .notNull()
      .default({ keywords: [], match: "exact" }),
    actionType: automationActionTypeEnum("action_type")
      .notNull()
      .default("send_message"),
    actionConfig: jsonb("action_config")
      .$type<AutomationActionConfig>()
      .notNull()
      .default({ text: "" }),
    /**
     * Jenis automation (Fase 2C). Baris lama Fase 2A otomatis 'keyword'.
     * Pemicu tetap keyword untuk kedua jenis; yang berbeda adalah aksinya.
     */
    kind: automationKindEnum("kind").notNull().default("keyword"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("automations_tenant_id_idx").on(t.tenantId),
    index("automations_tenant_active_idx").on(t.tenantId, t.isActive),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Pesan inbound pemicu; NULL hanya untuk pemicu non-pesan di masa depan. */
    triggerMessageId: uuid("trigger_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    status: automationRunStatusEnum("status").notNull(),
    /** Konteks eksekusi: keyword yang cocok, id pesan balasan, alasan skip, dsb. */
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("automation_runs_tenant_id_idx").on(t.tenantId),
    index("automation_runs_contact_id_idx").on(t.contactId),
    index("automation_runs_conversation_id_idx").on(t.conversationId),
    index("automation_runs_automation_created_idx").on(
      t.automationId,
      t.createdAt,
    ),
    uniqueIndex("automation_runs_automation_trigger_message_unique")
      .on(t.automationId, t.triggerMessageId)
      .where(sql`${t.triggerMessageId} IS NOT NULL`),
  ],
);

export const automationSteps = pgTable(
  "automation_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    /** Urutan langkah dalam rangkaian, mulai dari 1. */
    position: integer("position").notNull(),
    /**
     * Jeda (menit) sebelum langkah ini dikirim, relatif terhadap langkah
     * sebelumnya — untuk langkah pertama, relatif terhadap pendaftaran.
     * 0 = secepatnya. Maksimum ditegakkan kontrak API (43200 = 30 hari).
     */
    delayMinutes: integer("delay_minutes").notNull().default(0),
    /** Isi pesan langkah; mendukung placeholder {name} (nama kontak). */
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("automation_steps_tenant_id_idx").on(t.tenantId),
    index("automation_steps_automation_idx").on(t.automationId, t.position),
    uniqueIndex("automation_steps_automation_position_unique").on(
      t.automationId,
      t.position,
    ),
    check(
      "automation_steps_delay_minutes_nonnegative",
      sql`${t.delayMinutes} >= 0`,
    ),
    check("automation_steps_position_positive", sql`${t.position} >= 1`),
  ],
);

export const sequenceEnrollments = pgTable(
  "sequence_enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Pesan inbound yang mendaftarkan kontak ke rangkaian ini. */
    triggerMessageId: uuid("trigger_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    /** Berapa langkah yang SUDAH terkirim (0 = belum ada langkah terkirim). */
    currentStep: integer("current_step").notNull().default(0),
    status: sequenceEnrollmentStatusEnum("status").notNull().default("active"),
    /** Kapan langkah berikutnya dijadwalkan dikirim; NULL bila tidak aktif. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sequence_enrollments_tenant_id_idx").on(t.tenantId),
    index("sequence_enrollments_contact_id_idx").on(t.contactId),
    index("sequence_enrollments_conversation_idx").on(
      t.tenantId,
      t.conversationId,
      t.status,
    ),
    index("sequence_enrollments_automation_idx").on(
      t.automationId,
      t.createdAt,
    ),
    /**
     * Satu enrollment AKTIF per (automation, kontak): pendaftaran ulang
     * saat rangkaian masih berjalan diabaikan (run dicatat 'skipped').
     */
    uniqueIndex("sequence_enrollments_active_unique")
      .on(t.automationId, t.contactId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type Automation = typeof automations.$inferSelect;
export type NewAutomation = typeof automations.$inferInsert;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type NewAutomationRun = typeof automationRuns.$inferInsert;
export type AutomationStep = typeof automationSteps.$inferSelect;
export type NewAutomationStep = typeof automationSteps.$inferInsert;
export type SequenceEnrollment = typeof sequenceEnrollments.$inferSelect;
export type NewSequenceEnrollment = typeof sequenceEnrollments.$inferInsert;

/** Satu langkah templat sequence tersimpan (payload jsonb `steps`). */
export interface SequenceTemplateStep {
  delayMinutes: number;
  text: string;
}

/**
 * Templat sequence PRIBADI tenant (gelombang G2): satu baris = satu
 * templat yang disimpan pemilik dari formulir buat/edit sequence
 * (nama bebas dari pemilik; isi = kata kunci + mode cocok + langkah
 * saat disimpan). Mengikuti POLA BERSAMA "SIMPAN TEMPLAT PRIBADI"
 * (lihat kontrak agents.ts) — pola yang sama dengan
 * `agent_instruction_templates`, TABEL yang berbeda: payload templat
 * sequence adalah daftar langkah terurut, bukan satu teks instruction.
 *
 * Templat adalah SALINAN, bukan rujukan: memakainya membuat automation
 * sequence BARU (selalu nonaktif, seperti instantiate katalog);
 * mengubah/menghapus templat tidak menyentuh automation mana pun.
 * Ubah templat tersimpan di v1 = hapus + simpan ulang.
 * `steps` jsonb: array terurut {delayMinutes, text} — posisi adalah
 * indeks array (mulai dari 1), divalidasi skema kontrak saat simpan
 * dan saat instantiate (batas yang sama dengan langkah automation).
 */
export const sequenceTemplates = pgTable(
  "sequence_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    /** Kata kunci pemicu sequence (pola trigger_config automation). */
    keywords: text("keywords").array().notNull().default([]),
    /** Mode cocok kata kunci: 'exact' | 'contains' (teks bebas divalidasi kontrak). */
    match: varchar("match", { length: 16 }).notNull().default("exact"),
    /** Langkah terurut {delayMinutes, text}; posisi = indeks + 1. */
    steps: jsonb("steps")
      .$type<SequenceTemplateStep[]>()
      .notNull()
      .default([]),
    /** User penyimpan; SET NULL bila user hilang (pola saved_replies). */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sequence_templates_tenant_id_idx").on(t.tenantId)],
);

export type SequenceTemplate = typeof sequenceTemplates.$inferSelect;
export type NewSequenceTemplate = typeof sequenceTemplates.$inferInsert;
