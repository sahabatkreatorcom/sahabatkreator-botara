import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  FailedMessageListQuerySchema,
  FailedMessageListResponseSchema,
  FailedMessageResponseSchema,
  FailedMessageRetryResponseSchema,
  IntegrationLogDetailResponseSchema,
  IntegrationLogListQuerySchema,
  IntegrationLogListResponseSchema,
  IntegrationLogReplayResponseSchema,
  IntegrationLogResponseSchema,
  type FailedMessageResponse,
  type IntegrationLogDetailResponse,
  type IntegrationLogListQuery,
  type IntegrationLogResponse,
} from "@sahabat-kreator/contracts";
import {
  evaluateIntegrationLogReplayEligibility,
  getIntegrationLog,
  getUnresolvedIntegrationLog,
  isPlatformAdmin,
  listFailedOutboundMessages,
  listIntegrationLogs,
  listUnresolvedIntegrationLogs,
  retryFailedOutboundMessage,
  type FailedOutboundMessage,
  type ListIntegrationLogsInput,
} from "@sahabat-kreator/core";
import type { IntegrationLogRow } from "@sahabat-kreator/db";
import type { RealtimePublisher } from "@sahabat-kreator/queue";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";
import {
  runIntegrationLogReplay,
  runPlatformIntegrationLogReplay,
} from "./replay";

export interface LogsRoutesOptions {
  /** Allowlist mentah env PLATFORM_ADMIN_EMAILS (koma-terpisah). */
  platformAdminEmails?: string;
  /**
   * Dependensi replay Fase 7B.2 — transport yang sama seperti route
   * webhook live (publisher realtime + kredensial channel + base URL
   * provider + versi Graph), dirakit di index.ts dari env yang sama.
   * Tanpa ini endpoint replay menjawab 503.
   */
  replay?: {
    publisher: RealtimePublisher | null;
    channelTokenSecret?: string;
    telegramApiBase?: string;
    metaApiBase?: string;
    graphApiVersion: string;
  };
}

function serializeLog(row: IntegrationLogRow): IntegrationLogResponse {
  return IntegrationLogResponseSchema.parse({
    id: row.id,
    direction: row.direction,
    provider: row.provider,
    tenantId: row.tenantId,
    channelAccountId: row.channelAccountId,
    messageId: row.messageId,
    signatureValid: row.signatureValid,
    outcome: row.outcome,
    errorCode: row.errorCode,
    summary: row.summary,
    hasPayload: row.payload !== null && row.payload !== undefined,
    createdAt: row.createdAt.toISOString(),
  });
}

function serializeLogDetail(row: IntegrationLogRow): IntegrationLogDetailResponse {
  return IntegrationLogDetailResponseSchema.parse({
    ...serializeLog(row),
    payload: row.payload ?? null,
  });
}

function serializeFailedMessage(
  m: FailedOutboundMessage,
): FailedMessageResponse {
  return FailedMessageResponseSchema.parse({
    id: m.id,
    conversationId: m.conversationId,
    provider: m.provider,
    channelAccountId: m.channelAccountId,
    channelDisplayName: m.channelDisplayName,
    contactId: m.contactId,
    contactName: m.contactName,
    contentPreview: m.contentPreview,
    errorCode: m.errorCode,
    // G13 butir 6: detail teknis (deskripsi Graph + fbtrace) ikut tampil.
    errorDetail: m.errorDetail
      ? {
          description: m.errorDetail.description ?? null,
          subcode: m.errorDetail.subcode ?? null,
          fbtraceId: m.errorDetail.fbtraceId ?? null,
        }
      : null,
    createdAt: m.createdAt.toISOString(),
  });
}

function toListInput(query: IntegrationLogListQuery): ListIntegrationLogsInput {
  return {
    provider: query.provider,
    direction: query.direction,
    outcome: query.outcome,
    channelAccountId: query.channelAccountId,
    cursor: query.cursor,
    limit: query.limit,
  };
}

/**
 * Modul log integrasi (Fase 7B.1) — pembacaan tabel `integration_log`:
 *   GET /tenants/:tenantId/logs              daftar log tenant (tanpa payload)
 *   GET /tenants/:tenantId/logs/:logId       detail (payload tersimpan)
 *   GET /logs/unresolved                     baris platform (tenant NULL)
 *   GET /logs/unresolved/:logId              detail baris platform
 *
 * Fase 7B.2 — penanganan kegagalan (akses owner/admin yang sama):
 *   POST /tenants/:tenantId/logs/:logId/replay
 *        proses ulang baris arah masuk yang eligible (signature_valid
 *        true, payload lengkap, outcome error/ignored_disconnected)
 *        lewat jalur pemrosesan webhook live (lihat ./replay.ts);
 *        tidak eligible → 422 LOG_REPLAY_NOT_ALLOWED /
 *        LOG_PAYLOAD_TRUNCATED; akun sumber hilang → 422.
 *   POST /logs/unresolved/:logId/replay      (Fase 13A — platform admin)
 *        replay baris tenant-NULL yang eligible lewat jalur live TANPA
 *        konteks tenant (akun di-resolve ulang dari payload/id akun);
 *        non-admin → 404 seperti daftar unresolved; auditnya baris
 *        platform `integration.replay`.
 *   GET  /tenants/:tenantId/failed-messages  pusat pesan keluar `failed`
 *   POST /tenants/:tenantId/failed-messages/:messageId/retry
 *        antrekan ulang failed → queued secara atomik (core); channel
 *        tidak connected → 409 CHANNEL_DISCONNECTED; bukan failed →
 *        409 MESSAGE_NOT_FAILED; tak ditemukan → 404.
 *
 * AKSES (payload memuat isi pesan pelanggan — sensitif):
 * - Route tenant: sesi + membership; non-member 404 TENANT_NOT_FOUND
 *   (pola Fase 1B). Membaca dibatasi role OWNER/ADMIN — member biasa
 *   (agent/viewer) mendapat 403 FORBIDDEN, lebih ketat dari daftar
 *   API key (5A) yang boleh dibaca semua member.
 * - Route unresolved: baris tak ber-tenant (akun tak dikenal dst.) hanya
 *   untuk sesi PLATFORM ADMIN (allowlist env PLATFORM_ADMIN_EMAILS);
 *   non-admin 404 NOT_FOUND agar eksistensinya tidak dibocorkan (pola
 *   Panel Admin 6C). Baris ini di luar tenant mana pun — tidak ada
 *   konteks tenant yang bisa membukanya.
 * Penulisan log terjadi di route webhook & poller (core
 * `recordIntegrationLog`, best-effort) — modul ini murni membaca.
 */
export function createLogsRoutes(
  bundle: AuthBundle | null,
  opts: LogsRoutesOptions = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const tenantBase = "/tenants/:tenantId/logs";

  if (!bundle) {
    app.get(tenantBase, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get(`${tenantBase}/:logId`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/logs/unresolved", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/logs/unresolved/:logId", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.post(`${tenantBase}/:logId/replay`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.post("/logs/unresolved/:logId/replay", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tenants/:tenantId/failed-messages", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.post("/tenants/:tenantId/failed-messages/:messageId/retry", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  const auth = requireAuth(bundle);
  app.use("/logs/*", auth);

  app.get(tenantBase, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId"),
      appUser.id,
    );
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only workspace owners and admins can view integration logs",
      );
    }
    const parsed = IntegrationLogListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid log list query");
    }
    const page = await listIntegrationLogs(
      bundle.db,
      tenant.id,
      toListInput(parsed.data),
    );
    const body = IntegrationLogListResponseSchema.parse({
      logs: page.logs.map(serializeLog),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  app.get(`${tenantBase}/:logId`, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId"),
      appUser.id,
    );
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only workspace owners and admins can view integration logs",
      );
    }
    const logId = c.req.param("logId");
    if (!z.string().uuid().safeParse(logId).success) {
      return apiError(c, 404, "NOT_FOUND", "Log entry not found");
    }
    const row = await getIntegrationLog(bundle.db, tenant.id, logId);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Log entry not found");
    return c.json(serializeLogDetail(row));
  });

  app.get("/logs/unresolved", async (c) => {
    const appUser = c.get("appUser");
    const allowed = await isPlatformAdmin(
      bundle.db,
      appUser.email,
      opts.platformAdminEmails,
    );
    if (!allowed) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }
    const parsed = IntegrationLogListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid log list query");
    }
    const page = await listUnresolvedIntegrationLogs(
      bundle.db,
      toListInput(parsed.data),
    );
    const body = IntegrationLogListResponseSchema.parse({
      logs: page.logs.map(serializeLog),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  app.get("/logs/unresolved/:logId", async (c) => {
    const appUser = c.get("appUser");
    const allowed = await isPlatformAdmin(
      bundle.db,
      appUser.email,
      opts.platformAdminEmails,
    );
    if (!allowed) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }
    const logId = c.req.param("logId");
    if (!z.string().uuid().safeParse(logId).success) {
      return apiError(c, 404, "NOT_FOUND", "Log entry not found");
    }
    const row = await getUnresolvedIntegrationLog(bundle.db, logId);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Log entry not found");
    return c.json(serializeLogDetail(row));
  });

  // Fase 13A: replay baris tenant-NULL — gerbang platform admin yang
  // sama seperti daftar/detail unresolved (non-admin 404), kelayakan
  // yang sama seperti replay tenant, mesin di ./replay.ts.
  app.post("/logs/unresolved/:logId/replay", async (c) => {
    const appUser = c.get("appUser");
    const allowed = await isPlatformAdmin(
      bundle.db,
      appUser.email,
      opts.platformAdminEmails,
    );
    if (!allowed) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }
    const logId = c.req.param("logId");
    if (!z.string().uuid().safeParse(logId).success) {
      return apiError(c, 404, "NOT_FOUND", "Log entry not found");
    }
    const row = await getUnresolvedIntegrationLog(bundle.db, logId);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Log entry not found");
    const eligibility = evaluateIntegrationLogReplayEligibility(row);
    if (!eligibility.ok) {
      return apiError(
        c,
        422,
        eligibility.code,
        eligibility.code === "LOG_PAYLOAD_TRUNCATED"
          ? "The stored payload for this entry is incomplete and cannot be replayed"
          : "This log entry cannot be replayed",
      );
    }
    if (!opts.replay) {
      return apiError(c, 503, "INTERNAL_ERROR", "Replay is not configured");
    }
    const result = await runPlatformIntegrationLogReplay(
      { bundle, ...opts.replay },
      row,
      appUser.id,
    );
    if (result.kind === "account_unavailable") {
      return apiError(
        c,
        422,
        "LOG_REPLAY_NOT_ALLOWED",
        "The channel account for this event no longer exists",
      );
    }
    const body = IntegrationLogReplayResponseSchema.parse({
      replayed: true,
      sourceLogId: row.id,
      outcomes: result.outcomes,
    });
    return c.json(body);
  });

  // ---------------------------------------------------------------------
  // Fase 7B.2: replay webhook + pusat pesan gagal (owner/admin saja —
  // penjaga yang sama seperti pembacaan log di atas).
  // ---------------------------------------------------------------------

  const guardOwnerAdmin = async (c: Context<{ Variables: AppVariables }>) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      appUser.id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      } as const;
    }
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage delivery failures",
        ),
      } as const;
    }
    return { tenant, appUser } as const;
  };

  app.post(`${tenantBase}/:logId/replay`, async (c) => {
    const guard = await guardOwnerAdmin(c);
    if ("error" in guard) return guard.error;
    const logId = c.req.param("logId");
    if (!z.string().uuid().safeParse(logId).success) {
      return apiError(c, 404, "NOT_FOUND", "Log entry not found");
    }
    const row = await getIntegrationLog(bundle.db, guard.tenant.id, logId);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Log entry not found");
    const eligibility = evaluateIntegrationLogReplayEligibility(row);
    if (!eligibility.ok) {
      return apiError(
        c,
        422,
        eligibility.code,
        eligibility.code === "LOG_PAYLOAD_TRUNCATED"
          ? "The stored payload for this entry is incomplete and cannot be replayed"
          : "This log entry cannot be replayed",
      );
    }
    if (!opts.replay) {
      return apiError(c, 503, "INTERNAL_ERROR", "Replay is not configured");
    }
    const result = await runIntegrationLogReplay(
      { bundle, ...opts.replay },
      row,
      guard.appUser.id,
    );
    if (result.kind === "account_unavailable") {
      return apiError(
        c,
        422,
        "LOG_REPLAY_NOT_ALLOWED",
        "The channel account for this event no longer exists",
      );
    }
    const body = IntegrationLogReplayResponseSchema.parse({
      replayed: true,
      sourceLogId: row.id,
      outcomes: result.outcomes,
    });
    return c.json(body);
  });

  app.get("/tenants/:tenantId/failed-messages", async (c) => {
    const guard = await guardOwnerAdmin(c);
    if ("error" in guard) return guard.error;
    const parsed = FailedMessageListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid failed message list query");
    }
    const page = await listFailedOutboundMessages(bundle.db, guard.tenant.id, {
      provider: parsed.data.provider,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    const body = FailedMessageListResponseSchema.parse({
      messages: page.messages.map(serializeFailedMessage),
      nextCursor: page.nextCursor,
    });
    return c.json(body);
  });

  app.post("/tenants/:tenantId/failed-messages/:messageId/retry", async (c) => {
    const guard = await guardOwnerAdmin(c);
    if ("error" in guard) return guard.error;
    const messageId = c.req.param("messageId");
    if (!z.string().uuid().safeParse(messageId).success) {
      return apiError(c, 404, "NOT_FOUND", "Message not found");
    }
    const result = await retryFailedOutboundMessage(
      bundle.db,
      { tenantId: guard.tenant.id, userId: guard.appUser.id },
      messageId,
    );
    switch (result.kind) {
      case "requeued": {
        const body = FailedMessageRetryResponseSchema.parse({
          id: result.message.id,
          status: "queued",
        });
        return c.json(body);
      }
      case "not_found":
        return apiError(c, 404, "NOT_FOUND", "Message not found");
      case "not_failed":
        return apiError(
          c,
          409,
          "MESSAGE_NOT_FAILED",
          "Only failed messages can be retried",
        );
      case "channel_disconnected":
        return apiError(
          c,
          409,
          "CHANNEL_DISCONNECTED",
          "Channel is disconnected",
        );
      case "unsupported_provider":
        return apiError(
          c,
          422,
          "MESSAGE_RETRY_UNSUPPORTED",
          "This provider does not support retrying failed messages",
        );
    }
  });

  return app;
}
