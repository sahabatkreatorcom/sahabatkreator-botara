/**
 * Worker lifecycle token Threads (integrasi Threads) — SATU putaran
 * pemindaian, sejajar `meta-token-lifecycle.ts` dengan perbedaan
 * mekanisme provider yang terdokumentasi:
 *
 * - Pindai akun Threads aktif yang tokennya mendekati/melewati
 *   kedaluwarsa (listExpiringThreadsTokens — lengan RLS pemindaian
 *   yang sama seperti Meta), lalu per akun ambil keputusan
 *   (threadsTokenLifecycleDecision):
 *   - varian `threads_user_token` → refresh grant `th_refresh_token`
 *     di graph.threads.net. Grant ini TIDAK memakai app secret —
 *     "konfigurasi lengkap" di sini hanya CHANNEL_TOKEN_SECRET untuk
 *     membuka & menyegel ulang envelope token (beda dari Meta yang
 *     juga butuh app id + secret untuk `tbft`).
 *   - varian lain / konfigurasi kurang → tandai kesehatan
 *     "expiring"/"expired" sebagai peringatan hubungkan ulang.
 *   - refresh yang ditolak Graph 190 → akun 'error'
 *     (threads_graph_190) + kesehatan "expired", pola runner Meta.
 * - Penulisan hasil memakai applyMetaTokenLifecycleUpdate: penulis
 *   kolom lifecycle (token terenkripsi, token_expires_at,
 *   token_refreshed_at, token_health) itu GENERIK per (tenant, akun)
 *   walau namanya historis Meta — tidak ada logika provider di
 *   dalamnya, jadi dipakai bersama alih-alih diduplikasi.
 *
 * Token tidak pernah masuk log. Worker memanggilnya pada tick yang
 * sama dengan lifecycle Meta (boot + tiap 6 jam); skrip
 * scripts/threads-token-lifecycle.ts memanggilnya sekali untuk
 * operasi manual.
 */
import {
  ThreadsGraphClient,
  ThreadsGraphError,
} from "@sahabat-kreator/channel-messenger";
import type { Database } from "@sahabat-kreator/db";
import {
  applyMetaTokenLifecycleUpdate,
  decryptChannelSecret,
  encryptChannelSecret,
  listExpiringThreadsTokens,
  markChannelAccountAuthError,
  threadsTokenLifecycleDecision,
} from "@sahabat-kreator/core";

export interface ThreadsTokenLifecycleDeps {
  db: Database;
  /** Kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Threads API (env THREADS_API_BASE; default graph.threads.net). */
  threadsApiBase?: string;
  /** Window peringatan (hari) sebelum kedaluwarsa; default 7. */
  withinDays?: number;
}

export interface ThreadsTokenLifecycleRunResult {
  scanned: number;
  refreshed: number;
  /** Peringatan ditulis (varian tak refreshable / konfigurasi kurang). */
  warned: number;
  /** Akun ditandai 'error' karena refresh ditolak Graph 190. */
  authErrored: number;
  failed: number;
}

/** Jeda antar pemanggilan Threads API satu akun (sopan ke rate limit). */
const INTER_ACCOUNT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runThreadsTokenLifecycle(
  deps: ThreadsTokenLifecycleDeps,
): Promise<ThreadsTokenLifecycleRunResult> {
  const result: ThreadsTokenLifecycleRunResult = {
    scanned: 0,
    refreshed: 0,
    warned: 0,
    authErrored: 0,
    failed: 0,
  };

  // Grant th_refresh_token tidak memakai kredensial aplikasi — satu-
  // satunya konfigurasi yang menentukan bisa-tidaknya refresh adalah
  // kunci envelope channel (untuk dekripsi + enkripsi ulang token).
  const canRefresh = Boolean(deps.channelTokenSecret);
  if (!canRefresh) {
    console.warn(
      "[worker] lifecycle token Threads: CHANNEL_TOKEN_SECRET kosong — hanya penandaan expiring/expired",
    );
  }

  const refs = await listExpiringThreadsTokens(deps.db, {
    withinDays: deps.withinDays ?? 7,
  });
  result.scanned = refs.length;
  if (refs.length === 0) return result;

  for (const ref of refs) {
    const now = new Date();
    const decision = threadsTokenLifecycleDecision({
      tokenType: ref.tokenType,
      tokenExpiresAt: ref.tokenExpiresAt,
      now,
      canRefresh,
    });
    try {
      if (decision.action === "refresh") {
        const token =
          ref.accessTokenEncrypted && deps.channelTokenSecret
            ? decryptChannelSecret(
                deps.channelTokenSecret,
                ref.accessTokenEncrypted,
              )
            : null;
        if (!token) {
          // Kredensial tak bisa dibuka (kunci berubah?) — peringatkan.
          await applyMetaTokenLifecycleUpdate(deps.db, ref, {
            tokenHealth: decision.health,
          });
          result.warned += 1;
          continue;
        }
        const client = new ThreadsGraphClient({
          baseUrl: deps.threadsApiBase,
          accessToken: token,
        });
        const refreshed = await client.refreshThreadsToken();
        const expiresAt = refreshed.expiresInSeconds
          ? new Date(Date.now() + refreshed.expiresInSeconds * 1000)
          : ref.tokenExpiresAt;
        await applyMetaTokenLifecycleUpdate(deps.db, ref, {
          encryptedAccessToken: encryptChannelSecret(
            deps.channelTokenSecret!,
            refreshed.accessToken,
          ),
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
      if (err instanceof ThreadsGraphError && err.graphCode === 190) {
        // Token sudah ditolak provider — tandai akun 'error'.
        try {
          await markChannelAccountAuthError(
            deps.db,
            { tenantId: ref.tenantId },
            ref.channelAccountId,
            "threads_graph_190",
          );
          await applyMetaTokenLifecycleUpdate(deps.db, ref, {
            tokenHealth: "expired",
          });
          result.authErrored += 1;
          await sleep(INTER_ACCOUNT_DELAY_MS);
          continue;
        } catch (markErr) {
          console.error(
            `[worker] lifecycle token Threads: penandaan error akun ${ref.channelAccountId} gagal`,
            markErr,
          );
        }
      }
      result.failed += 1;
      console.error(
        `[worker] lifecycle token Threads: gagal memproses akun ${ref.channelAccountId} (threads ${ref.externalId}):`,
        err,
      );
    }
    await sleep(INTER_ACCOUNT_DELAY_MS);
  }
  return result;
}
