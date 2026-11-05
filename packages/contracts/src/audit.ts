import { z } from "zod";

// ---------------------------------------------------------------------------
// Penelusur log audit (Fase 7B.4) — pembacaan `audit_logs` (read-only)
// ---------------------------------------------------------------------------

/**
 * Jenis pelaku audit — persis enum DB `audit_actor_type` dan nilai yang
 * benar-benar ditulis penulis audit di core: `user` (operator dashboard
 * & admin platform), `agent` (runtime agent AI, termasuk tool-nya),
 * `system` (komponen: poller/webhook/purge/halaman bayar), `api_key`
 * (API publik /v1 — saat ini hanya `message.queued`).
 */
export const AuditActorTypeSchema = z.enum([
  "user",
  "agent",
  "system",
  "api_key",
]);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

/**
 * Kategori audit = awalan `action` sebelum titik pertama, dari taksonomi
 * NYATA penulis audit di core (tenant.*, channel.*, message.*,
 * automation.*, sequence.*, agent.*, contact.* — dua aksi tool agent,
 * payment_link.*, payment.*, api_key.*, telegram.*, integration.*,
 * platform_settings.*). Dipakai sebagai filter daftar.
 */
export const AuditCategorySchema = z.enum([
  "tenant",
  "channel",
  "message",
  "automation",
  "sequence",
  "agent",
  "contact",
  "payment_link",
  "payment",
  "api_key",
  "telegram",
  "integration",
  "platform_settings",
  "broadcast",
  "whatsapp_template",
  "flow",
  "kb_document",
]);
export type AuditCategory = z.infer<typeof AuditCategorySchema>;

/** Target ringkas satu baris audit, diturunkan server dari meta. */
export const AuditLogTargetSchema = z.object({
  /** Jenis entitas, mis. `channel_account`, `message`, `api_key`. */
  type: z.string(),
  /** Id entitas (uuid) atau pengenal stabil lain (mis. nama kunci panel). */
  id: z.string(),
});
export type AuditLogTarget = z.infer<typeof AuditLogTargetSchema>;

/**
 * Satu baris audit sebagaimana tampil di penelusur. Berbeda dari log
 * integrasi (payload ±32KB → endpoint detail terpisah), `meta` audit
 * kecil (id referensi + fakta berkode) sehingga ikut di respons daftar
 * dan baris UI dapat diperluas tanpa panggilan kedua. `actorLabel`
 * adalah resolusi server sebisa mungkin: user → nama/email; api_key →
 * nama kunci + prefix; agent → nama agent; system → nama komponen
 * (actorId itu sendiri). Null bila pelaku tak lagi dapat di-resolve
 * (mis. agent sudah dihapus) — UI jatuh ke actorId mentah.
 */
export const AuditLogResponseSchema = z.object({
  id: z.string().uuid(),
  /** Null = baris tingkat platform (hanya pandangan admin platform). */
  tenantId: z.string().uuid().nullable(),
  actorType: AuditActorTypeSchema,
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  action: z.string(),
  category: z.string(),
  target: AuditLogTargetSchema.nullable(),
  meta: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>;

export const AuditLogListResponseSchema = z.object({
  entries: z.array(AuditLogResponseSchema),
  /** Kursor opaque halaman berikutnya; null = habis. */
  nextCursor: z.string().nullable(),
});
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;

/**
 * Query penelusur audit: filter actor/kategori/rentang tanggal +
 * pencarian teks bebas pada kolom `action` (substring, wildcard LIKE
 * di-escape server) + paginasi kursor (pola log integrasi).
 */
export const AuditLogListQuerySchema = z.object({
  actorType: AuditActorTypeSchema.optional(),
  category: AuditCategorySchema.optional(),
  q: z.string().min(1).max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type AuditLogListQuery = z.infer<typeof AuditLogListQuerySchema>;
