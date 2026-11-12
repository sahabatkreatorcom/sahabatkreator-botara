import { Hono } from "hono";
import { z } from "zod";
import {
  BroadcastRecurrenceListQuerySchema,
  BroadcastRecurrenceListResponseSchema,
  BroadcastRecurrenceOccurrenceListQuerySchema,
  BroadcastRecurrenceOccurrenceListResponseSchema,
  BroadcastRecurrenceOccurrenceResponseSchema,
  BroadcastRecurrencePreviewRequestSchema,
  BroadcastRecurrencePreviewResponseSchema,
  BroadcastRecurrenceResponseSchema,
  CreateBroadcastRecurrenceRequestSchema,
  UpdateBroadcastRecurrenceRequestSchema,
  type BroadcastRecurrenceOccurrenceResponse,
  type BroadcastRecurrenceResponse,
} from "@sahabat-kreator/contracts";
import type { BroadcastRecurrenceOccurrence } from "@sahabat-kreator/db";
import {
  cancelBroadcastRecurrenceRule,
  createBroadcastRecurrenceRule,
  getBroadcastRecurrenceRule,
  listBroadcastRecurrenceOccurrences,
  listBroadcastRecurrenceRules,
  pauseBroadcastRecurrenceRule,
  previewRecurrenceSlots,
  resumeBroadcastRecurrenceRule,
  updateBroadcastRecurrenceRule,
  validateRecurrencePattern,
  type BroadcastRecurrenceRuleWithChannel,
  type CreateBroadcastRecurrenceResult,
  type UpdateBroadcastRecurrenceResult,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul broadcast-recurrences (G9) — aturan broadcast BERULANG:
 *   GET    /tenants/:tenantId/broadcast-recurrences                 daftar aturan
 *   POST   /tenants/:tenantId/broadcast-recurrences                 buat aturan (owner/admin)
 *   POST   /tenants/:tenantId/broadcast-recurrences/preview         pratinjau slot pola (belum disimpan)
 *   GET    /tenants/:tenantId/broadcast-recurrences/:id             detail aturan
 *   PATCH  /tenants/:tenantId/broadcast-recurrences/:id             edit (active/paused; owner/admin)
 *   POST   /tenants/:tenantId/broadcast-recurrences/:id/pause       jeda (owner/admin)
 *   POST   /tenants/:tenantId/broadcast-recurrences/:id/resume      lanjutkan (owner/admin)
 *   POST   /tenants/:tenantId/broadcast-recurrences/:id/cancel      batalkan (owner/admin)
 *   GET    /tenants/:tenantId/broadcast-recurrences/:id/occurrences ledger kejadian per slot
 *
 * Modul ini TIDAK mengirim apa pun: penyapu worker mematerialisasi
 * slot jatuh tempo menjadi broadcast biasa lewat jalur broadcasts
 * yang ada. Akses selaras broadcasts: mutasi owner/admin, baca semua
 * member; non-member selalu 404 TENANT_NOT_FOUND.
 */

export function serializeRecurrenceRule(
  rule: BroadcastRecurrenceRuleWithChannel,
): BroadcastRecurrenceResponse {
  return BroadcastRecurrenceResponseSchema.parse({
    id: rule.id,
    sourceBroadcastId: rule.sourceBroadcastId ?? null,
    channelAccountId: rule.channelAccountId,
    provider: rule.provider,
    channelDisplayName: rule.channelDisplayName,
    name: rule.name,
    messageText: rule.messageText,
    whatsappTemplateId: rule.whatsappTemplateId ?? null,
    templateVariableSources: rule.templateVariableSources ?? [],
    audienceFilter: rule.audienceFilter ?? {},
    requireOptIn: rule.requireOptIn ?? false,
    abSplitPercentB: rule.abSplitPercentB ?? null,
    variantBMessageText: rule.variantBMessageText ?? null,
    variantBWhatsappTemplateId: rule.variantBWhatsappTemplateId ?? null,
    variantBTemplateVariableSources: rule.variantBTemplateVariableSources ?? [],
    frequency: rule.frequency,
    interval: rule.interval,
    daysOfWeek: (rule.daysOfWeek as number[] | null) ?? [],
    dayOfMonth: rule.dayOfMonth ?? null,
    lastDayOfMonth: rule.lastDayOfMonth ?? false,
    timezone: rule.timezone,
    startsAt: rule.startsAt.toISOString(),
    endsAt: rule.endsAt?.toISOString() ?? null,
    maxOccurrences: rule.maxOccurrences ?? null,
    occurrencesCreated: rule.occurrencesCreated,
    status: rule.status,
    nextRunAt: rule.nextRunAt?.toISOString() ?? null,
    createdByUserId: rule.createdByUserId,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  });
}

function serializeOccurrence(
  occurrence: BroadcastRecurrenceOccurrence,
): BroadcastRecurrenceOccurrenceResponse {
  return BroadcastRecurrenceOccurrenceResponseSchema.parse({
    id: occurrence.id,
    ruleId: occurrence.ruleId,
    slotAt: occurrence.slotAt.toISOString(),
    status: occurrence.status,
    reason: occurrence.reason,
    broadcastId: occurrence.broadcastId ?? null,
    createdAt: occurrence.createdAt.toISOString(),
    updatedAt: occurrence.updatedAt.toISOString(),
  });
}

export function createBroadcastRecurrenceRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/broadcast-recurrences";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.post(`${base}/preview`, unavailable);
    app.get(`${base}/:id`, unavailable);
    app.patch(`${base}/:id`, unavailable);
    app.post(`${base}/:id/pause`, unavailable);
    app.post(`${base}/:id/resume`, unavailable);
    app.post(`${base}/:id/cancel`, unavailable);
    app.get(`${base}/:id/occurrences`, unavailable);
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
          "Only workspace owners and admins can manage recurring broadcasts",
        ),
      };
    }
    return { tenant, appUser: { id: appUser.id } };
  }

  function parseRuleId(c: AppContext): string | null {
    const id = c.req.param("id");
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  function invalidState(c: AppContext, status: string) {
    return apiError(
      c,
      409,
      "BROADCAST_RECURRENCE_INVALID_STATE",
      `Recurring broadcast in status '${status}' cannot perform this action`,
    );
  }

  /** Menerjemahkan hasil gerbang definisi/pola core menjadi respons API. */
  function definitionError(
    c: AppContext,
    result:
      | Exclude<CreateBroadcastRecurrenceResult, { kind: "created" }>
      | Exclude<UpdateBroadcastRecurrenceResult, { kind: "updated" }>,
  ): Response {
    switch (result.kind) {
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Recurring broadcast not found");
      case "invalid_state":
        return invalidState(c, result.status);
      case "source_not_found":
        return apiError(c, 404, "NOT_FOUND", "Source broadcast not found");
      case "invalid_pattern":
        return apiError(
          c,
          400,
          "VALIDATION_ERROR",
          `Invalid recurrence pattern: ${result.reason}`,
        );
      case "definition_incomplete":
        return apiError(
          c,
          400,
          "VALIDATION_ERROR",
          "A channel and a name are required (directly or via a source broadcast)",
        );
      case "channel_not_found":
        return apiError(c, 404, "NOT_FOUND", "Channel account not found");
      case "channel_unsupported":
        return apiError(
          c,
          422,
          "BROADCAST_CHANNEL_UNSUPPORTED",
          `Broadcasts are not supported for provider '${result.provider}' yet`,
        );
      case "template_required":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_REQUIRED",
          "WhatsApp broadcasts require an approved message template",
        );
      case "template_not_found":
        return apiError(c, 404, "NOT_FOUND", "WhatsApp template not found");
      case "template_not_approved":
        return apiError(
          c,
          422,
          "BROADCAST_TEMPLATE_NOT_APPROVED",
          `WhatsApp template is not approved (status '${result.status}')`,
        );
      case "segment_not_found":
        return apiError(c, 404, "NOT_FOUND", "Segment not found");
      case "message_required":
        return apiError(
          c,
          400,
          "VALIDATION_ERROR",
          "Message text is required for this provider",
        );
      case "ab_incomplete":
        return apiError(
          c,
          422,
          "BROADCAST_AB_INCOMPLETE",
          "A/B test is enabled but variant B content is missing or invalid for this channel",
        );
    }
  }

  async function readJson(c: AppContext): Promise<unknown | null> {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  }

  // ---- Daftar -------------------------------------------------------------
  app.get(base, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const parsed = BroadcastRecurrenceListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid recurrence list query");
    }
    const page = await listBroadcastRecurrenceRules(bundle.db, {
      tenantId: g.tenant.id,
      status: parsed.data.status,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    return c.json(
      BroadcastRecurrenceListResponseSchema.parse({
        rules: page.rules.map(serializeRecurrenceRule),
        nextCursor: page.nextCursor,
      }),
    );
  });

  // ---- Pratinjau slot (sebelum route :id agar tidak tertangkap) -----------
  app.post(`${base}/preview`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = BroadcastRecurrencePreviewRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid recurrence preview payload");
    }
    const pattern = {
      frequency: parsed.data.frequency,
      interval: parsed.data.interval ?? 1,
      daysOfWeek: parsed.data.daysOfWeek ?? [],
      dayOfMonth: parsed.data.dayOfMonth ?? null,
      lastDayOfMonth: parsed.data.lastDayOfMonth ?? false,
      timezone: parsed.data.timezone ?? g.tenant.timezone,
      startsAt: new Date(parsed.data.startsAt),
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
    };
    const invalid = validateRecurrencePattern(pattern);
    if (invalid) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        `Invalid recurrence pattern: ${invalid}`,
      );
    }
    const slots = previewRecurrenceSlots(pattern, {
      count: parsed.data.count ?? 5,
      from: parsed.data.from ? new Date(parsed.data.from) : new Date(),
    });
    return c.json(
      BroadcastRecurrencePreviewResponseSchema.parse({
        slots: slots.map((s) => s.toISOString()),
        timezone: pattern.timezone,
      }),
    );
  });

  // ---- Buat aturan -----------------------------------------------------------
  app.post(base, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateBroadcastRecurrenceRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid recurrence payload");
    }
    const result = await createBroadcastRecurrenceRule(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      sourceBroadcastId: parsed.data.sourceBroadcastId,
      definition: {
        name: parsed.data.name,
        channelAccountId: parsed.data.channelAccountId,
        messageText: parsed.data.messageText,
        whatsappTemplateId: parsed.data.whatsappTemplateId,
        templateVariableSources: parsed.data.templateVariableSources,
        audienceFilter: parsed.data.audienceFilter,
        requireOptIn: parsed.data.requireOptIn,
        abSplitPercentB: parsed.data.abSplitPercentB,
        variantBMessageText: parsed.data.variantBMessageText,
        variantBWhatsappTemplateId: parsed.data.variantBWhatsappTemplateId,
        variantBTemplateVariableSources:
          parsed.data.variantBTemplateVariableSources,
      },
      pattern: {
        frequency: parsed.data.frequency,
        interval: parsed.data.interval,
        daysOfWeek: parsed.data.daysOfWeek,
        dayOfMonth: parsed.data.dayOfMonth,
        lastDayOfMonth: parsed.data.lastDayOfMonth,
        timezone: parsed.data.timezone ?? g.tenant.timezone,
        startsAt: new Date(parsed.data.startsAt),
        endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
        maxOccurrences: parsed.data.maxOccurrences ?? null,
      },
    });
    if (result.kind === "created") {
      return c.json(serializeRecurrenceRule(result.rule), 201);
    }
    return definitionError(c, result);
  });

  // ---- Detail ---------------------------------------------------------------
  app.get(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseRuleId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Recurring broadcast not found");
    const rule = await getBroadcastRecurrenceRule(bundle.db, {
      tenantId: g.tenant.id,
      ruleId: id,
    });
    if (!rule) return apiError(c, 404, "NOT_FOUND", "Recurring broadcast not found");
    return c.json(serializeRecurrenceRule(rule));
  });

  // ---- Edit -------------------------------------------------------------------
  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseRuleId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Recurring broadcast not found");
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateBroadcastRecurrenceRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid recurrence payload");
    }
    const result = await updateBroadcastRecurrenceRule(bundle.db, {
      tenantId: g.tenant.id,
      ruleId: id,
      userId: g.appUser.id,
      definition: {
        name: parsed.data.name,
        channelAccountId: parsed.data.channelAccountId,
        messageText: parsed.data.messageText,
        whatsappTemplateId: parsed.data.whatsappTemplateId,
        templateVariableSources: parsed.data.templateVariableSources,
        audienceFilter: parsed.data.audienceFilter,
        requireOptIn: parsed.data.requireOptIn,
        abSplitPercentB: parsed.data.abSplitPercentB,
        variantBMessageText: parsed.data.variantBMessageText,
        variantBWhatsappTemplateId: parsed.data.variantBWhatsappTemplateId,
        variantBTemplateVariableSources:
          parsed.data.variantBTemplateVariableSources,
      },
      pattern: {
        frequency: parsed.data.frequency,
        interval: parsed.data.interval,
        daysOfWeek: parsed.data.daysOfWeek,
        dayOfMonth: parsed.data.dayOfMonth,
        lastDayOfMonth: parsed.data.lastDayOfMonth,
        timezone: parsed.data.timezone,
        startsAt: parsed.data.startsAt
          ? new Date(parsed.data.startsAt)
          : undefined,
        endsAt:
          parsed.data.endsAt === undefined
            ? undefined
            : parsed.data.endsAt
              ? new Date(parsed.data.endsAt)
              : null,
        maxOccurrences: parsed.data.maxOccurrences,
      },
    });
    if (result.kind === "updated") {
      return c.json(serializeRecurrenceRule(result.rule));
    }
    return definitionError(c, result);
  });

  // ---- Jeda / lanjut / batal ---------------------------------------------------
  const stateAction = (
    path: string,
    fn: typeof pauseBroadcastRecurrenceRule,
  ) => {
    app.post(`${base}/:id/${path}`, async (c) => {
      const g = await guard(c, { ownerAdmin: true });
      if ("error" in g) return g.error;
      const id = parseRuleId(c);
      if (!id) return apiError(c, 404, "NOT_FOUND", "Recurring broadcast not found");
      const result = await fn(bundle.db, {
        tenantId: g.tenant.id,
        ruleId: id,
        userId: g.appUser.id,
      });
      switch (result.kind) {
        case "changed":
          return c.json(serializeRecurrenceRule(result.rule));
        case "not_found":
          return apiError(c, 404, "NOT_FOUND", "Recurring broadcast not found");
        case "invalid_state":
          return invalidState(c, result.status);
      }
    });
  };
  stateAction("pause", pauseBroadcastRecurrenceRule);
  stateAction("resume", resumeBroadcastRecurrenceRule);
  stateAction("cancel", cancelBroadcastRecurrenceRule);

  // ---- Ledger kejadian ---------------------------------------------------------
  app.get(`${base}/:id/occurrences`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseRuleId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Recurring broadcast not found");
    const parsed = BroadcastRecurrenceOccurrenceListQuerySchema.safeParse(
      c.req.query(),
    );
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid occurrence list query");
    }
    const result = await listBroadcastRecurrenceOccurrences(bundle.db, {
      tenantId: g.tenant.id,
      ruleId: id,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Recurring broadcast not found");
    }
    return c.json(
      BroadcastRecurrenceOccurrenceListResponseSchema.parse({
        occurrences: result.occurrences.map(serializeOccurrence),
        nextCursor: result.nextCursor,
      }),
    );
  });

  return app;
}
