/**
 * Run-once lifecycle token TikTok (gelombang Semua OAuth):
 * menjalankan SATU putaran `runTikTokTokenLifecycle` — pindai akun
 * TikTok aktif yang access token-nya (±24 jam) mendekati/melewati
 * kedaluwarsa, refresh via grant `refresh_token` Login Kit, tandai
 * "expiring"/"expired"/akun 'error'. Jalur berkala yang sama juga
 * jalan sendiri di worker (boot + tiap 6 jam), jadi skrip ini tidak
 * wajib untuk operasi normal.
 *
 * Jalankan dari server (env dari .env produksi):
 *   pnpm --filter @sahabat-kreator/worker tiktok:token-lifecycle
 */
import { loadEnv } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import type { PlatformSettingsOptions } from "@sahabat-kreator/core";
import { runTikTokTokenLifecycle } from "../src/tiktok-token-lifecycle";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[tiktok:token-lifecycle] DATABASE_URL wajib diisi");
}
const platform: PlatformSettingsOptions = {
  masterSecret: env.PLATFORM_SETTINGS_SECRET,
  env: {
    tiktok_client_key: env.TIKTOK_CLIENT_KEY,
    tiktok_client_secret: env.TIKTOK_CLIENT_SECRET,
  },
};
const { db, pool } = createDb(env.DATABASE_URL, {
  applicationName: "sk-worker-tiktok-lifecycle",
});
try {
  const result = await runTikTokTokenLifecycle({
    db,
    platform,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    tiktokApiBase: env.TIKTOK_API_BASE,
  });
  console.log(
    `[tiktok:token-lifecycle] terpindai ${result.scanned} — refresh=${result.refreshed} warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
