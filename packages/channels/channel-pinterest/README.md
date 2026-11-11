# @sahabat-kreator/channel-pinterest

Klien Pinterest API v5 untuk **publikasi content schedule saja**
(Gelombang 3) — BUKAN adapter inbox: tidak ada webhook, pesan, atau
DM, dan paket ini tidak mengimplementasikan `ChannelAdapter`.

**Fase implementasi:** Gelombang 3 — HIDUP untuk Pin gambar. Isi
paket:

- `PinterestClient` — klien API v5 tipis (fetch) ke
  `api.pinterest.com`: daftar board (`GET /v5/boards`) dan pembuatan
  Pin (`POST /v5/pins`). Base URL dari konstruktor (default
  `https://api.pinterest.com`; override dipakai uji mock).
- **Board tujuan = board pertama akun** (`resolveDefaultBoardId`).
  Model post tidak punya konsep board dan gelombang ini tidak
  menambah pemilih board; pemilihan board per postingan adalah
  pengembangan lanjutan. Akun tanpa board gagal aman
  (`pinterest_board_missing`).
- `buildPinterestPinPayload` — pembangun payload Pin murni: `title`
  post → judul Pin (maks 100), caption → deskripsi (maks 800),
  tautan tujuan = URL pertama di caption (opsional). Media:
  JPEG/PNG sebagai `image_base64` dari biner object store privat
  (tanpa URL publik); format gambar lain (GIF) sebagai `image_url`
  dari resolver URL publik.
- `pinterestErrorCode` — pemetaan error aman: 401 →
  `pinterest_unauthorized`, 403 → `pinterest_forbidden`, 429 →
  `pinterest_rate_limited`, jaringan → `pinterest_network_error`.

Pin video TIDAK didukung paket ini: ia menuntut pendaftaran media
asinkron API v5 (`POST /v5/media` + unggah multipart + polling
status) — lihat capability `pinterest` di
`@sahabat-kreator/contracts`.

Kredensial (access token OAuth API v5) diserahkan pemanggil per
panggilan dari akun channel terenkripsi; token TIDAK PERNAH masuk
`PinterestApiError`/log.
