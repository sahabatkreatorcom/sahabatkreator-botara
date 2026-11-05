import { Hono } from "hono";
import { z } from "zod";
import {
  CreateSegmentRequestSchema,
  SegmentListResponseSchema,
  SegmentPreviewRequestSchema,
  SegmentPreviewResponseSchema,
  SegmentResponseSchema,
  UpdateSegmentRequestSchema,
  type SegmentResponse,
} from "@sahabat-kreator/contracts";
import {
  countSegmentMembers,
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  updateSegment,
} from "@sahabat-kreator/core";
import type { Segment } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul segments (Fase 13C) — segmen audiens per workspace:
 *   GET    /tenants/:tenantId/segments          daftar (semua member)
 *   POST   /tenants/:tenantId/segments          buat (owner/admin)
 *   POST   /tenants/:tenantId/segments/preview  hitung anggota definisi
 *   GET    /tenants/:tenantId/segments/:id      detail (semua member)
 *   PATCH  /tenants/:tenantId/segments/:id      edit (owner/admin)
 *   DELETE /tenants/:tenantId/segments/:id      hapus (owner/admin)
 *
 * Keanggotaan TIDAK disimpan: selalu diturunkan evaluator tunggal
 * core dari definisi saat dibaca (daftar kontak ?segmentId=,
 * pratinjau & dispatch broadcast memakai jalur yang sama). Segmen
 * yang dihapus sementara dirujuk filter broadcast lama membuat
 * audiensnya kosong saat dispatch (broadcast gagal AUDIENCE_EMPTY) —
 * tidak ada penghapusan diam-diam ke audiens lain.
 */

export function serializeSegment(row: Segment): SegmentResponse {
  return SegmentResponseSchema.parse({
    id: row.id,
    name: row.name,
    definition: row.definition,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function createSegmentsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/segments";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.post(`${base}/preview`, unavailable);
    app.get(`${base}/:id`, unavailable);
    app.patch(`${base}/:id`, unavailable);
    app.delete(`${base}/:id`, unavailable);
    return app;
  }

  const auth = requireAuth(bundle);
  app.use("/tenants/*", auth);

  type GuardOk = {
    tenant: NonNullable<Awaited<ReturnType<typeof resolveTenantForUser>>>;
    appUser: { id: string };
  };
  async function guard(
    c: AppContext,
    opts: { ownerAdmin: boolean },
  ): Promise<GuardOk | { error: Response }> {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle!,
      c.req.param("tenantId") ?? "",
      appUser.id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      };
    }
    if (opts.ownerAdmin && tenant.role !== "owner" && tenant.role !== "admin") {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage segments",
        ),
      };
    }
    return { tenant, appUser: { id: appUser.id } };
  }

  function parseSegmentId(c: AppContext): string | null {
    const id = c.req.param("id");
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  async function readJson(c: AppContext): Promise<unknown | null> {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  }

  app.get(base, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const rows = await listSegments(bundle.db, g.tenant.id);
    return c.json(
      SegmentListResponseSchema.parse({
        segments: rows.map(serializeSegment),
      }),
    );
  });

  app.post(base, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateSegmentRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid segment payload");
    }
    const row = await createSegment(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      name: parsed.data.name,
      definition: parsed.data.definition,
    });
    return c.json(serializeSegment(row), 201);
  });

  // Pratinjau hitungan untuk definisi draf — didaftarkan sebelum "/:id".
  app.post(`${base}/preview`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = SegmentPreviewRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid segment definition");
    }
    const count = await countSegmentMembers(
      bundle.db,
      g.tenant.id,
      parsed.data.definition,
    );
    return c.json(SegmentPreviewResponseSchema.parse({ count }));
  });

  app.get(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseSegmentId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Segment not found");
    const row = await getSegment(bundle.db, g.tenant.id, id);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Segment not found");
    return c.json(serializeSegment(row));
  });

  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseSegmentId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Segment not found");
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateSegmentRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid segment payload");
    }
    const result = await updateSegment(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      segmentId: id,
      patch: parsed.data,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Segment not found");
    }
    return c.json(serializeSegment(result.segment));
  });

  app.delete(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseSegmentId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Segment not found");
    const result = await deleteSegment(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      segmentId: id,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Segment not found");
    }
    return c.body(null, 204);
  });

  return app;
}
