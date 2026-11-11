/**
 * @sahabat-kreator/channel-linkedin — klien LinkedIn Posts API untuk
 * PUBLIKASI content schedule saja (Gelombang 3).
 *
 * LinkedIn bukan channel inbox: tidak ada webhook, pesan, atau DM di
 * paket ini, dan paket ini SENGAJA bukan `ChannelAdapter`. Sasaran
 * satu-satunya adalah PROFIL PRIBADI anggota — author post selalu
 * `urn:li:person:{member ID}` dengan access token OAuth ber-scope
 * `w_member_social`. Company Page TIDAK didukung: menerbitkan sebagai
 * Page (`urn:li:organization`) membutuhkan persetujuan program
 * Community Management LinkedIn yang terpisah, dan adapter ini tidak
 * akan pernah menyusun author organisasi.
 *
 * Alur publikasi mengikuti pola media biner repo (Telegram/Bluesky/
 * YouTube) — media dibaca dari object store privat, TIDAK perlu URL
 * publik:
 *   1. Gambar: `POST /rest/images?action=initializeUpload` →
 *      `uploadUrl` + URN gambar; PUT biner ke URL itu.
 *   2. Video: `POST /rest/videos?action=initializeUpload` (dengan
 *      ukuran berkas) → daftar instruksi unggah per potongan byte;
 *      PUT tiap potongan (mengumpulkan ETag); lalu
 *      `POST /rest/videos?action=finalizeUpload`.
 *   3. `POST /rest/posts` dengan author person + commentary (+ konten
 *      media/multiImage bila ada); id postingan adalah URN pada
 *      header respons `x-restli-id`.
 *
 * Semua panggilan REST membawa header `LinkedIn-Version` (versi
 * bulanan ter-pin di `LINKEDIN_API_VERSION` — LinkedIn menghentikan
 * versi setelah ±1 tahun, jadi konstanta ini adalah perawatan berkala
 * yang disengaja, bukan konfigurasi tenant) dan
 * `X-Restli-Protocol-Version: 2.0.0`.
 *
 * KEAMANAN: access token TIDAK PERNAH masuk pesan error/log —
 * `LinkedInApiError` hanya membawa status HTTP + pesan resmi provider
 * yang dipotong (pesan error LinkedIn tidak memuat kredensial).
 */

export const DEFAULT_LINKEDIN_API_BASE = "https://api.linkedin.com";

/**
 * Versi REST LinkedIn ter-pin (format YYYYMM). LinkedIn hanya
 * mendukung satu versi ±1 tahun; menaikkan nilai ini adalah tugas
 * perawatan platform berkala, dilakukan bersama uji mock di repo ini.
 */
export const LINKEDIN_API_VERSION = "202510";

/** Batas commentary Posts API (karakter) — ditegakkan capability di core. */
export const LINKEDIN_COMMENTARY_MAX = 3000;

/** Error LinkedIn yang aman dicatat: status HTTP + pesan resmi provider. */
export class LinkedInApiError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
  ) {
    super(`LinkedIn API ${status}: ${description}`);
    this.name = "LinkedInApiError";
  }
}

/**
 * Petakan error ke errorCode postingan yang aman & stabil. 401 (token
 * mati/dicabut) dan 403 (scope `w_member_social` tidak diberikan /
 * bukan pemilik profil) dibedakan karena tindakan operatornya beda;
 * 429 adalah rate limit aplikasi LinkedIn.
 */
export function linkedinErrorCode(err: unknown): string {
  if (!(err instanceof LinkedInApiError)) return "linkedin_send_error";
  if (err.status === 0) return "linkedin_network_error";
  if (err.status === 401) return "linkedin_unauthorized";
  if (err.status === 403) return "linkedin_forbidden";
  if (err.status === 429) return "linkedin_rate_limited";
  return `linkedin_http_${err.status}`;
}

export interface LinkedInClientOptions {
  /** Base URL API; default https://api.linkedin.com. Override hanya untuk uji mock. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Timeout panggilan REST (metadata); default 15 detik. */
  timeoutMs?: number | undefined;
  /** Timeout unggah biner (video besar); default 180 detik. */
  uploadTimeoutMs?: number | undefined;
}

interface LinkedInErrorBody {
  message?: unknown;
  status?: unknown;
}

interface InitializeImageResponse {
  value?: { uploadUrl?: unknown; image?: unknown };
}

interface InitializeVideoResponse {
  value?: {
    video?: unknown;
    uploadInstructions?: Array<{
      uploadUrl?: unknown;
      firstByte?: unknown;
      lastByte?: unknown;
    }>;
  };
}

export class LinkedInClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(options: LinkedInClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_LINKEDIN_API_BASE).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 180_000;
  }

  private restHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      "LinkedIn-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    };
  }

  private async parseError(response: Response): Promise<LinkedInApiError> {
    let body: LinkedInErrorBody = {};
    try {
      body = (await response.json()) as LinkedInErrorBody;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const description =
      typeof body.message === "string"
        ? body.message.slice(0, 200)
        : "linkedin_api_error";
    return new LinkedInApiError(response.status, description);
  }

  /** POST JSON ke permukaan /rest/*; mengembalikan body JSON terurai. */
  private async postRest(
    accessToken: string,
    path: string,
    payload: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          ...this.restHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new LinkedInApiError(0, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    return response.json().catch(() => ({}));
  }

  /** PUT biner ke URL unggah hasil inisiasi; mengembalikan ETag (bila ada). */
  private async putBinary(input: {
    uploadUrl: string;
    accessToken: string;
    data: Uint8Array;
    contentType: string;
  }): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(input.uploadUrl, {
        method: "PUT",
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": input.contentType,
          "Content-Length": String(input.data.byteLength),
        },
        body: input.data,
      });
    } catch {
      throw new LinkedInApiError(0, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    return response.headers.get("etag");
  }

  /**
   * Unggah SATU gambar: inisiasi → PUT biner → URN gambar
   * (`urn:li:image:…`) siap dirujuk konten post.
   */
  async uploadImage(input: {
    accessToken: string;
    ownerUrn: string;
    data: Uint8Array;
    contentType: string;
  }): Promise<string> {
    const body = (await this.postRest(
      input.accessToken,
      "/rest/images?action=initializeUpload",
      { initializeUploadRequest: { owner: input.ownerUrn } },
    )) as InitializeImageResponse;
    const uploadUrl =
      typeof body.value?.uploadUrl === "string" ? body.value.uploadUrl : null;
    const imageUrn =
      typeof body.value?.image === "string" ? body.value.image : null;
    if (!uploadUrl || !imageUrn) {
      throw new LinkedInApiError(200, "missing_upload_fields");
    }
    await this.putBinary({
      uploadUrl,
      accessToken: input.accessToken,
      data: input.data,
      contentType: input.contentType,
    });
    return imageUrn;
  }

  /**
   * Unggah SATU video: inisiasi (ukuran berkas menentukan jumlah
   * potongan) → PUT tiap potongan byte sesuai instruksi → finalisasi
   * dengan ETag tiap potongan. Mengembalikan URN video
   * (`urn:li:video:…`).
   */
  async uploadVideo(input: {
    accessToken: string;
    ownerUrn: string;
    data: Uint8Array;
    contentType: string;
  }): Promise<string> {
    const body = (await this.postRest(
      input.accessToken,
      "/rest/videos?action=initializeUpload",
      {
        initializeUploadRequest: {
          owner: input.ownerUrn,
          fileSizeBytes: input.data.byteLength,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      },
    )) as InitializeVideoResponse;
    const videoUrn =
      typeof body.value?.video === "string" ? body.value.video : null;
    const instructions = (body.value?.uploadInstructions ?? []).filter(
      (item) =>
        typeof item.uploadUrl === "string" &&
        typeof item.firstByte === "number" &&
        typeof item.lastByte === "number",
    ) as Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
    if (!videoUrn || instructions.length === 0) {
      throw new LinkedInApiError(200, "missing_upload_fields");
    }

    const uploadedPartIds: string[] = [];
    for (const instruction of instructions) {
      const part = input.data.subarray(
        instruction.firstByte,
        instruction.lastByte + 1,
      );
      const etag = await this.putBinary({
        uploadUrl: instruction.uploadUrl,
        accessToken: input.accessToken,
        data: part,
        contentType: input.contentType,
      });
      if (!etag) {
        // Tanpa ETag potongan tidak bisa difinalisasi — gagal di sini
        // lebih jujur daripada finalize yang pasti ditolak LinkedIn.
        throw new LinkedInApiError(200, "missing_part_etag");
      }
      uploadedPartIds.push(etag);
    }

    await this.postRest(input.accessToken, "/rest/videos?action=finalizeUpload", {
      finalizeUploadRequest: {
        video: videoUrn,
        uploadToken: "",
        uploadedPartIds,
      },
    });
    return videoUrn;
  }

  /**
   * Buat post di profil anggota. Id postingan terbit adalah URN pada
   * header `x-restli-id` respons (201) — body respons kosong.
   */
  async createPost(input: {
    accessToken: string;
    payload: LinkedInPostPayload;
  }): Promise<{ postUrn: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/rest/posts`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          ...this.restHeaders(input.accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.payload),
      });
    } catch {
      throw new LinkedInApiError(0, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    const postUrn = response.headers.get("x-restli-id");
    if (!postUrn) {
      throw new LinkedInApiError(response.status, "missing_post_id");
    }
    return { postUrn };
  }
}

// ---------------------------------------------------------------------------
// Pembangun payload post (fungsi murni — diuji tanpa jaringan)
// ---------------------------------------------------------------------------

export interface LinkedInPostPayload {
  author: string;
  commentary: string;
  visibility: "PUBLIC";
  distribution: {
    feedDistribution: "MAIN_FEED";
    targetEntities: never[];
    thirdPartyDistributionChannels: never[];
  };
  lifecycleState: "PUBLISHED";
  isReshareDisabledByAuthor: false;
  content?:
    | { media: { id: string; altText?: string; title?: string } }
    | {
        multiImage: {
          images: Array<{ id: string; altText?: string }>;
        };
      };
}

/**
 * Rakit payload `/rest/posts` untuk PROFIL PRIBADI (murni):
 * - author selalu `urn:li:person:{memberId}` — fungsi ini tidak
 *   menerima bentuk author lain, jadi jalur organisasi tidak bisa
 *   terbentuk dari sini.
 * - Tanpa media → post teks (tautan di dalam commentary dirender
 *   LinkedIn sebagai pratinjau di feed; konten `article` terstruktur
 *   tidak disusun gelombang ini).
 * - Tepat 1 gambar/video → `content.media`; ≥2 gambar →
 *   `content.multiImage`. Campuran gambar+video tidak punya bentuk di
 *   Posts API dan ditolak ADAPTER sebelum sampai ke fungsi ini.
 * - Batas commentary (3000) ditegakkan capability di core saat
 *   penjadwalan; pemotongan di sini pertahanan terakhir.
 */
export function buildLinkedInPostPayload(input: {
  /** Member ID LinkedIn (subjek token) — TANPA awalan urn. */
  memberId: string;
  caption: string;
  images?: Array<{ urn: string; alt: string }> | undefined;
  video?: { urn: string; title: string } | undefined;
}): LinkedInPostPayload {
  const images = input.images ?? [];
  const base: LinkedInPostPayload = {
    author: `urn:li:person:${input.memberId}`,
    commentary: input.caption.slice(0, LINKEDIN_COMMENTARY_MAX),
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (input.video) {
    return {
      ...base,
      content: {
        media: {
          id: input.video.urn,
          ...(input.video.title ? { title: input.video.title } : {}),
        },
      },
    };
  }
  if (images.length === 1) {
    return {
      ...base,
      content: {
        media: {
          id: images[0]!.urn,
          ...(images[0]!.alt ? { altText: images[0]!.alt } : {}),
        },
      },
    };
  }
  if (images.length > 1) {
    return {
      ...base,
      content: {
        multiImage: {
          images: images.map((image) => ({
            id: image.urn,
            ...(image.alt ? { altText: image.alt } : {}),
          })),
        },
      },
    };
  }
  return base;
}
