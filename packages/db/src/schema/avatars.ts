import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * Foto profil channel & kontak (Fase 6D — avatar asli Telegram).
 *
 * Satu baris per pemilik: foto bot pada akun channel Telegram
 * (`owner_type='channel_account'`, owner_id = channel_accounts.id) dan
 * foto profil pengguna Telegram pada kontak (`owner_type='contact'`,
 * owner_id = contacts.id). Byte foto disimpan LANGSUNG di DB (bytea) —
 * keputusan pragmatis yang disepakati untuk fase ini: belum ada konsumen
 * R2, ukuran foto profil kecil (dipilih ≤512px dari Bot API), dan yang
 * terpenting URL file Telegram (yang MENYEMATKAN token bot) tidak pernah
 * boleh menjadi URL publik kita. Dashboard hanya menerima URL endpoint
 * kita sendiri (`/api/tenants/:tenantId/avatars/...`), yang menyajikan
 * byte ini di balik sesi + membership.
 *
 * Pengecualian TikTok (keputusan pemilik 2026-11-12, migrasi 0024):
 * avatar akun TikTok disimpan sebagai OBJEK di Cloudflare R2
 * (`storage='r2'`, `data` NULL, `object_key` menunjuk objeknya), karena
 * URL avatar CDN TikTok adalah URL bertanda tangan yang KEDALUWARSA
 * (parameter `x-expires`) — salinan berkasnya harus tinggal di
 * penyimpanan objek milik platform sendiri. Channel lain tetap bytea.
 * Bentuk baris ditegakkan check `profile_photos_storage_shape`: tepat
 * satu dari dua bentuk yang sah. Penyajian tidak berubah: endpoint
 * avatar mengambil objek R2 di sisi server dan meneruskan bytenya, jadi
 * web tidak pernah tahu bedanya. Bila kredensial R2 di Panel Admin
 * belum terisi (atau tulis R2 gagal), avatar TikTok jatuh ke bytea
 * persis seperti channel lain — lihat core/avatars.ts.
 *
 * `owner_id` sengaja TANPA foreign key: pemiliknya polimorfik (dua tabel
 * berbeda). Kebersihan dirujuk dijaga lapisan core — purge channel (6I)
 * menghapus foto pemilik akun channel-nya, dan penghapusan tenant
 * men-cascade lewat tenant_id di sini. `etag` = SHA-256 hex byte foto,
 * dipakai endpoint penyaji untuk Cache-Control/If-None-Match (foto yang
 * sama tidak diunduh ulang browser).
 *
 * drizzle-orm 0.44 belum mengekspor kolom `bytea` bawaan untuk pg, jadi
 * kolom byte didefinisikan lewat customType dengan dataType 'bytea'
 * (driver pg & PGlite sama-sama mengembalikan Buffer/Uint8Array).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const profilePhotos = pgTable(
  "profile_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Jenis pemilik foto: 'channel_account' | 'contact'. */
    ownerType: varchar("owner_type", { length: 32 }).notNull(),
    /** Id pemilik (channel_accounts.id atau contacts.id, sesuai owner_type). */
    ownerId: uuid("owner_id").notNull(),
    contentType: varchar("content_type", { length: 128 }).notNull(),
    /**
     * Bentuk penyimpanan byte foto: 'db' (bytea di kolom `data`) atau
     * 'r2' (objek Cloudflare R2 di `object_key`, `data` NULL) — 'r2'
     * saat ini KHUSUS avatar TikTok (lihat header modul).
     */
    storage: varchar("storage", { length: 16 }).notNull().default("db"),
    /** Kunci objek R2 bila `storage='r2'`; NULL bila 'db'. */
    objectKey: varchar("object_key", { length: 512 }),
    /** Byte foto mentah (JPEG/PNG dari Bot API); NULL bila `storage='r2'`. */
    data: bytea("data"),
    /** SHA-256 hex dari `data` — ETag endpoint penyaji. */
    etag: varchar("etag", { length: 64 }).notNull(),
    /** Kapan foto ini diambil dari provider. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("profile_photos_tenant_owner_unique").on(
      t.tenantId,
      t.ownerType,
      t.ownerId,
    ),
    index("profile_photos_tenant_id_idx").on(t.tenantId),
    check(
      "profile_photos_owner_type_valid",
      sql`${t.ownerType} IN ('channel_account', 'contact')`,
    ),
    check(
      "profile_photos_storage_valid",
      sql`${t.storage} IN ('db', 'r2')`,
    ),
    check(
      "profile_photos_storage_shape",
      sql`(${t.storage} = 'db' AND ${t.data} IS NOT NULL AND ${t.objectKey} IS NULL) OR (${t.storage} = 'r2' AND ${t.data} IS NULL AND ${t.objectKey} IS NOT NULL)`,
    ),
  ],
);

export type ProfilePhoto = typeof profilePhotos.$inferSelect;
export type NewProfilePhoto = typeof profilePhotos.$inferInsert;
