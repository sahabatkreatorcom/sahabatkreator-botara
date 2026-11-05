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
 * mengambil baris yang sama. Bila handler gagal, transaksi rollback: event
 * tetap belum ter-publish dan akan dicoba lagi pada siklus berikutnya —
 * karena itu handler WAJIB idempoten (untuk `message.received`, idempotensi
 * dijamin jobId BullMQ yang diturunkan dari id event; lihat worker).
 */

export interface UnpublishedOutboxEvent {
  id: string;
  tenantId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type OutboxRelayHandler = (
  tx: DbTx,
  event: UnpublishedOutboxEvent,
) => Promise<void>;

/**
 * Menjalankan satu siklus relay: klaim ≤ `limit` event tertua yang belum
 * ter-publish, panggil `handler` untuk masing-masing, lalu tandai semuanya
 * published dalam transaksi yang sama. Mengembalikan jumlah event yang
 * diproses. Melempar bila handler melempar (seluruh siklus dibatalkan).
 */
export async function relayUnpublishedOutboxEvents(
  db: Database,
  handler: OutboxRelayHandler,
  limit = 25,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_relay', 'outbox', true)`);
    const result = await tx.execute(sql`
      SELECT id, tenant_id, type, payload, created_at
      FROM outbox_events
      WHERE published_at IS NULL
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
        }>;
      }
    ).rows;
    if (rows.length === 0) return 0;

    for (const row of rows) {
      await handler(tx as unknown as DbTx, {
        id: row.id,
        tenantId: row.tenant_id,
        type: row.type,
        payload: row.payload ?? {},
        createdAt: new Date(row.created_at),
      });
    }

    const ids = rows.map((r) => r.id);
    await tx.execute(sql`
      UPDATE outbox_events
      SET published_at = now()
      WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    return rows.length;
  });
}
