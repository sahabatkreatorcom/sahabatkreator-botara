# @sahabat-kreator/channel-tiktok

Klien TikTok Content Posting API untuk **publikasi content schedule
saja** (Gelombang 4) — BUKAN adapter inbox: tidak ada webhook, pesan,
atau DM, dan paket ini tidak mengimplementasikan `ChannelAdapter`.

**Fase implementasi:** Gelombang 4 — HIDUP untuk direct post video;
pengembangan lanjutan — HIDUP juga untuk direct post **foto /
carousel** dengan auto music. Gerbang audit TikTok berlaku untuk
kedua bentuk: sebelum aplikasi pemilik lolos audit Content Posting
API, API hanya mengizinkan privasi `SELF_ONLY`. Level privasi
adalah PILIHAN KREATOR per postingan (gelombang Pilihan Privasi &
AI — Content Sharing Guidelines mewajibkannya dipilih dari
dropdown tanpa nilai terpilih duluan; bawaan Panel Admin → env
hanya menjangkau postingan tanpa pilihan) dan selalu divalidasi
terhadap `privacy_level_options` akun sebelum init, tanpa
penurunan diam-diam. post_info juga membawa pilihan kreator lain:
toggle interaksi (mati secara bawaan; yang dimatikan kreator di
pengaturan TikTok selalu menang), pengungkapan komersial
(`brand_content_toggle`/`brand_organic_toggle`), dan label AI
(`is_aigc`).

Dua jalur publikasi:

- **Video (tepat satu):** `publishVideo` — creator_info → validasi
  privasi → `video/init/` FILE_UPLOAD → PUT biner per potongan
  (`Content-Range`) → polling status. Video diunggah sebagai biner
  dari object store privat; TIDAK perlu URL publik.
- **Foto / carousel (satu foto atau album khusus foto):**
  `publishPhotos` — creator_info → validasi privasi yang sama →
  `content/init/` dengan `media_type: "PHOTO"`,
  `post_mode: "DIRECT_POST"`, dan `source: "PULL_FROM_URL"` →
  polling status yang sama (keadaan khas `PROCESSING_DOWNLOAD`).
  Foto TIDAK punya jalur unggah biner: TikTok menariknya dari URL
  publik pada domain yang kepemilikannya diverifikasi pemilik di
  portal TikTok for Developers (tanpa itu:
  `url_ownership_unverified`). Adapter menyelesaikan URL lewat
  resolver media publik repo dan gagal aman sebelum memanggil
  paket ini bila URL tidak tersedia. Post_info foto membawa
  **`auto_add_music: true`** secara bawaan (parameter resmi
  DIRECT_POST — musik rekomendasi otomatis, permintaan pemilik),
  judul = potongan awal caption (maks 90 rune UTF-16), deskripsi =
  caption utuh (maks 4000). Platform menerima s/d 35 foto
  (JPEG/WebP); capability repo membatasi 10.

Isi paket:

- `TikTokClient` — klien tipis (fetch) ke `open.tiktokapis.com`:
  `queryCreatorInfo` (`/v2/post/publish/creator_info/query/`),
  `initVideoPublish` (`/v2/post/publish/video/init/`, FILE_UPLOAD),
  `uploadVideoChunk` (PUT `Content-Range` ke `upload_url`),
  `initPhotoPublish` (`/v2/post/publish/content/init/`),
  `fetchPublishStatus` (`/v2/post/publish/status/fetch/`), polling
  terminal bersama `pollPublishStatus` (privat), serta
  `publishVideo` / `publishPhotos` yang merangkai alur masing-
  masing sampai `PUBLISH_COMPLETE`/`FAILED`/`SEND_TO_USER_INBOX`.
  Base URL dari konstruktor (default `https://open.tiktokapis.com`;
  override dipakai uji mock).
- `buildTikTokVideoPostInfo` — pembangun `post_info` video murni:
  judul postingan adalah caption post (maks 2200); flag `disable_*`
  meniru interaksi yang dimatikan kreator di pengaturan TikTok.
- `buildTikTokPhotoPostInfo` — pembangun `post_info` foto murni
  (title/description dari caption, `disable_comment` meniru
  kreator, `auto_add_music` diteruskan dari keputusan pemanggil).
- `planTikTokUploadChunks` — perencana potongan murni (5–64 MB per
  potongan; sisa ekor di bawah minimum digabung ke potongan
  terakhir).
- `resolveTikTokPrivacyLevel` — gerbang privasi murni: level yang
  diminta hanya boleh bila akun mengizinkannya.
- `tiktokErrorCode` — pemetaan error aman: envelope
  `access_token_invalid` → `tiktok_unauthorized`,
  `scope_not_authorized` → `tiktok_scope_missing`,
  `rate_limit_exceeded`/`spam_risk_too_many_posts`/
  `spam_risk_too_many_pending_share` → `tiktok_rate_limited`,
  `unaudited_client_can_only_post_to_private_accounts` →
  `tiktok_unaudited_private_only`,
  `url_ownership_unverified` → `tiktok_url_unverified`,
  `privacy_level_option_mismatch` →
  `tiktok_privacy_option_mismatch`, status FAILED →
  `tiktok_publish_failed`, jaringan → `tiktok_network_error`.

Kredensial (access token OAuth scope `video.publish`) diserahkan
pemanggil per panggilan dari akun channel terenkripsi; token TIDAK
PERNAH masuk `TikTokApiError`/log. Access token TikTok berumur
±24 jam dan penyegaran otomatis belum dibangun (belum ada kolom
refresh token generik di repo) — token kedaluwarsa dipetakan ke
`tiktok_unauthorized` untuk dihubungkan ulang.
