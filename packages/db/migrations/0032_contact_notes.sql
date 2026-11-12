-- 0032_contact_notes.sql
--
-- Gelombang G8 (Tier 1 butir 6 program adopsi): CATATAN LEVEL KONTAK.
--
-- Masalah yang ditutup: catatan internal tim selama ini hanya bisa
-- menempel pada PERCAKAPAN (`conversation_notes`, Fase 9C). Hal yang
-- perlu diingat tentang ORANGNYA — lintas percakapan dan lintas kanal
-- — tidak punya rumah: ditulis ulang di tiap utas atau hilang.
--
-- Yang dibangun migrasi ini: tabel `contact_notes`, saudara persis
-- `conversation_notes` dengan `contact_id` menggantikan
-- `conversation_id`:
-- - Tabel TERPISAH dari `messages` dengan alasan struktural yang sama
--   seperti 9C: tidak ada jalur pengiriman (poller provider, broadcast,
--   agent) yang membaca tabel ini, jadi catatan tidak bisa terkirim
--   ke kontak — bukan difilter, melainkan tidak berada di tabel yang
--   dibaca pengirim.
-- - `author_user_id` ON DELETE SET NULL: catatan bertahan walau
--   penulis keluar/terhapus; penulis yatim hanya bisa dihapus
--   owner/admin (aturan hapus ditegakkan di core, pola 9C).
-- - Catatan kontak dan catatan percakapan SENGAJA tidak dicampur:
--   tidak ada kolom penanda bersama dan tidak ada query yang membaca
--   keduanya sebagai satu daftar.
--
-- Linimasa aktivitas kontak (bagian kedua G8) TIDAK menambah tabel:
-- ia perakitan baca-saja dari audit_logs + baris yang sudah ada.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()).

CREATE TABLE IF NOT EXISTS "contact_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "contact_id" uuid NOT NULL,
  "author_user_id" uuid,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "contact_notes" DROP CONSTRAINT IF EXISTS "contact_notes_tenant_id_tenants_id_fk";
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "contact_notes" DROP CONSTRAINT IF EXISTS "contact_notes_contact_id_contacts_id_fk";
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_contacts_id_fk"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE cascade;

ALTER TABLE "contact_notes" DROP CONSTRAINT IF EXISTS "contact_notes_author_user_id_users_id_fk";
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_author_user_id_users_id_fk"
  FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "contact_notes_tenant_id_idx" ON "contact_notes" ("tenant_id");
CREATE INDEX IF NOT EXISTS "contact_notes_contact_created_idx" ON "contact_notes" ("contact_id", "created_at");

ALTER TABLE "contact_notes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "contact_notes";
CREATE POLICY "tenant_isolation" ON "contact_notes"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
