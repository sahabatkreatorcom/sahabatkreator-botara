import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  PinterestOAuthInfoResponseSchema,
  PinterestOAuthStartRequestSchema,
  PinterestOAuthStartResponseSchema,
} from "@sahabat-kreator/contracts";
import {
  createPinterestChannelAccount,
  encryptChannelSecret,
  fetchAndStoreProfilePhotoFromUrl,
  getPlatformPublicConfig,
  getProviderSecret,
  lookupChannelAccountsByProviderExternalId,
  recordChannelConnectedAudit,
  updatePinterestChannelAccountCredentials,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import {
  PinterestApiError,
  PinterestClient,
} from "@sahabat-kreator/channel-pinterest";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { createOAuthKvStore, type OAuthKvStore } from "../../oauth-kv";
import {
  signOAuthState,
  verifyOAuthState,
  type OAuthStatePayload,
} from "../oauth-state";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul Pinterest OAuth Connect (gelombang Semua OAuth) —
 * "Hubungkan dengan Pinterest".
 *
 *   POST /tenants/:tenantId/pinterest-oauth/start            buat state + URL dialog
 *   GET  /pinterest/oauth/callback                           callback TUNGGAL platform (publik)
 *   GET  /tenants/:tenantId/channels/pinterest-oauth-info    ketersediaan connect (owner/admin)
 *
 * Alur resmi API v5: authorize di `https://www.pinterest.com/oauth/`
 * (scope boards:read,boards:write,pins:read,pins:write +
 * user_accounts:read untuk profil/avatar) → callback menukar code
 * di `POST /v5/oauth/token` (HTTP Basic app_id:secret) → profil
 * `GET /v5/user_account` (id = external_id, username, profile_image)
 * → akun channel `pinterest` disimpan (KEDUA token TERENKRIPSI
 * envelope CHANNEL_TOKEN_SECRET). Access token ±30 hari disegarkan
 * worker lifecycle memakai refresh token sebelum kedaluwarsa. Pin
 * diterbitkan adapter ke board PERTAMA akun (keputusan Gelombang 3
 * — connect tidak mengubahnya).
 *
 * Kepercayaan & kustodi mengikuti modul Threads/TikTok persis:
 * state HMAC sekali pakai, penjaga satu akun = satu koneksi lintas
 * workspace, revive baris yang sama, token tidak pernah masuk
 * log/respons/URL selain dialog authorize.
 */
export interface PinterestOAuthModuleOptions {
  /** Resolver Panel Admin: pinterest_app_id (publik) + pinterest_app_secret. */
  platform: PlatformSettingsOptions;
  /** Kunci envelope kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL API Pinterest (env PINTEREST_API_BASE; default api.pinterest.com). */
  pinterestApiBase?: string;
  /** URL publik aplikasi (env BETTER_AUTH_URL) — dasar redirect URI & tujuan redirect browser. */
  publicBaseUrl?: string;
  /** Redis platform (env REDIS_URL) untuk nonce OAuth. */
  redisUrl?: string;
  /** Secret penandatangan state (env BETTER_AUTH_SECRET). */
  stateSecret?: string;
}

const OAUTH_TTL_SECONDS = 600;
const PINTEREST_AUTHORIZE_BASE = "https://www.pinterest.com";
/**
 * Scope: board + pin untuk penerbitan (Gelombang 3) dan
 * user_accounts:read agar profil (identitas + foto) bisa dibaca
 * saat connect — tanpa scope terakhir /v5/user_account ditolak.
 */
const PINTEREST_OAUTH_SCOPES =
  "boards:read,boards:write,pins:read,pins:write,user_accounts:read";

export function createPinterestOAuthRoutes(
  bundle: AuthBundle | null,
  opts: PinterestOAuthModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const tenantBase = "/tenants/:tenantId/pinterest-oauth";

  if (!bundle) {
    app.post(`${tenantBase}/start`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tenants/:tenantId/channels/pinterest-oauth-info", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/pinterest/oauth/callback", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  const store: OAuthKvStore = createOAuthKvStore(opts.redisUrl, {
    namespace: "pinterest-oauth",
    ttlSeconds: OAUTH_TTL_SECONDS,
  });

  const webBase = (opts.publicBaseUrl ?? "").replace(/\/+$/, "");
  const redirectUri = `${webBase}/api/pinterest/oauth/callback`;

  /** Konfigurasi OAuth efektif (panel → env). */
  async function resolvePinterestConfig() {
    const [publicConfig, appSecret] = await Promise.all([
      getPlatformPublicConfig(bundle!.db, opts.platform),
      getProviderSecret(bundle!.db, "pinterest_app_secret", opts.platform),
    ]);
    const appId = publicConfig.pinterest_app_id;
    return {
      appId,
      appSecret,
      available: Boolean(appId) && Boolean(appSecret),
    };
  }

  // -------------------------------------------------------------------------
  // Info ketersediaan connect (owner/admin) — dasar tombol di Channels.
  // -------------------------------------------------------------------------
  app.get("/tenants/:tenantId/channels/pinterest-oauth-info", async (c) => {
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
        "Only workspace owners and admins can view Pinterest OAuth settings",
      );
    }
    const config = await resolvePinterestConfig();
    const body = PinterestOAuthInfoResponseSchema.parse({
      oauthRedirectUri: redirectUri,
      appId: config.appId,
      appIdConfigured: Boolean(config.appId),
      appSecretConfigured: Boolean(config.appSecret),
      available: config.available,
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Start: buat state sekali pakai + URL dialog authorize Pinterest.
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
    const parsed = PinterestOAuthStartRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid OAuth start payload");
    }
    if (!opts.stateSecret || !webBase) {
      return apiError(
        c,
        503,
        "PINTEREST_OAUTH_NOT_CONFIGURED",
        "Pinterest OAuth is not configured on this server",
      );
    }
    const config = await resolvePinterestConfig();
    if (!config.available || !config.appId) {
      return apiError(
        c,
        503,
        "PINTEREST_OAUTH_NOT_CONFIGURED",
        "Pinterest app credentials are not configured in the platform admin panel yet",
      );
    }

    const expSeconds = Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS;
    const payload: OAuthStatePayload = {
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
    const state = signOAuthState(opts.stateSecret, payload);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.appId,
      redirect_uri: redirectUri,
      scope: PINTEREST_OAUTH_SCOPES,
      state,
    });
    const body = PinterestOAuthStartResponseSchema.parse({
      dialogUrl: `${PINTEREST_AUTHORIZE_BASE}/oauth/?${params.toString()}`,
      expiresAt: new Date(expSeconds * 1000).toISOString(),
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Callback TUNGGAL (publik; identitas dari state bertanda tangan).
  // Semua kegagalan → redirect error berkode TANPA membuat akun apa pun.
  // -------------------------------------------------------------------------
  app.get("/pinterest/oauth/callback", async (c) => {
    const fail = (code: string) =>
      c.redirect(`${webBase}/channels?pinterest_oauth_error=${code}`, 302);

    if (!opts.stateSecret || !webBase) {
      return fail("PINTEREST_OAUTH_NOT_CONFIGURED");
    }
    // Pinterest mengembalikan `error` bila user membatalkan/menolak izin.
    if (c.req.query("error")) return fail("PINTEREST_OAUTH_CANCELLED");

    const stateRaw = c.req.query("state");
    const code = c.req.query("code");
    if (!stateRaw || !code) return fail("PINTEREST_OAUTH_STATE_INVALID");
    const state = verifyOAuthState(opts.stateSecret, stateRaw);
    if (!state) return fail("PINTEREST_OAUTH_STATE_INVALID");
    let consumed = false;
    try {
      consumed = await store.consumeNonce(state.nonce);
    } catch {
      consumed = false;
    }
    if (!consumed) return fail("PINTEREST_OAUTH_STATE_INVALID");

    const config = await resolvePinterestConfig();
    if (!config.appId || !config.appSecret) {
      return fail("PINTEREST_OAUTH_NOT_CONFIGURED");
    }
    if (!opts.channelTokenSecret) return fail("PINTEREST_OAUTH_NOT_CONFIGURED");

    // Tukar code → token → profil akun. Profil WAJIB (id akun adalah
    // identitas channel — tanpa profil tidak ada akun yang dibuat).
    let accountId: string;
    let accessToken: string;
    let refreshToken: string | null;
    let expiresInSeconds: number | null;
    let username: string | null = null;
    let profileImageUrl: string | null = null;
    try {
      const client = new PinterestClient({ baseUrl: opts.pinterestApiBase });
      const tokens = await client.exchangePinterestCode({
        appId: config.appId,
        appSecret: config.appSecret,
        code,
        redirectUri,
      });
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
      expiresInSeconds = tokens.expiresInSeconds;
      const account = await client.getPinterestUserAccount(tokens.accessToken);
      accountId = account.id;
      username = account.username;
      profileImageUrl = account.profileImageUrl;
    } catch (err) {
      const detail =
        err instanceof PinterestApiError
          ? `${err.status}: ${err.description}`
          : "non-api error";
      console.error(`[pinterest-oauth] exchange/profil gagal (${detail})`);
      return fail("PINTEREST_OAUTH_EXCHANGE_FAILED");
    }

    // Penjaga satu akun = satu koneksi (pola meta-oauth).
    const existing = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      "pinterest",
      accountId,
    );
    const activeElsewhere = existing.find(
      (r) => r.tenantId !== state.tenantId && r.status !== "disconnected",
    );
    if (activeElsewhere) return fail("PINTEREST_ACCOUNT_ALREADY_CONNECTED");

    const own = existing.find((r) => r.tenantId === state.tenantId);
    if (own && own.status === "connected") {
      // Idempoten seperti Threads: kredensial tidak ditimpa;
      // token disegarkan worker lifecycle.
      return c.redirect(`${webBase}/channels?pinterest_oauth=connected`, 302);
    }

    const tokenExpiresAt =
      expiresInSeconds == null
        ? null
        : new Date(Date.now() + expiresInSeconds * 1000);
    let encryptedAccessToken: string;
    let encryptedRefreshToken: string | null;
    try {
      encryptedAccessToken = encryptChannelSecret(
        opts.channelTokenSecret,
        accessToken,
      );
      encryptedRefreshToken = refreshToken
        ? encryptChannelSecret(opts.channelTokenSecret, refreshToken)
        : null;
    } catch {
      return fail("PINTEREST_OAUTH_NOT_CONFIGURED");
    }

    let rowId: string;
    if (own) {
      const row = await updatePinterestChannelAccountCredentials(
        bundle.db,
        { tenantId: state.tenantId },
        own.id,
        {
          encryptedAccessToken,
          encryptedRefreshToken,
          publicHandle: username,
          status: "connected",
          tokenExpiresAt,
          tokenRefreshedAt: null,
        },
      );
      if (!row) return fail("PINTEREST_OAUTH_EXCHANGE_FAILED");
      rowId = row.id;
    } else {
      const row = await createPinterestChannelAccount(
        bundle.db,
        { tenantId: state.tenantId, userId: state.userId },
        {
          accountExternalId: accountId,
          publicHandle: username,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt,
        },
      );
      rowId = row.id;
    }

    await recordChannelConnectedAudit(
      bundle.db,
      { tenantId: state.tenantId, userId: state.userId },
      { channelAccountId: rowId, provider: "pinterest", method: "oauth" },
    );

    // Foto profil dari `profile_image` — fail-soft pola platform lain.
    await awaitPhotoSoftDeadline(
      fetchAndStoreProfilePhotoFromUrl(bundle.db, {
        tenantId: state.tenantId,
        channelAccountId: rowId,
        pictureUrl: profileImageUrl,
      }),
    );

    return c.redirect(`${webBase}/channels?pinterest_oauth=connected`, 302);
  });

  return app;
}

/**
 * Batas lunak menunggu pengambilan foto profil pada jalur connect
 * (pola Hotfix R1 modul channels/meta-oauth): pekerjaan foto menelan
 * semua error-nya sendiri; lewat ±6 detik koneksi tetap selesai dan
 * foto menyusul lewat backfill daftar channel.
 */
const PHOTO_FETCH_SOFT_DEADLINE_MS = 6_000;

async function awaitPhotoSoftDeadline(work: Promise<unknown>): Promise<void> {
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) =>
      setTimeout(resolve, PHOTO_FETCH_SOFT_DEADLINE_MS),
    ),
  ]);
}
