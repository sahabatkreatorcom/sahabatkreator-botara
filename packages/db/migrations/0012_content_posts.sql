-- 0012_content_posts.sql
--
-- Content Schedule (Fase 23): postingan terjadwal ke linimasa channel.
--
-- Kenapa tabel BARU dan bukan menumpang `broadcasts`:
-- broadcast punya penerima (satu baris `broadcast_recipients` per kontak) dan
-- metrik "terkirim/dibaca". Postingan channel tidak punya penerima sama
-- sekali; ia satu baris di linimasa publik. Menggabungkan keduanya berarti
-- separuh kolom NULL dan dua arti pada kolom `status` yang sama.
--
-- `post_media` menyimpan lampiran berurutan (album) yang menunjuk baris
-- `media` yang SUDAH ada. Dua konsekuensi yang harus dijaga bersama:
--
--   1. `media-gc` wajib mengecualikan media yang dirujuk `post_media`.
--      Tanpa itu, aset postingan yang dijadwalkan dua minggu ke depan
--      dihapus sapuan "tak dirujuk" (masa tenggang 7 hari) — diam-diam,
--      tanpa error, dan baru ketahuan saat jam tayang. Kode sapuannya
--      diperbarui di commit yang sama.
--   2. FK `media_id` sengaja RESTRICT, bukan CASCADE. Bila penghitungan
--      rujukan di (1) suatu saat salah, kita ingin sapuan GAGAL berisik,
--      bukan mengosongkan lampiran sebuah post yang sudah terjadwal.
--
-- Status: draft → scheduled → publishing → published | failed, dan
-- cancelled dari draft/scheduled. `publishing` adalah klaim atomik —
-- satu-satunya keadaan yang boleh benar-benar mengirim ke provider.

DO $$ BEGIN
  CREATE TYPE "post_status" AS ENUM (
    'draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "posts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "title" varchar(255) NOT NULL,
  "caption" text DEFAULT '' NOT NULL,
  "status" "post_status" DEFAULT 'draft' NOT NULL,
  "scheduled_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "provider_message_id" varchar(255),
  "error_code" varchar(128),
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "post_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "post_id" uuid NOT NULL,
  "media_id" uuid NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_tenant_id_tenants_id_fk";
ALTER TABLE "posts" ADD CONSTRAINT "posts_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_channel_account_id_channel_accounts_id_fk";
ALTER TABLE "posts" ADD CONSTRAINT "posts_channel_account_id_channel_accounts_id_fk"
  FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE cascade;

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_conversation_id_conversations_id_fk";
ALTER TABLE "posts" ADD CONSTRAINT "posts_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade;

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_created_by_user_id_users_id_fk";
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null;

ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_tenant_id_tenants_id_fk";
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_post_id_posts_id_fk";
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_posts_id_fk"
  FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE cascade;

ALTER TABLE "post_media" DROP CONSTRAINT IF EXISTS "post_media_media_id_media_id_fk";
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_media_id_media_id_fk"
  FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE restrict;

CREATE INDEX IF NOT EXISTS "posts_tenant_scheduled_idx" ON "posts" ("tenant_id", "scheduled_at");
CREATE INDEX IF NOT EXISTS "posts_tenant_status_idx" ON "posts" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "posts_conversation_idx" ON "posts" ("conversation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "post_media_post_position_unique" ON "post_media" ("post_id", "position");
CREATE INDEX IF NOT EXISTS "post_media_media_id_idx" ON "post_media" ("media_id");
CREATE INDEX IF NOT EXISTS "post_media_tenant_id_idx" ON "post_media" ("tenant_id");

-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id.
ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "posts";
CREATE POLICY "tenant_isolation" ON "posts"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "post_media" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "post_media";
CREATE POLICY "tenant_isolation" ON "post_media"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
