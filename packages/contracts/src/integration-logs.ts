import { z } from "zod";

import { IntegrationLogOutcomeSchema } from "./channels";

// ---------------------------------------------------------------------------
// Log integrasi webhook & pengiriman (Fase 7B.1)
// ---------------------------------------------------------------------------

export const IntegrationLogDirectionSchema = z.enum(["in", "out"]);
export type IntegrationLogDirection = z.infer<
  typeof IntegrationLogDirectionSchema
>;

/**
 * Provider pada baris log. `meta` = hit webhook Meta SEBELUM ter-rute ke
 * provider konkret (tanda tangan buruk / belum terkonfigurasi / akun tak
 * dikenal di gerbang bersama). `webchat` dicadangkan (flush webchat bukan
 * percobaan API provider dan tidak dicatat di v1).
 */
export const IntegrationLogProviderSchema = z.enum([
  "telegram",
  "messenger",
  "instagram",
  "whatsapp",
  "webchat",
  "meta",
]);
export type IntegrationLogProvider = z.infer<
  typeof IntegrationLogProviderSchema
>;

/**
 * Outcome terkendali — union arah masuk & keluar (kolom `outcome`).
 * Skemanya sendiri didefinisikan di seksi channel di atas (dipakai juga
 * oleh `ChannelHealthSchema`, Fase 7B.3).
 */

/**
 * Satu baris log integrasi sebagaimana tampil di daftar (TANPA payload —
 * payload hanya di endpoint detail; payload memuat isi pesan pelanggan
 * dan endpoint-nya owner/admin saja). `hasPayload` memberi tahu UI
 * apakah detail punya payload untuk ditampilkan.
 */
export const IntegrationLogResponseSchema = z.object({
  id: z.string().uuid(),
  direction: IntegrationLogDirectionSchema,
  provider: z.string(),
  tenantId: z.string().uuid().nullable(),
  channelAccountId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  /** Hanya arah 'in'; null = tidak berlaku/belum bisa dinilai. */
  signatureValid: z.boolean().nullable(),
  outcome: IntegrationLogOutcomeSchema,
  errorCode: z.string().nullable(),
  summary: z.string().nullable(),
  hasPayload: z.boolean(),
  createdAt: z.string().datetime(),
});
export type IntegrationLogResponse = z.infer<
  typeof IntegrationLogResponseSchema
>;

/** Detail satu baris log: daftar + payload tersimpan (sudah dibatasi ±32KB di server). */
export const IntegrationLogDetailResponseSchema =
  IntegrationLogResponseSchema.extend({
    payload: z.unknown().nullable(),
  });
export type IntegrationLogDetailResponse = z.infer<
  typeof IntegrationLogDetailResponseSchema
>;

export const IntegrationLogListResponseSchema = z.object({
  logs: z.array(IntegrationLogResponseSchema),
  /** Kursor opaque halaman berikutnya; null = habis. */
  nextCursor: z.string().nullable(),
});
export type IntegrationLogListResponse = z.infer<
  typeof IntegrationLogListResponseSchema
>;

/** Query daftar log: filter + paginasi kursor (bukan offset). */
export const IntegrationLogListQuerySchema = z.object({
  provider: IntegrationLogProviderSchema.optional(),
  direction: IntegrationLogDirectionSchema.optional(),
  outcome: IntegrationLogOutcomeSchema.optional(),
  channelAccountId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type IntegrationLogListQuery = z.infer<
  typeof IntegrationLogListQuerySchema
>;

// ---------------------------------------------------------------------------
// Penanganan kegagalan (Fase 7B.2): replay webhook & pusat pesan gagal
// ---------------------------------------------------------------------------

/**
 * Respons POST /tenants/:tenantId/logs/:logId/replay — proses ulang SATU
 * baris log arah masuk yang eligible (signature_valid=true, payload
 * lengkap, outcome `error`/`ignored_disconnected`) lewat jalur pemrosesan
 * webhook yang sama. `outcomes` = outcome baris-baris log BARU yang
 * ditulis replay ini, berurutan (payload multi-event bisa menghasilkan
 * lebih dari satu). Baris sumber tidak pernah diubah (append-only).
 */
export const IntegrationLogReplayResponseSchema = z.object({
  replayed: z.literal(true),
  sourceLogId: z.string().uuid(),
  outcomes: z.array(IntegrationLogOutcomeSchema),
});
export type IntegrationLogReplayResponse = z.infer<
  typeof IntegrationLogReplayResponseSchema
>;

/** Provider yang dapat memiliki pesan keluar `failed` (poller telegram/meta). */
export const FailedMessageProviderSchema = z.enum([
  "telegram",
  "messenger",
  "instagram",
  "whatsapp",
]);
export type FailedMessageProvider = z.infer<typeof FailedMessageProviderSchema>;

/**
 * Satu pesan keluar berstatus `failed` pada pusat pesan gagal.
 * `contentPreview` dipotong server (±280 char) — isi penuh tetap ada di
 * utas inbox; endpoint ini owner/admin saja seperti log integrasi.
 */
export const FailedMessageResponseSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  provider: z.string(),
  channelAccountId: z.string().uuid(),
  /** Nama tampil akun channel; null bila akun sudah tidak ada. */
  channelDisplayName: z.string().nullable(),
  contactId: z.string().uuid(),
  /** Nama kontak percakapan; null bila kontak sudah tidak ada. */
  contactName: z.string().nullable(),
  contentPreview: z.string().nullable(),
  /** Kode kegagalan terakhir (kolom messages.error_code), mis. `meta_graph_131047`. */
  errorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type FailedMessageResponse = z.infer<typeof FailedMessageResponseSchema>;

export const FailedMessageListResponseSchema = z.object({
  messages: z.array(FailedMessageResponseSchema),
  /** Kursor opaque halaman berikutnya; null = habis. */
  nextCursor: z.string().nullable(),
});
export type FailedMessageListResponse = z.infer<
  typeof FailedMessageListResponseSchema
>;

/** Query pusat pesan gagal: filter provider + paginasi kursor. */
export const FailedMessageListQuerySchema = z.object({
  provider: FailedMessageProviderSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type FailedMessageListQuery = z.infer<typeof FailedMessageListQuerySchema>;

/**
 * Respons POST /tenants/:tenantId/failed-messages/:messageId/retry —
 * pesan berhasil diantrekan ulang (`failed` → `queued`); terkirim atau
 * tidaknya dibuktikan percobaan poller berikutnya, bukan respons ini.
 */
export const FailedMessageRetryResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal("queued"),
});
export type FailedMessageRetryResponse = z.infer<
  typeof FailedMessageRetryResponseSchema
>;
