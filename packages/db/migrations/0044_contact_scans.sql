-- 0044_contact_scans.sql
--
-- Gelombang G18 butir 2 (Tier 3 — penutup): PINDAI PELANGGAN OTOMATIS.
-- Pekerjaan latar memindai riwayat komentar kanal untuk menemukan
-- penulis komentar yang belum menjadi kontak, menyajikannya sebagai
-- kandidat yang bisa DITINJAU dulu, lalu mengimpor yang dipilih.
--
-- Sumber pindai adalah tabel `comments`: penulis DM selalu menjadi
-- kontak saat pesan pertamanya masuk (semua ingest kanal membuat
-- kontak + identitas), tetapi penulis komentar tidak —
-- `comments.contact_id` hanya terisi bila aksi comment-to-DM pernah
-- berjalan baginya. Komentator adalah satu-satunya populasi lawan
-- bicara yang benar-benar ada di data tanpa menjadi kontak.
--
-- Yang dibangun migrasi ini:
-- - `contact_scan_runs`: satu pekerjaan pindai per baris (status
--   queued/running/completed/failed + statistik hasil jsonb).
-- - `contact_scan_candidates`: satu baris per penulis unik per akun
--   per pindai, terklasifikasi pending / imported / already_contact /
--   self_account / skipped_existing. Penulis yang adalah akun kanal
--   tenant SENDIRI (external_user_id = channel_accounts.external_id)
--   diklasifikasikan self_account dan tidak pernah diimpor —
--   pelajaran pemisahan akun-sendiri dari gelombang inbox/contacts.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()).
-- Dua tabel baru + 2 policy → hitungan db verify naik 84 → 86 tabel,
-- 112 → 114 policy.

CREATE TABLE IF NOT EXISTS "contact_scan_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "status" varchar(16) DEFAULT 'queued' NOT NULL,
  "stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

ALTER TABLE "contact_scan_runs" DROP CONSTRAINT IF EXISTS "contact_scan_runs_tenant_id_tenants_id_fk";
ALTER TABLE "contact_scan_runs" ADD CONSTRAINT "contact_scan_runs_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "contact_scan_runs_tenant_id_idx" ON "contact_scan_runs" ("tenant_id");

ALTER TABLE "contact_scan_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "contact_scan_runs";
CREATE POLICY "tenant_isolation" ON "contact_scan_runs"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

CREATE TABLE IF NOT EXISTS "contact_scan_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "scan_run_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL,
  "external_user_id" varchar(255) NOT NULL,
  "display_name" varchar(255),
  "username" varchar(255),
  "comment_count" integer DEFAULT 0 NOT NULL,
  "last_comment_at" timestamp with time zone,
  "sample_text" text,
  "status" varchar(24) DEFAULT 'pending' NOT NULL,
  "imported_contact_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "contact_scan_candidates" DROP CONSTRAINT IF EXISTS "contact_scan_candidates_tenant_id_tenants_id_fk";
ALTER TABLE "contact_scan_candidates" ADD CONSTRAINT "contact_scan_candidates_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "contact_scan_candidates" DROP CONSTRAINT IF EXISTS "contact_scan_candidates_scan_run_id_contact_scan_runs_id_fk";
ALTER TABLE "contact_scan_candidates" ADD CONSTRAINT "contact_scan_candidates_scan_run_id_contact_scan_runs_id_fk"
  FOREIGN KEY ("scan_run_id") REFERENCES "contact_scan_runs"("id") ON DELETE cascade;

ALTER TABLE "contact_scan_candidates" DROP CONSTRAINT IF EXISTS "contact_scan_candidates_channel_account_id_channel_accounts_id_fk";
ALTER TABLE "contact_scan_candidates" ADD CONSTRAINT "contact_scan_candidates_channel_account_id_channel_accounts_id_fk"
  FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE cascade;

ALTER TABLE "contact_scan_candidates" DROP CONSTRAINT IF EXISTS "contact_scan_candidates_imported_contact_id_contacts_id_fk";
ALTER TABLE "contact_scan_candidates" ADD CONSTRAINT "contact_scan_candidates_imported_contact_id_contacts_id_fk"
  FOREIGN KEY ("imported_contact_id") REFERENCES "contacts"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "contact_scan_candidates_tenant_id_idx" ON "contact_scan_candidates" ("tenant_id");
CREATE INDEX IF NOT EXISTS "contact_scan_candidates_run_id_idx" ON "contact_scan_candidates" ("scan_run_id");
CREATE UNIQUE INDEX IF NOT EXISTS "contact_scan_candidates_run_account_author_unique" ON "contact_scan_candidates" ("scan_run_id", "channel_account_id", "external_user_id");

ALTER TABLE "contact_scan_candidates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "contact_scan_candidates";
CREATE POLICY "tenant_isolation" ON "contact_scan_candidates"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
