import { Hono } from "hono";
import { z } from "zod";
import {
  CreateDealPipelineRequestSchema,
  CreateDealRequestSchema,
  CreateDealStageRequestSchema,
  DealDetailResponseSchema,
  DealListResponseSchema,
  DealPipelineAnalyticsResponseSchema,
  DealPipelineListResponseSchema,
  DealPipelineResponseSchema,
  DealResponseSchema,
  DealSettingsResponseSchema,
  DealStageResponseSchema,
  DeleteDealStageRequestSchema,
  MoveDealStageRequestSchema,
  ReorderDealStagesRequestSchema,
  UpdateDealPipelineRequestSchema,
  UpdateDealRequestSchema,
  UpdateDealSettingsRequestSchema,
  UpdateDealStageRequestSchema,
  type DealDetailResponse,
  type DealPipelineResponse,
  type DealResponse,
  type DealStageResponse,
} from "@sahabat-kreator/contracts";
import type { DealStage } from "@sahabat-kreator/db";
import type {
  DealPipelineWithStages,
  DealView,
} from "@sahabat-kreator/core";
import {
  createDeal,
  createDealPipeline,
  createDealStage,
  deleteDeal,
  deleteDealPipeline,
  deleteDealStage,
  getDealDetail,
  getDealPipelineAnalytics,
  listDealPipelines,
  listDeals,
  moveDealStage,
  reorderDealStages,
  updateDeal,
  updateDealPipeline,
  updateDealStage,
  updateTenantDefaultCurrency,
  type TenantWithRole,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul deals (G12) — pipeline penjualan & papan Kanban:
 *   GET    /tenants/:tenantId/deal-pipelines            daftar pipeline + tahap (semua member; pipeline bawaan disemai malas oleh core)
 *   POST   /tenants/:tenantId/deal-pipelines            buat pipeline + tahap bawaan (owner/admin)
 *   PATCH  /tenants/:tenantId/deal-pipelines/:pid       ganti nama (owner/admin)
 *   DELETE /tenants/:tenantId/deal-pipelines/:pid       hapus pipeline kosong (owner/admin; berisi deal → 409)
 *   POST   /tenants/:tenantId/deal-pipelines/:pid/stages            tambah tahap (owner/admin)
 *   PATCH  /tenants/:tenantId/deal-pipelines/:pid/stages/:sid       ubah nama/warna/kind (owner/admin)
 *   POST   /tenants/:tenantId/deal-pipelines/:pid/stages/reorder    susun ulang (owner/admin)
 *   DELETE /tenants/:tenantId/deal-pipelines/:pid/stages/:sid       hapus tahap (owner/admin; berisi deal → wajib moveDealsToStageId)
 *   GET    /tenants/:tenantId/deal-pipelines/:pid/analytics         analitik ringan per tahap (semua member)
 *   GET    /tenants/:tenantId/deals                      daftar deal (filter pipelineId/stageId/status/contactId)
 *   POST   /tenants/:tenantId/deals                      buat deal (owner/admin/agent)
 *   GET    /tenants/:tenantId/deals/:id                  detail + riwayat tahap
 *   PATCH  /tenants/:tenantId/deals/:id                  ubah field (owner/admin/agent)
 *   POST   /tenants/:tenantId/deals/:id/move             pindah tahap (owner/admin/agent)
 *   DELETE /tenants/:tenantId/deals/:id                  hapus deal (owner/admin)
 *   GET    /tenants/:tenantId/deal-settings              mata uang bawaan akun (semua member)
 *   PATCH  /tenants/:tenantId/deal-settings              ubah mata uang bawaan (owner/admin)
 *
 * Pembagian peran meniru wacrm: pengelolaan pipeline/tahap adalah
 * write tingkat-pengaturan (owner/admin); operasi deal harian cukup
 * agent+; viewer hanya membaca. Non-member selalu 404
 * TENANT_NOT_FOUND (pola Fase 1B).
 */

export function serializeDealStage(row: DealStage): DealStageResponse {
  return DealStageResponseSchema.parse({
    id: row.id,
    pipelineId: row.pipelineId,
    name: row.name,
    position: row.position,
    color: row.color,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function serializeDealPipeline(
  row: DealPipelineWithStages,
): DealPipelineResponse {
  return DealPipelineResponseSchema.parse({
    id: row.id,
    name: row.name,
    stages: row.stages.map(serializeDealStage),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function serializeDeal(row: DealView): DealResponse {
  return DealResponseSchema.parse({
    id: row.id,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    contactId: row.contactId,
    contactName: row.contactName,
    conversationId: row.conversationId,
    title: row.title,
    value: Number.parseFloat(row.value),
    currency: row.currency,
    expectedCloseDate: row.expectedCloseDate,
    dueAt: row.dueAt?.toISOString() ?? null,
    status: row.status,
    priority: row.priority,
    assigneeUserId: row.assigneeUserId,
    assigneeName: row.assigneeName,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

type GuardResult =
  | { tenant: TenantWithRole; userId: string }
  | { error: ReturnType<typeof apiError> };

export function createDealsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const pipelinesBase = "/tenants/:tenantId/deal-pipelines";
  const dealsBase = "/tenants/:tenantId/deals";
  const settingsPath = "/tenants/:tenantId/deal-settings";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(pipelinesBase, unavailable);
    app.post(pipelinesBase, unavailable);
    app.patch(`${pipelinesBase}/:pid`, unavailable);
    app.delete(`${pipelinesBase}/:pid`, unavailable);
    app.post(`${pipelinesBase}/:pid/stages`, unavailable);
    app.patch(`${pipelinesBase}/:pid/stages/:sid`, unavailable);
    app.post(`${pipelinesBase}/:pid/stages/reorder`, unavailable);
    app.delete(`${pipelinesBase}/:pid/stages/:sid`, unavailable);
    app.get(`${pipelinesBase}/:pid/analytics`, unavailable);
    app.get(dealsBase, unavailable);
    app.post(dealsBase, unavailable);
    app.get(`${dealsBase}/:id`, unavailable);
    app.patch(`${dealsBase}/:id`, unavailable);
    app.post(`${dealsBase}/:id/move`, unavailable);
    app.delete(`${dealsBase}/:id`, unavailable);
    app.get(settingsPath, unavailable);
    app.patch(settingsPath, unavailable);
    return app;
  }

  const guard = async (
    c: AppContext,
    level: "member" | "operator" | "manager",
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
    if (level === "manager" && tenant.role !== "owner" && tenant.role !== "admin") {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage pipelines",
        ),
      };
    }
    if (level === "operator" && tenant.role === "viewer") {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Viewers cannot modify deals",
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
        error: apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON"),
      };
    }
  };

  const uuidParam = (c: AppContext, name: string): string | null => {
    const value = c.req.param(name) ?? "";
    return z.string().uuid().safeParse(value).success ? value : null;
  };

  // ---- Pipeline ---------------------------------------------------------------

  app.get(pipelinesBase, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const pipelines = await listDealPipelines(bundle.db, g.tenant.id);
    return c.json(
      DealPipelineListResponseSchema.parse({
        pipelines: pipelines.map(serializeDealPipeline),
      }),
    );
  });

  app.post(pipelinesBase, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = CreateDealPipelineRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid pipeline payload");
    }
    const pipeline = await createDealPipeline(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      name: parsed.data.name,
    });
    return c.json(serializeDealPipeline(pipeline), 201);
  });

  app.patch(`${pipelinesBase}/:pid`, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const pid = uuidParam(c, "pid");
    if (!pid) return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = UpdateDealPipelineRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid pipeline payload");
    }
    const result = await updateDealPipeline(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      pipelineId: pid,
      name: parsed.data.name,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    }
    const pipelines = await listDealPipelines(bundle.db, g.tenant.id);
    const full = pipelines.find((p) => p.id === pid);
    return c.json(serializeDealPipeline(full!));
  });

  app.delete(`${pipelinesBase}/:pid`, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const pid = uuidParam(c, "pid");
    if (!pid) return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    const result = await deleteDealPipeline(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      pipelineId: pid,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    }
    if (result.kind === "has_deals") {
      return apiError(
        c,
        409,
        "PIPELINE_HAS_DEALS",
        `Pipeline still contains ${result.dealCount} deal(s); delete or move them first`,
      );
    }
    return c.body(null, 204);
  });

  // ---- Tahap ------------------------------------------------------------------

  app.post(`${pipelinesBase}/:pid/stages`, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const pid = uuidParam(c, "pid");
    if (!pid) return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = CreateDealStageRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid stage payload");
    }
    const result = await createDealStage(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      pipelineId: pid,
      name: parsed.data.name,
      color: parsed.data.color,
      kind: parsed.data.kind,
    });
    if (result.kind === "pipeline_not_found") {
      return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    }
    return c.json(serializeDealStage(result.stage), 201);
  });

  app.patch(`${pipelinesBase}/:pid/stages/:sid`, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const pid = uuidParam(c, "pid");
    const sid = uuidParam(c, "sid");
    if (!pid) return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    if (!sid) return apiError(c, 404, "STAGE_NOT_FOUND", "Stage not found");
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = UpdateDealStageRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid stage payload");
    }
    const result = await updateDealStage(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      pipelineId: pid,
      stageId: sid,
      name: parsed.data.name,
      color: parsed.data.color,
      kind: parsed.data.kind,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "STAGE_NOT_FOUND", "Stage not found");
    }
    return c.json(serializeDealStage(result.stage));
  });

  app.post(`${pipelinesBase}/:pid/stages/reorder`, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const pid = uuidParam(c, "pid");
    if (!pid) return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = ReorderDealStagesRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid reorder payload");
    }
    const result = await reorderDealStages(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      pipelineId: pid,
      stageIds: parsed.data.stageIds,
    });
    if (result.kind === "pipeline_not_found") {
      return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    }
    if (result.kind === "invalid_stage_set") {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "stageIds must list every stage of this pipeline exactly once",
      );
    }
    const pipelines = await listDealPipelines(bundle.db, g.tenant.id);
    return c.json(serializeDealPipeline(pipelines.find((p) => p.id === pid)!));
  });

  app.delete(`${pipelinesBase}/:pid/stages/:sid`, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const pid = uuidParam(c, "pid");
    const sid = uuidParam(c, "sid");
    if (!pid) return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    if (!sid) return apiError(c, 404, "STAGE_NOT_FOUND", "Stage not found");
    // Body opsional: { moveDealsToStageId } — absen = tahap harus kosong.
    let moveDealsToStageId: string | undefined;
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
      }
      const parsed = DeleteDealStageRequestSchema.safeParse(json);
      if (!parsed.success) {
        return apiError(c, 400, "VALIDATION_ERROR", "Invalid stage delete payload");
      }
      moveDealsToStageId = parsed.data.moveDealsToStageId;
    }
    const result = await deleteDealStage(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      pipelineId: pid,
      stageId: sid,
      moveDealsToStageId,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "STAGE_NOT_FOUND", "Stage not found");
    }
    if (result.kind === "stage_not_empty") {
      return apiError(
        c,
        409,
        "STAGE_NOT_EMPTY",
        `Stage still contains ${result.dealCount} deal(s); provide moveDealsToStageId to move them`,
      );
    }
    if (result.kind === "invalid_move_target") {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "moveDealsToStageId must be another stage of the same pipeline",
      );
    }
    return c.body(null, 204);
  });

  app.get(`${pipelinesBase}/:pid/analytics`, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const pid = uuidParam(c, "pid");
    if (!pid) return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    const result = await getDealPipelineAnalytics(bundle.db, {
      tenantId: g.tenant.id,
      pipelineId: pid,
    });
    if (result.kind === "pipeline_not_found") {
      return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
    }
    return c.json(DealPipelineAnalyticsResponseSchema.parse(result.analytics));
  });

  // ---- Deal -------------------------------------------------------------------

  app.get(dealsBase, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const q = c.req.query();
    const uuidOrUndefined = (v: string | undefined) =>
      v && z.string().uuid().safeParse(v).success ? v : undefined;
    const status =
      q.status === "open" || q.status === "won" || q.status === "lost"
        ? q.status
        : undefined;
    const rows = await listDeals(bundle.db, g.tenant.id, {
      pipelineId: uuidOrUndefined(q.pipelineId),
      stageId: uuidOrUndefined(q.stageId),
      status,
      contactId: uuidOrUndefined(q.contactId),
      limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
    });
    return c.json(
      DealListResponseSchema.parse({ deals: rows.map(serializeDeal) }),
    );
  });

  app.post(dealsBase, async (c) => {
    const g = await guard(c, "operator");
    if ("error" in g) return g.error;
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = CreateDealRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid deal payload");
    }
    const result = await createDeal(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      title: parsed.data.title,
      contactId: parsed.data.contactId,
      pipelineId: parsed.data.pipelineId,
      stageId: parsed.data.stageId,
      conversationId: parsed.data.conversationId,
      value: parsed.data.value,
      currency: parsed.data.currency,
      expectedCloseDate: parsed.data.expectedCloseDate,
      dueAt: parsed.data.dueAt,
      priority: parsed.data.priority,
      assigneeUserId: parsed.data.assigneeUserId,
    });
    switch (result.kind) {
      case "created":
        return c.json(serializeDeal(result.deal), 201);
      case "contact_not_found":
        return apiError(c, 404, "CONTACT_NOT_FOUND", "Contact not found");
      case "pipeline_not_found":
        return apiError(c, 404, "PIPELINE_NOT_FOUND", "Pipeline not found");
      case "stage_not_found":
        return apiError(c, 404, "STAGE_NOT_FOUND", "Stage not found");
      case "pipeline_has_no_stages":
        return apiError(c, 409, "PIPELINE_HAS_NO_STAGES", "Pipeline has no stages yet");
      case "assignee_not_member":
        return apiError(c, 400, "ASSIGNEE_NOT_MEMBER", "Assignee is not a member of this workspace");
      case "conversation_not_found":
        return apiError(c, 404, "CONVERSATION_NOT_FOUND", "Conversation not found for this contact");
    }
  });

  app.get(`${dealsBase}/:id`, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    const id = uuidParam(c, "id");
    if (!id) return apiError(c, 404, "DEAL_NOT_FOUND", "Deal not found");
    const detail = await getDealDetail(bundle.db, {
      tenantId: g.tenant.id,
      dealId: id,
    });
    if (!detail) return apiError(c, 404, "DEAL_NOT_FOUND", "Deal not found");
    const response: DealDetailResponse = DealDetailResponseSchema.parse({
      ...serializeDeal(detail.deal),
      stageHistory: detail.stageHistory.map((e) => ({
        id: e.id,
        dealId: e.dealId,
        fromStageId: e.fromStageId,
        toStageId: e.toStageId,
        fromStageName: e.fromStageName,
        toStageName: e.toStageName,
        actorType: e.actorType,
        actorId: e.actorId,
        createdAt: e.createdAt.toISOString(),
      })),
    });
    return c.json(response);
  });

  app.patch(`${dealsBase}/:id`, async (c) => {
    const g = await guard(c, "operator");
    if ("error" in g) return g.error;
    const id = uuidParam(c, "id");
    if (!id) return apiError(c, 404, "DEAL_NOT_FOUND", "Deal not found");
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = UpdateDealRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid deal payload");
    }
    const result = await updateDeal(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      dealId: id,
      title: parsed.data.title,
      value: parsed.data.value,
      currency: parsed.data.currency,
      expectedCloseDate: parsed.data.expectedCloseDate,
      dueAt: parsed.data.dueAt,
      priority: parsed.data.priority,
      assigneeUserId: parsed.data.assigneeUserId,
      conversationId: parsed.data.conversationId,
      contactId: parsed.data.contactId,
    });
    switch (result.kind) {
      case "updated":
        return c.json(serializeDeal(result.deal));
      case "not_found":
        return apiError(c, 404, "DEAL_NOT_FOUND", "Deal not found");
      case "contact_not_found":
        return apiError(c, 404, "CONTACT_NOT_FOUND", "Contact not found");
      case "assignee_not_member":
        return apiError(c, 400, "ASSIGNEE_NOT_MEMBER", "Assignee is not a member of this workspace");
      case "conversation_not_found":
        return apiError(c, 404, "CONVERSATION_NOT_FOUND", "Conversation not found for this contact");
    }
  });

  app.post(`${dealsBase}/:id/move`, async (c) => {
    const g = await guard(c, "operator");
    if ("error" in g) return g.error;
    const id = uuidParam(c, "id");
    if (!id) return apiError(c, 404, "DEAL_NOT_FOUND", "Deal not found");
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = MoveDealStageRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid move payload");
    }
    const result = await moveDealStage(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      dealId: id,
      stageId: parsed.data.stageId,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "DEAL_NOT_FOUND", "Deal not found");
    }
    if (result.kind === "stage_not_found") {
      return apiError(c, 404, "STAGE_NOT_FOUND", "Stage not found");
    }
    return c.json(serializeDeal(result.deal));
  });

  app.delete(`${dealsBase}/:id`, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const id = uuidParam(c, "id");
    if (!id) return apiError(c, 404, "DEAL_NOT_FOUND", "Deal not found");
    const result = await deleteDeal(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      dealId: id,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "DEAL_NOT_FOUND", "Deal not found");
    }
    return c.body(null, 204);
  });

  // ---- Pengaturan deals (mata uang bawaan akun) --------------------------------

  app.get(settingsPath, async (c) => {
    const g = await guard(c, "member");
    if ("error" in g) return g.error;
    return c.json(
      DealSettingsResponseSchema.parse({
        defaultCurrency: g.tenant.defaultCurrency,
      }),
    );
  });

  app.patch(settingsPath, async (c) => {
    const g = await guard(c, "manager");
    if ("error" in g) return g.error;
    const body = await parseJson(c);
    if ("error" in body) return body.error;
    const parsed = UpdateDealSettingsRequestSchema.safeParse(body.json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid deal settings payload");
    }
    const updated = await updateTenantDefaultCurrency(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.userId,
      currency: parsed.data.defaultCurrency,
    });
    if (!updated) {
      return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    }
    return c.json(DealSettingsResponseSchema.parse(updated));
  });

  return app;
}
