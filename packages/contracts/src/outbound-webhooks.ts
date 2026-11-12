import { z } from "zod";

// ---------------------------------------------------------------------------
// Webhook keluar (outbound) tenant (Gelombang G11)
// ---------------------------------------------------------------------------

/**
 * Katalog peristiwa yang boleh dilanggan — cermin dari katalog core
 * (OUTBOUND_WEBHOOK_EVENT_TYPES di @sahabat-kreator/core). Hanya
 * peristiwa outbox yang BENAR-BENAR punya sumber hari ini:
 * `message.received` (semua jalur ingest) dan `message.status_updated`
 * (penanda pusat pesan keluar + resi WhatsApp). `conversation.created`
 * SENGAJA tidak ada — tidak ada satu titik produsen outbox untuknya
 * (lihat catatan katalog di core outbound-webhooks).
 */
export const OutboundWebhookEventTypeSchema = z.enum([
  "message.received",
  "message.status_updated",
]);
export type OutboundWebhookEventType = z.infer<
  typeof OutboundWebhookEventTypeSchema
>;

export const OUTBOUND_WEBHOOK_EVENT_TYPES: readonly OutboundWebhookEventType[] =
  ["message.received", "message.status_updated"] as const;

export const OutboundWebhookEndpointStatusSchema = z.enum([
  "active",
  "disabled",
]);
export type OutboundWebhookEndpointStatus = z.infer<
  typeof OutboundWebhookEndpointStatusSchema
>;

export const CreateOutboundWebhookRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  url: z.string().trim().min(1).max(2048),
  events: z.array(OutboundWebhookEventTypeSchema).min(1),
});
export type CreateOutboundWebhookRequest = z.infer<
  typeof CreateOutboundWebhookRequestSchema
>;

export const OutboundWebhookResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  status: OutboundWebhookEndpointStatusSchema,
  consecutiveFailures: z.number().int(),
  /** 'manual' | 'consecutive_failures' | null */
  disabledReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OutboundWebhookResponse = z.infer<
  typeof OutboundWebhookResponseSchema
>;

/** Respons pembuatan: memuat rahasia penanda tangan UTUH — ditampilkan SATU KALI. */
export const CreatedOutboundWebhookResponseSchema =
  OutboundWebhookResponseSchema.extend({
    signingSecret: z.string(),
  });
export type CreatedOutboundWebhookResponse = z.infer<
  typeof CreatedOutboundWebhookResponseSchema
>;

export const OutboundWebhookListResponseSchema = z.object({
  endpoints: z.array(OutboundWebhookResponseSchema),
});
export type OutboundWebhookListResponse = z.infer<
  typeof OutboundWebhookListResponseSchema
>;

export const OutboundWebhookDeliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
]);
export type OutboundWebhookDeliveryStatus = z.infer<
  typeof OutboundWebhookDeliveryStatusSchema
>;

export const OutboundWebhookDeliveryResponseSchema = z.object({
  id: z.string().uuid(),
  endpointId: z.string().uuid(),
  /** Jenis peristiwa; 'ping' = pengiriman uji manual. */
  eventType: z.string(),
  sourceEventId: z.string().uuid().nullable(),
  /** Badan envelope persis seperti dikirim (data milik tenant sendiri). */
  payload: z.record(z.string(), z.unknown()),
  status: OutboundWebhookDeliveryStatusSchema,
  attempts: z.number().int(),
  nextAttemptAt: z.string().datetime().nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OutboundWebhookDeliveryResponse = z.infer<
  typeof OutboundWebhookDeliveryResponseSchema
>;

export const OutboundWebhookDeliveryListResponseSchema = z.object({
  deliveries: z.array(OutboundWebhookDeliveryResponseSchema),
});
export type OutboundWebhookDeliveryListResponse = z.infer<
  typeof OutboundWebhookDeliveryListResponseSchema
>;
