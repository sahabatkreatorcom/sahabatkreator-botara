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
  TelegramApiError,
  TelegramBotApiClient,
  type TelegramPostFile,
} from "@sahabat-kreator/channel-telegram";
import type {
  PostPublisherAdapter,
  PostPublisherOptions,
  PublishPostResult,
} from "./post-publisher";

/**
 * Penerbit postingan channel Telegram (Fase 23) — adapter PERTAMA dari
 * registry `PublisherAdapter` (`post-publisher.ts`, Gelombang 0).
 *
 * Berbeda dari `runner.ts` (poller pesan): tidak ada pemindaian antrean di
 * sini. Pemicunya adalah job BullMQ tertunda yang dibuat relay outbox dari
 * event `post.publish_due`, jadi tidak ada tabel yang dipoll untuk mencari
 * pekerjaan.
 *
 * Urutan yang TIDAK boleh ditukar:
 *   1. klaim atomik `scheduled → publishing` (dengan pencocokan
 *      `scheduled_at` — job lama tidak boleh menerbitkan jadwal baru);
 *   2. muat isi postingan;
 *   3. dekripsi token bot;
 *   4. baca berkas dari object store;
 *   5. kirim;
 *   6. tandai `published` + id pesan.
 *
 * Kegagalan di langkah 2–5 dicatat sebagai `failed` beserta kode aman.
 * Kegagalan SESUDAH provider menerima tetapi SEBELUM penandaan (proses
 * mati di antara 5 dan 6) meninggalkan status `publishing`. Itu disengaja:
 * job tidak diulang (attempts 1), dan pemilik melihat status yang jujur —
 * bukan dua postingan di channel pelanggan.
 */

/**
 * Opsi penerbit — sekarang milik bersama registry (`PostPublisherOptions`
 * di `post-publisher.ts`); alias ini dipertahankan agar pemanggil lama
 * tidak berubah.
 */
export type PublishPostOptions = PostPublisherOptions;

export type { PublishPostResult };

function errorCode(err: unknown): string {
  if (!(err instanceof TelegramApiError)) return "telegram_send_error";
  return err.status === 0
    ? "telegram_network_error"
    : `telegram_http_${err.status}`;
}

export async function publishTelegramPost(
  db: Database,
  input: { tenantId: string; postId: string; scheduledAt: string },
  opts: PublishPostOptions,
): Promise<PublishPostResult> {
  const ctx = { tenantId: input.tenantId };
  const expected = new Date(input.scheduledAt);

  const claim = await claimPostForPublish(db, {
    tenantId: input.tenantId,
    postId: input.postId,
    expectedScheduledAt: expected,
  });
  if (claim.kind === "not_found") {
    console.error(`[post] ${input.postId} tidak ditemukan — job dilewati`);
    return { published: false, reason: "not_found" };
  }
  if (claim.kind === "skipped") {
    // Dibatalkan, sudah terbit, atau dijadwalkan ulang. Ketiganya normal.
    console.log(
      `[post] ${input.postId} dilewati: status=${claim.status} (jadwal ${input.scheduledAt})`,
    );
    return { published: false, reason: `status_${claim.status}` };
  }

  const fail = async (code: string): Promise<PublishPostResult> => {
    await markPostFailed(db, { ...ctx, postId: input.postId, errorCode: code });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "telegram",
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
  if (!payload.encryptedToken) return fail("telegram_missing_credentials");
  if (!opts.channelTokenSecret) {
    return fail("telegram_token_secret_unset");
  }

  const token = decryptChannelSecret(
    opts.channelTokenSecret,
    payload.encryptedToken,
  );
  if (!token) return fail("telegram_token_undecryptable");

  const files: TelegramPostFile[] = [];
  for (const item of payload.media) {
    const object = await opts.mediaStore.get(item.r2Key);
    if (!object) {
      // Baris media ada tetapi berkasnya hilang (volume tidak ter-mount,
      // restore DB tanpa disk). Lebih jujur gagal di sini daripada
      // menerbitkan postingan tanpa gambar yang dijanjikan.
      return fail("post_media_missing");
    }
    files.push({
      data: new Uint8Array(object.data),
      filename: item.fileName ?? "file",
      contentType:
        item.mimeType ?? object.contentType ?? "application/octet-stream",
      kind: item.kind,
    });
  }

  const client = new TelegramBotApiClient({
    baseUrl: opts.telegramApiBase,
    token,
  });

  try {
    const sent = await client.sendChannelPost({
      chatId: payload.chatId,
      caption: payload.caption,
      files,
    });
    await markPostPublished(db, {
      ...ctx,
      postId: input.postId,
      providerMessageId: sent.providerMessageId,
    });
    await recordIntegrationLog(db, {
      direction: "out",
      provider: "telegram",
      tenantId: input.tenantId,
      channelAccountId: payload.channelAccountId,
      outcome: "sent",
      summary: `channel post ${input.postId} published`,
    });
    console.log(
      `[post] ${input.postId} terbit (message ${sent.providerMessageId}, ${files.length} lampiran)`,
    );
    return { published: true };
  } catch (err) {
    const code = errorCode(err);
    // Deskripsi Bot API aman dicatat (tidak memuat token) dan sangat
    // membantu saat caption ditolak karena format teks.
    const detail =
      err instanceof Error && err.message ? ` — ${err.message.slice(0, 200)}` : "";
    console.error(`[post] ${input.postId} ditolak provider: ${code}${detail}`);
    return fail(code);
  }
}

/**
 * Adapter Telegram untuk registry `PublisherAdapter`. Seluruh alurnya
 * adalah `publishTelegramPost` di atas — ekstraksi Gelombang 0 tidak
 * mengubah satu langkah pun dari alur Fase 23.
 */
export const telegramPostPublisher: PostPublisherAdapter = {
  provider: "telegram",
  publish: publishTelegramPost,
};
