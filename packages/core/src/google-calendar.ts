import { eq, and } from "drizzle-orm";
import {
  appointmentServices,
  bookings,
  contacts,
  googleCalendarConnections,
  type BookingRow,
  type Database,
  type GoogleCalendarConnectionRow,
} from "@sahabat-kreator/db";
import {
  decryptChannelSecret,
  encryptChannelSecret,
} from "./channel-secrets";
import {
  getProviderSecret,
  type PlatformSettingsOptions,
} from "./platform-settings";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Google Calendar (Fase 13G) — PENINGKATAN sinkronisasi di atas lapisan
 * janji temu internal; janji temu bekerja penuh TANPA modul ini.
 *
 * Model kegagalan yang mengikat fase ini:
 * - Booking TIDAK PERNAH gagal karena Google. Pembuatan/pembatalan
 *   menulis event outbox `appointment.google_sync_requested` dalam
 *   transaksi yang sama; relay worker menerjemahkannya menjadi job
 *   `appointment.google_sync` yang menjalankan sinkron di sini.
 *   Hasil percobaan tercatat di baris booking (google_sync_status /
 *   google_sync_error / google_event_id) — tidak ada kegagalan diam.
 * - Klien OAuth (client id + secret) milik PLATFORM, dikelola Panel
 *   Admin dengan resolusi panel → env yang sama seperti Resend
 *   (Fase 11B). Tanpa keduanya, Hubungkan Google menjawab
 *   GOOGLE_NOT_CONFIGURED secara jujur — bukan tombol mati.
 * - Token TENANT (access + refresh) disimpan TERENKRIPSI envelope
 *   `v1:` AES-256-GCM dengan secret env CHANNEL_TOKEN_SECRET (pola
 *   kredensial channel Fase 6A) — DB tidak pernah memegang token
 *   mentah, dan token tidak pernah masuk hasil/log/error.
 * - Base URL bisa dioverride env untuk mock rantai uji (pola
 *   RESEND_API_BASE): GOOGLE_API_BASE (Calendar API + userinfo,
 *   default https://www.googleapis.com), GOOGLE_TOKEN_BASE (token
 *   endpoint, default https://oauth2.googleapis.com), GOOGLE_AUTH_BASE
 *   (dialog authorize, default https://accounts.google.com).
 * - Job sinkron membaca keadaan booking TERKINI sebelum bertindak:
 *   create untuk booking yang sudah dibatalkan dilewati, delete untuk
 *   booking yang masih confirmed dilewati — urutan job yang bertukar
 *   tidak menciptakan event yatim semampu pemeriksaan ini.
 */

export const GOOGLE_DEFAULT_API_BASE = "https://www.googleapis.com";
export const GOOGLE_DEFAULT_TOKEN_BASE = "https://oauth2.googleapis.com";
export const GOOGLE_DEFAULT_AUTH_BASE = "https://accounts.google.com";

/** Scope unggah video YouTube (Gelombang 2) — scope sensitif Google. */
export const YOUTUBE_UPLOAD_SCOPE =
  "https://www.googleapis.com/auth/youtube.upload";
/** Scope baca channel YouTube (Gelombang 2) — untuk channel ID/judul. */
export const YOUTUBE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/youtube.readonly";

/**
 * Scope yang diminta: tulis event + baca kalender/freebusy + email akun
 * + YouTube (Gelombang 2). SATU koneksi Google per tenant melayani
 * Calendar DAN YouTube — tidak ada jalur OAuth kedua; consent yang
 * sama (access_type=offline + include_granted_scopes) menerbitkan
 * refresh token yang mencakup semuanya. Koneksi lama yang terhubung
 * sebelum scope YouTube ditambahkan TIDAK memilikinya: penerbitan
 * YouTube menjawab `youtube_scope_missing` sampai pemilik menghubungkan
 * ulang Google (consent inkremental menambahkan scope baru).
 */
export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  YOUTUBE_UPLOAD_SCOPE,
  YOUTUBE_READONLY_SCOPE,
].join(" ");

export const APPOINTMENT_GOOGLE_SYNC_OUTBOX_TYPE =
  "appointment.google_sync_requested";

const GOOGLE_TIMEOUT_MS = 10_000;
/** Batas ringkasan error yang disimpan di bookings.google_sync_error. */
const SYNC_ERROR_MAX = 255;

export interface GoogleBases {
  apiBase?: string;
  tokenBase?: string;
  authBase?: string;
}

export interface GoogleDeps {
  platform: PlatformSettingsOptions;
  /** Secret enkripsi token tenant (env CHANNEL_TOKEN_SECRET). */
  tokenSecret?: string;
  bases?: GoogleBases;
}

function apiBase(deps: GoogleDeps): string {
  return (deps.bases?.apiBase ?? GOOGLE_DEFAULT_API_BASE).replace(/\/+$/, "");
}
function tokenBase(deps: GoogleDeps): string {
  return (deps.bases?.tokenBase ?? GOOGLE_DEFAULT_TOKEN_BASE).replace(
    /\/+$/,
    "",
  );
}

// ---------------------------------------------------------------------------
// Resolusi klien OAuth platform: panel → env (pola Resend 11B)
// ---------------------------------------------------------------------------

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Klien OAuth Google efektif, atau null bila TIDAK TERKONFIGURASI
 * (client id atau secret kosong di panel & env — keduanya wajib).
 */
export async function resolveGoogleOAuthClient(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<GoogleOAuthClientConfig | null> {
  const [clientId, clientSecret] = await Promise.all([
    getProviderSecret(db, "google_oauth_client_id", opts),
    getProviderSecret(db, "google_oauth_client_secret", opts),
  ]);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** URL dialog OAuth Google (consent + akses offline agar refresh token terbit). */
export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  authBase?: string;
}): string {
  const base = (input.authBase ?? GOOGLE_DEFAULT_AUTH_BASE).replace(/\/+$/, "");
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  });
  return `${base}/o/oauth2/v2/auth?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token endpoint (exchange + refresh) — fetch polos, pola klien Resend
// ---------------------------------------------------------------------------

export interface GoogleTokenSet {
  accessToken: string;
  /** Null bila Google tidak menerbitkan refresh token pada grant ini. */
  refreshToken: string | null;
  expiresInSec: number;
  scope: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  deps: GoogleDeps,
  form: URLSearchParams,
): Promise<GoogleTokenSet> {
  let res: Response;
  try {
    res = await fetch(`${tokenBase(deps)}/token`, {
      method: "POST",
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch {
    throw new Error("GOOGLE_UNREACHABLE: token endpoint tidak terjangkau");
  }
  const body = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!res.ok || !body.access_token) {
    const code = body.error ?? `http_${res.status}`;
    throw new Error(`GOOGLE_TOKEN_FAILED: ${code}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresInSec: typeof body.expires_in === "number" ? body.expires_in : 3600,
    scope: body.scope ?? "",
  };
}

/** Tukar authorization code → token (dipakai callback OAuth API). */
export async function exchangeGoogleAuthCode(
  deps: GoogleDeps,
  client: GoogleOAuthClientConfig,
  input: { code: string; redirectUri: string },
): Promise<GoogleTokenSet> {
  return postToken(
    deps,
    new URLSearchParams({
      code: input.code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }),
  );
}

async function refreshGoogleToken(
  deps: GoogleDeps,
  client: GoogleOAuthClientConfig,
  refreshToken: string,
): Promise<GoogleTokenSet> {
  return postToken(
    deps,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
    }),
  );
}

/** Email akun Google dari userinfo (untuk label koneksi); null bila gagal. */
export async function fetchGoogleAccountEmail(
  deps: GoogleDeps,
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase(deps)}/oauth2/v2/userinfo`, {
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { email?: unknown };
    return typeof body.email === "string" ? body.email : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Koneksi tenant: simpan / baca / putus (token selalu terenkripsi)
// ---------------------------------------------------------------------------

export async function getGoogleConnection(
  db: Database,
  tenantId: string,
): Promise<GoogleCalendarConnectionRow | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(googleCalendarConnections)
      .where(eq(googleCalendarConnections.tenantId, tenantId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Simpan koneksi dari grant OAuth baru (upsert per tenant). Refresh
 * token baru menggantikan yang lama; bila grant tidak membawa refresh
 * token baru, yang lama dipertahankan (Google hanya menerbitkannya
 * pada consent penuh — kita selalu meminta prompt=consent).
 */
export async function saveGoogleConnection(
  db: Database,
  tenantId: string,
  input: {
    tokens: GoogleTokenSet;
    accountEmail: string | null;
    tokenSecret: string;
  },
): Promise<GoogleCalendarConnectionRow> {
  const expiresAt = new Date(Date.now() + input.tokens.expiresInSec * 1000);
  return withTenantDb(db, tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(googleCalendarConnections)
      .where(eq(googleCalendarConnections.tenantId, tenantId))
      .limit(1);
    const values = {
      tenantId,
      accountEmail: input.accountEmail ?? existing?.accountEmail ?? null,
      calendarId: existing?.calendarId ?? "primary",
      accessTokenEncrypted: encryptChannelSecret(
        input.tokenSecret,
        input.tokens.accessToken,
      ),
      refreshTokenEncrypted: input.tokens.refreshToken
        ? encryptChannelSecret(input.tokenSecret, input.tokens.refreshToken)
        : (existing?.refreshTokenEncrypted ?? null),
      tokenExpiresAt: expiresAt,
      scopes: input.tokens.scope || existing?.scopes || "",
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(googleCalendarConnections)
      .values(values)
      .onConflictDoUpdate({
        target: googleCalendarConnections.tenantId,
        set: values,
      })
      .returning();
    return row!;
  });
}

/** Putus koneksi (baris dihapus; booking lama mempertahankan jejak sinkronnya). */
export async function deleteGoogleConnection(
  db: Database,
  tenantId: string,
): Promise<boolean> {
  return withTenantDb(db, tenantId, async (tx) => {
    const deleted = await tx
      .delete(googleCalendarConnections)
      .where(eq(googleCalendarConnections.tenantId, tenantId))
      .returning({ id: googleCalendarConnections.id });
    return deleted.length > 0;
  });
}

/** Ganti kalender tujuan event pada koneksi yang ada. */
export async function setGoogleConnectionCalendar(
  db: Database,
  tenantId: string,
  calendarId: string,
): Promise<GoogleCalendarConnectionRow | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .update(googleCalendarConnections)
      .set({ calendarId, updatedAt: new Date() })
      .where(eq(googleCalendarConnections.tenantId, tenantId))
      .returning();
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// Akses token yang sah (refresh bila hampir kedaluwarsa)
// ---------------------------------------------------------------------------

const REFRESH_SKEW_MS = 60_000;

export interface GoogleAccess {
  accessToken: string;
  connection: GoogleCalendarConnectionRow;
}

/**
 * Access token tenant yang masih berlaku; me-refresh (dan menyimpan
 * hasilnya) bila kedaluwarsa dalam 60 detik. Null bila: tidak ada
 * koneksi, secret enkripsi tak tersedia, klien platform tak
 * terkonfigurasi, atau refresh gagal (grant dicabut) — pemanggil
 * memperlakukan null sebagai "Google tidak tersedia" (fail-soft),
 * BUKAN sebagai kegagalan operasi utamanya.
 */
export async function getValidGoogleAccess(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
): Promise<GoogleAccess | null> {
  if (!deps.tokenSecret) return null;
  const connection = await getGoogleConnection(db, tenantId);
  if (!connection) return null;
  if (connection.tokenExpiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
    const accessToken = decryptChannelSecret(
      deps.tokenSecret,
      connection.accessTokenEncrypted,
    );
    return accessToken ? { accessToken, connection } : null;
  }
  if (!connection.refreshTokenEncrypted) return null;
  const refreshToken = decryptChannelSecret(
    deps.tokenSecret,
    connection.refreshTokenEncrypted,
  );
  if (!refreshToken) return null;
  const client = await resolveGoogleOAuthClient(db, deps.platform);
  if (!client) return null;
  let tokens: GoogleTokenSet;
  try {
    tokens = await refreshGoogleToken(deps, client, refreshToken);
  } catch {
    return null;
  }
  const updated = await saveGoogleConnection(db, tenantId, {
    tokens,
    accountEmail: connection.accountEmail,
    tokenSecret: deps.tokenSecret,
  });
  return { accessToken: tokens.accessToken, connection: updated };
}

// ---------------------------------------------------------------------------
// Calendar API: daftar kalender + freebusy (umpan mesin slot)
// ---------------------------------------------------------------------------

export interface GoogleCalendarOption {
  id: string;
  summary: string;
  primary: boolean;
}

/** Daftar kalender akun (untuk pemilih kalender dashboard). */
export async function listGoogleCalendars(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
): Promise<GoogleCalendarOption[] | null> {
  const access = await getValidGoogleAccess(db, tenantId, deps);
  if (!access) return null;
  let res: Response;
  try {
    res = await fetch(
      `${apiBase(deps)}/calendar/v3/users/me/calendarList?maxResults=50`,
      {
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        headers: { Authorization: "Bearer " + access.accessToken },
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as {
    items?: Array<{ id?: unknown; summary?: unknown; primary?: unknown }>;
  };
  const items = Array.isArray(body.items) ? body.items : [];
  return items
    .filter((i) => typeof i.id === "string")
    .map((i) => ({
      id: i.id as string,
      summary: typeof i.summary === "string" ? i.summary : (i.id as string),
      primary: i.primary === true,
    }));
}

export interface GoogleBusyInterval {
  start: Date;
  end: Date;
}

/**
 * Interval sibuk Google pada kalender tujuan dalam [from, to).
 * FAIL-SOFT: keadaan apa pun yang gagal (tak terhubung, token mati,
 * provider error) menghasilkan [] — mesin slot tetap menjawab dari
 * data internal; kegagalan freebusy tidak menggagalkan pemesanan.
 */
export async function fetchGoogleBusyIntervals(
  db: Database,
  tenantId: string,
  deps: GoogleDeps,
  range: { from: Date; to: Date },
): Promise<GoogleBusyInterval[]> {
  const access = await getValidGoogleAccess(db, tenantId, deps);
  if (!access) return [];
  let res: Response;
  try {
    res = await fetch(`${apiBase(deps)}/calendar/v3/freeBusy`, {
      method: "POST",
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      headers: {
        Authorization: "Bearer " + access.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: range.from.toISOString(),
        timeMax: range.to.toISOString(),
        items: [{ id: access.connection.calendarId }],
      }),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as {
    calendars?: Record<
      string,
      { busy?: Array<{ start?: unknown; end?: unknown }> }
    >;
  };
  const cal = body.calendars?.[access.connection.calendarId];
  const busy = Array.isArray(cal?.busy) ? cal.busy : [];
  const out: GoogleBusyInterval[] = [];
  for (const b of busy) {
    if (typeof b.start !== "string" || typeof b.end !== "string") continue;
    const start = new Date(b.start);
    const end = new Date(b.end);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      out.push({ start, end });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sinkron event per booking (dijalankan job worker dari outbox)
// ---------------------------------------------------------------------------

export type GoogleSyncAction = "create" | "delete";

export type GoogleSyncResult =
  | { kind: "synced"; eventId: string }
  | { kind: "deleted" }
  | { kind: "not_connected" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

function syncErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, SYNC_ERROR_MAX);
}

async function patchBookingSync(
  tx: DbTx,
  tenantId: string,
  bookingId: string,
  patch: Partial<BookingRow>,
): Promise<void> {
  await tx
    .update(bookings)
    .set(patch)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId)));
}

/**
 * Jalankan SATU aksi sinkron untuk SATU booking (inti job
 * `appointment.google_sync`). Membaca keadaan booking terkini di dalam
 * tenant DB; hasil akhir selalu tercatat di baris booking. TIDAK
 * PERNAH melempar untuk kegagalan provider — hasil `failed` adalah
 * nilai kembalian (job selesai; jejaknya di booking + log worker).
 */
export async function syncBookingToGoogle(
  db: Database,
  deps: GoogleDeps,
  input: { tenantId: string; bookingId: string; action: GoogleSyncAction },
): Promise<GoogleSyncResult> {
  const { tenantId, bookingId } = input;
  const snapshot = await withTenantDb(db, tenantId, async (tx) => {
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId)))
      .limit(1);
    return booking ?? null;
  });
  if (!snapshot) return { kind: "skipped", reason: "booking_not_found" };

  const access = await getValidGoogleAccess(db, tenantId, deps);
  if (!access) {
    await withTenantDb(db, tenantId, (tx) =>
      patchBookingSync(tx, tenantId, bookingId, {
        googleSyncStatus:
          snapshot.googleSyncStatus === "synced"
            ? "synced"
            : "not_connected",
        googleSyncError: null,
      }),
    );
    return { kind: "not_connected" };
  }
  const calendarId = encodeURIComponent(access.connection.calendarId);
  const headers = {
    Authorization: "Bearer " + access.accessToken,
    "Content-Type": "application/json",
  };

  if (input.action === "create") {
    if (snapshot.status !== "confirmed") {
      // Booking sudah dibatalkan sebelum job create berjalan — jangan
      // menciptakan event untuk janji yang tidak jadi.
      await withTenantDb(db, tenantId, (tx) =>
        patchBookingSync(tx, tenantId, bookingId, {
          googleSyncStatus: "not_connected",
          googleSyncError: null,
        }),
      );
      return { kind: "skipped", reason: "booking_cancelled" };
    }
    if (snapshot.googleEventId) {
      return { kind: "synced", eventId: snapshot.googleEventId };
    }
    const detail = await withTenantDb(db, tenantId, async (tx) => {
      const [svc] = await tx
        .select({ name: appointmentServices.name })
        .from(appointmentServices)
        .where(eq(appointmentServices.id, snapshot.serviceId))
        .limit(1);
      const [ctc] = await tx
        .select({ name: contacts.name })
        .from(contacts)
        .where(eq(contacts.id, snapshot.contactId))
        .limit(1);
      return { serviceName: svc?.name ?? null, contactName: ctc?.name ?? null };
    }).catch(() => ({ serviceName: null, contactName: null }));
    try {
      // ID event DETERMINISTIK dari id booking (UUID tanpa tanda
      // hubung = 32 karakter hex, seluruhnya di dalam abjad yang
      // diizinkan Google Calendar: base32hex `0-9a-v`).
      //
      // Ini satu-satunya idempotensi yang tersedia di Calendar API
      // (tidak ada Idempotency-Key seperti di jalur pembayaran).
      // Tanpa ini ada jendela duplikat nyata: worker sempat membuat
      // event di Google lalu mati sebelum `patchBookingSync` mencatat
      // `googleEventId`. BullMQ mengulang job yang stalled, percobaan
      // kedua tidak menemukan jejak apa pun dan membuat event KEDUA —
      // janji yang sama muncul dua kali di kalender. Dengan id tetap,
      // percobaan ulang ditolak Google (409 duplicate) dan kita
      // menyimpulkan event-nya memang sudah ada.
      const eventId = snapshot.id.replace(/-/g, "");
      const res = await fetch(
        `${apiBase(deps)}/calendar/v3/calendars/${calendarId}/events`,
        {
          method: "POST",
          signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
          headers,
          body: JSON.stringify({
            id: eventId,
            summary:
              `Sahabat Kreator — ${detail.serviceName ?? "Appointment"}` +
              (detail.contactName ? ` — ${detail.contactName}` : ""),
            description: `Booking ${snapshot.id} (source: ${snapshot.source})`,
            start: { dateTime: snapshot.startsAt.toISOString() },
            end: { dateTime: snapshot.endsAt.toISOString() },
          }),
        },
      );
      // 409 = event dengan id itu sudah ada (percobaan sebelumnya
      // berhasil tetapi jejaknya belum tercatat). Sukses, bukan gagal.
      const alreadyExists = res.status === 409;
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      const createdId = alreadyExists
        ? eventId
        : typeof body.id === "string"
          ? body.id
          : null;
      if (!createdId) {
        throw new Error(`GOOGLE_EVENT_CREATE_FAILED: http_${res.status}`);
      }
      await withTenantDb(db, tenantId, (tx) =>
        patchBookingSync(tx, tenantId, bookingId, {
          googleEventId: createdId,
          googleSyncStatus: "synced",
          googleSyncError: null,
        }),
      );
      return { kind: "synced", eventId: createdId };
    } catch (err) {
      const error = syncErrorText(err);
      await withTenantDb(db, tenantId, (tx) =>
        patchBookingSync(tx, tenantId, bookingId, {
          googleSyncStatus: "failed",
          googleSyncError: error,
        }),
      );
      return { kind: "failed", error };
    }
  }

  // action === "delete"
  if (snapshot.status === "confirmed") {
    // Booking ternyata masih hidup (urutan event bertukar) — jangan
    // menghapus event janji yang sah.
    return { kind: "skipped", reason: "booking_still_confirmed" };
  }
  if (!snapshot.googleEventId) {
    await withTenantDb(db, tenantId, (tx) =>
      patchBookingSync(tx, tenantId, bookingId, {
        googleSyncStatus: "not_connected",
        googleSyncError: null,
      }),
    );
    return { kind: "deleted" };
  }
  try {
    const res = await fetch(
      `${apiBase(deps)}/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(snapshot.googleEventId)}`,
      {
        method: "DELETE",
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        headers,
      },
    );
    // 204 = terhapus; 404/410 = memang sudah tidak ada — keduanya sukses.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`GOOGLE_EVENT_DELETE_FAILED: http_${res.status}`);
    }
    await withTenantDb(db, tenantId, (tx) =>
      patchBookingSync(tx, tenantId, bookingId, {
        googleEventId: null,
        googleSyncStatus: "not_connected",
        googleSyncError: null,
      }),
    );
    return { kind: "deleted" };
  } catch (err) {
    const error = syncErrorText(err);
    await withTenantDb(db, tenantId, (tx) =>
      patchBookingSync(tx, tenantId, bookingId, {
        googleSyncStatus: "failed",
        googleSyncError: error,
      }),
    );
    return { kind: "failed", error };
  }
}
