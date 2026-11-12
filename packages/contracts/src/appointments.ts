import { z } from "zod";

// ---------------------------------------------------------------------------
// Fase 13G — Janji temu (appointments) + sinkronisasi Google Calendar.
//
// Lapisan janji temu bekerja PENUH tanpa Google (kalender internal):
// layanan janji (durasi), jendela ketersediaan mingguan per tenant,
// pengaturan zona waktu + lead time minimum, dan booking yang lahir
// dari node flow `book_appointment` atau dibuat operator di dashboard.
// Google Calendar adalah PENINGKATAN sinkronisasi: koneksi OAuth per
// tenant (klien OAuth milik PLATFORM dari Panel Admin); event dibuat/
// dihapus mengikuti booking dan kesibukan (freebusy) Google memotong
// slot. Kegagalan sinkron tercatat di booking (googleSyncStatus/Error)
// dan TIDAK PERNAH menggagalkan booking itu sendiri.
//
// Permukaan v1 BACA saja (appointments:read): daftar booking
// (tersaring from/to/status) + daftar layanan. Tulis SENGAJA
// dashboard/flow-only: layanan & ketersediaan adalah artefak kurasi
// operator, dan booking adalah hasil percakapan/dashboard — bukan
// sumber daya integrasi (lihat docs/COVERAGE-MATRIX.md).
// ---------------------------------------------------------------------------

/** Hari dalam seminggu: 0 = Minggu … 6 = Sabtu (konvensi JS getDay). */
export const AppointmentWeekdaySchema = z.number().int().min(0).max(6);
export type AppointmentWeekday = z.infer<typeof AppointmentWeekdaySchema>;

/** Jam dinding "HH:mm" 24-jam dalam zona waktu janji tenant. */
export const AppointmentTimeOfDaySchema = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "format HH:mm 24-jam");

/** Satu layanan janji temu (mis. "Konsultasi 30 menit"). */
export const AppointmentServiceResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Deskripsi opsional untuk operator; null = tidak diisi. */
  description: z.string().nullable(),
  durationMinutes: z.number().int().positive(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AppointmentServiceResponse = z.infer<
  typeof AppointmentServiceResponseSchema
>;

export const AppointmentServiceListResponseSchema = z.object({
  services: z.array(AppointmentServiceResponseSchema),
});
export type AppointmentServiceListResponse = z.infer<
  typeof AppointmentServiceListResponseSchema
>;

export const CreateAppointmentServiceRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(24 * 60),
  isActive: z.boolean().optional(),
});
export type CreateAppointmentServiceRequest = z.infer<
  typeof CreateAppointmentServiceRequestSchema
>;

export const UpdateAppointmentServiceRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(24 * 60).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateAppointmentServiceRequest = z.infer<
  typeof UpdateAppointmentServiceRequestSchema
>;

/**
 * Pengaturan janji per tenant. `timezone` adalah zona IANA yang
 * menjadi acuan SEMUA hitungan slot (default Asia/Jakarta);
 * `minLeadMinutes` = jarak minimum dari sekarang ke slot yang masih
 * boleh dipesan (lead time yang bisa dikonfigurasi).
 */
export const AppointmentSettingsResponseSchema = z.object({
  timezone: z.string(),
  minLeadMinutes: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export type AppointmentSettingsResponse = z.infer<
  typeof AppointmentSettingsResponseSchema
>;

export const UpdateAppointmentSettingsRequestSchema = z.object({
  timezone: z.string().trim().min(1).max(64).optional(),
  minLeadMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
});
export type UpdateAppointmentSettingsRequest = z.infer<
  typeof UpdateAppointmentSettingsRequestSchema
>;

/** Satu jendela ketersediaan mingguan (jam dinding zona janji tenant). */
export const AppointmentAvailabilityWindowSchema = z.object({
  weekday: AppointmentWeekdaySchema,
  startTime: AppointmentTimeOfDaySchema,
  endTime: AppointmentTimeOfDaySchema,
});
export type AppointmentAvailabilityWindow = z.infer<
  typeof AppointmentAvailabilityWindowSchema
>;

export const AppointmentAvailabilityResponseSchema = z.object({
  windows: z.array(AppointmentAvailabilityWindowSchema),
});
export type AppointmentAvailabilityResponse = z.infer<
  typeof AppointmentAvailabilityResponseSchema
>;

/** Ganti SELURUH jendela mingguan (semantik replace — editor mingguan). */
export const UpdateAppointmentAvailabilityRequestSchema = z.object({
  windows: z.array(AppointmentAvailabilityWindowSchema).max(7 * 4),
});
export type UpdateAppointmentAvailabilityRequest = z.infer<
  typeof UpdateAppointmentAvailabilityRequestSchema
>;

/** Status booking: terkonfirmasi atau dibatalkan (baris tidak dihapus). */
export const BookingStatusSchema = z.enum(["confirmed", "cancelled"]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

/**
 * Keadaan sinkron Google pada satu booking: not_connected (tenant
 * tidak/belum terhubung saat booking diproses), pending (event outbox
 * menunggu job), synced (event Google ada untuk booking ini),
 * failed (percobaan terakhir gagal — booking tetap sah; error tercatat).
 */
export const BookingGoogleSyncStatusSchema = z.enum([
  "not_connected",
  "pending",
  "synced",
  "failed",
]);
export type BookingGoogleSyncStatus = z.infer<
  typeof BookingGoogleSyncStatusSchema
>;

/** Sumber booking: percakapan flow atau dibuat operator di dashboard. */
export const BookingSourceSchema = z.enum(["flow", "dashboard"]);
export type BookingSource = z.infer<typeof BookingSourceSchema>;

export const BookingResponseSchema = z.object({
  id: z.string().uuid(),
  serviceId: z.string().uuid(),
  /** Nama layanan saat dibaca; null bila layanan sudah dihapus. */
  serviceName: z.string().nullable(),
  contactId: z.string().uuid(),
  /** Nama kontak; null bila kontak sudah terhapus. */
  contactName: z.string().nullable(),
  /** Percakapan asal (booking flow); null untuk booking dashboard. */
  conversationId: z.string().uuid().nullable(),
  /** Instan mulai/selesai UTC (ISO); render lokal = zona janji tenant. */
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  status: BookingStatusSchema,
  source: BookingSourceSchema,
  /** Id event Google; null sampai sinkron berhasil / bila tak terhubung. */
  googleEventId: z.string().nullable(),
  googleSyncStatus: BookingGoogleSyncStatusSchema,
  /** Ringkasan error sinkron terakhir (tanpa kredensial); null bila tak ada. */
  googleSyncError: z.string().nullable(),
  createdAt: z.string().datetime(),
  cancelledAt: z.string().datetime().nullable(),
});
export type BookingResponse = z.infer<typeof BookingResponseSchema>;

export const BookingListResponseSchema = z.object({
  bookings: z.array(BookingResponseSchema),
});
export type BookingListResponse = z.infer<typeof BookingListResponseSchema>;

/** Pembuatan booking manual oleh operator di dashboard. */
export const CreateBookingRequestSchema = z.object({
  serviceId: z.string().uuid(),
  contactId: z.string().uuid(),
  /** Instan mulai UTC (ISO) — UI menghitungnya dari pilihan slot lokal. */
  startsAt: z.string().datetime(),
});
export type CreateBookingRequest = z.infer<typeof CreateBookingRequestSchema>;

/** Satu slot yang bisa dipesan (instan UTC) — pratinjau dashboard. */
export const AppointmentSlotSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});
export type AppointmentSlot = z.infer<typeof AppointmentSlotSchema>;

export const AppointmentSlotListResponseSchema = z.object({
  slots: z.array(AppointmentSlotSchema),
  /** Zona janji tenant yang menjadi acuan render slot. */
  timezone: z.string(),
});
export type AppointmentSlotListResponse = z.infer<
  typeof AppointmentSlotListResponseSchema
>;

/** Keadaan koneksi Google Calendar tenant (TANPA token apa pun). */
export const GoogleCalendarConnectionResponseSchema = z.object({
  connected: z.boolean(),
  /** Email akun Google terhubung; null bila belum terhubung. */
  accountEmail: z.string().nullable(),
  /** Kalender tujuan event; null bila belum terhubung. */
  calendarId: z.string().nullable(),
  connectedAt: z.string().datetime().nullable(),
});
export type GoogleCalendarConnectionResponse = z.infer<
  typeof GoogleCalendarConnectionResponseSchema
>;

/** Satu kalender dari akun Google tenant (untuk pemilih kalender). */
export const GoogleCalendarOptionSchema = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean(),
});
export type GoogleCalendarOption = z.infer<typeof GoogleCalendarOptionSchema>;

export const GoogleCalendarListResponseSchema = z.object({
  calendars: z.array(GoogleCalendarOptionSchema),
});
export type GoogleCalendarListResponse = z.infer<
  typeof GoogleCalendarListResponseSchema
>;

export const UpdateGoogleCalendarRequestSchema = z.object({
  calendarId: z.string().trim().min(1).max(255),
});
export type UpdateGoogleCalendarRequest = z.infer<
  typeof UpdateGoogleCalendarRequestSchema
>;

/**
 * Hasil mulai koneksi Google: URL dialog OAuth yang harus dibuka
 * browser operator. Bila klien OAuth platform belum diatur di Panel
 * Admin, endpoint menjawab 422 GOOGLE_NOT_CONFIGURED (bukan URL mati).
 */
export const GoogleConnectStartResponseSchema = z.object({
  url: z.string().url(),
});
export type GoogleConnectStartResponse = z.infer<
  typeof GoogleConnectStartResponseSchema
>;

/**
 * Layanan Google berkoneksi OAuth mandiri (pemisahan Google,
 * 2026-11-12): calendar (janji temu), youtube (content schedule),
 * business (Google Business Profile). Tiap layanan = consent +
 * koneksi + klien OAuth proyek Cloud-nya sendiri.
 */
export const GoogleServiceSchema = z.enum([
  "calendar",
  "youtube",
  "business",
  // G16: layanan 'ads' — consent OAuth Google Ads (scope adwords)
  // untuk pengiriman konversi dari flow; callback kanonis
  // /api/oauth/google_ads/callback.
  "ads",
]);
export type GoogleService = z.infer<typeof GoogleServiceSchema>;

/** Keadaan koneksi SATU layanan Google tenant (TANPA token apa pun). */
export const GoogleServiceConnectionSchema = z.object({
  service: GoogleServiceSchema,
  connected: z.boolean(),
  /** Email akun Google layanan ini; null bila belum terhubung. */
  accountEmail: z.string().nullable(),
  connectedAt: z.string().datetime().nullable(),
});
export type GoogleServiceConnection = z.infer<
  typeof GoogleServiceConnectionSchema
>;

/**
 * Keadaan koneksi SEMUA layanan Google tenant — selalu tiga entri
 * (calendar, youtube, business), layanan belum terhubung tampil
 * connected=false. Dasar blok Google per layanan di Channels.
 */
export const GoogleServiceConnectionsResponseSchema = z.object({
  services: z.array(GoogleServiceConnectionSchema),
});
export type GoogleServiceConnectionsResponse = z.infer<
  typeof GoogleServiceConnectionsResponseSchema
>;

/** Query daftar booking API publik /v1 (Fase 13G) — rentang + status. */
export const V1ListAppointmentsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: BookingStatusSchema.optional(),
});
export type V1ListAppointmentsQuery = z.infer<
  typeof V1ListAppointmentsQuerySchema
>;
/** Alias pola SDK (ListContactsQuery/ListBroadcastsQuery). */
export type ListAppointmentsQuery = V1ListAppointmentsQuery;
