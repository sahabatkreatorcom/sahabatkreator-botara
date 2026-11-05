import { z } from "zod";

// ---------------------------------------------------------------------------
// Realtime (Fase 6G) — event "nudge" yang diterbitkan ke Redis pub/sub dan
// diteruskan apps/realtime ke klien WebSocket (dashboard & widget webchat).
//
// Event ini SENGAJA bukan muatan data: ia hanya berkata "ada perubahan di
// tenant/percakapan ini" — klien lalu memuat ulang lewat REST yang sudah
// ada (sumber kebenaran tetap REST + RLS + autentikasi per request). Ini
// menghindari duplikasi otorisasi & serialisasi muatan di jalur socket.
// ---------------------------------------------------------------------------

export const RealtimeNudgeKindSchema = z.enum([
  /** Pesan masuk baru tercatat (webchat/telegram, termasuk postingan channel). */
  "message.received",
  /** Pesan outbound baru dibuat & berstatus `queued` (manual/automation/agent/sequence/saran disetujui). */
  "message.queued",
  /** Pesan outbound berubah status menjadi `sent`. */
  "message.sent",
  /** Pesan outbound berubah status menjadi `failed`. */
  "message.failed",
  /** Draf saran agent baru menunggu persetujuan (mode suggest). */
  "agent.suggestion",
  /** Perubahan percakapan lain yang tak tertampung jenis di atas. */
  "conversation.updated",
]);
export type RealtimeNudgeKind = z.infer<typeof RealtimeNudgeKindSchema>;

export const RealtimeNudgeSchema = z.object({
  type: z.literal("nudge"),
  kind: RealtimeNudgeKindSchema,
  tenantId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  /** Cap waktu penerbitan (ISO) — diagnostik latensi, bukan otoritas urutan. */
  at: z.string().datetime(),
});
export type RealtimeNudge = z.infer<typeof RealtimeNudgeSchema>;

/** Bentuk yang diberikan penerbit: `type` & `at` diisi helper penerbit. */
export type RealtimeNudgeInput = Omit<RealtimeNudge, "type" | "at">;
