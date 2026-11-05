import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index";

export type Database = NodePgDatabase<typeof schema>;

export interface CreateDbResult {
  db: Database;
  pool: Pool;
}

/** Opsi pool. Semua punya default yang aman untuk produksi. */
export interface CreateDbOptions {
  /**
   * Nama yang tampil di `pg_stat_activity.application_name`. Isi dengan
   * proses pemanggil (`sk-api`, `sk-worker`, `sk-realtime`, `sk-migrate`)
   * supaya koneksi bisa dibedakan saat mendiagnosis.
   *
   * Tanpa ini semua koneksi tampil tanpa nama — persis yang mempersulit
   * diagnosis latensi 2026-11-05: tidak bisa diketahui koneksi mana milik
   * container mana.
   */
  applicationName?: string;
  /**
   * Batas satu statement di sisi SERVER (`statement_timeout`), milidetik.
   * `0` = tanpa batas. Default 15 detik.
   */
  statementTimeoutMs?: number;
  /** Batas menunggu koneksi bebas dari pool, milidetik. Default 5 detik. */
  connectionTimeoutMillis?: number;
  /** Koneksi menganggur ditutup setelah ini, milidetik. Default 30 detik. */
  idleTimeoutMillis?: number;
  /** Jumlah koneksi maksimum per proses. Default 10. */
  max?: number;
}

/**
 * Default `statement_timeout`.
 *
 * Query dashboard yang sehat berjalan dalam satuan milidetik; 15 detik sudah
 * sangat longgar. Sebelum ini TIDAK ADA batas sama sekali: satu query yang
 * menggantung (lock, seq scan saat data tumbuh) menahan request selamanya,
 * dan setelah seluruh koneksi pool habis semua request ikut menggantung
 * tanpa error apa pun.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_MAX = 10;

/**
 * Membuat koneksi PostgreSQL (node-postgres) + Drizzle.
 *
 * PENTING soal RLS: koneksi aplikasi untuk request tenant harus memakai role
 * NON-superuser dan BUKAN pemilik tabel, supaya Row Level Security benar-benar
 * berlaku; setiap transaksi tenant wajib diawali dengan
 * `set_config('app.tenant_id', <tenantId>, true)` — gunakan helper
 * `withTenant` dari @sahabat-kreator/core. Lihat README paket ini.
 *
 * Timeout di bawah adalah jaring pengaman, bukan alat tuning: nilainya
 * dipilih jauh di atas waktu query normal sehingga yang tersentuh hanya
 * query yang memang sudah bermasalah.
 */
export function createDb(
  connectionString: string,
  options: CreateDbOptions = {},
): CreateDbResult {
  const pool = new Pool({
    connectionString,
    application_name: options.applicationName ?? "sk-app",
    statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis:
      options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    max: options.max ?? DEFAULT_POOL_MAX,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
