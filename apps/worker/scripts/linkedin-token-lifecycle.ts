/**
 * Run-once lifecycle token LinkedIn (gelombang Semua OAuth):
 * menjalankan SATU putaran `runLinkedInTokenLifecycle` — pindai akun
 * LinkedIn aktif yang tokennya (±60 hari, TANPA refresh token dari
 * platform) mendekati/melewati kedaluwarsa: tandai "expiring", dan
 * yang sudah lewat jadwal dipindahkan ke 'error'
 * linkedin_token_expired agar dihubungkan ulang. Jalur berkala yang
 * sama juga jalan sendiri di worker (boot + tiap 6 jam).
 *
 * Jalankan dari server (env dari .env produksi):
 *   pnpm --filter @sahabat-kreator/worker linkedin:token-lifecycle
 */
import { loadEnv } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import { runLinkedInTokenLifecycle } from "../src/linkedin-token-lifecycle";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[linkedin:token-lifecycle] DATABASE_URL wajib diisi");
}
const { db, pool } = createDb(env.DATABASE_URL, {
  applicationName: "sk-worker-linkedin-lifecycle",
});
try {
  const result = await runLinkedInTokenLifecycle({ db });
  console.log(
    `[linkedin:token-lifecycle] terpindai ${result.scanned} — warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
