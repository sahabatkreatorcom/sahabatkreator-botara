import type { Database } from "@sahabat-kreator/db";
import {
  claimPostForPublish,
  getPostForPublish,
  getYouTubePublishAccess,
  markPostFailed,
  markPostPublished,
  recordIntegrationLog,
} from "@sahabat-kreator/core";
import {
  YouTubeApiError,
  YouTubeClient,
  buildYouTubeVideoMetadata,
  youtubeErrorCode,
  type YouTubePrivacyStatus,
} from "@sahabat-kreator/channel-youtube";
import type {
  PostPublisherAdapter,
  PostPublisherOptions,
  PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit YouTube (Gelombang 2) — publikasi saja, BUKAN inbox.
 *
 * Alurnya meniru adapter lain persis pada bagian yang menjaga keamanan
 * publikasi: klaim atomik dengan pencocokan jadwal lebih dulu, lalu
 * muat payload, siapkan kredensial, kirim, dan tandai hasil. Perbedaan
 * YouTube ada pada kredensial dan bentuk konten:
 *
 * - Kredensial BUKAN token pada akun channel (`payload.encryptedToken`
 *   memang NULL untuk youtube dan SENGAJA tidak dibaca di sini).
 *   Access token ditukar dari refresh token KONEKSI GOOGLE tenant
 *   oleh core (`getYouTubePublishAccess`) — koneksi yang sama dengan
 *   Google Calendar, scope `youtube.upload` diperiksa di sana.
 * - Konten = tepat SATU video (capability menolak selain itu saat
 *   penjadwalan; pemeriksaan di sini pertahanan terakhir). Biner
 *   dibaca dari object store privat lalu diunggah resumable — YouTube
 *   tidak menuntut URL publik seperti API container IG/Threads.
 * - `privacyStatus` dari konfigurasi platform (env
 *   YOUTUBE_PRIVACY_STATUS, bawaan `private`): aplikasi Google yang
 *   belum terverifikasi dikunci Google ke private, dan bawaan aman
 *   yang sama dipakai sampai pemilik menaikkannya dengan sadar.
 * - Kuota `videos.insert` (1600/10.000 unit per proyek per hari)
 *   dipetakan ke kode khusus `youtube_quota_exceeded` oleh paket
 *   channel — operator harus bisa membedakan "kuota proyek habis"
 *   dari "kanal tenant bermasalah".
 *
 * Satu-satunya percakapan yang disentuh adalah sasaran sintetis
 * `kind='channel'` milik kanal YouTube itu sendiri.
 */

export async function publishYouTubePost(
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
      provider: "youtube",
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
  if (!opts.google) return fail("youtube_not_connected");

  // Media divalidasi & dibaca SEBELUM token ditukar: postingan yang
  // medianya hilang/rusak tidak boleh membakar satu refresh token
  // (dan tidak boleh menyentuh kuota) untuk kegagalan yang pasti.
  if (
    payload.media.length !== 1 ||
    payload.media[0]!.kind !== "video"
  ) {
    return fail("youtube_media_kind_unsupported");
  }
  const media = payload.media[0]!;
  const object = await opts.mediaStore.get(media.r2Key);
  if (!object) return fail("post_media_missing");
  const data = new Uint8Array(object.data);
  const contentType = media.mimeType ?? object.contentType ?? "video/mp4";

  const access = await getYouTubePublishAccess(db, input.tenantId, opts.google);
  if (access.kind === "not_connected") return fail("youtube_not_connected");
  if (access.kind === "scope_missing") return fail("youtube_scope_missing");

  const privacyStatus = (opts.youtubePrivacyStatus ??
    "private") as YouTubePrivacyStatus;
  const metadata = buildYouTubeVideoMetadata({
    title: payload.title,
    caption: payload.caption,
    privacyStatus,
  });
  const client = new YouTubeClient({
    baseUrl: opts.google.bases?.apiBase,
  });

  try {
    const { videoId } = await client.uploadVideo({
      accessToken: access.accessToken,
      metadata,
      data,
      contentType,
    });
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: videoId,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "youtube",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary: `channel post ${input.postId} published`,
    });
    console.log(`[post] ${input.postId} terbit (${videoId})`);
    return { published: true };
  } catch (err) {
    const code = youtubeErrorCode(err);
    const detail =
      err instanceof YouTubeApiError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

export const youtubePostPublisher: PostPublisherAdapter = {
  provider: "youtube",
  publish: publishYouTubePost,
};
