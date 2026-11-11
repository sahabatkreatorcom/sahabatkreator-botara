# @sahabat-kreator/channel-tiktok

Klien TikTok Content Posting API untuk **publikasi content schedule
saja** (Gelombang 4) — BUKAN adapter inbox: tidak ada webhook, pesan,
atau DM, dan paket ini tidak mengimplementasikan `ChannelAdapter`.

**Fase implementasi:** Gelombang 4 — HIDUP untuk direct post video
ke akun kreator yang terhubung. Gerbang audit TikTok berlaku:
sebelum aplikasi pemilik lolos audit Content Posting API, API hanya
mengizinkan privasi `SELF_ONLY`; mode privasi adapter terkonfigurasi
(env platform, bawaan `SELF_ONLY`) dan divalidasi terhadap
`privacy_level_options` akun. Mode foto TIDAK dibangun (foto hanya
menerima `PULL_FROM_URL` dari domain terverifikasi milik aplikasi —
bertabrakan dengan model media privat repo).

Isi paket:

- `TikTokClient` — klien tipis (fetch) ke `open.tiktokapis.com`:
  `queryCreatorInfo` (`/v2/post/publish/creator_info/query/`),
  `initVideoPublish` (`/v2/post/publish/video/init/`, FILE_UPLOAD),
  `uploadVideoChunk` (PUT `Content-Range` ke `upload_url`),
  `fetchPublishStatus` (`/v2/post/publish/status/fetch/`), dan
  `publishVideo` yang merangkai semuanya (creator_info → validasi
  privasi → init → unggah per potongan → polling sampai
  `PUBLISH_COMPLETE`/`FAILED`). Base URL dari konstruktor (default
  `https://open.tiktokapis.com`; override dipakai uji mock).
- `buildTikTokVideoPostInfo` — pembangun `post_info` murni: judul
  postingan adalah caption post (maks 2200); flag `disable_*`
  meniru interaksi yang dimatikan kreator di pengaturan TikTok.
- `planTikTokUploadChunks` — perencana potongan murni (5–64 MB per
  potongan; sisa ekor di bawah minimum digabung ke potongan
  terakhir).
- `resolveTikTokPrivacyLevel` — gerbang privasi murni: level yang
  diminta hanya boleh bila akun mengizinkannya.
- `tiktokErrorCode` — pemetaan error aman: envelope
  `access_token_invalid` → `tiktok_unauthorized`,
  `scope_not_authorized` → `tiktok_scope_missing`,
  `rate_limit_exceeded`/`spam_risk_too_many_posts` →
  `tiktok_rate_limited`, `privacy_level_option_mismatch` →
  `tiktok_privacy_option_mismatch`, status FAILED →
  `tiktok_publish_failed`, jaringan → `tiktok_network_error`.

Kredensial (access token OAuth scope `video.publish`) diserahkan
pemanggil per panggilan dari akun channel terenkripsi; token TIDAK
PERNAH masuk `TikTokApiError`/log. Access token TikTok berumur
±24 jam dan penyegaran otomatis belum dibangun (belum ada kolom
refresh token generik di repo) — token kedaluwarsa dipetakan ke
`tiktok_unauthorized` untuk dihubungkan ulang. Media diunggah
sebagai biner dari object store privat — tidak ada kebutuhan URL
media publik.
