import {
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Tabel global (tanpa tenant_id, tanpa RLS): users & plans.
 * Lihat docs/RANCANGAN-v3.md §6 — Identity & Tenant.
 */

export const userThemeEnum = pgEnum("user_theme", ["system", "light", "dark"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  /**
   * Penghubung ke tabel Better Auth `auth_user` (Fase 1B): id teks milik
   * Better Auth. NULL untuk user yang dibuat tanpa jalur auth (seed/sistem).
   * Sumber kebenaran workspace tetap tabel ini; autentikasi milik Better Auth.
   */
  authUserId: text("auth_user_id").unique(),
  name: varchar("name", { length: 255 }),
  /** Bahasa UI pengguna: default & fallback aplikasi adalah 'en' (RANCANGAN §11). */
  locale: varchar("locale", { length: 10 }).notNull().default("en"),
  /** Preferensi tema: system | light | dark (RANCANGAN §10.3). */
  theme: userThemeEnum("theme").notNull().default("system"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Kode paket stabil, mis. 'free' | 'pro' | 'business'. */
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  /** Batas paket: { contacts, messagesPerMonth, aiTokensPerMonth, channels, ... } */
  limits: jsonb("limits").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
