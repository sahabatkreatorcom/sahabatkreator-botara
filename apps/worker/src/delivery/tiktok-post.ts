import type { Database } from "@sahabat-kreator/db";
import {
  claimPostForPublish,
  decryptChannelSecret,
  getPostForPublish,
  markPostFailed,
  markPostPublished,
  recordIntegrationLog,
} from "@sahabat-kreator/core";
import {
  TikTokApiError,
  TikTokClient,
  tiktokErrorCode,
  type TikTokPrivacyLevel,
} from "@sahabat-kreator/channel-tiktok";
import type {
  PostPublisherAdapter,
  PostPublisherOptions,
  PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit TikTok (Gelombang 4) — publikasi saja, BUKAN inbox.
 *
 * Alurnya meniru adapter lain persis pada bagian yang menjaga
 * keamanan publikasi: klaim atomik dengan pencocokan jadwal lebih
 * dulu, lalu muat payload, dekripsi kredensial akun, kirim, dan
 * tandai hasil. Perbedaan TikTok ada pada protokol dan gerbangnya:
 *
 * - Konten = tepat SATU video (capability menolak selain itu saat
 *   penjadwalan; pemeriksaan di sini pertahanan terakhir). Biner
 *   dibaca dari object store privat lalu diunggah FILE_UPLOAD per
 *   potongan oleh klien — TikTok tidak menuntut URL publik untuk
 *   video, sama seperti YouTube/Bluesky.
 * - Judul postingan TikTok adalah CAPTION post itu sendiri
 *   (`post_info.title`); kolom `title` post tidak dikirim ke
 *   platform dan tetap label internal kalender.
 * - GERBANG AUDIT: level privasi berasal dari konfigurasi platform
 *   (env TIKTOK_PRIVACY_LEVEL, bawaan `SELF_ONLY` — satu-satunya
 *   level yang diizinkan sebelum aplikasi pemilik lolos audit
 *   TikTok). Klien memvalidasinya terhadap `privacy_level_options`
 *   akun sebelum unggah; hasil terbit mencatat level privasinya di
 *   log integrasi, dan providerMessageId jatuh ke `publish_id` bila
 *   postingan tidak punya id publik (kasus SELF_ONLY) — postingan
 *   privat TIDAK pernah dicatat atau diklaim sebagai publik.
 * - Access token OAuth pada akun channel berumur ±24 jam dan repo
 *   belum punya penyegaran token generik untuk TikTok: token yang
 *   kedaluwarsa dipetakan klien ke `tiktok_unauthorized` agar
 *   operator menghubungkan ulang akun (batasan terdokumentasi di
 *   paket channel-tiktok + OWNER-ACTIONS).
 *
 * Satu-satunya percakapan yang disentuh adalah sasaran sintetis
 * `kind='channel'` milik akun TikTok itu sendiri.
 */

export async function publishTikTokPost(
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
      provider: "tiktok",
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
  if (!payload.encryptedToken) return fail("tiktok_missing_credentials");
  if (!opts.channelTokenSecret) return fail("tiktok_token_secret_unset");
  const accessToken = decryptChannelSecret(
    opts.channelTokenSecret,
    payload.encryptedToken,
  );
  if (!accessToken) return fail("tiktok_token_undecryptable");

  // Media divalidasi & dibaca SEBELUM API dipanggil: direct post
  // menuntut tepat satu video (capability menegakkannya saat
  // penjadwalan; pemeriksaan di sini pertahanan terakhir), dan
  // postingan yang medianya hilang tidak boleh membakar panggilan
  // creator_info/init untuk kegagalan yang pasti.
  if (payload.media.length !== 1 || payload.media[0]!.kind !== "video") {
    return fail("tiktok_media_kind_unsupported");
  }
  const media = payload.media[0]!;
  const object = await opts.mediaStore.get(media.r2Key);
  if (!object) return fail("post_media_missing");
  const data = new Uint8Array(object.data);
  const contentType = media.mimeType ?? object.contentType ?? "video/mp4";

  const privacyLevel = (opts.tiktokPrivacyLevel ??
    "SELF_ONLY") as TikTokPrivacyLevel;
  const client = new TikTokClient({ baseUrl: opts.tiktokApiBase });

  try {
    const result = await client.publishVideo({
      accessToken,
      // Judul postingan TikTok ADALAH caption; `title` post adalah
      // label internal kalender dan tidak dikirim ke platform.
      title: payload.caption,
      privacyLevel,
      data,
      contentType,
      pollIntervalMs: opts.tiktokStatusPollIntervalMs,
      maxPolls: opts.tiktokStatusMaxPolls,
    });
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: result.postId ?? result.publishId,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "tiktok",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary:
        `channel post ${input.postId} published ` +
        `(privacy ${result.privacyLevel}, status ${result.finalStatus})`,
    });
    console.log(
      `[post] ${input.postId} terbit (${result.postId ?? result.publishId}, ` +
        `privacy ${result.privacyLevel})`,
    );
    return { published: true };
  } catch (err) {
    const code = tiktokErrorCode(err);
    const detail =
      err instanceof TikTokApiError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

export const tiktokPostPublisher: PostPublisherAdapter = {
  provider: "tiktok",
  publish: publishTikTokPost,
};
