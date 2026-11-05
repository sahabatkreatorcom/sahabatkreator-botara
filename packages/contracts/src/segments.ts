import { z } from "zod";

import { EffectiveOptInStatusSchema } from "./contacts";
import { ChannelProviderSchema } from "./inbox";

// ---------------------------------------------------------------------------
// Fase 13C — Segmentasi audiens & pengaturan opt-in broadcast.
//
// Segmen = definisi kondisi bernama atas kontak tenant, dievaluasi
// SATU evaluator di core untuk tiga konsumen: filter daftar kontak,
// pratinjau audiens broadcast, dan materialisasi penerima broadcast.
// Permukaan v1 untuk segmen BACA saja (segments:read); tulis =
// dashboard-only (artefak kurasi UI + definisi kompleks — lihat
// docs/COVERAGE-MATRIX.md). Pengaturan opt-in adalah permukaan
// dashboard saja (konfigurasi tenant, bukan sumber daya integrasi).
// ---------------------------------------------------------------------------

/**
 * Satu kondisi segmen. `last_active_within_days` memakai definisi
 * aktivitas: waktu pesan MASUK terakhir kontak di semua percakapan
 * 1:1-nya; bila kontak belum pernah mengirim pesan, jatuh ke
 * `updated_at` percakapan 1:1 terbarunya; kontak tanpa percakapan
 * sama sekali tidak pernah "aktif".
 */
export const SegmentConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tag"),
    tag: z.string().trim().min(1).max(64),
  }),
  z.object({
    type: z.literal("stage"),
    stage: z.string().trim().min(1).max(64),
  }),
  z.object({
    type: z.literal("source_prefix"),
    prefix: z.string().trim().min(1).max(128),
  }),
  z.object({
    type: z.literal("opt_in_status"),
    status: EffectiveOptInStatusSchema,
  }),
  z.object({
    type: z.literal("custom_field"),
    key: z.string().trim().min(1).max(64),
    op: z.enum(["eq", "contains"]),
    value: z.string().max(1000),
  }),
  z.object({
    type: z.literal("created_within_days"),
    days: z.number().int().min(1).max(3650),
  }),
  z.object({
    type: z.literal("last_active_within_days"),
    days: z.number().int().min(1).max(3650),
  }),
  z.object({
    type: z.literal("has_channel"),
    provider: ChannelProviderSchema,
  }),
]);
export type SegmentCondition = z.infer<typeof SegmentConditionSchema>;

export const SegmentDefinitionSchema = z.object({
  /** "all" = semua kondisi harus cocok (AND); "any" = salah satu (OR). */
  match: z.enum(["all", "any"]),
  conditions: z.array(SegmentConditionSchema).min(1).max(20),
});
export type SegmentDefinition = z.infer<typeof SegmentDefinitionSchema>;

export const SegmentResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  definition: SegmentDefinitionSchema,
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SegmentResponse = z.infer<typeof SegmentResponseSchema>;

export const SegmentListResponseSchema = z.object({
  segments: z.array(SegmentResponseSchema),
});
export type SegmentListResponse = z.infer<typeof SegmentListResponseSchema>;

export const CreateSegmentRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  definition: SegmentDefinitionSchema,
});
export type CreateSegmentRequest = z.infer<typeof CreateSegmentRequestSchema>;

export const UpdateSegmentRequestSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  definition: SegmentDefinitionSchema.optional(),
});
export type UpdateSegmentRequest = z.infer<typeof UpdateSegmentRequestSchema>;

/** Pratinjau hitungan anggota untuk definisi (tersimpan atau draf). */
export const SegmentPreviewRequestSchema = z.object({
  definition: SegmentDefinitionSchema,
});
export type SegmentPreviewRequest = z.infer<
  typeof SegmentPreviewRequestSchema
>;

export const SegmentPreviewResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type SegmentPreviewResponse = z.infer<
  typeof SegmentPreviewResponseSchema
>;

/**
 * Pengaturan mesin opt-in per tenant (Fase 13C). `defaultOptOutKeywords`
 * adalah kata bawaan sistem (konstanta core, hanya-baca di UI);
 * `optOutExtraKeywords` adalah tambahan tenant yang digabung di atasnya.
 */
export const OptInSettingsResponseSchema = z.object({
  optInKeywords: z.array(z.string()),
  /** Teks konfirmasi opt-in; null = opt-in diam (tanpa balasan). */
  optInConfirmationText: z.string().nullable(),
  optOutExtraKeywords: z.array(z.string()),
  defaultOptOutKeywords: z.array(z.string()),
});
export type OptInSettingsResponse = z.infer<
  typeof OptInSettingsResponseSchema
>;

export const UpdateOptInSettingsRequestSchema = z.object({
  optInKeywords: z
    .array(z.string().trim().min(1).max(64))
    .max(20)
    .optional(),
  optInConfirmationText: z.string().trim().max(1000).nullable().optional(),
  optOutExtraKeywords: z
    .array(z.string().trim().min(1).max(64))
    .max(20)
    .optional(),
});
export type UpdateOptInSettingsRequest = z.infer<
  typeof UpdateOptInSettingsRequestSchema
>;
