-- 0024_profile_photos_r2_storage.sql
--
-- Avatar TikTok disimpan di Cloudflare R2 (keputusan pemilik
-- 2026-11-12). URL avatar CDN TikTok adalah URL bertanda tangan yang
-- KEDALUWARSA (parameter `x-expires` pada URL-nya), jadi berbeda
-- dengan channel lain — yang byte fotonya cukup disimpan sebagai
-- bytea di `profile_photos` — salinan berkas avatar TikTok harus
-- tinggal di penyimpanan objek milik platform sendiri.
--
-- Migrasi ini memperluas `profile_photos` agar satu baris bisa
-- berbentuk salah satu dari dua bentuk yang sah (ditegakkan check
-- `profile_photos_storage_shape`):
--   - 'db' : bentuk lama — byte di kolom `data`, `object_key` NULL.
--            Semua baris yang ada otomatis bentuk ini (kolom baru
--            ber-default 'db'); perilaku channel non-TikTok TIDAK
--            berubah sama sekali.
--   - 'r2' : byte adalah objek R2 — `object_key` terisi (kunci
--            deterministik `avatars/tiktok/<channel_account_id>.<ext>`),
--            `data` NULL. `content_type` + `etag` (SHA-256 byte foto)
--            tetap dicatat di baris agar endpoint penyaji bisa menjawab
--            If-None-Match tanpa mengambil objeknya lebih dulu.
--
-- `data` karena itu tidak lagi NOT NULL. Penyajian avatar tidak
-- berubah bentuk: endpoint mengambil objek R2 di sisi server dan
-- meneruskan bytenya (bucket tetap privat; tidak bergantung pada
-- domain publik media). Selama kredensial R2 di Panel Admin belum
-- terisi, penulisan avatar TikTok jatuh ke bentuk 'db' persis seperti
-- sebelumnya — migrasi ini sendiri tidak memindahkan byte apa pun.
--
-- Nomor 0024 SENGAJA melompati 0023: nomor itu disiapkan untuk
-- gelombang pemisahan OAuth Google yang sedang berjalan di worktree
-- lain; entri journal di bawah memakai idx/when sesudahnya agar
-- urutan teraplikasi tetap aman di kedua urutan pendaratan.

ALTER TABLE "profile_photos" ADD COLUMN "storage" varchar(16) DEFAULT 'db' NOT NULL;
--> statement-breakpoint
ALTER TABLE "profile_photos" ADD COLUMN "object_key" varchar(512);
--> statement-breakpoint
ALTER TABLE "profile_photos" ALTER COLUMN "data" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_storage_valid" CHECK ("storage" IN ('db', 'r2'));
--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_storage_shape" CHECK (("storage" = 'db' AND "data" IS NOT NULL AND "object_key" IS NULL) OR ("storage" = 'r2' AND "data" IS NULL AND "object_key" IS NOT NULL));
