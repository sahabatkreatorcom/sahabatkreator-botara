import { Hono } from "hono";
import { z } from "zod";
import {
  CreateFlowRequestSchema,
  FLOW_TEMPLATES,
  FlowExperimentsResponseSchema,
  FlowGraphSchema,
  FlowListQuerySchema,
  FlowListResponseSchema,
  FlowResponseSchema,
  FlowRunListQuerySchema,
  FlowRunListResponseSchema,
  FlowRunStepListQuerySchema,
  FlowRunStepListResponseSchema,
  FlowSimulateRequestSchema,
  FlowSimulateResponseSchema,
  FlowTemplateListResponseSchema,
  FlowValidationResponseSchema,
  FlowVersionListResponseSchema,
  FlowVersionResponseSchema,
  FlowVersionRestoreResponseSchema,
  FlowWebhookTriggerResponseSchema,
  FlowWebhookTriggerRotateResponseSchema,
  InstantiateFlowTemplateRequestSchema,
  UpdateFlowRequestSchema,
  type FlowGraph,
  type FlowResponse,
  type FlowVersionResponse,
} from "@sahabat-kreator/contracts";
import {
  activateFlow,
  createFlow,
  deactivateFlow,
  deleteFlow,
  deleteFlowWebhookEndpoint,
  getFlow,
  getFlowWebhookEndpoint,
  provisionFlowWebhookEndpoint,
  getFlowExperimentResults,
  getFlowVersion,
  instantiateFlowTemplate,
  listFlowRunSteps,
  listFlowRuns,
  listFlowVersions,
  listFlows,
  normalizeFlowGraph,
  restoreFlowVersion,
  setFlowArchived,
  simulateFlow,
  updateFlow,
  validateFlowGraph,
  type FlowGraphIssue,
  type FlowVersionSummary,
  type FlowWithRunCount,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul flows (Fase 8A) — definisi flow berbentuk graf + eksekusi
 * yang bisa diamati:
 *   GET    /tenants/:tenantId/flows                    daftar
 *   POST   /tenants/:tenantId/flows                    buat draft
 *   GET    /tenants/:tenantId/flows/templates          katalog template (12B)
 *   POST   /tenants/:tenantId/flows/templates/:slug/instantiate
 *                                                      buat draft dari template
 *   GET    /tenants/:tenantId/flows/:id                detail
 *   PATCH  /tenants/:tenantId/flows/:id                edit (draft saja)
 *   DELETE /tenants/:tenantId/flows/:id                hapus (draft saja)
 *   POST   /tenants/:tenantId/flows/:id/validate       validasi graf (kering)
 *   POST   /tenants/:tenantId/flows/:id/activate       aktifkan (validasi penuh)
 *   POST   /tenants/:tenantId/flows/:id/deactivate     nonaktifkan → draft
 *   POST   /tenants/:tenantId/flows/:id/archive        arsipkan
 *   POST   /tenants/:tenantId/flows/:id/unarchive      keluar arsip → draft
 *   GET    /tenants/:tenantId/flows/:id/runs           run milik flow
 *   GET    /tenants/:tenantId/flows/:id/experiments    hasil eksperimen A/B (13D)
 *   GET    /tenants/:tenantId/flows/runs/:runId/steps  langkah satu run
 *   GET    /tenants/:tenantId/flows/:id/versions       riwayat versi (G3)
 *   POST   /tenants/:tenantId/flows/:id/versions/:version/restore
 *                                                      pulihkan versi → versi baru (G3)
 *   POST   /tenants/:tenantId/flows/:id/simulate       simulasi kering (G4) —
 *                                                      jejak + efek sebagai data,
 *                                                      tanpa satu pun tulisan
 *   GET    /tenants/:tenantId/flows/:id/webhook-trigger
 *                                                      keadaan endpoint webhook (G17; tanpa token)
 *   POST   /tenants/:tenantId/flows/:id/webhook-trigger/rotate
 *                                                      provision/rotasi token (owner/admin; token tampil SATU KALI)
 *   DELETE /tenants/:tenantId/flows/:id/webhook-trigger
 *                                                      hapus endpoint webhook (owner/admin)
 *
 * Eksekusi BUKAN di sini: pesan masuk dievaluasi worker
 * (keyword → flow → agent); run berjalan sebagai job `flow.step`.
 *
 * AKSES (keputusan Fase 8A, selaras broadcasts/automations): mutasi
 * (buat/edit/hapus/transisi status) = OWNER/ADMIN; baca (daftar/
 * detail/run/langkah/validasi kering) = semua member workspace.
 * Non-member selalu 404 TENANT_NOT_FOUND agar eksistensi tenant
 * tidak bocor.
 *
 * Validasi graf: bentuk ditegakkan skema kontrak; KESELURUHAN
 * semantik (tepat satu trigger, edge menggantung, cabang condition,
 * config per tipe, rujukan sequence) hanya saat aktivasi — draft
 * boleh belum sah. Aktivasi yang gagal → 422 FLOW_GRAPH_INVALID
 * dengan `details.issues` terstruktur; peringatan (node tak
 * terjangkau) tidak memblokir dan ikut dikembalikan saat sukses.
 */

export function serializeFlow(flow: FlowWithRunCount): FlowResponse {
  return FlowResponseSchema.parse({
    id: flow.id,
    name: flow.name,
    status: flow.status,
    graph: normalizeFlowGraph(flow.graph),
    runCount: flow.runCount,
    createdByUserId: flow.createdByUserId,
    createdAt: flow.createdAt.toISOString(),
    updatedAt: flow.updatedAt.toISOString(),
  });
}

function serializeFlowVersion(
  summary: FlowVersionSummary,
): FlowVersionResponse {
  const row = summary.version;
  return FlowVersionResponseSchema.parse({
    id: row.id,
    flowId: row.flowId,
    version: row.version,
    name: row.name,
    nodeCount: summary.nodeCount,
    edgeCount: summary.edgeCount,
    restoredFromVersion: row.restoredFromVersion,
    activatedByUserId: row.activatedByUserId,
    isCurrent: summary.isCurrent,
    createdAt: row.createdAt.toISOString(),
  });
}

function graphIssuesBody(issues: FlowGraphIssue[]) {
  return {
    valid: !issues.some((i) => i.severity === "error"),
    issues: issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      nodeId: i.nodeId,
      message: i.message,
    })),
  };
}

export function createFlowsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/flows";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.get(`${base}/templates`, unavailable);
    app.post(`${base}/templates/:slug/instantiate`, unavailable);
    app.get(`${base}/runs/:runId/steps`, unavailable);
    app.get(`${base}/:id`, unavailable);
    app.patch(`${base}/:id`, unavailable);
    app.delete(`${base}/:id`, unavailable);
    app.post(`${base}/:id/validate`, unavailable);
    app.post(`${base}/:id/activate`, unavailable);
    app.post(`${base}/:id/deactivate`, unavailable);
    app.post(`${base}/:id/archive`, unavailable);
    app.post(`${base}/:id/unarchive`, unavailable);
    app.get(`${base}/:id/runs`, unavailable);
    app.get(`${base}/:id/experiments`, unavailable);
    app.get(`${base}/:id/versions`, unavailable);
    app.post(`${base}/:id/versions/:version/restore`, unavailable);
    app.post(`${base}/:id/simulate`, unavailable);
    app.get(`${base}/:id/webhook-trigger`, unavailable);
    app.post(`${base}/:id/webhook-trigger/rotate`, unavailable);
    app.delete(`${base}/:id/webhook-trigger`, unavailable);
    return app;
  }


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
          "Only workspace owners and admins can manage flows",
        ),
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

  function invalidState(c: AppContext, status: string) {
    return apiError(
      c,
      409,
      "FLOW_INVALID_STATE",
      `Flow in status '${status}' cannot perform this action`,
    );
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

  // ---- Daftar -------------------------------------------------------------
  app.get(base, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const parsed = FlowListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid flow list query");
    }
    const page = await listFlows(bundle.db, {
      tenantId: g.tenant.id,
      status: parsed.data.status,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    const body = FlowListResponseSchema.parse({
      flows: page.flows.map(serializeFlow),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  // ---- Buat draft -----------------------------------------------------------
  app.post(base, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (typeof json === "object" && json !== null && "error" in json) {
      return (json as { error: Response }).error;
    }
    const parsed = CreateFlowRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid flow payload");
    }
    const result = await createFlow(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      name: parsed.data.name,
      graph: parsed.data.graph as FlowGraph | undefined,
    });
    return c.json(serializeFlow(result.flow), 201);
  });

  // ---- Galeri template (Fase 12B, sebelum route :id agar tidak tertangkap) --
  // Katalog statis dari kontrak (FLOW_TEMPLATES): respons hanya ringkasan
  // (slug, kunci i18n nama/deskripsi, kategori, jumlah node, kebutuhan) —
  // graf penuh tidak keluar di daftar; ia disalin server saat instantiate.
  app.get(`${base}/templates`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const body = FlowTemplateListResponseSchema.parse({
      templates: FLOW_TEMPLATES.map((tpl) => ({
        slug: tpl.slug,
        nameKey: tpl.nameKey,
        descriptionKey: tpl.descriptionKey,
        category: tpl.category,
        nodeCount: tpl.graph.nodes.length,
        needs: tpl.needs,
      })),
    });
    return c.json(body);
  });

  // Membuat flow DRAFT dari template. Peran = mutasi flow (owner/admin).
  // Body boleh kosong sama sekali; {name} opsional menimpa nama bawaan
  // template. Slug tak dikenal → 404 FLOW_TEMPLATE_NOT_FOUND.
  app.post(`${base}/templates/:slug/instantiate`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    let name: string | undefined;
    try {
      const json = (await c.req.json()) as { name?: unknown } | null;
      if (json && typeof json === "object" && json.name !== undefined) {
        const parsed = InstantiateFlowTemplateRequestSchema.safeParse(json);
        if (!parsed.success) {
          return apiError(c, 400, "VALIDATION_ERROR", "Invalid instantiate payload");
        }
        name = parsed.data.name;
      }
    } catch {
      // Body kosong sah = pakai nama bawaan template.
    }
    const result = await instantiateFlowTemplate(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      slug: c.req.param("slug") ?? "",
      name,
    });
    switch (result.kind) {
      case "created":
        return c.json(serializeFlow(result.flow), 201);
      case "template_not_found":
        return apiError(
          c,
          404,
          "FLOW_TEMPLATE_NOT_FOUND",
          "Flow template not found",
        );
    }
  });

  // ---- Langkah satu run (sebelum route :id agar tidak tertangkap) -----------
  app.get(`${base}/runs/:runId/steps`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const runId = parseUuidParam(c, "runId");
    if (!runId) return apiError(c, 404, "NOT_FOUND", "Flow run not found");
    const parsed = FlowRunStepListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid step list query");
    }
    const result = await listFlowRunSteps(bundle.db, {
      tenantId: g.tenant.id,
      runId,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Flow run not found");
    }
    const body = FlowRunStepListResponseSchema.parse({
      steps: result.steps.map((s) => ({
        id: s.id,
        runId: s.runId,
        seq: s.seq,
        nodeId: s.nodeId,
        nodeType: s.nodeType,
        detail: (s.detail ?? {}) as Record<string, unknown>,
        error: s.error,
        createdAt: s.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    });
    return c.json(body);
  });

  // ---- Detail ---------------------------------------------------------------
  app.get(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const flow = await getFlow(bundle.db, { tenantId: g.tenant.id, flowId: id });
    if (!flow) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    return c.json(serializeFlow(flow));
  });

  // ---- Edit draft -------------------------------------------------------------
  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const json = await readJson(c);
    if (typeof json === "object" && json !== null && "error" in json) {
      return (json as { error: Response }).error;
    }
    const parsed = UpdateFlowRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid flow payload");
    }
    const result = await updateFlow(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
      userId: g.appUser.id,
      patch: {
        name: parsed.data.name,
        graph: parsed.data.graph as FlowGraph | undefined,
      },
    });
    switch (result.kind) {
      case "updated": {
        const detail = await getFlow(bundle.db, {
          tenantId: g.tenant.id,
          flowId: id,
        });
        return c.json(serializeFlow(detail ?? { ...result.flow, runCount: 0 }));
      }
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Flow not found");
      case "invalid_state":
        return invalidState(c, result.status);
    }
  });

  // ---- Hapus draft ------------------------------------------------------------
  app.delete(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const result = await deleteFlow(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
      userId: g.appUser.id,
    });
    switch (result.kind) {
      case "deleted":
        return c.body(null, 204);
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Flow not found");
      case "invalid_state":
        return invalidState(c, result.status);
    }
  });

  // ---- Validasi kering ---------------------------------------------------------
  // Body {graph} opsional: tanpa body, graf tersimpan yang divalidasi.
  // Tidak mengubah status apa pun — dipakai builder (8B) untuk umpan
  // balik langsung dan oleh rantai uji.
  app.post(`${base}/:id/validate`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    let graph: FlowGraph | undefined;
    try {
      const json = (await c.req.json()) as { graph?: unknown } | null;
      if (json && typeof json === "object" && json.graph !== undefined) {
        const parsedGraph = FlowGraphSchema.safeParse(json.graph);
        if (!parsedGraph.success) {
          return apiError(c, 400, "VALIDATION_ERROR", "Invalid graph shape");
        }
        graph = parsedGraph.data;
      }
    } catch {
      // Body kosong sah = validasi graf tersimpan.
    }
    if (!graph) {
      const flow = await getFlow(bundle.db, {
        tenantId: g.tenant.id,
        flowId: id,
      });
      if (!flow) return apiError(c, 404, "NOT_FOUND", "Flow not found");
      graph = normalizeFlowGraph(flow.graph) as FlowGraph;
    }
    const issues = await validateFlowGraph(
      bundle.db,
      g.tenant.id,
      normalizeFlowGraph(graph),
      { selfFlowId: id },
    );
    return c.json(FlowValidationResponseSchema.parse(graphIssuesBody(issues)));
  });

  // ---- Simulasi kering (G4) -------------------------------------------------------
  // Menjalankan interpreter kering core atas graf DRAF kiriman
  // (`graph`), SNAPSHOT versi tersimpan (`version`), atau graf
  // tersimpan flow — dengan kontak mock + teks pemicu dari body.
  // `graph` dan `version` saling eksklusif. Hasil validator graf yang
  // ada ikut dikembalikan (error TIDAK memblokir simulasi — panel uji
  // justru untuk melihat perilaku graf yang belum sah). Jalur ini
  // TIDAK menulis apa pun: tidak ada run/pesan/outbox/audit, tidak
  // ada panggilan LLM/jaringan dari node mana pun. Baca = semua
  // member (selaras validate).
  app.post(`${base}/:id/simulate`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const json = await readJson(c);
    if (typeof json === "object" && json !== null && "error" in json) {
      return (json as { error: Response }).error;
    }
    const parsed = FlowSimulateRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid simulate payload");
    }
    const body = parsed.data;
    if (body.graph !== undefined && body.version !== undefined) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Provide either graph or version, not both",
      );
    }
    const flow = await getFlow(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
    });
    if (!flow) return apiError(c, 404, "NOT_FOUND", "Flow not found");

    let graph: FlowGraph;
    let source: { kind: "draft" | "stored" | "version"; version: number | null };
    if (body.graph !== undefined) {
      graph = body.graph;
      source = { kind: "draft", version: null };
    } else if (body.version !== undefined) {
      const row = await getFlowVersion(bundle.db, {
        tenantId: g.tenant.id,
        flowId: id,
        version: body.version,
      });
      if (!row) {
        return apiError(c, 404, "NOT_FOUND", "Flow version not found");
      }
      graph = normalizeFlowGraph(row.graph) as FlowGraph;
      source = { kind: "version", version: row.version };
    } else {
      graph = normalizeFlowGraph(flow.graph) as FlowGraph;
      source = { kind: "stored", version: null };
    }

    const issues = await validateFlowGraph(
      bundle.db,
      g.tenant.id,
      normalizeFlowGraph(graph),
      { selfFlowId: id },
    );
    const contact = body.contact ?? {};
    const result = await simulateFlow(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
      graph: normalizeFlowGraph(graph),
      triggerText: body.triggerText ?? "",
      contact: {
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        tags: contact.tags,
        pipelineStage: contact.stage,
        customFields: contact.customFields,
        cartItemCount: contact.cartItemCount,
      },
      replyText: body.replyText,
      splitChoices: body.splitChoices,
    });
    const responseBody = FlowSimulateResponseSchema.parse({
      source,
      triggerMatched: result.triggerMatched,
      status: result.status,
      parkedNodeId: result.parkedNodeId,
      parkReason: result.parkReason,
      failReason: result.failReason,
      steps: result.steps,
      effects: result.effects,
      contact: {
        name: result.contact.name,
        phone: result.contact.phone,
        email: result.contact.email,
        tags: result.contact.tags,
        stage: result.contact.pipelineStage,
        customFields: result.contact.customFields,
      },
      issues: graphIssuesBody(issues).issues,
    });
    return c.json(responseBody);
  });

  // ---- Aktifkan ------------------------------------------------------------------
  app.post(`${base}/:id/activate`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const result = await activateFlow(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
      userId: g.appUser.id,
    });
    switch (result.kind) {
      case "activated": {
        const detail = await getFlow(bundle.db, {
          tenantId: g.tenant.id,
          flowId: id,
        });
        return c.json({
          flow: serializeFlow(detail ?? { ...result.flow, runCount: 0 }),
          warnings: result.warnings.map((w) => ({
            code: w.code,
            severity: w.severity,
            nodeId: w.nodeId,
            message: w.message,
          })),
          // G3: nomor versi snapshot yang ditulis aktivasi ini.
          version: result.version,
        });
      }
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Flow not found");
      case "invalid_state":
        return invalidState(c, result.status);
      case "invalid":
        return apiError(
          c,
          422,
          "FLOW_GRAPH_INVALID",
          "Flow graph failed validation",
          { issues: graphIssuesBody(result.issues).issues },
        );
    }
  });

  // ---- Nonaktifkan / arsip / keluar arsip ---------------------------------------
  type StatusResult =
    | { kind: "ok" }
    | { kind: "not_found" }
    | { kind: "invalid_state"; status: string };
  const statusHandler =
    (
      run: (
        tenantId: string,
        flowId: string,
        userId: string,
      ) => Promise<StatusResult>,
    ) =>
    async (c: AppContext) => {
      const g = await guard(c, { ownerAdmin: true });
      if ("error" in g) return g.error;
      const id = parseUuidParam(c, "id");
      if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
      const result = await run(g.tenant.id, id, g.appUser.id);
      switch (result.kind) {
        case "ok": {
          const detail = await getFlow(bundle.db, {
            tenantId: g.tenant.id,
            flowId: id,
          });
          if (!detail) return apiError(c, 404, "NOT_FOUND", "Flow not found");
          return c.json(serializeFlow(detail));
        }
        case "not_found":
          return apiError(c, 404, "NOT_FOUND", "Flow not found");
        case "invalid_state":
          return invalidState(c, result.status);
      }
    };

  app.post(
    `${base}/:id/deactivate`,
    statusHandler(async (tenantId, flowId, userId) => {
      const r = await deactivateFlow(bundle.db, { tenantId, flowId, userId });
      return r.kind === "ok" ? { kind: "ok" } : r;
    }),
  );
  app.post(
    `${base}/:id/archive`,
    statusHandler(async (tenantId, flowId, userId) => {
      const r = await setFlowArchived(bundle.db, {
        tenantId,
        flowId,
        userId,
        archived: true,
      });
      return r.kind === "ok" ? { kind: "ok" } : r;
    }),
  );
  app.post(
    `${base}/:id/unarchive`,
    statusHandler(async (tenantId, flowId, userId) => {
      const r = await setFlowArchived(bundle.db, {
        tenantId,
        flowId,
        userId,
        archived: false,
      });
      return r.kind === "ok" ? { kind: "ok" } : r;
    }),
  );

  // ---- Run milik flow -------------------------------------------------------------
  app.get(`${base}/:id/runs`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const parsed = FlowRunListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid run list query");
    }
    const result = await listFlowRuns(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
      status: parsed.data.status,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Flow not found");
    }
    const body = FlowRunListResponseSchema.parse({
      runs: result.runs.map((r) => ({
        id: r.id,
        flowId: r.flowId,
        conversationId: r.conversationId,
        contactId: r.contactId,
        contactName: r.contactName,
        triggerMessageId: r.triggerMessageId,
        flowVersion: r.flowVersion,
        status: r.status,
        currentNodeId: r.currentNodeId,
        stepCount: r.stepCount,
        errorCode: r.errorCode,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    });
    return c.json(body);
  });

  // ---- Hasil eksperimen A/B (Fase 13D, dashboard saja) ---------------------------
  // Per node ab_split mode eksperimen: penugasan unik, run, selesai,
  // konversi + putusan statistik jujur (z-test dua-proporsi + pagar
  // sampel minimum di core). Baca = semua member; flow tenant lain
  // selalu 404 (isolasi tenant ditegakkan query core).
  app.get(`${base}/:id/experiments`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const result = await getFlowExperimentResults(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
    });
    if (!result) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    return c.json(FlowExperimentsResponseSchema.parse(result));
  });

  // ---- Riwayat versi (G3) ---------------------------------------------------------
  // Baca = semua member. Ringkasan snapshot per aktivasi, terbaru
  // dulu; graf penuh snapshot tidak keluar di daftar.
  app.get(`${base}/:id/versions`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const result = await listFlowVersions(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Flow not found");
    }
    const body = FlowVersionListResponseSchema.parse({
      versions: result.versions.map(serializeFlowVersion),
    });
    return c.json(body);
  });

  // ---- Pulihkan versi (G3) ---------------------------------------------------------
  // Mutasi = owner/admin. Mengaktifkan isi snapshot lama sebagai
  // versi BARU (append-only). Draft kotor → 409 FLOW_RESTORE_DIRTY_DRAFT;
  // snapshot yang kini tidak sah → 422 FLOW_GRAPH_INVALID.
  app.post(`${base}/:id/versions/:version/restore`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const versionRaw = c.req.param("version") ?? "";
    const version = Number.parseInt(versionRaw, 10);
    if (!/^\d+$/.test(versionRaw) || !Number.isFinite(version) || version < 1) {
      return apiError(c, 404, "NOT_FOUND", "Flow version not found");
    }
    const result = await restoreFlowVersion(bundle.db, {
      tenantId: g.tenant.id,
      flowId: id,
      version,
      userId: g.appUser.id,
    });
    switch (result.kind) {
      case "restored": {
        const detail = await getFlow(bundle.db, {
          tenantId: g.tenant.id,
          flowId: id,
        });
        const graph = normalizeFlowGraph(result.version.graph);
        const body = FlowVersionRestoreResponseSchema.parse({
          flow: serializeFlow(detail ?? { ...result.flow, runCount: 0 }),
          version: serializeFlowVersion({
            version: result.version,
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            // Baru dipulihkan & aktif: versi ini adalah versi berjalan.
            isCurrent: true,
          }),
        });
        return c.json(body);
      }
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Flow not found");
      case "version_not_found":
        return apiError(c, 404, "NOT_FOUND", "Flow version not found");
      case "invalid_state":
        return invalidState(c, result.status);
      case "dirty_draft":
        return apiError(
          c,
          409,
          "FLOW_RESTORE_DIRTY_DRAFT",
          "Flow has unactivated draft changes; activate the draft first so it is saved as a version, then restore",
        );
      case "invalid":
        return apiError(
          c,
          422,
          "FLOW_GRAPH_INVALID",
          "Flow graph failed validation",
          { issues: graphIssuesBody(result.issues).issues },
        );
    }
  });

  // ---- Pemicu webhook (G17) --------------------------------------------------
  // Keadaan endpoint dibaca semua member; provision/rotasi & hapus =
  // owner/admin (token adalah kredensial pemicu). Token terang HANYA
  // keluar pada respons rotate — hash-only di DB, tidak ada baca ulang.
  function serializeWebhookTrigger(
    endpoint: Awaited<ReturnType<typeof getFlowWebhookEndpoint>>,
  ) {
    return FlowWebhookTriggerResponseSchema.parse({
      configured: endpoint !== null,
      endpointId: endpoint?.id ?? null,
      tokenPrefix: endpoint?.tokenPrefix ?? null,
      lastTriggeredAt: endpoint?.lastTriggeredAt?.toISOString() ?? null,
      createdAt: endpoint?.createdAt.toISOString() ?? null,
    });
  }

  app.get(`${base}/:id/webhook-trigger`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const flow = await getFlow(bundle.db, { tenantId: g.tenant.id, flowId: id });
    if (!flow) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const endpoint = await getFlowWebhookEndpoint(bundle.db, g.tenant.id, id);
    return c.json(serializeWebhookTrigger(endpoint));
  });

  app.post(`${base}/:id/webhook-trigger/rotate`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const result = await provisionFlowWebhookEndpoint(
      bundle.db,
      g.tenant.id,
      id,
      g.appUser.id,
    );
    if (!result) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    return c.json(
      FlowWebhookTriggerRotateResponseSchema.parse({
        ...serializeWebhookTrigger(result.endpoint),
        token: result.token,
      }),
    );
  });

  app.delete(`${base}/:id/webhook-trigger`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c, "id");
    if (!id) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    const flow = await getFlow(bundle.db, { tenantId: g.tenant.id, flowId: id });
    if (!flow) return apiError(c, 404, "NOT_FOUND", "Flow not found");
    await deleteFlowWebhookEndpoint(bundle.db, g.tenant.id, id, g.appUser.id);
    return c.json(serializeWebhookTrigger(null));
  });

  return app;
}
