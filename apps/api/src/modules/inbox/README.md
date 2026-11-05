# Modul `inbox`

Percakapan & pesan per workspace. **Fase 1D terimplementasi** (`routes.ts`):

- `GET /tenants/:tenantId/conversations?status=` — daftar percakapan dengan
  nama kontak + cuplikan pesan terakhir
- `GET /tenants/:tenantId/conversations/:id/messages?limit=` — pesan kronologis
- `POST /tenants/:tenantId/conversations/:id/messages` {contentText} — balasan
  manual: membuat pesan outbound `sender_type=user` berstatus `queued` +
  audit `message.queued`. **Stub pengiriman** — belum dikirim ke channel
  mana pun; pengiriman sungguhan menunggu adapter channel (fase berikutnya).

Wajib sesi + membership workspace (non-member → 404 `TENANT_NOT_FOUND`).
Logika domain di `@sahabat-kreator/core` (`conversations.ts`).
Assignment, realtime (SSE/WS), dan ambil-alih manusia menyusul.
