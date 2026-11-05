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
    /** Byte foto mentah (JPEG/PNG dari Bot API). */
    data: bytea("data").notNull(),
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
  ],
);

export type ProfilePhoto = typeof profilePhotos.$inferSelect;
export type NewProfilePhoto = typeof profilePhotos.$inferInsert;
