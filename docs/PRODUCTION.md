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

Yang harus dibackup:

```bash
pg_dump --format=custom --no-privileges "$DATABASE_URL" > sahabat-$(date +%F).dump
```

- `--no-privileges` disengaja: hak role dipulihkan oleh migrasi `0002`
  dan `provision.ts grant`, bukan oleh dump. Restore dump ber-privileges
  ke role berbeda justru menghasilkan `permission denied` senyap.
- Volume Redis **tidak** perlu dibackup: isinya antrean dan cache. Job
  yang hilang dipulihkan dari `outbox_events` yang belum terbit.
- Media di R2 mengikuti retensi bucket.

## 7. Skala

- `api`, `worker`, `realtime` semuanya stateless — boleh direplikasi.
- Poller pengiriman Telegram/Meta saat ini berjalan **di proses API**
  dan mengklaim baris secara atomik. Aman untuk beberapa replika, tetapi
  menambah beban DB per replika. Rencana: pindahkan ke `worker`.
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
