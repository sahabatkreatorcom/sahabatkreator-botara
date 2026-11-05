# @sahabat-kreator/mcp-server

MCP server Sahabat Kreator (Fase 5B) — **transport stdio**, dibangun di atas
`@sahabat-kreator/sdk` dan memanggil API publik v1 yang sama dengan
integrasi lain (RANCANGAN §2: MCP adalah adapter tipis). Server tidak
mengakses database; satu-satunya kredensial yang dipegangnya adalah API
key tenant dari env.

> 🔒 **DEFAULT SERVER INI READ-ONLY (tiering keamanan, Fase 9B).**
> Tool tulis (`create_contact`, `send_message`) tetap terdaftar agar
> dapat ditemukan klien, tetapi **menolak setiap panggilan** dengan error
> yang jelas sampai server dijalankan dengan env `MCP_ALLOW_WRITES=1`.
> Tool baca selalu jalan. Tier ini adalah lapisan opt-in lokal yang
> independen dari scope API key: tulis hanya berhasil bila **keduanya**
> mengizinkan (env `MCP_ALLOW_WRITES=1` DAN scope kunci mencukupi).

## Tools

| Tool | Tier | Scope kunci | Keterangan |
| --- | --- | --- | --- |
| `whoami` | baca | — | Tenant pemilik kunci + scope kunci |
| `list_contacts` | baca | `contacts:read` | Daftar/cari kontak (`search`, `limit`, `offset`) |
| `create_contact` | **tulis** | `contacts:write` | Buat kontak (`name`, `phone?`, `email?`) — perlu `MCP_ALLOW_WRITES=1` |
| `list_conversations` | baca | `conversations:read` | Daftar percakapan workspace |
| `list_messages` | baca | `conversations:read` | Riwayat pesan (`conversationId`, `limit?`) |
| `send_message` | **tulis** | `messages:write` | Kirim pesan keluar (`conversationId`, `text`) — perlu `MCP_ALLOW_WRITES=1` |
| `list_products` | baca | `products:read` | Daftar produk + harga |

Tier juga terlihat oleh klien MCP lewat annotation `readOnlyHint`
(`true` untuk tool baca, `false` untuk tool tulis) dan catatan
`[TIER TULIS …]` pada deskripsi tool tulis.

Error API (kunci tidak valid, scope kurang, data tidak ditemukan)
dikembalikan sebagai **tool error MCP** yang memuat kode kontrak —
server tidak crash.

## Konfigurasi

| Env | Wajib | Keterangan |
| --- | --- | --- |
| `SAHABAT_KREATOR_API_KEY` | ya | API key `sk_live_...` dari dashboard Settings → API Keys |
| `SAHABAT_KREATOR_BASE_URL` | tidak | Origin API; default `https://botara.my.id` |
| `MCP_ALLOW_WRITES` | tidak | `1` = izinkan tool tulis. **Tanpa env ini (atau nilai selain `1`) server READ-ONLY.** |

> ⚠️ **Kunci hanya boleh datang dari env.** Jangan menulis kunci utuh ke
> file konfigurasi yang ter-commit, jangan membagikannya di chat/log.
> Buat kunci khusus MCP dengan scope seminimal yang dibutuhkan (mis.
> tanpa `messages:write` bila hanya perlu membaca).

## Build & jalankan

```bash
pnpm --filter @sahabat-kreator/mcp-server build   # menghasilkan dist/index.js
# Read-only (default) — cukup untuk whoami/list_*:
SAHABAT_KREATOR_API_KEY=sk_live_... node apps/mcp-server/dist/index.js
# Dengan tool tulis aktif (opt-in eksplisit):
SAHABAT_KREATOR_API_KEY=sk_live_... MCP_ALLOW_WRITES=1 node apps/mcp-server/dist/index.js
```

Baris log startup (stderr) selalu menyatakan tier aktif server.

## Contoh konfigurasi klien MCP

Claude Desktop (`claude_desktop_config.json`) dan Cursor
(`.cursor/mcp.json`) memakai format yang sama:

```json
{
  "mcpServers": {
    "sahabat-kreator": {
      "command": "node",
      "args": ["/path/ke/sahabatkreator/apps/mcp-server/dist/index.js"],
      "env": {
        "SAHABAT_KREATOR_API_KEY": "sk_live_...",
        "SAHABAT_KREATOR_BASE_URL": "https://botara.my.id"
      }
    }
  }
}
```

## Verifikasi end-to-end

```bash
pnpm --filter @sahabat-kreator/mcp-server build
SAHABAT_KREATOR_API_KEY=sk_live_... \
SAHABAT_KREATOR_API_KEY_LIMITED=sk_live_... \
  pnpm --filter @sahabat-kreator/mcp-server verify:mcp
```

`verify:mcp` memulai server hasil build sebagai proses anak (stdio) dan
mengujinya dengan klien MCP resmi terhadap API live dalam tiga sesi:
(A) default tanpa `MCP_ALLOW_WRITES` — baca jalan, tulis ditolak di
lapisan MCP; (B) `MCP_ALLOW_WRITES=1` — tulis berhasil; (C) kunci
terbatas dengan `MCP_ALLOW_WRITES=1` — tulis ditolak API oleh scope
(`API_KEY_SCOPE_DENIED`). Lihat header `scripts/verify-mcp.ts` untuk
semua env yang didukung.

## Batas v1

Transport hanya **stdio** (standar untuk klien MCP lokal seperti Claude
Desktop/Cursor). Transport HTTP (Streamable HTTP) menyusul bila ada
kebutuhan klien jarak jauh — arsitektur adapter membuat penambahannya
tidak menyentuh tool maupun SDK.
