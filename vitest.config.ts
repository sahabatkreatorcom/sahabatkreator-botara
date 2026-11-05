import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Arahkan direktori temp ke dalam repo SEBELUM worker test lahir.
 *
 * Dua lingkungan bermasalah yang pernah terbukti, keduanya berakhir
 * dengan `EPERM` pada tulis cache transform SSR Vitest — test-nya sendiri
 * lulus, tetapi run dilaporkan gagal karena "unhandled error":
 *   1. direktori temp sistem (%TEMP% / /tmp) read-only atau diblokir
 *      sandbox;
 *   2. `node_modules/` — beberapa sandbox hanya mengizinkan tulis di
 *      root workspace, sehingga `node_modules/.tmp` pun ditolak.
 *
 * Karena itu targetnya root repo (`.tmp-vitest/`, di-gitignore), bukan
 * `node_modules`. Worker mewarisi env proses ini, jadi satu set variabel
 * di sini cukup — tidak perlu flag per-test.
 */
const tmpDir = path.join(process.cwd(), ".tmp-vitest");
mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir;
process.env.TMP = tmpDir;
process.env.TEMP = tmpDir;

/**
 * Test runner monorepo Sahabat Kreator.
 *
 * Prinsip: test harus bisa jalan TANPA layanan eksternal. Itu sebabnya
 * Postgres diganti PGlite (Postgres asli dalam WASM) dan provider HTTP
 * (Meta/Telegram/Midtrans/Xendit) selalu dipalsukan lewat base URL atau
 * fungsi murni. Test yang butuh jaringan tidak boleh masuk `pnpm test`.
 *
 * `verify:*` di tiap paket tetap dipertahankan: itu bukti integrasi
 * end-to-end yang lebih berat (rantai HTTP Hono, rantai migrasi penuh).
 * Vitest mengisi celah yang tidak tercakup verify: unit murni + regresi
 * cepat yang harus jalan di setiap commit.
 */
export default defineConfig({
  // Cache di dalam repo, bukan di %TEMP%: sebagian lingkungan (sandbox,
  // container read-only) melarang tulis ke direktori temp sistem.
  cacheDir: "./node_modules/.vitest",
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/channels/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    /**
     * Batas pekerja, bukan sekadar timeout besar.
     *
     * Setiap suite yang menyentuh database menjalankan PGlite (Postgres
     * dalam WASM) dan memutar ULANG seluruh rantai migrasi — 59 tabel,
     * 215 index, 76 policy. Itu kerja CPU yang berat dan tidak paralel
     * di dalam satu instance.
     *
     * Terukur: `packages/db/src/rls.test.ts` selesai 3,2 detik saat
     * dijalankan sendiri, tetapi melewati 30 detik ketika sembilan
     * instance PGlite berjalan bersamaan di mesin 8 core. Timeout yang
     * dinaikkan saja akan menyembunyikan masalah itu di mesin ini dan
     * tetap gagal di runner CI 2 core.
     *
     * Membatasi dua pekerja membuat waktu per suite tetap dekat dengan
     * angka "sendirian", dengan total wall time yang masih wajar.
     */
    maxWorkers: 2,
    minWorkers: 1,
    // PGlite memuat Postgres WASM + menjalankan seluruh rantai migrasi;
    // 30 detik memberi ruang di mesin CI yang lambat.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["packages/*/src/**/*.ts", "packages/channels/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
