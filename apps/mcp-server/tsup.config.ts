import { defineConfig } from "tsup";

// Bundle self-contained: paket workspace (@sahabat-kreator/*) ikut dibundel
// karena entrypoint mereka menunjuk ke sumber TypeScript. Dependensi npm
// sungguhan (@modelcontextprotocol/sdk, zod) tetap eksternal dan di-resolve
// dari node_modules saat runtime — server dijalankan dari dalam repo.
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
});
