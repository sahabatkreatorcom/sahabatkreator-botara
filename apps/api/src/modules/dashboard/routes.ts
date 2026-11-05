import { Hono } from "hono";
import { DashboardSummaryResponseSchema } from "@sahabat-kreator/contracts";
import { getDashboardSummary } from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul dashboard (Fase 16A) — ringkasan live workspace:
 *   GET /tenants/:tenantId/dashboard/summary
 * Baca untuk SEMUA member workspace (non-member → 404 TENANT_NOT_FOUND,
 * pola yang sama dengan modul lain). Semua angka dihitung di core
 * (`getDashboardSummary`) dalam satu transaksi tenant RLS — semantik
 * kejujuran tiap angka ada di kontrak DashboardSummaryResponseSchema.
 */
export function createDashboardRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/dashboard/summary";

  if (!bundle) {
    app.get(base, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }


  app.get(base, async (c) => {
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId"),
      c.get("appUser").id,
    );
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const summary = await getDashboardSummary(bundle.db, {
      tenantId: tenant.id,
    });
    return c.json(DashboardSummaryResponseSchema.parse(summary));
  });

  return app;
}
