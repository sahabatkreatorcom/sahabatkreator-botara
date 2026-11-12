-- 0034_outbound_webhooks.sql
--
-- Gelombang G11 (Tier 2 butir 10 program adopsi): WEBHOOK KELUAR
-- (OUTBOUND) TENANT — tenant mendaftarkan endpoint HTTPS miliknya dan
-- Botara meneruskan peristiwa internal yang dilanggan secara
-- real-time, tertandatangani HMAC-SHA256, dengan pengiriman yang
-- andal (percobaan ulang backoff + log per pengiriman).
--
-- Yang dibangun migrasi ini:
-- - `outbound_webhook_endpoints`: endpoint per tenant — URL HTTPS,
--   daftar peristiwa yang dilanggan (jsonb string[]; subset katalog
--   peristiwa outbox yang BENAR-BENAR punya sumber hari ini:
--   message.received + message.status_updated), rahasia penanda
--   tangan TERENKRIPSI (envelope AES-256-GCM CHANNEL_TOKEN_SECRET,
--   pola channel-secrets Fase 6A — nilai terang hanya tampil satu
--   kali pada respons pembuatan), status active/disabled,
--   consecutive_failures (pengiriman gagal final beruntun; sukses
--   meng-nol-kan), disabled_reason ('manual' |
--   'consecutive_failures').
-- - `outbound_webhook_deliveries`: log pengiriman — satu baris per
--   (endpoint, peristiwa) dengan badan JSON persis seperti dikirim,
--   status pending/delivered/failed, attempts, next_attempt_at
--   (jadwal percobaan ulang), last_status_code/last_error percobaan
--   terakhir. UNIQUE (endpoint_id, source_event_id) parsial adalah
--   KUNCI IDEMPOTENSI fan-out: event outbox yang sama tidak pernah
--   melahirkan dua pengiriman ke endpoint yang sama. source_event_id
--   TANPA FK — baris outbox diretensi 7 hari sedangkan log
--   pengiriman adalah jejak yang hidup lebih lama.
--
-- Pengiriman BUKAN mesin antrean kedua: fan-out menumpang relay
-- outbox yang ada (relay → job BullMQ outbound-webhook.fanout →
-- baris pengiriman + percobaan pertama), percobaan ulang diproses
-- penyapu worker lewat next_attempt_at (policy baca lintas-tenant
-- `system_outbound_webhook_scan`, meniru
-- `system_broadcast_recurrence_scan` migrasi 0033 — penulisan tetap
-- selalu dalam konteks tenant).
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()).

DO $$ BEGIN
  CREATE TYPE "outbound_webhook_endpoint_status" AS ENUM ('active', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "outbound_webhook_delivery_status" AS ENUM ('pending', 'delivered', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "outbound_webhook_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "url" text NOT NULL,
  "events" jsonb DEFAULT '[]' NOT NULL,
  "secret_encrypted" text NOT NULL,
  "status" "outbound_webhook_endpoint_status" DEFAULT 'active' NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "disabled_reason" varchar(64),
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "outbound_webhook_endpoints" DROP CONSTRAINT IF EXISTS "outbound_webhook_endpoints_tenant_id_tenants_id_fk";
ALTER TABLE "outbound_webhook_endpoints" ADD CONSTRAINT "outbound_webhook_endpoints_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "outbound_webhook_endpoints" DROP CONSTRAINT IF EXISTS "outbound_webhook_endpoints_created_by_user_id_users_id_fk";
ALTER TABLE "outbound_webhook_endpoints" ADD CONSTRAINT "outbound_webhook_endpoints_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "outbound_webhook_endpoints_tenant_id_idx" ON "outbound_webhook_endpoints" ("tenant_id");
CREATE INDEX IF NOT EXISTS "outbound_webhook_endpoints_tenant_status_idx" ON "outbound_webhook_endpoints" ("tenant_id", "status");

ALTER TABLE "outbound_webhook_endpoints" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "outbound_webhook_endpoints";
CREATE POLICY "tenant_isolation" ON "outbound_webhook_endpoints"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

CREATE TABLE IF NOT EXISTS "outbound_webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "endpoint_id" uuid NOT NULL,
  "event_type" varchar(64) NOT NULL,
  "source_event_id" uuid,
  "payload" jsonb NOT NULL,
  "status" "outbound_webhook_delivery_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "last_status_code" integer,
  "last_error" varchar(500),
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "outbound_webhook_deliveries" DROP CONSTRAINT IF EXISTS "outbound_webhook_deliveries_tenant_id_tenants_id_fk";
ALTER TABLE "outbound_webhook_deliveries" ADD CONSTRAINT "outbound_webhook_deliveries_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "outbound_webhook_deliveries" DROP CONSTRAINT IF EXISTS "outbound_webhook_deliveries_endpoint_id_outbound_webhook_endpoints_id_fk";
ALTER TABLE "outbound_webhook_deliveries" ADD CONSTRAINT "outbound_webhook_deliveries_endpoint_id_outbound_webhook_endpoints_id_fk"
  FOREIGN KEY ("endpoint_id") REFERENCES "outbound_webhook_endpoints"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "outbound_webhook_deliveries_tenant_id_idx" ON "outbound_webhook_deliveries" ("tenant_id");
CREATE INDEX IF NOT EXISTS "outbound_webhook_deliveries_endpoint_created_idx" ON "outbound_webhook_deliveries" ("endpoint_id", "created_at");
CREATE INDEX IF NOT EXISTS "outbound_webhook_deliveries_due_idx" ON "outbound_webhook_deliveries" ("next_attempt_at") WHERE "next_attempt_at" IS NOT NULL;
-- KUNCI IDEMPOTENSI fan-out: satu event outbox = paling banyak satu pengiriman per endpoint.
CREATE UNIQUE INDEX IF NOT EXISTS "outbound_webhook_deliveries_endpoint_event_unique" ON "outbound_webhook_deliveries" ("endpoint_id", "source_event_id") WHERE "source_event_id" IS NOT NULL;

ALTER TABLE "outbound_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "outbound_webhook_deliveries";
CREATE POLICY "tenant_isolation" ON "outbound_webhook_deliveries"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- Penyapu percobaan ulang worker membaca pengiriman jatuh tempo
-- LINTAS tenant (id + tenant pemilik saja), lalu memproses tiap
-- pengiriman di dalam konteks tenant-nya. Baca saja; meniru
-- system_broadcast_recurrence_scan (migrasi 0033).
DROP POLICY IF EXISTS "system_outbound_webhook_scan" ON "outbound_webhook_deliveries";
CREATE POLICY "system_outbound_webhook_scan" ON "outbound_webhook_deliveries"
  FOR SELECT
  USING (app_setting('app.outbound_webhook') = 'scan');
