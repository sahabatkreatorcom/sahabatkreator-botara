import { z } from "zod";

import { ChannelProviderSchema } from "./inbox";

// ---------------------------------------------------------------------------
// Fase 7C — Broadcasts v1
// ---------------------------------------------------------------------------

/**
 * Status broadcast. `draft` hanya hidup di dashboard; `scheduled`
 * menunggu job worker `broadcast.dispatch` (delayed sampai
 * scheduled_at); `sending` selama dispatch berjalan dan penerima belum
 * semuanya terminal; status akhir dihitung dari baris penerima:
 * completed (tanpa failed), partially_failed (ada failed), failed
 * (semua penerima gagal / dispatch gagal), cancelled (dibatalkan
 * sebelum atau saat pengiriman — sisa queued dihapus).
 */
export const BroadcastStatusSchema = z.enum([
  "draft",
  "scheduled",
  "sending",
  "completed",
  "partially_failed",
  "failed",
  "cancelled",
]);
export type BroadcastStatus = z.infer<typeof BroadcastStatusSchema>;

/**
 * Status satu penerima. queued/sent/delivered/read/failed mengikuti
 * status pesan keluarnya; skipped adalah terminal lokal saat dispatch
 * (skipReason wajib menyertainya); cancelled = pesan queued-nya
 * dihapus oleh pembatalan broadcast.
 */
export const BroadcastRecipientStatusSchema = z.enum([
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "skipped",
  "cancelled",
]);
export type BroadcastRecipientStatus = z.infer<
  typeof BroadcastRecipientStatusSchema
>;

/** Alasan penerima dilewati saat dispatch (tidak dicoba kirim). */
export const BroadcastSkipReasonSchema = z.enum([
  "opted_out",
  // Fase 13C: broadcast require_opt_in dan status opt-in efektif
  // kontak bukan "opted_in".
  "not_opted_in",
  "outside_24h_window",
  "message_deleted",
  // Fase 10A: variabel template WhatsApp penerima tidak terpetakan,
  // atau identitas penerima tidak membawa alamat (nomor) tujuan.
  "template_variable_missing",
  "missing_phone_number",
  // Fase 17: template memakai variabel di HEADER atau tombol URL, yang
  // belum bisa dipetakan ke sumber data di broadcast. Tanpa alasan
  // sendiri, penerima ini tercatat "variabel tidak terpetakan" —
  // menyesatkan, karena masalahnya bukan data kontak melainkan fitur
  // yang belum ada.
  "template_component_unsupported",
]);
export type BroadcastSkipReason = z.infer<typeof BroadcastSkipReasonSchema>;

/**
 * Filter audiens broadcast. Mode ditentukan `audience`:
 * - "all"     : semua kontak beridentitas di channel itu.
 * - "tag"     : kontak cocok bila punya SALAH SATU tag pada `tags`
 *               (OR dalam kelompok) DAN stage pipeline-nya termasuk
 *               salah satu `stages`; antar-kelompok digabung AND.
 * - "segment" : keanggotaan ditentukan evaluator segmen (Fase 13C)
 *               atas segmen `segmentId`.
 * Baris lama tanpa `audience` diturunkan modenya server dari isi
 * filter (segmentId → segment; tags/stages non-kosong → tag; selain
 * itu all) — perilaku tag yang ada tidak berubah (regresi nol).
 */
export const BroadcastAudienceFilterSchema = z.object({
  audience: z.enum(["all", "tag", "segment"]).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  stages: z.array(z.string().min(1).max(64)).max(20).optional(),
  segmentId: z.string().uuid().optional(),
});
export type BroadcastAudienceFilter = z.infer<
  typeof BroadcastAudienceFilterSchema
>;

/** Statistik penerima — SELALU dihitung server dari broadcast_recipients. */
export const BroadcastStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});
export type BroadcastStats = z.infer<typeof BroadcastStatsSchema>;

export const BroadcastResponseSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string().uuid(),
  /** Provider + label channel diturunkan server untuk daftar UI. */
  provider: ChannelProviderSchema,
  channelDisplayName: z.string().nullable(),
  name: z.string(),
  messageText: z.string(),
  /**
   * Template WhatsApp untuk broadcast provider whatsapp (Fase 10A):
   * id baris cermin lokal; null untuk provider lain (dan untuk
   * broadcast WA yang templatenya sudah terhapus — wajib memilih
   * ulang sebelum bisa dijadwalkan lagi).
   */
  whatsappTemplateId: z.string().uuid().nullable(),
  /**
   * Sumber nilai variabel BODY template per posisi (Fase 10A):
   * "name" = nama kontak; nilai lain = kunci custom_fields kontak.
   */
  templateVariableSources: z.array(z.string()),
  audienceFilter: BroadcastAudienceFilterSchema,
  /**
   * Gerbang opt-in (Fase 13C): true = hanya kontak berstatus opt-in
   * efektif yang dikirimi; sisanya dicatat skipped `not_opted_in`.
   * Bawaan server saat buat: true untuk WhatsApp, false selain itu.
   */
  requireOptIn: z.boolean(),
  status: BroadcastStatusSchema,
  scheduledAt: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  /** Kode kegagalan tingkat dispatch (CHANNEL_DISCONNECTED / AUDIENCE_EMPTY). */
  errorCode: z.string().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stats: BroadcastStatsSchema,
});
export type BroadcastResponse = z.infer<typeof BroadcastResponseSchema>;

export const BroadcastListResponseSchema = z.object({
  broadcasts: z.array(BroadcastResponseSchema),
  nextCursor: z.string().nullable(),
});
export type BroadcastListResponse = z.infer<typeof BroadcastListResponseSchema>;

export const BroadcastListQuerySchema = z.object({
  status: BroadcastStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type BroadcastListQuery = z.infer<typeof BroadcastListQuerySchema>;

export const CreateBroadcastRequestSchema = z.object({
  name: z.string().min(1).max(255),
  channelAccountId: z.string().uuid(),
  /**
   * Isi pesan teks — wajib untuk telegram/messenger/instagram.
   * Untuk whatsapp kolom ini diabaikan (isi broadcast adalah template;
   * server menyimpan teks BODY template sebagai snapshot) dan
   * `whatsappTemplateId` yang wajib (422 BROADCAST_TEMPLATE_REQUIRED).
   */
  messageText: z.string().min(1).max(4096).optional(),
  /** Template WhatsApp (Fase 10A) — wajib & harus APPROVED untuk channel whatsapp. */
  whatsappTemplateId: z.string().uuid().optional(),
  /** Sumber variabel template per posisi (Fase 10A): "name" atau kunci custom_fields. */
  templateVariableSources: z
    .array(z.string().min(1).max(64))
    .max(25)
    .optional(),
  audienceFilter: BroadcastAudienceFilterSchema.optional(),
  /** Gerbang opt-in (Fase 13C); kosong = bawaan server per provider. */
  requireOptIn: z.boolean().optional(),
  /**
   * Uji A/B (Fase 13D): persen penerima yang masuk varian B (1..99).
   * Mengisinya MENYALAKAN A/B dan mewajibkan isi varian B: teks
   * `variantBMessageText` untuk provider teks, atau
   * `variantBWhatsappTemplateId` untuk WhatsApp (gerbang template
   * yang sama seperti varian A). Tidak diisi = tanpa A/B.
   */
  abSplitPercentB: z.number().int().min(1).max(99).optional(),
  /** Isi varian B untuk provider teks (Fase 13D). */
  variantBMessageText: z.string().min(1).max(4096).optional(),
  /** Template WhatsApp varian B (Fase 13D) — wajib & APPROVED untuk channel whatsapp ber-A/B. */
  variantBWhatsappTemplateId: z.string().uuid().optional(),
  /** Sumber variabel template B per posisi (Fase 13D). */
  variantBTemplateVariableSources: z
    .array(z.string().min(1).max(64))
    .max(25)
    .optional(),
});
export type CreateBroadcastRequest = z.infer<
  typeof CreateBroadcastRequestSchema
>;

/** Edit hanya sah selama broadcast masih `draft`. */
export const UpdateBroadcastRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  channelAccountId: z.string().uuid().optional(),
  messageText: z.string().min(1).max(4096).optional(),
  whatsappTemplateId: z.string().uuid().nullable().optional(),
  templateVariableSources: z
    .array(z.string().min(1).max(64))
    .max(25)
    .optional(),
  audienceFilter: BroadcastAudienceFilterSchema.optional(),
  /** Gerbang opt-in (Fase 13C) — hanya bisa diubah selama draft. */
  requireOptIn: z.boolean().optional(),
  /**
   * Uji A/B (Fase 13D) — hanya selama draft. `null` eksplisit =
   * MATIKAN A/B (semua kolom varian B dibersihkan); tidak diisi =
   * biarkan seperti tersimpan. Keadaan akhir selalu divalidasi utuh:
   * A/B menyala wajib punya isi varian B yang sah untuk provider-nya.
   */
  abSplitPercentB: z.number().int().min(1).max(99).nullable().optional(),
  variantBMessageText: z.string().min(1).max(4096).nullable().optional(),
  variantBWhatsappTemplateId: z.string().uuid().nullable().optional(),
  variantBTemplateVariableSources: z
    .array(z.string().min(1).max(64))
    .max(25)
    .optional(),
});
export type UpdateBroadcastRequest = z.infer<
  typeof UpdateBroadcastRequestSchema
>;

/**
 * Jadwalkan broadcast. `scheduledAt` kosong/null = kirim sekarang
 * (dispatch secepatnya lewat antrean worker yang sama). Waktu lampau
 * diperlakukan sebagai sekarang — server tidak menolak jam user.
 */
export const ScheduleBroadcastRequestSchema = z.object({
  scheduledAt: z.string().datetime().nullable().optional(),
});
export type ScheduleBroadcastRequest = z.infer<
  typeof ScheduleBroadcastRequestSchema
>;

/**
 * Pratinjau audiens broadcast (Fase 13C — menggantikan estimasi 7C):
 * dihitung dengan KLASIFIKASI YANG SAMA seperti materialisasi
 * penerima saat dispatch (satu fungsi inti di core — tidak ada dua
 * logika), jadi angka pratinjau = angka hasil dispatch untuk audiens
 * dan keadaan yang sama, kecuali perubahan data di antaranya.
 * `totalCandidates` = kontak beridentitas di channel yang cocok
 * filter audiens; `willSend` = yang lolos semua gerbang;
 * sisanya rincian per alasan skip. Jendela 24 jam Meta dievaluasi
 * terhadap waktu pratinjau (bisa bergeser sedikit sampai dispatch).
 */
export const BroadcastAudiencePreviewResponseSchema = z.object({
  totalCandidates: z.number().int().nonnegative(),
  willSend: z.number().int().nonnegative(),
  skippedOptedOut: z.number().int().nonnegative(),
  skippedNotOptedIn: z.number().int().nonnegative(),
  skippedOutside24hWindow: z.number().int().nonnegative(),
  skippedMissingPhoneNumber: z.number().int().nonnegative(),
  skippedTemplateVariableMissing: z.number().int().nonnegative(),
  skippedTemplateComponentUnsupported: z.number().int().nonnegative(),
});
export type BroadcastAudiencePreviewResponse = z.infer<
  typeof BroadcastAudiencePreviewResponseSchema
>;

export const BroadcastAudiencePreviewQuerySchema = z.object({
  channelAccountId: z.string().uuid(),
  /** Daftar tag terpisah koma (mengikuti pola query daftar kontak). */
  tags: z.string().max(1024).optional(),
  stages: z.string().max(1024).optional(),
  /** Mode audiens segmen (Fase 13C): id segmen milik tenant. */
  segmentId: z.string().uuid().optional(),
  /** Gerbang opt-in yang akan dipakai broadcast ("true"/"false"). */
  requireOptIn: z.enum(["true", "false"]).optional(),
  /** Template WhatsApp terpilih — untuk klasifikasi variabel (Fase 13C). */
  whatsappTemplateId: z.string().uuid().optional(),
  /** Sumber variabel template terpisah koma, sejajar posisi template. */
  templateVariableSources: z.string().max(2048).optional(),
});
export type BroadcastAudiencePreviewQuery = z.infer<
  typeof BroadcastAudiencePreviewQuerySchema
>;

export const BroadcastRecipientResponseSchema = z.object({
  id: z.string().uuid(),
  contactId: z.string().uuid(),
  contactName: z.string(),
  conversationId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  status: BroadcastRecipientStatusSchema,
  /**
   * Varian uji A/B penerima (Fase 13D): "a" untuk semua penerima
   * broadcast tanpa A/B; penugasan deterministik per
   * (broadcast, kontak) dan tidak berubah pada materialisasi ulang.
   */
  variant: z.enum(["a", "b"]),
  skipReason: BroadcastSkipReasonSchema.nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BroadcastRecipientResponse = z.infer<
  typeof BroadcastRecipientResponseSchema
>;

export const BroadcastRecipientListResponseSchema = z.object({
  recipients: z.array(BroadcastRecipientResponseSchema),
  nextCursor: z.string().nullable(),
});
export type BroadcastRecipientListResponse = z.infer<
  typeof BroadcastRecipientListResponseSchema
>;

export const BroadcastRecipientListQuerySchema = z.object({
  status: BroadcastRecipientStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type BroadcastRecipientListQuery = z.infer<
  typeof BroadcastRecipientListQuerySchema
>;

/**
 * Konfigurasi uji A/B broadcast sebagaimana tersimpan (gema untuk
 * formulir edit + panel hasil). `null` pada respons hasil = broadcast
 * tanpa A/B. Untuk WhatsApp `variantBMessageText` adalah snapshot
 * BODY template B; untuk provider teks ia isi pesan B itu sendiri.
 */
export const BroadcastAbConfigSchema = z.object({
  splitPercentB: z.number().int().min(1).max(99),
  variantBMessageText: z.string().nullable(),
  variantBWhatsappTemplateId: z.string().uuid().nullable(),
  variantBTemplateVariableSources: z.array(z.string()),
});
export type BroadcastAbConfig = z.infer<typeof BroadcastAbConfigSchema>;

/** Rincian alasan skip per varian — alasan 13C dipertahankan utuh. */
export const BroadcastVariantSkipReasonsSchema = z.object({
  opted_out: z.number().int().nonnegative(),
  not_opted_in: z.number().int().nonnegative(),
  outside_24h_window: z.number().int().nonnegative(),
  template_variable_missing: z.number().int().nonnegative(),
  missing_phone_number: z.number().int().nonnegative(),
  message_deleted: z.number().int().nonnegative(),
  template_component_unsupported: z.number().int().nonnegative(),
});
export type BroadcastVariantSkipReasons = z.infer<
  typeof BroadcastVariantSkipReasonsSchema
>;

/**
 * Statistik satu varian broadcast — SELALU dihitung server dari
 * broadcast_recipients (sumber kebenaran yang sama seperti statistik
 * broadcast keseluruhan). `assigned` = semua baris penerima varian
 * ini (termasuk yang skipped). TANPA putusan pemenang: broadcast
 * tidak punya metrik hasil per penerima yang sebanding antar varian
 * (atribusi balasan sengaja tidak ditebak — lihat matriks cakupan).
 */
export const BroadcastVariantStatsSchema = z.object({
  variant: z.enum(["a", "b"]),
  assigned: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  skippedByReason: BroadcastVariantSkipReasonsSchema,
});
export type BroadcastVariantStats = z.infer<typeof BroadcastVariantStatsSchema>;

/** Respons GET /tenants/:tenantId/broadcasts/:id/ab-results (dashboard). */
export const BroadcastAbResultsResponseSchema = z.object({
  broadcastId: z.string().uuid(),
  abTest: BroadcastAbConfigSchema.nullable(),
  variants: z.array(BroadcastVariantStatsSchema),
});
export type BroadcastAbResultsResponse = z.infer<
  typeof BroadcastAbResultsResponseSchema
>;

// ---------------------------------------------------------------------------
// Gelombang G9 — Broadcast Berulang (lapisan penjadwal di atas Fase 7C)
// ---------------------------------------------------------------------------

/**
 * Frekuensi pengulangan. Pola lengkapnya: frequency + interval
 * (setiap N) + penentu hari:
 * - daily   : setiap `interval` hari pada jam dinding yang sama.
 * - weekly  : setiap `interval` minggu pada hari-hari `daysOfWeek`
 *   (0=Minggu..6=Sabtu; kosong = hari yang sama dengan `startsAt`).
 * - monthly : setiap `interval` bulan pada `dayOfMonth` (1..31 —
 *   tanggal melampaui akhir bulan dijepit ke hari terakhir bulan
 *   itu) atau pada hari terakhir bulan bila `lastDayOfMonth`.
 * Semua perhitungan dalam `timezone` aturan (IANA); `startsAt`
 * adalah jangkar: slot pertama DAN jam dinding semua slot.
 */
export const BroadcastRecurrenceFrequencySchema = z.enum([
  "daily",
  "weekly",
  "monthly",
]);
export type BroadcastRecurrenceFrequency = z.infer<
  typeof BroadcastRecurrenceFrequencySchema
>;

/**
 * Status aturan berulang. active = penyapu memproses slot jatuh
 * tempo; paused = slot dicatat skipped `rule_paused` (tidak lahir,
 * tidak hilang diam-diam); completed = kondisi berhenti tercapai
 * (terminal); cancelled = dihentikan pemilik (terminal).
 */
export const BroadcastRecurrenceStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "cancelled",
]);
export type BroadcastRecurrenceStatus = z.infer<
  typeof BroadcastRecurrenceStatusSchema
>;

/**
 * Status satu baris ledger kejadian. claimed = sedang
 * dimaterialisasi (transien; klaim basi diambil alih menjadi
 * missed `claim_stale`); created = broadcast anak lahir;
 * skipped = tidak lahir karena gerbang/aturan (lihat reason);
 * missed = slot basi tidak ditembakkan (slot_expired/claim_stale).
 */
export const BroadcastRecurrenceOccurrenceStatusSchema = z.enum([
  "claimed",
  "created",
  "skipped",
  "missed",
]);
export type BroadcastRecurrenceOccurrenceStatus = z.infer<
  typeof BroadcastRecurrenceOccurrenceStatusSchema
>;

/** Alasan ledger untuk kejadian skipped/missed (created/claimed: null). */
export const BroadcastRecurrenceOccurrenceReasonSchema = z.enum([
  // Aturan sedang dijeda saat slot jatuh tempo.
  "rule_paused",
  // Slot pertama kali terlihat penyapu sudah melewati ambang
  // keterlambatan (1 jam) — broadcast basi tidak ditembakkan.
  "slot_expired",
  // Klaim materialisasi tidak pernah selesai (proses mati di tengah).
  "claim_stale",
  // Gerbang pembuatan/penjadwalan broadcast anak (kode core yang sama).
  "channel_not_found",
  "channel_disconnected",
  "channel_unsupported",
  "template_required",
  "template_not_approved",
  "segment_not_found",
  "message_required",
  "ab_incomplete",
]);
export type BroadcastRecurrenceOccurrenceReason = z.infer<
  typeof BroadcastRecurrenceOccurrenceReasonSchema
>;

/** Pola pengulangan (dipakai buat/edit/pratinjau). */
export const BroadcastRecurrencePatternSchema = z.object({
  frequency: BroadcastRecurrenceFrequencySchema,
  /** Setiap N hari/minggu/bulan (1..365). */
  interval: z.number().int().min(1).max(365).optional(),
  /** Hanya weekly: hari aktif 0=Minggu..6=Sabtu, tanpa duplikat. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  /** Hanya monthly: tanggal 1..31 (dijepit ke akhir bulan pendek). */
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  /** Hanya monthly: slot di hari terakhir bulan (mengalahkan dayOfMonth). */
  lastDayOfMonth: z.boolean().optional(),
  /** Zona waktu IANA; kosong = zona waktu tenant. */
  timezone: z.string().min(1).max(64).optional(),
  /** Jangkar: slot pertama + jam dinding semua slot (ISO 8601). */
  startsAt: z.string().datetime(),
  /** Slot terakhir yang masih boleh lahir, inklusif (ISO 8601). */
  endsAt: z.string().datetime().nullable().optional(),
  /** Batas jumlah broadcast anak yang dibuat (1..10000). */
  maxOccurrences: z.number().int().min(1).max(10000).nullable().optional(),
});
export type BroadcastRecurrencePattern = z.infer<
  typeof BroadcastRecurrencePatternSchema
>;

/**
 * Definisi broadcast untuk aturan berulang — SALAH SATU dari:
 * (a) `sourceBroadcastId`: definisi DISALIN dari broadcast itu
 *     (bidang definisi lain yang ikut dikirim menimpa salinannya), atau
 * (b) definisi inline lengkap (bidang yang sama seperti buat
 *     broadcast). Aturan menyimpan snapshot: perubahan pada broadcast
 *     sumber sesudahnya tidak mengubah aturan.
 */
export const BroadcastRecurrenceDefinitionSchema = z.object({
  sourceBroadcastId: z.string().uuid().optional(),
  name: z.string().min(1).max(255).optional(),
  channelAccountId: z.string().uuid().optional(),
  messageText: z.string().min(1).max(4096).optional(),
  whatsappTemplateId: z.string().uuid().nullable().optional(),
  templateVariableSources: z
    .array(z.string().min(1).max(64))
    .max(25)
    .optional(),
  audienceFilter: BroadcastAudienceFilterSchema.optional(),
  requireOptIn: z.boolean().optional(),
  abSplitPercentB: z.number().int().min(1).max(99).nullable().optional(),
  variantBMessageText: z.string().min(1).max(4096).nullable().optional(),
  variantBWhatsappTemplateId: z.string().uuid().nullable().optional(),
  variantBTemplateVariableSources: z
    .array(z.string().min(1).max(64))
    .max(25)
    .optional(),
});
export type BroadcastRecurrenceDefinition = z.infer<
  typeof BroadcastRecurrenceDefinitionSchema
>;

export const CreateBroadcastRecurrenceRequestSchema =
  BroadcastRecurrenceDefinitionSchema.merge(
    BroadcastRecurrencePatternSchema,
  );
export type CreateBroadcastRecurrenceRequest = z.infer<
  typeof CreateBroadcastRecurrenceRequestSchema
>;

/**
 * Edit aturan (hanya active/paused). Mengubah pola/jangkar
 * menghitung ulang slot berikutnya dari pola baru; mengubah definisi
 * memengaruhi broadcast anak BERIKUTNYA (yang sudah lahir tidak
 * berubah). Bidang pola bersifat parsial terhadap pola tersimpan.
 */
export const UpdateBroadcastRecurrenceRequestSchema =
  BroadcastRecurrenceDefinitionSchema.partial().merge(
    BroadcastRecurrencePatternSchema.partial(),
  );
export type UpdateBroadcastRecurrenceRequest = z.infer<
  typeof UpdateBroadcastRecurrenceRequestSchema
>;

/** Pratinjau slot berikutnya untuk pola yang BELUM disimpan. */
export const BroadcastRecurrencePreviewRequestSchema =
  BroadcastRecurrencePatternSchema.extend({
    /** Berapa slot ke depan yang dihitung (bawaan server 5). */
    count: z.number().int().min(1).max(24).optional(),
    /**
     * Hitung slot sesudah instan ini (ISO 8601); kosong = sesudah
     * sekarang. Slot pertama yang memenuhi dimulai dari startsAt.
     */
    from: z.string().datetime().optional(),
  });
export type BroadcastRecurrencePreviewRequest = z.infer<
  typeof BroadcastRecurrencePreviewRequestSchema
>;

export const BroadcastRecurrencePreviewResponseSchema = z.object({
  /** Instan slot (ISO 8601, UTC) menaik; bisa lebih pendek dari count bila pola berakhir (endsAt/maxOccurrences tidak dihitung di sini — murni pola + endsAt). */
  slots: z.array(z.string().datetime()),
  /** Zona waktu efektif yang dipakai perhitungan. */
  timezone: z.string(),
});
export type BroadcastRecurrencePreviewResponse = z.infer<
  typeof BroadcastRecurrencePreviewResponseSchema
>;

export const BroadcastRecurrenceResponseSchema = z.object({
  id: z.string().uuid(),
  sourceBroadcastId: z.string().uuid().nullable(),
  channelAccountId: z.string().uuid(),
  provider: ChannelProviderSchema,
  channelDisplayName: z.string().nullable(),
  name: z.string(),
  messageText: z.string(),
  whatsappTemplateId: z.string().uuid().nullable(),
  templateVariableSources: z.array(z.string()),
  audienceFilter: BroadcastAudienceFilterSchema,
  requireOptIn: z.boolean(),
  abSplitPercentB: z.number().int().nullable(),
  variantBMessageText: z.string().nullable(),
  variantBWhatsappTemplateId: z.string().uuid().nullable(),
  variantBTemplateVariableSources: z.array(z.string()),
  frequency: BroadcastRecurrenceFrequencySchema,
  interval: z.number().int(),
  daysOfWeek: z.array(z.number().int()),
  dayOfMonth: z.number().int().nullable(),
  lastDayOfMonth: z.boolean(),
  timezone: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable(),
  maxOccurrences: z.number().int().nullable(),
  occurrencesCreated: z.number().int().nonnegative(),
  status: BroadcastRecurrenceStatusSchema,
  /** Slot berikutnya yang belum diproses; null pada aturan terminal. */
  nextRunAt: z.string().datetime().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BroadcastRecurrenceResponse = z.infer<
  typeof BroadcastRecurrenceResponseSchema
>;

export const BroadcastRecurrenceListResponseSchema = z.object({
  rules: z.array(BroadcastRecurrenceResponseSchema),
  nextCursor: z.string().nullable(),
});
export type BroadcastRecurrenceListResponse = z.infer<
  typeof BroadcastRecurrenceListResponseSchema
>;

export const BroadcastRecurrenceListQuerySchema = z.object({
  status: BroadcastRecurrenceStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type BroadcastRecurrenceListQuery = z.infer<
  typeof BroadcastRecurrenceListQuerySchema
>;

export const BroadcastRecurrenceOccurrenceResponseSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  /** Instan slot (ISO 8601, UTC). */
  slotAt: z.string().datetime(),
  status: BroadcastRecurrenceOccurrenceStatusSchema,
  reason: BroadcastRecurrenceOccurrenceReasonSchema.nullable(),
  /** Broadcast anak yang lahir dari slot ini (hanya status created). */
  broadcastId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BroadcastRecurrenceOccurrenceResponse = z.infer<
  typeof BroadcastRecurrenceOccurrenceResponseSchema
>;

export const BroadcastRecurrenceOccurrenceListResponseSchema = z.object({
  occurrences: z.array(BroadcastRecurrenceOccurrenceResponseSchema),
  nextCursor: z.string().nullable(),
});
export type BroadcastRecurrenceOccurrenceListResponse = z.infer<
  typeof BroadcastRecurrenceOccurrenceListResponseSchema
>;

export const BroadcastRecurrenceOccurrenceListQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type BroadcastRecurrenceOccurrenceListQuery = z.infer<
  typeof BroadcastRecurrenceOccurrenceListQuerySchema
>;
