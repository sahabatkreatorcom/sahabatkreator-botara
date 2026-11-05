import { Hono } from "hono";
import {
  ApiKeyListResponseSchema,
  ApiKeyResponseSchema,
  CreatedApiKeyResponseSchema,
  CreateApiKeyRequestSchema,
  API_KEY_DEFAULT_SCOPES,
  type ApiKeyResponse,
} from "@sahabat-kreator/contracts";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@sahabat-kreator/core";
import type { ApiKey } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";

export function serializeApiKey(row: ApiKey): ApiKeyResponse {
  return ApiKeyResponseSchema.parse({
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Modul manajemen API keys (Fase 5A) — route bersarang di workspace:
 *   POST   /tenants/:tenantId/api-keys       buat kunci → 201 {key utuh SEKALI, ...}
 *   GET    /tenants/:tenantId/api-keys       daftar (tanpa nilai utuh)
 *   DELETE /tenants/:tenantId/api-keys/:id   cabut (soft revoke) → 204
 * Wajib sesi + membership (non-member → 404 TENANT_NOT_FOUND, pola Fase 1B).
 * Membuat & mencabut dibatasi role owner/admin (member agent/viewer → 403
 * FORBIDDEN); membaca daftar boleh semua member. Logika di @sahabat-kreator/core.
 */
export function createApiKeysRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/api-keys";

  if (!bundle) {
    app.post(base, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(base, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.delete(`${base}/:id`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    return app;
  }

  const auth = requireAuth(bundle);
  app.use("/tenants/*", auth);

  app.post(base, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can create API keys");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateApiKeyRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid API key payload");
    }
    const scopes = parsed.data.scopes ?? [...API_KEY_DEFAULT_SCOPES];
    const created = await createApiKey(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      { name: parsed.data.name, scopes },
    );
    const body = CreatedApiKeyResponseSchema.parse({
      ...serializeApiKey(created.row),
      key: created.fullKey,
    });
    return c.json(body, 201);
  });

  app.get(base, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listApiKeys(bundle.db, { tenantId: tenant.id });
    const body = ApiKeyListResponseSchema.parse({
      apiKeys: rows.map(serializeApiKey),
    });
    return c.json(body);
  });

  app.delete(`${base}/:id`, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can revoke API keys");
    }
    const revoked = await revokeApiKey(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      c.req.param("id"),
    );
    if (!revoked) return apiError(c, 404, "NOT_FOUND", "API key not found");
    return c.body(null, 204);
  });

  return app;
}
