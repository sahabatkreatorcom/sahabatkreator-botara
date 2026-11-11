import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  TikTokOAuthInfoResponseSchema,
  TikTokOAuthStartRequestSchema,
  TikTokOAuthStartResponseSchema,
} from "@sahabat-kreator/contracts";
import {
  createTikTokChannelAccount,
  encryptChannelSecret,
  fetchAndStoreProfilePhotoFromUrl,
  getPlatformPublicConfig,
  getProviderSecret,
  lookupChannelAccountsByProviderExternalId,
  recordChannelConnectedAudit,
  updateTikTokChannelAccountCredentials,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import { TikTokApiError, TikTokClient } from "@sahabat-kreator/channel-tiktok";
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
 * Modul TikTok OAuth Connect (gelombang Semua OAuth) — "Hubungkan
 * dengan TikTok" via Login Kit.
 *
 *   POST /tenants/:tenantId/tiktok-oauth/start               buat state + URL dialog
 *   GET  /tiktok/oauth/callback                              callback TUNGGAL platform (publik)
 *   GET  /tenants/:tenantId/channels/tiktok-oauth-info       ketersediaan connect (owner/admin)
 *
 * Alur resmi TikTok Login Kit: authorize di
 * `https://www.tiktok.com/v2/auth/authorize/` (client_key = Client
 * Key aplikasi platform, scope `user.info.basic` + `video.publish`)
 * → callback menukar code di `POST /v2/oauth/token/` → access token
 * (±24 jam) + refresh token (±365 hari) + open_id → user info
 * (`GET /v2/user/info/`) untuk username/nama tampil → akun channel
 * `tiktok` disimpan (KEDUA token TERENKRIPSI envelope
 * CHANNEL_TOKEN_SECRET; external_id = open_id). Sesudah itu
 * sasaran TikTok muncul otomatis di /posts lewat materialisasi
 * listPostTargets — akun dari connect ini berbentuk persis akun
 * Gelombang 4.
 *
 * Kepercayaan & kustodi (pola meta-oauth 7D / threads-oauth):
 * - `state` = payload bertanda tangan HMAC (tenantId, userId,
 *   nonce, exp ≤10 menit). Nonce diklaim saat start dan DIKONSUMSI
 *   atomik saat callback (sekali pakai — replay ditolak).
 * - Kredensial aplikasi diselesaikan panel → env PER REQUEST
 *   (tiktok_client_key publik via getPlatformPublicConfig;
 *   tiktok_client_secret via getProviderSecret). Belum terisi →
 *   info menjawab clientKeyConfigured/clientSecretConfigured=false
 *   dan start menjawab 503 TIKTOK_OAUTH_NOT_CONFIGURED — jujur,
 *   seperti Threads.
 * - Token TIDAK PERNAH masuk URL/browser/log: callback bekerja
 *   penuh di server dan hanya me-redirect browser dengan penanda
 *   hasil (`?tiktok_oauth=connected` / `?tiktok_oauth_error=<KODE>`).
 * - Access token yang berumur ±24 jam BUKAN masalah operator lagi:
 *   worker lifecycle menyegarkannya dari refresh token via grant
 *   `refresh_token` sebelum kedaluwarsa (lihat worker
 *   tiktok-token-lifecycle).
 *
 * Beda bentuk dari meta-oauth — SENGAJA: login TikTok selalu
 * menghasilkan TEPAT SATU akun (kreator pemberi izin), jadi tidak
 * ada sesi pemilih aset; callback langsung menghubungkan (pola
 * Threads/Google).
 */

export interface TikTokOAuthModuleOptions {
  /** Resolver Panel Admin: tiktok_client_key (publik) + tiktok_client_secret. */
  platform: PlatformSettingsOptions;
  /** Kunci envelope kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL TikTok API (env TIKTOK_API_BASE; default open.tiktokapis.com). */
  tiktokApiBase?: string;
  /** URL publik aplikasi (env BETTER_AUTH_URL) — dasar redirect URI & tujuan redirect browser. */
  publicBaseUrl?: string;
  /** Redis platform (env REDIS_URL) untuk nonce OAuth. */
  redisUrl?: string;
  /** Secret penandatangan state (env BETTER_AUTH_SECRET). */
  stateSecret?: string;
}

const OAUTH_TTL_SECONDS = 600;
const TIKTOK_AUTHORIZE_BASE = "https://www.tiktok.com";
/** Scope minimum: profil dasar + penerbitan content schedule. */
const TIKTOK_OAUTH_SCOPES = ["user.info.basic", "video.publish"] as const;

export function createTikTokOAuthRoutes(
  bundle: AuthBundle | null,
  opts: TikTokOAuthModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const tenantBase = "/tenants/:tenantId/tiktok-oauth";

  if (!bundle) {
    app.post(`${tenantBase}/start`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tenants/:tenantId/channels/tiktok-oauth-info", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tiktok/oauth/callback", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  const store: OAuthKvStore = createOAuthKvStore(opts.redisUrl, {
    namespace: "tiktok-oauth",
    ttlSeconds: OAUTH_TTL_SECONDS,
  });

  const webBase = (opts.publicBaseUrl ?? "").replace(/\/+$/, "");
  const redirectUri = `${webBase}/api/tiktok/oauth/callback`;

  /** Konfigurasi OAuth efektif (panel → env). */
  async function resolveTikTokConfig() {
    const [publicConfig, clientSecret] = await Promise.all([
      getPlatformPublicConfig(bundle!.db, opts.platform),
      getProviderSecret(bundle!.db, "tiktok_client_secret", opts.platform),
    ]);
    const clientKey = publicConfig.tiktok_client_key;
    return {
      clientKey,
      clientSecret,
      available: Boolean(clientKey) && Boolean(clientSecret),
    };
  }

  // -------------------------------------------------------------------------
  // Info ketersediaan connect (owner/admin) — dasar tombol di Channels.
  // -------------------------------------------------------------------------
  app.get("/tenants/:tenantId/channels/tiktok-oauth-info", async (c) => {
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
        "Only workspace owners and admins can view TikTok OAuth settings",
      );
    }
    const config = await resolveTikTokConfig();
    const body = TikTokOAuthInfoResponseSchema.parse({
      oauthRedirectUri: redirectUri,
      clientKey: config.clientKey,
      clientKeyConfigured: Boolean(config.clientKey),
      clientSecretConfigured: Boolean(config.clientSecret),
      available: config.available,
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Start: buat state sekali pakai + URL dialog authorize TikTok.
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
    const parsed = TikTokOAuthStartRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid OAuth start payload");
    }
    if (!opts.stateSecret || !webBase) {
      return apiError(
        c,
        503,
        "TIKTOK_OAUTH_NOT_CONFIGURED",
        "TikTok OAuth is not configured on this server",
      );
    }
    const config = await resolveTikTokConfig();
    if (!config.available || !config.clientKey) {
      return apiError(
        c,
        503,
        "TIKTOK_OAUTH_NOT_CONFIGURED",
        "TikTok app credentials are not configured in the platform admin panel yet",
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
      client_key: config.clientKey,
      scope: TIKTOK_OAUTH_SCOPES.join(","),
      response_type: "code",
      redirect_uri: redirectUri,
      state,
    });
    const body = TikTokOAuthStartResponseSchema.parse({
      dialogUrl: `${TIKTOK_AUTHORIZE_BASE}/v2/auth/authorize/?${params.toString()}`,
      expiresAt: new Date(expSeconds * 1000).toISOString(),
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Callback TUNGGAL (publik; identitas dari state bertanda tangan).
  // Semua kegagalan → redirect error berkode TANPA membuat akun apa pun.
  // -------------------------------------------------------------------------
  app.get("/tiktok/oauth/callback", async (c) => {
    const fail = (code: string) =>
      c.redirect(`${webBase}/channels?tiktok_oauth_error=${code}`, 302);

    if (!opts.stateSecret || !webBase) {
      return fail("TIKTOK_OAUTH_NOT_CONFIGURED");
    }
    // TikTok mengembalikan `error` bila user membatalkan/menolak izin.
    if (c.req.query("error")) return fail("TIKTOK_OAUTH_CANCELLED");

    const stateRaw = c.req.query("state");
    const code = c.req.query("code");
    if (!stateRaw || !code) return fail("TIKTOK_OAUTH_STATE_INVALID");
    const state = verifyOAuthState(opts.stateSecret, stateRaw);
    if (!state) return fail("TIKTOK_OAUTH_STATE_INVALID");
    let consumed = false;
    try {
      consumed = await store.consumeNonce(state.nonce);
    } catch {
      consumed = false;
    }
    if (!consumed) return fail("TIKTOK_OAUTH_STATE_INVALID");

    const config = await resolveTikTokConfig();
    if (!config.clientKey || !config.clientSecret) {
      return fail("TIKTOK_OAUTH_NOT_CONFIGURED");
    }
    if (!opts.channelTokenSecret) return fail("TIKTOK_OAUTH_NOT_CONFIGURED");

    // Tukar code → token + open_id → user info (username/nama).
    // Hanya label tahap + kode/pesan resmi provider yang dicatat;
    // code, token, dan secret TIDAK PERNAH dicatat. User info yang
    // gagal TIDAK menggagalkan connect bila token response sudah
    // membawa open_id (identitas akun) — profil menyusul kosong.
    let openId: string;
    let accessToken: string;
    let refreshToken: string | null;
    let expiresInSeconds: number | null;
    let username: string | null = null;
    let displayName: string | null = null;
    let avatarUrl: string | null = null;
    try {
      const client = new TikTokClient({ baseUrl: opts.tiktokApiBase });
      const tokens = await client.exchangeTikTokCode({
        clientKey: config.clientKey,
        clientSecret: config.clientSecret,
        code,
        redirectUri,
      });
      if (!tokens.openId) {
        throw new TikTokApiError(200, "", "missing_open_id");
      }
      openId = tokens.openId;
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
      expiresInSeconds = tokens.expiresInSeconds;
      try {
        const info = await client.getTikTokUserInfo(tokens.accessToken);
        username = info.username;
        displayName = info.displayName;
        avatarUrl = info.avatarUrl;
      } catch (infoErr) {
        const detail =
          infoErr instanceof TikTokApiError
            ? `${infoErr.providerCode || infoErr.status}: ${infoErr.description}`
            : "non-api error";
        console.error(`[tiktok-oauth] user info gagal (${detail}) — lanjut tanpa profil`);
      }
    } catch (err) {
      const detail =
        err instanceof TikTokApiError
          ? `${err.providerCode || err.status}: ${err.description}`
          : "non-api error";
      console.error(`[tiktok-oauth] exchange gagal (${detail})`);
      return fail("TIKTOK_OAUTH_EXCHANGE_FAILED");
    }

    // Penjaga satu akun = satu koneksi (pola meta-oauth): aktif di
    // workspace lain → ditolak; TIDAK ada akun yang dibuat/diubah.
    const existing = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      "tiktok",
      openId,
    );
    const activeElsewhere = existing.find(
      (r) => r.tenantId !== state.tenantId && r.status !== "disconnected",
    );
    if (activeElsewhere) return fail("TIKTOK_ACCOUNT_ALREADY_CONNECTED");

    const own = existing.find((r) => r.tenantId === state.tenantId);
    if (own && own.status === "connected") {
      // Sudah terhubung di workspace ini — idempoten seperti
      // Threads: kredensial yang ada TIDAK ditimpa; token disegarkan
      // worker lifecycle, bukan oleh login ulang.
      return c.redirect(`${webBase}/channels?tiktok_oauth=connected`, 302);
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
      return fail("TIKTOK_OAUTH_NOT_CONFIGURED");
    }

    let rowId: string;
    if (own) {
      // Revive baris yang sama dengan kredensial OAuth baru.
      const row = await updateTikTokChannelAccountCredentials(
        bundle.db,
        { tenantId: state.tenantId },
        own.id,
        {
          encryptedAccessToken,
          encryptedRefreshToken,
          publicHandle: username,
          profileName: displayName,
          status: "connected",
          tokenExpiresAt,
          tokenRefreshedAt: null,
        },
      );
      if (!row) return fail("TIKTOK_OAUTH_EXCHANGE_FAILED");
      rowId = row.id;
    } else {
      const row = await createTikTokChannelAccount(
        bundle.db,
        { tenantId: state.tenantId, userId: state.userId },
        {
          accountExternalId: openId,
          profileName: displayName,
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
      { channelAccountId: rowId, provider: "tiktok", method: "oauth" },
    );

    // Foto profil: `avatar_url` dari user info diunduh & disimpan
    // mengikuti mekanisme avatar platform lain (profile_photos) —
    // fail-soft dengan batas lunak; kegagalan tidak menggagalkan
    // connect dan backfill daftar channel mencoba lagi nanti.
    await awaitPhotoSoftDeadline(
      fetchAndStoreProfilePhotoFromUrl(bundle.db, {
        tenantId: state.tenantId,
        channelAccountId: rowId,
        pictureUrl: avatarUrl,
      }),
    );

    return c.redirect(`${webBase}/channels?tiktok_oauth=connected`, 302);
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
