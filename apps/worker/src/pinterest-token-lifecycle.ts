import type { Database } from "@sahabat-kreator/db";
import {
  PinterestApiError,
  PinterestClient,
} from "@sahabat-kreator/channel-pinterest";
import {
  applyMetaTokenLifecycleUpdate,
  decryptChannelSecret,
  encryptChannelSecret,
  getProviderSecret,
  listExpiringPinterestTokens,
  markChannelAccountAuthError,
  pinterestTokenLifecycleDecision,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";

/**
 * Runner lifecycle token Pinterest — pola runner TikTok: pindai akun
 * Pinterest AKTIF yang access token-nya mendekati kedaluwarsa
 * (jendela default 7 hari; token Pinterest ±30 hari) dan segarkan
 * via grant `refresh_token` API v5 SEBELUM mati, memakai kredensial
 * aplikasi Panel Admin (pinterest_app_id + pinterest_app_secret,
 * env hanya fallback) untuk Basic auth token endpoint.
 *
 * Rotasi: tulisan hasil refresh menyimpan access token baru dan —
 * HANYA bila grant menerbitkan refresh token baru — refresh token
 * baru, pada SATU tulisan atomik yang sama (applyMetaTokenLifecycleUpdate);
 * bila grant tidak menerbitkan refresh baru, yang lama dipertahankan
 * (refresh berkelanjutan Pinterest memang tidak selalu merotasi).
 * Kegagalan otorisasi refresh (401 — refresh mati/dicabut) menandai
 * akun 'error' `pinterest_unauthorized` + kesehatan 'expired' agar
 * pemilik menghubungkan ulang. Token TIDAK PERNAH masuk log.
 */
export interface PinterestTokenLifecycleDeps {
  db: Database;
  /** Resolver Panel Admin: pinterest_app_id + pinterest_app_secret. */
  platform: PlatformSettingsOptions;
  /** Kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL API Pinterest (env PINTEREST_API_BASE; default api.pinterest.com). */
  pinterestApiBase?: string;
  /** Window peringatan (hari) sebelum kedaluwarsa; default 7. */
  withinDays?: number;
}

export interface PinterestTokenLifecycleRunResult {
  scanned: number;
  refreshed: number;
  /** Peringatan ditulis (varian tak refreshable / konfigurasi kurang). */
  warned: number;
  /** Akun ditandai 'error' karena refresh ditolak provider. */
  authErrored: number;
  failed: number;
}

/** Jeda antar pemanggilan Pinterest API satu akun (sopan ke rate limit). */
const INTER_ACCOUNT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPinterestTokenLifecycle(
  deps: PinterestTokenLifecycleDeps,
): Promise<PinterestTokenLifecycleRunResult> {
  const result: PinterestTokenLifecycleRunResult = {
    scanned: 0,
    refreshed: 0,
    warned: 0,
    authErrored: 0,
    failed: 0,
  };

  const [appId, appSecret] = await Promise.all([
    getProviderSecret(deps.db, "pinterest_app_id", deps.platform),
    getProviderSecret(deps.db, "pinterest_app_secret", deps.platform),
  ]);
  const canRefresh = Boolean(appId && appSecret && deps.channelTokenSecret);
  if (!canRefresh) {
    console.warn(
      "[worker] lifecycle token Pinterest: kredensial aplikasi/kunci channel belum lengkap — hanya penandaan expiring/expired",
    );
  }

  const refs = await listExpiringPinterestTokens(deps.db, {
    withinDays: deps.withinDays ?? 7,
  });
  result.scanned = refs.length;
  if (refs.length === 0) return result;

  const client = new PinterestClient({ baseUrl: deps.pinterestApiBase });

  for (const ref of refs) {
    const now = new Date();
    const decision = pinterestTokenLifecycleDecision({
      tokenType: ref.tokenType,
      tokenExpiresAt: ref.tokenExpiresAt,
      now,
      canRefresh,
      hasRefreshToken: Boolean(ref.refreshTokenEncrypted),
    });
    try {
      if (decision.action === "refresh") {
        const refreshToken =
          ref.refreshTokenEncrypted && deps.channelTokenSecret
            ? decryptChannelSecret(
                deps.channelTokenSecret,
                ref.refreshTokenEncrypted,
              )
            : null;
        if (!refreshToken) {
          await applyMetaTokenLifecycleUpdate(deps.db, ref, {
            tokenHealth: decision.health,
          });
          result.warned += 1;
          continue;
        }
        const refreshed = await client.refreshPinterestAccessToken({
          appId: appId!,
          appSecret: appSecret!,
          refreshToken,
        });
        const expiresAt = refreshed.expiresInSeconds
          ? new Date(Date.now() + refreshed.expiresInSeconds * 1000)
          : ref.tokenExpiresAt;
        await applyMetaTokenLifecycleUpdate(deps.db, ref, {
          encryptedAccessToken: encryptChannelSecret(
            deps.channelTokenSecret!,
            refreshed.accessToken,
          ),
          ...(refreshed.refreshToken
            ? {
                encryptedRefreshToken: encryptChannelSecret(
                  deps.channelTokenSecret!,
                  refreshed.refreshToken,
                ),
              }
            : {}),
          tokenExpiresAt: expiresAt,
          tokenRefreshedAt: now,
          tokenHealth: "ok",
        });
        result.refreshed += 1;
      } else {
        await applyMetaTokenLifecycleUpdate(deps.db, ref, {
          tokenHealth: decision.health,
        });
        result.warned += 1;
      }
    } catch (err) {
      const isAuthError = err instanceof PinterestApiError && err.status === 401;
      if (isAuthError) {
        // Refresh token mati/dicabut — tandai akun 'error'.
        try {
          await markChannelAccountAuthError(
            deps.db,
            { tenantId: ref.tenantId },
            ref.channelAccountId,
            "pinterest_unauthorized",
          );
          await applyMetaTokenLifecycleUpdate(deps.db, ref, {
            tokenHealth: "expired",
          });
          result.authErrored += 1;
          await sleep(INTER_ACCOUNT_DELAY_MS);
          continue;
        } catch (markErr) {
          console.error(
            `[worker] lifecycle token Pinterest: penandaan error akun ${ref.channelAccountId} gagal`,
            markErr,
          );
        }
      }
      result.failed += 1;
      console.error(
        `[worker] lifecycle token Pinterest: gagal memproses akun ${ref.channelAccountId} (pinterest ${ref.externalId}):`,
        err,
      );
    }
    await sleep(INTER_ACCOUNT_DELAY_MS);
  }
  return result;
}
