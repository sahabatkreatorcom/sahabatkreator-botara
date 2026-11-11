import { z } from "zod";

import { ChannelProviderSchema, type ChannelProvider } from "./inbox";

/**
 * Content Schedule (Fase 23) — kontrak postingan terjadwal ke linimasa
 * channel.
 *
 * Bedanya dengan `broadcasts` harus terbaca dari bentuk kontraknya, bukan
 * hanya dari komentar: di sini TIDAK ADA audiens, penerima, maupun
 * statistik terkirim/dibaca. Satu post = satu baris di linimasa publik.
 */

/**
 * Status postingan:
 * - `draft`      : masih disunting; tidak punya jam tayang.
 * - `scheduled`  : menunggu job worker `post.publish` (delay sampai
 *                  `scheduledAt`).
 * - `publishing` : klaim atomik sesaat sebelum mengirim. Hanya keadaan ini
 *                  yang boleh benar-benar memanggil provider.
 * - `published`  : provider menerima; `providerMessageId` terisi.
 * - `failed`     : provider menolak / kredensial mati; `errorCode` terisi.
 * - `cancelled`  : dibatalkan dari draft/scheduled.
 */
export const PostStatusSchema = z.enum([
  "draft",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
]);
export type PostStatus = z.infer<typeof PostStatusSchema>;

/**
 * Jenis lampiran diturunkan dari MIME, bukan dipilih pengguna — satu
 * klasifikasi, dipakai UI dan publisher.
 */
export const PostMediaKindSchema = z.enum(["photo", "video", "document"]);
export type PostMediaKind = z.infer<typeof PostMediaKindSchema>;

export const PostMediaSchema = z.object({
  id: z.string().uuid(),
  mediaId: z.string().uuid(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  kind: PostMediaKindSchema,
});
export type PostMediaItem = z.infer<typeof PostMediaSchema>;

/**
 * Sasaran postingan = SATU percakapan `kind='channel'`. Alamat kirim
 * (`providerChatId`) dibaca dari percakapan saat publikasi, bukan disalin
 * ke baris post — supaya tidak ada dua sumber kebenaran yang bisa
 * menyimpang saat channel dipindah atau bot diganti.
 */
export const PostTargetSchema = z.object({
  channelAccountId: z.string().uuid(),
  conversationId: z.string().uuid(),
  provider: ChannelProviderSchema,
  /** Judul channel di provider (Telegram `chat.title`). */
  title: z.string().nullable(),
  providerChatId: z.string().nullable(),
  /** Nama tampilan akun bot pengirim. */
  channelDisplayName: z.string().nullable(),
});
export type PostTarget = z.infer<typeof PostTargetSchema>;

export const PostSchema = z.object({
  id: z.string().uuid(),
  /** Grup multi-target pemilik post ini (migrasi 0013); null = tunggal. */
  groupId: z.string().uuid().nullable(),
  title: z.string(),
  caption: z.string(),
  status: PostStatusSchema,
  scheduledAt: z.string().datetime().nullable(),
  publishedAt: z.string().datetime().nullable(),
  providerMessageId: z.string().nullable(),
  errorCode: z.string().nullable(),
  target: PostTargetSchema,
  media: z.array(PostMediaSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PostResponse = z.infer<typeof PostSchema>;

/**
 * Batas caption Telegram (1024) — dipertahankan sebagai konstanta bernama
 * karena UI dan pesan bantuan masih merujuknya, tetapi sejak Gelombang 0
 * ia BUKAN lagi batas global: batas yang mengikat per postingan adalah
 * `maxCaption` pada capability provider sasarannya (lihat di bawah).
 */
export const POST_CAPTION_MAX = 1024;

/** Batas album Telegram (sendMediaGroup menerima 2–10 item). */
export const POST_MEDIA_MAX = 10;

/**
 * Deklarasi kemampuan penerbitan per provider (Gelombang 0, butir 2).
 *
 * Dua jenis nilai yang sengaja dibedakan di sini:
 * - ATURAN PLATFORM (`maxCaption`, `mediaRequired`, `supportsAlbum`, …):
 *   fakta tentang API provider, berlaku selamanya. Validasi di core
 *   memakai nilai ini saat membuat/menjadwalkan postingan — kesalahan
 *   format harus tertangkap sebelum jam tayang, bukan saat provider
 *   menolak di tengah malam.
 * - `publishSupported`: apakah SISTEM saat ini punya `PublisherAdapter`
 *   terdaftar untuk provider itu di worker. Ini berubah tiap gelombang
 *   (Telegram `true` sejak Fase 23; sisanya menyusul per roadmap) dan
 *   menjadi gerbang penjadwalan menggantikan pemeriksaan keras
 *   `provider === "telegram"` yang dulu hidup di core.
 *
 * Provider yang belum menjadi sasaran linimasa (whatsapp, webchat)
 * tetap dideklarasikan agar tabel ini lengkap terhadap
 * `ChannelProviderSchema`; nilai aturannya tidak dipakai selama
 * `publishSupported: false`.
 */
export const PostProviderCapabilitySchema = z.object({
  publishSupported: z.boolean(),
  /** true = postingan tanpa media tidak pernah boleh terbit (Instagram). */
  mediaRequired: z.boolean(),
  maxCaption: z.number().int().positive(),
  /**
   * Batas kolom `title` post BILA provider memetakannya ke judul
   * terpisah milik platform (YouTube: judul video maks 100). null =
   * provider tidak memakai judul platform — `title` post tetap label
   * internal kalender dan tidak dibatasi capability.
   */
  maxTitle: z.number().int().positive().nullable(),
  maxMedia: z.number().int().positive(),
  supportsAlbum: z.boolean(),
  /** Foto/gambar sebagai lampiran (YouTube menolaknya — video saja). */
  supportsPhotos: z.boolean(),
  supportsVideo: z.boolean(),
  /** Dokumen sebagai lampiran TUNGGAL. */
  supportsDocuments: z.boolean(),
  /** Dokumen di dalam album campuran (Telegram menolak ini di Bot API). */
  supportsAlbumDocuments: z.boolean(),
  supportsFirstComment: z.boolean(),
});
export type PostProviderCapability = z.infer<
  typeof PostProviderCapabilitySchema
>;

export const POST_PROVIDER_CAPABILITIES: Record<
  ChannelProvider,
  PostProviderCapability
> = {
  telegram: {
    publishSupported: true,
    mediaRequired: false,
    maxCaption: POST_CAPTION_MAX,
    maxTitle: null,
    maxMedia: POST_MEDIA_MAX,
    supportsAlbum: true,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: true,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
  instagram: {
    // Content Publishing API (Gelombang 1): wajib media, karousel
    // maks 10, caption 2200, video diterbitkan sebagai Reels. First
    // comment belum dinyalakan karena model post belum membawa isinya.
    publishSupported: true,
    mediaRequired: true,
    maxCaption: 2200,
    maxTitle: null,
    maxMedia: 10,
    supportsAlbum: true,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
  messenger: {
    // Facebook Page (Gelombang 1): feed teks/tautan, foto tunggal,
    // album foto, dan video Graph didukung adapter. First comment
    // belum dinyalakan: model post belum punya kolom/isi komentar
    // pertama, jadi capability tidak boleh menjanjikannya.
    publishSupported: true,
    mediaRequired: false,
    maxCaption: 63206,
    maxTitle: null,
    maxMedia: 10,
    supportsAlbum: true,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
  threads: {
    // Threads API (Gelombang 1): teks boleh berdiri sendiri (maks
    // 500), gambar/video/karousel memakai container dua tahap. Sistem
    // repo membatasi media bersama ke 10 walau karousel Threads bisa
    // lebih banyak. Dokumen dan first comment tidak didukung model ini.
    publishSupported: true,
    mediaRequired: false,
    maxCaption: 500,
    maxTitle: null,
    maxMedia: 10,
    supportsAlbum: true,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
  bluesky: {
    // Bluesky / AT Protocol (Gelombang 1.5): teks maks 300 grapheme.
    // Validasi repo memakai panjang string JS yang selalu >= jumlah
    // grapheme, jadi penolakan caption berada di sisi aman (caption
    // emoji padat bisa ditolak lebih awal, tidak pernah lolos
    // kelebihan). Gambar maks 4 sebagai embed `app.bsky.embed.images`
    // — album dalam arti embed multi-gambar, bukan container. Video
    // DITUNDA dengan sengaja: unggah video Bluesky bukan `uploadBlob`
    // ke PDS melainkan layanan video terpisah
    // (`app.bsky.video.uploadVideo` + polling job + token layanan),
    // subsistem sendiri yang tidak berbagi pola media biner repo.
    // Dokumen dan first comment tidak dikenal `app.bsky.feed.post`.
    publishSupported: true,
    mediaRequired: false,
    maxCaption: 300,
    maxTitle: null,
    maxMedia: 4,
    supportsAlbum: true,
    supportsPhotos: true,
    supportsVideo: false,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
  youtube: {
    // YouTube Data API v3 (Gelombang 2): HANYA unggah video
    // (videos.insert) — tidak ada postingan teks/foto di API publik
    // (Community Posts tidak dibuka untuk API pihak ketiga), jadi
    // mediaRequired + video saja + tepat satu media. Pemetaan field:
    // `title` post menjadi judul video (maks 100, ditegakkan lewat
    // maxTitle) dan `caption` menjadi deskripsi (maks 5000 — YouTube
    // menghitung byte UTF-8; panjang string JS selalu <= jumlah byte,
    // jadi penolakan di core berada di sisi aman). Video di bawah
    // 60 detik otomatis menjadi Shorts oleh YouTube; tidak ada jalur
    // API terpisah dan tidak ada yang perlu dibedakan di sini.
    publishSupported: true,
    mediaRequired: true,
    maxCaption: 5000,
    maxTitle: 100,
    maxMedia: 1,
    supportsAlbum: false,
    supportsPhotos: false,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
  linkedin: {
    // LinkedIn Posts API (Gelombang 3): sasaran PROFIL PRIBADI
    // anggota (`urn:li:person:{id}`, scope `w_member_social`) — bukan
    // Company Page, yang menunggu program Community Management
    // terpisah. Teks (commentary) maks 3000 karakter; gambar tunggal
    // atau multi-image (API mengizinkan s/d 20 gambar — repo membatasi
    // ke POST_MEDIA_MAX bersama) dan tepat satu video didukung lewat
    // unggah aset Images/Videos API. Campuran gambar+video dalam satu
    // post TIDAK dirakit Posts API sebagai satu konten, jadi adapter
    // menolaknya sebelum memanggil provider (pola Facebook). Dokumen
    // (Documents API) tidak dinyalakan gelombang ini; first comment
    // belum didukung model post.
    publishSupported: true,
    mediaRequired: false,
    maxCaption: 3000,
    maxTitle: null,
    maxMedia: POST_MEDIA_MAX,
    supportsAlbum: true,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
  whatsapp: {
    // Bukan sasaran linimasa (tidak ada API publikasi pihak ketiga);
    // kebutuhan massal ditangani broadcasts. Nilai aturan tidak dipakai.
    publishSupported: false,
    mediaRequired: false,
    maxCaption: POST_CAPTION_MAX,
    maxTitle: null,
    maxMedia: POST_MEDIA_MAX,
    supportsAlbum: false,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: true,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
  webchat: {
    // Widget milik sendiri; tidak ada linimasa publik untuk diterbitkan.
    publishSupported: false,
    mediaRequired: false,
    maxCaption: POST_CAPTION_MAX,
    maxTitle: null,
    maxMedia: POST_MEDIA_MAX,
    supportsAlbum: false,
    supportsPhotos: false,
    supportsVideo: false,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
  },
};

/** Capability sebuah provider; `undefined` untuk nilai di luar enum. */
export function getPostProviderCapability(
  provider: string,
): PostProviderCapability | undefined {
  return (
    POST_PROVIDER_CAPABILITIES as Record<string, PostProviderCapability>
  )[provider];
}

/**
 * Langit-langit keras caption pada skema permintaan: cukup longgar untuk
 * provider paling longgar, karena batas yang BENAR-BENAR mengikat adalah
 * capability provider sasaran dan ditegakkan di core (di sana provider
 * diketahui; di kontrak permintaan, sasaran bisa berubah per baris grup).
 */
export const POST_CAPTION_HARD_MAX = Math.max(
  ...Object.values(POST_PROVIDER_CAPABILITIES).map((c) => c.maxCaption),
);

export const CreatePostRequestSchema = z.object({
  conversationId: z.string().uuid(),
  title: z.string().trim().min(1).max(255),
  caption: z.string().max(POST_CAPTION_HARD_MAX).default(""),
  mediaIds: z.array(z.string().uuid()).max(POST_MEDIA_MAX).default([]),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

/**
 * Buat konten multi-target sekaligus (Gelombang 0, butir 3): satu
 * konten induk, N sasaran. Server membuat SATU baris `posts` per
 * sasaran dalam satu grup (satu transaksi — gagal satu, gagal semua),
 * karena status dan klaim publikasi memang per linimasa.
 *
 * `caption` per sasaran adalah override opsional di atas caption induk:
 * panjang dan gaya tiap platform berbeda, dan memaksa satu teks untuk
 * semua platform adalah kesalahan yang baru terasa setelah terbit.
 * Media dipakai bersama (album yang sama untuk semua sasaran); validasi
 * kesesuaiannya per platform terjadi saat penjadwalan, per baris.
 */
export const CreatePostGroupRequestSchema = z.object({
  title: z.string().trim().min(1).max(255),
  caption: z.string().max(POST_CAPTION_HARD_MAX).default(""),
  mediaIds: z.array(z.string().uuid()).max(POST_MEDIA_MAX).default([]),
  targets: z
    .array(
      z.object({
        conversationId: z.string().uuid(),
        caption: z.string().max(POST_CAPTION_HARD_MAX).optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type CreatePostGroupRequest = z.infer<
  typeof CreatePostGroupRequestSchema
>;

export const PostGroupResponseSchema = z.object({
  groupId: z.string().uuid(),
  items: z.array(PostSchema),
});
export type PostGroupResponse = z.infer<typeof PostGroupResponseSchema>;

/** Edit hanya berlaku untuk draft (ditegakkan di core, bukan di kontrak). */
export const UpdatePostRequestSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  caption: z.string().max(POST_CAPTION_HARD_MAX).optional(),
  mediaIds: z.array(z.string().uuid()).max(POST_MEDIA_MAX).optional(),
});
export type UpdatePostRequest = z.infer<typeof UpdatePostRequestSchema>;

/**
 * `scheduledAt` kosong = terbit sekarang. Nilai di masa lalu diperlakukan
 * sama (terbit sekarang) oleh core — bukan ditolak, karena jam perangkat
 * pengguna sering meleset beberapa detik.
 */
export const SchedulePostRequestSchema = z.object({
  scheduledAt: z.string().datetime().optional(),
});
export type SchedulePostRequest = z.infer<typeof SchedulePostRequestSchema>;

export const PostListQuerySchema = z.object({
  status: PostStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type PostListQuery = z.infer<typeof PostListQuerySchema>;

export const PostListResponseSchema = z.object({
  items: z.array(PostSchema),
});
export type PostListResponse = z.infer<typeof PostListResponseSchema>;

/**
 * Daftar channel yang bisa dituju: percakapan `kind='channel'` pada akun
 * channel yang masih terhubung. Kosong berarti bot belum pernah ditambahkan
 * sebagai admin ke channel mana pun — UI memakai itu untuk instruksi,
 * bukan menampilkan pemilih kosong tanpa penjelasan.
 */
export const PostTargetListResponseSchema = z.object({
  items: z.array(PostTargetSchema),
});
export type PostTargetListResponse = z.infer<
  typeof PostTargetListResponseSchema
>;
