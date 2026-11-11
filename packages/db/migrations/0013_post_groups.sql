-- 0013_post_groups.sql
--
-- Grup multi-target untuk content schedule (Gelombang 0, butir 3
-- roadmap): satu konten induk diterbitkan ke N channel sekaligus.
--
-- Bentuknya sengaja TIDAK mengubah model Fase 23:
--
--   - `posts` tetap satu baris per linimasa. State machine, klaim
--     atomik, dan pencocokan `scheduled_at` hidup per baris, karena
--     status antar platform memang boleh (dan akan) berbeda: IG bisa
--     terbit sementara Telegram gagal, dan keduanya harus tercatat
--     apa adanya.
--   - `post_groups` hanya tabel pengelompok: judul induk + pemilik.
--     `posts.group_id` menunjuk ke sana dengan ON DELETE SET NULL —
--     menghapus label grup tidak boleh menghapus riwayat postingan
--     yang sudah terbit.
--
-- Tanpa grup, "satu konten ke banyak channel" akan memaksa kolom
-- target menjadi jamak dan separuh state machine ditulis ulang.
-- Dengan grup, pembuatan multi-target hanyalah N kali pembuatan yang
-- sudah ada, dalam satu transaksi.

CREATE TABLE IF NOT EXISTS "post_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "title" varchar(255) NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "post_groups" DROP CONSTRAINT IF EXISTS "post_groups_tenant_id_tenants_id_fk";
ALTER TABLE "post_groups" ADD CONSTRAINT "post_groups_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "post_groups" DROP CONSTRAINT IF EXISTS "post_groups_created_by_user_id_users_id_fk";
ALTER TABLE "post_groups" ADD CONSTRAINT "post_groups_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null;

ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "group_id" uuid;

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_group_id_post_groups_id_fk";
ALTER TABLE "posts" ADD CONSTRAINT "posts_group_id_post_groups_id_fk"
  FOREIGN KEY ("group_id") REFERENCES "post_groups"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "posts_group_idx" ON "posts" ("group_id");

-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id.
ALTER TABLE "post_groups" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "post_groups";
CREATE POLICY "tenant_isolation" ON "post_groups"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
