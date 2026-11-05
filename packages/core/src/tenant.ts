import { sql } from "drizzle-orm";

/**
 * Konteks tenant yang diteruskan secara eksplisit ke seluruh service/repo
 * (RANCANGAN §2 prinsip 3 & §3: tidak ada query tanpa tenantId).
 */
export interface TenantContext {
  tenantId: string;
  /** User yang sedang bertindak (bila ada; kosong untuk job/agent sistem). */
  userId?: string;
  /** Role member dalam tenant ini: owner | admin | agent | viewer. */
  role?: string;
}

/** Bentuk minimal transaksi Drizzle yang dibutuhkan helper ini. */
export interface TenantTx {
  execute: (query: unknown) => Promise<unknown>;
}

/** Bentuk minimal database Drizzle (node-postgres / pglite / dsb). */
export interface TenantDb {
  transaction: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
}

/**
 * Menjalankan `fn` di dalam transaksi dengan konteks tenant aktif untuk
 * Row Level Security: `app.tenant_id` di-set secara transaction-local lewat
 * `set_config(..., true)` (setara SET LOCAL, dan aman terhadap parameter
 * binding — SET biasa tidak menerima parameter di prepared statement).
 *
 * Policy RLS di packages/db membaca nilai ini lewat
 * `current_setting('app.tenant_id', true)`.
 *
 * Contoh:
 *   const rows = await withTenant(db, ctx.tenantId, (tx) =>
 *     tx.select().from(contacts),
 *   );
 */
export async function withTenant<T>(
  db: TenantDb,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new Error("withTenant: tenantId wajib diisi");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
