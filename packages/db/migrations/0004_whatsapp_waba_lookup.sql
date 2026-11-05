-- 0004_whatsapp_waba_lookup.sql
--
-- Dua hal yang dibutuhkan webhook WhatsApp tingkat WABA (coexistence +
-- status template), keduanya tidak bisa diselesaikan di lapisan aplikasi.
--
-- 1) Lengan lookup BARU untuk `channel_accounts`.
--    Lengan yang ada (`provider_external_lookup`, 0001) mencocokkan
--    `external_id` = phone_number_id, karena payload `messages` selalu
--    membawa `metadata.phone_number_id`. Payload
--    `message_template_status_update` TIDAK: yang ada hanya
--    `entry.id` = WABA id, sedangkan nomor telepon tidak disebut sama
--    sekali. Tanpa lengan ini, event status template tidak bisa
--    dipetakan ke akun mana pun dan RLS akan menyembunyikan SEMUA baris
--    (fail-closed) — bukan gagal keras, tetapi diam-diam tidak melakukan
--    apa-apa, yang lebih buruk.
--
--    Kunci `parent_external_id` adalah WABA id (lihat
--    createWhatsAppChannelAccount), jadi pencocokannya tepat.
--    Disetel HANYA oleh resolver webhook yang sudah lolos verifikasi
--    tanda tangan app secret, pola yang sama dengan lengan 0001.

CREATE POLICY "whatsapp_waba_lookup" ON "channel_accounts"
  FOR SELECT
  USING ("provider"::text = 'whatsapp'
     AND "parent_external_id" = app_setting('app.whatsapp_waba_id'));
--> statement-breakpoint

-- 2) Alasan status template.
--    Meta mengirim `reason` (INVALID_FORMAT, PROMOTIONAL, …) plus
--    `rejection_info.reason`/`.recommendation` saat template ditolak.
--    Tanpa kolom ini, operator hanya melihat chip "REJECTED" tanpa tahu
--    APA yang harus diperbaiki — persis keluhan yang membuat status
--    template perlu ditangani otomatis. Disimpan sebagai teks bebas
--    (bukan enum) karena nilai `reason` Meta bertambah dari waktu ke
--    waktu dan kita tidak ingin migrasi baru setiap kali itu terjadi.
--
--    Nullable: template yang belum pernah ditolak tidak punya alasan.
ALTER TABLE "whatsapp_templates"
  ADD COLUMN IF NOT EXISTS "status_reason" varchar(512);
