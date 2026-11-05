import { z } from "zod";

import type { ApiKeyScope } from "./api-keys";
import { BroadcastStatusSchema } from "./broadcasts";
import { FlowStatusSchema } from "./flows";

// ---------------------------------------------------------------------------
// Fase 15A — Permukaan publik v1: query tambahan + REGISTRY permukaan.
//
// Aturan sinkronisasi kontrak (keputusan user 2026-11-02 22:10):
// packages/contracts adalah sumber kebenaran tunggal; setiap kemampuan
// yang masuk permukaan publik WAJIB punya pemetaan kontrak → API v1 →
// SDK → MCP → CLI dalam fase yang sama (CLI bergabung Fase 14D).
// PUBLIC_V1_SURFACE di bawah adalah registry pemetaan itu — satu
// entri per rute publik. Skrip `check:drift`
// (packages/sdk/scripts/check-drift.ts, jalankan `pnpm check:drift`)
// memeriksa registry ini terhadap implementasi nyata (rute di modul
// public-v1, metode SDK, tool MCP, perintah CLI) dan GAGAL bila ada
// rute publik tanpa pemetaan atau pemetaan yang menunjuk nama yang
// tidak ada. Matriks cakupan lengkap (termasuk permukaan
// dashboard-only yang disengaja) hidup di docs/COVERAGE-MATRIX.md.
//
// Seksi ini sengaja di AKHIR file: skema query broadcast/flow merujuk
// skema status yang didefinisikan di seksi sumber dayanya masing-masing.
// ---------------------------------------------------------------------------

/** Query daftar broadcast API publik /v1 (Fase 15A) — paginasi kursor seperti dashboard. */
export const V1ListBroadcastsQuerySchema = z.object({
  status: BroadcastStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListBroadcastsQuery = z.infer<typeof V1ListBroadcastsQuerySchema>;

/** Query daftar flow API publik /v1 (Fase 15A) — paginasi kursor seperti dashboard. */
export const V1ListFlowsQuerySchema = z.object({
  status: FlowStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListFlowsQuery = z.infer<typeof V1ListFlowsQuerySchema>;

/** Query daftar template WhatsApp API publik /v1 (Fase 15A) — cermin selalu per akun channel. */
export const V1ListWhatsAppTemplatesQuerySchema = z.object({
  channelAccountId: z.string().uuid(),
});
export type ListWhatsAppTemplatesQuery = z.infer<
  typeof V1ListWhatsAppTemplatesQuerySchema
>;

/** Tier tool MCP untuk satu rute: read = jalan selalu; write = butuh MCP_ALLOW_WRITES=1. */
export type PublicSurfaceMcpTier = "read" | "write";

/**
 * Satu rute API publik v1 dan pemetaannya ke permukaan lain.
 *
 * - `scope`: scope API key yang dituntut rute; null = cukup kunci sah
 *   apa pun (hanya /v1/me).
 * - `contractSchemas`: nama ekspor skema kontrak yang membentuk
 *   request/response rute ini — diverifikasi check:drift benar-benar
 *   ada di paket ini.
 * - `sdkMethod`: nama metode pada SahabatKreatorClient; null hanya
 *   bila disengaja dan `exclusionReason` terisi.
 * - `mcpTool`/`mcpTier`: nama tool MCP + tiernya; null hanya bila
 *   disengaja dan `exclusionReason` terisi.
 * - `cliCommand`: nama perintah CLI `sk` (Fase 14D) — mis.
 *   "contacts list". TIDAK PERNAH null: permukaan klien keempat ini
 *   menjangkau setiap rute publik; perintahnya hidup di tabel perintah
 *   apps/cli dan dicocokkan check:drift dua arah, persis seperti
 *   metode SDK dan tool MCP.
 */
export interface PublicV1RouteMapping {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  scope: ApiKeyScope | null;
  contractSchemas: string[];
  sdkMethod: string | null;
  mcpTool: string | null;
  mcpTier: PublicSurfaceMcpTier | null;
  cliCommand: string;
  exclusionReason?: string;
}

/**
 * REGISTRY permukaan publik v1 — daftar kanonis semua rute /v1.
 * Menambah rute publik = menambah entri di sini pada fase yang sama,
 * atau check:drift gagal.
 */
export const PUBLIC_V1_SURFACE: readonly PublicV1RouteMapping[] = [
  {
    method: "GET",
    path: "/v1/me",
    scope: null,
    contractSchemas: ["PublicMeResponseSchema"],
    sdkMethod: "me",
    mcpTool: "whoami",
    mcpTier: "read",
    cliCommand: "whoami",
  },
  {
    method: "GET",
    path: "/v1/contacts",
    scope: "contacts:read",
    contractSchemas: ["V1ListContactsQuerySchema", "ContactListResponseSchema"],
    sdkMethod: "listContacts",
    mcpTool: "list_contacts",
    mcpTier: "read",
    cliCommand: "contacts list",
  },
  {
    method: "POST",
    path: "/v1/contacts",
    scope: "contacts:write",
    contractSchemas: ["CreateContactRequestSchema", "ContactResponseSchema"],
    sdkMethod: "createContact",
    mcpTool: "create_contact",
    mcpTier: "write",
    cliCommand: "contacts create",
  },
  {
    method: "PATCH",
    path: "/v1/contacts/:id",
    scope: "contacts:write",
    contractSchemas: ["UpdateContactRequestSchema", "ContactResponseSchema"],
    sdkMethod: "updateContact",
    mcpTool: "update_contact",
    mcpTier: "write",
    cliCommand: "contacts update",
  },
  {
    method: "GET",
    path: "/v1/conversations",
    scope: "conversations:read",
    contractSchemas: [
      "V1ListConversationsQuerySchema",
      "ConversationListResponseSchema",
    ],
    sdkMethod: "listConversations",
    mcpTool: "list_conversations",
    mcpTier: "read",
    cliCommand: "conversations list",
  },
  {
    method: "GET",
    path: "/v1/conversations/:id/messages",
    scope: "conversations:read",
    contractSchemas: ["V1ListMessagesQuerySchema", "MessageListResponseSchema"],
    sdkMethod: "listMessages",
    mcpTool: "list_messages",
    mcpTier: "read",
    cliCommand: "messages list",
  },
  {
    method: "POST",
    path: "/v1/conversations/:id/messages",
    scope: "messages:write",
    contractSchemas: ["SendMessageRequestSchema", "MessageResponseSchema"],
    sdkMethod: "sendMessage",
    mcpTool: "send_message",
    mcpTier: "write",
    cliCommand: "messages send",
  },
  {
    method: "GET",
    path: "/v1/products",
    scope: "products:read",
    contractSchemas: ["ProductListResponseSchema"],
    sdkMethod: "listProducts",
    mcpTool: "list_products",
    mcpTier: "read",
    cliCommand: "products list",
  },
  {
    method: "GET",
    path: "/v1/comments",
    scope: "comments:read",
    contractSchemas: ["V1ListCommentsQuerySchema", "CommentListResponseSchema"],
    sdkMethod: "listComments",
    mcpTool: "list_comments",
    mcpTier: "read",
    cliCommand: "comments list",
  },
  {
    method: "POST",
    path: "/v1/comments/:id/hide",
    scope: "comments:write",
    contractSchemas: ["CommentResponseSchema"],
    sdkMethod: "hideComment",
    mcpTool: "hide_comment",
    mcpTier: "write",
    cliCommand: "comments hide",
  },
  {
    method: "POST",
    path: "/v1/comments/:id/unhide",
    scope: "comments:write",
    contractSchemas: ["CommentResponseSchema"],
    sdkMethod: "unhideComment",
    mcpTool: "unhide_comment",
    mcpTier: "write",
    cliCommand: "comments unhide",
  },
  // --- Fase 15A: permukaan BACA baru (sebelumnya dashboard-only) -------
  {
    method: "GET",
    path: "/v1/broadcasts",
    scope: "broadcasts:read",
    contractSchemas: ["V1ListBroadcastsQuerySchema", "BroadcastListResponseSchema"],
    sdkMethod: "listBroadcasts",
    mcpTool: "list_broadcasts",
    mcpTier: "read",
    cliCommand: "broadcasts list",
  },
  {
    method: "GET",
    path: "/v1/broadcasts/:id",
    scope: "broadcasts:read",
    contractSchemas: ["BroadcastResponseSchema"],
    sdkMethod: "getBroadcast",
    mcpTool: "get_broadcast",
    mcpTier: "read",
    cliCommand: "broadcasts get",
  },
  {
    method: "GET",
    path: "/v1/flows",
    scope: "flows:read",
    contractSchemas: ["V1ListFlowsQuerySchema", "FlowListResponseSchema"],
    sdkMethod: "listFlows",
    mcpTool: "list_flows",
    mcpTier: "read",
    cliCommand: "flows list",
  },
  {
    method: "GET",
    path: "/v1/flows/:id",
    scope: "flows:read",
    contractSchemas: ["FlowResponseSchema"],
    sdkMethod: "getFlow",
    mcpTool: "get_flow",
    mcpTier: "read",
    cliCommand: "flows get",
  },
  {
    method: "GET",
    path: "/v1/flow-templates",
    scope: "flows:read",
    contractSchemas: ["FlowTemplateListResponseSchema"],
    sdkMethod: "listFlowTemplates",
    mcpTool: "list_flow_templates",
    mcpTier: "read",
    cliCommand: "flow-templates list",
  },
  {
    method: "GET",
    path: "/v1/automations",
    scope: "automations:read",
    contractSchemas: ["AutomationListResponseSchema"],
    sdkMethod: "listAutomations",
    mcpTool: "list_automations",
    mcpTier: "read",
    cliCommand: "automations list",
  },
  {
    method: "GET",
    path: "/v1/automations/:id",
    scope: "automations:read",
    contractSchemas: ["AutomationResponseSchema"],
    sdkMethod: "getAutomation",
    mcpTool: "get_automation",
    mcpTier: "read",
    cliCommand: "automations get",
  },
  {
    method: "GET",
    path: "/v1/agents",
    scope: "agents:read",
    contractSchemas: ["AgentListResponseSchema"],
    sdkMethod: "listAgents",
    mcpTool: "list_agents",
    mcpTier: "read",
    cliCommand: "agents list",
  },
  {
    method: "GET",
    path: "/v1/agents/:id",
    scope: "agents:read",
    contractSchemas: ["AgentResponseSchema"],
    sdkMethod: "getAgent",
    mcpTool: "get_agent",
    mcpTier: "read",
    cliCommand: "agents get",
  },
  {
    method: "GET",
    path: "/v1/channels",
    scope: "channels:read",
    contractSchemas: ["ChannelAccountListResponseSchema"],
    sdkMethod: "listChannels",
    mcpTool: "list_channels",
    mcpTier: "read",
    cliCommand: "channels list",
  },
  {
    method: "GET",
    path: "/v1/channels/:id",
    scope: "channels:read",
    contractSchemas: ["ChannelAccountResponseSchema"],
    sdkMethod: "getChannel",
    mcpTool: "get_channel",
    mcpTier: "read",
    cliCommand: "channels get",
  },
  {
    method: "GET",
    path: "/v1/whatsapp-templates",
    scope: "whatsapp_templates:read",
    contractSchemas: [
      "V1ListWhatsAppTemplatesQuerySchema",
      "WhatsAppTemplateListResponseSchema",
    ],
    sdkMethod: "listWhatsAppTemplates",
    mcpTool: "list_whatsapp_templates",
    mcpTier: "read",
    cliCommand: "whatsapp-templates list",
  },
  {
    method: "GET",
    path: "/v1/knowledge/documents",
    scope: "knowledge:read",
    contractSchemas: ["KbDocumentListResponseSchema"],
    sdkMethod: "listKnowledgeDocuments",
    mcpTool: "list_knowledge_documents",
    mcpTier: "read",
    cliCommand: "kb list",
  },
  {
    method: "GET",
    path: "/v1/knowledge/documents/:id",
    scope: "knowledge:read",
    contractSchemas: ["KbDocumentResponseSchema"],
    sdkMethod: "getKnowledgeDocument",
    mcpTool: "get_knowledge_document",
    mcpTier: "read",
    cliCommand: "kb get",
  },
  {
    method: "GET",
    path: "/v1/knowledge/stats",
    scope: "knowledge:read",
    contractSchemas: ["KbStatsResponseSchema"],
    sdkMethod: "getKnowledgeStats",
    mcpTool: "get_knowledge_stats",
    mcpTier: "read",
    cliCommand: "kb stats",
  },
  // --- Fase 13B: growth links — permukaan BACA (tulis dashboard-only) --
  {
    method: "GET",
    path: "/v1/growth-links",
    scope: "growth_links:read",
    contractSchemas: ["GrowthLinkListResponseSchema"],
    sdkMethod: "listGrowthLinks",
    mcpTool: "list_growth_links",
    mcpTier: "read",
    cliCommand: "growth-links list",
  },
  {
    method: "GET",
    path: "/v1/growth-links/:id",
    scope: "growth_links:read",
    contractSchemas: ["GrowthLinkResponseSchema"],
    sdkMethod: "getGrowthLink",
    mcpTool: "get_growth_link",
    mcpTier: "read",
    cliCommand: "growth-links get",
  },
  // --- Fase 13C: segmen — permukaan BACA (tulis dashboard-only) --
  {
    method: "GET",
    path: "/v1/segments",
    scope: "segments:read",
    contractSchemas: ["SegmentListResponseSchema"],
    sdkMethod: "listSegments",
    mcpTool: "list_segments",
    mcpTier: "read",
    cliCommand: "segments list",
  },
  {
    method: "GET",
    path: "/v1/segments/:id",
    scope: "segments:read",
    contractSchemas: ["SegmentResponseSchema"],
    sdkMethod: "getSegment",
    mcpTool: "get_segment",
    mcpTier: "read",
    cliCommand: "segments get",
  },
  // --- Fase 13F: order — permukaan BACA (keranjang internal) --------
  {
    method: "GET",
    path: "/v1/orders",
    scope: "orders:read",
    contractSchemas: ["OrderListResponseSchema"],
    sdkMethod: "listOrders",
    mcpTool: "list_orders",
    mcpTier: "read",
    cliCommand: "orders list",
  },
  {
    method: "GET",
    path: "/v1/orders/:id",
    scope: "orders:read",
    contractSchemas: ["OrderResponseSchema"],
    sdkMethod: "getOrder",
    mcpTool: "get_order",
    mcpTier: "read",
    cliCommand: "orders get",
  },
  {
    method: "GET",
    path: "/v1/appointments",
    scope: "appointments:read",
    contractSchemas: ["V1ListAppointmentsQuerySchema", "BookingListResponseSchema"],
    sdkMethod: "listAppointments",
    mcpTool: "list_appointments",
    mcpTier: "read",
    cliCommand: "appointments list",
  },
  {
    method: "GET",
    path: "/v1/appointment-services",
    scope: "appointments:read",
    contractSchemas: ["AppointmentServiceListResponseSchema"],
    sdkMethod: "listAppointmentServices",
    mcpTool: "list_appointment_services",
    mcpTier: "read",
    cliCommand: "appointments services",
  },
];
