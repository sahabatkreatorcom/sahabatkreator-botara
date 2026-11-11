import type { Database } from "@sahabat-kreator/db";
import {
  LINKEDIN_TOKEN_EXPIRED_ERROR_CODE,
  applyMetaTokenLifecycleUpdate,
  linkedinTokenLifecycleDecision,
  listExpiringLinkedInTokens,
  markChannelAccountAuthError,
} from "@sahabat-kreator/core";

/**
 * Runner lifecycle token LinkedIn — TANDAI-RECONNECT, BUKAN refresh.
 *
 * LinkedIn TIDAK menerbitkan refresh token untuk program standar
 * (Sign In with LinkedIn + Share on LinkedIn): access token ±60
 * hari dan sesudah itu satu-satunya jalan adalah login ulang. Jadi
 * runner ini SENGAJA tidak memanggil API LinkedIn sama sekali:
 * - akun yang tokennya mendekati kedaluwarsa (jendela default 7
 *   hari) ditandai kesehatan `expiring` — UI Channels menampilkan
 *   peringatan agar pemilik menghubungkan ulang SEBELUM mati;
 * - akun yang tokennya SUDAH lewat jadwal ditandai kesehatan
 *   `expired` DAN dipindahkan ke status 'error' dengan kode
 *   `linkedin_token_expired` (markChannelAccountAuthError — pola
 *   mesin lifecycle yang sama seperti penolakan refresh provider
 *   lain), karena token mati tidak akan pernah bisa menerbitkan
 *   lagi dan operator harus tahu.
 *
 * Tidak ada kredensial aplikasi yang dibutuhkan runner ini (tidak
 * ada panggilan provider) — ia murni pemindaian + penandaan DB.
 * Penulisan memakai penulis generik lifecycle
 * `applyMetaTokenLifecycleUpdate` (dipakai bersama Meta/Threads/
 * TikTok/Pinterest) dalam konteks tenant masing-masing.
 */
export interface LinkedInTokenLifecycleDeps {
  db: Database;
  /** Window peringatan (hari) sebelum kedaluwarsa; default 7. */
  withinDays?: number;
}

export interface LinkedInTokenLifecycleRunResult {
  scanned: number;
  /** Akun ditandai 'expiring' (belum lewat — peringatan hubungkan ulang). */
  warned: number;
  /** Akun yang sudah lewat jadwal → status 'error' linkedin_token_expired. */
  authErrored: number;
  failed: number;
}

export async function runLinkedInTokenLifecycle(
  deps: LinkedInTokenLifecycleDeps,
): Promise<LinkedInTokenLifecycleRunResult> {
  const result: LinkedInTokenLifecycleRunResult = {
    scanned: 0,
    warned: 0,
    authErrored: 0,
    failed: 0,
  };

  const refs = await listExpiringLinkedInTokens(deps.db, {
    withinDays: deps.withinDays ?? 7,
  });
  result.scanned = refs.length;

  for (const ref of refs) {
    const decision = linkedinTokenLifecycleDecision({
      tokenType: ref.tokenType,
      tokenExpiresAt: ref.tokenExpiresAt,
      now: new Date(),
    });
    try {
      if (decision.health === "expired") {
        // Token sudah mati: tandai akun error agar operator
        // menghubungkan ulang (pola penolakan refresh provider lain).
        await markChannelAccountAuthError(
          deps.db,
          { tenantId: ref.tenantId },
          ref.channelAccountId,
          LINKEDIN_TOKEN_EXPIRED_ERROR_CODE,
        );
        await applyMetaTokenLifecycleUpdate(deps.db, ref, {
          tokenHealth: "expired",
        });
        result.authErrored += 1;
      } else {
        await applyMetaTokenLifecycleUpdate(deps.db, ref, {
          tokenHealth: "expiring",
        });
        result.warned += 1;
      }
    } catch (err) {
      result.failed += 1;
      console.error(
        `[worker] lifecycle token LinkedIn: gagal memproses akun ${ref.channelAccountId} (linkedin ${ref.externalId}):`,
        err,
      );
    }
  }
  return result;
}
