/**
 * Observability HTTP untuk apps/api (Fase 16A).
 *
 * Tanggung jawab:
 * 1. `requestContext` — memberi setiap request `requestId` (dari header
 *    `x-request-id` bila wajar, selain itu UUID), `clientIp`, dan logger
 *    request-scoped; menulis SATU baris access log JSON saat selesai.
 * 2. `securityHeaders` — header keamanan standar (nosniff, frame, HSTS,
 *    CSP). CSP mengizinkan `<style>` inline karena halaman growth publik
 *    (`/go/:slug`) merender CSS inline; tidak ada script inline.
 * 3. `createErrorHandler` — exception tak tertangani menjadi respons
 *    kontrak `{ error: { code: "INTERNAL_ERROR" } }` TANPA membocorkan
 *    stack/pesan internal; detail lengkap hanya di log.
 * 4. `createNotFoundHandler` — 404 konsisten berbentuk kontrak.
 *
 * Catatan kepercayaan IP: `cf-connecting-ip` hanya sah bila origin HANYA
 * bisa dicapai lewat Cloudflare Tunnel (lihat docs/PRODUCTION.md §1).
 * `x-forwarded-for` dipakai sebagai fallback di belakang reverse-proxy lain.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { Logger } from "@sahabat-kreator/config";
import { apiError, type AppVariables } from "./http";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Nilai fallback bila tidak ada satu pun sumber IP yang bisa dibaca. */
const UNKNOWN_IP = "unknown";

/**
 * Resolusi IP klien untuk rate limit & log. Urutan: Cloudflare →
 * X-Forwarded-For (entri pertama) → socket remote → "unknown".
 * Tidak pernah melempar: `getConnInfo` bergantung pada adapter runtime.
 */
export function resolveClientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  try {
    return getConnInfo(c).remote.address ?? UNKNOWN_IP;
  } catch {
    return UNKNOWN_IP;
  }
}

/** Middleware konteks request + access log. Pasang SEBELUM route apa pun. */
export function createRequestMiddleware(
  logger: Logger,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const requestId =
      inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : crypto.randomUUID();
    const clientIp = resolveClientIp(c);
    const requestLogger = logger.child({ requestId });

    c.set("requestId", requestId);
    c.set("clientIp", clientIp);
    c.set("logger", requestLogger);
    c.header("x-request-id", requestId);

    const startedAt = performance.now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } catch (err) {
      status = err instanceof HTTPException ? err.status : 500;
      throw err;
    } finally {
      requestLogger.info("http.request", {
        method: c.req.method,
        path: c.req.path,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        ip: clientIp,
      });
    }
  };
}

/**
 * Header keamanan. `Cross-Origin-Resource-Policy: cross-origin` sengaja
 * dipilih karena endpoint widget webchat memang dibaca dari origin situs
 * tenant (bukan same-origin). HSTS aman dikirim juga di dev: browser
 * mengabaikannya untuk origin non-HTTPS.
 */
export const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    fontSrc: ["'self'", "https:", "data:"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
    imgSrc: ["'self'", "data:", "https:"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "https:", "'unsafe-inline'"],
    upgradeInsecureRequests: [],
  },
  crossOriginResourcePolicy: "cross-origin",
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: "max-age=31536000; includeSubDomains",
  xFrameOptions: "SAMEORIGIN",
});

/** Error handler global: kontrak JSON, tanpa kebocoran detail internal. */
export function createErrorHandler(
  logger: Logger,
): ErrorHandler<{ Variables: AppVariables }> {
  return (err, c) => {
    const requestId = c.get("requestId");
    const log = requestId ? c.get("logger") : logger;
    log.error("http.error", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      err,
    });

    // HTTPException membawa respons sendiri (mis. 401 dari middleware
    // bawaan). Hormati bentuk aslinya agar perilaku library tidak berubah.
    if (err instanceof HTTPException) return err.getResponse();

    return apiError(c, 500, "INTERNAL_ERROR", "Internal server error");
  };
}

/** 404 konsisten berbentuk kontrak (sebelumnya teks polos Hono). */
export function createNotFoundHandler(): NotFoundHandler<{
  Variables: AppVariables;
}> {
  return (c) => apiError(c, 404, "NOT_FOUND", "Route not found");
}
