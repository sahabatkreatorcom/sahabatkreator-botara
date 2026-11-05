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

## 5. Kesehatan

| Endpoint | Arti |
|---|---|
| `/health` | proses hidup (liveness) |
| `/ready` | DB `SELECT 1` + Redis `PING` (readiness; 503 saat tidak siap) |
| `/version` | versi aplikasi + versi Graph API |

Readiness 503 **tidak** memicu restart loop — ia menarik replika dari
rotasi. Liveness yang memicu restart.

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

## 7. Skala

- `api`, `worker`, `realtime` semuanya stateless — boleh direplikasi.
- **Poller pengiriman Telegram/Meta berjalan di `worker`**
  (`apps/worker/src/delivery/`), bukan di API. Klaim barisnya atomik, jadi
  beberapa replika worker tetap aman; menambah replika API tidak menambah
  beban panggilan provider.
- Klaim outbound memakai `FOR UPDATE SKIP LOCKED`; dua replika tidak akan
  mengirim pesan yang sama.

## 8. Log dan audit

- Log terstruktur JSON (`LOG_LEVEL`), membawa `requestId`.
- `integration_log` — jejak per pesan keluar/masuk beserta kode error.
- `audit_logs` — aksi manusia & sistem; baris platform ber-`tenant_id`
  NULL dan hanya terlihat dengan flag admin.
- **Token tidak pernah masuk log.** Bila menemukan token di log, itu bug
  keamanan — perlakukan sebagai insiden.

## 9. Checklist sebelum rilis

- [ ] `pnpm lint` tanpa error
- [ ] `pnpm typecheck` hijau
- [ ] `pnpm test` hijau
- [ ] `pnpm --filter @sahabat-kreator/db verify` hijau
- [ ] `pnpm check:drift` hijau
- [ ] `db:doctor` hijau di DB target
- [ ] Backup diambil sebelum migrasi
- [ ] `META_ENGAGEMENT_SCOPES=0` kecuali App Review sudah menyetujui
