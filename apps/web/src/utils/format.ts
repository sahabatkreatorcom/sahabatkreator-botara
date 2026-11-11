import type { Locale } from "@sahabat-kreator/i18n";

function intlLocale(locale: Locale): string {
  return locale === "id" ? "id-ID" : "en-US";
}

/**
 * Format tanggal+waktu lengkap lewat Intl (RANCANGAN §11.1 — tanpa
 * format manual). `timeZone` opsional: tanpa argumen, perilaku lama
 * (zona waktu browser). Halaman yang menjadwalkan sesuatu untuk orang
 * lain — content schedule — WAJIB meneruskan zona waktu tenant, karena
 * "jam 9 pagi" pada jadwal adalah jam 9 pagi di workspace, bukan di
 * peramban siapa pun yang kebetulan membuka halamannya.
 */
export function formatDateTime(
  iso: string,
  locale: Locale,
  timeZone?: string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** Offset zona waktu (wall clock − UTC) pada satu instant, dalam ms. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Tafsirkan nilai `datetime-local` ("2026-11-20T09:00") sebagai jam
 * dinding pada `timeZone`, kembalikan ISO UTC untuk server.
 *
 * Input datetime-local tidak membawa zona; browser menafsirkannya
 * sebagai zona BROWSER. Untuk jadwal workspace itu salah begitu
 * admin membuka halaman dari zona lain — jadwal "jam 9" bisa tayang
 * jam 16. Di sini komponennya dibaca apa adanya, lalu digeser sebesar
 * offset zona tenant pada instant tebakan. Satu iterasi cukup untuk
 * semua zona nyata; ketidaktepatan hanya mungkin pada menit-menit di
 * sekitar pergantian DST, yang tidak dikenal zona-zona Indonesia.
 */
export function zonedLocalToIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    local.trim(),
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const guessUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  if (Number.isNaN(guessUtc)) return null;
  const offset = zoneOffsetMs(new Date(guessUtc), timeZone);
  return new Date(guessUtc - offset).toISOString();
}

/** Tanggal saja (tanpa jam) lewat Intl — mis. label "Terhubung 28 Okt 2026" di kartu channel. */
export function formatDate(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** Label waktu ringkas untuk daftar percakapan: jam hari ini, tanggal bila lebih lama. */
export function formatListTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...(sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", year: "numeric" }),
  }).format(d);
}

/**
 * Waktu relatif dwibahasa lewat Intl.RelativeTimeFormat (Fase 7B.3) —
 * "5 menit yang lalu" / "5 minutes ago", "kemarin" / "yesterday".
 * Dipakai baris kesehatan kartu channel; timestamp penuhnya tetap
 * tersedia lewat formatDateTime di atribut title.
 */
export function formatRelativeTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  });
  const diffSeconds = Math.round((d.getTime() - Date.now()) / 1000);
  if (Math.abs(diffSeconds) < 60) return rtf.format(diffSeconds, "second");
  const minutes = Math.round(diffSeconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return rtf.format(months, "month");
  return rtf.format(Math.round(months / 12), "year");
}

/** Format harga Rupiah lewat Intl sesuai locale UI aktif (Fase 4A). */
/**
 * Ukuran berkas untuk chip lampiran (Fase 18B).
 *
 * Memakai 1000, bukan 1024: angka ini ditampilkan di samping batas
 * unggah 25 MB yang juga dinyatakan desimal, dan selisih 2,4% antara
 * keduanya cukup untuk membuat berkas 24,9 MB terlihat "di bawah batas"
 * padahal server menolaknya.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatIdr(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Format harga Rupiah untuk halaman bayar publik: selalu id-ID sesuai
 * penetapan desain Fase 4A (halaman pembeli Indonesia), lewat Intl.
 */
export function formatIdrId(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Jam menit untuk meta gelembung pesan. */
export function formatTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
