import { z } from "zod";

// ---------------------------------------------------------------------------
// Products & payment links (Fase 4A) — katalog produk tenant + tautan bayar.
// PENTING: provider fase ini adalah 'simulation' — halaman /pay adalah
// SIMULASI berlabel jujur, bukan gerbang pembayaran sungguhan (Midtrans/
// Xendit menyusul bersama kredensial sandbox; temuan v26 §12: order API
// Meta dihapus, pembayaran memang harus milik sendiri).
// ---------------------------------------------------------------------------

/** Harga Rupiah penuh: bilangan bulat >= 0 (bigint di DB, number di kontrak). */
const PriceIdrSchema = z.number().int().nonnegative().max(1_000_000_000_000_000);

export const CreateProductRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(10_000).optional(),
  priceIdr: PriceIdrSchema,
  isActive: z.boolean().optional(),
});
export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

export const UpdateProductRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    /** null = kosongkan deskripsi. */
    description: z.string().trim().max(10_000).nullable().optional(),
    priceIdr: PriceIdrSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateProductRequest = z.infer<typeof UpdateProductRequestSchema>;

export const ProductResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  priceIdr: z.number().int().nonnegative(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProductResponse = z.infer<typeof ProductResponseSchema>;

export const ProductListResponseSchema = z.object({
  products: z.array(ProductResponseSchema),
});
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;

export const PaymentLinkStatusSchema = z.enum([
  "pending",
  "paid",
  "expired",
  "cancelled",
]);
export type PaymentLinkStatus = z.infer<typeof PaymentLinkStatusSchema>;

/**
 * Gerbang pembayaran (Fase 14A): 'simulation' adalah provider bawaan
 * (tanpa uang sungguhan, halaman /pay berlabel simulasi); 'midtrans' &
 * 'xendit' adalah gerbang sungguhan dengan kredensial MILIK TENANT.
 */
export const PaymentProviderSchema = z.enum([
  "simulation",
  "midtrans",
  "xendit",
]);
export type PaymentProvider = z.infer<typeof PaymentProviderSchema>;

/** Environment provider: kunci sandbox & production terpisah per tenant. */
export const PaymentEnvironmentSchema = z.enum(["sandbox", "production"]);
export type PaymentEnvironment = z.infer<typeof PaymentEnvironmentSchema>;

export const CreatePaymentLinkRequestSchema = z.object({
  productId: z.string().uuid(),
  /** Opsional: tautan dibuat untuk kontak tertentu. */
  contactId: z.string().uuid().optional(),
});
export type CreatePaymentLinkRequest = z.infer<
  typeof CreatePaymentLinkRequestSchema
>;

export const PaymentLinkResponseSchema = z.object({
  id: z.string().uuid(),
  /** Produk yang dibayar; null untuk tautan order (Fase 13F). */
  productId: z.string().uuid().nullable(),
  /** Order yang dibayar; null untuk tautan produk (Fase 13F). */
  orderId: z.string().uuid().nullable(),
  productName: z.string(),
  contactId: z.string().uuid().nullable(),
  contactName: z.string().nullable(),
  conversationId: z.string().uuid().nullable(),
  code: z.string(),
  /** URL publik halaman bayar: {base}/pay/{code}. */
  url: z.string(),
  /** Snapshot harga produk / total order saat tautan dibuat. */
  amountIdr: z.number().int().nonnegative(),
  status: PaymentLinkStatusSchema,
  /** Provider gerbang tautan: 'simulation' | 'midtrans' | 'xendit' (Fase 14A). */
  provider: z.string(),
  /** Environment provider saat tautan dibuat (snapshot per tautan). */
  providerEnvironment: PaymentEnvironmentSchema,
  paidAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PaymentLinkResponse = z.infer<typeof PaymentLinkResponseSchema>;

export const PaymentLinkListResponseSchema = z.object({
  paymentLinks: z.array(PaymentLinkResponseSchema),
});
export type PaymentLinkListResponse = z.infer<
  typeof PaymentLinkListResponseSchema
>;

/**
 * Tampilan publik halaman bayar /pay/:code — TANPA data pribadi kontak.
 * Yang boleh dilihat siapa pun yang memegang tautan: produk, harga,
 * status, dan nama workspace penjual.
 */
export const PublicPaymentResponseSchema = z.object({
  code: z.string(),
  productName: z.string(),
  description: z.string().nullable(),
  amountIdr: z.number().int().nonnegative(),
  status: PaymentLinkStatusSchema,
  tenantName: z.string(),
  /** 'simulation' → halaman berlabel simulasi; selain itu gerbang sungguhan. */
  provider: z.string(),
  /** Environment provider tautan (Fase 14A). */
  providerEnvironment: PaymentEnvironmentSchema,
  /**
   * URL checkout provider (Fase 14A): halaman /pay mengarahkan pembeli
   * ke sini untuk provider sungguhan; null untuk simulasi (bayar di
   * tempat) dan untuk tautan yang sudah tidak pending.
   */
  checkoutUrl: z.string().nullable(),
  paidAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
});
export type PublicPaymentResponse = z.infer<
  typeof PublicPaymentResponseSchema
>;

/**
 * Konfigurasi gerbang pembayaran tenant (Fase 14A) — Settings →
 * Payments di dashboard. KEAMANAN: respons TIDAK PERNAH memuat nilai
 * kunci; yang keluar hanya penanda terkonfigurasi per pasangan
 * (provider, environment). Permukaan ini dashboard-only (kredensial
 * tenant; preseden kredensial) — bukan API v1/SDK/MCP.
 */
export const PaymentCredentialSetStatusSchema = z.object({
  serverKeyConfigured: z.boolean(),
  clientKeyConfigured: z.boolean(),
});
export type PaymentCredentialSetStatus = z.infer<
  typeof PaymentCredentialSetStatusSchema
>;

export const XenditCredentialSetStatusSchema =
  PaymentCredentialSetStatusSchema.extend({
    callbackTokenConfigured: z.boolean(),
  });
export type XenditCredentialSetStatus = z.infer<
  typeof XenditCredentialSetStatusSchema
>;

export const PaymentSettingsResponseSchema = z.object({
  provider: PaymentProviderSchema,
  environment: PaymentEnvironmentSchema,
  midtrans: z.object({
    sandbox: PaymentCredentialSetStatusSchema,
    production: PaymentCredentialSetStatusSchema,
  }),
  xendit: z.object({
    sandbox: XenditCredentialSetStatusSchema,
    production: XenditCredentialSetStatusSchema,
  }),
  /** URL webhook yang harus didaftarkan tenant di dashboard provider. */
  webhookUrls: z.object({
    midtrans: z.string(),
    xendit: z.string(),
  }),
});
export type PaymentSettingsResponse = z.infer<
  typeof PaymentSettingsResponseSchema
>;

/**
 * Pembaruan konfigurasi: field kunci bersifat tri-state per field —
 * tidak dikirim = tidak berubah; string kosong = hapus (kembali belum
 * terkonfigurasi); string non-kosong = ganti (dienkripsi server).
 */
export const UpdatePaymentSettingsRequestSchema = z.object({
  provider: PaymentProviderSchema.optional(),
  environment: PaymentEnvironmentSchema.optional(),
  midtransSandboxServerKey: z.string().max(512).optional(),
  midtransSandboxClientKey: z.string().max(512).optional(),
  midtransProductionServerKey: z.string().max(512).optional(),
  midtransProductionClientKey: z.string().max(512).optional(),
  xenditSandboxServerKey: z.string().max(512).optional(),
  xenditSandboxClientKey: z.string().max(512).optional(),
  xenditProductionServerKey: z.string().max(512).optional(),
  xenditProductionClientKey: z.string().max(512).optional(),
  xenditSandboxCallbackToken: z.string().max(512).optional(),
  xenditProductionCallbackToken: z.string().max(512).optional(),
});
export type UpdatePaymentSettingsRequest = z.infer<
  typeof UpdatePaymentSettingsRequestSchema
>;

/**
 * Hasil uji koneksi provider aktif (preseden probe Resend Fase 11B):
 * kode jujur — OK | NOT_CONFIGURED | MIDTRANS_AUTH_FAILED |
 * MIDTRANS_UNREACHABLE | XENDIT_AUTH_FAILED | XENDIT_UNREACHABLE.
 */
export const PaymentSettingsTestResponseSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  provider: PaymentProviderSchema,
  environment: PaymentEnvironmentSchema,
});
export type PaymentSettingsTestResponse = z.infer<
  typeof PaymentSettingsTestResponseSchema
>;
