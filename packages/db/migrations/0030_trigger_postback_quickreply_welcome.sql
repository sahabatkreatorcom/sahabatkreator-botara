-- 0030_trigger_postback_quickreply_welcome.sql
--
-- Gelombang G5 (Tier 1 butir 5 program adopsi): PEMICU
-- POSTBACK / QUICK-REPLY / WELCOME + prioritas trigger eksplisit.
--
-- Masalah yang ditutup: matcher pesan masuk hanya mengenal teks.
-- Ketukan tombol postback Meta (Messenger/IG) dibuang parser v1
-- ("receipts & postback dilewati"), callback_query Telegram tidak
-- pernah diminta ke Telegram (allowed_updates webhook tidak
-- memuatnya), dan payload quick reply pada pesan teks tidak dibedakan
-- dari teks ketikan biasa — jadi ketukan tombol tidak bisa menjadi
-- pemicu kelas-satu, dan tidak ada pemicu "pesan pertama" (welcome).
--
-- Yang dibangun migrasi ini:
-- - `automation_trigger_type` + tiga nilai: 'postback', 'quick_reply',
--   'welcome'. Aturan automation kini bisa dipicu ketukan tombol
--   (payload dicocokkan PERSIS dari trigger_config.payloads) atau
--   pesan pertama kontak (welcome) — kolom `kind` tetap keluarga
--   AKSInya ('keyword' = balasan langsung, 'sequence' = daftarkan).
-- - `messages.trigger_signal` jsonb: sinyal pemicu yang dibawa SATU
--   pesan masuk sebagaimana dinormalkan parser channel:
--     { kind: 'postback' | 'quick_reply', payload: string,
--       title: string | null }
--   NULL untuk pesan biasa (ketikan teks, media, dsb.). Evaluator
--   membaca kolom ini untuk mengklasifikasikan pesan ke kelas pemicu
--   (lihat packages/core/src/trigger-priority.ts — sumber kebenaran
--   urutan prioritasnya). Payload disimpan apa adanya (string mesin
--   dari platform); pencocokan trigger selalu PERSIS (case-sensitive)
--   karena payload adalah data mesin, bukan teks manusia.
--
-- Tanpa tabel/policy baru: hitungan verify DB tetap 67 tabel / 92
-- policy. Tanpa backfill: pesan lama tetap NULL (teks biasa).

ALTER TYPE "public"."automation_trigger_type" ADD VALUE IF NOT EXISTS 'postback';
--> statement-breakpoint
ALTER TYPE "public"."automation_trigger_type" ADD VALUE IF NOT EXISTS 'quick_reply';
--> statement-breakpoint
ALTER TYPE "public"."automation_trigger_type" ADD VALUE IF NOT EXISTS 'welcome';
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "trigger_signal" jsonb;
