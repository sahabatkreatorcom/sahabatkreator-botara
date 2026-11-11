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

**Cara memasukkan kredensial (instruksi pemilik 2026-11-12):** semua
kredensial dan pengaturan platform kini diisi lewat **Panel Admin**
(halaman Admin platform), BUKAN edit env server — env hanya fallback
bila isian panel kosong. Yang relevan untuk daftar ini: App ID/Secret
Meta dan klien OAuth Google memang sudah panel sejak awal; base URL
media publik, status privasi YouTube, dan level privasi TikTok kini
juga panel (grup "Content schedule"). Jadi setiap baris di bawah yang
menyebut kredensial/env dibaca sebagai: **isi/ubah di Panel Admin**.
Yang tetap tindakan pemilik dan TIDAK berubah: kepemilikan akun,
pengajuan App Review/audit/verifikasi ke masing-masing platform.

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
   **Langkah webhook (eksplisit, selama ini hanya tersirat):**
   isi **Meta App ID, App Secret, DAN Verify Token** di Panel Admin
   (grup Meta) — ketiganya dibaca lewat resolver panel → env, jadi
   tidak ada lagi edit env untuk ini. Setelah itu buka halaman
   **Channels**: blok info webhook Meta di sana menampilkan
   **Callback URL + Verify Token** yang harus ditempel pemilik ke
   dashboard Meta App (pengaturan Webhooks untuk objek Page) dan
   pemilik wajib **subscribe field `messages`** agar pesan masuk
   diteruskan Meta. Tanpa App Secret + Verify Token terisi, blok
   itu menampilkan "Webhook setup is not available yet" dan
   webhook masuk DITOLAK (handshake verifikasi tidak bisa
   dijawab) — jadi langkah ini prasyarat inbox Meta berfungsi,
   bukan sekadar pelengkap App Review.

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
   `threads_content_publish`, akun Threads contoh, dan infrastruktur
   URL media publik yang sama seperti Instagram untuk postingan
   bergambar/video. Untuk apa: adapter membuat container di
   `graph.threads.net/v1.0`, menunggu statusnya, lalu memanggil
   `threads_publish`; teks dapat terbit tanpa media, sedangkan media
   tanpa URL publik gagal aman dengan
   `threads_public_media_url_unavailable`. Sudah dibangun (di luar
   mock): provider `threads` end-to-end sebatas akun/sasaran linimasa
   + capability + adapter (migrasi 0014) dan seluruh protokol
   container diverifikasi melawan fake Threads API
   (`verify:threads-post`); Threads didokumentasikan bukan channel
   inbox. Per 2026-11-12: (i) App ID & App Secret aplikasi Threads
   bisa diisi di Panel Admin (grup Meta → sub-blok Threads; fallback
   env `THREADS_APP_ID` / `THREADS_APP_SECRET`); (ii) alur
   connect/OAuth Threads SUDAH DIBANGUN memakai kredensial itu —
   tombol "Hubungkan dengan Threads" di halaman Channels menjalankan
   authorize resmi (scope `threads_basic` +
   `threads_content_publish`) → token berumur panjang
   (`th_exchange_token`) tersimpan terenkripsi sebagai akun channel,
   dan token disegarkan otomatis oleh worker lifecycle
   (`th_refresh_token`, migrasi 0021) sebelum kedaluwarsa ±60 hari;
   seluruh alur diverifikasi melawan fake Threads OAuth + Graph
   (`verify:threads-oauth`, `verify:threads-token-lifecycle`). Yang
   TERSISA untuk pemilik: (a) membuat aplikasi Threads di portal
   Meta/Threads dan mengisi App ID + App Secret-nya di Panel Admin;
   (b) menempel Redirect URI `https://botara.my.id/api/threads/oauth/callback`
   persis di pengaturan aplikasi Threads (URI yang sama juga tampil
   di langkah Hubungkan Threads halaman Channels); (c) mengajukan
   App Review izin `threads_content_publish` agar akun di luar
   penguji aplikasi bisa terbit untuk publik; (d) menghubungkan satu
   akun Threads contoh lewat tombol itu untuk uji live pertama.

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

## Gelombang 2 — YouTube

1. **YouTube** — dibutuhkan: (a) proyek Google Cloud milik pemilik
   dengan YouTube Data API v3 aktif dan klien OAuth yang sama dengan
   yang dipakai Google Calendar (client ID/secret dikelola Panel
   Admin / env platform — TIDAK perlu aplikasi kedua); (b) verifikasi
   aplikasi OAuth Google untuk scope sensitif `youtube.upload` +
   `youtube.readonly` (layar consent terverifikasi; selama belum
   terverifikasi, Google membatasi consent dan video yang diunggah
   lewat API dikunci `private`); (c) channel YouTube contoh milik
   pemilik dan menghubungkan ulang Google dari dashboard (consent
   inkremental menambahkan scope YouTube ke koneksi yang sudah ada —
   callback otomatis menyinkronkan akun channel youtube dari koneksi
   itu); (d) keputusan strategi kuota: kuota bawaan 10.000 unit/hari
   per proyek dan `videos.insert` berharga 1.600 unit (≈ 6 video/hari
   untuk SEMUA tenant bersama) — ajukan penambahan kuota ke Google
   atau putuskan tenant besar membawa proyeknya sendiri (keputusan
   terbuka roadmap no. 2); (e) setelah verifikasi selesai, naikkan
   status privasi YouTube di Panel Admin (grup Content schedule) dari
   bawaan `private` ke `unlisted`/`public` bila video terjadwal harus
   langsung publik (env `YOUTUBE_PRIVACY_STATUS` hanya fallback).
   Untuk apa:
   adapter menukar refresh token koneksi Google tenant menjadi access
   token (scope diperiksa; koneksi lama menjawab
   `youtube_scope_missing` sampai dihubungkan ulang), membaca kanal
   dari `channels.list?mine=true` saat sinkronisasi, dan mengunggah
   video dengan `videos.insert` resumable; kuota habis terpetakan ke
   `youtube_quota_exceeded`. Sudah dimock: provider `youtube`
   ditambahkan end-to-end sebatas akun/sasaran linimasa + capability
   + adapter (migrasi 0016), scope ditambahkan ke consent Google yang
   ada, sinkronisasi akun + gerbang scope diuji di core
   (`youtube.test.ts`, fetch fake), dan seluruh protokol resumable
   diverifikasi melawan fake Google API (`verify:youtube-post`,
   12 PASS) dengan access token uji; TIDAK dibutuhkan URL media
   publik (video diunggah sebagai biner dari object store privat).
   Catatan batas: provisioning YouTube BUKAN connect channel generik
   (dijawab `CHANNEL_NOT_AVAILABLE_YET`) — jalurnya adalah
   menghubungkan Google; judul video diambil dari `title` post
   (maks 100, divalidasi core) dan deskripsi dari caption (maks
   5000); unggahan memakai satu PUT penuh ke sesi resumable —
   kelanjutan chunked setelah PUT 308 belum dibangun (postingan
   gagal dengan `youtube_upload_incomplete` dan dijadwalkan ulang
   manual).

## Gelombang 3 — LinkedIn, Pinterest, Google Business

1. **LinkedIn** — dibutuhkan: (a) aplikasi LinkedIn milik pemilik
   (LinkedIn Developer) dengan produk Sign In with LinkedIn (OpenID)
   + Share on LinkedIn aktif; (b) OAuth pemilik akun LinkedIn pribadi
   dengan scope `openid profile w_member_social` agar member ID +
   access token terekam sebagai akun channel `linkedin`; (c) akun
   LinkedIn pribadi contoh untuk publikasi nyata pertama. Untuk apa:
   adapter menerbitkan ke PROFIL PRIBADI (`urn:li:person:{member ID}`)
   lewat Posts API — unggah media Images/Videos API lalu
   `POST /rest/posts` dengan versi REST ter-pin
   (`LINKEDIN_API_VERSION` di paket channel-linkedin; LinkedIn
   menghentikan versi setelah ±1 tahun, jadi menaikkan konstanta itu
   adalah perawatan berkala pemilik platform). Sudah dimock:
   provider `linkedin` ditambahkan end-to-end sebatas akun/sasaran
   linimasa + capability + adapter (migrasi 0017), dan seluruh alur
   unggah gambar/video + pembuatan post diverifikasi melawan fake
   LinkedIn API (`verify:linkedin-post`, 16 PASS) dengan access token
   uji; TIDAK dibutuhkan URL media publik (media diunggah sebagai
   biner). Catatan batas: **Company Page BUKAN sasaran gelombang
   ini** — menerbitkan sebagai Page membutuhkan persetujuan program
   Community Management LinkedIn yang terpisah dan ketat; ajukan
   program itu dari akun pemilik bila Page perusahaan menjadi
   kebutuhan nyata (pengembangan lanjutan, bukan pembangunan
   setengah-setengah di gelombang ini). Provisioning LinkedIn juga
   belum dibuka di endpoint connect generik (dijawab
   `CHANNEL_NOT_AVAILABLE_YET`) — pendaftaran akun nyata menunggu
   alur OAuth LinkedIn khusus atau penyemaian akun oleh operator.

2. **Pinterest** — dibutuhkan: (a) aplikasi Pinterest milik pemilik
   (Pinterest Developers) yang naik dari akses trial ke persetujuan
   akses PENUH (Pin creation pada akses trial hanya menjangkau akun
   sandbox/terbatas); (b) OAuth pemilik akun Pinterest dengan scope
   `boards:read` + `pins:read,pins:write` agar user ID + access
   token terekam sebagai akun channel `pinterest`; (c) akun
   Pinterest contoh yang SUDAH punya minimal satu board publik —
   board PERTAMA akun adalah tujuan bawaan Pin (akun tanpa board
   gagal aman `pinterest_board_missing`); (d) untuk gambar berformat
   selain JPEG/PNG (mis. GIF), infrastruktur URL media publik yang
   sama seperti Instagram (base URL-nya diisi di Panel Admin grup
   Content schedule; env `POST_MEDIA_PUBLIC_BASE_URL` hanya fallback)
   karena format itu hanya bisa dikirim sebagai `image_url`. Untuk apa:
   adapter membuat Pin API v5 (judul dari `title` post maks 100,
   deskripsi dari caption maks 800, tautan tujuan dari URL pertama
   caption) ke board pertama akun. Sudah dimock: provider
   `pinterest` ditambahkan end-to-end sebatas akun/sasaran linimasa
   + capability + adapter (migrasi 0018), dan pembuatan Pin kedua
   jalur media diverifikasi melawan fake API v5
   (`verify:pinterest-post`, 12 PASS) dengan access token uji;
   gambar JPEG/PNG TIDAK butuh URL publik (dikirim `image_base64`
   dari biner privat). Catatan batas: Pin video DITUNDA (butuh
   subsistem pendaftaran media asinkron API v5 — unggah multipart +
   polling status media; alasan yang sama seperti video Bluesky);
   pemilihan board per postingan belum dibangun (satu keputusan
   bawaan: board pertama); provisioning Pinterest belum dibuka di
   endpoint connect generik (`CHANNEL_NOT_AVAILABLE_YET`).

3. **Google Business Profile** — dibutuhkan: (a) pengajuan akses
   Business Profile API dari proyek Google Cloud milik pemilik
   disetujui Google — **kuota API bernilai 0 sampai disetujui** dan
   selama itu publikasi nyata menjawab
   `google_business_permission_denied`; prasyarat ini sudah tercatat
   sejak Gelombang 0 dan merupakan gerbang terpanjang gelombang
   ini; (b) verifikasi aplikasi OAuth Google mencakup scope
   `business.manage` yang kini ikut diminta consent Google yang
   sama; (c) akun Google pemilik yang mengelola lokasi bisnis
   contoh, lalu menghubungkan ulang Google dari dashboard (consent
   inkremental menambahkan scope business ke koneksi yang sudah
   ada — callback otomatis menyinkronkan semua lokasi akun itu
   menjadi akun lokasi `google_business`, satu sasaran per lokasi);
   (d) infrastruktur URL media publik (base URL-nya diisi di Panel
   Admin grup Content schedule; env `POST_MEDIA_PUBLIC_BASE_URL`
   hanya fallback; sama seperti Instagram) bila postingan lokal
   harus membawa foto —
   API postingan lokal hanya menerima `sourceUrl` publik, bukan
   biner; postingan teks terbit tanpa kebutuhan ini. Untuk apa:
   adapter membuat postingan lokal STANDARD per lokasi
   (`POST /v4/{location}/localPosts`, summary maks 1500, CTA
   LEARN_MORE dari URL pertama caption). Sudah dimock: provider
   `google_business` ditambahkan end-to-end sebatas akun/sasaran
   linimasa + capability + adapter (migrasi 0019), scope
   ditambahkan ke consent Google yang ada, sinkronisasi lokasi +
   gerbang scope diuji di core (`google-business.test.ts`, fetch
   fake, 6 test), dan protokol localPosts diverifikasi melawan
   fake Business Profile API (`verify:google-business-post`,
   10 PASS) dengan access token uji. Catatan batas: provisioning
   GBP BUKAN connect channel generik (dijawab
   `CHANNEL_NOT_AVAILABLE_YET`) — jalurnya adalah menghubungkan
   Google; jenis postingan EVENT/OFFER belum dibangun (STANDARD
   saja); satu lokasi dikelola satu koneksi Google tenant.

## Gelombang 4 — TikTok (gelombang terakhir)

1. **TikTok** — dibutuhkan: (a) aplikasi TikTok milik pemilik
   (TikTok for Developers) dengan produk Login Kit + Content
   Posting API aktif dan client key/secret aplikasi itu — per
   2026-11-12, Client Key & Client Secret kini bisa diisi di Panel
   Admin (grup TikTok; fallback env `TIKTOK_CLIENT_KEY` /
   `TIKTOK_CLIENT_SECRET`) dan akan dipakai alur connect/OAuth
   TikTok kelak; pendaftaran aplikasinya sendiri tetap tindakan
   pemilik di portal TikTok for Developers; (b)
   pengajuan **AUDIT Content Posting API** dari akun pemilik —
   prasyarat ini sudah dicatat sejak Gelombang 0 karena prosesnya
   paling lama: TANPA audit lolos, TikTok hanya mengizinkan
   postingan API berprivasi `SELF_ONLY` (hanya terlihat kreator
   sendiri), dan adapter memang berjalan dengan bawaan itu; (c)
   daftarkan Redirect URI yang ditampilkan blok TikTok di halaman
   Channels persis seperti tertulis di aplikasi TikTok (Login
   Kit), lalu hubungkan akun TikTok contoh dari halaman Channels
   (Hubungkan → TikTok → "Hubungkan dengan TikTok") — alur connect
   OAuth-nya SUDAH dibangun (gelombang Semua OAuth, lihat bagian
   terakhir dokumen ini) dengan scope `user.info.basic` +
   `video.publish`; (d) SETELAH audit lolos, naikkan level
   privasi TikTok di Panel Admin (grup Content schedule) dari
   `SELF_ONLY` ke level yang dikehendaki (`PUBLIC_TO_EVERYONE` dsb.;
   env `TIKTOK_PRIVACY_LEVEL` hanya fallback) — adapter memvalidasi
   level itu terhadap `privacy_level_options` akun dan menolak
   dengan `tiktok_privacy_option_mismatch` bila akun belum
   mengizinkannya; (e) khusus FOTO/CAROUSEL: **verifikasi
   kepemilikan domain (atau prefix URL) dari base URL media
   publik** di portal TikTok for Developers, dan isi base URL itu
   di Panel Admin (grup Cloudflare R2; env
   `POST_MEDIA_PUBLIC_BASE_URL` hanya fallback) — foto hanya bisa
   `PULL_FROM_URL` dari domain terverifikasi itu; tanpa
   verifikasi, init foto ditolak provider dengan
   `url_ownership_unverified`, dan tanpa base URL terisi adapter
   gagal aman `tiktok_public_media_url_unavailable` sebelum
   memanggil API. Untuk apa: adapter menerbitkan direct post
   dalam dua bentuk — VIDEO: periksa `creator_info` → init
   unggah `FILE_UPLOAD` → unggah biner per potongan dari object
   store privat → polling status sampai `PUBLISH_COMPLETE`;
   FOTO/CAROUSEL: `creator_info` yang sama → init ke
   `/content/init/` (`media_type: PHOTO`, `post_mode:
   DIRECT_POST`, `PULL_FROM_URL`) dengan `auto_add_music: true`
   (musik rekomendasi otomatis, parameter resmi post_info foto)
   → polling status yang sama. Judul postingan adalah caption
   post (video maks 2200; foto: caption menjadi title maks 90 +
   description maks 4000). Sudah dimock: provider `tiktok`
   ditambahkan end-to-end sebatas akun/sasaran linimasa +
   capability + adapter (migrasi 0020), dan seluruh protokol
   kedua jalur (creator_info → init → potongan Content-Range /
   daftar URL foto → polling, gerbang privasi sebelum init,
   pemetaan error termasuk kuota posting harian
   `spam_risk_too_many_posts` dan `url_ownership_unverified`)
   diverifikasi melawan fake Content Posting API
   (`verify:tiktok-post`, 28 PASS) dengan access token uji;
   video TIDAK membutuhkan URL media publik (diunggah sebagai
   biner), foto MEMBUTUHKANNYA (butir e). Catatan batas: mode
   foto/carousel **SUDAH dibangun** (pengembangan lanjutan
   pasca-roadmap atas permintaan pemilik) — yang tersisa murni
   tindakan pemilik pada butir (e) di atas; foto yang diterima
   TikTok berformat JPEG/WebP (PNG ditolak platform, konversi
   belum dibangun); access
   token TikTok berumur ±24 jam dan — sejak gelombang Semua
   OAuth — penyegaran otomatisnya SUDAH dibangun: connect
   menyimpan refresh token (±365 hari) terenkripsi dan worker
   lifecycle menyegarkannya sebelum kedaluwarsa (rotasi penuh);
   token yang tetap kedaluwarsa (refresh dicabut/ditolak)
   menjawab `tiktok_unauthorized` dan akun ditandai error agar
   dihubungkan ulang dari Channels; bila scope yang
   diberikan ternyata `video.upload` (bukan `video.publish`),
   konten mendarat sebagai draf di inbox kreator
   (`SEND_TO_USER_INBOX`) untuk ditinjau manual, bukan terbit
   langsung; provisioning TikTok tetap tidak dibuka di endpoint
   connect generik (dijawab `CHANNEL_NOT_AVAILABLE_YET`) — jalur
   resminya adalah blok connect TikTok khusus di Channels.

## Gelombang Semua OAuth — Connect TikTok/LinkedIn/Pinterest/Bluesky/Google

Semua alur connect di bawah SUDAH dibangun & terverifikasi melawan
API tiruan (verify:tiktok-oauth 11 grup, verify:tiktok-token-lifecycle
20 PASS, verify:linkedin-oauth, verify:pinterest-oauth,
verify:bluesky-connect, verify:google-channels, plus lifecycle
masing-masing). Yang tersisa murni tindakan pemilik per platform:

1. **TikTok** — (a) buat aplikasi di TikTok for Developers dengan
   produk Login Kit + Content Posting API; (b) isi Client Key &
   Client Secret di Panel Admin (grup TikTok) — SUDAH bisa sejak
   pengembangan foto/carousel; (c) daftarkan Redirect URI dari blok
   TikTok di Channels ke aplikasi (Login Kit → Redirect URI);
   (d) ajukan audit Content Posting API (tanpa audit, postingan
   API hanya `SELF_ONLY`); (e) hubungkan akun contoh dari Channels.
2. **LinkedIn** — (a) buat aplikasi di LinkedIn Developers dan
   aktifkan produk "Sign In with LinkedIn using OpenID Connect" +
   "Share on LinkedIn" (scope `openid profile w_member_social`);
   (b) isi Client ID & Client Secret di Panel Admin (grup LinkedIn
   — formulirnya BARU ditambahkan gelombang ini; fallback env
   `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`); (c) daftarkan
   Redirect URI dari blok LinkedIn di Channels sebagai Authorized
   Redirect URL aplikasi; (d) hubungkan profil contoh dari
   Channels. KEJUJURAN LIFECYCLE: LinkedIn TIDAK menerbitkan
   refresh token untuk program standar — token ±60 hari; worker
   lifecycle hanya MENANDAI akun menjelang kedaluwarsa dan
   menandainya 'error' (`linkedin_token_expired`) sesudah lewat,
   agar pemilik menghubungkan ulang; tidak ada penyegaran diam-diam.
   Company Page tetap di luar jangkauan (program Community
   Management terpisah).
3. **Pinterest** — (a) buat aplikasi di Pinterest Developers;
   (b) isi App ID & App Secret di Panel Admin (grup Pinterest —
   formulirnya BARU ditambahkan gelombang ini; fallback env
   `PINTEREST_APP_ID`/`PINTEREST_APP_SECRET`); (c) daftarkan
   Redirect URI dari blok Pinterest di Channels ke aplikasi;
   (d) ajukan akses penuh (Standard) bila masih Trial — Pin dari
   aplikasi Trial hanya terlihat oleh pemiliknya; (e) hubungkan
   akun contoh dari Channels. Token ±30 hari disegarkan otomatis
   memakai refresh token; Pin diterbitkan ke board PERTAMA akun.
4. **Bluesky** — tidak ada aplikasi/platform yang perlu dibuat:
   pemilik akun cukup membuat App Password di Bluesky (Pengaturan
   → Privasi dan Keamanan → Kata Sandi Aplikasi) lalu mengisi
   handle + App Password di blok Bluesky pada halaman Channels.
   App password tidak kedaluwarsa; cabut dari Bluesky bila tidak
   dipakai lagi (akun akan gagal terbit dan perlu dihubungkan
   ulang dengan app password baru).
5. **Google (YouTube + Google Business)** — tidak ada OAuth baru:
   blok Google di Channels memakai koneksi Google yang sama
   seperti Kalender. Tindakan pemilik tetap seperti Gelombang
   2/3: verifikasi aplikasi Google + scope sensitif
   (youtube.upload, business.manage) agar consent tidak ditolak
   Google, lalu hubungkan akun Google contoh dari Channels atau
   Kalender — kanal YouTube + lokasi bisnis tersinkron otomatis
   sebagai akun channel.

---

_Daftar ini lengkap untuk Gelombang 0 sampai 4 (seluruh roadmap
content schedule) + gelombang Semua OAuth. Entri baru hanya
ditambahkan bila ada pengembangan lanjutan di luar roadmap._
