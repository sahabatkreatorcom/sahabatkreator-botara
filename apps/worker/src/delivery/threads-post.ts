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
  ThreadsGraphClient,
  ThreadsGraphError,
} from "@sahabat-kreator/channel-messenger";
import {
  resolvePostPublicMediaUrl,
  type PostPublisherAdapter,
  type PostPublisherOptions,
  type PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit Threads (Gelombang 1) — publikasi saja, BUKAN inbox.
 *
 * Alurnya meniru adapter Telegram/Meta persis pada bagian yang menjaga
 * keamanan publikasi: klaim atomik dengan pencocokan jadwal lebih dulu,
 * lalu muat payload, dekripsi token akun, panggil Threads API, dan
 * tandai hasil. Tidak ada webhook, pesan, atau percakapan dua arah di
 * sini; satu-satunya percakapan yang disentuh adalah sasaran sintetis
 * `kind='channel'` milik akun Threads itu sendiri.
 */

function threadsErrorCode(err: unknown): string {
  if (!(err instanceof ThreadsGraphError)) return "threads_send_error";
  if (err.status === 0) return "threads_network_error";
  if (err.graphCode !== null) return `threads_graph_${err.graphCode}`;
  return `threads_http_${err.status}`;
}

async function waitForThreadsContainer(
  client: ThreadsGraphClient,
  containerId: string,
  opts: PostPublisherOptions,
): Promise<void> {
  const maxPolls = opts.metaContainerMaxPolls ?? 20;
  const intervalMs = opts.metaContainerPollIntervalMs ?? 3_000;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const status = await client.getThreadsContainerStatus(containerId);
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error("threads_container_failed");
    }
    if (attempt + 1 < maxPolls && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("threads_container_timeout");
}

async function sendThreadsPost(
  client: ThreadsGraphClient,
  payload: PostPublishPayload,
  opts: PostPublisherOptions,
): Promise<string> {
  if (payload.media.some((item) => item.kind === "document")) {
    throw new Error("threads_media_kind_unsupported");
  }

  const urls = payload.media.map((item) => {
    const url = resolvePostPublicMediaUrl(opts, item);
    if (!url) throw new Error("threads_public_media_url_unavailable");
    return url;
  });

  if (payload.media.length === 0) {
    const container = await client.createThreadsContainer({
      threadsUserId: payload.chatId,
      mediaType: "TEXT",
      text: payload.caption,
    });
    await waitForThreadsContainer(client, container.containerId, opts);
    const published = await client.publishThreadsContainer({
      threadsUserId: payload.chatId,
      containerId: container.containerId,
    });
    return published.providerPostId;
  }

  if (payload.media.length === 1) {
    const item = payload.media[0]!;
    const container = await client.createThreadsContainer({
      threadsUserId: payload.chatId,
      mediaType: item.kind === "video" ? "VIDEO" : "IMAGE",
      ...(item.kind === "video"
        ? { videoUrl: urls[0]! }
        : { imageUrl: urls[0]! }),
      text: payload.caption,
    });
    await waitForThreadsContainer(client, container.containerId, opts);
    const published = await client.publishThreadsContainer({
      threadsUserId: payload.chatId,
      containerId: container.containerId,
    });
    return published.providerPostId;
  }

  const children: string[] = [];
  for (const [index, item] of payload.media.entries()) {
    const child = await client.createThreadsContainer({
      threadsUserId: payload.chatId,
      mediaType: item.kind === "video" ? "VIDEO" : "IMAGE",
      ...(item.kind === "video"
        ? { videoUrl: urls[index]! }
        : { imageUrl: urls[index]! }),
      isCarouselItem: true,
    });
    await waitForThreadsContainer(client, child.containerId, opts);
    children.push(child.containerId);
  }
  const carousel = await client.createThreadsContainer({
    threadsUserId: payload.chatId,
    mediaType: "CAROUSEL",
    children,
    text: payload.caption,
  });
  await waitForThreadsContainer(client, carousel.containerId, opts);
  const published = await client.publishThreadsContainer({
    threadsUserId: payload.chatId,
    containerId: carousel.containerId,
  });
  return published.providerPostId;
}

export async function publishThreadsPost(
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
      provider: "threads",
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
  if (!payload.encryptedToken) return fail("threads_missing_credentials");
  if (!opts.channelTokenSecret) return fail("threads_token_secret_unset");
  const token = decryptChannelSecret(
    opts.channelTokenSecret,
    payload.encryptedToken,
  );
  if (!token) return fail("threads_token_undecryptable");

  const client = new ThreadsGraphClient({
    baseUrl: opts.threadsApiBase,
    accessToken: token,
  });

  try {
    const providerPostId = await sendThreadsPost(client, payload, opts);
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: providerPostId,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "threads",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary: `channel post ${input.postId} published`,
    });
    console.log(`[post] ${input.postId} terbit (post ${providerPostId})`);
    return { published: true };
  } catch (err) {
    const code =
      err instanceof ThreadsGraphError
        ? threadsErrorCode(err)
        : err instanceof Error && /^[a-z_]+$/.test(err.message)
          ? err.message
          : threadsErrorCode(err);
    const detail =
      err instanceof ThreadsGraphError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

export const threadsPostPublisher: PostPublisherAdapter = {
  provider: "threads",
  publish: publishThreadsPost,
};
