import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./identity";
import { contacts, conversations, messages } from "./inbox";

/**
 * Kelompok AI Agent & Knowledge Base (Fase 3A, RANCANGAN §5.1 & §6):
 * - agents            : konfigurasi agent AI per tenant (persona/prompt,
 *                       model, level otonomi). Tenant boleh punya banyak
 *                       agent; runtime memakai agent AKTIF TERTUA
 *                       (is_active=true, created_at paling awal) — satu
 *                       agent penanggung jawab per tenant di fase ini.
 * - kb_documents      : dokumen basis pengetahuan milik tenant (teks bebas
 *                       di fase ini; PDF/link menyusul sebagai source type).
 *                       Fase 12C menambah `source_document_id`: entri yang
 *                       lahir dari unggahan berkas menunjuk baris
 *                       `kb_source_documents` asalnya (NULL = tulis tangan).
 * - kb_source_documents: berkas asli unggahan KB (Fase 12C) — byte mentah
 *                       (bytea, pola profile_photos 6D), nama/mime/ukuran,
 *                       jumlah chunk hasil impor, dan pengunggah. Menghapus
 *                       baris ini men-cascade ke entri `kb_documents`
 *                       turunannya (dan chunk-nya); entri tulis tangan
 *                       tidak terpengaruh.
 * - kb_chunks         : potongan ±800 karakter dari dokumen untuk retrieval.
 *                       `search_vector` adalah kolom tsvector TER-GENERATE
 *                       dari `content` dengan konfigurasi 'simple' —
 *                       disengaja: korpus tenant adalah campuran Bahasa
 *                       Indonesia & Inggris, dan 'simple' tidak melakukan
 *                       stemming bahasa tertentu sehingga kedua bahasa
 *                       diperlakukan sama adil (retrieval v1 = full-text;
 *                       ranking memakai ts_rank di service core).
 *                       `embedding` vector(1536) disiapkan NULLABLE untuk
 *                       fase embedding berikutnya (retrieval semantik);
 *                       NULL di fase ini, tidak ada query yang memakainya.
 * - agent_suggestions : draf balasan agent pada mode 'suggest' — tidak ada
 *                       pesan yang keluar sebelum manusia menyetujui.
 *                       `detail` mencatat tool call yang DIUSULKAN agent
 *                       (di mode suggest tool TIDAK dieksekusi, termasuk
 *                       setelah approve: approve hanya mengirim teks).
 * - agent_instruction_templates : templat instruksi PRIBADI tenant
 *                       (gelombang Templat Instruction /agents) — salinan
 *                       instruction + mode + bahasa yang disimpan pemilik
 *                       dari formulir agent untuk dipakai ulang dari galeri
 *                       templat yang sama dengan templat bawaan statis
 *                       (katalog bawaan hidup di kontrak, BUKAN di tabel
 *                       ini). RLS migrasi 0027.
 * Semua tabel tenant-scoped: tenant_id + index, dilindungi RLS (migrasi 0010).
 *
 * Catatan kolom handoff: RANCANGAN menamai saklar AI per percakapan
 * `agent_enabled` dan kolom itu SUDAH ada di `conversations` sejak Fase 1D
 * (terekspos di kontrak API sebagai `agentEnabled`). Tool
 * `handoff_to_human` memakai kolom yang sama (tidak ada kolom duplikat).
 */

export const agentModeEnum = pgEnum("agent_mode", ["auto", "suggest"]);

export const agentSuggestionStatusEnum = pgEnum("agent_suggestion_status", [
  "pending",
  "approved",
  "rejected",
  "sent",
]);

export interface AgentConfig {
  /** Batas panjang balasan yang dikirim agent (karakter); kosong = tanpa batas. */
  maxReplyChars?: number;
  /** Petunjuk bahasa balasan, mis. 'id' | 'en'; kosong = mengikuti lawan bicara. */
  language?: string;
  /**
   * Cap balasan AI PER PERCAKAPAN dalam jendela bergulir 24 jam
   * (Gelombang G6, klaim atomik di core/agent-guards.ts); kosong =
   * bawaan runtime (20); 0 = cap nonaktif.
   */
  maxConversationReplies?: number;
}

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .filter((p) => p.length > 0)
      .map(Number);
  },
});

/**
 * Byte mentah berkas (Fase 12C) — drizzle-orm 0.44 belum mengekspor kolom
 * `bytea` bawaan untuk pg; pola yang sama dengan profile_photos (6D):
 * driver pg & PGlite mengembalikan Buffer/Uint8Array.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    /** Persona & instruksi agent (prompt sistem dasar, sebelum konteks KB). */
    systemPrompt: text("system_prompt").notNull().default(""),
    /**
     * Nama model untuk provider LLM (mis. 'openai/gpt-4o-mini' di OpenRouter).
     * String kosong = pakai default provider dari env (OPENROUTER_MODEL).
     */
    model: varchar("model", { length: 128 }).notNull().default(""),
    /** Level otonomi: 'auto' = langsung mengirim; 'suggest' = draf menunggu persetujuan. */
    mode: agentModeEnum("mode").notNull().default("suggest"),
    isActive: boolean("is_active").notNull().default(false),
    config: jsonb("config").$type<AgentConfig>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agents_tenant_id_idx").on(t.tenantId),
    index("agents_tenant_active_idx").on(t.tenantId, t.isActive, t.createdAt),
  ],
);

export const kbDocuments = pgTable(
  "kb_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    content: text("content").notNull(),
    /**
     * Berkas asal entri ini (Fase 12C): terisi untuk entri hasil impor
     * unggahan, NULL untuk entri tulis tangan. ON DELETE CASCADE dari
     * sisi berkas: menghapus berkas menghapus entri ini (dan chunk-nya).
     */
    sourceDocumentId: uuid("source_document_id").references(
      () => kbSourceDocuments.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("kb_documents_tenant_id_idx").on(t.tenantId),
    index("kb_documents_source_document_idx").on(t.sourceDocumentId),
  ],
);

/**
 * Berkas asli unggahan Knowledge Base (Fase 12C): satu baris per berkas
 * yang diunggah user (PDF/TXT/MD ≤5MB). Byte disimpan di DB (bytea) —
 * belum ada konsumen R2 dan ukuran dibatasi kecil; teks hasil ekstraksi
 * hidup sebagai entri `kb_documents` biasa (source_document_id ke sini)
 * yang di-chunk ke `kb_chunks`, jadi retrieval agent tidak berubah.
 * `chunk_count` dicatat saat impor (jumlah chunk entri turunannya).
 */
export const kbSourceDocuments = pgTable(
  "kb_source_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 128 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    /** Byte mentah berkas sebagaimana diunggah. */
    data: bytea("data").notNull(),
    /** Jumlah chunk KB hasil impor berkas ini (0 sampai impor selesai). */
    chunkCount: integer("chunk_count").notNull().default(0),
    /** User pengunggah; SET NULL bila user hilang (pola saved_replies). */
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
  (t) => [index("kb_source_documents_tenant_id_idx").on(t.tenantId)],
);

export const kbChunks = pgTable(
  "kb_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => kbDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    /** Ter-generate dari `content` (konfigurasi 'simple' — lihat kepala file). */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', "content")`,
    ),
    /** Embedding semantik; NULL sampai fase embedding (retrieval v1 = FTS). */
    embedding: vector1536("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("kb_chunks_tenant_id_idx").on(t.tenantId),
    index("kb_chunks_document_idx").on(t.documentId, t.chunkIndex),
    index("kb_chunks_search_vector_gin_idx").using("gin", t.searchVector),
  ],
);

export const agentSuggestions = pgTable(
  "agent_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Pesan inbound yang memicu draf ini. */
    triggerMessageId: uuid("trigger_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    /** Kontak lawan bicara (denormalisasi agar daftar saran murah dibaca). */
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    suggestedText: text("suggested_text").notNull(),
    status: agentSuggestionStatusEnum("status").notNull().default("pending"),
    /**
     * Konteks saran: tool call yang diusulkan (TIDAK dieksekusi di mode
     * suggest), provider/model, token, dan — setelah approve — id pesan
     * outbound yang terkirim.
     */
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agent_suggestions_tenant_id_idx").on(t.tenantId),
    index("agent_suggestions_tenant_status_idx").on(t.tenantId, t.status),
    index("agent_suggestions_conversation_idx").on(t.conversationId),
    index("agent_suggestions_agent_id_idx").on(t.agentId),
    index("agent_suggestions_contact_id_idx").on(t.contactId),
  ],
);

/**
 * Templat instruksi pribadi tenant: satu baris = satu templat yang
 * disimpan pemilik dari formulir buat/edit agent (nama bebas dari
 * pemilik; isi = instruction + mode + bahasa saat disimpan). Dipakai
 * ulang dari galeri templat di formulir yang sama; menghapusnya tidak
 * menyentuh agent mana pun (templat adalah salinan, bukan rujukan).
 * `language` NULL = templat tidak menyarankan bahasa (ikuti lawan
 * bicara, sama seperti config.language kosong pada agent).
 */
export const agentInstructionTemplates = pgTable(
  "agent_instruction_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    /** Instruction (system prompt) salinan saat templat disimpan. */
    systemPrompt: text("system_prompt").notNull().default(""),
    /** Mode yang disarankan templat (pola kolom mode pada `agents`). */
    mode: agentModeEnum("mode").notNull().default("suggest"),
    /** Bahasa balasan yang disarankan ('id' | 'en'); NULL = tanpa saran. */
    language: varchar("language", { length: 16 }),
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
  (t) => [index("agent_instruction_templates_tenant_id_idx").on(t.tenantId)],
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type KbDocument = typeof kbDocuments.$inferSelect;
export type NewKbDocument = typeof kbDocuments.$inferInsert;
export type KbSourceDocument = typeof kbSourceDocuments.$inferSelect;
export type NewKbSourceDocument = typeof kbSourceDocuments.$inferInsert;
export type KbChunk = typeof kbChunks.$inferSelect;
export type NewKbChunk = typeof kbChunks.$inferInsert;
export type AgentSuggestion = typeof agentSuggestions.$inferSelect;
export type NewAgentSuggestion = typeof agentSuggestions.$inferInsert;
export type AgentInstructionTemplate =
  typeof agentInstructionTemplates.$inferSelect;
export type NewAgentInstructionTemplate =
  typeof agentInstructionTemplates.$inferInsert;
