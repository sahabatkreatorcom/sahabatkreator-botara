import { Hono } from "hono";
import { z } from "zod";
import {
  MemberWorkScheduleResponseSchema,
  TenantSlaSettingsResponseSchema,
  UpdateMemberWorkScheduleRequestSchema,
  UpdateTenantSlaSettingsRequestSchema,
  type MemberWorkScheduleResponse,
} from "@sahabat-kreator/contracts";
import {
  deleteMemberWorkSchedule,
  getMemberWorkSchedule,
  getTenantSlaSettings,
  listTeamMembers,
  updateTenantSlaSettings,
  upsertMemberWorkSchedule,
  type MemberWorkScheduleView,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul SLA & jam kerja (G15):
 *   GET    /tenants/:tenantId/team/members/:userId/work-schedule   jadwal anggota (semua member)
 *   PUT    /tenants/:tenantId/team/members/:userId/work-schedule   simpan (diri sendiri / owner-admin)
 *   DELETE /tenants/:tenantId/team/members/:userId/work-schedule   hapus → jatuh ke jadwal bawaan tenant
 *   GET    /tenants/:tenantId/sla/settings                         target + jadwal bawaan (semua member)
 *   PATCH  /tenants/:tenantId/sla/settings                         ubah (owner/admin)
 *
 * Gerbang tulis jadwal ditegakkan di core (aktor member; orang lain
 * hanya owner/admin) — route hanya memetakan hasilnya. Pengaturan
 * tenant digerbang di sini (owner/admin) mengikuti pola modul deals.
 * Definisi yang diukur: lihat contracts/sla.ts.
 */
export function createSlaRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const scheduleBase =
    "/tenants/:tenantId/team/members/:userId/work-schedule";
  const settingsBase = "/tenants/:tenantId/sla/settings";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(scheduleBase, unavailable);
    app.put(scheduleBase, unavailable);
    app.delete(scheduleBase, unavailable);
    app.get(settingsBase, unavailable);
    app.patch(settingsBase, unavailable);
    return app;
  }

  const guard = async (
    c: AppContext,
    level: "member" | "manager",
  ): Promise<
    | { tenant: NonNullable<Awaited<ReturnType<typeof resolveTenantForUser>>>; userId: string }
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
          "Only workspace owners and admins can change SLA settings",
        ),
      };
    }
    return { tenant, userId: appUser.id };
  };

  const parseJson = async (
    c: AppContext,
  ): Promise<{ json: unknown } | { error: ReturnType<typeof apiError> }> => {
    try {
      return { json: await c.req.json() };
    } catch {
      return {
        error: apiError(
          c,
          400,
          "VALIDATION_ERROR",
          "Request body must be valid JSON",
        ),
      };
    }
  };

  const targetUserId = (c: AppContext): string | null => {
    const value = c.req.param("userId") ?? "";
    return z.string().uuid().safeParse(value).success ? value : null;
  };

  const serializeSchedule = (
    view: MemberWorkScheduleView,
  ): MemberWorkScheduleResponse =>
    MemberWorkScheduleResponseSchema.parse({
      userId: view.userId,
      timezone: view.timezone,
      schedule: view.schedule,
      updatedAt: view.updatedAt?.toISOString() ?? null,
    });

  app.get(scheduleBase, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const userId = targetUserId(c);
    if (!userId) {
      return apiError(c, 404, "MEMBER_NOT_FOUND", "Team member not found");
    }
    const members = await listTeamMembers(bundle.db, {
      tenantId: g.tenant.id,
    });
    if (!members.some((m) => m.userId === userId)) {
      return apiError(c, 404, "MEMBER_NOT_FOUND", "Team member not found");
    }
    const view = await getMemberWorkSchedule(
      bundle.db,
      { tenantId: g.tenant.id },
      userId,
    );
    return c.json(serializeSchedule(view));
  });

  app.put(scheduleBase, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const userId = targetUserId(c);
    if (!userId) {
      return apiError(c, 404, "MEMBER_NOT_FOUND", "Team member not found");
    }
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = UpdateMemberWorkScheduleRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Invalid work schedule payload",
      );
    }
    const result = await upsertMemberWorkSchedule(
      bundle.db,
      { tenantId: g.tenant.id, userId: g.userId },
      {
        targetUserId: userId,
        timezone: parsed.data.timezone,
        schedule: parsed.data.schedule,
      },
    );
    if (result.kind === "forbidden") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "You can only edit your own work schedule",
      );
    }
    if (result.kind === "member_not_found") {
      return apiError(c, 404, "MEMBER_NOT_FOUND", "Team member not found");
    }
    return c.json(serializeSchedule(result.view));
  });

  app.delete(scheduleBase, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const userId = targetUserId(c);
    if (!userId) {
      return apiError(c, 404, "MEMBER_NOT_FOUND", "Team member not found");
    }
    const result = await deleteMemberWorkSchedule(
      bundle.db,
      { tenantId: g.tenant.id, userId: g.userId },
      userId,
    );
    if (result.kind === "forbidden") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "You can only edit your own work schedule",
      );
    }
    if (result.kind === "member_not_found") {
      return apiError(c, 404, "MEMBER_NOT_FOUND", "Team member not found");
    }
    return c.body(null, 204);
  });

  app.get(settingsBase, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const settings = await getTenantSlaSettings(bundle.db, {
      tenantId: g.tenant.id,
    });
    return c.json(TenantSlaSettingsResponseSchema.parse(settings));
  });

  app.patch(settingsBase, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = UpdateTenantSlaSettingsRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Invalid SLA settings payload",
      );
    }
    const updated = await updateTenantSlaSettings(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      targetMinutes: parsed.data.targetMinutes,
      defaultSchedule: parsed.data.defaultSchedule,
    });
    if (!updated) {
      return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    }
    return c.json(TenantSlaSettingsResponseSchema.parse(updated));
  });

  return app;
}
