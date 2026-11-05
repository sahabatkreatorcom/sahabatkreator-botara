/**
 * Run-once prune log integrasi (Fase 7B.1): menjalankan SATU putaran
 * `pruneIntegrationLogs` (hapus baris `integration_log` lebih tua dari
 * retensi 30 hari) terhadap DATABASE_URL dari env, lalu keluar. Jalur
 * berkala yang sama juga jalan sendiri di worker (sekali saat boot +
 * tiap jam), jadi skrip ini untuk pengujian & operasi manual saja.
 *
 * Jalankan dari server staging (env dari .env.staging):
 *   set -a; . ./.env.staging; set +a
 *   pnpm --filter @sahabat-kreator/worker prune:logs
 */
import { loadEnv } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import {
  INTEGRATION_LOG_RETENTION_DAYS,
  pruneIntegrationLogs,
} from "@sahabat-kreator/core";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[prune:logs] DATABASE_URL wajib diisi");
}
const { db, pool } = createDb(env.DATABASE_URL, { applicationName: "sk-script" });
try {
  const result = await pruneIntegrationLogs(db);
  console.log(
    `[prune:logs] terhapus ${result.deleted} baris log integrasi >${INTEGRATION_LOG_RETENTION_DAYS} hari`,
  );
} finally {
  await pool.end();
}
