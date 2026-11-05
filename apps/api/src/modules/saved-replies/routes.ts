import { Hono } from "hono";
import { z } from "zod";
import {
  CreateSavedReplyRequestSchema,
  SavedReplyListResponseSchema,
  SavedReplyResponseSchema,
  UpdateSavedReplyRequestSchema,
  type SavedReplyResponse,
} from "@sahabat-kreator/contracts";
import {
  createSavedReply,
  deleteSavedReply,
  listSavedReplies,
  updateSavedReply,
  type SavedReply,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul saved-replies (Fase 9A) — macro balasan tersimpan workspace:
 *   GET    /tenants/:tenantId/saved-replies        daftar (semua member)
 *   POST   /tenants/:tenantId/saved-replies        buat (semua member)
 *   PATCH  /tenants/:tenantId/saved-replies/:id    edit (pembuat/owner/admin)
 *   DELETE /tenants/:tenantId/saved-replies/:id    hapus (pembuat/owner/admin)
 *
 * AKSES: pustaka balasan adalah milik bersama workspace — baca & buat
 * untuk semua member; gerbang edit/hapus per baris (pembuat ATAU
 * owner/admin) ditegakkan di core (`saved-replies.ts`), route hanya
 * memetakan hasilnya: forbidden → 403, tidak ada → 404. Non-member
 * selalu 404 TENANT_NOT_FOUND agar eksistensi tenant tidak bocor.
 * Audit saved_reply.* ditulis core dalam transaksi yang sama.
 */
function serializeSavedReply(reply: SavedReply): SavedReplyResponse {
  return SavedReplyResponseSchema.parse({
    id: reply.id,
    title: reply.title,
    body: reply.body,
    createdByUserId: reply.createdByUserId,
    createdAt: reply.createdAt.toISOString(),
    updatedAt: reply.updatedAt.toISOString(),
  });
}

export function createSavedRepliesRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/saved-replies";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
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
  async function guard(c: AppContext): Promise<GuardOk | { error: Response }> {
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
    return { tenant, appUser: { id: appUser.id } };
  }

  function parseUuidParam(c: AppContext, name: string): string | null {
    const id = c.req.param(name);
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  async function readJson(c: AppContext): Promise<unknown | { error: Response }> {
    try {
      return await c.req.json();
    } catch {
      return {
        error: apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON"),
      };
    }
  }

  // ---- Daftar ---------------------------------------------------------------
  app.get(base, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    const replies = await listSavedReplies(bundle.db, {
      tenantId: g.tenant.id,
    });
    const body = SavedReplyListResponseSchema.parse({
      replies: replies.map(serializeSavedReply),
    });
    return c.json(body);
  });

  // ---- Buat -----------------------------------------------------------------
  app.post(base, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (typeof json === "object" && json !== null && "error" in json) {
      return (json as { error: Response }).error;
    }
    const parsed = CreateSavedReplyRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid saved reply payload");
    }
    const reply = await createSavedReply(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      title: parsed.data.title,
      body: parsed.data.body,
    });
    return c.json(serializeSavedReply(reply), 201);
  });

  // ---- Edit -----------------------------------------------------------------
  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Saved reply not found");
    const json = await readJson(c);
    if (typeof json === "object" && json !== null && "error" in json) {
      return (json as { error: Response }).error;
    }
    const parsed = UpdateSavedReplyRequestSchema.safeParse(json);
    if (
      !parsed.success ||
      (parsed.data.title === undefined && parsed.data.body === undefined)
    ) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid saved reply payload");
    }
    const result = await updateSavedReply(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      role: g.tenant.role,
      id,
      title: parsed.data.title,
      body: parsed.data.body,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Saved reply not found");
    }
    if (result.kind === "forbidden") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only the author or a workspace owner/admin can edit this saved reply",
      );
    }
    return c.json(serializeSavedReply(result.reply));
  });

  // ---- Hapus ----------------------------------------------------------------
  app.delete(`${base}/:id`, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Saved reply not found");
    const result = await deleteSavedReply(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      role: g.tenant.role,
      id,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Saved reply not found");
    }
    if (result.kind === "forbidden") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only the author or a workspace owner/admin can delete this saved reply",
      );
    }
    return c.body(null, 204);
  });

  return app;
}
