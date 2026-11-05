import { Hono } from "hono";
import { z } from "zod";
import {
  AutomationListResponseSchema,
  AutomationResponseSchema,
  AutomationRunListResponseSchema,
  AutomationRunResponseSchema,
  CreateAutomationRequestSchema,
  SequenceEnrollmentListResponseSchema,
  SequenceEnrollmentResponseSchema,
  UpdateAutomationRequestSchema,
  type AutomationResponse,
  type AutomationRunResponse,
  type SequenceEnrollmentResponse,
} from "@sahabat-kreator/contracts";
import {
  createAutomation,
  getChannelAccount,
  listAutomationRuns,
  listAutomations,
  listSequenceEnrollments,
  updateAutomation,
  type AutomationWithRunCount,
  type SequenceEnrollmentWithTotal,
} from "@sahabat-kreator/core";
import type { AutomationRun } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

export function serializeAutomation(row: AutomationWithRunCount): AutomationResponse {
  return AutomationResponseSchema.parse({
    id: row.id,
    name: row.name,
    triggerType: row.triggerType,
    kind: row.kind,
    keywords: row.triggerConfig.keywords,
    match: row.triggerConfig.match,
    actionType: row.actionType,
    text: row.actionConfig.text,
    // Fase 10B: field aturan komentar; aturan pesan mendapat default
    // aman (akun null, semua aksi mati).
    channelAccountId: row.triggerConfig.channelAccountId ?? null,
    sendDm: row.actionConfig.sendDm ?? false,
    publicReplyText: row.actionConfig.publicReplyText ?? null,
    hideComment: row.actionConfig.hideComment ?? false,
    steps: row.steps.map((s) => ({
      position: s.position,
      delayMinutes: s.delayMinutes,
      text: s.text,
    })),
    stepCount: row.stepCount,
    isActive: row.isActive,
    runCount: row.runCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function serializeEnrollment(
  row: SequenceEnrollmentWithTotal,
): SequenceEnrollmentResponse {
  return SequenceEnrollmentResponseSchema.parse({
    id: row.id,
    automationId: row.automationId,
    contactId: row.contactId,
    conversationId: row.conversationId,
    triggerMessageId: row.triggerMessageId,
    status: row.status,
    currentStep: row.currentStep,
    totalSteps: row.totalSteps,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function serializeRun(row: AutomationRun): AutomationRunResponse {
  return AutomationRunResponseSchema.parse({
    id: row.id,
    automationId: row.automationId,
    contactId: row.contactId,
    conversationId: row.conversationId,
    triggerMessageId: row.triggerMessageId,
    status: row.status,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Modul automations (Fase 2A; sequence Fase 2C) — manajemen automation
 * workspace:
 *   POST  /tenants/:tenantId/automations            buat → 201
 *         kind 'keyword' (atau tanpa kind): {name, keywords, match, text}
 *         kind 'sequence': {name, keywords, match, steps[{delayMinutes, text}]}
 *   GET   /tenants/:tenantId/automations            daftar + jumlah run +
 *                                                   kind & langkah sequence
 *   PATCH /tenants/:tenantId/automations/:id        ubah isActive/name/keywords/match/text
 *                                                   (langkah sequence TIDAK bisa
 *                                                   diubah — buat automation baru)
 *   GET   /tenants/:tenantId/automations/:id/runs   riwayat eksekusi terbaru
 *   GET   /tenants/:tenantId/automations/:id/enrollments
 *                                                   pendaftaran sequence terbaru
 * Wajib sesi + membership workspace (non-member → 404 TENANT_NOT_FOUND,
 * pola Fase 1B/1D). Eksekusi automation sendiri berjalan di worker
 * (job `automation.evaluate` & `sequence.step`), bukan di proses API ini.
 */
export function createAutomationsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/automations";

  if (!bundle) {
    const notConfigured = (c: Parameters<typeof apiError>[0]) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.post(base, notConfigured);
    app.get(base, notConfigured);
    app.patch(`${base}/:id`, notConfigured);
    app.get(`${base}/:id/runs`, notConfigured);
    app.get(`${base}/:id/enrollments`, notConfigured);
    return app;
  }


  const resolveTenant = async (c: AppContext) =>
    resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      c.get("appUser").id,
    );

  app.post(base, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateAutomationRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid automation payload");
    }
    // Fase 10B: aturan komentar terikat ke satu akun IG/Messenger milik
    // tenant ini. Akun tak ditemukan di tenant, provider di luar
    // instagram/messenger, atau akun sedang terputus → 422
    // COMMENT_CHANNEL_UNSUPPORTED (aturan tak pernah lahir mengambang).
    if ("channelAccountId" in parsed.data) {
      const account = await getChannelAccount(
        bundle.db,
        { tenantId: tenant.id },
        parsed.data.channelAccountId,
      );
      if (
        !account ||
        (account.provider !== "instagram" &&
          account.provider !== "messenger") ||
        account.status !== "connected"
      ) {
        return apiError(
          c,
          422,
          "COMMENT_CHANNEL_UNSUPPORTED",
          "Comment rules require a connected Instagram or Messenger account",
        );
      }
    }
    const created = await createAutomation(
      bundle.db,
      { tenantId: tenant.id },
      "steps" in parsed.data
        ? {
            name: parsed.data.name,
            keywords: parsed.data.keywords,
            match: parsed.data.match,
            kind: "sequence",
            steps: parsed.data.steps,
          }
        : "channelAccountId" in parsed.data
          ? {
              name: parsed.data.name,
              keywords: parsed.data.keywords,
              match: parsed.data.match,
              kind: "comment",
              channelAccountId: parsed.data.channelAccountId,
              sendDm: parsed.data.sendDm,
              text: parsed.data.dmText,
              publicReplyText: parsed.data.publicReplyText ?? null,
              hideComment: parsed.data.hideComment,
            }
          : {
              name: parsed.data.name,
              keywords: parsed.data.keywords,
              match: parsed.data.match,
              kind: "keyword",
              text: parsed.data.text,
            },
    );
    return c.json(
      serializeAutomation({
        ...created,
        runCount: 0,
        stepCount: created.steps.length,
      }),
      201,
    );
  });

  app.get(base, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listAutomations(bundle.db, { tenantId: tenant.id });
    const body = AutomationListResponseSchema.parse({
      automations: rows.map(serializeAutomation),
    });
    return c.json(body);
  });

  app.patch(`${base}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateAutomationRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid automation payload");
    }
    const updated = await updateAutomation(
      bundle.db,
      { tenantId: tenant.id },
      id,
      parsed.data,
    );
    if (!updated) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    const rows = await listAutomations(bundle.db, { tenantId: tenant.id });
    const withCount =
      rows.find((r) => r.id === updated.id) ??
      { ...updated, runCount: 0, steps: [], stepCount: 0 };
    return c.json(serializeAutomation(withCount));
  });

  app.get(`${base}/:id/enrollments`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    const enrollments = await listSequenceEnrollments(
      bundle.db,
      { tenantId: tenant.id },
      id,
      { limit: 50 },
    );
    if (!enrollments)
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    const body = SequenceEnrollmentListResponseSchema.parse({
      enrollments: enrollments.map(serializeEnrollment),
    });
    return c.json(body);
  });

  app.get(`${base}/:id/runs`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Automation not found");
    }
    const runs = await listAutomationRuns(
      bundle.db,
      { tenantId: tenant.id },
      id,
      { limit: 50 },
    );
    if (!runs) return apiError(c, 404, "NOT_FOUND", "Automation not found");
    const body = AutomationRunListResponseSchema.parse({
      runs: runs.map(serializeRun),
    });
    return c.json(body);
  });

  return app;
}
