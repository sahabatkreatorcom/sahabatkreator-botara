import type { Context } from "hono";
import type { Logger } from "@sahabat-kreator/config";
import {
  ApiErrorSchema,
  type ApiKeyScope,
  type ErrorCode,
} from "@sahabat-kreator/contracts";
import type { ApiKey, User } from "@sahabat-kreator/db";

/** Konteks autentikasi API publik /v1 (Fase 5A): tenant diturunkan dari API key. */
export interface ApiKeyAuthContext {
  apiKey: ApiKey;
  tenantId: string;
  scopes: ApiKeyScope[];
}

/** Variabel konteks Hono untuk request terautentikasi. */
export interface AppVariables {
  /** Baris `users` kita (bukan auth_user Better Auth) untuk sesi aktif. */
  appUser: User;
  /** Id Better Auth (auth_user.id) dari sesi aktif. */
  authUserId: string;
  /** Terisi hanya pada route API publik /v1 sesudah middleware API key lolos. */
  apiKeyAuth: ApiKeyAuthContext;
  /**
   * Id korelasi request (Observability): diambil dari `x-request-id` yang
   * masuk bila bentuknya wajar, selain itu UUID baru. Selalu dikembalikan
   * pada respons dan dipakai logger access/error.
   */
  requestId: string;
  /** IP klien hasil resolusi header proxy/tunnel (untuk rate limit & log). */
  clientIp: string;
  /** Logger request-scoped (membawa requestId otomatis). */
  logger: Logger;
}

export type AppContext = Context<{ Variables: AppVariables }>;

/** Balasan error sesuai kontrak: { error: { code, message } } (RANCANGAN §11.1). */
export function apiError(
  c: Context,
  // 413/415 (Fase 18B): unggahan lampiran — ukuran dan tipe ditolak
  // dengan kode yang bisa ditindaklanjuti pengguna, bukan 400 generik.
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  const body = ApiErrorSchema.parse({
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
  return c.json(body, status);
}
