-- 0001_rls_tenant_isolation.sql
--
-- Isolasi tenant lewat Row Level Security PostgreSQL.
--
-- ATURAN (baca seluruh berkas ini sebelum mengubahnya):
--
-- 1. Setiap tabel ber-`tenant_id` WAJIB punya policy `tenant_isolation`
--    (FOR ALL, USING + WITH CHECK). Konteks dibaca dari setting
--    transaction-local `app.tenant_id` yang dipasang `withTenant()`
--    (@sahabat-kreator/core). Konteks kosong = NOL baris (fail closed),
--    bukan error — jadi bug "lupa konteks" muncul sebagai data kosong.
-- 2. RLS hanya ENABLE, tidak FORCE: role pemilik skema (migrasi) dan
--    worker sistem yang memang lintas tenant melewatinya secara sadar.
--    Role APLIKASI (sk_app) bukan pemilik tabel sehingga selalu tunduk RLS.
-- 3. Policy tambahan (`*_lookup`, `system_*`) HANYA membuka baris yang
--    dibutuhkan satu alur publik/sistem, dan hanya bila setting
--    transaction-local terkait di-set. Tidak ada policy `USING (true)`.
-- 4. Nama policy sengaja stabil: kode menyebutnya di komentar & audit.
-- 5. Predikat konteks HANYA lewat helper di bawah (app_tenant_id,
--    app_user_id, app_setting). Jangan menyalin ekspresi
--    current_setting() ke dalam policy: satu definisi, satu tempat salah.
--
-- Dihasilkan ulang 2026-11-05 setelah folder migrasi lama dihapus;
-- daftar tabel diturunkan dari packages/db/src/schema/*.ts.

-- ----------------------------------------------------------------
-- 0. Helper konteks transaksi
-- ----------------------------------------------------------------
-- `current_setting(nama, true)` mengembalikan NULL bila belum di-set dan
-- string kosong bila di-set kosong; nullif menyamakan keduanya menjadi
-- NULL sehingga cast ::uuid tidak pernah gagal.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $fn$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $fn$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $fn$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $fn$;

CREATE OR REPLACE FUNCTION app_setting(key text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $fn$ SELECT nullif(current_setting(key, true), '') $fn$;

-- ----------------------------------------------------------------
-- 1. Policy dasar: satu tenant per transaksi (51 tabel)
-- ----------------------------------------------------------------
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "api_keys"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invitations"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "subscriptions"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "tenant_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_members"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_logs"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "integration_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "integration_log"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "outbox_events"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "usage_ledger" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "usage_ledger"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "webhook_inbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "webhook_inbox"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "channel_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_accounts"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "channel_identities" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "channel_identities"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "contacts"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "conversation_notes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "conversation_notes"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "conversations"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "media"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "messages"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "automation_runs"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "automation_steps" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "automation_steps"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "automations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "automations"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "sequence_enrollments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sequence_enrollments"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "agent_suggestions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agent_suggestions"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agents"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "kb_chunks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "kb_chunks"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "kb_documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "kb_documents"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "kb_source_documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "kb_source_documents"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "cart_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "cart_items"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "carts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "carts"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order_items"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "orders"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "payment_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payment_links"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "products"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "profile_photos" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "profile_photos"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "broadcast_recipients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "broadcast_recipients"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "broadcasts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "broadcasts"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "whatsapp_templates"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "comments"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "flow_experiment_assignments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "flow_experiment_assignments"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "flow_run_steps" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "flow_run_steps"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "flow_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "flow_runs"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "flows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "flows"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "saved_replies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "saved_replies"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "growth_link_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "growth_link_events"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "growth_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "growth_links"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "segments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "segments"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "tenant_opt_in_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_opt_in_settings"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "appointment_availability" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointment_availability"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "appointment_services" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointment_services"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "appointment_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointment_settings"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bookings"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "google_calendar_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "google_calendar_connections"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "payment_provider_configs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payment_provider_configs"
  FOR ALL
  USING ("tenant_id" = app_tenant_id())
  WITH CHECK ("tenant_id" = app_tenant_id());

-- ----------------------------------------------------------------
-- 2. Lengan lintas-tenant yang sempit (bukan bypass)
-- ----------------------------------------------------------------
-- Daftar workspace milik user yang login: policy SELECT terpisah yang
-- OR dengan tenant_isolation, jadi user melihat baris keanggotaannya
-- sendiri TANPA konteks tenant. WITH CHECK tetap hanya konteks tenant.
CREATE POLICY "tenant_members_self_lookup" ON "tenant_members"
  FOR SELECT
  USING ("user_id" = app_user_id());

-- Relay outbox: worker memindai event belum terbit lintas tenant.
CREATE POLICY "system_relay" ON "outbox_events"
  FOR ALL
  USING (app_setting('app.system_relay') = 'outbox')
  WITH CHECK (app_setting('app.system_relay') = 'outbox');

-- Pemurnian channel ter-trash: baca akun lintas tenant untuk purge.
-- HANYA baris trashed yang terbuka; akun aktif tidak pernah terlihat
-- lewat lengan ini.
CREATE POLICY "system_purge_scan" ON "channel_accounts"
  FOR SELECT
  USING (app_setting('app.system_relay') = 'channel_purge'
     AND "trashed_at" IS NOT NULL);

-- Siklus hidup token Meta: pindai akun messenger/instagram/whatsapp.
CREATE POLICY "meta_token_lifecycle_scan" ON "channel_accounts"
  FOR SELECT
  USING (app_setting('app.system_relay') = 'meta_token_lifecycle');

-- Webhook masuk tanpa sesi: provider + external id menentukan akun.
CREATE POLICY "provider_external_lookup" ON "channel_accounts"
  FOR SELECT
  USING ("provider"::text = app_setting('app.channel_provider')
     AND "external_id" = app_setting('app.channel_external_id'));

-- Webhook Telegram membawa id akun di URL, bukan tenant.
CREATE POLICY "telegram_webhook_lookup" ON "channel_accounts"
  FOR SELECT
  USING ("provider"::text = 'telegram'
     AND "id" = app_setting('app.telegram_channel_account_id')::uuid);

-- Widget webchat: siteKey publik menentukan akun + tenant.
CREATE POLICY "webchat_site_lookup" ON "channel_accounts"
  FOR SELECT
  USING ("provider"::text = 'webchat'
     AND "external_id" = app_setting('app.webchat_site_key'));

-- Autentikasi API key: hash kunci menentukan tenant, tanpa konteks tenant.
CREATE POLICY "public_key_lookup" ON "api_keys"
  FOR SELECT
  USING ("key_hash" = app_setting('app.api_key_hash'));

-- Halaman bayar publik /pay/:code.
CREATE POLICY "public_code_lookup" ON "payment_links"
  FOR SELECT
  USING ("code" = app_setting('app.payment_code'));

-- Penerimaan undangan /invitations/:token (hash token, bukan tenant).
CREATE POLICY "invitation_token_lookup" ON "invitations"
  FOR SELECT
  USING ("token_hash" = app_setting('app.invitation_token_hash'));

-- Tautan pertumbuhan publik /go/:slug.
CREATE POLICY "growth_link_public_lookup" ON "growth_links"
  FOR SELECT
  USING ("slug" = app_setting('app.growth_slug'));

-- Panel Admin Platform: kredensial provider milik platform, bukan tenant.
-- Tabel ini TIDAK punya tenant_id, jadi RLS-nya bukan isolasi tenant
-- melainkan gerbang tunggal: tanpa flag admin, nol baris dan nol tulis.
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "platform_settings_admin" ON "platform_settings"
  FOR ALL
  USING (app_setting('app.platform_settings') = 'admin')
  WITH CHECK (app_setting('app.platform_settings') = 'admin');

-- Penelusur audit lintas tenant untuk admin platform. FOR ALL karena
-- admin platform juga MENULIS baris audit ber-tenant_id NULL (aksi panel).
CREATE POLICY "platform_audit" ON "audit_logs"
  FOR ALL
  USING (app_setting('app.platform_settings') = 'admin')
  WITH CHECK (app_setting('app.platform_settings') = 'admin');

-- Log integrasi: tulis dari poller/webhook lintas tenant (INSERT saja),
-- baca untuk admin platform, hapus untuk job prune.
CREATE POLICY "integration_log_ingest" ON "integration_log"
  FOR INSERT
  WITH CHECK (app_setting('app.integration_log') = 'ingest');

CREATE POLICY "platform_integration_log" ON "integration_log"
  FOR SELECT
  USING (app_setting('app.platform_settings') = 'admin'
     AND "tenant_id" IS NULL);

CREATE POLICY "integration_log_prune" ON "integration_log"
  FOR ALL
  USING (app_setting('app.integration_log') = 'prune')
  WITH CHECK (app_setting('app.integration_log') = 'prune');

-- Rekonsiliasi broadcast: baca kampanye lintas tenant saat dispatch.
CREATE POLICY "system_broadcast_scan" ON "broadcasts"
  FOR SELECT
  USING (app_setting('app.system_broadcast') = 'reconcile');

-- ----------------------------------------------------------------
-- 3. Pindai pengiriman lintas tenant (baca saja)
-- ----------------------------------------------------------------
-- Poller Telegram & Meta mencari pesan `queued` lintas tenant, lalu
-- menandai sent/failed DALAM konteks tenant masing-masing. Empat tabel
-- ikut terbaca oleh join-nya, jadi keempatnya butuh lengan baca.
CREATE POLICY "system_delivery_scan" ON "messages"
  FOR SELECT
  USING (app_setting('app.system_delivery') = 'telegram');

CREATE POLICY "system_delivery_scan" ON "conversations"
  FOR SELECT
  USING (app_setting('app.system_delivery') = 'telegram'
     AND "provider"::text = 'telegram');

CREATE POLICY "system_delivery_scan" ON "channel_accounts"
  FOR SELECT
  USING (app_setting('app.system_delivery') = 'telegram'
     AND "provider"::text = 'telegram');

CREATE POLICY "system_delivery_scan" ON "channel_identities"
  FOR SELECT
  USING (app_setting('app.system_delivery') = 'telegram'
     AND "provider"::text = 'telegram');

CREATE POLICY "meta_delivery_scan" ON "messages"
  FOR SELECT
  USING (app_setting('app.system_delivery') IN ('meta', 'whatsapp'));

CREATE POLICY "meta_delivery_scan" ON "conversations"
  FOR SELECT
  USING (app_setting('app.system_delivery') IN ('meta', 'whatsapp')
     AND "provider"::text IN ('messenger', 'instagram', 'whatsapp'));

CREATE POLICY "meta_delivery_scan" ON "channel_accounts"
  FOR SELECT
  USING (app_setting('app.system_delivery') IN ('meta', 'whatsapp')
     AND "provider"::text IN ('messenger', 'instagram', 'whatsapp'));

CREATE POLICY "meta_delivery_scan" ON "channel_identities"
  FOR SELECT
  USING (app_setting('app.system_delivery') IN ('meta', 'whatsapp')
     AND "provider"::text IN ('messenger', 'instagram', 'whatsapp'));
