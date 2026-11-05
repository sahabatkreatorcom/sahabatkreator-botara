# @sahabat-kreator/channel-telegram

Adapter Telegram Bot API (bukan Meta, tanpa jendela pesan).

**Fase implementasi:** Fase 6A — HIDUP. Isi paket:

- `TelegramBotApiClient` — klien Bot API tipis (fetch): `getMe`,
  `setWebhook`, `sendMessage`. Base URL dari konstruktor (default
  `https://api.telegram.org`; override dipakai uji mock). Error dilempar
  sebagai `TelegramApiError` yang hanya membawa status HTTP + deskripsi
  Telegram — TIDAK PERNAH memuat token/URL bertoken.
- `parseTelegramUpdate` — normalisasi update → `StandardEvent`
  channel-core (fungsi murni). Hanya pesan teks yang menjadi
  `message.received`.
- `TelegramChannelAdapter` — implementasi `ChannelAdapter` untuk satu
  akun bot. `verifyWebhookSignature` selalu `false` BY DESIGN: keaslian
  webhook Telegram dibuktikan header secret token terhadap hash
  tersimpan, dilakukan route API + core (`verifyChannelWebhookSecret`),
  bukan adapter.

Logika DB (enkripsi token, resolusi akun webhook, kontak/percakapan/
pesan masuk, antrean pengiriman) hidup di `@sahabat-kreator/core`
(`telegram.ts`, `channel-secrets.ts`); pengiriman keluar berjalan lewat
antrean pesan `queued` + poller di apps/api (`modules/telegram`).
