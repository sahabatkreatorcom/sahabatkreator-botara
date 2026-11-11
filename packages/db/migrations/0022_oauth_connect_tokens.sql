-- 0022_oauth_connect_tokens.sql
--
-- Fondasi connect/OAuth gelombang Semua OAuth (TikTok Login Kit,
-- LinkedIn, Pinterest — mengikuti integrasi Threads 0021):
--
-- 1. Varian token baru di `channel_token_type` per provider, karena
--    siklus hidupnya berbeda-beda dan TIDAK bisa disamakan dengan
--    varian Meta/Threads:
--    - `tiktok_user_token`   : access token OAuth TikTok (±24 jam)
--      yang REFRESHABLE via grant `refresh_token` Login Kit (refresh
--      token-nya sendiri ±365 hari).
--    - `pinterest_user_token`: access token OAuth Pinterest v5
--      (30 hari) yang REFRESHABLE via grant `refresh_token`
--      (penyegaran berkelanjutan tanpa kedaluwarsa refresh token).
--    - `linkedin_user_token` : access token OAuth LinkedIn (±60
--      hari) yang TIDAK refreshable — LinkedIn tidak menerbitkan
--      refresh token untuk program standar (Sign In + Share);
--      lifecycle-nya hanya menandai "expiring"/"expired" + 'error'
--      agar pemilik menghubungkan ulang. Varian terpisah membuat
--      ketidakmampuan itu eksplisit di data, bukan tebakan worker.
--
-- 2. Kolom `refresh_token_encrypted` di `channel_accounts`: rumah
--    bagi refresh token TikTok/Pinterest (envelope AES-256-GCM yang
--    sama seperti access token — BUKAN token mentah). Sebelumnya
--    refresh token hanya hidup di tabel koneksi Google
--    (google_calendar_connections) yang modelnya per-tenant, bukan
--    per-akun channel; gelombang ini menutup celah yang dicatat
--    migrasi 0020 ("repo belum punya kolom refresh token generik").
--    Kolom lifecycle lain (token_expires_at, token_refreshed_at,
--    token_health) sudah generik dan dipakai apa adanya.

ALTER TYPE "public"."channel_token_type" ADD VALUE IF NOT EXISTS 'tiktok_user_token';
--> statement-breakpoint
ALTER TYPE "public"."channel_token_type" ADD VALUE IF NOT EXISTS 'pinterest_user_token';
--> statement-breakpoint
ALTER TYPE "public"."channel_token_type" ADD VALUE IF NOT EXISTS 'linkedin_user_token';
--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "refresh_token_encrypted" text;
