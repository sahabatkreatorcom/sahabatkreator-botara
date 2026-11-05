/**
 * Worker lifecycle token Meta (lifecycle 0010) — SATU putaran pemindaian:
 * pindai akun Meta aktif yang tokennya mendekati/melewati kedaluwarsa
 * (listExpiringMetaTokens, lengan RLS `meta_token_lifecycle_scan`), lalu
 * per akun ambil keputusan (metaTokenLifecycleDecision):
 * - varian refreshable (system_user_token/business_token) + konfigurasi
 *   lengkap (appId+appSecret+CHANNEL_TOKEN_SECRET) → refresh `tbft`
 *   (refreshSystemUserToken), simpan token baru + jadwal kedaluwarsa;
 * - varian lain (Page token/warisan) atau konfigurasi kurang → tandai
 *   kesehatan "expiring"/"expired" sebagai peringatan hubungkan ulang;
 * - refresh yang ditolak Graph 190 → akun 'error' (meta_graph_190) +
 *   kesehatan "expired", sama seperti runner pengiriman.
 *
 * Modul ini SENGAJA bukan bagian @sahabat-kreator/core: ia butuh env &
 * resolver platform milik proses worker (pola deps worker), dan
 * src/index.ts TIDAK boleh diimpor skrip (ia menjalankan boot loop).
 * Worker memanggilnya tiap 6 jam; skrip scripts/meta-token-lifecycle.ts
 * memanggilnya sekali untuk operasi manual.
 */
import {
  MetaGraphClient,
  MetaGraphError,
} from "@sahabat-kreator/channel-messenger";
import { META_GRAPH_API_VERSION } from "@sahabat-kreator/config";
import type { Database } from "@sahabat-kreator/db";
import {
  applyMetaTokenLifecycleUpdate,
  decryptChannelSecret,
  encryptChannelSecret,
  getPlatformPublicConfig,
  getProviderSecret,
  listExpiringMetaTokens,
  markChannelAccountAuthError,
  metaTokenLifecycleDecision,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";

export interface MetaTokenLifecycleDeps {
  db: Database;
  /** Resolver panel → env untuk meta_app_id & meta_app_secret. */
  platform: PlatformSettingsOptions;
  /** Kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string;
  /** Window peringatan (hari) sebelum kedaluwarsa; default 7. */
  withinDays?: number;
}

export interface MetaTokenLifecycleRunResult {
  scanned: number;
  refreshed: number;
  /** Peringatan ditulis (varian tak refreshable / konfigurasi kurang). */
  warned: number;
  /** Akun ditandai 'error' karena refresh ditolak Graph 190. */
  authErrored: number;
  failed: number;
}

/** Jeda antar pemanggilan Graph satu akun (sopan ke rate limit). */
const INTER_ACCOUNT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runMetaTokenLifecycle(
  deps: MetaTokenLifecycleDeps,
): Promise<MetaTokenLifecycleRunResult> {
  const result: MetaTokenLifecycleRunResult = {
    scanned: 0,
    refreshed: 0,
    warned: 0,
    authErrored: 0,
    failed: 0,
  };

  const [publicConfig, appSecret] = await Promise.all([
    getPlatformPublicConfig(deps.db, deps.platform),
    getProviderSecret(deps.db, "meta_app_secret", deps.platform),
  ]);
  const appId = publicConfig.meta_app_id;
  const canRefresh =
    Boolean(appId) &&
    Boolean(appSecret) &&
    Boolean(deps.channelTokenSecret) &&
    Boolean(deps.metaApiBase);
  if (!canRefresh) {
    console.warn(
      "[worker] lifecycle token: refresh tidak terkonfigurasi (META_APP_ID/META_APP_SECRET/CHANNEL_TOKEN_SECRET/META_API_BASE) — hanya penandaan expiring/expired",
    );
  }

  const refs = await listExpiringMetaTokens(deps.db, {
    withinDays: deps.withinDays ?? 7,
  });
  result.scanned = refs.length;
  if (refs.length === 0) return result;

  for (const ref of refs) {
    const now = new Date();
    const decision = metaTokenLifecycleDecision({
      tokenType: ref.tokenType,
      tokenExpiresAt: ref.tokenExpiresAt,
      now,
      canRefresh,
    });
    try {
      if (decision.action === "refresh") {
        const token =
          ref.accessTokenEncrypted && deps.channelTokenSecret
            ? decryptChannelSecret(deps.channelTokenSecret, ref.accessTokenEncrypted)
            : null;
        if (!token) {
          // Kredensial tak bisa dibuka (kunci berubah?) — peringatkan.
          await applyMetaTokenLifecycleUpdate(deps.db, ref, {
            tokenHealth: decision.health,
          });
          result.warned += 1;
          continue;
        }
        const client = new MetaGraphClient({
          baseUrl: deps.metaApiBase,
          apiVersion: META_GRAPH_API_VERSION,
          accessToken: token,
        });
        const refreshedToken = await client.refreshSystemUserToken({
          clientId: appId!,
          clientSecret: appSecret!,
        });
        const expiresAt = refreshedToken.expiresInSeconds
          ? new Date(Date.now() + refreshedToken.expiresInSeconds * 1000)
          : ref.tokenExpiresAt;
        await applyMetaTokenLifecycleUpdate(deps.db, ref, {
          encryptedAccessToken: encryptChannelSecret(
            deps.channelTokenSecret!,
            refreshedToken.accessToken,
          ),
          tokenExpiresAt: expiresAt,
          tokenRefreshedAt: now,
          tokenHealth: "ok",
        });
        result.refreshed += 1;
      } else {
        // Varian tak refreshable (Page token/warisan) atau konfigurasi
        // kurang: tandai kesehatan supaya UI meminta hubungkan ulang
        // sebelum token mati.
        await applyMetaTokenLifecycleUpdate(deps.db, ref, {
          tokenHealth: decision.health,
        });
        result.warned += 1;
      }
    } catch (err) {
      if (err instanceof MetaGraphError && err.graphCode === 190) {
        // Token sudah ditolak Graph — tandai akun 'error' (pola runner).
        try {
          await markChannelAccountAuthError(
            deps.db,
            { tenantId: ref.tenantId },
            ref.channelAccountId,
            "meta_graph_190",
          );
          await applyMetaTokenLifecycleUpdate(deps.db, ref, {
            tokenHealth: "expired",
          });
          result.authErrored += 1;
          await sleep(INTER_ACCOUNT_DELAY_MS);
          continue;
        } catch (markErr) {
          console.error(
            `[worker] lifecycle token: penandaan error akun ${ref.channelAccountId} gagal`,
            markErr,
          );
        }
      }
      result.failed += 1;
      console.error(
        `[worker] lifecycle token: gagal memproses akun ${ref.channelAccountId} (${ref.provider} ${ref.externalId}):`,
        err,
      );
    }
    await sleep(INTER_ACCOUNT_DELAY_MS);
  }
  return result;
}

