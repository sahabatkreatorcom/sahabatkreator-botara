import { Hono } from "hono";
import {
  PublicPaymentResponseSchema,
  type PublicPaymentResponse,
} from "@sahabat-kreator/contracts";
import {
  getPublicPaymentByCode,
  simulatePayByCode,
  type PublicPaymentView,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";

function serializeView(view: PublicPaymentView): PublicPaymentResponse {
  return PublicPaymentResponseSchema.parse({
    code: view.code,
    productName: view.productName,
    description: view.description,
    amountIdr: view.amountIdr,
    status: view.status,
    tenantName: view.tenantName,
    provider: view.provider,
    providerEnvironment: view.providerEnvironment,
    checkoutUrl: view.checkoutUrl,
    paidAt: view.paidAt?.toISOString() ?? null,
    expiresAt: view.expiresAt.toISOString(),
  });
}

/**
 * Modul pay (Fase 4A) — API publik halaman bayar /pay/:code (TANPA sesi):
 *   GET  /pay/:code               ringkasan tautan (produk, harga, status)
 *   POST /pay/:code/simulate-pay  SIMULASI pembayaran → status paid
 * Autentikasinya adalah `code` itu sendiri (kredensial publik tautan,
 * pola yang sama dengan siteKey webchat): resolusi code → tenant lewat
 * lengan RLS `app.payment_code` (migrasi 0012) di core; code tak dikenal
 * → 404. Respons TIDAK memuat data pribadi kontak.
 *
 * Fase 14A: untuk tautan provider sungguhan (midtrans/xendit) respons
 * membawa `checkoutUrl` dan halaman /pay mengarahkan pembeli ke sana;
 * label simulasi hanya untuk provider 'simulation', dan endpoint
 * simulate-pay menolak tautan non-simulasi (409 PAYMENT_NOT_SIMULATION)
 * — pembayaran sungguhan hanya selesai lewat webhook provider.
 */
export function createPayRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();

  if (!bundle) {
    const notConfigured = (c: Parameters<typeof apiError>[0]) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get("/pay/:code", notConfigured);
    app.post("/pay/:code/simulate-pay", notConfigured);
    return app;
  }

  app.get("/pay/:code", async (c) => {
    const view = await getPublicPaymentByCode(bundle.db, c.req.param("code"));
    if (!view) {
      return apiError(c, 404, "NOT_FOUND", "Payment link not found");
    }
    return c.json(serializeView(view));
  });

  app.post("/pay/:code/simulate-pay", async (c) => {
    const result = await simulatePayByCode(bundle.db, c.req.param("code"));
    if (!result) {
      return apiError(c, 404, "NOT_FOUND", "Payment link not found");
    }
    if (result.kind === "not_payable") {
      return apiError(
        c,
        409,
        "VALIDATION_ERROR",
        `Payment link is ${result.view.status} and can no longer be paid`,
      );
    }
    if (result.kind === "not_simulation") {
      // Fase 14A: tautan provider sungguhan hanya selesai lewat
      // webhook provider — endpoint simulasi menolaknya dengan jujur.
      return apiError(
        c,
        409,
        "PAYMENT_NOT_SIMULATION",
        "This link uses a real payment provider and cannot be simulated",
      );
    }
    return c.json(serializeView(result.view));
  });

  return app;
}
