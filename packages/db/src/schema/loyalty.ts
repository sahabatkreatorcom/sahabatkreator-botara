import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contacts } from "./inbox";
import { users } from "./identity";
import { tenants } from "./tenants";

/**
 * Gamifikasi / loyalitas (G18 butir 4).
 *
 * `contact_point_ledger` adalah BUKU BESAR poin per kontak: saldo
 * adalah SUM(points) atas baris-baris kontak itu — tidak ada kolom
 * saldo yang bisa menyimpang dari riwayat. Dua sumber baris:
 * - `flow_award`: pemberian dari node flow `award_points`,
 *   IDEMPOTEN per run+node lewat `event_id` deterministik +
 *   unique (tenant_id, event_id) — pola G16/G14.
 * - `manual`: penyesuaian oleh tim (boleh negatif, koreksi),
 *   `created_by_user_id` mencatat siapa; event_id NULL.
 *
 * `loyalty_levels` adalah ambang level yang diatur tenant
 * (nama + poin minimum); level kontak diturunkan saat baca dari
 * saldo (level tertinggi yang ambangnya terpenuhi), tidak disimpan.
 */
export const loyaltyLevels = pgTable(
  "loyalty_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    minPoints: integer("min_points").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("loyalty_levels_tenant_min_points_unique").on(
      t.tenantId,
      t.minPoints,
    ),
    index("loyalty_levels_tenant_id_idx").on(t.tenantId),
    check("loyalty_levels_min_points_nonneg", sql`${t.minPoints} >= 0`),
  ],
);

export const contactPointLedger = pgTable(
  "contact_point_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Delta poin baris ini (pemberian flow > 0; manual boleh ±). */
    points: integer("points").notNull(),
    source: varchar("source", { length: 16 }).notNull(),
    /**
     * Id peristiwa deterministik pemberian flow
     * (`evt_<sha256(runId:nodeId)>`) — jangkar idempotensi.
     * NULL untuk penyesuaian manual.
     */
    eventId: varchar("event_id", { length: 80 }),
    runId: uuid("run_id"),
    nodeId: varchar("node_id", { length: 128 }),
    /** Catatan bebas (label pemberian / alasan penyesuaian). */
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("contact_point_ledger_tenant_event_unique")
      .on(t.tenantId, t.eventId)
      .where(sql`${t.eventId} IS NOT NULL`),
    index("contact_point_ledger_contact_idx").on(t.tenantId, t.contactId),
    index("contact_point_ledger_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    check(
      "contact_point_ledger_source_valid",
      sql`${t.source} IN ('flow_award', 'manual')`,
    ),
    check("contact_point_ledger_points_nonzero", sql`${t.points} <> 0`),
  ],
);

export type LoyaltyLevel = typeof loyaltyLevels.$inferSelect;
export type ContactPointLedgerEntry = typeof contactPointLedger.$inferSelect;
