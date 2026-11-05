import { z } from "zod";

// ---------------------------------------------------------------------------
// Dashboard — ringkasan live workspace (kartu prioritas + denyut 7 hari)
// ---------------------------------------------------------------------------

/**
 * Ringkasan "butuh perhatian" — angka yang MENUNTUT aksi pemilik
 * workspace. Kejujuran semantik adalah bagian kontrak:
 * - `unreadConversations`: percakapan dengan unreadCount > 0 (apa pun
 *   statusnya) — tepat sama dengan badge yang dilihat agen di Inbox.
 * - `idleOpenConversations`: percakapan berstatus 'open' yang pesan
 *   terakhirnya lebih tua dari IDLE_THRESHOLD_HOURS (24 jam UTC) —
 *   calon pelanggan yang mungkin terlupakan, BUKAN hitungan SLA.
 * - `failedMessages`: pesan keluar berstatus 'failed' menunggu
 *   ditangani (panel pesan gagal).
 */
export const DashboardAttentionSchema = z.object({
  unreadConversations: z.number().int().nonnegative(),
  idleOpenConversations: z.number().int().nonnegative(),
  failedMessages: z.number().int().nonnegative(),
});
export type DashboardAttention = z.infer<typeof DashboardAttentionSchema>;

export const DashboardChannelHealthSchema = z.object({
  provider: z.string(),
  connected: z.number().int().nonnegative(),
  disconnected: z.number().int().nonnegative(),
});
export type DashboardChannelHealth = z.infer<
  typeof DashboardChannelHealthSchema
>;

/** Satu titik harian deret aktivitas (UTC, YYYY-MM-DD). */
export const DashboardDailyPointSchema = z.object({
  date: z.string(),
  inbound: z.number().int().nonnegative(),
  outbound: z.number().int().nonnegative(),
});
export type DashboardDailyPoint = z.infer<typeof DashboardDailyPointSchema>;

/**
 * Denyut aktivitas 7 hari terakhir (jendela hari UTC penuh, hari ini
 * termasuk). `agentReplies` vs `manualReplies` memakai sender_type
 * messages ('agent' vs 'user') — pemisahan tanggung jawab AI dan
 * manusia, bukan kualitas jawaban.
 */
export const DashboardActivitySchema = z.object({
  messagesIn: z.number().int().nonnegative(),
  messagesOut: z.number().int().nonnegative(),
  agentReplies: z.number().int().nonnegative(),
  manualReplies: z.number().int().nonnegative(),
  newContacts: z.number().int().nonnegative(),
  daily: z.array(DashboardDailyPointSchema),
});
export type DashboardActivity = z.infer<typeof DashboardActivitySchema>;

export const DashboardSummaryResponseSchema = z.object({
  attention: DashboardAttentionSchema,
  channels: z.array(DashboardChannelHealthSchema),
  activity: DashboardActivitySchema,
  /** ISO timestamp server saat ringkasan dihitung. */
  generatedAt: z.string(),
});
export type DashboardSummaryResponse = z.infer<
  typeof DashboardSummaryResponseSchema
>;
