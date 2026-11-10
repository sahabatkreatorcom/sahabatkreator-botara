-- 0011_platform_admin_management.sql
--
-- Dua hal yang membuat panel admin berhenti bergantung pada SSH:
--
--   1. DAFTAR ADMIN PLATFORM. Sebelumnya satu-satunya sumber adalah
--      `PLATFORM_ADMIN_EMAILS` di .env. Menambah satu admin berarti mengubah
--      file, recreate container, dan menunggu deploy. Lebih buruk: akun yang
--      sudah terdaftar tidak otomatis menjadi admin, dan tidak ada cara
--      melihat SIAPA yang berhak tanpa membaca env.
--      Tabel `platform_admins` menyimpan admin yang dikelola dari panel.
--      Env TIDAK dihapus — ia tetap berlaku sebagai bootstrap/darurat
--      (mis. DB rusak), tampil di panel sebagai baris terkunci.
--
--   2. STATUS BACKUP. Cron backup menulis ke berkas log di host, sehingga
--      panel tidak punya sumber yang bisa dibaca. Tabel `backup_runs`
--      menerima SATU baris per eksekusi (harian / drill) dari skrip backup.
--      Kalau tabel ini kosong, panel berkata "belum ada catatan" — bukan
--      "backup aman".
--
-- Keduanya adalah tabel GLOBAL tanpa tenant_id dan tanpa RLS, mengikuti
-- pola `users` / `plans` / `platform_settings`: yang menjaga aksesnya
-- adalah gerbang API (allowlist admin), bukan isolasi tenant.

CREATE TABLE IF NOT EXISTS "platform_admins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" varchar(320) NOT NULL UNIQUE,
  "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "platform_admins_email_idx" ON "platform_admins" ("email");

CREATE TABLE IF NOT EXISTS "backup_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" varchar(16) NOT NULL,
  "status" varchar(16) NOT NULL,
  "size_bytes" bigint,
  "detail" varchar(255),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "backup_runs_kind_created_idx" ON "backup_runs" ("kind", "created_at" DESC);

-- 0002 memasang ALTER DEFAULT PRIVILEGES, tetapi grant itu hanya berlaku
-- untuk tabel yang dibuat role yang sama. Grant eksplisit di sini membuat
-- migrasi ini aman dijalankan baik oleh pemilik skema maupun di PGlite
-- (tempat role sk_app tidak selalu ada — karena itu ada pengecekan).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sk_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_admins", "backup_runs" TO sk_app;
  END IF;
END $$;
