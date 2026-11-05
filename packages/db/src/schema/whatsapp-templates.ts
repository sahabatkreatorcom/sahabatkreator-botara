import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { channelAccounts } from "./channels";

/**
 * Template pesan WhatsApp resmi Meta (Fase 10A) — tabel CERMIN lokal
 * per akun WhatsApp:
 * - Baris lahir dari sinkronisasi `GET /{waba-id}/message_templates`
 *   (sumber kebenaran tetap Meta; status APPROVED/PENDING/REJECTED
 *   adalah status Meta saat sinkron terakhir) atau dari pembuatan
 *   lewat dashboard yang diteruskan ke Meta (status awal dari respons
 *   Meta, biasanya PENDING).
 * - `components` menyimpan komponen apa adanya dari Meta (HEADER /
 *   BODY / FOOTER / BUTTONS) — bentuk mentah provider, bukan skema
 *   kita; `body_text` + `variable_count` adalah turunan lokal dari
 *   komponen BODY untuk pratinjau & pemetaan variabel broadcast
 *   (jumlah variabel = indeks {{n}} terbesar di teks BODY).
 * - Broadcast WhatsApp HANYA boleh memakai baris berstatus APPROVED
 *   (ditegakkan core saat buat/jadwalkan/dispatch — status bisa
 *   berubah di Meta di antara itu, jadi dispatch memeriksa ulang).
 * Semua tenant-scoped: tenant_id + index, dilindungi RLS (migrasi 0036).
 */
export const whatsappTemplates = pgTable(
  "whatsapp_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Akun WhatsApp pemilik (WABA-nya = channel_accounts.parent_external_id). */
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    /** Id template di Meta (`message_templates` id); null hanya bila Meta tidak mengembalikannya. */
    metaTemplateId: varchar("meta_template_id", { length: 255 }),
    /** Nama template di Meta (huruf kecil + garis bawah, unik per WABA per bahasa bersama language). */
    name: varchar("name", { length: 512 }).notNull(),
    /** Kode bahasa template di Meta, mis. 'id', 'en_US'. */
    language: varchar("language", { length: 32 }).notNull(),
    /** Kategori Meta: UTILITY | MARKETING | AUTHENTICATION. */
    category: varchar("category", { length: 32 }).notNull(),
    /** Status persetujuan Meta: APPROVED | PENDING | REJECTED (atau status lain apa adanya). */
    status: varchar("status", { length: 32 }).notNull(),
    /** Komponen template apa adanya dari Meta (array HEADER/BODY/FOOTER/BUTTONS). */
    components: jsonb("components").notNull().default([]),
    /** Teks komponen BODY (turunan lokal untuk pratinjau); null bila komponen tidak terbaca. */
    bodyText: text("body_text"),
    /** Jumlah variabel BODY = indeks {{n}} terbesar pada body_text (0 = tanpa variabel). */
    variableCount: integer("variable_count").notNull().default(0),
    /** Kapan baris ini terakhir diselaraskan dengan Meta (sinkronisasi / pembuatan). */
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("whatsapp_templates_account_name_language_unique").on(
      t.channelAccountId,
      t.name,
      t.language,
    ),
    index("whatsapp_templates_tenant_id_idx").on(t.tenantId),
    index("whatsapp_templates_channel_account_id_idx").on(t.channelAccountId),
  ],
);

export type WhatsAppTemplate = typeof whatsappTemplates.$inferSelect;
export type NewWhatsAppTemplate = typeof whatsappTemplates.$inferInsert;
