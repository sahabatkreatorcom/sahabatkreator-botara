import type { Database } from "@sahabat-kreator/db";
import { withTenant, type TenantDb } from "./tenant";

/** Tipe transaksi Drizzle penuh (hasil `db.transaction`). */
export type DbTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Jembatan bertipe di atas `withTenant`: menjalankan `fn` dalam transaksi
 * dengan konteks RLS `app.tenant_id` terpasang, sambil memberikan transaksi
 * Drizzle penuh (select/insert/update) kepada `fn`. Semua service tenant
 * WAJIB lewat helper ini agar tidak ada query tenant-scoped tanpa konteks.
 */
export function withTenantDb<T>(
  db: Database,
  tenantId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return withTenant(db as unknown as TenantDb, tenantId, (tx) =>
    fn(tx as unknown as DbTx),
  );
}
