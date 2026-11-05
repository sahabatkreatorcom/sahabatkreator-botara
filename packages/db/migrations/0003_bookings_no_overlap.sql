-- 0003_bookings_no_overlap.sql
--
-- Constraint anti-double-booking untuk janji temu.
--
-- Drizzle tidak bisa menyatakan EXCLUDE constraint, jadi ini SQL manual.
-- Bentuknya: dua booking `confirmed` untuk LAYANAN yang sama tidak boleh
-- beririsan waktunya. Rentang memakai '[)' (mulai inklusif, selesai
-- eksklusif) supaya booking 09:00–10:00 dan 10:00–11:00 tidak dianggap
-- bentrok — perilaku yang diharapkan mesin slot.
--
-- Kode menangkap pelanggarannya lewat SQLSTATE 23P01 (exclusion_violation)
-- ATAU nama constraint `bookings_no_overlap_confirmed`; keduanya harus
-- tetap cocok bila constraint ini diubah. Lihat isExclusionViolation() di
-- packages/core/src/appointments.ts.
--
-- btree_gist diperlukan agar kolom uuid (service_id) bisa dipakai bersama
-- operator rentang (&&) dalam satu index GiST.

CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap_confirmed"
  EXCLUDE USING gist (
    "service_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" = 'confirmed');
