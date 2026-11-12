import { z } from "zod";

/**
 * Jam kerja tim + SLA manusia (G15, Tier 3 butir 15).
 *
 * DEFINISI YANG DIUKUR (ditampilkan juga di UI, supaya pengguna bisa
 * membaca apa arti angkanya):
 * - "Jendela menunggu balasan manusia" DIBUKA oleh pesan masuk
 *   pelanggan pada percakapan yang sedang menjadi tanggung jawab
 *   manusia, dan DITUTUP hanya oleh pesan keluar pertama dari manusia
 *   (`sender_type = 'user'`). Balasan AI (`agent`), pesan sistem
 *   (`system`), dan catatan internal TIDAK pernah menutup jendela.
 * - Percakapan menjadi tanggung jawab manusia selama AI-nya mati
 *   (handoff / dinonaktifkan) ATAU ia ditugaskan ke anggota tim;
 *   intervalnya direkonstruksi dari audit log, bukan ditebak.
 * - Jam SLA hanya berjalan pada menit yang jatuh di dalam JADWAL
 *   KERJA penanggung jawab (jadwal pribadi anggota penerima tugas;
 *   bila tidak ada, jadwal bawaan tenant; bila itu pun tidak ada, jam
 *   tidak berjalan dan jendela dilaporkan "tidak terukur" — bukan
 *   dianggap patuh).
 * - Berbeda dari KPI waktu balas (analytics/reply-times, G13) yang
 *   mengukur latensi jam-dinding mentah atas balasan yang terjadi:
 *   angka SLA di sini adalah menit JAM KERJA dan mencakup jendela
 *   yang terlewat, bukan hanya yang terjawab.
 */

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const WorkRangeSchema = z.object({
  /** "HH:MM" 24 jam, waktu dinding zona jadwal. */
  start: z.string().regex(TIME_OF_DAY),
  /** "HH:MM" 24 jam; wajib > start (rentang lintas tengah malam tidak didukung). */
  end: z.string().regex(TIME_OF_DAY),
});
export type WorkRange = z.infer<typeof WorkRangeSchema>;

function minutesOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

export const WorkScheduleSchema = z
  .object({
    /**
     * Kunci = nomor hari JS di zona jadwal: "0" Minggu … "6" Sabtu.
     * Hari tanpa kunci = libur. `{ days: {} }` sah dan berarti "tidak
     * ada jam kerja" secara eksplisit.
     */
    days: z.record(z.string(), z.array(WorkRangeSchema).max(4)),
  })
  .superRefine((value, ctx) => {
    for (const [day, ranges] of Object.entries(value.days)) {
      if (!/^[0-6]$/.test(day)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Hari tidak sah: ${day} (pakai "0".."6")`,
          path: ["days", day],
        });
        continue;
      }
      let prevEnd = -1;
      for (const range of ranges) {
        const start = minutesOf(range.start);
        const end = minutesOf(range.end);
        if (end <= start) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Rentang ${range.start}-${range.end} harus berakhir sesudah mulai`,
            path: ["days", day],
          });
        }
        if (start < prevEnd) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Rentang hari ${day} tumpang tindih / tidak terurut`,
            path: ["days", day],
          });
        }
        prevEnd = Math.max(prevEnd, end);
      }
    }
  });
export type WorkSchedule = z.infer<typeof WorkScheduleSchema>;

/** Nama zona IANA yang benar-benar dikenal Intl (runtime adalah hakimnya). */
export const IanaTimezoneSchema = z.string().min(1).max(64).refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Zona waktu IANA tidak dikenal" },
);

// ---------------------------------------------------------------------------
// Jadwal kerja anggota
// ---------------------------------------------------------------------------

export const MemberWorkScheduleResponseSchema = z.object({
  userId: z.string().uuid(),
  /** Zona anggota; null = ikut zona waktu tenant. */
  timezone: z.string().nullable(),
  /** Jadwal pribadi; null = anggota tidak punya baris jadwal (jatuh ke bawaan tenant). */
  schedule: WorkScheduleSchema.nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type MemberWorkScheduleResponse = z.infer<
  typeof MemberWorkScheduleResponseSchema
>;

export const UpdateMemberWorkScheduleRequestSchema = z.object({
  timezone: IanaTimezoneSchema.nullable(),
  schedule: WorkScheduleSchema,
});
export type UpdateMemberWorkScheduleRequest = z.infer<
  typeof UpdateMemberWorkScheduleRequestSchema
>;

// ---------------------------------------------------------------------------
// Pengaturan SLA tenant
// ---------------------------------------------------------------------------

export const TenantSlaSettingsResponseSchema = z.object({
  /** Target tanggap dalam menit JAM KERJA; null = SLA belum diatur (nonaktif). */
  targetMinutes: z.number().int().min(1).max(10080).nullable(),
  /** Jadwal bawaan tenant; null = tidak ada (jam jendela tanpa jadwal pribadi tidak berjalan). */
  defaultSchedule: WorkScheduleSchema.nullable(),
  /** Zona tenant — zona yang berlaku untuk jadwal bawaan. */
  timezone: z.string(),
});
export type TenantSlaSettingsResponse = z.infer<
  typeof TenantSlaSettingsResponseSchema
>;

export const UpdateTenantSlaSettingsRequestSchema = z.object({
  targetMinutes: z.number().int().min(1).max(10080).nullable(),
  defaultSchedule: WorkScheduleSchema.nullable(),
});
export type UpdateTenantSlaSettingsRequest = z.infer<
  typeof UpdateTenantSlaSettingsRequestSchema
>;

// ---------------------------------------------------------------------------
// Keadaan SLA per percakapan (menempel di ConversationResponse)
// ---------------------------------------------------------------------------

export const ConversationSlaSchema = z.object({
  /** Kapan pesan masuk pertama yang belum terjawab manusia masuk. */
  openedAt: z.string().datetime(),
  /** Target tenant dalam menit jam kerja. */
  targetMinutes: z.number().int().positive(),
  /** Sumber jadwal yang dipakai jam ini. */
  scheduleSource: z.enum(["member", "tenant", "none"]),
  /**
   * false bila tidak ada jadwal yang berlaku — jam tidak berjalan,
   * jendela TIDAK dinilai patuh/terlewat (elapsed/remaining/deadline
   * null), hanya dilaporkan menunggu.
   */
  measured: z.boolean(),
  /** Menit jam kerja yang sudah terbakar sejak tanggung jawab dimulai. */
  elapsedWorkingMinutes: z.number().nonnegative().nullable(),
  /** Sisa menit jam kerja sebelum terlewat; negatif bila sudah terlewat. */
  remainingWorkingMinutes: z.number().nullable(),
  /** Instan (UTC) ketika anggaran habis menurut jadwal; null bila tak terukur. */
  deadlineAt: z.string().datetime().nullable(),
  breached: z.boolean(),
});
export type ConversationSla = z.infer<typeof ConversationSlaSchema>;

// ---------------------------------------------------------------------------
// Laporan SLA (Analitik)
// ---------------------------------------------------------------------------

export const SlaReportResponseSchema = z.object({
  /** Lebar periode (hari), dihitung dari waktu DIBUKANYA jendela. */
  days: z.number().int().positive(),
  /** Target tenant saat laporan dibuat; null = SLA belum diatur. */
  targetMinutes: z.number().int().positive().nullable(),
  /** Jendela yang dibuka pada periode di percakapan tanggung jawab manusia. */
  windowsOpened: z.number().int().nonnegative(),
  /** Jendela tertutup manusia di dalam target. */
  closedOnTime: z.number().int().nonnegative(),
  /** Jendela tertutup manusia SESUDAH target habis. */
  closedBreached: z.number().int().nonnegative(),
  /** Jendela masih terbuka, anggaran belum habis. */
  openWithinTarget: z.number().int().nonnegative(),
  /** Jendela masih terbuka dan sudah melewati target. */
  openBreached: z.number().int().nonnegative(),
  /** Jendela yang jamnya tidak berjalan (tanpa jadwal berlaku) — tidak dinilai. */
  unmeasured: z.number().int().nonnegative(),
  /**
   * Median menit JAM KERJA dari jendela dibuka → ditutup manusia,
   * atas jendela yang tertutup pada periode (dibuka pada periode yang
   * sama). null bila tidak ada sampel tertutup yang terukur. Ini BUKAN
   * KPI waktu balas mentah G13: jam-dinding di luar jam kerja tidak
   * dihitung di sini.
   */
  medianWorkingResponseMinutes: z.number().nonnegative().nullable(),
  closedMeasuredSamples: z.number().int().nonnegative(),
});
export type SlaReportResponse = z.infer<typeof SlaReportResponseSchema>;
