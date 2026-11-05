// @sahabat-kreator/embed — widget webchat untuk situs tenant.
// Implementasi widget ada di `src/widget.ts` (vanilla TS, tanpa framework),
// dibundel tsup menjadi satu file IIFE `dist/widget.js`, lalu
// `scripts/publish.mjs` menyalinnya ke apps/web/public/widget.js agar
// tersaji di https://<domain>/widget.js. File ini sengaja kosong: paket
// ini tidak mengekspor API untuk dikonsumsi paket lain.
export {};
