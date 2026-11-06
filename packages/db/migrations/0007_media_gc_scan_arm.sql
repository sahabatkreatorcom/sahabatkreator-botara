-- 0007_media_gc_scan_arm.sql
--
-- Fase 19: lengan pindai lintas tenant untuk pembersihan media.
--
-- Masalah yang ditutup: `media` hanya punya policy isolasi tenant
-- (0001), jadi worker tidak bisa melihat baris tenant lain sama sekali.
-- Akibatnya tiga keadaan tidak pernah bisa dideteksi:
--
--   1. baris yang berkasnya hilang (volume tidak ter-mount, DB dipulihkan
--      tanpa disk) — sampai sekarang hanya muncul sebagai 404 saat agen
--      membuka percakapan, selamanya;
--   2. baris yang tidak dirujuk pesan mana pun (lampiran diunggah lalu
--      batal dikirim, atau pesannya sudah dihapus) — tumbuh tanpa batas;
--   3. baris yang melewati masa retensi.
--
-- Ketiganya butuh pembacaan lintas tenant, dan worker tidak punya daftar
-- tenant.
--
-- Kenapa SELECT saja: penghapusan tetap terjadi di konteks tenant
-- masing-masing (`withTenantDb`), mengikuti pola ingest media. Yang
-- lintas tenant hanya PEMBACAAN, sehingga bug di jalur tulis tidak
-- mungkin menghapus baris milik tenant lain — RLS tetap menjadi
-- pengaman terakhir untuk tulisan.
--
-- Nilai setting sengaja bukan `on` yang umum: lengan ini hanya untuk GC
-- media, dan nama yang spesifik mencegah satu set_config tidak sengaja
-- membuka lengan lain.

CREATE POLICY "system_media_gc_scan" ON "media"
  FOR SELECT
  USING (app_setting('app.system_media_gc') = 'on');
