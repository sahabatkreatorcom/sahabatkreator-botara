import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Arahkan direktori temp ke dalam repo SEBELUM worker test lahir.
 *
 * Sebagian lingkungan (sandbox IDE, container dengan /tmp read-only)
 * melarang tulis ke direktori temp sistem; Vitest menulis cache transform
 * SSR ke sana dan gagal dengan EPERM meskipun seluruh test lulus. Karena
 * worker mewarisi env proses ini, satu baris di sini cukup.
 */
const tmpDir = path.join(process.cwd(), "node_modules", ".tmp");
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
