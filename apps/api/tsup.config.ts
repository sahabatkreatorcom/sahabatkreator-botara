import { defineConfig } from "tsup";

// Bundle self-contained: paket workspace (@sahabat-kreator/*) ikut dibundel
// karena entrypoint mereka menunjuk ke sumber TypeScript.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  noExternal: [/^@sahabat-kreator\//],
  // pg WAJIB eksternal (Fase 13G): bila ikut ter-bundel, bundle memuat
  // salinan kelas Pool SENDIRI sementara drizzle-orm (eksternal)
  // memuat pg asli dari node_modules — `instanceof Pool` di sesi
  // drizzle gagal, transaksi tidak lagi ter-pin ke satu koneksi,
  // set_config tenant menyebar antar-koneksi pool (RLS acak +
  // savepoint 25P01). Satu-satunya salinan pg yang boleh ada adalah
  // yang di-resolve runtime dari node_modules.
  external: ["pg"],
  // Transitive CJS (mis. `node-abort-controller` lewat BullMQ dari
  // @sahabat-kreator/queue) memanggil `require("events")`. Dalam output
  // ESM, `require` tidak ada sehingga boot gagal dengan "Dynamic require
  // of \"events\" is not supported". Banner ini menyediakan `require`
  // nyata (createRequire) agar paket CJS hasil bundel tetap berjalan;
  // tanpa itu smoke artefak build tidak pernah bisa boot.
  banner: {
    js: "import { createRequire as __skCreateRequire } from 'node:module'; const require = __skCreateRequire(import.meta.url);",
  },
});
