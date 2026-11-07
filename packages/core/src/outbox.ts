import { and, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { outboxEvents, type Database } from "@sahabat-kreator/db";
import type { DbTx } from "./tx";

/**
 * Relay Transactional Outbox (Fase 2A, RANCANGAN §2 aturan 5).
 *
 * Event ditulis produsen (service domain) ke `outbox_events` dalam transaksi
 * yang sama dengan perubahan datanya, dengan `published_at` NULL. Relay —
 * dijalankan worker secara berkala — mengklaim event yang belum ter-publish
 * dari SEMUA tenant, menyerahkannya ke handler, lalu menandai published.
 *
 * Kenapa bisa lintas tenant tanpa mematikan RLS: transaksi relay men-set
 * `app.system_relay='outbox'` (transaction-local), yang membuka policy
 * `system_relay` pada outbox_events (migrasi 0008) — dan HANYA tabel itu.
 * Semua tabel lain tetap menuntut konteks tenant seperti biasa.
 *
 * Keamanan klaim: SELECT ... FOR UPDATE SKIP LOCKED di dalam satu transaksi
 * yang sama dengan pemrosesan + penandaan, jadi dua relay yang balapan tidak
 * mengambil baris yang sama.
 *
 * ISOLASI PER EVENT (Fase 16D, migrasi 0005). Versi sebelumnya memproses
 * seluruh batch dalam satu blok tanpa penjaga: satu handler yang melempar
 * membatalkan SEMUA event di batch itu, dan karena urutannya `created_at
 * ASC`, event yang sama diambil lagi pada siklus berikutnya — event yang
 * lebih baru tidak pernah diproses. Efeknya seluruh pipa berhenti
 * (automation, sequence, flow, broadcast, email undangan, embedding KB,
 * sinkron Google) dengan satu baris `console.error` sebagai satu-satunya
 * jejak.
 *
 * Sekarang setiap event berjalan di SAVEPOINT sendiri:
 * - handler gagal → hanya event itu yang di-rollback; sisanya tetap jalan;
 * - kegagalan dicatat (`attempts`, `last_error`) sehingga bisa dibaca
 *   operator, bukan hanya muncul di log;
 * - setelah `OUTBOX_MAX_ATTEMPTS` relay MENYERAH (`dead_lettered_at`) agar
 *   satu event rusak tidak menempati slot batch selamanya.
 *
 * Handler tetap WAJIB idempoten: handler bisa sudah menulis ke sistem luar
 * (mis. menaruh job BullMQ) sebelum melempar, dan event itu akan dicoba
 * lagi. Untuk semua handler saat ini idempotensi dijamin jobId BullMQ yang
 * diturunkan dari id event (lihat worker).
 */

/** Setelah sekian kegagalan, event dikarantina dan tidak dipindai lagi. */
export const OUTBOX_MAX_ATTEMPTS = 5;

/** Panjang maksimum `last_error` yang disimpan (bukan tumpukan penuh). */
const LAST_ERROR_MAX = 500;

export interface UnpublishedOutboxEvent {
  id: string;
  tenantId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  /** Percobaan sebelumnya yang sudah gagal. */
  attempts: number;
}

export type OutboxRelayHandler = (
  tx: DbTx,
  event: UnpublishedOutboxEvent,
) => Promise<void>;

export interface OutboxDeadLetter {
  id: string;
  tenantId: string | null;
  type: string;
  attempts: number;
  error: string;
}

export interface OutboxRelayResult {
  /** Event yang berhasil diproses siklus ini. */
  relayed: number;
  /** Event yang BARU SAJA dikarantina siklus ini (perlu dilaporkan). */
  deadLettered: OutboxDeadLetter[];
}

function describeError(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  return raw.length > LAST_ERROR_MAX ? `${raw.slice(0, LAST_ERROR_MAX)}…` : raw;
}

/**
 * Menjalankan satu siklus relay: klaim ≤ `limit` event tertua yang belum
 * ter-publish dan belum dikarantina, panggil `handler` untuk masing-masing,
 * lalu tandai published — semuanya dalam satu transaksi.
 *
 * Tidak lagi melempar karena handler gagal: kegagalan per event ditangani
 * di dalam (savepoint + pencatatan). Yang masih melempar adalah kegagalan
 * tingkat transaksi (koneksi DB putus, lock timeout) — di situ seluruh
 * siklus memang harus diulang.
 */
export async function relayUnpublishedOutboxEvents(
  db: Database,
  handler: OutboxRelayHandler,
  limit = 25,
): Promise<OutboxRelayResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_relay', 'outbox', true)`);
    const result = await tx.execute(sql`
      SELECT id, tenant_id, type, payload, created_at, attempts
      FROM outbox_events
      WHERE published_at IS NULL AND dead_lettered_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const rows = (
      result as unknown as {
        rows: Array<{
          id: string;
          tenant_id: string | null;
          type: string;
          payload: Record<string, unknown>;
          created_at: Date | string;
          attempts: number | string | null;
        }>;
      }
    ).rows;
    if (rows.length === 0) return { relayed: 0, deadLettered: [] };

    let relayed = 0;
    const deadLettered: OutboxDeadLetter[] = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      // Nama savepoint harus pengenal SQL yang sah; indeks batch cukup
      // unik karena savepoint bersarang tidak dipakai di sini.
      const savepoint = `outbox_event_${index}`;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        await handler(tx as unknown as DbTx, {
          id: row.id,
          tenantId: row.tenant_id,
          type: row.type,
          payload: row.payload ?? {},
          createdAt: new Date(row.created_at),
          attempts: Number(row.attempts ?? 0),
        });
        await tx.execute(
          sql`UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = ${row.id}`,
        );
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
        relayed += 1;
      } catch (err) {
        // Rollback ke savepoint memulihkan transaksi dari keadaan
        // "aborted" sekaligus membatalkan tulisan handler untuk event ini
        // saja. Tulisan event lain di batch ini tidak tersentuh.
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));

        const attempts = Number(row.attempts ?? 0) + 1;
        const error = describeError(err);
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          await tx.execute(sql`
            UPDATE outbox_events
            SET attempts = ${attempts},
                last_error = ${error},
                dead_lettered_at = now()
            WHERE id = ${row.id}
          `);
          deadLettered.push({
            id: row.id,
            tenantId: row.tenant_id,
            type: row.type,
            attempts,
            error,
          });
        } else {
          await tx.execute(sql`
            UPDATE outbox_events
            SET attempts = ${attempts}, last_error = ${error}
            WHERE id = ${row.id}
          `);
        }
      }
    }

    return { relayed, deadLettered };
  });
}

// ---------------------------------------------------------------------------
// Retensi (Fase 20)
// ---------------------------------------------------------------------------

/**
 * Umur maksimum baris yang sudah TERBIT.
 *
 * Event dikonsumsi dalam hitungan detik oleh relay; seminggu adalah
 * jendela yang jauh lebih longgar daripada kebutuhan debugging apa pun.
 * Yang disimpan setelah itu tidak pernah dibaca kode mana pun — hanya
 * menambah ukuran tabel, waktu vacuum, dan waktu backup.
 */
export const OUTBOX_PUBLISHED_RETENTION_DAYS = 7;

/**
 * Umur maksimum baris DEAD-LETTER.
 *
 * Lebih panjang dari baris terbit karena baris ini adalah bukti: satu
 * event yang gagal 5 kali menandakan bug handler atau kredensial yang
 * dicabut, dan operator butuh waktu untuk menemukannya. Setelah 30 hari
 * bukti itu sudah tidak bisa ditindaklanjuti — yang tersisa hanya biaya.
 *
 * Sama dengan retensi `integration_log`, supaya dua sumber jejak kegagalan
 * bisa dibaca berdampingan tanpa salah satunya sudah hilang.
 */
export const OUTBOX_DEAD_LETTER_RETENTION_DAYS = 30;

/** Baris per transaksi — menjaga transaksi pendek dan kunci singkat. */
const OUTBOX_PRUNE_BATCH_SIZE = 5000;

export interface OutboxPruneResult {
  publishedDeleted: number;
  deadLetterDeleted: number;
}

/**
 * Hapus satu batch baris outbox yang memenuhi `predicate`.
 *
 * Memakai lengan `app.system_relay='outbox'` yang SAMA dengan relay:
 * policy `system_relay` pada tabel ini memang FOR ALL, jadi penghapusan
 * tidak menuntut lengan baru. Predikatnya selalu berbasis waktu, sehingga
 * tidak mungkin menyentuh baris yang belum terbit.
 */
async function deleteOutboxBatch(
  db: Database,
  predicate: SQL | undefined,
  batchSize: number,
): Promise<number> {
  // `and()` mengembalikan undefined bila tidak ada kondisi. Menghapus
  // tanpa predikat berarti mengosongkan SELURUH tabel outbox — termasuk
  // event yang belum terbit. Lebih baik tidak melakukan apa pun.
  if (!predicate) return 0;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_relay', 'outbox', true)`);
    const doomed = tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(predicate)
      .limit(batchSize);
    const rows = await tx
      .delete(outboxEvents)
      .where(inArray(outboxEvents.id, doomed))
      .returning({ id: outboxEvents.id });
    return rows.length;
  });
}

/**
 * Retensi `outbox_events`: baris terbit dibuang setelah 7 hari, baris
 * dead-letter setelah 30 hari. Baris yang BELUM terbit tidak pernah
 * disentuh — itu pekerjaan yang belum selesai, bukan sampah.
 *
 * Dua jalur dipisah karena artinya berbeda, dan satu `DELETE` gabungan
 * akan menyulitkan operator memahami mana yang terhapus saat angkanya
 * dilaporkan.
 */
export async function pruneOutboxEvents(
  db: Database,
  opts: {
    publishedDays?: number;
    deadLetterDays?: number;
    now?: Date;
    batchSize?: number;
  } = {},
): Promise<OutboxPruneResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? OUTBOX_PRUNE_BATCH_SIZE;
  const publishedDays = opts.publishedDays ?? OUTBOX_PUBLISHED_RETENTION_DAYS;
  const deadLetterDays =
    opts.deadLetterDays ?? OUTBOX_DEAD_LETTER_RETENTION_DAYS;
  const publishedCutoff = new Date(now.getTime() - publishedDays * 86_400_000);
  const deadCutoff = new Date(now.getTime() - deadLetterDays * 86_400_000);

  let publishedDeleted = 0;
  for (;;) {
    const deleted = await deleteOutboxBatch(
      db,
      and(
        isNotNull(outboxEvents.publishedAt),
        // Baris dead-letter punya published_at NULL, tetapi penjaga ini
        // membuat kedua jalur tidak mungkin saling memakan baris yang
        // sama bila suatu saat penandaan berubah.
        isNull(outboxEvents.deadLetteredAt),
        lt(outboxEvents.publishedAt, publishedCutoff),
      ),
      batchSize,
    );
    publishedDeleted += deleted;
    if (deleted < batchSize) break;
  }

  let deadLetterDeleted = 0;
  for (;;) {
    const deleted = await deleteOutboxBatch(
      db,
      and(
        isNotNull(outboxEvents.deadLetteredAt),
        lt(outboxEvents.deadLetteredAt, deadCutoff),
      ),
      batchSize,
    );
    deadLetterDeleted += deleted;
    if (deleted < batchSize) break;
  }

  return { publishedDeleted, deadLetterDeleted };
}
