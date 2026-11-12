-- 0037_discount_codes.sql
--
-- Gelombang G14 (Tier 3 butir 14 program adopsi — chat commerce):
-- KODE DISKON & PENUKARAN. E-commerce (produk/keranjang/pesanan/
-- tautan bayar Midtrans/Xendit) sudah live sejak Fase 13F/14A; yang
-- belum ada hanya kode diskon + penukarannya.
--
-- Hasil audit permukaan (jujur soal titik terapan):
-- - SATU-SATUNYA jalur checkout yang melahirkan ORDER adalah node
--   flow `cart_checkout` (keranjang per kontak → order + snapshot +
--   SATU tautan bayar yang jumlahnya = total order). Kode diskon
--   diterapkan DI SINI: diskon dihitung dari subtotal snapshot,
--   tercatat di order, dan tautan bayar lahir dengan total SESUDAH
--   diskon (sesi provider sungguhan disiapkan dari total yang sama).
-- - Tautan bayar produk tunggal (createPaymentLink) TIDAK menerima
--   kode: jumlahnya snapshot harga produk satu langkah, tidak ada
--   order/subtotal tempat diskon dicatat — kotak kode di sana akan
--   jadi janji palsu.
-- - Halaman publik /pay/:code TIDAK menerima kode: jumlah + sesi
--   provider sudah terkunci saat tautan dibuat.
--
-- Yang dibangun migrasi ini:
-- - `discount_codes`: kode per tenant, `code` ternormalisasi HURUF
--   BESAR + unik per tenant; kind 'percent' (value 1..100) / 'fixed'
--   (value nominal Rupiah — commerce repo ini IDR-only, jadi kode
--   mengikuti mata uang pesanan, tanpa kolom mata uang sendiri);
--   min_order_idr, max_redemptions, max_per_contact, jendela
--   starts_at/ends_at (NULL = terbuka), is_active.
-- - `discount_redemptions`: satu baris per penukaran yang diklaim di
--   dalam transaksi checkout (UNIQUE order_id — satu penukaran per
--   order). status 'redeemed' selama order pending/paid; 'released'
--   bila order berakhir expired/cancelled tanpa dibayar → kuota
--   kembali bebas (keputusan G14: yang belum dibayar belum
--   mengonsumsi nilai; batas dihitung dari baris 'redeemed' saja).
-- - `orders.discount_amount_idr` (NOT NULL bawaan 0) +
--   `discount_code` snapshot + `discount_code_id` penunjuk tanpa FK
--   (pola payment_link_id). total_idr tetap total FINAL.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()). Dua tabel baru →
-- hitungan db verify naik 77 → 79 tabel, 104 → 106 policy.

-- ---------------------------------------------------------------------------
-- orders: jejak diskon
-- ---------------------------------------------------------------------------

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "discount_amount_idr" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "discount_code" varchar(64);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "discount_code_id" uuid;

-- ---------------------------------------------------------------------------
-- discount_codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "discount_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "code" varchar(64) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "value" bigint NOT NULL,
  "min_order_idr" bigint DEFAULT 0 NOT NULL,
  "max_redemptions" integer,
  "max_per_contact" integer,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "discount_codes" DROP CONSTRAINT IF EXISTS "discount_codes_tenant_id_tenants_id_fk";
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "discount_codes" DROP CONSTRAINT IF EXISTS "discount_codes_kind_valid";
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_kind_valid"
  CHECK ("kind" IN ('percent', 'fixed'));

ALTER TABLE "discount_codes" DROP CONSTRAINT IF EXISTS "discount_codes_value_positive";
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_value_positive"
  CHECK ("value" > 0);

ALTER TABLE "discount_codes" DROP CONSTRAINT IF EXISTS "discount_codes_min_order_nonnegative";
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_min_order_nonnegative"
  CHECK ("min_order_idr" >= 0);

CREATE INDEX IF NOT EXISTS "discount_codes_tenant_id_idx" ON "discount_codes" ("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "discount_codes_tenant_code_unique" ON "discount_codes" ("tenant_id", "code");

ALTER TABLE "discount_codes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "discount_codes";
CREATE POLICY "tenant_isolation" ON "discount_codes"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- ---------------------------------------------------------------------------
-- discount_redemptions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "discount_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "discount_code_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "contact_id" uuid NOT NULL,
  "code" varchar(64) NOT NULL,
  "discount_amount_idr" bigint NOT NULL,
  "status" varchar(16) DEFAULT 'redeemed' NOT NULL,
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "discount_redemptions" DROP CONSTRAINT IF EXISTS "discount_redemptions_tenant_id_tenants_id_fk";
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "discount_redemptions" DROP CONSTRAINT IF EXISTS "discount_redemptions_discount_code_id_discount_codes_id_fk";
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_discount_code_id_discount_codes_id_fk"
  FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes"("id") ON DELETE cascade;

ALTER TABLE "discount_redemptions" DROP CONSTRAINT IF EXISTS "discount_redemptions_order_id_orders_id_fk";
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_order_id_orders_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE cascade;

ALTER TABLE "discount_redemptions" DROP CONSTRAINT IF EXISTS "discount_redemptions_contact_id_contacts_id_fk";
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_contact_id_contacts_id_fk"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE cascade;

ALTER TABLE "discount_redemptions" DROP CONSTRAINT IF EXISTS "discount_redemptions_status_valid";
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_status_valid"
  CHECK ("status" IN ('redeemed', 'released'));

ALTER TABLE "discount_redemptions" DROP CONSTRAINT IF EXISTS "discount_redemptions_amount_nonnegative";
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_amount_nonnegative"
  CHECK ("discount_amount_idr" >= 0);

CREATE INDEX IF NOT EXISTS "discount_redemptions_tenant_id_idx" ON "discount_redemptions" ("tenant_id");
CREATE INDEX IF NOT EXISTS "discount_redemptions_code_idx" ON "discount_redemptions" ("discount_code_id");
CREATE INDEX IF NOT EXISTS "discount_redemptions_contact_idx" ON "discount_redemptions" ("tenant_id", "contact_id");
CREATE UNIQUE INDEX IF NOT EXISTS "discount_redemptions_order_unique" ON "discount_redemptions" ("order_id");

ALTER TABLE "discount_redemptions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "discount_redemptions";
CREATE POLICY "tenant_isolation" ON "discount_redemptions"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
