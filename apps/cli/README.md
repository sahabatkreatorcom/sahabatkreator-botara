# @sahabat-kreator/cli — `sk`

CLI publik Sahabat Kreator (Fase 14D). Adapter **tipis** di atas
[@sahabat-kreator/sdk](../../packages/sdk): setiap perintah memanggil
tepat satu metode client publik ke API v1 — tidak ada klien HTTP kedua
di sini. Pemetaan perintah ↔ rute v1 ↔ metode SDK ↔ tool MCP dicatat
di registry `PUBLIC_V1_SURFACE`
([@sahabat-kreator/contracts](../../packages/contracts)) dan dijaga
`pnpm check:drift` — sejak fase ini penjaga itu mencakup **empat**
permukaan (kontrak, SDK, MCP, CLI).

Perintah internal lama yang disebut README placeholder Fase 0 (seed,
migrasi, test webhook) **tidak** menjadi bagian CLI ini: seed/migrasi
tetap urusan paket db & skrip repo, dan CLI ini murni permukaan
publik berkunci API key tenant.

## Instalasi (dari monorepo)

```bash
pnpm install
pnpm --filter @sahabat-kreator/cli build   # menghasilkan dist/index.js
# binary: apps/cli/bin/sk.js  (package.json "bin": { "sk": ... })
./apps/cli/bin/sk.js --help
# atau: pnpm --filter @sahabat-kreator/cli start -- <perintah>
```

Syarat runtime: Node ≥ 20 (atau Bun). Bundle bersifat self-contained
(paket workspace ikut dibundel oleh tsup); tidak ada dependensi npm
runtime selain Node itu sendiri.

## Konfigurasi

API key **tidak pernah** diterima lewat flag (bocor ke riwayat shell
dan daftar proses) dan tidak pernah dicetak utuh.

| Hal | Sumber (urutan menang) |
|---|---|
| API key | env `SK_API_KEY` → berkas konfigurasi |
| Base URL | flag `--base-url` → env `SK_BASE_URL` → berkas konfigurasi → bawaan `https://botara.my.id` |

Berkas konfigurasi: `$XDG_CONFIG_HOME/sahabat-kreator/config.json`
atau `~/.config/sahabat-kreator/config.json`:

```json
{ "baseUrl": "https://botara.my.id", "apiKey": "sk_live_..." }
```

Kunci dibuat di dashboard: **Settings → API Keys**. Scope kunci
membatasi perintah — mis. kunci tanpa `messages:write` ditolak
`messages send` dengan `403 API_KEY_SCOPE_DENIED`.

`sk whoami` adalah perintah cek konfigurasi: menampilkan base URL,
sidik jari kunci tersamar (`sk_live_…` + 4 karakter terakhir), tenant
pemilik kunci, dan scope kunci (dari `GET /v1/me`).

## Keluaran & kode keluar

- Bawaan: terbaca manusia — daftar menjadi tabel ringkas, objek
  tunggal menjadi baris `kunci: nilai`. Bentuk tabel adalah
  kenyamanan baca, **bukan** kontrak.
- `--json` (di semua perintah): respons API mentah sebagai JSON —
  satu-satunya format yang dijanjikan stabil untuk skrip.
- Error API ditampilkan sebagai kode kontrak + pesan, mis.
  `Error: API_KEY_SCOPE_DENIED (HTTP 403) — …`; dengan `--json`
  error menjadi objek JSON di stderr.
- Kode keluar: `0` sukses · `1` error API/jaringan · `2` kesalahan
  pemakaian/konfigurasi.

## Indeks perintah (34 — satu per rute publik v1)

| Perintah | Metode SDK | Scope |
|---|---|---|
| `sk whoami` | `me` | kunci sah apa pun |
| `sk contacts list` | `listContacts` | `contacts:read` |
| `sk contacts create` | `createContact` | `contacts:write` |
| `sk contacts update <id>` | `updateContact` | `contacts:write` |
| `sk conversations list` | `listConversations` | `conversations:read` |
| `sk messages list <conversationId>` | `listMessages` | `conversations:read` |
| `sk messages send <conversationId> --text <pesan>` | `sendMessage` | `messages:write` |
| `sk products list` | `listProducts` | `products:read` |
| `sk comments list` | `listComments` | `comments:read` |
| `sk comments hide <id>` | `hideComment` | `comments:write` |
| `sk comments unhide <id>` | `unhideComment` | `comments:write` |
| `sk broadcasts list` / `sk broadcasts get <id>` | `listBroadcasts` / `getBroadcast` | `broadcasts:read` |
| `sk flows list` / `sk flows get <id>` | `listFlows` / `getFlow` | `flows:read` |
| `sk flow-templates list` | `listFlowTemplates` | `flows:read` |
| `sk automations list` / `sk automations get <id>` | `listAutomations` / `getAutomation` | `automations:read` |
| `sk agents list` / `sk agents get <id>` | `listAgents` / `getAgent` | `agents:read` |
| `sk channels list` / `sk channels get <id>` | `listChannels` / `getChannel` | `channels:read` |
| `sk whatsapp-templates list --channel-account-id <id>` | `listWhatsAppTemplates` | `whatsapp_templates:read` |
| `sk kb list` / `sk kb get <id>` / `sk kb stats` | `listKnowledgeDocuments` / `getKnowledgeDocument` / `getKnowledgeStats` | `knowledge:read` |
| `sk growth-links list` / `sk growth-links get <id>` | `listGrowthLinks` / `getGrowthLink` | `growth_links:read` |
| `sk segments list` / `sk segments get <id>` | `listSegments` / `getSegment` | `segments:read` |
| `sk orders list` / `sk orders get <id>` | `listOrders` / `getOrder` | `orders:read` |
| `sk appointments list` | `listAppointments` | `appointments:read` |
| `sk appointments services` | `listAppointmentServices` | `appointments:read` |

Tulis publik memang hanya lima rute dan **tidak satu pun destruktif**
(API v1 tidak punya DELETE) — karena itu tidak ada gerbang `--yes`:
tidak ada yang bisa dihapus lewat permukaan ini. Yang SENGAJA tidak
dibuat mengikuti keputusan docs/COVERAGE-MATRIX.md: `sk broadcasts
send` (pengiriman massal tetap dashboard-only) serta kandidat tanpa
rute v1 (`contacts get`, `flows runs`, `automations runs`,
`kb files`, `usage report`).

Paginasi mengikuti API-nya: kontak memakai `--limit`/`--offset`;
broadcast & flow memakai `--cursor`/`--limit`; sisanya daftar penuh
atau `--limit` sesuai kontrak.

## Contoh

```bash
export SK_API_KEY=sk_live_...            # dari dashboard Settings → API Keys
sk whoami
sk contacts list --search budi --limit 10
sk contacts create --name "Budi" --tag webinar --field kota=Bandung
sk contacts update <id> --field kota=Jakarta   # gabung per kunci
sk messages send <conversationId> --text "Halo! Ada yang bisa dibantu?"
sk appointments list --from 2026-11-04T00:00:00Z --status confirmed

# scripting: --json di mana-mana
sk orders list --json | jq '.orders[] | select(.status == "paid")'
sk segments get <id> --json | jq '.definition'
```

## Verifikasi

```bash
pnpm check:drift                                   # statis, tanpa server
SK_API_KEY=... SK_BASE_URL=http://127.0.0.1:3214 \
  pnpm --filter @sahabat-kreator/cli verify:cli    # binary hasil build vs API hidup
```

`verify:cli` mengikuti pola `verify-sdk`/`verify-mcp`: ia menjalankan
binary hasil build sebagai proses anak terhadap tenant uji (di
rantai fase: tenant buangan di instance API chain, tidak pernah
tenant live user) dan melaporkan hitungan PASS.
