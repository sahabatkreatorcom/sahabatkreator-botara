-- 0036_wacrm_extras.sql
--
-- Gelombang G13 (Tier 2 butir 13 program adopsi — pelengkap wacrm).
-- Tiga tambahan skema kecil, masing-masing menempel pada tabel yang
-- sudah ada:
--
-- - `users.last_seen_at`: stempel detak kehadiran tim (butir 9).
--   Ditulis endpoint heartbeat (dijinakkan di core: hanya ditulis bila
--   stempel lama berusia >45 detik), dibaca daftar member tim untuk
--   penanda online/terakhir-aktif. Tabel users GLOBAL (tanpa RLS) —
--   kehadiran memang fakta per orang, bukan per tenant; permukaan tim
--   hanya menampilkannya untuk member tenant yang sama.
-- - `messages.error_detail` jsonb: detail teknis kegagalan kirim
--   (butir 6 — penerjemah error Meta). `error_code` yang ada tetap
--   kode aman ringkas (`meta_graph_131047`); kolom ini menampung
--   { description, fbtraceId, subcode } persis dari body error Graph
--   (aman: tidak pernah memuat token — lihat channel-core/graph.ts)
--   agar panel pesan gagal bisa menampilkan bahasa awam DARI kode +
--   detail teknis mentahnya untuk dukungan. NULL untuk pesan yang
--   gagal sebelum era kolom ini / gagal tanpa detail provider.
-- - `message_reactions`: reaksi emoji pada pesan (butir 11). Satu baris
--   per (pesan, aktor, emoji); aktor 'user' = anggota tim (lewat API,
--   diteruskan ke provider sejauh API-nya mendukung), aktor 'contact'
--   = kontak (dari webhook provider yang melaporkan reaksi masuk).
--   `actor_key` adalah kunci idempotensi aktor dalam satu pesan:
--   'user:<userId>' untuk tim, 'contact:<externalUserId>' untuk kontak.
--   Tabel ini SUMBER TAMPILAN inbox; pengiriman keluar ke provider
--   adalah efek samping API (WhatsApp/Telegram), bukan dibaca poller.
--
-- Isolasi tenant: pola yang sama dengan seluruh tabel ber-tenant_id
-- (RLS `tenant_isolation` dengan app_tenant_id()). Satu tabel baru →
-- hitungan db verify naik 76 → 77 tabel, 103 → 104 policy.

-- ---------------------------------------------------------------------------
-- users.last_seen_at (kehadiran tim)
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;

-- ---------------------------------------------------------------------------
-- messages.error_detail (detail teknis kegagalan)
-- ---------------------------------------------------------------------------

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "error_detail" jsonb;

-- ---------------------------------------------------------------------------
-- message_reactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "message_reactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "actor_type" varchar(16) NOT NULL,
  "actor_user_id" uuid,
  "actor_key" varchar(128) NOT NULL,
  "emoji" varchar(16) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "message_reactions" DROP CONSTRAINT IF EXISTS "message_reactions_tenant_id_tenants_id_fk";
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;

ALTER TABLE "message_reactions" DROP CONSTRAINT IF EXISTS "message_reactions_message_id_messages_id_fk";
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade;

ALTER TABLE "message_reactions" DROP CONSTRAINT IF EXISTS "message_reactions_conversation_id_conversations_id_fk";
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade;

ALTER TABLE "message_reactions" DROP CONSTRAINT IF EXISTS "message_reactions_actor_user_id_users_id_fk";
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null;

ALTER TABLE "message_reactions" DROP CONSTRAINT IF EXISTS "message_reactions_actor_type_valid";
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_actor_type_valid"
  CHECK ("actor_type" IN ('user', 'contact'));

CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_message_actor_emoji_unique"
  ON "message_reactions" ("message_id", "actor_key", "emoji");
CREATE INDEX IF NOT EXISTS "message_reactions_tenant_id_idx" ON "message_reactions" ("tenant_id");
CREATE INDEX IF NOT EXISTS "message_reactions_message_id_idx" ON "message_reactions" ("message_id");
CREATE INDEX IF NOT EXISTS "message_reactions_conversation_id_idx" ON "message_reactions" ("conversation_id");

ALTER TABLE "message_reactions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "message_reactions";
CREATE POLICY "tenant_isolation" ON "message_reactions"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());
