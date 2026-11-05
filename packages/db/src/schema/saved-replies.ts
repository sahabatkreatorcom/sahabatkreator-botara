import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./identity";

/**
 * Saved Replies / macro balasan tersimpan (Fase 9A):
 * - saved_replies : templat balasan milik workspace yang disisipkan ke
 *                   composer Inbox lewat pemilih `/`. `body` boleh
 *                   memuat placeholder {name} — substitusinya dilakukan
 *                   KLIEN saat penyisipan (WYSIWYG: agen melihat teks
 *                   final sebelum mengirim), BUKAN oleh pipeline render
 *                   otomatis, karena balasan manual adalah teks harfiah.
 *                   Kepemilikan: `created_by_user_id` menentukan siapa
 *                   boleh mengedit/menghapus (pembuat, atau owner/admin
 *                   workspace) — ditegakkan di core, bukan di UI.
 * Tabel tenant-scoped: tenant_id + index, dilindungi RLS (migrasi 0033).
 */
export const savedReplies = pgTable(
  "saved_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Judul internal macro (yang dicari di pemilih `/`). */
    title: varchar("title", { length: 255 }).notNull(),
    /** Isi balasan; boleh memuat {name} (diganti klien saat disisipkan). */
    body: text("body").notNull(),
    /** User pembuat — dasar gerbang edit/hapus; SET NULL bila user hilang. */
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
  (t) => [index("saved_replies_tenant_id_idx").on(t.tenantId)],
);

export type SavedReply = typeof savedReplies.$inferSelect;
