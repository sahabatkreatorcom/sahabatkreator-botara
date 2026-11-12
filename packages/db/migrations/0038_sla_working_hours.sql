-- 0038_sla_working_hours.sql
--
-- Gelombang G15 (Tier 3 butir 15 program adopsi): JAM KERJA TIM +
-- SLA MANUSIA YANG JUJUR.
--
-- Yang dibangun migrasi ini:
-- - `member_work_schedules`: jadwal kerja mingguan per anggota tim
--   (satu baris per tenant+user; `week` jsonb berbentuk
--   {days: {"0".."6": [{start "HH:MM", end "HH:MM"}]}} di zona waktu
--   baris itu — `timezone` NULL = ikut zona tenant). Anggota TANPA
--   baris tidak punya jadwal pribadi.
-- - `tenants.sla_target_minutes`: target waktu tanggap manusia dalam
--   MENIT JAM KERJA. NULL = SLA belum diatur → tidak ada anggaran SLA
--   dihitung (bukan angka karangan). CHECK 1..10080.
-- - `tenants.default_work_schedule`: jadwal bawaan tenant untuk
--   jendela yang penanggung jawabnya tanpa jadwal pribadi / belum
--   ditugaskan. NULL = jam SLA jendela seperti itu TIDAK berjalan
--   (dilaporkan "tidak terukur" oleh core/sla.ts).
--
-- SLA sendiri TIDAK disimpan sebagai status: jendela, interval
-- tanggung jawab, dan sisa menit selalu diturunkan saat baca dari
-- `messages` + `audit_logs` + jadwal (lihat core/sla.ts) — tidak ada
-- status tersimpan yang bisa basi.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()). Satu tabel baru →
-- hitungan db verify naik 79 → 80 tabel, 106 → 107 policy.

-- ---------------------------------------------------------------------------
-- tenants: pengaturan SLA
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "sla_target_minutes" integer;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "default_work_schedule" jsonb;

ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_sla_target_minutes_range";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_sla_target_minutes_range"
  CHECK ("sla_target_minutes" IS NULL OR ("sla_target_minutes" >= 1 AND "sla_target_minutes" <= 10080));

-- ---------------------------------------------------------------------------
-- member_work_schedules
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "member_work_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "timezone" varchar(64),
  "week" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "member_work_schedules" DROP CONSTRAINT IF EXISTS "member_work_schedules_tenant_id_tenants_id_fk";
ALTER TABLE "member_work_schedules" ADD CONSTRAINT "member_work_schedules_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "member_work_schedules" DROP CONSTRAINT IF EXISTS "member_work_schedules_user_id_users_id_fk";
ALTER TABLE "member_work_schedules" ADD CONSTRAINT "member_work_schedules_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "member_work_schedules_tenant_id_idx" ON "member_work_schedules" ("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "member_work_schedules_tenant_user_unique" ON "member_work_schedules" ("tenant_id", "user_id");

ALTER TABLE "member_work_schedules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "member_work_schedules";
CREATE POLICY "tenant_isolation" ON "member_work_schedules"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
