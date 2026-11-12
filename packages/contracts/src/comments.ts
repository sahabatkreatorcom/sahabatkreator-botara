import { z } from "zod";

// ---------------------------------------------------------------------------
// Comments (Fase 10B; G7 menambah Threads) — komentar publik
// Instagram/Messenger + balasan Threads yang tercatat dari webhook,
// beserta jejak aksi aturan comment-to-DM/moderasi. Daftar bersifat
// baca-saja dari sisi API; satu-satunya tulis adalah moderasi manual
// sembunyikan/tampilkan (POST .../hide | .../unhide). Jejak DM untuk
// Threads selalu `skipped` dengan reason `threads_dm_not_supported`
// (API Threads tidak punya DM).
// ---------------------------------------------------------------------------

export const CommentModerationStatusSchema = z.enum(["visible", "hidden"]);
export type CommentModerationStatus = z.infer<
  typeof CommentModerationStatusSchema
>;

/** Jejak hasil satu aksi pada sebuah komentar (comments.actions di DB). */
export const CommentActionTraceSchema = z.object({
  dm: z
    .object({
      status: z.enum(["queued", "skipped", "failed"]),
      messageId: z.string().uuid().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  publicReply: z
    .object({
      status: z.enum(["sent", "failed"]),
      replyId: z.string().nullable().optional(),
      errorCode: z.string().optional(),
    })
    .optional(),
  hide: z
    .object({
      status: z.enum(["hidden", "failed"]),
      errorCode: z.string().optional(),
    })
    .optional(),
  skipped: z.literal("own_comment").optional(),
  evaluatedAt: z.string().optional(),
});
export type CommentActionTrace = z.infer<typeof CommentActionTraceSchema>;

export const CommentResponseSchema = z.object({
  id: z.string().uuid(),
  channelAccountId: z.string().uuid(),
  /** Nama tampilan akun pemilik komentar (untuk label daftar). */
  channelDisplayName: z.string(),
  provider: z.enum(["instagram", "messenger", "threads"]),
  providerCommentId: z.string(),
  mediaId: z.string().nullable(),
  postId: z.string().nullable(),
  parentId: z.string().nullable(),
  authorExternalId: z.string(),
  authorUsername: z.string().nullable(),
  text: z.string(),
  providerCreatedAt: z.string().datetime().nullable(),
  moderationStatus: CommentModerationStatusSchema,
  contactId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  matchedAutomationId: z.string().uuid().nullable(),
  actions: CommentActionTraceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CommentResponse = z.infer<typeof CommentResponseSchema>;

export const CommentListResponseSchema = z.object({
  comments: z.array(CommentResponseSchema),
});
export type CommentListResponse = z.infer<typeof CommentListResponseSchema>;
