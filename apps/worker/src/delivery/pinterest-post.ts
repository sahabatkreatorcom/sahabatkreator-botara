import type { Database } from "@sahabat-kreator/db";
import {
  claimPostForPublish,
  decryptChannelSecret,
  getPinterestBoardChoice,
  getPostForPublish,
  markPostFailed,
  markPostPublished,
  recordIntegrationLog,
} from "@sahabat-kreator/core";
import {
  PINTEREST_BASE64_IMAGE_TYPES,
  PinterestApiError,
  PinterestClient,
  buildPinterestPinPayload,
  pinterestErrorCode,
  uint8ToBase64,
  type PinterestMediaSource,
} from "@sahabat-kreator/channel-pinterest";
import {
  resolvePostPublicMediaUrl,
  type PostPublisherAdapter,
  type PostPublisherOptions,
  type PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit Pinterest (Gelombang 3) — publikasi saja, BUKAN inbox.
 *
 * Alurnya meniru adapter lain persis pada bagian yang menjaga keamanan
 * publikasi: klaim atomik dengan pencocokan jadwal lebih dulu, lalu
 * muat payload, dekripsi kredensial akun, kirim, dan tandai hasil.
 * Perbedaan Pinterest ada pada bentuk konten dan media:
 *
 * - Satu post = satu Pin pada board tujuan. Resolusi board
 *   BERLAPIS (gelombang Pilihan Privasi & AI memindahkan pilihan
 *   board ke postingan): (1) board pada opsi postingan ini —
 *   dipilih pengguna di formulir /posts; (2) pilihan board per
 *   akun dari pemilih board Channels (bawaan akun); (3) board
 *   pertama akun. Resolver klien (`resolvePinBoard`) memvalidasi
 *   lapis teratas yang terisi terhadap daftar board hidup akun;
 *   pilihan yang sudah hilang di Pinterest turun ke board pertama
 *   DENGAN catatan log yang menyebut lapis asalnya; akun tanpa
 *   board sama sekali gagal aman `pinterest_board_missing`.
 *   Judul Pin dari `title` post, deskripsi dari caption, tautan
 *   tujuan dari URL pertama di caption — semua dirangkai
 *   pembangun murni di paket channel.
 * - Media gambar JPEG/PNG dikirim sebagai `image_base64` dari biner
 *   object store privat (pola biner repo — tanpa URL publik). Format
 *   gambar lain yang diterima Pinterest (GIF) memakai `image_url`
 *   dari resolver publik pola Instagram/Threads dan gagal aman
 *   dengan `pinterest_public_media_url_unavailable` sebelum API
 *   dipanggil — media internal tidak pernah ditebak URL-nya.
 *
 * Satu-satunya percakapan yang disentuh adalah sasaran sintetis
 * `kind='channel'` milik akun Pinterest itu sendiri.
 */

export async function publishPinterestPost(
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
      provider: "pinterest",
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
  if (!payload.encryptedToken) return fail("pinterest_missing_credentials");
  if (!opts.channelTokenSecret) return fail("pinterest_token_secret_unset");
  const accessToken = decryptChannelSecret(
    opts.channelTokenSecret,
    payload.encryptedToken,
  );
  if (!accessToken) return fail("pinterest_token_undecryptable");

  // Media divalidasi & sumbernya diputuskan SEBELUM API dipanggil:
  // Pin menuntut tepat satu gambar (capability menegakkannya saat
  // penjadwalan; pemeriksaan di sini pertahanan terakhir), dan
  // kegagalan URL publik tidak boleh dibayar dengan panggilan board.
  if (payload.media.length !== 1 || payload.media[0]!.kind !== "photo") {
    return fail("pinterest_media_kind_unsupported");
  }
  const media = payload.media[0]!;
  let mediaSource: PinterestMediaSource;
  const mimeType = (media.mimeType ?? "").toLowerCase();
  if (PINTEREST_BASE64_IMAGE_TYPES.includes(mimeType)) {
    const object = await opts.mediaStore.get(media.r2Key);
    if (!object) return fail("post_media_missing");
    mediaSource = {
      source_type: "image_base64",
      content_type: mimeType,
      data: uint8ToBase64(new Uint8Array(object.data)),
    };
  } else if (mimeType.startsWith("image/")) {
    const url = resolvePostPublicMediaUrl(opts, media);
    if (!url) return fail("pinterest_public_media_url_unavailable");
    mediaSource = { source_type: "image_url", url };
  } else {
    return fail("pinterest_media_kind_unsupported");
  }

  const client = new PinterestClient({ baseUrl: opts.pinterestApiBase });

  try {
    // Board tujuan berlapis: opsi postingan menang atas bawaan
    // akun (kolom pilihan Channels); resolver klien memvalidasi
    // lapis teratas yang terisi ke daftar board hidup akun sebelum
    // Pin dibuat, dan menandai bila pilihan itu sudah hilang.
    const choice = await getPinterestBoardChoice(
      db,
      ctx,
      payload.channelAccountId,
    );
    const postBoardId = payload.publishOptions?.pinterestBoardId ?? null;
    const preferredBoardId = postBoardId ?? choice?.boardId ?? null;
    const resolution = await client.resolvePinBoard(
      accessToken,
      preferredBoardId,
    );
    if (!resolution.boardId) return fail("pinterest_board_missing");
    if (resolution.preferredMissing) {
      console.log(
        `[post] ${input.postId}: board pilihan ${postBoardId ? "postingan" : "akun"} ${preferredBoardId} tidak ditemukan lagi di Pinterest — jatuh ke board pertama ${resolution.boardId}`,
      );
    }
    const boardId = resolution.boardId;
    const pinPayload = buildPinterestPinPayload({
      boardId,
      title: payload.title,
      caption: payload.caption,
      mediaSource,
      altText: media.fileName ?? undefined,
    });
    const { pinId } = await client.createPin({
      accessToken,
      payload: pinPayload,
    });
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: pinId,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "pinterest",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary: `channel post ${input.postId} published`,
    });
    console.log(`[post] ${input.postId} terbit (${pinId})`);
    return { published: true };
  } catch (err) {
    const code = pinterestErrorCode(err);
    const detail =
      err instanceof PinterestApiError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

export const pinterestPostPublisher: PostPublisherAdapter = {
  provider: "pinterest",
  publish: publishPinterestPost,
};
