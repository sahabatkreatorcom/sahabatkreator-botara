import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { contacts } from "./inbox";
import { orders } from "./products";

/**
 * Kelompok Kode Diskon & Penukaran (Gelombang G14 — Tier 3 butir 14
 * program adopsi, chat commerce):
 *
 * - discount_codes      : kode promo per tenant. `code` disimpan
 *   TERNORMALISASI huruf besar (core menormalkan saat tulis & baca)
 *   dan unik per tenant. `kind` = 'percent' (value 1..100) atau
 *   'fixed' (value = nominal Rupiah penuh). Commerce repo ini memang
 *   IDR-only (price_idr/total_idr di mana-mana), jadi kode nominal
 *   TIDAK membawa mata uang sendiri — ia mengikuti mata uang pesanan
 *   (IDR). Batas & jendela semua opsional: NULL = tanpa batas/tanpa
 *   jendela pada sisi itu (diwakili kolom nullable karena memang
 *   keadaan kondisional yang genuin).
 * - discount_redemptions: SATU baris per penukaran yang berhasil
 *   diklaim, lahir di dalam transaksi checkout yang sama dengan
 *   ordernya. `status` 'redeemed' selama order pending/paid;
 *   'released' (+ released_at) bila order berakhir expired/cancelled
 *   TANPA dibayar — kuota kode kembali bebas (keputusan G14: penukaran
 *   yang belum pernah dibayar belum mengonsumsi nilai apa pun, sama
 *   seperti tautan bayar yang kedaluwarsa tidak mengonsumsi stok).
 *   Batas kode dihitung dari baris berstatus 'redeemed' saja.
 *   `code` adalah snapshot teks kode (tetap terbaca walau baris kode
 *   diubah namanya... kode tidak bisa diganti namanya — PATCH menolak
 *   mengubah `code`; snapshot tetap disimpan agar riwayat mandiri).
 *
 * orders menerima dua kolom jejak (migrasi 0037): `discount_amount_idr`
 * (NOT NULL, bawaan 0) + `discount_code` snapshot (NULL bila tanpa
 * diskon) — total_idr tetap total FINAL sesudah diskon.
 *
 * Semua tabel tenant-scoped + RLS (migrasi 0037).
 */

export const discountCodes = pgTable(
  "discount_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Kode ternormalisasi HURUF BESAR (core yang menormalkan). */
    code: varchar("code", { length: 64 }).notNull(),
    /** 'percent' | 'fixed' — ditegakkan CHECK + kontrak zod. */
    kind: varchar("kind", { length: 16 }).notNull(),
    /** percent: 1..100; fixed: nominal Rupiah penuh > 0. */
    value: bigint("value", { mode: "number" }).notNull(),
    /** Subtotal minimum agar kode berlaku (Rupiah penuh); 0 = tanpa minimum. */
    minOrderIdr: bigint("min_order_idr", { mode: "number" })
      .notNull()
      .default(0),
    /** Batas TOTAL penukaran (baris 'redeemed'); NULL = tanpa batas. */
    maxRedemptions: integer("max_redemptions"),
    /** Batas penukaran per kontak; NULL = tanpa batas. */
    maxPerContact: integer("max_per_contact"),
    /** Jendela berlaku; NULL pada satu sisi = terbuka di sisi itu. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("discount_codes_tenant_id_idx").on(t.tenantId),
    uniqueIndex("discount_codes_tenant_code_unique").on(t.tenantId, t.code),
    check(
      "discount_codes_kind_valid",
      sql`${t.kind} IN ('percent', 'fixed')`,
    ),
    check("discount_codes_value_positive", sql`${t.value} > 0`),
    check(
      "discount_codes_min_order_nonnegative",
      sql`${t.minOrderIdr} >= 0`,
    ),
  ],
);

export const discountRedemptions = pgTable(
  "discount_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    discountCodeId: uuid("discount_code_id")
      .notNull()
      .references(() => discountCodes.id, { onDelete: "cascade" }),
    /** Order pemilik penukaran ini — tepat satu penukaran per order. */
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Snapshot teks kode saat penukaran. */
    code: varchar("code", { length: 64 }).notNull(),
    /** Jumlah diskon yang benar-benar diberikan (Rupiah penuh). */
    discountAmountIdr: bigint("discount_amount_idr", {
      mode: "number",
    }).notNull(),
    /** 'redeemed' | 'released' — ditegakkan CHECK + kontrak zod. */
    status: varchar("status", { length: 16 }).notNull().default("redeemed"),
    /** Terisi saat penukaran dilepas (order expired/cancelled). */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("discount_redemptions_tenant_id_idx").on(t.tenantId),
    index("discount_redemptions_code_idx").on(t.discountCodeId),
    index("discount_redemptions_contact_idx").on(t.tenantId, t.contactId),
    uniqueIndex("discount_redemptions_order_unique").on(t.orderId),
    check(
      "discount_redemptions_status_valid",
      sql`${t.status} IN ('redeemed', 'released')`,
    ),
    check(
      "discount_redemptions_amount_nonnegative",
      sql`${t.discountAmountIdr} >= 0`,
    ),
  ],
);

export type DiscountCode = typeof discountCodes.$inferSelect;
export type NewDiscountCode = typeof discountCodes.$inferInsert;
export type DiscountRedemption = typeof discountRedemptions.$inferSelect;
export type NewDiscountRedemption = typeof discountRedemptions.$inferInsert;
