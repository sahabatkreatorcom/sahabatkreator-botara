import { Hono } from "hono";
import {
  parseFlowWebhookPayload,
  resolveFlowWebhookEndpoint,
  startFlowWebhookRun,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";

/**
 * Modul flow-webhooks (G17) — titik masuk PUBLIK pemicu webhook flow:
 *   POST /webhooks/flow/:endpointId   (kanonis di bawah /api)
 *
 * Autentikasi = token rahasia endpoint, disodorkan lewat header
 * `x-flow-webhook-token` atau `Authorization: Bearer <token>`. Token
 * dibandingkan sebagai HASH (hash-only di DB, lengan RLS
 * `flow_webhook_lookup`): endpoint tak dikenal, token hilang, dan
 * token salah SEMUA menjawab 404 NOT_FOUND yang identik — pemanggil
 * tidak bisa membedakan "flow tidak ada" dari "token salah", jadi
 * keberadaan flow tidak bocor.
 *
 * Body WAJIB objek JSON (payload pemicu): contactId | externalId |
 * phone | email menentukan kontak sasaran (lihat core
 * flows/webhook-trigger). Respons:
 *   202 { runId, status: "started" }        run dimulai
 *   200 { status: "ignored", reason }       kontak opt-out — keadaan
 *                                           bisnis, bukan kesalahan
 *                                           pemanggil (sistem luar
 *                                           tidak perlu mengulang)
 *   400 WEBHOOK_PAYLOAD_INVALID             body bukan objek JSON sah
 *                                           / melebihi batas ukuran
 *   409 FLOW_NOT_ACTIVE / FLOW_TRIGGER_CHANGED / FLOW_CHANNEL_MISSING
 *                                           konfigurasi flow berubah
 *                                           sejak URL dibagikan
 *   422 WEBHOOK_CONTACT_UNRESOLVED          payload tidak membawa
 *                                           pengenal kontak yang bisa
 *                                           diresolusi
 * Run yang lahir dieksekusi worker lewat rel outbox yang sama seperti
 * run pesan masuk (job flow.step) — modul ini hanya memulai.
 */

/** Batas body mentah yang dibaca (payload sah dibatasi 16KB di core). */
const RAW_BODY_MAX_CHARS = 65_536;

export function createFlowWebhooksRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const path = "/webhooks/flow/:endpointId";

  if (!bundle) {
    app.post(path, (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  app.post(path, async (c) => {
    const endpointId = c.req.param("endpointId") ?? "";
    const headerToken = c.req.header("x-flow-webhook-token");
    const auth = c.req.header("authorization");
    const bearer =
      auth && auth.toLowerCase().startsWith("bearer ")
        ? auth.slice("bearer ".length).trim()
        : null;
    const token = headerToken?.trim() || bearer;
    if (!token) {
      return apiError(c, 404, "NOT_FOUND", "Flow webhook not found");
    }
    const endpoint = await resolveFlowWebhookEndpoint(
      bundle.db,
      endpointId,
      token,
    );
    if (!endpoint) {
      return apiError(c, 404, "NOT_FOUND", "Flow webhook not found");
    }

    const raw = await c.req.text().catch(() => "");
    if (raw.length > RAW_BODY_MAX_CHARS) {
      return apiError(
        c,
        400,
        "WEBHOOK_PAYLOAD_INVALID",
        "Webhook payload is too large",
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = raw ? JSON.parse(raw) : null;
    } catch {
      return apiError(
        c,
        400,
        "WEBHOOK_PAYLOAD_INVALID",
        "Webhook body must be a JSON object",
      );
    }
    const payloadResult = parseFlowWebhookPayload(parsedJson);
    if (!payloadResult.ok) {
      return apiError(
        c,
        400,
        "WEBHOOK_PAYLOAD_INVALID",
        payloadResult.reason === "too_large"
          ? "Webhook payload is too large"
          : "Webhook body must be a JSON object",
      );
    }

    const result = await startFlowWebhookRun(
      bundle.db,
      endpoint,
      payloadResult.payload,
    );
    switch (result.kind) {
      case "started":
        return c.json({ runId: result.runId, status: "started" }, 202);
      case "contact_opted_out":
        return c.json({ status: "ignored", reason: "contact_opted_out" });
      case "contact_unresolved":
        return apiError(
          c,
          422,
          "WEBHOOK_CONTACT_UNRESOLVED",
          "Payload does not identify a resolvable contact (contactId, externalId, phone, or email)",
        );
      case "flow_not_active":
        return apiError(
          c,
          409,
          "FLOW_NOT_ACTIVE",
          "Flow is not active",
        );
      case "trigger_not_webhook":
        return apiError(
          c,
          409,
          "FLOW_TRIGGER_CHANGED",
          "Flow trigger is no longer a webhook trigger",
        );
      case "channel_account_missing":
        return apiError(
          c,
          409,
          "FLOW_CHANNEL_MISSING",
          "Flow webhook channel account no longer exists",
        );
    }
  });

  return app;
}
