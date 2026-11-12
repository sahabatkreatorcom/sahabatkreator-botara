import {
  isValidTimeZone,
  localDateOf,
  tzOffsetMs,
  weekdayOfDate,
  zonedWallToUtcMs,
} from "./appointments";

/**
 * Matematika pola pengulangan KALENDER murni — dipakai bersama oleh
 * broadcast berulang (G9, `broadcast-recurrence.ts`) dan jadwal
 * postingan berulang + slot antrean rutin (Fase Susulan S2,
 * `post-recurrence.ts` / `post-queue.ts`).
 *
 * Modul ini disengaja TIDAK tahu domain apa pun: ia hanya menjawab
 * "pola (frekuensi, interval, hari aktif, tanggal bulanan, zona
 * waktu, jangkar) menembak pada instan apa saja". Ledger, klaim,
 * materialisasi, dan kondisi berhenti adalah urusan modul domain
 * masing-masing — yang dibagi di sini hanyalah aritmetika kalender
 * yang sudah terbukti di G9:
 *
 * - Jam dinding tetap dari jangkar `startsAt` dalam zona pola:
 *   melintasi DST, jam dinding tidak bergeser (instan UTC-nya yang
 *   bergeser).
 * - Bulanan: tanggal melampaui akhir bulan DIJEPIT ke hari terakhir
 *   bulan itu (31 Jan → 28 Feb → 31 Mar), bukan dilewati; mode
 *   `lastDayOfMonth` selalu menembak di hari terakhir bulan.
 * - Mingguan: `daysOfWeek` kosong = hari yang sama dengan jangkar.
 * - Interval berlaku per satuan frekuensi (setiap N hari / minggu /
 *   bulan dihitung dari jangkar).
 */

export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export interface RecurrencePattern {
  frequency: RecurrenceFrequency;
  /** Setiap N (hari/minggu/bulan sesuai frequency). */
  interval: number;
  /** Weekly: hari aktif 0=Minggu..6=Sabtu; kosong = hari starts_at. */
  daysOfWeek: number[];
  /** Monthly: tanggal 1..31 (dijepit ke akhir bulan); null = tanggal starts_at. */
  dayOfMonth: number | null;
  /** Monthly: hari terakhir bulan (mengalahkan dayOfMonth). */
  lastDayOfMonth: boolean;
  /** Zona waktu IANA. */
  timezone: string;
  /** Jangkar: slot pertama + jam dinding semua slot. */
  startsAt: Date;
  /** Slot terakhir yang boleh (inklusif); null = tanpa batas. */
  endsAt: Date | null;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Hari sejak epoch untuk tanggal kalender (algoritma civil Hinnant). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): CivilDate {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

function lastDayOfMonth(year: number, month: number): number {
  const next =
    month === 12
      ? daysFromCivil(year + 1, 1, 1)
      : daysFromCivil(year, month + 1, 1);
  return civilFromDays(next - 1).day;
}

/** Jam dinding (jam:menit) satu instan dalam zona — detik diabaikan (slot selalu :00). */
function wallTimeOf(
  tz: string,
  instantMs: number,
): { hour: number; minute: number } {
  const local = new Date(instantMs + tzOffsetMs(tz, instantMs));
  return { hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

function anchorDateOf(pattern: RecurrencePattern): CivilDate {
  return localDateOf(pattern.timezone, pattern.startsAt.getTime());
}

function effectiveDaysOfWeek(pattern: RecurrencePattern, anchor: CivilDate): number[] {
  if (pattern.daysOfWeek.length > 0) {
    return [...new Set(pattern.daysOfWeek)].sort((a, b) => a - b);
  }
  return [weekdayOfDate(anchor.year, anchor.month, anchor.day)];
}

/** Apakah pola menembak pada tanggal kalender ini (tanpa memeriksa jam)? */
function patternFiresOnDate(
  pattern: RecurrencePattern,
  anchor: CivilDate,
  date: CivilDate,
): boolean {
  const dayNumber = daysFromCivil(date.year, date.month, date.day);
  const anchorDayNumber = daysFromCivil(anchor.year, anchor.month, anchor.day);
  const diffDays = dayNumber - anchorDayNumber;
  if (diffDays < 0) return false;
  if (pattern.frequency === "daily") {
    return diffDays % pattern.interval === 0;
  }
  if (pattern.frequency === "weekly") {
    const weekday = weekdayOfDate(date.year, date.month, date.day);
    if (!effectiveDaysOfWeek(pattern, anchor).includes(weekday)) return false;
    const anchorWeekday = weekdayOfDate(anchor.year, anchor.month, anchor.day);
    const weekDiff = Math.floor((diffDays + anchorWeekday - weekday) / 7);
    return weekDiff % pattern.interval === 0;
  }
  // monthly
  const monthDiff =
    (date.year - anchor.year) * 12 + (date.month - anchor.month);
  if (monthDiff < 0 || monthDiff % pattern.interval !== 0) return false;
  const last = lastDayOfMonth(date.year, date.month);
  const targetDay = pattern.lastDayOfMonth
    ? last
    : Math.min(pattern.dayOfMonth ?? anchor.day, last);
  return date.day === targetDay;
}

function slotInstantOnDate(
  pattern: RecurrencePattern,
  wall: { hour: number; minute: number },
  date: CivilDate,
): number {
  return zonedWallToUtcMs(
    pattern.timezone,
    date.year,
    date.month,
    date.day,
    wall.hour,
    wall.minute,
  );
}

/**
 * Slot pertama pada atau sesudah `boundMs` (dan tidak sebelum
 * starts_at). Null hanya bila pola secara internal tidak konsisten
 * (tidak tercapai untuk pola yang lolos validasi).
 *
 * Pemindaian maju per tanggal kalender dari tanggal lokal `bound`
 * (atau tanggal jangkar, mana yang lebih akhir): jendela pindai
 * dijamin memuat tembakan berikutnya untuk pola yang sah — daily
 * ≤ interval hari, weekly ≤ interval minggu + 1 minggu, monthly
 * ≤ (interval+1) bulan + 1 bulan.
 */
export function firstRecurrenceSlotAtOrAfter(
  pattern: RecurrencePattern,
  boundMs: number,
): Date | null {
  const tz = pattern.timezone;
  const startsMs = pattern.startsAt.getTime();
  const anchor = anchorDateOf(pattern);
  const wall = wallTimeOf(tz, startsMs);
  const boundLocal = localDateOf(tz, Math.max(boundMs, startsMs));
  const startDayNumber = Math.max(
    daysFromCivil(anchor.year, anchor.month, anchor.day),
    daysFromCivil(boundLocal.year, boundLocal.month, boundLocal.day) - 1,
  );
  const horizonDays =
    pattern.frequency === "daily"
      ? pattern.interval + 3
      : pattern.frequency === "weekly"
        ? pattern.interval * 7 + 8
        : (pattern.interval + 1) * 31 + 32;
  const cap = Math.min(horizonDays + 400, 5000);
  for (let i = 0; i <= cap; i++) {
    const date = civilFromDays(startDayNumber + i);
    if (!patternFiresOnDate(pattern, anchor, date)) continue;
    const instant = slotInstantOnDate(pattern, wall, date);
    if (instant >= boundMs && instant >= startsMs) {
      return new Date(instant);
    }
  }
  return null;
}

/** Slot pertama yang KETAT sesudah `afterMs`. */
export function nextRecurrenceSlotAfter(
  pattern: RecurrencePattern,
  afterMs: number,
): Date | null {
  return firstRecurrenceSlotAtOrAfter(pattern, afterMs + 1);
}

/**
 * Pratinjau slot berikutnya (untuk formulir): mulai dari slot
 * pertama pada/sesudah max(from, starts_at), berhenti pada endsAt.
 * Batas jumlah kejadian (maxOccurrences domain) SENGAJA tidak
 * diterapkan — pratinjau pola murni.
 */
export function previewRecurrenceSlots(
  pattern: RecurrencePattern,
  input: { count: number; from: Date },
): Date[] {
  const out: Date[] = [];
  let cursor = firstRecurrenceSlotAtOrAfter(
    pattern,
    Math.max(input.from.getTime(), pattern.startsAt.getTime()),
  );
  while (cursor && out.length < input.count) {
    if (pattern.endsAt && cursor.getTime() > pattern.endsAt.getTime()) break;
    out.push(cursor);
    cursor = nextRecurrenceSlotAfter(pattern, cursor.getTime());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validasi pola
// ---------------------------------------------------------------------------

export type RecurrenceValidationKind =
  | "invalid_interval"
  | "invalid_timezone"
  | "invalid_days_of_week"
  | "invalid_day_of_month"
  | "invalid_range"
  | "invalid_max_occurrences";

export function validateRecurrencePattern(
  pattern: RecurrencePattern,
): RecurrenceValidationKind | null {
  if (
    !Number.isInteger(pattern.interval) ||
    pattern.interval < 1 ||
    pattern.interval > 365
  ) {
    return "invalid_interval";
  }
  if (!isValidTimeZone(pattern.timezone)) return "invalid_timezone";
  if (
    pattern.daysOfWeek.some(
      (d) => !Number.isInteger(d) || d < 0 || d > 6,
    ) ||
    new Set(pattern.daysOfWeek).size !== pattern.daysOfWeek.length
  ) {
    return "invalid_days_of_week";
  }
  if (
    pattern.dayOfMonth !== null &&
    (!Number.isInteger(pattern.dayOfMonth) ||
      pattern.dayOfMonth < 1 ||
      pattern.dayOfMonth > 31)
  ) {
    return "invalid_day_of_month";
  }
  if (pattern.endsAt && pattern.endsAt.getTime() < pattern.startsAt.getTime()) {
    return "invalid_range";
  }
  return null;
}

/**
 * Pola mingguan untuk SLOT ANTREAN RUTIN (S2): slot didefinisikan
 * sebagai hari-hari aktif + jam dinding "HH:MM", bukan jangkar
 * bebas. Fungsi ini mengubah definisi itu menjadi pola bersama:
 * jangkar = tembakan pertama pada/sesudah `fromMs` pada hari aktif
 * terdekat dengan jam dinding tersebut dalam zona slot.
 *
 * Mengembalikan pola (startsAt = jangkar yang ditemukan) atau null
 * bila definisinya tidak sah (zona/hari/jam tidak valid — penjaga
 * memanggil `validateQueueSlotDefinition` lebih dulu untuk alasan
 * yang terbedakan).
 */
export function queueSlotPattern(input: {
  daysOfWeek: number[];
  /** Jam dinding "HH:MM" (00:00–23:59) dalam `timezone`. */
  timeOfDay: string;
  timezone: string;
  fromMs: number;
}): RecurrencePattern | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.timeOfDay);
  if (!match) return null;
  if (input.daysOfWeek.length === 0) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  // Jangkar sementara: instan UTC pada tanggal lokal `fromMs` dengan
  // jam dinding yang diminta — dipakai hanya untuk menurunkan
  // tanggal jangkar + jam dinding oleh matematika pola; tembakan
  // pertama yang sebenarnya dicari dari fromMs.
  const fromLocal = localDateOf(input.timezone, input.fromMs);
  const provisionalStart = zonedWallToUtcMs(
    input.timezone,
    fromLocal.year,
    fromLocal.month,
    fromLocal.day,
    hour,
    minute,
  );
  const pattern: RecurrencePattern = {
    frequency: "weekly",
    interval: 1,
    daysOfWeek: [...new Set(input.daysOfWeek)].sort((a, b) => a - b),
    dayOfMonth: null,
    lastDayOfMonth: false,
    timezone: input.timezone,
    startsAt: new Date(provisionalStart),
    endsAt: null,
  };
  const first = firstRecurrenceSlotAtOrAfter(pattern, input.fromMs);
  if (!first) return null;
  return { ...pattern, startsAt: first };
}

/** Jam dinding "HH:MM" sebuah pola dalam zonanya (untuk tampilan slot antrean). */
export function patternTimeOfDay(pattern: RecurrencePattern): string {
  const wall = wallTimeOf(pattern.timezone, pattern.startsAt.getTime());
  return `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
}
