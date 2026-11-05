import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "@sahabat-kreator/db";
import * as schema from "@sahabat-kreator/db/schema";

/**
 * Database sungguhan untuk test, tanpa server Postgres.
 *
 * PGlite adalah Postgres asli yang dikompilasi ke WASM. Artinya test di
 * sini menjalankan SQL dan constraint yang SAMA dengan produksi —
 * exclusion constraint anti-double-booking, partial unique index
 * keranjang terbuka, dan tipe `timestamptz` semuanya berperilaku nyata.
 * Memalsukan lapisan database akan membuat test ini lulus sementara
 * produksi gagal, yang justru kebalikan dari gunanya.
 *
 * Yang TIDAK diuji di sini: RLS. Koneksi test memakai peran pemilik
 * tabel, dan RLS tidak berlaku bagi pemilik. Isolasi tenant punya
 * test-nya sendiri di `packages/db/src/rls.test.ts` yang menyamar
 * sebagai peran non-pemilik.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "..", "..", "db", "migrations");

export const TEST_PLAN_ID = "99999999-9999-4999-8999-999999999999";
export const TEST_TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_TENANT_B_ID = "22222222-2222-4222-8222-222222222222";

export interface TestDb {
  /**
   * Drizzle di atas PGlite. Tipe aslinya `PgliteDatabase`, sedangkan
   * kode aplikasi bertipe `NodePgDatabase`; keduanya mengekspos API
   * Drizzle yang sama, jadi cast di sini memusatkan satu-satunya
   * perbedaan tipe ke satu tempat, bukan di setiap test.
   */
  db: Database;
  pglite: PGlite;
  close: () => Promise<void>;
}

/**
 * Menyalakan PGlite, menjalankan SELURUH rantai migrasi dari nol, lalu
 * menyemai satu plan dan dua tenant.
 *
 * Migrasi dibaca dari `packages/db/migrations` — bukan disalin ke test —
 * supaya test gagal bila migrasi rusak, dan supaya tidak ada skema
 * "versi test" yang bisa menyimpang dari produksi.
 */
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite({ extensions: { vector, btree_gist } });

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await pglite.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }

  await pglite.query(
    `INSERT INTO plans (id, code, name, limits) VALUES ($1, 'test', 'Test', '{}'::jsonb)`,
    [TEST_PLAN_ID],
  );
  await pglite.query(
    `INSERT INTO tenants (id, name, slug) VALUES
       ($1, 'Tenant Uji', 'tenant-uji'),
       ($2, 'Tenant Uji B', 'tenant-uji-b')`,
    [TEST_TENANT_ID, TEST_TENANT_B_ID],
  );

  const db = drizzle(pglite, { schema }) as unknown as Database;

  return {
    db,
    pglite,
    close: async () => {
      await pglite.close();
    },
  };
}

/** Kontak minimal untuk test yang butuh kontak (keranjang, booking). */
export async function seedContact(
  pglite: PGlite,
  tenantId: string,
  opts: { id?: string; phone?: string; name?: string } = {},
): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  await pglite.query(
    `INSERT INTO contacts (id, tenant_id, phone, name) VALUES ($1, $2, $3, $4)`,
    [id, tenantId, opts.phone ?? "+628111111111", opts.name ?? "Kontak Uji"],
  );
  return id;
}

/** Produk aktif dengan harga tertentu — dipakai test keranjang/checkout. */
export async function seedProduct(
  pglite: PGlite,
  tenantId: string,
  opts: { name?: string; priceIdr: number; isActive?: boolean },
): Promise<string> {
  const id = crypto.randomUUID();
  await pglite.query(
    `INSERT INTO products (id, tenant_id, name, price_idr, is_active)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, tenantId, opts.name ?? "Produk Uji", opts.priceIdr, opts.isActive ?? true],
  );
  return id;
}
