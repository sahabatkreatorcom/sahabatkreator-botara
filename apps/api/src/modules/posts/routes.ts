import { Hono } from "hono";
import { z } from "zod";
import {
  CreatePostGroupRequestSchema,
  CreatePostRequestSchema,
  PostGroupResponseSchema,
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
  createPostGroup,
  decryptChannelSecret,
  deletePost,
  duplicatePost,
  getChannelAccount,
  getPost,
  listPostTargets,
  listPosts,
  releaseStuckPost,
  retryPost,
  schedulePost,
  updatePost,
  type PostErrorCode,
  type PostRecord,
} from "@sahabat-kreator/core";
import {
  PinterestApiError,
  PinterestClient,
} from "@sahabat-kreator/channel-pinterest";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul posts (Fase 23) — Content Schedule untuk channel Telegram:
 *   GET    /tenants/:tenantId/posts/targets        channel yang bisa dituju
 *   GET    /tenants/:tenantId/posts                daftar + saringan status
 *   POST   /tenants/:tenantId/posts                buat draft
 *   POST   /tenants/:tenantId/posts/group          buat grup multi-target
 *   GET    /tenants/:tenantId/posts/:id            detail
 *   PATCH  /tenants/:tenantId/posts/:id            edit (draft saja)
 *   DELETE /tenants/:tenantId/posts/:id            hapus (draft/cancelled)
 *   POST   /tenants/:tenantId/posts/:id/schedule   jadwalkan / terbitkan sekarang
 *   POST   /tenants/:tenantId/posts/:id/retry      jadwalkan ulang post gagal (manual)
 *   POST   /tenants/:tenantId/posts/:id/release-stuck  publishing macet → failed (manual)
 *   POST   /tenants/:tenantId/posts/:id/duplicate  duplikat menjadi draft baru
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
    groupId: post.groupId,
    title: post.title,
    caption: post.caption,
    status: post.status,
    scheduledAt: post.scheduledAt ? post.scheduledAt.toISOString() : null,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    providerMessageId: post.providerMessageId,
    errorCode: post.errorCode,
    publishOptions: post.publishOptions,
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
  POST_NOT_RETRYABLE: 409,
  POST_NOT_PUBLISHING: 409,
  POST_EMPTY: 422,
  POST_CAPTION_TOO_LONG: 422,
  POST_TITLE_TOO_LONG: 422,
  POST_MEDIA_REQUIRED: 422,
  POST_MEDIA_TOO_MANY: 422,
  POST_MEDIA_KIND_UNSUPPORTED: 422,
  POST_PUBLISH_OPTIONS_REQUIRED: 422,
  POST_PUBLISH_OPTIONS_INVALID: 422,
};

function domainError(c: AppContext, err: unknown) {
  if (err instanceof PostDomainError) {
    return apiError(c, ERROR_STATUS[err.code], err.code, err.code);
  }
  throw err;
}

export interface PostsRoutesOptions {
  /**
   * Material kunci token channel — hanya dipakai validasi board
   * Pinterest pada opsi postingan (membuka token akun sasaran).
   * Tanpa ini validasi simpan dilewati; resolver penerbit tetap
   * memeriksa keanggotaan board saat publish.
   */
  channelTokenSecret?: string | undefined;
  /** Base URL Pinterest API v5 (env PINTEREST_API_BASE; untuk mock rantai uji). */
  pinterestApiBase?: string | undefined;
}

export function createPostsRoutes(
  bundle: AuthBundle | null,
  opts?: PostsRoutesOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/posts";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.post(`${base}/group`, unavailable);
    app.get(`${base}/targets`, unavailable);
    app.get(`${base}/:id`, unavailable);
    app.patch(`${base}/:id`, unavailable);
    app.delete(`${base}/:id`, unavailable);
    app.post(`${base}/:id/schedule`, unavailable);
    app.post(`${base}/:id/retry`, unavailable);
    app.post(`${base}/:id/release-stuck`, unavailable);
    app.post(`${base}/:id/duplicate`, unavailable);
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

  /**
   * Validasi board Pinterest pada opsi postingan — pola yang sama
   * persis seperti endpoint pemilih board Channels: `boardId` wajib
   * ada di daftar board AKUN Pinterest sasaran postingan ini
   * (board asing → 422 PINTEREST_BOARD_NOT_FOUND; API tak terjangkau
   * → 502 PINTEREST_BOARDS_UNAVAILABLE). Sasaran bukan Pinterest →
   * tidak divalidasi (core membuang field-nya saat menyimpan).
   * Tanpa material kunci token pada opsi modul, validasi simpan
   * dilewati — keanggotaan tetap diperiksa resolver penerbit
   * terhadap daftar board hidup saat publish.
   */
  async function validatePinterestBoardOption(
    c: AppContext,
    tenantId: string,
    conversationId: string,
    boardId: string | undefined,
  ): Promise<Response | null> {
    if (!boardId || !opts?.channelTokenSecret) return null;
    const targets = await listPostTargets(bundle!.db, { tenantId });
    const target = targets.find((t) => t.conversationId === conversationId);
    if (!target || target.provider !== "pinterest") return null;
    const account = await getChannelAccount(
      bundle!.db,
      { tenantId },
      target.channelAccountId,
    );
    const accessToken =
      account?.accessTokenEncrypted != null
        ? decryptChannelSecret(
            opts.channelTokenSecret,
            account.accessTokenEncrypted,
          )
        : null;
    if (!accessToken) {
      return apiError(
        c,
        502,
        "PINTEREST_BOARDS_UNAVAILABLE",
        "Could not reach Pinterest boards",
      );
    }
    try {
      const boards = await new PinterestClient({
        baseUrl: opts.pinterestApiBase,
      }).listBoards(accessToken);
      if (!boards.some((board) => board.id === boardId)) {
        return apiError(
          c,
          422,
          "PINTEREST_BOARD_NOT_FOUND",
          "The selected board does not belong to this Pinterest account",
        );
      }
      return null;
    } catch (err) {
      const detail =
        err instanceof PinterestApiError
          ? `${err.status}: ${err.description}`
          : "non-api error";
      console.error(`[posts] validasi board Pinterest gagal (${detail})`);
      return apiError(
        c,
        502,
        "PINTEREST_BOARDS_UNAVAILABLE",
        "Could not reach Pinterest boards",
      );
    }
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
    const boardError = await validatePinterestBoardOption(
      c,
      g.tenant.id,
      parsed.data.conversationId,
      parsed.data.publishOptions?.pinterestBoardId,
    );
    if (boardError) return boardError;
    try {
      const post = await createPost(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        conversationId: parsed.data.conversationId,
        title: parsed.data.title,
        caption: parsed.data.caption,
        mediaIds: parsed.data.mediaIds,
        publishOptions: parsed.data.publishOptions,
      });
      return c.json(PostSchema.parse(serializePost(post)), 201);
    } catch (err) {
      return domainError(c, err);
    }
  });

  // ---- Buat grup multi-target ----------------------------------------------
  // Satu konten induk → N draft dalam satu grup (satu transaksi di core).
  // Penjadwalan tetap per anggota lewat route /:id/schedule yang ada.
  app.post(`${base}/group`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid JSON body");
    }
    const parsed = CreatePostGroupRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid post group payload");
    }
    for (const target of parsed.data.targets) {
      const boardError = await validatePinterestBoardOption(
        c,
        g.tenant.id,
        target.conversationId,
        target.publishOptions?.pinterestBoardId,
      );
      if (boardError) return boardError;
    }
    try {
      const result = await createPostGroup(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        title: parsed.data.title,
        caption: parsed.data.caption,
        mediaIds: parsed.data.mediaIds,
        targets: parsed.data.targets,
      });
      return c.json(
        PostGroupResponseSchema.parse({
          groupId: result.groupId,
          items: result.posts.map(serializePost),
        }),
        201,
      );
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
    if (parsed.data.publishOptions?.pinterestBoardId) {
      const existing = await getPost(bundle.db, {
        tenantId: g.tenant.id,
        postId,
      });
      if (!existing) {
        return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
      }
      const boardError = await validatePinterestBoardOption(
        c,
        g.tenant.id,
        existing.target.conversationId,
        parsed.data.publishOptions.pinterestBoardId,
      );
      if (boardError) return boardError;
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

  // ---- Jadwalkan ulang post gagal (retry manual) ---------------------------
  // Bentuk body sama persis dengan /schedule (scheduledAt opsional =
  // terbitkan sekarang), karena di core keduanya memang satu operasi
  // penjadwalan dengan gerbang status yang berbeda.
  app.post(`${base}/:id/retry`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const postId = parsePostId(c);
    if (!postId) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
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
      const result = await retryPost(bundle.db, {
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

  // ---- Bebaskan post macet di publishing -----------------------------------
  app.post(`${base}/:id/release-stuck`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const postId = parsePostId(c);
    if (!postId) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
    try {
      const post = await releaseStuckPost(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        postId,
      });
      return c.json(PostSchema.parse(serializePost(post)));
    } catch (err) {
      return domainError(c, err);
    }
  });

  // ---- Duplikat menjadi draft baru ------------------------------------------
  app.post(`${base}/:id/duplicate`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const postId = parsePostId(c);
    if (!postId) return apiError(c, 404, "POST_NOT_FOUND", "Post not found");
    try {
      const post = await duplicatePost(bundle.db, {
        tenantId: g.tenant.id,
        userId: g.appUser.id,
        postId,
      });
      return c.json(PostSchema.parse(serializePost(post)), 201);
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
