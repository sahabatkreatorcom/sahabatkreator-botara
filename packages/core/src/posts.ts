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
  tenantMembers,
  tenants,
  users,
  type Database,
  type PostApprovalStatus,
  type PostStatus,
} from "@sahabat-kreator/db";
import {
  POST_MEDIA_MAX,
  PostPublishOptionsSchema,
  getPostProviderCapability,
  type PostMediaKind,
  type PostProviderCapability,
  type PostPublishOptions,
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
  | "POST_TITLE_TOO_LONG"
  | "POST_MEDIA_REQUIRED"
  | "POST_MEDIA_TOO_MANY"
  | "POST_MEDIA_KIND_UNSUPPORTED"
  | "POST_PUBLISH_OPTIONS_REQUIRED"
  | "POST_PUBLISH_OPTIONS_INVALID"
  | "POST_APPROVAL_INVALID_STATE"
  | "POST_APPROVAL_NOTE_REQUIRED"
  | "POST_APPROVAL_SELF_REVIEW";

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
  /** Opsi penerbitan per target (privasi/AI/dst.); null = belum dipilih. */
  publishOptions: PostPublishOptions | null;
  /** Pembuat postingan; null bila akunnya sudah dihapus. */
  createdByUserId: string | null;
  /** Keadaan persetujuan (S1) — lihat blok persetujuan di bawah. */
  approvalStatus: PostApprovalStatus;
  /** Catatan keputusan terakhir peninjau; null = belum ada keputusan. */
  approvalNote: string | null;
  approvalSubmittedByUserId: string | null;
  approvalSubmittedAt: Date | null;
  approvalReviewedByUserId: string | null;
  approvalReviewedAt: Date | null;
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
 * Baca kolom `publish_options` (jsonb) menjadi bentuk kontrak.
 * Nilai menyimpang/rusak diperlakukan sebagai "belum dipilih" (null)
 * — bukan meledak saat membaca daftar: konsekuensinya jatuh ke
 * gerbang penjadwalan dan resolusi bawaan adapter, yang memang
 * dirancang untuk keadaan tanpa pilihan.
 */
function parsePublishOptions(value: unknown): PostPublishOptions | null {
  if (value === null || value === undefined) return null;
  const parsed = PostPublishOptionsSchema.safeParse(value);
  if (!parsed.success) return null;
  return Object.keys(parsed.data).length > 0 ? parsed.data : null;
}

/**
 * Bersihkan opsi menurut provider SASARAN baris ini: field milik
 * platform lain dibuang saat penulisan, supaya baris tidak pernah
 * membawa pilihan basi lintas platform (mis. privasi TikTok pada
 * baris YouTube hasil duplikat/grup campuran). Mengembalikan null
 * bila tidak ada field yang relevan — kolomnya memang NULL untuk
 * "belum memilih", bukan objek kosong.
 */
function sanitizePublishOptions(
  provider: string,
  options: PostPublishOptions | null | undefined,
): PostPublishOptions | null {
  if (!options) return null;
  const clean: PostPublishOptions = {};
  if (provider === "youtube") {
    if (options.youtubePrivacyStatus !== undefined) {
      clean.youtubePrivacyStatus = options.youtubePrivacyStatus;
    }
    if (options.aiGenerated !== undefined) {
      clean.aiGenerated = options.aiGenerated;
    }
    if (options.madeForKids !== undefined) {
      clean.madeForKids = options.madeForKids;
    }
  } else if (provider === "tiktok") {
    if (options.tiktokPrivacyLevel !== undefined) {
      clean.tiktokPrivacyLevel = options.tiktokPrivacyLevel;
    }
    if (options.aiGenerated !== undefined) {
      clean.aiGenerated = options.aiGenerated;
    }
    if (options.tiktokAllowComment !== undefined) {
      clean.tiktokAllowComment = options.tiktokAllowComment;
    }
    if (options.tiktokAllowDuet !== undefined) {
      clean.tiktokAllowDuet = options.tiktokAllowDuet;
    }
    if (options.tiktokAllowStitch !== undefined) {
      clean.tiktokAllowStitch = options.tiktokAllowStitch;
    }
    if (options.tiktokBrandOrganic !== undefined) {
      clean.tiktokBrandOrganic = options.tiktokBrandOrganic;
    }
    if (options.tiktokBrandContent !== undefined) {
      clean.tiktokBrandContent = options.tiktokBrandContent;
    }
  } else if (provider === "pinterest") {
    // Board tujuan Pin untuk postingan ini (resolusi berlapis di
    // penerbit: postingan → bawaan akun Channels → board pertama).
    // Keanggotaan board pada akun divalidasi lapisan API saat opsi
    // ditulis dan oleh resolver penerbit saat publish.
    if (options.pinterestBoardId !== undefined) {
      clean.pinterestBoardId = options.pinterestBoardId;
    }
  }
  return Object.keys(clean).length > 0 ? clean : null;
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

/** Kolom pembuat + persetujuan (S1), dipakai bersama daftar dan muat satu. */
function approvalSelection() {
  return {
    createdByUserId: posts.createdByUserId,
    approvalStatus: posts.approvalStatus,
    approvalNote: posts.approvalNote,
    approvalSubmittedByUserId: posts.approvalSubmittedByUserId,
    approvalSubmittedAt: posts.approvalSubmittedAt,
    approvalReviewedByUserId: posts.approvalReviewedByUserId,
    approvalReviewedAt: posts.approvalReviewedAt,
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
 * Business, akun Threads, akun Bluesky, channel YouTube, profil
 * LinkedIn, akun Pinterest, lokasi Google Business, dan akun TikTok
 * sudah membawa alamat terbitnya sejak connect: `external_id`
 * akun adalah Page ID / IG user ID / Threads user ID / DID Bluesky /
 * channel ID YouTube / member ID LinkedIn / Pinterest user ID / nama
 * resource lokasi Google Business / open_id TikTok. Karena itu tidak
 * ada tabel sasaran baru: sasaran dimaterialisasi sebagai percakapan
 * `kind='channel'` dengan `provider_chat_id = external_id`, persis
 * bentuk yang sudah dipakai state machine post. Untuk Threads,
 * Bluesky, YouTube, dan LinkedIn ini murni sasaran publikasi —
 * provider itu tidak menjadi channel inbox hanya karena sasarannya
 * memakai baris percakapan channel. Khusus YouTube, baris akunnya
 * sendiri disinkronkan dari koneksi Google tenant oleh
 * `syncYouTubeChannelAccount` (core/youtube) — kredensial penerbitan
 * tetap hidup di koneksi Google, bukan di akun channel. Hal yang sama
 * berlaku untuk lokasi Google Business lewat
 * `syncGoogleBusinessLocationAccounts` (core/google-business).
 */
const TIMELINE_ACCOUNT_PROVIDERS = [
  "messenger",
  "instagram",
  "threads",
  "bluesky",
  "youtube",
  "linkedin",
  "pinterest",
  "google_business",
  "tiktok",
] as const;

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
 * sasaran Page/IG/Threads/Bluesky/YouTube/LinkedIn/Pinterest/Google Business dimaterialisasi dari akun terhubung oleh
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
      publishOptions: posts.publishOptions,
      createdAt: posts.createdAt,
      updatedAt: posts.updatedAt,
      ...approvalSelection(),
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
    publishOptions: parsePublishOptions(row.publishOptions),
    createdByUserId: row.createdByUserId,
    approvalStatus: row.approvalStatus,
    approvalNote: row.approvalNote,
    approvalSubmittedByUserId: row.approvalSubmittedByUserId,
    approvalSubmittedAt: row.approvalSubmittedAt,
    approvalReviewedByUserId: row.approvalReviewedByUserId,
    approvalReviewedAt: row.approvalReviewedAt,
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
  input: {
    tenantId: string;
    status?: PostStatus;
    /** Saringan antrean tinjauan (S1): keadaan persetujuan persis. */
    approvalStatus?: PostApprovalStatus;
    limit?: number;
  },
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
        publishOptions: posts.publishOptions,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        ...approvalSelection(),
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
          input.approvalStatus
            ? eq(posts.approvalStatus, input.approvalStatus)
            : undefined,
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
      publishOptions: parsePublishOptions(row.publishOptions),
      createdByUserId: row.createdByUserId,
      approvalStatus: row.approvalStatus,
      approvalNote: row.approvalNote,
      approvalSubmittedByUserId: row.approvalSubmittedByUserId,
      approvalSubmittedAt: row.approvalSubmittedAt,
      approvalReviewedByUserId: row.approvalReviewedByUserId,
      approvalReviewedAt: row.approvalReviewedAt,
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
    publishOptions?: PostPublishOptions | null | undefined;
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
      // Opsi dibersihkan menurut provider baris ini (satu tempat,
      // dipakai semua jalur pembuatan termasuk duplikat).
      publishOptions: sanitizePublishOptions(
        input.target.provider,
        input.publishOptions,
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
    publishOptions?: PostPublishOptions | null | undefined;
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
      publishOptions: input.publishOptions,
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
    targets: Array<{
      conversationId: string;
      caption?: string;
      publishOptions?: PostPublishOptions | null | undefined;
    }>;
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
          publishOptions: target.publishOptions,
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
    /** undefined = tidak diubah; null = kosongkan pilihan. */
    publishOptions?: PostPublishOptions | null | undefined;
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
    // Persetujuan menempel pada ISI (S1): suntingan apa pun pada post
    // yang sudah pernah diajukan/disetujui membatalkan persetujuannya
    // — keadaan kembali ke `draft` (belum diajukan) dan catatan
    // keputusan terakhir dibersihkan. Tanpa ini, persetujuan untuk
    // teks A bisa menerbitkan teks B. Reset hanya menyentuh baris ini;
    // anggota grup lain mempertahankan keadaannya sampai tindakan
    // persetujuan grup berikutnya mensinkronkan unit.
    const approvalReset =
      existing.approvalStatus !== "draft" ? existing.approvalStatus : null;
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
        ...(input.publishOptions !== undefined
          ? {
              publishOptions: sanitizePublishOptions(
                existing.target.provider,
                input.publishOptions,
              ),
            }
          : {}),
        ...(approvalReset
          ? {
              approvalStatus: "draft" as const,
              approvalNote: null,
              approvalSubmittedByUserId: null,
              approvalSubmittedAt: null,
              approvalReviewedByUserId: null,
              approvalReviewedAt: null,
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
      meta: {
        postId: input.postId,
        ...(approvalReset ? { approvalResetFrom: approvalReset } : {}),
      },
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
  if (
    capability.maxTitle !== null &&
    existing.title.trim().length > capability.maxTitle
  ) {
    // Provider yang memetakan `title` post ke judul platform (YouTube:
    // judul video maks 100) — judul adalah field wajib yang tidak
    // dipotong diam-diam saat pembuatan seperti caption, jadi kelebihan
    // harus tertangkap di sini sebelum antre, bukan ditolak YouTube
    // saat jam tayang.
    throw new PostDomainError("POST_TITLE_TOO_LONG");
  }
  if (capability.mediaRequired && existing.media.length === 0) {
    throw new PostDomainError("POST_MEDIA_REQUIRED");
  }
  if (existing.media.length > capability.maxMedia) {
    throw new PostDomainError("POST_MEDIA_TOO_MANY");
  }
  if (
    (!capability.supportsPhotos &&
      existing.media.some((item) => item.kind === "photo")) ||
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
    // Album khusus foto (TikTok/LinkedIn/Facebook Page): video apa
    // pun di dalam kumpulan multi-media — dua video, atau campuran
    // foto+video — ditolak di sini juga. Untuk provider itu video
    // hanya sah sendirian, tepat satu; membiarkannya lolos berarti
    // kegagalan pasti di adapter pada jam tayang.
    if (
      !capability.supportsVideoAlbum &&
      existing.media.some((item) => item.kind === "video")
    ) {
      throw new PostDomainError("POST_MEDIA_ALBUM_UNSUPPORTED");
    }
    if (
      !capability.supportsAlbumDocuments &&
      existing.media.some((item) => item.kind === "document")
    ) {
      throw new PostDomainError("POST_MEDIA_ALBUM_UNSUPPORTED");
    }
  }
  assertPublishOptionsSchedulable(existing, capability);
}

/**
 * Gerbang pilihan penerbitan (gelombang Pilihan Privasi & AI per
 * Postingan) — siapa yang WAJIB memutuskan apa, menurut dokumen
 * resmi platform (riset 2026-11-12, lihat kontrak PostPublishOptions):
 *
 * - Pengungkapan AI (`aiGenerated`): pernyataan ISI per postingan.
 *   Untuk provider yang capability-nya mendukung pengungkapan
 *   (YouTube `containsSyntheticMedia`, TikTok `is_aigc`) ia wajib
 *   eksplisit — tidak ada nilai konfigurasi yang boleh mengisinya,
 *   karena mengarang pernyataan isi atas nama kreator adalah
 *   pelanggaran kebijakan kedua platform.
 * - Privasi TikTok: Content Sharing Guidelines mewajibkan kreator
 *   MEMILIH dari dropdown tanpa nilai yang terpilih duluan. Karena
 *   itu sasaran TikTok tanpa `tiktokPrivacyLevel` pada postingannya
 *   TIDAK bisa dijadwalkan — default Panel Admin sengaja TIDAK
 *   menggantikannya di jalur formulir (ia hanya lapis bawaan
 *   adapter untuk postingan lama/non-formulir). Pilihan tetap
 *   divalidasi adapter terhadap `privacy_level_options` akun saat
 *   publish, tanpa penurunan diam-diam.
 * - Privasi YouTube: YouTube tidak melarang preseleksi dan pemilik
 *   memutuskan nilai bawaan platform tetap hidup di Panel Admin —
 *   jadi ketiadaan `youtubePrivacyStatus` pada postingan BUKAN
 *   penolakan: adapter memakai bawaan panel→env saat publish.
 * - Kombinasi tidak sah: konten bermerek TikTok (`brandContent`)
 *   tidak boleh privat menurut Branded Content Policy — pilihan
 *   SELF_ONLY + bermerek ditolak di sini, sebelum jam tayang.
 */
function assertPublishOptionsSchedulable(
  existing: PostRecord,
  capability: PostProviderCapability,
): void {
  const options = existing.publishOptions;
  if (
    capability.publishOptions.supportsAiDisclosure &&
    typeof options?.aiGenerated !== "boolean"
  ) {
    throw new PostDomainError("POST_PUBLISH_OPTIONS_REQUIRED");
  }
  if (existing.target.provider === "tiktok") {
    if (!options?.tiktokPrivacyLevel) {
      throw new PostDomainError("POST_PUBLISH_OPTIONS_REQUIRED");
    }
    if (
      options.tiktokBrandContent === true &&
      options.tiktokPrivacyLevel === "SELF_ONLY"
    ) {
      throw new PostDomainError("POST_PUBLISH_OPTIONS_INVALID");
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
      // Pilihan penerbitan ikut disalin: menduplikat berarti memakai
      // ulang keputusan privasi/AI yang sama untuk kiriman yang sama.
      publishOptions: source.publishOptions,
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
// Persetujuan postingan (Fase Susulan S1)
//
// Model: keadaan persetujuan hidup per baris `posts`, tetapi setiap
// transisi bekerja pada UNIT PERSETUJUAN = post jangkar + seluruh
// anggota grup multi-targetnya. Satu konten induk = satu keputusan —
// menyetujui separuh grup dan menolak separuhnya bukanlah keadaan
// yang bisa diwakili alur ini, sama seperti grup dibuat dalam satu
// transaksi. Post tunggal (group_id NULL) adalah unit satu anggota.
//
// Anggota yang masih BISA DITINDAK adalah yang status publikasinya
// `draft` / `scheduled` / `failed`. Anggota yang sudah `published`,
// sedang `publishing`, atau `cancelled` tidak diubah transisi mana
// pun: yang sudah tayang adalah riwayat, dan keputusan atas sisa
// grup tidak boleh menulis ulang riwayat itu.
//
// Peran ditegakkan lapisan API (owner/admin, gerbang yang sama dengan
// mutasi post lain). Yang ditegakkan DI SINI adalah aturan yang
// membutuhkan data tenant: anti-setuju-sendiri. Pembuat post tidak
// boleh meninjau postingannya sendiri BILA ada penyetuju lain
// (anggota owner/admin lain) di tenant — bila tidak ada (tenant satu
// orang, atau semua anggota lain berperan agent/viewer), pembuat
// BOLEH meninjau sendiri, karena alternatifnya adalah tenant yang
// terkunci dari menerbitkan selamanya. Pembuat yang sudah terhapus
// (created_by_user_id NULL) tidak memicu aturan ini.
//
// Catatan keputusan disimpan di baris post (`approval_note`) dan
// TIDAK disalin ke meta audit — mengikuti preseden repo (isi catatan
// tidak masuk audit); audit hanya mencatat aksi + pelaku + anggota
// unit, dan dari sanalah riwayat keputusan dibaca.
// ---------------------------------------------------------------------------

/** Status publikasi yang masih bisa menerima keputusan persetujuan. */
const APPROVAL_ACTIONABLE_STATUSES: readonly PostStatus[] = [
  "draft",
  "scheduled",
  "failed",
];

interface ApprovalUnitMember {
  id: string;
  status: PostStatus;
  approvalStatus: PostApprovalStatus;
}

/** Seluruh baris unit persetujuan milik post jangkar (grup atau tunggal). */
async function loadApprovalUnit(
  tx: DbTx,
  tenantId: string,
  anchor: PostRecord,
): Promise<ApprovalUnitMember[]> {
  if (!anchor.groupId) {
    return [
      {
        id: anchor.id,
        status: anchor.status,
        approvalStatus: anchor.approvalStatus,
      },
    ];
  }
  return tx
    .select({
      id: posts.id,
      status: posts.status,
      approvalStatus: posts.approvalStatus,
    })
    .from(posts)
    .where(
      and(eq(posts.tenantId, tenantId), eq(posts.groupId, anchor.groupId)),
    );
}

/** Anggota unit yang masih bisa ditindak (belum tayang / belum mati). */
function actionableMembers(
  unit: ApprovalUnitMember[],
): ApprovalUnitMember[] {
  return unit.filter((member) =>
    APPROVAL_ACTIONABLE_STATUSES.includes(member.status),
  );
}

/**
 * Ajukan postingan (unit) ke tinjauan: dari `draft` / `rejected` /
 * `changes_requested` → `pending_review`.
 *
 * Semua anggota yang bisa ditindak harus berada pada salah satu
 * keadaan awal itu — unit yang campurannya memuat `pending_review`
 * (sudah diajukan) atau `approved` (sudah disetujui) ditolak sebagai
 * transisi liar, bukan disinkronkan diam-diam: pengguna harus tahu
 * persis keadaan apa yang sedang ia ajukan. Pengajuan membersihkan
 * catatan + peninjau keputusan sebelumnya (riwayatnya tetap di audit).
 */
export async function submitPostForReview(
  db: Database,
  input: { tenantId: string; userId: string; postId: string },
): Promise<PostRecord> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const anchor = await loadPost(tx, input.tenantId, input.postId);
    if (!anchor) throw new PostDomainError("POST_NOT_FOUND");
    const actionable = actionableMembers(
      await loadApprovalUnit(tx, input.tenantId, anchor),
    );
    if (actionable.length === 0) {
      throw new PostDomainError("POST_APPROVAL_INVALID_STATE");
    }
    const submittable: readonly PostApprovalStatus[] = [
      "draft",
      "rejected",
      "changes_requested",
    ];
    if (
      !actionable.every((member) =>
        submittable.includes(member.approvalStatus),
      )
    ) {
      throw new PostDomainError("POST_APPROVAL_INVALID_STATE");
    }
    const now = new Date();
    await tx
      .update(posts)
      .set({
        approvalStatus: "pending_review",
        approvalNote: null,
        approvalSubmittedByUserId: input.userId,
        approvalSubmittedAt: now,
        approvalReviewedByUserId: null,
        approvalReviewedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(posts.tenantId, input.tenantId),
          inArray(
            posts.id,
            actionable.map((member) => member.id),
          ),
        ),
      );
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post.approval_submitted",
      meta: {
        postId: input.postId,
        groupId: anchor.groupId,
        memberPostIds: actionable.map((member) => member.id),
      },
    });
    const updated = await loadPost(tx, input.tenantId, input.postId);
    if (!updated) throw new PostDomainError("POST_NOT_FOUND");
    return updated;
  });
}

type PostApprovalDecision = "approved" | "rejected" | "changes_requested";

/**
 * Inti keputusan peninjau (setujui / tolak / minta revisi) — satu
 * tempat, supaya ketiga jalur menegakkan gerbang yang sama persis:
 * unit harus seluruhnya `pending_review`, catatan wajib untuk
 * penolakan & revisi, dan aturan anti-setuju-sendiri berlaku sama.
 *
 * Penolakan & permintaan revisi juga MENURUNKAN anggota yang masih
 * `scheduled` kembali ke `draft` (jam tayang dibersihkan): konten
 * yang ditolak tidak boleh memegang jam tayang, dan konten yang
 * diminta revisi harus bisa disunting — edit memang hanya untuk
 * draft. Job publish basi yang telanjur antre tidak berbahaya: klaim
 * penerbit memeriksa status + `scheduled_at`, dan keduanya sudah
 * berubah. Persetujuan TIDAK menyentuh jadwal — post yang disetujui
 * sebelum jam tayangnya tetap terbit pada jamnya.
 */
async function reviewPostApproval(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    postId: string;
    decision: PostApprovalDecision;
    note?: string | null | undefined;
  },
): Promise<PostRecord> {
  const note =
    typeof input.note === "string" && input.note.trim().length > 0
      ? input.note.trim()
      : null;
  if (input.decision !== "approved" && note === null) {
    throw new PostDomainError("POST_APPROVAL_NOTE_REQUIRED");
  }
  return withTenantDb(db, input.tenantId, async (tx) => {
    const anchor = await loadPost(tx, input.tenantId, input.postId);
    if (!anchor) throw new PostDomainError("POST_NOT_FOUND");
    const actionable = actionableMembers(
      await loadApprovalUnit(tx, input.tenantId, anchor),
    );
    if (
      actionable.length === 0 ||
      !actionable.every(
        (member) => member.approvalStatus === "pending_review",
      )
    ) {
      throw new PostDomainError("POST_APPROVAL_INVALID_STATE");
    }

    // Anti-setuju-sendiri: peninjau = pembuat post jangkar → hanya
    // sah bila tenant tidak punya penyetuju (owner/admin) lain.
    if (anchor.createdByUserId && anchor.createdByUserId === input.userId) {
      const others = await tx
        .select({ userId: tenantMembers.userId })
        .from(tenantMembers)
        .where(
          and(
            eq(tenantMembers.tenantId, input.tenantId),
            inArray(tenantMembers.role, ["owner", "admin"]),
          ),
        );
      const otherApprovers = others.filter(
        (member) => member.userId !== anchor.createdByUserId,
      );
      if (otherApprovers.length > 0) {
        throw new PostDomainError("POST_APPROVAL_SELF_REVIEW");
      }
    }

    const now = new Date();
    const memberIds = actionable.map((member) => member.id);
    await tx
      .update(posts)
      .set({
        approvalStatus: input.decision,
        approvalNote: note,
        approvalReviewedByUserId: input.userId,
        approvalReviewedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(posts.tenantId, input.tenantId),
          inArray(posts.id, memberIds),
        ),
      );

    // Tolak / revisi: turunkan yang terjadwal menjadi draft.
    let unscheduledCount = 0;
    if (input.decision !== "approved") {
      const unscheduled = await tx
        .update(posts)
        .set({ status: "draft", scheduledAt: null, updatedAt: now })
        .where(
          and(
            eq(posts.tenantId, input.tenantId),
            inArray(posts.id, memberIds),
            eq(posts.status, "scheduled"),
          ),
        )
        .returning({ id: posts.id });
      unscheduledCount = unscheduled.length;
    }

    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action:
        input.decision === "approved"
          ? "post.approval_approved"
          : input.decision === "rejected"
            ? "post.approval_rejected"
            : "post.approval_changes_requested",
      meta: {
        postId: input.postId,
        groupId: anchor.groupId,
        memberPostIds: memberIds,
        ...(unscheduledCount > 0 ? { unscheduledCount } : {}),
      },
    });
    const updated = await loadPost(tx, input.tenantId, input.postId);
    if (!updated) throw new PostDomainError("POST_NOT_FOUND");
    return updated;
  });
}

/** Setujui postingan yang menunggu tinjauan (catatan opsional). */
export async function approvePost(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    postId: string;
    note?: string | null | undefined;
  },
): Promise<PostRecord> {
  return reviewPostApproval(db, { ...input, decision: "approved" });
}

/** Tolak postingan yang menunggu tinjauan (catatan WAJIB). */
export async function rejectPost(
  db: Database,
  input: { tenantId: string; userId: string; postId: string; note: string },
): Promise<PostRecord> {
  return reviewPostApproval(db, { ...input, decision: "rejected" });
}

/** Minta revisi atas postingan yang menunggu tinjauan (catatan WAJIB). */
export async function requestPostChanges(
  db: Database,
  input: { tenantId: string; userId: string; postId: string; note: string },
): Promise<PostRecord> {
  return reviewPostApproval(db, { ...input, decision: "changes_requested" });
}

// ---------------------------------------------------------------------------
// Pengaturan persetujuan tenant + riwayat keputusan
// ---------------------------------------------------------------------------

export interface PostApprovalSettingsRecord {
  approvalRequired: boolean;
}

/** Baca sakelar persetujuan wajib tenant (bawaan false = nonaktif). */
export async function getPostApprovalSettings(
  db: Database,
  input: { tenantId: string },
): Promise<PostApprovalSettingsRecord> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ postApprovalRequired: tenants.postApprovalRequired })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    return { approvalRequired: tenant?.postApprovalRequired ?? false };
  });
}

/**
 * Ubah sakelar persetujuan wajib. Pola transaksi yang sama dengan
 * `updateTenantSlaSettings` (baris tenant ditulis dalam transaksi
 * ber-config tenant) + audit from/to. Menyalakan sakelar tidak
 * mengubah postingan yang sudah terbit; ia hanya mengaktifkan
 * gerbang penerbitan untuk jam tayang berikutnya.
 */
export async function updatePostApprovalSettings(
  db: Database,
  input: { tenantId: string; userId: string; approvalRequired: boolean },
): Promise<PostApprovalSettingsRecord> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`,
    );
    const [before] = await tx
      .select({ postApprovalRequired: tenants.postApprovalRequired })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    if (!before) throw new PostDomainError("POST_NOT_FOUND");
    await tx
      .update(tenants)
      .set({
        postApprovalRequired: input.approvalRequired,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, input.tenantId));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "post_approval.settings_updated",
      meta: {
        approvalRequiredFrom: before.postApprovalRequired,
        approvalRequiredTo: input.approvalRequired,
      },
    });
    return { approvalRequired: input.approvalRequired };
  });
}

/** Aksi audit yang merupakan riwayat keputusan persetujuan satu post. */
const POST_APPROVAL_HISTORY_ACTIONS = [
  "post.approval_submitted",
  "post.approval_approved",
  "post.approval_rejected",
  "post.approval_changes_requested",
  "post.publish_blocked_approval",
] as const;

export interface PostApprovalHistoryRecord {
  id: string;
  action: string;
  actorType: "user" | "agent" | "system" | "api_key";
  actorId: string | null;
  /** Nama/email user pelaku, nama komponen untuk system; null = tak ter-resolve. */
  actorLabel: string | null;
  /** Post jangkar pada entri audit (anggota grup berbagi riwayat yang sama). */
  postId: string | null;
  createdAt: Date;
}

/**
 * Riwayat keputusan persetujuan sebuah post — dibaca dari
 * `audit_logs`, bukan tabel kedua. Entri milik unit yang sama
 * ditemukan lewat `meta.postId` (jangkar tempat tindakan dilakukan)
 * ATAU `meta.groupId` (untuk post dalam grup, tindakan pada anggota
 * mana pun adalah riwayat grup yang sama).
 */
export async function listPostApprovalHistory(
  db: Database,
  input: { tenantId: string; postId: string; limit?: number },
): Promise<PostApprovalHistoryRecord[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [anchor] = await tx
      .select({ id: posts.id, groupId: posts.groupId })
      .from(posts)
      .where(
        and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)),
      )
      .limit(1);
    if (!anchor) throw new PostDomainError("POST_NOT_FOUND");

    const groupMatch = anchor.groupId
      ? sql` OR ${auditLogs.meta} ->> 'groupId' = ${anchor.groupId}`
      : sql``;
    const rows = await tx
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        meta: auditLogs.meta,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, input.tenantId),
          inArray(auditLogs.action, [...POST_APPROVAL_HISTORY_ACTIONS]),
          sql`(${auditLogs.meta} ->> 'postId' = ${input.postId}${groupMatch})`,
        ),
      )
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(Math.min(100, Math.max(1, input.limit ?? 50)));

    // Resolusi label pelaku — pola yang sama dengan penelusur audit:
    // user → nama/email dari tabel users; system → actorId itu sendiri.
    const userIds = [
      ...new Set(
        rows
          .filter((row) => row.actorType === "user" && row.actorId)
          .map((row) => row.actorId as string),
      ),
    ];
    const labels = new Map<string, string>();
    if (userIds.length > 0) {
      const found = await tx
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds));
      for (const user of found) {
        labels.set(
          user.id,
          user.name && user.name.trim().length > 0 ? user.name : user.email,
        );
      }
    }
    return rows.map((row) => {
      const meta = (row.meta ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        action: row.action,
        actorType: row.actorType,
        actorId: row.actorId,
        actorLabel:
          row.actorType === "system"
            ? row.actorId
            : row.actorId
              ? (labels.get(row.actorId) ?? null)
              : null,
        postId: typeof meta.postId === "string" ? meta.postId : null,
        createdAt: row.createdAt,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Sisi worker — klaim, muat untuk dikirim, penanda hasil
// ---------------------------------------------------------------------------

export interface PostPublishPayload {
  postId: string;
  channelAccountId: string;
  /** Judul post — label kalender umum; YouTube memetakannya ke judul video. */
  title: string;
  caption: string;
  chatId: string;
  encryptedToken: string | null;
  provider: string;
  /** Pilihan penerbitan pengguna per postingan ini; null = belum memilih. */
  publishOptions: PostPublishOptions | null;
  media: Array<{
    r2Key: string;
    mimeType: string | null;
    fileName: string | null;
    kind: PostMediaKind;
  }>;
}

/**
 * Gerbang persetujuan pada jam tayang (S1) — dipanggil dispatcher
 * worker SEBELUM adapter mana pun mengklaim postingan.
 *
 * Bila tenant mengaktifkan persetujuan wajib dan postingan belum
 * `approved`, fungsi ini MEMBLOKIR penerbitan secara tercatat:
 * postingan dipindah `scheduled → failed` dengan kode persis
 * `post_approval_required` (terlihat di UI sebagai alasan kegagalan,
 * lengkap dengan petunjuknya) + baris audit `post.publish_blocked_approval`
 * oleh actor system. Bukan gagal diam-diam, bukan terbit diam-diam.
 *
 * Penjaga atomiknya sama dengan klaim penerbit: transisi hanya
 * terjadi bila baris MASIH `scheduled` pada `scheduled_at` yang
 * disepakati job ini. Job basi milik penjadwalan lama (post sudah
 * dijadwal ulang / dibatalkan / sudah ditangani) tidak memblokir apa
 * pun — dispatcher meneruskan ke adapter dan klaim di sana yang
 * memutuskan, seperti sebelum gerbang ini ada.
 *
 * Aturan jam tayang yang sudah lewat (keputusan S1): yang dinilai
 * adalah keadaan SAAT JOB BERJALAN. Post yang disetujui sesudah jam
 * tayangnya tetapi sebelum job-nya berjalan tetap terbit oleh job
 * itu. Post yang sudah terlanjur terblokir TIDAK terbit otomatis
 * sesudah disetujui — pembuat menjadwalkan ulang secara eksplisit
 * (tombol Coba Lagi / retryPost yang sudah ada), karena penerbitan
 * kejutan pada jam yang tidak lagi diharapkan lebih buruk daripada
 * satu klik yang terlihat.
 */
export async function blockUnapprovedPostPublish(
  db: Database,
  input: { tenantId: string; postId: string; expectedScheduledAt: Date },
): Promise<{ blocked: boolean }> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [tenant] = await tx
      .select({ postApprovalRequired: tenants.postApprovalRequired })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    if (!tenant?.postApprovalRequired) return { blocked: false };

    const [post] = await tx
      .select({
        approvalStatus: posts.approvalStatus,
        groupId: posts.groupId,
      })
      .from(posts)
      .where(
        and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)),
      )
      .limit(1);
    if (!post || post.approvalStatus === "approved") {
      return { blocked: false };
    }

    const blocked = await tx
      .update(posts)
      .set({
        status: "failed",
        errorCode: "post_approval_required",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(posts.tenantId, input.tenantId),
          eq(posts.id, input.postId),
          eq(posts.status, "scheduled"),
          eq(posts.scheduledAt, input.expectedScheduledAt),
        ),
      )
      .returning({ id: posts.id });
    if (blocked.length === 0) return { blocked: false };

    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "system",
      actorId: "post-publisher",
      action: "post.publish_blocked_approval",
      meta: {
        postId: input.postId,
        groupId: post.groupId,
        approvalStatus: post.approvalStatus,
        scheduledAt: input.expectedScheduledAt.toISOString(),
      },
    });
    return { blocked: true };
  });
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
        title: posts.title,
        caption: posts.caption,
        channelAccountId: posts.channelAccountId,
        chatId: conversations.providerChatId,
        provider: conversations.provider,
        encryptedToken: channelAccounts.accessTokenEncrypted,
        publishOptions: posts.publishOptions,
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
      title: row.title,
      caption: row.caption,
      chatId: row.chatId,
      encryptedToken: row.encryptedToken,
      provider: row.provider,
      publishOptions: parsePublishOptions(row.publishOptions),
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
