-- 0008_outbox_prune.sql
--
-- Fase 20: retensi `outbox_events`.
--
-- Sebelum ini tabel itu TIDAK PERNAH dihapus sama sekali — bukan hanya
-- baris dead-letter, baris yang sudah `published_at` pun tidak. Satu-satunya
-- DELETE ada di purge kanal ter-trash (untuk event tertunda milik kanal
-- itu). Relay hanya menandai terbit, tidak pernah membuang.
--
-- Akibatnya setiap event domain yang pernah terjadi tersimpan permanen
-- dengan payload jsonb penuhnya: message.received, message.sent,
-- broadcast.*, payment.succeeded, sinkron janji temu, dan seterusnya.
-- Index parsial `outbox_events_pending_idx` menjaga PEMINDAIAN tetap
-- cepat, sehingga tidak ada gejala sampai tabelnya besar — kelas
-- kebocoran yang sama dengan media di Fase 19.
--
-- Index di bawah membuat sapuan dead-letter tidak perlu memindai seluruh
-- tabel: baris itu jarang (hanya setelah 5 kegagalan), jadi mencarinya
-- tanpa index berarti membaca semuanya setiap jam.
--
-- Untuk baris terbit, index `outbox_events_published_at_idx` (0001) sudah
-- ada dan dipakai apa adanya.

CREATE INDEX IF NOT EXISTS "outbox_events_dead_letter_idx"
  ON "outbox_events" ("dead_lettered_at")
  WHERE "dead_lettered_at" IS NOT NULL;
