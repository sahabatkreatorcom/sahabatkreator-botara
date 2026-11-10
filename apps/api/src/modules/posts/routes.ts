import { Hono } from "hono";
import { z } from "zod";
import {
  CreatePostRequestSchema,
  PostListQuerySchema,
  PostListResponseSchema,
  PostSchema,
  PostTargetListResponseSchema,
  SchedulePostRequestSchema,
  UpdatePostRequestSchema,
  type PostResponse,
} from "@sahabat-kreator/contracts";
import {
  PostDomainError,
  cancelPost,
  createPost,
  deletePost,
  getPost,
  listPostTargets,
  listPosts,
  schedulePost,
  updatePost,
  type PostErrorCode,
  type PostRecord,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul posts (Fase 23) — Content Schedule untuk channel Telegram:
 *   GET    /tenants/:tenantId/posts/targets        channel yang bisa dituju
 *   GET    /tenants/:tenantId/posts                daftar + saringan status
 *   POST   /tenants/:tenantId/posts                buat draft
 *   GET    /tenants/:tenantId/posts/:id            detail
 *   PATCH  /tenants/:tenantId/posts/:id            edit (draft saja)
 *   DELETE /tenants/:tenantId/posts/:id            hapus (draft/cancelled)
 *   POST   /tenants/:tenantId/posts/:id/schedule   jadwalkan / terbitkan sekarang
 *   POST   /tenants/:tenantId/posts/:id/cancel     batalkan
 *
 * Penerbitan BUKAN di sini: `schedule` menulis event outbox
 * `post.publish_due`; relay worker mengubahnya menjadi job tertunda
 * `post.publish`, dan publisher di worker yang memanggil Bot API.
 *
 * AKSES: baca = semua member (kalender konten adalah informasi bersama);
 * mutasi = owner/admin, sama seperti broadcast — menerbitkan ke linimasa
 * publik adalah aksi yang mewakili workspace.
 */

function serializePost(post: PostRecord): PostResponse {
  return {
    id: post.id,
    title: post.title,
    caption: post.caption,
    status: post.status,
    scheduledAt: post.scheduledAt ? post.scheduledAt.toISOString() : null,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    providerMessageId: post.providerMessageId,
    errorCode: post.errorCode,
    target: {
      channelAccountId: post.target.channelAccountId,
      conversationId: post.target.conversationId,
      provider: post.target.provider as PostResponse["target"]["provider"],
      title: post.target.title,
      providerChatId: post.target.providerChatId,
      channelDisplayName: post.target.channelDisplayName,
    },
    media: post.media,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

/** Kode domain → status HTTP. Satu tabel, supaya tidak tersebar di tiap route. */
const ERROR_STATUS: Record<PostErrorCode, 400 | 404 | 409 | 422> = {
  POST_NOT_FOUND: 404,
  POST_TARGET_NOT_FOUND: 422,
  POST_TARGET_NOT_CONNECTED: 409,
  POST_MEDIA_NOT_FOUND: 422,
  POST_MEDIA_ALBUM_UNSUPPORTED: 422,
  POST_NOT_EDITABLE: 409,
  POST_NOT_SCHEDULABLE: 409,
  POST_NOT_CANCELLABLE: 409,
  POST_EMPTY: 422,
};

function domainError(c: AppContext, err: unknown) {
  if (err instanceof PostDomainError) {
    return apiError(c, ERROR_STATUS[err.code], err.code, err.code);
  }
  throw err;
}

export function createPostsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/posts";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.get(`${base}/targets`, unavailable);
    app.get(`${base}/:id`, unavailable);
    app.patch(`${base}/:id`, unavailable);
    app.delete(`${base}/:id`, unavailable);
    app.post(`${base}/:id/schedule`, unavailable);
    app.post(`${base}/:id/cancel`, unavailable);
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
          "Only workspace owners and admins can manage scheduled posts",
        ),
      };
    }
    return { tenant, appUser: { id: appUser.id } };
  }

  function parsePostId(c: AppContext): string | null {
    const id = c.req.param("id");
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  // ---- Channel yang bisa dituju (sebelum :id) -----------------------------
  app.get(`${base}/targets`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const items = await listPostTargets(bundle.db, { tenantId: g.tenant.id });
    return c.json(
      PostTargetListResponseSchema.parse({
        items: items.map((target) => ({
          ...target,
          provider: target.provider as PostResponse["target"]["provider"],
        })),
      }),
    );
  });

  // ---- Daftar -------------------------------------------------------------
  app.get(base, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const parsed = PostListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid post list query");
    }
    const items = await listPosts(bundle.db, {
      tenantId: g.tenant.id,
      status: parsed.data.status,
      limit: parsed.data.limit,
    });
    return c.json(
      PostListResponseSchema.parse({ items: items.map(serializePost) }),
    );
  });

  // ---- Buat ---------------------------------------------------------------
  app.post(base, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid JSON body");
    }
    const parsed = CreatePostRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid post payload");
    }
    try {
      const post = await createPost(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        conversationId: parsed.data.conversationId,
        title: parsed.data.title,
        caption: parsed.data.caption,
        mediaIds: parsed.data.mediaIds,
      });
      return c.json(PostSchema.parse(serializePost(post)), 201);
    } catch (err) {
      return domainError(c, err);
    }
  });

  // ---- Detail -------------------------------------------------------------
  app.get(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const postId = parsePostId(c);
    if (!postId) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
    const post = await getPost(bundle.db, { tenantId: g.tenant.id, postId });
    if (!post) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
    return c.json(PostSchema.parse(serializePost(post)));
  });

  // ---- Edit ---------------------------------------------------------------
  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const postId = parsePostId(c);
    if (!postId) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid JSON body");
    }
    const parsed = UpdatePostRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid post payload");
    }
    try {
      const post = await updatePost(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        postId,
        ...parsed.data,
      });
      return c.json(PostSchema.parse(serializePost(post)));
    } catch (err) {
      return domainError(c, err);
    }
  });

  // ---- Hapus --------------------------------------------------------------
  app.delete(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const postId = parsePostId(c);
    if (!postId) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
    try {
      await deletePost(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        postId,
      });
      return c.body(null, 204);
    } catch (err) {
      return domainError(c, err);
    }
  });

  // ---- Jadwalkan / terbitkan sekarang -------------------------------------
  app.post(`${base}/:id/schedule`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const postId = parsePostId(c);
    if (!postId) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
    // Body opsional: "terbitkan sekarang" boleh tanpa body sama sekali.
    let json: unknown = {};
    try {
      const text = await c.req.text();
      json = text.trim().length > 0 ? JSON.parse(text) : {};
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid JSON body");
    }
    const parsed = SchedulePostRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid schedule payload");
    }
    try {
      const result = await schedulePost(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        postId,
        scheduledAt: parsed.data.scheduledAt
          ? new Date(parsed.data.scheduledAt)
          : null,
      });
      return c.json(PostSchema.parse(serializePost(result.post)));
    } catch (err) {
      return domainError(c, err);
    }
  });

  // ---- Batalkan -----------------------------------------------------------
  app.post(`${base}/:id/cancel`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const postId = parsePostId(c);
    if (!postId) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
    try {
      const post = await cancelPost(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        postId,
      });
      return c.json(PostSchema.parse(serializePost(post)));
    } catch (err) {
      return domainError(c, err);
    }
  });

  return app;
}
