import { z } from "zod";

// ---------------------------------------------------------------------------
// Deals / pipeline penjualan (Gelombang G12, Tier 2 butir 12 program
// adopsi — pola wacrm `src/lib/pipelines`, MIT, diadopsi sebagai pola).
//
// Entitas deal TERPISAH dari `contacts.pipeline_stage` (tahap kontak
// sederhana): deal bernilai uang, menempel pada SATU kontak (wajib),
// bergerak antar tahap pipeline di papan Kanban. Satu kontak boleh
// punya banyak deal.
// ---------------------------------------------------------------------------

/** Kode mata uang ISO 4217: tepat 3 huruf besar (sama seperti CHECK DB). */
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO 4217 code");
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

/**
 * Sifat tahap pipeline: 'open' = tahap kerja biasa; 'won'/'lost' =
 * tahap TERMINAL — memindahkan deal ke tahap ber-kind itu menetapkan
 * status deal won/lost (dan closed_at); memindahkan keluar dari tahap
 * terminal membuka deal lagi.
 */
export const DealStageKindSchema = z.enum(["open", "won", "lost"]);
export type DealStageKind = z.infer<typeof DealStageKindSchema>;

export const DealStatusSchema = z.enum(["open", "won", "lost"]);
export type DealStatus = z.infer<typeof DealStatusSchema>;

export const DealPrioritySchema = z.enum(["low", "medium", "high"]);
export type DealPriority = z.infer<typeof DealPrioritySchema>;

// --- Pipeline ---------------------------------------------------------------

export const CreateDealPipelineRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
});
export type CreateDealPipelineRequest = z.infer<
  typeof CreateDealPipelineRequestSchema
>;

export const UpdateDealPipelineRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
});
export type UpdateDealPipelineRequest = z.infer<
  typeof UpdateDealPipelineRequestSchema
>;

export const DealStageResponseSchema = z.object({
  id: z.string().uuid(),
  pipelineId: z.string().uuid(),
  name: z.string(),
  position: z.number().int(),
  color: z.string(),
  kind: DealStageKindSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DealStageResponse = z.infer<typeof DealStageResponseSchema>;

export const DealPipelineResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  stages: z.array(DealStageResponseSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DealPipelineResponse = z.infer<typeof DealPipelineResponseSchema>;

export const DealPipelineListResponseSchema = z.object({
  pipelines: z.array(DealPipelineResponseSchema),
});
export type DealPipelineListResponse = z.infer<
  typeof DealPipelineListResponseSchema
>;

// --- Tahap ------------------------------------------------------------------

const DealStageColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a #RRGGBB hex value");

export const CreateDealStageRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  color: DealStageColorSchema.optional(),
  kind: DealStageKindSchema.optional(),
});
export type CreateDealStageRequest = z.infer<
  typeof CreateDealStageRequestSchema
>;

export const UpdateDealStageRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  color: DealStageColorSchema.optional(),
  kind: DealStageKindSchema.optional(),
});
export type UpdateDealStageRequest = z.infer<
  typeof UpdateDealStageRequestSchema
>;

/** Susun ulang: daftar id tahap pipeline ini dalam urutan baru yang utuh. */
export const ReorderDealStagesRequestSchema = z.object({
  stageIds: z.array(z.string().uuid()).min(1).max(50),
});
export type ReorderDealStagesRequest = z.infer<
  typeof ReorderDealStagesRequestSchema
>;

/**
 * Hapus tahap. Bila tahap masih berisi deal, `moveDealsToStageId`
 * WAJIB diisi (tahap tujuan di pipeline yang sama) — tanpa itu server
 * menolak 409 STAGE_NOT_EMPTY; deal tidak pernah hilang diam-diam.
 */
export const DeleteDealStageRequestSchema = z.object({
  moveDealsToStageId: z.string().uuid().optional(),
});
export type DeleteDealStageRequest = z.infer<
  typeof DeleteDealStageRequestSchema
>;

// --- Deal -------------------------------------------------------------------

const DealTitleSchema = z.string().trim().min(1).max(1000);
/** Nilai deal: satuan mayor mata uangnya, ≥ 0, maks 2 desimal efektif di DB. */
const DealValueSchema = z.number().finite().min(0).max(999_999_999_999);
const DealDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const CreateDealRequestSchema = z.object({
  title: DealTitleSchema,
  contactId: z.string().uuid(),
  /** Boleh kosong: pipeline bawaan tenant dipakai. */
  pipelineId: z.string().uuid().optional(),
  /** Boleh kosong: tahap pertama pipeline dipakai. */
  stageId: z.string().uuid().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  value: DealValueSchema.optional(),
  /** Boleh kosong: mata uang bawaan tenant dipakai. */
  currency: CurrencyCodeSchema.optional(),
  expectedCloseDate: DealDateSchema.nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  priority: DealPrioritySchema.optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
});
export type CreateDealRequest = z.infer<typeof CreateDealRequestSchema>;

export const UpdateDealRequestSchema = z.object({
  title: DealTitleSchema.optional(),
  value: DealValueSchema.optional(),
  currency: CurrencyCodeSchema.optional(),
  expectedCloseDate: DealDateSchema.nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  priority: DealPrioritySchema.optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().optional(),
});
export type UpdateDealRequest = z.infer<typeof UpdateDealRequestSchema>;

/** Pindah tahap (seret Kanban & pemilih tahap di detail memakai ini). */
export const MoveDealStageRequestSchema = z.object({
  stageId: z.string().uuid(),
});
export type MoveDealStageRequest = z.infer<typeof MoveDealStageRequestSchema>;

export const DealResponseSchema = z.object({
  id: z.string().uuid(),
  pipelineId: z.string().uuid(),
  stageId: z.string().uuid(),
  contactId: z.string().uuid(),
  /** Nama kontak (denormalisasi baca — kartu papan tidak memuat kontak lagi). */
  contactName: z.string().nullable(),
  conversationId: z.string().uuid().nullable(),
  title: z.string(),
  value: z.number(),
  currency: z.string(),
  expectedCloseDate: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  status: DealStatusSchema,
  priority: DealPrioritySchema,
  assigneeUserId: z.string().uuid().nullable(),
  /** Nama penanggung jawab (denormalisasi baca); null bila tak ada/sudah keluar. */
  assigneeName: z.string().nullable(),
  closedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DealResponse = z.infer<typeof DealResponseSchema>;

export const DealListResponseSchema = z.object({
  deals: z.array(DealResponseSchema),
});
export type DealListResponse = z.infer<typeof DealListResponseSchema>;

/** Satu peristiwa riwayat tahap (baris pertama: pembuatan, from* null). */
export const DealStageEventResponseSchema = z.object({
  id: z.string().uuid(),
  dealId: z.string().uuid(),
  fromStageId: z.string().uuid().nullable(),
  toStageId: z.string().uuid().nullable(),
  fromStageName: z.string().nullable(),
  toStageName: z.string(),
  actorType: z.string(),
  actorId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type DealStageEventResponse = z.infer<
  typeof DealStageEventResponseSchema
>;

export const DealDetailResponseSchema = DealResponseSchema.extend({
  stageHistory: z.array(DealStageEventResponseSchema),
});
export type DealDetailResponse = z.infer<typeof DealDetailResponseSchema>;

// --- Analitik ringan (di halaman pipeline, bukan halaman analitik baru) -----

/** Total nilai satu mata uang — TIDAK pernah dijumlah lintas mata uang. */
export const DealCurrencyTotalSchema = z.object({
  currency: z.string(),
  total: z.number(),
});
export type DealCurrencyTotal = z.infer<typeof DealCurrencyTotalSchema>;

export const DealStageAnalyticsSchema = z.object({
  stageId: z.string().uuid(),
  dealCount: z.number().int(),
  totals: z.array(DealCurrencyTotalSchema),
});
export type DealStageAnalytics = z.infer<typeof DealStageAnalyticsSchema>;

export const DealPipelineAnalyticsResponseSchema = z.object({
  pipelineId: z.string().uuid(),
  stages: z.array(DealStageAnalyticsSchema),
  /** Jumlah deal berstatus won di pipeline ini. */
  wonCount: z.number().int(),
  /** Jumlah deal berstatus lost di pipeline ini. */
  lostCount: z.number().int(),
  /**
   * Rata-rata hari dari deal dibuat → won (closed_at − created_at
   * untuk deal won), dibulatkan 2 desimal; null bila belum ada deal
   * won — keadaan kosong yang jujur, bukan angka 0 karangan.
   */
  avgDaysToWon: z.number().nullable(),
});
export type DealPipelineAnalyticsResponse = z.infer<
  typeof DealPipelineAnalyticsResponseSchema
>;

// --- Pengaturan deals per tenant ---------------------------------------------

export const DealSettingsResponseSchema = z.object({
  /** Mata uang bawaan akun untuk deal baru (tenants.default_currency). */
  defaultCurrency: z.string(),
});
export type DealSettingsResponse = z.infer<typeof DealSettingsResponseSchema>;

export const UpdateDealSettingsRequestSchema = z.object({
  defaultCurrency: CurrencyCodeSchema,
});
export type UpdateDealSettingsRequest = z.infer<
  typeof UpdateDealSettingsRequestSchema
>;
