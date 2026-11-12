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
  /**
   * Kanal penghapusan kunci field kustom (aditif): semantik
   * `customFields` sendiri TIDAK berubah (tetap gabung per kunci);
   * kunci yang disebut di sini dihapus dari peta tersimpan. Dipakai
   * editor field kustom dashboard yang mengelola himpunan lengkap —
   * tanpa kanal ini kunci yang dihapus dari formulir akan hidup lagi
   * pada pemuatan berikutnya karena gabung tidak bisa menghapus.
   */
  customFieldsDelete: z
    .array(z.string().trim().min(1).max(64))
    .max(50)
    .optional(),
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

// ---------------------------------------------------------------------------
// Percakapan milik kontak (panel detail /contacts)
// ---------------------------------------------------------------------------

/**
 * Satu percakapan milik kontak untuk panel detail. `kind` menentukan
 * apakah baris ini boleh diberi tautan "Buka di Inbox": hanya
 * percakapan PESAN (`private`/`group`) yang hidup di Inbox; baris
 * `channel` adalah linimasa postingan akun itu sendiri — menautkannya
 * ke Inbox akan menyesatkan (Inbox memang menyaringnya keluar), jadi
 * UI menampilkannya tanpa tautan.
 */
export const ContactConversationSchema = z.object({
  id: z.string().uuid(),
  provider: ChannelProviderSchema,
  kind: z.enum(["private", "group", "channel"]),
  /** Judul percakapan (grup/channel); null untuk privat. */
  title: z.string().nullable(),
  status: z.enum(["open", "pending", "closed"]),
  lastMessageAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ContactConversation = z.infer<typeof ContactConversationSchema>;

export const ContactConversationListResponseSchema = z.object({
  conversations: z.array(ContactConversationSchema),
});
export type ContactConversationListResponse = z.infer<
  typeof ContactConversationListResponseSchema
>;

// ---------------------------------------------------------------------------
// Aksi massal kontak (daftar utama /contacts)
// ---------------------------------------------------------------------------

const ContactBulkIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(500);

/**
 * Body POST /contacts/bulk — SATU aksi untuk banyak kontak dalam satu
 * panggilan. Id yang dikirim klien tetap divalidasi server di dalam
 * tenant (id asing / tak dikenal dilaporkan gagal per id, bukan
 * menggagalkan seluruh panggilan). Aksi `delete` digerbang
 * owner/admin di route (sejajar merge) dan menghapus kontak beserta
 * turunan cascade-nya — UI wajib mengonfirmasi lebih dulu.
 */
export const ContactBulkRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add_tag"),
    ids: ContactBulkIdsSchema,
    tag: z.string().trim().min(1).max(64),
  }),
  z.object({
    action: z.literal("remove_tag"),
    ids: ContactBulkIdsSchema,
    tag: z.string().trim().min(1).max(64),
  }),
  z.object({
    action: z.literal("set_stage"),
    ids: ContactBulkIdsSchema,
    stage: z.string().trim().min(1).max(64),
  }),
  z.object({ action: z.literal("opt_out"), ids: ContactBulkIdsSchema }),
  z.object({ action: z.literal("delete"), ids: ContactBulkIdsSchema }),
]);
export type ContactBulkRequest = z.infer<typeof ContactBulkRequestSchema>;

export const ContactBulkFailureSchema = z.object({
  id: z.string().uuid(),
  /** Kode alasan ringkas — saat ini hanya "not_found" (id bukan milik tenant). */
  reason: z.string(),
});
export type ContactBulkFailure = z.infer<typeof ContactBulkFailureSchema>;

export const ContactBulkResponseSchema = z.object({
  action: z.enum(["add_tag", "remove_tag", "set_stage", "opt_out", "delete"]),
  succeeded: z.number().int().nonnegative(),
  failed: z.array(ContactBulkFailureSchema),
});
export type ContactBulkResponse = z.infer<typeof ContactBulkResponseSchema>;

// ---------------------------------------------------------------------------
// Impor CSV kontak (daftar utama /contacts)
// ---------------------------------------------------------------------------

/**
 * Body POST /contacts/import — isi berkas CSV sebagai teks utuh
 * (klien membaca berkas lokal lalu mengirim teksnya; server yang
 * mem-parsing agar normalisasi + deteksi duplikat memakai mesin yang
 * sama persis dengan jalur lain). Batas 5 jt karakter menjaga satu
 * panggilan tetap wajar untuk skala workspace produk ini.
 */
export const ContactImportRequestSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
});
export type ContactImportRequest = z.infer<typeof ContactImportRequestSchema>;

/** Satu baris impor yang tidak menjadi kontak, beserta alasannya. */
export const ContactImportIssueSchema = z.object({
  /** Nomor baris DATA (1 = baris data pertama; baris judul tidak dihitung). */
  row: z.number().int().positive(),
  /** Kode alasan: duplicate_phone | duplicate_email | missing_name | invalid_email | invalid_row | … */
  reason: z.string(),
});
export type ContactImportIssue = z.infer<typeof ContactImportIssueSchema>;

export const ContactImportResponseSchema = z.object({
  /** Jumlah kontak yang benar-benar dibuat. */
  imported: z.number().int().nonnegative(),
  /** Baris yang dilewati karena duplikat (kontak lama atau sesama berkas). */
  duplicates: z.array(ContactImportIssueSchema),
  /** Baris yang ditolak karena tidak sah. */
  invalid: z.array(ContactImportIssueSchema),
});
export type ContactImportResponse = z.infer<typeof ContactImportResponseSchema>;

// ---------------------------------------------------------------------------
// Catatan level kontak (Gelombang G8)
// ---------------------------------------------------------------------------

/**
 * Catatan internal yang menempel pada KONTAK (bukan percakapan) —
 * saudara `ConversationNoteResponse` dengan subjek berbeda. Keduanya
 * SENGAJA kontrak yang terpisah dan tidak pernah dicampur dalam satu
 * daftar: catatan kontak adalah ingatan tim tentang ORANGNYA (lintas
 * percakapan & kanal); catatan percakapan hidup di Inbox per utas.
 * `authorName` adalah label tampil penulis (nama, jatuh ke email);
 * null bila penulis sudah terhapus (UI memakai label cadangan).
 */
export const ContactNoteResponseSchema = z.object({
  id: z.string().uuid(),
  contactId: z.string().uuid(),
  authorUserId: z.string().uuid().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ContactNoteResponse = z.infer<typeof ContactNoteResponseSchema>;

export const ContactNoteListResponseSchema = z.object({
  notes: z.array(ContactNoteResponseSchema),
});
export type ContactNoteListResponse = z.infer<
  typeof ContactNoteListResponseSchema
>;

export const CreateContactNoteRequestSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});
export type CreateContactNoteRequest = z.infer<
  typeof CreateContactNoteRequestSchema
>;

// ---------------------------------------------------------------------------
// Linimasa aktivitas kontak (Gelombang G8)
// ---------------------------------------------------------------------------

/**
 * Jenis peristiwa linimasa kontak. Linimasa adalah PERAKITAN BACA-SAJA
 * dari data yang memang sudah tercatat (baris kontak, pesan, audit
 * log, enrollment sequence) — jenis yang sumbernya tidak tercatat
 * TIDAK PERNAH dikarang masuk daftar ini. Cakupan jujur saat ini:
 * - contact_created      baris kontak dibuat (+ sumber perolehannya).
 * - first_message        pesan paling awal di percakapan mana pun.
 * - last_message         pesan paling akhir (hanya bila berbeda dari
 *                        pesan pertama).
 * - opt_in_changed       status opt-in efektif berubah (audit
 *                        contact.opt_in_changed: from/to/source).
 * - merged_in            kontak lain dilebur KE kontak ini (audit
 *                        contact.merged; sisi korban tidak tampil —
 *                        kontak korban terhapus oleh merge).
 * - sequence_enrolled    kontak didaftarkan ke sebuah sequence.
 * - sequence_completed   enrollment selesai (audit sequence.completed).
 * - sequence_cancelled   enrollment dibatalkan (balasan kontak /
 *                        opt-out; audit sequence.cancelled_*).
 * - handoff              AI menyerahkan percakapan ke manusia (audit
 *                        agent.handoff).
 * - contact_note_added   catatan KONTAK ditambahkan (audit
 *                        contact.note_created).
 * - conversation_note_added  catatan PERCAKAPAN pada salah satu
 *                        percakapan kontak ditambahkan (audit
 *                        conversation.note_created) — jenis terpisah
 *                        agar dua keluarga catatan tidak tercampur.
 * Perubahan tahap pipeline & tag TIDAK termasuk: keduanya tidak
 * dicatat sebagai riwayat di mana pun (hanya nilai kini di baris
 * kontak), jadi menampilkannya berarti mengarang waktu perubahan.
 */
export const ContactTimelineEventKindSchema = z.enum([
  "contact_created",
  "first_message",
  "last_message",
  "opt_in_changed",
  "merged_in",
  "sequence_enrolled",
  "sequence_completed",
  "sequence_cancelled",
  "handoff",
  "contact_note_added",
  "conversation_note_added",
]);
export type ContactTimelineEventKind = z.infer<
  typeof ContactTimelineEventKindSchema
>;

/**
 * Satu peristiwa linimasa. `detail` adalah peta datar nilai primitif
 * yang isinya bergantung `kind` (kunci terdokumentasi per jenis di
 * core/contact-timeline.ts); UI merender label jenis dari i18n dan
 * membaca detail yang ia kenal — detail tak dikenal diabaikan, bukan
 * membuat peristiwa gugur.
 */
export const ContactTimelineEventSchema = z.object({
  kind: ContactTimelineEventKindSchema,
  occurredAt: z.string().datetime(),
  detail: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});
export type ContactTimelineEvent = z.infer<typeof ContactTimelineEventSchema>;

export const ContactTimelineResponseSchema = z.object({
  /** Peristiwa terurut terbaru → terlama. */
  events: z.array(ContactTimelineEventSchema),
  /** true bila ada peristiwa yang tidak ikut terkirim karena batas. */
  truncated: z.boolean(),
});
export type ContactTimelineResponse = z.infer<
  typeof ContactTimelineResponseSchema
>;
