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

API menolak boot bila kunci bertanda `[wajib-produksi]` kosong.

- `DATABASE_URL`, `REDIS_URL`
- `BETTER_AUTH_SECRET` (≥32 char), `BETTER_AUTH_URL` (origin **browser**)
- `CHANNEL_TOKEN_SECRET` (base64 32 byte — AES-256-GCM)
- `WEBCHAT_SECRET`, `PLATFORM_SETTINGS_SECRET`
- `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`

Kunci provider lain (OpenRouter, R2, Resend, Google, Midtrans/Xendit)
**sebaiknya** diisi lewat Panel Admin (`platform_settings` terenkripsi);
env hanya fallback.

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
- **Off-site belum aktif.** `BACKUP_UPLOAD_CMD` kosong = salinan hanya ada
  di VPS ini. Selama itu belum diisi, VPS yang mati berarti backup ikut
  hilang — dan drill yang lolos tetap tidak menolong. Isi setelah
  kredensial R2 tersedia, mis.:
  `BACKUP_UPLOAD_CMD='rclone copy "$1" r2:sahabat-kreator-backup'`.
- Volume Redis **tidak** perlu dibackup: isinya antrean dan cache. Job
  yang hilang dipulihkan dari `outbox_events` yang belum terbit.
- Media di R2 mengikuti retensi bucket.

Retensi default: 7 dump harian + 28 hari cadangan mingguan. Retensi
dijalankan **sesudah** backup baru sukses, sehingga kegagalan backup tidak
pernah mengurangi jumlah salinan yang ada.

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
