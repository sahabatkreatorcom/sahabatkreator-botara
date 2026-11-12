import { z } from "zod";

// ---------------------------------------------------------------------------
// Automations (Fase 2A; diperluas Fase 2C) — trigger keyword.
// Konfigurasi di DB disimpan sebagai trigger_config {keywords, match} dan
// action_config {text}; kontrak API menampilkannya sebagai field datar.
// Dua jenis (kolom kind di DB):
//   'keyword'  — pesan cocok → satu balasan langsung (perilaku Fase 2A).
//   'sequence' — pesan cocok → kontak didaftarkan ke rangkaian langkah
//                automation_steps yang dikirim berjeda (Fase 2C).
// Request buat BARU memakai union: tanpa field `kind` (atau kind='keyword')
// berarti jalur keyword lama — kompatibilitas mundur penuh.
// ---------------------------------------------------------------------------

export const AutomationMatchSchema = z.enum(["exact", "contains"]);
export type AutomationMatch = z.infer<typeof AutomationMatchSchema>;

/**
 * Jenis pemicu automation (kolom trigger_type di DB):
 * - 'keyword'     : teks pesan cocok dengan keywords (Fase 2A/2C).
 * - 'comment'     : teks komentar publik di satu akun (Fase 10B).
 * - 'postback'    : ketukan tombol postback (Meta) / callback_query
 *                   (Telegram) — payload dicocokkan PERSIS (G5).
 * - 'quick_reply' : ketukan quick reply yang membawa payload (Meta
 *                   quick reply, balasan tombol/list WhatsApp) (G5).
 * - 'welcome'     : pesan MASUK PERTAMA seorang kontak (G5).
 * Kolom `kind` tetap keluarga AKSI ('keyword' balasan langsung,
 * 'sequence' pendaftaran rangkaian, 'comment' aturan komentar) —
 * pemicu dan aksi ortogonal sejak G5.
 */
export const AutomationTriggerTypeSchema = z.enum([
  "keyword",
  "comment",
  "postback",
  "quick_reply",
  "welcome",
]);
export type AutomationTriggerType = z.infer<
  typeof AutomationTriggerTypeSchema
>;

/** Payload tombol untuk pemicu postback/quick_reply: 1–10 string mesin. */
const AutomationPayloadsSchema = z
  .array(z.string().trim().min(1).max(255))
  .min(1)
  .max(10);

export const AutomationKindSchema = z.enum([
  "keyword",
  "sequence",
  // Fase 10B: aturan komentar (comment-to-DM + moderasi).
  "comment",
]);
export type AutomationKind = z.infer<typeof AutomationKindSchema>;

const AutomationKeywordsSchema = z
  .array(z.string().trim().min(1).max(255))
  .min(1)
  .max(10);

const AutomationNameSchema = z.string().trim().min(1).max(255);

/** Satu langkah rangkaian sequence (Fase 2C). */
export const AutomationStepInputSchema = z.object({
  /** Jeda (menit) sebelum langkah ini, relatif terhadap langkah sebelumnya. */
  delayMinutes: z.number().int().min(0).max(43_200),
  /** Isi pesan langkah; mendukung placeholder {name} = nama kontak. */
  text: z.string().trim().min(1).max(4096),
});
export type AutomationStepInput = z.infer<typeof AutomationStepInputSchema>;

export const AutomationStepResponseSchema = AutomationStepInputSchema.extend({
  position: z.number().int().positive(),
});
export type AutomationStepResponse = z.infer<
  typeof AutomationStepResponseSchema
>;

export const CreateKeywordAutomationRequestSchema = z.object({
  kind: z.literal("keyword").optional(),
  name: AutomationNameSchema,
  keywords: AutomationKeywordsSchema,
  match: AutomationMatchSchema.default("exact"),
  /** Isi balasan otomatis; mendukung placeholder {name} = nama kontak. */
  text: z.string().trim().min(1).max(4096),
});
export type CreateKeywordAutomationRequest = z.infer<
  typeof CreateKeywordAutomationRequestSchema
>;

export const CreateSequenceAutomationRequestSchema = z.object({
  kind: z.literal("sequence"),
  name: AutomationNameSchema,
  keywords: AutomationKeywordsSchema,
  match: AutomationMatchSchema.default("exact"),
  /** 1–10 langkah; posisi ditentukan urutan array (mulai dari 1). */
  steps: z.array(AutomationStepInputSchema).min(1).max(10),
});
export type CreateSequenceAutomationRequest = z.infer<
  typeof CreateSequenceAutomationRequestSchema
>;

/**
 * Aturan komentar (Fase 10B): pemicu keyword yang sama, tetapi diterapkan
 * pada TEKS KOMENTAR publik di SATU akun Instagram/Messenger
 * (channelAccountId). Aksi dapat dikombinasikan (minimal satu aktif):
 * - sendDm: DM privat ke penulis komentar (private reply); teksnya
 *   `dmText` — wajib terisi bila sendDm true.
 * - publicReplyText: balasan publik pada komentar; null/kosong = mati.
 * - hideComment: sembunyikan komentar (mode moderasi murni =
 *   sendDm false + publicReplyText kosong + hideComment true).
 */
export const CreateCommentAutomationRequestSchema = z
  .object({
    kind: z.literal("comment"),
    name: AutomationNameSchema,
    keywords: AutomationKeywordsSchema,
    match: AutomationMatchSchema.default("exact"),
    channelAccountId: z.string().uuid(),
    sendDm: z.boolean().default(false),
    dmText: z.string().trim().max(4096).optional(),
    publicReplyText: z.string().trim().max(4096).nullable().optional(),
    hideComment: z.boolean().default(false),
  })
  .refine((v) => !v.sendDm || (v.dmText && v.dmText.length > 0), {
    message: "dmText is required when sendDm is true",
    path: ["dmText"],
  })
  .refine(
    (v) =>
      v.sendDm ||
      (v.publicReplyText != null && v.publicReplyText.length > 0) ||
      v.hideComment,
    { message: "At least one comment action must be enabled" },
  );
export type CreateCommentAutomationRequest = z.infer<
  typeof CreateCommentAutomationRequestSchema
>;

/**
 * Aturan pemicu SINYAL (G5): ketukan tombol postback / quick reply.
 * `payloads` dicocokkan PERSIS (case-sensitive) ke payload yang dibawa
 * pesan (messages.trigger_signal). Aksi mengikuti `kind`:
 * 'keyword' = balasan langsung (`text` wajib), 'sequence' =
 * pendaftaran rangkaian (`steps` wajib). Tanpa keywords/match —
 * payload adalah string mesin, bukan teks manusia.
 */
export const CreateSignalAutomationRequestSchema = z
  .object({
    triggerType: z.enum(["postback", "quick_reply"]),
    kind: z.enum(["keyword", "sequence"]).default("keyword"),
    name: AutomationNameSchema,
    payloads: AutomationPayloadsSchema,
    /** Wajib bila kind='keyword': isi balasan langsung. */
    text: z.string().trim().min(1).max(4096).optional(),
    /** Wajib bila kind='sequence': 1–10 langkah rangkaian. */
    steps: z.array(AutomationStepInputSchema).min(1).max(10).optional(),
  })
  .refine((v) => (v.kind === "keyword" ? !!v.text : !!v.steps), {
    message: "text is required for kind='keyword'; steps for kind='sequence'",
  });
export type CreateSignalAutomationRequest = z.infer<
  typeof CreateSignalAutomationRequestSchema
>;

/**
 * Aturan WELCOME (G5): menyala untuk PESAN MASUK PERTAMA seorang
 * kontak — sekali per kontak per aturan (riwayat run adalah
 * penjaganya). Tanpa syarat pencocokan tambahan; aksi mengikuti
 * `kind` seperti aturan sinyal.
 */
export const CreateWelcomeAutomationRequestSchema = z
  .object({
    triggerType: z.literal("welcome"),
    kind: z.enum(["keyword", "sequence"]).default("keyword"),
    name: AutomationNameSchema,
    /** Wajib bila kind='keyword': isi balasan sambutan. */
    text: z.string().trim().min(1).max(4096).optional(),
    /** Wajib bila kind='sequence': 1–10 langkah rangkaian. */
    steps: z.array(AutomationStepInputSchema).min(1).max(10).optional(),
  })
  .refine((v) => (v.kind === "keyword" ? !!v.text : !!v.steps), {
    message: "text is required for kind='keyword'; steps for kind='sequence'",
  });
export type CreateWelcomeAutomationRequest = z.infer<
  typeof CreateWelcomeAutomationRequestSchema
>;

export const CreateAutomationRequestSchema = z.union([
  CreateKeywordAutomationRequestSchema,
  CreateSequenceAutomationRequestSchema,
  CreateCommentAutomationRequestSchema,
  CreateSignalAutomationRequestSchema,
  CreateWelcomeAutomationRequestSchema,
]);
export type CreateAutomationRequest = z.infer<
  typeof CreateAutomationRequestSchema
>;

export const UpdateAutomationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    keywords: AutomationKeywordsSchema.optional(),
    /** G5 — hanya bermakna untuk aturan triggerType postback/quick_reply. */
    payloads: AutomationPayloadsSchema.optional(),
    match: AutomationMatchSchema.optional(),
    text: z.string().trim().min(1).max(4096).optional(),
    isActive: z.boolean().optional(),
    /** Fase 10B — hanya bermakna untuk aturan kind='comment'. */
    sendDm: z.boolean().optional(),
    publicReplyText: z.string().trim().max(4096).nullable().optional(),
    hideComment: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateAutomationRequest = z.infer<
  typeof UpdateAutomationRequestSchema
>;

export const AutomationResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  triggerType: AutomationTriggerTypeSchema,
  /** Jenis automation (Fase 2C): 'keyword' (balasan langsung) | 'sequence' | 'comment' (Fase 10B). */
  kind: AutomationKindSchema,
  keywords: z.array(z.string()),
  /** G5: payload tombol untuk triggerType postback/quick_reply; kosong untuk pemicu lain. */
  payloads: z.array(z.string()),
  match: AutomationMatchSchema,
  actionType: z.literal("send_message"),
  /** Isi balasan untuk kind='keyword'; untuk sequence selalu string kosong. */
  text: z.string(),
  /**
   * Fase 10B — akun terikat aturan komentar (uuid channel_accounts);
   * null untuk aturan pesan. Field komentar lain hanya bermakna untuk
   * kind='comment' dan selalu terisi default aman untuk aturan lama.
   */
  channelAccountId: z.string().uuid().nullable(),
  /** Fase 10B: aksi DM privat aktif (teks DM-nya ada di `text`). */
  sendDm: z.boolean(),
  /** Fase 10B: teks balasan publik; null = aksi mati. */
  publicReplyText: z.string().nullable(),
  /** Fase 10B: aksi sembunyikan komentar aktif. */
  hideComment: z.boolean(),
  /** Langkah rangkaian terurut posisi; kosong untuk kind='keyword'. */
  steps: z.array(AutomationStepResponseSchema),
  /** Jumlah langkah (Fase 2C); 0 untuk kind='keyword'. */
  stepCount: z.number().int().nonnegative(),
  isActive: z.boolean(),
  /** Jumlah baris automation_runs milik automation ini. */
  runCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutomationResponse = z.infer<typeof AutomationResponseSchema>;

export const AutomationListResponseSchema = z.object({
  automations: z.array(AutomationResponseSchema),
});
export type AutomationListResponse = z.infer<
  typeof AutomationListResponseSchema
>;

export const AutomationRunStatusSchema = z.enum([
  "completed",
  "failed",
  "skipped",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationRunResponseSchema = z.object({
  id: z.string().uuid(),
  automationId: z.string().uuid(),
  contactId: z.string().uuid(),
  conversationId: z.string().uuid(),
  triggerMessageId: z.string().uuid().nullable(),
  status: AutomationRunStatusSchema,
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type AutomationRunResponse = z.infer<typeof AutomationRunResponseSchema>;

export const AutomationRunListResponseSchema = z.object({
  runs: z.array(AutomationRunResponseSchema),
});
export type AutomationRunListResponse = z.infer<
  typeof AutomationRunListResponseSchema
>;

// ---------------------------------------------------------------------------
// Sequence enrollments (Fase 2C) — pendaftaran kontak ke rangkaian pesan.
// ---------------------------------------------------------------------------

export const SequenceEnrollmentStatusSchema = z.enum([
  "active",
  "completed",
  "cancelled",
]);
export type SequenceEnrollmentStatus = z.infer<
  typeof SequenceEnrollmentStatusSchema
>;

export const SequenceEnrollmentResponseSchema = z.object({
  id: z.string().uuid(),
  automationId: z.string().uuid(),
  contactId: z.string().uuid(),
  conversationId: z.string().uuid(),
  triggerMessageId: z.string().uuid().nullable(),
  status: SequenceEnrollmentStatusSchema,
  /** Berapa langkah yang SUDAH terkirim (0 = belum ada). */
  currentStep: z.number().int().nonnegative(),
  /** Total langkah pada automation (untuk tampilan "langkah X dari Y"). */
  totalSteps: z.number().int().nonnegative(),
  /** Jadwal pengiriman langkah berikutnya; null bila tidak lagi aktif. */
  nextRunAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SequenceEnrollmentResponse = z.infer<
  typeof SequenceEnrollmentResponseSchema
>;

export const SequenceEnrollmentListResponseSchema = z.object({
  enrollments: z.array(SequenceEnrollmentResponseSchema),
});
export type SequenceEnrollmentListResponse = z.infer<
  typeof SequenceEnrollmentListResponseSchema
>;

// ---------------------------------------------------------------------------
// Pendaftaran sequence MANUAL (G2b) — daftarkan kontak / semua kontak
// bertag ke sequence aktif dari dashboard, tanpa menunggu kata kunci.
// Enrollment manual berjangkar ke PERCAKAPAN PESAN (kind 'private' /
// 'group') milik kontak: `conversationId` boleh dipilih eksplisit;
// kosong = percakapan pesan terbaru kontak. Kontak tanpa percakapan
// pesan tidak bisa didaftarkan (ENROLL_NO_CONVERSATION) — TIDAK ada
// enrollment yang lahir mengambang tanpa percakapan.
// ---------------------------------------------------------------------------

export const EnrollSequenceContactRequestSchema = z.object({
  contactId: z.string().uuid(),
  /** Jangkar eksplisit; harus percakapan pesan milik kontak ini. */
  conversationId: z.string().uuid().optional(),
});
export type EnrollSequenceContactRequest = z.infer<
  typeof EnrollSequenceContactRequestSchema
>;

export const EnrollSequenceByTagRequestSchema = z.object({
  tag: z.string().trim().min(1).max(128),
});
export type EnrollSequenceByTagRequest = z.infer<
  typeof EnrollSequenceByTagRequestSchema
>;

/**
 * Hasil pendaftaran satu kontak. Penolakan BUKAN di sini: sebab
 * penolakan (tanpa percakapan, opt-out, sequence tak tersedia, …)
 * berjalan sebagai error berkode (lihat ErrorCodeSchema) supaya UI
 * menerjemahkan sebabnya, bukan menebak dari status.
 */
export const EnrollSequenceContactResponseSchema = z.object({
  outcome: z.enum(["enrolled", "already_enrolled"]),
  enrollment: SequenceEnrollmentResponseSchema,
});
export type EnrollSequenceContactResponse = z.infer<
  typeof EnrollSequenceContactResponseSchema
>;

/**
 * Laporan pendaftaran per tag: berapa kontak cocok, berapa benar-benar
 * terdaftar baru, berapa sudah terdaftar sebelumnya, dan berapa
 * dilewati — diagregat per alasan (kontak yang dilewati tidak disebut
 * satu per satu; daftar enrollment adalah sumber kebenaran per kontak).
 */
export const EnrollSequenceByTagResponseSchema = z.object({
  tag: z.string(),
  /** Total kontak tenant yang memuat tag ini. */
  matched: z.number().int().nonnegative(),
  enrolled: z.number().int().nonnegative(),
  alreadyEnrolled: z.number().int().nonnegative(),
  skippedTotal: z.number().int().nonnegative(),
  skippedByReason: z.object({
    noConversation: z.number().int().nonnegative(),
    contactOptedOut: z.number().int().nonnegative(),
  }),
  /** true bila `matched` melebihi batas pemrosesan per panggilan. */
  capped: z.boolean(),
});
export type EnrollSequenceByTagResponse = z.infer<
  typeof EnrollSequenceByTagResponseSchema
>;

/** Satu percakapan pesan kandidat jangkar enrollment manual. */
export const EnrollConversationResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["private", "group"]),
  provider: z.string(),
  /** Judul grup di provider; null untuk percakapan privat. */
  title: z.string().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type EnrollConversationResponse = z.infer<
  typeof EnrollConversationResponseSchema
>;

export const EnrollConversationListResponseSchema = z.object({
  conversations: z.array(EnrollConversationResponseSchema),
});
export type EnrollConversationListResponse = z.infer<
  typeof EnrollConversationListResponseSchema
>;
