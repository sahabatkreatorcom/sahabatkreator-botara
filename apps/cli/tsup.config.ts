import { defineConfig } from "tsup";

// Bundle self-contained: paket workspace (@sahabat-kreator/*) ikut dibundel
// karena entrypoint mereka menunjuk ke sumber TypeScript. CLI adalah
// artefak KLIEN murni (fetch bawaan Node) — tidak ada dependensi npm
// runtime selain paket workspace, jadi dist/index.js bisa jalan di mana
// saja selama ada Node >= 20.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  noExternal: [/^@sahabat-kreator\//],
  // pg WAJIB eksternal di semua bundle (aturan Fase 13G) — CLI tidak
  // memuat pg sama sekali, tetapi deklarasi ini menjaga bundle tetap
  // bersih bila suatu hari ada impor transitif yang menyeretnya.
  external: ["pg"],
});
