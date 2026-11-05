# @sahabat-kreator/channel-webchat

Channel milik sendiri — **hidup sejak Fase 1F** (channel pertama yang
benar-benar mengirim/menerima di Sahabat Kreator).

Pembagian kerja (lihat juga header `src/index.ts`):
- Paket ini: format **token sesi pengunjung** (HMAC-SHA256, payload
  tenant/akun/kontak/percakapan + expiry), normalisasi payload pesan masuk
  ke `StandardEvent`, dan `WebchatChannelAdapter` untuk pengirim berbasis
  antrean (`registerWebchatSender`).
- `@sahabat-kreator/core` (`webchat.ts`): resolusi siteKey → tenant (RLS
  migrasi 0006), sesi pengunjung, pesan masuk (+ outbox `message.received`),
  flush pesan `queued` saat pengunjung connect.
- `apps/api`: endpoint publik `/webchat/*`, hub WebSocket yang mendorong
  balasan dashboard secara realtime, dan widget di `packages/embed`.
