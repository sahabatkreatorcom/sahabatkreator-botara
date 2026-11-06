-- 0006_message_media_ingest.sql
--
-- Fase 18: jejak media MASUK yang belum sempat diunduh.
--
-- Sebelum ini, parser webhook WhatsApp membuang `image.id` dan hanya
-- menyimpan caption-nya. Akibatnya foto yang dikirim pelanggan tidak
-- pernah bisa dilihat agen — dan TIDAK BISA DISUSUL: URL unduhan Meta
-- hanya valid ±5 menit, jadi tanpa menyimpan media id saat webhook tiba,
-- berkasnya hilang permanen.
--
-- Kolom di bawah menyimpan referensi itu di baris pesan. Ingest media
-- (worker) menukarnya menjadi URL, mengunduh, menyimpan ke object store,
-- lalu mengisi `media_id` yang sudah ada sejak awal.
--
-- Kenapa di baris pesan, bukan tabel antrean baru: baris pesan sudah
-- punya identitas tenant + percakapan + status, dan pindai "belum
-- ter-ingest" cukup satu index parsial. Tabel antrean terpisah akan
-- menuntut pembersihan sendiri ketika pesan dihapus (purge channel).

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "provider_media_id" varchar(255);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "provider_media_mime" varchar(128);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "provider_media_file_name" varchar(255);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_ingest_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_ingest_error" varchar(500);--> statement-breakpoint
-- Kapan percobaan terakhir dijalankan. Tanpa kolom ini, siklus 5 detik
-- akan menghabiskan SELURUH jatah percobaan dalam 25 detik — gangguan
-- jaringan semenit membuat media hilang permanen, padahal berkasnya
-- masih ada di Meta. Dengan jarak antar-percobaan, jatah yang sama
-- menutupi gangguan yang jauh lebih lama.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_ingest_attempted_at" timestamptz;--> statement-breakpoint

-- Index parsial untuk pindai ingest: hanya baris yang punya referensi
-- provider tetapi belum punya media tersimpan. Baris teks (mayoritas
-- tabel) tidak ikut masuk index sama sekali.
CREATE INDEX IF NOT EXISTS "messages_pending_media_idx"
  ON "messages" ("created_at")
  WHERE "media_id" IS NULL AND "provider_media_id" IS NOT NULL;
