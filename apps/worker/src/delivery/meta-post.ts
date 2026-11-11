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
  MetaGraphClient,
  MetaGraphError,
  type MetaPublishFile,
} from "@sahabat-kreator/channel-messenger";
import type {
  PostPublisherAdapter,
  PostPublisherOptions,
  PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit linimasa keluarga Meta (Gelombang 1).
 *
 * Facebook Page dan Instagram berbagi seluruh rangka publikasi Telegram:
 * klaim atomik lebih dulu, lalu muat payload, dekripsi kredensial akun,
 * panggil provider, dan tandai hasil. Yang berbeda hanya panggilan Graph
 * terakhir — karena itu rangka itu hidup SATU kali di sini dan tiap
 * platform menyumbang fungsi kirimnya saja. Tidak ada jalan pintas yang
 * mengklaim ulang atau menandai dari dispatcher.
 */

export interface MetaPostMediaFile extends MetaPublishFile {
  kind: "photo" | "video" | "document";
  r2Key: string;
  mimeType: string | null;
  fileName: string | null;
}

/**
 * Resolusi URL media publik untuk API container (Instagram/Threads).
 *
 * Media repo TIDAK pernah diekspos apa adanya: object store privat dan
 * endpoint API media memeriksa sesi + tenant. Fungsi ini hanya memakai
 * resolver khusus (rantai uji / integrasi CDN bertanda tangan di luar
 * repo) atau base URL publik yang secara eksplisit dikonfigurasi
 * operator sebagai pemetaan `{base}/{r2Key}`. Tanpa keduanya ia
 * mengembalikan null dan adapter gagal SEBELUM memanggil provider —
 * bukan menebak URL internal yang pasti ditolak Meta.
 */
export function resolvePublicMediaUrl(
  opts: PostPublisherOptions,
  media: { r2Key: string; mimeType: string | null; fileName: string | null },
): string | null {
  const custom = opts.resolvePublicMediaUrl?.(media);
  if (custom) return custom;
  if (!opts.publicMediaBaseUrl) return null;
  const base = opts.publicMediaBaseUrl.replace(/\/+$/, "");
  const path = media.r2Key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${path}`;
}

type MetaPublishSender = (
  client: MetaGraphClient,
  payload: PostPublishPayload,
  files: MetaPostMediaFile[],
  opts: PostPublisherOptions,
) => Promise<string>;

function graphErrorCode(providerLabel: string, err: unknown): string {
  if (!(err instanceof MetaGraphError)) return `${providerLabel}_send_error`;
  if (err.status === 0) return `${providerLabel}_network_error`;
  if (err.graphCode !== null) return `${providerLabel}_graph_${err.graphCode}`;
  return `${providerLabel}_http_${err.status}`;
}

async function publishMetaPost(
  db: Database,
  input: { tenantId: string; postId: string; scheduledAt: string },
  opts: PostPublisherOptions,
  config: {
    /** Provider pada percakapan/akun (`messenger` / `instagram`). */
    provider: string;
    /** Awalan kode error yang aman (`facebook` / `instagram`). */
    label: string;
    /** Apakah adapter perlu byte media (FB) atau hanya URL publik (IG). */
    loadMediaBytes: boolean;
    send: MetaPublishSender;
  },
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
      provider: config.provider,
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
  if (!payload.encryptedToken) {
    return fail(`${config.label}_missing_credentials`);
  }
  if (!opts.channelTokenSecret) {
    return fail(`${config.label}_token_secret_unset`);
  }
  const token = decryptChannelSecret(
    opts.channelTokenSecret,
    payload.encryptedToken,
  );
  if (!token) return fail(`${config.label}_token_undecryptable`);

  const files: MetaPostMediaFile[] = [];
  if (config.loadMediaBytes) {
    for (const item of payload.media) {
      const object = await opts.mediaStore.get(item.r2Key);
      if (!object) return fail("post_media_missing");
      files.push({
        data: new Uint8Array(object.data),
        filename: item.fileName ?? "file",
        contentType:
          item.mimeType ?? object.contentType ?? "application/octet-stream",
        kind: item.kind,
        r2Key: item.r2Key,
        mimeType: item.mimeType,
        fileName: item.fileName,
      });
    }
  } else {
    // Adapter berbasis URL (Instagram/Threads) tidak mengunduh byte:
    // fungsi kirimnya me-resolusi URL publik dari r2Key pada payload.
    for (const item of payload.media) {
      files.push({
        data: new Uint8Array(),
        filename: item.fileName ?? "file",
        contentType: item.mimeType ?? "application/octet-stream",
        kind: item.kind,
        r2Key: item.r2Key,
        mimeType: item.mimeType,
        fileName: item.fileName,
      });
    }
  }

  const client = new MetaGraphClient({
    baseUrl: opts.metaApiBase,
    apiVersion: opts.metaGraphApiVersion,
    accessToken: token,
  });

  try {
    const providerPostId = await config.send(client, payload, files, opts);
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: providerPostId,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: config.provider,
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary: `channel post ${input.postId} published`,
    });
    console.log(`[post] ${input.postId} terbit (post ${providerPostId})`);
    return { published: true };
  } catch (err) {
    // Kegagalan yang disengaja dari fungsi kirim membawa kode aman
    // pada `message` berawalan label provider (mis.
    // `instagram_public_media_url_unavailable`). Error Graph dipetakan
    // dari status/kode resminya. Token tidak pernah masuk keduanya.
    const code =
      err instanceof MetaGraphError
        ? graphErrorCode(config.label, err)
        : err instanceof Error && /^[a-z_]+$/.test(err.message)
          ? err.message
          : graphErrorCode(config.label, err);
    const detail =
      err instanceof MetaGraphError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

/** Kirim Facebook Page: teks ke feed, foto ke photos/album, video ke videos. */
async function sendFacebookPagePost(
  client: MetaGraphClient,
  payload: PostPublishPayload,
  files: MetaPostMediaFile[],
): Promise<string> {
  if (files.length === 0) {
    const result = await client.publishPagePost({
      pageId: payload.chatId,
      message: payload.caption,
    });
    return result.providerPostId;
  }

  if (files.every((file) => file.kind === "photo")) {
    const result = await client.publishPagePhotoAlbum({
      pageId: payload.chatId,
      files,
      caption: payload.caption,
    });
    return result.providerPostId;
  }

  if (files.length === 1 && files[0]!.kind === "video") {
    const result = await client.publishPageVideo({
      pageId: payload.chatId,
      file: files[0]!,
      description: payload.caption,
    });
    return result.providerPostId;
  }

  // Capability mengizinkan album + video secara terpisah, tetapi Graph
  // Page tidak merangkai campuran foto/video sebagai satu album feed.
  // Gagal sebelum panggilan provider lebih jujur daripada menerbitkan
  // hanya sebagian lampiran.
  throw new Error("facebook_media_combination_unsupported");
}

async function waitForInstagramContainer(
  client: MetaGraphClient,
  containerId: string,
  opts: PostPublisherOptions,
): Promise<void> {
  const maxPolls = opts.metaContainerMaxPolls ?? 20;
  const intervalMs = opts.metaContainerPollIntervalMs ?? 3_000;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const status = await client.getInstagramContainerStatus(containerId);
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error("instagram_container_failed");
    }
    if (attempt + 1 < maxPolls && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("instagram_container_timeout");
}

/** Kirim Instagram: container per media → tunggu siap → publish. */
async function sendInstagramPost(
  client: MetaGraphClient,
  payload: PostPublishPayload,
  files: MetaPostMediaFile[],
  opts: PostPublisherOptions,
): Promise<string> {
  if (files.length === 0) {
    // Capability seharusnya menolak ini di core (mediaRequired), tetapi
    // adapter tetap gagal aman bila baris lama menyelinap.
    throw new Error("instagram_media_required");
  }
  if (files.some((file) => file.kind === "document")) {
    throw new Error("instagram_media_kind_unsupported");
  }

  const urls = files.map((file) => {
    const url = resolvePublicMediaUrl(opts, file);
    if (!url) throw new Error("instagram_public_media_url_unavailable");
    return url;
  });

  if (files.length === 1) {
    const file = files[0]!;
    const container = await client.createInstagramMediaContainer({
      instagramAccountId: payload.chatId,
      ...(file.kind === "video"
        ? { videoUrl: urls[0]!, mediaType: "REELS" as const }
        : { imageUrl: urls[0]! }),
      caption: payload.caption,
    });
    await waitForInstagramContainer(client, container.containerId, opts);
    const published = await client.publishInstagramContainer({
      instagramAccountId: payload.chatId,
      containerId: container.containerId,
    });
    return published.providerPostId;
  }

  const children: string[] = [];
  for (const [index, file] of files.entries()) {
    const child = await client.createInstagramMediaContainer({
      instagramAccountId: payload.chatId,
      ...(file.kind === "video"
        ? { videoUrl: urls[index]! }
        : { imageUrl: urls[index]! }),
      isCarouselItem: true,
    });
    await waitForInstagramContainer(client, child.containerId, opts);
    children.push(child.containerId);
  }
  const carousel = await client.createInstagramCarouselContainer({
    instagramAccountId: payload.chatId,
    children,
    caption: payload.caption,
  });
  await waitForInstagramContainer(client, carousel.containerId, opts);
  const published = await client.publishInstagramContainer({
    instagramAccountId: payload.chatId,
    containerId: carousel.containerId,
  });
  return published.providerPostId;
}

export const instagramPostPublisher: PostPublisherAdapter = {
  provider: "instagram",
  publish: (db, input, opts) =>
    publishMetaPost(db, input, opts, {
      provider: "instagram",
      label: "instagram",
      loadMediaBytes: false,
      send: sendInstagramPost,
    }),
};

export const facebookPagePostPublisher: PostPublisherAdapter = {
  provider: "messenger",
  publish: (db, input, opts) =>
    publishMetaPost(db, input, opts, {
      provider: "messenger",
      label: "facebook",
      loadMediaBytes: true,
      send: sendFacebookPagePost,
    }),
};
