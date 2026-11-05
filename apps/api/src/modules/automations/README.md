# Modul `automations`

Manajemen automation workspace (Fase 2A — nyata untuk trigger keyword):

- `POST /tenants/:tenantId/automations` — buat automation keyword (`{name, keywords[], match: exact|contains, text}`) → 201. Balasan mendukung placeholder `{name}`.
- `GET /tenants/:tenantId/automations` — daftar automation + `runCount`.
- `PATCH /tenants/:tenantId/automations/:id` — ubah `isActive`/`name`/`keywords`/`match`/`text`.
- `GET /tenants/:tenantId/automations/:id/runs` — riwayat eksekusi terbaru.

Semua route wajib sesi + membership (non-member → 404 `TENANT_NOT_FOUND`). Logika domain di `@sahabat-kreator/core` (`automations.ts`); eksekusi automation berjalan di worker lewat job `automation.evaluate` — API hanya mengelola definisinya. Trigger comment-to-DM & sequence menyusul di fase berikutnya.
