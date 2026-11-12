import { sql } from "drizzle-orm";
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
import { contacts, conversations, messages } from "./inbox";

/**
 * Kelompok Flow (Fase 8A — Flow Engine):
 * - flows          : satu definisi alur otomatisasi berbentuk GRAF
 *                    (jsonb `graph` — format kontrak di
 *                    @sahabat-kreator/contracts: nodes + edges, tepat
 *                    satu node trigger). Status draft|active|archived.
 *                    Graf DRAFT boleh belum sah; validasi menyeluruh
 *                    terjadi di core saat aktivasi (FLOW_GRAPH_INVALID).
 * - flow_versions  : snapshot graf yang TIDAK bisa diubah, ditulis
 *                    SETIAP aktivasi flow (G3 — adopsi pola zernflow
 *                    00010_flow_versions): nomor urut per flow, graf
 *                    utuh, nama flow saat itu, pengaktif, dan
 *                    `restored_from_version` bila versi ini lahir dari
 *                    pemulihan versi lama. Append-only: pemulihan
 *                    melahirkan versi BARU, sejarah tidak ditulis
 *                    ulang. Run mem-pin versi lewat
 *                    `flow_runs.flow_version_id` dan eksekutor membaca
 *                    SNAPSHOT itu — bukan graf live — agar suntingan
 *                    flow tidak mengubah run yang sedang berjalan.
 * - flow_runs      : satu eksekusi flow untuk satu (flow, pesan
 *                    pemicu) — unik parsial di DB sebagai idempotensi
 *                    terakhir. Status running|waiting|completed|failed|
 *                    cancelled. `current_node_id` + `next_step_seq`
 *                    adalah penanda resume eksekutor worker; `context`
 *                    jsonb menyimpan konteks eksekusi (teks pesan
 *                    pemicu untuk predikat message_contains).
 *                    `flow_version_id`/`flow_version` = pin versi graf
 *                    yang dijalankan run ini; NULL = run warisan
 *                    (lahir sebelum G3, atau flow aktif warisan yang
 *                    belum pernah diaktifkan ulang) → eksekutor jatuh
 *                    kembali ke graf live secara jujur, tanpa snapshot
 *                    retroaktif yang dikarang.
 * - flow_run_steps : log per langkah (observabilitas yang diadopsi
 *                    dari riset referensi): urutan (seq), node, tipe,
 *                    ringkasan hasil terstruktur, error bila gagal.
 * Semua tabel tenant-scoped: tenant_id + index, dilindungi RLS
 * (migrasi 0031). Eksekutor worker berjalan dalam konteks tenant
 * pemilik run (job membawa tenantId) — tidak ada lengan lintas tenant.
 */

export const flowStatusEnum = pgEnum("flow_status", [
  "draft",
  "active",
  "archived",
]);

export const flowRunStatusEnum = pgEnum("flow_run_status", [
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);

export const flows = pgTable(
  "flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Nama internal flow (tidak dikirim ke kontak). */
    name: varchar("name", { length: 255 }).notNull(),
    status: flowStatusEnum("status").notNull().default("draft"),
    /**
     * Graf flow (kontrak FlowGraph di @sahabat-kreator/contracts):
     * { nodes: [{id, type, config}], edges: [{from, to, branch?}] }.
     * Disimpan apa adanya selama draft; divalidasi kontrak saat buat/
     * edit (bentuk) dan divalidasi semantik penuh saat aktivasi (core).
     */
    graph: jsonb("graph").notNull().default({ nodes: [], edges: [] }),
    /** User pembuat — informasional, SET NULL bila user hilang. */
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
    index("flows_tenant_id_idx").on(t.tenantId),
    index("flows_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

/**
 * Snapshot versi flow (G3): satu baris per AKTIVASI. Ditulis core di
 * dalam transaksi aktivasi yang sama (crud.activateFlow /
 * versions.restoreFlowVersion) — tidak pernah diubah atau dihapus
 * kecuali flow induknya dihapus (cascade). Unik (flow_id, version):
 * nomor tidak pernah dipakai ulang walau dua aktivasi balapan.
 */
export const flowVersions = pgTable(
  "flow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    /** Nomor urut versi per flow (1-based, tanpa celah dari aktivasi). */
    version: integer("version").notNull(),
    /** Nama flow saat versi ini diaktifkan (label historis). */
    name: varchar("name", { length: 255 }).notNull(),
    /** Snapshot graf utuh {nodes, edges} persis seperti yang diaktifkan. */
    graph: jsonb("graph").notNull(),
    /**
     * Versi sumber bila baris ini lahir dari pemulihan (restore);
     * NULL untuk aktivasi biasa dari draft.
     */
    restoredFromVersion: integer("restored_from_version"),
    /** User yang mengaktifkan — informasional, SET NULL bila hilang. */
    activatedByUserId: uuid("activated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("flow_versions_flow_version_unique").on(t.flowId, t.version),
    index("flow_versions_tenant_id_idx").on(t.tenantId),
    index("flow_versions_flow_id_idx").on(t.flowId),
  ],
);

export type FlowVersion = typeof flowVersions.$inferSelect;
export type NewFlowVersion = typeof flowVersions.$inferInsert;

export const flowRuns = pgTable(
  "flow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    /**
     * Pin versi graf (G3): snapshot `flow_versions` yang dijalankan
     * run ini. Eksekutor membaca graf DARI snapshot ini, bukan graf
     * live flows. NULL = run warisan tanpa pin → fallback graf live.
     * SET NULL bila baris versi hilang (versi append-only; hanya
     * cascade hapus flow yang bisa menghilangkannya, dan itu ikut
     * menghapus run ini).
     */
    flowVersionId: uuid("flow_version_id").references(() => flowVersions.id, {
      onDelete: "set null",
    }),
    /** Nomor versi ter-pin (denormalisasi dari baris versi saat pin). */
    flowVersion: integer("flow_version"),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * Pesan masuk yang memulai run ini (idempotensi: unik per flow).
     * NULLABLE sejak Fase 12A (migrasi 0038): run yang lahir dari node
     * goto_flow tidak dipicu pesan masuk; konteksnya menyimpan
     * rootTriggerMessageId sebagai gantinya. Index unik parsial sudah
     * mengabaikan NULL sejak 0031.
     */
    triggerMessageId: uuid("trigger_message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    status: flowRunStatusEnum("status").notNull().default("running"),
    /** Node yang akan dieksekusi langkah berikutnya; null bila terminal. */
    currentNodeId: varchar("current_node_id", { length: 128 }),
    /**
     * Nomor urut langkah BERIKUTNYA (1-based). jobId `flow.step`
     * diturunkan dari (runId, next_step_seq) — enqueue/job ganda untuk
     * resume yang sama selalu menunjuk job yang sama, dan eksekusi
     * menolak seq basi.
     */
    nextStepSeq: integer("next_step_seq").notNull().default(1),
    /** Jumlah langkah yang sudah dieksekusi (penjaga cap langkah). */
    stepCount: integer("step_count").notNull().default(0),
    /**
     * Konteks eksekusi: { triggerText } — teks pesan pemicu (untuk
     * predikat message_contains) + fakta langkah yang perlu bertahan
     * lintas resume (mis. outboundMessageId terakhir). Fase 12A
     * menambah: `gotoDepth` (kedalaman rantai goto_flow),
     * `rootTriggerMessageId` (pesan pemicu run akar untuk run goto),
     * dan `wait` ({ nodeId, deadline } — parkir node wait_reply).
     */
    context: jsonb("context").notNull().default({}),
    /** Alasan terminal non-sukses: step_cap_exceeded, contact_opted_out, dst. */
    errorCode: varchar("error_code", { length: 128 }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("flow_runs_tenant_id_idx").on(t.tenantId),
    index("flow_runs_flow_id_idx").on(t.flowId),
    index("flow_runs_contact_id_idx").on(t.contactId),
    index("flow_runs_conversation_id_idx").on(t.conversationId),
    index("flow_runs_tenant_status_idx").on(t.tenantId, t.status),
    uniqueIndex("flow_runs_flow_trigger_message_unique")
      .on(t.flowId, t.triggerMessageId)
      .where(sql`${t.triggerMessageId} IS NOT NULL`),
  ],
);

export const flowRunSteps = pgTable(
  "flow_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => flowRuns.id, { onDelete: "cascade" }),
    /** Nomor urut langkah dalam run (1-based, unik per run). */
    seq: integer("seq").notNull(),
    /** Id node di graf yang dieksekusi langkah ini. */
    nodeId: varchar("node_id", { length: 128 }).notNull(),
    /** Tipe node saat eksekusi (denormalisasi dari graf). */
    nodeType: varchar("node_type", { length: 64 }).notNull(),
    /** Ringkasan hasil terstruktur (branch terpilih, pesan terkirim, dst). */
    detail: jsonb("detail").notNull().default({}),
    /** Pesan error bila langkah gagal (run ikut failed); null bila sukses. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("flow_run_steps_tenant_id_idx").on(t.tenantId),
    index("flow_run_steps_run_id_idx").on(t.runId),
    uniqueIndex("flow_run_steps_run_seq_unique").on(t.runId, t.seq),
  ],
);

export type Flow = typeof flows.$inferSelect;
export type NewFlow = typeof flows.$inferInsert;
export type FlowRun = typeof flowRuns.$inferSelect;
export type NewFlowRun = typeof flowRuns.$inferInsert;
export type FlowRunStep = typeof flowRunSteps.$inferSelect;
export type NewFlowRunStep = typeof flowRunSteps.$inferInsert;

/**
 * Penugasan eksperimen A/B flow (Fase 13D): SATU baris per
 * (tenant, flow, node ab_split, kontak) — penugasan PERTAMA menang dan
 * tidak pernah berubah (unik parsial ditegakkan index unik), sehingga
 * kontak yang sama selalu masuk varian yang sama di semua run walau
 * operator mengubah percentA di tengah eksperimen. Baris ditulis
 * eksekutor saat node ab_split mode eksperimen pertama kali dicapai
 * kontak itu; `branch` + `percent_a` adalah snapshot keputusan saat
 * itu, `run_id` = run penugasan pertama. Laporan per varian (kontak
 * unik) membaca tabel ini; hitungan run/konversi diturunkan dari
 * flow_run_steps + flow_runs. Tenant-scoped + RLS seperti tabel flow
 * lain (migrasi 0004).
 */
export const flowExperimentAssignments = pgTable(
  "flow_experiment_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    flowId: uuid("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    /** Id node ab_split di graf flow (bukan FK — id graf, bukan baris). */
    nodeId: varchar("node_id", { length: 128 }).notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Run yang pertama kali menugaskan kontak ini ke variannya. */
    runId: uuid("run_id")
      .notNull()
      .references(() => flowRuns.id, { onDelete: "cascade" }),
    /** Varian hasil penugasan: "a" | "b" (branch edge ab_split). */
    branch: varchar("branch", { length: 8 }).notNull(),
    /** Label eksperimen dari config node saat penugasan (opsional). */
    label: varchar("label", { length: 255 }),
    /** Snapshot percentA yang berlaku saat penugasan dibuat. */
    percentA: integer("percent_a").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("flow_experiment_assignments_sticky_unique").on(
      t.tenantId,
      t.flowId,
      t.nodeId,
      t.contactId,
    ),
    index("flow_experiment_assignments_tenant_id_idx").on(t.tenantId),
    index("flow_experiment_assignments_split_idx").on(
      t.tenantId,
      t.flowId,
      t.nodeId,
      t.branch,
    ),
  ],
);

export type FlowExperimentAssignment =
  typeof flowExperimentAssignments.$inferSelect;
export type NewFlowExperimentAssignment =
  typeof flowExperimentAssignments.$inferInsert;
