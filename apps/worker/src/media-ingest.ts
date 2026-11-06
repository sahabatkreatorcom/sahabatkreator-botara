import {
  createDiskMediaStore,
  runMediaIngestCycle,
  type MediaIngestCycleResult,
} from "@sahabat-kreator/core";
import type { Database } from "@sahabat-kreator/db";
import { WhatsAppCloudClient } from "@sahabat-kreator/channel-whatsapp";

/**
 * Ingest media masuk (Fase 18) — siklus berkala di worker.
 *
 * Kenapa worker, bukan webhook: Meta mengirim ulang payload bila ack
 * lambat, dan mengunduh berkas 16 MB di jalur webhook membuat ack
 * lambat lalu memicu retry yang mengunduh ulang. Pesan sudah tercatat
 * lengkap dengan media id-nya, jadi unduhan bisa kapan saja.
 *
 * Siklus ini TIDAK melempar: kegagalan satu media dicatat di barisnya
 * sendiri (dan berhenti setelah batas percobaan), bukan menghentikan
 * pemrosesan media lain.
 */
export interface MediaIngestLoopOptions {
  /**
   * Material kunci dekripsi kredensial channel (env CHANNEL_TOKEN_SECRET).
   * Opsional di tipe karena env bersifat opsional saat dev; tanpa nilai
   * yang sah, dekripsi mengembalikan null dan ingest mencatat
   * `media_token_unavailable` — bukan melempar tiap siklus.
   */
  channelTokenSecret?: string;
  metaApiBase?: string;
  graphApiVersion: string;
  /** Akar penyimpanan disk (resolveMediaStorageRoot). */
  storageRoot: string;
  maxBytes?: number;
}

export interface MediaIngestLoop {
  stop: () => void;
  /** Satu siklus manual — dipakai `verify:*` dan test. */
  tick: () => Promise<MediaIngestCycleResult>;
}

export function startMediaIngestLoop(
  db: Database,
  opts: MediaIngestLoopOptions,
  intervalMs = 5_000,
): MediaIngestLoop {
  let running = false;
  let stopped = false;

  // Tanpa kunci dekripsi, SEMUA media akan gagal dengan alasan yang
  // sama. Lebih baik mengatakannya sekali di startup daripada
  // membiarkan operator membaca ratusan baris "media_token_unavailable".
  if (!opts.channelTokenSecret) {
    console.warn(
      "[worker] MEDIA: CHANNEL_TOKEN_SECRET kosong — media masuk tidak akan bisa diunduh",
    );
  }

  const tick = async (): Promise<MediaIngestCycleResult> => {
    const store = createDiskMediaStore(opts.storageRoot);
    return runMediaIngestCycle(db, {
      store,
      channelTokenSecret: opts.channelTokenSecret ?? "",
      maxBytes: opts.maxBytes,
      fetchMedia: async ({ accessToken, mediaId }) => {
        const client = new WhatsAppCloudClient({
          baseUrl: opts.metaApiBase,
          apiVersion: opts.graphApiVersion,
          accessToken,
        });
        return client.downloadMedia(mediaId, { maxBytes: opts.maxBytes });
      },
    });
  };

  const run = async (): Promise<void> => {
    // Satu siklus pada satu waktu: dua siklus bersamaan akan mengunduh
    // media yang sama dua kali (penjaga `media_id IS NULL` mencegah
    // tautan ganda, tetapi unduhannya tetap boros).
    if (running || stopped) return;
    running = true;
    try {
      const result = await tick();
      if (result.stored > 0 || result.failed > 0) {
        console.log(
          `[worker] media ingest — dipindai ${result.scanned}, tersimpan ${result.stored}, gagal ${result.failed}`,
        );
      }
      // Kegagalan yang sudah menyerah dilaporkan eksplisit: ini media
      // yang TIDAK akan pernah muncul di inbox, dan satu-satunya jejak
      // yang bisa dibaca operator.
      for (const item of result.exhausted) {
        console.warn(
          `[worker] media ingest menyerah — pesan ${item.messageId} (tenant ${item.tenantId}): ${item.reason}`,
        );
      }
    } catch (err) {
      // Kegagalan tingkat siklus (DB putus): dicatat, dicoba lagi tick
      // berikutnya. Tidak boleh mematikan interval.
      console.error("[worker] media ingest gagal:", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  // Jalankan sekali di awal supaya media yang menumpuk saat worker mati
  // tidak menunggu satu interval penuh.
  void run();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
