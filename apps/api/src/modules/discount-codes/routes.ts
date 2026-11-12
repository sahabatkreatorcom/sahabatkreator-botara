import { Hono } from "hono";
import { z } from "zod";
import {
  CreateDiscountCodeRequestSchema,
  DiscountCodeListResponseSchema,
  DiscountCodeResponseSchema,
  UpdateDiscountCodeRequestSchema,
  type DiscountCodeResponse,
} from "@sahabat-kreator/contracts";
import {
  createDiscountCode,
  getDiscountCode,
  listDiscountCodes,
  updateDiscountCode,
  type DiscountCodeWithStats,
  type TenantWithRole,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul discount-codes (G14) — kode diskon & penukaran chat commerce:
 *   GET    /tenants/:tenantId/discount-codes        daftar + statistik penukaran (semua member)
 *   POST   /tenants/:tenantId/discount-codes        buat kode → 201 (owner/admin)
 *   GET    /tenants/:tenantId/discount-codes/:id    satu kode + statistik (semua member)
 *   PATCH  /tenants/:tenantId/discount-codes/:id    ubah nilai/batas/jendela/status (owner/admin)
 *
 * Kode diskon memengaruhi uang yang dibayar pelanggan, jadi
 * pengelolaannya setingkat pengaturan (owner/admin — pola gerbang
 * deals); membaca cukup member. Teks kode TIDAK bisa diubah lewat
 * PATCH (kontrak memang tidak memuatnya). Tidak ada DELETE: kode
 * dinonaktifkan, riwayat penukarannya adalah jejak audit commerce.
 * Non-member selalu 404 TENANT_NOT_FOUND (pola Fase 1B).
 */

export function serializeDiscountCode(
  row: DiscountCodeWithStats,
): DiscountCodeResponse {
  return DiscountCodeResponseSchema.parse({
    id: row.id,
    code: row.code,
    kind: row.kind,
    value: row.value,
    minOrderIdr: row.minOrderIdr,
    maxRedemptions: row.maxRedemptions,
    maxPerContact: row.maxPerContact,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    isActive: row.isActive,
    redemptionCount: row.redemptionCount,
    releasedCount: row.releasedCount,
    totalDiscountIdr: row.totalDiscountIdr,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

type GuardResult =
  | { tenant: TenantWithRole; userId: string }
  | { error: ReturnType<typeof apiError> };

export function createDiscountCodesRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/discount-codes";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.get(`${base}/:id`, unavailable);
    app.patch(`${base}/:id`, unavailable);
    return app;
  }

  const guard = async (
    c: AppContext,
    level: "member" | "manager",
  ): Promise<GuardResult> => {
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
    if (
      level === "manager" &&
      tenant.role !== "owner" &&
      tenant.role !== "admin"
    ) {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage discount codes",
        ),
      };
    }
    return { tenant, userId: appUser.id };
  };

  const parseJson = async (c: AppContext): Promise<unknown | null> => {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  };

  app.get(base, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const rows = await listDiscountCodes(bundle.db, {
      tenantId: g.tenant.id,
    });
    return c.json(
      DiscountCodeListResponseSchema.parse({
        discountCodes: rows.map(serializeDiscountCode),
      }),
    );
  });

  app.post(base, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const json = await parseJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateDiscountCodeRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid discount code payload");
    }
    const result = await createDiscountCode(
      bundle.db,
      { tenantId: g.tenant.id },
      parsed.data,
      { actorType: "user", actorId: g.userId },
    );
    if (result.kind === "duplicate") {
      return apiError(
        c,
        409,
        "DISCOUNT_CODE_DUPLICATE",
        "A discount code with this text already exists in this workspace",
      );
    }
    return c.json(serializeDiscountCode(result.code), 201);
  });

  app.get(`${base}/:id`, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "DISCOUNT_CODE_NOT_FOUND", "Discount code not found");
    }
    const row = await getDiscountCode(bundle.db, { tenantId: g.tenant.id }, id);
    if (!row) {
      return apiError(c, 404, "DISCOUNT_CODE_NOT_FOUND", "Discount code not found");
    }
    return c.json(serializeDiscountCode(row));
  });

  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "DISCOUNT_CODE_NOT_FOUND", "Discount code not found");
    }
    const json = await parseJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateDiscountCodeRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid discount code payload");
    }
    const updated = await updateDiscountCode(
      bundle.db,
      { tenantId: g.tenant.id },
      id,
      parsed.data,
      { actorType: "user", actorId: g.userId },
    );
    if (!updated) {
      return apiError(c, 404, "DISCOUNT_CODE_NOT_FOUND", "Discount code not found");
    }
    return c.json(serializeDiscountCode(updated));
  });

  return app;
}
