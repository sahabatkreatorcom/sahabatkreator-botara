import { Hono } from "hono";
import {
  CreatedOutboundWebhookResponseSchema,
  CreateOutboundWebhookRequestSchema,
  OutboundWebhookDeliveryListResponseSchema,
  OutboundWebhookDeliveryResponseSchema,
  OutboundWebhookListResponseSchema,
  OutboundWebhookResponseSchema,
  type OutboundWebhookDeliveryResponse,
  type OutboundWebhookResponse,
} from "@sahabat-kreator/contracts";
import type {
  OutboundWebhookDelivery,
  OutboundWebhookEndpoint,
} from "@sahabat-kreator/db";
import {
  createOutboundWebhookEndpoint,
  deleteOutboundWebhookEndpoint,
  getOutboundWebhookEndpoint,
  listOutboundWebhookDeliveries,
  listOutboundWebhookEndpoints,
  sendOutboundWebhookTestEvent,
  setOutboundWebhookEndpointEnabled,
  type OutboundWebhookEndpointView,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul outbound-webhooks (G11) — webhook KELUAR tenant:
 *   POST   /tenants/:tenantId/outbound-webhooks              buat endpoint (owner/admin) → 201 + rahasia SATU KALI
 *   GET    /tenants/:tenantId/outbound-webhooks              daftar (semua member; TANPA rahasia)
 *   POST   /tenants/:tenantId/outbound-webhooks/:id/enable   aktifkan lagi (owner/admin; penghitung gagal di-nol-kan)
 *   POST   /tenants/:tenantId/outbound-webhooks/:id/disable  nonaktifkan manual (owner/admin)
 *   DELETE /tenants/:tenantId/outbound-webhooks/:id          hapus (owner/admin) → 204
 *   GET    /tenants/:tenantId/outbound-webhooks/:id/deliveries  log pengiriman terakhir (semua member)
 *   POST   /tenants/:tenantId/outbound-webhooks/:id/test     kirim peristiwa uji `ping` sekarang (owner/admin)
 *
 * Pengiriman peristiwa sungguhan ada di worker (relay outbox →
 * job fan-out → penyapu percobaan ulang); modul ini hanya mengelola
 * endpoint + membaca log-nya — kecuali peristiwa uji yang memang
 * ditembak sinkron dari sini sebagai alat diagnostik.
 * Non-member selalu 404 TENANT_NOT_FOUND (pola Fase 1B).
 */

export function serializeOutboundWebhookEndpoint(
  row: OutboundWebhookEndpointView | OutboundWebhookEndpoint,
): OutboundWebhookResponse {
  return OutboundWebhookResponseSchema.parse({
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events ?? [],
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    disabledReason: row.disabledReason ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function serializeOutboundWebhookDelivery(
  row: OutboundWebhookDelivery,
): OutboundWebhookDeliveryResponse {
  return OutboundWebhookDeliveryResponseSchema.parse({
    id: row.id,
    endpointId: row.endpointId,
    eventType: row.eventType,
    sourceEventId: row.sourceEventId ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastStatusCode: row.lastStatusCode ?? null,
    lastError: row.lastError ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export interface OutboundWebhooksRoutesDeps {
  channelTokenSecret?: string | undefined;
}

export function createOutboundWebhooksRoutes(
  bundle: AuthBundle | null,
  deps: OutboundWebhooksRoutesDeps,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/outbound-webhooks";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.post(base, unavailable);
    app.get(base, unavailable);
    app.post(`${base}/:id/enable`, unavailable);
    app.post(`${base}/:id/disable`, unavailable);
    app.delete(`${base}/:id`, unavailable);
    app.get(`${base}/:id/deliveries`, unavailable);
    app.post(`${base}/:id/test`, unavailable);
    return app;
  }

  const requireManager = async (
    c: AppContext,
  ): Promise<
    | { tenantId: string; userId: string }
    | { error: ReturnType<typeof apiError> }
  > => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      appUser.id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      };
    }
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage outbound webhooks",
        ),
      };
    }
    return { tenantId: tenant.id, userId: appUser.id };
  };

  const requireMember = async (
    c: AppContext,
  ): Promise<{ tenantId: string } | { error: ReturnType<typeof apiError> }> => {
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      c.get("appUser").id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      };
    }
    return { tenantId: tenant.id };
  };

  app.post(base, async (c) => {
    const access = await requireManager(c);
    if ("error" in access) return access.error;
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateOutboundWebhookRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid outbound webhook payload");
    }
    if (!deps.channelTokenSecret) {
      return apiError(c, 503, "INTERNAL_ERROR", "Webhook signing is not configured");
    }
    const result = await createOutboundWebhookEndpoint(
      bundle.db,
      { tenantId: access.tenantId, userId: access.userId },
      { encryptionSecret: deps.channelTokenSecret },
      {
        name: parsed.data.name,
        url: parsed.data.url,
        events: parsed.data.events,
      },
    );
    if (!result.ok) {
      return apiError(c, 400, result.code, `Outbound webhook rejected: ${result.code}`);
    }
    const body = CreatedOutboundWebhookResponseSchema.parse({
      ...serializeOutboundWebhookEndpoint(result.endpoint),
      signingSecret: result.signingSecret,
    });
    return c.json(body, 201);
  });

  app.get(base, async (c) => {
    const access = await requireMember(c);
    if ("error" in access) return access.error;
    const rows = await listOutboundWebhookEndpoints(bundle.db, access.tenantId);
    const body = OutboundWebhookListResponseSchema.parse({
      endpoints: rows.map(serializeOutboundWebhookEndpoint),
    });
    return c.json(body);
  });

  app.post(`${base}/:id/enable`, async (c) => {
    const access = await requireManager(c);
    if ("error" in access) return access.error;
    const row = await setOutboundWebhookEndpointEnabled(
      bundle.db,
      { tenantId: access.tenantId, userId: access.userId },
      c.req.param("id"),
      true,
    );
    if (!row) return apiError(c, 404, "NOT_FOUND", "Outbound webhook not found");
    return c.json(serializeOutboundWebhookEndpoint(row));
  });

  app.post(`${base}/:id/disable`, async (c) => {
    const access = await requireManager(c);
    if ("error" in access) return access.error;
    const row = await setOutboundWebhookEndpointEnabled(
      bundle.db,
      { tenantId: access.tenantId, userId: access.userId },
      c.req.param("id"),
      false,
    );
    if (!row) return apiError(c, 404, "NOT_FOUND", "Outbound webhook not found");
    return c.json(serializeOutboundWebhookEndpoint(row));
  });

  app.delete(`${base}/:id`, async (c) => {
    const access = await requireManager(c);
    if ("error" in access) return access.error;
    const deleted = await deleteOutboundWebhookEndpoint(
      bundle.db,
      { tenantId: access.tenantId, userId: access.userId },
      c.req.param("id"),
    );
    if (!deleted) return apiError(c, 404, "NOT_FOUND", "Outbound webhook not found");
    return c.body(null, 204);
  });

  app.get(`${base}/:id/deliveries`, async (c) => {
    const access = await requireMember(c);
    if ("error" in access) return access.error;
    const endpoint = await getOutboundWebhookEndpoint(
      bundle.db,
      access.tenantId,
      c.req.param("id"),
    );
    if (!endpoint) return apiError(c, 404, "NOT_FOUND", "Outbound webhook not found");
    const limitRaw = Number(c.req.query("limit"));
    const rows = await listOutboundWebhookDeliveries(
      bundle.db,
      access.tenantId,
      endpoint.id,
      Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20,
    );
    const body = OutboundWebhookDeliveryListResponseSchema.parse({
      deliveries: rows.map(serializeOutboundWebhookDelivery),
    });
    return c.json(body);
  });

  app.post(`${base}/:id/test`, async (c) => {
    const access = await requireManager(c);
    if ("error" in access) return access.error;
    if (!deps.channelTokenSecret) {
      return apiError(c, 503, "INTERNAL_ERROR", "Webhook signing is not configured");
    }
    const delivery = await sendOutboundWebhookTestEvent(
      bundle.db,
      { tenantId: access.tenantId, userId: access.userId },
      { encryptionSecret: deps.channelTokenSecret },
      c.req.param("id"),
    );
    if (!delivery) return apiError(c, 404, "NOT_FOUND", "Outbound webhook not found");
    return c.json(serializeOutboundWebhookDelivery(delivery));
  });

  return app;
}
