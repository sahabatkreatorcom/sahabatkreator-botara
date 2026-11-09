-- 0010_platform_admin_console.sql
--
-- Panel Admin Platform naik kelas: dari halaman kredensial menjadi konsol
-- OPERASI lintas tenant (Ringkasan, Tenant, Pengguna, Operasional, Sistem).
--
-- Dua hal yang dibutuhkan konsol itu, dan tidak bisa disediakan tanpa migrasi:
--
--   1. STATUS TENANT. Tanpa kolom status, "suspend tenant" tidak punya arti
--      yang bisa ditegakkan — tombolnya akan jadi hiasan. Status disimpan di
--      `tenants` (tabel ini TIDAK ber-RLS, sama seperti sebelumnya: isolasi
--      tenant hidup di tabel ber-tenant_id, bukan di daftar tenant).
--      Penegakannya di `getTenantForUser` (core): tenant non-aktif → null →
--      seluruh route bersarang menjawab 404, pola yang sama dengan non-member.
--
--   2. BACA LINTAS TENANT. `tenant_members`, `channel_accounts`,
--      `subscriptions`, `messages`, `conversations`, dan `outbox_events`
--      semuanya ber-RLS, sehingga admin platform melihat NOL baris tanpa
--      konteks. Lengan baru `app.platform_admin` memberi BACA (dan UPDATE
--      khusus outbox untuk retry) hanya ketika flag itu di-set — dan flag itu
--      hanya di-set oleh `withPlatformAdminTx` di core, yang hanya dipanggil
--      dari route yang sudah lolos gerbang allowlist email.
--
-- Kenapa flag BARU, bukan menumpang `app.platform_settings`:
-- flag itu bermakna "kredensial provider", dan memberinya hak baca seluruh
-- pesan pelanggan akan melanggar prinsip hak-minimal. Satu flag = satu
-- kemampuan, sehingga bisa dicabut tanpa mematikan panel kredensial.
--
-- Policy bersifat ADITIF (di-OR dengan policy yang ada): isolasi tenant tidak
-- melemah, karena `app.platform_admin` tidak pernah di-set pada request tenant
-- biasa — nilainya NULL, dan perbandingan `= 'on'` menjadi false.

DO $$ BEGIN
  CREATE TYPE "tenant_status" AS ENUM ('active', 'suspended');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "status" "tenant_status" NOT NULL DEFAULT 'active';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "status_reason" text;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "tenants_status_idx" ON "tenants" ("status");

-- Hitungan aktivitas per tenant di daftar konsol (pesan 7 hari). Index yang
-- ada hanya `(tenant_id)`, sehingga agregat per tenant memindai seluruh pesan
-- tenant itu; kolom waktu ikut masuk index supaya rentangnya dipotong di
-- index, bukan setelah baca baris.
CREATE INDEX IF NOT EXISTS "messages_tenant_created_idx" ON "messages" ("tenant_id", "created_at");

-- --- Baca lintas tenant untuk konsol -------------------------------------

DROP POLICY IF EXISTS "platform_admin_tenant_members" ON "tenant_members";
CREATE POLICY "platform_admin_tenant_members" ON "tenant_members"
  FOR SELECT
  USING (app_setting('app.platform_admin') = 'on');

DROP POLICY IF EXISTS "platform_admin_channel_accounts" ON "channel_accounts";
CREATE POLICY "platform_admin_channel_accounts" ON "channel_accounts"
  FOR SELECT
  USING (app_setting('app.platform_admin') = 'on');

DROP POLICY IF EXISTS "platform_admin_subscriptions" ON "subscriptions";
CREATE POLICY "platform_admin_subscriptions" ON "subscriptions"
  FOR SELECT
  USING (app_setting('app.platform_admin') = 'on');

DROP POLICY IF EXISTS "platform_admin_messages" ON "messages";
CREATE POLICY "platform_admin_messages" ON "messages"
  FOR SELECT
  USING (app_setting('app.platform_admin') = 'on');

DROP POLICY IF EXISTS "platform_admin_conversations" ON "conversations";
CREATE POLICY "platform_admin_conversations" ON "conversations"
  FOR SELECT
  USING (app_setting('app.platform_admin') = 'on');

-- Audit: baris ber-tenant_id NULL (aksi platform) sudah terbaca lewat
-- `platform_audit`, tetapi konsol juga perlu melihat jejak AKSI ADMIN pada
-- tenant tertentu — karena itu SELECT lintas tenant ditambahkan di sini.
DROP POLICY IF EXISTS "platform_admin_audit_read" ON "audit_logs";
CREATE POLICY "platform_admin_audit_read" ON "audit_logs"
  FOR SELECT
  USING (app_setting('app.platform_admin') = 'on');

-- Tulis audit dari konsol: SETIAP aksi admin (suspend, paksa logout, retry)
-- meninggalkan jejak, dan jejak itu ditulis oleh kode yang sama yang
-- memakainya. Sengaja INSERT saja — konsol tidak boleh menyunting atau
-- menghapus riwayat yang sudah tercatat.
DROP POLICY IF EXISTS "platform_admin_audit_write" ON "audit_logs";
CREATE POLICY "platform_admin_audit_write" ON "audit_logs"
  FOR INSERT
  WITH CHECK (app_setting('app.platform_admin') = 'on');

-- Outbox: konsol membaca dead-letter dan MENULIS ulang baris yang dicoba
-- ulang. WITH CHECK wajib — tanpa itu UPDATE akan lolos baca tetapi ditolak
-- tulis, dan gejalanya "retry tidak berpengaruh" tanpa error yang jelas.
DROP POLICY IF EXISTS "platform_admin_outbox" ON "outbox_events";
CREATE POLICY "platform_admin_outbox" ON "outbox_events"
  FOR ALL
  USING (app_setting('app.platform_admin') = 'on')
  WITH CHECK (app_setting('app.platform_admin') = 'on');
