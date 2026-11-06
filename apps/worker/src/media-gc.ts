import {
  runMediaGcCycle,
  type MediaGcSummary,
  type MediaObjectStore,
} from "@sahabat-kreator/core";
import type { Database } from "@sahabat-kreator/db";

/**
 * Pembersihan media (Fase 19) — siklus berkala di worker.
 *
 * Empat kebocoran ditutup di sini (lihat `media-gc.ts` di core untuk
 * alasannya): berkas yatim, baris tanpa berkas, baris tak dirujuk, dan
 * retensi opt-in.
 *
 * Kenapa di worker: ini pekerjaan latar yang menyentuh seluruh tenant
 * dan menghapus berkas. Menjalankannya di jalur request berarti satu
 * klik pengguna bisa memicu penghapusan lintas tenant.
 *
 * Kenapa per JAM, bukan per 5 detik seperti ingest: tidak ada yang
 * mendesak. Berkas yatim boleh menunggu satu jam; menjalankannya lebih
 * sering hanya menambah beban DB tanpa hasil berbeda.
 */
export interface MediaGcLoopOptions {
  /**
   * Penyimpanan yang SAMA dengan ingest dan poller pengiriman.
   *
   * Diberikan dari luar, bukan dibuat di sini: dua instance dengan akar
   * berbeda berarti GC memeriksa direktori yang salah dan menyimpulkan
   * "semua berkas hilang" — persis keadaan yang dijaga penjaga rasio.
   */
  store: MediaObjectStore;
  /** Retensi dalam hari; `0` = simpan selamanya (default). */
  retentionDays?: number;
}

export interface MediaGcLoop {
  stop: () => void;
  /** Satu putaran manual — dipakai skrip run-once dan test. */
  tick: () => Promise<MediaGcSummary>;
}

export const MEDIA_GC_INTERVAL_MS = 60 * 60 * 1000;

export function startMediaGcLoop(
  db: Database,
  opts: MediaGcLoopOptions,
  intervalMs = MEDIA_GC_INTERVAL_MS,
): MediaGcLoop {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<MediaGcSummary> => {
    return runMediaGcCycle(db, opts.store, {
      retentionDays: opts.retentionDays,
    });
  };

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const summary = await tick();
      // Penjaga rasio BUKAN kegagalan rutin: artinya penyimpanan tidak
      // terpasang atau salah arah. Ini harus terbaca operator, bukan
      // tenggelam di antara log lain.
      if (summary.missing.kind === "aborted_ratio") {
        console.error(
          `[worker] media GC DIBATALKAN: ${summary.missing.missing} dari ${summary.missing.total} baris kehilangan berkas ` +
            `(>${Math.round((summary.missing.missing / Math.max(summary.missing.total, 1)) * 100)}%). ` +
            "Periksa MEDIA_STORAGE_ROOT — volume kemungkinan tidak ter-mount. Tidak ada baris yang dihapus.",
        );
      }
      const changed =
        summary.missing.deleted +
        summary.unreferenced.deleted +
        summary.retention.deleted +
        summary.orphans.deleted;
      if (changed > 0) {
        console.log(
          `[worker] media GC — hilang ${summary.missing.deleted}, ` +
            `tak dirujuk ${summary.unreferenced.deleted}, ` +
            `retensi ${summary.retention.deleted}, ` +
            `berkas yatim ${summary.orphans.deleted}`,
        );
      }
    } catch (err) {
      // Kegagalan satu putaran (DB putus, disk tidak terbaca) tidak
      // boleh mematikan interval.
      console.error("[worker] media GC gagal (akan dicoba lagi):", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  // Sekali saat boot: mengejar yang menumpuk selama worker mati, dan
  // sekaligus memunculkan masalah volume lebih awal daripada satu jam
  // kemudian.
  void run();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
