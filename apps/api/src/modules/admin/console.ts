import type { Hono } from "hono";
import {
  DeadLetterOutboxListResponseSchema,
  PlatformOverviewResponseSchema,
  PlatformSystemResponseSchema,
  PlatformTenantDetailResponseSchema,
  PlatformTenantListResponseSchema,
  PlatformUserListResponseSchema,
  RetryOutboxResponseSchema,
  RevokeSessionsResponseSchema,
  SetPlatformTenantStatusRequestSchema,
  SetPlatformTenantStatusResponseSchema,
} from "@sahabat-kreator/contracts";
import {
  getPlatformOverview,
  getPlatformSystemStats,
  getPlatformTenant,
  listDeadLetterOutbox,
  listPlatformTenants,
  retryDeadLetterOutbox,
  revokePlatformUserSessions,
  searchPlatformUsers,
  setPlatformTenantStatus,
} from "@sahabat-kreator/core";
import { z } from "zod";
import { APP_VERSION } from "@sahabat-kreator/config";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";

/**
 * Konsol Admin Platform — didaftarkan KE DALAM app admin yang sudah punya
 * dua gerbang (sesi + allowlist email), jadi berkas ini tidak memasang
 * middleware sendiri. Kalau gerbang itu dipindah, seluruh route di sini
 * ikut terbuka — karena itu pemanggilnya sengaja hanya satu: createAdminRoutes.
 */

type AdminApp = Hono<{ Variables: AppVariables }>;

const TenantIdParam = z.string().uuid();
const UserIdParam = z.string().uuid();
const OutboxIdParam = z.string().uuid();

/**
 * Baris tenant dari core memakai `Date`; kontrak mengirim ISO string.
 * Tipe parameter sengaja struktural (bukan nama tipe dari kontrak) supaya
 * tidak tertukar dengan bentuk respons yang sudah diserialisasi.
 */
function toTenantRow(row: {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  statusReason: string | null;
  createdAt: Date;
  members: number;
  channels: number;
  channelsConnected: number;
  messages7d: number;
  planCode: string | null;
  subscriptionStatus: string | null;
}) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    statusReason: row.statusReason,
    createdAt: row.createdAt.toISOString(),
    members: row.members,
    channels: row.channels,
    channelsConnected: row.channelsConnected,
    messages7d: row.messages7d,
    planCode: row.planCode,
    subscriptionStatus: row.subscriptionStatus,
  };
}

export function registerAdminConsoleRoutes(
  app: AdminApp,
  bundle: AuthBundle,
): void {
  app.get("/admin/overview", async (c) => {
    const overview = await getPlatformOverview(bundle.db);
    return c.json(PlatformOverviewResponseSchema.parse(overview));
  });

  app.get("/admin/tenants", async (c) => {
    const rawLimit = Number(c.req.query("limit") ?? 25);
    const rawOffset = Number(c.req.query("offset") ?? 0);
    const statusParam = c.req.query("status");
    const status =
      statusParam === "active" || statusParam === "suspended"
        ? statusParam
        : undefined;

    const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
    const offset = Number.isFinite(rawOffset) ? rawOffset : 0;

    const { rows, total } = await listPlatformTenants(bundle.db, {
      query: c.req.query("q"),
      status,
      limit,
      offset,
    });

    return c.json(
      PlatformTenantListResponseSchema.parse({
        rows: rows.map(toTenantRow),
        total,
        limit: Math.min(Math.max(limit, 1), 100),
        offset: Math.max(offset, 0),
      }),
    );
  });

  app.get("/admin/tenants/:tenantId", async (c) => {
    const parsed = TenantIdParam.safeParse(c.req.param("tenantId"));
    if (!parsed.success) return apiError(c, 404, "NOT_FOUND", "Not found");

    const detail = await getPlatformTenant(bundle.db, parsed.data);
    if (!detail) return apiError(c, 404, "NOT_FOUND", "Not found");

    return c.json(
      PlatformTenantDetailResponseSchema.parse({
        tenant: toTenantRow(detail.tenant),
        members: detail.members.map((m) => ({
          userId: m.userId,
          email: m.email,
          name: m.name,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        })),
        channels: detail.channels,
        counts: detail.counts,
        recentAudit: detail.recentAudit.map((a) => ({
          id: a.id,
          action: a.action,
          actorType: a.actorType,
          actorId: a.actorId,
          createdAt: a.createdAt.toISOString(),
        })),
      }),
    );
  });

  app.patch("/admin/tenants/:tenantId", async (c) => {
    const parsed = TenantIdParam.safeParse(c.req.param("tenantId"));
    if (!parsed.success) return apiError(c, 404, "NOT_FOUND", "Not found");

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const body = SetPlatformTenantStatusRequestSchema.safeParse(json);
    if (!body.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid status payload");
    }

    try {
      const result = await setPlatformTenantStatus(bundle.db, {
        tenantId: parsed.data,
        status: body.data.status,
        reason: body.data.reason ?? null,
        actorUserId: c.get("appUser").id,
      });
      return c.json(SetPlatformTenantStatusResponseSchema.parse(result));
    } catch (err) {
      if (err instanceof Error && err.message === "TENANT_NOT_FOUND") {
        return apiError(c, 404, "NOT_FOUND", "Not found");
      }
      throw err;
    }
  });

  app.get("/admin/users", async (c) => {
    const query = c.req.query("q") ?? "";
    const rows = await searchPlatformUsers(bundle.db, query);
    return c.json(
      PlatformUserListResponseSchema.parse({
        rows: rows.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          createdAt: u.createdAt.toISOString(),
          memberships: u.memberships,
          activeSessions: u.activeSessions,
        })),
        tooShort: query.trim().length < 2,
      }),
    );
  });

  app.post("/admin/users/:userId/sessions/revoke", async (c) => {
    const parsed = UserIdParam.safeParse(c.req.param("userId"));
    if (!parsed.success) return apiError(c, 404, "NOT_FOUND", "Not found");

    try {
      const result = await revokePlatformUserSessions(bundle.db, {
        userId: parsed.data,
        actorUserId: c.get("appUser").id,
      });
      return c.json(RevokeSessionsResponseSchema.parse(result));
    } catch (err) {
      if (err instanceof Error && err.message === "USER_NOT_FOUND") {
        return apiError(c, 404, "NOT_FOUND", "Not found");
      }
      throw err;
    }
  });

  app.get("/admin/operations/outbox", async (c) => {
    const rows = await listDeadLetterOutbox(bundle.db, 50);
    return c.json(
      DeadLetterOutboxListResponseSchema.parse({
        rows: rows.map((r) => ({
          id: r.id,
          type: r.type,
          tenantId: r.tenantId,
          tenantName: r.tenantName,
          attempts: r.attempts,
          lastError: r.lastError,
          deadLetteredAt: r.deadLetteredAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
      }),
    );
  });

  app.post("/admin/operations/outbox/:id/retry", async (c) => {
    const parsed = OutboxIdParam.safeParse(c.req.param("id"));
    if (!parsed.success) return apiError(c, 404, "NOT_FOUND", "Not found");

    const result = await retryDeadLetterOutbox(bundle.db, {
      id: parsed.data,
      actorUserId: c.get("appUser").id,
    });
    return c.json(RetryOutboxResponseSchema.parse(result));
  });

  app.get("/admin/system", async (c) => {
    const stats = await getPlatformSystemStats(bundle.db);
    return c.json(
      PlatformSystemResponseSchema.parse({
        app: {
          version: APP_VERSION,
          buildSha: process.env.BUILD_SHA?.slice(0, 40) ?? null,
          uptimeSeconds: Math.round(process.uptime()),
          nodeVersion: process.version,
          environment: process.env.NODE_ENV ?? "development",
        },
        database: {
          size: stats.databaseSize,
          serverVersion: stats.serverVersion,
          serverTime: stats.serverTime,
        },
        tables: stats.tables,
      }),
    );
  });
}
