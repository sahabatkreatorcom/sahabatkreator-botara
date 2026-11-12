import { Hono } from "hono";
import { z } from "zod";
import {
  CreatePostRecurrenceRuleRequestSchema,
  PostRecurrenceOccurrenceListQuerySchema,
  PostRecurrenceOccurrenceListResponseSchema,
  PostRecurrenceOccurrenceResponseSchema,
  PostRecurrencePreviewRequestSchema,
  PostRecurrencePreviewResponseSchema,
  PostRecurrenceRuleListQuerySchema,
  PostRecurrenceRuleListResponseSchema,
  PostRecurrenceRuleResponseSchema,
  UpdatePostRecurrenceRuleRequestSchema,
  type PostRecurrenceOccurrenceResponse,
  type PostRecurrenceRuleResponse,
} from "@sahabat-kreator/contracts";
import type { PostRecurrenceOccurrence } from "@sahabat-kreator/db";
import {
  cancelPostRecurrenceRule,
  createPostRecurrenceRule,
  getPostRecurrenceRule,
  listPostRecurrenceOccurrences,
  listPostRecurrenceRules,
  pausePostRecurrenceRule,
  previewRecurrenceSlots,
  resumePostRecurrenceRule,
  updatePostRecurrenceRule,
  validateRecurrencePattern,
  type CreatePostRecurrenceResult,
  type PostRecurrenceRuleRecord,
  type UpdatePostRecurrenceResult,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul post-recurrences (Fase Susulan S2) — aturan postingan
 * BERULANG untuk /posts:
 *   GET    /tenants/:tenantId/post-recurrences                 daftar aturan
 *   POST   /tenants/:tenantId/post-recurrences                 buat aturan (owner/admin)
 *   POST   /tenants/:tenantId/post-recurrences/preview         pratinjau slot pola (belum disimpan)
 *   GET    /tenants/:tenantId/post-recurrences/:id             detail aturan
 *   PATCH  /tenants/:tenantId/post-recurrences/:id             edit (active/paused; owner/admin)
 *   POST   /tenants/:tenantId/post-recurrences/:id/pause       jeda (owner/admin)
 *   POST   /tenants/:tenantId/post-recurrences/:id/resume      lanjutkan (owner/admin)
 *   POST   /tenants/:tenantId/post-recurrences/:id/cancel      batalkan (owner/admin)
 *   GET    /tenants/:tenantId/post-recurrences/:id/occurrences ledger kejadian per slot
 *
 * Modul ini TIDAK menerbitkan apa pun: penyapu worker
 * mematerialisasi slot jatuh tempo menjadi postingan terjadwal
 * biasa lewat jalur posts yang ada (gerbang persetujuan S1 berlaku
 * apa adanya). Akses selaras posts: mutasi owner/admin, baca semua
 * member; non-member selalu 404 TENANT_NOT_FOUND.
 */

export function serializePostRecurrenceRule(
  rule: PostRecurrenceRuleRecord,
): PostRecurrenceRuleResponse {
  return PostRecurrenceRuleResponseSchema.parse({
    id: rule.id,
    sourcePostId: rule.sourcePostId ?? null,
    name: rule.name,
    title: rule.title,
    caption: rule.caption,
    mediaIds: rule.mediaIds ?? [],
    targets: rule.targets.map((target) => ({
      conversationId: target.conversationId,
      ...(target.caption !== undefined ? { caption: target.caption } : {}),
      publishOptions: target.publishOptions ?? null,
      provider: target.provider,
      conversationTitle: target.conversationTitle,
      channelDisplayName: target.channelDisplayName,
    })),
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
  occurrence: PostRecurrenceOccurrence,
): PostRecurrenceOccurrenceResponse {
  return PostRecurrenceOccurrenceResponseSchema.parse({
    id: occurrence.id,
    ruleId: occurrence.ruleId,
    slotAt: occurrence.slotAt.toISOString(),
    status: occurrence.status,
    reason: occurrence.reason,
    postGroupId: occurrence.postGroupId ?? null,
    postIds: (occurrence.postIds as string[] | null) ?? [],
    createdAt: occurrence.createdAt.toISOString(),
    updatedAt: occurrence.updatedAt.toISOString(),
  });
}

export function createPostRecurrenceRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/post-recurrences";

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
          "Only workspace owners and admins can manage recurring posts",
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
      "POST_RECURRENCE_INVALID_STATE",
      `Recurring post rule in status '${status}' cannot perform this action`,
    );
  }

  /** Menerjemahkan hasil gerbang templat/pola core menjadi respons API. */
  function definitionError(
    c: AppContext,
    result:
      | Exclude<CreatePostRecurrenceResult, { kind: "created" }>
      | Exclude<UpdatePostRecurrenceResult, { kind: "updated" }>,
  ): Response {
    switch (result.kind) {
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Recurring post rule not found");
      case "invalid_state":
        return invalidState(c, result.status);
      case "source_not_found":
        return apiError(c, 404, "NOT_FOUND", "Source post not found");
      case "invalid_pattern":
        return apiError(
          c,
          400,
          "VALIDATION_ERROR",
          `Invalid recurrence pattern: ${result.reason}`,
        );
      case "template_incomplete":
        return apiError(
          c,
          400,
          "VALIDATION_ERROR",
          "A title and at least one target are required (directly or via a source post)",
        );
      case "target_not_found":
        return apiError(
          c,
          404,
          "POST_TARGET_NOT_FOUND",
          "A target is not a channel conversation of this workspace",
        );
      case "target_not_connected":
        return apiError(
          c,
          422,
          "POST_TARGET_NOT_CONNECTED",
          "A target channel account is not connected",
        );
      case "media_not_found":
        return apiError(
          c,
          422,
          "POST_MEDIA_NOT_FOUND",
          "A template media item was not found",
        );
      case "media_too_many":
        return apiError(
          c,
          422,
          "POST_MEDIA_TOO_MANY",
          "The template carries more media than a post may hold",
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
    const parsed = PostRecurrenceRuleListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid recurrence list query");
    }
    const page = await listPostRecurrenceRules(bundle.db, {
      tenantId: g.tenant.id,
      status: parsed.data.status,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    return c.json(
      PostRecurrenceRuleListResponseSchema.parse({
        rules: page.rules.map(serializePostRecurrenceRule),
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
    const parsed = PostRecurrencePreviewRequestSchema.safeParse(json);
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
      PostRecurrencePreviewResponseSchema.parse({
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
    const parsed = CreatePostRecurrenceRuleRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid recurrence payload");
    }
    const result = await createPostRecurrenceRule(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      sourcePostId: parsed.data.sourcePostId,
      name: parsed.data.name,
      template: {
        title: parsed.data.title,
        caption: parsed.data.caption,
        mediaIds: parsed.data.mediaIds,
        targets: parsed.data.targets,
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
      return c.json(serializePostRecurrenceRule(result.rule), 201);
    }
    return definitionError(c, result);
  });

  // ---- Detail ---------------------------------------------------------------
  app.get(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseRuleId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Recurring post rule not found");
    const rule = await getPostRecurrenceRule(bundle.db, {
      tenantId: g.tenant.id,
      ruleId: id,
    });
    if (!rule) return apiError(c, 404, "NOT_FOUND", "Recurring post rule not found");
    return c.json(serializePostRecurrenceRule(rule));
  });

  // ---- Edit -------------------------------------------------------------------
  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseRuleId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Recurring post rule not found");
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdatePostRecurrenceRuleRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid recurrence payload");
    }
    const result = await updatePostRecurrenceRule(bundle.db, {
      tenantId: g.tenant.id,
      ruleId: id,
      userId: g.appUser.id,
      name: parsed.data.name,
      template: {
        title: parsed.data.title,
        caption: parsed.data.caption,
        mediaIds: parsed.data.mediaIds,
        targets: parsed.data.targets,
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
      return c.json(serializePostRecurrenceRule(result.rule));
    }
    return definitionError(c, result);
  });

  // ---- Jeda / lanjut / batal ---------------------------------------------------
  const stateAction = (
    path: string,
    fn: typeof pausePostRecurrenceRule,
  ) => {
    app.post(`${base}/:id/${path}`, async (c) => {
      const g = await guard(c, { ownerAdmin: true });
      if ("error" in g) return g.error;
      const id = parseRuleId(c);
      if (!id) return apiError(c, 404, "NOT_FOUND", "Recurring post rule not found");
      const result = await fn(bundle.db, {
        tenantId: g.tenant.id,
        ruleId: id,
        userId: g.appUser.id,
      });
      switch (result.kind) {
        case "changed":
          return c.json(serializePostRecurrenceRule(result.rule));
        case "not_found":
          return apiError(c, 404, "NOT_FOUND", "Recurring post rule not found");
        case "invalid_state":
          return invalidState(c, result.status);
      }
    });
  };
  stateAction("pause", pausePostRecurrenceRule);
  stateAction("resume", resumePostRecurrenceRule);
  stateAction("cancel", cancelPostRecurrenceRule);

  // ---- Ledger kejadian ---------------------------------------------------------
  app.get(`${base}/:id/occurrences`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseRuleId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Recurring post rule not found");
    const parsed = PostRecurrenceOccurrenceListQuerySchema.safeParse(
      c.req.query(),
    );
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid occurrence list query");
    }
    const result = await listPostRecurrenceOccurrences(bundle.db, {
      tenantId: g.tenant.id,
      ruleId: id,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Recurring post rule not found");
    }
    return c.json(
      PostRecurrenceOccurrenceListResponseSchema.parse({
        occurrences: result.occurrences.map(serializeOccurrence),
        nextCursor: result.nextCursor,
      }),
    );
  });

  return app;
}
