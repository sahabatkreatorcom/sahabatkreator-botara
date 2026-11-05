import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Tabel autentikasi milik Better Auth (RANCANGAN §7) — dikelola oleh
 * Better Auth lewat Drizzle adapter di apps/api (email + password, sesi
 * cookie httpOnly).
 *
 * Tabel-tabel ini TERPISAH dari tabel `users` kita: Better Auth memakai
 * id berupa teks, sedangkan sumber kebenaran workspace (member, role,
 * tenant) adalah tabel Fase 1A. Penghubungnya kolom `auth_user_id`
 * di tabel `users` (lihat schema/identity.ts).
 *
 * Penamaan kolom mengikuti model standar Better Auth (user/session/
 * account/verification) agar Drizzle adapter dapat memetakannya langsung.
 */

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_session_user_id_idx").on(t.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** Hash password untuk provider 'credential' (email+password) — di-hash oleh Better Auth. */
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_account_user_id_idx").on(t.userId)],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);

export type AuthUser = typeof authUser.$inferSelect;
export type NewAuthUser = typeof authUser.$inferInsert;
export type AuthSession = typeof authSession.$inferSelect;
export type NewAuthSession = typeof authSession.$inferInsert;
export type AuthAccount = typeof authAccount.$inferSelect;
export type NewAuthAccount = typeof authAccount.$inferInsert;
export type AuthVerification = typeof authVerification.$inferSelect;
export type NewAuthVerification = typeof authVerification.$inferInsert;
