import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * Pengaturan tingkat PLATFORM (Fase 6C) — BUKAN tenant-scoped.
 *
 * `platform_settings`: nilai konfigurasi provider milik platform yang
 * dikelola pemilik platform lewat Panel Admin (mis. kunci OpenRouter &
 * kredensial R2). Nilai disimpan TERENKRIPSI AES-256-GCM (envelope `v1:`
 * yang sama dengan kredensial channel, Fase 6A) dengan kunci induk dari
 * env `PLATFORM_SETTINGS_SECRET` — DB tidak pernah memegang nilai mentah,
 * dan nilai tidak pernah dikembalikan API (hanya status isSet/sumber).
 *
 * RLS: ENABLE + fail-closed (migrasi 0022). Satu-satunya policy membuka
 * akses bila transaksi men-set flag transaction-local
 * `app.platform_settings = 'admin'` (pola system_relay 0008) — flag itu
 * hanya di-set helper core di dalam handler yang sudah lolos gerbang
 * platform-admin (allowlist env PLATFORM_ADMIN_EMAILS di lapisan API).
 */
export const platformSettings = pgTable("platform_settings", {
  /** Kunci yang dikelola, mis. 'openrouter_api_key', 'r2_secret_access_key'. */
  key: varchar("key", { length: 64 }).primaryKey(),
  /** Envelope terenkripsi `v1:<iv>.<tag>.<ciphertext>` — BUKAN nilai mentah. */
  valueEncrypted: text("value_encrypted").notNull(),
  /** User pemilik platform yang terakhir mengubah nilai ini. */
  updatedBy: uuid("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PlatformSettingRow = typeof platformSettings.$inferSelect;
export type NewPlatformSettingRow = typeof platformSettings.$inferInsert;
