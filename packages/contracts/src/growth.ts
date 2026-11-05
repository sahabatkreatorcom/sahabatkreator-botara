import { z } from "zod";

import { ChannelAccountStatusSchema } from "./channels";
import { ChannelProviderSchema } from "./inbox";

// ---------------------------------------------------------------------------
// Fase 13B — Growth Tools: tautan publik per channel (/go/:slug),
// halaman arahan pemilih channel, dan analitik per tautan.
//
// Bentuk publik: GET /go/:slug (tanpa autentikasi) mencatat klik lalu
// 302 ke URL platform; picker me-render halaman arahan. Atribusi
// kontak terjadi di jalur inbound (Telegram /start <slug>, referral
// Meta, sesi webchat ?src=) — WhatsApp memang tidak punya jalur
// payload, jadi untuk WA hanya klik yang tercatat (dinyatakan jujur
// di UI). Permukaan v1 untuk sumber daya ini BACA saja
// (growth_links:read); tulis = kurasi UI dashboard (slug publik +
// branding), lihat docs/COVERAGE-MATRIX.md.
// ---------------------------------------------------------------------------

export const GrowthLinkKindSchema = z.enum(["single", "picker"]);
export type GrowthLinkKind = z.infer<typeof GrowthLinkKindSchema>;

/**
 * Slug publik: 3–64 karakter huruf kecil/angka/strip, tidak diawali
 * atau diakhiri strip. Batas 64 juga menjaga payload `/start` Telegram
 * (maks 64 karakter) tetap sah.
 */
export const GrowthLinkSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/,
    "Slug must be 3-64 chars of lowercase letters, digits and hyphens",
  );
export type GrowthLinkSlug = z.infer<typeof GrowthLinkSlugSchema>;

/** Ringkasan akun channel sebagaimana dirujuk tautan growth. */
export const GrowthLinkChannelSummarySchema = z.object({
  id: z.string().uuid(),
  provider: ChannelProviderSchema,
  displayName: z.string().nullable(),
  /** Username Page (messenger) / akun IG / nomor tampil WhatsApp. */
  publicHandle: z.string().nullable(),
  /** Username bot Telegram (tanpa '@'); provider lain null. */
  botUsername: z.string().nullable(),
  status: ChannelAccountStatusSchema,
});
export type GrowthLinkChannelSummary = z.infer<
  typeof GrowthLinkChannelSummarySchema
>;

/** Angka analitik yang DITURUNKAN dari growth_link_events (bukan penghitung tersimpan). */
export const GrowthLinkStatsSchema = z.object({
  clicks: z.number().int(),
  pickerViews: z.number().int(),
  conversions: z.number().int(),
});
export type GrowthLinkStats = z.infer<typeof GrowthLinkStatsSchema>;

export const GrowthLinkResponseSchema = z.object({
  id: z.string().uuid(),
  kind: GrowthLinkKindSchema,
  label: z.string(),
  slug: z.string(),
  /** Path publik tautan ini (origin dashboard + path ini = URL utuh). */
  publicPath: z.string(),
  channelAccountId: z.string().uuid().nullable(),
  /** Akun tujuan untuk kind 'single'; null untuk picker. */
  channel: GrowthLinkChannelSummarySchema.nullable(),
  pickerChannelIds: z.array(z.string().uuid()),
  /** Ringkasan akun picker, urut seperti pickerChannelIds. */
  pickerChannels: z.array(GrowthLinkChannelSummarySchema),
  autoTag: z.string().nullable(),
  prefillText: z.string().nullable(),
  isActive: z.boolean(),
  stats: GrowthLinkStatsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GrowthLinkResponse = z.infer<typeof GrowthLinkResponseSchema>;

export const GrowthLinkListResponseSchema = z.object({
  links: z.array(GrowthLinkResponseSchema),
});
export type GrowthLinkListResponse = z.infer<
  typeof GrowthLinkListResponseSchema
>;

export const CreateGrowthLinkRequestSchema = z.object({
  kind: GrowthLinkKindSchema,
  label: z.string().trim().min(1).max(128),
  /** Kosongkan untuk digenerate server dari label. */
  slug: GrowthLinkSlugSchema.optional(),
  /** Wajib untuk kind 'single' (ditegakkan layanan: 422 bila absen/salah). */
  channelAccountId: z.string().uuid().optional(),
  /** Wajib >= 2 untuk kind 'picker' (ditegakkan layanan). */
  pickerChannelIds: z.array(z.string().uuid()).max(10).optional(),
  autoTag: z.string().trim().min(1).max(64).nullable().optional(),
  prefillText: z.string().trim().min(1).max(1000).nullable().optional(),
});
export type CreateGrowthLinkRequest = z.infer<
  typeof CreateGrowthLinkRequestSchema
>;

/** Edit parsial: hanya field yang disebut yang berubah (route menolak objek kosong). */
export const UpdateGrowthLinkRequestSchema = z.object({
  label: z.string().trim().min(1).max(128).optional(),
  slug: GrowthLinkSlugSchema.optional(),
  channelAccountId: z.string().uuid().optional(),
  pickerChannelIds: z.array(z.string().uuid()).max(10).optional(),
  autoTag: z.string().trim().min(1).max(64).nullable().optional(),
  prefillText: z.string().trim().min(1).max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateGrowthLinkRequest = z.infer<
  typeof UpdateGrowthLinkRequestSchema
>;

/** Satu kontak teratribusi (event conversion terbaru dulu). */
export const GrowthLinkAttributedContactSchema = z.object({
  contactId: z.string().uuid(),
  name: z.string(),
  /** Nilai kolom sumber kontak (mis. "growth:promo"), null bila kontak sudah terhapus sumbernya. */
  source: z.string().nullable(),
  convertedAt: z.string().datetime(),
});
export type GrowthLinkAttributedContact = z.infer<
  typeof GrowthLinkAttributedContactSchema
>;

export const GrowthLinkAttributedContactsResponseSchema = z.object({
  contacts: z.array(GrowthLinkAttributedContactSchema),
});
export type GrowthLinkAttributedContactsResponse = z.infer<
  typeof GrowthLinkAttributedContactsResponseSchema
>;
