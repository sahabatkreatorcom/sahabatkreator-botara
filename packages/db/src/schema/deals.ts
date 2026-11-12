import {
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { contacts, conversations } from "./inbox";
import { tenants } from "./tenants";

/**
 * Deals / pipeline penjualan (Gelombang G12, Tier 2 butir 12 program
 * adopsi — pola repo riset wacrm `src/lib/pipelines` + migrasi
 * 001/002/021 wacrm, MIT, diadopsi sebagai POLA bukan kode).
 *
 * Entitas deal TERPISAH dari kontak: `contacts.pipeline_stage` yang
 * sudah ada adalah tahap KONTAK sederhana (satu nilai per orang);
 * deal adalah peluang penjualan bernilai uang yang menempel pada
 * kontak — satu kontak boleh punya BANYAK deal, dan deal-lah yang
 * bergerak di papan Kanban. Keduanya tidak dicampur.
 *
 * - `deal_pipelines`: pipeline per tenant (boleh lebih dari satu).
 *   Pipeline bawaan + tahap bawaannya disemai MALAS oleh core
 *   (`ensureDefaultDealPipeline`) saat tenant pertama kali membuka
 *   permukaan deals — bukan trigger DB, agar semai menghormati
 *   `tenants.default_locale` untuk nama tahapnya.
 * - `deal_stages`: tahap per pipeline — nama + urutan (`position`)
 *   bisa disesuaikan tenant. `kind` menandai sifat tahap:
 *   'open' (tahap kerja biasa), 'won' / 'lost' (tahap TERMINAL —
 *   memindahkan deal ke tahap ber-kind itu menetapkan
 *   `deals.status` won/lost + `closed_at`; memindahkan keluar dari
 *   tahap terminal membuka lagi deal: status 'open', closed_at NULL).
 *   Pola status di baris deal meniru wacrm (status open/won/lost di
 *   deal, bukan diturunkan dari posisi tahap).
 * - `deals`: judul, `value` numeric(14,2) + `currency` per deal
 *   (bawaan dari `tenants.default_currency` saat dibuat; sesudah itu
 *   milik deal sendiri — total analitik TIDAK pernah menjumlah
 *   lintas mata uang), expected_close_date, due_at (tenggat),
 *   priority, assignee (member tenant; SET NULL bila user terhapus),
 *   kontak WAJIB (CASCADE mengikuti pola FK kontak repo: percakapan
 *   & catatan kontak), percakapan opsional (SET NULL).
 *   FK `stage_id` RESTRICT: tahap berisi deal tidak bisa dihapus
 *   sebelum dealnya dipindahkan — ditegakkan core dengan pesan
 *   jujur, DB menjadi jaring pengaman terakhirnya.
 * - `deal_stage_events`: riwayat perpindahan tahap per deal
 *   (dari → ke, aktor user/flow/sistem, nama tahap SNAPSHOT agar
 *   riwayat tetap terbaca sesudah tahap diganti nama/dihapus;
 *   FK tahap SET NULL). Baris pertama sebuah deal adalah peristiwa
 *   pembuatan (from NULL). Riwayat ini sumber analitik durasi tahap
 *   di masa depan; gelombang ini memakainya untuk panel detail.
 *
 * Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
 * (RLS `tenant_isolation` dengan app_tenant_id()).
 */

export const dealStageKindEnum = pgEnum("deal_stage_kind", [
  "open",
  "won",
  "lost",
]);

export const dealStatusEnum = pgEnum("deal_status", ["open", "won", "lost"]);

export const dealPriorityEnum = pgEnum("deal_priority", [
  "low",
  "medium",
  "high",
]);

export const dealPipelines = pgTable(
  "deal_pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("deal_pipelines_tenant_id_idx").on(t.tenantId)],
);

export type DealPipeline = typeof dealPipelines.$inferSelect;
export type NewDealPipeline = typeof dealPipelines.$inferInsert;

export const dealStages = pgTable(
  "deal_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => dealPipelines.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    /** Urutan kolom di papan (0-based, rapat — diatur ulang core). */
    position: integer("position").notNull().default(0),
    /** Warna aksen kolom (hex), pola tahap wacrm. */
    color: varchar("color", { length: 16 }).notNull().default("#3b82f6"),
    /** 'open' = tahap kerja; 'won'/'lost' = tahap terminal. */
    kind: dealStageKindEnum("kind").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("deal_stages_tenant_id_idx").on(t.tenantId),
    index("deal_stages_pipeline_position_idx").on(t.pipelineId, t.position),
  ],
);

export type DealStage = typeof dealStages.$inferSelect;
export type NewDealStage = typeof dealStages.$inferInsert;

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => dealPipelines.id, { onDelete: "cascade" }),
    /** RESTRICT: tahap berisi deal wajib dikosongkan/dipindahkan dulu. */
    stageId: uuid("stage_id")
      .notNull()
      .references(() => dealStages.id, { onDelete: "restrict" }),
    /** Kontak pemilik deal — WAJIB; CASCADE pola FK kontak repo. */
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Percakapan terkait (opsional). */
    conversationId: uuid("conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    /** Nilai deal dalam mata uang `currency` (satuan mayor, 2 desimal). */
    value: numeric("value", { precision: 14, scale: 2 }).notNull().default("0"),
    /** Kode mata uang ISO 4217 (3 huruf besar) milik deal ini sendiri. */
    currency: varchar("currency", { length: 3 }).notNull(),
    /** Perkiraan tanggal tutup (menang/kalah) — tanggal kalender. */
    expectedCloseDate: date("expected_close_date"),
    /** Tenggat tindak lanjut (timestamp); kartu papan menampilkannya. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: dealStatusEnum("status").notNull().default("open"),
    priority: dealPriorityEnum("priority").notNull().default("medium"),
    /** Penanggung jawab: member tenant; SET NULL bila user terhapus. */
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Terisi saat status menjadi won/lost; NULL lagi bila dibuka ulang. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("deals_tenant_id_idx").on(t.tenantId),
    index("deals_pipeline_stage_idx").on(t.pipelineId, t.stageId),
    index("deals_contact_id_idx").on(t.contactId),
    index("deals_status_idx").on(t.status),
  ],
);

export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;

export const dealStageEvents = pgTable(
  "deal_stage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    /** NULL pada peristiwa pembuatan deal. */
    fromStageId: uuid("from_stage_id").references(() => dealStages.id, {
      onDelete: "set null",
    }),
    toStageId: uuid("to_stage_id").references(() => dealStages.id, {
      onDelete: "set null",
    }),
    /** Snapshot nama — riwayat tetap terbaca sesudah tahap berubah. */
    fromStageName: text("from_stage_name"),
    toStageName: text("to_stage_name").notNull(),
    /** Siapa yang memindahkan: 'user' | 'flow' | 'automation' | 'system'. */
    actorType: varchar("actor_type", { length: 32 }).notNull(),
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("deal_stage_events_tenant_id_idx").on(t.tenantId),
    index("deal_stage_events_deal_created_idx").on(t.dealId, t.createdAt),
  ],
);

export type DealStageEvent = typeof dealStageEvents.$inferSelect;
export type NewDealStageEvent = typeof dealStageEvents.$inferInsert;
