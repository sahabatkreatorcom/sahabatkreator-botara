# Modul `knowledge`

Knowledge base agent: dokumen teks milik tenant yang di-chunk (±800
karakter) untuk retrieval full-text Postgres (Fase 3A).

Status: **live sejak Fase 3A** — route di `routes.ts`:
- `POST/GET /tenants/:tenantId/kb/documents`
- `GET/DELETE /tenants/:tenantId/kb/documents/:id`

Service domainnya di `@sahabat-kreator/core` (`kb.ts`: chunking + CRUD +
`searchKbChunks`). Sumber PDF/link/produk dan retrieval semantik
(embedding pgvector; kolom sudah disiapkan) menyusul di fase berikutnya.
