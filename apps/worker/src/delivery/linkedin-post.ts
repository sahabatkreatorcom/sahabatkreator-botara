import type { Database } from "@sahabat-kreator/db";
import {
  claimPostForPublish,
  decryptChannelSecret,
  getPostForPublish,
  markPostFailed,
  markPostPublished,
  recordIntegrationLog,
  type PostPublishPayload,
} from "@sahabat-kreator/core";
import {
  LinkedInApiError,
  LinkedInClient,
  buildLinkedInPostPayload,
  linkedinErrorCode,
} from "@sahabat-kreator/channel-linkedin";
import type {
  PostPublisherAdapter,
  PostPublisherOptions,
  PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit LinkedIn (Gelombang 3) — publikasi saja, BUKAN inbox.
 *
 * Alurnya meniru adapter lain persis pada bagian yang menjaga keamanan
 * publikasi: klaim atomik dengan pencocokan jadwal lebih dulu, lalu
 * muat payload, dekripsi kredensial akun, kirim, dan tandai hasil.
 * Perbedaan LinkedIn ada pada sasaran dan media:
 *
 * - Sasaran = PROFIL PRIBADI anggota: author post adalah
 *   `urn:li:person:{member ID}` dari `provider_chat_id` sasaran, dan
 *   kredensialnya adalah access token OAuth (scope `w_member_social`)
 *   yang tersimpan terenkripsi pada akun channel seperti token
 *   provider lain. Company Page tidak diterbitkani dari sini —
 *   program Community Management LinkedIn adalah gerbang terpisah.
 * - Media dibaca sebagai BINER dari object store privat (pola
 *   Telegram/Bluesky/YouTube) lalu diunggah lewat Images/Videos API —
 *   LinkedIn tidak menuntut URL publik seperti API container
 *   Instagram/Threads, jadi model media privat repo tetap utuh.
 *   Campuran gambar+video dalam satu post ditolak sebelum provider
 *   dipanggil (Posts API tidak merangkainya sebagai satu konten —
 *   pola penolakan yang sama seperti Facebook Page).
 *
 * Satu-satunya percakapan yang disentuh adalah sasaran sintetis
 * `kind='channel'` milik profil LinkedIn itu sendiri.
 */

async function sendLinkedInPost(
  client: LinkedInClient,
  accessToken: string,
  payload: PostPublishPayload,
  mediaBinaries: Array<{
    data: Uint8Array;
    contentType: string;
    kind: "photo" | "video";
    fileName: string | null;
  }>,
): Promise<string> {
  const ownerUrn = `urn:li:person:${payload.chatId}`;
  const videos = mediaBinaries.filter((media) => media.kind === "video");
  const images = mediaBinaries.filter((media) => media.kind === "photo");
  if (videos.length > 0 && images.length > 0) {
    throw new Error("linkedin_media_combination_unsupported");
  }
  if (videos.length > 1) {
    throw new Error("linkedin_media_combination_unsupported");
  }

  if (videos.length === 1) {
    const video = videos[0]!;
    const urn = await client.uploadVideo({
      accessToken,
      ownerUrn,
      data: video.data,
      contentType: video.contentType,
    });
    const post = buildLinkedInPostPayload({
      memberId: payload.chatId,
      caption: payload.caption,
      video: { urn, title: video.fileName ?? "" },
    });
    const { postUrn } = await client.createPost({
      accessToken,
      payload: post,
    });
    return postUrn;
  }

  const uploadedImages: Array<{ urn: string; alt: string }> = [];
  for (const image of images) {
    const urn = await client.uploadImage({
      accessToken,
      ownerUrn,
      data: image.data,
      contentType: image.contentType,
    });
    uploadedImages.push({ urn, alt: image.fileName ?? "" });
  }
  const post = buildLinkedInPostPayload({
    memberId: payload.chatId,
    caption: payload.caption,
    images: uploadedImages,
  });
  const { postUrn } = await client.createPost({
    accessToken,
    payload: post,
  });
  return postUrn;
}

export async function publishLinkedInPost(
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
      provider: "linkedin",
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
  if (!payload.encryptedToken) return fail("linkedin_missing_credentials");
  if (!opts.channelTokenSecret) return fail("linkedin_token_secret_unset");
  const accessToken = decryptChannelSecret(
    opts.channelTokenSecret,
    payload.encryptedToken,
  );
  if (!accessToken) return fail("linkedin_token_undecryptable");

  // Media divalidasi & dibaca SEBELUM unggahan pertama: campuran
  // gambar+video dan dokumen adalah kegagalan yang sudah pasti, dan
  // tidak boleh dibayar dengan unggahan aset yang yatim di LinkedIn.
  const hasPhoto = payload.media.some((item) => item.kind === "photo");
  const hasVideo = payload.media.some((item) => item.kind === "video");
  if (hasPhoto && hasVideo) {
    return fail("linkedin_media_combination_unsupported");
  }
  const mediaBinaries: Array<{
    data: Uint8Array;
    contentType: string;
    kind: "photo" | "video";
    fileName: string | null;
  }> = [];
  for (const item of payload.media) {
    if (item.kind !== "photo" && item.kind !== "video") {
      // Capability sudah menolak dokumen saat penjadwalan; ini
      // pertahanan terakhir bila data berubah di antara keduanya.
      return fail("linkedin_media_kind_unsupported");
    }
    const object = await opts.mediaStore.get(item.r2Key);
    if (!object) return fail("post_media_missing");
    mediaBinaries.push({
      data: new Uint8Array(object.data),
      contentType:
        item.mimeType ??
        object.contentType ??
        (item.kind === "video" ? "video/mp4" : "image/jpeg"),
      kind: item.kind,
      fileName: item.fileName,
    });
  }

  const client = new LinkedInClient({ baseUrl: opts.linkedinApiBase });

  try {
    const providerPostId = await sendLinkedInPost(
      client,
      accessToken,
      payload,
      mediaBinaries,
    );
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: providerPostId,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "linkedin",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary: `channel post ${input.postId} published`,
    });
    console.log(`[post] ${input.postId} terbit (${providerPostId})`);
    return { published: true };
  } catch (err) {
    const code =
      err instanceof LinkedInApiError
        ? linkedinErrorCode(err)
        : err instanceof Error && /^[a-z_]+$/.test(err.message)
          ? err.message
          : linkedinErrorCode(err);
    const detail =
      err instanceof LinkedInApiError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

export const linkedinPostPublisher: PostPublisherAdapter = {
  provider: "linkedin",
  publish: publishLinkedInPost,
};
