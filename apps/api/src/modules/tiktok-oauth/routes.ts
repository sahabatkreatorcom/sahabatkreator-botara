import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  TikTokOAuthInfoResponseSchema,
  TikTokOAuthStartRequestSchema,
  TikTokOAuthStartResponseSchema,
} from "@sahabat-kreator/contracts";
import {
  TIKTOK_AVATAR_R2_KEY_PREFIX,
  createTikTokChannelAccount,
  encryptChannelSecret,
  fetchAndStoreProfilePhotoFromUrl,
  getChannelAccount,
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
 * (±24 jam) + refresh token (±365 hari) + open_id → profil berjenjang
 * (user info `GET /v2/user/info/` lebih dulu; bila gagal, info
 * kreator posting dari `creator_info/query/`) untuk username/nama
 * tampil/avatar → akun channel `tiktok` disimpan (KEDUA token
 * TERENKRIPSI envelope CHANNEL_TOKEN_SECRET; external_id = open_id).
 * Sesudah itu
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
 *   Satu penanda peringatan khusus: bila user info ditolak provider
 *   KHUSUSNYA karena scope (`scope_not_authorized` — izin
 *   `user.info.basic`/Login Kit belum disetujui untuk aplikasi
 *   TikTok di portal developer) DAN cadangan creator_info juga
 *   tidak menghasilkan nama tampil, akun TETAP terhubung fail-soft
 *   tetapi kepulangannya `?tiktok_oauth=connected_profile_incomplete`
 *   agar Channels menampilkan banner peringatan yang jujur (nama &
 *   foto profil tidak terbaca + cara memperbaikinya), bukan sukses
 *   polos yang menyembunyikan akun tanpa nama. Bila creator_info
 *   berhasil, akun tampil normal dan tidak ada banner — sumber
 *   profil dicatat di log server tanpa token. Menghubungkan ulang
 *   mengisi profil yang kosong dari resolusi berjenjang terbaru
 *   (lihat cabang akun-sudah-terhubung di callback).
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

    // Tukar code → token + open_id → profil (username/nama/avatar).
    // Hanya label tahap + kode/pesan resmi provider yang dicatat;
    // code, token, dan secret TIDAK PERNAH dicatat. Profil dibaca
    // berjenjang oleh TikTokClient: user info Login Kit lebih dulu,
    // lalu creator_info posting (`video.publish`) sebagai cadangan.
    // Kedua sumber gagal TIDAK menggagalkan connect bila token
    // response sudah membawa open_id (identitas akun) — profil
    // menyusul kosong. Kegagalan user info KHUSUS scope
    // (`scope_not_authorized`) dicatat terpisah: bila profil hasil
    // akhirnya tetap tanpa nama, kepulangan membawa penanda
    // peringatan profil-belum-lengkap (lihat header modul).
    let openId: string;
    let accessToken: string;
    let refreshToken: string | null;
    let expiresInSeconds: number | null;
    let username: string | null = null;
    let displayName: string | null = null;
    let avatarUrl: string | null = null;
    let profileScopeDenied = false;
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
      const resolution = await client.getTikTokProfile(tokens.accessToken);
      if (resolution.profile) {
        username = resolution.profile.username;
        displayName = resolution.profile.displayName;
        avatarUrl = resolution.profile.avatarUrl;
      }
      profileScopeDenied =
        resolution.userInfoError?.providerCode === "scope_not_authorized";
      if (resolution.userInfoError) {
        const detail = `${resolution.userInfoError.providerCode || resolution.userInfoError.status}: ${resolution.userInfoError.description}`;
        if (resolution.profile?.source === "creator_info") {
          console.error(
            `[tiktok-oauth] user info gagal (${detail}) — profil dilengkapi dari creator_info`,
          );
        } else {
          const fallbackDetail = resolution.creatorInfoError
            ? `; creator_info juga gagal (${resolution.creatorInfoError.providerCode || resolution.creatorInfoError.status}: ${resolution.creatorInfoError.description})`
            : "; creator_info tidak memberi profil yang dapat dipakai";
          console.error(
            `[tiktok-oauth] user info gagal (${detail})${fallbackDetail} — lanjut tanpa profil`,
          );
        }
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

    // Kepulangan sukses: penanda peringatan profil-belum-lengkap
    // HANYA bila user info kali ini ditolak karena scope DAN akun
    // hasil akhirnya tetap tanpa nama tampil — kegagalan user info
    // karena alasan lain tetap sukses polos seperti sebelumnya.
    const successRedirect = (profileIncomplete: boolean) =>
      c.redirect(
        `${webBase}/channels?tiktok_oauth=${
          profileIncomplete ? "connected_profile_incomplete" : "connected"
        }`,
        302,
      );

    const own = existing.find((r) => r.tenantId === state.tenantId);
    if (own && own.status === "connected") {
      // Sudah terhubung di workspace ini — idempoten seperti
      // Threads: kredensial yang ada TIDAK ditimpa; token disegarkan
      // worker lifecycle, bukan oleh login ulang.
      //
      // SATU pengecualian yang disengaja: PROFIL yang masih kosong
      // dilengkapi dari resolusi profil berjenjang kali ini. Inilah
      // jalur perbaikan akun yang dulu terhubung saat user info
      // gagal (nama kosong + avatar placeholder): menghubungkan
      // ulang akun yang sama mengisi nama tampil (patch core hanya
      // mengisi yang kosong) + mengambil avatar — dari user info
      // bila scope-nya sudah disetujui, atau dari creator_info
      // posting yang tidak bergantung pada scope tersebut — tanpa
      // baris baru dan tanpa menyentuh kredensial tersimpan.
      let resultingDisplayName: string | null | undefined;
      if (displayName !== null || username !== null) {
        const row = await updateTikTokChannelAccountCredentials(
          bundle.db,
          { tenantId: state.tenantId },
          own.id,
          {
            publicHandle: username ?? undefined,
            profileName: displayName,
          },
        );
        if (row) resultingDisplayName = row.displayName;
      }
      if (avatarUrl) {
        await awaitPhotoSoftDeadline(
          fetchAndStoreProfilePhotoFromUrl(bundle.db, {
            tenantId: state.tenantId,
            channelAccountId: own.id,
            pictureUrl: avatarUrl,
            // Avatar TikTok disimpan ke R2 (fallback bytea selama
            // kredensial R2 panel belum terisi) — lihat core/avatars.
            r2: {
              platformOptions: opts.platform,
              keyPrefix: TIKTOK_AVATAR_R2_KEY_PREFIX,
            },
          }),
        );
      }
      if (resultingDisplayName === undefined) {
        // Resolusi profil kali ini tidak membawa profil sama sekali
        // (kedua sumber gagal): putuskan penanda peringatan dari
        // nama yang TERSIMPAN — akun yang namanya sudah terisi dari
        // connect sebelumnya tetap sukses polos.
        const stored = await getChannelAccount(
          bundle.db,
          { tenantId: state.tenantId },
          own.id,
        );
        resultingDisplayName = stored?.displayName ?? null;
      }
      return successRedirect(profileScopeDenied && !resultingDisplayName);
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
    let rowDisplayName: string | null;
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
      rowDisplayName = row.displayName;
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
      rowDisplayName = row.displayName;
    }

    await recordChannelConnectedAudit(
      bundle.db,
      { tenantId: state.tenantId, userId: state.userId },
      { channelAccountId: rowId, provider: "tiktok", method: "oauth" },
    );

    // Foto profil: URL avatar dari sumber profil yang berhasil
    // (user info atau creator_info) diunduh & disimpan mengikuti
    // mekanisme avatar platform lain (profile_photos) — fail-soft
    // dengan batas lunak; kegagalan tidak menggagalkan connect dan
    // backfill daftar channel mencoba lagi nanti. KHUSUS TikTok
    // bytenya ditulis ke Cloudflare R2 (keputusan pemilik 2026-11-12:
    // URL CDN TikTok bertanda tangan & kedaluwarsa), dengan fallback
    // bytea selama kredensial R2 di Panel Admin belum terisi.
    await awaitPhotoSoftDeadline(
      fetchAndStoreProfilePhotoFromUrl(bundle.db, {
        tenantId: state.tenantId,
        channelAccountId: rowId,
        pictureUrl: avatarUrl,
        r2: {
          platformOptions: opts.platform,
          keyPrefix: TIKTOK_AVATAR_R2_KEY_PREFIX,
        },
      }),
    );

    return successRedirect(profileScopeDenied && !rowDisplayName);
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
