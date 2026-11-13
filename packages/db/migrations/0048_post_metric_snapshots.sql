-- 0048_post_metric_snapshots.sql
--
-- Fase Susulan S3: ANALITIK PER PLATFORM UNTUK POSTINGAN — angka
-- keterlibatan NYATA untuk postingan yang sudah terbit, ditarik
-- penyapu worker dari API resmi tiap platform berdasarkan
-- `posts.provider_message_id`. Ini lapisan BACA di atas publikasi
-- yang ada (Fase 23 + Gelombang 0–4), bukan mesin metrik kedua:
-- adapter penarikan di worker menumpang registry/kapabilitas pola
-- PublisherAdapter, dan angka yang disimpan hanya yang benar-benar
-- dikembalikan platform.
--
-- Yang dibangun migrasi ini:
-- - `post_metric_snapshots`: snapshot DERET WAKTU per target
--   postingan. Tiap penarikan MENAMBAH satu baris (tidak pernah
--   menimpa): status penarikan (`ok` / `unavailable` / `failed`),
--   kode alasan persis pada `reason`, dan `metrics` jsonb berisi
--   hitungan kumulatif platform dengan kunci ternormalisasi kontrak
--   (views/likes/comments/shares/reach/saves/clicks/reposts/quotes/
--   outboundClicks). Kunci yang tidak dilaporkan platform ABSEN dari
--   objek — angka tidak pernah dikarang. `metrics` NULL kecuali
--   status `ok`. `provider` didenormalisasi saat penarikan supaya
--   agregat per platform tidak perlu join dan riwayat tetap benar.
-- - Platform yang TIDAK menawarkan metrik postingan organik lewat
--   API resmi (Telegram — Bot API tanpa statistik per pesan; Google
--   Business — metrik per postingan lokal dihentikan Google 2023)
--   menerima tepat SATU snapshot `unavailable` per postingan dan
--   tidak pernah ditarik lagi.
--
-- RLS: tenant_isolation standar untuk tabel baru, DITAMBAH policy
-- baca lintas-tenant `system_post_analytics_scan` pada
-- `post_metric_snapshots` DAN pada `posts` untuk penyapu worker
-- (flag `app.post_analytics` = 'scan' — meniru
-- system_post_recurrence_scan, migrasi 0047; penulisan snapshot
-- tetap selalu dalam konteks tenant pemiliknya).

DO $$ BEGIN
  CREATE TYPE "post_metric_snapshot_status" AS ENUM ('ok', 'unavailable', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "post_metric_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "post_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL,
  "status" "post_metric_snapshot_status" NOT NULL,
  "reason" varchar(128),
  "metrics" jsonb,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "post_metric_snapshots" DROP CONSTRAINT IF EXISTS "post_metric_snapshots_tenant_id_tenants_id_fk";
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "post_metric_snapshots" DROP CONSTRAINT IF EXISTS "post_metric_snapshots_post_id_posts_id_fk";
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_post_id_posts_id_fk"
  FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "post_metric_snapshots_tenant_id_idx" ON "post_metric_snapshots" ("tenant_id");
CREATE INDEX IF NOT EXISTS "post_metric_snapshots_post_fetched_idx" ON "post_metric_snapshots" ("post_id", "fetched_at");
CREATE INDEX IF NOT EXISTS "post_metric_snapshots_tenant_provider_fetched_idx" ON "post_metric_snapshots" ("tenant_id", "provider", "fetched_at");

ALTER TABLE "post_metric_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "post_metric_snapshots";
CREATE POLICY "tenant_isolation" ON "post_metric_snapshots"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- Penyapu worker menemukan postingan jatuh-tempo tarik LINTAS tenant
-- (id + tenant pemilik + stempel saja), lalu memproses tiap target di
-- dalam konteks tenant-nya. Baca saja; meniru
-- system_post_recurrence_scan (0047).
DROP POLICY IF EXISTS "system_post_analytics_scan" ON "post_metric_snapshots";
CREATE POLICY "system_post_analytics_scan" ON "post_metric_snapshots"
  FOR SELECT
  USING (app_setting('app.post_analytics') = 'scan');

DROP POLICY IF EXISTS "system_post_analytics_scan" ON "posts";
CREATE POLICY "system_post_analytics_scan" ON "posts"
  FOR SELECT
  USING (app_setting('app.post_analytics') = 'scan');
