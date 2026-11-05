import { Hono } from "hono";
import {
  PaymentSettingsResponseSchema,
  PaymentSettingsTestResponseSchema,
  UpdatePaymentSettingsRequestSchema,
  type PaymentSettingsResponse,
} from "@sahabat-kreator/contracts";
import {
  getPaymentSettings,
  handleMidtransWebhook,
  handleXenditWebhook,
  recordIntegrationLog,
  testPaymentConnection,
  updatePaymentSettings,
  type PaymentDeps,
  type PaymentSettingsView,
  type PaymentWebhookResult,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

export interface PaymentsModuleOptions extends PaymentDeps {
  /** Base URL publik aplikasi untuk merangkai URL webhook yang ditampilkan. */
  publicBaseUrl?: string;
}

function serializeSettings(
  view: PaymentSettingsView,
  publicBaseUrl: string | undefined,
): PaymentSettingsResponse {
  const origin = (publicBaseUrl ?? "").replace(/\/+$/, "");
  return PaymentSettingsResponseSchema.parse({
    provider: view.provider,
    environment: view.environment,
    midtrans: view.midtrans,
    xendit: view.xendit,
    webhookUrls: {
      midtrans: `${origin}/api/payments/webhook/midtrans`,
      xendit: `${origin}/api/payments/webhook/xendit`,
    },
  });
}

/**
 * Modul payments (Fase 14A) — gerbang pembayaran sungguhan per tenant:
 *   GET  /tenants/:tenantId/payment-settings            konfigurasi
 *        (semua member; HANYA penanda terkonfigurasi — nilai kunci
 *        tidak pernah keluar dari server)
 *   PUT  /tenants/:tenantId/payment-settings            simpan
 *        (owner/admin; kunci dienkripsi core)
 *   POST /tenants/:tenantId/payment-settings/test       uji koneksi
 *        provider aktif (owner/admin; kode hasil jujur)
 *   POST /payments/webhook/midtrans                     notifikasi
 *        Midtrans (publik; verifikasi signature_key di core)
 *   POST /payments/webhook/xendit                       callback
 *        Xendit (publik; verifikasi x-callback-token di core)
 *
 * Webhook TIDAK memakai sesi: autentikasinya kriptografis per tenant
 * (kunci/token milik tenant pemilik tautan, di-resolve dari tautan —
 * bukan dari klaim payload). Setiap hasil dicatat ke log integrasi
 * (payload TEREDAKSI: tanpa signature_key / token callback).
 */
export function createPaymentsRoutes(
  bundle: AuthBundle | null,
  opts: PaymentsModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const settingsBase = "/tenants/:tenantId/payment-settings";
  const deps: PaymentDeps = {
    tokenSecret: opts.tokenSecret,
    midtransApiBase: opts.midtransApiBase,
    xenditApiBase: opts.xenditApiBase,
    publicBaseUrl: opts.publicBaseUrl,
  };

  if (!bundle) {
    const notConfigured = (c: Parameters<typeof apiError>[0]) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(settingsBase, notConfigured);
    app.put(settingsBase, notConfigured);
    app.post(`${settingsBase}/test`, notConfigured);
    app.post("/payments/webhook/midtrans", notConfigured);
    app.post("/payments/webhook/xendit", notConfigured);
    return app;
  }


  async function guard(
    c: AppContext,
    opts2: { ownerAdmin: boolean },
  ) {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle!,
      c.req.param("tenantId") ?? "",
      appUser.id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      } as const;
    }
    if (
      opts2.ownerAdmin &&
      tenant.role !== "owner" &&
      tenant.role !== "admin"
    ) {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage payment settings",
        ),
      } as const;
    }
    return { tenant, appUser: { id: appUser.id } } as const;
  }

  async function readJson(c: AppContext): Promise<unknown | null> {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  }

  app.get(settingsBase, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const view = await getPaymentSettings(bundle.db, {
      tenantId: g.tenant.id,
    });
    return c.json(serializeSettings(view, opts.publicBaseUrl));
  });

  app.put(settingsBase, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdatePaymentSettingsRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid payment settings payload");
    }
    const result = await updatePaymentSettings(
      bundle.db,
      { tenantId: g.tenant.id },
      parsed.data,
      { actorType: "user", actorId: g.appUser.id },
      deps,
    );
    if (result.kind === "secret_unconfigured") {
      return apiError(
        c,
        503,
        "INTERNAL_ERROR",
        "Server encryption secret is not configured; keys cannot be stored",
      );
    }
    return c.json(serializeSettings(result.view, opts.publicBaseUrl));
  });

  app.post(`${settingsBase}/test`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const result = await testPaymentConnection(
      bundle.db,
      { tenantId: g.tenant.id },
      deps,
    );
    return c.json(PaymentSettingsTestResponseSchema.parse(result));
  });

  // ------------------------------------------------------------ webhooks
  /**
   * Mencatat hasil webhook ke log integrasi (best-effort, pola modul
   * telegram/meta). Payload yang disimpan TEREDAKSI — signature_key
   * Midtrans dan token callback Xendit TIDAK pernah ditulis; yang
   * dicatat hanya fakta berkode + boolean signatureValid.
   */
  async function logWebhook(
    provider: "midtrans" | "xendit",
    result: PaymentWebhookResult,
    signatureValid: boolean | null,
    summary: string,
    redactedPayload: unknown,
  ): Promise<void> {
    try {
      await recordIntegrationLog(bundle!.db, {
        direction: "in",
        provider,
        tenantId: result.tenantId,
        signatureValid,
        outcome:
          result.outcome === "applied"
            ? "recorded"
            : result.outcome === "duplicate"
              ? "duplicate"
              : result.outcome === "rejected_signature"
                ? "rejected_signature"
                : result.outcome === "not_configured"
                  ? "rejected_unconfigured"
                  : "error",
        errorCode:
          result.outcome === "applied" || result.outcome === "duplicate"
            ? null
            : result.outcome.toUpperCase(),
        summary,
        payload: redactedPayload,
      });
    } catch {
      // Log bersifat best-effort: kegagalannya tidak mengubah respons.
    }
  }

  function webhookHttpStatus(
    result: PaymentWebhookResult,
  ): 200 | 400 | 401 | 404 | 503 {
    switch (result.outcome) {
      case "applied":
      case "duplicate":
      case "ignored_pending":
        return 200;
      case "rejected_signature":
        return 401;
      case "rejected_amount":
      case "malformed":
        return 400;
      case "not_found":
        return 404;
      case "not_configured":
        return 503;
    }
  }

  app.post("/payments/webhook/midtrans", async (c) => {
    const payload = await readJson(c);
    const result = await handleMidtransWebhook(bundle.db, deps, payload);
    const rec =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    await logWebhook(
      "midtrans",
      result,
      result.outcome === "rejected_signature" ? false : result.outcome === "malformed" || result.outcome === "not_found" ? null : true,
      `midtrans webhook ${String(rec.transaction_status ?? "?")} → ${result.outcome}`,
      {
        order_id: rec.order_id ?? null,
        transaction_status: rec.transaction_status ?? null,
        status_code: rec.status_code ?? null,
        gross_amount: rec.gross_amount ?? null,
        fraud_status: rec.fraud_status ?? null,
      },
    );
    return c.json({ received: true, outcome: result.outcome }, webhookHttpStatus(result));
  });

  app.post("/payments/webhook/xendit", async (c) => {
    const payload = await readJson(c);
    const callbackToken = c.req.header("x-callback-token") ?? null;
    const result = await handleXenditWebhook(
      bundle.db,
      deps,
      callbackToken,
      payload,
    );
    const rec =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    await logWebhook(
      "xendit",
      result,
      result.outcome === "rejected_signature" ? false : result.outcome === "malformed" || result.outcome === "not_found" ? null : true,
      `xendit webhook ${String(rec.status ?? "?")} → ${result.outcome}`,
      {
        external_id: rec.external_id ?? null,
        status: rec.status ?? null,
        amount: rec.amount ?? null,
      },
    );
    return c.json({ received: true, outcome: result.outcome }, webhookHttpStatus(result));
  });

  return app;
}
