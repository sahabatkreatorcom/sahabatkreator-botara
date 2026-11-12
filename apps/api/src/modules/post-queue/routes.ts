import { Hono } from "hono";
import { z } from "zod";
import {
  CreatePostQueueItemRequestSchema,
  CreatePostQueueSlotRequestSchema,
  MovePostQueueItemRequestSchema,
  PostQueueFiringListQuerySchema,
  PostQueueFiringListResponseSchema,
  PostQueueFiringResponseSchema,
  PostQueueItemListQuerySchema,
  PostQueueItemListResponseSchema,
  PostQueueItemResponseSchema,
  PostQueueSlotListQuerySchema,
  PostQueueSlotListResponseSchema,
  PostQueueSlotResponseSchema,
  UpdatePostQueueItemRequestSchema,
  UpdatePostQueueSlotRequestSchema,
  type PostQueueFiringResponse,
  type PostQueueItemResponse,
  type PostQueueSlotResponse,
} from "@sahabat-kreator/contracts";
import type {
  PostQueueItem,
  PostQueueSlotFiring,
} from "@sahabat-kreator/db";
import {
  addPostQueueItem,
  cancelPostQueueSlot,
  createPostQueueSlot,
  getPostQueueSlot,
  listPostQueueItems,
  listPostQueueSlotFirings,
  listPostQueueSlots,
  movePostQueueItem,
  pausePostQueueSlot,
  removePostQueueItem,
  resumePostQueueSlot,
  updatePostQueueItem,
  updatePostQueueSlot,
  type CreatePostQueueSlotResult,
  type PostQueueSlotRecord,
  type UpdatePostQueueSlotResult,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul post-queue (Fase Susulan S2) — antrean konten + slot rutin:
 *   GET    /tenants/:tenantId/post-queue/items                  antrean (?status=queued|pulled)
 *   POST   /tenants/:tenantId/post-queue/items                  tambah item (owner/admin)
 *   PATCH  /tenants/:tenantId/post-queue/items/:id              edit item queued (owner/admin)
 *   DELETE /tenants/:tenantId/post-queue/items/:id              hapus item queued (owner/admin)
 *   POST   /tenants/:tenantId/post-queue/items/:id/move         geser urutan {direction} (owner/admin)
 *   GET    /tenants/:tenantId/post-queue/slots                  daftar slot rutin
 *   POST   /tenants/:tenantId/post-queue/slots                  buat slot (owner/admin)
 *   GET    /tenants/:tenantId/post-queue/slots/:id              detail slot
 *   PATCH  /tenants/:tenantId/post-queue/slots/:id              edit slot (owner/admin)
 *   POST   /tenants/:tenantId/post-queue/slots/:id/pause        jeda (owner/admin)
 *   POST   /tenants/:tenantId/post-queue/slots/:id/resume       lanjutkan (owner/admin)
 *   POST   /tenants/:tenantId/post-queue/slots/:id/cancel       batalkan (owner/admin)
 *   GET    /tenants/:tenantId/post-queue/slots/:id/firings      ledger tembakan slot
 *
 * Saat slot tiba, penyapu worker menarik item teratas menjadi
 * postingan terjadwal lewat jalur posts yang ada; antrean kosong
 * tercatat sebagai tembakan `empty`. Akses selaras posts: mutasi
 * owner/admin, baca semua member; non-member 404 TENANT_NOT_FOUND.
 */

export function serializePostQueueItem(
  item: PostQueueItem,
): PostQueueItemResponse {
  return PostQueueItemResponseSchema.parse({
    id: item.id,
    position: item.position,
    title: item.title,
    caption: item.caption,
    mediaIds: (item.mediaIds as string[] | null) ?? [],
    status: item.status,
    pulledAt: item.pulledAt?.toISOString() ?? null,
    pulledPostGroupId: item.pulledPostGroupId ?? null,
    pulledPostIds: (item.pulledPostIds as string[] | null) ?? [],
    createdByUserId: item.createdByUserId,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  });
}

export function serializePostQueueSlot(
  slot: PostQueueSlotRecord,
): PostQueueSlotResponse {
  return PostQueueSlotResponseSchema.parse({
    id: slot.id,
    name: slot.name,
    targets: slot.targets.map((target) => ({
      conversationId: target.conversationId,
      ...(target.caption !== undefined ? { caption: target.caption } : {}),
      publishOptions: target.publishOptions ?? null,
      provider: target.provider,
      conversationTitle: target.conversationTitle,
      channelDisplayName: target.channelDisplayName,
    })),
    daysOfWeek: (slot.daysOfWeek as number[] | null) ?? [],
    timeOfDay: slot.timeOfDay,
    timezone: slot.timezone,
    startsAt: slot.startsAt.toISOString(),
    status: slot.status,
    nextRunAt: slot.nextRunAt?.toISOString() ?? null,
    createdByUserId: slot.createdByUserId,
    createdAt: slot.createdAt.toISOString(),
    updatedAt: slot.updatedAt.toISOString(),
  });
}

function serializeFiring(
  firing: PostQueueSlotFiring,
): PostQueueFiringResponse {
  return PostQueueFiringResponseSchema.parse({
    id: firing.id,
    slotId: firing.slotId,
    slotAt: firing.slotAt.toISOString(),
    status: firing.status,
    reason: firing.reason,
    queueItemId: firing.queueItemId ?? null,
    postGroupId: firing.postGroupId ?? null,
    postIds: (firing.postIds as string[] | null) ?? [],
    createdAt: firing.createdAt.toISOString(),
    updatedAt: firing.updatedAt.toISOString(),
  });
}

export function createPostQueueRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const itemsBase = "/tenants/:tenantId/post-queue/items";
  const slotsBase = "/tenants/:tenantId/post-queue/slots";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(itemsBase, unavailable);
    app.post(itemsBase, unavailable);
    app.patch(`${itemsBase}/:id`, unavailable);
    app.delete(`${itemsBase}/:id`, unavailable);
    app.post(`${itemsBase}/:id/move`, unavailable);
    app.get(slotsBase, unavailable);
    app.post(slotsBase, unavailable);
    app.get(`${slotsBase}/:id`, unavailable);
    app.patch(`${slotsBase}/:id`, unavailable);
    app.post(`${slotsBase}/:id/pause`, unavailable);
    app.post(`${slotsBase}/:id/resume`, unavailable);
    app.post(`${slotsBase}/:id/cancel`, unavailable);
    app.get(`${slotsBase}/:id/firings`, unavailable);
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
          "Only workspace owners and admins can manage the post queue",
        ),
      };
    }
    return { tenant, appUser: { id: appUser.id } };
  }

  function parseId(c: AppContext): string | null {
    const id = c.req.param("id");
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  function invalidState(c: AppContext, status: string) {
    return apiError(
      c,
      409,
      "POST_QUEUE_INVALID_STATE",
      `Post queue entry in status '${status}' cannot perform this action`,
    );
  }

  function itemContentError(
    c: AppContext,
    result: { kind: string },
  ): Response | null {
    switch (result.kind) {
      case "template_incomplete":
        return apiError(c, 400, "VALIDATION_ERROR", "A title is required");
      case "media_not_found":
        return apiError(
          c,
          422,
          "POST_MEDIA_NOT_FOUND",
          "A queue item media entry was not found",
        );
      case "media_too_many":
        return apiError(
          c,
          422,
          "POST_MEDIA_TOO_MANY",
          "The item carries more media than a post may hold",
        );
      default:
        return null;
    }
  }

  function slotDefinitionError(
    c: AppContext,
    result:
      | Exclude<CreatePostQueueSlotResult, { kind: "created" }>
      | Exclude<UpdatePostQueueSlotResult, { kind: "updated" }>,
  ): Response {
    switch (result.kind) {
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Queue slot not found");
      case "invalid_state":
        return invalidState(c, result.status);
      case "invalid_pattern":
        return apiError(
          c,
          400,
          "VALIDATION_ERROR",
          `Invalid queue slot pattern: ${result.reason}`,
        );
      case "targets_incomplete":
        return apiError(
          c,
          400,
          "VALIDATION_ERROR",
          "At least one target is required",
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
    }
  }

  async function readJson(c: AppContext): Promise<unknown | null> {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  }

  // ---- Item antrean ---------------------------------------------------------
  app.get(itemsBase, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const parsed = PostQueueItemListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid queue item list query");
    }
    const page = await listPostQueueItems(bundle.db, {
      tenantId: g.tenant.id,
      status: parsed.data.status,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    return c.json(
      PostQueueItemListResponseSchema.parse({
        items: page.items.map(serializePostQueueItem),
        nextCursor: page.nextCursor,
      }),
    );
  });

  app.post(itemsBase, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreatePostQueueItemRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid queue item payload");
    }
    const result = await addPostQueueItem(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      item: {
        title: parsed.data.title,
        caption: parsed.data.caption,
        mediaIds: parsed.data.mediaIds,
      },
    });
    if (result.kind === "added") {
      return c.json(serializePostQueueItem(result.item), 201);
    }
    return itemContentError(c, result)!;
  });

  app.patch(`${itemsBase}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Queue item not found");
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdatePostQueueItemRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid queue item payload");
    }
    const result = await updatePostQueueItem(bundle.db, {
      tenantId: g.tenant.id,
      itemId: id,
      userId: g.appUser.id,
      item: {
        title: parsed.data.title,
        caption: parsed.data.caption,
        mediaIds: parsed.data.mediaIds,
      },
    });
    switch (result.kind) {
      case "updated":
        return c.json(serializePostQueueItem(result.item));
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Queue item not found");
      case "invalid_state":
        return invalidState(c, result.status);
      default:
        return itemContentError(c, result)!;
    }
  });

  app.delete(`${itemsBase}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Queue item not found");
    const result = await removePostQueueItem(bundle.db, {
      tenantId: g.tenant.id,
      itemId: id,
      userId: g.appUser.id,
    });
    switch (result.kind) {
      case "removed":
        return c.json({ ok: true });
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Queue item not found");
      case "invalid_state":
        return invalidState(c, result.status);
    }
  });

  app.post(`${itemsBase}/:id/move`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Queue item not found");
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = MovePostQueueItemRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid move payload");
    }
    const result = await movePostQueueItem(bundle.db, {
      tenantId: g.tenant.id,
      itemId: id,
      userId: g.appUser.id,
      direction: parsed.data.direction,
    });
    switch (result.kind) {
      case "moved":
      case "unchanged":
        return c.json(serializePostQueueItem(result.item));
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Queue item not found");
      case "invalid_state":
        return invalidState(c, result.status);
    }
  });

  // ---- Slot rutin -------------------------------------------------------------
  app.get(slotsBase, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const parsed = PostQueueSlotListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid queue slot list query");
    }
    const page = await listPostQueueSlots(bundle.db, {
      tenantId: g.tenant.id,
      status: parsed.data.status,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    return c.json(
      PostQueueSlotListResponseSchema.parse({
        slots: page.slots.map(serializePostQueueSlot),
        nextCursor: page.nextCursor,
      }),
    );
  });

  app.post(slotsBase, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreatePostQueueSlotRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid queue slot payload");
    }
    const result = await createPostQueueSlot(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      name: parsed.data.name,
      targets: parsed.data.targets,
      pattern: {
        daysOfWeek: parsed.data.daysOfWeek,
        timeOfDay: parsed.data.timeOfDay,
        timezone: parsed.data.timezone ?? g.tenant.timezone,
        startsAt: parsed.data.startsAt
          ? new Date(parsed.data.startsAt)
          : undefined,
      },
    });
    if (result.kind === "created") {
      return c.json(serializePostQueueSlot(result.slot), 201);
    }
    return slotDefinitionError(c, result);
  });

  app.get(`${slotsBase}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Queue slot not found");
    const slot = await getPostQueueSlot(bundle.db, {
      tenantId: g.tenant.id,
      slotId: id,
    });
    if (!slot) return apiError(c, 404, "NOT_FOUND", "Queue slot not found");
    return c.json(serializePostQueueSlot(slot));
  });

  app.patch(`${slotsBase}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Queue slot not found");
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdatePostQueueSlotRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid queue slot payload");
    }
    const result = await updatePostQueueSlot(bundle.db, {
      tenantId: g.tenant.id,
      slotId: id,
      userId: g.appUser.id,
      name: parsed.data.name,
      targets: parsed.data.targets,
      pattern: {
        daysOfWeek: parsed.data.daysOfWeek,
        timeOfDay: parsed.data.timeOfDay,
        timezone: parsed.data.timezone,
        startsAt: parsed.data.startsAt
          ? new Date(parsed.data.startsAt)
          : undefined,
      },
    });
    if (result.kind === "updated") {
      return c.json(serializePostQueueSlot(result.slot));
    }
    return slotDefinitionError(c, result);
  });

  const slotStateAction = (
    path: string,
    fn: typeof pausePostQueueSlot,
  ) => {
    app.post(`${slotsBase}/:id/${path}`, async (c) => {
      const g = await guard(c, { ownerAdmin: true });
      if ("error" in g) return g.error;
      const id = parseId(c);
      if (!id) return apiError(c, 404, "NOT_FOUND", "Queue slot not found");
      const result = await fn(bundle.db, {
        tenantId: g.tenant.id,
        slotId: id,
        userId: g.appUser.id,
      });
      switch (result.kind) {
        case "changed":
          return c.json(serializePostQueueSlot(result.slot));
        case "not_found":
          return apiError(c, 404, "NOT_FOUND", "Queue slot not found");
        case "invalid_state":
          return invalidState(c, result.status);
      }
    });
  };
  slotStateAction("pause", pausePostQueueSlot);
  slotStateAction("resume", resumePostQueueSlot);
  slotStateAction("cancel", cancelPostQueueSlot);

  app.get(`${slotsBase}/:id/firings`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseId(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Queue slot not found");
    const parsed = PostQueueFiringListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid firing list query");
    }
    const result = await listPostQueueSlotFirings(bundle.db, {
      tenantId: g.tenant.id,
      slotId: id,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Queue slot not found");
    }
    return c.json(
      PostQueueFiringListResponseSchema.parse({
        firings: result.firings.map(serializeFiring),
        nextCursor: result.nextCursor,
      }),
    );
  });

  return app;
}
