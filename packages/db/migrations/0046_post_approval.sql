-- 0046_post_approval.sql
--
-- Fase Susulan S1: ALUR PERSETUJUAN POSTINGAN (draft → tinjauan →
-- disetujui/ditolak) untuk content schedule /posts.
--
-- Yang dibangun migrasi ini:
-- - `tenants.post_approval_required`: sakelar OPT-IN per tenant.
--   Bawaan false = perilaku lama utuh (postingan terjadwal terbit
--   tanpa persetujuan). Bila true, worker `post.publish` MENOLAK
--   menerbitkan postingan yang belum berstatus persetujuan
--   `approved` (lihat core/posts.ts `blockUnapprovedPostPublish`).
-- - Kolom persetujuan pada `posts`: keadaan persetujuan hidup PER
--   BARIS post, tetapi semua transisi di core bekerja pada UNIT =
--   seluruh anggota grup multi-target sekaligus (satu keputusan untuk
--   satu konten induk, bukan per sasaran). Post tunggal = unit satu
--   anggota. `approval_status`:
--     draft            = belum diajukan (keadaan awal; juga hasil
--                        reset saat isi postingan disunting)
--     pending_review   = diajukan, menunggu peninjau
--     approved         = disetujui — boleh terbit
--     rejected         = ditolak (approval_note wajib terisi)
--     changes_requested= diminta revisi (approval_note wajib terisi);
--                        postingan terjadwal diturunkan kembali ke
--                        draft oleh core agar bisa disunting
--   `approval_note` = catatan keputusan TERAKHIR (penolakan/revisi —
--   tampil ke pembuat). Riwayat keputusan lengkap TIDAK disalin ke
--   kolom: ia hidup di `audit_logs` (aksi `post.approval_*` +
--   `post.publish_blocked_approval`), sesuai preseden repo bahwa isi
--   catatan tidak diduplikasi ke meta audit.
-- - Kolom peninjau/pengaju menunjuk `users` dengan ON DELETE SET
--   NULL, pola yang sama dengan `created_by_user_id`: riwayat
--   persetujuan tidak boleh hilang hanya karena akunnya dihapus.
--
-- Tidak ada tabel baru → hitungan db verify tetap 88 tabel / 116
-- policy. Indeks `(tenant_id, approval_status)` melayani antrean
-- tinjauan (saringan daftar postingan per status persetujuan).

-- ---------------------------------------------------------------------------
-- tenants: sakelar persetujuan wajib
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "post_approval_required" boolean DEFAULT false NOT NULL;

-- ---------------------------------------------------------------------------
-- posts: keadaan persetujuan
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "post_approval_status" AS ENUM (
    'draft', 'pending_review', 'approved', 'rejected', 'changes_requested'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "approval_status" "post_approval_status" DEFAULT 'draft' NOT NULL;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "approval_note" text;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "approval_submitted_by_user_id" uuid;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "approval_submitted_at" timestamp with time zone;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "approval_reviewed_by_user_id" uuid;
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "approval_reviewed_at" timestamp with time zone;

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_approval_submitted_by_user_id_users_id_fk";
ALTER TABLE "posts" ADD CONSTRAINT "posts_approval_submitted_by_user_id_users_id_fk"
  FOREIGN KEY ("approval_submitted_by_user_id") REFERENCES "users"("id") ON DELETE set null;

ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_approval_reviewed_by_user_id_users_id_fk";
ALTER TABLE "posts" ADD CONSTRAINT "posts_approval_reviewed_by_user_id_users_id_fk"
  FOREIGN KEY ("approval_reviewed_by_user_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "posts_tenant_approval_idx" ON "posts" ("tenant_id", "approval_status");
