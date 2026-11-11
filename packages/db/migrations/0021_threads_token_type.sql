-- 0021_threads_token_type.sql
--
-- Varian token Threads untuk lifecycle token (integrasi Threads —
-- connect/OAuth memakai kredensial aplikasi Threads dari Panel Admin).
--
-- Token pengguna Threads hasil OAuth adalah token berumur panjang
-- (±60 hari) yang refreshable via grant `th_refresh_token` di
-- graph.threads.net. Ia BUKAN keluarga token Meta (Page/System
-- User/bisnis — refresh `tbft` dengan app secret), jadi enum
-- `channel_token_type` mendapat nilai sendiri: `threads_user_token`.
-- Worker lifecycle Threads memindai akun provider `threads` dengan
-- varian ini + token_expires_at terisi untuk menyegarkannya sebelum
-- kedaluwarsa. Nilai enum saja cukup — kolom lifecycle yang ada
-- (token_expires_at, token_refreshed_at, token_health) generik.

ALTER TYPE "public"."channel_token_type" ADD VALUE IF NOT EXISTS 'threads_user_token';
