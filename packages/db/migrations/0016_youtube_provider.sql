-- 0016_youtube_provider.sql
--
-- Provider YouTube untuk content schedule (Gelombang 2).
--
-- YouTube ditambahkan ke enum `channel_provider` agar akun YouTube,
-- identitasnya, dan sasaran post memakai model `channel_accounts` /
-- percakapan `kind='channel'` yang sama seperti Page, Instagram,
-- Threads, dan Bluesky. Ini BUKAN penambahan channel inbox: tidak
-- ada tabel, webhook, atau jalur pesan baru. Nilai enum saja sudah
-- cukup karena baris akun YouTube hanya membawa identitas channel:
-- external_id = channel ID YouTube (UC…), display_name = judul
-- channel. Kredensial penerbitan TIDAK disimpan di akun channel —
-- access token ditukar dari refresh token koneksi Google tenant
-- (google_calendar_connections, Fase 13G) yang scope-nya diperluas
-- dengan youtube.upload/youtube.readonly; akun channel disinkronkan
-- dari koneksi itu oleh core (syncYouTubeChannelAccount).

ALTER TYPE "public"."channel_provider" ADD VALUE IF NOT EXISTS 'youtube';
