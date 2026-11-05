import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  ChannelAccountResponseSchema,
  MetaOAuthCompleteRequestSchema,
  MetaOAuthCompleteResponseSchema,
  MetaOAuthInfoResponseSchema,
  MetaOAuthSessionResponseSchema,
  MetaOAuthStartRequestSchema,
  MetaOAuthStartResponseSchema,
  type ChannelAccountResponse,
  type MetaOAuthAsset,
  type MetaOAuthEmptyHint,
  type MetaOAuthProvider,
} from "@sahabat-kreator/contracts";
import {
  channelConfirmationName,
  channelPurgeAt,
  createMetaChannelAccount,
  createWhatsAppChannelAccount,
  decryptChannelSecret,
  encryptChannelSecret,
  getChannelAccount,
  getChannelHealthMap,
  getPlatformPublicConfig,
  getProviderSecret,
  IDLE_CHANNEL_HEALTH,
  listProfilePhotoOwnerIds,
  lookupChannelAccountsByProviderExternalId,
  recordChannelConnectedAudit,
  storeProfilePhoto,
  updateMetaChannelAccountCredentials,
  updateWhatsAppChannelAccountCredentials,
  type ChannelHealthInfo,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import {
  MetaGraphClient,
  MetaGraphError,
  type MetaDiscoveryTraceEntry,
  type MetaInstagramDiscoveryContext,
} from "@sahabat-kreator/channel-messenger";
import { WhatsAppCloudClient } from "@sahabat-kreator/channel-whatsapp";
import type { ChannelAccount } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { createOAuthKvStore, type OAuthKvStore } from "../../oauth-kv";
import { channelAvatarUrl } from "../avatars/routes";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul Meta OAuth Connect (Fase 7D) — "Lanjutkan dengan Facebook".
 *
 *   POST /tenants/:tenantId/meta-oauth/start                 buat state + URL dialog
 *   GET  /meta/oauth/callback                                callback TUNGGAL platform (publik)
 *   GET  /tenants/:tenantId/meta-oauth/sessions/:sessionId    aset hasil login (tanpa token)
 *   POST /tenants/:tenantId/meta-oauth/sessions/:sessionId/complete  hubungkan aset terpilih
 *   GET  /tenants/:tenantId/channels/meta-oauth-info         ketersediaan OAuth per provider
 *
 * Tiga rasa alur Meta di balik satu callback (dokumentasi resmi yang
 * terverifikasi; lihat docs/DEPLOY-STAGING.md Fase 7D):
 * - messenger — Facebook Login klasik: dialog membawa `scope`
 *   (pages_show_list, pages_messaging, pages_manage_metadata,
 *   business_management — yang terakhir agar tepi bisnis penemuan
 *   Page bisa dibaca, Hotfix R1; ditambah trio engagement
 *   pages_read_engagement/pages_read_user_content/
 *   pages_manage_engagement untuk fitur komentar Page, Fase 14B —
 *   rincian di komentar MESSENGER_OAUTH_SCOPES); code → user token →
 *   long-lived (fb_exchange_token) → rantai daftar Page. Token
 *   channel = Page Access Token turunan token long-lived per Page.
 * - instagram — Unified Login: dialog membawa `config_id` (BUKAN scope,
 *   BUKAN JS SDK); exchange code → Business Integration System User
 *   Access Token (SUAT); aset dari RANTAI penemuan multi-tepi
 *   (Fase 7D.3: assigned_instagram_accounts → IG-pada-Page →
 *   IG-milik-portofolio → per-Page; kandidat lewat Page membawa Page
 *   token-nya dan disimpan dengan token itu; fase penemuan SU
 *   menambah tepi IG-milik-node-bisnis-klien + target hibah
 *   debug_token khusus token System User); probe /me membedakan
 *   SUAT vs token user untuk petunjuk picker; `client_business_id`
 *   disimpan sebagai parent_external_id.
 * - whatsapp — Embedded Signup (Login for Business): dialog membawa
 *   `config_id`; exchange code → token bisnis; penemuan WABA ter-assign
 *   + nomor-nomornya DARI TOKEN di server (keputusan redirect-based —
 *   bukan event JS SDK WA_EMBEDDED_SIGNUP; lihat catatan di docs).
 *
 * Kepercayaan & kustodi:
 * - `state` = payload bertanda tangan HMAC (tenantId, provider, userId,
 *   nonce, exp ≤10 menit). Nonce diklaim saat start dan DIKONSUMSI
 *   atomik saat callback (sekali pakai — replay state ditolak).
 * - Token hasil exchange TIDAK PERNAH masuk URL/browser/log: ia hidup
 *   di "sesi OAuth" server-side (id opak, TTL ≤10 menit) yang isinya
 *   TERENKRIPSI envelope AES-256-GCM yang sama seperti kredensial
 *   channel (kunci env CHANNEL_TOKEN_SECRET).
 * - Penyimpanan nonce + sesi: Redis platform yang sudah ada (pola
 *   Fase 2A/6G) lewat @sahabat-kreator/queue; tanpa REDIS_URL jatuh ke
 *   Map in-memory proses ini (sesi hilang saat API restart — diterima
 *   & terdokumentasi; staging selalu punya Redis).
 * - App Secret untuk exchange diselesaikan panel → env per request
 *   (resolver Fase 7A.1). App ID & config ID identifier publik dari
 *   panel → env (Fase 7D, `getPlatformPublicConfig`).
 * - Semua panggilan Graph menghormati override META_API_BASE (mock uji)
 *   lewat opsi modul, persis klien Meta yang ada.
 */

export interface MetaOAuthModuleOptions {
  /** Resolver Panel Admin: App Secret (rahasia) + identifier publik Meta. */
  platform: PlatformSettingsOptions;
  /** Kunci envelope kredensial channel & sesi OAuth (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string;
  /** Versi Graph ter-pin (dari @sahabat-kreator/config). */
  graphApiVersion: string;
  /** URL publik aplikasi (env BETTER_AUTH_URL) — dasar redirect URI & tujuan redirect browser. */
  publicBaseUrl?: string;
  /** Redis platform (env REDIS_URL) untuk nonce + sesi OAuth. */
  redisUrl?: string;
  /** Secret penandatangan state (env BETTER_AUTH_SECRET). */
  stateSecret?: string;
  /**
   * Minta izin engagement Page di dialog Messenger (env
   * META_ENGAGEMENT_SCOPES). Default false — lihat catatan
   * MESSENGER_ENGAGEMENT_SCOPES: menyalakannya sebelum App Review
   * membuat dialog menjawab "Invalid Scopes" dan mematikan
   * onboarding Messenger.
   */
  engagementScopes?: boolean;
}

const OAUTH_TTL_SECONDS = 600;
const FACEBOOK_DIALOG_BASE = "https://www.facebook.com";
/**
 * Scope Messenger untuk dialog Facebook Login klasik kita.
 * - pages_show_list/pages_messaging/pages_manage_metadata: minimum
 *   terbukti untuk alur kita (daftar Page + kirim + subscribed_apps).
 * - business_management (Hotfix R1): WAJIB agar token bisa membaca
 *   tepi bisnis penemuan Page — /me/assigned_pages menolak dengan
 *   graph_10 dan /me/businesses dengan graph_100 tanpa izin ini
 *   (terbukti dari log percobaan live user 2026-11-03: hanya Page
 *   yang dikelola langsung yang muncul di pemilih; Page yang hanya
 *   terlihat lewat portofolio bisnis tidak pernah jadi kandidat).
 *   Izinnya SUDAH ditambahkan pemilik ke aplikasi Meta — dialog
 *   klasik hanya memberikan scope yang secara eksplisit diminta di
 *   parameter `scope`, jadi menambahkannya di sinilah perbaikannya.
 * - pages_read_engagement + pages_read_user_content +
 *   pages_manage_engagement (Fase 14B — inventaris izin dari kode
 *   untuk App Review): fitur komentar Page Fase 10B menerima event
 *   komentar lewat langganan field `feed`, membalas publik
 *   (`POST /{comment-id}/comments`) dan menyembunyikan
 *   (`POST /{comment-id}?is_hidden=`). Dokumentasi Pages API Meta
 *   menaruh ketiganya di izin engagement ini — TANPA diminta di
 *   dialog, token Page hasil OAuth tidak membawanya, jadi moderasi
 *   komentar untuk Page hasil "Lanjutkan dengan Facebook" akan
 *   ditolak Graph di luar mode dev (rantai uji lolos hanya karena
 *   mock tidak menegakkan izin).
 *
 *   ⚠️ KETIGANYA OPSIONAL DAN DEFAULT MATI. Fase 14B menambahkannya
 *   tanpa syarat, dan itu MEMATAHKAN onboarding Messenger untuk
 *   aplikasi yang belum lolos App Review: dialog menjawab "Konten
 *   ini tidak tersedia untuk saat ini / Invalid Scopes:
 *   pages_read_engagement, pages_read_user_content,
 *   pages_manage_engagement", sehingga koneksi Messenger baru tidak
 *   bisa dibuat sama sekali (terbukti live 2026-11-03). Izin ini
 *   hanya diminta bila env `META_ENGAGEMENT_SCOPES=1`, dipasang
 *   SETELAH App Review menyetujui ketiganya. Tanpa flag itu,
 *   moderasi komentar tetap berfungsi di mode pengembangan tetapi
 *   ditolak Graph untuk Page hasil OAuth biasa — kegagalan yang
 *   jujur dan tercatat, bukan dialog mati.
 *   Urutan lengkapnya di docs/APP-REVIEW.md §0.
 */
const MESSENGER_CORE_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "business_management",
] as const;

/** Izin komentar Page — hanya setelah Advanced Access disetujui. */
const MESSENGER_ENGAGEMENT_SCOPES = [
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_engagement",
] as const;

/**
 * Daftar scope dialog Messenger. Core selalu diminta; engagement hanya
 * bila `META_ENGAGEMENT_SCOPES` aktif (opsi modul `engagementScopes`).
 */
function messengerScopes(engagementScopes: boolean): string[] {
  return engagementScopes
    ? [...MESSENGER_CORE_SCOPES, ...MESSENGER_ENGAGEMENT_SCOPES]
    : [...MESSENGER_CORE_SCOPES];
}

// ---------------------------------------------------------------------------
// State bertanda tangan (HMAC-SHA256)
// ---------------------------------------------------------------------------

interface OAuthStatePayload {
  v: 1;
  tenantId: string;
  provider: MetaOAuthProvider;
  userId: string;
  nonce: string;
  /** Epoch detik kedaluwarsa. */
  exp: number;
}

function signOAuthState(secret: string, payload: OAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret).update(body).digest();
  return `${body}.${signature.toString("base64url")}`;
}

function verifyOAuthState(
  secret: string,
  state: string,
): OAuthStatePayload | null {
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const presented = Buffer.from(state.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as OAuthStatePayload;
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
  if (
    payload.provider !== "messenger" &&
    payload.provider !== "instagram" &&
    payload.provider !== "whatsapp"
  ) {
    return null;
  }
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Sesi OAuth (payload terenkripsi; token TIDAK PERNAH keluar server)
// ---------------------------------------------------------------------------

interface OAuthSessionData {
  tenantId: string;
  provider: MetaOAuthProvider;
  userId: string;
  assets: MetaOAuthAsset[];
  /**
   * Page Access Token per ID aset: Messenger per Page; Instagram
   * (Fase 7D.3) per akun IG yang ditemukan LEWAT sebuah Page — aset
   * itu disimpan dengan token Page-nya, bukan token alur.
   */
  pageTokens?: Record<string, string>;
  /** Instagram (SUAT) & WhatsApp (token bisnis): satu token semua aset. */
  accessToken?: string;
  /**
   * Umur token alur dari `expires_in` Graph (lifecycle 0010), detik —
   * null bila Graph tidak melaporkannya (disimpan sebagai tanpa expiry,
   * bukan ditebak). Token Page per aset TIDAK memakai ini (non-expiring).
   */
  accessTokenExpiresInSeconds?: number | null;
  /** Instagram: client_business_id portfolio klien (konteks induk). */
  clientBusinessId?: string | null;
  /**
   * Instagram (Fase 7D.3): petunjuk keadaan kosong picker, dihitung di
   * callback dari probe profil token + jejak penemuan. TANPA token —
   * aman hidup di sesi & tampil ke browser.
   */
  emptyHint?: MetaOAuthEmptyHint | null;
  /** Epoch milidetik kedaluwarsa sesi. */
  expiresAt: number;
}

/** Format jejak penemuan untuk satu baris log: `label=jumlah` / `label=ERR:kelas`. */
function formatDiscoveryTrace(trace: MetaDiscoveryTraceEntry[]): string {
  return trace
    .map((entry) =>
      entry.error
        ? `${entry.label}=ERR:${entry.error}`
        : `${entry.label}=${entry.count}`,
    )
    .join(" ");
}

// ---------------------------------------------------------------------------
// Serialisasi channel (pola modul channels — kesehatan + avatar)
// ---------------------------------------------------------------------------

function serializeChannelHealth(health: ChannelHealthInfo) {
  return {
    status: health.status,
    lastInboundAt: health.lastInboundAt?.toISOString() ?? null,
    lastInboundOutcome: health.lastInboundOutcome,
    lastDeliveredAt: health.lastDeliveredAt?.toISOString() ?? null,
    lastFailureAt: health.lastFailureAt?.toISOString() ?? null,
    lastFailureOutcome: health.lastFailureOutcome,
    lastFailureErrorCode: health.lastFailureErrorCode,
  };
}

async function serializeChannel(
  bundle: AuthBundle,
  row: ChannelAccount,
): Promise<ChannelAccountResponse> {
  const healthMap = await getChannelHealthMap(
    bundle.db,
    { tenantId: row.tenantId },
    [row],
  );
  const health = healthMap.get(row.id) ?? IDLE_CHANNEL_HEALTH;
  const withPhoto = await listProfilePhotoOwnerIds(
    bundle.db,
    { tenantId: row.tenantId },
    "channel_account",
    [row.id],
  );
  const purgeAt = channelPurgeAt(row);
  return ChannelAccountResponseSchema.parse({
    id: row.id,
    provider: row.provider,
    externalId: row.externalId,
    displayName: row.displayName,
    botUsername: row.botUsername,
    publicHandle: row.publicHandle,
    avatarUrl: withPhoto.has(row.id)
      ? channelAvatarUrl(row.tenantId, row.id)
      : null,
    status: row.status,
    health: serializeChannelHealth(health),
    confirmationName: channelConfirmationName(row),
    trashedAt: row.trashedAt?.toISOString() ?? null,
    purgeAt: purgeAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Modul
// ---------------------------------------------------------------------------

export function createMetaOAuthRoutes(
  bundle: AuthBundle | null,
  opts: MetaOAuthModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const tenantBase = "/tenants/:tenantId/meta-oauth";

  if (!bundle) {
    app.post(`${tenantBase}/start`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get(`${tenantBase}/sessions/:sessionId`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.post(`${tenantBase}/sessions/:sessionId/complete`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/tenants/:tenantId/channels/meta-oauth-info", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.get("/meta/oauth/callback", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  const store: OAuthKvStore = createOAuthKvStore(opts.redisUrl, {
    namespace: "meta-oauth",
    ttlSeconds: OAUTH_TTL_SECONDS,
  });

  const webBase = (opts.publicBaseUrl ?? "").replace(/\/+$/, "");
  const redirectUri = `${webBase}/api/meta/oauth/callback`;

  /** Konfigurasi OAuth efektif (panel → env) + ketersediaan per provider. */
  async function resolveOAuthConfig() {
    const [publicConfig, appSecret] = await Promise.all([
      getPlatformPublicConfig(bundle!.db, opts.platform),
      getProviderSecret(bundle!.db, "meta_app_secret", opts.platform),
    ]);
    const appId = publicConfig.meta_app_id;
    const igConfigId = publicConfig.meta_ig_config_id;
    const waConfigId = publicConfig.meta_wa_config_id;
    const baseReady = Boolean(appId) && Boolean(appSecret);
    return {
      appId,
      appSecret,
      igConfigId,
      waConfigId,
      available: {
        messenger: baseReady,
        instagram: baseReady && Boolean(igConfigId),
        whatsapp: baseReady && Boolean(waConfigId),
      } as Record<MetaOAuthProvider, boolean>,
    };
  }

  function graphClient(accessToken?: string): MetaGraphClient {
    return new MetaGraphClient({
      baseUrl: opts.metaApiBase,
      apiVersion: opts.graphApiVersion,
      accessToken,
    });
  }

  // -------------------------------------------------------------------------
  // Info ketersediaan OAuth (owner/admin) — dasar tombol di modal connect.
  // -------------------------------------------------------------------------
  app.get("/tenants/:tenantId/channels/meta-oauth-info", async (c) => {
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
        "Only workspace owners and admins can view Meta OAuth settings",
      );
    }
    const config = await resolveOAuthConfig();
    const body = MetaOAuthInfoResponseSchema.parse({
      oauthRedirectUri: redirectUri,
      appId: config.appId,
      appIdConfigured: Boolean(config.appId),
      appSecretConfigured: Boolean(config.appSecret),
      providers: {
        messenger: { available: config.available.messenger },
        instagram: {
          available: config.available.instagram,
          configId: config.igConfigId,
        },
        whatsapp: {
          available: config.available.whatsapp,
          configId: config.waConfigId,
        },
      },
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Start: buat state sekali pakai + URL dialog Meta.
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
    const parsed = MetaOAuthStartRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid OAuth start payload");
    }
    const provider = parsed.data.provider;
    if (!opts.stateSecret || !webBase) {
      return apiError(
        c,
        503,
        "META_OAUTH_NOT_CONFIGURED",
        "Meta OAuth is not configured on this server",
      );
    }
    const config = await resolveOAuthConfig();
    if (!config.available[provider] || !config.appId) {
      return apiError(
        c,
        503,
        "META_OAUTH_NOT_CONFIGURED",
        "Meta OAuth is not configured for this provider yet",
      );
    }

    const expSeconds = Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS;
    const payload: OAuthStatePayload = {
      v: 1,
      tenantId: tenant.id,
      provider,
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
      client_id: config.appId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    });
    let dialogUrl: string;
    if (provider === "messenger") {
      // Facebook Login klasik: scope di URL (asimetri terdokumentasi —
      // IG/WA memakai config_id, Messenger v1 kita memakai scope).
      // Engagement trio hanya ikut bila META_ENGAGEMENT_SCOPES aktif.
      params.set("scope", messengerScopes(opts.engagementScopes ?? false).join(","));
      dialogUrl = `${FACEBOOK_DIALOG_BASE}/${opts.graphApiVersion}/dialog/oauth?${params.toString()}`;
    } else {
      params.set(
        "config_id",
        provider === "instagram" ? config.igConfigId! : config.waConfigId!,
      );
      if (provider === "instagram") {
        // Unified Login (dokumen terverifikasi): prompt=login memaksa
        // dialog SELALU menampilkan pemilih akun, termasuk opsi login
        // Instagram — konfigurasi IG user berlabel Instagram Login
        // Compatible. Tanpa parameter ini, pengguna yang sudah login
        // Facebook diteruskan sebagai akun itu tanpa pilihan. WhatsApp
        // (Embedded Signup) SENGAJA tidak diubah.
        params.set("prompt", "login");
      }
      dialogUrl = `${FACEBOOK_DIALOG_BASE}/dialog/oauth?${params.toString()}`;
    }

    const body = MetaOAuthStartResponseSchema.parse({
      dialogUrl,
      expiresAt: new Date(expSeconds * 1000).toISOString(),
    });
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // Callback TUNGGAL (publik; identitas dari state bertanda tangan).
  // Semua kegagalan → redirect error berkode TANPA membuat state apa pun.
  // -------------------------------------------------------------------------
  app.get("/meta/oauth/callback", async (c) => {
    const fail = (code: string) =>
      c.redirect(`${webBase}/channels?meta_oauth_error=${code}`, 302);

    if (!opts.stateSecret || !webBase) return fail("META_OAUTH_NOT_CONFIGURED");
    // Meta mengembalikan `error` bila user membatalkan/menolak izin.
    if (c.req.query("error")) return fail("META_OAUTH_CANCELLED");

    const stateRaw = c.req.query("state");
    const code = c.req.query("code");
    if (!stateRaw || !code) return fail("META_OAUTH_STATE_INVALID");
    const state = verifyOAuthState(opts.stateSecret, stateRaw);
    if (!state) return fail("META_OAUTH_STATE_INVALID");
    let consumed = false;
    try {
      consumed = await store.consumeNonce(state.nonce);
    } catch {
      consumed = false;
    }
    if (!consumed) return fail("META_OAUTH_STATE_INVALID");

    const config = await resolveOAuthConfig();
    if (!config.appId || !config.appSecret) {
      return fail("META_OAUTH_NOT_CONFIGURED");
    }
    if (!opts.channelTokenSecret) return fail("META_OAUTH_NOT_CONFIGURED");

    const anon = graphClient();
    const credentials = {
      clientId: config.appId,
      clientSecret: config.appSecret,
    };

    let session: OAuthSessionData;
    try {
      if (state.provider === "messenger") {
        const short = await anon.exchangeOAuthCode({
          ...credentials,
          code,
          redirectUri,
        });
        const longLived = await anon.exchangeLongLivedToken({
          ...credentials,
          shortLivedToken: short.accessToken,
        });
        // Daftar Page lewat rantai yang sama seperti penemuan IG
        // (Fase 7D.3): /me/accounts → assigned_pages → businesses +
        // pengisian token. Untuk token user klasik hasil /me/accounts
        // dipertahankan persis (kemunculan pertama menang) — rantai
        // hanya menemukan Page tambahan untuk token bisnis.
        // Hotfix R1: kandidat diambil UTUH (listPageCandidates), bukan
        // disaring bertoken seperti getManagedPages dulu — Page yang
        // ditemukan tetapi tokennya tidak berhasil diisi TETAP masuk
        // pemilih sebagai aset nonaktif beralasan
        // (connectable=false), tidak hilang diam-diam.
        const pageTrace: MetaDiscoveryTraceEntry[] = [];
        const pages = await graphClient(longLived.accessToken).listPageCandidates(
          pageTrace,
        );
        const connectableCount = pages.filter((p) => p.accessToken).length;
        console.log(
          `[meta-oauth] discovery provider=messenger ${formatDiscoveryTrace(pageTrace)} total=${pages.length} connectable=${connectableCount}`,
        );
        const pageTokens: Record<string, string> = {};
        const assets: MetaOAuthAsset[] = pages.map((page) => {
          if (page.accessToken) pageTokens[page.id] = page.accessToken;
          return {
            assetId: page.id,
            kind: "page" as const,
            name: page.name,
            handle: page.username,
            parentId: null,
            parentName: null,
            linkedIgUsername: page.linkedIg?.username ?? null,
            connectable: Boolean(page.accessToken),
            unavailableReason: page.accessToken
              ? null
              : ("missing_page_token" as const),
          };
        });
        session = {
          tenantId: state.tenantId,
          provider: "messenger",
          userId: state.userId,
          assets,
          pageTokens,
          expiresAt: Date.now() + OAUTH_TTL_SECONDS * 1000,
        };
      } else if (state.provider === "instagram") {
        // Unified Login: exchange DENGAN redirect_uri yang identik dengan
        // dialog (Hotfix 7D.2 — asumsi 7D "config-flow tanpa redirect_uri"
        // GUGUR oleh bukti live: Graph menolak code dengan error 100
        // "Error validating verification code" bila redirect_uri absen).
        const suat = await anon.exchangeOAuthCode({
          ...credentials,
          code,
          redirectUri,
        });
        // Lifecycle 0010: umur token BISU dari `expires_in` Graph —
        // jadwal kedaluwarsa + refresh harian `tbft` berbasis ini.
        const flowTokenExpiresInSeconds = suat.expiresInSeconds;
        const client = graphClient(suat.accessToken);
        // Probe profil token (Fase 7D.3, best-effort): client_business_id
        // yang terisi = token System User (BISU); kosong = token user.
        // Dipakai untuk konteks induk + petunjuk keadaan kosong picker.
        let tokenProfile: {
          id: string | null;
          clientBusinessId: string | null;
        } | null = null;
        try {
          tokenProfile = await client.getTokenProfile();
        } catch {
          tokenProfile = null;
        }
        const clientBusinessId = tokenProfile?.clientBusinessId ?? null;
        // RANTAI PENEMUAN multi-tepi (Fase 7D.3) menggantikan union
        // /me + /{business}/assigned_instagram_accounts rancangan awal
        // fase ini (tepi bisnis lama tercakup semangatnya oleh tepi
        // (c) businesses_instagram_accounts): assigned → IG-pada-Page
        // → IG-milik-portofolio → per-Page, dedupe by ID akun IG.
        // Kandidat yang ditemukan lewat Page membawa Page token-nya —
        // disimpan per aset di pageTokens dan dipakai saat complete.
        // Fase penemuan SU: bila probe profil menandai token System
        // User (client_business_id terisi), rantai menambah dua tepi
        // berjangkar portofolio SETELAH (c) dan SEBELUM (d) —
        // (e) IG milik node bisnis klien dan (f) target hibah
        // konfigurasi dari debug_token — karena bagi SU kedua tepi
        // /me memang kosong/galat secara desain. Konteks membawa
        // kredensial aplikasi untuk debug_token dan menerima kembali
        // JUMLAH target hibah (grants) untuk baris log; id target
        // tidak pernah meninggalkan klien.
        const trace: MetaDiscoveryTraceEntry[] = [];
        const discoveryContext: MetaInstagramDiscoveryContext = {
          clientBusinessId,
          appId: config.appId,
          appSecret: config.appSecret,
          grantTargetCount: 0,
        };
        const candidates = await client.discoverInstagramAccounts(
          trace,
          discoveryContext,
        );
        const pageTokens: Record<string, string> = {};
        const assets: MetaOAuthAsset[] = candidates.map((candidate) => {
          if (candidate.pageAccessToken) {
            pageTokens[candidate.id] = candidate.pageAccessToken;
          }
          return {
            assetId: candidate.id,
            kind: "instagram_account" as const,
            name: null,
            handle: candidate.username,
            parentId: clientBusinessId,
            parentName: null,
            linkedIgUsername: null,
            connectable: true,
            unavailableReason: null,
          };
        });
        console.log(
          `[meta-oauth] discovery provider=instagram ${formatDiscoveryTrace(trace)} total=${assets.length} grants=${discoveryContext.grantTargetCount} token=${
            tokenProfile === null
              ? "unknown"
              : clientBusinessId
                ? "system_user"
                : "user"
          }`,
        );
        // Petunjuk keadaan kosong (Fase 7D.3): hanya saat tak ada aset.
        // Prioritas: error izin tepi portofolio paling bisa ditindak;
        // lalu jenis token; terakhir SUAT-sah-namun-kosong.
        let emptyHint: MetaOAuthEmptyHint | null = null;
        if (assets.length === 0) {
          const businessEdge = trace.find(
            (entry) => entry.label === "businesses_instagram_accounts",
          );
          if (
            businessEdge?.error === "graph_200" ||
            businessEdge?.error === "graph_10"
          ) {
            emptyHint = "business_permission_missing";
          } else if (tokenProfile !== null && !clientBusinessId) {
            emptyHint = "not_system_user";
          } else if (tokenProfile !== null && clientBusinessId) {
            emptyHint = "no_accounts_shared";
          }
        }
        session = {
          tenantId: state.tenantId,
          provider: "instagram",
          userId: state.userId,
          assets,
          pageTokens:
            Object.keys(pageTokens).length > 0 ? pageTokens : undefined,
          accessToken: suat.accessToken,
          accessTokenExpiresInSeconds: flowTokenExpiresInSeconds,
          clientBusinessId,
          emptyHint,
          expiresAt: Date.now() + OAUTH_TTL_SECONDS * 1000,
        };
      } else {
        // WhatsApp Embedded Signup: token bisnis → WABA ter-assign →
        // nomor per WABA (penemuan di server, bukan event JS SDK).
        // Exchange membawa redirect_uri yang sama seperti Messenger &
        // Instagram (Hotfix 7D.2 — dialog ketiganya ber-redirect_uri,
        // jadi penukarannya pun wajib identik).
        const businessToken = await anon.exchangeOAuthCode({
          ...credentials,
          code,
          redirectUri,
        });
        const client = graphClient(businessToken.accessToken);
        const wabas = await client.getAssignedWhatsAppBusinessAccounts();
        const assets: MetaOAuthAsset[] = [];
        for (const waba of wabas.slice(0, 25)) {
          const numbers = await client.getWabaPhoneNumbers(waba.id);
          for (const number of numbers) {
            assets.push({
              assetId: number.id,
              kind: "whatsapp_number" as const,
              name: number.verifiedName,
              handle: number.displayPhoneNumber,
              parentId: waba.id,
              parentName: waba.name,
              linkedIgUsername: null,
              connectable: true,
              unavailableReason: null,
            });
          }
        }
        // Instrumentasi jumlah (Fase 7D.3, pola yang sama seperti
        // Instagram): me = jumlah WABA dari tepi /me; business = null
        // karena discovery WhatsApp memang tidak memakai tepi bisnis;
        // total = jumlah aset nomor yang bisa dipilih.
        console.log(
          `[meta-oauth] discovery provider=whatsapp me=${wabas.length} business=null total=${assets.length}`,
        );
        session = {
          tenantId: state.tenantId,
          provider: "whatsapp",
          userId: state.userId,
          assets,
          accessToken: businessToken.accessToken,
          accessTokenExpiresInSeconds: businessToken.expiresInSeconds,
          expiresAt: Date.now() + OAUTH_TTL_SECONDS * 1000,
        };
      }
    } catch (err) {
      // Hanya label tahap + kode/subkode/pesan resmi Graph yang dicatat
      // (Hotfix 7D.2: pesan + subcode membuat kegagalan berikutnya bisa
      // didiagnosis dari log saja). Auth code, token, dan secret TIDAK
      // PERNAH dicatat — pesan resmi Graph tidak memuat ketiganya.
      const detail =
        err instanceof MetaGraphError
          ? `graph ${err.graphCode ?? err.status}` +
            (err.graphSubcode !== null
              ? ` subcode ${err.graphSubcode}`
              : "") +
            `: ${err.description}`
          : "non-graph error";
      console.error(
        `[meta-oauth] exchange/discovery gagal (provider ${state.provider}) ${detail}`,
      );
      return fail("META_OAUTH_EXCHANGE_FAILED");
    }

    const sessionId = randomBytes(24).toString("base64url");
    try {
      const encrypted = encryptChannelSecret(
        opts.channelTokenSecret,
        JSON.stringify(session),
      );
      await store.putSession(sessionId, encrypted);
    } catch {
      return fail("META_OAUTH_EXCHANGE_FAILED");
    }
    return c.redirect(`${webBase}/channels?meta_oauth=${sessionId}`, 302);
  });

  // -------------------------------------------------------------------------
  // Sesi OAuth: baca aset (tanpa token) & complete.
  // -------------------------------------------------------------------------

  async function loadSession(
    sessionId: string,
    tenantId: string,
  ): Promise<OAuthSessionData | null> {
    if (!opts.channelTokenSecret) return null;
    let encrypted: string | null;
    try {
      encrypted = await store.getSession(sessionId);
    } catch {
      return null;
    }
    if (!encrypted) return null;
    const plain = decryptChannelSecret(opts.channelTokenSecret, encrypted);
    if (!plain) return null;
    let data: OAuthSessionData;
    try {
      data = JSON.parse(plain) as OAuthSessionData;
    } catch {
      return null;
    }
    if (data.tenantId !== tenantId) return null;
    if (typeof data.expiresAt !== "number" || data.expiresAt <= Date.now()) {
      return null;
    }
    return data;
  }

  app.get(`${tenantBase}/sessions/:sessionId`, async (c) => {
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
    const sessionId = c.req.param("sessionId");
    const session = await loadSession(sessionId, tenant.id);
    if (!session) {
      return apiError(
        c,
        404,
        "META_OAUTH_SESSION_NOT_FOUND",
        "OAuth session not found or expired",
      );
    }
    const body = MetaOAuthSessionResponseSchema.parse({
      sessionId,
      provider: session.provider,
      assets: session.assets,
      emptyHint: session.emptyHint ?? null,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
    return c.json(body);
  });

  app.post(`${tenantBase}/sessions/:sessionId/complete`, async (c) => {
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
    const parsed = MetaOAuthCompleteRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid OAuth complete payload");
    }
    if (!opts.channelTokenSecret) {
      return apiError(c, 503, "INTERNAL_ERROR", "Meta is not configured");
    }
    const sessionId = c.req.param("sessionId");
    const session = await loadSession(sessionId, tenant.id);
    if (!session) {
      return apiError(
        c,
        404,
        "META_OAUTH_SESSION_NOT_FOUND",
        "OAuth session not found or expired",
      );
    }
    const asset = session.assets.find((a) => a.assetId === parsed.data.assetId);
    if (!asset) {
      return apiError(
        c,
        422,
        "META_OAUTH_ASSET_NOT_FOUND",
        "The selected asset is not part of this OAuth session",
      );
    }
    // Hotfix R1: aset yang ditampilkan nonaktif di pemilih (Page tanpa
    // Page Access Token yang dapat dipakai) ditolak eksplisit di sini
    // juga — UI menonaktifkan tombolnya, tetapi API tidak bergantung
    // pada UI untuk penjagaan ini. Sesi TIDAK dikonsumsi.
    if (asset.connectable === false) {
      return apiError(
        c,
        422,
        "META_OAUTH_ASSET_NOT_CONNECTABLE",
        "This Page was found but Meta did not provide a Page access token for it, so it cannot be connected",
      );
    }
    const provider = session.provider;
    // Token per aset menang atas token alur: Messenger per Page;
    // Instagram untuk kandidat yang ditemukan lewat Page (Fase 7D.3);
    // WhatsApp & kandidat IG lain jatuh ke token alur sesi.
    const accessToken =
      session.pageTokens?.[asset.assetId] ?? session.accessToken;
    if (!accessToken) {
      return apiError(
        c,
        422,
        "META_OAUTH_ASSET_NOT_FOUND",
        "No credential is stored for the selected asset",
      );
    }
    // Lifecycle 0010: varian + jadwal kedaluwarsa token yang DISIMPAN.
    // - Token Page per aset (Messenger & kandidat IG lewat Page):
    //   page_access_token, non-expiring.
    // - Token alur Unified Login (SUAT/BISU): system_user_token,
    //   kedaluwarsa dari `expires_in` Graph (null = tanpa laporan —
    //   disimpan jujur sebagai tanpa expiry, bukan ditebak).
    // - Token alur WhatsApp Embedded Signup: business_token, sama.
    const usingPageToken = Boolean(session.pageTokens?.[asset.assetId]);
    const storedTokenType: "page_access_token" | "system_user_token" | "business_token" =
      usingPageToken
        ? "page_access_token"
        : provider === "instagram"
          ? "system_user_token"
          : "business_token";
    const storedTokenExpiresAt =
      usingPageToken || session.accessTokenExpiresInSeconds == null
        ? null
        : new Date(Date.now() + session.accessTokenExpiresInSeconds * 1000);

    // Penjaga satu akun = satu koneksi (pola connect manual 7A/7B):
    // aktif di workspace lain → 409; sesi TIDAK dikonsumsi agar pemilik
    // bisa memilih aset lain dari sesi yang sama.
    const existing = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      provider,
      asset.assetId,
    );
    const activeElsewhere = existing.find(
      (r) => r.tenantId !== tenant.id && r.status !== "disconnected",
    );
    if (activeElsewhere) {
      return apiError(
        c,
        409,
        "META_ACCOUNT_ALREADY_CONNECTED",
        "This Meta account is already connected to another workspace",
      );
    }

    let encryptedAccessToken: string;
    try {
      encryptedAccessToken = encryptChannelSecret(
        opts.channelTokenSecret,
        accessToken,
      );
    } catch {
      return apiError(
        c,
        503,
        "INTERNAL_ERROR",
        "Channel credential encryption is not configured",
      );
    }

    const own = existing.find((r) => r.tenantId === tenant.id);
    let row: ChannelAccount | null = null;
    let created = false;

    if (own && own.status !== "connected") {
      // Revive baris yang sama dengan kredensial OAuth baru (pola manual).
      if (provider === "whatsapp") {
        row = await updateWhatsAppChannelAccountCredentials(
          bundle.db,
          { tenantId: tenant.id },
          own.id,
          {
            encryptedAccessToken,
            wabaId: asset.parentId ?? undefined,
            displayPhoneNumber: asset.handle,
            verifiedName: asset.name,
            status: "connected",
            // Lifecycle 0010: revive dengan varian + jadwal token baru.
            tokenType: storedTokenType,
            tokenExpiresAt: storedTokenExpiresAt,
            tokenRefreshedAt: null,
          },
        );
      } else {
        row = await updateMetaChannelAccountCredentials(
          bundle.db,
          { tenantId: tenant.id },
          own.id,
          {
            encryptedAccessToken,
            publicHandle: asset.handle,
            graphName: asset.name,
            parentExternalId:
              provider === "instagram"
                ? (session.clientBusinessId ?? asset.parentId)
                : undefined,
            status: "connected",
            // Lifecycle 0010: revive dengan varian + jadwal token baru.
            tokenType: storedTokenType,
            tokenExpiresAt: storedTokenExpiresAt,
            tokenRefreshedAt: null,
          },
        );
      }
    } else if (own) {
      // Sudah connected di workspace ini — idempoten seperti connect
      // manual: kembalikan akun yang ada (kredensial tidak ditimpa).
      row = await getChannelAccount(bundle.db, { tenantId: tenant.id }, own.id);
    } else if (provider === "messenger") {
      row = await createMetaChannelAccount(
        bundle.db,
        { tenantId: tenant.id, userId: appUser.id },
        {
          provider: "messenger",
          accountExternalId: asset.assetId,
          graphName: asset.name,
          publicHandle: asset.handle,
          encryptedAccessToken,
          graphApiVersion: opts.graphApiVersion,
          // Lifecycle 0010: Page token Facebook Login, non-expiring.
          tokenType: storedTokenType,
          tokenExpiresAt: storedTokenExpiresAt,
        },
      );
      created = true;
    } else if (provider === "instagram") {
      // Nama akun IG diambil best-effort dengan SUAT (pemilih hanya
      // membawa username); kegagalan tidak menggagalkan koneksi.
      let graphName = asset.name;
      if (!graphName) {
        try {
          const profile = await graphClient(accessToken).getObjectProfile(
            asset.assetId,
          );
          graphName = profile.name;
        } catch {
          graphName = null;
        }
      }
      row = await createMetaChannelAccount(
        bundle.db,
        { tenantId: tenant.id, userId: appUser.id },
        {
          provider: "instagram",
          accountExternalId: asset.assetId,
          graphName,
          publicHandle: asset.handle,
          encryptedAccessToken,
          graphApiVersion: opts.graphApiVersion,
          parentExternalId: session.clientBusinessId ?? asset.parentId,
          // Lifecycle 0010: Page token (lewat Page) atau SUAT BISU
          // ber-kedaluwarsa (token alur Unified Login).
          tokenType: storedTokenType,
          tokenExpiresAt: storedTokenExpiresAt,
        },
      );
      created = true;
    } else {
      row = await createWhatsAppChannelAccount(
        bundle.db,
        { tenantId: tenant.id, userId: appUser.id },
        {
          phoneNumberId: asset.assetId,
          wabaId: asset.parentId ?? "",
          verifiedName: asset.name,
          displayPhoneNumber: asset.handle,
          encryptedAccessToken,
          graphApiVersion: opts.graphApiVersion,
          // Lifecycle 0010: token bisnis Embedded Signup + jadwalnya.
          tokenType: storedTokenType,
          tokenExpiresAt: storedTokenExpiresAt,
        },
      );
      created = true;
    }

    if (!row) {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }

    // Auto-subscribe webhook: kegagalan TIDAK menggagalkan koneksi
    // (token & akun valid) — dilaporkan sebagai peringatan berkode.
    const warnings: Array<"META_SUBSCRIBE_FAILED"> = [];
    try {
      const client = graphClient(accessToken);
      if (provider === "messenger") {
        // Fase 10B: sertakan field komentar (feed) — helper mundur ke
        // messages saja bila Graph menolak field lebar.
        await client.subscribeAppToObjectWithComments(asset.assetId, "messenger");
      } else if (provider === "instagram") {
        await client.subscribeAppToObjectWithComments(asset.assetId, "instagram");
      } else {
        if (!asset.parentId) throw new MetaGraphError(0, null, "missing_waba");
        await client.subscribeAppToObject(asset.parentId);
      }
    } catch {
      warnings.push("META_SUBSCRIBE_FAILED");
    }

    await recordChannelConnectedAudit(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      { channelAccountId: row.id, provider, method: "oauth" },
    );

    // Foto profil best-effort (pola 6D/7A/7B) — tidak menggagalkan.
    // Hotfix R1: DI-AWAIT (batas lunak) sebelum serialisasi, dengan
    // permukaan per provider, agar respons complete langsung memuat
    // avatarUrl akun baru.
    await fetchOAuthAccountPhoto(bundle, opts, {
      tenantId: tenant.id,
      channelAccountId: row.id,
      provider,
      externalId: asset.assetId,
      accessToken,
    });

    // Sesi dikonsumsi setelah complete berhasil.
    try {
      await store.deleteSession(sessionId);
    } catch {
      /* sesi kedaluwarsa sendiri ≤10 menit — penghapusan best-effort */
    }

    const body = MetaOAuthCompleteResponseSchema.parse({
      channel: await serializeChannel(bundle, row),
      warnings,
    });
    return c.json(body, created ? 201 : 200);
  });

  return app;
}

/** Batas lunak menunggu foto profil pada complete OAuth (Hotfix R1). */
const OAUTH_PHOTO_SOFT_DEADLINE_MS = 6_000;

/**
 * Ambil & simpan foto profil akun hasil OAuth (best-effort — pola
 * pengambilan foto Fase 7A): Page/akun IG lewat MetaGraphClient
 * dengan permukaan per provider (Hotfix R1: Page /picture, akun IG
 * profile_picture_url — /picture tidak bekerja untuk akun IG),
 * bisnis WhatsApp lewat WhatsAppCloudClient. Kini DI-AWAIT dengan
 * batas lunak sebelum respons complete diserialkan, agar avatarUrl
 * langsung termuat; lewat batas itu koneksi tetap selesai dan foto
 * menyusul lewat backfill daftar channel. Kegagalan foto tidak
 * pernah menggagalkan koneksi.
 */
async function fetchOAuthAccountPhoto(
  bundle: AuthBundle,
  opts: MetaOAuthModuleOptions,
  input: {
    tenantId: string;
    channelAccountId: string;
    provider: MetaOAuthProvider;
    externalId: string;
    accessToken: string;
  },
): Promise<void> {
  const work = (async () => {
    try {
      let picture: { data: Buffer; contentType: string } | null = null;
      if (input.provider === "whatsapp") {
        const client = new WhatsAppCloudClient({
          baseUrl: opts.metaApiBase,
          apiVersion: opts.graphApiVersion,
          accessToken: input.accessToken,
        });
        picture = await client.getBusinessProfilePicture(input.externalId);
      } else {
        const client = new MetaGraphClient({
          baseUrl: opts.metaApiBase,
          apiVersion: opts.graphApiVersion,
          accessToken: input.accessToken,
        });
        picture = await client.getChannelProfilePicture(
          input.provider,
          input.externalId,
        );
      }
      if (!picture) return;
      await storeProfilePhoto(bundle.db, { tenantId: input.tenantId }, {
        ownerType: "channel_account",
        ownerId: input.channelAccountId,
        contentType: picture.contentType,
        data: picture.data,
      });
    } catch {
      console.error(
        `[meta-oauth] pengambilan foto profil akun ${input.channelAccountId} gagal`,
      );
    }
  })();
  await Promise.race([
    work,
    new Promise<void>((resolve) =>
      setTimeout(resolve, OAUTH_PHOTO_SOFT_DEADLINE_MS),
    ),
  ]);
}
