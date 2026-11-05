import { Hono } from "hono";
import {
  AuditLogListQuerySchema,
  AuditLogListResponseSchema,
  AuditLogResponseSchema,
  type AuditLogResponse,
} from "@sahabat-kreator/contracts";
import {
  isPlatformAdminEmail,
  listPlatformAuditLogs,
  listTenantAuditLogs,
  type AuditLogEntry,
  type ListAuditLogsInput,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";

export interface AuditRoutesOptions {
  /** Allowlist mentah env PLATFORM_ADMIN_EMAILS (koma-terpisah). */
  platformAdminEmails?: string;
}

function serializeEntry(entry: AuditLogEntry): AuditLogResponse {
  return AuditLogResponseSchema.parse({
    id: entry.id,
    tenantId: entry.tenantId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    actorLabel: entry.actorLabel,
    action: entry.action,
    category: entry.category,
    target: entry.target,
    meta: entry.meta,
    createdAt: entry.createdAt.toISOString(),
  });
}

function toListInput(
  query: ReturnType<typeof AuditLogListQuerySchema.parse>,
): ListAuditLogsInput {
  return {
    actorType: query.actorType,
    category: query.category,
    q: query.q,
    from: query.from,
    to: query.to,
    cursor: query.cursor,
    limit: query.limit,
  };
}

/**
 * Modul penelusur log audit (Fase 7B.4) — pembacaan `audit_logs`
 * (murni baca; penulisan audit tetap milik fitur-fitur penulisnya):
 *   GET /tenants/:tenantId/audit   daftar audit tenant aktif
 *   GET /audit/platform            baris tingkat platform (tenant NULL)
 *
 * AKSES (selaras log integrasi 7B.1 — meta audit menyangkut operasi
 * workspace, termasuk isi referensi aksi agent & API key):
 * - Route tenant: sesi + membership; non-member 404 TENANT_NOT_FOUND;
 *   membaca dibatasi role OWNER/ADMIN — member biasa 403 FORBIDDEN.
 * - Route platform: baris tenant-NULL (aksi `platform_settings.*`)
 *   hanya untuk sesi PLATFORM ADMIN (allowlist env); non-admin 404
 *   NOT_FOUND agar eksistensinya tidak dibocorkan (pola 6C/7B.1).
 *   Baris platform tidak pernah tercampur ke daftar tenant mana pun.
 */
export function createAuditRoutes(
  bundle: AuthBundle | null,
  opts: AuditRoutesOptions = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();

  if (!bundle) {
    app.get("/tenants/:tenantId/audit", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/audit/platform", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  const auth = requireAuth(bundle);
  app.use("/tenants/*", auth);
  app.use("/audit/*", auth);

  app.get("/tenants/:tenantId/audit", async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId"),
      appUser.id,
    );
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only workspace owners and admins can view the audit log",
      );
    }
    const parsed = AuditLogListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid audit list query");
    }
    const page = await listTenantAuditLogs(
      bundle.db,
      tenant.id,
      toListInput(parsed.data),
    );
    const body = AuditLogListResponseSchema.parse({
      entries: page.entries.map(serializeEntry),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  app.get("/audit/platform", async (c) => {
    const appUser = c.get("appUser");
    if (!isPlatformAdminEmail(appUser.email, opts.platformAdminEmails)) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }
    const parsed = AuditLogListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid audit list query");
    }
    const page = await listPlatformAuditLogs(
      bundle.db,
      toListInput(parsed.data),
    );
    const body = AuditLogListResponseSchema.parse({
      entries: page.entries.map(serializeEntry),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  return app;
}
