/**
 * Run-once pembersihan media (Fase 19): menjalankan SATU putaran
 * `runMediaGcCycle` terhadap DATABASE_URL + MEDIA_STORAGE_ROOT dari env,
 * lalu keluar. Jalur berkala yang sama jalan sendiri di worker (sekali
 * saat boot + tiap jam), jadi skrip ini untuk pengujian & operasi manual
 * — misalnya setelah memindahkan volume media atau memulihkan DB.
 *
 * Retensi mengikuti MEDIA_RETENTION_DAYS (default 0 = simpan selamanya).
 * Untuk mencoba tanpa menghapus apa pun, jalankan dengan retensi 0 lebih
 * dulu dan baca angkanya.
 *
 * Jalankan dari server staging (env dari .env.staging):
 *   set -a; . ./.env.staging; set +a
 *   pnpm --filter @sahabat-kreator/worker prune:media
 */
import { loadEnv, resolveMediaStorageRoot } from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import { createDiskMediaStore, runMediaGcCycle } from "@sahabat-kreator/core";

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[prune:media] DATABASE_URL wajib diisi");
}

const storageRoot = resolveMediaStorageRoot(env.MEDIA_STORAGE_ROOT);
const { db, pool } = createDb(env.DATABASE_URL, { applicationName: "sk-script" });
try {
  const summary = await runMediaGcCycle(db, createDiskMediaStore(storageRoot), {
    retentionDays: env.MEDIA_RETENTION_DAYS,
  });

  console.log(`[prune:media] akar penyimpanan: ${storageRoot}`);
  console.log(
    `[prune:media] baris tanpa berkas: diperiksa ${summary.missing.checked}/${summary.missing.total}, ` +
      `hilang ${summary.missing.missing}, dihapus ${summary.missing.deleted}` +
      (summary.missing.kind === "aborted_ratio"
        ? " — DIBATALKAN (penyimpanan tampak tidak ter-mount)"
        : ""),
  );
  console.log(
    `[prune:media] tak dirujuk: diperiksa ${summary.unreferenced.scanned}, ` +
      `kandidat ${summary.unreferenced.candidates}, dihapus ${summary.unreferenced.deleted} ` +
      `(berkas ${summary.unreferenced.objectsDeleted})`,
  );
  console.log(
    summary.retention.kind === "disabled"
      ? "[prune:media] retensi: nonaktif (MEDIA_RETENTION_DAYS=0)"
      : `[prune:media] retensi >${summary.retention.retentionDays} hari: ` +
          `dihapus ${summary.retention.deleted} (berkas ${summary.retention.objectsDeleted}), ` +
          `dipertahankan karena masih antre ${summary.retention.keptQueued}`,
  );
  console.log(
    `[prune:media] berkas yatim: diperiksa ${summary.orphans.objectsScanned} di ` +
      `${summary.orphans.tenantsScanned} tenant, dihapus ${summary.orphans.deleted}, ` +
      `ditunda (baru) ${summary.orphans.skippedRecent}, ` +
      `dilewati (tata letak asing) ${summary.orphans.skippedUnknown}`,
  );
} finally {
  await pool.end();
}
