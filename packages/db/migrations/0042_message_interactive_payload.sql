-- Migrasi 0042 — Gelombang G17 butir 3: muatan interaktif natif pesan.
--
-- Node flow `send_catalog` mengirim katalog commerce dalam format
-- NATIF kanal: daftar interaktif WhatsApp / template generik
-- Messenger-Instagram. Bentuk terstruktur itu disimpan di kolom
-- `interactive_payload` (jsonb) pada baris pesan keluar — pola yang
-- sama seperti `template_payload` (Fase 10A); poller pengiriman yang
-- membacanya dan membentuk panggilan API natif, sementara
-- `content_text` baris yang sama tetap memuat daftar teks terbaca
-- manusia (fallback tampilan inbox + isi body daftar WhatsApp).
-- Tidak ada tabel/policy baru (hitungan db verify tetap 83/111).

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "interactive_payload" jsonb;
