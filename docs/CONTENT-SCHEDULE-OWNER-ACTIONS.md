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

## Gelombang berikutnya

_(belum ada entri — ditambahkan pekerja saat ditemukan, per gelombang)_
