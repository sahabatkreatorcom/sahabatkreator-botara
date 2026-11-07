import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { channelAccounts } from "./channels";
import { messages } from "./inbox";

/**
 * Tabel sistem fondasi (RANCANGAN §2 & §6):
 * - outbox_events : Transactional Outbox — event ditulis dalam transaksi yang
 *                   sama dengan perubahan datanya, relay mem-publish yang
 *                   published_at-nya masih NULL.
 * - audit_logs    : jejak setiap aksi penting, terutama aksi otonom AI agent.
 * - usage_ledger  : metering APPEND-ONLY (sengaja tanpa updated_at) untuk
 *                   billing; mencatat qty + biaya model + biaya provider.
 * - integration_log: log observabilitas integrasi (Fase 7B.1) — SETIAP hit
 *                   webhook provider (telegram/meta) dan SETIAP percobaan
 *                   kirim keluar poller tercatat dengan outcome jujur.
 *                   (payload dibatasi ±32KB, retensi 30 hari oleh worker).
 *
 * `webhook_inbox` DIHAPUS di migrasi 0009 (Fase 21). Tabel itu tidak pernah
 * menerima satu pun INSERT sejak dedup pindah ke
 * `messages.provider_message_id` (unique index) — lihat catatan di sana.
 * Ia dipertahankan lama hanya karena dokumentasi menyebutnya sebagai
 * lapisan dedup, sehingga `db verify` pun menguji constraint tabel mati.
 */

export const auditActorTypeEnum = pgEnum("audit_actor_type", [
  "user",
  "agent",
  "system",
  /** Pelaku = API key tenant lewat API publik /v1 (Fase 5A); actor_id = id baris api_keys. */
  "api_key",
]);

export const usageTypeEnum = pgEnum("usage_type", [
  "message",
  "ai_token",
  "contact",
]);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Boleh NULL untuk event tingkat sistem yang tidak terkait tenant. */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    /** Mis. 'message.received', 'payment.succeeded', 'contact.created'. */
    type: varchar("type", { length: 128 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** NULL = belum di-publish oleh relay. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /**
     * Berapa kali handler untuk event ini melempar (migrasi 0005). Relay
     * memakai ini untuk berhenti mengulang selamanya: satu event yang
     * selalu gagal tidak boleh menahan seluruh antrean.
     */
    attempts: integer("attempts").notNull().default(0),
    /** Pesan error terakhir dari handler (dipotong ±500 karakter). */
    lastError: text("last_error"),
    /**
     * Diisi saat relay MENYERAH setelah `OUTBOX_MAX_ATTEMPTS`. Baris
     * ber-isi tidak dipindai lagi, tetapi tetap ada sebagai bukti untuk
     * operator — bukan dihapus, bukan dianggap published.
     */
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbox_events_published_at_idx").on(t.publishedAt),
    index("outbox_events_tenant_id_idx").on(t.tenantId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * NULL = aksi tingkat PLATFORM (Fase 6C, mis. `platform_settings.*`),
     * bukan milik tenant mana pun. Kolom dibuat nullable di migrasi 0022;
     * baris platform hanya bisa ditulis/dibaca dalam transaksi ber-flag
     * `app.platform_settings='admin'` (policy `platform_audit`) dan tidak
     * pernah terlihat dari konteks tenant mana pun.
     */
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    actorType: auditActorTypeEnum("actor_type").notNull(),
    /** ID user / agent / komponen sistem yang melakukan aksi. */
    actorId: varchar("actor_id", { length: 255 }),
    /** Mis. 'agent.message_sent', 'contact.tagged', 'billing.subscription_changed'. */
    action: varchar("action", { length: 128 }).notNull(),
    /** Konteks bebas: prompt_version, model, tokens, ref id, dsb. */
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_tenant_id_idx").on(t.tenantId),
    index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: usageTypeEnum("type").notNull(),
    /** Jumlah unit: pesan terkirim, token, atau kontak baru. */
    qty: numeric("qty", { precision: 18, scale: 6 }).notNull(),
    /** Biaya model AI (LLM) untuk baris ini, dalam `currency`. */
    costModel: numeric("cost_model", { precision: 18, scale: 6 }).notNull().default("0"),
    /** Biaya provider (mis. tarif per-pesan WhatsApp, RANCANGAN §12.5) dalam `currency`. */
    costProvider: numeric("cost_provider", { precision: 18, scale: 6 })
      .notNull()
      .default("0"),
    currency: varchar("currency", { length: 3 }).notNull().default("IDR"),
    /** Referensi sumber, mis. refType='message', refId=<message uuid>. */
    refType: varchar("ref_type", { length: 64 }),
    refId: varchar("ref_id", { length: 255 }),
    /**
     * Rincian baris (Fase 9B): untuk type='ai_token' berisi
     * { agentId, provider, model, tokensIn, tokensOut, costUsd?,
     * costCurrency? }. Kolom `qty` tetap SUMBER total token (baris lama
     * pra-9B punya meta '{}' — rincian in/out, model, dan agent-nya
     * di-backfill dari meta audit `agent.responded`, lihat skrip
     * backfill:usage-meta). Biaya TIDAK memakai kolom cost_model
     * (mata uang baris = IDR): biaya aktual provider (OpenRouter)
     * berdenominasi USD dan hidup di meta.costUsd agar tidak tercampur.
     */
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // APPEND-ONLY: sengaja TIDAK ada updated_at.
  },
  (t) => [
    index("usage_ledger_tenant_id_idx").on(t.tenantId),
    index("usage_ledger_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const integrationDirectionEnum = pgEnum("integration_direction", [
  "in",
  "out",
]);

/**
 * Log integrasi (Fase 7B.1) — APPEND-ONLY, satu baris per hit webhook
 * (direction 'in') atau per percobaan kirim keluar poller (direction
 * 'out'). Kolom penjelas:
 *
 * - `tenantId` NULLABLE: hit yang tidak ter-resolve ke tenant mana pun
 *   (akun tak dikenal, tanda tangan buruk sebelum resolusi, handshake)
 *   tetap tercatat sebagai baris platform — hanya terlihat lewat flag
 *   platform-admin (policy `platform_integration_log`, pola 0022).
 * - `channelAccountId` / `messageId`: FK `ON DELETE SET NULL` — purge
 *   channel/pesan (Fase 6I) tidak menghapus sejarah log; barisnya tetap
 *   ada dengan ringkasan teksnya, tautannya saja yang lepas.
 * - `signatureValid`: hanya bermakna untuk direction 'in' (telegram:
 *   secret token; meta: HMAC-SHA256). NULL = tidak berlaku / belum bisa
 *   dinilai (mis. akun tak dikenal sehingga secret tak bisa dicek, atau
 *   arah 'out'). Nilai secret/tanda tangan TIDAK PERNAH disimpan — hanya
 *   boolean ini.
 * - `outcome`: teks terkendali (union di @sahabat-kreator/contracts &
 *   core/integration-log): in → recorded | duplicate |
 *   ignored_disconnected | ignored_echo | ignored_status_only |
 *   rejected_signature | rejected_unconfigured | unresolved_account |
 *   error; out → sent | failed.
 * - `payload`: payload webhook mentah (in) — DIBATASI ±32KB oleh penulis
 *   di core; payload yang lebih besar disimpan sebagai objek penanda
 *   `{ truncated: true, originalSize, preview }`. Untuk 'out' payload
 *   selalu NULL (isi pesan sudah ada di tabel messages; log cukup
 *   menunjuk messageId).
 */
export const integrationLog = pgTable(
  "integration_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    direction: integrationDirectionEnum("direction").notNull(),
    /** 'telegram' | 'messenger' | 'instagram' | 'whatsapp' | 'meta' (pra-rute). */
    provider: varchar("provider", { length: 32 }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    channelAccountId: uuid("channel_account_id").references(
      () => channelAccounts.id,
      { onDelete: "set null" },
    ),
    /** Hanya untuk direction 'out': pesan yang dicoba dikirim. */
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    signatureValid: boolean("signature_valid"),
    outcome: varchar("outcome", { length: 32 }).notNull(),
    /** Kode error provider/sistem yang aman (tanpa rahasia), mis. `meta_graph_131047`. */
    errorCode: varchar("error_code", { length: 128 }),
    /** Ringkasan pendek buatan server, mis. "text message from 62812…". */
    summary: varchar("summary", { length: 255 }),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // APPEND-ONLY: sengaja TIDAK ada updated_at.
  },
  (t) => [
    index("integration_log_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("integration_log_created_at_idx").on(t.createdAt),
    index("integration_log_channel_account_idx").on(t.channelAccountId),
  ],
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type UsageLedgerRow = typeof usageLedger.$inferSelect;
export type NewUsageLedgerRow = typeof usageLedger.$inferInsert;
export type IntegrationLogRow = typeof integrationLog.$inferSelect;
export type NewIntegrationLogRow = typeof integrationLog.$inferInsert;
