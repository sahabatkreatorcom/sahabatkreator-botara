import type { Database } from "@sahabat-kreator/db";
import {
  claimOutboundMessage,
  decryptChannelSecret,
  markChannelAccountAuthError,
  markOutboundMessageFailed,
  markOutboundMessageSent,
  recordIntegrationLog,
} from "@sahabat-kreator/core";
import type { RealtimePublisher } from "@sahabat-kreator/queue";

/**
 * Runner poller pengiriman bersama.
 *
 * Sebelumnya `telegram/poller.ts` dan `meta/poller.ts` memuat siklus yang
 * ~90% identik: klaim baris, validasi teks/kredensial, dekripsi token,
 * kirim, tandai sent/failed, catat integration_log, terbitkan nudge
 * realtime. Setiap hotfix pada siklus itu harus dikerjakan dua kali dan
 * mudah menyimpang.
 *
 * Modul ini memegang SATU implementasi siklus tersebut. Perbedaan per
 * provider tinggal di `DeliveryPollerSpec`: cara memindai antrean, cara
 * mengirim, bentuk id pesan majemuk, dan pemetaan error transport.
 *
 * SEJAK PINDAH KE WORKER: runner ini hidup di proses `worker`, bukan
 * `api`. Alasannya, pengiriman pesan adalah pekerjaan latar berdurasi
 * variabel (Bot API/Graph bisa lambat atau menggantung) dan proses API
 * harus tetap stateless + dapat di-replika tanpa batas. Selama poller
 * hidup di API, setiap replika ikut mengirim — klaim atomik mencegah
 * kirim ganda, tetapi beban provider tetap menempel pada replika HTTP
 * dan `SIGTERM` saat rolling deploy bisa memotong pengiriman di tengah
 * jalan. Worker sudah memiliki pola poller berkala (relay outbox, purge,
 * prune, reconcile, lifecycle token), jadi ini konsisten dengan
 * prosesnya.
 */

/** Bentuk minimal satu baris antrean yang dibutuhkan runner. */
export interface QueuedDeliveryBase {
  tenantId: string;
  messageId: string;
  conversationId: string;
  contentText: string | null;
  channelAccountId: string;
  /** Envelope token terenkripsi akun pengirim (bot Telegram / page Meta). */
  encryptedToken: string | null;
  /** Label penerima untuk ringkasan integration_log. */
  recipientLabel: string;
  /** Provider untuk kolom integration_log (telegram/messenger/instagram/whatsapp). */
  logProvider: string;
}

export interface DeliveryPollerSpec<D extends QueuedDeliveryBase> {
  /** Nama proses untuk log & awalan pesan error, mis. "telegram"/"meta". */
  name: string;
  /** Pindai antrean lintas tenant (sudah menyaring baris yang bisa diklaim). */
  scan: (db: Database) => Promise<D[]>;
  /** Kode saat pesan tidak punya teks. */
  emptyTextCode: string;
  /** Kode saat akun tidak punya kredensial tersimpan. */
  missingCredentialsCode: string;
  /** Kode saat token gagal didekripsi (kunci berubah/rusak). */
  undecryptableCode: string;
  /**
   * Kirim satu pesan dan kembalikan id pesan MENTAH dari provider
   * (tanpa awalan majemuk). Melempar error transport bila gagal.
   */
  send: (delivery: D, token: string, db: Database) => Promise<string>;
  /** Bentuk id majemuk untuk kolom messages.provider_message_id. */
  compositeProviderMessageId: (delivery: D, rawProviderId: string) => string;
  /** Terjemahkan error transport → kode aman (tanpa token/URL). */
  errorCode: (err: unknown) => string;
  /**
   * Deteksi error KREDENSIAL MATI (lifecycle 0010 — mis. Graph 190):
   * bila dikembalikan true, runner menandai akun status='error' +
   * error_code di konteks tenant pemiliknya, sehingga inbox meminta
   * "hubungkan ulang" alih-alih gagal senyap berulang. Penandaan
   * best-effort — kegagalan DB tidak mengubah penandaan pesan.
   */
  isAuthError?: (err: unknown) => boolean;
}

export interface DeliveryPoller {
  stop: () => void;
}

export interface DeliveryPollerOptions {
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret: string | undefined;
  /** Penerbit nudge realtime: status sent/failed menyegarkan dashboard seketika. */
  publisher?: RealtimePublisher | null;
}

/**
 * Jalankan poller untuk satu provider. Perilaku yang dipertahankan persis
 * dari dua poller lama:
 * - satu tick tidak pernah tumpang tindih (`running`), error tick ditelan;
 * - tiap pesan DIKLAIM dulu (cegah kirim ganda antar-replica);
 * - kegagalan pra-kirim (teks/kredensial/token) tetap ditandai `failed`
 *   beserta baris integration_log — jujur terlihat di dashboard;
 * - penandaan `sent` dengan id majemuk yang menabrak index unik (pantulan
 *   webhook lebih dulu) diulang TANPA id agar status tidak tertinggal;
 * - token tidak pernah dicatat: hanya kode error aman.
 */
export function startDeliveryPoller<D extends QueuedDeliveryBase>(
  db: Database,
  spec: DeliveryPollerSpec<D>,
  opts: DeliveryPollerOptions,
  intervalMs = 2_000,
): DeliveryPoller {
  let running = false;
  let warnedNoSecret = false;

  const logOut = async (
    delivery: D,
    outcome: "sent" | "failed",
    errorCode: string | null,
  ): Promise<void> => {
    try {
      await recordIntegrationLog(db, {
        direction: "out",
        provider: delivery.logProvider,
        tenantId: delivery.tenantId,
        channelAccountId: delivery.channelAccountId,
        messageId: delivery.messageId,
        outcome,
        errorCode,
        summary:
          outcome === "sent"
            ? `message sent to ${delivery.recipientLabel}`
            : `send to ${delivery.recipientLabel} failed`,
      });
    } catch {
      // Sengaja ditelan: log tidak boleh menjatuhkan poller.
    }
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const deliveries = await spec.scan(db);
      if (deliveries.length === 0) return;
      if (!opts.channelTokenSecret) {
        if (!warnedNoSecret) {
          warnedNoSecret = true;
          console.error(
            `[${spec.name}] ada pesan queued tetapi CHANNEL_TOKEN_SECRET belum diatur — pengiriman dilewati`,
          );
        }
        return;
      }

      for (const delivery of deliveries) {
        const ctx = { tenantId: delivery.tenantId };

        // Klaim atomik: hanya SATU proses yang boleh mengirim baris ini.
        // Gagal klaim = sudah dibatalkan (dihapus broadcast) atau sedang
        // dikirim proses lain → lewati.
        if (!(await claimOutboundMessage(db, ctx, delivery.messageId))) {
          continue;
        }

        const nudgeStatus = async (kind: "message.sent" | "message.failed") => {
          if (opts.publisher) {
            await opts.publisher.publishNudge({
              kind,
              tenantId: delivery.tenantId,
              conversationId: delivery.conversationId,
            });
          }
        };
        const failBeforeSend = async (code: string) => {
          await markOutboundMessageFailed(
            db,
            ctx,
            delivery.messageId,
            `${spec.name}-poller`,
            code,
          );
          await logOut(delivery, "failed", code);
          await nudgeStatus("message.failed");
        };

        if (!delivery.contentText) {
          await failBeforeSend(spec.emptyTextCode);
          continue;
        }
        if (!delivery.encryptedToken) {
          await failBeforeSend(spec.missingCredentialsCode);
          continue;
        }
        const token = decryptChannelSecret(
          opts.channelTokenSecret,
          delivery.encryptedToken,
        );
        if (!token) {
          await failBeforeSend(spec.undecryptableCode);
          continue;
        }

        try {
          const rawProviderId = await spec.send(delivery, token, db);
          const compositeId = spec.compositeProviderMessageId(
            delivery,
            rawProviderId,
          );
          try {
            await markOutboundMessageSent(
              db,
              ctx,
              delivery.messageId,
              `${spec.name}-poller`,
              compositeId,
            );
          } catch {
            // Balapan sangat jarang: pantulan webhook tiba & tercatat lebih
            // dulu sehingga id majemuk menabrak index unik global.
            // Penandaan `sent` tidak boleh ikut gagal — ulang tanpa id.
            console.error(
              `[${spec.name}] menyimpan provider id pesan ${delivery.messageId} gagal — tandai sent tanpa id`,
            );
            await markOutboundMessageSent(
              db,
              ctx,
              delivery.messageId,
              `${spec.name}-poller`,
            );
          }
          await logOut(delivery, "sent", null);
          await nudgeStatus("message.sent");
        } catch (err) {
          const code = spec.errorCode(err);
          // Sertakan deskripsi resmi provider (dipotong) supaya log server
          // tidak hanya berbunyi "meta_graph_100" tanpa sebab. Deskripsi
          // Graph tidak memuat token; error jaringan tetap "network_error".
          const detail =
            err instanceof Error && err.message
              ? ` — ${err.message.slice(0, 200)}`
              : "";
          console.error(
            `[${spec.name}] pengiriman pesan ${delivery.messageId} gagal: ${code}${detail}`,
          );
          await markOutboundMessageFailed(
            db,
            ctx,
            delivery.messageId,
            `${spec.name}-poller`,
            code,
          );
          await logOut(delivery, "failed", code);
          await nudgeStatus("message.failed");
          // Lifecycle 0010: token mati → tandai akun 'error' + error_code
          // (best-effort) supaya gagal berikutnya dicegah lebih awal dan
          // pemilik melihat "hubungkan ulang", bukan pesan gagal diam.
          if (spec.isAuthError?.(err)) {
            try {
              await markChannelAccountAuthError(
                db,
                ctx,
                delivery.channelAccountId,
                code,
              );
              console.error(
                `[${spec.name}] akun ${delivery.channelAccountId} ditandai 'error' (${code}) — kredensial ditolak provider`,
              );
            } catch (markErr) {
              console.error(
                `[${spec.name}] penandaan auth-error akun ${delivery.channelAccountId} gagal`,
                markErr,
              );
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${spec.name}] delivery poller tick failed`, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  console.log(
    `[${spec.name}] delivery poller aktif (interval ${intervalMs}ms)`,
  );
  return {
    stop: () => clearInterval(timer),
  };
}
