-- Outbox: hitung percobaan + karantina event yang tidak pernah bisa diproses.
--
-- MASALAH YANG DITUTUP: relay memproses SATU batch (≤25 event tertua) dalam
-- satu transaksi. Satu handler yang melempar membatalkan SELURUH batch, dan
-- karena urutannya `created_at ASC`, event yang sama diambil lagi pada
-- siklus berikutnya — event yang lebih baru TIDAK PERNAH diproses. Semua
-- automation, sequence, flow, broadcast, email undangan, embedding KB, dan
-- sinkron Google berhenti, dengan satu baris console.error sebagai satu-
-- satunya jejak.
--
-- Kolom di sini memberi relay cara berhenti mengulang selamanya dan
-- meninggalkan bukti yang bisa dibaca operator:
--   attempts         berapa kali handler untuk event ini melempar.
--   last_error       pesan error terakhir (dipotong), bukan tumpukan penuh.
--   dead_lettered_at diisi saat relay MENYERAH; baris tidak dipindai lagi.
--
-- Tanpa `dead_lettered_at`, satu event rusak akan menempati slot batch
-- selamanya dan terus menulis error setiap siklus — kegagalan yang sama,
-- hanya lebih berisik.
ALTER TABLE "outbox_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint

-- Pemindaian relay: event tertua yang masih menunggu. Index parsial hanya
-- memuat baris yang benar-benar dipindai, jadi tetap kecil walaupun
-- outbox_events tumbuh (baris published/dead-letter tidak ikut).
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("created_at") WHERE "published_at" IS NULL AND "dead_lettered_at" IS NULL;
