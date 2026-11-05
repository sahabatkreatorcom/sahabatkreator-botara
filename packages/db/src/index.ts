/**
 * @sahabat-kreator/db — Drizzle schema, migrasi, dan client PostgreSQL.
 * Pola isolasi tenant: Row Level Security + `app.tenant_id` per transaksi
 * (helper `withTenant` ada di @sahabat-kreator/core). Lihat README paket ini.
 */
export * from "./schema/index";
export { createDb, type Database, type CreateDbResult } from "./client";
