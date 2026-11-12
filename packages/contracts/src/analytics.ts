import { z } from "zod";

// ---------------------------------------------------------------------------
// Fase 9B — Analitik pemakaian AI (dasbor /analytics)
// ---------------------------------------------------------------------------

/**
 * Laporan pemakaian AI satu tenant dari usage_ledger (type='ai_token').
 * Kejujuran angka adalah bagian kontrak:
 * - `tokensIn`/`tokensOut` hanya menjumlah baris BER-RINCIAN (meta Fase
 *   9B); baris warisan tanpa rincian dihitung di `undetailedResponses`
 *   dan hanya menyumbang `responses` + `tokensTotal` (dari kolom qty).
 * - `costUsd` adalah biaya AKTUAL yang dilaporkan provider (OpenRouter);
 *   null bila tak satu pun respons pada periode melaporkan biaya.
 *   `costReportedResponses` menunjukkan cakupan biayanya. Tidak ada
 *   estimasi harga karangan di mana pun pada kontrak ini.
 */
export const AiUsageDayPointSchema = z.object({
  /** Tanggal UTC (YYYY-MM-DD). */
  date: z.string(),
  responses: z.number().int().nonnegative(),
  tokensIn: z.number().nonnegative(),
  tokensOut: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});
export type AiUsageDayPoint = z.infer<typeof AiUsageDayPointSchema>;

export const AiUsageAgentPointSchema = z.object({
  /** Null untuk keranjang baris warisan tanpa rincian agent. */
  agentId: z.string().uuid().nullable(),
  agentName: z.string().nullable(),
  responses: z.number().int().nonnegative(),
  tokensIn: z.number().nonnegative(),
  tokensOut: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  models: z.array(z.string()),
});
export type AiUsageAgentPoint = z.infer<typeof AiUsageAgentPointSchema>;

export const AiUsageReportResponseSchema = z.object({
  days: z.number().int().positive(),
  responses: z.number().int().nonnegative(),
  tokensTotal: z.number().nonnegative(),
  tokensIn: z.number().nonnegative(),
  tokensOut: z.number().nonnegative(),
  detailedResponses: z.number().int().nonnegative(),
  undetailedResponses: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  costReportedResponses: z.number().int().nonnegative(),
  daily: z.array(AiUsageDayPointSchema),
  perAgent: z.array(AiUsageAgentPointSchema),
  cap: z.object({
    dailyLimit: z.number().int().positive(),
    usedToday: z.number().int().nonnegative(),
    remainingToday: z.number().int().nonnegative(),
  }),
});
export type AiUsageReportResponse = z.infer<typeof AiUsageReportResponseSchema>;

// ---------------------------------------------------------------------------
// G13 butir 8 — KPI waktu balas (median manusia vs AI, vs periode lalu)
// ---------------------------------------------------------------------------

/**
 * Satu keranjang waktu balas. Definisi "waktu balas" yang JUJUR dari
 * stempel yang tersedia (messages.created_at): untuk tiap pesan MASUK,
 * latensinya = selisih ke pesan KELUAR PERTAMA sesudahnya dalam
 * percakapan yang sama; balasan dikreditkan ke kelas pengirim pesan
 * keluar itu (`user` = manusia, `agent` = AI; `system` tidak dihitung).
 * Pesan masuk tanpa balasan keluar tidak menyumbang sampel (median
 * atas balasan yang TERJADI, bukan SLA). `medianSeconds` null bila
 * sampel kosong — tidak ada angka karangan.
 */
export const ReplyTimeBucketSchema = z.object({
  medianSeconds: z.number().nonnegative().nullable(),
  samples: z.number().int().nonnegative(),
});
export type ReplyTimeBucket = z.infer<typeof ReplyTimeBucketSchema>;

export const ReplyTimeSideSchema = z.object({
  current: ReplyTimeBucketSchema,
  previous: ReplyTimeBucketSchema,
});
export type ReplyTimeSide = z.infer<typeof ReplyTimeSideSchema>;

export const ReplyTimeReportResponseSchema = z.object({
  /** Lebar jendela periode berjalan (hari); periode pembanding sama lebar, tepat sebelumnya. */
  days: z.number().int().positive(),
  human: ReplyTimeSideSchema,
  agent: ReplyTimeSideSchema,
});
export type ReplyTimeReportResponse = z.infer<
  typeof ReplyTimeReportResponseSchema
>;
