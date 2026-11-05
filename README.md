# Sahabat Kreator

Platform customer engagement multi-tenant: inbox omnichannel, otomasi, agen AI, dan commerce ringan untuk UMKM Indonesia.

Kanal yang didukung: **WhatsApp, Instagram, Messenger, Telegram, dan webchat** (widget milik sendiri).
Selain itu tersedia API publik `/v1`, SDK, CLI `sk`, dan MCP server untuk dipakai agen AI eksternal.

## Isi repo

```
apps/
  api/         HTTP API (Hono) — adapter tipis di atas core
  worker/      Proses latar (BullMQ + poller): outbox relay, automation, agent,
               flow, broadcast, PENGIRIMAN pesan kanal (Telegram/Meta)
  realtime/    Gateway WebSocket dashboard + widget webchat
  web/         Dashboard React + Vite (termasuk panel admin platform)
  cli/         CLI `sk` di atas SDK
  mcp-server/  MCP server (tools diturunkan dari contracts)
packages/
  core/        SELURUH logika bisnis (transport-agnostic); mesin flow di core/flows/
  db/          Skema Drizzle + migrasi + RLS
  contracts/   Skema zod — sumber kebenaran tunggal API/SDK/MCP
  ai/          Provider LLM & embedding (mock | OpenRouter)
  queue/       BullMQ + Redis pub/sub + jobId deterministik
  channels/    Adapter per kanal (messenger, whatsapp, telegram, webchat, core)
  config/      Env tervalidasi + logger
  i18n/        id + en
  embed/       Bundel widget webchat
  sdk/         SDK TypeScript untuk API publik
deploy/        Docker compose produksi + nginx
docs/          Arsitektur, matriks cakupan, operasional
```

## Menjalankan lokal

```bash
# 1. Infrastruktur
docker compose up -d          # Postgres (pgvector) + Redis

# 2. Dependensi
pnpm install

# 3. Konfigurasi
cp .env.example .env          # isi secret (lihat komentar di dalamnya)

# 4. Skema database
pnpm --filter @sahabat-kreator/db db:migrate

# 5. Jalankan
pnpm dev                      # api :3101 + web :5173
pnpm dev:worker               # terminal lain
pnpm dev:realtime             # terminal lain
```

Web membuka `http://localhost:5173`; proxy Vite meneruskan `/api` ke `:3101`.

## Perintah penting

| Perintah | Kegunaan |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` di seluruh 20 paket |
| `pnpm lint` | ESLint (0 error; warning = utang terukur) |
| `pnpm test` | Vitest — tanpa layanan eksternal |
| `pnpm --filter @sahabat-kreator/db verify` | Bukti migrasi + isolasi RLS di PGlite |
| `pnpm check:drift` | Pastikan SDK tidak menyimpang dari contracts |
| `pnpm verify:ci` | Rangkaian lengkap yang dijalankan CI |

## Prinsip yang mengikat

1. **API tidak berisi logika bisnis.** Route hanya memvalidasi, memanggil `core`, dan menyusun respons.
2. **Kontrak tunggal.** Semua bentuk request/response adalah skema zod di `packages/contracts`; SDK dan MCP menurunkannya, bukan menyalinnya.
3. **Isolasi tenant di database.** Setiap tabel ber-`tenant_id` dilindungi RLS; konteks kosong = nol baris. Lihat `packages/db/migrations/0001_rls_tenant_isolation.sql`.
4. **Idempotensi lewat jobId deterministik.** Relay outbox boleh berjalan berkali-kali tanpa menggandakan efek.
5. **Rahasia tidak pernah di log.** Token kanal dienkripsi AES-256-GCM; log hanya memuat kode error aman.

Detail: [docs/RANCANGAN-v3.md](docs/RANCANGAN-v3.md).

## Deploy

Produksi berjalan sebagai Docker Compose di balik Cloudflare Tunnel — lihat
[docs/DEPLOY-STAGING.md](docs/DEPLOY-STAGING.md) dan [docs/PRODUCTION.md](docs/PRODUCTION.md).

## Lisensi

Proprietary — © Sahabat Kreator.
