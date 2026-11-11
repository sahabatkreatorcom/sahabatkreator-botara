# @sahabat-kreator/channel-linkedin

Klien LinkedIn Posts API untuk **publikasi content schedule saja**
(Gelombang 3) — BUKAN adapter inbox: tidak ada webhook, pesan, atau
DM, dan paket ini tidak mengimplementasikan `ChannelAdapter`.

**Fase implementasi:** Gelombang 3 — HIDUP untuk publikasi ke PROFIL
PRIBADI anggota. Company Page BUKAN sasaran: menerbitkan sebagai
`urn:li:organization` membutuhkan persetujuan program Community
Management LinkedIn yang terpisah.

Isi paket:

- `LinkedInClient` — klien REST tipis (fetch) ke `api.linkedin.com`:
  unggah gambar (`/rest/images?action=initializeUpload` → PUT biner →
  URN `urn:li:image:…`), unggah video (`/rest/videos` initialize →
  PUT per potongan byte → `finalizeUpload` dengan ETag → URN
  `urn:li:video:…`), dan pembuatan post (`POST /rest/posts`, id
  terbit = header `x-restli-id`). Semua panggilan membawa header
  `LinkedIn-Version` (konstanta ter-pin `LINKEDIN_API_VERSION`;
  LinkedIn menghentikan versi setelah ±1 tahun, jadi menaikkannya
  adalah perawatan berkala) dan `X-Restli-Protocol-Version: 2.0.0`.
  Base URL dari konstruktor (default `https://api.linkedin.com`;
  override dipakai uji mock).
- `buildLinkedInPostPayload` — pembangun payload post murni: author
  selalu `urn:li:person:{memberId}`; 1 media → `content.media`, ≥2
  gambar → `content.multiImage`, tanpa media → post teks.
- `linkedinErrorCode` — pemetaan error aman: 401 →
  `linkedin_unauthorized`, 403 → `linkedin_forbidden`, 429 →
  `linkedin_rate_limited`, jaringan → `linkedin_network_error`.

Kredensial (access token OAuth scope `w_member_social`) diserahkan
pemanggil per panggilan dari akun channel terenkripsi; token TIDAK
PERNAH masuk `LinkedInApiError`/log. Media diunggah sebagai biner
dari object store privat — tidak ada kebutuhan URL media publik.
