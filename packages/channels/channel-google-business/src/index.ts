/**
 * @sahabat-kreator/channel-google-business — klien Google Business
 * Profile API untuk PUBLIKASI content schedule saja (Gelombang 3).
 *
 * Google Business bukan channel inbox: tidak ada webhook, pesan,
 * atau DM di paket ini, dan paket ini SENGAJA bukan `ChannelAdapter`.
 * Satu-satunya permukaan publikasi adalah POSTINGAN LOKAL
 * (`localPosts`) pada SATU lokasi bisnis:
 *
 *   POST /v4/{locationName}/localPosts
 *   { languageCode, summary, topicType: "STANDARD",
 *     media?: [{ mediaFormat: "PHOTO", sourceUrl }],
 *     callToAction?: { actionType: "LEARN_MORE", url } }
 *
 * Keputusan pemetaan yang dibangun di sini:
 * - Sasaran adalah NAMA RESOURCE LOKASI
 *   (`accounts/{accountId}/locations/{locationId}`) — alamat kirim
 *   disimpan sebagai `provider_chat_id` sasaran oleh core, jadi
 *   klien menerima nama itu apa adanya dan tidak mengenal konsep
 *   akun terpisah.
 * - Media hanya FOTO dan hanya dari `sourceUrl` PUBLIK: API tidak
 *   menerima unggahan biner untuk postingan lokal. Pemanggil
 *   (adapter) menyerahkan URL dari resolver publik repo dan gagal
 *   aman sebelum memanggil klien bila URL tidak tersedia — media
 *   internal yang privat tidak pernah ditebak URL-nya.
 * - Tombol CTA: model post tidak punya field CTA, jadi CTA
 *   `LEARN_MORE` disusun dari URL http(s) PERTAMA di caption bila
 *   ada (pemetaan yang sama seperti tautan Pin Pinterest); tanpa
 *   URL, postingan terbit tanpa tombol.
 * - `languageCode` bawaan "id": konten tenant repo ini berbahasa
 *   Indonesia (UI dan bahasa bawaan tenant), dan kode bahasa
 *   postingan lokal harus cocok dengan bahasa ringkasannya.
 *
 * GERBANG KUOTA: kuota Business Profile API bernilai 0 sampai Google
 * menyetujui pengajuan akses pemilik. Selama belum disetujui,
 * panggilan ini menjawab 403 PERMISSION_DENIED — dipetakan ke kode
 * khusus `google_business_permission_denied` agar operator bisa
 * membedakan "akses API belum diberikan Google" dari kegagalan
 * postingan biasa. Persetujuan itu kebutuhan pemilik (OWNER-ACTIONS).
 *
 * Kredensial TIDAK dikenal paket ini: pemanggil (adapter worker)
 * menyerahkan access token yang sudah ditukar dari refresh token
 * koneksi Google tenant oleh core
 * (`getGoogleBusinessPublishAccess`). Access token TIDAK PERNAH
 * masuk error/log — `GoogleBusinessApiError` hanya membawa status
 * HTTP + status resmi Google + pesan resmi yang dipotong.
 */

export const DEFAULT_GOOGLE_BUSINESS_API_BASE =
  "https://mybusiness.googleapis.com";

/** Batas ringkasan (summary) postingan lokal (karakter). */
export const GOOGLE_BUSINESS_SUMMARY_MAX = 1500;

/** Kode bahasa bawaan postingan lokal — konten tenant berbahasa Indonesia. */
export const GOOGLE_BUSINESS_DEFAULT_LANGUAGE = "id";

/** Error Google yang aman dicatat: status HTTP + status resmi provider. */
export class GoogleBusinessApiError extends Error {
  constructor(
    readonly status: number,
    /** `status` resmi Google (mis. `PERMISSION_DENIED`); null bila tak terbaca. */
    readonly googleStatus: string | null,
    readonly description: string,
  ) {
    super(
      `Google Business API ${status}${googleStatus ? ` ${googleStatus}` : ""}: ${description}`,
    );
    this.name = "GoogleBusinessApiError";
  }
}

/**
 * Petakan error ke errorCode postingan yang aman & stabil. Dua kode
 * khusus mencerminkan gerbang platform: PERMISSION_DENIED (akses API
 * belum disetujui / lokasi bukan milik akun) dan RESOURCE_EXHAUSTED
 * (kuota — termasuk kuota 0 sebelum persetujuan pada sebagian
 * permukaan) harus bisa dibedakan operator dari kegagalan biasa.
 */
export function googleBusinessErrorCode(err: unknown): string {
  if (!(err instanceof GoogleBusinessApiError)) {
    return "google_business_send_error";
  }
  if (err.status === 0) return "google_business_network_error";
  if (
    err.googleStatus === "RESOURCE_EXHAUSTED" ||
    err.status === 429
  ) {
    return "google_business_quota_exceeded";
  }
  if (err.googleStatus === "PERMISSION_DENIED" || err.status === 403) {
    return "google_business_permission_denied";
  }
  if (err.status === 401) return "google_business_unauthorized";
  return `google_business_http_${err.status}`;
}

export interface GoogleBusinessClientOptions {
  /** Base URL Business Profile API; default https://mybusiness.googleapis.com. Override hanya untuk uji mock. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

interface GoogleErrorBody {
  error?: {
    status?: unknown;
    message?: unknown;
  };
}

export class GoogleBusinessClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GoogleBusinessClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ?? DEFAULT_GOOGLE_BUSINESS_API_BASE
    ).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async parseError(
    response: Response,
  ): Promise<GoogleBusinessApiError> {
    let body: GoogleErrorBody = {};
    try {
      body = (await response.json()) as GoogleErrorBody;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const googleStatus =
      typeof body.error?.status === "string"
        ? body.error.status.slice(0, 64)
        : null;
    const description =
      typeof body.error?.message === "string"
        ? body.error.message.slice(0, 200)
        : "google_business_api_error";
    return new GoogleBusinessApiError(
      response.status,
      googleStatus,
      description,
    );
  }

  /**
   * Buat SATU postingan lokal STANDARD pada lokasi sasaran.
   * Mengembalikan nama resource postingan terbit
   * (`{locationName}/localPosts/{id}`) sebagai providerMessageId.
   */
  async createLocalPost(input: {
    accessToken: string;
    /** Nama resource lokasi: `accounts/{a}/locations/{l}`. */
    locationName: string;
    payload: GoogleBusinessLocalPostPayload;
  }): Promise<{ localPostName: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/v4/${input.locationName}/localPosts`,
        {
          method: "POST",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input.payload),
        },
      );
    } catch {
      throw new GoogleBusinessApiError(0, null, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    const body = (await response.json().catch(() => ({}))) as {
      name?: unknown;
    };
    if (typeof body.name !== "string" || !body.name) {
      throw new GoogleBusinessApiError(
        response.status,
        null,
        "missing_local_post_name",
      );
    }
    return { localPostName: body.name };
  }
}

// ---------------------------------------------------------------------------
// Pembangun payload postingan lokal (fungsi murni — diuji tanpa jaringan)
// ---------------------------------------------------------------------------

export interface GoogleBusinessLocalPostPayload {
  languageCode: string;
  summary: string;
  topicType: "STANDARD";
  media?: Array<{ mediaFormat: "PHOTO"; sourceUrl: string }>;
  callToAction?: { actionType: "LEARN_MORE"; url: string };
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** URL http(s) pertama di caption (tanda baca ekor dibuang), atau null. */
export function extractGoogleBusinessLink(caption: string): string | null {
  const match = caption.match(URL_PATTERN);
  if (!match) return null;
  const url = match[0].replace(TRAILING_PUNCTUATION, "");
  return url || null;
}

/**
 * Rakit payload `localPosts.create` (murni):
 * - caption utuh menjadi `summary` (batas 1500 ditegakkan capability
 *   di core saat penjadwalan; pemotongan di sini pertahanan terakhir);
 * - foto opsional sebagai media `sourceUrl` PUBLIK yang diserahkan
 *   pemanggil — fungsi ini tidak pernah menyusun URL sendiri;
 * - CTA `LEARN_MORE` dari URL pertama di caption bila ada.
 */
export function buildGoogleBusinessLocalPostPayload(input: {
  caption: string;
  photoUrl?: string | null | undefined;
  languageCode?: string | undefined;
}): GoogleBusinessLocalPostPayload {
  const link = extractGoogleBusinessLink(input.caption);
  return {
    languageCode: input.languageCode ?? GOOGLE_BUSINESS_DEFAULT_LANGUAGE,
    summary: input.caption.slice(0, GOOGLE_BUSINESS_SUMMARY_MAX),
    topicType: "STANDARD",
    ...(input.photoUrl
      ? {
          media: [
            {
              mediaFormat: "PHOTO" as const,
              sourceUrl: input.photoUrl,
            },
          ],
        }
      : {}),
    ...(link
      ? { callToAction: { actionType: "LEARN_MORE" as const, url: link } }
      : {}),
  };
}
