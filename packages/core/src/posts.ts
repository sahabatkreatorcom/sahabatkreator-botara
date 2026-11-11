import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  channelIdentities,
  contacts,
  conversations,
  media,
  outboxEvents,
  postGroups,
  postMedia,
  posts,
  type Database,
  type PostStatus,
} from "@sahabat-kreator/db";
import {
  POST_MEDIA_MAX,
  getPostProviderCapability,
  type PostMediaKind,
  type PostProviderCapability,
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
  | "POST_NOT_RETRYABLE"
  | "POST_NOT_PUBLISHING"
  | "POST_EMPTY"
  | "POST_CAPTION_TOO_LONG"
  | "POST_MEDIA_REQUIRED"
  | "POST_MEDIA_TOO_MANY"
  | "POST_MEDIA_KIND_UNSUPPORTED";

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
  /** Grup multi-target (migrasi 0013); null = post tunggal. */
  groupId: string | null;
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
 * Capability provider sasaran sebuah postingan. Provider di luar enum
 * kontrak (baris lama, data menyimpang) diperlakukan sebagai Telegram —
 * nilai capability yang PALING KETAT — agar validasi gagal aman, bukan
 * gagal longgar.
 */
function capabilityFor(provider: string): PostProviderCapability {
  return (
    getPostProviderCapability(provider) ??
    getPostProviderCapability("telegram")!
  );
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
 * Provider linimasa yang akun terhubungnya SENDIRI adalah sasarannya.
 * Berbeda dari Telegram — yang sasaran channel-nya baru diketahui saat
 * bot ditambahkan ke sebuah channel oleh admin — Page, akun IG
 * Business, dan akun Threads sudah membawa alamat terbitnya sejak
 * connect: `external_id` akun adalah Page ID / IG user ID / Threads
 * user ID. Karena itu tidak ada tabel sasaran baru: sasaran
 * dimaterialisasi sebagai percakapan `kind='channel'` dengan
 * `provider_chat_id = external_id`, persis bentuk yang sudah dipakai
 * state machine post. Untuk Threads ini murni sasaran publikasi —
 * provider itu tidak menjadi channel inbox hanya karena sasarannya
 * memakai baris percakapan channel.
 */
const TIMELINE_ACCOUNT_PROVIDERS = ["messenger", "instagram", "threads"] as const;

/**
 * Materialisasi idempoten sasaran linimasa untuk akun terhubung.
 *
 * Kontak jangkar adalah akun itu sendiri (pola `ensureTelegramChannel`):
 * identitas `(channel_account_id, external_id akun)` menunjuk ke satu
 * kontak bernama akun, dan satu percakapan channel menunjuk balik ke
 * akun tersebut. Fungsi ini dipanggil dari `listPostTargets` karena
 * daftar sasaran adalah permukaan yang memang harus mencerminkan akun
 * yang baru terhubung; ia tidak membuat postingan dan tidak memanggil
 * provider. Panggilan berulang menemukan baris yang sama.
 */
async function ensureTimelineTargets(
  tx: DbTx,
  tenantId: string,
): Promise<void> {
  const accounts = await tx
    .select({
      id: channelAccounts.id,
      provider: channelAccounts.provider,
      externalId: channelAccounts.externalId,
      displayName: channelAccounts.displayName,
      publicHandle: channelAccounts.publicHandle,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.status, "connected"),
        inArray(channelAccounts.provider, [...TIMELINE_ACCOUNT_PROVIDERS]),
      ),
    );

  for (const account of accounts) {
    const label =
      account.displayName ?? account.publicHandle ?? account.externalId;

    const [identity] = await tx
      .select({ contactId: channelIdentities.contactId })
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channelAccountId, account.id),
          eq(channelIdentities.externalUserId, account.externalId),
        ),
      )
      .limit(1);

    let contactId = identity?.contactId;
    if (!contactId) {
      const [contact] = await tx
        .insert(contacts)
        .values({ tenantId, name: label })
        .returning({ id: contacts.id });
      contactId = contact!.id;
      await tx.insert(channelIdentities).values({
        tenantId,
        contactId,
        channelAccountId: account.id,
        provider: account.provider,
        externalUserId: account.externalId,
        username: account.publicHandle,
      });
    }

    const [existing] = await tx
      .select({
        id: conversations.id,
        title: conversations.title,
        kind: conversations.kind,
        provider: conversations.provider,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.channelAccountId, account.id),
          eq(conversations.providerChatId, account.externalId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);

    if (existing) {
      if (
        existing.kind !== "channel" ||
        existing.provider !== account.provider ||
        existing.title !== label
      ) {
        await tx
          .update(conversations)
          .set({
            kind: "channel",
            provider: account.provider,
            title: label,
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, existing.id));
      }
      continue;
    }

    await tx.insert(conversations).values({
      tenantId,
      channelAccountId: account.id,
      contactId,
      provider: account.provider,
      providerChatId: account.externalId,
      title: label,
      kind: "channel",
      status: "open",
    });
  }
}

/**
 * Channel yang bisa dituju: percakapan `kind='channel'` pada akun yang
 * masih terhubung. Percakapan channel Telegram dibuat saat bot
 * ditambahkan sebagai admin (webhook `my_chat_member` / `channel_post`);
 * sasaran Page/IG/Threads dimaterialisasi dari akun terhubung oleh
 * `ensureTimelineTargets` di atas. Daftar kosong berarti belum ada
 * channel/akun linimasa yang terhubung, dan UI menampilkan instruksi
 * alih-alih pemilih kosong.
 */
export async function listPostTargets(
  db: Database,
  input: { tenantId: string },
): Promise<PostTarget[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    await ensureTimelineTargets(tx, input.tenantId);
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
      groupId: posts.groupId,
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
    groupId: row.groupId,
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
        groupId: posts.groupId,
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
      groupId: row.groupId,
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

interface ResolvedPostTarget {
  channelAccountId: string;
  provider: string;
}

/**
 * Validasi sasaran saat PEMBUATAN (bukan saat jadwal) supaya pengguna
 * tahu lebih awal kalau channel-nya sudah tidak terhubung. Dipakai
 * bersama oleh pembuatan tunggal dan grup.
 */
async function resolvePostTarget(
  tx: DbTx,
  tenantId: string,
  conversationId: string,
): Promise<ResolvedPostTarget> {
  const [target] = await tx
    .select({
      channelAccountId: conversations.channelAccountId,
      provider: conversations.provider,
      status: channelAccounts.status,
    })
    .from(conversations)
    .innerJoin(
      channelAccounts,
      eq(channelAccounts.id, conversations.channelAccountId),
    )
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.id, conversationId),
        eq(conversations.kind, "channel"),
      ),
    )
    .limit(1);
  if (!target) throw new PostDomainError("POST_TARGET_NOT_FOUND");
  if (target.status !== "connected") {
    throw new PostDomainError("POST_TARGET_NOT_CONNECTED");
  }
  return target;
}

/**
 * Sisipkan satu baris draft + lampirannya. Caption dipotong ke batas
 * provider SASARAN (capability), bukan konstanta global — dulu semua
 * provider mewarisi 1024 ala Telegram hanya karena batasnya tinggal
 * di jalur pembuatan tunggal.
 */
async function insertDraftPost(
  tx: DbTx,
  input: {
    tenantId: string;
    userId: string;
    target: ResolvedPostTarget;
    conversationId: string;
    groupId: string | null;
    title: string;
    caption: string;
    mediaIds: string[];
  },
): Promise<string> {
  const [row] = await tx
    .insert(posts)
    .values({
      tenantId: input.tenantId,
      channelAccountId: input.target.channelAccountId,
      conversationId: input.conversationId,
      groupId: input.groupId,
      title: input.title,
      caption: input.caption.slice(
        0,
        capabilityFor(input.target.provider).maxCaption,
      ),
      status: "draft",
      createdByUserId: input.userId,
    })
    .returning({ id: posts.id });
  await replaceMedia(tx, input.tenantId, row!.id, input.mediaIds);
  return row!.id;
}

/** Buat draft tunggal. */
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
    const target = await resolvePostTarget(
      tx,
      input.tenantId,
      input.conversationId,
    );
    const postId = await insertDraftPost(tx, {
      tenantId: input.tenantId,
      userId: input.userId,
      target,
      conversationId: input.conversationId,
      groupId: null,
      title: input.title,
      caption: input.caption,
      mediaIds: input.mediaIds,
    });
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.created",
      meta: {
        postId,
        conversationId: input.conversationId,
        mediaCount: input.mediaIds.length,
      },
    });
    const created = await loadPost(tx, input.tenantId, postId);
    if (!created) throw new PostDomainError("POST_NOT_FOUND");
    return created;
  });
}

export interface PostGroupRecord {
  groupId: string;
  posts: PostRecord[];
}

/**
 * Buat konten multi-target (Gelombang 0, butir 3): satu grup, N draft —
 * satu per sasaran, dalam SATU transaksi. Gagal memvalidasi satu
 * sasaran = tidak ada satu pun yang dibuat; pengguna tidak pernah
 * ditinggal dengan grup setengah jadi yang separuhnya hilang.
 *
 * Penjadwalan TIDAK dilakukan di sini: tiap anggota tetap dijadwalkan
 * (dan terbit/gagal) sendiri-sendiri lewat jalur yang sudah ada, karena
 * state machine-nya memang per linimasa.
 */
export async function createPostGroup(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    title: string;
    caption: string;
    mediaIds: string[];
    targets: Array<{ conversationId: string; caption?: string }>;
  },
): Promise<PostGroupRecord> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    // Sasaran ganda pada permintaan yang sama dibuang: dua baris untuk
    // linimasa yang sama dalam satu grup adalah kirim ganda yang
    // direncanakan, bukan fitur.
    const uniqueTargets = [
      ...new Map(input.targets.map((t) => [t.conversationId, t])).values(),
    ];
    if (uniqueTargets.length === 0) {
      throw new PostDomainError("POST_TARGET_NOT_FOUND");
    }
    const resolved = new Map<string, ResolvedPostTarget>();
    for (const target of uniqueTargets) {
      resolved.set(
        target.conversationId,
        await resolvePostTarget(tx, input.tenantId, target.conversationId),
      );
    }

    const [group] = await tx
      .insert(postGroups)
      .values({
        tenantId: input.tenantId,
        title: input.title,
        createdByUserId: input.userId,
      })
      .returning({ id: postGroups.id });

    const postIds: string[] = [];
    for (const target of uniqueTargets) {
      postIds.push(
        await insertDraftPost(tx, {
          tenantId: input.tenantId,
          userId: input.userId,
          target: resolved.get(target.conversationId)!,
          conversationId: target.conversationId,
          groupId: group!.id,
          title: input.title,
          caption: target.caption ?? input.caption,
          mediaIds: input.mediaIds,
        }),
      );
    }
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_group.created",
      meta: {
        groupId: group!.id,
        postIds,
        targetCount: postIds.length,
        mediaCount: input.mediaIds.length,
      },
    });

    const created: PostRecord[] = [];
    for (const postId of postIds) {
      const post = await loadPost(tx, input.tenantId, postId);
      if (!post) throw new PostDomainError("POST_NOT_FOUND");
      created.push(post);
    }
    return { groupId: group!.id, posts: created };
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
          ? {
              caption: input.caption.slice(
                0,
                capabilityFor(existing.target.provider).maxCaption,
              ),
            }
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
/**
 * Semua pemeriksaan isi yang harus lolos SEBELUM sebuah post boleh
 * memegang jam tayang: gerbang provider (capability), kekosongan, dan
 * kesesuaian format per provider. Dipakai bersama oleh penjadwalan
 * pertama dan penjadwalan ulang manual (retry) — post yang gagal lalu
 * dicoba lagi tidak boleh melewati gerbang yang lebih longgar daripada
 * post yang baru pertama dijadwalkan.
 */
function assertPostContentSchedulable(existing: PostRecord): void {
  // Gerbang provider membaca capability (Gelombang 0), menggantikan
  // pemeriksaan keras `provider !== "telegram"`: provider tanpa
  // PublisherAdapter terdaftar tetap ditolak dengan kode yang sama.
  const capability = capabilityFor(existing.target.provider);
  if (!capability.publishSupported) {
    throw new PostDomainError("POST_TARGET_NOT_FOUND");
  }
  if (!existing.target.providerChatId) {
    throw new PostDomainError("POST_TARGET_NOT_FOUND");
  }
  if (existing.caption.trim().length === 0 && existing.media.length === 0) {
    throw new PostDomainError("POST_EMPTY");
  }
  // Validasi format per provider — semuanya harus tertangkap SEBELUM
  // jam tayang. Caption yang lolos pembuatan (dipotong per capability
  // sasaran asal) bisa menjadi terlalu panjang bila sasaran berganti
  // konteks, mis. lewat grup multi-target di masa depan.
  if (existing.caption.length > capability.maxCaption) {
    throw new PostDomainError("POST_CAPTION_TOO_LONG");
  }
  if (capability.mediaRequired && existing.media.length === 0) {
    throw new PostDomainError("POST_MEDIA_REQUIRED");
  }
  if (existing.media.length > capability.maxMedia) {
    throw new PostDomainError("POST_MEDIA_TOO_MANY");
  }
  if (
    (!capability.supportsVideo &&
      existing.media.some((item) => item.kind === "video")) ||
    (!capability.supportsDocuments &&
      existing.media.some((item) => item.kind === "document"))
  ) {
    throw new PostDomainError("POST_MEDIA_KIND_UNSUPPORTED");
  }
  if (existing.media.length > 1) {
    // Album bukan hak semua provider, dan dokumen di tengah album
    // ditolak Bot API Telegram — keduanya ditolak di sini, bukan
    // saat provider menjawab error di jam tayang.
    if (!capability.supportsAlbum) {
      throw new PostDomainError("POST_MEDIA_ALBUM_UNSUPPORTED");
    }
    if (
      !capability.supportsAlbumDocuments &&
      existing.media.some((item) => item.kind === "document")
    ) {
      throw new PostDomainError("POST_MEDIA_ALBUM_UNSUPPORTED");
    }
  }
}

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
    assertPostContentSchedulable(existing);

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

/**
 * Jadwalkan ulang post yang GAGAL — secara manual, oleh manusia, satu
 * kali per tindakan (Gelombang 0, butir 5).
 *
 * Ini BUKAN auto-retry dan tidak mengubah filosofi attempts-1 Fase 23:
 * sistem tidak pernah mencoba ulang sendiri, karena kegagalan setelah
 * provider menerima kiriman tidak bisa dibedakan dari keberhasilan
 * yang laporannya hilang. Yang berubah hanyalah bahwa operator tidak
 * lagi harus membuat post baru dari nol untuk mencoba lagi: post yang
 * sama divalidasi ulang persis seperti penjadwalan pertama (gerbang
 * yang sama), catatan errornya dibersihkan, dan tindakannya teraudit
 * sebagai `post.retried` dengan kode error sebelumnya ikut tercatat.
 *
 * Guard status di WHERE adalah pertahanan terhadap balapan: dua klik
 * retry bersamaan tidak boleh menghasilkan dua event publish_due.
 */
export async function retryPost(
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
    if (existing.status !== "failed") {
      throw new PostDomainError("POST_NOT_RETRYABLE");
    }
    assertPostContentSchedulable(existing);

    const now = new Date();
    const requested =
      input.scheduledAt && input.scheduledAt.getTime() > now.getTime()
        ? input.scheduledAt
        : now;

    const updated = await tx
      .update(posts)
      .set({
        status: "scheduled",
        scheduledAt: requested,
        errorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(posts.tenantId, input.tenantId),
          eq(posts.id, input.postId),
          eq(posts.status, "failed"),
        ),
      )
      .returning({ id: posts.id });
    if (updated.length === 0) {
      throw new PostDomainError("POST_NOT_RETRYABLE");
    }

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
      action: "post.retried",
      meta: {
        postId: input.postId,
        scheduledAt: requested.toISOString(),
        previousErrorCode: existing.errorCode,
      },
    });

    const retried = await loadPost(tx, input.tenantId, input.postId);
    if (!retried) throw new PostDomainError("POST_NOT_FOUND");
    return { kind: "scheduled" as const, post: retried, dispatchAt: requested };
  });
}

/**
 * Bebaskan post yang macet di `publishing` (Gelombang 0, butir 5).
 *
 * Post bisa tertinggal di status ini bila worker mati di antara klaim
 * dan panggilan provider, atau sesudah provider menerima kiriman
 * tetapi sebelum hasilnya tercatat. Pada titik itu sistem TIDAK TAHU
 * apakah postingan sudah tayang — dan tidak akan pernah tahu dari
 * dalam. Karena itu aksi ini secara eksplisit BUKAN retry: status
 * dipindah ke `failed` dengan kode `publish_outcome_unknown` — kode
 * itulah penjelasan untuk operator (UI menerjemahkannya menjadi
 * "periksa linimasa sebelum menjadwalkan ulang") — supaya manusia
 * yang memeriksa linimasa channel yang memutuskan langkah berikutnya
 * (jadwalkan ulang lewat retryPost, atau biarkan). Teraudit sebagai
 * `post.publish_released`.
 */
export async function releaseStuckPost(
  db: Database,
  input: { tenantId: string; userId: string; postId: string },
): Promise<PostRecord> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await loadPost(tx, input.tenantId, input.postId);
    if (!existing) throw new PostDomainError("POST_NOT_FOUND");
    if (existing.status !== "publishing") {
      throw new PostDomainError("POST_NOT_PUBLISHING");
    }

    const updated = await tx
      .update(posts)
      .set({
        status: "failed",
        errorCode: "publish_outcome_unknown",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(posts.tenantId, input.tenantId),
          eq(posts.id, input.postId),
          eq(posts.status, "publishing"),
        ),
      )
      .returning({ id: posts.id });
    if (updated.length === 0) {
      throw new PostDomainError("POST_NOT_PUBLISHING");
    }

    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.publish_released",
      meta: { postId: input.postId, fromStatus: "publishing" },
    });

    const released = await loadPost(tx, input.tenantId, input.postId);
    if (!released) throw new PostDomainError("POST_NOT_FOUND");
    return released;
  });
}

/**
 * Duplikat post menjadi draft BARU (Gelombang 0, butir 5): judul,
 * caption, media, dan sasaran disalin; jadwal dan hasil publikasi
 * TIDAK — duplikat selalu lahir sebagai draft yang belum terjadwal,
 * apa pun status sumbernya.
 *
 * Keanggotaan grup ikut disalin: menduplikat anggota kampanye berarti
 * menambah satu kiriman lagi ke kampanye yang sama, bukan memulai
 * kampanye baru yang mirip. Sasaran divalidasi ulang seperti pembuatan
 * biasa — channel yang sudah putus sejak post asal dibuat menolak
 * duplikat dengan kode yang sama seperti pembuatan baru.
 */
export async function duplicatePost(
  db: Database,
  input: { tenantId: string; userId: string; postId: string },
): Promise<PostRecord> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const source = await loadPost(tx, input.tenantId, input.postId);
    if (!source) throw new PostDomainError("POST_NOT_FOUND");
    const target = await resolvePostTarget(
      tx,
      input.tenantId,
      source.target.conversationId,
    );
    const newPostId = await insertDraftPost(tx, {
      tenantId: input.tenantId,
      userId: input.userId,
      target,
      conversationId: source.target.conversationId,
      groupId: source.groupId,
      title: source.title,
      caption: source.caption,
      mediaIds: source.media.map((item) => item.mediaId),
    });
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.duplicated",
      meta: { postId: newPostId, sourcePostId: input.postId },
    });
    const created = await loadPost(tx, input.tenantId, newPostId);
    if (!created) throw new PostDomainError("POST_NOT_FOUND");
    return created;
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

/**
 * Intip provider sasaran sebuah postingan — read-only, BUKAN klaim.
 *
 * Dipakai worker (registry `PublisherAdapter`) untuk memilih adapter
 * SEBELUM menjalankan alur publikasi. Membaca provider tidak mengubah
 * jaminan apa pun: klaim atomik tetap terjadi di dalam adapter lewat
 * `claimPostForPublish`, dan postingan yang sudah dibatalkan/dijadwal
 * ulang tetap ditolak di sana. `null` = postingan tidak ada (atau bukan
 * milik tenant ini, yang oleh RLS tampak sama).
 */
export async function getPostTargetProvider(
  db: Database,
  input: { tenantId: string; postId: string },
): Promise<string | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select({ provider: conversations.provider })
      .from(posts)
      .innerJoin(conversations, eq(conversations.id, posts.conversationId))
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)))
      .limit(1);
    return row?.provider ?? null;
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
