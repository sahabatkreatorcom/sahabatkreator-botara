import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";

/**
 * Konfigurasi gerbang pembayaran per tenant (Fase 14A — Midtrans/Xendit
 * menggantikan simulasi sebagai provider hidup).
 *
 * Keputusan yang dijaga di sini:
 * - Kredensial adalah milik TENANT (kreator menerima uangnya sendiri ke
 *   akun merchant-nya sendiri) — BUKAN Panel Admin platform. Satu baris
 *   per tenant (unique tenant_id); baris lahir malas dari service dengan
 *   provider 'simulation' + environment 'sandbox' sebagai default aman.
 * - Kunci sandbox dan production disimpan TERPISAH (empat pasang kolom):
 *   toggle environment memilih pasangan yang aktif; tidak ada penimpaan
 *   silang. Semua kolom kunci adalah ENVELOPE terenkripsi AES-256-GCM
 *   (pola channel-secrets `v1:...`, kunci env CHANNEL_TOKEN_SECRET) —
 *   teks terang tidak pernah tersimpan, terbaca API, atau masuk log.
 * - Kolom kunci NULLABLE secara genuin kondisional: pasangan environment
 *   yang belum diisi memang belum ada; pasangan yang aktif tapi kosong
 *   ditolak di service (NOT_CONFIGURED), bukan di DB.
 * - Token callback Xendit diperlakukan sama seperti server key
 *   (terenkripsi, per environment) karena ia adalah kredensial
 *   verifikasi webhook penuh.
 * - CHECK menjaga nilai provider/environment tetap di himpunan sah
 *   walau ada penulis SQL liar.
 * Tabel tenant-scoped + RLS tenant_isolation (blok [K-14A] di migrasi).
 */
export const paymentProviderConfigs = pgTable(
  "payment_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Provider aktif tenant: 'simulation' | 'midtrans' | 'xendit'. */
    provider: varchar("provider", { length: 32 })
      .notNull()
      .default("simulation"),
    /** Environment aktif: 'sandbox' | 'production'. */
    environment: varchar("environment", { length: 16 })
      .notNull()
      .default("sandbox"),
    /** Envelope terenkripsi server key Midtrans (sandbox). */
    midtransSandboxServerKeyEncrypted: text(
      "midtrans_sandbox_server_key_encrypted",
    ),
    midtransSandboxClientKeyEncrypted: text(
      "midtrans_sandbox_client_key_encrypted",
    ),
    midtransProductionServerKeyEncrypted: text(
      "midtrans_production_server_key_encrypted",
    ),
    midtransProductionClientKeyEncrypted: text(
      "midtrans_production_client_key_encrypted",
    ),
    xenditSandboxServerKeyEncrypted: text(
      "xendit_sandbox_server_key_encrypted",
    ),
    xenditSandboxClientKeyEncrypted: text(
      "xendit_sandbox_client_key_encrypted",
    ),
    xenditProductionServerKeyEncrypted: text(
      "xendit_production_server_key_encrypted",
    ),
    xenditProductionClientKeyEncrypted: text(
      "xendit_production_client_key_encrypted",
    ),
    /** Envelope terenkripsi token callback webhook Xendit (per environment). */
    xenditSandboxCallbackTokenEncrypted: text(
      "xendit_sandbox_callback_token_encrypted",
    ),
    xenditProductionCallbackTokenEncrypted: text(
      "xendit_production_callback_token_encrypted",
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_provider_configs_tenant_unique").on(t.tenantId),
    index("payment_provider_configs_tenant_id_idx").on(t.tenantId),
    check(
      "payment_provider_configs_provider_valid",
      sql`${t.provider} IN ('simulation', 'midtrans', 'xendit')`,
    ),
    check(
      "payment_provider_configs_environment_valid",
      sql`${t.environment} IN ('sandbox', 'production')`,
    ),
  ],
);

export type PaymentProviderConfig = typeof paymentProviderConfigs.$inferSelect;
export type NewPaymentProviderConfig =
  typeof paymentProviderConfigs.$inferInsert;
