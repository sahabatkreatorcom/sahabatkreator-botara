# Modul `agents`

Manajemen AI agent per tenant + antrean draf balasan mode 'suggest' (Fase 3A).

Status: **live sejak Fase 3A** — route di `routes.ts`:
- `POST/GET /tenants/:tenantId/agents`, `PATCH .../agents/:id`
- `GET /tenants/:tenantId/suggestions?status=`,
  `POST .../suggestions/:id/approve`, `POST .../suggestions/:id/reject`
- `POST .../agents/:id/playground` (Fase 12E) — uji kering SATU agent:
  provider di-resolve per request (Panel → env, resolver yang sama
  seperti worker) lalu core `runAgentPlayground` menjalankan jalur
  draft yang sama seperti runtime; tool tidak dieksekusi (dikembalikan
  sebagai niat), tidak ada data percakapan ditulis, usage tercatat
  sebagai refType `agent_playground`. Provider gagal/salah konfigurasi
  → 502 `AGENT_PROVIDER_ERROR`.

Service domainnya di `@sahabat-kreator/core` (`agents.ts`, `suggestions.ts`);
runtime agent (loop, retrieval, tools, metering) berjalan di worker lewat
job `agent.respond` — lihat `packages/core/src/agent-runtime.ts` dan
`@sahabat-kreator/ai` untuk provider LLM (mock default, OpenRouter via env).
