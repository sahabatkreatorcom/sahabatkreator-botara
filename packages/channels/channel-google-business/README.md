# @sahabat-kreator/channel-google-business

Klien Google Business Profile API untuk **publikasi content schedule
saja** (Gelombang 3) — BUKAN adapter inbox: tidak ada webhook, pesan,
atau DM, dan paket ini tidak mengimplementasikan `ChannelAdapter`.

**Fase implementasi:** Gelombang 3 — HIDUP untuk postingan lokal,
dibangun dan dimock penuh; kuota API nyata bernilai 0 sampai Google
menyetujui pengajuan akses pemilik (lihat dokumen OWNER-ACTIONS
roadmap content schedule). Isi paket:

- `GoogleBusinessClient` — klien tipis (fetch) untuk SATU panggilan:
  `createLocalPost` (`POST /v4/{locationName}/localPosts`) dengan
  access token yang diserahkan pemanggil. Base URL dari konstruktor
  (default `https://mybusiness.googleapis.com`; override dipakai uji
  mock). Nama resource postingan terbit menjadi providerMessageId.
- `buildGoogleBusinessLocalPostPayload` — pembangun payload murni:
  caption → `summary` (maks 1500), topicType `STANDARD`,
  languageCode bawaan `id`, foto opsional dari `sourceUrl` PUBLIK
  (API tidak menerima biner — adapter menyelesaikannya lewat
  resolver URL publik repo dan gagal aman tanpanya), CTA
  `LEARN_MORE` dari URL pertama di caption.
- `googleBusinessErrorCode` — pemetaan error aman: 403 /
  `PERMISSION_DENIED` → `google_business_permission_denied`
  (termasuk keadaan kuota 0 sebelum akses disetujui), 429 /
  `RESOURCE_EXHAUSTED` → `google_business_quota_exceeded`, 401 →
  `google_business_unauthorized`, jaringan →
  `google_business_network_error`.

Kredensial TIDAK tinggal di paket ini maupun di akun channel:
adapter menukarnya dari refresh token koneksi Google tenant lewat
core (`getGoogleBusinessPublishAccess`); token TIDAK PERNAH masuk
`GoogleBusinessApiError`/log.
