-- 0039_ad_conversions.sql
--
-- Gelombang G16 (Tier 3 butir 16 program adopsi): KONVERSI IKLAN DARI
-- FLOW — node flow `send_ad_conversion` mengirim peristiwa konversi ke
-- platform iklan tenant (Meta Conversions API + Google Ads) saat flow
-- mencapai titik tertentu (prospek masuk, deal menang, pesanan lunas).
--
-- Yang dibangun migrasi ini:
-- - Enum `google_service` += 'ads': koneksi OAuth Google PER LAYANAN
--   bertambah satu layanan mandiri (scope `adwords` saja) untuk
--   Google Ads — menumpang mesin pemisahan Google migrasi 0023 persis
--   (consent sendiri, baris google_connections sendiri, callback
--   kanonis /api/oauth/google_ads/callback). Token layanan lain
--   (calendar/youtube/business) TIDAK bisa dipakai Ads: scope-nya
--   memang tidak memuat adwords, dan core menolak meminjamnya.
-- - `ad_connections`: SATU baris per tenant (unik tenant_id) memuat
--   koneksi iklan milik TENANT (bukan platform):
--   * Meta: dataset/pixel ID (identifier publik) + access token CAPI
--     sebagai ENVELOPE terenkripsi AES-256-GCM (pola
--     payment_provider_configs / channel-secrets, kunci env
--     CHANNEL_TOKEN_SECRET) + kode peristiwa uji opsional.
--   * Google Ads: customer ID + conversion action ID (identifier
--     publik akun tenant). Kredensial aksesnya BUKAN di sini:
--     akses token datang dari koneksi OAuth layanan 'ads' di atas,
--     dan developer token adalah kredensial PLATFORM (Panel Admin
--     `google_ads_developer_token`) karena ia milik akun manager
--     milik platform, bukan milik tenant.
-- - `ad_conversion_events`: ledger pengiriman konversi. Satu baris
--   lahir di dalam transaksi langkah flow bersama event outbox
--   `ad_conversion.requested`; worker mengirimnya dan menulis hasil
--   akhir di baris yang sama. UNIQUE (tenant_id, event_id) adalah
--   kunci dedup: event_id deterministik dari (run, node) — eksekusi
--   ulang langkah yang sama tidak pernah melahirkan konversi kedua,
--   dan event_id yang sama diteruskan ke platform (Meta `event_id`,
--   Google `orderId`) agar dedup juga berlaku di sisi platform.
--   `user_data` hanya memuat HASH SHA-256 pengenal (email/telepon/
--   external id) — nilai terang tidak pernah disimpan di ledger.
--   `payload` = snapshot payload platform persis seperti terkirim
--   (tanpa token; token tidak pernah masuk baris ini).
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()). Dua tabel baru
-- → hitungan db verify naik 80 → 82 tabel, 107 → 109 policy.

-- ---------------------------------------------------------------------------
-- Enum google_service += 'ads'
-- ---------------------------------------------------------------------------

ALTER TYPE "public"."google_service" ADD VALUE IF NOT EXISTS 'ads';

-- ---------------------------------------------------------------------------
-- ad_connections (satu baris per tenant)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "ad_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "meta_dataset_id" varchar(64),
  "meta_access_token_encrypted" text,
  "meta_test_event_code" varchar(64),
  "google_customer_id" varchar(32),
  "google_conversion_action_id" varchar(32),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "ad_connections" DROP CONSTRAINT IF EXISTS "ad_connections_tenant_id_tenants_id_fk";
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

CREATE UNIQUE INDEX IF NOT EXISTS "ad_connections_tenant_unique" ON "ad_connections" ("tenant_id");
CREATE INDEX IF NOT EXISTS "ad_connections_tenant_id_idx" ON "ad_connections" ("tenant_id");

ALTER TABLE "ad_connections" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_connections";
CREATE POLICY "tenant_isolation" ON "ad_connections"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- ---------------------------------------------------------------------------
-- ad_conversion_events (ledger pengiriman konversi)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "ad_conversion_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "event_id" varchar(128) NOT NULL,
  "platform" varchar(16) NOT NULL,
  "event_name" varchar(128) NOT NULL,
  "flow_id" uuid,
  "flow_run_id" uuid,
  "node_id" varchar(128),
  "contact_id" uuid,
  "value" numeric(14, 2),
  "currency" varchar(3),
  "value_source" varchar(16),
  "user_data" jsonb,
  "status" varchar(16) DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "http_status" integer,
  "error_code" varchar(64),
  "error_message" varchar(500),
  "payload" jsonb,
  "occurred_at" timestamp with time zone NOT NULL,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "ad_conversion_events" DROP CONSTRAINT IF EXISTS "ad_conversion_events_tenant_id_tenants_id_fk";
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "ad_conversion_events" DROP CONSTRAINT IF EXISTS "ad_conversion_events_contact_id_contacts_id_fk";
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_contact_id_contacts_id_fk"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE set null;

ALTER TABLE "ad_conversion_events" DROP CONSTRAINT IF EXISTS "ad_conversion_events_platform_valid";
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_platform_valid"
  CHECK ("platform" IN ('meta', 'google'));

ALTER TABLE "ad_conversion_events" DROP CONSTRAINT IF EXISTS "ad_conversion_events_status_valid";
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_status_valid"
  CHECK ("status" IN ('queued', 'sent', 'failed', 'skipped'));

ALTER TABLE "ad_conversion_events" DROP CONSTRAINT IF EXISTS "ad_conversion_events_value_source_valid";
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_value_source_valid"
  CHECK ("value_source" IS NULL OR "value_source" IN ('order', 'deal', 'static'));

CREATE UNIQUE INDEX IF NOT EXISTS "ad_conversion_events_tenant_event_unique" ON "ad_conversion_events" ("tenant_id", "event_id");
CREATE INDEX IF NOT EXISTS "ad_conversion_events_tenant_id_idx" ON "ad_conversion_events" ("tenant_id");
CREATE INDEX IF NOT EXISTS "ad_conversion_events_tenant_created_idx" ON "ad_conversion_events" ("tenant_id", "created_at");

ALTER TABLE "ad_conversion_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ad_conversion_events";
CREATE POLICY "tenant_isolation" ON "ad_conversion_events"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
