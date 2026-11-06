import { sql } from "drizzle-orm";
import type { Database } from "@sahabat-kreator/db";
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
