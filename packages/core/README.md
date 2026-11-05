# @sahabat-kreator/core

Logika bisnis murni Sahabat Kreator (contacts, conversations, automations, campaigns, agents, billing-rules, entitlements). Transport-agnostic: tidak tahu Hono/HTTP/BullMQ/MCP/CLI.

**Status:** Fase 1A — baru fondasi konteks tenant. Service domain menyusul di fase berikutnya.

## Yang sudah ada

- `TenantContext` (`src/tenant.ts`) — tipe `{ tenantId, userId?, role? }` yang diteruskan eksplisit ke semua service/repo; tidak ada query tanpa tenantId (RANCANGAN §2–§3).
- `withTenant(db, tenantId, fn)` — menjalankan `fn` dalam satu transaksi Drizzle dan mengaktifkan konteks Row Level Security secara transaction-local di awal transaksi:

  ```sql
  SELECT set_config('app.tenant_id', '<tenant-uuid>', true)
  ```

  Policy RLS di `@sahabat-kreator/db` (migrasi `0001`) membaca setting ini; tanpa helper ini, query ke tabel tenant-scoped oleh role aplikasi akan mengembalikan nol baris (fail closed). `set_config` dipakai (bukan `SET LOCAL` biasa) karena `SET` tidak menerima parameter pada prepared statement.

## Verifikasi

```bash
pnpm --filter @sahabat-kreator/core verify   # kontrak withTenant (urutan begin -> set_config -> fn -> commit)
pnpm --filter @sahabat-kreator/db verify     # bukti RLS sungguhan di Postgres (PGlite)
```
