# Content Schedule — Kebutuhan Tindakan Pemilik

Daftar berjalan semua hal yang membutuhkan akun/kredensial/persetujuan
pemilik (Mas Romo) selama pengerjaan roadmap content schedule.

Sesuai instruksi pemilik 2026-11-12: daftar ini **dikumpulkan dan
disampaikan SEKALI di akhir semua fase**, bukan dicicil per gelombang.
Pengerjaan TIDAK berhenti menunggu daftar ini — semua yang bisa
dikerjakan dengan mock dikerjakan dengan mock (pola fake provider yang
sudah dipakai repo untuk test), dan baris "sudah dimock" mencatat
penggantinya.

Format per entri: gelombang · platform · yang dibutuhkan dari pemilik ·
untuk apa · apa yang sudah dimock sebagai gantinya.

---

## Gelombang 0 — Fondasi (administrasi paralel)

Kode Gelombang 0 sendiri tidak membutuhkan tindakan pemilik apa pun dan
tidak memakai mock. Tiga proses persetujuan eksternal di bawah ini oleh
roadmap memang DIMULAI di Gelombang 0 secara paralel, dan ketiganya
hanya bisa diajukan dari akun pemilik:

1. **Meta (Facebook/Instagram/Threads)** — dibutuhkan: akses ke Meta
   App yang sudah ada (App ID/Secret) dan akun Facebook pemilik yang
   menjadi admin app + Page/IG Business contoh untuk pengujian review.
   Untuk apa: mengajukan App Review izin `pages_manage_posts` dan
   `instagram_content_publish` (dan review Threads terpisah) agar
   Gelombang 1 bisa menerbitkan ke akun nyata, bukan hanya sandbox.
   Sudah dimock: belum perlu — Gelombang 0 tidak menyentuh Meta;
   adapter Meta di Gelombang 1 akan dibangun melawan fake Graph API
   seperti pola `verify:meta-send` yang sudah ada.

2. **TikTok** — dibutuhkan: akun TikTok developer atas nama pemilik/
   entitas dan pengajuan audit Content Posting API dari akun itu.
   Untuk apa: tanpa audit lolos, postingan API hanya boleh tampil
   private (`SELF_ONLY`); audit adalah prasyarat Gelombang 4 (direct
   post publik). Prosesnya lama, karena itu diajukan paling awal.
   Sudah dimock: belum perlu — implementasi TikTok belum dimulai;
   mode kirim-sebagai-draft akan dibangun melawan fake API dulu.

3. **Google Business Profile** — dibutuhkan: akun Google pemilik yang
   mengelola lokasi bisnis dan pengajuan akses Business Profile API
   dari akun/proyek Google Cloud pemilik.
   Untuk apa: kuota API bernilai 0 sampai Google menyetujui akses;
   persetujuan ini prasyarat Gelombang 3 (postingan per lokasi).
   Sudah dimock: belum perlu — implementasi GBP belum dimulai.

## Gelombang 1 — Keluarga Meta

1. **Facebook Page** — dibutuhkan: Meta App milik pemilik dengan
   izin `pages_manage_posts` lolos App Review, Page contoh yang
   terhubung sebagai akun `messenger`, dan Page Access Token hasil
   connect nyata. Untuk apa: adapter menerbitkan teks/tautan ke
   `/{page-id}/feed`, foto/album ke `/{page-id}/photos`, dan video ke
   `/{page-id}/videos` memakai token Page terenkripsi. Sudah dimock:
   seluruh permukaan Graph itu dibangun dan diverifikasi melawan fake
   Graph API (`verify:meta-post`) dengan token uji; sasaran Page
   dimaterialisasi dari `channel_accounts` terhubung tanpa migrasi.

2. **Instagram** — dibutuhkan: Meta App milik pemilik dengan izin
   `instagram_content_publish` lolos App Review, akun Instagram
   Business/Creator contoh yang terhubung ke Page, token hasil connect
   nyata, dan infrastruktur URL media publik yang dapat diambil Meta
   (CDN/pemetaan publik untuk media terjadwal; endpoint media internal
   repo bersesi dan sengaja tidak dipakai). Untuk apa: Content
   Publishing API membuat container dari `image_url`/`video_url`,
   menunggu status `FINISHED`, lalu memanggil `media_publish`; tanpa
   URL publik adapter gagal aman dengan
   `instagram_public_media_url_unavailable`. Sudah dimock: sasaran IG
   dimaterialisasi dari akun `instagram` terhubung, dan seluruh alur
   container foto/Reels/karousel diverifikasi melawan fake Graph API
   (`verify:meta-post`) dengan URL CDN contoh.

3. **Threads** — dibutuhkan: aplikasi Threads milik pemilik yang
   terpisah dari aplikasi Facebook/Instagram, review/izin
   `threads_content_publish`, akun Threads contoh, Threads user ID +
   user access token hasil OAuth nyata, dan infrastruktur URL media
   publik yang sama seperti Instagram untuk postingan bergambar/video.
   Untuk apa: adapter membuat container di `graph.threads.net/v1.0`,
   menunggu statusnya, lalu memanggil `threads_publish`; teks dapat
   terbit tanpa media, sedangkan media tanpa URL publik gagal aman
   dengan `threads_public_media_url_unavailable`. Sudah dimock:
   provider `threads` ditambahkan end-to-end sebatas akun/sasaran
   linimasa + capability + adapter (migrasi 0014), OAuth/connect
   generik sengaja belum dibuka dan Threads didokumentasikan bukan
   channel inbox; seluruh protokol container diverifikasi melawan
   fake Threads API (`verify:threads-post`).

## Gelombang 1.5 — Bluesky

1. **Bluesky** — dibutuhkan: akun Bluesky milik pemilik (handle,
   mis. akun brand di bsky.social) dan **app password** yang dibuat
   dari akun itu (Bluesky → Settings → Privacy and Security → App
   Passwords), plus DID akun tersebut. Untuk apa: adapter menukar
   app password menjadi sesi XRPC (`createSession`) setiap publikasi
   dengan identifier = DID; app password tersimpan terenkripsi pada
   akun channel (`access_token_encrypted`), handle pada
   `public_handle`, dan DID pada `external_id` — tanpa ketiganya
   tidak ada akun Bluesky nyata yang bisa diterbitkani. Sudah
   dimock: provider `bluesky` ditambahkan end-to-end sebatas
   akun/sasaran linimasa + capability + adapter (migrasi 0015), dan
   seluruh protokol sesi → `uploadBlob` → `createRecord` diverifikasi
   melawan fake XRPC (`verify:bluesky-post`) dengan DID dan app
   password uji; TIDAK dibutuhkan URL media publik (media diunggah
   sebagai biner). Catatan batas: provisioning/connect Bluesky belum
   dibuka di endpoint channel generik (dijawab
   `CHANNEL_NOT_AVAILABLE_YET`, sama seperti Threads) — pendaftaran
   akun nyata menunggu alur pendaftaran app password khusus atau
   penyemaian akun oleh operator; dan akun yang tinggal di PDS
   mandiri di luar entryway bsky.social memerlukan resolusi DID → PDS
   per akun yang belum dibangun (default mengasumsikan akun
   ter-hosting Bluesky).

## Gelombang berikutnya

_(belum ada entri — ditambahkan pekerja saat ditemukan, per gelombang)_
