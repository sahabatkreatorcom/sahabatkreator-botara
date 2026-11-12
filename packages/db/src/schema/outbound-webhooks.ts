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
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { users } from "./identity";

/**
 * Webhook KELUAR tenant (Gelombang G11, Tier 2 butir 10 program
 * adopsi): tenant mendaftarkan endpoint HTTPS miliknya dan Botara
 * meneruskan peristiwa internal (outbox) yang dilanggan ke endpoint
 * itu sebagai POST JSON tertandatangani HMAC-SHA256.
 *
 * - `outbound_webhook_endpoints`: satu endpoint per baris. Rahasia
 *   penanda tangan disimpan TERENKRIPSI (envelope AES-256-GCM
 *   CHANNEL_TOKEN_SECRET, pola channel-secrets) — nilai terang hanya
 *   ditampilkan SATU KALI pada respons pembuatan. `status` menjadi
 *   'disabled' secara manual oleh tenant atau OTOMATIS sesudah
 *   ambang kegagalan beruntun (disabled_reason mencatat sebabnya).
 * - `outbound_webhook_deliveries`: log pengiriman per (endpoint,
 *   peristiwa) — satu baris per upaya logis, `attempts` menghitung
 *   percobaan HTTP di dalam baris itu. UNIQUE (endpoint_id,
 *   source_event_id) adalah kunci idempotensi fan-out relay: event
 *   outbox yang sama tidak pernah melahirkan dua pengiriman ke
 *   endpoint yang sama. Percobaan ulang dijadwalkan lewat
 *   `next_attempt_at` dan diproses penyapu worker (policy baca
 *   `system_outbound_webhook_scan`, meniru pola penyapu broadcast).
 */
export const outboundWebhookEndpointStatusEnum = pgEnum(
  "outbound_webhook_endpoint_status",
  ["active", "disabled"],
);

export const outboundWebhookDeliveryStatusEnum = pgEnum(
  "outbound_webhook_delivery_status",
  ["pending", "delivered", "failed"],
);

export const outboundWebhookEndpoints = pgTable(
  "outbound_webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Label buatan tenant untuk membedakan endpoint di daftar. */
    name: varchar("name", { length: 255 }).notNull(),
    /** URL HTTPS tujuan (lolos validasi anti-SSRF saat simpan & kirim). */
    url: text("url").notNull(),
    /** Peristiwa yang dilanggan (subset katalog OUTBOUND_WEBHOOK_EVENT_TYPES). */
    events: jsonb("events").notNull().default([]).$type<string[]>(),
    /** Envelope `v1:...` dari encryptChannelSecret — BUKAN nilai terang. */
    secretEncrypted: text("secret_encrypted").notNull(),
    status: outboundWebhookEndpointStatusEnum("status")
      .notNull()
      .default("active"),
    /** Pengiriman GAGAL FINAL beruntun; keberhasilan meng-nol-kan. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Sebab nonaktif terakhir: 'manual' | 'consecutive_failures' | null. */
    disabledReason: varchar("disabled_reason", { length: 64 }),
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
  (table) => [
    index("outbound_webhook_endpoints_tenant_id_idx").on(table.tenantId),
    index("outbound_webhook_endpoints_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
  ],
);

export const outboundWebhookDeliveries = pgTable(
  "outbound_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => outboundWebhookEndpoints.id, { onDelete: "cascade" }),
    /** Jenis peristiwa: katalog outbox ('message.received', …) atau 'ping' (uji manual). */
    eventType: varchar("event_type", { length: 64 }).notNull(),
    /**
     * Id event outbox sumber; NULL untuk peristiwa uji manual.
     * TANPA FK: baris outbox diretensi 7 hari, log pengiriman adalah
     * jejak yang harus hidup lebih lama dari sumbernya.
     */
    sourceEventId: uuid("source_event_id"),
    /** Badan JSON PERSIS seperti yang dikirim (objek envelope peristiwa). */
    payload: jsonb("payload").notNull(),
    status: outboundWebhookDeliveryStatusEnum("status")
      .notNull()
      .default("pending"),
    /** Jumlah percobaan HTTP yang sudah dilakukan untuk baris ini. */
    attempts: integer("attempts").notNull().default(0),
    /** Jadwal percobaan berikutnya; NULL = tidak ada percobaan terjadwal. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** Kode status HTTP percobaan terakhir; NULL bila gagal jaringan. */
    lastStatusCode: integer("last_status_code"),
    /** Ringkasan kesalahan percobaan terakhir (aman, ≤500 char). */
    lastError: varchar("last_error", { length: 500 }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("outbound_webhook_deliveries_tenant_id_idx").on(table.tenantId),
    index("outbound_webhook_deliveries_endpoint_created_idx").on(
      table.endpointId,
      table.createdAt,
    ),
    // Indeks pemindaian penyapu percobaan ulang: pengiriman jatuh tempo.
    index("outbound_webhook_deliveries_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.nextAttemptAt} IS NOT NULL`),
    // KUNCI IDEMPOTENSI fan-out: satu event outbox → ≤1 pengiriman per endpoint.
    uniqueIndex("outbound_webhook_deliveries_endpoint_event_unique")
      .on(table.endpointId, table.sourceEventId)
      .where(sql`${table.sourceEventId} IS NOT NULL`),
  ],
);

export type OutboundWebhookEndpoint =
  typeof outboundWebhookEndpoints.$inferSelect;
export type OutboundWebhookDelivery =
  typeof outboundWebhookDeliveries.$inferSelect;
