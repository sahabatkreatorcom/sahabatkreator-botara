import { z } from "zod";

// ---------------------------------------------------------------------------
// Fase 10A — Template WhatsApp (cermin lokal template resmi Meta)
// ---------------------------------------------------------------------------

/** Kategori template Meta. */
export const WhatsAppTemplateCategorySchema = z.enum([
  "UTILITY",
  "MARKETING",
  "AUTHENTICATION",
]);
export type WhatsAppTemplateCategory = z.infer<
  typeof WhatsAppTemplateCategorySchema
>;

/**
 * Status persetujuan Meta sebagaimana terakhir disinkronkan. Nilai di
 * luar tiga status utama diteruskan apa adanya (varchar di cermin) —
 * skema membatasi pada yang dikenal agar UI punya chip yang pasti;
 * status asing dari Meta jatuh ke string mentahnya lewat validasi
 * longgar di serializer (lihat routes).
 */
export const WhatsAppTemplateStatusSchema = z.enum([
  "APPROVED",
  "PENDING",
  "REJECTED",
]);
export type WhatsAppTemplateStatus = z.infer<
  typeof WhatsAppTemplateStatusSchema
>;

/** Satu tombol template sederhana (URL / QUICK_REPLY) untuk formulir buat. */
export const WhatsAppTemplateButtonSchema = z.object({
  type: z.enum(["URL", "QUICK_REPLY"]),
  text: z.string().min(1).max(25),
  /** Wajib untuk tombol URL (maks 2000 mengikuti batas Meta). */
  url: z.string().url().max(2000).optional(),
});
export type WhatsAppTemplateButton = z.infer<
  typeof WhatsAppTemplateButtonSchema
>;

/**
 * Satu baris cermin template. `components` adalah komponen Meta apa
 * adanya (array objek bebas) — bentuk tampilan diturunkan dari
 * `bodyText` + `variableCount` yang dihitung server.
 */
export const WhatsAppTemplateResponseSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string().uuid(),
  metaTemplateId: z.string().nullable(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
  /**
   * Alasan status terakhir dari webhook `message_template_status_update`
   * (mis. alasan penolakan Meta). Null bila belum pernah dilaporkan —
   * ditampilkan di UI supaya "REJECTED" tidak menjadi jalan buntu.
   */
  statusReason: z.string().nullable(),
  components: z.array(z.record(z.string(), z.unknown())),
  bodyText: z.string().nullable(),
  /**
   * Jumlah variabel BODY. Dipertahankan apa adanya demi kompatibilitas,
   * tetapi JANGAN dipakai untuk menentukan berapa kolom yang harus diisi:
   * header dan tombol URL punya variabelnya sendiri. Pakai `params`.
   */
  variableCount: z.number().int().nonnegative(),
  /**
   * Spesifikasi parameter per KOMPONEN (Fase 17). Diturunkan server dari
   * `components` supaya UI tidak perlu mem-parse JSON Meta sendiri —
   * satu tempat salah baca berarti kolom input yang salah jumlahnya.
   */
  params: z.object({
    header: z.object({
      /** `TEXT` ber-variabel teks; `IMAGE`/`VIDEO`/`DOCUMENT` butuh media. */
      format: z.string().nullable(),
      text: z.string().nullable(),
      variableCount: z.number().int().nonnegative(),
    }),
    body: z.object({
      text: z.string().nullable(),
      variableCount: z.number().int().nonnegative(),
    }),
    /** Tombol URL ber-variabel; `index` = posisi tombol (0-based). */
    urlButtons: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        variableCount: z.number().int().nonnegative(),
      }),
    ),
    total: z.number().int().nonnegative(),
  }),
  syncedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WhatsAppTemplateResponse = z.infer<
  typeof WhatsAppTemplateResponseSchema
>;

export const WhatsAppTemplateListResponseSchema = z.object({
  templates: z.array(WhatsAppTemplateResponseSchema),
});
export type WhatsAppTemplateListResponse = z.infer<
  typeof WhatsAppTemplateListResponseSchema
>;

export const WhatsAppTemplateListQuerySchema = z.object({
  channelAccountId: z.string().uuid(),
});
export type WhatsAppTemplateListQuery = z.infer<
  typeof WhatsAppTemplateListQuerySchema
>;

/** Sinkronisasi cermin dari Meta untuk satu akun WhatsApp. */
export const SyncWhatsAppTemplatesRequestSchema = z.object({
  channelAccountId: z.string().uuid(),
});
export type SyncWhatsAppTemplatesRequest = z.infer<
  typeof SyncWhatsAppTemplatesRequestSchema
>;

export const SyncWhatsAppTemplatesResponseSchema = z.object({
  /** Jumlah template yang kini tercermin untuk akun (sesudah sinkron). */
  synced: z.number().int().nonnegative(),
  templates: z.array(WhatsAppTemplateResponseSchema),
});
export type SyncWhatsAppTemplatesResponse = z.infer<
  typeof SyncWhatsAppTemplatesResponseSchema
>;

/**
 * Buat template baru (diteruskan ke Meta `POST /{waba-id}/message_templates`).
 * Bentuk formulir sederhana v1: HEADER teks polos opsional (tanpa
 * variabel), BODY wajib (variabel {{n}} wajib disertai contoh di
 * `bodyExamples` agar lolos tinjauan Meta), FOOTER opsional, tombol
 * URL/QUICK_REPLY sederhana (maks 3). Nama mengikuti aturan Meta:
 * huruf kecil, angka, garis bawah.
 */
export const CreateWhatsAppTemplateRequestSchema = z.object({
  channelAccountId: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-z0-9_]+$/, "template name must be lowercase letters, digits and underscores"),
  language: z.string().min(2).max(32),
  category: WhatsAppTemplateCategorySchema,
  headerText: z.string().min(1).max(60).optional(),
  bodyText: z.string().min(1).max(1024),
  /** Contoh nilai variabel BODY secara berurutan ({{1}}, {{2}}, …). */
  bodyExamples: z.array(z.string().min(1).max(200)).max(25).optional(),
  footerText: z.string().min(1).max(60).optional(),
  buttons: z.array(WhatsAppTemplateButtonSchema).max(3).optional(),
});
export type CreateWhatsAppTemplateRequest = z.infer<
  typeof CreateWhatsAppTemplateRequestSchema
>;
