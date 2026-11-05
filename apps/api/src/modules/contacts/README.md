# Modul `contacts`

CRUD kontak audiens per workspace. **Fase 1D terimplementasi** (`routes.ts`):

- `POST /tenants/:tenantId/contacts` — buat kontak {name, phone?, email?, tags?} → 201
- `GET /tenants/:tenantId/contacts?search=&limit=&offset=` — daftar + total
- `GET /tenants/:tenantId/contacts/:id` — detail; bukan milik tenant → 404
- `PATCH /tenants/:tenantId/contacts/:id` — name, tags, pipeline_stage, opt_in_status

Wajib sesi + membership workspace (non-member → 404 `TENANT_NOT_FOUND`).
Logika domain di `@sahabat-kreator/core` (`contacts.ts`), validasi Zod dari
`@sahabat-kreator/contracts`. Custom fields & segmentasi lanjutan menyusul.
