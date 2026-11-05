/**
 * Run-once purge Sampah channel (Fase 6I): menjalankan SATU putaran
 * `purgeExpiredTrashedChannels` terhadap DATABASE_URL dari env, lalu
 * keluar. Inilah pemicu manual untuk pengujian & operasi — jalur berkala
 * yang sama juga jalan sendiri di worker (sekali saat boot + tiap jam),
 * jadi skrip ini tidak wajib untuk operasi normal.
 *
 * Jalankan dari server staging (env dari .env.staging):
 *   set -a; . ./.env.staging; set +a
 *   pnpm --filter @sahabat-kreator/worker purge:channels
 */
import { loadEnv } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import { purgeExpiredTrashedChannels } from "@sahabat-kreator/core";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[purge:channels] DATABASE_URL wajib diisi");
}
const { db, pool } = createDb(env.DATABASE_URL, { applicationName: "sk-script" });
try {
  const result = await purgeExpiredTrashedChannels(db);
  console.log(
    `[purge:channels] terpinai ${result.scanned} akun Sampah kedaluwarsa; ter-purge ${result.purged.length}; gagal ${result.failed.length}`,
  );
  for (const p of result.purged) {
    console.log(
      `[purge:channels] PURGED ${p.channelAccountId} (tenant ${p.tenantId}) counts=${JSON.stringify(p.counts)}`,
    );
  }
  for (const f of result.failed) {
    console.error(
      `[purge:channels] FAILED ${f.channelAccountId} (tenant ${f.tenantId}): ${f.error}`,
    );
  }
  if (result.failed.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
