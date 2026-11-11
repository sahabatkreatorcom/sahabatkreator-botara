/**
 * Run-once lifecycle token Pinterest (gelombang Semua OAuth):
 * menjalankan SATU putaran `runPinterestTokenLifecycle` — pindai
 * akun Pinterest aktif yang access token-nya (±30 hari)
 * mendekati/melewati kedaluwarsa, refresh via grant `refresh_token`
 * API v5, tandai "expiring"/"expired"/akun 'error'. Jalur berkala
 * yang sama juga jalan sendiri di worker (boot + tiap 6 jam).
 *
 * Jalankan dari server (env dari .env produksi):
 *   pnpm --filter @sahabat-kreator/worker pinterest:token-lifecycle
 */
import { loadEnv } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import type { PlatformSettingsOptions } from "@sahabat-kreator/core";
import { runPinterestTokenLifecycle } from "../src/pinterest-token-lifecycle";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[pinterest:token-lifecycle] DATABASE_URL wajib diisi");
}
const platform: PlatformSettingsOptions = {
  masterSecret: env.PLATFORM_SETTINGS_SECRET,
  env: {
    pinterest_app_id: env.PINTEREST_APP_ID,
    pinterest_app_secret: env.PINTEREST_APP_SECRET,
  },
};
const { db, pool } = createDb(env.DATABASE_URL, {
  applicationName: "sk-worker-pinterest-lifecycle",
});
try {
  const result = await runPinterestTokenLifecycle({
    db,
    platform,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    pinterestApiBase: env.PINTEREST_API_BASE,
  });
  console.log(
    `[pinterest:token-lifecycle] terpindai ${result.scanned} — refresh=${result.refreshed} warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
