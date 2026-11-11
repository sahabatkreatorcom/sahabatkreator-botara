import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  ThreadsOAuthInfoResponseSchema,
  ThreadsOAuthStartRequestSchema,
  ThreadsOAuthStartResponseSchema,
} from "@sahabat-kreator/contracts";
import {
  createThreadsChannelAccount,
  encryptChannelSecret,
  getPlatformPublicConfig,
  getProviderSecret,
  lookupChannelAccountsByProviderExternalId,
  recordChannelConnectedAudit,
  updateThreadsChannelAccountCredentials,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import {
  DEFAULT_THREADS_API_VERSION,
  ThreadsGraphClient,
  ThreadsGraphError,
} from "@sahabat-kreator/channel-messenger";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { createOAuthKvStore, type OAuthKvStore } from "../../oauth-kv";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul Threads OAuth Connect (integrasi Threads) — "Hubungkan dengan
 * Threads".
 *
 *   POST /tenants/:tenantId/threads-oauth/start              buat state + URL dialog
 *   GET  /threads/oauth/callback                             callback TUNGGAL platform (publik)
 *   GET  /tenants/:tenantId/channels/threads-oauth-info      ketersediaan connect (owner/admin)
 *
 * Alur OAuth resmi Threads (dokumentasi threads.net):
 * authorize di `https://threads.net/oauth/authorize` (client_id =
 * Threads App ID platform, scope `threads_basic` +
 * `threads_content_publish`) → callback menukar code di
 * `graph.threads.net/oauth/access_token` → token pendek ditukar ke
 * token berumur panjang (±60 hari) via grant `th_exchange_token` →
 * profil `/me` (id + username + name) → akun channel `threads`
 * disimpan (token TERENKRIPSI envelope CHANNEL_TOKEN_SECRET;
 * external_id = Threads user ID). Sesudah itu sasaran Threads muncul
 * otomatis di /posts lewat materialisasi listPostTargets — akun dari
 * connect ini berbentuk persis akun Gelombang 1.
 *
 * Kepercayaan & kustodi (pola meta-oauth 7D):
 * - `state` = payload bertanda tangan HMAC (tenantId, userId, nonce,
 *   exp ≤10 menit). Nonce diklaim saat start dan DIKONSUMSI atomik
 *   saat callback (sekali pakai — replay ditolak).
 * - Kredensial aplikasi diselesaikan panel → env PER REQUEST
 *   (threads_app_id publik via getPlatformPublicConfig;
 *   threads_app_secret via getProviderSecret). Belum terisi → info
 *   menjawab appIdConfigured/appSecretConfigured=false dan start
 *   menjawab 503 THREADS_OAUTH_NOT_CONFIGURED — jujur, seperti Meta.
 * - Token TIDAK PERNAH masuk URL/browser/log: callback bekerja penuh
 *   di server dan hanya me-redirect browser dengan penanda hasil
 *   (`?threads_oauth=connected` / `?threads_oauth_error=<KODE>`).
 *
 * Beda bentuk dari meta-oauth — SENGAJA: login Threads selalu
 * menghasilkan TEPAT SATU akun (akun pemberi izin), jadi tidak ada
 * sesi pemilih aset; callback langsung menghubungkan (pola yang sama
 * dengan callback Google Calendar 13G). Penyimpanan nonce memakai
 * oauth-kv yang sama (namespace `threads-oauth`).
 */

export interface ThreadsOAuthModuleOptions {
  /** Resolver Panel Admin: threads_app_id (publik) + threads_app_secret. */
  platform: PlatformSettingsOptions;
  /** Kunci envelope kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Threads API (env THREADS_API_BASE; default graph.threads.net). */
  threadsApiBase?: string;
  /** URL publik aplikasi (env BETTER_AUTH_URL) — dasar redirect URI & tujuan redirect browser. */
  publicBaseUrl?: string;
  /** Redis platform (env REDIS_URL) untuk nonce OAuth. */
  redisUrl?: string;
  /** Secret penandatangan state (env BETTER_AUTH_SECRET). */
  stateSecret?: string;
}

const OAUTH_TTL_SECONDS = 600;
const THREADS_AUTHORIZE_BASE = "https://threads.net";
/** Scope minimum: profil dasar + penerbitan content schedule. */
const THREADS_OAUTH_SCOPES = [
  "threads_basic",
  "threads_content_publish",
] as const;

// ---------------------------------------------------------------------------
// State bertanda tangan (HMAC-SHA256) — pola meta-oauth/google-oauth
// ---------------------------------------------------------------------------

interface ThreadsOAuthStatePayload {
  v: 1;
  tenantId: string;
  userId: string;
  nonce: string;
  /** Epoch detik kedaluwarsa. */
  exp: number;
}

function signThreadsOAuthState(
  secret: string,
  payload: ThreadsOAuthStatePayload,
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret).update(body).digest();
  return `${body}.${signature.toString("base64url")}`;
}

function verifyThreadsOAuthState(
  secret: string,
  state: string,
): ThreadsOAuthStatePayload | null {
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const presented = Buffer.from(state.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  let payload: ThreadsOAuthStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as ThreadsOAuthStatePayload;
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (
    typeof payload.tenantId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Modul
// ---------------------------------------------------------------------------

export function createThreadsOAuthRoutes(
  bundle: AuthBundle | null,
  opts: ThreadsOAuthModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const tenantBase = "/tenants/:tenantId/threads-oauth";

  if (!bundle) {
    app.post(`${tenantBase}/start`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tenants/:tenantId/channels/threads-oauth-info", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/threads/oauth/callback", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  const store: OAuthKvStore = createOAuthKvStore(opts.redisUrl, {
    namespace: "threads-oauth",
    ttlSeconds: OAUTH_TTL_SECONDS,
  });

  const webBase = (opts.publicBaseUrl ?? "").replace(/\/+$/, "");
  const redirectUri = `${webBase}/api/threads/oauth/callback`;

  /** Konfigurasi OAuth efektif (panel → env). */
  async function resolveThreadsConfig() {
    const [publicConfig, appSecret] = await Promise.all([
      getPlatformPublicConfig(bundle!.db, opts.platform),
      getProviderSecret(bundle!.db, "threads_app_secret", opts.platform),
    ]);
    const appId = publicConfig.threads_app_id;
    return {
      appId,
      appSecret,
      available: Boolean(appId) && Boolean(appSecret),
    };
  }

  // -------------------------------------------------------------------------
  // Info ketersediaan connect (owner/admin) — dasar tombol di Channels.
  // -------------------------------------------------------------------------
  app.get("/tenants/:tenantId/channels/threads-oauth-info", async (c) => {
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId"),
      c.get("appUser").id,
    );
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only workspace owners and admins can view Threads OAuth settings",
      );
    }
    const config = await resolveThreadsConfig();
    const body = ThreadsOAuthInfoResponseSchema.parse({
      oauthRedirectUri: redirectUri,
      appId: config.appId,
      appIdConfigured: Boolean(config.appId),
      appSecretConfigured: Boolean(config.appSecret),
      available: config.available,
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Start: buat state sekali pakai + URL dialog authorize Threads.
  // -------------------------------------------------------------------------
  app.post(`${tenantBase}/start`, async (c) => {
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
        "Only workspace owners and admins can connect channels",
      );
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = ThreadsOAuthStartRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid OAuth start payload");
    }
    if (!opts.stateSecret || !webBase) {
      return apiError(
        c,
        503,
        "THREADS_OAUTH_NOT_CONFIGURED",
        "Threads OAuth is not configured on this server",
      );
    }
    const config = await resolveThreadsConfig();
    if (!config.available || !config.appId) {
      return apiError(
        c,
        503,
        "THREADS_OAUTH_NOT_CONFIGURED",
        "Threads app credentials are not configured in the platform admin panel yet",
      );
    }

    const expSeconds = Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS;
    const payload: ThreadsOAuthStatePayload = {
      v: 1,
      tenantId: tenant.id,
      userId: appUser.id,
      nonce: randomBytes(18).toString("hex"),
      exp: expSeconds,
    };
    let claimed = false;
    try {
      claimed = await store.claimNonce(payload.nonce);
    } catch {
      return apiError(c, 503, "INTERNAL_ERROR", "OAuth session store is unavailable");
    }
    if (!claimed) {
      return apiError(c, 503, "INTERNAL_ERROR", "Could not allocate an OAuth state");
    }
    const state = signThreadsOAuthState(opts.stateSecret, payload);

    const params = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: redirectUri,
      scope: THREADS_OAUTH_SCOPES.join(","),
      response_type: "code",
      state,
    });
    const body = ThreadsOAuthStartResponseSchema.parse({
      dialogUrl: `${THREADS_AUTHORIZE_BASE}/oauth/authorize?${params.toString()}`,
      expiresAt: new Date(expSeconds * 1000).toISOString(),
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Callback TUNGGAL (publik; identitas dari state bertanda tangan).
  // Semua kegagalan → redirect error berkode TANPA membuat akun apa pun.
  // -------------------------------------------------------------------------
  app.get("/threads/oauth/callback", async (c) => {
    const fail = (code: string) =>
      c.redirect(`${webBase}/channels?threads_oauth_error=${code}`, 302);

    if (!opts.stateSecret || !webBase) {
      return fail("THREADS_OAUTH_NOT_CONFIGURED");
    }
    // Threads mengembalikan `error` bila user membatalkan/menolak izin.
    if (c.req.query("error")) return fail("THREADS_OAUTH_CANCELLED");

    const stateRaw = c.req.query("state");
    const code = c.req.query("code");
    if (!stateRaw || !code) return fail("THREADS_OAUTH_STATE_INVALID");
    const state = verifyThreadsOAuthState(opts.stateSecret, stateRaw);
    if (!state) return fail("THREADS_OAUTH_STATE_INVALID");
    let consumed = false;
    try {
      consumed = await store.consumeNonce(state.nonce);
    } catch {
      consumed = false;
    }
    if (!consumed) return fail("THREADS_OAUTH_STATE_INVALID");

    const config = await resolveThreadsConfig();
    if (!config.appId || !config.appSecret) {
      return fail("THREADS_OAUTH_NOT_CONFIGURED");
    }
    if (!opts.channelTokenSecret) return fail("THREADS_OAUTH_NOT_CONFIGURED");

    // Tukar code → token pendek → token berumur panjang → profil.
    // Hanya label tahap + kode/pesan resmi provider yang dicatat;
    // code, token, dan secret TIDAK PERNAH dicatat.
    let profile: { id: string; username: string | null; name: string | null };
    let longLived: { accessToken: string; expiresInSeconds: number | null };
    try {
      const anon = new ThreadsGraphClient({ baseUrl: opts.threadsApiBase });
      const short = await anon.exchangeThreadsCode({
        clientId: config.appId,
        clientSecret: config.appSecret,
        code,
        redirectUri,
      });
      longLived = await anon.exchangeThreadsLongLivedToken({
        clientSecret: config.appSecret,
        shortLivedToken: short.accessToken,
      });
      profile = await new ThreadsGraphClient({
        baseUrl: opts.threadsApiBase,
        accessToken: longLived.accessToken,
      }).getThreadsProfile();
    } catch (err) {
      const detail =
        err instanceof ThreadsGraphError
          ? `graph ${err.graphCode ?? err.status}` +
            (err.graphSubcode !== null ? ` subcode ${err.graphSubcode}` : "") +
            `: ${err.description}`
          : "non-graph error";
      console.error(`[threads-oauth] exchange/profil gagal ${detail}`);
      return fail("THREADS_OAUTH_EXCHANGE_FAILED");
    }

    // Penjaga satu akun = satu koneksi (pola meta-oauth): aktif di
    // workspace lain → ditolak; TIDAK ada akun yang dibuat/diubah.
    const existing = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      "threads",
      profile.id,
    );
    const activeElsewhere = existing.find(
      (r) => r.tenantId !== state.tenantId && r.status !== "disconnected",
    );
    if (activeElsewhere) return fail("THREADS_ACCOUNT_ALREADY_CONNECTED");

    const own = existing.find((r) => r.tenantId === state.tenantId);
    if (own && own.status === "connected") {
      // Sudah terhubung di workspace ini — idempoten seperti complete
      // Meta: kredensial yang ada TIDAK ditimpa; token disegarkan
      // worker lifecycle, bukan oleh login ulang.
      return c.redirect(`${webBase}/channels?threads_oauth=connected`, 302);
    }

    const tokenExpiresAt =
      longLived.expiresInSeconds == null
        ? null
        : new Date(Date.now() + longLived.expiresInSeconds * 1000);
    let encryptedAccessToken: string;
    try {
      encryptedAccessToken = encryptChannelSecret(
        opts.channelTokenSecret,
        longLived.accessToken,
      );
    } catch {
      return fail("THREADS_OAUTH_NOT_CONFIGURED");
    }

    let rowId: string;
    if (own) {
      // Revive baris yang sama dengan kredensial OAuth baru.
      const row = await updateThreadsChannelAccountCredentials(
        bundle.db,
        { tenantId: state.tenantId },
        own.id,
        {
          encryptedAccessToken,
          publicHandle: profile.username,
          profileName: profile.name,
          status: "connected",
          tokenExpiresAt,
          tokenRefreshedAt: null,
        },
      );
      if (!row) return fail("THREADS_OAUTH_EXCHANGE_FAILED");
      rowId = row.id;
    } else {
      const row = await createThreadsChannelAccount(
        bundle.db,
        { tenantId: state.tenantId, userId: state.userId },
        {
          accountExternalId: profile.id,
          profileName: profile.name,
          publicHandle: profile.username,
          encryptedAccessToken,
          graphApiVersion: DEFAULT_THREADS_API_VERSION,
          tokenExpiresAt,
        },
      );
      rowId = row.id;
    }

    await recordChannelConnectedAudit(
      bundle.db,
      { tenantId: state.tenantId, userId: state.userId },
      { channelAccountId: rowId, provider: "threads", method: "oauth" },
    );

    return c.redirect(`${webBase}/channels?threads_oauth=connected`, 302);
  });

  return app;
}
