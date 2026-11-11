-- 0017_linkedin_provider.sql
--
-- Provider LinkedIn untuk content schedule (Gelombang 3).
--
-- LinkedIn ditambahkan ke enum `channel_provider` agar akun LinkedIn,
-- identitasnya, dan sasaran post memakai model `channel_accounts` /
-- percakapan `kind='channel'` yang sama seperti Page, Instagram,
-- Threads, Bluesky, dan YouTube. Ini BUKAN penambahan channel inbox:
-- tidak ada tabel, webhook, atau jalur pesan baru. Nilai enum saja
-- sudah cukup karena seluruh data akun yang dibutuhkan adapter muat
-- di kolom yang ada: external_id = member ID LinkedIn (subjek
-- `urn:li:person:{id}` — BUKAN Company Page; Page perusahaan menunggu
-- program Community Management terpisah), public_handle = vanity name
-- profil bila ada, dan access_token_encrypted = access token OAuth
-- (scope `w_member_social` + openid/profile) terenkripsi, mengikuti
-- pola kredensial channel yang sudah ada.

ALTER TYPE "public"."channel_provider" ADD VALUE IF NOT EXISTS 'linkedin';
