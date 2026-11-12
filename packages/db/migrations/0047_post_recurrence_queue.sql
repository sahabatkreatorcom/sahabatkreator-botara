-- 0047_post_recurrence_queue.sql
--
-- Fase Susulan S2: JADWAL BERULANG POSTINGAN + SLOT ANTREAN RUTIN —
-- keteraturan PENERBITAN KONTEN untuk halaman /posts. Ini lapisan
-- penjadwal DI ATAS state machine postingan yang ada (Fase 23 +
-- grup multi-target 0013 + persetujuan 0046), BUKAN mesin penerbit
-- kedua dan BUKAN broadcast berulang G9 (0033): siaran punya
-- penerima per kontak; postingan hanya punya linimasa. Matematika
-- polanya dibagi lewat modul core/recurrence-pattern (diekstrak
-- dari G9), tabelnya terpisah karena snapshot dan ledgernya memang
-- tentang postingan.
--
-- Yang dibangun migrasi ini:
-- - `post_recurrence_rules`: aturan berulang milik tenant. Aturan
--   menyimpan SNAPSHOT templat postingan — judul, caption, media
--   (`media_ids` jsonb), dan himpunan sasaran (`targets` jsonb,
--   bentuk target grup komposer: conversation_id + caption override
--   opsional + opsi penerbitan per sasaran) — yang disalin dari
--   postingan sumber saat aturan dibuat (`source_post_id`, SET
--   NULL — aturan tetap hidup walau sumbernya dihapus) atau diisi
--   langsung lewat formulir. Snapshot (bukan referensi hidup)
--   disengaja: menyunting/menghapus postingan sumber tidak pernah
--   mengubah jadwal yang sedang berjalan secara diam-diam.
-- - Pola pengulangan: frequency daily/weekly/monthly + interval,
--   days_of_week (jsonb int[], 0=Minggu — hanya weekly; kosong =
--   hari starts_at), day_of_month (1..31 — hanya monthly; melampaui
--   akhir bulan DIJEPIT ke hari terakhir) atau last_day_of_month,
--   zona waktu IANA per aturan, starts_at (jangkar: slot pertama +
--   jam dinding semua slot), ends_at (inklusif), max_occurrences
--   (menghitung kejadian yang BENAR-BENAR dibuat).
-- - `next_run_at`: slot berikutnya yang belum diproses (NULL pada
--   aturan terminal). Penyapu worker memproses aturan yang jatuh
--   tempo; sesudah tiap slot kolom ini maju atau aturan ditutup.
-- - `post_recurrence_occurrences`: LEDGER per slot — satu baris per
--   (aturan, slot), UNIQUE (rule_id, slot_at) adalah kunci
--   idempotensi materialisasi. Status: claimed (sedang
--   dimaterialisasi — klaim basi diambil alih menjadi missed),
--   created (postingan anak lahir; `post_ids` + `post_group_id`
--   terisi), skipped (tidak lahir, `reason` jujur: rule_paused /
--   kode gerbang buat/jadwalkan), missed (slot_expired /
--   claim_stale).
-- - `post_queue_items`: antrean konten berurutan milik tenant.
--   `position` menentukan urutan tarik. Item yang tertarik menjadi
--   `pulled` dan keluar dari antrean dengan tautan ke postingan
--   hasil (`pulled_post_ids` / `pulled_post_group_id`) — riwayat
--   tidak hilang. `reserved_firing_id` menandai item yang sedang
--   dimaterialisasi satu firing slot (klaim dalam transaksi yang
--   sama dengan klaim firing), supaya dua slot yang menembak
--   bersamaan tidak menarik item yang sama dua kali.
-- - `post_queue_slots`: slot rutin MINGGUAN per himpunan sasaran.
--   Slot disimpan sebagai pola mingguan bersama: `days_of_week` +
--   `starts_at` sebagai jangkar (jam dindingnya dalam `timezone`
--   adalah jam slot). Tidak ada ends_at/max_occurrences: slot
--   berjalan sampai dijeda/dibatalkan pemiliknya.
-- - `post_queue_slot_firings`: LEDGER per tembakan slot — UNIQUE
--   (slot_id, slot_at) adalah kunci idempotensinya. Status: claimed,
--   pulled (item teratas tertarik; `queue_item_id` + postingan
--   hasil terisi), empty (antrean kosong saat slot menembak —
--   tercatat, BUKAN postingan karangan), skipped (slot_paused /
--   kode gerbang), missed (slot_expired / claim_stale).
--
-- Materialisasi TIDAK menerbitkan apa pun dari lapisan ini:
-- penyapu memanggil jalur pembuatan + penjadwalan postingan yang
-- SUDAH ADA (createPost/createPostGroup → schedulePost → event
-- outbox post.publish_due → publisher worker), jadi klaim atomik,
-- gerbang capability, dan gerbang persetujuan S1 berlaku apa
-- adanya untuk postingan hasil. Postingan hasil lahir dengan
-- approval_status bawaan `draft` — bila tenant mewajibkan
-- persetujuan, hasil materialisasi menunggu persetujuan persis
-- seperti postingan lain, tanpa jalur pintas.
--
-- Media yang hanya dirujuk snapshot aturan aktif/jeda dan item
-- antrean `queued` dihitung media-gc sebagai rujukan hidup
-- (perluasan jaring di core/media-gc dalam gelombang yang sama) —
-- tanpa itu aset templat bisa terhapus sebelum slotnya tiba.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (tenant_isolation dengan app_tenant_id()), DITAMBAH policy baca
-- lintas-tenant `system_post_recurrence_scan` untuk penyapu worker
-- pada kedua tabel yang dipindai (rules + slots), di bawah flag
-- `app.post_recurrence` = 'scan' (meniru
-- system_broadcast_recurrence_scan, migrasi 0033 — penulisan tetap
-- selalu dalam konteks tenant).

DO $$ BEGIN
  CREATE TYPE "post_recurrence_frequency" AS ENUM ('daily', 'weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "post_recurrence_status" AS ENUM ('active', 'paused', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "post_recurrence_occurrence_status" AS ENUM ('claimed', 'created', 'skipped', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "post_queue_item_status" AS ENUM ('queued', 'pulled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "post_queue_slot_status" AS ENUM ('active', 'paused', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "post_queue_slot_firing_status" AS ENUM ('claimed', 'pulled', 'empty', 'skipped', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "post_recurrence_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "source_post_id" uuid,
  "title" varchar(255) NOT NULL,
  "caption" text DEFAULT '' NOT NULL,
  "media_ids" jsonb DEFAULT '[]' NOT NULL,
  "targets" jsonb DEFAULT '[]' NOT NULL,
  "frequency" "post_recurrence_frequency" NOT NULL,
  "interval" integer DEFAULT 1 NOT NULL,
  "days_of_week" jsonb DEFAULT '[]' NOT NULL,
  "day_of_month" integer,
  "last_day_of_month" boolean DEFAULT false NOT NULL,
  "timezone" varchar(64) NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone,
  "max_occurrences" integer,
  "occurrences_created" integer DEFAULT 0 NOT NULL,
  "status" "post_recurrence_status" DEFAULT 'active' NOT NULL,
  "next_run_at" timestamp with time zone,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "post_recurrence_rules" DROP CONSTRAINT IF EXISTS "post_recurrence_rules_tenant_id_tenants_id_fk";
ALTER TABLE "post_recurrence_rules" ADD CONSTRAINT "post_recurrence_rules_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "post_recurrence_rules" DROP CONSTRAINT IF EXISTS "post_recurrence_rules_source_post_id_posts_id_fk";
ALTER TABLE "post_recurrence_rules" ADD CONSTRAINT "post_recurrence_rules_source_post_id_posts_id_fk"
  FOREIGN KEY ("source_post_id") REFERENCES "posts"("id") ON DELETE set null;

ALTER TABLE "post_recurrence_rules" DROP CONSTRAINT IF EXISTS "post_recurrence_rules_created_by_user_id_users_id_fk";
ALTER TABLE "post_recurrence_rules" ADD CONSTRAINT "post_recurrence_rules_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "post_recurrence_rules_tenant_id_idx" ON "post_recurrence_rules" ("tenant_id");
CREATE INDEX IF NOT EXISTS "post_recurrence_rules_tenant_status_idx" ON "post_recurrence_rules" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "post_recurrence_rules_due_idx" ON "post_recurrence_rules" ("next_run_at");

ALTER TABLE "post_recurrence_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "post_recurrence_rules";
CREATE POLICY "tenant_isolation" ON "post_recurrence_rules"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- Penyapu worker membaca aturan jatuh tempo LINTAS tenant (id +
-- tenant pemilik saja), lalu memproses tiap aturan di dalam konteks
-- tenant-nya. Baca saja; meniru system_broadcast_recurrence_scan.
DROP POLICY IF EXISTS "system_post_recurrence_scan" ON "post_recurrence_rules";
CREATE POLICY "system_post_recurrence_scan" ON "post_recurrence_rules"
  FOR SELECT
  USING (app_setting('app.post_recurrence') = 'scan');

CREATE TABLE IF NOT EXISTS "post_recurrence_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "rule_id" uuid NOT NULL,
  "slot_at" timestamp with time zone NOT NULL,
  "status" "post_recurrence_occurrence_status" NOT NULL,
  "reason" varchar(64),
  "post_group_id" uuid,
  "post_ids" jsonb DEFAULT '[]' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "post_recurrence_occurrences" DROP CONSTRAINT IF EXISTS "post_recurrence_occurrences_tenant_id_tenants_id_fk";
ALTER TABLE "post_recurrence_occurrences" ADD CONSTRAINT "post_recurrence_occurrences_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "post_recurrence_occurrences" DROP CONSTRAINT IF EXISTS "post_recurrence_occurrences_rule_id_post_recurrence_rules_id_fk";
ALTER TABLE "post_recurrence_occurrences" ADD CONSTRAINT "post_recurrence_occurrences_rule_id_post_recurrence_rules_id_fk"
  FOREIGN KEY ("rule_id") REFERENCES "post_recurrence_rules"("id") ON DELETE cascade;

ALTER TABLE "post_recurrence_occurrences" DROP CONSTRAINT IF EXISTS "post_recurrence_occurrences_post_group_id_post_groups_id_fk";
ALTER TABLE "post_recurrence_occurrences" ADD CONSTRAINT "post_recurrence_occurrences_post_group_id_post_groups_id_fk"
  FOREIGN KEY ("post_group_id") REFERENCES "post_groups"("id") ON DELETE set null;

-- KUNCI IDEMPOTENSI materialisasi: satu slot = paling banyak satu baris.
CREATE UNIQUE INDEX IF NOT EXISTS "post_recurrence_occurrences_rule_slot_unique" ON "post_recurrence_occurrences" ("rule_id", "slot_at");
CREATE INDEX IF NOT EXISTS "post_recurrence_occurrences_tenant_id_idx" ON "post_recurrence_occurrences" ("tenant_id");
CREATE INDEX IF NOT EXISTS "post_recurrence_occurrences_rule_slot_idx" ON "post_recurrence_occurrences" ("rule_id", "slot_at");

ALTER TABLE "post_recurrence_occurrences" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "post_recurrence_occurrences";
CREATE POLICY "tenant_isolation" ON "post_recurrence_occurrences"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

CREATE TABLE IF NOT EXISTS "post_queue_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "title" varchar(255) NOT NULL,
  "caption" text DEFAULT '' NOT NULL,
  "media_ids" jsonb DEFAULT '[]' NOT NULL,
  "status" "post_queue_item_status" DEFAULT 'queued' NOT NULL,
  "reserved_firing_id" uuid,
  "reserved_at" timestamp with time zone,
  "pulled_at" timestamp with time zone,
  "pulled_post_group_id" uuid,
  "pulled_post_ids" jsonb DEFAULT '[]' NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "post_queue_items" DROP CONSTRAINT IF EXISTS "post_queue_items_tenant_id_tenants_id_fk";
ALTER TABLE "post_queue_items" ADD CONSTRAINT "post_queue_items_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "post_queue_items" DROP CONSTRAINT IF EXISTS "post_queue_items_pulled_post_group_id_post_groups_id_fk";
ALTER TABLE "post_queue_items" ADD CONSTRAINT "post_queue_items_pulled_post_group_id_post_groups_id_fk"
  FOREIGN KEY ("pulled_post_group_id") REFERENCES "post_groups"("id") ON DELETE set null;

ALTER TABLE "post_queue_items" DROP CONSTRAINT IF EXISTS "post_queue_items_created_by_user_id_users_id_fk";
ALTER TABLE "post_queue_items" ADD CONSTRAINT "post_queue_items_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "post_queue_items_tenant_status_position_idx" ON "post_queue_items" ("tenant_id", "status", "position");
CREATE INDEX IF NOT EXISTS "post_queue_items_tenant_id_idx" ON "post_queue_items" ("tenant_id");

ALTER TABLE "post_queue_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "post_queue_items";
CREATE POLICY "tenant_isolation" ON "post_queue_items"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

CREATE TABLE IF NOT EXISTS "post_queue_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "targets" jsonb DEFAULT '[]' NOT NULL,
  "days_of_week" jsonb DEFAULT '[]' NOT NULL,
  "timezone" varchar(64) NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "status" "post_queue_slot_status" DEFAULT 'active' NOT NULL,
  "next_run_at" timestamp with time zone,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "post_queue_slots" DROP CONSTRAINT IF EXISTS "post_queue_slots_tenant_id_tenants_id_fk";
ALTER TABLE "post_queue_slots" ADD CONSTRAINT "post_queue_slots_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "post_queue_slots" DROP CONSTRAINT IF EXISTS "post_queue_slots_created_by_user_id_users_id_fk";
ALTER TABLE "post_queue_slots" ADD CONSTRAINT "post_queue_slots_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "post_queue_slots_tenant_id_idx" ON "post_queue_slots" ("tenant_id");
CREATE INDEX IF NOT EXISTS "post_queue_slots_tenant_status_idx" ON "post_queue_slots" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "post_queue_slots_due_idx" ON "post_queue_slots" ("next_run_at");

ALTER TABLE "post_queue_slots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "post_queue_slots";
CREATE POLICY "tenant_isolation" ON "post_queue_slots"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

DROP POLICY IF EXISTS "system_post_recurrence_scan" ON "post_queue_slots";
CREATE POLICY "system_post_recurrence_scan" ON "post_queue_slots"
  FOR SELECT
  USING (app_setting('app.post_recurrence') = 'scan');

CREATE TABLE IF NOT EXISTS "post_queue_slot_firings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "slot_id" uuid NOT NULL,
  "slot_at" timestamp with time zone NOT NULL,
  "status" "post_queue_slot_firing_status" NOT NULL,
  "reason" varchar(64),
  "queue_item_id" uuid,
  "post_group_id" uuid,
  "post_ids" jsonb DEFAULT '[]' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "post_queue_slot_firings" DROP CONSTRAINT IF EXISTS "post_queue_slot_firings_tenant_id_tenants_id_fk";
ALTER TABLE "post_queue_slot_firings" ADD CONSTRAINT "post_queue_slot_firings_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "post_queue_slot_firings" DROP CONSTRAINT IF EXISTS "post_queue_slot_firings_slot_id_post_queue_slots_id_fk";
ALTER TABLE "post_queue_slot_firings" ADD CONSTRAINT "post_queue_slot_firings_slot_id_post_queue_slots_id_fk"
  FOREIGN KEY ("slot_id") REFERENCES "post_queue_slots"("id") ON DELETE cascade;

ALTER TABLE "post_queue_slot_firings" DROP CONSTRAINT IF EXISTS "post_queue_slot_firings_queue_item_id_post_queue_items_id_fk";
ALTER TABLE "post_queue_slot_firings" ADD CONSTRAINT "post_queue_slot_firings_queue_item_id_post_queue_items_id_fk"
  FOREIGN KEY ("queue_item_id") REFERENCES "post_queue_items"("id") ON DELETE set null;

ALTER TABLE "post_queue_slot_firings" DROP CONSTRAINT IF EXISTS "post_queue_slot_firings_post_group_id_post_groups_id_fk";
ALTER TABLE "post_queue_slot_firings" ADD CONSTRAINT "post_queue_slot_firings_post_group_id_post_groups_id_fk"
  FOREIGN KEY ("post_group_id") REFERENCES "post_groups"("id") ON DELETE set null;

-- KUNCI IDEMPOTENSI tembakan: satu slot pada satu instan = satu baris.
CREATE UNIQUE INDEX IF NOT EXISTS "post_queue_slot_firings_slot_slot_unique" ON "post_queue_slot_firings" ("slot_id", "slot_at");
CREATE INDEX IF NOT EXISTS "post_queue_slot_firings_tenant_id_idx" ON "post_queue_slot_firings" ("tenant_id");
CREATE INDEX IF NOT EXISTS "post_queue_slot_firings_slot_slot_idx" ON "post_queue_slot_firings" ("slot_id", "slot_at");

ALTER TABLE "post_queue_slot_firings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "post_queue_slot_firings";
CREATE POLICY "tenant_isolation" ON "post_queue_slot_firings"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
