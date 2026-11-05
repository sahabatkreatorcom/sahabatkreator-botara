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
cat > .env <<EOF
NODE_ENV=production
API_PORT=3101
REALTIME_PORT=3103
LOG_LEVEL=info

DATABASE_URL=postgres://sahabat:$(openssl rand -hex 16)@db:5432/sahabat_kreator
POSTGRES_PASSWORD=<sama dengan di atas>
REDIS_URL=redis://redis:6379

BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
BETTER_AUTH_URL=https://botara.my.id
CHANNEL_TOKEN_SECRET=$(openssl rand -base64 32)
WEBCHAT_SECRET=$(openssl rand -base64 32)
PLATFORM_SETTINGS_SECRET=$(openssl rand -base64 32)
PLATFORM_ADMIN_EMAILS=

LLM_PROVIDER=mock
META_GRAPH_API_VERSION=v26.0
META_ENGAGEMENT_SCOPES=0
EOF
```

Catat `POSTGRES_PASSWORD` — harus sama dengan yang dipakai `DATABASE_URL`.

## 4. Build dan jalankan

```bash
cd /home/ubuntu/sahabat-kreator/deploy
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d db redis
```

Migrasi dijalankan sekali, bukan oleh replika API:

```bash
docker compose -f docker-compose.prod.yml run --rm \
  --entrypoint sh migrate -lc "cd /app && pnpm --filter @sahabat-kreator/db db:migrate"
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
