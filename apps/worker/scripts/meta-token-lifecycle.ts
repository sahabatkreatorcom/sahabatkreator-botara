/**
 * Run-once lifecycle token Meta (lifecycle 0010): menjalankan SATU putaran
 * `runMetaTokenLifecycle` — pindai akun Meta aktif yang tokennya
 * mendekati/melewati kedaluwarsa, refresh `tbft` untuk varian
 * refreshable, tandai "expiring"/"expired"/akun 'error'. Jalur berkala
 * yang sama juga jalan sendiri di worker (boot + tiap 6 jam), jadi skrip
 * ini tidak wajib untuk operasi normal.
 *
 * Jalankan dari server staging (env dari .env.staging):
 *   set -a; . ./.env.staging; set +a
 *   pnpm --filter @sahabat-kreator/worker meta:token-lifecycle
 */
import { loadEnv } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import { runMetaTokenLifecycle } from "../src/meta-token-lifecycle";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[meta:token-lifecycle] DATABASE_URL wajib diisi");
}
const { db, pool } = createDb(env.DATABASE_URL);
try {
  const result = await runMetaTokenLifecycle({
    db,
    platform: {
      masterSecret: env.PLATFORM_SETTINGS_SECRET,
      env: {
        meta_app_id: env.META_APP_ID,
        meta_app_secret: env.META_APP_SECRET,
      },
    },
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    metaApiBase: env.META_API_BASE,
  });
  console.log(
    `[meta:token-lifecycle] terpindai ${result.scanned} — refresh=${result.refreshed} warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
