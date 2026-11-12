-- 0023_google_connections.sql
--
-- Pemisahan Google OAuth PER LAYANAN (keputusan pemilik 2026-11-12):
-- satu consent gabungan Calendar+YouTube+Business di proyek Cloud
-- bersama terbukti rapuh — API yang belum diaktifkan di proyek itu
-- membuat halaman Calendar membalas 502 DAN sinkronisasi kanal
-- YouTube + lokasi Business gagal bersama-sama, dan billing/kuota/
-- persetujuan API ketiga layanan selamanya tercampur. Mulai migrasi
-- ini tiap layanan punya koneksi, consent, dan klien OAuth-nya
-- sendiri.
--
-- 1. Tabel baru `google_connections`: satu baris per (tenant,
--    layanan). Bentuk kolom meniru `google_calendar_connections`
--    persis — token tetap envelope terenkripsi `v1:` AES-256-GCM
--    (secret env CHANNEL_TOKEN_SECRET), TIDAK ada token mentah —
--    ditambah kolom `service` dan RLS tenant_isolation yang sama.
--    `calendar_id` hanya bermakna untuk baris calendar.
--
-- 2. PENYEMAIAN dari `google_calendar_connections` (koneksi gabungan
--    lama): baris calendar SELALU dibuat dari baris lama; baris
--    youtube dan business ikut dibuat dengan MENYALIN envelope token
--    yang sama BILA scopes tersimpan mencakup scope layanan itu
--    (youtube.readonly / business.manage). Penyalinan refresh token
--    yang sama ke beberapa baris layanan aman: refresh token Google
--    tidak berotasi pada pemakaian biasa, dan tiap baris sesudah itu
--    hidup mandiri (consent ulang per layanan mengganti token baris
--    itu saja). Koneksi gabungan yang scope-nya hanya kalender
--    menghasilkan tepat satu baris calendar — tenant menghubungkan
--    YouTube/Business secara terpisah sesudahnya, sesuai desain baru.
--
-- 3. `google_calendar_connections` TIDAK di-drop: ia menjadi arsip
--    koneksi gabungan lama (terdokumentasi di skema Drizzle); semua
--    pembaca/penulis aplikasi beralih ke `google_connections`.

CREATE TYPE "public"."google_service" AS ENUM('calendar', 'youtube', 'business');
--> statement-breakpoint
CREATE TABLE "google_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service" "google_service" NOT NULL,
	"account_email" varchar(320),
	"calendar_id" varchar(255) DEFAULT 'primary' NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "google_connections_tenant_service_unique" ON "google_connections" USING btree ("tenant_id","service");
--> statement-breakpoint
CREATE INDEX "google_connections_tenant_id_idx" ON "google_connections" USING btree ("tenant_id");
--> statement-breakpoint
ALTER TABLE "google_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "google_connections"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
--> statement-breakpoint
INSERT INTO "google_connections" ("tenant_id", "service", "account_email", "calendar_id", "access_token_encrypted", "refresh_token_encrypted", "token_expires_at", "scopes", "created_at", "updated_at")
SELECT "tenant_id", 'calendar', "account_email", "calendar_id", "access_token_encrypted", "refresh_token_encrypted", "token_expires_at", "scopes", "created_at", "updated_at"
  FROM "google_calendar_connections";
--> statement-breakpoint
INSERT INTO "google_connections" ("tenant_id", "service", "account_email", "calendar_id", "access_token_encrypted", "refresh_token_encrypted", "token_expires_at", "scopes", "created_at", "updated_at")
SELECT "tenant_id", 'youtube', "account_email", "calendar_id", "access_token_encrypted", "refresh_token_encrypted", "token_expires_at", "scopes", "created_at", "updated_at"
  FROM "google_calendar_connections"
 WHERE "scopes" LIKE '%https://www.googleapis.com/auth/youtube.readonly%';
--> statement-breakpoint
INSERT INTO "google_connections" ("tenant_id", "service", "account_email", "calendar_id", "access_token_encrypted", "refresh_token_encrypted", "token_expires_at", "scopes", "created_at", "updated_at")
SELECT "tenant_id", 'business', "account_email", "calendar_id", "access_token_encrypted", "refresh_token_encrypted", "token_expires_at", "scopes", "created_at", "updated_at"
  FROM "google_calendar_connections"
 WHERE "scopes" LIKE '%https://www.googleapis.com/auth/business.manage%';
