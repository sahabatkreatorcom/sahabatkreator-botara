-- 0014_threads_provider.sql
--
-- Provider Threads untuk content schedule (Gelombang 1).
--
-- Threads ditambahkan ke enum `channel_provider` agar akun Threads,
-- identitasnya, dan sasaran post memakai model `channel_accounts` /
-- percakapan `kind='channel'` yang sama seperti Page dan Instagram.
-- Ini BUKAN penambahan channel inbox: tidak ada tabel, webhook, atau
-- jalur pesan baru. Nilai enum saja sudah cukup karena seluruh data
-- akun yang dibutuhkan adapter (external_id = Threads user ID, token
-- terenkripsi, public_handle = username) muat di kolom yang ada.

ALTER TYPE "public"."channel_provider" ADD VALUE IF NOT EXISTS 'threads';
