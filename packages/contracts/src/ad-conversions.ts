import { z } from "zod";

// ---------------------------------------------------------------------------
// Gelombang G16 — Konversi Iklan dari Flow (Meta CAPI + Google Ads)
// ---------------------------------------------------------------------------

/**
 * KONEKSI IKLAN TENANT — Settings → Konversi Iklan di dashboard.
 * Koneksi ini MILIK TENANT (dataset/token Meta mereka, akun Google
 * Ads mereka), BUKAN kredensial platform: yang platform hanya
 * developer token Google Ads + klien OAuth layanan 'ads' (Panel
 * Admin). KEAMANAN: respons TIDAK PERNAH memuat nilai token; yang
 * keluar hanya penanda terkonfigurasi + identifier publik (dataset
 * ID, customer ID, conversion action ID, email akun Google).
 * Permukaan ini dashboard-only — bukan API v1/SDK/MCP.
 */

export const AdPlatformSchema = z.enum(["meta", "google"]);
export type AdPlatform = z.infer<typeof AdPlatformSchema>;

/** Peristiwa standar Meta yang ditawarkan builder (nama kustom tetap sah). */
export const META_STANDARD_EVENT_NAMES = [
  "Lead",
  "Purchase",
  "CompleteRegistration",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Contact",
  "Schedule",
  "SubmitApplication",
  "ViewContent",
] as const;

export const AdConnectionsResponseSchema = z.object({
  meta: z.object({
    /** Dataset (pixel) ID — identifier publik, ditampilkan. */
    datasetId: z.string().nullable(),
    /** Token CAPI TIDAK PERNAH ditampilkan; hanya statusnya. */
    accessTokenConfigured: z.boolean(),
    /** Kode peristiwa uji Events Manager (bukan rahasia). */
    testEventCode: z.string().nullable(),
    /** Siap kirim = dataset + token terisi. */
    ready: z.boolean(),
  }),
  google: z.object({
    /** Customer ID akun Ads tenant (digit) — identifier publik. */
    customerId: z.string().nullable(),
    /** ID aksi konversi tujuan — identifier publik. */
    conversionActionId: z.string().nullable(),
    /** Akun Google layanan 'ads' terhubung (consent OAuth tenant). */
    adsAccountConnected: z.boolean(),
    adsAccountEmail: z.string().nullable(),
    /**
     * Developer token adalah kredensial PLATFORM: tenant hanya
     * melihat apakah platform sudah menyediakannya, bukan nilainya.
     */
    developerTokenConfigured: z.boolean(),
    /** Siap kirim = akun terhubung + customer + aksi + token platform. */
    ready: z.boolean(),
  }),
});
export type AdConnectionsResponse = z.infer<
  typeof AdConnectionsResponseSchema
>;

/**
 * Pembaruan koneksi: field bersifat tri-state per field (pola
 * UpdatePaymentSettingsRequest) — tidak dikirim = tidak berubah;
 * string kosong/null = hapus; string non-kosong = ganti (token
 * dienkripsi server). Dataset/customer/action ID dinormalisasi server
 * (strip dibuang untuk ID Google).
 */
export const UpdateAdConnectionsRequestSchema = z.object({
  metaDatasetId: z.string().max(64).nullable().optional(),
  metaAccessToken: z.string().max(1024).nullable().optional(),
  metaTestEventCode: z.string().max(64).nullable().optional(),
  googleCustomerId: z.string().max(32).nullable().optional(),
  googleConversionActionId: z.string().max(32).nullable().optional(),
});
export type UpdateAdConnectionsRequest = z.infer<
  typeof UpdateAdConnectionsRequestSchema
>;

/** Status akhir satu baris ledger pengiriman konversi. */
export const AdConversionStatusSchema = z.enum([
  "queued",
  "sent",
  "failed",
  "skipped",
]);
export type AdConversionStatus = z.infer<typeof AdConversionStatusSchema>;

/**
 * Satu baris riwayat pengiriman konversi untuk daftar di Pengaturan —
 * TANPA payload mentah dan TANPA pengenal (hash pun tidak ditampilkan;
 * daftar ini murni status operasional).
 */
export const AdConversionEventResponseSchema = z.object({
  id: z.string().uuid(),
  platform: AdPlatformSchema,
  eventName: z.string(),
  status: AdConversionStatusSchema,
  value: z.number().nullable(),
  currency: z.string().nullable(),
  valueSource: z.enum(["order", "deal", "static"]).nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
});
export type AdConversionEventResponse = z.infer<
  typeof AdConversionEventResponseSchema
>;

export const AdConversionEventListResponseSchema = z.object({
  events: z.array(AdConversionEventResponseSchema),
});
export type AdConversionEventListResponse = z.infer<
  typeof AdConversionEventListResponseSchema
>;
