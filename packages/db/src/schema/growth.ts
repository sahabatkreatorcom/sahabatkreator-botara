import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./identity";
import { channelAccounts } from "./channels";
import { contacts } from "./inbox";

/**
 * Kelompok Growth Tools (Fase 13B):
 * - growth_links        : tautan publik per workspace — `single` (satu
 *                         channel) atau `picker` (halaman arahan memilih
 *                         channel). `slug` unik GLOBAL karena URL-nya
 *                         publik di bawah /go/:slug tanpa konteks tenant.
 * - growth_link_events  : jejak mentah analitik (click / picker_view /
 *                         conversion). Angka analitik DITURUNKAN dari
 *                         event ini — tidak ada kolom penghitung yang
 *                         bisa menyimpang dari kenyataan.
 *
 * Aturan NOT NULL (instruksi user 2026-11-03): kolom yang wajib secara
 * semantik NOT NULL; nullable hanya untuk keadaan yang memang
 * kondisional — di sini: `channel_account_id` (hanya untuk kind
 * 'single'; untuk 'picker' wajib NULL dan himpunannya hidup di
 * `picker_channel_ids`, ditegakkan CHECK di bawah), `auto_tag` &
 * `prefill_text` (konfigurasi opsional dari pengguna), `created_by`
 * (penulis bisa terhapus → SET NULL), dan `contact_id` pada event
 * (klik anonim memang tanpa kontak).
 * Semua tabel tenant-scoped: tenant_id + index, dilindungi RLS —
 * tenant_isolation untuk keduanya + lengan sempit SELECT-only
 * `growth_link_public_lookup` pada growth_links (resolusi slug publik
 * tanpa konteks tenant, pola webchat_site_key 0006) di migrasi.
 */

export const growthLinkKindEnum = pgEnum("growth_link_kind", [
  "single",
  "picker",
]);

export const growthLinkEventKindEnum = pgEnum("growth_link_event_kind", [
  "click",
  "picker_view",
  "conversion",
]);

export const growthLinks = pgTable(
  "growth_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: growthLinkKindEnum("kind").notNull(),
    /** Label tampil untuk pemilik workspace (daftar + analitik). */
    label: varchar("label", { length: 128 }).notNull(),
    /** Segmen URL publik /go/<slug> — unik GLOBAL, url-safe. */
    slug: varchar("slug", { length: 64 }).notNull(),
    /**
     * Akun channel tujuan untuk kind 'single'. Wajib terisi untuk
     * single dan wajib NULL untuk picker (CHECK di bawah) — picker
     * memakai `pickerChannelIds`.
     */
    channelAccountId: uuid("channel_account_id").references(
      () => channelAccounts.id,
      { onDelete: "cascade" },
    ),
    /**
     * Himpunan akun channel untuk kind 'picker' (id akun milik tenant
     * yang sama, min 2 — divalidasi layanan + CHECK panjang minimum).
     * Untuk 'single' selalu array kosong. NOT NULL dengan default []
     * (aturan user 2026-11-03: keadaan "bukan picker" diwakili array
     * kosong, bukan NULL).
     */
    pickerChannelIds: jsonb("picker_channel_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Tag yang ditempelkan ke kontak hasil atribusi; NULL = tanpa tag. */
    autoTag: varchar("auto_tag", { length: 64 }),
    /**
     * Teks awal yang disiapkan untuk pengunjung (WhatsApp `?text=`).
     * NULL = tanpa teks awal. (Telegram tidak punya mekanisme teks
     * awal — payload start-nya adalah slug itu sendiri.)
     */
    prefillText: varchar("prefill_text", { length: 1000 }),
    isActive: boolean("is_active").notNull().default(true),
    /** Pembuat tautan; SET NULL bila user-nya terhapus (jejak tetap). */
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("growth_links_slug_unique").on(t.slug),
    index("growth_links_tenant_id_idx").on(t.tenantId),
    check(
      "growth_links_kind_channel_check",
      sql`(${t.kind} = 'single' AND ${t.channelAccountId} IS NOT NULL AND jsonb_array_length(${t.pickerChannelIds}) = 0)
        OR (${t.kind} = 'picker' AND ${t.channelAccountId} IS NULL AND jsonb_array_length(${t.pickerChannelIds}) >= 2)`,
    ),
  ],
);

export const growthLinkEvents = pgTable(
  "growth_link_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    growthLinkId: uuid("growth_link_id")
      .notNull()
      .references(() => growthLinks.id, { onDelete: "cascade" }),
    kind: growthLinkEventKindEnum("kind").notNull(),
    /**
     * Kontak yang teratribusi — hanya untuk event `conversion`.
     * NULL untuk click/picker_view (anonim). SET NULL (bukan cascade)
     * agar penghapusan kontak tidak menghapus jejak analitik.
     */
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("growth_link_events_tenant_id_idx").on(t.tenantId),
    index("growth_link_events_link_kind_idx").on(t.growthLinkId, t.kind),
    index("growth_link_events_contact_id_idx").on(t.contactId),
    // Konversi tepat SEKALI per kontak per tautan (dijaga data, bukan
    // hanya logika layanan): index unik parsial khusus conversion
    // yang kontaknya terisi.
    uniqueIndex("growth_link_events_conversion_unique")
      .on(t.growthLinkId, t.contactId)
      .where(sql`${t.kind} = 'conversion' AND ${t.contactId} IS NOT NULL`),
  ],
);

export type GrowthLink = typeof growthLinks.$inferSelect;
export type NewGrowthLink = typeof growthLinks.$inferInsert;
export type GrowthLinkEvent = typeof growthLinkEvents.$inferSelect;
export type NewGrowthLinkEvent = typeof growthLinkEvents.$inferInsert;
