import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  AppointmentAvailabilityResponseSchema,
  AppointmentServiceListResponseSchema,
  AppointmentServiceResponseSchema,
  AppointmentSettingsResponseSchema,
  AppointmentSlotListResponseSchema,
  BookingListResponseSchema,
  BookingResponseSchema,
  CreateAppointmentServiceRequestSchema,
  CreateBookingRequestSchema,
  GoogleCalendarConnectionResponseSchema,
  GoogleCalendarListResponseSchema,
  GoogleConnectStartResponseSchema,
  GoogleServiceConnectionSchema,
  GoogleServiceConnectionsResponseSchema,
  UpdateAppointmentAvailabilityRequestSchema,
  UpdateAppointmentServiceRequestSchema,
  UpdateAppointmentSettingsRequestSchema,
  UpdateGoogleCalendarRequestSchema,
  type AppointmentServiceResponse,
  type BookingResponse,
} from "@sahabat-kreator/contracts";
import {
  AppointmentServiceNotFoundError,
  SlotTakenError,
  buildGoogleAuthorizeUrl,
  cancelBooking,
  createAppointmentService,
  createBooking,
  deleteAppointmentService,
  deleteGoogleConnection,
  disconnectGoogleService,
  exchangeGoogleAuthCode,
  fetchGoogleAccountEmail,
  getAppointmentService,
  getAppointmentSettings,
  getBookableSlots,
  getBooking,
  getContact,
  getGoogleConnection,
  GOOGLE_OAUTH_CALLBACK_SEGMENTS,
  googleServiceScopes,
  isGoogleService,
  listAppointmentAvailability,
  listAppointmentServices,
  listBookings,
  listGoogleCalendars,
  listGoogleServiceConnections,
  replaceAppointmentAvailability,
  resolveGoogleServiceClient,
  saveGoogleServiceConnection,
  syncGoogleBusinessLocationAccounts,
  syncYouTubeChannelAccount,
  setGoogleConnectionCalendar,
  updateAppointmentService,
  updateAppointmentSettings,
  type BookingWithNames,
  type GoogleBases,
  type GoogleDeps,
  type GoogleService,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import type {
  AppointmentServiceRow,
  BookingRow,
} from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { createOAuthKvStore, type OAuthKvStore } from "../../oauth-kv";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul appointments (Fase 13G) — janji temu per workspace + koneksi
 * Google Calendar tenant:
 *   GET    /tenants/:tenantId/appointments/settings       pengaturan (semua member)
 *   PUT    /tenants/:tenantId/appointments/settings       ubah (owner/admin)
 *   GET    /tenants/:tenantId/appointments/services       daftar layanan
 *   POST   /tenants/:tenantId/appointments/services       buat (owner/admin)
 *   PATCH  /tenants/:tenantId/appointments/services/:id   edit (owner/admin)
 *   DELETE /tenants/:tenantId/appointments/services/:id   hapus (owner/admin)
 *   GET    /tenants/:tenantId/appointments/availability   jendela mingguan
 *   PUT    /tenants/:tenantId/appointments/availability   ganti seluruh (owner/admin)
 *   GET    /tenants/:tenantId/appointments/slots          pratinjau slot (mesin inti)
 *   GET    /tenants/:tenantId/appointments/bookings       daftar booking (?from&to&status)
 *   POST   /tenants/:tenantId/appointments/bookings       buat manual (owner/admin)
 *   POST   /tenants/:tenantId/appointments/bookings/:id/cancel  batalkan (owner/admin)
 *   GET    /tenants/:tenantId/appointments/google         status koneksi Google
 *   POST   /tenants/:tenantId/appointments/google/connect mulai OAuth → { url } (owner/admin)
 *   GET    /tenants/:tenantId/appointments/google/calendars     daftar kalender akun
 *   PUT    /tenants/:tenantId/appointments/google/calendar      pilih kalender (owner/admin)
 *   DELETE /tenants/:tenantId/appointments/google         putus koneksi (owner/admin)
 *   GET    /oauth/google_calendar/callback                callback publik calendar (state bertanda tangan)
 *   GET    /oauth/youtube/callback                        callback publik youtube (state bertanda tangan)
 *   GET    /oauth/google_business/callback                callback publik business (state bertanda tangan)
 *   GET    /oauth/google_ads/callback                     callback publik ads (state bertanda tangan; G16)
 *   GET    /oauth/google_sheets/callback                  callback publik sheets (state bertanda tangan; G17)
 *
 * Pemisahan Google per layanan (2026-11-12): modul ini juga rumah
 * bagi OAuth layanan Google — state bertanda tangan kini memuat
 * LAYANAN (calendar/youtube/business/ads) dan halaman asal. Tiap layanan
 * punya callback KANONIS sendiri (/api/oauth/google_calendar|
 * youtube|google_business|google_ads/callback, keputusan pemilik) yang
 * dilayani SATU handler yang sama; callback gabungan lama Fase 13G
 * (/google/oauth/callback) SENGAJA dihapus tanpa alias — pemilik
 * mendaftarkan URI baru di proyeknya sebelum connect diuji lagi:
 *   GET    /tenants/:tenantId/google/status               status tiga layanan
 *   POST   /tenants/:tenantId/google/:service/connect     mulai OAuth layanan itu (owner/admin)
 *   DELETE /tenants/:tenantId/google/:service             putus koneksi SATU layanan itu saja (owner/admin; S4)
 * Rute appointments/google/* di atas adalah bentuk Calendar-nya
 * (halaman Janji Temu); consent-nya kini SEMPIT kalender saja.
 *
 * Lapisan janji bekerja PENUH tanpa Google. Klien OAuth Google milik
 * PLATFORM (Panel Admin, resolusi panel → env): tanpa client id/secret
 * endpoint connect menjawab 422 GOOGLE_NOT_CONFIGURED secara jujur
 * (pola Resend 11B) — bukan URL dialog mati. Callback memakai state
 * HMAC sekali pakai (nonce diklaim/dikonsumsi atomik lewat Redis
 * `oauth-kv` yang sama dengan modul meta-oauth 7D; masa berlaku 10
 * menit). Nonce disimpan di Redis, bukan memori proses, agar callback
 * tetap sah saat API berjalan lebih dari satu replika atau baru
 * di-restart di antara "connect" dan "callback".
 */

export interface AppointmentsModuleOptions {
  platform: PlatformSettingsOptions;
  /** Secret enkripsi token tenant (env CHANNEL_TOKEN_SECRET). */
  tokenSecret?: string;
  /** Override base URL Google (mock rantai) — lihat core google-calendar. */
  googleBases?: GoogleBases;
  /** Base URL publik aplikasi (env BETTER_AUTH_URL) untuk callback + redirect hasil. */
  publicBaseUrl?: string;
  /** Secret penanda tangan state OAuth (env BETTER_AUTH_SECRET). */
  stateSecret?: string;
  /** Redis platform (env REDIS_URL) untuk nonce state OAuth lintas replika. */
  redisUrl?: string;
}

export function serializeAppointmentService(
  row: AppointmentServiceRow,
): AppointmentServiceResponse {
  return AppointmentServiceResponseSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.durationMinutes,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Serializer booking — dipakai modul ini DAN rute publik /v1/appointments. */
export function serializeBooking(row: BookingWithNames): BookingResponse {
  const b: BookingRow = row.booking;
  return BookingResponseSchema.parse({
    id: b.id,
    serviceId: b.serviceId,
    serviceName: row.serviceName,
    contactId: b.contactId,
    contactName: row.contactName,
    conversationId: b.conversationId,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    status: b.status,
    source: b.source,
    googleEventId: b.googleEventId,
    googleSyncStatus: b.googleSyncStatus,
    googleSyncError: b.googleSyncError,
    createdAt: b.createdAt.toISOString(),
    cancelledAt: b.cancelledAt ? b.cancelledAt.toISOString() : null,
  });
}

const STATE_TTL_MS = 10 * 60_000;

interface OAuthStatePayload {
  tenantId: string;
  userId: string;
  nonce: string;
  exp: number;
  /** Layanan yang sedang dihubungkan — callback menyimpan koneksi + menyinkronkan HANYA layanan ini. */
  service: GoogleService;
  /** Halaman asal alur: callback mengembalikan browser ke sana (banner per konteks). */
  returnTo: "appointments" | "channels";
}

function signOAuthState(secret: string, payload: OAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest();
  return `${body}.${signature.toString("base64url")}`;
}

function verifyOAuthState(
  secret: string,
  state: string,
): OAuthStatePayload | null {
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const presented = Buffer.from(state.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as OAuthStatePayload;
    if (
      typeof payload.tenantId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp < Date.now() ||
      typeof payload.service !== "string" ||
      !isGoogleService(payload.service) ||
      (payload.returnTo !== "appointments" && payload.returnTo !== "channels")
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

const STATE_TTL_SECONDS = STATE_TTL_MS / 1000;

export function createAppointmentsRoutes(
  bundle: AuthBundle | null,
  options: AppointmentsModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/appointments";

  const googleDeps: GoogleDeps = {
    platform: options.platform,
    tokenSecret: options.tokenSecret,
    bases: options.googleBases,
  };
  // Nonce state OAuth sekali pakai di Redis (lintas replika) dengan
  // fallback memori proses — store yang sama dengan modul meta-oauth.
  const oauthState: OAuthKvStore = createOAuthKvStore(options.redisUrl, {
    namespace: "google-oauth",
    ttlSeconds: STATE_TTL_SECONDS,
  });
  const webBase = (options.publicBaseUrl ?? "").replace(/\/+$/, "");
  /**
   * Redirect URI KANONIS per layanan (keputusan pemilik 2026-11-12:
   * `/api/oauth/<layanan>/callback` — google_calendar / youtube /
   * google_business). Dialog dan pertukaran kode WAJIB memakai URI
   * layanan yang sama persis.
   */
  const redirectUriFor = (service: GoogleService): string =>
    `${webBase}/api/oauth/${GOOGLE_OAUTH_CALLBACK_SEGMENTS[service]}/callback`;

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(`${base}/settings`, unavailable);
    app.put(`${base}/settings`, unavailable);
    app.get(`${base}/services`, unavailable);
    app.post(`${base}/services`, unavailable);
    app.patch(`${base}/services/:id`, unavailable);
    app.delete(`${base}/services/:id`, unavailable);
    app.get(`${base}/availability`, unavailable);
    app.put(`${base}/availability`, unavailable);
    app.get(`${base}/slots`, unavailable);
    app.get(`${base}/bookings`, unavailable);
    app.post(`${base}/bookings`, unavailable);
    app.post(`${base}/bookings/:id/cancel`, unavailable);
    app.get(`${base}/google`, unavailable);
    app.post(`${base}/google/connect`, unavailable);
    app.get(`${base}/google/calendars`, unavailable);
    app.put(`${base}/google/calendar`, unavailable);
    app.delete(`${base}/google`, unavailable);
    app.get("/tenants/:tenantId/google/status", unavailable);
    app.post("/tenants/:tenantId/google/:service/connect", unavailable);
    app.delete("/tenants/:tenantId/google/:service", unavailable);
    app.get("/oauth/google_calendar/callback", unavailable);
    app.get("/oauth/youtube/callback", unavailable);
    app.get("/oauth/google_business/callback", unavailable);
    app.get("/oauth/google_ads/callback", unavailable);
    app.get("/oauth/google_sheets/callback", unavailable);
    return app;
  }


  type GuardOk = {
    tenant: NonNullable<Awaited<ReturnType<typeof resolveTenantForUser>>>;
    appUser: { id: string };
  };
  async function guard(
    c: AppContext,
    opts: { ownerAdmin: boolean },
  ): Promise<GuardOk | { error: Response }> {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle!,
      c.req.param("tenantId") ?? "",
      appUser.id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      };
    }
    if (
      opts.ownerAdmin &&
      tenant.role !== "owner" &&
      tenant.role !== "admin"
    ) {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage appointments",
        ),
      };
    }
    return { tenant, appUser: { id: appUser.id } };
  }

  function parseUuidParam(c: AppContext, name = "id"): string | null {
    const id = c.req.param(name);
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  async function readJson(c: AppContext): Promise<unknown | null> {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  }

  function parseDateQuery(value: string | undefined): Date | null | undefined {
    if (value === undefined) return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // --- Pengaturan ---------------------------------------------------
  app.get(`${base}/settings`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const settings = await getAppointmentSettings(bundle.db, g.tenant.id);
    return c.json(
      AppointmentSettingsResponseSchema.parse({
        timezone: settings.timezone,
        minLeadMinutes: settings.minLeadMinutes,
        updatedAt: settings.updatedAt.toISOString(),
      }),
    );
  });

  app.put(`${base}/settings`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const parsed = UpdateAppointmentSettingsRequestSchema.safeParse(
      await readJson(c),
    );
    if (!parsed.success) {
      return apiError(c, 422, "VALIDATION_ERROR", "Invalid settings payload");
    }
    try {
      const settings = await updateAppointmentSettings(
        bundle.db,
        g.tenant.id,
        parsed.data,
      );
      return c.json(
        AppointmentSettingsResponseSchema.parse({
          timezone: settings.timezone,
          minLeadMinutes: settings.minLeadMinutes,
          updatedAt: settings.updatedAt.toISOString(),
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AppointmentSettingsError") {
        return apiError(c, 422, "APPOINTMENT_TIMEZONE_INVALID", err.message);
      }
      throw err;
    }
  });

  // --- Layanan --------------------------------------------------------
  app.get(`${base}/services`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const rows = await listAppointmentServices(bundle.db, g.tenant.id);
    return c.json(
      AppointmentServiceListResponseSchema.parse({
        services: rows.map(serializeAppointmentService),
      }),
    );
  });

  app.post(`${base}/services`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const parsed = CreateAppointmentServiceRequestSchema.safeParse(
      await readJson(c),
    );
    if (!parsed.success) {
      return apiError(c, 422, "VALIDATION_ERROR", "Invalid service payload");
    }
    const row = await createAppointmentService(
      bundle.db,
      g.tenant.id,
      parsed.data,
    );
    return c.json(serializeAppointmentService(row), 201);
  });

  app.patch(`${base}/services/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c);
    if (!id) {
      return apiError(c, 404, "NOT_FOUND", "Appointment service not found");
    }
    const parsed = UpdateAppointmentServiceRequestSchema.safeParse(
      await readJson(c),
    );
    if (!parsed.success) {
      return apiError(c, 422, "VALIDATION_ERROR", "Invalid service payload");
    }
    const row = await updateAppointmentService(
      bundle.db,
      g.tenant.id,
      id,
      parsed.data,
    );
    if (!row) {
      return apiError(c, 404, "NOT_FOUND", "Appointment service not found");
    }
    return c.json(serializeAppointmentService(row));
  });

  app.delete(`${base}/services/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c);
    if (!id) {
      return apiError(c, 404, "NOT_FOUND", "Appointment service not found");
    }
    const deleted = await deleteAppointmentService(bundle.db, g.tenant.id, id);
    if (!deleted) {
      return apiError(c, 404, "NOT_FOUND", "Appointment service not found");
    }
    return c.json({ deleted: true });
  });

  // --- Ketersediaan ---------------------------------------------------
  app.get(`${base}/availability`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const windows = await listAppointmentAvailability(bundle.db, g.tenant.id);
    return c.json(AppointmentAvailabilityResponseSchema.parse({ windows }));
  });

  app.put(`${base}/availability`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const parsed = UpdateAppointmentAvailabilityRequestSchema.safeParse(
      await readJson(c),
    );
    if (!parsed.success) {
      return apiError(c, 422, "VALIDATION_ERROR", "Invalid availability payload");
    }
    for (const w of parsed.data.windows) {
      if (w.endTime <= w.startTime) {
        return apiError(
          c,
          422,
          "VALIDATION_ERROR",
          "Availability window end must be after start",
        );
      }
    }
    const windows = await replaceAppointmentAvailability(
      bundle.db,
      g.tenant.id,
      parsed.data.windows,
    );
    return c.json(AppointmentAvailabilityResponseSchema.parse({ windows }));
  });

  // --- Pratinjau slot (mesin inti yang sama dengan node flow) ---------
  app.get(`${base}/slots`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const serviceId = c.req.query("serviceId");
    if (!serviceId || !z.string().uuid().safeParse(serviceId).success) {
      return apiError(c, 422, "VALIDATION_ERROR", "serviceId is required");
    }
    const from = parseDateQuery(c.req.query("from")) ?? new Date();
    const to =
      parseDateQuery(c.req.query("to")) ??
      new Date(from.getTime() + 14 * 86_400_000);
    if (to.getTime() - from.getTime() > 62 * 86_400_000) {
      return apiError(c, 422, "VALIDATION_ERROR", "Slot range too large");
    }
    const result = await getBookableSlots(
      bundle.db,
      g.tenant.id,
      serviceId,
      { from, to, now: new Date() },
      googleDeps,
    );
    if (!result) {
      return apiError(c, 404, "NOT_FOUND", "Appointment service not found");
    }
    return c.json(
      AppointmentSlotListResponseSchema.parse({
        slots: result.slots.map((s) => ({
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
        })),
        timezone: result.settings.timezone,
      }),
    );
  });

  // --- Booking ----------------------------------------------------------
  app.get(`${base}/bookings`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const from = parseDateQuery(c.req.query("from"));
    const to = parseDateQuery(c.req.query("to"));
    if (from === null || to === null) {
      return apiError(c, 422, "VALIDATION_ERROR", "Invalid from/to date");
    }
    const statusRaw = c.req.query("status");
    const status =
      statusRaw === "confirmed" || statusRaw === "cancelled"
        ? statusRaw
        : undefined;
    const rows = await listBookings(bundle.db, g.tenant.id, {
      from: from ?? undefined,
      to: to ?? undefined,
      status,
    });
    return c.json(
      BookingListResponseSchema.parse({
        bookings: rows.map(serializeBooking),
      }),
    );
  });

  app.post(`${base}/bookings`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const parsed = CreateBookingRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return apiError(c, 422, "VALIDATION_ERROR", "Invalid booking payload");
    }
    const service = await getAppointmentService(
      bundle.db,
      g.tenant.id,
      parsed.data.serviceId,
    );
    if (!service) {
      return apiError(c, 404, "NOT_FOUND", "Appointment service not found");
    }
    const contact = await getContact(
      bundle.db,
      { tenantId: g.tenant.id },
      parsed.data.contactId,
    ).catch(() => null);
    if (!contact) {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    try {
      const booking = await createBooking(bundle.db, g.tenant.id, {
        serviceId: parsed.data.serviceId,
        contactId: parsed.data.contactId,
        conversationId: null,
        startsAt: new Date(parsed.data.startsAt),
        source: "dashboard",
        actorType: "user",
        actorId: g.appUser.id,
      });
      const detailed = await getBooking(bundle.db, g.tenant.id, booking.id);
      return c.json(
        serializeBooking(
          detailed ?? {
            booking,
            serviceName: service.name,
            contactName: contact.name,
          },
        ),
        201,
      );
    } catch (err) {
      if (err instanceof SlotTakenError) {
        return apiError(
          c,
          409,
          "SLOT_TAKEN",
          "That time is already booked",
        );
      }
      if (err instanceof AppointmentServiceNotFoundError) {
        return apiError(c, 404, "NOT_FOUND", "Appointment service not found");
      }
      throw err;
    }
  });

  app.post(`${base}/bookings/:id/cancel`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Booking not found");
    const booking = await cancelBooking(bundle.db, g.tenant.id, id, {
      actorType: "user",
      actorId: g.appUser.id,
    });
    if (!booking) return apiError(c, 404, "NOT_FOUND", "Booking not found");
    const detailed = await getBooking(bundle.db, g.tenant.id, booking.id);
    return c.json(
      serializeBooking(
        detailed ?? { booking, serviceName: null, contactName: null },
      ),
    );
  });

  // --- Google Calendar --------------------------------------------------
  app.get(`${base}/google`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const connection = await getGoogleConnection(bundle.db, g.tenant.id);
    return c.json(
      GoogleCalendarConnectionResponseSchema.parse({
        connected: connection !== null,
        accountEmail: connection?.accountEmail ?? null,
        calendarId: connection?.calendarId ?? null,
        connectedAt: connection ? connection.createdAt.toISOString() : null,
      }),
    );
  });

  /**
   * Mulai OAuth SATU layanan Google: dialog dibangun dari klien
   * LAYANAN itu (resolusi berjenjang per-layanan → bersama), scope
   * SEMPIT layanannya, dan redirect URI KANONIS layanannya
   * (/api/oauth/<layanan>/callback); state bertanda tangan memuat
   * layanan + halaman asal. Dipakai rute janji temu (calendar, asal
   * appointments) dan rute Channels per layanan (asal channels).
   */
  async function startGoogleServiceConnect(
    c: AppContext,
    g: GuardOk,
    service: GoogleService,
    returnTo: "appointments" | "channels",
  ): Promise<Response> {
    const client = await resolveGoogleServiceClient(
      bundle!.db,
      options.platform,
      service,
    );
    if (!client) {
      // Kejujuran NOT_CONFIGURED (pola Resend 11B): klien OAuth
      // platform belum diatur Panel Admin — tidak ada URL mati.
      return apiError(
        c,
        422,
        "GOOGLE_NOT_CONFIGURED",
        "Google is not configured by the platform yet",
      );
    }
    if (!options.stateSecret || !webBase) {
      return apiError(
        c,
        422,
        "GOOGLE_NOT_CONFIGURED",
        "Google OAuth is not configured on this server",
      );
    }
    if (!options.tokenSecret) {
      return apiError(
        c,
        422,
        "GOOGLE_NOT_CONFIGURED",
        "Credential storage is not configured on this server",
      );
    }
    const nonce = randomBytes(16).toString("base64url");
    // Klaim atomik: bila Redis menolak (nonce kembar) pengguna cukup
    // mengulang, jadi jawab jujur alih-alih menerbitkan state mati.
    if (!(await oauthState.claimNonce(nonce))) {
      return apiError(
        c,
        503,
        "INTERNAL_ERROR",
        "Could not start Google OAuth, please retry",
      );
    }
    const state = signOAuthState(options.stateSecret, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      nonce,
      exp: Date.now() + STATE_TTL_MS,
      service,
      returnTo,
    });
    const url = buildGoogleAuthorizeUrl({
      clientId: client.clientId,
      redirectUri: redirectUriFor(service),
      state,
      scopes: googleServiceScopes(service),
      authBase: options.googleBases?.authBase,
    });
    return c.json(GoogleConnectStartResponseSchema.parse({ url }));
  }

  app.post(`${base}/google/connect`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    return startGoogleServiceConnect(c, g, "calendar", "appointments");
  });

  // --- Google per layanan (Channels) -------------------------------------
  app.get("/tenants/:tenantId/google/status", async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const rows = await listGoogleServiceConnections(bundle.db, g.tenant.id);
    const services = (
      ["calendar", "youtube", "business", "sheets"] as GoogleService[]
    ).map((service) => {
      const row = rows.find((r) => r.service === service);
      return {
        service,
        connected: row !== undefined,
        accountEmail: row?.accountEmail ?? null,
        connectedAt: row ? row.createdAt.toISOString() : null,
      };
    });
    return c.json(
      GoogleServiceConnectionsResponseSchema.parse({ services }),
    );
  });

  app.post("/tenants/:tenantId/google/:service/connect", async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const service = c.req.param("service") ?? "";
    if (!isGoogleService(service)) {
      return apiError(c, 404, "NOT_FOUND", "Unknown Google service");
    }
    return startGoogleServiceConnect(c, g, service, "channels");
  });

  /**
   * Putus koneksi SATU layanan Google (Fase Susulan S4) — pasangan
   * DELETE dari connect per layanan di atas: baris koneksi layanan
   * itu saja yang dicabut, empat layanan lain tidak tersentuh.
   * Semantik turunan (akun channel YouTube/Business ikut nonaktif,
   * konfigurasi ad_connections bertahan, dsb.) hidup di core
   * `disconnectGoogleService`. Layanan yang memang TIDAK terhubung
   * dijawab jujur 422 GOOGLE_NOT_CONNECTED (pola rute kalender di
   * modul ini), bukan sukses pura-pura. Keberhasilan menjawab
   * keadaan layanan itu sesudah putus (connected: false).
   */
  app.delete("/tenants/:tenantId/google/:service", async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const service = c.req.param("service") ?? "";
    if (!isGoogleService(service)) {
      return apiError(c, 404, "NOT_FOUND", "Unknown Google service");
    }
    const result = await disconnectGoogleService(
      bundle.db,
      { tenantId: g.tenant.id, actorType: "user", actorId: g.appUser.id },
      service,
    );
    if (!result.connectionRemoved && result.channelAccountsDisconnected === 0) {
      return apiError(
        c,
        422,
        "GOOGLE_NOT_CONNECTED",
        "Google service is not connected",
      );
    }
    return c.json(
      GoogleServiceConnectionSchema.parse({
        service,
        connected: false,
        accountEmail: null,
        connectedAt: null,
      }),
    );
  });

  app.get(`${base}/google/calendars`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const connection = await getGoogleConnection(bundle.db, g.tenant.id);
    if (!connection) {
      return apiError(c, 422, "GOOGLE_NOT_CONNECTED", "Google is not connected");
    }
    const calendars = await listGoogleCalendars(
      bundle.db,
      g.tenant.id,
      googleDeps,
    );
    if (!calendars) {
      return apiError(
        c,
        502,
        "GOOGLE_UNREACHABLE",
        "Could not read calendars from Google",
      );
    }
    return c.json(
      GoogleCalendarListResponseSchema.parse({ calendars }),
    );
  });

  app.put(`${base}/google/calendar`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const parsed = UpdateGoogleCalendarRequestSchema.safeParse(
      await readJson(c),
    );
    if (!parsed.success) {
      return apiError(c, 422, "VALIDATION_ERROR", "Invalid calendar payload");
    }
    const row = await setGoogleConnectionCalendar(
      bundle.db,
      g.tenant.id,
      parsed.data.calendarId,
    );
    if (!row) {
      return apiError(c, 422, "GOOGLE_NOT_CONNECTED", "Google is not connected");
    }
    return c.json(
      GoogleCalendarConnectionResponseSchema.parse({
        connected: true,
        accountEmail: row.accountEmail,
        calendarId: row.calendarId,
        connectedAt: row.createdAt.toISOString(),
      }),
    );
  });

  app.delete(`${base}/google`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    await deleteGoogleConnection(bundle.db, g.tenant.id);
    return c.json(
      GoogleCalendarConnectionResponseSchema.parse({
        connected: false,
        accountEmail: null,
        calendarId: null,
        connectedAt: null,
      }),
    );
  });

  // --- Callback OAuth publik (identitas dari state bertanda tangan) -----
  // Callback KANONIS per layanan (keputusan pemilik 2026-11-12):
  // /oauth/google_calendar/callback, /oauth/youtube/callback,
  // /oauth/google_business/callback — satu handler yang sama untuk
  // ketiganya; layanan dan halaman asal dibaca dari STATE bertanda
  // tangan (bukan dari path/query yang bisa dipalsukan), token
  // ditukar dengan klien LAYANAN ITU dan redirect URI kanonis
  // layanan itu, dan koneksi disimpan ke baris layanan itu saja.
  // Path gabungan lama /google/oauth/callback (Fase 13G) TIDAK lagi
  // dilayani — tanpa alias/fallback, sesuai keputusan pemilik.
  const handleGoogleOAuthCallback = async (c: AppContext) => {
    const failAppointments = (code: string) =>
      c.redirect(
        `${webBase}/appointments?google=error&reason=${encodeURIComponent(code)}`,
        302,
      );
    if (!options.stateSecret || !webBase || !options.tokenSecret) {
      return failAppointments("GOOGLE_NOT_CONFIGURED");
    }
    const stateRaw = c.req.query("state");
    const code = c.req.query("code");
    if (!stateRaw || !code) return failAppointments("GOOGLE_STATE_INVALID");
    const state = verifyOAuthState(options.stateSecret, stateRaw);
    if (!state) return failAppointments("GOOGLE_STATE_INVALID");
    const fail = (failCode: string) =>
      state.returnTo === "channels"
        ? c.redirect(
            `${webBase}/channels?google_oauth_error=${encodeURIComponent(failCode)}&google_service=${state.service}`,
            302,
          )
        : failAppointments(failCode);
    if (!(await oauthState.consumeNonce(state.nonce))) {
      return fail("GOOGLE_STATE_INVALID");
    }
    const client = await resolveGoogleServiceClient(
      bundle.db,
      options.platform,
      state.service,
    );
    if (!client) return fail("GOOGLE_NOT_CONFIGURED");
    try {
      const tokens = await exchangeGoogleAuthCode(googleDeps, client, {
        code,
        // Redirect URI pertukaran = URI KANONIS layanan yang sama
        // dengan dialog awal (Google memvalidasi persis).
        redirectUri: redirectUriFor(state.service),
      });
      const email = await fetchGoogleAccountEmail(
        googleDeps,
        tokens.accessToken,
      );
      await saveGoogleServiceConnection(bundle.db, state.tenantId, state.service, {
        tokens,
        accountEmail: email,
        tokenSecret: options.tokenSecret,
      });
    } catch {
      return fail("GOOGLE_EXCHANGE_FAILED");
    }
    // Sinkron turunan HANYA untuk layanan yang baru terhubung —
    // FAIL-SOFT sepenuhnya (kegagalan sinkron tidak menggagalkan
    // koneksi yang sudah tersimpan):
    // - youtube: petakan koneksi youtube ke akun channel youtube
    //   tenant agar kanal muncul sebagai sasaran content schedule
    //   (Gelombang 2; dulu ikut callback consent gabungan).
    // - business: petakan lokasi Business Profile ke akun lokasi
    //   google_business (Gelombang 3; pola yang sama).
    // - calendar: tidak ada turunan — janji temu membaca koneksinya
    //   langsung.
    try {
      if (state.service === "youtube") {
        await syncYouTubeChannelAccount(bundle.db, state.tenantId, googleDeps);
      } else if (state.service === "business") {
        await syncGoogleBusinessLocationAccounts(
          bundle.db,
          state.tenantId,
          googleDeps,
        );
      }
    } catch {
      /* abaikan — sinkron turunan bukan syarat koneksi layanan */
    }
    if (state.returnTo === "channels") {
      return c.redirect(
        `${webBase}/channels?google_oauth=connected&google_service=${state.service}`,
        302,
      );
    }
    return c.redirect(`${webBase}/appointments?google=connected`, 302);
  };

  app.get("/oauth/google_calendar/callback", handleGoogleOAuthCallback);
  app.get("/oauth/youtube/callback", handleGoogleOAuthCallback);
  app.get("/oauth/google_business/callback", handleGoogleOAuthCallback);
  // G16: layanan 'ads' — callback-nya tidak punya sinkron turunan
  // (tidak ada akun channel dari Ads); koneksi cukup disimpan dan
  // dibaca modul ad-conversions untuk pengiriman konversi.
  app.get("/oauth/google_ads/callback", handleGoogleOAuthCallback);
  // G17: layanan 'sheets' — callback tanpa sinkron turunan juga
  // (tidak ada akun channel dari Sheets); koneksi dibaca node flow
  // append_sheet_row saat mengeksekusi langkah.
  app.get("/oauth/google_sheets/callback", handleGoogleOAuthCallback);

  return app;
}
