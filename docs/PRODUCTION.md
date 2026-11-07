# Operasional produksi

## 1. Peran database

Dua role, dan pemisahannya **bukan formalitas**:

| Role | Dipakai | Sifat |
|---|---|---|
| pemilik skema (mis. `sahabat`) | migrasi, `db:doctor`, job sistem lintas tenant | melewati RLS |
| `sk_app` (non-owner, NOLOGIN → dipakai via login role aplikasi) | API, worker, realtime | **tunduk RLS** |

Bila API memakai role pemilik, seluruh isolasi tenant di
`0001_rls_tenant_isolation.sql` menjadi hiasan. `provision.ts doctor`
memeriksa hal ini dan keluar dengan kode 1 bila salah.

```bash
MIGRATION_DATABASE_URL=... pnpm --filter @sahabat-kreator/db db:doctor
MIGRATION_DATABASE_URL=... pnpm --filter @sahabat-kreator/db db:grant   # idempoten
```

## 2. Migrasi

```bash
pnpm --filter @sahabat-kreator/db db:generate   # setelah mengubah skema
pnpm --filter @sahabat-kreator/db db:migrate    # terapkan
pnpm --filter @sahabat-kreator/db verify        # bukti di PGlite, tanpa server
```

Jangan mengedit migrasi yang sudah ter-commit. Rantai saat ini:
`0000` baseline (generate) → `0001` RLS → `0002` grant role aplikasi →
`0003` constraint anti-double-booking.

## 3. Env wajib produksi

API menolak boot bila salah satu kunci di `PRODUCTION_REQUIRED_KEYS`
(`packages/config/src/index.ts`) kosong:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET` (≥32 char), `BETTER_AUTH_URL` (origin **browser**)
- `CHANNEL_TOKEN_SECRET` (base64 32 byte — AES-256-GCM)
- `WEBCHAT_SECRET`, `PLATFORM_SETTINGS_SECRET`

`REDIS_URL` **tidak** wajib-boot (ada fallback in-memory), tetapi di
produksi ia praktis wajib: tanpa Redis, sesi OAuth Meta dan cache rate
limit hidup di memori satu proses.

Kunci provider lain (OpenRouter, R2, Resend, Google, Midtrans/Xendit,
Meta) **tidak** masuk daftar itu dan sengaja tidak: platform harus bisa
boot dengan Telegram/webchat saja. Konsekuensinya kegagalan kunci-kunci
itu **tidak terlihat saat boot** — muncul belakangan sebagai fitur yang
menolak jalan. Dua yang paling mudah terlewat:

- `META_WEBHOOK_VERIFY_TOKEN` — **hanya dari env**, tidak ada di Panel
  Admin. Tanpa ini `GET /api/meta/webhook` menjawab 503, dan Panel Admin
  menampilkan "verify token belum diset, webhook tidak bisa didaftarkan".
  Nilainya kita yang menentukan (`openssl rand -hex 24` cukup), lalu
  ditempel ke Meta App Dashboard → Webhooks → Verify token. Owner/admin
  bisa membacanya lagi lewat `GET /channels/meta-webhook-info`.
- `META_APP_SECRET` — boleh env, tetapi **lebih baik lewat Panel Admin**
  (`meta_app_secret`), karena resolver panel → env dibaca ulang per
  request. Tanpa ini `POST /api/meta/webhook` menjawab 503; dengan ini
  tapi tanda tangan salah, jawabannya 401 `META_SIGNATURE_INVALID` —
  bedakan keduanya saat mendiagnosis.

## 4. Rate limit

Tiga lapis, sengaja berlapis:

1. Cloudflare (edge) — lapisan pertama yang dianjurkan.
2. In-app: `/v1` 600/menit, `/webchat` 300/menit, `/pay` + `/go`
   120/menit, per IP.
3. Better Auth: rate limit login di Redis.

**Peringatan:** tanpa `REDIS_URL`, penghitung rate limit jatuh ke memori
per proses. Itu benar untuk satu replika, **salah** untuk banyak. Di
produksi `REDIS_URL` wajib.

Saat Redis mati, limiter **fail-open** ke memori proses: request tidak
pernah gagal karena Redis bermasalah, tetapi batas efektif lintas replika
menjadi `limit × jumlah replika` selama 30 detik terakhir (limiter
berhenti mencoba Redis selama itu, lalu menyambung lagi). Ini trade-off
yang disengaja — alternatifnya menolak semua trafik, atau memindahkan
penghitung ke Postgres, yaitu database yang justru sedang dilindungi
limiter ini.

Karena itu degradasinya **terbaca di setiap respons**, bukan hanya di log:

```bash
curl -sI https://api.contoh.id/v1/ping | grep -i x-ratelimit
# X-RateLimit-Limit: 600
# X-RateLimit-Remaining: 597
# X-RateLimit-Scope: global        ← dihitung bersama semua replika
# X-RateLimit-Scope: process       ← HANYA proses ini; batas berlipat
```

`X-RateLimit-Scope: process` pada trafik normal berarti Redis sedang tidak
terjangkau (atau `REDIS_URL` memang kosong). Log mencatat satu baris
`ratelimit.redis_unavailable` per periode degradasi — bukan per request.

## 5. Kesehatan

| Endpoint | Arti |
|---|---|
| `/health` | proses hidup (liveness) |
| `/ready` | DB `SELECT 1` + Redis `PING` (readiness; 503 saat tidak siap) |
| `/version` | versi aplikasi + versi Graph API |

Readiness 503 **tidak** memicu restart loop — ia menarik replika dari
rotasi. Liveness yang memicu restart.

`/ready` juga yang dipantau otomatis setiap 5 menit — lihat §7.

## 6. Backup

Backup **otomatis dan teruji** — bukan sekadar perintah yang didokumentasikan.
Empat skrip di `deploy/scripts/`:

| Skrip | Fungsi |
| --- | --- |
| `install-backup-cron.sh` | memasang jadwal: backup harian 02:30 UTC, drill mingguan Minggu 03:30 UTC |
| `backup-db.sh` | `pg_dump` format custom → `~/backups/sahabat-kreator/{daily,weekly}`, lalu memverifikasi dump dapat dibaca ulang |
| `verify-backup-fresh-cluster.sh` | **drill bencana**: memulihkan dump ke cluster Postgres baru (volume kosong), membandingkan isi + struktur dengan produksi |
| `verify-backup.sh` | pemeriksaan cepat: memulihkan ke database UJI di cluster yang sama |
| `restore-db.sh` | pemulihan sungguhan ke produksi (menimpa; butuh `--yes`) |

```bash
cd /home/ubuntu/sahabat-kreator/deploy/scripts
./install-backup-cron.sh             # sekali, saat deploy awal
./backup-db.sh                       # boleh dijalankan manual kapan pun
./verify-backup-fresh-cluster.sh     # buktikan dump dapat menghidupkan mesin baru
./verify-backup.sh                   # pemeriksaan cepat, tanpa container tambahan
```

Keputusan yang mengikat:

- **`--no-privileges`** disengaja: hak role dipulihkan oleh migrasi `0002`
  dan `provision.ts grant`, bukan oleh dump. Restore dump ber-privileges
  ke role berbeda justru menghasilkan `permission denied` senyap.
- **Dump diverifikasi sesudah dibuat.** Dump terpotong tetap berukuran
  besar dan terlihat wajar sampai seseorang mencoba restore. `backup-db.sh`
  menjalankan `pg_restore --list` dan menolak dump yang tidak terbaca —
  lebih baik tidak punya berkas daripada punya berkas yang dikira backup.
- **Yang dijadwalkan mingguan adalah drill, bukan `verify-backup.sh`.**
  `verify-backup.sh` memulihkan ke database uji di dalam cluster produksi,
  yang sudah punya ekstensi `vector`/`btree_gist` dan role `sk_app`. Itu
  membuktikan dump terbaca, tetapi tidak menguji skenario sebenarnya:
  mesinnya hilang. Drill menyalakan container `pgvector/pgvector:pg16`
  dengan volume kosong dan `--network none`, memastikan titik awalnya
  benar-benar 0 tabel dan 0 ekstensi, baru memulihkan.
- **Uji restore membandingkan isi, bukan hanya jumlah baris.** Untuk tabel
  ≤ 50.000 baris, md5 dari seluruh barisnya yang terurut dibandingkan —
  jumlah baris yang sama di atas isi yang berbeda tetap lolos kalau hanya
  `count(*)` yang diperiksa.
- **Uji restore membandingkan struktur, bukan hanya baris.** Lima hitungan
  diperiksa: tabel, index, constraint, **policy RLS**, dan **tabel dengan
  RLS aktif**. Policy di atas tabel yang RLS-nya dimatikan tidak melakukan
  apa pun, sehingga hitungan policy bisa cocok sempurna sementara isolasi
  tenant sebenarnya tidak berlaku.
- **Role `sk_app` tidak pernah ikut dump** karena ia hidup di level
  cluster, bukan di dalam database. Restore bencana karena itu wajib
  menjalankan migrasi (`0002` membuat role) atau `restore-db.sh` yang
  membuat ulang role + GRANT. Drill mencetak fakta ini setiap kali jalan
  supaya tidak jadi kejutan saat benar-benar dipakai.
- **Off-site aktif lewat Cloudflare R2**, memakai rclone. Kredensialnya
  tidak disalin tangan: satu-satunya sumber adalah Panel Admin
  (`platform_settings`, terenkripsi). `deploy/scripts/sync-r2-credentials.sh`
  menariknya dari panel, mendekripsinya di dalam container `api`, lalu
  menulis `~/.config/rclone/rclone.conf` (mode 600) — nilai rahasia tidak
  pernah dicetak. Jalankan ulang skrip itu setiap kali kunci dirotasi;
  ada `--check` untuk menguji kredensial tanpa menulis apa pun.
  Konfigurasi off-site (perintah unggah, URL webhook) tinggal di
  `deploy/backup.env`, terpisah dari `.env` aplikasi — `.env` memuat
  rahasia runtime yang tidak ada urusannya dengan skrip backup.
- **Unggahan off-site diverifikasi ukurannya, bukan hanya "rclone tidak
  melapor galat".** `rclone copy` yang selesai tanpa galat berarti tidak
  ada galat yang dilaporkan, bukan bahwa objeknya ada dan utuh. Ukuran
  objek di R2 dibandingkan dengan berkas lokal; beda = gagal.
- **Off-site gagal = exit != 0.** Salinan lokal tetap disimpan dan tidak
  dihapus, tetapi kontrak skrip ini adalah "backup + off-site", jadi
  setengah berhasil ditandai gagal supaya cron punya sesuatu untuk
  dilaporkan. Tanpa itu, kegagalan off-site hanya jadi satu baris di
  `backup.log` yang tidak dibaca siapa pun.
- **Retensi berbeda di tiap sisi:** 7 harian + 28 hari mingguan di VPS,
  30 hari di R2. Off-site justru untuk menutup kasus "VPS-nya hilang",
  jadi wajar disimpan lebih lama di sana.
- **Notifikasi sadar-penyedia.** `lib-notify.sh` memilih bentuk body dari
  URL: Telegram form-encoded, Discord `{"content":…}`, sisanya
  `{"text":…}` (Slack/Mattermost). Satu bentuk untuk semua berarti
  notifikasi diam-diam hilang di dua dari tiga penyedia. Uji tanpa
  menunggu kegagalan nyata: `./backup-db.sh --test-notify`.
- **Heartbeat menutup celah yang tidak bisa ditutup notifikasi.** Semua
  notifikasi di atas dikirim oleh mesin yang sama dengan yang diawasi —
  kalau VPS-nya mati, tidak ada proses yang hidup untuk mengirim apa pun.
  `heartbeat.sh` (cron tiap jam :17) mem-ping layanan pemantau di luar,
  **tetapi hanya bila dump terbaru masih segar** (< 36 jam). Dengan begitu
  satu pemeriksaan menutup dua kegagalan: mesin mati, dan backup yang
  berhenti tanpa suara. Kalau yang diperiksa hanya "mesin hidup", backup
  yang berhenti berbulan-bulan tetap terlihat sehat.
- Volume Redis **tidak** perlu dibackup: isinya antrean dan cache. Job
  yang hilang dipulihkan dari `outbox_events` yang belum terbit.
- Media di R2 mengikuti retensi bucket.

### Media pelanggan (Fase 18)

Foto, audio, video, dan dokumen yang dikirim pelanggan **disimpan di
disk** pada `MEDIA_STORAGE_ROOT` (default `.data/media`, relatif terhadap
`cwd` proses). Worker menulis, API menyajikan — keduanya WAJIB menunjuk
direktori yang sama, dan `resolveMediaStorageRoot` dipakai oleh keduanya
supaya tidak bisa menyimpang. Kalau menyimpang, berkasnya tersimpan
tetapi tidak pernah bisa ditampilkan, tanpa satu pun error.

**Wajib:** arahkan `MEDIA_STORAGE_ROOT` ke volume yang bertahan
antar-deploy. Di container tanpa volume, setiap penggantian proses
membuat semua media lama menjadi tautan mati (pesan tetap ada,
gambarnya tidak). Ini juga berarti:

- direktori ini harus ikut dibackup bila media dianggap data, dan
- `media` (tabel) menunjuk object key; memulihkan DB tanpa memulihkan
  direktori ini menghasilkan 404 "Media object missing" untuk berkas
  lama — sengaja dibedakan dari 404 biasa supaya kelihatan.

Bucket R2 sudah terkonfigurasi tetapi BELUM dipakai untuk media: adapter
S3-nya belum ditulis karena tidak bisa diuji terhadap bucket sungguhan di
lingkungan build. `MediaObjectStore` adalah slotnya — mengganti disk
dengan R2 tidak menyentuh domain, route, maupun UI.

**Arah keluar.** Lampiran dari dashboard diunggah dulu ke direktori yang
sama (`POST /tenants/:tenantId/media`), baru dirujuk saat dikirim. Worker
membaca byte dari direktori itu lalu mengunggahnya ke Meta — Cloud API
tidak bisa mengambil berkas dari penyimpanan privat, jadi unggah ke Meta
adalah langkah wajib, bukan pilihan. Artinya: worker dan API WAJIB
berbagi volume, dan media keluar tetap bisa dikirim ulang selama berkasnya
masih ada.

Batas unggah juga 25 MB, dengan daftar putih tipe berkas (gambar, audio,
video, PDF, Office, ZIP, teks). `text/html` dan `image/svg+xml` sengaja
TIDAK diizinkan: keduanya bisa membawa skrip yang berjalan di origin
dashboard.

Batas unduhan 25 MB (plafon Meta: 16 MB media, 100 MB dokumen). Berkas
di atas batas TIDAK dibuang diam-diam: alasannya dicatat di
`messages.media_ingest_error`, dan setelah 5 percobaan barisnya berhenti
dipindai. Percobaan diberi jarak 5 menit (`MEDIA_INGEST_RETRY_BACKOFF_MS`),
jadi jatah itu menutupi gangguan ±25 menit — tanpa jarak, siklus 5 detik
akan menghabiskannya dalam 25 detik dan satu gangguan sesaat membuat
media hilang permanen.

**Header media pada template (Fase 18C).** Template ber-header
`IMAGE`/`VIDEO`/`DOCUMENT` dikirim dengan cara yang sama: worker membaca
berkas dari direktori media, mengunggahnya ke Meta, lalu memakai media id
hasil unggahan itu di komponen `header`. Konsekuensi operasionalnya:

- media id Meta **tidak disimpan** — ia berlaku per WABA dan kedaluwarsa,
  jadi setiap pengiriman mengunggah ulang. Yang kita simpan hanya id
  lampiran sendiri (`templatePayload.headerMediaId`), sehingga pesan yang
  diulang setelah gagal tetap punya sumber berkas yang sah;
- unggahan header menambah satu panggilan API sebelum kirim. Bila kuota
  atau jaringan Meta sedang bermasalah, pesan gagal di langkah unggah dan
  dicatat sebagai `failed` — bukan terkirim tanpa gambar;
- format header menentukan jenis berkas yang sah (`IMAGE` → gambar,
  `VIDEO` → video, `DOCUMENT` → selain audio). Pasangan yang salah
  ditolak saat mengantre, bukan setelah Meta menolaknya.

### Pembersihan media (Fase 19)

Tanpa pembersihan, direktori media hanya bertambah: berkas yatim (objek
tanpa baris), baris tanpa berkas, dan lampiran yang tak pernah dikirim.
Worker menjalankan satu putaran **tiap jam** (dan sekali saat boot);
untuk operasi manual:

```bash
pnpm --filter @sahabat-kreator/worker prune:media
```

Yang dilakukan satu putaran, berurutan:

1. **Baris tanpa berkas** dihapus. Baris seperti ini tidak bisa
   diperbaiki (URL Meta sudah kedaluwarsa) dan hanya menghasilkan 404
   saat agen menekan lampiran. **Penjaga:** kalau lebih dari 20% baris
   kehilangan berkas (minimal 10 baris), GC MENOLAK menghapus apa pun
   dan menulis error — itu ciri volume tidak ter-mount, bukan kerusakan
   normal.
2. **Baris tak dirujuk pesan** dihapus bersama berkasnya setelah 7 hari.
3. **Retensi** — hanya bila `MEDIA_RETENTION_DAYS > 0`.
4. **Berkas yatim** (objek tanpa baris) dihapus setelah 24 jam. Berkas
   yang lebih baru dibiarkan: objek ditulis SEBELUM barisnya, jadi
   berkas berumur detik belum tentu yatim.

`MEDIA_RETENTION_DAYS` **default 0 = simpan selamanya**. Menyalakannya
menghapus berkas lebih tua dari N hari, termasuk foto kiriman pelanggan;
pesan dan caption-nya tetap ada (`messages.media_id` menjadi NULL lewat
FK) dan inbox menampilkan "lampiran tidak lagi tersedia". Lampiran milik
pesan berstatus `queued` tidak pernah dihapus — menghapusnya mengubah
pesan yang akan terkirim menjadi gagal permanen.

Semua penghapusan baris terjadi **di konteks tenant masing-masing**;
lengan RLS `system_media_gc_scan` hanya memberi hak BACA lintas tenant
(diuji di `db verify` [46]).

### Retensi outbox (Fase 20)

`outbox_events` menyimpan setiap event domain (pesan terkirim, broadcast,
pembayaran, sinkron janji temu) di dalam transaksi yang sama dengan
perubahan datanya. Sampai Fase 20 tabel itu **tidak pernah dihapus sama
sekali** — termasuk baris yang sudah terbit — sehingga tumbuh monoton
dengan payload penuh.

Worker menjalankan satu putaran **tiap jam** (dan sekali saat boot); untuk
operasi manual:

```bash
pnpm --filter @sahabat-kreator/worker prune:outbox
```

| Baris | Umur simpan | Alasan |
|---|---|---|
| Sudah terbit (`published_at`) | 7 hari | Dikonsumsi relay dalam hitungan detik; seminggu jauh lebih longgar daripada kebutuhan debugging apa pun |
| Dead-letter (`dead_lettered_at`) | 30 hari | Bukti kegagalan handler/kredensial yang sedang ditelusuri operator |
| **Belum terbit** | **tidak pernah dihapus** | Pekerjaan yang belum selesai, bukan sampah |

Kalau relay sempat mati berhari-hari, event yang menumpuk tetap aman:
retensi hanya menyentuh baris yang sudah selesai diproses.

Retensi default: 7 dump harian + 28 hari cadangan mingguan di VPS, 30 hari
di R2. Retensi lokal dijalankan **sesudah** backup baru sukses, sehingga
kegagalan backup tidak pernah mengurangi jumlah salinan yang ada.

Prasyarat di host: `rclone` tersedia di `$PATH` atau `~/bin/rclone`
(biner statis, tidak butuh root). Tanpa itu, backup lokal tetap jalan dan
off-site dilaporkan gagal — bukan diam-diam dilewati.

### Memasang notifikasi dan heartbeat

Semua pengaturan ada di `deploy/backup.env` (mode 600, di-`.gitignore`),
terpisah dari `.env` aplikasi.

**Telegram** (disarankan: pesan sampai sebagai push ke HP):

```bash
# 1. Chat @BotFather → /newbot → simpan token.
# 2. Kirim satu pesan apa saja ke bot itu — bot tidak bisa memulai
#    percakapan sendiri, ini langkah yang paling sering terlewat.
# 3. Skrip mencari chat_id sendiri, menulis ALERT_WEBHOOK_URL, dan
#    mengirim pesan uji:
deploy/scripts/setup-alert-telegram.sh <BOT_TOKEN>
```

`chat_id` sengaja ditaruh di URL (`…/sendMessage?chat_id=…`) supaya
`notify()` cukup memakai satu variabel. Token tidak dicetak ulang oleh
skrip; yang ditampilkan hanya nama bot dan judul percakapan.

**Heartbeat** — buat check di layanan pemantau (healthchecks.io, cron-job.org,
UptimeRobot), atur periodenya ±1 jam dengan grace ±2 jam, lalu isi:

```
HEARTBEAT_URL='https://hc-ping.com/<uuid>'
```

Uji tanpa menunggu: `deploy/scripts/heartbeat.sh --dry-run` mencetak
keputusan tanpa menghubungi apa pun; tanpa `--dry-run` ia benar-benar
mem-ping. Selama `HEARTBEAT_URL` kosong, heartbeat tidak aktif dan tidak
dianggap gagal.

## 7. Pemantauan ketersediaan

Backup punya alarm (notifikasi kegagalan) dan dead-man's switch (heartbeat).
**Aplikasi tidak** — sampai 2026-11-05 tidak ada satu pun alarm yang berbunyi
saat API berhenti melayani. `restart: unless-stopped` memang menyalakan ulang
proses yang mati, tetapi ia tidak memberi tahu siapa pun dan tidak menolong
saat container crash-loop.

`deploy/scripts/check-ready.sh` menutup celah itu dan dipasang cron setiap
5 menit oleh `install-backup-cron.sh`:

| Perintah | Arti |
|---|---|
| `check-ready.sh` | periksa `/api/ready` lewat nginx (`127.0.0.1:5180`) |
| `check-ready.sh --status` | cetak status terakhir tanpa memeriksa |
| `check-ready.sh --dry-run` | periksa dan cetak aksi, tanpa mengirim apa pun |
| `check-ready.sh --force-fail` | paksa jalur gagal (menguji alert) |

Diperiksa **lewat nginx**, bukan langsung ke container `api`, supaya satu
pemeriksaan mencakup rantai yang benar-benar dilalui pengguna: nginx → api →
Postgres + Redis. Alarm dikirim setelah **2 kegagalan berturut-turut**
(praktisnya ~10 menit), sekali per insiden, lalu sekali lagi saat pulih.
Log: `~/backups/sahabat-kreator/ready.log`.

**Dua lapis, dan bedanya penting:**

1. **Alert Telegram** — dikirim dari VPS yang sama. Menangkap container mati,
   crash-loop, DB/Redis tidak siap, dan nginx rusak. TIDAK menangkap VPS mati
   total, karena pengirim alarm ikut mati.
2. **Dead-man's switch** (`READY_HEARTBEAT_URL`) — skrip hanya mengetuk layanan
   pemantau di luar VPS ketika aplikasi SEHAT. Kalau mesinnya mati, ketukan
   berhenti dan layanan pemantau yang membunyikan alarm. **Ini satu-satunya
   lapis yang menangkap kematian total mesin.**

Mengaktifkan lapis 2: buat check baru di healthchecks.io (period 5 menit,
grace 10 menit), lalu tambahkan ke `deploy/backup.env`:

```
READY_HEARTBEAT_URL='https://hc-ping.com/<uuid>'
```

Selama variabel itu kosong, lapis 2 tidak aktif dan tidak dianggap gagal —
lapis 1 tetap berjalan.

### Kalau ada yang lambat

`pg_stat_statements` aktif (di-set lewat `command:` pada service `db` di
`deploy/docker-compose.prod.yml`, plus `log_min_duration_statement=1000`).
Tanpa ini, pertanyaan "query mana yang lambat" hanya bisa dijawab dengan
menembak endpoint satu per satu — persis yang memakan waktu pada insiden
latensi 2026-11-05.

```sql
select calls, round(total_exec_time::numeric, 1) as total_ms,
       round(mean_exec_time::numeric, 2) as rata_ms, left(query, 90) as query
from pg_stat_statements
order by total_exec_time desc
limit 20;
```

`shared_preload_libraries` hanya dibaca saat proses postgres mulai, jadi
mengubahnya menuntut **restart container `db`** (data aman: ada di volume
`pgdata`). Setelah restart pertama, ekstensinya perlu dibuat sekali:
`create extension if not exists pg_stat_statements;`

### Kalau automation, flow, atau broadcast berhenti serentak

Semua pipa itu digerakkan **satu relay outbox** di proses `worker`. Sejak
Fase 16D relay memproses tiap event di savepoint sendiri: satu event rusak
tidak lagi membatalkan seluruh batch. Event yang gagal `OUTBOX_MAX_ATTEMPTS`
(5) kali **dikarantina**, bukan diulang selamanya — dan itu satu-satunya
keadaan yang perlu diperiksa manual:

```sql
-- event yang menyerah: tidak diproses lagi, tetapi tidak dianggap terkirim
SELECT id, tenant_id, type, attempts, last_error, created_at
  FROM outbox_events
 WHERE dead_lettered_at IS NOT NULL
 ORDER BY dead_lettered_at DESC
 LIMIT 20;

-- antrean yang masih menunggu (normal: puluhan, bukan ribuan)
SELECT count(*) FROM outbox_events
 WHERE published_at IS NULL AND dead_lettered_at IS NULL;
```

`last_error` memuat sebabnya (dipotong ±500 karakter) — bukan hanya "ada
yang gagal". Untuk mencoba ulang satu event setelah penyebabnya diperbaiki:

```sql
UPDATE outbox_events
   SET attempts = 0, last_error = NULL, dead_lettered_at = NULL
 WHERE id = '<id>';
```

Relay mengambilnya lagi pada siklus berikutnya (interval 2 detik). Log
worker menandai karantina dengan awalan `outbox DEAD-LETTER id=...`, jadi
`grep DEAD-LETTER` pada `docker compose logs worker` cukup untuk melihat
riwayatnya.

**Yang TIDAK boleh dilakukan:** menghapus baris `outbox_events` yang
`published_at IS NULL` untuk "membersihkan" antrean. Baris itu adalah satu-
satunya bukti bahwa sebuah automation/pesan seharusnya terjadi.

### Kalau satu pelanggan berhenti di tengah alur / tidak dibalas AI

Event outbox hanya menaruh job di BullMQ. Job punya `attempts: 3` dengan
backoff eksponensial; bila ketiganya gagal, BullMQ berhenti dan job itu
hilang dari pandangan. Sejak Fase 16E kegagalan **permanen** meninggalkan
baris audit `job.failed` (actor `system`, actor_id = nama job) berisi
`jobId`, `attempts`, dan pesan error terpotong:

**Audit → kategori "Background job"**, atau:

```sql
SELECT created_at, actor_id, meta
  FROM audit_logs
 WHERE action = 'job.failed'
 ORDER BY created_at DESC
 LIMIT 20;
```

Perhatikan bedanya: `failed` pada BullMQ berbunyi di SETIAP percobaan,
termasuk yang akhirnya berhasil. Yang dicatat ke audit hanya yang
MENYERAH — jadi daftar ini tidak berisi kegagalan yang sudah pulih.

### Kalau template gagal dikirim / tidak bisa dipakai broadcast

Sejak Fase 17 parameter template divalidasi **per komponen** (header,
body, tombol URL), bukan sebagai satu daftar. Dua kegagalan yang tersisa
dan artinya:

- **`MESSAGE_TEMPLATE_MEDIA_HEADER_UNSUPPORTED` (422).** Template memakai
  header gambar/video/dokumen. Header media memerlukan unggahan media,
  yang belum ada. Ditolak **sebelum** masuk antrean — jadi tidak ada
  pesan `failed` yang perlu dibersihkan. Kirim lewat aplikasi WhatsApp
  Business sampai dukungannya ditambahkan.
- **Broadcast melewati penerima dengan alasan
  "variabel di header/tombol belum bisa diisi".** Itu disengaja: broadcast
  belum punya pemetaan sumber data untuk header/tombol URL, dan
  mengirimnya akan menghasilkan ribuan `failed` di Meta. Pakai template
  yang semua variabelnya di body, atau kirim satu per satu dari inbox.

### Kalau balasan webchat tertulis "Menunggu pengunjung"

Itu **bukan** kegagalan pengiriman dan bukan antrean yang macet. Balasan
sudah tersimpan di kotak masuk widget dan akan tampil begitu pengunjung
membuka chat lagi — status berubah menjadi `sent` saat widget memuat
riwayat (polling 4 detik) atau saat socket pengunjung tersambung. Usia di
samping label menunjukkan sudah berapa lama ia menunggu, sehingga agen
bisa memutuskan menghubungi lewat jalur lain (email/telepon).

Kalau status itu bertahan berjam-jam untuk banyak kontak sekaligus,
periksa hal lain dulu sebelum menuduh webchat: akun channel yang
`disconnected` menghentikan seluruh arus pengunjung (409
`CHANNEL_DISCONNECTED` di sisi widget), dan pesan sengaja TIDAK ditandai
terkirim selama channel mati.

```sql
-- balasan webchat yang menunggu, terlama dulu
SELECT m.created_at, c.id AS conversation_id, left(m.content_text, 60) AS isi
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
 WHERE c.provider = 'webchat' AND m.direction = 'outbound' AND m.status = 'queued'
 ORDER BY m.created_at
 LIMIT 20;
```

### Kalau channel Meta tidak menerima pesan

Channel tampil "terhubung", token valid, dan webhook aplikasi benar — tetapi
tidak ada satu pun `POST /api/meta/webhook` di log nginx. Untuk WhatsApp ada
**dua** syarat yang keduanya harus benar-benar terpenuhi, dan keduanya tidak
terlihat dari halaman Channel:

```bash
# 1. WABA harus berlangganan aplikasi kita. Harus memuat "Sahabat Botara".
curl -s "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps?access_token=<TOKEN>"

# 2. Nomor harus berstatus CONNECTED. PENDING/RESTRICTED tidak menerima pesan.
curl -s "https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>?fields=status,quality_rating&access_token=<TOKEN>"
```

| Temuan | Arti | Tindakan |
| --- | --- | --- |
| `subscribed_apps` tidak memuat aplikasi kita | Meta tidak mengirim event ke webhook | Hubungkan ulang nomor di halaman Channel (sejak perbaikan 2026-11-05 jalur tempel token ikut subscribe), atau `POST /{WABA_ID}/subscribed_apps` |
| `status` = `PENDING` | Nomor terdaftar tetapi belum aktif | Selesaikan verifikasi/registrasi nomor di Meta Business Manager — ini di luar kendali aplikasi |
| keduanya benar | Masalah ada di jalur webhook aplikasi | Periksa callback URL + field `messages` pada `GET /{APP_ID}/subscriptions` |

Insiden 2026-11-05 (nomor "Kampung Inggris Booster"): penyebabnya baris
pertama — nomor dihubungkan lewat **tempel token**, sedangkan hanya jalur
OAuth Unified Login yang melakukan subscribe otomatis. Sesudah WABA
di-subscribe, percakapan WhatsApp pertama langsung masuk (masuk → keluar →
masuk → keluar, keempatnya `read`), tanpa perubahan lain.

### Coexistence (nomor dipakai juga di aplikasi WhatsApp Business)

Nomor yang di-onboard lewat alur coexistence tetap menerima pesan pelanggan
di field `messages`, dan pesan yang **diketik staf dari HP** datang di field
`smb_message_echoes`. Keduanya ditangani:

- Echo dicatat sebagai pesan **keluar** di percakapan yang sama (bukan pesan
  masuk, bukan kontak baru untuk nomor bisnis sendiri).
- Echo **tidak** memicu automation/AI. Ini disengaja: pesan itu baru saja
  diketik manusia, dan membalasnya otomatis adalah kebalikan dari maksudnya.
- `to` pada echo kadang berawalan `+`; parser menormalkannya supaya orang yang
  sama tidak menjadi dua kontak.

Yang **belum** diterapkan: `revoke` dan `edit` dari HP. Pesan yang dihapus
atau disunting lewat aplikasi WhatsApp Business tetap tampil apa adanya di
inbox; keduanya dicatat di log integrasi sebagai `ignored_status_only` supaya
tidak senyap. `smb_app_state_sync` (sinkronisasi kontak dari HP) belum
ditangani sama sekali.

### Status template (`/broadcasts`)

Template yang baru dibuat berstatus `PENDING` sampai Meta meninjaunya. Sejak
2026-11-06 status itu bergerak sendiri lewat field
`message_template_status_update`: cermin lokal diperbarui (status + alasan
penolakan) tanpa perlu menekan **Sinkron dari Meta**.

Syaratnya field itu benar-benar dilanggankan di **App Dashboard → WhatsApp →
Configuration → Webhook fields**. Catatan penting: webhook WhatsApp **tidak
bisa** diubah lewat `POST /{app-id}/subscriptions` (dibatasi Meta); hanya
dashboard. Cek hasilnya dengan:

```bash
curl -s "https://graph.facebook.com/v21.0/<APP_ID>/subscriptions?access_token=<APP_ID>|<APP_SECRET>"
# objek whatsapp_business_account harus memuat: messages, message_template_status_update
```

## 8. Skala

- `api`, `worker`, `realtime` semuanya stateless — boleh direplikasi.
- **Poller pengiriman Telegram/Meta berjalan di `worker`**
  (`apps/worker/src/delivery/`), bukan di API. Klaim barisnya atomik, jadi
  beberapa replika worker tetap aman; menambah replika API tidak menambah
  beban panggilan provider.
- Klaim outbound memakai `FOR UPDATE SKIP LOCKED`; dua replika tidak akan
  mengirim pesan yang sama.

## 9. Log dan audit

- Log terstruktur JSON (`LOG_LEVEL`), membawa `requestId`.
- `integration_log` — jejak per pesan keluar/masuk beserta kode error.
- `audit_logs` — aksi manusia & sistem; baris platform ber-`tenant_id`
  NULL dan hanya terlihat dengan flag admin.
- **Token tidak pernah masuk log.** Bila menemukan token di log, itu bug
  keamanan — perlakukan sebagai insiden.

## 10. Checklist sebelum rilis

- [ ] `pnpm lint` tanpa error
- [ ] `pnpm typecheck` hijau
- [ ] `pnpm test` hijau
- [ ] `pnpm --filter @sahabat-kreator/db verify` hijau
- [ ] `pnpm check:drift` hijau
- [ ] `db:doctor` hijau di DB target
- [ ] Backup diambil sebelum migrasi
- [ ] `META_ENGAGEMENT_SCOPES=0` kecuali App Review sudah menyetujui
