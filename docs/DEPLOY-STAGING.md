# Deploy (Docker + Cloudflare Tunnel)

Target: `https://botara.my.id` → Cloudflare Tunnel → nginx (`web`) →
`api` / `realtime` → `db`, `redis`.

Semua container hanya mengikat `127.0.0.1`; satu-satunya pintu masuk
adalah tunnel. Tidak ada port aplikasi yang terbuka ke internet.

## 1. Prasyarat di server

- Docker + Docker Compose v2
- `cloudflared` berjalan sebagai service (mode token, dikelola dashboard
  Cloudflare)
- Direktori aplikasi, mis. `/home/ubuntu/sahabat-kreator`

## 2. Ambil kode

```bash
cd /home/ubuntu
git clone git@github.com:sahabatkreatorcom/sahabatkreator-botara.git sahabat-kreator
cd sahabat-kreator
```

Bila repo sudah ada: `git pull --ff-only`.

## 3. Siapkan `.env` produksi

`.env` **tidak** ikut repo (ada di `.gitignore`). Buat sekali, isi
rahasia acak:

```bash
cd deploy
umask 077
PG_PW=$(openssl rand -hex 24)      # superuser pemilik skema
APP_PW=$(openssl rand -hex 24)     # role aplikasi (runtime)
cat > .env <<EOF
NODE_ENV=production
API_PORT=3101
REALTIME_PORT=3103
REALTIME_HOST=0.0.0.0
LOG_LEVEL=info

POSTGRES_PASSWORD=$PG_PW
DATABASE_URL=postgres://sk_app:$APP_PW@db:5432/sahabat_kreator
REDIS_URL=redis://redis:6379

BETTER_AUTH_SECRET=$(openssl rand -hex 32)
BETTER_AUTH_URL=https://botara.my.id
CHANNEL_TOKEN_SECRET=$(openssl rand -base64 32 | tr -d '\n')
WEBCHAT_SECRET=$(openssl rand -hex 32)
PLATFORM_SETTINGS_SECRET=$(openssl rand -base64 32 | tr -d '\n')
PLATFORM_ADMIN_EMAILS=

LLM_PROVIDER=mock
META_ENGAGEMENT_SCOPES=0
EOF
chmod 600 .env
```

### Kenapa ada DUA password database

| Kunci | Role | Dipakai oleh |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `sahabat` (superuser, pemilik skema) | container `db`, langkah migrasi |
| password di `DATABASE_URL` | `sk_app` (NOLOGIN sampai diset) | api, worker, realtime |

**RLS tidak berlaku bagi pemilik tabel.** Kalau API menyambung sebagai
`sahabat`, seluruh isolasi tenant di `0001_rls_tenant_isolation.sql`
menjadi hiasan — setiap tenant dapat membaca data tenant lain.
`0002_app_role_grants.sql` membuat `sk_app` dan memberinya hak tabel;
password-nya di-set sekali pada langkah 4. `pnpm --filter
@sahabat-kreator/db db:doctor` memeriksa pemisahan ini dan akan gagal
bila runtime masih memakai role pemilik.

`REALTIME_HOST=0.0.0.0` wajib di Docker: container `realtime` dan `web`
(nginx) adalah dua netns berbeda, sehingga bind `127.0.0.1` tidak dapat
dijangkau nginx dan proxy `/realtime/` akan gagal 502. Port-nya tetap
hanya di-publish ke loopback host (`127.0.0.1:3103`), jadi tidak terbuka
ke internet.

## 4. Build dan jalankan

```bash
cd /home/ubuntu/sahabat-kreator/deploy
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d db redis
```

Migrasi dijalankan sekali, bukan oleh replika API — dan **sebagai role
pemilik skema**, bukan role aplikasi (`sk_app` tidak punya hak CREATE,
jadi DDL akan ditolak):

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -e DATABASE_URL="postgres://sahabat:$PG_PW@db:5432/sahabat_kreator" \
  migrate "cd /app && pnpm --filter @sahabat-kreator/db db:migrate"
```

Sesudah migrasi, beri `sk_app` kemampuan login (sekali saja; idempoten):

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U sahabat -d sahabat_kreator \
  -c "ALTER ROLE sk_app WITH LOGIN PASSWORD '$APP_PW'"
```

Lalu seluruh layanan:

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

## 5. Arahkan tunnel

Di dashboard Cloudflare (Zero Trust → Tunnels → Public Hostname), arahkan
`botara.my.id` ke `http://localhost:5180` (container `web`).

Karena tunnel memakai token, konfigurasi ingress **tidak** ada di server
— jangan mencari `config.yml`; satu-satunya berkas lokal adalah
`/etc/cloudflared/token`.

## 6. Verifikasi

```bash
curl -s http://127.0.0.1:5180/health   | head -c 200
curl -s http://127.0.0.1:5180/ready    | head -c 300
curl -sI https://botara.my.id | head -5
```

`/ready` harus `200` dengan `checks.database.ok` dan `checks.redis.ok`.

## 7. Update rilis

```bash
cd /home/ubuntu/sahabat-kreator
git pull --ff-only
cd deploy
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm \
  --entrypoint sh migrate -lc "cd /app && pnpm --filter @sahabat-kreator/db db:migrate"
docker compose -f docker-compose.prod.yml up -d
```

`up -d` hanya membuat ulang container yang image-nya berubah.

## 8. Rollback

```bash
git log --oneline -5
git checkout <commit-sebelumnya>
docker compose -f docker-compose.prod.yml build && \
docker compose -f docker-compose.prod.yml up -d
```

Migrasi **tidak** otomatis mundur. Bila rilis berisi migrasi destruktif,
pulihkan dari dump (lihat PRODUCTION.md §6).

## 9. Catatan desain deploy

- **Satu image untuk api/worker/realtime.** Ketiganya berbagi seluruh
  paket workspace dan harus selalu ber-versi sama; memisahkan image
  membuat worker bisa tertinggal satu rilis tanpa terlihat.
- **`pg` tidak dibundel** (lihat `apps/api/tsup.config.ts`). Karena itu
  `node_modules` ikut ke image runtime — jangan "optimasi" dengan
  `--prod` tanpa memindahkan `pg` ke dependency runtime yang eksplisit.
- **Container berjalan sebagai `node` (non-root).** Image ini memegang
  kunci dekripsi kredensial tenant.
