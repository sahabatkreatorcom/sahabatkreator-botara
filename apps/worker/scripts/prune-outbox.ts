/**
 * Run-once retensi outbox (Fase 20, temuan audit A3): menjalankan SATU
 * putaran `pruneOutboxEvents` terhadap DATABASE_URL dari env, lalu keluar.
 * Jalur berkala yang sama jalan sendiri di worker (sekali saat boot + tiap
 * jam), jadi skrip ini untuk pengujian & operasi manual — misalnya setelah
 * tabel membengkak karena retensi belum pernah berjalan.
 *
 * Yang dibuang: baris TERBIT lebih tua dari 7 hari, dan baris DEAD-LETTER
 * lebih tua dari 30 hari. Event yang belum terbit TIDAK PERNAH disentuh.
 *
 * Jalankan dari server (env dari .env.staging):
 *   set -a; . ./.env.staging; set +a
 *   pnpm --filter @sahabat-kreator/worker prune:outbox
 */
import { loadEnv } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import {
  OUTBOX_DEAD_LETTER_RETENTION_DAYS,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  pruneOutboxEvents,
} from "@sahabat-kreator/core";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[prune:outbox] DATABASE_URL wajib diisi");
}

const { db, pool } = createDb(env.DATABASE_URL, { applicationName: "sk-script" });
try {
  const result = await pruneOutboxEvents(db);
  console.log(
    `[prune:outbox] terbit >${OUTBOX_PUBLISHED_RETENTION_DAYS} hari: ${result.publishedDeleted} baris terhapus`,
  );
  console.log(
    `[prune:outbox] dead-letter >${OUTBOX_DEAD_LETTER_RETENTION_DAYS} hari: ${result.deadLetterDeleted} baris terhapus`,
  );
  console.log(
    "[prune:outbox] event yang belum terbit tidak disentuh (pekerjaan yang belum selesai)",
  );
} finally {
  await pool.end();
}
