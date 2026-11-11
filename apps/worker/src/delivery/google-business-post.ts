import type { Database } from "@sahabat-kreator/db";
import {
  claimPostForPublish,
  getGoogleBusinessPublishAccess,
  getPostForPublish,
  markPostFailed,
  markPostPublished,
  recordIntegrationLog,
} from "@sahabat-kreator/core";
import {
  GoogleBusinessApiError,
  GoogleBusinessClient,
  buildGoogleBusinessLocalPostPayload,
  googleBusinessErrorCode,
} from "@sahabat-kreator/channel-google-business";
import {
  resolvePostPublicMediaUrl,
  type PostPublisherAdapter,
  type PostPublisherOptions,
  type PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit Google Business Profile (Gelombang 3) — publikasi saja,
 * BUKAN inbox.
 *
 * Alurnya meniru adapter lain persis pada bagian yang menjaga
 * keamanan publikasi: klaim atomik dengan pencocokan jadwal lebih
 * dulu, lalu muat payload, siapkan kredensial, kirim, dan tandai
 * hasil. Perbedaan Google Business ada pada sasaran, kredensial,
 * dan media:
 *
 * - Sasaran = LOKASI bisnis: `provider_chat_id` sasaran adalah nama
 *   resource lokasi (`accounts/{a}/locations/{l}`) — satu postingan
 *   lokal terbit per lokasi, bukan per akun.
 * - Kredensial BUKAN token pada akun channel (`payload.encryptedToken`
 *   memang NULL untuk google_business dan SENGAJA tidak dibaca di
 *   sini). Access token ditukar dari refresh token KONEKSI GOOGLE
 *   tenant oleh core (`getGoogleBusinessPublishAccess`) — koneksi
 *   yang sama dengan Calendar/YouTube, scope `business.manage`
 *   diperiksa di sana.
 * - Media hanya SATU foto dan hanya dari URL publik (API postingan
 *   lokal tidak menerima biner): diselesaikan lewat resolver publik
 *   pola Instagram SEBELUM token ditukar, dan gagal aman dengan
 *   `google_business_public_media_url_unavailable`. Tanpa media,
 *   postingan teks terbit apa adanya.
 * - Kuota API bernilai 0 sampai pengajuan akses pemilik disetujui
 *   Google; penolakan akses terpetakan khusus oleh paket channel ke
 *   `google_business_permission_denied` / `google_business_quota_exceeded`
 *   agar bisa dibedakan dari kegagalan postingan biasa.
 *
 * Satu-satunya percakapan yang disentuh adalah sasaran sintetis
 * `kind='channel'` milik lokasi itu sendiri.
 */

export async function publishGoogleBusinessPost(
  db: Database,
  input: { tenantId: string; postId: string; scheduledAt: string },
  opts: PostPublisherOptions,
): Promise<PublishPostResult> {
  const ctx = { tenantId: input.tenantId };
  const claim = await claimPostForPublish(db, {
    tenantId: input.tenantId,
    postId: input.postId,
    expectedScheduledAt: new Date(input.scheduledAt),
  });
  if (claim.kind === "not_found") {
    console.error(`[post] ${input.postId} tidak ditemukan — job dilewati`);
    return { published: false, reason: "not_found" };
  }
  if (claim.kind === "skipped") {
    console.log(
      `[post] ${input.postId} dilewati: status=${claim.status} (jadwal ${input.scheduledAt})`,
    );
    return { published: false, reason: `status_${claim.status}` };
  }

  const fail = async (code: string): Promise<PublishPostResult> => {
    await markPostFailed(db, { ...ctx, postId: input.postId, errorCode: code });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "google_business",
      tenantId: input.tenantId,
      outcome: "failed",
      errorCode: code,
      summary: `channel post ${input.postId} failed`,
    });
    console.error(`[post] ${input.postId} gagal terbit: ${code}`);
    return { published: false, reason: code };
  };

  const payload = await getPostForPublish(db, {
    tenantId: input.tenantId,
    postId: input.postId,
  });
  if (!payload) return fail("post_target_missing");
  if (!opts.google) return fail("google_business_not_connected");

  // Media divalidasi & URL publiknya diselesaikan SEBELUM token
  // ditukar: postingan yang medianya tidak bisa diterbitkani tidak
  // boleh membakar satu refresh token untuk kegagalan yang pasti.
  let photoUrl: string | null = null;
  if (payload.media.length > 0) {
    if (payload.media.length !== 1 || payload.media[0]!.kind !== "photo") {
      return fail("google_business_media_kind_unsupported");
    }
    photoUrl = resolvePostPublicMediaUrl(opts, payload.media[0]!);
    if (!photoUrl) return fail("google_business_public_media_url_unavailable");
  }

  const access = await getGoogleBusinessPublishAccess(
    db,
    input.tenantId,
    opts.google,
  );
  if (access.kind === "not_connected") {
    return fail("google_business_not_connected");
  }
  if (access.kind === "scope_missing") {
    return fail("google_business_scope_missing");
  }

  const localPostPayload = buildGoogleBusinessLocalPostPayload({
    caption: payload.caption,
    photoUrl,
  });
  const client = new GoogleBusinessClient({
    baseUrl: opts.googleBusinessApiBase,
  });

  try {
    const { localPostName } = await client.createLocalPost({
      accessToken: access.accessToken,
      locationName: payload.chatId,
      payload: localPostPayload,
    });
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: localPostName,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "google_business",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary: `channel post ${input.postId} published`,
    });
    console.log(`[post] ${input.postId} terbit (${localPostName})`);
    return { published: true };
  } catch (err) {
    const code = googleBusinessErrorCode(err);
    const detail =
      err instanceof GoogleBusinessApiError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

export const googleBusinessPostPublisher: PostPublisherAdapter = {
  provider: "google_business",
  publish: publishGoogleBusinessPost,
};
