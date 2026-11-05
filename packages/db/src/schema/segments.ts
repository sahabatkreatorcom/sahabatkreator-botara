import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./identity";

/**
 * Kelompok Segmentasi & Opt-in (Fase 13C):
 * - segments               : definisi segmen audiens per workspace —
 *                            { match: "all"|"any", conditions: [...] }
 *                            dievaluasi SATU evaluator di core
 *                            (@sahabat-kreator/core segments.ts) untuk
 *                            daftar kontak, pratinjau broadcast, dan
 *                            materialisasi penerima broadcast.
 * - tenant_opt_in_settings : pengaturan mesin opt-in per tenant (satu
 *                            baris per tenant, dibuat malas saat
 *                            pertama dibaca/diubah): kata kunci opt-in,
 *                            teks konfirmasi opt-in (opsional), dan
 *                            kata kunci opt-out TAMBAHAN di atas kata
 *                            bawaan sistem (konstanta core).
 *
 * Aturan NOT NULL (instruksi user 2026-11-03): field wajib semantik
 * NOT NULL — name & definition segmen, daftar kata kunci (array
 * kosong sah, bukan NULL). Nullable hanya yang genuin kondisional:
 * `opt_in_confirmation_text` (kosong = opt-in diam, tanpa balasan)
 * dan `created_by` (penulis bisa terhapus → SET NULL).
 * Kedua tabel tenant-scoped: tenant_id + index, dilindungi RLS
 * tenant_isolation (blok [K-13C] di migrasi fase ini).
 */

export interface SegmentDefinitionData {
  match: "all" | "any";
  conditions: Array<Record<string, unknown>>;
}

export const segments = pgTable(
  "segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Nama tampil segmen untuk pemilik workspace. */
    name: varchar("name", { length: 128 }).notNull(),
    /**
     * Definisi kondisi (kontrak SegmentDefinitionSchema adalah sumber
     * kebenaran bentuknya; kolom menyimpan apa adanya).
     */
    definition: jsonb("definition").$type<SegmentDefinitionData>().notNull(),
    /** Pembuat segmen; SET NULL bila user-nya terhapus (jejak tetap). */
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
  (t) => [index("segments_tenant_id_idx").on(t.tenantId)],
);

export const tenantOptInSettings = pgTable(
  "tenant_opt_in_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * Kata kunci opt-in tenant (pencocokan kata persis, ternormalisasi
     * seperti matcher keyword automation). Bawaan:
     * ["ikut","mau ikut","join","optin"] — diterapkan core bila baris
     * belum ada. Array kosong = penangkapan opt-in nonaktif.
     */
    optInKeywords: jsonb("opt_in_keywords").$type<string[]>().notNull(),
    /**
     * Teks balasan konfirmasi opt-in; NULL/kosong = opt-in diam
     * (tanpa balasan). Dikirim SEKALI per transisi masuk ke opted_in
     * lewat jalur keluar biasa.
     */
    optInConfirmationText: varchar("opt_in_confirmation_text", {
      length: 1000,
    }),
    /**
     * Kata kunci opt-out TAMBAHAN tenant, digabung di atas kata
     * bawaan sistem (STOP/BERHENTI/UNSUBSCRIBE/… di core). Array
     * kosong sah.
     */
    optOutExtraKeywords: jsonb("opt_out_extra_keywords")
      .$type<string[]>()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("tenant_opt_in_settings_tenant_id_idx").on(t.tenantId)],
);

export type Segment = typeof segments.$inferSelect;
export type TenantOptInSetting = typeof tenantOptInSettings.$inferSelect;
