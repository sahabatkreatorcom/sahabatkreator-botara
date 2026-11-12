-- 0029_flow_versions.sql
--
-- Gelombang G3 (Tier 1 butir 3 program adopsi): VERSIONING FLOW.
-- Pola diadopsi dari riset zernflow (00010_flow_versions.sql, MIT):
-- snapshot graf pada setiap publish + run mem-pin versinya.
--
-- Masalah yang ditutup: eksekutor flow membaca graf LIVE dari tabel
-- `flows` pada tiap langkah. Graf flow aktif memang tidak bisa diedit
-- langsung (edit hanya draft), tetapi jalur nonaktifkan → edit →
-- aktifkan mengubah graf di bawah run yang masih berjalan/terparkir,
-- sehingga run menyelesaikan versi graf yang berbeda dari yang
-- memulainya.
--
-- Yang dibangun migrasi ini:
-- - `flow_versions`: SATU baris snapshot per AKTIVASI flow — nomor
--   urut per flow (unik (flow_id, version)), graf utuh jsonb, nama
--   flow saat itu, pengaktif, dan `restored_from_version` bila versi
--   lahir dari pemulihan versi lama. Baris APPEND-ONLY: tidak pernah
--   diubah; pemulihan melahirkan versi BARU (nomor lanjut), sejarah
--   tidak ditulis ulang. Ditulis core di dalam transaksi aktivasi.
-- - `flow_runs.flow_version_id` + `flow_runs.flow_version`: pin versi
--   yang dijalankan run. Eksekutor membaca graf dari snapshot
--   ter-pin, BUKAN graf live. Keduanya NULLABLE dan migrasi ini
--   SENGAJA tidak mengisi baris lama: run yang lahir sebelum G3
--   (dan run dari flow aktif warisan yang belum pernah diaktifkan
--   ulang) tetap tanpa pin dan eksekutor jatuh kembali ke graf live
--   secara jujur — tidak ada snapshot retroaktif yang dikarang.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()).

CREATE TABLE IF NOT EXISTS "flow_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "flow_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "name" varchar(255) NOT NULL,
  "graph" jsonb NOT NULL,
  "restored_from_version" integer,
  "activated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "flow_versions" DROP CONSTRAINT IF EXISTS "flow_versions_tenant_id_tenants_id_fk";
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "flow_versions" DROP CONSTRAINT IF EXISTS "flow_versions_flow_id_flows_id_fk";
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flow_id_flows_id_fk"
  FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE cascade;

ALTER TABLE "flow_versions" DROP CONSTRAINT IF EXISTS "flow_versions_activated_by_user_id_users_id_fk";
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_activated_by_user_id_users_id_fk"
  FOREIGN KEY ("activated_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE UNIQUE INDEX IF NOT EXISTS "flow_versions_flow_version_unique" ON "flow_versions" ("flow_id", "version");
CREATE INDEX IF NOT EXISTS "flow_versions_tenant_id_idx" ON "flow_versions" ("tenant_id");
CREATE INDEX IF NOT EXISTS "flow_versions_flow_id_idx" ON "flow_versions" ("flow_id");

ALTER TABLE "flow_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "flow_versions";
CREATE POLICY "tenant_isolation" ON "flow_versions"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "flow_version_id" uuid;
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "flow_version" integer;

ALTER TABLE "flow_runs" DROP CONSTRAINT IF EXISTS "flow_runs_flow_version_id_flow_versions_id_fk";
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_version_id_flow_versions_id_fk"
  FOREIGN KEY ("flow_version_id") REFERENCES "flow_versions"("id") ON DELETE set null;
