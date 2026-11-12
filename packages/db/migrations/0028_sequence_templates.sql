-- 0028_sequence_templates.sql
--
-- Gelombang G2 (lapisan templat sequence): tenant dapat menyimpan
-- sequence dari formulir buat/edit sequence sebagai templat
-- pribadinya, lalu memakainya lagi dari galeri template yang sama.
--
-- Yang disimpan tabel ini HANYA templat pribadi tenant. Template
-- bawaan sequence (Sambutan Pelanggan Baru, Pengingat Pesanan
-- Terbengkalai, Follow-up Lead Dingin, Edukasi Produk Bertahap,
-- Seri Materi Kreator, Reaktivasi Pelanggan Lama) adalah katalog
-- STATIS dwibahasa di kontrak (`AUTOMATION_TEMPLATES` pada
-- @sahabat-kreator/contracts) dan tidak pernah menjadi baris di
-- sini — galeri menggabungkan keduanya di klien, dibedakan oleh
-- sumbernya.
--
-- Tabel ini meniru POLA BERSAMA "SIMPAN TEMPLAT PRIBADI" dari
-- agent_instruction_templates (migrasi 0027) — pola yang sama,
-- tabel yang berbeda: payload sequence adalah daftar langkah
-- terurut {delayMinutes, text} (jsonb `steps`, posisi = indeks + 1),
-- bukan satu teks instruction. Isi satu baris = salinan persis
-- keadaan formulir saat disimpan: nama templat (bebas dari
-- pemilik), kata kunci pemicu, mode cocok, dan langkah-langkahnya.
-- Memakai templat membuat automation sequence BARU yang selalu
-- NONAKTIF (keselamatan yang sama dengan instantiate katalog);
-- mengedit/menghapus templat tidak menyentuh automation mana pun.
-- Ubah templat tersimpan di v1 = hapus + simpan ulang.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()).

CREATE TABLE IF NOT EXISTS "sequence_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "keywords" text[] DEFAULT '{}' NOT NULL,
  "match" varchar(16) DEFAULT 'exact' NOT NULL,
  "steps" jsonb DEFAULT '[]' NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "sequence_templates" DROP CONSTRAINT IF EXISTS "sequence_templates_tenant_id_tenants_id_fk";
ALTER TABLE "sequence_templates" ADD CONSTRAINT "sequence_templates_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "sequence_templates" DROP CONSTRAINT IF EXISTS "sequence_templates_created_by_users_id_fk";
ALTER TABLE "sequence_templates" ADD CONSTRAINT "sequence_templates_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "sequence_templates_tenant_id_idx" ON "sequence_templates" ("tenant_id");

ALTER TABLE "sequence_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "sequence_templates";
CREATE POLICY "tenant_isolation" ON "sequence_templates"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
