import { and, asc, eq, gt, gte, lt } from "drizzle-orm";
import {
  appointmentAvailability,
  appointmentServices,
  appointmentSettings,
  auditLogs,
  bookings,
  contacts,
  googleConnections,
  outboxEvents,
  type AppointmentAvailabilityRow,
  type AppointmentServiceRow,
  type AppointmentSettingRow,
  type BookingRow,
  type Database,
} from "@sahabat-kreator/db";
import { APPOINTMENT_REPLY_HINT } from "@sahabat-kreator/contracts";
import { withTenantDb, type DbTx } from "./tx";
import {
  APPOINTMENT_GOOGLE_SYNC_OUTBOX_TYPE,
  fetchGoogleBusyIntervals,
  type GoogleBusyInterval,
  type GoogleDeps,
} from "./google-calendar";

/**
 * Janji Temu (Fase 13G) — lapisan inti yang dipakai SEMUA permukaan:
 * - MESIN SLOT TUNGGAL `computeBookableSlots` (murni): slot = jendela
 *   ketersediaan mingguan ∩ masa depan (+ lead time minimum) − booking
 *   terkonfirmasi − interval sibuk Google (bila terhubung). Grid slot
 *   berjalan dari awal jendela dengan langkah = durasi layanan.
 * - SEMUA aritmetika dalam zona waktu janji tenant
 *   (`appointment_settings.timezone`, default Asia/Jakarta): jendela
 *   disimpan sebagai jam dinding; konversi jam-dinding → instan UTC
 *   hanya terjadi di sini lewat Intl (tanpa dependensi tanggal baru).
 *   Contoh yang dibuktikan rantai: jendela Selasa 00:30 Asia/Jakarta
 *   menghasilkan slot pada Senin 17:30 UTC — jendela yang melintasi
 *   tengah malam UTC tertangani karena iterasinya per TANGGAL LOKAL.
 * - Booking dibuat oleh `createBookingTx` (dipakai node flow di dalam
 *   transaksi evaluasinya — dibungkus savepoint agar pelanggaran
 *   constraint eksklusi bisa ditangkap sebagai SLOT_TAKEN tanpa
 *   membatalkan transaksi luar) dan oleh dashboard lewat
 *   `createBooking`. Constraint eksklusi GiST di DB adalah penjaga
 *   terakhir anti-tumpang-tindih; pemeriksaan overlap di memori hanya
 *   untuk UX daftar slot, bukan untuk kebenaran.
 * - Google adalah sinkronisasi: create/cancel menulis event outbox
 *   dalam transaksi booking (hanya bila koneksi ada → status awal
 *   `pending`; tanpa koneksi `not_connected`). Lihat google-calendar.ts.
 */

export const APPOINTMENT_DEFAULT_TIMEZONE = "Asia/Jakarta";
export const APPOINTMENT_DEFAULT_MIN_LEAD_MINUTES = 120;

// ---------------------------------------------------------------------------
// Aritmetika zona waktu (Intl murni)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtfFor(tz: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, dtf);
  }
  return dtf;
}

/**
 * True bila `tz` adalah zona yang dikenal runtime Intl.
 *
 * Selain nama IANA ("Asia/Jakarta"), ECMA-402 juga mengakui pengenal
 * offset seperti "+07:00". Itu diterima dengan sengaja: zona offset
 * berperilaku benar di seluruh fungsi di modul ini (tanpa DST, yang
 * memang artinya), dan menolaknya hanya akan membuat validasi berbeda
 * dari yang dipahami runtime. Yang ditolak adalah teks yang tidak
 * dikenali sama sekali, mis. "Asia/Jakartaa".
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(tz: string, instantMs: number): LocalParts {
  const parts = dtfFor(tz).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number.parseInt(p.value, 10) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset zona (lokal − UTC) dalam ms pada satu instan. */
export function tzOffsetMs(tz: string, instantMs: number): number {
  const p = localParts(tz, instantMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Konversi jam dinding (tanggal + HH:mm dalam zona) → instan UTC (ms).
 * Dua lintasan koreksi offset agar batas DST (offset berubah di antara
 * tebakan dan hasil) tetap tepat untuk zona yang memilikinya.
 */
export function zonedWallToUtcMs(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = wallAsUtc - tzOffsetMs(tz, wallAsUtc);
  return wallAsUtc - tzOffsetMs(tz, first);
}

/** Tanggal kalender lokal (zona) dari satu instan. */
export function localDateOf(
  tz: string,
  instantMs: number,
): { year: number; month: number; day: number } {
  const p = localParts(tz, instantMs);
  return { year: p.year, month: p.month, day: p.day };
}

/** Weekday (0=Minggu..6=Sabtu) dari tanggal kalender — fakta kalender murni. */
export function weekdayOfDate(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const WEEKDAY_NAMES: Record<string, string[]> = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  id: ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"],
};
const MONTH_NAMES_EN = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function hhmmInTz(tz: string, instantMs: number): string {
  const p = localParts(tz, instantMs);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Label satu slot untuk daftar chat/dashboard — dwibahasa dalam satu
 * baris: "Tuesday/Selasa, 4 Nov 2026 — 09:00–09:30". Tanggal & jam
 * selalu dalam zona janji tenant (bukan zona perangkat pembaca).
 */
export function formatAppointmentSlot(
  tz: string,
  startsAt: Date,
  endsAt: Date,
): string {
  const p = localParts(tz, startsAt.getTime());
  const weekday = weekdayOfDate(p.year, p.month, p.day);
  const en = WEEKDAY_NAMES.en[weekday]!;
  const id = WEEKDAY_NAMES.id[weekday]!;
  return (
    `${en}/${id}, ${p.day} ${MONTH_NAMES_EN[p.month - 1]} ${p.year}` +
    ` — ${hhmmInTz(tz, startsAt.getTime())}–${hhmmInTz(tz, endsAt.getTime())}`
  );
}

/**
 * Render daftar slot bernomor untuk node flow (+ dipakai pratinjau):
 * teks pembuka opsional (sudah dirender pemanggil) + satu baris per
 * slot + petunjuk balasan kanonis dwibahasa dari kontrak.
 */
export function renderSlotListText(
  slots: Array<{ startsAt: Date; endsAt: Date }>,
  tz: string,
  opts?: { introText?: string | null },
): string {
  const lines = slots.map(
    (s, i) => `${i + 1}. ${formatAppointmentSlot(tz, s.startsAt, s.endsAt)}`,
  );
  const body = lines.join("\n");
  const intro = opts?.introText ? `${opts.introText}\n` : "";
  return `${intro}${body}\n${APPOINTMENT_REPLY_HINT}`;
}

/**
 * Parsing balasan pilihan slot: nomor polos "N" (1..count). Berbeda
 * dari katalog, "NxM" TIDAK sah di sini — janji tidak punya kuantitas.
 */
export function parseSlotSelection(
  text: string,
  count: number,
): { index: number } | null {
  const m = /^(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isInteger(n) || n < 1 || n > count) return null;
  return { index: n - 1 };
}

// ---------------------------------------------------------------------------
// Pengaturan tenant (dibuat malas — pola tenant_opt_in_settings 13C)
// ---------------------------------------------------------------------------

export interface AppointmentSettingsData {
  timezone: string;
  minLeadMinutes: number;
  updatedAt: Date;
}

async function getOrCreateSettingsTx(
  tx: DbTx,
  tenantId: string,
): Promise<AppointmentSettingRow> {
  const [existing] = await tx
    .select()
    .from(appointmentSettings)
    .where(eq(appointmentSettings.tenantId, tenantId))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx
    .insert(appointmentSettings)
    .values({ tenantId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [row] = await tx
    .select()
    .from(appointmentSettings)
    .where(eq(appointmentSettings.tenantId, tenantId))
    .limit(1);
  return row!;
}

/** Pengaturan janji tenant (baris dibuat malas dengan bawaan bila belum ada). */
export async function getAppointmentSettings(
  db: Database,
  tenantId: string,
): Promise<AppointmentSettingsData> {
  return withTenantDb(db, tenantId, async (tx) => {
    const row = await getOrCreateSettingsTx(tx, tenantId);
    return {
      timezone: row.timezone,
      minLeadMinutes: row.minLeadMinutes,
      updatedAt: row.updatedAt,
    };
  });
}

export class AppointmentSettingsError extends Error {
  code = "APPOINTMENT_TIMEZONE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "AppointmentSettingsError";
  }
}

/** Ubah pengaturan janji; zona divalidasi terhadap registri IANA Intl. */
export async function updateAppointmentSettings(
  db: Database,
  tenantId: string,
  patch: { timezone?: string; minLeadMinutes?: number },
): Promise<AppointmentSettingsData> {
  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
    throw new AppointmentSettingsError(
      `zona waktu tidak dikenal: ${patch.timezone}`,
    );
  }
  return withTenantDb(db, tenantId, async (tx) => {
    const row = await getOrCreateSettingsTx(tx, tenantId);
    const [updated] = await tx
      .update(appointmentSettings)
      .set({
        ...(patch.timezone !== undefined
          ? { timezone: patch.timezone }
          : {}),
        ...(patch.minLeadMinutes !== undefined
          ? { minLeadMinutes: patch.minLeadMinutes }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(appointmentSettings.tenantId, tenantId))
      .returning();
    void row;
    return {
      timezone: updated!.timezone,
      minLeadMinutes: updated!.minLeadMinutes,
      updatedAt: updated!.updatedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Layanan janji: CRUD dashboard
// ---------------------------------------------------------------------------

export async function listAppointmentServices(
  db: Database,
  tenantId: string,
  opts?: { activeOnly?: boolean },
): Promise<AppointmentServiceRow[]> {
  return withTenantDb(db, tenantId, async (tx) => {
    return tx
      .select()
      .from(appointmentServices)
      .where(
        and(
          eq(appointmentServices.tenantId, tenantId),
          ...(opts?.activeOnly
            ? [eq(appointmentServices.isActive, true)]
            : []),
        ),
      )
      .orderBy(asc(appointmentServices.createdAt));
  });
}

export async function getAppointmentService(
  db: Database,
  tenantId: string,
  serviceId: string,
): Promise<AppointmentServiceRow | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(appointmentServices)
      .where(
        and(
          eq(appointmentServices.tenantId, tenantId),
          eq(appointmentServices.id, serviceId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function createAppointmentService(
  db: Database,
  tenantId: string,
  input: {
    name: string;
    description?: string | null;
    durationMinutes: number;
    isActive?: boolean;
  },
): Promise<AppointmentServiceRow> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .insert(appointmentServices)
      .values({
        tenantId,
        name: input.name,
        description: input.description ?? null,
        durationMinutes: input.durationMinutes,
        isActive: input.isActive ?? true,
      })
      .returning();
    return row!;
  });
}

export async function updateAppointmentService(
  db: Database,
  tenantId: string,
  serviceId: string,
  patch: {
    name?: string;
    description?: string | null;
    durationMinutes?: number;
    isActive?: boolean;
  },
): Promise<AppointmentServiceRow | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .update(appointmentServices)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(appointmentServices.tenantId, tenantId),
          eq(appointmentServices.id, serviceId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/** Hapus layanan (booking-nya ikut terhapus oleh FK cascade — keputusan skema). */
export async function deleteAppointmentService(
  db: Database,
  tenantId: string,
  serviceId: string,
): Promise<boolean> {
  return withTenantDb(db, tenantId, async (tx) => {
    const deleted = await tx
      .delete(appointmentServices)
      .where(
        and(
          eq(appointmentServices.tenantId, tenantId),
          eq(appointmentServices.id, serviceId),
        ),
      )
      .returning({ id: appointmentServices.id });
    return deleted.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Ketersediaan mingguan
// ---------------------------------------------------------------------------

export interface AvailabilityWindowData {
  weekday: number;
  startTime: string;
  endTime: string;
}

export async function listAppointmentAvailability(
  db: Database,
  tenantId: string,
): Promise<AvailabilityWindowData[]> {
  return withTenantDb(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(appointmentAvailability)
      .where(eq(appointmentAvailability.tenantId, tenantId))
      .orderBy(
        asc(appointmentAvailability.weekday),
        asc(appointmentAvailability.startTime),
      );
    return rows.map((r) => ({
      weekday: r.weekday,
      startTime: r.startTime,
      endTime: r.endTime,
    }));
  });
}

/** Ganti seluruh jendela mingguan (semantik replace — satu-satunya pola tulis editor). */
export async function replaceAppointmentAvailability(
  db: Database,
  tenantId: string,
  windows: AvailabilityWindowData[],
): Promise<AvailabilityWindowData[]> {
  return withTenantDb(db, tenantId, async (tx) => {
    await tx
      .delete(appointmentAvailability)
      .where(eq(appointmentAvailability.tenantId, tenantId));
    if (windows.length > 0) {
      await tx.insert(appointmentAvailability).values(
        windows.map((w) => ({
          tenantId,
          weekday: w.weekday,
          startTime: w.startTime,
          endTime: w.endTime,
        })),
      );
    }
    const rows = await tx
      .select()
      .from(appointmentAvailability)
      .where(eq(appointmentAvailability.tenantId, tenantId))
      .orderBy(
        asc(appointmentAvailability.weekday),
        asc(appointmentAvailability.startTime),
      );
    return rows.map((r) => ({
      weekday: r.weekday,
      startTime: r.startTime,
      endTime: r.endTime,
    }));
  });
}

// ---------------------------------------------------------------------------
// MESIN SLOT — satu fungsi untuk chat + dashboard
// ---------------------------------------------------------------------------

export interface BookableSlot {
  startsAt: Date;
  endsAt: Date;
}

function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Inti murni mesin slot (tanpa DB): menerima semua bahan dan
 * mengembalikan slot yang bisa dipesan, menaik per waktu mulai.
 * Diekspor agar logikanya bisa diuji terpisah dari lapisan data.
 *
 * Aturan: untuk setiap tanggal LOKAL dalam [from, to], untuk setiap
 * jendela pada weekday tanggal itu: kandidat berjalan dari awal
 * jendela dengan langkah durasi; kandidat hanya sah bila (1) utuh di
 * dalam jendela, (2) mulai ≥ max(from, now + lead), (3) mulai < to,
 * (4) tidak bertumpang tindih booking terkonfirmasi maupun interval
 * sibuk tambahan (Google). Iterasi per tanggal lokal — BUKAN per hari
 * UTC — adalah yang membuat jendela melintasi tengah malam UTC benar.
 */
export function computeBookableSlots(input: {
  timezone: string;
  minLeadMinutes: number;
  durationMinutes: number;
  windows: AvailabilityWindowData[];
  confirmed: Array<{ start: Date; end: Date }>;
  extraBusy: Array<{ start: Date; end: Date }>;
  from: Date;
  to: Date;
  now: Date;
}): BookableSlot[] {
  const tz = input.timezone;
  const durationMs = input.durationMinutes * 60_000;
  const earliest = Math.max(
    input.from.getTime(),
    input.now.getTime() + input.minLeadMinutes * 60_000,
  );
  const toMs = input.to.getTime();
  const busy = [...input.confirmed, ...input.extraBusy].map(
    (b) => [b.start.getTime(), b.end.getTime()] as const,
  );
  const windowsByWeekday = new Map<number, AvailabilityWindowData[]>();
  for (const w of input.windows) {
    const list = windowsByWeekday.get(w.weekday) ?? [];
    list.push(w);
    windowsByWeekday.set(w.weekday, list);
  }
  const slots: BookableSlot[] = [];
  let cursor = localDateOf(tz, input.from.getTime());
  // Penjaga iterasi: rentang from→to yang wajar ≤ 62 hari lokal.
  for (let guard = 0; guard < 70; guard++) {
    const { year, month, day } = cursor;
    const dayStartUtcMs = zonedWallToUtcMs(tz, year, month, day, 0, 0);
    if (dayStartUtcMs >= toMs && guard > 0) break;
    const windows = windowsByWeekday.get(weekdayOfDate(year, month, day)) ?? [];
    for (const w of windows) {
      const [sh, sm] = w.startTime.split(":").map((x) => Number.parseInt(x, 10));
      const [eh, em] = w.endTime.split(":").map((x) => Number.parseInt(x, 10));
      const windowStart = zonedWallToUtcMs(tz, year, month, day, sh!, sm!);
      const windowEnd = zonedWallToUtcMs(tz, year, month, day, eh!, em!);
      for (
        let slotStart = windowStart;
        slotStart + durationMs <= windowEnd;
        slotStart += durationMs
      ) {
        const slotEnd = slotStart + durationMs;
        if (slotStart < earliest || slotStart >= toMs) continue;
        if (busy.some(([bs, be]) => intervalsOverlap(slotStart, slotEnd, bs, be))) {
          continue;
        }
        slots.push({
          startsAt: new Date(slotStart),
          endsAt: new Date(slotEnd),
        });
      }
    }
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    cursor = {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
    };
    if (dayStartUtcMs >= toMs) break;
  }
  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots;
}

/**
 * Mesin slot penuh: memuat layanan + pengaturan + jendela + booking
 * terkonfirmasi dari DB, memotong dengan kesibukan Google bila
 * `googleDeps` diberikan DAN tenant terhubung (freebusy fail-soft:
 * kegagalan Google tidak pernah mengosongkan daftar secara diam-diam
 * selain melewatkan potongan sibuknya). Mengembalikan null bila
 * layanan tidak ada di tenant ini.
 */
export async function getBookableSlots(
  db: Database,
  tenantId: string,
  serviceId: string,
  range: { from: Date; to: Date; now?: Date },
  googleDeps?: GoogleDeps,
): Promise<{
  service: AppointmentServiceRow;
  settings: AppointmentSettingsData;
  slots: BookableSlot[];
} | null> {
  const loaded = await withTenantDb(db, tenantId, async (tx) => {
    const [service] = await tx
      .select()
      .from(appointmentServices)
      .where(
        and(
          eq(appointmentServices.tenantId, tenantId),
          eq(appointmentServices.id, serviceId),
        ),
      )
      .limit(1);
    if (!service) return null;
    const settings = await getOrCreateSettingsTx(tx, tenantId);
    const windows = await tx
      .select()
      .from(appointmentAvailability)
      .where(eq(appointmentAvailability.tenantId, tenantId));
    const confirmed = await tx
      .select({ start: bookings.startsAt, end: bookings.endsAt })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          eq(bookings.status, "confirmed"),
          lt(bookings.startsAt, range.to),
          gt(bookings.endsAt, range.from),
        ),
      );
    return { service, settings, windows, confirmed };
  });
  if (!loaded) return null;
  let extraBusy: GoogleBusyInterval[] = [];
  if (googleDeps) {
    extraBusy = await fetchGoogleBusyIntervals(db, tenantId, googleDeps, range);
  }
  const slots = computeBookableSlots({
    timezone: loaded.settings.timezone,
    minLeadMinutes: loaded.settings.minLeadMinutes,
    durationMinutes: loaded.service.durationMinutes,
    windows: loaded.windows.map((w) => ({
      weekday: w.weekday,
      startTime: w.startTime,
      endTime: w.endTime,
    })),
    confirmed: loaded.confirmed,
    extraBusy,
    from: range.from,
    to: range.to,
    now: range.now ?? new Date(),
  });
  return {
    service: loaded.service,
    settings: {
      timezone: loaded.settings.timezone,
      minLeadMinutes: loaded.settings.minLeadMinutes,
      updatedAt: loaded.settings.updatedAt,
    },
    slots,
  };
}

// ---------------------------------------------------------------------------
// Booking: buat & batal
// ---------------------------------------------------------------------------

/** Pilihan slot keburu diambil (constraint eksklusi DB menolak insert). */
export class SlotTakenError extends Error {
  code = "SLOT_TAKEN";
  constructor(message = "slot sudah terisi booking terkonfirmasi lain") {
    super(message);
    this.name = "SlotTakenError";
  }
}

/** Layanan tidak ditemukan di tenant ini. */
export class AppointmentServiceNotFoundError extends Error {
  code = "APPOINTMENT_SERVICE_NOT_FOUND";
  constructor() {
    super("layanan janji tidak ditemukan");
    this.name = "AppointmentServiceNotFoundError";
  }
}

function isExclusionViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === "23P01") return true;
    if (
      typeof e.message === "string" &&
      e.message.includes("bookings_no_overlap_confirmed")
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

export interface CreateBookingInput {
  serviceId: string;
  contactId: string;
  conversationId?: string | null;
  startsAt: Date;
  source: "flow" | "dashboard";
  actorType: "user" | "system";
  actorId: string;
}

/**
 * Buat booking DALAM transaksi pemanggil (pola addToCartTx 13F):
 * endsAt diturunkan dari durasi layanan. Pelanggaran constraint
 * eksklusi diterjemahkan menjadi SlotTakenError — pemanggil flow
 * membungkusnya dalam savepoint agar transaksinya selamat. Bila
 * tenant terhubung Google, status awal `pending` + event outbox
 * sinkron ditulis dalam transaksi yang sama; tanpa koneksi status
 * awal `not_connected` dan tidak ada event.
 */
export async function createBookingTx(
  tx: DbTx,
  tenantId: string,
  input: CreateBookingInput,
): Promise<BookingRow> {
  const [service] = await tx
    .select()
    .from(appointmentServices)
    .where(
      and(
        eq(appointmentServices.tenantId, tenantId),
        eq(appointmentServices.id, input.serviceId),
      ),
    )
    .limit(1);
  if (!service) throw new AppointmentServiceNotFoundError();
  const endsAt = new Date(
    input.startsAt.getTime() + service.durationMinutes * 60_000,
  );
  // Koneksi yang menentukan status sinkron booking adalah koneksi
  // layanan CALENDAR (pemisahan Google) — koneksi YouTube/Business
  // tenant tidak membuat booking berstatus pending.
  const [connection] = await tx
    .select({ id: googleConnections.id })
    .from(googleConnections)
    .where(
      and(
        eq(googleConnections.tenantId, tenantId),
        eq(googleConnections.service, "calendar"),
      ),
    )
    .limit(1);
  const googleSyncStatus = connection ? "pending" : "not_connected";
  let booking: BookingRow;
  try {
    const [row] = await tx
      .insert(bookings)
      .values({
        tenantId,
        serviceId: service.id,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        startsAt: input.startsAt,
        endsAt,
        status: "confirmed",
        source: input.source,
        googleSyncStatus,
      })
      .returning();
    booking = row!;
  } catch (err) {
    if (isExclusionViolation(err)) throw new SlotTakenError();
    throw err;
  }
  if (connection) {
    await tx.insert(outboxEvents).values({
      tenantId,
      type: APPOINTMENT_GOOGLE_SYNC_OUTBOX_TYPE,
      payload: { bookingId: booking.id, action: "create" },
    });
  }
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: "appointment.booked",
    meta: {
      bookingId: booking.id,
      serviceId: service.id,
      contactId: input.contactId,
      startsAt: input.startsAt.toISOString(),
      source: input.source,
    },
  });
  return booking;
}

/** Buat booking (transaksi sendiri) — jalur dashboard. */
export async function createBooking(
  db: Database,
  tenantId: string,
  input: CreateBookingInput,
): Promise<BookingRow> {
  return withTenantDb(db, tenantId, (tx) =>
    createBookingTx(tx, tenantId, input),
  );
}

export interface BookingWithNames {
  booking: BookingRow;
  serviceName: string | null;
  contactName: string | null;
}

/** Daftar booking tenant (untuk v1 & dashboard): saring rentang/status. */
export async function listBookings(
  db: Database,
  tenantId: string,
  opts?: {
    from?: Date;
    to?: Date;
    status?: BookingRow["status"];
    limit?: number;
  },
): Promise<BookingWithNames[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  return withTenantDb(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        booking: bookings,
        serviceName: appointmentServices.name,
        contactName: contacts.name,
      })
      .from(bookings)
      .leftJoin(
        appointmentServices,
        eq(appointmentServices.id, bookings.serviceId),
      )
      .leftJoin(contacts, eq(contacts.id, bookings.contactId))
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          ...(opts?.from ? [gte(bookings.startsAt, opts.from)] : []),
          ...(opts?.to ? [lt(bookings.startsAt, opts.to)] : []),
          ...(opts?.status ? [eq(bookings.status, opts.status)] : []),
        ),
      )
      .orderBy(asc(bookings.startsAt))
      .limit(limit);
    return rows.map((r) => ({
      booking: r.booking,
      serviceName: r.serviceName,
      contactName: r.contactName,
    }));
  });
}

/** Satu booking tenant dengan nama layanan/kontak; null bila bukan miliknya. */
export async function getBooking(
  db: Database,
  tenantId: string,
  bookingId: string,
): Promise<BookingWithNames | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        booking: bookings,
        serviceName: appointmentServices.name,
        contactName: contacts.name,
      })
      .from(bookings)
      .leftJoin(
        appointmentServices,
        eq(appointmentServices.id, bookings.serviceId),
      )
      .leftJoin(contacts, eq(contacts.id, bookings.contactId))
      .where(
        and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId)),
      )
      .limit(1);
    if (!row) return null;
    return {
      booking: row.booking,
      serviceName: row.serviceName,
      contactName: row.contactName,
    };
  });
}

/**
 * Batalkan booking: status → cancelled + cancelled_at (constraint
 * eksklusi parsial membebaskan rentangnya seketika). Bila booking
 * punya jejak Google (event ada / sinkron tertunda), event outbox
 * delete ditulis dan status sinkron menjadi `pending` sampai job
 * menyelesaikan penghapusan. Idempoten: booking yang sudah cancelled
 * dikembalikan apa adanya tanpa event/audit baru.
 */
export async function cancelBooking(
  db: Database,
  tenantId: string,
  bookingId: string,
  actor: { actorType: "user" | "system"; actorId: string },
): Promise<BookingRow | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId)))
      .limit(1);
    if (!booking) return null;
    if (booking.status === "cancelled") return booking;
    const needsGoogleDelete =
      booking.googleEventId !== null || booking.googleSyncStatus === "pending";
    // Klaim atomik: `status = 'confirmed'` di WHERE membuat hanya SATU
    // pembatalan yang menang. Tanpa penjaga ini dua permintaan
    // bersamaan (klik ganda di dashboard, atau cancel dari flow +
    // dashboard) sama-sama lolos pemeriksaan di atas dan menulis dua
    // baris audit + dua event outbox delete untuk booking yang sama.
    const [updated] = await tx
      .update(bookings)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        ...(needsGoogleDelete ? { googleSyncStatus: "pending" as const } : {}),
      })
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          eq(bookings.id, bookingId),
          eq(bookings.status, "confirmed"),
        ),
      )
      .returning();
    if (!updated) {
      // Kalah balapan: pembatalan lain sudah menulis. Kembalikan
      // keadaan terbaru tanpa event/audit tambahan (idempoten).
      const [latest] = await tx
        .select()
        .from(bookings)
        .where(
          and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId)),
        )
        .limit(1);
      return latest ?? booking;
    }
    if (needsGoogleDelete) {
      await tx.insert(outboxEvents).values({
        tenantId,
        type: APPOINTMENT_GOOGLE_SYNC_OUTBOX_TYPE,
        payload: { bookingId, action: "delete" },
      });
    }
    await tx.insert(auditLogs).values({
      tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "appointment.cancelled",
      meta: { bookingId, serviceId: booking.serviceId },
    });
    return updated!;
  });
}

export type { AppointmentAvailabilityRow };
