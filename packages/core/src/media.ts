import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  channelAccounts,
  conversations,
  media,
  messages,
  type Database,
} from "@sahabat-kreator/db";
import { decryptChannelSecret } from "./channel-secrets";
import { buildMediaObjectKey, type MediaObjectStore } from "./media-storage";
import { withTenantDb } from "./tx";

/**
 * Ingest media MASUK (Fase 18).
 *
 * Masalah yang ditutup: webhook WhatsApp hanya membawa media id, bukan
 * berkasnya, dan URL unduhan hasil penukaran id hanya hidup ±5 menit.
 * Sampai fase ini parser membuang id itu dan menyimpan caption saja —
 * jadi foto yang dikirim pelanggan tidak pernah bisa dilihat agen, dan
 * TIDAK BISA DISUSUL karena kuncinya sudah hilang.
 *
 * Alur (sengaja tiga langkah, bukan satu transaksi):
 *   1. baca singkat dalam konteks tenant → media id + token akun;
 *   2. unduh DI LUAR transaksi — satu video bisa butuh detik, dan
 *      menahan koneksi DB selama itu menghabiskan pool;
 *   3. tulis singkat dalam konteks tenant → baris `media` + `media_id`
 *      di pesan.
 *
 * Kenapa di worker, bukan di webhook: Meta mengirim ULANG payload bila
 * ack lambat. Mengunduh di jalur webhook membuat unduhan 16 MB menahan
 * ack, lalu retry memicu unduhan yang sama lagi. Pola ini meniru
 * poller pengiriman yang sudah ada: pindai tabel, kerjakan di luar
 * request.
 */

/**
 * Setelah sekian kegagalan, baris berhenti dipindai.
 *
 * Media bisa gagal SELAMANYA: pengirim menghapus berkas, media id
 * kedaluwarsa (Meta menyimpan ±30 hari), atau berkas melebihi batas
 * ukuran kita. Tanpa batas percobaan, tiap tick memindai dan mengunduh
 * ulang baris yang sama selamanya — biaya CPU dan kuota tanpa hasil.
 */
export const MEDIA_INGEST_MAX_ATTEMPTS = 5;

/**
 * Jarak minimum antar-percobaan untuk baris yang SAMA.
 *
 * Tanpa jarak ini, siklus worker (5 dtk) menghabiskan seluruh jatah
 * percobaan dalam 25 detik: gangguan jaringan satu menit sudah cukup
 * membuat media hilang permanen, padahal berkasnya masih ada di Meta
 * (media id berlaku ±30 hari). Dengan 5 menit, jatah yang sama menutupi
 * gangguan ±25 menit, dan media yang benar-benar hilang tetap berhenti
 * dicoba setelah itu — tidak selamanya.
 */
export const MEDIA_INGEST_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/** Pesan yang menunggu ingest media. */
export interface PendingMediaIngestion {
  tenantId: string;
  messageId: string;
}

/**
 * Pindai LINTAS tenant untuk pesan yang punya referensi media provider
 * tetapi belum punya `media_id`.
 *
 * Berjalan dalam transaksi `app.system_delivery='whatsapp'` — policy
 * `meta_delivery_scan` (0018, diperluas ke whatsapp) membuka baris
 * pesan untuk dibaca; penulisan tetap terjadi di konteks tenant
 * masing-masing pada langkah 3.
 *
 * `media_ingest_attempts < MAX` disaring di sini (bukan di predikat
 * index parsial) supaya angkanya tetap satu konstanta di kode.
 */
export async function listPendingMediaIngestions(
  db: Database,
  limit = 20,
): Promise<PendingMediaIngestion[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.system_delivery', 'whatsapp', true)`,
    );
    // Jarak antar-percobaan dihitung di SQL (bukan di kode) supaya
    // penyaringnya ikut mendorong pemakaian index dan tidak menarik
    // baris yang belum boleh dicoba ke dalam proses.
    const retryCutoff = new Date(Date.now() - MEDIA_INGEST_RETRY_BACKOFF_MS);
    const rows = await tx
      .select({ tenantId: messages.tenantId, messageId: messages.id })
      .from(messages)
      .where(
        and(
          isNull(messages.mediaId),
          sql`${messages.providerMediaId} IS NOT NULL`,
          sql`${messages.mediaIngestAttempts} < ${MEDIA_INGEST_MAX_ATTEMPTS}`,
          or(
            isNull(messages.mediaIngestAttemptedAt),
            lt(messages.mediaIngestAttemptedAt, retryCutoff),
          ),
        ),
      )
      .orderBy(messages.createdAt)
      .limit(limit);
    return rows;
  });
}

/** Hasil satu ingest. `skipped` = tidak ada yang perlu dikerjakan. */
export type MediaIngestOutcome =
  | { kind: "stored"; mediaId: string; bytes: number; mimeType: string | null }
  | { kind: "skipped"; reason: "already_stored" | "no_media_ref" }
  | { kind: "failed"; reason: string; attempts: number; exhausted: boolean };

export interface MediaIngestDeps {
  /** Penyimpanan objek tujuan (disk/R2/memori). */
  store: MediaObjectStore;
  /**
   * Unduh isi media dari provider. Diimplementasikan pemanggil
   * (worker) memakai `WhatsAppCloudClient.downloadMedia`, supaya core
   * tidak bergantung pada paket kanal.
   */
  fetchMedia: (input: {
    accessToken: string;
    mediaId: string;
  }) => Promise<{ data: Buffer; mimeType: string | null }>;
  /** Material kunci dekripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret: string;
  /** Batas ukuran; unduhan lebih besar dianggap gagal permanen. */
  maxBytes?: number;
  now?: Date;
}

function describeError(err: unknown): string {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}

/**
 * Ingest satu pesan: unduh, simpan, tautkan.
 *
 * Tidak pernah melempar untuk kegagalan media — pemanggil (siklus
 * worker) harus tetap memproses baris berikutnya. Kegagalan dicatat di
 * `media_ingest_error` + `media_ingest_attempts` agar terlihat operator
 * dan berhenti setelah batas.
 */
export async function ingestMessageMedia(
  db: Database,
  deps: MediaIngestDeps,
  target: PendingMediaIngestion,
): Promise<MediaIngestOutcome> {
  // --- Langkah 1: baca referensi + token (transaksi singkat) ----------
  const prepared = await withTenantDb(db, target.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        messageId: messages.id,
        mediaId: messages.mediaId,
        providerMediaId: messages.providerMediaId,
        providerMediaMime: messages.providerMediaMime,
        providerMediaFileName: messages.providerMediaFileName,
        type: messages.type,
        encryptedToken: channelAccounts.accessTokenEncrypted,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(
        channelAccounts,
        eq(conversations.channelAccountId, channelAccounts.id),
      )
      .where(eq(messages.id, target.messageId))
      .limit(1);
    return row ?? null;
  });

  if (!prepared) {
    return { kind: "skipped", reason: "no_media_ref" };
  }
  if (prepared.mediaId) {
    return { kind: "skipped", reason: "already_stored" };
  }
  if (!prepared.providerMediaId) {
    return { kind: "skipped", reason: "no_media_ref" };
  }

  const recordFailure = async (
    reason: string,
  ): Promise<MediaIngestOutcome> => {
    const attempts = await withTenantDb(db, target.tenantId, async (tx) => {
      const [updated] = await tx
        .update(messages)
        .set({
          mediaIngestAttempts: sql`${messages.mediaIngestAttempts} + 1`,
          mediaIngestError: reason,
          // Dicatat supaya pemindai memberi jarak sebelum mencoba lagi.
          mediaIngestAttemptedAt: new Date(),
        })
        .where(eq(messages.id, target.messageId))
        .returning({ attempts: messages.mediaIngestAttempts });
      return updated?.attempts ?? MEDIA_INGEST_MAX_ATTEMPTS;
    });
    return {
      kind: "failed",
      reason,
      attempts,
      exhausted: attempts >= MEDIA_INGEST_MAX_ATTEMPTS,
    };
  };

  // Token yang tidak bisa didekripsi bukan kesalahan sementara: kunci
  // env berganti. Dicatat sekali dan tidak dicoba ulang sampai batas.
  const accessToken = prepared.encryptedToken
    ? decryptChannelSecret(deps.channelTokenSecret, prepared.encryptedToken)
    : null;
  if (!accessToken) {
    return recordFailure("media_token_unavailable");
  }

  // --- Langkah 2: unduh (di luar transaksi) ---------------------------
  let downloaded: { data: Buffer; mimeType: string | null };
  try {
    downloaded = await deps.fetchMedia({
      accessToken,
      mediaId: prepared.providerMediaId,
    });
  } catch (err) {
    return recordFailure(describeError(err));
  }

  const maxBytes = deps.maxBytes ?? 25 * 1024 * 1024;
  if (downloaded.data.length === 0) {
    return recordFailure("media_empty");
  }
  if (downloaded.data.length > maxBytes) {
    return recordFailure("media_too_large");
  }

  const mimeType = downloaded.mimeType ?? prepared.providerMediaMime ?? null;
  const objectKey = buildMediaObjectKey({
    tenantId: target.tenantId,
    fileName: prepared.providerMediaFileName,
    mimeType,
    now: deps.now,
  });

  try {
    await deps.store.put(objectKey, downloaded.data, mimeType);
  } catch (err) {
    return recordFailure(describeError(err));
  }

  // --- Langkah 3: tulis baris media + tautkan (transaksi singkat) -----
  try {
    const mediaId = await withTenantDb(db, target.tenantId, async (tx) => {
      const [inserted] = await tx
        .insert(media)
        .values({
          tenantId: target.tenantId,
          r2Key: objectKey,
          fileName: prepared.providerMediaFileName,
          mimeType,
          sizeBytes: downloaded.data.length,
        })
        .returning({ id: media.id });
      if (!inserted) throw new Error("media_insert_failed");

      // Penjaga `media_id IS NULL`: dua siklus ingest yang balapan
      // tidak boleh saling menimpa. Yang kalah cukup tidak melakukan
      // apa-apa — berkasnya sudah tersimpan dan baris `media` yatim
      // akan tersapu oleh purge channel.
      await tx
        .update(messages)
        .set({ mediaId: inserted.id, mediaIngestError: null })
        .where(
          and(eq(messages.id, target.messageId), isNull(messages.mediaId)),
        );
      return inserted.id;
    });

    return {
      kind: "stored",
      mediaId,
      bytes: downloaded.data.length,
      mimeType,
    };
  } catch (err) {
    // Berkas sudah ada di store tetapi baris DB gagal: hapus supaya
    // tidak menumpuk objek yatim. Kegagalan hapus diabaikan — masalah
    // utamanya sudah dilaporkan lewat recordFailure.
    try {
      await deps.store.delete(objectKey);
    } catch {
      /* objek yatim lebih baik daripada menggagalkan pelaporan */
    }
    return recordFailure(describeError(err));
  }
}

/** Ringkasan satu siklus ingest. */
export interface MediaIngestCycleResult {
  scanned: number;
  stored: number;
  skipped: number;
  failed: number;
  /** Kegagalan yang membuat baris berhenti dicoba (perlu dilihat operator). */
  exhausted: Array<{ tenantId: string; messageId: string; reason: string }>;
}

/**
 * Satu siklus: pindai sejumlah baris, ingest satu per satu.
 *
 * Kegagalan per baris TIDAK menghentikan siklus — kalau berhenti, satu
 * media rusak akan menahan semua media lain di belakangnya (persis
 * kelas kegagalan yang diperbaiki Fase 16D di relay outbox).
 */
export async function runMediaIngestCycle(
  db: Database,
  deps: MediaIngestDeps,
  limit = 20,
): Promise<MediaIngestCycleResult> {
  const pending = await listPendingMediaIngestions(db, limit);
  const result: MediaIngestCycleResult = {
    scanned: pending.length,
    stored: 0,
    skipped: 0,
    failed: 0,
    exhausted: [],
  };
  for (const target of pending) {
    let outcome: MediaIngestOutcome;
    try {
      outcome = await ingestMessageMedia(db, deps, target);
    } catch (err) {
      // Jaring pengaman: kesalahan tak terduga (DB putus) tidak boleh
      // mematikan siklus untuk baris lain.
      result.failed += 1;
      result.exhausted.push({
        tenantId: target.tenantId,
        messageId: target.messageId,
        reason: describeError(err),
      });
      continue;
    }
    if (outcome.kind === "stored") result.stored += 1;
    else if (outcome.kind === "skipped") result.skipped += 1;
    else {
      result.failed += 1;
      if (outcome.exhausted) {
        result.exhausted.push({
          tenantId: target.tenantId,
          messageId: target.messageId,
          reason: outcome.reason,
        });
      }
    }
  }
  return result;
}

/** Metadata media untuk disajikan API (`GET /media/:id`). */
export async function getMediaForServing(
  db: Database,
  ctx: { tenantId: string },
  mediaId: string,
): Promise<{ r2Key: string; mimeType: string | null; fileName: string | null } | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        r2Key: media.r2Key,
        mimeType: media.mimeType,
        fileName: media.fileName,
      })
      .from(media)
      .where(eq(media.id, mediaId))
      .limit(1);
    return row ?? null;
  });
}
