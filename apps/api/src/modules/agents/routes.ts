import { Hono } from "hono";
import { z } from "zod";
import {
  AgentInstructionTemplateListResponseSchema,
  AgentInstructionTemplateResponseSchema,
  AgentListResponseSchema,
  AgentPlaygroundDraftRequestSchema,
  AgentPlaygroundRequestSchema,
  AgentPlaygroundResponseSchema,
  AgentResponseSchema,
  AgentSuggestionListResponseSchema,
  AgentSuggestionResponseSchema,
  AgentSuggestionStatusSchema,
  CreateAgentInstructionTemplateRequestSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  type AgentInstructionTemplateResponse,
  type AgentPlaygroundResponse,
  type AgentResponse,
  type AgentSuggestionResponse,
} from "@sahabat-kreator/contracts";
import {
  approveSuggestion,
  createAgent,
  createAgentInstructionTemplate,
  deleteAgentInstructionTemplate,
  listAgentInstructionTemplates,
  listAgents,
  listSuggestions,
  rejectSuggestion,
  resolveAgentLlmProvider,
  resolveEmbeddingProvider,
  runAgentPlayground,
  runAgentPlaygroundDraft,
  updateAgent,
  type AgentPlaygroundOutcome,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import type {
  Agent,
  AgentInstructionTemplate,
  AgentSuggestion,
} from "@sahabat-kreator/db";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

export function serializeAgent(row: Agent): AgentResponse {
  return AgentResponseSchema.parse({
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    model: row.model,
    mode: row.mode,
    isActive: row.isActive,
    config: row.config,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function serializeAgentInstructionTemplate(
  row: AgentInstructionTemplate,
): AgentInstructionTemplateResponse {
  return AgentInstructionTemplateResponseSchema.parse({
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    mode: row.mode,
    language: row.language,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Serialisasi respons playground — dipakai handler agent tersimpan
 * DAN handler draf agar kedua jalur menjawab dengan bentuk persis sama.
 */
function serializePlaygroundOutcome(
  outcome: Extract<AgentPlaygroundOutcome, { kind: "ok" }>,
): AgentPlaygroundResponse {
  return AgentPlaygroundResponseSchema.parse({
    replyText: outcome.replyText,
    mode: outcome.mode,
    retrieval: outcome.retrieval,
    kbHits: outcome.kbHits.map((h) => ({
      chunkId: h.chunkId,
      documentId: h.documentId,
      documentTitle: h.documentTitle,
      chunkIndex: h.chunkIndex,
      snippet: h.content.slice(0, 280),
      sources: h.sources,
    })),
    intents: outcome.intents.map((intent) =>
      intent.kind === "unknown"
        ? { kind: intent.kind, toolName: intent.toolName }
        : intent,
    ),
    usage: {
      provider: outcome.usage.provider,
      model: outcome.usage.model,
      tokensIn: outcome.usage.tokensIn,
      tokensOut: outcome.usage.tokensOut,
      costUsd: outcome.usage.costUsd ?? null,
    },
  });
}

function serializeSuggestion(row: AgentSuggestion): AgentSuggestionResponse {
  return AgentSuggestionResponseSchema.parse({
    id: row.id,
    agentId: row.agentId,
    conversationId: row.conversationId,
    triggerMessageId: row.triggerMessageId,
    contactId: row.contactId,
    suggestedText: row.suggestedText,
    status: row.status,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Dependensi playground (Fase 12E): resolver Panel Admin proses API +
 * env provider — pola yang sama seperti status semantik modul knowledge
 * (Fase 12D), agar provider yang dipakai playground PERSIS provider yang
 * akan dipakai worker (kunci panel → env; mock hanya dari env/default).
 */
export interface AgentsRoutesDeps {
  platform?: PlatformSettingsOptions;
  /** Nilai env LLM_PROVIDER proses ini ('mock' | 'openrouter'). */
  llmProviderEnv?: string;
  /** Nilai env EMBEDDING_PROVIDER proses ini ('mock' | 'openrouter' | undefined). */
  embeddingProviderEnv?: string;
  /** Nilai env OPENROUTER_EMBEDDING_MODEL proses ini. */
  embeddingModelEnv?: string;
}

/**
 * Modul agents (Fase 3A) — manajemen agent AI workspace + antrean draf
 * balasan mode 'suggest':
 *   POST  /tenants/:tenantId/agents                  buat → 201
 *   GET   /tenants/:tenantId/agents                  daftar
 *   POST  /tenants/:tenantId/agents/playground-draft uji kering konfigurasi DRAF formulir (belum tersimpan) → balasan + potongan KB + niat tool
 *   PATCH /tenants/:tenantId/agents/:id              ubah name/systemPrompt/model/mode/isActive/config
 *   POST  /tenants/:tenantId/agents/:id/playground   uji kering agent (Fase 12E) → balasan + potongan KB + niat tool
 *   POST  /tenants/:tenantId/agent-templates         simpan templat instruction pribadi → 201
 *   GET   /tenants/:tenantId/agent-templates         daftar templat instruction pribadi
 *   DELETE /tenants/:tenantId/agent-templates/:id    hapus templat instruction pribadi → baris terhapus
 *   GET   /tenants/:tenantId/suggestions?status=     draf balasan agent
 *   POST  /tenants/:tenantId/suggestions/:id/approve kirim teks saran sbg pesan agent
 *   POST  /tenants/:tenantId/suggestions/:id/reject  tolak draf
 * Wajib sesi + membership workspace (non-member → 404 TENANT_NOT_FOUND,
 * pola Fase 1B/1D). Runtime agent berjalan di worker (job `agent.respond`),
 * bukan di proses API ini; playground adalah satu-satunya jalur agent
 * yang dieksekusi proses API — dan ia kering secara konstruksi (core
 * `runAgentPlayground` tidak mengeksekusi tool & tidak menulis data
 * percakapan; hanya usage playground yang tercatat).
 */
export function createAgentsRoutes(
  bundle: AuthBundle | null,
  publisher?: RealtimePublisher | null,
  deps: AgentsRoutesDeps = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const agentsBase = "/tenants/:tenantId/agents";
  const templatesBase = "/tenants/:tenantId/agent-templates";
  const suggestionsBase = "/tenants/:tenantId/suggestions";

  if (!bundle) {
    const notConfigured = (c: Parameters<typeof apiError>[0]) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.post(agentsBase, notConfigured);
    app.get(agentsBase, notConfigured);
    app.post(`${agentsBase}/playground-draft`, notConfigured);
    app.patch(`${agentsBase}/:id`, notConfigured);
    app.post(`${agentsBase}/:id/playground`, notConfigured);
    app.post(templatesBase, notConfigured);
    app.get(templatesBase, notConfigured);
    app.delete(`${templatesBase}/:id`, notConfigured);
    app.get(suggestionsBase, notConfigured);
    app.post(`${suggestionsBase}/:id/approve`, notConfigured);
    app.post(`${suggestionsBase}/:id/reject`, notConfigured);
    return app;
  }


  const resolveTenant = async (c: AppContext) =>
    resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      c.get("appUser").id,
    );

  const parseJson = async (c: AppContext): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  /**
   * Resolusi provider playground — dipakai handler tersimpan DAN draf
   * agar yang diuji persis provider yang akan menjawab sungguhan.
   * Kegagalan resolusi LLM DILEMPAR (pemanggil memetakannya ke 502);
   * embedding adalah peningkat: kegagalan resolusi = nonaktif
   * (retrieval full-text murni), tidak pernah menggagalkan playground.
   */
  const resolvePlaygroundProviders = async () => {
    const llmProvider = await resolveAgentLlmProvider(bundle.db, {
      platform: deps.platform,
      providerEnv: deps.llmProviderEnv,
    });
    const embeddingProvider = deps.platform
      ? await resolveEmbeddingProvider(bundle.db, {
          platform: deps.platform,
          providerEnv: deps.embeddingProviderEnv,
          modelEnv: deps.embeddingModelEnv,
        }).catch(() => null)
      : null;
    return { llmProvider, embeddingProvider };
  };

  app.post(agentsBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const json = await parseJson(c);
    if (json === undefined) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateAgentRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid agent payload");
    }
    const created = await createAgent(
      bundle.db,
      { tenantId: tenant.id },
      parsed.data,
    );
    return c.json(serializeAgent(created), 201);
  });

  app.get(agentsBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listAgents(bundle.db, { tenantId: tenant.id });
    const body = AgentListResponseSchema.parse({
      agents: rows.map(serializeAgent),
    });
    return c.json(body);
  });

  // Playground draf: uji kering konfigurasi formulir yang BELUM
  // tersimpan. Didaftarkan SEBELUM rute `:id` agar segmen literal
  // `playground-draft` tidak pernah ditafsirkan sebagai id agent.
  // Resolusi provider + serialisasi respons sama persis dengan
  // playground tersimpan di bawah.
  app.post(`${agentsBase}/playground-draft`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const json = await parseJson(c);
    if (json === undefined) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = AgentPlaygroundDraftRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid playground payload");
    }

    let providers;
    try {
      providers = await resolvePlaygroundProviders();
    } catch {
      return apiError(
        c,
        502,
        "AGENT_PROVIDER_ERROR",
        "AI provider is not configured correctly",
      );
    }

    const outcome = await runAgentPlaygroundDraft(
      bundle.db,
      providers.llmProvider,
      {
        tenantId: tenant.id,
        draft: parsed.data.draft,
        message: parsed.data.message,
        history: parsed.data.history,
        embeddingProvider: providers.embeddingProvider,
      },
    );
    if (outcome.kind === "provider_error") {
      return apiError(
        c,
        502,
        "AGENT_PROVIDER_ERROR",
        "AI provider failed to respond",
      );
    }
    if (outcome.kind === "agent_not_found") {
      // Tidak mungkin pada jalur draf (agent sintetis selalu ada);
      // dijaga hanya agar penyempitan tipe tuntas.
      return apiError(c, 404, "NOT_FOUND", "Agent not found");
    }
    return c.json(serializePlaygroundOutcome(outcome));
  });

  app.patch(`${agentsBase}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Agent not found");
    }
    const json = await parseJson(c);
    if (json === undefined) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateAgentRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid agent payload");
    }
    const updated = await updateAgent(
      bundle.db,
      { tenantId: tenant.id },
      id,
      parsed.data,
    );
    if (!updated) return apiError(c, 404, "NOT_FOUND", "Agent not found");
    return c.json(serializeAgent(updated));
  });

  // Playground (Fase 12E): uji kering SATU agent pilihan pemilik.
  // Provider di-resolve per request dengan resolver yang sama seperti
  // worker (Panel → env) agar yang diuji = yang akan menjawab sungguhan.
  app.post(`${agentsBase}/:id/playground`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Agent not found");
    }
    const json = await parseJson(c);
    if (json === undefined) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = AgentPlaygroundRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid playground payload");
    }

    let providers;
    try {
      providers = await resolvePlaygroundProviders();
    } catch {
      return apiError(
        c,
        502,
        "AGENT_PROVIDER_ERROR",
        "AI provider is not configured correctly",
      );
    }

    const outcome = await runAgentPlayground(bundle.db, providers.llmProvider, {
      tenantId: tenant.id,
      agentId: id,
      message: parsed.data.message,
      history: parsed.data.history,
      embeddingProvider: providers.embeddingProvider,
    });
    if (outcome.kind === "agent_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Agent not found");
    }
    if (outcome.kind === "provider_error") {
      return apiError(
        c,
        502,
        "AGENT_PROVIDER_ERROR",
        "AI provider failed to respond",
      );
    }
    return c.json(serializePlaygroundOutcome(outcome));
  });

  // Templat instruction pribadi tenant: buat/daftar/hapus salinan
  // instruction dari formulir agent. Penanda "[...]" yang belum diganti
  // BUKAN kesalahan di sini — skema kontrak sengaja hanya membatasi
  // panjang, sama seperti pembuatan agent.
  app.post(templatesBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const json = await parseJson(c);
    if (json === undefined) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateAgentInstructionTemplateRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid agent template payload");
    }
    const created = await createAgentInstructionTemplate(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      parsed.data,
    );
    return c.json(serializeAgentInstructionTemplate(created), 201);
  });

  app.get(templatesBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listAgentInstructionTemplates(bundle.db, {
      tenantId: tenant.id,
    });
    const body = AgentInstructionTemplateListResponseSchema.parse({
      templates: rows.map(serializeAgentInstructionTemplate),
    });
    return c.json(body);
  });

  app.delete(`${templatesBase}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Agent template not found");
    }
    const deleted = await deleteAgentInstructionTemplate(
      bundle.db,
      { tenantId: tenant.id },
      id,
    );
    if (!deleted) {
      return apiError(c, 404, "NOT_FOUND", "Agent template not found");
    }
    return c.json(serializeAgentInstructionTemplate(deleted));
  });

  app.get(suggestionsBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const statusRaw = c.req.query("status");
    let status: AgentSuggestion["status"] | undefined;
    if (statusRaw !== undefined) {
      const statusParsed = AgentSuggestionStatusSchema.safeParse(statusRaw);
      if (!statusParsed.success) {
        return apiError(c, 400, "VALIDATION_ERROR", "Invalid status filter");
      }
      status = statusParsed.data;
    }
    const rows = await listSuggestions(
      bundle.db,
      { tenantId: tenant.id },
      { status, limit: 100 },
    );
    const body = AgentSuggestionListResponseSchema.parse({
      suggestions: rows.map(serializeSuggestion),
    });
    return c.json(body);
  });

  app.post(`${suggestionsBase}/:id/approve`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Suggestion not found");
    }
    const outcome = await approveSuggestion(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      id,
    );
    if (outcome.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Suggestion not found");
    }
    if (outcome.kind === "not_pending") {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Suggestion is not pending",
      );
    }
    // Fase 6G: approve mengirim pesan outbound sungguhan — nudge agar
    // realtime mem-flush ke pengunjung webchat & dashboard menyegar.
    if (publisher) {
      await publisher.publishNudge({
        kind: "message.queued",
        tenantId: tenant.id,
        conversationId: outcome.suggestion.conversationId,
      });
    }
    return c.json(serializeSuggestion(outcome.suggestion));
  });

  app.post(`${suggestionsBase}/:id/reject`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Suggestion not found");
    }
    const outcome = await rejectSuggestion(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      id,
    );
    if (outcome.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Suggestion not found");
    }
    if (outcome.kind === "not_pending") {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Suggestion is not pending",
      );
    }
    return c.json(serializeSuggestion(outcome.suggestion));
  });

  return app;
}
