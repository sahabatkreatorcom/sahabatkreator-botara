import { Hono } from "hono";
import { z } from "zod";
import {
  CreateWhatsAppTemplateRequestSchema,
  SyncWhatsAppTemplatesRequestSchema,
  SyncWhatsAppTemplatesResponseSchema,
  WhatsAppTemplateListQuerySchema,
  WhatsAppTemplateListResponseSchema,
  WhatsAppTemplateResponseSchema,
  type WhatsAppTemplateResponse,
} from "@sahabat-kreator/contracts";
import {
  decryptChannelSecret,
  deleteWhatsAppTemplateMirrorByName,
  getChannelAccount,
  getWhatsAppTemplateById,
  listWhatsAppTemplates,
  recordCreatedWhatsAppTemplate,
  replaceSyncedWhatsAppTemplates,
} from "@sahabat-kreator/core";
import type { ChannelAccount, WhatsAppTemplate } from "@sahabat-kreator/db";
import {
  WhatsAppCloudClient,
  WhatsAppGraphError,
  countTemplateVariables,
  deriveTemplateBody,
  type WhatsAppTemplateComponent,
} from "@sahabat-kreator/channel-whatsapp";
import { META_GRAPH_API_VERSION } from "@sahabat-kreator/config";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul whatsapp-templates (Fase 10A) — manajemen template pesan
 * resmi WhatsApp per akun channel:
 *   GET    /tenants/:tenantId/whatsapp-templates?channelAccountId=…
 *          daftar cermin lokal (semua member)
 *   POST   /tenants/:tenantId/whatsapp-templates/sync
 *          tarik daftar dari Meta → ganti cermin (owner/admin)
 *   POST   /tenants/:tenantId/whatsapp-templates
 *          buat template di Meta + catat cermin (owner/admin)
 *   DELETE /tenants/:tenantId/whatsapp-templates/:id
 *          hapus di Meta (berbasis nama) + hapus cermin (owner/admin)
 *
 * Pembagian kerja: route ini pemilik pemanggilan Graph (membangun
 * WhatsAppCloudClient dari token akun yang didekripsi sesaat);
 * core hanya menyimpan cermin + audit `whatsapp_template.*`.
 * Penolakan Graph diterjemahkan menjadi 422 META_TEMPLATE_INVALID —
 * pesan Graph mentah hanya masuk log server, tidak pernah ke klien,
 * dan token tidak pernah muncul di keduanya.
 */

export interface WhatsAppTemplatesModuleOptions {
  /** Rahasia enkripsi token channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string;
}

export function serializeTemplate(row: WhatsAppTemplate): WhatsAppTemplateResponse {
  return WhatsAppTemplateResponseSchema.parse({
    id: row.id,
    channelAccountId: row.channelAccountId,
    metaTemplateId: row.metaTemplateId,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    components: Array.isArray(row.components) ? row.components : [],
    bodyText: row.bodyText,
    variableCount: row.variableCount,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

type AccountGate =
  | { kind: "ok"; account: ChannelAccount }
  | { error: Response };

/** Muat akun + tegakkan provider whatsapp (tanpa syarat token). */
async function loadWhatsAppAccount(
  c: AppContext,
  bundle: AuthBundle,
  tenantId: string,
  channelAccountId: string,
): Promise<AccountGate> {
  const account = await getChannelAccount(
    bundle.db,
    { tenantId },
    channelAccountId,
  );
  if (!account || account.trashedAt) {
    return {
      error: apiError(c, 404, "NOT_FOUND", "Channel account not found"),
    };
  }
  if (account.provider !== "whatsapp") {
    return {
      error: apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Channel account is not a WhatsApp account",
      ),
    };
  }
  return { kind: "ok", account };
}

type ClientGate =
  | { kind: "ok"; client: WhatsAppCloudClient; wabaId: string }
  | { error: Response };

/** Bangun klien Graph dari token akun (syarat mutasi ke Meta). */
function buildClient(
  c: AppContext,
  opts: WhatsAppTemplatesModuleOptions,
  account: ChannelAccount,
): ClientGate {
  if (account.status !== "connected") {
    return {
      error: apiError(c, 409, "CHANNEL_DISCONNECTED", "Channel is not connected"),
    };
  }
  const wabaId = account.parentExternalId;
  if (!wabaId) {
    return {
      error: apiError(
        c,
        422,
        "META_WABA_MISSING",
        "WhatsApp account has no WABA id recorded",
      ),
    };
  }
  if (!account.accessTokenEncrypted || !opts.channelTokenSecret) {
    return {
      error: apiError(c, 503, "INTERNAL_ERROR", "WhatsApp is not configured"),
    };
  }
  const accessToken = decryptChannelSecret(
    opts.channelTokenSecret,
    account.accessTokenEncrypted,
  );
  if (!accessToken) {
    return {
      error: apiError(c, 503, "INTERNAL_ERROR", "WhatsApp is not configured"),
    };
  }
  return {
    kind: "ok",
    wabaId,
    client: new WhatsAppCloudClient({
      baseUrl: opts.metaApiBase,
      apiVersion: META_GRAPH_API_VERSION,
      accessToken,
    }),
  };
}

/** Terjemahkan error Graph → respons terkontrol (detail hanya ke log). */
function graphFailure(c: AppContext, err: unknown, operation: string) {
  if (err instanceof WhatsAppGraphError) {
    if (err.status === 0) {
      return apiError(c, 503, "INTERNAL_ERROR", "Meta Graph API is unreachable");
    }
    console.error(
      `[whatsapp-templates] ${operation} rejected by Meta: HTTP ${err.status} code=${err.graphCode ?? "?"} ${err.description}`,
    );
    return apiError(
      c,
      422,
      "META_TEMPLATE_INVALID",
      "Meta rejected the template operation",
    );
  }
  console.error(`[whatsapp-templates] ${operation} failed unexpectedly`, err);
  return apiError(c, 503, "INTERNAL_ERROR", "Meta Graph API is unreachable");
}

export function createWhatsAppTemplatesRoutes(
  bundle: AuthBundle | null,
  opts: WhatsAppTemplatesModuleOptions = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/whatsapp-templates";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(`${base}/sync`, unavailable);
    app.post(base, unavailable);
    app.delete(`${base}/:id`, unavailable);
    return app;
  }


  type GuardOk = {
    tenant: NonNullable<Awaited<ReturnType<typeof resolveTenantForUser>>>;
    appUser: { id: string };
  };
  async function guard(
    c: AppContext,
    guardOpts: { ownerAdmin: boolean },
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
    if (
      guardOpts.ownerAdmin &&
      tenant.role !== "owner" &&
      tenant.role !== "admin"
    ) {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage WhatsApp templates",
        ),
      };
    }
    return { tenant, appUser: { id: appUser.id } };
  }

  async function readJson(c: AppContext): Promise<unknown | null> {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  }

  // ---- Daftar cermin ------------------------------------------------------
  app.get(base, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const parsed = WhatsAppTemplateListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid template list query");
    }
    const gate = await loadWhatsAppAccount(
      c,
      bundle,
      g.tenant.id,
      parsed.data.channelAccountId,
    );
    if ("error" in gate) return gate.error;
    const rows = await listWhatsAppTemplates(bundle.db, {
      tenantId: g.tenant.id,
      channelAccountId: parsed.data.channelAccountId,
    });
    const body = WhatsAppTemplateListResponseSchema.parse({
      templates: rows.map(serializeTemplate),
    });
    return c.json(body);
  });

  // ---- Sinkron dari Meta ----------------------------------------------------
  app.post(`${base}/sync`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    const parsed = SyncWhatsAppTemplatesRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid sync payload");
    }
    const gate = await loadWhatsAppAccount(
      c,
      bundle,
      g.tenant.id,
      parsed.data.channelAccountId,
    );
    if ("error" in gate) return gate.error;
    const clientGate = buildClient(c, opts, gate.account);
    if ("error" in clientGate) return clientGate.error;
    let remote;
    try {
      remote = await clientGate.client.listMessageTemplates(clientGate.wabaId);
    } catch (err) {
      return graphFailure(c, err, "sync");
    }
    const rows = await replaceSyncedWhatsAppTemplates(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      channelAccountId: parsed.data.channelAccountId,
      templates: remote.map((t) => {
        const derived = deriveTemplateBody(t.components);
        return {
          metaTemplateId: t.id,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          components: t.components,
          bodyText: derived.bodyText,
          variableCount: derived.variableCount,
        };
      }),
    });
    const body = SyncWhatsAppTemplatesResponseSchema.parse({
      synced: rows.length,
      templates: rows.map(serializeTemplate),
    });
    return c.json(body);
  });

  // ---- Buat template ---------------------------------------------------------
  app.post(base, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    const parsed = CreateWhatsAppTemplateRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid template payload");
    }
    const data = parsed.data;
    const variableCount = countTemplateVariables(data.bodyText);
    if (
      data.bodyExamples !== undefined &&
      data.bodyExamples.length !== variableCount
    ) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Body examples must match the number of template variables",
      );
    }
    if (
      data.headerText &&
      countTemplateVariables(data.headerText) > 0
    ) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Header text cannot contain variables in this form",
      );
    }
    if (data.buttons?.some((b) => b.type === "URL" && !b.url)) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "URL buttons require a url",
      );
    }
    const gate = await loadWhatsAppAccount(
      c,
      bundle,
      g.tenant.id,
      data.channelAccountId,
    );
    if ("error" in gate) return gate.error;
    const clientGate = buildClient(c, opts, gate.account);
    if ("error" in clientGate) return clientGate.error;

    const components: WhatsAppTemplateComponent[] = [];
    if (data.headerText) {
      components.push({ type: "HEADER", format: "TEXT", text: data.headerText });
    }
    const bodyComponent: WhatsAppTemplateComponent = {
      type: "BODY",
      text: data.bodyText,
    };
    if (data.bodyExamples && data.bodyExamples.length > 0) {
      bodyComponent.example = { body_text: [data.bodyExamples] };
    }
    components.push(bodyComponent);
    if (data.footerText) {
      components.push({ type: "FOOTER", text: data.footerText });
    }
    if (data.buttons && data.buttons.length > 0) {
      components.push({
        type: "BUTTONS",
        buttons: data.buttons.map((b) =>
          b.type === "URL"
            ? { type: "URL", text: b.text, url: b.url }
            : { type: "QUICK_REPLY", text: b.text },
        ),
      });
    }

    let created;
    try {
      created = await clientGate.client.createMessageTemplate(
        clientGate.wabaId,
        {
          name: data.name,
          language: data.language,
          category: data.category,
          components,
        },
      );
    } catch (err) {
      return graphFailure(c, err, "create");
    }
    const row = await recordCreatedWhatsAppTemplate(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      channelAccountId: data.channelAccountId,
      template: {
        metaTemplateId: created.id,
        name: data.name,
        language: data.language,
        category: created.category,
        status: created.status,
        components,
        bodyText: data.bodyText,
        variableCount,
      },
    });
    return c.json(serializeTemplate(row), 201);
  });

  // ---- Hapus template ----------------------------------------------------------
  app.delete(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = c.req.param("id");
    if (!id || !z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "WhatsApp template not found");
    }
    const row = await getWhatsAppTemplateById(bundle.db, {
      tenantId: g.tenant.id,
      templateId: id,
    });
    if (!row) {
      return apiError(c, 404, "NOT_FOUND", "WhatsApp template not found");
    }
    const gate = await loadWhatsAppAccount(
      c,
      bundle,
      g.tenant.id,
      row.channelAccountId,
    );
    if ("error" in gate) return gate.error;
    const clientGate = buildClient(c, opts, gate.account);
    if ("error" in clientGate) return clientGate.error;
    try {
      // DELETE Meta berbasis NAMA (semua bahasa) — cermin mengikuti.
      await clientGate.client.deleteMessageTemplate(clientGate.wabaId, row.name);
    } catch (err) {
      return graphFailure(c, err, "delete");
    }
    await deleteWhatsAppTemplateMirrorByName(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      channelAccountId: row.channelAccountId,
      name: row.name,
      templateId: row.id,
    });
    return c.body(null, 204);
  });

  return app;
}
