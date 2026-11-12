import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { contacts, conversations } from "./inbox";

/**
 * Kelompok Janji Temu & Google Calendar (Fase 13G):
 * - appointment_services        : layanan janji per tenant (nama,
 *                                 durasi menit, deskripsi opsional,
 *                                 flag aktif). Durasi adalah satuan
 *                                 grid slot mesin slot inti.
 * - appointment_settings        : pengaturan janji per tenant (SATU
 *                                 baris per tenant): zona waktu IANA
 *                                 acuan semua hitungan slot (default
 *                                 Asia/Jakarta) + lead time minimum.
 * - appointment_availability    : jendela ketersediaan mingguan —
 *                                 weekday (0=Minggu..6=Sabtu, konvensi
 *                                 JS getDay) + jam dinding "HH:mm"
 *                                 dalam zona janji tenant. Jam disimpan
 *                                 varchar agar aritmetika jam-dinding
 *                                 tetap naif-zona (konversi ke instan
 *                                 UTC hanya terjadi di mesin slot core
 *                                 lewat Intl); format ditegakkan CHECK.
 * - bookings                    : booking terkonfirmasi/dibatalkan.
 *                                 Anti tabrakan di lapisan data:
 *                                 constraint EKSKLUSI GiST (blok kustom
 *                                 [K-13G] di migrasi) menolak dua
 *                                 booking `confirmed` bertumpang tindih
 *                                 pada tenant yang sama — batal
 *                                 membebaskan rentangnya.
 * - google_calendar_connections : koneksi Google Calendar per tenant
 *                                 (SATU baris per tenant): token OAuth
 *                                 TERENKRIPSI envelope `v1:` AES-256-GCM
 *                                 (helper kredensial channel Fase 6A,
 *                                 secret env CHANNEL_TOKEN_SECRET),
 *                                 kalender tujuan event, email akun.
 *
 * Aturan NOT NULL (instruksi user 2026-11-03): field wajib semantik
 * NOT NULL. Nullable hanya yang genuin kondisional: deskripsi layanan
 * (opsional dari operator), conversation_id booking (booking dashboard
 * tidak lahir dari percakapan), google_event_id (belum sinkron / tidak
 * terhubung), google_sync_error (hanya ada bila sinkron gagal),
 * cancelled_at (hanya ada bila booking dibatalkan), refresh token
 * Google (Google boleh tidak menerbitkannya ulang pada consent ulang),
 * account_email (diketahui sesudah profil terbaca; baris dibuat saat
 * token pertama tersimpan sehingga secara praktik terisi, tetapi
 * skema tidak memaksakannya sebelum profil dibaca).
 * Semua tabel tenant-scoped: tenant_id + index, dilindungi RLS
 * tenant_isolation (blok [K-13G] di migrasi fase ini).
 */

export const bookingStatusEnum = pgEnum("booking_status", [
  "confirmed",
  "cancelled",
]);

/** Keadaan sinkron Google satu booking — lihat kontrak (Fase 13G). */
export const bookingGoogleSyncStatusEnum = pgEnum(
  "booking_google_sync_status",
  ["not_connected", "pending", "synced", "failed"],
);

export const appointmentServices = pgTable(
  "appointment_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Nama tampil layanan, mis. "Konsultasi 30 Menit". */
    name: varchar("name", { length: 255 }).notNull(),
    /** Deskripsi opsional untuk operator; NULL = tidak diisi. */
    description: text("description"),
    /** Durasi layanan dalam menit = langkah grid slot. */
    durationMinutes: integer("duration_minutes").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("appointment_services_tenant_id_idx").on(t.tenantId),
    index("appointment_services_tenant_active_idx").on(t.tenantId, t.isActive),
    check(
      "appointment_services_duration_positive",
      sql`${t.durationMinutes} > 0`,
    ),
  ],
);

export const appointmentSettings = pgTable("appointment_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /**
   * Zona IANA acuan SEMUA hitungan slot tenant (jendela mingguan,
   * render daftar slot chat & dashboard). Bawaan segmen pertama
   * (kreator Indonesia): Asia/Jakarta.
   */
  timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Jakarta"),
  /** Lead time minimum: slot harus mulai ≥ sekarang + nilai ini (menit). */
  minLeadMinutes: integer("min_lead_minutes").notNull().default(120),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const appointmentAvailability = pgTable(
  "appointment_availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 0 = Minggu … 6 = Sabtu (konvensi JS getDay / Intl weekday). */
    weekday: integer("weekday").notNull(),
    /** Jam dinding "HH:mm" (zona janji tenant) — awal jendela inklusif. */
    startTime: varchar("start_time", { length: 5 }).notNull(),
    /** Jam dinding "HH:mm" (zona janji tenant) — akhir jendela eksklusif. */
    endTime: varchar("end_time", { length: 5 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("appointment_availability_tenant_id_idx").on(t.tenantId),
    index("appointment_availability_tenant_weekday_idx").on(
      t.tenantId,
      t.weekday,
    ),
    check(
      "appointment_availability_weekday_range",
      sql`${t.weekday} >= 0 AND ${t.weekday} <= 6`,
    ),
    check(
      "appointment_availability_start_format",
      sql`${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      "appointment_availability_end_format",
      sql`${t.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check(
      "appointment_availability_end_after_start",
      sql`${t.endTime} > ${t.startTime}`,
    ),
  ],
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Layanan yang dipesan; layanan terhapus membawa booking-nya (riwayat janji tidak berdiri tanpa layanannya). */
    serviceId: uuid("service_id")
      .notNull()
      .references(() => appointmentServices.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Percakapan asal untuk booking flow; NULL untuk booking dashboard. */
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    /** Instan mulai/selesai (UTC) — hasil konversi mesin slot dari jam dinding zona janji. */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: bookingStatusEnum("status").notNull().default("confirmed"),
    /** 'flow' (node book_appointment) atau 'dashboard' (operator). */
    source: varchar("source", { length: 16 }).notNull(),
    /** Id event Google Calendar; NULL sampai sinkron berhasil / bila tidak terhubung. */
    googleEventId: varchar("google_event_id", { length: 255 }),
    googleSyncStatus: bookingGoogleSyncStatusEnum("google_sync_status")
      .notNull()
      .default("not_connected"),
    /** Ringkasan error sinkron terakhir (kode + pesan singkat, tanpa kredensial). */
    googleSyncError: varchar("google_sync_error", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Waktu pembatalan; NULL selama booking belum pernah dibatalkan. */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    index("bookings_tenant_id_idx").on(t.tenantId),
    index("bookings_tenant_starts_idx").on(t.tenantId, t.startsAt),
    index("bookings_contact_idx").on(t.contactId),
    index("bookings_service_idx").on(t.serviceId),
    check("bookings_end_after_start", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "bookings_source_valid",
      sql`${t.source} IN ('flow', 'dashboard')`,
    ),
  ],
);

export const googleCalendarConnections = pgTable(
  "google_calendar_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Email akun Google terhubung (dari profil token); lihat catatan nullable di header. */
    accountEmail: varchar("account_email", { length: 320 }),
    /** Kalender tujuan event (id Google, mis. "primary" atau id kalender lain). */
    calendarId: varchar("calendar_id", { length: 255 })
      .notNull()
      .default("primary"),
    /** Envelope terenkripsi `v1:` — token mentah TIDAK PERNAH tersimpan. */
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    /** Envelope terenkripsi `v1:`; NULL bila Google tidak menerbitkan refresh token pada consent ini. */
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    /** Kedaluwarsa akses token berjalan (untuk keputusan refresh). */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true })
      .notNull(),
    /** Scope OAuth yang diberikan (string spasi-terpisah dari Google). */
    scopes: text("scopes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("google_calendar_connections_tenant_unique").on(t.tenantId)],
);

/** Layanan Google pemilik satu baris `google_connections`. */
export const googleServiceEnum = pgEnum("google_service", [
  "calendar",
  "youtube",
  "business",
  // G16 (migrasi 0039): layanan 'ads' — consent OAuth Google Ads
  // (scope adwords) untuk pengiriman konversi dari flow.
  "ads",
  // G17 (migrasi 0041): layanan 'sheets' — consent Google Sheets
  // (scope spreadsheets) untuk node flow append_sheet_row.
  "sheets",
]);

/**
 * Koneksi Google PER LAYANAN per tenant (gelombang Pemisahan Google,
 * migrasi 0023) — SATU baris per (tenant, layanan): calendar /
 * youtube / business masing-masing hasil consent OAuth-nya sendiri
 * dengan klien OAuth proyek Cloud-nya sendiri, agar billing, kuota,
 * dan persetujuan API tiap layanan benar-benar terpisah (insiden
 * pemicu: API yang belum aktif di proyek bersama menjatuhkan
 * Calendar + sinkron YouTube/GBP bersama-sama).
 *
 * Bentuk kolom meniru `google_calendar_connections` persis (token
 * TERENKRIPSI envelope `v1:` yang sama, secret env
 * CHANNEL_TOKEN_SECRET) + kolom `service` dan unik (tenant, service).
 * `calendar_id` hanya bermakna untuk baris calendar (kalender tujuan
 * event janji temu); baris youtube/business mengabaikannya.
 * `google_calendar_connections` tetap ada sebagai arsip koneksi
 * gabungan lama — migrasi 0023 menyemai tabel ini darinya dan semua
 * pembaca/penulis beralih ke sini.
 */
export const googleConnections = pgTable(
  "google_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Layanan pemilik koneksi ini; token HANYA sah untuk layanan itu. */
    service: googleServiceEnum("service").notNull(),
    /** Email akun Google terhubung (dari profil token); nullable seperti tabel lama. */
    accountEmail: varchar("account_email", { length: 320 }),
    /** Kalender tujuan event — hanya bermakna untuk service='calendar'. */
    calendarId: varchar("calendar_id", { length: 255 })
      .notNull()
      .default("primary"),
    /** Envelope terenkripsi `v1:` — token mentah TIDAK PERNAH tersimpan. */
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    /** Envelope terenkripsi `v1:`; NULL bila Google tidak menerbitkan refresh token pada consent ini. */
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    /** Kedaluwarsa akses token berjalan (untuk keputusan refresh per layanan). */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true })
      .notNull(),
    /** Scope OAuth yang diberikan consent layanan ini (string spasi-terpisah dari Google). */
    scopes: text("scopes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("google_connections_tenant_service_unique").on(
      t.tenantId,
      t.service,
    ),
    index("google_connections_tenant_id_idx").on(t.tenantId),
  ],
);

export type AppointmentServiceRow = typeof appointmentServices.$inferSelect;
export type AppointmentSettingRow = typeof appointmentSettings.$inferSelect;
export type AppointmentAvailabilityRow =
  typeof appointmentAvailability.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;
export type GoogleCalendarConnectionRow =
  typeof googleCalendarConnections.$inferSelect;
export type GoogleConnectionRow = typeof googleConnections.$inferSelect;
