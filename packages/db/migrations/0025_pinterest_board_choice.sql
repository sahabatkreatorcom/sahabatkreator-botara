-- 0025_pinterest_board_choice.sql
--
-- Pemilih board Pinterest (permintaan pemilik, lanjutan Gelombang 3).
--
-- Migrasi 0018 SENGAJA tidak memberi kolom board: satu post = satu
-- Pin pada board PERTAMA akun, dan pemilihan board dicatat sebagai
-- pengembangan lanjutan. Pengembangan itu tiba di sini:
--
-- - `pinterest_board_id`: id board API v5 yang dipilih pemilik
--   workspace untuk akun Pinterest ini (dari daftar `GET /v5/boards`
--   milik akun itu sendiri — endpoint simpan memvalidasinya).
--   NULL = belum memilih → penerbit tetap memakai board pertama
--   akun, persis perilaku sebelum migrasi ini.
-- - `pinterest_board_name`: snapshot nama board saat pilihan
--   disimpan, agar kartu Channels menampilkan board tujuan tanpa
--   memanggil API Pinterest pada setiap pembacaan. Snapshot
--   diperbarui setiap kali pilihan disimpan atau daftar board
--   diambil ulang oleh pemilik.
--
-- Dua kolom khusus provider mengikuti pola kolom per-provider yang
-- sudah ada di tabel ini (bot_username untuk Telegram,
-- graph_api_version untuk Meta): `channel_accounts` tidak punya
-- kolom metadata jsonb generik, dan tidak dibuatkan satu hanya
-- untuk ini. Untuk provider selain Pinterest kedua kolom selalu
-- NULL dan tidak dibaca siapa pun.

ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "pinterest_board_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "pinterest_board_name" varchar(255);
