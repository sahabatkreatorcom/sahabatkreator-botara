import { z } from "zod";

import { ChannelProviderSchema } from "./inbox";

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
 * Batas caption 1024 karakter = batas `caption` Bot API Telegram. Sengaja
 * ditegakkan di kontrak, bukan hanya di publisher: provider lain punya
 * batas lebih longgar, tetapi menampung 4096 lalu menolak saat jam tayang
 * adalah kegagalan yang baru terlihat setelah postingan gagal terbit.
 */
export const POST_CAPTION_MAX = 1024;

/** Batas album Telegram (sendMediaGroup menerima 2–10 item). */
export const POST_MEDIA_MAX = 10;

export const CreatePostRequestSchema = z.object({
  conversationId: z.string().uuid(),
  title: z.string().trim().min(1).max(255),
  caption: z.string().max(POST_CAPTION_MAX).default(""),
  mediaIds: z.array(z.string().uuid()).max(POST_MEDIA_MAX).default([]),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

/** Edit hanya berlaku untuk draft (ditegakkan di core, bukan di kontrak). */
export const UpdatePostRequestSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  caption: z.string().max(POST_CAPTION_MAX).optional(),
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
