import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { plans, users } from "./identity";

/**
 * Tabel tenant & keanggotaan. Semua tabel di file ini (kecuali `tenants`
 * itu sendiri) adalah tenant-scoped: punya tenant_id + index, dan dilindungi
 * Row Level Security (lihat migrations/0001_rls_tenant_isolation.sql).
 */

export const memberRoleEnum = pgEnum("member_role", [
  "owner",
  "admin",
  "agent",
  "viewer",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
]);

/**
 * Status workspace (migrasi 0010). `suspended` = ditangguhkan admin platform:
 * seluruh route bersarang menjawab 404 karena `getTenantForUser` menolak
 * tenant non-aktif. Datanya TIDAK dihapus — penangguhan harus selalu bisa
 * dibatalkan tanpa memulihkan backup.
 */
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 128 }).notNull().unique(),
  defaultLocale: varchar("default_locale", { length: 10 }).notNull().default("en"),
  timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Jakarta"),
  /**
   * Mata uang bawaan AKUN (G12, pola wacrm 021 `accounts.default_currency`):
   * dipakai sebagai mata uang deal baru (UI papan + aksi otomasi
   * create_deal); tiap deal menyimpan mata uangnya sendiri sesudah
   * dibuat. Bawaan 'IDR' — produk ini Indonesia-first; format ditegakkan
   * CHECK di migrasi 0035 (^[A-Z]{3}$).
   */
  defaultCurrency: varchar("default_currency", { length: 3 })
    .notNull()
    .default("IDR"),
  status: tenantStatusEnum("status").notNull().default("active"),
  /** Alasan penangguhan yang diketik admin — dibaca pemilik saat mengajukan banding. */
  statusReason: text("status_reason"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantMembers = pgTable(
  "tenant_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_members_tenant_user_unique").on(t.tenantId, t.userId),
    index("tenant_members_tenant_id_idx").on(t.tenantId),
    index("tenant_members_user_id_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: memberRoleEnum("role").notNull().default("agent"),
    /** Hanya HASH token undangan yang disimpan, bukan token mentahnya. */
    tokenHash: varchar("token_hash", { length: 255 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /**
     * Pencabutan undangan (Fase 9C): diisi saat owner/admin mencabut
     * undangan yang masih pending; undangan yang dicabut tidak bisa
     * diterima lagi. Status turunan: pending = accepted_at NULL &
     * revoked_at NULL & expires_at > now(); selain itu terminal.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Pengiriman email undangan (Fase 11B, Resend): waktu email benar-
     * benar terkirim oleh job `team.invitation_email`. NULL = belum
     * terkirim (belum diantrekan / masih retry / tidak terkonfigurasi).
     */
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    /**
     * Ringkasan kegagalan kirim terakhir (Fase 11B): kode provider +
     * pesan singkat terpotong — TIDAK PERNAH berisi token atau isi
     * email. Dikosongkan lagi saat kirim berhasil.
     */
    emailError: varchar("email_error", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invitations_tenant_id_idx").on(t.tenantId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 128 }).notNull(),
    /** Hash (mis. SHA-256) dari API key lengkap; key mentah hanya ditampilkan sekali saat dibuat. */
    keyHash: varchar("key_hash", { length: 255 }).notNull().unique(),
    /**
     * Awalan tampil kunci (Fase 5A), mis. `sk_live_ab12` — cukup untuk
     * mengenali kunci di daftar dashboard TANPA menyimpan kunci mentah.
     * Kunci lama (pra-5A) bernilai '' dan ditampilkan sebagai awalan kosong.
     */
    keyPrefix: varchar("key_prefix", { length: 16 }).notNull().default(""),
    /** Scope terbatas, mis. ['contacts:read', 'messages:write'] (RANCANGAN §5.4). */
    scopes: text("scopes").array().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_keys_tenant_id_idx").on(t.tenantId)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscriptions_tenant_id_idx").on(t.tenantId)],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantMember = typeof tenantMembers.$inferSelect;
export type NewTenantMember = typeof tenantMembers.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
