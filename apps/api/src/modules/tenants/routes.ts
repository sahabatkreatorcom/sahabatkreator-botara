import { Hono } from "hono";
import { z } from "zod";
import {
  CreateTenantRequestSchema,
  TenantListResponseSchema,
  TenantResponseSchema,
  type TenantResponse,
} from "@sahabat-kreator/contracts";
import {
  createTenant,
  getTenantForUser,
  listTenantsForUser,
  type TenantWithRole,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";

function serializeTenant(t: TenantWithRole): TenantResponse {
  return TenantResponseSchema.parse({
    id: t.id,
    name: t.name,
    slug: t.slug,
    defaultLocale: t.defaultLocale,
    timezone: t.timezone,
    role: t.role,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  });
}

/**
 * Modul tenants (Fase 1B):
 * - POST /tenants        buat workspace; pembuat menjadi owner (+audit log).
 * - GET  /tenants        daftar workspace milik user login.
 * - GET  /tenants/:id    detail hanya untuk member; non-member → 404
 *                        (TENANT_NOT_FOUND, eksistensi tidak dibocorkan).
 * Semua handler butuh sesi (requireAuth). Query tenant lewat core yang
 * memakai konteks RLS app.tenant_id / app.user_id sesuai kebutuhan.
 */
export function createTenantsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();

  if (!bundle) {
    // Mode tanpa DB (Fase 0 lokal): kontrak tetap dijawab, dengan 503.
    app.post("/tenants", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tenants", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tenants/:id", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }


  app.post("/tenants", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateTenantRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid tenant payload");
    }
    const appUser = c.get("appUser");
    const tenant = await createTenant(bundle.db, {
      userId: appUser.id,
      name: parsed.data.name,
    });
    return c.json(serializeTenant(tenant), 201);
  });

  app.get("/tenants", async (c) => {
    const appUser = c.get("appUser");
    const rows = await listTenantsForUser(bundle.db, appUser.id);
    const body = TenantListResponseSchema.parse({
      tenants: rows.map(serializeTenant),
    });
    return c.json(body);
  });

  app.get("/tenants/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    }
    const appUser = c.get("appUser");
    const tenant = await getTenantForUser(bundle.db, {
      tenantId: id,
      userId: appUser.id,
    });
    if (!tenant) {
      return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    }
    return c.json(serializeTenant(tenant));
  });

  return app;
}
