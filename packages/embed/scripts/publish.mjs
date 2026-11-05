// Menyalin hasil build widget ke apps/web/public/widget.js agar Vite
// menyalinnya ke dist web dan tersaji publik di https://<domain>/widget.js
// (lihat README paket ini & docs/DEPLOY-STAGING.md Fase 1F).
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "dist", "widget.js");
const destDir = path.join(here, "..", "..", "..", "apps", "web", "public");
mkdirSync(destDir, { recursive: true });
copyFileSync(src, path.join(destDir, "widget.js"));
console.log(`[embed] widget.js tersalin ke ${path.join(destDir, "widget.js")}`);
