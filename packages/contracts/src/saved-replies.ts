import { z } from "zod";

// ---------------------------------------------------------------------------
// Fase 9A — Saved Replies (macro `/` di composer Inbox)
// ---------------------------------------------------------------------------

/**
 * Satu balasan tersimpan milik workspace. `body` boleh memuat {name};
 * substitusinya dilakukan klien saat penyisipan ke composer (WYSIWYG).
 * `createdByUserId` adalah dasar gerbang edit/hapus di server: hanya
 * pembuat atau owner/admin workspace yang boleh mengubah/menghapus;
 * membaca & membuat boleh semua member.
 */
export const SavedReplyResponseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SavedReplyResponse = z.infer<typeof SavedReplyResponseSchema>;

export const SavedReplyListResponseSchema = z.object({
  replies: z.array(SavedReplyResponseSchema),
});
export type SavedReplyListResponse = z.infer<
  typeof SavedReplyListResponseSchema
>;

export const CreateSavedReplyRequestSchema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(4096),
});
export type CreateSavedReplyRequest = z.infer<
  typeof CreateSavedReplyRequestSchema
>;

/** Edit parsial: minimal satu field (ditegakkan di route). */
export const UpdateSavedReplyRequestSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  body: z.string().min(1).max(4096).optional(),
});
export type UpdateSavedReplyRequest = z.infer<
  typeof UpdateSavedReplyRequestSchema
>;
