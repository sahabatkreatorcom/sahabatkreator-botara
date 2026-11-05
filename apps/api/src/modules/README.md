# Modul API (vertical slice)

Satu folder = satu domain. Tiap modul berisi `routes.ts` (Hono), `service.ts`
(memanggil `packages/core`), `schema.ts` (dari `packages/contracts`), `repo.ts`.
Logika bisnis TIDAK di sini — API hanyalah adapter tipis di atas core
(RANCANGAN §2 aturan 1). Lihat README di tiap folder modul untuk cakupannya.
