import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { contacts, conversations } from "./inbox";

/**
 * Kelompok Produk & Tautan Bayar (Fase 4A, RANCANGAN §6 & §9):
 * - products      : katalog produk digital milik tenant (segmen pertama:
 *                   kreator produk digital & course). `price_idr` adalah
 *                   harga dalam Rupiah penuh (bigint, tanpa sen) dan
 *                   TIDAK boleh negatif (check constraint di DB).
 * - payment_links : satu tautan bayar untuk satu produk (+ opsional kontak
 *                   & percakapan asal). `amount_idr` adalah SNAPSHOT harga
 *                   produk saat tautan dibuat — mengubah harga produk tidak
 *                   mengubah tautan yang sudah beredar. `code` adalah
 *                   kredensial publik tautan (`pay_...`), sama seperti
 *                   siteKey webchat: dirancang untuk disebar ke pembeli.
 *                   `provider` adalah gerbang pembayaran tautan —
 *                   'simulation' sampai Fase 13F; sejak Fase 14A juga
 *                   'midtrans'/'xendit' sungguhan sesuai konfigurasi
 *                   provider tenant (payment_provider_configs), dan
 *                   halaman /pay hanya berlabel simulasi untuk provider
 *                   'simulation'.
 * Semua tabel tenant-scoped: tenant_id + index, dilindungi RLS (migrasi
 * 0012 — termasuk lengan SELECT sempit `app.payment_code` pada
 * payment_links agar halaman bayar publik bisa me-resolve code → tenant,
 * meniru pola siteKey webchat migrasi 0006).
 *
 * Fase 13F menambah kelompok Keranjang & Order di berkas yang sama
 * (carts, cart_items, orders, order_items — lihat seksi di bawah) dan
 * menjadikan payment_links dwivarian: tautan produk tunggal ATAU
 * tautan order, ditegakkan CHECK eksklusif.
 */

export const paymentLinkStatusEnum = pgEnum("payment_link_status", [
  "pending",
  "paid",
  "expired",
  "cancelled",
]);

/** Status keranjang (Fase 13F): open = sedang diisi; checked_out = sudah
 * menjadi order; abandoned = ditinggalkan (lipatan merge kontak 9B). */
export const cartStatusEnum = pgEnum("cart_status", [
  "open",
  "checked_out",
  "abandoned",
]);

/** Status order (Fase 13F) — cermin status tautan bayarnya. */
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "expired",
  "cancelled",
]);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    /** Harga dalam Rupiah penuh (mode number: aman sampai 2^53). */
    priceIdr: bigint("price_idr", { mode: "number" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("products_tenant_id_idx").on(t.tenantId),
    index("products_tenant_active_idx").on(t.tenantId, t.isActive),
    check("products_price_idr_nonnegative", sql`${t.priceIdr} >= 0`),
  ],
);

export const paymentLinks = pgTable(
  "payment_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * Produk yang dibayar — WAJIB terisi untuk tautan produk tunggal,
     * NULL untuk tautan order (Fase 13F). Pasangan eksklusif dengan
     * `order_id` ditegakkan CHECK `payment_links_exactly_one_target`:
     * tepat satu dari keduanya terisi. Nullable di sini adalah keadaan
     * kondisional varian tautan, bukan field yang "boleh kosong".
     */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    /** Order yang dibayar tautan ini (Fase 13F) — lihat `product_id`. */
    orderId: uuid("order_id").references(() => orders.id, {
      onDelete: "cascade",
    }),
    /** Kontak pembeli bila tautan dibuat untuk kontak tertentu. */
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /** Percakapan asal bila tautan dibuat dari dalam percakapan/agent. */
    conversationId: uuid("conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    /** Kredensial publik tautan: `pay_` + 16 karakter acak. */
    code: varchar("code", { length: 64 }).notNull(),
    /** Snapshot harga produk saat tautan dibuat (Rupiah penuh). */
    amountIdr: bigint("amount_idr", { mode: "number" }).notNull(),
    status: paymentLinkStatusEnum("status").notNull().default("pending"),
    /** Gerbang pembayaran tautan: 'simulation' | 'midtrans' | 'xendit' (Fase 14A). */
    provider: varchar("provider", { length: 32 }).notNull().default("simulation"),
    /**
     * Environment provider saat tautan dibuat (Fase 14A): 'sandbox' |
     * 'production'. Snapshot per tautan — mengganti environment tenant
     * sesudahnya tidak menulis ulang tautan yang sudah beredar (sama
     * seperti snapshot harga). Untuk 'simulation' selalu 'sandbox'.
     */
    providerEnvironment: varchar("provider_environment", { length: 16 })
      .notNull()
      .default("sandbox"),
    /**
     * Referensi transaksi di provider (Fase 14A): token Snap Midtrans /
     * id invoice Xendit. NULL untuk simulasi dan untuk tautan warisan
     * pra-14A — referensi hanya ada bila provider sungguhan membuatnya.
     */
    providerRef: varchar("provider_ref", { length: 255 }),
    /**
     * URL checkout provider (Fase 14A): redirect_url Snap / invoice_url
     * Xendit. Halaman /pay/:code mengarahkan pembeli ke sini. NULL untuk
     * simulasi (halaman membayar di tempat).
     */
    checkoutUrl: text("checkout_url"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Kedaluwarsa default 7 hari sejak dibuat (di-set service, bukan DB default). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("payment_links_tenant_id_idx").on(t.tenantId),
    index("payment_links_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("payment_links_product_idx").on(t.productId),
    index("payment_links_order_idx").on(t.orderId),
    index("payment_links_contact_id_idx").on(t.contactId),
    index("payment_links_conversation_id_idx").on(t.conversationId),
    uniqueIndex("payment_links_code_unique").on(t.code),
    check("payment_links_amount_idr_nonnegative", sql`${t.amountIdr} >= 0`),
    check(
      "payment_links_exactly_one_target",
      sql`(${t.productId} IS NOT NULL) <> (${t.orderId} IS NOT NULL)`,
    ),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type PaymentLink = typeof paymentLinks.$inferSelect;
export type NewPaymentLink = typeof paymentLinks.$inferInsert;

// ---------------------------------------------------------------------------
// Keranjang & Order (Fase 13F — katalog + keranjang commerce)
//
// - carts       : keranjang belanja per (tenant, kontak). Tepat SATU
//                 keranjang `open` per kontak ditegakkan partial unique
//                 index `carts_one_open_per_contact`; keranjang yang
//                 sudah checkout/ ditinggalkan tetap tersimpan sebagai
//                 riwayat sesi (baris tidak dihapus saat checkout).
// - cart_items  : baris item sebagai TABEL (bukan jsonb): item perlu
//                 dirujuk per produk (gabung nama produk untuk tampilan,
//                 lipatan merge kontak 9B, unik per produk dalam satu
//                 keranjang). `unit_price_idr` adalah SNAPSHOT harga
//                 produk saat item PERTAMA ditambahkan ke keranjang —
//                 perubahan harga produk sesudahnya tidak menulis ulang
//                 keranjang (aturan yang sama seperti snapshot
//                 payment_links di atas).
// - orders      : order yang lahir saat checkout. Total DIHITUNG server
//                 dari snapshot cart_items (bukan dari harga produk
//                 berjalan). `payment_link_id` menunjuk tautan bayar
//                 tunggal order ini — kolom uuid TANPA FK karena arah
//                 referensi kanonisnya adalah `payment_links.order_id`
//                 (FK sebaliknya akan melingkar); diisi dalam transaksi
//                 checkout yang sama. Status order mengikuti status
//                 tautan bayarnya lewat hook penyelesaian pembayaran.
// - order_items : snapshot item order (nama + harga + qty saat checkout)
//                 — riwayat order tidak berubah walau produk diubah/
//                 dihapus (`product_id` SET NULL, nama snapshot kekal).
// Aturan NOT NULL (instruksi user 2026-11-03): semua field semantik
// wajib NOT NULL; yang nullable hanya keadaan genuin kondisional —
// `orders.conversation_id` (order bisa lahir di luar percakapan),
// `orders.paid_at` (belum tentu pernah dibayar), `orders.payment_link_id`
// (diisi sesudah tautan dibuat dalam transaksi yang sama),
// `order_items.product_id` (produk bisa dihapus sesudah checkout),
// dan pasangan varian `payment_links.product_id`/`order_id` di atas.
// Semua tabel tenant-scoped + RLS (blok [K-13F] di migrasi fase ini).
// ---------------------------------------------------------------------------

export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: cartStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("carts_tenant_id_idx").on(t.tenantId),
    index("carts_contact_idx").on(t.tenantId, t.contactId),
    uniqueIndex("carts_one_open_per_contact")
      .on(t.tenantId, t.contactId)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull(),
    /** Snapshot harga produk saat item pertama ditambahkan (Rupiah penuh). */
    unitPriceIdr: bigint("unit_price_idr", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("cart_items_tenant_id_idx").on(t.tenantId),
    index("cart_items_cart_idx").on(t.cartId),
    uniqueIndex("cart_items_cart_product_unique").on(t.cartId, t.productId),
    check("cart_items_qty_positive", sql`${t.qty} > 0`),
    check(
      "cart_items_unit_price_nonnegative",
      sql`${t.unitPriceIdr} >= 0`,
    ),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Percakapan asal checkout; null bila order lahir di luar percakapan. */
    conversationId: uuid("conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    status: orderStatusEnum("status").notNull().default("pending"),
    /** Total snapshot keranjang saat checkout — dihitung server (Rupiah penuh). */
    totalIdr: bigint("total_idr", { mode: "number" }).notNull(),
    /**
     * Tautan bayar tunggal order ini. TANPA FK (lihat catatan kelompok):
     * arah referensi kanonis adalah payment_links.order_id.
     */
    paymentLinkId: uuid("payment_link_id"),
    /** Terisi saat pembayaran order selesai; null selama belum dibayar. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("orders_tenant_id_idx").on(t.tenantId),
    index("orders_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("orders_contact_idx").on(t.contactId),
    check("orders_total_idr_nonnegative", sql`${t.totalIdr} >= 0`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Produk asal; SET NULL bila produk dihapus — snapshot nama/harga kekal. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /** Snapshot nama produk saat checkout. */
    productName: varchar("product_name", { length: 255 }).notNull(),
    qty: integer("qty").notNull(),
    /** Snapshot harga satuan dari cart_items (Rupiah penuh). */
    unitPriceIdr: bigint("unit_price_idr", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("order_items_tenant_id_idx").on(t.tenantId),
    index("order_items_order_idx").on(t.orderId),
    check("order_items_qty_positive", sql`${t.qty} > 0`),
    check(
      "order_items_unit_price_nonnegative",
      sql`${t.unitPriceIdr} >= 0`,
    ),
  ],
);

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;
export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
