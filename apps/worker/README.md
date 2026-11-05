# @sahabat-kreator/worker

Proses worker terpisah dari API (Fase 2A — nyata). Dijalankan di staging sebagai unit systemd `sahabat-kreator-worker` (Bun menjalankan `dist/index.js` hasil bundle tsup), env dari `.env.staging` (`DATABASE_URL` role aplikasi + `REDIS_URL` ke container Redis khusus proyek).

Tanggung jawab saat ini:

1. **Relay outbox** — polling `outbox_events` yang belum ter-publish tiap ±2 detik (klaim `FOR UPDATE SKIP LOCKED`, policy RLS `system_relay` migrasi 0008). Event `message.received` diterjemahkan menjadi job BullMQ `automation.evaluate` dengan jobId deterministik dari id event (idempoten).
2. **Evaluasi automation** — BullMQ Worker menjalankan `evaluateInboundMessageForAutomations` (@sahabat-kreator/core): pencocokan keyword, balasan outbound `sender_type='system'` berstatus `queued`, `automation_runs`, dan audit `automation.fired`.
3. **Respons agent AI (Fase 3A)** — setelah evaluasi automation selesai TANPA tembakan, processor meng-enqueue job `agent.respond` (jobId deterministik `agent-respond-<messageId>`). Job itu menjalankan `respondToInboundMessage` (@sahabat-kreator/core): retrieval KB full-text → provider LLM dari `@sahabat-kreator/ai` (env `LLM_PROVIDER`: `mock` default deterministik, atau `openrouter` dengan `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`) → mode `auto` mengeksekusi tool (tag/stage/handoff) dan membuat balasan `sender_type='agent'` berstatus `queued`; mode `suggest` menyimpan draf ke `agent_suggestions`. Setiap respons mencatat `usage_ledger` (ai_token) + audit `agent.responded`; caps 200 respons/tenant/hari.

Worker **tidak** mengirim WebSocket ke pengunjung webchat — hub WS hidup di proses API. Pengiriman balasan automation & agent ke pengunjung dijembatani poller pengiriman di API (lihat README `@sahabat-kreator/queue`). Job fase berikutnya (broadcast, sequence) akan ditambahkan sebagai nama job baru pada antrean yang sama.
