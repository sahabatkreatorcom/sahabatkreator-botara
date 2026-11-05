import { z } from "zod";

// ---------------------------------------------------------------------------
// AI Agents (Fase 3A) — konfigurasi agent per tenant. Runtime memakai agent
// aktif tertua; mode 'auto' mengirim langsung, mode 'suggest' membuat draf
// di agent_suggestions yang menunggu persetujuan manusia.
// ---------------------------------------------------------------------------

export const AgentModeSchema = z.enum(["auto", "suggest"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const AgentConfigSchema = z.object({
  maxReplyChars: z.number().int().positive().max(100_000).optional(),
  language: z.string().trim().min(2).max(16).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const CreateAgentRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  systemPrompt: z.string().max(20_000).optional(),
  model: z.string().trim().max(128).optional(),
  mode: AgentModeSchema.optional(),
  isActive: z.boolean().optional(),
  config: AgentConfigSchema.optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    systemPrompt: z.string().max(20_000).optional(),
    model: z.string().trim().max(128).optional(),
    mode: AgentModeSchema.optional(),
    isActive: z.boolean().optional(),
    config: AgentConfigSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const AgentResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  systemPrompt: z.string(),
  model: z.string(),
  mode: AgentModeSchema,
  isActive: z.boolean(),
  config: AgentConfigSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const AgentListResponseSchema = z.object({
  agents: z.array(AgentResponseSchema),
});
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

// ---------------------------------------------------------------------------
// AI Playground (Fase 12E) — uji KERING agent dari dashboard hub /agents.
// Balasan dihitung lewat jalur yang sama persis seperti runtime
// (prompt agent + retrieval KB hibrida + provider LLM), tetapi tool call
// TIDAK dieksekusi — dikembalikan sebagai "niat" terstruktur — dan tidak
// ada percakapan/pesan/kontak/saran yang ditulis. Pemakaian token tetap
// tercatat di usage_ledger dengan refType khusus `agent_playground`,
// TERPISAH dari `agent_response`: tidak mengonsumsi cap 200 respons/hari
// dan tidak masuk agregat analytics (dasbor 9B menyaring agent_response).
// ---------------------------------------------------------------------------

export const AgentPlaygroundHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4_000),
});
export type AgentPlaygroundHistoryMessage = z.infer<
  typeof AgentPlaygroundHistoryMessageSchema
>;

export const AgentPlaygroundRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  /** Riwayat uji sebelumnya (hanya hidup di klien; maks 20 giliran). */
  history: z.array(AgentPlaygroundHistoryMessageSchema).max(20).optional(),
});
export type AgentPlaygroundRequest = z.infer<
  typeof AgentPlaygroundRequestSchema
>;

export const AgentPlaygroundIntentKindSchema = z.enum([
  "add_tag",
  "set_stage",
  "handoff",
  "create_payment_link",
  "unknown",
]);
export type AgentPlaygroundIntentKind = z.infer<
  typeof AgentPlaygroundIntentKindSchema
>;

export const AgentPlaygroundIntentSchema = z.object({
  kind: AgentPlaygroundIntentKindSchema,
  /** add_tag: tag (ternormalisasi seperti executor) yang AKAN dipasang. */
  tag: z.string().nullable().optional(),
  /** set_stage: tahap tujuan yang diusulkan model. */
  stage: z.string().nullable().optional(),
  /** handoff: alasan yang diusulkan model. */
  reason: z.string().nullable().optional(),
  /**
   * create_payment_link: produk yang AKAN dipakai, dari pencocokan
   * BACA-SAJA yang sama seperti executor; null = tidak ada produk aktif.
   */
  productId: z.string().uuid().nullable().optional(),
  productName: z.string().nullable().optional(),
  /** create_payment_link: nama produk yang diminta model (query mentah). */
  query: z.string().nullable().optional(),
  /** unknown: nama tool mentah dari model yang tidak dikenal runtime. */
  toolName: z.string().nullable().optional(),
});
export type AgentPlaygroundIntent = z.infer<
  typeof AgentPlaygroundIntentSchema
>;

export const AgentPlaygroundKbHitSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  chunkIndex: z.number().int(),
  /** Cuplikan isi chunk (dipotong server, maks 280 karakter). */
  snippet: z.string(),
  /** Jalur retrieval yang menemukan chunk ini (Fase 12D). */
  sources: z.array(z.enum(["fts", "vector"])),
});
export type AgentPlaygroundKbHit = z.infer<
  typeof AgentPlaygroundKbHitSchema
>;

export const AgentPlaygroundUsageSchema = z.object({
  provider: z.string(),
  model: z.string(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  /** Biaya aktual provider (USD); null = provider tidak melaporkannya. */
  costUsd: z.number().nullable(),
});
export type AgentPlaygroundUsage = z.infer<
  typeof AgentPlaygroundUsageSchema
>;

export const AgentPlaygroundResponseSchema = z.object({
  /** Teks balasan yang AKAN dikirim agent (mode auto) / diusulkan (suggest). */
  replyText: z.string(),
  mode: AgentModeSchema,
  /** Mode retrieval yang benar-benar terjadi pada lari ini. */
  retrieval: z.enum(["hybrid", "fts"]),
  kbHits: z.array(AgentPlaygroundKbHitSchema),
  intents: z.array(AgentPlaygroundIntentSchema),
  usage: AgentPlaygroundUsageSchema,
});
export type AgentPlaygroundResponse = z.infer<
  typeof AgentPlaygroundResponseSchema
>;

// ---------------------------------------------------------------------------
// Knowledge Base (Fase 3A) — dokumen teks yang di-chunk untuk retrieval
// full-text (pgvector embedding menyusul; kolom sudah disiapkan di DB).
// ---------------------------------------------------------------------------

export const CreateKbDocumentRequestSchema = z.object({
  title: z.string().trim().min(1).max(255),
  content: z.string().trim().min(1).max(200_000),
});
export type CreateKbDocumentRequest = z.infer<
  typeof CreateKbDocumentRequestSchema
>;

export const KbDocumentResponseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  content: z.string(),
  /** Jumlah chunk hasil pemecahan dokumen ini (untuk retrieval). */
  chunkCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type KbDocumentResponse = z.infer<typeof KbDocumentResponseSchema>;

export const KbDocumentListResponseSchema = z.object({
  documents: z.array(KbDocumentResponseSchema),
});
export type KbDocumentListResponse = z.infer<
  typeof KbDocumentListResponseSchema
>;

/**
 * Berkas lampiran KB (Fase 12C): byte asli tersimpan di
 * `kb_source_documents`; teks hasil ekstraksinya menjadi satu entri
 * `KbDocumentResponse` biasa (`documentId` di sini) yang ter-chunk
 * untuk retrieval. Respons ini TIDAK pernah membawa byte berkas —
 * unduh berkas asli tidak dibuat di v1.
 */
export const KbFileDocumentResponseSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** Jumlah chunk entri KB turunan berkas ini. */
  chunkCount: z.number().int().nonnegative(),
  /** Id entri KB (kb_documents) yang lahir dari berkas ini. */
  documentId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type KbFileDocumentResponse = z.infer<
  typeof KbFileDocumentResponseSchema
>;

export const KbFileDocumentListResponseSchema = z.object({
  files: z.array(KbFileDocumentResponseSchema),
});
export type KbFileDocumentListResponse = z.infer<
  typeof KbFileDocumentListResponseSchema
>;

/**
 * Statistik indeks KB (Fase 12D): cakupan embedding chunk + status
 * pencarian semantik SEBAGAIMANA di-resolve proses API (provider yang
 * sama dengan yang dipakai worker: mock paksa via env, atau OpenRouter
 * dari kunci Panel Admin → env; tanpa kunci → active=false dan agent
 * mencari full-text saja). `provider`/`model` null bila nonaktif.
 */
export const KbStatsResponseSchema = z.object({
  totalChunks: z.number().int().nonnegative(),
  embeddedChunks: z.number().int().nonnegative(),
  semanticSearch: z.object({
    active: z.boolean(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
  }),
});
export type KbStatsResponse = z.infer<typeof KbStatsResponseSchema>;

// ---------------------------------------------------------------------------
// Agent suggestions (Fase 3A) — draf balasan dari agent mode 'suggest'.
// Approve = kirim teks saran sebagai pesan outbound agent (status saran
// menjadi 'sent'); tool call yang diusulkan agent TIDAK ikut dieksekusi.
// ---------------------------------------------------------------------------

export const AgentSuggestionStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "sent",
]);
export type AgentSuggestionStatus = z.infer<typeof AgentSuggestionStatusSchema>;

export const AgentSuggestionResponseSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  conversationId: z.string().uuid(),
  triggerMessageId: z.string().uuid().nullable(),
  contactId: z.string().uuid().nullable(),
  suggestedText: z.string(),
  status: AgentSuggestionStatusSchema,
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentSuggestionResponse = z.infer<
  typeof AgentSuggestionResponseSchema
>;

export const AgentSuggestionListResponseSchema = z.object({
  suggestions: z.array(AgentSuggestionResponseSchema),
});
export type AgentSuggestionListResponse = z.infer<
  typeof AgentSuggestionListResponseSchema
>;
