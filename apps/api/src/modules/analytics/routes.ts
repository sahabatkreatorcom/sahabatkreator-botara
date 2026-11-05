import { Hono } from "hono";
import { z } from "zod";
import { AiUsageReportResponseSchema } from "@sahabat-kreator/contracts";
import { getAiUsageReport } from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

const AiUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/**
 * Modul analitik (Fase 9B) — dasbor pemakaian AI:
 *   GET /tenants/:tenantId/analytics/ai-usage?days=30
 * Baca untuk SEMUA member workspace (non-member → 404 TENANT_NOT_FOUND,
 * pola yang sama dengan modul lain). Agregasi murni dari usage_ledger
 * type='ai_token' di core (`getAiUsageReport`) — termasuk pemakaian cap
 * harian agent. Angka biaya adalah biaya aktual terlapor provider;
 * lihat kontrak AiUsageReportResponseSchema untuk semantik kejujurannya.
 */
export function createAnalyticsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/analytics/ai-usage";

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
    const query = AiUsageQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const report = await getAiUsageReport(
      bundle.db,
      { tenantId: tenant.id },
      { days: query.data.days },
    );
    return c.json(AiUsageReportResponseSchema.parse(report));
  });

  return app;
}
