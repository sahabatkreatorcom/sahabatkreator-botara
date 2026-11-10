import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  conversations,
  media,
  outboxEvents,
  postMedia,
  posts,
  type Database,
  type PostStatus,
} from "@sahabat-kreator/db";
import {
  POST_CAPTION_MAX,
  POST_MEDIA_MAX,
  type PostMediaKind,
} from "@sahabat-kreator/contracts";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Content Schedule (Fase 23) — postingan terjadwal ke linimasa channel.
 *
 * BUKAN broadcast. Broadcast punya penerima dan fan-out per kontak; post
 * punya satu baris di linimasa publik dan nol penerima. Karena itu tabel,
 * status, dan metriknya terpisah — dan fungsi di modul ini tidak pernah
 * menyentuh `messages`/`broadcast_recipients`.
 *
 * Pembagian tugas dengan worker:
 * - core (di sini) memegang STATE MACHINE: validasi, transisi, klaim
 *   atomik, penulisan event outbox, audit. Tidak ada panggilan HTTP ke
 *   provider di sini — core tidak bergantung pada paket channel mana pun.
 * - worker memegang PENGIRIMAN: mengambil baris yang sudah diklaim,
 *   mendekripsi token, memanggil Bot API, lalu memanggil penanda di sini.
 *
 * Anti kirim ganda (keputusan sadar, karena publish TIDAK idempoten):
 * klaim `scheduled → publishing` bersifat atomik. Job yang diulang setelah
 * klaim tidak akan menemukan status `scheduled` lagi, jadi ia TIDAK
 * mengirim ulang. Kalau proses mati tepat setelah provider menerima tetapi
 * sebelum penandaan, hasilnya `failed` dengan kode
 * `publish_outcome_unknown` — operator memeriksa channel, bukan pengguna
 * menerima dua postingan.
 */

export class PostDomainError extends Error {
  constructor(readonly code: PostErrorCode) {
    super(code);
    this.name = "PostDomainError";
  }
}

export type PostErrorCode =
  | "POST_NOT_FOUND"
  | "POST_TARGET_NOT_FOUND"
  | "POST_TARGET_NOT_CONNECTED"
  | "POST_MEDIA_NOT_FOUND"
  | "POST_MEDIA_ALBUM_UNSUPPORTED"
  | "POST_NOT_EDITABLE"
  | "POST_NOT_SCHEDULABLE"
  | "POST_NOT_CANCELLABLE"
  | "POST_EMPTY";

export interface PostTarget {
  channelAccountId: string;
  conversationId: string;
  provider: string;
  title: string | null;
  providerChatId: string | null;
  channelDisplayName: string | null;
}

export interface PostMediaItem {
  id: string;
  mediaId: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  kind: PostMediaKind;
}

export interface PostRecord {
  id: string;
  title: string;
  caption: string;
  status: PostStatus;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  providerMessageId: string | null;
  errorCode: string | null;
  target: PostTarget;
  media: PostMediaItem[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Klasifikasi lampiran dari MIME — satu tempat, dipakai UI (ikon) dan
 * publisher (metode Bot API yang dipilih). `application/octet-stream`
 * jatuh ke dokumen: lebih jujur daripada menebak dari ekstensi nama file.
 */
export function postMediaKind(mimeType: string | null): PostMediaKind {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

/** Baris target + akun, dipakai bersama oleh daftar dan pemuatan satu post. */
function targetSelection() {
  return {
    channelAccountId: posts.channelAccountId,
    conversationId: posts.conversationId,
    provider: conversations.provider,
    channelTitle: conversations.title,
    providerChatId: conversations.providerChatId,
    channelDisplayName: channelAccounts.displayName,
  };
}

async function loadMedia(
  tx: DbTx,
  tenantId: string,
  postIds: string[],
): Promise<Map<string, PostMediaItem[]>> {
  const grouped = new Map<string, PostMediaItem[]>();
  if (postIds.length === 0) return grouped;
  const rows = await tx
    .select({
      id: postMedia.id,
      postId: postMedia.postId,
      mediaId: postMedia.mediaId,
      position: postMedia.position,
      fileName: media.fileName,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
    })
    .from(postMedia)
    .innerJoin(media, eq(media.id, postMedia.mediaId))
    .where(
      and(eq(postMedia.tenantId, tenantId), inArray(postMedia.postId, postIds)),
    )
    .orderBy(asc(postMedia.position));

  for (const row of rows) {
    const list = grouped.get(row.postId) ?? [];
    list.push({
      id: row.id,
      mediaId: row.mediaId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: postMediaKind(row.mimeType),
    });
    grouped.set(row.postId, list);
  }
  return grouped;
}

/**
 * Channel yang bisa dituju: percakapan `kind='channel'` pada akun yang
 * masih terhubung. Percakapan channel dibuat saat bot ditambahkan sebagai
 * admin (webhook `my_chat_member` / `channel_post`) — jadi daftar ini
 * kosong berarti bot belum pernah masuk ke channel mana pun, dan UI
 * menampilkan instruksi alih-alih pemilih kosong.
 */
export async function listPostTargets(
  db: Database,
  input: { tenantId: string },
): Promise<PostTarget[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    return tx
      .select({
        channelAccountId: conversations.channelAccountId,
        conversationId: conversations.id,
        provider: conversations.provider,
        title: conversations.title,
        providerChatId: conversations.providerChatId,
        channelDisplayName: channelAccounts.displayName,
      })
      .from(conversations)
      .innerJoin(
        channelAccounts,
        eq(channelAccounts.id, conversations.channelAccountId),
      )
      .where(
        and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.kind, "channel"),
          eq(channelAccounts.status, "connected"),
        ),
      )
      .orderBy(asc(conversations.title));
  });
}

async function loadPost(
  tx: DbTx,
  tenantId: string,
  postId: string,
): Promise<PostRecord | null> {
  const [row] = await tx
    .select({
      id: posts.id,
      title: posts.title,
      caption: posts.caption,
      status: posts.status,
      scheduledAt: posts.scheduledAt,
      publishedAt: posts.publishedAt,
      providerMessageId: posts.providerMessageId,
      errorCode: posts.errorCode,
      createdAt: posts.createdAt,
      updatedAt: posts.updatedAt,
      ...targetSelection(),
    })
    .from(posts)
    .innerJoin(conversations, eq(conversations.id, posts.conversationId))
    .innerJoin(
      channelAccounts,
      eq(channelAccounts.id, posts.channelAccountId),
    )
    .where(and(eq(posts.tenantId, tenantId), eq(posts.id, postId)))
    .limit(1);
  if (!row) return null;

  const mediaByPost = await loadMedia(tx, tenantId, [postId]);
  return {
    id: row.id,
    title: row.title,
    caption: row.caption,
    status: row.status,
    scheduledAt: row.scheduledAt,
    publishedAt: row.publishedAt,
    providerMessageId: row.providerMessageId,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    target: {
      channelAccountId: row.channelAccountId,
      conversationId: row.conversationId,
      provider: row.provider,
      title: row.channelTitle ?? null,
      providerChatId: row.providerChatId,
      channelDisplayName: row.channelDisplayName,
    },
    media: mediaByPost.get(postId) ?? [],
  };
}

/**
 * Ganti seluruh lampiran dalam satu transaksi. Urutan `mediaIds` dari
 * pemanggil = urutan album; duplikat dibuang agar unique (post, position)
 * tidak tertabrak oleh input yang jujur tetapi ceroboh.
 */
async function replaceMedia(
  tx: DbTx,
  tenantId: string,
  postId: string,
  mediaIds: string[],
): Promise<void> {
  const unique = [...new Set(mediaIds)];
  if (unique.length > POST_MEDIA_MAX) {
    throw new PostDomainError("POST_MEDIA_ALBUM_UNSUPPORTED");
  }
  if (unique.length > 0) {
    const found = await tx
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.tenantId, tenantId), inArray(media.id, unique)));
    if (found.length !== unique.length) {
      throw new PostDomainError("POST_MEDIA_NOT_FOUND");
    }
  }
  await tx.delete(postMedia).where(eq(postMedia.postId, postId));
  if (unique.length === 0) return;
  await tx.insert(postMedia).values(
    unique.map((mediaId, position) => ({
      tenantId,
      postId,
      mediaId,
      position,
    })),
  );
}

export async function listPosts(
  db: Database,
  input: { tenantId: string; status?: PostStatus; limit?: number },
): Promise<PostRecord[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: posts.id,
        title: posts.title,
        caption: posts.caption,
        status: posts.status,
        scheduledAt: posts.scheduledAt,
        publishedAt: posts.publishedAt,
        providerMessageId: posts.providerMessageId,
        errorCode: posts.errorCode,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        ...targetSelection(),
      })
      .from(posts)
      .innerJoin(conversations, eq(conversations.id, posts.conversationId))
      .innerJoin(
        channelAccounts,
        eq(channelAccounts.id, posts.channelAccountId),
      )
      .where(
        and(
          eq(posts.tenantId, input.tenantId),
          input.status ? eq(posts.status, input.status) : undefined,
        ),
      )
      // Kalender dibaca dari jam tayang terdekat; draft (scheduled_at
      // NULL) jatuh ke bawah lewat COALESCE ke created_at.
      .orderBy(desc(sql`coalesce(${posts.scheduledAt}, ${posts.createdAt})`))
      .limit(input.limit ?? 100);

    const mediaByPost = await loadMedia(
      tx,
      input.tenantId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      caption: row.caption,
      status: row.status,
      scheduledAt: row.scheduledAt,
      publishedAt: row.publishedAt,
      providerMessageId: row.providerMessageId,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      target: {
        channelAccountId: row.channelAccountId,
        conversationId: row.conversationId,
        provider: row.provider,
        title: row.channelTitle ?? null,
        providerChatId: row.providerChatId,
        channelDisplayName: row.channelDisplayName,
      },
      media: mediaByPost.get(row.id) ?? [],
    }));
  });
}

export async function getPost(
  db: Database,
  input: { tenantId: string; postId: string },
): Promise<PostRecord | null> {
  return withTenantDb(db, input.tenantId, async (tx) =>
    loadPost(tx, input.tenantId, input.postId),
  );
}

/**
 * Buat draft. Target divalidasi saat pembuatan (bukan saat jadwal) supaya
 * pengguna tahu lebih awal kalau channel-nya sudah tidak terhubung.
 */
export async function createPost(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    conversationId: string;
    title: string;
    caption: string;
    mediaIds: string[];
  },
): Promise<PostRecord> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [target] = await tx
      .select({
        channelAccountId: conversations.channelAccountId,
        status: channelAccounts.status,
      })
      .from(conversations)
      .innerJoin(
        channelAccounts,
        eq(channelAccounts.id, conversations.channelAccountId),
      )
      .where(
        and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.id, input.conversationId),
          eq(conversations.kind, "channel"),
        ),
      )
      .limit(1);
    if (!target) throw new PostDomainError("POST_TARGET_NOT_FOUND");
    if (target.status !== "connected") {
      throw new PostDomainError("POST_TARGET_NOT_CONNECTED");
    }

    const [row] = await tx
      .insert(posts)
      .values({
        tenantId: input.tenantId,
        channelAccountId: target.channelAccountId,
        conversationId: input.conversationId,
        title: input.title,
        caption: input.caption.slice(0, POST_CAPTION_MAX),
        status: "draft",
        createdByUserId: input.userId,
      })
      .returning({ id: posts.id });

    await replaceMedia(tx, input.tenantId, row!.id, input.mediaIds);
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.created",
      meta: {
        postId: row!.id,
        conversationId: input.conversationId,
        mediaCount: input.mediaIds.length,
      },
    });
    const created = await loadPost(tx, input.tenantId, row!.id);
    if (!created) throw new PostDomainError("POST_NOT_FOUND");
    return created;
  });
}

export async function updatePost(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    postId: string;
    title?: string;
    caption?: string;
    mediaIds?: string[];
  },
): Promise<PostRecord> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await loadPost(tx, input.tenantId, input.postId);
    if (!existing) throw new PostDomainError("POST_NOT_FOUND");
    // Edit hanya untuk draft. Postingan terjadwal yang isinya diubah akan
    // membuat "apa yang disetujui" berbeda dari "apa yang terbit" — kalau
    // perlu ubah, batalkan lalu jadwalkan ulang.
    if (existing.status !== "draft") {
      throw new PostDomainError("POST_NOT_EDITABLE");
    }
    await tx
      .update(posts)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.caption !== undefined
          ? { caption: input.caption.slice(0, POST_CAPTION_MAX) }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)));
    if (input.mediaIds !== undefined) {
      await replaceMedia(tx, input.tenantId, input.postId, input.mediaIds);
    }
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.updated",
      meta: { postId: input.postId },
    });
    const updated = await loadPost(tx, input.tenantId, input.postId);
    if (!updated) throw new PostDomainError("POST_NOT_FOUND");
    return updated;
  });
}

/** Hapus permanen — hanya draft/cancelled. Yang pernah terbit adalah riwayat. */
export async function deletePost(
  db: Database,
  input: { tenantId: string; userId: string; postId: string },
): Promise<void> {
  await withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await loadPost(tx, input.tenantId, input.postId);
    if (!existing) throw new PostDomainError("POST_NOT_FOUND");
    if (existing.status !== "draft" && existing.status !== "cancelled") {
      throw new PostDomainError("POST_NOT_EDITABLE");
    }
    await tx
      .delete(posts)
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.deleted",
      meta: { postId: input.postId, status: existing.status },
    });
  });
}

/**
 * Jadwalkan (draft/scheduled → scheduled + event outbox).
 *
 * Event membawa `scheduledAt` yang DISEPAKATI. Publisher membandingkannya
 * dengan kolom `posts.scheduled_at` sebelum mengirim: job lama yang masih
 * hidup setelah penjadwalan ulang tidak boleh menerbitkan lebih awal.
 */
export async function schedulePost(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    postId: string;
    scheduledAt?: Date | null;
  },
): Promise<{ kind: "scheduled"; post: PostRecord; dispatchAt: Date }> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await loadPost(tx, input.tenantId, input.postId);
    if (!existing) throw new PostDomainError("POST_NOT_FOUND");
    if (existing.status !== "draft" && existing.status !== "scheduled") {
      throw new PostDomainError("POST_NOT_SCHEDULABLE");
    }
    if (existing.target.provider !== "telegram") {
      throw new PostDomainError("POST_TARGET_NOT_FOUND");
    }
    if (!existing.target.providerChatId) {
      throw new PostDomainError("POST_TARGET_NOT_FOUND");
    }
    if (existing.caption.trim().length === 0 && existing.media.length === 0) {
      throw new PostDomainError("POST_EMPTY");
    }
    // Telegram: album hanya boleh berisi foto/video. Dokumen di tengah
    // album ditolak Bot API, jadi ditolak di sini — sebelum jam tayang.
    if (
      existing.media.length > 1 &&
      existing.media.some((item) => item.kind === "document")
    ) {
      throw new PostDomainError("POST_MEDIA_ALBUM_UNSUPPORTED");
    }

    const now = new Date();
    const requested =
      input.scheduledAt && input.scheduledAt.getTime() > now.getTime()
        ? input.scheduledAt
        : now;

    await tx
      .update(posts)
      .set({ status: "scheduled", scheduledAt: requested, updatedAt: now })
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)));

    await tx.insert(outboxEvents).values({
      tenantId: input.tenantId,
      type: "post.publish_due",
      payload: {
        postId: input.postId,
        scheduledAt: requested.toISOString(),
      },
    });
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.scheduled",
      meta: {
        postId: input.postId,
        scheduledAt: requested.toISOString(),
        mediaCount: existing.media.length,
      },
    });

    const scheduled = await loadPost(tx, input.tenantId, input.postId);
    if (!scheduled) throw new PostDomainError("POST_NOT_FOUND");
    return { kind: "scheduled" as const, post: scheduled, dispatchAt: requested };
  });
}

export async function cancelPost(
  db: Database,
  input: { tenantId: string; userId: string; postId: string },
): Promise<PostRecord> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await loadPost(tx, input.tenantId, input.postId);
    if (!existing) throw new PostDomainError("POST_NOT_FOUND");
    if (existing.status !== "draft" && existing.status !== "scheduled") {
      throw new PostDomainError("POST_NOT_CANCELLABLE");
    }
    await tx
      .update(posts)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.cancelled",
      meta: { postId: input.postId },
    });
    const cancelled = await loadPost(tx, input.tenantId, input.postId);
    if (!cancelled) throw new PostDomainError("POST_NOT_FOUND");
    return cancelled;
  });
}

// ---------------------------------------------------------------------------
// Sisi worker — klaim, muat untuk dikirim, penanda hasil
// ---------------------------------------------------------------------------

export interface PostPublishPayload {
  postId: string;
  channelAccountId: string;
  caption: string;
  chatId: string;
  encryptedToken: string | null;
  provider: string;
  media: Array<{
    r2Key: string;
    mimeType: string | null;
    fileName: string | null;
    kind: PostMediaKind;
  }>;
}

/**
 * Klaim atomik `scheduled → publishing`.
 *
 * `expectedScheduledAt` wajib: job lama (dari penjadwalan sebelumnya) tidak
 * boleh menerbitkan postingan yang sudah dijadwal ulang. Perbandingan
 * memakai kolom `scheduled_at`, jadi tidak perlu menyimpan id job.
 */
export async function claimPostForPublish(
  db: Database,
  input: { tenantId: string; postId: string; expectedScheduledAt: Date },
): Promise<
  | { kind: "claimed" }
  | { kind: "not_found" }
  | { kind: "skipped"; status: PostStatus }
> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const claimed = await tx
      .update(posts)
      .set({ status: "publishing", updatedAt: new Date() })
      .where(
        and(
          eq(posts.tenantId, input.tenantId),
          eq(posts.id, input.postId),
          eq(posts.status, "scheduled"),
          eq(posts.scheduledAt, input.expectedScheduledAt),
        ),
      )
      .returning({ id: posts.id });
    if (claimed.length > 0) return { kind: "claimed" as const };

    const [row] = await tx
      .select({ status: posts.status })
      .from(posts)
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)))
      .limit(1);
    if (!row) return { kind: "not_found" as const };
    return { kind: "skipped" as const, status: row.status };
  });
}

/** Muat semua yang dibutuhkan pengirim, dalam konteks tenant pemiliknya. */
export async function getPostForPublish(
  db: Database,
  input: { tenantId: string; postId: string },
): Promise<PostPublishPayload | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        caption: posts.caption,
        channelAccountId: posts.channelAccountId,
        chatId: conversations.providerChatId,
        provider: conversations.provider,
        encryptedToken: channelAccounts.accessTokenEncrypted,
      })
      .from(posts)
      .innerJoin(conversations, eq(conversations.id, posts.conversationId))
      .innerJoin(
        channelAccounts,
        eq(channelAccounts.id, posts.channelAccountId),
      )
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)))
      .limit(1);
    if (!row || !row.chatId) return null;

    const files = await tx
      .select({
        r2Key: media.r2Key,
        mimeType: media.mimeType,
        fileName: media.fileName,
        position: postMedia.position,
      })
      .from(postMedia)
      .innerJoin(media, eq(media.id, postMedia.mediaId))
      .where(eq(postMedia.postId, input.postId))
      .orderBy(asc(postMedia.position));

    return {
      postId: input.postId,
      channelAccountId: row.channelAccountId,
      caption: row.caption,
      chatId: row.chatId,
      encryptedToken: row.encryptedToken,
      provider: row.provider,
      media: files.map((file) => ({
        r2Key: file.r2Key,
        mimeType: file.mimeType,
        fileName: file.fileName,
        kind: postMediaKind(file.mimeType),
      })),
    };
  });
}

export async function markPostPublished(
  db: Database,
  input: { tenantId: string; postId: string; providerMessageId: string },
): Promise<void> {
  await withTenantDb(db, input.tenantId, async (tx) => {
    await tx
      .update(posts)
      .set({
        status: "published",
        publishedAt: new Date(),
        providerMessageId: input.providerMessageId,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)));
  });
}

export async function markPostFailed(
  db: Database,
  input: { tenantId: string; postId: string; errorCode: string },
): Promise<void> {
  await withTenantDb(db, input.tenantId, async (tx) => {
    await tx
      .update(posts)
      .set({
        status: "failed",
        errorCode: input.errorCode.slice(0, 128),
        updatedAt: new Date(),
      })
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)));
  });
}
