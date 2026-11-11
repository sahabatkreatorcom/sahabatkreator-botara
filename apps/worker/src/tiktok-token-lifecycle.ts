/**
 * Worker lifecycle token TikTok (gelombang Semua OAuth) — SATU
 * putaran pemindaian, sejajar `threads-token-lifecycle.ts` dengan
 * perbedaan mekanisme provider yang terdokumentasi:
 *
 * - Pindai akun TikTok aktif yang access token-nya mendekati/melewati
 *   kedaluwarsa (listExpiringTikTokTokens — lengan RLS pemindaian
 *   yang sama seperti Meta/Threads), lalu per akun ambil keputusan
 *   (tiktokTokenLifecycleDecision):
 *   - varian `tiktok_user_token` + refresh token tersimpan +
 *     kredensial aplikasi lengkap → refresh grant `refresh_token`
 *     Login Kit. Access token TikTok hanya ±24 jam, jadi dengan
 *     jendela pindai bawaan (7 hari) akun yang terhubung SELALU
 *     masuk pindaian dan disegarkan pada tick ini — itu memang
 *     jalur normalnya, bukan pengecualian. Grant menerbitkan
 *     access token BARU + refresh token BARU (rotasi penuh);
 *     keduanya disimpan atomik (applyMetaTokenLifecycleUpdate —
 *     penulis generik kolom lifecycle, dipakai bersama).
 *   - varian lain / refresh token tak ada / konfigurasi kurang →
 *     tandai kesehatan "expiring"/"expired" sebagai peringatan
 *     hubungkan ulang.
 *   - refresh yang ditolak TikTok dengan `refresh_token_invalid`
 *     (refresh token mati/dicabut) atau `access_token_invalid` →
 *     akun 'error' (`tiktok_refresh_token_invalid` /
 *     `tiktok_unauthorized`) + kesehatan "expired", pola runner
 *     Threads untuk Graph 190.
 * - "Konfigurasi lengkap" di sini = client key + client secret
 *   aplikasi (Panel Admin → env, getProviderSecret) untuk token
 *   endpoint + CHANNEL_TOKEN_SECRET untuk membuka & menyegel ulang
 *   envelope token.
 *
 * Inilah perbaikan atas batas Gelombang 4 ("refresh token otomatis
 * belum dibangun — hubungkan ulang manual"): batas itu tertutup di
 * sini. Token tidak pernah masuk log. Worker memanggilnya pada tick
 * yang sejajar lifecycle lain (boot + tiap 6 jam); skrip
 * scripts/tiktok-token-lifecycle.ts memanggilnya sekali untuk
 * operasi manual.
 */
import { TikTokApiError, TikTokClient } from "@sahabat-kreator/channel-tiktok";
import type { Database } from "@sahabat-kreator/db";
import {
  applyMetaTokenLifecycleUpdate,
  decryptChannelSecret,
  encryptChannelSecret,
  getProviderSecret,
  listExpiringTikTokTokens,
  markChannelAccountAuthError,
  tiktokTokenLifecycleDecision,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";

export interface TikTokTokenLifecycleDeps {
  db: Database;
  /** Resolver Panel Admin: tiktok_client_key + tiktok_client_secret. */
  platform: PlatformSettingsOptions;
  /** Kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL TikTok API (env TIKTOK_API_BASE; default open.tiktokapis.com). */
  tiktokApiBase?: string;
  /** Window peringatan (hari) sebelum kedaluwarsa; default 7. */
  withinDays?: number;
}

export interface TikTokTokenLifecycleRunResult {
  scanned: number;
  refreshed: number;
  /** Peringatan ditulis (varian tak refreshable / konfigurasi kurang). */
  warned: number;
  /** Akun ditandai 'error' karena refresh ditolak provider. */
  authErrored: number;
  failed: number;
}

/** Jeda antar pemanggilan TikTok API satu akun (sopan ke rate limit). */
const INTER_ACCOUNT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kode error akun untuk penolakan refresh TikTok (aman & stabil). */
function tiktokRefreshAuthErrorCode(err: TikTokApiError): string | null {
  if (err.providerCode === "refresh_token_invalid") {
    return "tiktok_refresh_token_invalid";
  }
  if (err.providerCode === "access_token_invalid" || err.status === 401) {
    return "tiktok_unauthorized";
  }
  return null;
}

export async function runTikTokTokenLifecycle(
  deps: TikTokTokenLifecycleDeps,
): Promise<TikTokTokenLifecycleRunResult> {
  const result: TikTokTokenLifecycleRunResult = {
    scanned: 0,
    refreshed: 0,
    warned: 0,
    authErrored: 0,
    failed: 0,
  };

  const [clientKey, clientSecret] = await Promise.all([
    getProviderSecret(deps.db, "tiktok_client_key", deps.platform),
    getProviderSecret(deps.db, "tiktok_client_secret", deps.platform),
  ]);
  const canRefresh = Boolean(clientKey && clientSecret && deps.channelTokenSecret);
  if (!canRefresh) {
    console.warn(
      "[worker] lifecycle token TikTok: kredensial aplikasi/kunci channel belum lengkap — hanya penandaan expiring/expired",
    );
  }

  const refs = await listExpiringTikTokTokens(deps.db, {
    withinDays: deps.withinDays ?? 7,
  });
  result.scanned = refs.length;
  if (refs.length === 0) return result;

  const client = new TikTokClient({ baseUrl: deps.tiktokApiBase });

  for (const ref of refs) {
    const now = new Date();
    const decision = tiktokTokenLifecycleDecision({
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
          // Refresh token tak bisa dibuka (kunci berubah?) — peringatkan.
          await applyMetaTokenLifecycleUpdate(deps.db, ref, {
            tokenHealth: decision.health,
          });
          result.warned += 1;
          continue;
        }
        const refreshed = await client.refreshTikTokAccessToken({
          clientKey: clientKey!,
          clientSecret: clientSecret!,
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
          // Rotasi penuh: refresh token baru menggantikan yang lama
          // pada tulisan yang sama. Bila grant tidak menerbitkan
          // refresh token baru (tak lazim), yang lama dipertahankan.
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
        // Varian tak refreshable atau konfigurasi kurang: tandai
        // kesehatan supaya UI meminta hubungkan ulang sebelum mati.
        await applyMetaTokenLifecycleUpdate(deps.db, ref, {
          tokenHealth: decision.health,
        });
        result.warned += 1;
      }
    } catch (err) {
      const authCode =
        err instanceof TikTokApiError
          ? tiktokRefreshAuthErrorCode(err)
          : null;
      if (authCode) {
        // Refresh token mati/dicabut — tandai akun 'error'.
        try {
          await markChannelAccountAuthError(
            deps.db,
            { tenantId: ref.tenantId },
            ref.channelAccountId,
            authCode,
          );
          await applyMetaTokenLifecycleUpdate(deps.db, ref, {
            tokenHealth: "expired",
          });
          result.authErrored += 1;
          await sleep(INTER_ACCOUNT_DELAY_MS);
          continue;
        } catch (markErr) {
          console.error(
            `[worker] lifecycle token TikTok: penandaan error akun ${ref.channelAccountId} gagal`,
            markErr,
          );
        }
      }
      result.failed += 1;
      console.error(
        `[worker] lifecycle token TikTok: gagal memproses akun ${ref.channelAccountId} (tiktok ${ref.externalId}):`,
        err,
      );
    }
    await sleep(INTER_ACCOUNT_DELAY_MS);
  }
  return result;
}
