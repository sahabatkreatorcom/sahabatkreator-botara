-- 0035_deals.sql
--
-- Gelombang G12 (Tier 2 butir 12 program adopsi): DEALS / PIPELINE
-- KANBAN BERMATA UANG — entitas deal TERPISAH dari kontak (pola repo
-- riset wacrm `src/lib/pipelines` + migrasi 001/002/021 wacrm, MIT,
-- diadopsi sebagai pola). Yang ada hari ini hanya
-- `contacts.pipeline_stage` — tahap KONTAK sederhana, satu nilai per
-- orang, tanpa nilai uang. Deal adalah peluang penjualan: satu kontak
-- boleh punya banyak deal, dan deal yang bergerak di papan.
--
-- Yang dibangun migrasi ini:
-- - `tenants.default_currency` (pola wacrm 021): mata uang bawaan
--   akun, dipakai deal baru; format ^[A-Z]{3}$ ditegakkan CHECK.
--   Bawaan 'IDR' (produk Indonesia-first).
-- - `deal_pipelines`: pipeline per tenant (boleh banyak). Pipeline
--   bawaan + tahap bawaan disemai MALAS oleh core saat permukaan
--   deals pertama dibuka (nama tahap mengikuti default_locale
--   tenant — bukan urusan trigger DB).
-- - `deal_stages`: nama + position + color yang bisa disesuaikan,
--   plus `kind` ('open'|'won'|'lost'): tahap ber-kind won/lost adalah
--   tahap TERMINAL — memindahkan deal ke sana menetapkan
--   `deals.status` + `closed_at` (pola status-di-deal wacrm).
-- - `deals`: kontak WAJIB (CASCADE — pola FK kontak repo), percakapan
--   opsional (SET NULL), value numeric(14,2) + currency per deal
--   (total analitik tidak pernah menjumlah lintas mata uang),
--   expected_close_date, due_at (tenggat), priority, assignee
--   (SET NULL), status open/won/lost, closed_at. FK stage_id
--   RESTRICT: tahap berisi deal tidak bisa dihapus sebelum dealnya
--   dipindahkan (core menegakkan dengan pesan; DB jaring terakhir).
-- - `deal_stage_events`: riwayat perpindahan tahap (dari → ke,
--   aktor, nama tahap SNAPSHOT agar riwayat terbaca sesudah tahap
--   diganti nama/dihapus; FK tahap SET NULL). Baris pertama deal =
--   peristiwa pembuatan (from NULL).
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()). Empat tabel baru
-- → hitungan db verify naik 70 → 74 tabel, 96 → 100 policy.

-- ---------------------------------------------------------------------------
-- tenants.default_currency
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "default_currency" varchar(3) NOT NULL DEFAULT 'IDR';

ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_default_currency_format";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_currency_format"
  CHECK ("default_currency" ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "deal_stage_kind" AS ENUM ('open', 'won', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "deal_status" AS ENUM ('open', 'won', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "deal_priority" AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- deal_pipelines
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "deal_pipelines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "deal_pipelines" DROP CONSTRAINT IF EXISTS "deal_pipelines_tenant_id_tenants_id_fk";
ALTER TABLE "deal_pipelines" ADD CONSTRAINT "deal_pipelines_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "deal_pipelines_tenant_id_idx" ON "deal_pipelines" ("tenant_id");

ALTER TABLE "deal_pipelines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "deal_pipelines";
CREATE POLICY "tenant_isolation" ON "deal_pipelines"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- ---------------------------------------------------------------------------
-- deal_stages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "deal_stages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "pipeline_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "color" varchar(16) DEFAULT '#3b82f6' NOT NULL,
  "kind" "deal_stage_kind" DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "deal_stages" DROP CONSTRAINT IF EXISTS "deal_stages_tenant_id_tenants_id_fk";
ALTER TABLE "deal_stages" ADD CONSTRAINT "deal_stages_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "deal_stages" DROP CONSTRAINT IF EXISTS "deal_stages_pipeline_id_deal_pipelines_id_fk";
ALTER TABLE "deal_stages" ADD CONSTRAINT "deal_stages_pipeline_id_deal_pipelines_id_fk"
  FOREIGN KEY ("pipeline_id") REFERENCES "deal_pipelines"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "deal_stages_tenant_id_idx" ON "deal_stages" ("tenant_id");
CREATE INDEX IF NOT EXISTS "deal_stages_pipeline_position_idx" ON "deal_stages" ("pipeline_id", "position");

ALTER TABLE "deal_stages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "deal_stages";
CREATE POLICY "tenant_isolation" ON "deal_stages"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- ---------------------------------------------------------------------------
-- deals
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "deals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "pipeline_id" uuid NOT NULL,
  "stage_id" uuid NOT NULL,
  "contact_id" uuid NOT NULL,
  "conversation_id" uuid,
  "title" text NOT NULL,
  "value" numeric(14, 2) DEFAULT '0' NOT NULL,
  "currency" varchar(3) NOT NULL,
  "expected_close_date" date,
  "due_at" timestamp with time zone,
  "status" "deal_status" DEFAULT 'open' NOT NULL,
  "priority" "deal_priority" DEFAULT 'medium' NOT NULL,
  "assignee_user_id" uuid,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_tenant_id_tenants_id_fk";
ALTER TABLE "deals" ADD CONSTRAINT "deals_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_pipeline_id_deal_pipelines_id_fk";
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_deal_pipelines_id_fk"
  FOREIGN KEY ("pipeline_id") REFERENCES "deal_pipelines"("id") ON DELETE cascade;

ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_stage_id_deal_stages_id_fk";
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_deal_stages_id_fk"
  FOREIGN KEY ("stage_id") REFERENCES "deal_stages"("id") ON DELETE restrict;

ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_contact_id_contacts_id_fk";
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE cascade;

ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_conversation_id_conversations_id_fk";
ALTER TABLE "deals" ADD CONSTRAINT "deals_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE set null;

ALTER TABLE "deals" DROP CONSTRAINT IF EXISTS "deals_assignee_user_id_users_id_fk";
ALTER TABLE "deals" ADD CONSTRAINT "deals_assignee_user_id_users_id_fk"
  FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "deals_tenant_id_idx" ON "deals" ("tenant_id");
CREATE INDEX IF NOT EXISTS "deals_pipeline_stage_idx" ON "deals" ("pipeline_id", "stage_id");
CREATE INDEX IF NOT EXISTS "deals_contact_id_idx" ON "deals" ("contact_id");
CREATE INDEX IF NOT EXISTS "deals_status_idx" ON "deals" ("status");

ALTER TABLE "deals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "deals";
CREATE POLICY "tenant_isolation" ON "deals"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- ---------------------------------------------------------------------------
-- deal_stage_events (riwayat perpindahan tahap)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "deal_stage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "deal_id" uuid NOT NULL,
  "from_stage_id" uuid,
  "to_stage_id" uuid,
  "from_stage_name" text,
  "to_stage_name" text NOT NULL,
  "actor_type" varchar(32) NOT NULL,
  "actor_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "deal_stage_events" DROP CONSTRAINT IF EXISTS "deal_stage_events_tenant_id_tenants_id_fk";
ALTER TABLE "deal_stage_events" ADD CONSTRAINT "deal_stage_events_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "deal_stage_events" DROP CONSTRAINT IF EXISTS "deal_stage_events_deal_id_deals_id_fk";
ALTER TABLE "deal_stage_events" ADD CONSTRAINT "deal_stage_events_deal_id_deals_id_fk"
  FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE cascade;

ALTER TABLE "deal_stage_events" DROP CONSTRAINT IF EXISTS "deal_stage_events_from_stage_id_deal_stages_id_fk";
ALTER TABLE "deal_stage_events" ADD CONSTRAINT "deal_stage_events_from_stage_id_deal_stages_id_fk"
  FOREIGN KEY ("from_stage_id") REFERENCES "deal_stages"("id") ON DELETE set null;

ALTER TABLE "deal_stage_events" DROP CONSTRAINT IF EXISTS "deal_stage_events_to_stage_id_deal_stages_id_fk";
ALTER TABLE "deal_stage_events" ADD CONSTRAINT "deal_stage_events_to_stage_id_deal_stages_id_fk"
  FOREIGN KEY ("to_stage_id") REFERENCES "deal_stages"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "deal_stage_events_tenant_id_idx" ON "deal_stage_events" ("tenant_id");
CREATE INDEX IF NOT EXISTS "deal_stage_events_deal_created_idx" ON "deal_stage_events" ("deal_id", "created_at");

ALTER TABLE "deal_stage_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "deal_stage_events";
CREATE POLICY "tenant_isolation" ON "deal_stage_events"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
