import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { contacts } from "./inbox";

/**
 * Koneksi iklan per tenant + ledger konversi (Gelombang G16, migrasi
 * 0039) — lihat header migrasi untuk keputusan lengkapnya.
 *
 * - `ad_connections`: SATU baris per tenant. Meta dataset ID + token
 *   CAPI milik tenant (token TERENKRIPSI envelope `v1:` pola
 *   channel-secrets; teks terang tidak pernah tersimpan/terbaca API/
 *   masuk log); Google Ads customer ID + conversion action ID —
 *   kredensial akses Google TIDAK di sini (OAuth layanan 'ads' di
 *   google_connections + developer token platform di Panel Admin).
 * - `ad_conversion_events`: satu baris per peristiwa konversi logis.
 *   UNIQUE (tenant_id, event_id) = dedup; event_id deterministik dari
 *   (run, node) flow. `user_data` HANYA hash SHA-256 pengenal.
 */
export const adConnections = pgTable(
  "ad_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Dataset (pixel) ID Meta milik tenant — identifier publik. */
    metaDatasetId: varchar("meta_dataset_id", { length: 64 }),
    /** Envelope terenkripsi access token Conversions API Meta. */
    metaAccessTokenEncrypted: text("meta_access_token_encrypted"),
    /** Kode peristiwa uji Meta (Events Manager → Test Events). */
    metaTestEventCode: varchar("meta_test_event_code", { length: 64 }),
    /** Customer ID Google Ads tenant (digit, boleh berstrip saat input). */
    googleCustomerId: varchar("google_customer_id", { length: 32 }),
    /** ID aksi konversi Google Ads tenant (bagian numerik resource name). */
    googleConversionActionId: varchar("google_conversion_action_id", {
      length: 32,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_connections_tenant_unique").on(t.tenantId),
    index("ad_connections_tenant_id_idx").on(t.tenantId),
  ],
);

export type AdPlatform = "meta" | "google";
export type AdConversionStatus = "queued" | "sent" | "failed" | "skipped";
export type AdConversionValueSource = "order" | "deal" | "static";

/** Hash pengenal yang dibawa satu peristiwa (TANPA nilai terang). */
export interface AdConversionUserData {
  /** SHA-256 hex email ternormalisasi (trim + lowercase). */
  emailHash?: string;
  /** SHA-256 hex telepon digit ternormalisasi (kode negara, tanpa +). */
  phoneHash?: string;
  /** SHA-256 hex telepon E.164 (+kode negara) untuk Google. */
  phoneE164Hash?: string;
  /** SHA-256 hex id kontak Botara (external_id Meta). */
  externalIdHash?: string;
}

export const adConversionEvents = pgTable(
  "ad_conversion_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Dedup lintas pengiriman ulang: deterministik dari (run, node). */
    eventId: varchar("event_id", { length: 128 }).notNull(),
    platform: varchar("platform", { length: 16 }).notNull(),
    eventName: varchar("event_name", { length: 128 }).notNull(),
    /** Jejak asal flow (tanpa FK — baris run bisa diprune lebih dulu). */
    flowId: uuid("flow_id"),
    flowRunId: uuid("flow_run_id"),
    nodeId: varchar("node_id", { length: 128 }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    value: numeric("value", { precision: 14, scale: 2 }),
    currency: varchar("currency", { length: 3 }),
    valueSource: varchar("value_source", { length: 16 }),
    userData: jsonb("user_data").$type<AdConversionUserData>(),
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    httpStatus: integer("http_status"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: varchar("error_message", { length: 500 }),
    /** Payload platform persis seperti terkirim (hash saja, tanpa token). */
    payload: jsonb("payload"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_conversion_events_tenant_event_unique").on(
      t.tenantId,
      t.eventId,
    ),
    index("ad_conversion_events_tenant_id_idx").on(t.tenantId),
    index("ad_conversion_events_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    check(
      "ad_conversion_events_platform_valid",
      sql`${t.platform} IN ('meta', 'google')`,
    ),
    check(
      "ad_conversion_events_status_valid",
      sql`${t.status} IN ('queued', 'sent', 'failed', 'skipped')`,
    ),
    check(
      "ad_conversion_events_value_source_valid",
      sql`${t.valueSource} IS NULL OR ${t.valueSource} IN ('order', 'deal', 'static')`,
    ),
  ],
);

export type AdConnectionRow = typeof adConnections.$inferSelect;
export type AdConversionEventRow = typeof adConversionEvents.$inferSelect;
