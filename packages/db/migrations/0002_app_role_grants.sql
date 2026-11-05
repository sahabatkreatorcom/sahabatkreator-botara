-- 0002_app_role_grants.sql
--
-- Hak role APLIKASI (bukan pemilik skema).
--
-- Mengapa ada di rantai migrasi, bukan di dokumen: `reset` skema menghapus
-- seluruh hak role aplikasi sementara API tetap hidup, dan setiap query
-- gagal "permission denied" tanpa ada yang memeriksa. Dengan berada di sini,
-- `db:migrate` selalu meninggalkan DB dalam keadaan bisa dipakai.
--
-- Role dipisah dari pemilik tabel karena RLS TIDAK berlaku bagi pemilik:
-- bila API memakai role pemilik, seluruh isolasi tenant di
-- 0001_rls_tenant_isolation.sql menjadi hiasan. `provision.ts doctor`
-- memeriksa pemisahan ini.
--
-- Nama role dapat diganti lewat env APP_DB_ROLE (default `sk_app`); bila
-- diganti, jalankan `tsx scripts/provision.ts grant` untuk role tersebut.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sk_app') THEN
    CREATE ROLE sk_app NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO sk_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sk_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sk_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sk_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sk_app;
