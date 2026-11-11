import { Hono } from "hono";
import { z } from "zod";
import {
  ChannelAccountListResponseSchema,
  ChannelAccountResponseSchema,
  CreateChannelRequestSchema,
  MetaWebhookInfoResponseSchema,
  TrashChannelRequestSchema,
  type ChannelAccountResponse,
} from "@sahabat-kreator/contracts";
import {
  channelConfirmationName,
  channelPurgeAt,
  createMetaChannelAccount,
  createTelegramChannelAccount,
  createWebchatChannelAccount,
  createWhatsAppChannelAccount,
  decryptChannelSecret,
  disconnectChannelAccount,
  encryptChannelSecret,
  exportChannelAccount,
  fetchAndStoreProfilePhotoFromUrl,
  fetchAndStoreTelegramProfilePhoto,
  generateChannelWebhookSecret,
  getChannelAccount,
  getChannelHealthMap,
  IDLE_CHANNEL_HEALTH,
  hashChannelWebhookSecret,
  listChannelAccounts,
  listProfilePhotoOwnerIds,
  listTrashedChannelAccounts,
  lookupChannelAccountsByProviderExternalId,
  markChannelAccountTrashed,
  restoreChannelAccount,
  setChannelAccountStatus,
  storeProfilePhoto,
  updateMetaChannelAccountCredentials,
  updateTelegramChannelAccountCredentials,
  updateWhatsAppChannelAccountCredentials,
  type ChannelHealthInfo,
  type MetaProvider,
} from "@sahabat-kreator/core";
import {
  TelegramApiError,
  TelegramBotApiClient,
} from "@sahabat-kreator/channel-telegram";
import {
  MetaGraphClient,
  MetaGraphError,
  ThreadsGraphClient,
} from "@sahabat-kreator/channel-messenger";
import { TikTokClient } from "@sahabat-kreator/channel-tiktok";
import {
  WhatsAppCloudClient,
  WhatsAppGraphError,
} from "@sahabat-kreator/channel-whatsapp";
import { META_GRAPH_API_VERSION } from "@sahabat-kreator/config";
import type { ChannelAccount } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { channelAvatarUrl } from "../avatars/routes";
import { resolveTenantForUser } from "../tenants/guard";

/** Kesehatan core → bentuk kontrak (waktu ISO; outcome apa adanya). */
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

export function serializeChannel(
  row: ChannelAccount,
  avatarUrl: string | null = null,
  health: ChannelHealthInfo = IDLE_CHANNEL_HEALTH,
): ChannelAccountResponse {
  const purgeAt = channelPurgeAt(row);
  return ChannelAccountResponseSchema.parse({
    id: row.id,
    provider: row.provider,
    externalId: row.externalId,
    displayName: row.displayName,
    botUsername: row.botUsername,
    publicHandle: row.publicHandle,
    avatarUrl,
    status: row.status,
    health: serializeChannelHealth(health),
    confirmationName: channelConfirmationName(row),
    trashedAt: row.trashedAt?.toISOString() ?? null,
    purgeAt: purgeAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Serialisasi satu akun lengkap dengan kesehatan operasionalnya
 * (Fase 7B.3 — satu kueri agregat core untuk akun ini saja).
 */
async function serializeChannelWithHealth(
  bundle: AuthBundle,
  row: ChannelAccount,
  avatarUrl: string | null = null,
): Promise<ChannelAccountResponse> {
  const healthMap = await getChannelHealthMap(
    bundle.db,
    { tenantId: row.tenantId },
    [row],
  );
  return serializeChannel(
    row,
    avatarUrl,
    healthMap.get(row.id) ?? IDLE_CHANNEL_HEALTH,
  );
}

/** Serialisasi satu akun lengkap dengan avatarUrl hasil cek foto tersimpan. */
async function serializeChannelWithAvatar(
  bundle: AuthBundle,
  row: ChannelAccount,
): Promise<ChannelAccountResponse> {
  const withPhoto = await listProfilePhotoOwnerIds(
    bundle.db,
    { tenantId: row.tenantId },
    "channel_account",
    [row.id],
  );
  return serializeChannelWithHealth(
    bundle,
    row,
    withPhoto.has(row.id) ? channelAvatarUrl(row.tenantId, row.id) : null,
  );
}

/**
 * Batas lunak menunggu pengambilan foto profil pada jalur connect
 * (Hotfix R1): foto kini DI-AWAIT sebelum respons connect disusun agar
 * avatarUrl langsung termuat (dulu fire-and-forget — avatar baru
 * muncul sesudah refresh). Batas ini menjaga connect tidak menggantung
 * pada Graph yang lambat: lewat 6 detik koneksi tetap selesai, dan
 * foto yang terlambat tersimpan tetap muncul lewat backfill daftar
 * channel. Pekerjaan foto sendiri menelan semua error-nya.
 */
const PHOTO_FETCH_SOFT_DEADLINE_MS = 6_000;

async function awaitPhotoFetch(work: Promise<unknown>): Promise<void> {
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

// ---------------------------------------------------------------------------
// Backfill malas foto bot (Fase 6D)
// ---------------------------------------------------------------------------
// Bot yang terhubung SEBELUM Fase 6D belum punya foto tersimpan. Saat
// daftar channel dibaca, akun telegram 'connected' tanpa foto memicu
// pengambilan async fire-and-forget — foto muncul sendiri di pembacaan
// berikutnya, tanpa reconnect. Dua penjaga per proses API agar Bot API
// tidak dipanggil berulang: dedup in-flight per akun, dan cache negatif
// (bot memang tidak punya foto / pengambilan gagal) selama 15 menit.
const botPhotoBackfillInFlight = new Set<string>();
const botPhotoBackfillNegative = new Map<string, number>();
const BOT_PHOTO_BACKFILL_NEGATIVE_TTL_MS = 15 * 60 * 1000;

function scheduleBotPhotoBackfill(
  bundle: AuthBundle,
  opts: ChannelsModuleOptions,
  row: ChannelAccount,
): void {
  if (row.provider !== "telegram" || row.status !== "connected") return;
  if (!row.accessTokenEncrypted || !opts.channelTokenSecret) return;
  if (botPhotoBackfillInFlight.has(row.id)) return;
  const lastNegative = botPhotoBackfillNegative.get(row.id);
  if (
    lastNegative !== undefined &&
    Date.now() - lastNegative < BOT_PHOTO_BACKFILL_NEGATIVE_TTL_MS
  ) {
    return;
  }
  const botToken = decryptChannelSecret(
    opts.channelTokenSecret,
    row.accessTokenEncrypted,
  );
  if (!botToken) return;
  botPhotoBackfillInFlight.add(row.id);
  void fetchAndStoreTelegramProfilePhoto(bundle.db, {
    tenantId: row.tenantId,
    botToken,
    telegramApiBase: opts.telegramApiBase,
    // external_id akun telegram = id numerik bot (dari getMe saat connect).
    telegramUserId: row.externalId,
    ownerType: "channel_account",
    ownerId: row.id,
  })
    .then((stored) => {
      if (stored) botPhotoBackfillNegative.delete(row.id);
      else botPhotoBackfillNegative.set(row.id, Date.now());
    })
    .catch(() => {
      botPhotoBackfillNegative.set(row.id, Date.now());
    })
    .finally(() => {
      botPhotoBackfillInFlight.delete(row.id);
    });
}

/**
 * Backfill malas foto Meta (Hotfix R1) — pasangan scheduleBotPhotoBackfill
 * untuk akun messenger/instagram. Akun yang terhubung SEBELUM permukaan
 * foto provider-nya benar (khususnya IG: /picture tidak bekerja untuk
 * akun IG — R1 mengambilnya lewat profile_picture_url) belum punya foto
 * tersimpan. Saat daftar channel dibaca, akun Meta 'connected' tanpa
 * foto memicu pengambilan async fire-and-forget memakai TOKEN
 * TERSIMPAN akun itu sendiri — foto muncul sendiri di pembacaan
 * berikutnya, TANPA reconnect. Penjaga per proses sama seperti
 * backfill bot: dedup in-flight per akun + cache negatif 15 menit
 * (akun memang tidak memasang foto / pengambilan gagal) agar Graph
 * tidak dipanggil berulang; kegagalan diam (tidak merusak daftar).
 */
const metaPhotoBackfillInFlight = new Set<string>();
const metaPhotoBackfillNegative = new Map<string, number>();

function scheduleMetaPhotoBackfill(
  bundle: AuthBundle,
  opts: ChannelsModuleOptions,
  row: ChannelAccount,
): void {
  if (row.provider !== "messenger" && row.provider !== "instagram") return;
  if (row.status !== "connected") return;
  if (!row.accessTokenEncrypted || !opts.channelTokenSecret) return;
  if (metaPhotoBackfillInFlight.has(row.id)) return;
  const lastNegative = metaPhotoBackfillNegative.get(row.id);
  if (
    lastNegative !== undefined &&
    Date.now() - lastNegative < BOT_PHOTO_BACKFILL_NEGATIVE_TTL_MS
  ) {
    return;
  }
  const accessToken = decryptChannelSecret(
    opts.channelTokenSecret,
    row.accessTokenEncrypted,
  );
  if (!accessToken) return;
  const provider = row.provider;
  metaPhotoBackfillInFlight.add(row.id);
  void (async () => {
    try {
      const client = new MetaGraphClient({
        baseUrl: opts.metaApiBase,
        apiVersion: META_GRAPH_API_VERSION,
        accessToken,
      });
      const picture = await client.getChannelProfilePicture(
        provider,
        row.externalId,
      );
      if (!picture) {
        metaPhotoBackfillNegative.set(row.id, Date.now());
        return;
      }
      await storeProfilePhoto(bundle.db, { tenantId: row.tenantId }, {
        ownerType: "channel_account",
        ownerId: row.id,
        contentType: picture.contentType,
        data: picture.data,
      });
      metaPhotoBackfillNegative.delete(row.id);
    } catch {
      metaPhotoBackfillNegative.set(row.id, Date.now());
    } finally {
      metaPhotoBackfillInFlight.delete(row.id);
    }
  })();
}

/**
 * Backfill malas foto provider OAuth non-Meta (gelombang SEMUA OAUTH)
 * — pasangan dua backfill di atas untuk akun yang URL foto profilnya
 * datang dari API platform: Threads (`threads_profile_picture_url`).
 * Akun yang terhubung SEBELUM foto profil diambil saat connect (atau
 * yang unduhan fotonya gagal/lambat saat connect) belum punya foto
 * tersimpan; saat daftar channel dibaca, akun 'connected' tanpa foto
 * memicu pengambilan async fire-and-forget memakai KREDENSIAL
 * TERSIMPAN akun itu sendiri — foto muncul sendiri di pembacaan
 * berikutnya, TANPA reconnect. Penjaga per proses sama: dedup
 * in-flight per akun + cache negatif 15 menit; kegagalan diam.
 *
 * URL foto diselesaikan per provider oleh
 * `resolveOAuthProfilePictureUrl` lalu diunduh+disimpan lewat helper
 * core bersama `fetchAndStoreProfilePhotoFromUrl` (mekanisme
 * `profile_photos` yang sama persis dengan Meta/Telegram).
 */
const oauthPhotoBackfillInFlight = new Set<string>();
const oauthPhotoBackfillNegative = new Map<string, number>();

/** Provider yang foto profilnya bisa diselesaikan dari API platform. */
const OAUTH_PHOTO_PROVIDERS = new Set(["threads", "tiktok"]);

async function resolveOAuthProfilePictureUrl(
  opts: ChannelsModuleOptions,
  row: ChannelAccount,
  credential: string,
): Promise<string | null> {
  switch (row.provider) {
    case "threads": {
      const profile = await new ThreadsGraphClient({
        baseUrl: opts.threadsApiBase,
        accessToken: credential,
      }).getThreadsProfile();
      return profile.profilePictureUrl;
    }
    case "tiktok": {
      const info = await new TikTokClient({
        baseUrl: opts.tiktokApiBase,
      }).getTikTokUserInfo(credential);
      return info.avatarUrl;
    }
    default:
      return null;
  }
}

function scheduleOAuthPhotoBackfill(
  bundle: AuthBundle,
  opts: ChannelsModuleOptions,
  row: ChannelAccount,
): void {
  if (!OAUTH_PHOTO_PROVIDERS.has(row.provider)) return;
  if (row.status !== "connected") return;
  if (!row.accessTokenEncrypted || !opts.channelTokenSecret) return;
  if (oauthPhotoBackfillInFlight.has(row.id)) return;
  const lastNegative = oauthPhotoBackfillNegative.get(row.id);
  if (
    lastNegative !== undefined &&
    Date.now() - lastNegative < BOT_PHOTO_BACKFILL_NEGATIVE_TTL_MS
  ) {
    return;
  }
  const credential = decryptChannelSecret(
    opts.channelTokenSecret,
    row.accessTokenEncrypted,
  );
  if (!credential) return;
  oauthPhotoBackfillInFlight.add(row.id);
  void (async () => {
    try {
      const pictureUrl = await resolveOAuthProfilePictureUrl(
        opts,
        row,
        credential,
      );
      const stored = pictureUrl
        ? await fetchAndStoreProfilePhotoFromUrl(bundle.db, {
            tenantId: row.tenantId,
            channelAccountId: row.id,
            pictureUrl,
          })
        : false;
      if (stored) oauthPhotoBackfillNegative.delete(row.id);
      else oauthPhotoBackfillNegative.set(row.id, Date.now());
    } catch {
      oauthPhotoBackfillNegative.set(row.id, Date.now());
    } finally {
      oauthPhotoBackfillInFlight.delete(row.id);
    }
  })();
}

/**
 * Mencabut webhook Telegram sebuah akun HANYA bila akun ini memang
 * pemilik webhook saat ini (getWebhookInfo menunjuk ke URL akun ini) —
 * akun duplikat warisan yang bukan pemilik tidak boleh mencabut webhook
 * pemilik sah. Kegagalan Bot API ditelan (disconnect lokal tetap aman:
 * hash secret dikosongkan core → sisa webhook ditolak 401). Dipakai
 * bersama oleh DELETE (disconnect) dan POST trash (Fase 6I).
 * Mengembalikan true bila webhook benar-benar dicabut.
 */
async function deleteTelegramWebhookIfOwner(
  opts: ChannelsModuleOptions,
  account: ChannelAccount,
): Promise<boolean> {
  if (
    account.provider !== "telegram" ||
    account.status === "disconnected" ||
    !account.accessTokenEncrypted ||
    !opts.channelTokenSecret ||
    !opts.publicBaseUrl
  ) {
    return false;
  }
  const botToken = decryptChannelSecret(
    opts.channelTokenSecret,
    account.accessTokenEncrypted,
  );
  if (!botToken) return false;
  const client = new TelegramBotApiClient({
    baseUrl: opts.telegramApiBase,
    token: botToken,
  });
  const expectedUrl = `${opts.publicBaseUrl.replace(/\/+$/, "")}/api/telegram/webhook/${account.id}`;
  try {
    const info = await client.getWebhookInfo();
    if (info.url === expectedUrl) {
      await client.deleteWebhook();
      return true;
    }
  } catch {
    // Bot API tak terjangkau/token tak berlaku lagi: disconnect lokal
    // tetap dilanjutkan pemanggil.
  }
  return false;
}

export interface ChannelsModuleOptions {
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Bot API (env TELEGRAM_API_BASE; default api.telegram.org). */
  telegramApiBase?: string;
  /** URL publik aplikasi (env BETTER_AUTH_URL) — dasar URL webhook Telegram & Meta. */
  publicBaseUrl?: string;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string;
  /** Base URL Threads API (env THREADS_API_BASE) — backfill foto Threads. */
  threadsApiBase?: string;
  /** Base URL TikTok API (env TIKTOK_API_BASE) — backfill foto TikTok. */
  tiktokApiBase?: string;
  /**
   * Verify token webhook Meta — nilai yang KITA tentukan; dibagikan ke
   * owner/admin lewat endpoint meta-webhook-info agar bisa ditempel ke
   * dashboard Meta App. Boleh berupa fungsi resolver async (instruksi
   * pemilik 2026-11-12: efektif Panel Admin → env
   * META_WEBHOOK_VERIFY_TOKEN) agar info webhook selalu menunjukkan
   * token yang benar-benar berlaku, pola metaAppSecretConfigured.
   */
  metaWebhookVerifyToken?: string | (() => Promise<string | null>);
  /**
   * Apakah App Secret Meta sudah terkonfigurasi — boolean saja, nilainya
   * tidak pernah masuk modul ini. Boleh berupa fungsi resolver async
   * (Fase 7A.1: efektif panel → env, bukan env semata) agar panel info
   * webhook tidak menuduh "belum diset" saat pemilik sudah mengisi panel.
   */
  metaAppSecretConfigured?: boolean | (() => Promise<boolean>);
}

/**
 * Modul channels (Fase 1F, diperluas 6A; hotfix Telegram; 6I Sampah) —
 * route bersarang di workspace:
 *   POST   /tenants/:tenantId/channels            buat channel (webchat, telegram)
 *   GET    /tenants/:tenantId/channels            daftar channel workspace
 *   DELETE /tenants/:tenantId/channels/:channelId putuskan koneksi channel
 *   GET    /tenants/:tenantId/channels/trash      daftar Sampah (Fase 6I)
 *   POST   /tenants/:tenantId/channels/:channelId/trash   buang ke Sampah
 *   POST   /tenants/:tenantId/channels/:channelId/restore pulihkan dari Sampah
 *   GET    /tenants/:tenantId/channels/:channelId/export  unduh ekspor JSON
 *   GET    /tenants/:tenantId/channels/meta-webhook-info  info wiring webhook Meta (Fase 7A, owner/admin)
 * Hapus permanen BERPENJAGA (Fase 6I): membuang = disconnect penuh (bila
 * masih terhubung) + `trashed_at`; masa tenggang 30 hari di Sampah bisa
 * dipulihkan/diekspor, sesudahnya worker meng-purge permanen. Purge
 * manual sengaja TIDAK dibuat — masa tenggang adalah pengamannya.
 * Semua provider kini bisa dihubungkan. Messenger & Instagram (Fase
 * 7A) dan WhatsApp (Fase 7B) dihubungkan token-based seperti Telegram:
 * token divalidasi ke Graph, disimpan terenkripsi; webhook Meta-nya
 * TUNGGAL milik platform (modul meta), bukan per akun. Fallback 422
 * CHANNEL_NOT_AVAILABLE_YET di handler hanya pengaman untuk provider
 * masa depan yang belum dikenal.
 * Untuk webchat, respons POST memuat siteKey di `externalId` — kunci
 * publik yang dipasang tenant di situsnya. Untuk telegram, token bot
 * TIDAK PERNAH muncul di respons: yang tampil hanya status + username bot.
 * Wajib sesi + membership (pola Fase 1B/1D); DELETE dibatasi owner/admin
 * (pola API keys Fase 5A).
 *
 * Hotfix Telegram:
 * - Penjaga "satu bot = satu koneksi": bot Telegram yang sama tidak
 *   boleh aktif di dua workspace (satu bot = satu webhook; koneksi kedua
 *   akan membajak yang pertama). Connect yang menabrak bot aktif milik
 *   workspace LAIN ditolak 409 TELEGRAM_BOT_ALREADY_CONNECTED; connect
 *   ulang di workspace yang sama bersifat idempoten.
 * - Disconnect: status 'disconnected' + kredensial dikosongkan; untuk
 *   Telegram, webhook di Telegram hanya dicabut bila akun ini memang
 *   pemilik webhook saat ini (cek getWebhookInfo). Riwayat percakapan
 *   TIDAK dihapus.
 */
export function createChannelsRoutes(
  bundle: AuthBundle | null,
  opts: ChannelsModuleOptions = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/channels";

  if (!bundle) {
    app.get(base, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(base, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.delete(`${base}/:channelId`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/trash`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/:channelId/trash`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/:channelId/restore`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/:channelId/export`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/meta-webhook-info`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    return app;
  }


  app.get(base, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listChannelAccounts(bundle.db, { tenantId: tenant.id });
    // Fase 6D: avatarUrl dari foto tersimpan; akun telegram connected
    // yang belum punya foto memicu backfill malas (fire-and-forget) —
    // respons ini tetap menjawab tanpa menunggu Bot API. Hotfix R1:
    // akun Meta (messenger/instagram) tanpa foto mendapat backfill
    // yang sama, agar akun lama ikut beravatar tanpa reconnect.
    const withPhoto = await listProfilePhotoOwnerIds(
      bundle.db,
      { tenantId: tenant.id },
      "channel_account",
      rows.map((r) => r.id),
    );
    for (const row of rows) {
      if (withPhoto.has(row.id)) continue;
      scheduleBotPhotoBackfill(bundle, opts, row);
      scheduleMetaPhotoBackfill(bundle, opts, row);
      scheduleOAuthPhotoBackfill(bundle, opts, row);
    }
    // Fase 7B.3: kesehatan operasional per akun — SATU peta agregat
    // untuk seluruh daftar (bukan kueri per kartu).
    const healthMap = await getChannelHealthMap(
      bundle.db,
      { tenantId: tenant.id },
      rows,
    );
    const body = ChannelAccountListResponseSchema.parse({
      channels: rows.map((row) =>
        serializeChannel(
          row,
          withPhoto.has(row.id) ? channelAvatarUrl(tenant.id, row.id) : null,
          healthMap.get(row.id) ?? IDLE_CHANNEL_HEALTH,
        ),
      ),
    });
    return c.json(body);
  });

  app.post(base, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateChannelRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid channel payload");
    }
    if (parsed.data.provider === "telegram") {
      return connectTelegram(c, bundle, opts, {
        tenantId: tenant.id,
        userId: appUser.id,
        displayName: parsed.data.displayName,
        botToken: parsed.data.botToken,
      });
    }
    if (
      parsed.data.provider === "messenger" ||
      parsed.data.provider === "instagram"
    ) {
      return connectMeta(c, bundle, opts, {
        tenantId: tenant.id,
        userId: appUser.id,
        provider: parsed.data.provider,
        displayName: parsed.data.displayName,
        pageAccessToken: parsed.data.pageAccessToken,
        pageId: parsed.data.pageId,
        igUserId: parsed.data.igUserId,
        tokenType: parsed.data.tokenType,
      });
    }
    if (parsed.data.provider === "whatsapp") {
      return connectWhatsApp(c, bundle, opts, {
        tenantId: tenant.id,
        userId: appUser.id,
        displayName: parsed.data.displayName,
        accessToken: parsed.data.accessToken,
        wabaId: parsed.data.wabaId,
        phoneNumberId: parsed.data.phoneNumberId,
      });
    }
    if (parsed.data.provider !== "webchat") {
      return apiError(
        c,
        422,
        "CHANNEL_NOT_AVAILABLE_YET",
        `Provider ${parsed.data.provider} cannot be connected yet`,
      );
    }
    const row = await createWebchatChannelAccount(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      { displayName: parsed.data.displayName },
    );
    return c.json(await serializeChannelWithHealth(bundle, row), 201);
  });

  /**
   * Memutuskan koneksi channel (hotfix Telegram): DELETE → 204.
   * Hanya owner/admin. Semantik per provider:
   * - Telegram: webhook di Telegram dicabut (deleteWebhook) HANYA bila
   *   getWebhookInfo menunjukkan URL webhook saat ini menunjuk ke akun
   *   ini — akun duplikat warisan yang bukan pemilik tidak boleh
   *   mencabut webhook pemilik sah. Kegagalan Bot API tidak menggagalkan
   *   disconnect lokal (hash secret dikosongkan core → webhook sisa akan
   *   ditolak 401). Hasil cek dicatat di audit sebagai `webhookDeleted`.
   * - Webchat: cukup status — sejak hotfix Disconnect Gate, status akun
   *   digerbangi di SEMUA jalur pengunjung (sesi baru 404; kirim/daftar
   *   pesan bertoken lama 409 CHANNEL_DISCONNECTED; upgrade socket
   *   realtime ditolak), jadi arus masuk berhenti total seketika.
   * Kredensial tersimpan dikosongkan oleh core; riwayat percakapan dan
   * pesan TIDAK dihapus. Idempoten: memutuskan akun yang sudah putus
   * tetap 204.
   */
  app.delete(`${base}/:channelId`, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can disconnect channels");
    }
    const channelId = c.req.param("channelId");
    if (!z.string().uuid().safeParse(channelId).success) {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    const account = await getChannelAccount(
      bundle.db,
      { tenantId: tenant.id },
      channelId,
    );
    if (!account) return apiError(c, 404, "NOT_FOUND", "Channel not found");

    const webhookDeleted = await deleteTelegramWebhookIfOwner(opts, account);

    await disconnectChannelAccount(
      bundle.db,
      { tenantId: tenant.id, actorType: "user", actorId: appUser.id },
      account.id,
      account.provider === "telegram" ? { webhookDeleted } : {},
    );
    return c.body(null, 204);
  });

  /**
   * Daftar Sampah (Fase 6I): akun yang dibuang, terlama dibuang lebih
   * dulu, masing-masing dengan `trashedAt` + `purgeAt` (trashedAt + 30
   * hari) dari serializer. Daftar channel baku (GET base) mengecualikan
   * akun-akun ini. Membership cukup — membaca Sampah tidak destruktif;
   * aksi di dalamnya (restore/export/trash) dibatasi owner/admin.
   */
  app.get(`${base}/trash`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listTrashedChannelAccounts(bundle.db, { tenantId: tenant.id });
    // Kesehatan tetap dihitung dari log yang masih tertaut (riwayat
    // akun Sampah memang dipertahankan sampai purge — Fase 6I/7B.1).
    const healthMap = await getChannelHealthMap(
      bundle.db,
      { tenantId: tenant.id },
      rows,
    );
    const body = ChannelAccountListResponseSchema.parse({
      channels: rows.map((row) =>
        serializeChannel(
          row,
          null,
          healthMap.get(row.id) ?? IDLE_CHANNEL_HEALTH,
        ),
      ),
    });
    return c.json(body);
  });

  /**
   * Info pemasangan webhook Meta (Fase 7A): URL webhook publik platform
   * + verify token untuk ditempel ke dashboard Meta App (bidang Webhook:
   * Callback URL + Verify Token, lalu subscribe ke field `messages`).
   * Hanya owner/admin — verify token adalah nilai yang kita tentukan
   * sendiri (bukan kredensial Meta), tetapi tetap tidak dibagikan ke
   * peran yang tidak memasang integrasi. App secret TIDAK pernah
   * termasuk dalam respons ini.
   */
  app.get(`${base}/meta-webhook-info`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can view Meta webhook settings");
    }
    const baseUrl = (opts.publicBaseUrl ?? "").replace(/\/+$/, "");
    const appSecretConfigured =
      typeof opts.metaAppSecretConfigured === "function"
        ? await opts.metaAppSecretConfigured()
        : opts.metaAppSecretConfigured ?? false;
    const verifyToken =
      typeof opts.metaWebhookVerifyToken === "function"
        ? await opts.metaWebhookVerifyToken()
        : opts.metaWebhookVerifyToken ?? null;
    const body = MetaWebhookInfoResponseSchema.parse({
      webhookUrl: `${baseUrl}/api/meta/webhook`,
      verifyToken,
      appSecretConfigured,
    });
    return c.json(body);
  });

  /**
   * Buang channel ke Sampah (Fase 6I, hapus permanen BERPENJAGA).
   * Hanya owner/admin. Urutan penjagaan, semuanya SEBELUM mutasi apa pun:
   * akun tak ditemukan → 404; sudah di Sampah → 409
   * CHANNEL_ALREADY_TRASHED (jujur, bukan idempoten diam-diam);
   * `confirmationName` tidak sama PERSIS dengan nama konfirmasi akun
   * (displayName ?? botUsername ?? externalId — lihat core) → 422
   * CHANNEL_DELETE_CONFIRMATION_MISMATCH. Sesudah lolos: bila akun
   * masih terhubung, semantik disconnect yang ADA dijalankan persis
   * (webhook Telegram dicabut bila pemilik, kredensial dikosongkan,
   * audit channel.disconnected), baru `trashed_at` diisi (audit
   * channel.trashed). Akun berakhir 'disconnected' — penjaga satu-bot
   * otomatis membebaskan botnya. Sukses → 200 akun terserialisasi
   * (dengan trashedAt + purgeAt).
   */
  app.post(`${base}/:channelId/trash`, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can delete channels");
    }
    const channelId = c.req.param("channelId");
    if (!z.string().uuid().safeParse(channelId).success) {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = TrashChannelRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid trash payload");
    }
    const account = await getChannelAccount(
      bundle.db,
      { tenantId: tenant.id },
      channelId,
    );
    if (!account) return apiError(c, 404, "NOT_FOUND", "Channel not found");
    if (account.trashedAt) {
      return apiError(c, 409, "CHANNEL_ALREADY_TRASHED", "This channel is already in the trash");
    }
    if (parsed.data.confirmationName !== channelConfirmationName(account)) {
      return apiError(
        c,
        422,
        "CHANNEL_DELETE_CONFIRMATION_MISMATCH",
        "The confirmation name does not match this channel's name",
      );
    }

    if (account.status !== "disconnected") {
      const webhookDeleted = await deleteTelegramWebhookIfOwner(opts, account);
      await disconnectChannelAccount(
        bundle.db,
        { tenantId: tenant.id, actorType: "user", actorId: appUser.id },
        account.id,
        account.provider === "telegram" ? { webhookDeleted } : {},
      );
    }

    const outcome = await markChannelAccountTrashed(
      bundle.db,
      { tenantId: tenant.id, actorType: "user", actorId: appUser.id },
      account.id,
    );
    if (outcome.outcome === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    if (outcome.outcome === "already_trashed") {
      return apiError(c, 409, "CHANNEL_ALREADY_TRASHED", "This channel is already in the trash");
    }
    return c.json(await serializeChannelWithAvatar(bundle, outcome.account), 200);
  });

  /**
   * Pulihkan channel dari Sampah (Fase 6I): membersihkan `trashed_at`;
   * status TETAP 'disconnected' — tidak ada reconnect diam-diam. Akun
   * yang tidak sedang di Sampah → 409 CHANNEL_NOT_TRASHED. Sukses →
   * 200 akun terserialisasi.
   */
  app.post(`${base}/:channelId/restore`, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can restore channels");
    }
    const channelId = c.req.param("channelId");
    if (!z.string().uuid().safeParse(channelId).success) {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    const outcome = await restoreChannelAccount(
      bundle.db,
      { tenantId: tenant.id, actorType: "user", actorId: appUser.id },
      channelId,
    );
    if (outcome.outcome === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    if (outcome.outcome === "not_trashed") {
      return apiError(c, 409, "CHANNEL_NOT_TRASHED", "This channel is not in the trash");
    }
    return c.json(await serializeChannelWithAvatar(bundle, outcome.account), 200);
  });

  /**
   * Ekspor riwayat channel (Fase 6I): unduhan JSON metadata channel +
   * semua percakapan + pesan-pesannya (struktur
   * `sahabat-kreator/channel-export@1`, lihat core). Berlaku untuk
   * channel aktif maupun di Sampah — jalan keluar data sebelum purge.
   * Nama berkas aman: provider + 8 char pertama id. Audit
   * `channel.exported` ditulis core dengan meta hitungan saja.
   */
  app.get(`${base}/:channelId/export`, async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), appUser.id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can export channels");
    }
    const channelId = c.req.param("channelId");
    if (!z.string().uuid().safeParse(channelId).success) {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    const data = await exportChannelAccount(
      bundle.db,
      { tenantId: tenant.id, actorType: "user", actorId: appUser.id },
      channelId,
    );
    if (!data) return apiError(c, 404, "NOT_FOUND", "Channel not found");
    const filename = `channel-export-${data.channel.provider}-${data.channel.id.slice(0, 8)}.json`;
    return c.body(JSON.stringify(data, null, 2), 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
  });

  return app;
}

/**
 * Menghubungkan bot Telegram (Fase 6A; penjaga hotfix Telegram):
 * 1. Validasi token ke Bot API (`getMe`) — token ditolak Telegram (401)
 *    → 422 TELEGRAM_TOKEN_INVALID; Bot API tak terjangkau → 503.
 * 2. Penjaga satu bot = satu koneksi: bot yang sama masih AKTIF di
 *    workspace lain → 409 TELEGRAM_BOT_ALREADY_CONNECTED (tanpa baris
 *    baru, tanpa menyentuh webhook pemilik sah). Di workspace ini:
 *    'connected' → idempoten 200; 'disconnected'/'error' → baris yang
 *    sama dihidupkan lagi (revive).
 * 3. Buat akun channel: token disimpan TERENKRIPSI (AES-256-GCM, kunci
 *    env CHANNEL_TOKEN_SECRET), secret webhook acak disimpan sebagai
 *    hash SHA-256. Token mentah tidak menyentuh DB/log/respons.
 * 4. Daftarkan webhook `POST {publicBaseUrl}/api/telegram/webhook/<id>`
 *    dengan secret itu. Gagal daftar → akun ditandai 'error' dan request
 *    menjawab 422 CHANNEL_NOT_CONNECTED (akun terlihat jujur di daftar,
 *    bukan hilang diam-diam).
 */
async function connectTelegram(
  c: Parameters<typeof apiError>[0],
  bundle: AuthBundle,
  opts: ChannelsModuleOptions,
  input: {
    tenantId: string;
    userId: string;
    displayName?: string;
    botToken?: string;
  },
) {
  if (!input.botToken) {
    return apiError(c, 400, "VALIDATION_ERROR", "botToken is required for telegram");
  }
  if (!opts.channelTokenSecret || !opts.publicBaseUrl) {
    return apiError(c, 503, "INTERNAL_ERROR", "Telegram is not configured");
  }
  const client = new TelegramBotApiClient({
    baseUrl: opts.telegramApiBase,
    token: input.botToken,
  });

  let identity;
  try {
    identity = await client.getMe();
  } catch (err) {
    if (err instanceof TelegramApiError) {
      if (err.status === 0) {
        return apiError(c, 503, "INTERNAL_ERROR", "Telegram API is unreachable");
      }
      return apiError(c, 422, "TELEGRAM_TOKEN_INVALID", "Telegram rejected the bot token");
    }
    return apiError(c, 503, "INTERNAL_ERROR", "Telegram API is unreachable");
  }

  let encryptedBotToken: string;
  try {
    encryptedBotToken = encryptChannelSecret(
      opts.channelTokenSecret,
      input.botToken,
    );
  } catch {
    return apiError(c, 503, "INTERNAL_ERROR", "Channel credential encryption is not configured");
  }

  // Penjaga "satu bot = satu koneksi" (hotfix Telegram): bot ini tidak
  // boleh AKTIF di workspace lain — webhook-nya hanya satu dan akan
  // berpindah diam-diam. Lookup lintas tenant hanya menjawab keberadaan;
  // respons TIDAK menyebut workspace pemiliknya.
  const existing = await lookupChannelAccountsByProviderExternalId(
    bundle.db,
    "telegram",
    identity.id,
  );
  const activeElsewhere = existing.find(
    (r) => r.tenantId !== input.tenantId && r.status !== "disconnected",
  );
  if (activeElsewhere) {
    return apiError(
      c,
      409,
      "TELEGRAM_BOT_ALREADY_CONNECTED",
      "This bot is already connected to another workspace",
    );
  }
  const own = existing.find((r) => r.tenantId === input.tenantId);
  if (own) {
    if (own.status === "connected") {
      // Idempoten: bot yang sama di workspace yang sama — kembalikan
      // akun yang ada; jangan buat baris duplikat, jangan sentuh webhook.
      const row = await getChannelAccount(
        bundle.db,
        { tenantId: input.tenantId },
        own.id,
      );
      if (row) return c.json(await serializeChannelWithAvatar(bundle, row), 200);
    }
    // Akun milik workspace ini berstatus 'disconnected'/'error':
    // hidupkan lagi baris yang sama (kredensial + secret baru, webhook
    // didaftarkan ulang) — index unik per tenant melarang baris kedua.
    return reviveTelegramAccount(c, bundle, opts, {
      tenantId: input.tenantId,
      displayName: input.displayName,
      accountId: own.id,
      botUsername: identity.username,
      botUserId: identity.id,
      botToken: input.botToken,
      encryptedBotToken,
      client,
    });
  }

  const webhookSecret = generateChannelWebhookSecret();
  let row: ChannelAccount;
  try {
    row = await createTelegramChannelAccount(
      bundle.db,
      { tenantId: input.tenantId, userId: input.userId },
      {
        displayName: input.displayName,
        botId: identity.id,
        botUsername: identity.username,
        encryptedBotToken,
        webhookSecretHash: hashChannelWebhookSecret(webhookSecret),
      },
    );
  } catch {
    // Balapan dengan connect lain: index unik parsial global (atau index
    // per tenant) menolak baris ini. Petakan ulang dari keadaan terbaru —
    // milik workspace lain → 409 yang sama; milik workspace ini →
    // kembalikan akun pemenang balapan (idempoten).
    const now = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      "telegram",
      identity.id,
    );
    const other = now.find(
      (r) => r.tenantId !== input.tenantId && r.status !== "disconnected",
    );
    if (other) {
      return apiError(
        c,
        409,
        "TELEGRAM_BOT_ALREADY_CONNECTED",
        "This bot is already connected to another workspace",
      );
    }
    const ownNow = now.find(
      (r) => r.tenantId === input.tenantId && r.status !== "disconnected",
    );
    if (ownNow) {
      const winner = await getChannelAccount(
        bundle.db,
        { tenantId: input.tenantId },
        ownNow.id,
      );
      if (winner) return c.json(await serializeChannelWithAvatar(bundle, winner), 200);
    }
    return apiError(
      c,
      422,
      "CHANNEL_NOT_CONNECTED",
      "This bot is already connected to this workspace",
    );
  }

  const webhookUrl = `${opts.publicBaseUrl.replace(/\/+$/, "")}/api/telegram/webhook/${row.id}`;
  try {
    await client.setWebhook({ url: webhookUrl, secretToken: webhookSecret });
  } catch {
    await setChannelAccountStatus(
      bundle.db,
      { tenantId: input.tenantId },
      row.id,
      "error",
    );
    return apiError(
      c,
      422,
      "CHANNEL_NOT_CONNECTED",
      "Failed to register the webhook with Telegram",
    );
  }

  // Fase 6D: ambil foto profil bot (best-effort) — token mentah sedang
  // di tangan; kegagalan foto tidak menggagalkan connect. Hotfix R1:
  // pengambilan kini DI-AWAIT (batas lunak) dan respons diserialkan
  // dengan avatar, jadi foto langsung tampil tanpa refresh.
  await awaitPhotoFetch(
    fetchAndStoreTelegramProfilePhoto(bundle.db, {
      tenantId: input.tenantId,
      botToken: input.botToken,
      telegramApiBase: opts.telegramApiBase,
      telegramUserId: identity.id,
      ownerType: "channel_account",
      ownerId: row.id,
    }),
  );

  return c.json(await serializeChannelWithAvatar(bundle, row), 201);
}

/**
 * Menghidupkan lagi akun Telegram milik workspace ini yang berstatus
 * 'disconnected'/'error' (jalur idempoten connect): kredensial ditulis
 * ulang dari token yang baru diserahkan (token sama sudah lolos getMe),
 * secret webhook dirotasi, webhook didaftarkan ulang untuk id akun yang
 * SAMA. Sukses → 200 akun 'connected'; webhook gagal → akun 'error' +
 * 422 CHANNEL_NOT_CONNECTED (pola connect baru Fase 6A).
 */
async function reviveTelegramAccount(
  c: Parameters<typeof apiError>[0],
  bundle: AuthBundle,
  opts: ChannelsModuleOptions,
  input: {
    tenantId: string;
    displayName?: string;
    accountId: string;
    botUsername: string | null;
    /** Id numerik bot + token mentah — untuk pengambilan foto profil (Fase 6D). */
    botUserId: string;
    botToken: string;
    encryptedBotToken: string;
    client: TelegramBotApiClient;
  },
) {
  const webhookSecret = generateChannelWebhookSecret();
  const updated = await updateTelegramChannelAccountCredentials(
    bundle.db,
    { tenantId: input.tenantId },
    input.accountId,
    {
      encryptedBotToken: input.encryptedBotToken,
      webhookSecretHash: hashChannelWebhookSecret(webhookSecret),
      botUsername: input.botUsername,
      displayName: input.displayName,
      status: "connected",
    },
  );
  if (!updated) {
    return apiError(c, 404, "NOT_FOUND", "Channel not found");
  }

  const webhookUrl = `${(opts.publicBaseUrl ?? "").replace(/\/+$/, "")}/api/telegram/webhook/${updated.id}`;
  try {
    await input.client.setWebhook({
      url: webhookUrl,
      secretToken: webhookSecret,
    });
  } catch {
    await setChannelAccountStatus(
      bundle.db,
      { tenantId: input.tenantId },
      updated.id,
      "error",
    );
    return apiError(
      c,
      422,
      "CHANNEL_NOT_CONNECTED",
      "Failed to register the webhook with Telegram",
    );
  }

  // Fase 6D: connect ulang = foto bot di-refresh (best-effort).
  // Hotfix R1: di-await (batas lunak) + respons membawa avatarUrl,
  // pola yang sama seperti connect baru.
  await awaitPhotoFetch(
    fetchAndStoreTelegramProfilePhoto(bundle.db, {
      tenantId: input.tenantId,
      botToken: input.botToken,
      telegramApiBase: opts.telegramApiBase,
      telegramUserId: input.botUserId,
      ownerType: "channel_account",
      ownerId: updated.id,
    }),
  );

  return c.json(await serializeChannelWithAvatar(bundle, updated), 200);
}

/**
 * Menghubungkan akun Meta (Fase 7A — Messenger & Instagram, token-based
 * v1 meniru pola Telegram 6A):
 * 1. Validasi ke Graph: `GET /{id}?fields=name,username` dengan token
 *    yang ditempel. Messenger memvalidasi Page-nya; Instagram
 *    memvalidasi akun IG-nya DAN Page yang terhubung (token harus milik
 *    Page itu). Graph menolak → 422 META_TOKEN_INVALID; Graph tak
 *    terjangkau → 503.
 * 2. Penjaga satu akun = satu koneksi (pola hotfix Telegram, kode
 *    generik Meta): akun yang sama masih AKTIF di workspace lain → 409
 *    META_ACCOUNT_ALREADY_CONNECTED (tanpa baris baru). Di workspace
 *    ini: 'connected' → idempoten 200; 'disconnected'/'error' → baris
 *    yang sama dihidupkan lagi (revive).
 * 3. Buat akun: external_id = Page ID (messenger) / ID akun IG
 *    (instagram); displayName dari form atau nama Graph; handle publik
 *    (username) disimpan; token TERENKRIPSI (AES-256-GCM). Tidak ada
 *    pendaftaran webhook per akun — webhook Meta adalah milik platform
 *    (satu URL untuk semua akun, dipasang sekali di Meta App).
 * 4. Foto profil Page/akun IG diambil & disimpan (pola 6D; Hotfix R1:
 *    di-await berbatas lunak + permukaan per provider — Page /picture,
 *    IG profile_picture_url — dan respons membawanya sebagai avatarUrl).
 *
 * Varian System User Token untuk Instagram (Fase 7D.3,
 * `tokenType: "system_user_token"`): OAuth Unified Login tidak bisa
 * menjangkau akun IG pemilik aplikasi sendiri — portfolio bisnis
 * aplikasi dan akun IG yang sama berarti "business integration system
 * user" tersembunyi dari alur itu tidak menerima asetnya (penemuan
 * /me/assigned_instagram_accounts selalu kosong untuk kasus
 * satu-portfolio). Jalan resminya adalah SUAT dari System User
 * EKSPILISIT yang dibuat pemilik di Pengaturan Bisnis (aset aplikasi +
 * akun IG ditetapkan kepadanya). Varian ini menerima token itu TANPA
 * Page ID: validasi `GET /{ig-id}?fields=id,username` dengan SUAT
 * (gagal → 422 META_TOKEN_INVALID yang sama); `client_business_id`
 * diambil best-effort sebagai parent_external_id; sesudah tersimpan,
 * subscribe `POST /{ig-id}/subscribed_apps` dicoba — kegagalannya
 * menjadi peringatan META_SUBSCRIBE_FAILED di respons, BUKAN kegagalan
 * koneksi (konsisten dengan complete OAuth 7D). Jalur simpan persis
 * sama (create/revive + penjaga 409 + enkripsi yang sama), dan poller
 * pengiriman memakai token tersimpan apa adanya sebagai Bearer ke
 * `POST /{ig-id}/messages` — tidak ada asumsi token-Page di jalur itu.
 */
async function connectMeta(
  c: Parameters<typeof apiError>[0],
  bundle: AuthBundle,
  opts: ChannelsModuleOptions,
  input: {
    tenantId: string;
    userId: string;
    provider: MetaProvider;
    displayName?: string;
    pageAccessToken?: string;
    pageId?: string;
    igUserId?: string;
    /** Fase 7D.3: hanya bermakna untuk instagram (lihat kontrak). */
    tokenType?: "page_access_token" | "system_user_token";
  },
) {
  if (!input.pageAccessToken) {
    return apiError(c, 400, "VALIDATION_ERROR", "pageAccessToken is required for Meta channels");
  }
  // Varian SUAT (Fase 7D.3): hanya untuk instagram; provider lain dan
  // tokenType absen/page_access_token = perilaku 7A persis.
  const isSuat =
    input.provider === "instagram" &&
    input.tokenType === "system_user_token";
  // external_id akun: messenger = Page ID; instagram = ID akun IG.
  const accountExternalId =
    input.provider === "instagram" ? input.igUserId : input.pageId;
  if (!accountExternalId) {
    return apiError(
      c,
      400,
      "VALIDATION_ERROR",
      input.provider === "instagram"
        ? "igUserId is required for instagram"
        : "pageId is required for messenger",
    );
  }
  if (input.provider === "instagram" && !input.pageId && !isSuat) {
    return apiError(c, 400, "VALIDATION_ERROR", "pageId (the connected Facebook Page) is required for instagram");
  }
  if (!opts.channelTokenSecret) {
    return apiError(c, 503, "INTERNAL_ERROR", "Meta is not configured");
  }
  const client = new MetaGraphClient({
    baseUrl: opts.metaApiBase,
    apiVersion: META_GRAPH_API_VERSION,
    accessToken: input.pageAccessToken,
  });

  // Validasi token + ambil identitas publik akun dari Graph.
  // - Varian Page token (7A): profil objek + (khusus IG) profil Page.
  // - Varian SUAT (7D.3): profil ringkas akun IG saja (id, username);
  //   konteks portofolio (client_business_id) best-effort — kegagalan
  //   membacanya menghasilkan null, BUKAN kegagalan koneksi.
  let profile: { id: string; name: string | null; username: string | null };
  let suatParentExternalId: string | null = null;
  try {
    if (isSuat) {
      const igProfile = await client.getInstagramAccountProfile(
        accountExternalId,
      );
      profile = {
        id: igProfile.id,
        name: null,
        username: igProfile.username,
      };
      suatParentExternalId = await client
        .getClientBusinessId()
        .catch(() => null);
    } else {
      profile = await client.getObjectProfile(accountExternalId);
      if (input.provider === "instagram" && input.pageId) {
        // Token juga harus berlaku untuk Page yang terhubung — inilah
        // satu-satunya guna Page ID pada connect IG (tidak disimpan).
        await client.getObjectProfile(input.pageId);
      }
    }
  } catch (err) {
    if (err instanceof MetaGraphError) {
      if (err.status === 0) {
        return apiError(c, 503, "INTERNAL_ERROR", "Meta Graph API is unreachable");
      }
      return apiError(c, 422, "META_TOKEN_INVALID", "Meta rejected the page access token or account id");
    }
    return apiError(c, 503, "INTERNAL_ERROR", "Meta Graph API is unreachable");
  }

  let encryptedAccessToken: string;
  try {
    encryptedAccessToken = encryptChannelSecret(
      opts.channelTokenSecret,
      input.pageAccessToken,
    );
  } catch {
    return apiError(c, 503, "INTERNAL_ERROR", "Channel credential encryption is not configured");
  }

  // Penutup connect untuk jalur yang MENYIMPAN kredensial (create &
  // revive). Varian SUAT (7D.3): sesudah tersimpan, subscribe akun IG
  // ke webhook aplikasi dicoba dengan SUAT yang sama — kegagalan TIDAK
  // menggagalkan koneksi, melainkan peringatan META_SUBSCRIBE_FAILED
  // yang menempel pada respons (konsisten dengan complete OAuth 7D;
  // kontrak respons manual tetap objek channel, peringatan adalah
  // field tambahan opsional). Varian lain: respons persis seperti
  // sebelumnya, tanpa field tambahan.
  const finishSavedConnect = async (
    row: ChannelAccount,
    status: 200 | 201,
  ) => {
    // Hotfix R1: serialkan DENGAN avatar — foto sudah di-await sebelum
    // titik ini, jadi respons connect langsung memuat avatarUrl.
    const serialized = await serializeChannelWithAvatar(bundle, row);
    if (!isSuat) return c.json(serialized, status);
    const warnings: Array<"META_SUBSCRIBE_FAILED"> = [];
    try {
      // Fase 10B: sertakan field comments — helper mundur ke messages
      // saja bila Graph menolak field lebar.
      await client.subscribeAppToObjectWithComments(
        accountExternalId,
        "instagram",
      );
    } catch {
      warnings.push("META_SUBSCRIBE_FAILED");
      console.error(
        `[meta] subscribe subscribed_apps akun IG ${row.id} (varian SUAT) gagal — koneksi tetap aktif`,
      );
    }
    return c.json({ ...serialized, warnings }, status);
  };

  // Penjaga "satu akun = satu koneksi": akun ini tidak boleh AKTIF di
  // workspace lain (pesan Page/IG hanya boleh masuk ke satu inbox).
  const existing = await lookupChannelAccountsByProviderExternalId(
    bundle.db,
    input.provider,
    accountExternalId,
  );
  const activeElsewhere = existing.find(
    (r) => r.tenantId !== input.tenantId && r.status !== "disconnected",
  );
  if (activeElsewhere) {
    return apiError(
      c,
      409,
      "META_ACCOUNT_ALREADY_CONNECTED",
      "This Meta account is already connected to another workspace",
    );
  }
  const own = existing.find((r) => r.tenantId === input.tenantId);
  if (own) {
    if (own.status === "connected") {
      const row = await getChannelAccount(
        bundle.db,
        { tenantId: input.tenantId },
        own.id,
      );
      if (row) return c.json(await serializeChannelWithAvatar(bundle, row), 200);
    }
    // Akun milik workspace ini 'disconnected'/'error': hidupkan lagi
    // baris yang sama dengan kredensial baru (pola revive Telegram).
    // Varian SUAT: segarkan juga konteks portofolio bila terbaca —
    // null hasil bacaan gagal TIDAK menimpa nilai lama (undefined =
    // jangan ubah, lihat core).
    const updated = await updateMetaChannelAccountCredentials(
      bundle.db,
      { tenantId: input.tenantId },
      own.id,
      {
        encryptedAccessToken,
        publicHandle: profile.username,
        graphName: profile.name,
        displayName: input.displayName,
        parentExternalId:
          isSuat && suatParentExternalId ? suatParentExternalId : undefined,
        status: "connected",
        // Lifecycle 0010: varian token tersimpan saat connect — SUAT
        // eksplisit (system_user_token) vs Page token (page_access_token).
        tokenType: isSuat ? "system_user_token" : "page_access_token",
        tokenExpiresAt: null,
        tokenRefreshedAt: null,
      },
    );
    if (!updated) {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    await fetchAndStoreMetaAccountPhoto(
      bundle,
      client,
      input.provider,
      input.tenantId,
      updated.id,
      accountExternalId,
    );
    return finishSavedConnect(updated, 200);
  }

  let row: ChannelAccount;
  try {
    row = await createMetaChannelAccount(
      bundle.db,
      { tenantId: input.tenantId, userId: input.userId },
      {
        provider: input.provider,
        accountExternalId,
        graphName: profile.name,
        publicHandle: profile.username,
        displayName: input.displayName,
        encryptedAccessToken,
        graphApiVersion: META_GRAPH_API_VERSION,
        // Varian SUAT (7D.3): konteks portofolio pemilik token.
        // Varian lain: undefined → core menyimpan null (perilaku 7A).
        parentExternalId: isSuat ? suatParentExternalId : undefined,
        // Lifecycle 0010: varian token tersimpan saat connect — SUAT
        // eksplisit vs Page token (Facebook Login); keduanya tanpa
        // expiry terdokumentasi di jalur manual ini.
        tokenType: isSuat ? "system_user_token" : "page_access_token",
        tokenExpiresAt: null,
      },
    );
  } catch {
    // Balapan dengan connect lain (pola Telegram): petakan ulang dari
    // keadaan terbaru — milik workspace lain → 409 yang sama; milik
    // workspace ini → kembalikan akun pemenang balapan (idempoten).
    const now = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      input.provider,
      accountExternalId,
    );
    const other = now.find(
      (r) => r.tenantId !== input.tenantId && r.status !== "disconnected",
    );
    if (other) {
      return apiError(
        c,
        409,
        "META_ACCOUNT_ALREADY_CONNECTED",
        "This Meta account is already connected to another workspace",
      );
    }
    const ownNow = now.find(
      (r) => r.tenantId === input.tenantId && r.status !== "disconnected",
    );
    if (ownNow) {
      const winner = await getChannelAccount(
        bundle.db,
        { tenantId: input.tenantId },
        ownNow.id,
      );
      if (winner) return c.json(await serializeChannelWithAvatar(bundle, winner), 200);
    }
    return apiError(
      c,
      422,
      "CHANNEL_NOT_CONNECTED",
      "This Meta account is already connected to this workspace",
    );
  }

  await fetchAndStoreMetaAccountPhoto(
    bundle,
    client,
    input.provider,
    input.tenantId,
    row.id,
    accountExternalId,
  );
  return finishSavedConnect(row, 201);
}

/**
 * Ambil & simpan foto profil Page/akun IG sesudah connect (Fase 7A,
 * pola 6D; Hotfix R1): memakai token yang sedang di tangan dan kini
 * DI-AWAIT (dengan batas lunak `awaitPhotoFetch`) sebelum respons
 * connect disusun — avatarUrl langsung termuat di respons, bukan
 * muncul sesudah refresh. Permukaan per provider dipilih klien
 * (Page: tepi /picture; akun IG: field profile_picture_url — /picture
 * TIDAK bekerja untuk akun IG, itulah sebab foto IG tidak pernah
 * tersimpan sebelum R1). Kegagalan foto tidak pernah menggagalkan
 * connect. Byte disimpan ke `profile_photos`; URL CDN Graph tidak
 * diedarkan ke klien.
 */
async function fetchAndStoreMetaAccountPhoto(
  bundle: AuthBundle,
  client: MetaGraphClient,
  provider: MetaProvider,
  tenantId: string,
  channelAccountId: string,
  accountExternalId: string,
): Promise<void> {
  const work = (async () => {
    try {
      const picture = await client.getChannelProfilePicture(
        provider,
        accountExternalId,
      );
      if (!picture) return;
      await storeProfilePhoto(bundle.db, { tenantId }, {
        ownerType: "channel_account",
        ownerId: channelAccountId,
        contentType: picture.contentType,
        data: picture.data,
      });
    } catch {
      console.error(
        `[meta] pengambilan foto profil akun ${channelAccountId} gagal`,
      );
    }
  })();
  await awaitPhotoFetch(work);
}

/**
 * Menghubungkan nomor WhatsApp (Fase 7B — token-based v1, pola Meta 7A):
 * 1. Validasi ke Graph: `GET /{phone_number_id}?fields=verified_name,display_phone_number`
 *    dengan Access Token yang ditempel (pola resmi: token System User
 *    permanen dari Meta Business Settings). Graph menolak → 422
 *    META_TOKEN_INVALID; Graph tak terjangkau → 503.
 * 2. Penjaga satu nomor = satu koneksi (kode generik Meta): nomor yang
 *    sama masih AKTIF di workspace lain → 409
 *    META_ACCOUNT_ALREADY_CONNECTED (tanpa baris baru). Workspace ini:
 *    'connected' → idempoten 200; 'disconnected'/'error' → revive baris
 *    yang sama. WABA ID yang sama di tenant/nomor lain BUKAN konflik —
 *    satu WABA sah menaungi banyak nomor.
 * 3. Buat akun: external_id = phone_number_id; WABA ID →
 *    parent_external_id; displayName dari form atau verified_name;
 *    public_handle = display_phone_number; token TERENKRIPSI.
 * 4. Foto profil bisnis diambil best-effort (whatsapp_business_profile)
 *    — kegagalan/kosong tidak menggagalkan connect; kartu jatuh ke
 *    inisial. Foto profil KONTAK WhatsApp tidak ada di API (privasi),
 *    jadi tidak ada pengambilan foto kontak untuk provider ini.
 * 5. WABA di-subscribe ke aplikasi (`POST /{waba-id}/subscribed_apps`)
 *    — WAJIB untuk jalur tempel token: OAuth Unified Login melakukannya
 *    otomatis, jalur manual tidak, dan tanpa langganan itu pesan masuk
 *    tidak pernah dikirim Meta ke webhook kita. Best-effort: gagal →
 *    peringatan META_SUBSCRIBE_FAILED, koneksi tetap aktif.
 */
async function connectWhatsApp(
  c: Parameters<typeof apiError>[0],
  bundle: AuthBundle,
  opts: ChannelsModuleOptions,
  input: {
    tenantId: string;
    userId: string;
    displayName?: string;
    accessToken?: string;
    wabaId?: string;
    phoneNumberId?: string;
  },
) {
  if (!input.accessToken) {
    return apiError(c, 400, "VALIDATION_ERROR", "accessToken is required for whatsapp");
  }
  if (!input.phoneNumberId) {
    return apiError(c, 400, "VALIDATION_ERROR", "phoneNumberId is required for whatsapp");
  }
  if (!input.wabaId) {
    return apiError(c, 400, "VALIDATION_ERROR", "wabaId is required for whatsapp");
  }
  // Simpan sebagai konstanta: dipakai juga di dalam penutup connect
  // (closure) yang tidak mewarisi penyempitan tipe dari penjaga di atas.
  const accessToken = input.accessToken;
  const wabaId = input.wabaId;
  if (!opts.channelTokenSecret) {
    return apiError(c, 503, "INTERNAL_ERROR", "WhatsApp is not configured");
  }
  const client = new WhatsAppCloudClient({
    baseUrl: opts.metaApiBase,
    apiVersion: META_GRAPH_API_VERSION,
    accessToken: input.accessToken,
  });

  // Validasi token + ambil identitas publik nomor dari Graph.
  let profile;
  try {
    profile = await client.getPhoneNumberProfile(input.phoneNumberId);
  } catch (err) {
    if (err instanceof WhatsAppGraphError) {
      if (err.status === 0) {
        return apiError(c, 503, "INTERNAL_ERROR", "Meta Graph API is unreachable");
      }
      return apiError(c, 422, "META_TOKEN_INVALID", "Meta rejected the WhatsApp access token or phone number id");
    }
    return apiError(c, 503, "INTERNAL_ERROR", "Meta Graph API is unreachable");
  }

  let encryptedAccessToken: string;
  try {
    encryptedAccessToken = encryptChannelSecret(
      opts.channelTokenSecret,
      input.accessToken,
    );
  } catch {
    return apiError(c, 503, "INTERNAL_ERROR", "Channel credential encryption is not configured");
  }

  /**
   * Penutup connect untuk setiap jalur yang MENYIMPAN kredensial
   * (create, revive, dan connect ulang idempoten).
   *
   * LANGGANAN WABA (perbaikan celah yang ditemukan pemilik): jalur OAuth
   * Unified Login MENSUBSCRIBE WABA ke aplikasi secara otomatis,
   * sedangkan penyambungan lewat TEMPEL TOKEN tidak. Akibatnya token
   * valid dan webhook aplikasi benar, tetapi pesan masuk tidak pernah
   * tiba karena WABA belum berlangganan aplikasi ini — persis gejala
   * "nomor tersambung tetapi tidak menerima pesan". Di sini langganan
   * dilakukan eksplisit memakai token yang baru diserahkan.
   *
   * `POST /{waba-id}/subscribed_apps` bersifat idempoten, jadi jalur
   * connect ulang idempoten pun memanggilnya — itu sekaligus jalan
   * perbaikan bagi akun yang terhubung SEBELUM perbaikan ini ada
   * (cukup sambungkan ulang nomornya, tanpa memutus koneksi).
   * Kegagalan TIDAK menggagalkan koneksi: menjadi peringatan
   * META_SUBSCRIBE_FAILED pada respons, pola yang sama dengan varian
   * SUAT Instagram (7D.3) dan complete OAuth.
   */
  const finishSavedConnect = async (
    row: ChannelAccount,
    status: 200 | 201,
  ) => {
    const serialized = await serializeChannelWithAvatar(bundle, row);
    // WABA tersimpan adalah sumber kebenaran untuk akun yang sudah ada;
    // input form hanya cadangan bila baris lama belum menyimpannya.
    const waba = row.parentExternalId ?? wabaId;
    const warnings: Array<
      "META_SUBSCRIBE_FAILED" | "WHATSAPP_NUMBER_NOT_CONNECTED"
    > = [];

    // Status registrasi nomor (temuan pemeriksaan produksi): nomor
    // berstatus PENDING/RESTRICTED sudah terdaftar tetapi Meta TIDAK
    // mengirim pesan masuknya ke webhook — gejalanya sama dengan "belum
    // subscribe", jadi keduanya harus bisa dibedakan oleh operator.
    // Hanya dilaporkan bila Graph benar-benar menyertakan status.
    if (profile.status && profile.status.toUpperCase() !== "CONNECTED") {
      warnings.push("WHATSAPP_NUMBER_NOT_CONNECTED");
      console.error(
        `[whatsapp] nomor akun ${row.id} berstatus ${profile.status} — pesan masuk tidak akan tiba sampai statusnya CONNECTED`,
      );
    }

    try {
      const graph = new MetaGraphClient({
        baseUrl: opts.metaApiBase,
        apiVersion: META_GRAPH_API_VERSION,
        accessToken,
      });
      await graph.subscribeAppToObject(waba);
    } catch {
      warnings.push("META_SUBSCRIBE_FAILED");
      console.error(
        `[whatsapp] subscribe subscribed_apps WABA ${waba} untuk akun ${row.id} gagal — koneksi tetap aktif`,
      );
    }
    return c.json({ ...serialized, warnings }, status);
  };

  // Penjaga "satu nomor = satu koneksi" per phone_number_id.
  const existing = await lookupChannelAccountsByProviderExternalId(
    bundle.db,
    "whatsapp",
    input.phoneNumberId,
  );
  const activeElsewhere = existing.find(
    (r) => r.tenantId !== input.tenantId && r.status !== "disconnected",
  );
  if (activeElsewhere) {
    return apiError(
      c,
      409,
      "META_ACCOUNT_ALREADY_CONNECTED",
      "This WhatsApp number is already connected to another workspace",
    );
  }
  const own = existing.find((r) => r.tenantId === input.tenantId);
  if (own) {
    if (own.status === "connected") {
      const row = await getChannelAccount(
        bundle.db,
        { tenantId: input.tenantId },
        own.id,
      );
      if (row) return finishSavedConnect(row, 200);
    }
    // Akun milik workspace ini 'disconnected'/'error': hidupkan lagi
    // baris yang sama dengan kredensial baru (pola revive Meta).
    const updated = await updateWhatsAppChannelAccountCredentials(
      bundle.db,
      { tenantId: input.tenantId },
      own.id,
      {
        encryptedAccessToken,
        wabaId: input.wabaId,
        displayPhoneNumber: profile.displayPhoneNumber,
        verifiedName: profile.verifiedName,
        displayName: input.displayName,
        status: "connected",
        // Lifecycle 0010: token manual System User — varian tersimpan,
        // tanpa expiry terdokumentasi di jalur manual ini.
        tokenType: "system_user_token",
        tokenExpiresAt: null,
        tokenRefreshedAt: null,
      },
    );
    if (!updated) {
      return apiError(c, 404, "NOT_FOUND", "Channel not found");
    }
    await awaitPhotoFetch(
      fetchAndStoreWhatsAppAccountPhoto(
        bundle,
        client,
        input.tenantId,
        updated.id,
        input.phoneNumberId,
      ),
    );
    return finishSavedConnect(updated, 200);
  }

  let row: ChannelAccount;
  try {
    row = await createWhatsAppChannelAccount(
      bundle.db,
      { tenantId: input.tenantId, userId: input.userId },
      {
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        verifiedName: profile.verifiedName,
        displayPhoneNumber: profile.displayPhoneNumber,
        displayName: input.displayName,
        encryptedAccessToken,
        graphApiVersion: META_GRAPH_API_VERSION,
        // Lifecycle 0010: token manual System User (system_user_token).
        tokenType: "system_user_token",
        tokenExpiresAt: null,
      },
    );
  } catch {
    // Balapan dengan connect lain (pola Meta): petakan ulang dari
    // keadaan terbaru — milik workspace lain → 409 yang sama; milik
    // workspace ini → kembalikan akun pemenang balapan (idempoten).
    const now = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      "whatsapp",
      input.phoneNumberId,
    );
    const other = now.find(
      (r) => r.tenantId !== input.tenantId && r.status !== "disconnected",
    );
    if (other) {
      return apiError(
        c,
        409,
        "META_ACCOUNT_ALREADY_CONNECTED",
        "This WhatsApp number is already connected to another workspace",
      );
    }
    const ownNow = now.find(
      (r) => r.tenantId === input.tenantId && r.status !== "disconnected",
    );
    if (ownNow) {
      const winner = await getChannelAccount(
        bundle.db,
        { tenantId: input.tenantId },
        ownNow.id,
      );
      if (winner) return c.json(await serializeChannelWithAvatar(bundle, winner), 200);
    }
    return apiError(
      c,
      422,
      "CHANNEL_NOT_CONNECTED",
      "This WhatsApp number is already connected to this workspace",
    );
  }

  await awaitPhotoFetch(
    fetchAndStoreWhatsAppAccountPhoto(
      bundle,
      client,
      input.tenantId,
      row.id,
      input.phoneNumberId,
    ),
  );
  return finishSavedConnect(row, 201);
}

/**
 * Ambil & simpan foto profil bisnis WhatsApp sesudah connect (Fase 7B,
 * pola 6D/7A; Hotfix R1): foto profil bisnis MEMANG tersedia lewat
 * Cloud API (`whatsapp_business_profile.profile_picture_url`) dan
 * klien mengembalikan null untuk profil kosong/field tak tersedia,
 * jadi ketiadaan foto tidak pernah menggagalkan connect; kartu
 * menampilkan inisial. Kini di-await (batas lunak) agar respons
 * connect langsung memuat avatarUrl seperti provider lain.
 */
async function fetchAndStoreWhatsAppAccountPhoto(
  bundle: AuthBundle,
  client: WhatsAppCloudClient,
  tenantId: string,
  channelAccountId: string,
  phoneNumberId: string,
): Promise<void> {
  try {
    const picture = await client.getBusinessProfilePicture(phoneNumberId);
    if (!picture) return;
    await storeProfilePhoto(bundle.db, { tenantId }, {
      ownerType: "channel_account",
      ownerId: channelAccountId,
      contentType: picture.contentType,
      data: picture.data,
    });
  } catch {
    console.error(
      `[whatsapp] pengambilan foto profil bisnis akun ${channelAccountId} gagal`,
    );
  }
}
