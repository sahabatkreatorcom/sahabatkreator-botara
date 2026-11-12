-- 0033_broadcast_recurrence.sql
--
-- Gelombang G9 (Tier 2 butir 9 program adopsi): BROADCAST BERULANG —
-- lapisan penjadwal DI ATAS mesin broadcast yang ada (Fase 7C),
-- bukan mesin kirim kedua.
--
-- Yang dibangun migrasi ini:
-- - `broadcast_recurrence_rules`: satu aturan berulang milik tenant.
--   Aturan menyimpan SNAPSHOT definisi broadcast (channel, isi/
--   template, filter audiens, gerbang opt-in, konfigurasi A/B —
--   kolom yang sama persis seperti `broadcasts`) yang disalin dari
--   broadcast sumber saat aturan dibuat (`source_broadcast_id`,
--   SET NULL — aturan tetap hidup walau broadcast sumbernya dihapus)
--   atau diisi langsung lewat formulir. Snapshot (bukan referensi
--   hidup) disengaja: mengedit/menghapus broadcast sumber tidak
--   pernah mengubah jadwal yang sedang berjalan secara diam-diam.
-- - Pola pengulangan: frequency daily/weekly/monthly + interval
--   (setiap N), days_of_week (jsonb int[], 0=Minggu — hanya weekly;
--   kosong = hari yang sama dengan tanggal mulai), day_of_month
--   (1..31 — hanya monthly; tanggal melampaui akhir bulan DIJEPIT ke
--   hari terakhir bulan itu) atau last_day_of_month, zona waktu IANA
--   per aturan, starts_at (jangkar: slot pertama + jam dinding semua
--   slot berikutnya), ends_at (slot terakhir yang masih boleh —
--   inklusif), max_occurrences (menghitung broadcast anak yang
--   BENAR-BENAR dibuat).
-- - `next_run_at`: slot berikutnya yang belum diproses (NULL pada
--   aturan terminal). Penyapu worker memproses aturan yang
--   next_run_at-nya jatuh tempo; sesudah tiap slot, kolom ini maju
--   ke slot berikutnya atau aturan ditutup `completed`.
-- - `broadcast_recurrence_occurrences`: LEDGER per slot — satu baris
--   per (aturan, slot), ditegakkan UNIQUE (rule_id, slot_at) yang
--   menjadi kunci idempotensi materialisasi: slot yang sama tidak
--   pernah melahirkan dua broadcast anak. Status: claimed (sedang
--   dimaterialisasi — klaim basi diambil alih menjadi missed),
--   created (broadcast anak lahir, `broadcast_id` terisi), skipped
--   (tidak lahir, `reason` jujur: rule_paused / channel_* /
--   template_* / segment_not_found / message_required /
--   ab_incomplete), missed (slot basi melewati ambang keterlambatan
--   core — slot_expired — atau klaim basi — claim_stale).
--
-- Materialisasi TIDAK mengirim apa pun dari lapisan ini: penyapu
-- memanggil jalur pembuatan + penjadwalan broadcast yang SUDAH ADA
-- (createBroadcast → scheduleBroadcast → event outbox
-- broadcast.dispatch_due → dispatch worker), jadi status per
-- penerima, klaim anti-dobel, resume, dan finalisasi berlaku apa
-- adanya untuk broadcast anak.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()), DITAMBAH policy
-- baca lintas-tenant `system_broadcast_recurrence_scan` untuk
-- penyapu worker (meniru `system_broadcast_scan` pada broadcasts,
-- migrasi 0001 — penulisan tetap selalu dalam konteks tenant).

DO $$ BEGIN
  CREATE TYPE "broadcast_recurrence_frequency" AS ENUM ('daily', 'weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "broadcast_recurrence_status" AS ENUM ('active', 'paused', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "broadcast_recurrence_occurrence_status" AS ENUM ('claimed', 'created', 'skipped', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "broadcast_recurrence_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL,
  "source_broadcast_id" uuid,
  "name" varchar(255) NOT NULL,
  "message_text" varchar(4096) NOT NULL,
  "whatsapp_template_id" uuid,
  "template_variable_sources" jsonb DEFAULT '[]' NOT NULL,
  "audience_filter" jsonb DEFAULT '{}' NOT NULL,
  "require_opt_in" boolean DEFAULT false NOT NULL,
  "ab_split_percent_b" integer,
  "variant_b_message_text" varchar(4096),
  "variant_b_whatsapp_template_id" uuid,
  "variant_b_template_variable_sources" jsonb DEFAULT '[]' NOT NULL,
  "frequency" "broadcast_recurrence_frequency" NOT NULL,
  "interval" integer DEFAULT 1 NOT NULL,
  "days_of_week" jsonb DEFAULT '[]' NOT NULL,
  "day_of_month" integer,
  "last_day_of_month" boolean DEFAULT false NOT NULL,
  "timezone" varchar(64) NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone,
  "max_occurrences" integer,
  "occurrences_created" integer DEFAULT 0 NOT NULL,
  "status" "broadcast_recurrence_status" DEFAULT 'active' NOT NULL,
  "next_run_at" timestamp with time zone,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "broadcast_recurrence_rules" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_rules_tenant_id_tenants_id_fk";
ALTER TABLE "broadcast_recurrence_rules" ADD CONSTRAINT "broadcast_recurrence_rules_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "broadcast_recurrence_rules" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_rules_channel_account_id_channel_accounts_id_fk";
ALTER TABLE "broadcast_recurrence_rules" ADD CONSTRAINT "broadcast_recurrence_rules_channel_account_id_channel_accounts_id_fk"
  FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE cascade;

ALTER TABLE "broadcast_recurrence_rules" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_rules_source_broadcast_id_broadcasts_id_fk";
ALTER TABLE "broadcast_recurrence_rules" ADD CONSTRAINT "broadcast_recurrence_rules_source_broadcast_id_broadcasts_id_fk"
  FOREIGN KEY ("source_broadcast_id") REFERENCES "broadcasts"("id") ON DELETE set null;

ALTER TABLE "broadcast_recurrence_rules" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_rules_whatsapp_template_id_whatsapp_templates_id_fk";
ALTER TABLE "broadcast_recurrence_rules" ADD CONSTRAINT "broadcast_recurrence_rules_whatsapp_template_id_whatsapp_templates_id_fk"
  FOREIGN KEY ("whatsapp_template_id") REFERENCES "whatsapp_templates"("id") ON DELETE set null;

ALTER TABLE "broadcast_recurrence_rules" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_rules_variant_b_whatsapp_template_id_whatsapp_templates_id_fk";
ALTER TABLE "broadcast_recurrence_rules" ADD CONSTRAINT "broadcast_recurrence_rules_variant_b_whatsapp_template_id_whatsapp_templates_id_fk"
  FOREIGN KEY ("variant_b_whatsapp_template_id") REFERENCES "whatsapp_templates"("id") ON DELETE set null;

ALTER TABLE "broadcast_recurrence_rules" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_rules_created_by_user_id_users_id_fk";
ALTER TABLE "broadcast_recurrence_rules" ADD CONSTRAINT "broadcast_recurrence_rules_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "broadcast_recurrence_rules_tenant_id_idx" ON "broadcast_recurrence_rules" ("tenant_id");
CREATE INDEX IF NOT EXISTS "broadcast_recurrence_rules_tenant_status_idx" ON "broadcast_recurrence_rules" ("tenant_id", "status");
-- Indeks pemindaian penyapu: aturan jatuh tempo lintas tenant.
CREATE INDEX IF NOT EXISTS "broadcast_recurrence_rules_due_idx" ON "broadcast_recurrence_rules" ("next_run_at") WHERE "next_run_at" IS NOT NULL;

ALTER TABLE "broadcast_recurrence_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "broadcast_recurrence_rules";
CREATE POLICY "tenant_isolation" ON "broadcast_recurrence_rules"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- Penyapu worker membaca aturan jatuh tempo LINTAS tenant (id +
-- tenant pemilik saja), lalu memproses tiap aturan di dalam konteks
-- tenant-nya. Baca saja; meniru system_broadcast_scan (migrasi 0001).
DROP POLICY IF EXISTS "system_broadcast_recurrence_scan" ON "broadcast_recurrence_rules";
CREATE POLICY "system_broadcast_recurrence_scan" ON "broadcast_recurrence_rules"
  FOR SELECT
  USING (app_setting('app.broadcast_recurrence') = 'scan');

CREATE TABLE IF NOT EXISTS "broadcast_recurrence_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "rule_id" uuid NOT NULL,
  "slot_at" timestamp with time zone NOT NULL,
  "status" "broadcast_recurrence_occurrence_status" NOT NULL,
  "reason" varchar(64),
  "broadcast_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "broadcast_recurrence_occurrences" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_occurrences_tenant_id_tenants_id_fk";
ALTER TABLE "broadcast_recurrence_occurrences" ADD CONSTRAINT "broadcast_recurrence_occurrences_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "broadcast_recurrence_occurrences" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_occurrences_rule_id_broadcast_recurrence_rules_id_fk";
ALTER TABLE "broadcast_recurrence_occurrences" ADD CONSTRAINT "broadcast_recurrence_occurrences_rule_id_broadcast_recurrence_rules_id_fk"
  FOREIGN KEY ("rule_id") REFERENCES "broadcast_recurrence_rules"("id") ON DELETE cascade;

ALTER TABLE "broadcast_recurrence_occurrences" DROP CONSTRAINT IF EXISTS "broadcast_recurrence_occurrences_broadcast_id_broadcasts_id_fk";
ALTER TABLE "broadcast_recurrence_occurrences" ADD CONSTRAINT "broadcast_recurrence_occurrences_broadcast_id_broadcasts_id_fk"
  FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE set null;

-- KUNCI IDEMPOTENSI materialisasi: satu slot = paling banyak satu baris.
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_recurrence_occurrences_rule_slot_unique" ON "broadcast_recurrence_occurrences" ("rule_id", "slot_at");
CREATE INDEX IF NOT EXISTS "broadcast_recurrence_occurrences_tenant_id_idx" ON "broadcast_recurrence_occurrences" ("tenant_id");
CREATE INDEX IF NOT EXISTS "broadcast_recurrence_occurrences_rule_slot_idx" ON "broadcast_recurrence_occurrences" ("rule_id", "slot_at");

ALTER TABLE "broadcast_recurrence_occurrences" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "broadcast_recurrence_occurrences";
CREATE POLICY "tenant_isolation" ON "broadcast_recurrence_occurrences"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
