# Modul `tenants`

Workspace/tenant, member & invitation, role (owner/admin/agent/viewer). Fase 0–1.

Status: **Fase 1B terimplementasi sebagian** — `routes.ts`:
`POST /tenants` (buat workspace, pembuat jadi `owner`, slug unik otomatis,
audit `tenant.created`), `GET /tenants` (daftar workspace milik user),
`GET /tenants/:id` (detail untuk member saja; non-member → 404
`TENANT_NOT_FOUND`). Logika bisnis di `@sahabat-kreator/core`
(`src/tenants.ts`) dengan konteks RLS `app.tenant_id` / `app.user_id`.
Member management & invitation menyusul di fase berikutnya.
