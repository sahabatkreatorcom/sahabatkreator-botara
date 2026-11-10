import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
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

/**
 * Admin platform yang dikelola dari panel (migrasi 0011). Env
 * `PLATFORM_ADMIN_EMAILS` TETAP berlaku sebagai bootstrap/darurat dan tidak
 * disalin ke sini — jadi mencabut semua baris panel tidak pernah mengunci
 * sistem selama env masih terisi.
 *
 * Tidak ber-RLS (global), sama seperti `users`: yang menjaganya adalah
 * gerbang API. `added_by` ON DELETE SET NULL supaya jejak tetap ada walau
 * akun yang menambahkan sudah dihapus.
 */
export const platformAdmins = pgTable("platform_admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  addedBy: uuid("added_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Satu baris per eksekusi backup/drill (migrasi 0011). Ditulis skrip cron
 * di host, dibaca panel lewat API. Sengaja TIDAK ada status bawaan "sukses":
 * tanpa baris, panel harus berkata "belum ada catatan".
 */
export const backupRuns = pgTable(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'daily' | 'drill'. */
    kind: varchar("kind", { length: 16 }).notNull(),
    /** 'ok' | 'failed'. */
    status: varchar("status", { length: 16 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    detail: varchar("detail", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("backup_runs_kind_created_idx").on(t.kind, t.createdAt)],
);

export type PlatformAdminRow = typeof platformAdmins.$inferSelect;
export type BackupRunRow = typeof backupRuns.$inferSelect;
