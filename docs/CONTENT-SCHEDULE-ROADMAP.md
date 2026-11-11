# Roadmap Content Schedule — Ekspansi Multi-Platform

Status: **disepakati 2026-11-12** (Mas Romo + Muse). Dokumen ini adalah
rencana, bukan kontrak API — detail kontrak tetap hidup di
`packages/contracts`, logika di `packages/core`, sesuai prinsip repo.

## Titik berangkat: Fase 23 (sudah live)

Content schedule **sudah ada** dan berjalan di produksi untuk **Telegram**:

- Tabel `posts` + `post_media` (migrasi 0012), RLS, FK media `RESTRICT`.
- State machine `draft → scheduled → publishing → published | failed`,
  plus `cancelled` (`packages/core/src/posts.ts`).
- Outbox `post.publish_due` → job BullMQ tertunda `post.publish`
  (attempts 1 — publikasi linimasa tidak idempoten; kegagalan dicatat,
  tidak diulang diam-diam). Klaim atomik + pencocokan `scheduled_at`
  membuat penjadwalan ulang kebal kirim ganda.
- Publisher Telegram: teks, 1 media, album 2–10 (`sendChannelPost`).
- API `/tenants/:tenantId/posts` (+`/targets`), halaman `/posts`,
  perlindungan media terjadwal dari `media-gc`, 12 test state machine.

Kekurangan saat ini: 1 post = 1 target; hanya Telegram; UI daftar (bukan
kalender); belum ada approval flow, recurring, retry manual untuk post
`failed`, maupun zona waktu tenant eksplisit; batas caption global 1024
(limit Telegram).

## Prasyarat arsitektur (Gelombang 0 — sebelum platform baru)

1. **`PublisherAdapter`** — ekstrak pola `apps/worker/src/delivery/telegram-post.ts`
   menjadi interface per provider: `publish(ctx) → { providerPostId }`.
   Worker memilih adapter dari provider target, bukan memanggil Telegram
   secara langsung seperti sekarang.
2. **Deklarasi kemampuan per platform** (`capabilities`) di kontrak:
   `mediaRequired`, `textOnly`, `maxCaption`, `maxMedia`, `supportsAlbum`,
   `supportsVideo`, `supportsFirstComment`, dll. Validasi penjadwalan di
   core memakai deklarasi ini — menggantikan batas global ala Telegram.
3. **Multi-target via grup** — satu konten induk membuat N baris `posts`
   (satu per target), dikelompokkan kolom grup baru. State machine dan
   klaim atomik tetap per target; status antar platform boleh berbeda.
4. **Varian konten per platform** — caption/media override opsional per
   target di atas konten induk (panjang caption dan rasio media berbeda
   antar platform).
5. **Kalender UI** (bulan/minggu/daftar, geser = jadwal ulang) dan
   **zona waktu tenant eksplisit** (default `Asia/Jakarta`), ditampilkan
   di UI — menggantikan ketergantungan pada jam browser pengguna.
6. **Retry manual + duplikat** untuk post `failed`/`publishing` macet
   (tetap manual dan teraudit — bukan auto-retry, sesuai filosofi
   attempts 1 Fase 23).

## Matriks platform target

| Platform | API publikasi | Gerbang persetujuan | Bentuk konten | Catatan kunci |
|---|---|---|---|---|
| Telegram ✅ | Bot API `sendChannelPost` | — (sudah live) | teks, media, album | acuan pola adapter |
| Facebook Page | Graph API `/{page-id}/feed|photos|videos` | App Review: `pages_manage_posts` | teks, tautan, foto, album, video, Reels | token Page sudah ada jalurnya di repo (inbox) |
| Instagram | Content Publishing API (container 2 tahap) | App Review: `instagram_content_publish` | foto, karousel ≤10, Reels — **wajib media** | akun Business/Creator terhubung Page; limit post/hari |
| Threads | Threads API `graph.threads.net` (container 2 tahap) | Review Threads: `threads_content_publish` | teks, gambar, video, karousel | app & review terpisah dari FB/IG, pola mirip IG |
| YouTube | YouTube Data API v3 `videos.insert` | Verifikasi aplikasi Google (scope `youtube.upload`) | video & Shorts saja | **kuota per project** (upload 1.600/10.000 unit/hari ≈ 6 video/hari) — perlu strategi kuota multi-tenant; tidak ada post teks/gambar |
| LinkedIn | Posts API + upload media | Profil: `w_member_social`; Company Page: program Community Management (ketat) | teks, gambar, video, dokumen | mulai dari profil pribadi; Page menyusul setelah akses disetujui |
| TikTok | Content Posting API | **Audit TikTok wajib** — sebelum lolos, post API hanya `SELF_ONLY` (private) | video (foto terbatas) | ajukan audit sejak Gelombang 0; jembatan: mode kirim-sebagai-draft, direct post terakhir |
| Pinterest | API v5 — Pins | Akses trial → persetujuan akses penuh | Pin gambar/video ke board | kuat untuk fashion, kuliner, DIY, wedding; tautan per Pin (bagus untuk traffic) |
| Bluesky | AT Protocol (`createRecord` + upload blob) | **tidak ada** — app password / OAuth | teks, gambar ≤4, video | platform termurah untuk dibangun; kandidat validasi `PublisherAdapter` pertama |
| Google Business | Business Profile API — local posts | Pengajuan akses API Google (kuota awal 0 sampai disetujui) | postingan STANDARD / EVENT / OFFER + tombol CTA, per lokasi | sangat relevan UMKM lokal (muncul di Maps & Search); 1 post per lokasi, bukan per akun |

Tidak masuk roadmap: **X/Twitter** (API berbayar, ROI rendah untuk
segmen kreator/UMKM) dan **WhatsApp** sebagai target linimasa (tidak ada
API publikasi pihak ketiga; kebutuhan massal sudah ditangani broadcasts).

## Gelombang pengerjaan

- **Gelombang 0 — Fondasi + administrasi.** Butir prasyarat 1–6 di atas.
  Paralel (proses di luar kendali kita, mulai paling awal): ajukan audit
  TikTok, pengajuan akses Google Business API, siapkan App Review Meta.
- **Gelombang 1 — Keluarga Meta: Facebook Page → Instagram → Threads.**
  Satu aplikasi Meta, satu keluarga token; izin publikasi diajukan dalam
  satu App Review. Nilai pengguna terbesar untuk kreator Indonesia.
- **Gelombang 1.5 — Bluesky.** Tanpa gerbang, usaha kecil — memvalidasi
  abstraksi adapter di platform kedua sebelum pola dibekukan. Boleh
  bertukar tempat dengan Gelombang 1 bila App Review Meta tersendat.
- **Gelombang 2 — YouTube.** Reuse OAuth Google yang sudah ada
  (Calendar). Termasuk keputusan strategi kuota per project dan apakah
  tenant besar diarahkan ke project/kuota sendiri.
- **Gelombang 3 — LinkedIn (profil dulu), Pinterest, Google Business.**
  Google Business menunggu persetujuan akses; LinkedIn Company Page
  menunggu program Community Management.
- **Gelombang 4 — TikTok direct post**, setelah audit lolos. Sebelumnya
  cukup mode draft.

## Sesudah semua gelombang (di luar roadmap ini)

- Approval flow (draft → review → approved sebelum terjadwal) — catatan
  ⚠️ yang sudah ada di `docs/COVERAGE-MATRIX.md`.
- Jadwal berulang / seri konten dan slot antrean rutin.
- Analitik per platform memakai `providerMessageId` yang sudah
  tersimpan (jangkauan, reaksi, klik) — aturan penarikan metrik berbeda
  per platform, diperlakukan sebagai fitur tersendiri.

## Keputusan yang masih terbuka

1. Email/akun pemilik untuk pendaftaran & peninjauan di tiap platform
   (Meta app, TikTok developer, Google Cloud, Pinterest, LinkedIn).
2. Apakah tenant tertentu (mis. agensi) perlu membawa aplikasi/kuota
   sendiri (khususnya YouTube) — ditunda sampai ada tenant nyata.
3. Prioritas segmen: bila mayoritas tenant adalah UMKM lokal, Google
   Business boleh didahulukan ke Gelombang 2 menukar tempat YouTube.
