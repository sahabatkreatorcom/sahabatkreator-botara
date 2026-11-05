# @sahabat-kreator/queue

Abstraksi BullMQ + kosakata job aplikasi (Fase 2A — nyata, bukan lagi placeholder).

- Satu antrean fisik `sahabat-kreator` (BullMQ di atas Redis proyek sendiri).
- Job `automation.evaluate` `{tenantId, conversationId, messageId, outboxEventId}` — jobId deterministik `automation-evaluate-<outboxEventId>` sebagai fondasi idempotensi relay.
- Job `agent.respond` `{tenantId, conversationId, messageId}` (Fase 3A) — jobId deterministik `agent-respond-<messageId>`; di-enqueue processor `automation.evaluate` setelah evaluasi tanpa tembakan (keyword dulu, AI kemudian).
- `outbox.relay` adalah pola polling worker (bukan job): worker mengklaim `outbox_events` yang belum ter-publish dari Postgres dengan `FOR UPDATE SKIP LOCKED` lewat helper `relayUnpublishedOutboxEvents` di `@sahabat-kreator/core`, menerjemahkan event `message.received` menjadi job di atas, lalu menandai event published — semua dalam satu transaksi klaim.

## Jembatan pengiriman lintas proses

Hub WebSocket webchat hidup di proses API, worker adalah proses lain. Worker **tidak** mengirim WebSocket langsung: worker cukup membuat pesan outbound berstatus `queued` (+ event outbox `message.queued`). Poller ringan di proses API (±2 detik) mengambil pesan `queued` untuk percakapan webchat yang pengunjungnya sedang terhubung, mendorongnya lewat hub, dan menandainya `sent`; pesan untuk pengunjung offline ter-flush saat reconnect (mekanisme Fase 1F). Ini jembatan sementara sampai pub/sub Redis di fase scale berikutnya — kontrak job di paket ini tidak berubah saat itu tiba.
