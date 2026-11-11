# @sahabat-kreator/channel-youtube

Klien YouTube Data API v3 untuk **publikasi content schedule saja**
(Gelombang 2) — BUKAN adapter inbox: tidak ada webhook, pesan, atau
DM, dan paket ini tidak mengimplementasikan `ChannelAdapter`.

**Fase implementasi:** Gelombang 2 — HIDUP untuk publikasi. Isi paket:

- `YouTubeClient` — klien tipis (fetch) untuk `videos.insert` dengan
  protokol unggah resumable: inisiasi sesi (metadata JSON) → PUT
  biner video → resource video terbit. Base URL dari konstruktor
  (default `https://www.googleapis.com`; override mengikuti
  `GOOGLE_API_BASE` untuk uji mock). Error dilempar sebagai
  `YouTubeApiError` yang hanya membawa status HTTP + `reason` resmi
  Google — TIDAK PERNAH memuat access token.
- `buildYouTubeVideoMetadata` — pemetaan murni field post → metadata
  video: `title` post → judul video (maks 100), `caption` → deskripsi
  (maks 5000), kategori bawaan 22 (People & Blogs), `privacyStatus`
  dari konfigurasi platform.
- `youtubeErrorCode` — pemetaan error ke errorCode postingan; kuota
  proyek habis (`quotaExceeded` dkk.) mendapat kode khusus
  `youtube_quota_exceeded`.

Catatan desain yang mengikat:

- **Kredensial tidak tinggal di sini.** Access token diserahkan
  pemanggil; ia ditukar dari refresh token koneksi Google tenant
  oleh core (`getYouTubePublishAccess`) — satu koneksi Google
  melayani Calendar + YouTube, tidak ada jalur OAuth kedua.
- **Kuota dijaga.** `videos.insert` = 1600 dari 10.000 unit/hari per
  proyek Google. Klien ini tidak melakukan panggilan pendamping
  (tanpa polling, tanpa list) dari jalur publikasi.
- **Privasi bawaan `private`** (diatur adapter lewat env
  `YOUTUBE_PRIVACY_STATUS`): aplikasi Google yang belum terverifikasi
  memang dikunci Google ke private; bawaan aman ini membuat perilaku
  sama di semua keadaan sampai pemilik menaikkan statusnya.
