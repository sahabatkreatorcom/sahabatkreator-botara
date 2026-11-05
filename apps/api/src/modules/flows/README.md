# Modul `flows`

Flow Engine (Fase 8A — backend): CRUD definisi flow berbentuk graf,
aktivasi dengan validasi graf menyeluruh, serta pembacaan run dan
log per langkah. Implementasi di `routes.ts`; logika domain di
`@sahabat-kreator/core` (`flows.ts`); eksekusi oleh worker (job
BullMQ `flow.step` dari event outbox `flow.step_due`). Builder UI
(Fase 8B) sudah hidup di apps/web (`/flows` + `/flows/:flowId`,
@xyflow/react) — format graf di `@sahabat-kreator/contracts`
(`FlowGraph`) adalah kontrak bersama keduanya, termasuk field
`position` opsional per node yang hanya dipakai builder dan
diabaikan eksekutor.

Keputusan v1:
- Format graf: `{nodes: [{id, type, config}], edges: [{from, to,
  branch?}]}`; tepat satu node `trigger`; `branch` hanya dari node
  `condition` (wajib `yes` + `no`).
- Validasi semantik penuh HANYA saat aktivasi (draft boleh belum
  sah): error → `422 FLOW_GRAPH_INVALID` + `details.issues`;
  warning (node tak terjangkau) tidak memblokir.
- Edit hanya saat `draft` — graf flow aktif tidak berubah di bawah
  run yang hidup. Nonaktifkan mengembalikan ke draft.
- Akses: mutasi owner/admin; baca semua member workspace.
- Eksekusi: urutan evaluasi pesan masuk keyword → flow → agent;
  balasan kontak TIDAK membatalkan run flow (berbeda dengan
  sequence), opt-out membatalkan run `waiting`; cap 100 langkah/run.

Fase 13D — eksperimen A/B: node `ab_split` dengan config
`experiment: true` menugaskan cabang secara deterministik (hash
stabil flow+node+kontak) dan lengket (baris pertama di
`flow_experiment_assignments` menang selamanya); tanpa flag itu
perilaku tetap acak per run (12A). `conversionNodeId` menamai titik
konversi. Hasil per split: `GET /tenants/:tenantId/flows/:id/experiments`
(dashboard saja — penugasan unik, run, selesai, konversi, putusan
uji z dua-proporsi dengan pagar sampel minimum di core
`experiments.ts`). Nyala/mati mode eksperimen diaudit
(`flow.experiment_enabled` / `flow.experiment_disabled`).
