import { z } from "zod";

// ---------------------------------------------------------------------------
// Gelombang G14 — KODE DISKON & PENUKARAN (chat commerce).
//
// Kode promo per tenant yang diterapkan pada checkout keranjang (node
// flow `cart_checkout`) — satu-satunya jalur yang melahirkan order.
// Kode ternormalisasi HURUF BESAR di server (`normalizeDiscountCode`
// di core); pola sah: huruf/angka/strip/garis-bawah, 3–64 karakter.
// Commerce repo ini IDR-only: `kind: 'fixed'` berarti nominal Rupiah
// mengikuti mata uang pesanan (tidak ada kolom mata uang di kode).
// ---------------------------------------------------------------------------

export const DiscountKindSchema = z.enum(["percent", "fixed"]);
export type DiscountKind = z.infer<typeof DiscountKindSchema>;

/** Pola kode sesudah normalisasi (huruf besar). */
export const DISCOUNT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;

const CodeField = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "Kode hanya boleh huruf, angka, strip, dan garis bawah",
  );

const LimitsShape = {
  /** Subtotal minimum (Rupiah penuh); 0/terlewat = tanpa minimum. */
  minOrderIdr: z.number().int().nonnegative().max(1_000_000_000_000).optional(),
  /** Batas total penukaran; null/terlewat = tanpa batas. */
  maxRedemptions: z.number().int().positive().max(1_000_000).nullable().optional(),
  /** Batas penukaran per kontak; null/terlewat = tanpa batas. */
  maxPerContact: z.number().int().positive().max(1_000_000).nullable().optional(),
  /** Jendela berlaku; null/terlewat pada satu sisi = terbuka. */
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
};

function refineWindowAndValue(
  data: {
    kind?: DiscountKind;
    value?: number;
    startsAt?: string | null;
    endsAt?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (data.kind === "percent" && typeof data.value === "number") {
    if (data.value < 1 || data.value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Diskon persen harus 1–100",
      });
    }
  }
  if (data.kind === "fixed" && typeof data.value === "number") {
    if (data.value < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Diskon nominal harus minimal 1",
      });
    }
  }
  if (data.startsAt && data.endsAt) {
    if (new Date(data.endsAt) <= new Date(data.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endsAt"],
        message: "Waktu selesai harus sesudah waktu mulai",
      });
    }
  }
}

export const CreateDiscountCodeRequestSchema = z
  .object({
    code: CodeField,
    kind: DiscountKindSchema,
    value: z.number().int().positive().max(1_000_000_000_000),
    isActive: z.boolean().optional(),
    ...LimitsShape,
  })
  .superRefine(refineWindowAndValue);
export type CreateDiscountCodeRequest = z.infer<
  typeof CreateDiscountCodeRequestSchema
>;

/**
 * Ubah kode diskon. `code` (teks kodenya) TIDAK bisa diubah — ia
 * tercetak di snapshot order & riwayat penukaran; membuat teks baru
 * berarti membuat kode baru. Yang bisa diubah: nilai/batas/jendela/
 * status aktif.
 */
export const UpdateDiscountCodeRequestSchema = z
  .object({
    kind: DiscountKindSchema.optional(),
    value: z.number().int().positive().max(1_000_000_000_000).optional(),
    isActive: z.boolean().optional(),
    ...LimitsShape,
  })
  .superRefine(refineWindowAndValue);
export type UpdateDiscountCodeRequest = z.infer<
  typeof UpdateDiscountCodeRequestSchema
>;

export const DiscountCodeResponseSchema = z.object({
  id: z.string().uuid(),
  /** Teks kode ternormalisasi HURUF BESAR. */
  code: z.string(),
  kind: DiscountKindSchema,
  value: z.number().int().positive(),
  minOrderIdr: z.number().int().nonnegative(),
  maxRedemptions: z.number().int().positive().nullable(),
  maxPerContact: z.number().int().positive().nullable(),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
  isActive: z.boolean(),
  /** Penukaran yang masih berlaku (order pending/paid). */
  redemptionCount: z.number().int().nonnegative(),
  /** Penukaran yang dilepas (order expired/cancelled) — tidak memakan kuota. */
  releasedCount: z.number().int().nonnegative(),
  /** Total Rupiah diskon yang diberikan oleh penukaran yang masih berlaku. */
  totalDiscountIdr: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DiscountCodeResponse = z.infer<typeof DiscountCodeResponseSchema>;

export const DiscountCodeListResponseSchema = z.object({
  discountCodes: z.array(DiscountCodeResponseSchema),
});
export type DiscountCodeListResponse = z.infer<
  typeof DiscountCodeListResponseSchema
>;

/** Alasan penolakan kode saat checkout — spesifik & jujur per sebab. */
export const DiscountRejectReasonSchema = z.enum([
  "not_found",
  "inactive",
  "not_started",
  "expired",
  "below_minimum",
  "exhausted",
  "contact_limit",
]);
export type DiscountRejectReason = z.infer<typeof DiscountRejectReasonSchema>;
