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
  BlueskyApiError,
  BlueskyClient,
  buildBlueskyPostRecord,
  type BlueskyBlobRef,
} from "@sahabat-kreator/channel-bluesky";
import type {
  PostPublisherAdapter,
  PostPublisherOptions,
  PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit Bluesky (Gelombang 1.5) — publikasi saja, BUKAN inbox.
 *
 * Alurnya meniru adapter lain persis pada bagian yang menjaga keamanan
 * publikasi: klaim atomik dengan pencocokan jadwal lebih dulu, lalu
 * muat payload, dekripsi kredensial akun, kirim, dan tandai hasil.
 * Perbedaan Bluesky ada pada kredensial dan media:
 *
 * - Kredensial akun adalah APP PASSWORD (dibuat pemilik di pengaturan
 *   Bluesky, tersimpan terenkripsi pada kolom token akun seperti token
 *   provider lain). Ia ditukar menjadi sesi XRPC segar setiap publikasi
 *   lewat `createSession` dengan identifier = DID akun (alamat kirim
 *   sasaran); accessJwt tidak pernah disimpan.
 * - Media dibaca sebagai BINER dari object store privat (pola
 *   Telegram) lalu diunggah dengan `uploadBlob` — Bluesky tidak
 *   menuntut URL publik seperti API container Instagram/Threads, jadi
 *   model media privat repo tetap utuh.
 *
 * Satu-satunya percakapan yang disentuh adalah sasaran sintetis
 * `kind='channel'` milik akun Bluesky itu sendiri.
 */

function blueskyErrorCode(err: unknown): string {
  if (!(err instanceof BlueskyApiError)) return "bluesky_send_error";
  if (err.status === 0) return "bluesky_network_error";
  if (err.xrpcError) {
    return `bluesky_xrpc_${err.xrpcError.toLowerCase()}`;
  }
  return `bluesky_http_${err.status}`;
}

async function sendBlueskyPost(
  client: BlueskyClient,
  session: { did: string; accessJwt: string },
  payload: PostPublishPayload,
  mediaBinaries: Array<{
    data: Uint8Array;
    contentType: string;
    alt: string;
  }>,
): Promise<string> {
  const images: Array<{ blob: BlueskyBlobRef; alt: string }> = [];
  for (const media of mediaBinaries) {
    const blob = await client.uploadBlob({
      accessJwt: session.accessJwt,
      data: media.data,
      contentType: media.contentType,
    });
    images.push({ blob, alt: media.alt });
  }
  const record = buildBlueskyPostRecord({
    text: payload.caption,
    images,
  });
  const created = await client.createRecord({
    accessJwt: session.accessJwt,
    repo: session.did,
    record,
  });
  return created.uri;
}

export async function publishBlueskyPost(
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
      provider: "bluesky",
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
  if (!payload.encryptedToken) return fail("bluesky_missing_credentials");
  if (!opts.channelTokenSecret) return fail("bluesky_token_secret_unset");
  // Yang tersimpan terenkripsi pada akun Bluesky adalah app password,
  // bukan token sesi — sesi dibuat segar di bawah dari nilai ini.
  const appPassword = decryptChannelSecret(
    opts.channelTokenSecret,
    payload.encryptedToken,
  );
  if (!appPassword) return fail("bluesky_token_undecryptable");

  // Media divalidasi & dibaca SEBELUM sesi dibuat: postingan yang
  // medianya hilang tidak boleh membakar satu sesi (dan satu upaya
  // login) untuk kegagalan yang sudah pasti.
  const mediaBinaries: Array<{
    data: Uint8Array;
    contentType: string;
    alt: string;
  }> = [];
  for (const item of payload.media) {
    if (item.kind !== "photo") {
      // Capability sudah menolak video/dokumen saat penjadwalan; ini
      // pertahanan terakhir bila data berubah di antara keduanya.
      return fail("bluesky_media_kind_unsupported");
    }
    const object = await opts.mediaStore.get(item.r2Key);
    if (!object) return fail("post_media_missing");
    mediaBinaries.push({
      data: new Uint8Array(object.data),
      contentType: item.mimeType ?? object.contentType ?? "image/jpeg",
      alt: item.fileName ?? "",
    });
  }

  const client = new BlueskyClient({ baseUrl: opts.blueskyApiBase });

  try {
    const session = await client.createSession({
      identifier: payload.chatId,
      password: appPassword,
    });
    const providerPostId = await sendBlueskyPost(
      client,
      session,
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
      provider: "bluesky",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary: `channel post ${input.postId} published`,
    });
    console.log(`[post] ${input.postId} terbit (${providerPostId})`);
    return { published: true };
  } catch (err) {
    const code =
      err instanceof BlueskyApiError
        ? blueskyErrorCode(err)
        : err instanceof Error && /^[a-z_]+$/.test(err.message)
          ? err.message
          : blueskyErrorCode(err);
    const detail =
      err instanceof BlueskyApiError
        ? ` — ${err.description.slice(0, 200)}`
        : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

export const blueskyPostPublisher: PostPublisherAdapter = {
  provider: "bluesky",
  publish: publishBlueskyPost,
};
