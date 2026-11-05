import { z } from "zod";
import { ChannelProviderSchema } from "./inbox";

// ---------------------------------------------------------------------------
// Contacts (Fase 1D)
// ---------------------------------------------------------------------------

export const OptInStatusSchema = z.enum(["unknown", "opted_in", "opted_out"]);
export type OptInStatus = z.infer<typeof OptInStatusSchema>;

/**
 * Peta field kustom kontak: string → string (Fase 13A — sebelumnya hanya
 * bisa ditulis jalur internal: node flow `set_field`, merge kontak, dst.;
 * kini juga permukaan publik). Aturan bentuk: kunci 1–64 karakter
 * (sesudah trim), nilai string maks 1000 karakter, maks 50 entri. Nilai
 * non-string DITOLAK — pemanggil mengonversi angka/boolean sendiri agar
 * tidak ada koersi senyap. Semantik tulis: buat = apa adanya; ubah =
 * GABUNG per kunci (kunci yang dikirim menimpa, yang tidak disebut
 * dipertahankan — sama seperti set_field menulis satu kunci).
 */
export const ContactCustomFieldsSchema = z
  .record(z.string().trim().min(1).max(64), z.string().max(1000))
  .refine((fields) => Object.keys(fields).length <= 50, {
    message: "At most 50 custom fields",
  });
export type ContactCustomFields = z.infer<typeof ContactCustomFieldsSchema>;

export const CreateContactRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  phone: z.string().trim().min(1).max(32).optional(),
  email: z.string().trim().email().max(320).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  customFields: ContactCustomFieldsSchema.optional(),
});
export type CreateContactRequest = z.infer<typeof CreateContactRequestSchema>;

export const UpdateContactRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  pipelineStage: z.string().trim().min(1).max(64).optional(),
  optInStatus: OptInStatusSchema.optional(),
  customFields: ContactCustomFieldsSchema.optional(),
});
export type UpdateContactRequest = z.infer<typeof UpdateContactRequestSchema>;

/**
 * Status opt-in EFEKTIF (Fase 13C) — diturunkan server dari kolom
 * tersimpan, bukan disimpan apa adanya:
 * - optInStatus tersimpan "opted_out"            → "opted_out"
 * - optInStatus "opted_in" ATAU optInAt terisi   → "opted_in"
 * - selain itu                                   → "none"
 * Dipakai kondisi segmen `opt_in_status` dan gerbang broadcast
 * `require_opt_in`. Status TERSIMPAN tetap diekspos apa adanya lewat
 * `optInStatus` (enum unknown/opted_in/opted_out) agar permukaan
 * PATCH yang ada tidak berubah semantik.
 */
export const EffectiveOptInStatusSchema = z.enum([
  "opted_in",
  "none",
  "opted_out",
]);
export type EffectiveOptInStatus = z.infer<typeof EffectiveOptInStatusSchema>;

export const ContactResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /**
   * URL foto profil kontak (Fase 6D): endpoint avatar kita sendiri
   * (`/api/tenants/:tenantId/avatars/contacts/:id`) bila foto tersimpan
   * (saat ini hanya kontak Telegram), selain itu null dan UI menampilkan
   * inisial berwarna — untuk kontak webchat null adalah BY DESIGN
   * (pengunjung anonim tidak punya foto). Bukan URL provider.
   */
  avatarUrl: z.string().nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.unknown()),
  pipelineStage: z.string(),
  optInStatus: OptInStatusSchema,
  /** Status opt-in efektif (Fase 13C) — lihat EffectiveOptInStatusSchema. */
  optInEffectiveStatus: EffectiveOptInStatusSchema,
  /**
   * Jalur persetujuan opt-in terakhir (Fase 13C): "keyword" (kata kunci
   * opt-in di pipeline inbound) atau "manual" (toggle dashboard/API);
   * null bila kontak belum pernah opt-in. Opt-out TIDAK menghapusnya
   * (riwayat) — status efektiflah yang menentukan boleh-tidaknya
   * broadcast.
   */
  optInSource: z.string().nullable(),
  /** Kapan opt-in terakhir diberikan (Fase 13C); null bila belum pernah. */
  optInAt: z.string().datetime().nullable(),
  consentAt: z.string().datetime().nullable(),
  lastContactedAt: z.string().datetime().nullable(),
  /**
   * Kanal tempat kontak ini BENAR-BENAR punya percakapan (badge di daftar
   * kontak). Diturunkan dari `conversations.provider`, bukan kolom di
   * `contacts` — jadi badge tidak pernah mengklaim kanal yang belum dipakai.
   * Array kosong = kontak belum pernah menghubungi lewat kanal mana pun
   * (mis. dibuat manual lewat impor/CRM).
   */
  platforms: z.array(ChannelProviderSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ContactResponse = z.infer<typeof ContactResponseSchema>;

export const ContactListResponseSchema = z.object({
  contacts: z.array(ContactResponseSchema),
  total: z.number().int().nonnegative(),
});
export type ContactListResponse = z.infer<typeof ContactListResponseSchema>;

// --- Dedup & merge kontak (Fase 9B) ---

/** Alasan dua kontak dinilai kandidat duplikat (sinyal yang cocok). */
export const DuplicateReasonSchema = z.object({
  type: z.enum(["phone", "email", "channel_identity"]),
  /** Nilai ternormalisasi yang sama: telepon digit, email lowercase, atau "provider:externalUserId". */
  value: z.string(),
  contactIds: z.array(z.string().uuid()).min(2),
});
export type DuplicateReason = z.infer<typeof DuplicateReasonSchema>;

export const ContactDuplicateGroupSchema = z.object({
  contacts: z.array(ContactResponseSchema).min(2),
  reasons: z.array(DuplicateReasonSchema).min(1),
});
export type ContactDuplicateGroup = z.infer<typeof ContactDuplicateGroupSchema>;

export const ContactDuplicatesResponseSchema = z.object({
  groups: z.array(ContactDuplicateGroupSchema),
});
export type ContactDuplicatesResponse = z.infer<
  typeof ContactDuplicatesResponseSchema
>;

/** Body POST /contacts/:survivorId/merge — kontak yang dilebur ke survivor. */
export const MergeContactRequestSchema = z.object({
  mergedId: z.string().uuid(),
});
export type MergeContactRequest = z.infer<typeof MergeContactRequestSchema>;
