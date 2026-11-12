-- 0027_agent_instruction_templates.sql
--
-- Templat Instruction /agents (perintah pemilik 2026-11-12): tenant dapat
-- menyimpan instruction dari formulir buat/edit agent sebagai templat
-- pribadinya, lalu memakainya lagi dari galeri templat yang sama.
--
-- Yang disimpan tabel ini HANYA templat pribadi tenant. Templat bawaan
-- (CS Ramah, Sales Penjual, Admin Booking, Penjawab FAQ Hemat, Penangan
-- Komplain, Penyaring Prospek) adalah katalog STATIS di kontrak
-- (`AGENT_INSTRUCTION_TEMPLATES` pada @sahabat-kreator/contracts) dan
-- tidak pernah menjadi baris di sini — galeri menggabungkan keduanya
-- di klien, dibedakan oleh sumbernya.
--
-- Isi satu baris = salinan persis keadaan formulir saat disimpan:
-- nama templat (bebas dari pemilik), instruction, mode saran, dan
-- bahasa saran (NULL = tanpa saran bahasa). Memakai templat menyalin
-- isinya ke formulir; mengedit/menghapus templat tidak menyentuh agent
-- mana pun. Ubah templat tersimpan di v1 = hapus + simpan ulang.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()).

CREATE TABLE IF NOT EXISTS "agent_instruction_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "system_prompt" text DEFAULT '' NOT NULL,
  "mode" "agent_mode" DEFAULT 'suggest' NOT NULL,
  "language" varchar(16),
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "agent_instruction_templates" DROP CONSTRAINT IF EXISTS "agent_instruction_templates_tenant_id_tenants_id_fk";
ALTER TABLE "agent_instruction_templates" ADD CONSTRAINT "agent_instruction_templates_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "agent_instruction_templates" DROP CONSTRAINT IF EXISTS "agent_instruction_templates_created_by_users_id_fk";
ALTER TABLE "agent_instruction_templates" ADD CONSTRAINT "agent_instruction_templates_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "agent_instruction_templates_tenant_id_idx" ON "agent_instruction_templates" ("tenant_id");

ALTER TABLE "agent_instruction_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_instruction_templates";
CREATE POLICY "tenant_isolation" ON "agent_instruction_templates"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
