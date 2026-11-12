-- 0043_contact_field_definitions.sql
--
-- Gelombang G18 butir 1 (Tier 3 — penutup): SKEMA FIELD KUSTOM BERTIPE.
-- Tenant dapat mendefinisikan field kustom kontak dengan tipe
-- (text/number/date/select/boolean) + opsi pilihan + kewajiban, dan
-- penulisan nilai kontak lewat API + impor CSV divalidasi terhadap
-- definisi itu.
--
-- Yang dibangun migrasi ini:
-- - `contact_field_definitions`: SATU baris per (tenant, kunci field).
--   Nilai kontak TIDAK pindah ke sini — nilai tetap di
--   `contacts.custom_fields` (peta string→string, kontrak Fase 13A
--   tidak berubah). Tabel ini murni skema: kunci tanpa definisi tetap
--   field bebas persis seperti sebelumnya; menghapus definisi tidak
--   menghapus nilai tersimpan (nilai menjadi field bebas kembali);
--   mengubah tipe definisi tidak menulis ulang nilai lama (validasi
--   hanya berlaku pada penulisan berikutnya).
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()).
-- Satu tabel baru + 1 policy → hitungan db verify naik 83 → 84 tabel,
-- 111 → 112 policy.

CREATE TABLE IF NOT EXISTS "contact_field_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "key" varchar(64) NOT NULL,
  "label" varchar(100) NOT NULL,
  "type" varchar(16) NOT NULL,
  "options" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "required" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "contact_field_definitions" DROP CONSTRAINT IF EXISTS "contact_field_definitions_tenant_id_tenants_id_fk";
ALTER TABLE "contact_field_definitions" ADD CONSTRAINT "contact_field_definitions_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

CREATE UNIQUE INDEX IF NOT EXISTS "contact_field_definitions_tenant_key_unique" ON "contact_field_definitions" ("tenant_id", "key");
CREATE INDEX IF NOT EXISTS "contact_field_definitions_tenant_id_idx" ON "contact_field_definitions" ("tenant_id");

ALTER TABLE "contact_field_definitions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "contact_field_definitions";
CREATE POLICY "tenant_isolation" ON "contact_field_definitions"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
