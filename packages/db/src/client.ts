import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index";

export type Database = NodePgDatabase<typeof schema>;

export interface CreateDbResult {
  db: Database;
  pool: Pool;
}

/**
 * Membuat koneksi PostgreSQL (node-postgres) + Drizzle.
 *
 * PENTING soal RLS: koneksi aplikasi untuk request tenant harus memakai role
 * NON-superuser dan BUKAN pemilik tabel, supaya Row Level Security benar-benar
 * berlaku; setiap transaksi tenant wajib diawali dengan
 * `set_config('app.tenant_id', <tenantId>, true)` — gunakan helper
 * `withTenant` dari @sahabat-kreator/core. Lihat README paket ini.
 */
export function createDb(connectionString: string): CreateDbResult {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
