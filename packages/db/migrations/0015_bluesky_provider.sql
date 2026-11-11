-- 0015_bluesky_provider.sql
--
-- Provider Bluesky untuk content schedule (Gelombang 1.5).
--
-- Bluesky ditambahkan ke enum `channel_provider` agar akun Bluesky,
-- identitasnya, dan sasaran post memakai model `channel_accounts` /
-- percakapan `kind='channel'` yang sama seperti Page, Instagram, dan
-- Threads. Ini BUKAN penambahan channel inbox: tidak ada tabel,
-- webhook, atau jalur pesan baru. Nilai enum saja sudah cukup karena
-- seluruh data akun yang dibutuhkan adapter muat di kolom yang ada:
-- external_id = DID akun, public_handle = handle, dan
-- access_token_encrypted = app password Bluesky terenkripsi (adapter
-- menukarnya menjadi sesi XRPC setiap kali menerbitkan).

ALTER TYPE "public"."channel_provider" ADD VALUE IF NOT EXISTS 'bluesky';
