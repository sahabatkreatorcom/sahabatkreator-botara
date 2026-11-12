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
 * Keadaan persetujuan postingan (Fase Susulan S1) — mesin status yang
 * TERPISAH dari `PostStatus`: status publikasi menjawab "sudah tayang
 * atau belum", status persetujuan menjawab "sudah boleh tayang atau
 * belum". Alur: `draft` (belum diajukan) → `pending_review` →
 * `approved` | `rejected` | `changes_requested`; dari `rejected` /
 * `changes_requested` postingan dapat diajukan lagi. Menyunting isi
 * postingan mengembalikan keadaan ke `draft` (yang disetujui harus
 * sama dengan yang terbit).
 *
 * Keadaan ini hanya MENJADI GERBANG bila tenant mengaktifkan
 * persetujuan wajib (`PostApprovalSettings.approvalRequired`);
 * tenant yang tidak mengaktifkannya tidak pernah diblokir olehnya.
 */
export const PostApprovalStatusSchema = z.enum([
  "draft",
  "pending_review",
  "approved",
  "rejected",
  "changes_requested",
]);
export type PostApprovalStatus = z.infer<typeof PostApprovalStatusSchema>;

/** Batas catatan keputusan peninjau (penolakan / minta revisi / persetujuan). */
export const POST_APPROVAL_NOTE_MAX = 2000;

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

/** Status privasi video YouTube (`status.privacyStatus` pada videos.insert). */
export const YouTubePrivacyStatusSchema = z.enum([
  "private",
  "unlisted",
  "public",
]);
export type YouTubePrivacyStatus = z.infer<typeof YouTubePrivacyStatusSchema>;

/** Level privasi direct post TikTok (`post_info.privacy_level`). */
export const TikTokPrivacyLevelSchema = z.enum([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);
export type TikTokPrivacyLevel = z.infer<typeof TikTokPrivacyLevelSchema>;

/**
 * Opsi penerbitan PER SASARAN postingan (gelombang Pilihan Privasi &
 * AI per Postingan, perintah pemilik 2026-11-12) — pilihan PENGGUNA
 * pada formulir postingan, BUKAN pengaturan platform.
 *
 * Latar kewajiban platform (riset dokumentasi resmi 2026-11-12):
 * - TikTok Content Sharing Guidelines MEWAJIBKAN kreator memilih
 *   sendiri status privasi tiap postingan dari daftar
 *   `privacy_level_options` akunnya, lewat dropdown TANPA nilai
 *   bawaan yang terpilih; toggle interaksi (komentar/duet/stitch)
 *   tidak boleh tercentang secara bawaan; pengungkapan konten
 *   komersial (brand sendiri / konten bermerek) adalah toggle
 *   kreator yang mati secara bawaan, dan konten bermerek TIDAK
 *   boleh privat. Field `is_aigc` pada post_info adalah label
 *   "dibuat AI" yang dinyatakan kreator.
 * - YouTube: `status.privacyStatus` adalah pilihan pengunggah per
 *   video (bila tidak diisi API justru membawakan `public` — alasan
 *   lain pilihan tidak boleh diam-diam berasal dari konfigurasi
 *   server), dan `status.containsSyntheticMedia` adalah pengungkapan
 *   WAJIB per video untuk konten realistis yang diubah/dibuat AI
 *   (kebijakan pengungkapan GenAI YouTube). `selfDeclaredMadeForKids`
 *   adalah penetapan audiens per video; API mengizinkannya tidak
 *   diisi (penetapan level kanal berlaku), jadi di sini ia TRI-STATE:
 *   tidak diisi = tidak dikirim.
 *
 * Konsekuensi bentuk: semua field opsional di skema (draft boleh
 * belum lengkap). Penegakan core saat penjadwalan mengikuti siapa
 * yang berhak memutuskan menurut dokumen platform di atas:
 * - TikTok: pilihan privasi + pengungkapan AI WAJIB eksplisit dari
 *   pengguna pada postingan itu (`POST_PUBLISH_OPTIONS_REQUIRED`) —
 *   guidelines melarang nilai privasi yang terpilih duluan, jadi
 *   default Panel Admin TIDAK boleh menggantikannya pada jalur
 *   formulir.
 * - YouTube: pengungkapan AI WAJIB eksplisit (pernyataan isi per
 *   video); privasi BOLEH jatuh ke default platform (Panel Admin →
 *   env) karena YouTube tidak melarang preseleksi — formulir
 *   menampilkannya terisi dari default itu dan pengguna menimpanya.
 * Resolusi akhir saat publish (adapter): opsi postingan → default
 * panel→env → validasi platform (TikTok: `privacy_level_options`
 * dari creator_info; tidak pernah diturunkan/dinaikkan diam-diam).
 * Field milik provider lain pada baris yang sama diabaikan/
 * dibersihkan core menurut provider sasaran baris itu — satu baris
 * posts = satu sasaran = satu provider, jadi opsi memang melekat
 * per target, bukan per postingan induk/grup.
 */
export const PostPublishOptionsSchema = z.object({
  /** YouTube: `status.privacyStatus`. Dipilih pengguna per video. */
  youtubePrivacyStatus: YouTubePrivacyStatusSchema.optional(),
  /** TikTok: `post_info.privacy_level`. Dipilih pengguna per postingan, tanpa bawaan. */
  tiktokPrivacyLevel: TikTokPrivacyLevelSchema.optional(),
  /**
   * Pengungkapan konten AI/ubahan realistis: YouTube →
   * `status.containsSyntheticMedia`, TikTok → `post_info.is_aigc`.
   * Boolean eksplisit (ya/tidak sama-sama pernyataan pengguna).
   */
  aiGenerated: z.boolean().optional(),
  /**
   * YouTube saja: `status.selfDeclaredMadeForKids`. Tidak diisi =
   * field tidak dikirim (penetapan level kanal berlaku) — lihat
   * catatan tri-state di atas.
   */
  madeForKids: z.boolean().optional(),
  /** TikTok saja: izinkan komentar. Bawaan pedoman TikTok: TIDAK tercentang. */
  tiktokAllowComment: z.boolean().optional(),
  /** TikTok saja (video): izinkan duet. Bawaan pedoman: TIDAK tercentang. */
  tiktokAllowDuet: z.boolean().optional(),
  /** TikTok saja (video): izinkan stitch. Bawaan pedoman: TIDAK tercentang. */
  tiktokAllowStitch: z.boolean().optional(),
  /**
   * TikTok saja: pengungkapan komersial "brand Anda sendiri"
   * (`brand_organic_toggle`, label platform "Promotional content").
   * Bawaan pedoman: mati.
   */
  tiktokBrandOrganic: z.boolean().optional(),
  /**
   * TikTok saja: pengungkapan komersial "konten bermerek"
   * (`brand_content_toggle`, label platform "Paid partnership").
   * Bawaan pedoman: mati. Konten bermerek tidak boleh privat —
   * kombinasi dengan `SELF_ONLY` ditolak core.
   */
  tiktokBrandContent: z.boolean().optional(),
  /**
   * Pinterest saja: board tujuan Pin untuk postingan INI
   * (`board_id` API v5). Resolusi penerbit berlapis: board
   * postingan ini → pilihan board per akun di Channels → board
   * pertama akun. Boleh kosong (= pakai lapis bawaan). Bila diisi,
   * server memvalidasinya ke daftar board akun Pinterest sasaran
   * (board asing ditolak 422 PINTEREST_BOARD_NOT_FOUND, pola
   * endpoint Channels yang sama).
   */
  pinterestBoardId: z.string().min(1).max(64).optional(),
});
export type PostPublishOptions = z.infer<typeof PostPublishOptionsSchema>;

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
  /** Opsi penerbitan per sasaran (privasi/AI/dst.); null = belum dipilih. */
  publishOptions: PostPublishOptionsSchema.nullable(),
  /** Pembuat postingan; null bila akun pembuat sudah dihapus. */
  createdByUserId: z.string().uuid().nullable(),
  /** Keadaan persetujuan (S1); hanya menjadi gerbang bila tenant mewajibkannya. */
  approvalStatus: PostApprovalStatusSchema,
  /** Catatan keputusan terakhir peninjau (penolakan / minta revisi). */
  approvalNote: z.string().nullable(),
  approvalSubmittedByUserId: z.string().uuid().nullable(),
  approvalSubmittedAt: z.string().datetime().nullable(),
  approvalReviewedByUserId: z.string().uuid().nullable(),
  approvalReviewedAt: z.string().datetime().nullable(),
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
/**
 * Permukaan opsi penerbitan per postingan milik satu provider.
 * `privacyValues` kosong = provider tidak mengenal pilihan privasi
 * per postingan (tidak ada yang wajib dipilih). Bendera lain menyala
 * hanya bila platform memang punya field per-postingannya.
 */
export const PostProviderPublishOptionsSchema = z.object({
  /** Nilai privasi sah yang boleh dipilih pengguna (mengikuti enum platform). */
  privacyValues: z.array(z.string()),
  /** Pengungkapan konten AI per postingan (YouTube containsSyntheticMedia / TikTok is_aigc). */
  supportsAiDisclosure: z.boolean(),
  /** Penetapan made-for-kids per video (YouTube saja). */
  supportsMadeForKids: z.boolean(),
  /** Toggle interaksi kreator (TikTok: komentar/duet/stitch). */
  supportsInteractions: z.boolean(),
  /** Pengungkapan konten komersial kreator (TikTok: brand organik/bermerek). */
  supportsCommercialDisclosure: z.boolean(),
  /** Pilihan board tujuan per postingan (Pinterest saja). */
  supportsBoardChoice: z.boolean(),
});
export type PostProviderPublishOptions = z.infer<
  typeof PostProviderPublishOptionsSchema
>;

/** Provider tanpa opsi penerbitan per postingan sama sekali. */
const NO_PUBLISH_OPTIONS: PostProviderPublishOptions = {
  privacyValues: [],
  supportsAiDisclosure: false,
  supportsMadeForKids: false,
  supportsInteractions: false,
  supportsCommercialDisclosure: false,
  supportsBoardChoice: false,
};

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
  /**
   * Album (media > 1) boleh memuat video. false = album khusus foto:
   * video hanya boleh terbit SENDIRIAN, tepat satu (TikTok, LinkedIn,
   * Facebook Page). Core menolak album apa pun yang memuat video —
   * termasuk campuran foto+video — sebelum jam tayang, bukan menunggu
   * adapter/provider menolaknya di tengah malam.
   */
  supportsVideoAlbum: z.boolean(),
  /** Foto/gambar sebagai lampiran (YouTube menolaknya — video saja). */
  supportsPhotos: z.boolean(),
  supportsVideo: z.boolean(),
  /** Dokumen sebagai lampiran TUNGGAL. */
  supportsDocuments: z.boolean(),
  /** Dokumen di dalam album campuran (Telegram menolak ini di Bot API). */
  supportsAlbumDocuments: z.boolean(),
  supportsFirstComment: z.boolean(),
  /**
   * Opsi penerbitan per postingan yang didukung provider ini —
   * formulir /posts menggambar sub-formulirnya dari sini, dan core
   * menegakkan kewajiban pilihan dari sini juga (satu sumber
   * kebenaran untuk "opsi apa yang harus dipilih pengguna").
   */
  publishOptions: PostProviderPublishOptionsSchema,
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
    supportsVideoAlbum: true,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: true,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
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
    supportsVideoAlbum: true,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
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
    supportsVideoAlbum: false,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
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
    supportsVideoAlbum: true,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
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
    supportsVideoAlbum: false,
    supportsPhotos: true,
    supportsVideo: false,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
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
    // OPSI PER POSTINGAN (gelombang Pilihan Privasi & AI): privasi
    // video (`status.privacyStatus`), pengungkapan konten AI/ubahan
    // (`status.containsSyntheticMedia` — kewajiban kebijakan GenAI
    // YouTube), dan penetapan audiens (`selfDeclaredMadeForKids`)
    // tampil sebagai pilihan PENGGUNA pada formulir postingan —
    // syarat platform bahwa pengunggahlah yang memilih per video
    // (dan API malah membawakan `public` bila field privasi tidak
    // diisi). Kunci panel `youtube_privacy_status` DIPERTAHANKAN
    // sebagai nilai BAWAAN (keputusan pemilik 2026-11-12): formulir
    // menampilkannya sebagai pilihan awal, pilihan pengguna pada
    // postingan menimpanya, dan postingan tanpa pilihan memakai
    // bawaan itu saat publish.
    publishSupported: true,
    mediaRequired: true,
    maxCaption: 5000,
    maxTitle: 100,
    maxMedia: 1,
    supportsAlbum: false,
    supportsVideoAlbum: false,
    supportsPhotos: false,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: {
      privacyValues: ["private", "unlisted", "public"],
      supportsAiDisclosure: true,
      supportsMadeForKids: true,
      supportsInteractions: false,
      supportsCommercialDisclosure: false,
      supportsBoardChoice: false,
    },
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
    supportsVideoAlbum: false,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
  },
  pinterest: {
    // Pinterest API v5 (Gelombang 3): satu post = satu Pin pada
    // board tujuan. Resolusi board BERLAPIS (gelombang Pilihan
    // Privasi & AI memindahkan pilihan ke postingan): board pada
    // opsi postingan ini → pilihan board per akun di Channels →
    // board pertama akun; pilihan yang sudah hilang di Pinterest
    // turun ke lapis berikutnya dengan catatan log penerbit.
    // Pin WAJIB media (mediaRequired) dan hanya
    // membawa SATU media (maxMedia 1 — tidak ada album Pin).
    // Pemetaan field: `title` post menjadi judul Pin (maks 100,
    // ditegakkan lewat maxTitle) dan `caption` menjadi deskripsi Pin
    // (maks 800). Gambar JPEG/PNG diunggah sebagai `image_base64`
    // dari biner object store privat (tanpa URL publik); format
    // gambar lain (GIF) memakai `image_url` dari resolver publik
    // pola Instagram dan gagal aman tanpa URL publik. Video
    // DITUNDA dengan sengaja: Pin video menuntut subsistem
    // pendaftaran media asinkron API v5 (unggah multipart ke
    // penyimpanan Pinterest + polling status media) yang tidak
    // berbagi pola media biner repo — alasan yang sama seperti
    // video Bluesky di Gelombang 1.5.
    publishSupported: true,
    mediaRequired: true,
    maxCaption: 800,
    maxTitle: 100,
    maxMedia: 1,
    supportsAlbum: false,
    supportsVideoAlbum: false,
    supportsPhotos: true,
    supportsVideo: false,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: {
      privacyValues: [],
      supportsAiDisclosure: false,
      supportsMadeForKids: false,
      supportsInteractions: false,
      supportsCommercialDisclosure: false,
      supportsBoardChoice: true,
    },
  },
  google_business: {
    // Google Business Profile (Gelombang 3): postingan lokal
    // (localPosts, topicType STANDARD) PER LOKASI — sasaran adalah
    // lokasi bisnis, bukan akun. Teks (summary) maks 1500 karakter;
    // media maksimal SATU foto dari URL publik (API hanya menerima
    // sourceUrl — pola resolver Instagram, gagal aman tanpa URL
    // publik); video dan album tidak dikenal postingan lokal.
    // Tombol CTA disusun adapter dari URL pertama di caption
    // (LEARN_MORE) sebatas field yang ada. Kuota API bernilai 0
    // sampai pengajuan akses pemilik disetujui Google — capability
    // menyatakan permukaan yang dibangun, bukan kuota yang tersedia.
    publishSupported: true,
    mediaRequired: false,
    maxCaption: 1500,
    maxTitle: null,
    maxMedia: 1,
    supportsAlbum: false,
    supportsVideoAlbum: false,
    supportsPhotos: true,
    supportsVideo: false,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
  },
  tiktok: {
    // TikTok Content Posting API (Gelombang 4 + pengembangan foto):
    // direct post video DAN foto/carousel, dua jalur yang berbeda
    // bentuk:
    // - VIDEO: tepat satu video (supportsVideoAlbum false — video
    //   tidak pernah masuk album dan tidak pernah bercampur foto),
    //   diunggah sebagai biner FILE_UPLOAD dari object store privat
    //   (init → unggah per potongan → polling status). Judul
    //   postingan video TikTok ADALAH caption itu sendiri
    //   (`post_info.title`, maks 2200 termasuk tagar/mention).
    // - FOTO: satu foto atau carousel foto (album khusus foto)
    //   lewat `/content/init/` dengan `PULL_FROM_URL` — TIDAK ada
    //   jalur unggah biner untuk foto, jadi URL-nya berasal dari
    //   resolver media publik (Panel Admin → env → null) dan domain
    //   base URL itu WAJIB diverifikasi kepemilikannya di portal
    //   developer TikTok, kalau tidak API menolak dengan
    //   `url_ownership_unverified`. Platform mengizinkan s/d 35
    //   foto per postingan; yang mengikat di sini adalah
    //   POST_MEDIA_MAX bersama (10). Foto membawa `auto_add_music`
    //   (musik rekomendasi otomatis — parameter resmi post_info
    //   foto) dan caption dipetakan ke `description` (maks 4000)
    //   sekaligus `title` foto (maks 90, dipotong adapter/klien
    //   sebagai pertahanan terakhir).
    // Kolom `title` post TIDAK dipetakan ke platform untuk kedua
    // jalur (maxTitle null): ia tetap label internal kalender.
    // GERBANG AUDIT: sebelum aplikasi pemilik lolos audit TikTok,
    // API hanya mengizinkan privasi `SELF_ONLY` — penegakannya ada
    // di `privacy_level_options` akun (adapter memvalidasi PILIHAN
    // PENGGUNA terhadap daftar itu sebelum init dan menolak dengan
    // `tiktok_privacy_option_mismatch`, TIDAK menurunkannya
    // diam-diam).
    // OPSI PER POSTINGAN (gelombang Pilihan Privasi & AI): Content
    // Sharing Guidelines TikTok MEWAJIBKAN kreator memilih sendiri
    // status privasi (dropdown tanpa nilai bawaan), toggle
    // interaksi (tidak tercentang secara bawaan), pengungkapan
    // konten komersial, dan label AI (`is_aigc`) — semuanya pilihan
    // pengguna pada formulir postingan. Kunci panel
    // `tiktok_privacy_level` DIPERTAHANKAN sebagai nilai bawaan
    // platform (keputusan pemilik 2026-11-12) tetapi TIDAK
    // menggantikan pilihan pada jalur formulir (guidelines melarang
    // privasi yang terpilih duluan): ia hanya menjadi lapis default
    // adapter untuk postingan tanpa pilihan (jalur lama/non-formulir),
    // tetap divalidasi terhadap creator_info apa adanya.
    publishSupported: true,
    mediaRequired: true,
    maxCaption: 2200,
    maxTitle: null,
    maxMedia: POST_MEDIA_MAX,
    supportsAlbum: true,
    supportsVideoAlbum: false,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: {
      privacyValues: [
        "PUBLIC_TO_EVERYONE",
        "MUTUAL_FOLLOW_FRIENDS",
        "FOLLOWER_OF_CREATOR",
        "SELF_ONLY",
      ],
      supportsAiDisclosure: true,
      supportsMadeForKids: false,
      supportsInteractions: true,
      supportsCommercialDisclosure: true,
      supportsBoardChoice: false,
    },
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
    supportsVideoAlbum: false,
    supportsPhotos: true,
    supportsVideo: true,
    supportsDocuments: true,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
  },
  webchat: {
    // Widget milik sendiri; tidak ada linimasa publik untuk diterbitkan.
    publishSupported: false,
    mediaRequired: false,
    maxCaption: POST_CAPTION_MAX,
    maxTitle: null,
    maxMedia: POST_MEDIA_MAX,
    supportsAlbum: false,
    supportsVideoAlbum: false,
    supportsPhotos: false,
    supportsVideo: false,
    supportsDocuments: false,
    supportsAlbumDocuments: false,
    supportsFirstComment: false,
    publishOptions: NO_PUBLISH_OPTIONS,
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
  /** Opsi penerbitan per sasaran (privasi/AI/dst.) — boleh belum lengkap pada draft. */
  publishOptions: PostPublishOptionsSchema.optional(),
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
        /** Opsi penerbitan milik sasaran INI (per target, bukan per grup). */
        publishOptions: PostPublishOptionsSchema.optional(),
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
  /** Ganti opsi penerbitan; `null` eksplisit = kosongkan pilihan. */
  publishOptions: PostPublishOptionsSchema.nullable().optional(),
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
  /** Saringan antrean tinjauan: hanya postingan pada keadaan persetujuan ini. */
  approvalStatus: PostApprovalStatusSchema.optional(),
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

// ---------------------------------------------------------------------------
// Persetujuan postingan (Fase Susulan S1)
// ---------------------------------------------------------------------------

/**
 * Pengaturan persetujuan tingkat tenant. `approvalRequired` adalah
 * sakelar OPT-IN (bawaan false): menyalakannya tidak mengubah
 * postingan yang sudah terbit, tetapi mulai saat itu gerbang
 * penerbitan worker menolak postingan terjadwal yang belum
 * `approved`.
 */
export const PostApprovalSettingsSchema = z.object({
  approvalRequired: z.boolean(),
});
export type PostApprovalSettings = z.infer<typeof PostApprovalSettingsSchema>;

export const UpdatePostApprovalSettingsRequestSchema = z.object({
  approvalRequired: z.boolean(),
});
export type UpdatePostApprovalSettingsRequest = z.infer<
  typeof UpdatePostApprovalSettingsRequestSchema
>;

/** Keputusan menyetujui: catatan bersifat opsional. */
export const ApprovePostRequestSchema = z.object({
  note: z.string().trim().max(POST_APPROVAL_NOTE_MAX).optional(),
});
export type ApprovePostRequest = z.infer<typeof ApprovePostRequestSchema>;

/**
 * Keputusan menolak / meminta revisi: catatan WAJIB — penolakan
 * tanpa alasan tidak memberi pembuat apa pun untuk diperbaiki.
 * Kekosongan ditegakkan juga di core (POST_APPROVAL_NOTE_REQUIRED),
 * bukan hanya di skema ini, supaya jalur non-HTTP tidak bisa
 * melewatinya.
 */
export const RejectPostRequestSchema = z.object({
  note: z.string().trim().min(1).max(POST_APPROVAL_NOTE_MAX),
});
export type RejectPostRequest = z.infer<typeof RejectPostRequestSchema>;

/**
 * Satu entri riwayat keputusan persetujuan — diturunkan dari baris
 * `audit_logs` (aksi `post.approval_*` + `post.publish_blocked_approval`),
 * BUKAN tabel kedua: audit adalah sumber kebenaran riwayat, kolom
 * `posts.approval_*` hanya potret keputusan terakhir. `actorLabel`
 * adalah resolusi nama user sebisa server (null = tak ter-resolve,
 * UI jatuh ke actorId).
 */
export const PostApprovalHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  actorType: z.enum(["user", "agent", "system", "api_key"]),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  /** Post jangkar tempat tindakan dilakukan (anggota grup berbagi riwayat grup). */
  postId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type PostApprovalHistoryEntry = z.infer<
  typeof PostApprovalHistoryEntrySchema
>;

export const PostApprovalHistoryResponseSchema = z.object({
  items: z.array(PostApprovalHistoryEntrySchema),
});
export type PostApprovalHistoryResponse = z.infer<
  typeof PostApprovalHistoryResponseSchema
>;

// ---------------------------------------------------------------------------
// Jadwal berulang postingan + antrean rutin (Fase Susulan S2)
// ---------------------------------------------------------------------------

/**
 * Frekuensi aturan berulang postingan — himpunan yang sama seperti
 * aturan siaran G9; matematika polanya dibagi di core lewat modul
 * recurrence-pattern bersama.
 */
export const PostRecurrenceFrequencySchema = z.enum([
  "daily",
  "weekly",
  "monthly",
]);
export type PostRecurrenceFrequency = z.infer<
  typeof PostRecurrenceFrequencySchema
>;

/**
 * Status aturan berulang postingan. active = penyapu memproses
 * slot jatuh tempo; paused = slot dicatat skipped `rule_paused`;
 * completed = kondisi berhenti tercapai (terminal); cancelled =
 * dihentikan pemilik (terminal).
 */
export const PostRecurrenceStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "cancelled",
]);
export type PostRecurrenceStatus = z.infer<typeof PostRecurrenceStatusSchema>;

/**
 * Status satu baris ledger kejadian aturan. claimed = sedang
 * dimaterialisasi (transien; klaim basi diambil alih menjadi
 * missed `claim_stale`); created = postingan anak lahir +
 * terjadwal; skipped = tidak lahir (aturan dijeda atau gerbang
 * pembuatan/penjadwalan menolak — lihat `reason`); missed = slot
 * basi tidak ditembakkan.
 */
export const PostRecurrenceOccurrenceStatusSchema = z.enum([
  "claimed",
  "created",
  "skipped",
  "missed",
]);
export type PostRecurrenceOccurrenceStatus = z.infer<
  typeof PostRecurrenceOccurrenceStatusSchema
>;

/** Satu sasaran templat postingan (bentuk target grup komposer). */
export const PostRecurrenceTargetInputSchema = z.object({
  conversationId: z.string().uuid(),
  /** Override caption untuk sasaran ini; kosong = caption induk. */
  caption: z.string().max(POST_CAPTION_HARD_MAX).optional(),
  /** Opsi penerbitan milik sasaran ini; null = kosongkan pilihan. */
  publishOptions: PostPublishOptionsSchema.nullable().optional(),
});
export type PostRecurrenceTargetInput = z.infer<
  typeof PostRecurrenceTargetInputSchema
>;

/** Sasaran templat + info tampilnya (respons aturan/slot). */
export const PostRecurrenceTargetSchema = z.object({
  conversationId: z.string().uuid(),
  caption: z.string().optional(),
  publishOptions: PostPublishOptionsSchema.nullable().optional(),
  /** Null bila percakapan sasaran sudah terhapus sesudah aturan disimpan. */
  provider: ChannelProviderSchema.nullable(),
  conversationTitle: z.string().nullable(),
  channelDisplayName: z.string().nullable(),
});
export type PostRecurrenceTarget = z.infer<typeof PostRecurrenceTargetSchema>;

/**
 * Templat postingan snapshot aturan/slot. Pada pembuatan aturan
 * dengan `sourcePostId`, bidang yang tidak dikirim DISALIN dari
 * postingan sumber; tanpa sumber, `title` + `targets` wajib
 * lengkap (ditegakkan core sebagai template_incomplete).
 */
export const PostRecurrenceTemplateSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  caption: z.string().max(POST_CAPTION_HARD_MAX).optional(),
  mediaIds: z.array(z.string().uuid()).max(POST_MEDIA_MAX).optional(),
  targets: z
    .array(PostRecurrenceTargetInputSchema)
    .min(1)
    .max(20)
    .optional(),
});
export type PostRecurrenceTemplate = z.infer<
  typeof PostRecurrenceTemplateSchema
>;

/** Pola pengulangan aturan postingan (dipakai buat/edit/pratinjau). */
export const PostRecurrencePatternSchema = z.object({
  frequency: PostRecurrenceFrequencySchema,
  /** Setiap N hari/minggu/bulan (1..365). */
  interval: z.number().int().min(1).max(365).optional(),
  /** Hanya weekly: hari aktif 0=Minggu..6=Sabtu. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  /** Hanya monthly: tanggal 1..31 (dijepit ke akhir bulan pendek). */
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  /** Hanya monthly: slot di hari terakhir bulan (mengalahkan dayOfMonth). */
  lastDayOfMonth: z.boolean().optional(),
  /** Zona waktu IANA; kosong = zona waktu tenant. */
  timezone: z.string().min(1).max(64).optional(),
  /** Jangkar: slot pertama + jam dinding semua slot (ISO 8601). */
  startsAt: z.string().datetime(),
  /** Slot terakhir yang masih boleh lahir, inklusif (ISO 8601). */
  endsAt: z.string().datetime().nullable().optional(),
  /** Batas jumlah postingan anak yang dibuat (1..10000). */
  maxOccurrences: z.number().int().min(1).max(10000).nullable().optional(),
});
export type PostRecurrencePattern = z.infer<typeof PostRecurrencePatternSchema>;

export const CreatePostRecurrenceRuleRequestSchema =
  PostRecurrenceTemplateSchema.extend({
    /** Salin templat dari postingan yang ada (snapshot; lihat template). */
    sourcePostId: z.string().uuid().optional(),
    /** Nama aturan; kosong = judul templat. */
    name: z.string().trim().min(1).max(255).optional(),
  }).merge(PostRecurrencePatternSchema);
export type CreatePostRecurrenceRuleRequest = z.infer<
  typeof CreatePostRecurrenceRuleRequestSchema
>;

/**
 * Edit aturan (hanya active/paused). Pola bersifat parsial terhadap
 * pola tersimpan; slot berikutnya dihitung ulang dari pola baru.
 * Templat bersifat parsial terhadap snapshot tersimpan.
 */
export const UpdatePostRecurrenceRuleRequestSchema =
  PostRecurrenceTemplateSchema.extend({
    name: z.string().trim().min(1).max(255).optional(),
  }).merge(PostRecurrencePatternSchema.partial());
export type UpdatePostRecurrenceRuleRequest = z.infer<
  typeof UpdatePostRecurrenceRuleRequestSchema
>;

/** Pratinjau slot berikutnya untuk pola yang BELUM disimpan. */
export const PostRecurrencePreviewRequestSchema =
  PostRecurrencePatternSchema.extend({
    /** Berapa slot ke depan yang dihitung (bawaan server 5). */
    count: z.number().int().min(1).max(24).optional(),
    /** Hitung slot sesudah instan ini (ISO 8601); kosong = sesudah sekarang. */
    from: z.string().datetime().optional(),
  });
export type PostRecurrencePreviewRequest = z.infer<
  typeof PostRecurrencePreviewRequestSchema
>;

export const PostRecurrencePreviewResponseSchema = z.object({
  /** Instan slot (ISO 8601, UTC) menaik. */
  slots: z.array(z.string().datetime()),
  /** Zona waktu efektif yang dipakai perhitungan. */
  timezone: z.string(),
});
export type PostRecurrencePreviewResponse = z.infer<
  typeof PostRecurrencePreviewResponseSchema
>;

export const PostRecurrenceRuleResponseSchema = z.object({
  id: z.string().uuid(),
  sourcePostId: z.string().uuid().nullable(),
  name: z.string(),
  title: z.string(),
  caption: z.string(),
  mediaIds: z.array(z.string().uuid()),
  targets: z.array(PostRecurrenceTargetSchema),
  frequency: PostRecurrenceFrequencySchema,
  interval: z.number().int(),
  daysOfWeek: z.array(z.number().int()),
  dayOfMonth: z.number().int().nullable(),
  lastDayOfMonth: z.boolean(),
  timezone: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable(),
  maxOccurrences: z.number().int().nullable(),
  occurrencesCreated: z.number().int().nonnegative(),
  status: PostRecurrenceStatusSchema,
  /** Slot berikutnya yang belum diproses; null pada aturan terminal. */
  nextRunAt: z.string().datetime().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PostRecurrenceRuleResponse = z.infer<
  typeof PostRecurrenceRuleResponseSchema
>;

export const PostRecurrenceRuleListResponseSchema = z.object({
  rules: z.array(PostRecurrenceRuleResponseSchema),
  nextCursor: z.string().nullable(),
});
export type PostRecurrenceRuleListResponse = z.infer<
  typeof PostRecurrenceRuleListResponseSchema
>;

export const PostRecurrenceRuleListQuerySchema = z.object({
  status: PostRecurrenceStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type PostRecurrenceRuleListQuery = z.infer<
  typeof PostRecurrenceRuleListQuerySchema
>;

export const PostRecurrenceOccurrenceResponseSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  /** Instan slot (ISO 8601, UTC). */
  slotAt: z.string().datetime(),
  status: PostRecurrenceOccurrenceStatusSchema,
  /**
   * Alasan skipped/missed: kode semantik lapisan ini (rule_paused,
   * slot_expired, claim_stale) atau kode gerbang postingan core
   * (mis. POST_TARGET_NOT_CONNECTED, POST_PUBLISH_OPTIONS_REQUIRED).
   * Null untuk created/claimed.
   */
  reason: z.string().nullable(),
  /** Grup postingan anak (null = sasaran tunggal / tidak lahir). */
  postGroupId: z.string().uuid().nullable(),
  /** Postingan anak yang lahir dari slot ini (hanya status created). */
  postIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PostRecurrenceOccurrenceResponse = z.infer<
  typeof PostRecurrenceOccurrenceResponseSchema
>;

export const PostRecurrenceOccurrenceListResponseSchema = z.object({
  occurrences: z.array(PostRecurrenceOccurrenceResponseSchema),
  nextCursor: z.string().nullable(),
});
export type PostRecurrenceOccurrenceListResponse = z.infer<
  typeof PostRecurrenceOccurrenceListResponseSchema
>;

export const PostRecurrenceOccurrenceListQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type PostRecurrenceOccurrenceListQuery = z.infer<
  typeof PostRecurrenceOccurrenceListQuerySchema
>;

// --- Antrean konten rutin ---

/** Status item antrean: queued = menunggu ditarik; pulled = sudah menjadi postingan. */
export const PostQueueItemStatusSchema = z.enum(["queued", "pulled"]);
export type PostQueueItemStatus = z.infer<typeof PostQueueItemStatusSchema>;

export const CreatePostQueueItemRequestSchema = z.object({
  title: z.string().trim().min(1).max(255),
  caption: z.string().max(POST_CAPTION_HARD_MAX).default(""),
  mediaIds: z.array(z.string().uuid()).max(POST_MEDIA_MAX).default([]),
});
export type CreatePostQueueItemRequest = z.infer<
  typeof CreatePostQueueItemRequestSchema
>;

export const UpdatePostQueueItemRequestSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  caption: z.string().max(POST_CAPTION_HARD_MAX).optional(),
  mediaIds: z.array(z.string().uuid()).max(POST_MEDIA_MAX).optional(),
});
export type UpdatePostQueueItemRequest = z.infer<
  typeof UpdatePostQueueItemRequestSchema
>;

export const MovePostQueueItemRequestSchema = z.object({
  direction: z.enum(["up", "down"]),
});
export type MovePostQueueItemRequest = z.infer<
  typeof MovePostQueueItemRequestSchema
>;

export const PostQueueItemResponseSchema = z.object({
  id: z.string().uuid(),
  /** Urutan tarik (menaik; terkecil = teratas). */
  position: z.number().int(),
  title: z.string(),
  caption: z.string(),
  mediaIds: z.array(z.string().uuid()),
  status: PostQueueItemStatusSchema,
  /** Kapan item ditarik slot (hanya status pulled). */
  pulledAt: z.string().datetime().nullable(),
  /** Grup postingan hasil tarikan (null = sasaran tunggal). */
  pulledPostGroupId: z.string().uuid().nullable(),
  /** Postingan hasil tarikan (hanya status pulled). */
  pulledPostIds: z.array(z.string().uuid()),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PostQueueItemResponse = z.infer<typeof PostQueueItemResponseSchema>;

export const PostQueueItemListResponseSchema = z.object({
  items: z.array(PostQueueItemResponseSchema),
  nextCursor: z.string().nullable(),
});
export type PostQueueItemListResponse = z.infer<
  typeof PostQueueItemListResponseSchema
>;

export const PostQueueItemListQuerySchema = z.object({
  status: PostQueueItemStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type PostQueueItemListQuery = z.infer<
  typeof PostQueueItemListQuerySchema
>;

// --- Slot rutin antrean ---

/** Status slot rutin: active/paused diproses penyapu (paused = tembakan skipped); cancelled terminal. */
export const PostQueueSlotStatusSchema = z.enum([
  "active",
  "paused",
  "cancelled",
]);
export type PostQueueSlotStatus = z.infer<typeof PostQueueSlotStatusSchema>;

/**
 * Status satu tembakan slot. pulled = item teratas menjadi
 * postingan terjadwal; empty = antrean kosong saat slot tiba
 * (reason queue_empty); skipped = slot dijeda atau gerbang menolak
 * (lihat reason); missed = slot basi (slot_expired/claim_stale).
 */
export const PostQueueFiringStatusSchema = z.enum([
  "claimed",
  "pulled",
  "empty",
  "skipped",
  "missed",
]);
export type PostQueueFiringStatus = z.infer<typeof PostQueueFiringStatusSchema>;

/** Pola slot rutin: mingguan — hari aktif (0=Minggu..6=Sabtu) + jam dinding. */
export const PostQueueSlotPatternSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  /** Jam dinding slot "HH:MM" 24 jam dalam `timezone`. */
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Zona waktu IANA; kosong = zona waktu tenant. */
  timezone: z.string().min(1).max(64).optional(),
  /** Tembakan pertama tidak sebelum instan ini (ISO 8601); kosong = sekarang. */
  startsAt: z.string().datetime().optional(),
});
export type PostQueueSlotPattern = z.infer<typeof PostQueueSlotPatternSchema>;

export const CreatePostQueueSlotRequestSchema =
  PostQueueSlotPatternSchema.extend({
    name: z.string().trim().min(1).max(255),
    targets: z.array(PostRecurrenceTargetInputSchema).min(1).max(20),
  });
export type CreatePostQueueSlotRequest = z.infer<
  typeof CreatePostQueueSlotRequestSchema
>;

export const UpdatePostQueueSlotRequestSchema =
  PostQueueSlotPatternSchema.partial().extend({
    name: z.string().trim().min(1).max(255).optional(),
    targets: z.array(PostRecurrenceTargetInputSchema).min(1).max(20).optional(),
  });
export type UpdatePostQueueSlotRequest = z.infer<
  typeof UpdatePostQueueSlotRequestSchema
>;

export const PostQueueSlotResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  targets: z.array(PostRecurrenceTargetSchema),
  daysOfWeek: z.array(z.number().int()),
  /** Jam slot "HH:MM" (diturunkan server dari jangkar + zona). */
  timeOfDay: z.string(),
  timezone: z.string(),
  /** Jangkar pola: instan tembakan pertama. */
  startsAt: z.string().datetime(),
  status: PostQueueSlotStatusSchema,
  /** Tembakan berikutnya yang belum diproses; null bila cancelled. */
  nextRunAt: z.string().datetime().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PostQueueSlotResponse = z.infer<typeof PostQueueSlotResponseSchema>;

export const PostQueueSlotListResponseSchema = z.object({
  slots: z.array(PostQueueSlotResponseSchema),
  nextCursor: z.string().nullable(),
});
export type PostQueueSlotListResponse = z.infer<
  typeof PostQueueSlotListResponseSchema
>;

export const PostQueueSlotListQuerySchema = z.object({
  status: PostQueueSlotStatusSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type PostQueueSlotListQuery = z.infer<
  typeof PostQueueSlotListQuerySchema
>;

export const PostQueueFiringResponseSchema = z.object({
  id: z.string().uuid(),
  slotId: z.string().uuid(),
  /** Instan tembakan (ISO 8601, UTC). */
  slotAt: z.string().datetime(),
  status: PostQueueFiringStatusSchema,
  /**
   * Alasan empty/skipped/missed: queue_empty, slot_paused,
   * slot_expired, claim_stale, atau kode gerbang postingan core.
   * Null untuk pulled/claimed.
   */
  reason: z.string().nullable(),
  /** Item yang ditarik/direservasi tembakan ini (null untuk empty). */
  queueItemId: z.string().uuid().nullable(),
  postGroupId: z.string().uuid().nullable(),
  postIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PostQueueFiringResponse = z.infer<
  typeof PostQueueFiringResponseSchema
>;

export const PostQueueFiringListResponseSchema = z.object({
  firings: z.array(PostQueueFiringResponseSchema),
  nextCursor: z.string().nullable(),
});
export type PostQueueFiringListResponse = z.infer<
  typeof PostQueueFiringListResponseSchema
>;

export const PostQueueFiringListQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type PostQueueFiringListQuery = z.infer<
  typeof PostQueueFiringListQuerySchema
>;
