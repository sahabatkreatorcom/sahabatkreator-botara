import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  LinkedInOAuthInfoResponseSchema,
  LinkedInOAuthStartRequestSchema,
  LinkedInOAuthStartResponseSchema,
} from "@sahabat-kreator/contracts";
import {
  createLinkedInChannelAccount,
  encryptChannelSecret,
  fetchAndStoreProfilePhotoFromUrl,
  getPlatformPublicConfig,
  getProviderSecret,
  lookupChannelAccountsByProviderExternalId,
  recordChannelConnectedAudit,
  updateLinkedInChannelAccountCredentials,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import {
  LinkedInApiError,
  LinkedInClient,
} from "@sahabat-kreator/channel-linkedin";
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
 * Modul LinkedIn OAuth Connect (gelombang Semua OAuth) —
 * "Hubungkan dengan LinkedIn" untuk PROFIL PRIBADI.
 *
 *   POST /tenants/:tenantId/linkedin-oauth/start             buat state + URL dialog
 *   GET  /linkedin/oauth/callback                            callback TUNGGAL platform (publik)
 *   GET  /tenants/:tenantId/channels/linkedin-oauth-info     ketersediaan connect (owner/admin)
 *
 * Alur resmi: authorize di
 * `https://www.linkedin.com/oauth/v2/authorization` (scope
 * `openid profile w_member_social`) → callback menukar code di
 * token endpoint host www (`POST /oauth/v2/accessToken`) → profil
 * OIDC `GET /v2/userinfo` di host API (sub = external_id, name,
 * picture) → akun channel `linkedin` disimpan (access token
 * TERENKRIPSI envelope CHANNEL_TOKEN_SECRET). Sasaran LinkedIn
 * muncul otomatis di /posts lewat materialisasi malas yang sama
 * seperti platform lain.
 *
 * BATAS PLATFORM YANG JUJUR (juga di kontrak + OWNER-ACTIONS):
 * LinkedIn TIDAK menerbitkan refresh token untuk program standar —
 * token ±60 hari dan lifecycle-nya TANDAI-RECONNECT di worker
 * (menandai expiring, lalu 'error' linkedin_token_expired sesudah
 * lewat). Modul ini tidak berpura-pura ada penyegaran. Company
 * Page TIDAK didukung (program Community Management terpisah).
 *
 * Kepercayaan & kustodi mengikuti modul Threads/TikTok persis:
 * state HMAC sekali pakai (nonce diklaim & dikonsumsi atomik via
 * oauth-kv), penjaga satu akun = satu koneksi lintas workspace,
 * revive baris yang sama untuk akun sendiri yang terputus, token
 * tidak pernah masuk log/respons/URL selain dialog authorize.
 */
export interface LinkedInOAuthModuleOptions {
  /** Resolver Panel Admin: linkedin_client_id (publik) + linkedin_client_secret. */
  platform: PlatformSettingsOptions;
  /** Kunci envelope kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL API LinkedIn (env LINKEDIN_API_BASE; default api.linkedin.com) — profil OIDC. */
  linkedinApiBase?: string;
  /**
   * Base URL host OAuth LinkedIn (env LINKEDIN_OAUTH_BASE; default
   * www.linkedin.com) — token endpoint hidup di host www.
   */
  linkedinOAuthBase?: string;
  /** URL publik aplikasi (env BETTER_AUTH_URL) — dasar redirect URI & tujuan redirect browser. */
  publicBaseUrl?: string;
  /** Redis platform (env REDIS_URL) untuk nonce OAuth. */
  redisUrl?: string;
  /** Secret penandatangan state (env BETTER_AUTH_SECRET). */
  stateSecret?: string;
}

const OAUTH_TTL_SECONDS = 600;
const LINKEDIN_AUTHORIZE_BASE = "https://www.linkedin.com";
/** Scope: identitas OIDC + penerbitan ke profil pribadi. */
const LINKEDIN_OAUTH_SCOPES = "openid profile w_member_social";

export function createLinkedInOAuthRoutes(
  bundle: AuthBundle | null,
  opts: LinkedInOAuthModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const tenantBase = "/tenants/:tenantId/linkedin-oauth";

  if (!bundle) {
    app.post(`${tenantBase}/start`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tenants/:tenantId/channels/linkedin-oauth-info", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/linkedin/oauth/callback", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  const store: OAuthKvStore = createOAuthKvStore(opts.redisUrl, {
    namespace: "linkedin-oauth",
    ttlSeconds: OAUTH_TTL_SECONDS,
  });

  const webBase = (opts.publicBaseUrl ?? "").replace(/\/+$/, "");
  const redirectUri = `${webBase}/api/linkedin/oauth/callback`;

  /** Konfigurasi OAuth efektif (panel → env). */
  async function resolveLinkedInConfig() {
    const [publicConfig, clientSecret] = await Promise.all([
      getPlatformPublicConfig(bundle!.db, opts.platform),
      getProviderSecret(bundle!.db, "linkedin_client_secret", opts.platform),
    ]);
    const clientId = publicConfig.linkedin_client_id;
    return {
      clientId,
      clientSecret,
      available: Boolean(clientId) && Boolean(clientSecret),
    };
  }

  // -------------------------------------------------------------------------
  // Info ketersediaan connect (owner/admin) — dasar tombol di Channels.
  // -------------------------------------------------------------------------
  app.get("/tenants/:tenantId/channels/linkedin-oauth-info", async (c) => {
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
        "Only workspace owners and admins can view LinkedIn OAuth settings",
      );
    }
    const config = await resolveLinkedInConfig();
    const body = LinkedInOAuthInfoResponseSchema.parse({
      oauthRedirectUri: redirectUri,
      clientId: config.clientId,
      clientIdConfigured: Boolean(config.clientId),
      clientSecretConfigured: Boolean(config.clientSecret),
      available: config.available,
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Start: buat state sekali pakai + URL dialog authorize LinkedIn.
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
    const parsed = LinkedInOAuthStartRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid OAuth start payload");
    }
    if (!opts.stateSecret || !webBase) {
      return apiError(
        c,
        503,
        "LINKEDIN_OAUTH_NOT_CONFIGURED",
        "LinkedIn OAuth is not configured on this server",
      );
    }
    const config = await resolveLinkedInConfig();
    if (!config.available || !config.clientId) {
      return apiError(
        c,
        503,
        "LINKEDIN_OAUTH_NOT_CONFIGURED",
        "LinkedIn app credentials are not configured in the platform admin panel yet",
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
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: LINKEDIN_OAUTH_SCOPES,
      state,
    });
    const body = LinkedInOAuthStartResponseSchema.parse({
      dialogUrl: `${LINKEDIN_AUTHORIZE_BASE}/oauth/v2/authorization?${params.toString()}`,
      expiresAt: new Date(expSeconds * 1000).toISOString(),
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Callback TUNGGAL (publik; identitas dari state bertanda tangan).
  // Semua kegagalan → redirect error berkode TANPA membuat akun apa pun.
  // -------------------------------------------------------------------------
  app.get("/linkedin/oauth/callback", async (c) => {
    const fail = (code: string) =>
      c.redirect(`${webBase}/channels?linkedin_oauth_error=${code}`, 302);

    if (!opts.stateSecret || !webBase) {
      return fail("LINKEDIN_OAUTH_NOT_CONFIGURED");
    }
    // LinkedIn mengembalikan `error` bila user membatalkan/menolak izin.
    if (c.req.query("error")) return fail("LINKEDIN_OAUTH_CANCELLED");

    const stateRaw = c.req.query("state");
    const code = c.req.query("code");
    if (!stateRaw || !code) return fail("LINKEDIN_OAUTH_STATE_INVALID");
    const state = verifyOAuthState(opts.stateSecret, stateRaw);
    if (!state) return fail("LINKEDIN_OAUTH_STATE_INVALID");
    let consumed = false;
    try {
      consumed = await store.consumeNonce(state.nonce);
    } catch {
      consumed = false;
    }
    if (!consumed) return fail("LINKEDIN_OAUTH_STATE_INVALID");

    const config = await resolveLinkedInConfig();
    if (!config.clientId || !config.clientSecret) {
      return fail("LINKEDIN_OAUTH_NOT_CONFIGURED");
    }
    if (!opts.channelTokenSecret) return fail("LINKEDIN_OAUTH_NOT_CONFIGURED");

    // Tukar code → access token → profil OIDC. Profil WAJIB di sini
    // (sub adalah identitas akun — tanpa profil tidak ada akun yang
    // bisa dibuat, berbeda dari TikTok yang open_id-nya ikut token).
    let sub: string;
    let accessToken: string;
    let expiresInSeconds: number | null;
    let profileName: string | null = null;
    let pictureUrl: string | null = null;
    try {
      const client = new LinkedInClient({
        baseUrl: opts.linkedinApiBase,
        oauthBaseUrl: opts.linkedinOAuthBase,
      });
      const tokens = await client.exchangeLinkedInCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri,
      });
      accessToken = tokens.accessToken;
      expiresInSeconds = tokens.expiresInSeconds;
      const info = await client.getLinkedInUserInfo(tokens.accessToken);
      sub = info.sub;
      profileName = info.name;
      pictureUrl = info.pictureUrl;
    } catch (err) {
      const detail =
        err instanceof LinkedInApiError
          ? `${err.status}: ${err.description}`
          : "non-api error";
      console.error(`[linkedin-oauth] exchange/profil gagal (${detail})`);
      return fail("LINKEDIN_OAUTH_EXCHANGE_FAILED");
    }

    // Penjaga satu akun = satu koneksi (pola meta-oauth): aktif di
    // workspace lain → ditolak; TIDAK ada akun yang dibuat/diubah.
    const existing = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      "linkedin",
      sub,
    );
    const activeElsewhere = existing.find(
      (r) => r.tenantId !== state.tenantId && r.status !== "disconnected",
    );
    if (activeElsewhere) return fail("LINKEDIN_ACCOUNT_ALREADY_CONNECTED");

    const own = existing.find((r) => r.tenantId === state.tenantId);
    if (own && own.status === "connected") {
      // Sudah terhubung di workspace ini — idempoten seperti
      // Threads: kredensial yang ada TIDAK ditimpa; kedaluwarsa
      // ditangani lifecycle tandai-reconnect, bukan login ulang.
      return c.redirect(`${webBase}/channels?linkedin_oauth=connected`, 302);
    }

    const tokenExpiresAt =
      expiresInSeconds == null
        ? null
        : new Date(Date.now() + expiresInSeconds * 1000);
    let encryptedAccessToken: string;
    try {
      encryptedAccessToken = encryptChannelSecret(
        opts.channelTokenSecret,
        accessToken,
      );
    } catch {
      return fail("LINKEDIN_OAUTH_NOT_CONFIGURED");
    }

    let rowId: string;
    if (own) {
      // Revive baris yang sama dengan kredensial OAuth baru.
      const row = await updateLinkedInChannelAccountCredentials(
        bundle.db,
        { tenantId: state.tenantId },
        own.id,
        {
          encryptedAccessToken,
          profileName,
          status: "connected",
          tokenExpiresAt,
        },
      );
      if (!row) return fail("LINKEDIN_OAUTH_EXCHANGE_FAILED");
      rowId = row.id;
    } else {
      const row = await createLinkedInChannelAccount(
        bundle.db,
        { tenantId: state.tenantId, userId: state.userId },
        {
          accountExternalId: sub,
          profileName,
          encryptedAccessToken,
          tokenExpiresAt,
        },
      );
      rowId = row.id;
    }

    await recordChannelConnectedAudit(
      bundle.db,
      { tenantId: state.tenantId, userId: state.userId },
      { channelAccountId: rowId, provider: "linkedin", method: "oauth" },
    );

    // Foto profil: klaim `picture` OIDC diunduh & disimpan mengikuti
    // mekanisme avatar platform lain (profile_photos) — fail-soft
    // dengan batas lunak; kegagalan tidak menggagalkan connect.
    await awaitPhotoSoftDeadline(
      fetchAndStoreProfilePhotoFromUrl(bundle.db, {
        tenantId: state.tenantId,
        channelAccountId: rowId,
        pictureUrl,
      }),
    );

    return c.redirect(`${webBase}/channels?linkedin_oauth=connected`, 302);
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
