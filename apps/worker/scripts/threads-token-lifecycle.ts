/**
 * Run-once lifecycle token Threads (integrasi Threads): menjalankan
 * SATU putaran `runThreadsTokenLifecycle` — pindai akun Threads aktif
 * yang token berumur panjangnya mendekati/melewati kedaluwarsa,
 * refresh `th_refresh_token`, tandai "expiring"/"expired"/akun
 * 'error'. Jalur berkala yang sama juga jalan sendiri di worker
 * (boot + tiap 6 jam), jadi skrip ini tidak wajib untuk operasi
 * normal.
 *
 * Jalankan dari server (env dari .env produksi):
 *   pnpm --filter @sahabat-kreator/worker threads:token-lifecycle
 */
import { loadEnv } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import { runThreadsTokenLifecycle } from "../src/threads-token-lifecycle";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[threads:token-lifecycle] DATABASE_URL wajib diisi");
}
const { db, pool } = createDb(env.DATABASE_URL, {
  applicationName: "sk-worker-threads-token-lifecycle",
});
try {
  const result = await runThreadsTokenLifecycle({
    db,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    threadsApiBase: env.THREADS_API_BASE,
  });
  console.log(
    `[threads:token-lifecycle] terpindai ${result.scanned} — refresh=${result.refreshed} warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
