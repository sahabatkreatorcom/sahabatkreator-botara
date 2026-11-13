/**
 * @sahabat-kreator/channel-youtube — klien YouTube Data API v3 untuk
 * PUBLIKASI content schedule saja (Gelombang 2).
 *
 * YouTube bukan channel inbox dan bukan API linimasa umum: satu-satunya
 * permukaan publikasi yang dibuka untuk API pihak ketiga adalah unggah
 * video (`videos.insert`). Postingan teks/foto tidak ada (Community
 * Posts tidak tersedia untuk API pihak ketiga), dan video di bawah
 * 60 detik otomatis menjadi Shorts — tidak ada endpoint terpisah.
 *
 * Alur unggah yang dipakai di sini adalah protokol RESUMABLE resmi:
 *   1. POST /upload/youtube/v3/videos?uploadType=resumable dengan
 *      metadata JSON → Google membalas URL sesi di header `Location`;
 *   2. PUT biner video ke URL sesi itu (satu PUT penuh; media repo
 *      dibaca sebagai biner dari object store privat — pola Telegram/
 *      Bluesky — jadi TIDAK perlu URL publik seperti IG/Threads);
 *   3. respons PUT adalah resource video; `id`-nya menjadi
 *      providerMessageId postingan.
 *
 * Kredensial TIDAK dikenal paket ini: pemanggil (adapter worker)
 * menyerahkan access token yang sudah ditukar dari refresh token
 * koneksi Google tenant oleh core (`getYouTubePublishAccess`).
 * Access token TIDAK PERNAH masuk error/log — `YouTubeApiError`
 * hanya membawa status HTTP + `reason` resmi Google + pesan resmi
 * yang dipotong (pesan error Google tidak memuat kredensial).
 *
 * KUOTA: `videos.insert` berharga 1600 unit dari kuota default
 * 10.000 unit/hari PER PROYEK Google (≈ 6 unggahan/hari). Karena itu
 * klien ini SENGAJA tidak melakukan panggilan pendamping apa pun —
 * tidak ada polling status (unggah resumable bersifat sinkron:
 * PUT selesai = video diterima), tidak ada `channels.list` dari
 * jalur publikasi. Error kuota dipetakan ke kode khusus
 * `youtube_quota_exceeded` agar operator bisa membedakannya dari
 * kegagalan biasa.
 */

export const DEFAULT_YOUTUBE_API_BASE = "https://www.googleapis.com";

/** Batas judul video YouTube (karakter). */
export const YOUTUBE_TITLE_MAX = 100;
/** Batas deskripsi video YouTube (byte UTF-8; JS length <= byte). */
export const YOUTUBE_DESCRIPTION_MAX = 5000;
/**
 * Kategori bawaan video: 22 = "People & Blogs" — kategori paling umum
 * untuk konten kreator/UMKM; metadata post belum membawa kategori
 * per postingan.
 */
export const YOUTUBE_DEFAULT_CATEGORY_ID = "22";

export type YouTubePrivacyStatus = "private" | "unlisted" | "public";

/** Error Google yang aman dicatat: status HTTP + reason resmi provider. */
export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    /** `reason` resmi Google (mis. `quotaExceeded`); null bila tak terbaca. */
    readonly reason: string | null,
    readonly description: string,
  ) {
    super(
      `YouTube API ${status}${reason ? ` ${reason}` : ""}: ${description}`,
    );
    this.name = "YouTubeApiError";
  }
}

/** Reason Google yang berarti kuota proyek habis (bukan salah tenant). */
const QUOTA_REASONS = new Set([
  "quotaExceeded",
  "dailyLimitExceeded",
  "userRateLimitExceeded",
  "rateLimitExceeded",
]);

/**
 * Petakan error ke errorCode postingan yang aman & stabil. Kuota
 * mendapat kode khusus; 401 (token ditolak/grant dicabut) dibedakan
 * dari kegagalan HTTP lain.
 */
export function youtubeErrorCode(err: unknown): string {
  if (!(err instanceof YouTubeApiError)) return "youtube_send_error";
  if (err.status === 0) return "youtube_network_error";
  if (err.reason && QUOTA_REASONS.has(err.reason)) {
    return "youtube_quota_exceeded";
  }
  if (err.reason === "uploadSessionMissing") {
    return "youtube_upload_session_missing";
  }
  if (err.reason === "uploadIncomplete" || err.status === 308) {
    return "youtube_upload_incomplete";
  }
  if (err.status === 401) return "youtube_unauthorized";
  return `youtube_http_${err.status}`;
}

export interface YouTubeVideoMetadata {
  snippet: {
    title: string;
    description: string;
    categoryId: string;
  };
  status: {
    privacyStatus: YouTubePrivacyStatus;
    /**
     * Pengungkapan konten yang diubah/dihasilkan AI secara realistis
     * (`status.containsSyntheticMedia`, Data API — kebijakan
     * pengungkapan GenAI YouTube mewajibkannya per video).
     */
    containsSyntheticMedia: boolean;
    /**
     * Penetapan audiens per video. OPSIONAL di tipe ini dengan
     * sengaja (tri-state): tidak ada di objek = tidak dikirim ke
     * API = penetapan level kanal yang berlaku; ada = pernyataan
     * pengguna untuk video ini.
     */
    selfDeclaredMadeForKids?: boolean;
  };
}

/**
 * Pemetaan field post → metadata video (murni, tanpa I/O):
 * - `title` post menjadi JUDUL video. Post memang punya kolom judul
 *   tersendiri, jadi caption TIDAK dibelah: caption utuh menjadi
 *   deskripsi. Judul kosong (defensif — kontrak mewajibkan judul)
 *   jatuh ke baris pertama caption, lalu ke "Video".
 * - Batas ditegakkan di core saat penjadwalan (POST_TITLE_TOO_LONG /
 *   POST_CAPTION_TOO_LONG); pemotongan di sini adalah pertahanan
 *   terakhir agar provider tidak menolak di jam tayang.
 * - Tiga field `status` adalah KEPUTUSAN PENGGUNA per video dari
 *   opsi postingan (gelombang Pilihan Privasi & AI): privasi
 *   (adapter menyelesaikan bawaan panel sebelum memanggil fungsi
 *   ini), `containsSyntheticMedia` dari pernyataan AI pengguna
 *   (WAJIB diteruskan apa adanya — mengarang nilai di sini berarti
 *   membuat pernyataan isi palsu atas nama kreator), dan
 *   `selfDeclaredMadeForKids` dari penetapan audiens pengguna.
 *   Tri-state madeForKids: input `undefined` → field TIDAK
 *   dimasukkan ke status (API membiarkan penetapan level kanal
 *   berlaku); ini mengubah perilaku lama yang selalu mengirim
 *   `false` — perubahan yang disengaja gelombang ini, karena
 *   `false` eksplisit akan menimpa penetapan kanal yang sah.
 */
export function buildYouTubeVideoMetadata(input: {
  title: string;
  caption: string;
  privacyStatus: YouTubePrivacyStatus;
  containsSyntheticMedia: boolean;
  madeForKids?: boolean | undefined;
  categoryId?: string;
}): YouTubeVideoMetadata {
  const firstCaptionLine = input.caption
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const title = (
    input.title.trim() ||
    firstCaptionLine ||
    "Video"
  ).slice(0, YOUTUBE_TITLE_MAX);
  return {
    snippet: {
      title,
      description: input.caption.slice(0, YOUTUBE_DESCRIPTION_MAX),
      categoryId: input.categoryId ?? YOUTUBE_DEFAULT_CATEGORY_ID,
    },
    status: {
      privacyStatus: input.privacyStatus,
      containsSyntheticMedia: input.containsSyntheticMedia,
      ...(input.madeForKids !== undefined
        ? { selfDeclaredMadeForKids: input.madeForKids }
        : {}),
    },
  };
}

export interface YouTubeClientOptions {
  /** Base URL Google API; default https://www.googleapis.com. Override hanya untuk uji mock (mengikuti GOOGLE_API_BASE). */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Timeout inisiasi sesi (metadata saja); default 15 detik. */
  timeoutMs?: number | undefined;
  /** Timeout unggah biner (video besar); default 180 detik. */
  uploadTimeoutMs?: number | undefined;
}

interface GoogleErrorBody {
  error?: {
    message?: unknown;
    errors?: Array<{ reason?: unknown }>;
  };
}

export class YouTubeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(options: YouTubeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_YOUTUBE_API_BASE).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 180_000;
  }

  /**
   * Statistik SATU video (Fase Susulan S3): `GET /youtube/v3/videos
   * ?part=statistics&id=<videoId>` (1 unit kuota). Angka Google
   * berbentuk string; `likeCount` ABSEN bila pemilik menyembunyikan
   * jumlah suka dan `commentCount` absen bila komentar dinonaktifkan
   * — keduanya diteruskan sebagai kunci absen, bukan 0. null bila
   * video tidak ditemukan untuk token ini.
   */
  async getVideoStatistics(input: {
    accessToken: string;
    videoId: string;
  }): Promise<{
    views?: number;
    likes?: number;
    comments?: number;
  } | null> {
    const query = new URLSearchParams({
      part: "statistics",
      id: input.videoId,
    }).toString();
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/youtube/v3/videos?${query}`,
        {
          method: "GET",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { Authorization: `Bearer ${input.accessToken}` },
        },
      );
    } catch {
      throw new YouTubeApiError(0, null, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    const body = (await response.json().catch(() => ({}))) as {
      items?: Array<{
        statistics?: {
          viewCount?: unknown;
          likeCount?: unknown;
          commentCount?: unknown;
        };
      }>;
    };
    const stats = body.items?.[0]?.statistics;
    if (!stats) return null;
    const parse = (value: unknown): number | undefined => {
      if (typeof value === "string" && /^\d+$/.test(value)) {
        return Number.parseInt(value, 10);
      }
      return typeof value === "number" ? value : undefined;
    };
    const out: { views?: number; likes?: number; comments?: number } = {};
    const views = parse(stats.viewCount);
    if (views !== undefined) out.views = views;
    const likes = parse(stats.likeCount);
    if (likes !== undefined) out.likes = likes;
    const comments = parse(stats.commentCount);
    if (comments !== undefined) out.comments = comments;
    return out;
  }

  private async parseError(response: Response): Promise<YouTubeApiError> {
    let body: GoogleErrorBody = {};
    try {
      body = (await response.json()) as GoogleErrorBody;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const first = body.error?.errors?.[0];
    const reason =
      typeof first?.reason === "string" ? first.reason.slice(0, 64) : null;
    const description =
      typeof body.error?.message === "string"
        ? body.error.message.slice(0, 200)
        : "youtube_api_error";
    return new YouTubeApiError(response.status, reason, description);
  }

  /**
   * Unggah SATU video lewat sesi resumable dan kembalikan id video.
   * Satu-satunya panggilan API: inisiasi + PUT (1600 unit kuota).
   */
  async uploadVideo(input: {
    accessToken: string;
    metadata: YouTubeVideoMetadata;
    data: Uint8Array;
    contentType: string;
  }): Promise<{ videoId: string }> {
    // 1) Inisiasi sesi resumable.
    let initRes: Response;
    try {
      initRes = await this.fetchImpl(
        `${this.baseUrl}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
        {
          method: "POST",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": input.contentType,
            "X-Upload-Content-Length": String(input.data.byteLength),
          },
          body: JSON.stringify(input.metadata),
        },
      );
    } catch {
      throw new YouTubeApiError(0, null, "network_error");
    }
    if (!initRes.ok) throw await this.parseError(initRes);
    const sessionUri = initRes.headers.get("location");
    if (!sessionUri) {
      throw new YouTubeApiError(
        initRes.status,
        "uploadSessionMissing",
        "upload_session_missing",
      );
    }

    // 2) Unggah biner penuh ke URL sesi. Sesi resumable mengizinkan
    //    PUT tunggal sebesar seluruh berkas; balasan 308 berarti
    //    Google belum menerima utuh (koneksi putus di tengah) — itu
    //    kegagalan `youtube_upload_incomplete`, BUKAN sukses parsial,
    //    dan kelanjutan chunked tidak dicoba otomatis (publikasi
    //    tidak idempoten; operator menjadwalkan ulang secara manual).
    let putRes: Response;
    try {
      putRes = await this.fetchImpl(sessionUri, {
        method: "PUT",
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
        headers: {
          "Content-Type": input.contentType,
          "Content-Length": String(input.data.byteLength),
        },
        body: input.data,
      });
    } catch {
      throw new YouTubeApiError(0, null, "network_error");
    }
    if (putRes.status === 308) {
      throw new YouTubeApiError(308, "uploadIncomplete", "upload_incomplete");
    }
    if (!putRes.ok) throw await this.parseError(putRes);
    const created = (await putRes.json().catch(() => ({}))) as {
      id?: unknown;
    };
    if (typeof created.id !== "string" || !created.id) {
      throw new YouTubeApiError(putRes.status, null, "invalid_response");
    }
    return { videoId: created.id };
  }
}
