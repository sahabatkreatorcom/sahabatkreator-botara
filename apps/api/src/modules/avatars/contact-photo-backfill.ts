import {
  decryptChannelSecret,
  fetchAndStoreMetaContactProfile,
  fetchAndStoreTelegramProfilePhoto,
  type ContactPhotoFetchCandidate,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";

/**
 * Backfill malas foto profil KONTAK (pendamping backfill foto akun
 * channel di modules/channels) — untuk kontak DM yang identitasnya
 * terbuat SEBELUM jalur ambil foto saat pesan masuk ada, atau yang
 * pengambilan pertamanya gagal / memang belum berfoto saat itu.
 *
 * Pemicu pesan masuk (telegram/process.ts, meta/process.ts) hanya
 * menembak SEKALI saat identitas pertama kali terbuat; tanpa backfill
 * ini, satu kegagalan Graph/Bot API membuat kontak berinisial selamanya
 * sampai reconnect — padahal identitas + token akun yang tersimpan
 * cukup untuk mencoba lagi. Saat daftar inbox/kontak dibaca, kontak
 * tanpa foto yang punya kandidat (core `listContactPhotoFetchCandidates`
 * — hanya telegram/messenger/instagram, satu-satunya provider dengan
 * jalur foto kontak resmi) dijadwalkan pengambilannya di sini:
 * fire-and-forget, foto muncul sendiri di pembacaan berikutnya.
 *
 * Penjaga per proses meniru pola backfill channel persis: dedup
 * in-flight per kontak + cache negatif 15 menit (kontak memang tidak
 * berfoto / pengambilan gagal) agar provider tidak dipanggil berulang
 * pada setiap pemuatan daftar. Batas per panggilan menjauhkan ledakan
 * panggilan saat daftar besar pertama kali dibuka; sisa kandidat
 * diambil putaran pemuatan berikutnya (yang berhasil berfoto gugur
 * dari kandidat dengan sendirinya).
 */
export interface ContactPhotoBackfillOptions {
  /** Rahasia dekripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL Bot API (env TELEGRAM_API_BASE; default api.telegram.org). */
  telegramApiBase?: string;
  /** Base URL Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string;
  /** Versi Graph ter-pin (packages/config lewat pemanggil). */
  graphApiVersion?: string;
}

const backfillInFlight = new Set<string>();
const backfillNegative = new Map<string, number>();
const BACKFILL_NEGATIVE_TTL_MS = 15 * 60 * 1000;
const BACKFILL_MAX_PER_CALL = 8;

/**
 * Saring id kontak yang MASIH layak dijadwalkan (tidak sedang berjalan,
 * tidak di cache negatif) — pemanggil memakai ini untuk membatasi
 * kueri kandidat hanya pada kontak yang memang akan dikerjakan.
 */
export function pendingContactPhotoBackfillIds(contactIds: string[]): string[] {
  const now = Date.now();
  return contactIds.filter((id) => {
    if (backfillInFlight.has(id)) return false;
    const lastNegative = backfillNegative.get(id);
    return (
      lastNegative === undefined ||
      now - lastNegative >= BACKFILL_NEGATIVE_TTL_MS
    );
  });
}

/**
 * Jadwalkan pengambilan foto untuk kandidat-kandidat ini. Tidak pernah
 * melempar dan tidak pernah ditunggu pemanggil — semua helper core yang
 * dipanggil sendiri fail-soft; penjaga di sini hanya mengatur ritme.
 */
export function scheduleContactPhotoBackfills(
  bundle: AuthBundle,
  opts: ContactPhotoBackfillOptions | undefined,
  tenantId: string,
  candidates: ContactPhotoFetchCandidate[],
): void {
  if (!opts?.channelTokenSecret) return;
  let scheduled = 0;
  for (const candidate of candidates) {
    if (scheduled >= BACKFILL_MAX_PER_CALL) break;
    if (backfillInFlight.has(candidate.contactId)) continue;
    const lastNegative = backfillNegative.get(candidate.contactId);
    if (
      lastNegative !== undefined &&
      Date.now() - lastNegative < BACKFILL_NEGATIVE_TTL_MS
    ) {
      continue;
    }
    // Meta tanpa versi Graph ter-pin tidak bisa memanggil helper-nya;
    // lewati tanpa menandai negatif (konfigurasi, bukan kegagalan).
    if (candidate.provider !== "telegram" && !opts.graphApiVersion) continue;
    const accessToken = decryptChannelSecret(
      opts.channelTokenSecret,
      candidate.accessTokenEncrypted,
    );
    if (!accessToken) continue;
    backfillInFlight.add(candidate.contactId);
    scheduled += 1;
    const work =
      candidate.provider === "telegram"
        ? fetchAndStoreTelegramProfilePhoto(bundle.db, {
            tenantId,
            botToken: accessToken,
            telegramApiBase: opts.telegramApiBase,
            telegramUserId: candidate.externalUserId,
            ownerType: "contact",
            ownerId: candidate.contactId,
          })
        : fetchAndStoreMetaContactProfile(bundle.db, {
            tenantId,
            accessToken,
            metaApiBase: opts.metaApiBase,
            graphApiVersion: opts.graphApiVersion as string,
            provider: candidate.provider,
            senderExternalId: candidate.externalUserId,
            contactId: candidate.contactId,
          });
    void work
      .then((stored) => {
        if (stored) backfillNegative.delete(candidate.contactId);
        else backfillNegative.set(candidate.contactId, Date.now());
      })
      .catch(() => {
        backfillNegative.set(candidate.contactId, Date.now());
      })
      .finally(() => {
        backfillInFlight.delete(candidate.contactId);
      });
  }
}
