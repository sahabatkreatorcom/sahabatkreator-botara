import { z } from "zod";

import { ConversationStatusSchema } from "./inbox";

// ---------------------------------------------------------------------------
// API keys & API publik /v1 (Fase 5A)
// ---------------------------------------------------------------------------

/**
 * Scope API key v1 (RANCANGAN §5.4). Read tersedia untuk kontak, percakapan,
 * dan produk; write harus dipilih EKSPLISIT saat kunci dibuat — default
 * pembuatan hanya berisi scope read (lihat API_KEYS_DEFAULT_SCOPES).
 */
export const ApiKeyScopeSchema = z.enum([
  "contacts:read",
  "contacts:write",
  "conversations:read",
  "messages:write",
  "products:read",
  // Fase 10B: permukaan publik komentar (aturan sinkronisasi kontrak).
  "comments:read",
  "comments:write",
  // Fase 13B: permukaan BACA publik growth links (tulis tetap
  // dashboard-only — slug publik + branding adalah artefak kurasi UI;
  // lihat docs/COVERAGE-MATRIX.md).
  "growth_links:read",
  // Fase 13C: permukaan BACA publik segmen (tulis tetap dashboard-only
  // — segmen adalah artefak kurasi UI dengan definisi kondisi kompleks;
  // lihat docs/COVERAGE-MATRIX.md).
  "segments:read",
  // Fase 13F: permukaan BACA publik order (keranjang tetap internal —
  // keadaan sesi ephemeral per kontak, bukan sumber daya integrasi;
  // lihat docs/COVERAGE-MATRIX.md).
  "orders:read",
  // Fase 13G: permukaan BACA publik janji temu (booking + layanan).
  // Tulis (layanan/ketersediaan/pembatalan) tetap dashboard/flow-only —
  // booking lahir dari percakapan (node book_appointment) atau aksi
  // operator di dashboard; lihat docs/COVERAGE-MATRIX.md.
  "appointments:read",
  // Fase 15A: permukaan BACA publik untuk sumber daya yang sebelumnya
  // hanya dashboard (aturan sinkronisasi kontrak dijalankan retrospektif).
  // Tulis untuk sumber daya ini tetap dashboard-only — lihat
  // docs/COVERAGE-MATRIX.md untuk alasan per sumber daya.
  "broadcasts:read",
  "flows:read",
  "automations:read",
  "agents:read",
  "channels:read",
  "whatsapp_templates:read",
  "knowledge:read",
]);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "contacts:read",
  "contacts:write",
  "conversations:read",
  "messages:write",
  "products:read",
  "comments:read",
  "comments:write",
  "broadcasts:read",
  "flows:read",
  "automations:read",
  "agents:read",
  "channels:read",
  "whatsapp_templates:read",
  "knowledge:read",
  "growth_links:read",
  "segments:read",
  "orders:read",
  "appointments:read",
] as const;

/** Default aman saat pembuatan tidak menyebut scope: hanya baca. */
export const API_KEY_DEFAULT_SCOPES: readonly ApiKeyScope[] = [
  "contacts:read",
  "conversations:read",
  "products:read",
  "comments:read",
  "broadcasts:read",
  "flows:read",
  "automations:read",
  "agents:read",
  "channels:read",
  "whatsapp_templates:read",
  "knowledge:read",
  "growth_links:read",
  "segments:read",
  "orders:read",
  "appointments:read",
] as const;

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  scopes: z.array(ApiKeyScopeSchema).max(18).optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const ApiKeyResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Awalan tampil, mis. `sk_live_ab12` — BUKAN kunci utuh. */
  keyPrefix: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
  lastUsedAt: z.string().datetime().nullable(),
  /** Terisi = kunci sudah dicabut (soft revoke) dan tidak berlaku lagi. */
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;

/** Respons pembuatan: memuat kunci UTUH — ditampilkan SATU KALI, tak pernah lagi. */
export const CreatedApiKeyResponseSchema = ApiKeyResponseSchema.extend({
  key: z.string(),
});
export type CreatedApiKeyResponse = z.infer<typeof CreatedApiKeyResponseSchema>;

export const ApiKeyListResponseSchema = z.object({
  apiKeys: z.array(ApiKeyResponseSchema),
});
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponseSchema>;

/** GET /api/v1/me — identitas tenant pemilik kunci yang dipakai. */
export const PublicMeResponseSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
});
export type PublicMeResponse = z.infer<typeof PublicMeResponseSchema>;

// ---------------------------------------------------------------------------
// Parameter query API publik /v1 (Fase 5B) — bentuk request sisi klien.
// SDK (@sahabat-kreator/sdk) memakai tipe ini agar tidak mendefinisikan
// ulang parameter endpoint v1 (RANCANGAN §2 aturan 2: contracts adalah
// sumber kebenaran; SDK & tool MCP diturunkan darinya). Semua field
// opsional — default & koersi diterapkan server (lihat modul public-v1).
// ---------------------------------------------------------------------------

export const V1ListContactsQuerySchema = z.object({
  search: z.string().max(255).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});
export type ListContactsQuery = z.infer<typeof V1ListContactsQuerySchema>;

export const V1ListConversationsQuerySchema = z.object({
  status: ConversationStatusSchema.optional(),
});
export type ListConversationsQuery = z.infer<
  typeof V1ListConversationsQuerySchema
>;

export const V1ListMessagesQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListMessagesQuery = z.infer<typeof V1ListMessagesQuerySchema>;

/** Query daftar komentar API publik /v1 (Fase 10B). */
export const V1ListCommentsQuerySchema = z.object({
  channelAccountId: z.string().uuid().optional(),
  automationId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListCommentsQuery = z.infer<typeof V1ListCommentsQuerySchema>;
