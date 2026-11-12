import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./identity";
import { tenants } from "./tenants";

/**
 * Jadwal kerja mingguan (G15) — bentuk JSON yang disimpan di
 * `member_work_schedules.week` dan `tenants.default_work_schedule`.
 *
 * - Kunci `days` adalah nomor hari JS di zona waktu jadwal itu
 *   sendiri: "0" = Minggu … "6" = Sabtu.
 * - Tiap hari memuat daftar rentang {start, end} format "HH:MM" 24 jam
 *   waktu dinding zona itu; start < end selalu (rentang melewati
 *   tengah malam TIDAK didukung — dinyatakan jujur di UI).
 * - Hari tanpa kunci = hari libur. Jadwal `{ days: {} }` = tidak ada
 *   jam kerja sama sekali (jam SLA tidak pernah berjalan).
 *
 * Validasi bentuk ditegakkan kontrak zod (packages/contracts/sla.ts);
 * kolom jsonb di sini hanya membawa tipenya.
 */
export interface WorkRange {
  start: string;
  end: string;
}

export interface WorkSchedule {
  days: Record<string, WorkRange[]>;
}

/**
 * Jadwal kerja per anggota tim (G15). Satu baris per (tenant, user);
 * tidak ada baris = anggota tidak punya jadwal pribadi → SLA memakai
 * jadwal bawaan tenant (`tenants.default_work_schedule`), dan bila itu
 * pun kosong jam SLA tidak berjalan untuk jendelanya (lihat core/sla.ts).
 *
 * `timezone` NULL = ikut zona waktu tenant. Zona disimpan per baris
 * (bukan per rentang) karena satu anggota bekerja dari satu zona.
 */
export const memberWorkSchedules = pgTable(
  "member_work_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    timezone: varchar("timezone", { length: 64 }),
    week: jsonb("week").$type<WorkSchedule>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("member_work_schedules_tenant_id_idx").on(t.tenantId),
    uniqueIndex("member_work_schedules_tenant_user_unique").on(
      t.tenantId,
      t.userId,
    ),
  ],
);
