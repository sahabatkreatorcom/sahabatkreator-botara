-- Migrasi 0041 — Gelombang G17 butir 2: layanan Google 'sheets'.
--
-- Node flow `append_sheet_row` (tambah baris ke Google Sheets)
-- memakai mesin koneksi Google PER LAYANAN (0023): consent-nya
-- sendiri dengan scope spreadsheets, TIDAK menumpang scope layanan
-- lain. Migrasi ini hanya menambah nilai enum `google_service` —
-- tabel google_connections yang ada menampung baris layanannya;
-- tidak ada tabel/policy baru (hitungan db verify tetap 83/111).

ALTER TYPE "public"."google_service" ADD VALUE IF NOT EXISTS 'sheets';
