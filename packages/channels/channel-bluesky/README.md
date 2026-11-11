# @sahabat-kreator/channel-bluesky

Klien XRPC AT Protocol untuk **publikasi content schedule saja**
(Gelombang 1.5) — BUKAN adapter inbox: tidak ada webhook, pesan, atau
DM, dan paket ini tidak mengimplementasikan `ChannelAdapter`.

**Fase implementasi:** Gelombang 1.5 — HIDUP untuk publikasi. Isi paket:

- `BlueskyClient` — klien XRPC tipis (fetch) ke PDS akun: 
  `createSession` (app password → sesi), `uploadBlob` (biner media →
  blob ref), `createRecord` (`app.bsky.feed.post`). Base URL dari
  konstruktor (default `https://bsky.social`; override dipakai uji
  mock). Error dilempar sebagai `BlueskyApiError` yang hanya membawa
  status HTTP + nama error resmi XRPC — TIDAK PERNAH memuat app
  password atau accessJwt.
- `buildBlueskyPostRecord` / `buildLinkFacets` — pembangun record post
  murni: teks, facet tautan (offset byte UTF-8), dan embed gambar
  `app.bsky.embed.images` (maks 4, ditegakkan capability di core).

Video TIDAK didukung paket ini: unggah video Bluesky berjalan lewat
layanan video terpisah (`app.bsky.video.uploadVideo`), bukan
`uploadBlob` PDS — lihat capability `bluesky` di
`@sahabat-kreator/contracts`.
