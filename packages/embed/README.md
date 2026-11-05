# @sahabat-kreator/embed

Widget webchat untuk situs tenant — **hidup sejak Fase 1F**.

- Sumber: `src/widget.ts` — vanilla TypeScript, TANPA framework, satu file.
- Build: `pnpm --filter @sahabat-kreator/embed build` → tsup membundelnya
  menjadi satu file IIFE `dist/widget.js`, lalu `scripts/publish.mjs`
  menyalinnya ke `apps/web/public/widget.js` sehingga Vite menyajikannya
  di `https://<domain>/widget.js`.
- Cara pasang di situs tenant:
  `<script src="https://botara.my.id/widget.js" data-site-key="wc_..."></script>`
  Opsi: `data-lang="id"` (default `en`), `data-title="..."`,
  `data-api-base="..."` (default: origin file widget).
- Perilaku: tombol chat + panel mengikuti `prefers-color-scheme`
  pengunjung; sesi dibuka ke `POST /api/webchat/:siteKey/session`; token +
  visitorId persisten di localStorage situs asal; balasan masuk realtime
  lewat WebSocket `/api/webchat/ws` dengan polling REST sebagai cadangan.
