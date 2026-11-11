/**
 * @sahabat-kreator/channel-pinterest — klien Pinterest API v5 untuk
 * PUBLIKASI content schedule saja (Gelombang 3).
 *
 * Pinterest bukan channel inbox: tidak ada webhook, pesan, atau DM
 * di paket ini, dan paket ini SENGAJA bukan `ChannelAdapter`. Satu
 * post = satu Pin pada SATU board milik akun yang terhubung.
 *
 * Keputusan board (disengaja, konsisten dengan parameter platform
 * yang dibawakan di tempat lain — mis. kategori bawaan YouTube):
 * board tujuan adalah board PERTAMA akun menurut `GET /v5/boards`.
 * Model post tidak punya konsep board dan UI tidak menambah pemilih
 * board gelombang ini; pemilihan board per postingan adalah
 * pengembangan lanjutan. Akun tanpa board sama sekali gagal aman
 * dengan `pinterest_board_missing` SEBELUM Pin dibuat.
 *
 * Media Pin — dua jalur `media_source`, dipilih dari MIME gambar:
 * - JPEG/PNG → `image_base64`: biner dibaca dari object store privat
 *   lalu dikirim sebagai base64 di badan pembuatan Pin. Jalur utama,
 *   karena model media privat repo tetap utuh (pola Telegram/
 *   Bluesky/YouTube) — TIDAK perlu URL publik.
 * - Format gambar lain yang diterima Pinterest (GIF) →
 *   `image_url`: Pinterest mengambil dari URL publik yang diserahkan
 *   pemanggil (resolver publik pola Instagram/Threads); tanpa URL
 *   publik adapter gagal aman sebelum memanggil API.
 *
 * Video TIDAK didukung paket ini: Pin video menuntut pendaftaran
 * media asinkron API v5 (`POST /v5/media` → unggah multipart ke
 * penyimpanan Pinterest → polling sampai `succeeded`) — subsistem
 * sendiri yang tidak berbagi pola media biner repo; capability di
 * kontrak menyatakannya `supportsVideo: false` (alasan yang sama
 * seperti video Bluesky, Gelombang 1.5).
 *
 * KEAMANAN: access token TIDAK PERNAH masuk pesan error/log —
 * `PinterestApiError` hanya membawa status HTTP + pesan resmi
 * provider yang dipotong.
 */

export const DEFAULT_PINTEREST_API_BASE = "https://api.pinterest.com";

/** Batas judul Pin (karakter) — ditegakkan capability lewat maxTitle di core. */
export const PINTEREST_TITLE_MAX = 100;
/** Batas deskripsi Pin (karakter) — ditegakkan capability di core. */
export const PINTEREST_DESCRIPTION_MAX = 800;

/** MIME gambar yang boleh dikirim sebagai `image_base64` oleh API v5. */
export const PINTEREST_BASE64_IMAGE_TYPES = ["image/jpeg", "image/png"];

/** Error Pinterest yang aman dicatat: status HTTP + pesan resmi provider. */
export class PinterestApiError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
  ) {
    super(`Pinterest API ${status}: ${description}`);
    this.name = "PinterestApiError";
  }
}

/**
 * Petakan error ke errorCode postingan yang aman & stabil. 401
 * (token mati/dicabut) dan 403 (akses aplikasi belum penuh / scope
 * kurang) dibedakan karena tindakan pemiliknya berbeda; 429 adalah
 * rate limit API v5.
 */
export function pinterestErrorCode(err: unknown): string {
  if (!(err instanceof PinterestApiError)) return "pinterest_send_error";
  if (err.status === 0) return "pinterest_network_error";
  if (err.status === 401) return "pinterest_unauthorized";
  if (err.status === 403) return "pinterest_forbidden";
  if (err.status === 429) return "pinterest_rate_limited";
  return `pinterest_http_${err.status}`;
}

export interface PinterestClientOptions {
  /** Base URL API; default https://api.pinterest.com. Override hanya untuk uji mock. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface PinterestBoard {
  id: string;
  name: string | null;
}

/** Hasil exchange/refresh token OAuth Pinterest. */
export interface PinterestOAuthTokenResult {
  accessToken: string;
  /** Umur access token dari provider (30 hari = 2592000 detik); null bila tak dilaporkan. */
  expiresInSeconds: number | null;
  /** Refresh token BARU bila diterbitkan grant ini; null = pertahankan yang lama. */
  refreshToken: string | null;
}

/** Akun Pinterest pemilik token (`GET /v5/user_account`). */
export interface PinterestUserAccount {
  /** ID akun Pinterest — menjadi external_id akun channel. */
  id: string;
  /** Username akun — identitas tampil (adapter & kartu memakai ini). */
  username: string | null;
  /** URL foto profil dari field `profile_image`; null bila tak ada. */
  profileImageUrl: string | null;
}

interface PinterestErrorBody {
  message?: unknown;
}

interface BoardsResponse {
  items?: Array<{ id?: unknown; name?: unknown }>;
}

interface CreatePinResponse {
  id?: unknown;
}

export class PinterestClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PinterestClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_PINTEREST_API_BASE).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async parseError(response: Response): Promise<PinterestApiError> {
    let body: PinterestErrorBody = {};
    try {
      body = (await response.json()) as PinterestErrorBody;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const description =
      typeof body.message === "string"
        ? body.message.slice(0, 200)
        : "pinterest_api_error";
    return new PinterestApiError(response.status, description);
  }

  private async request(
    accessToken: string,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new PinterestApiError(0, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    return response.json().catch(() => ({}));
  }

  // -------------------------------------------------------------------------
  // OAuth connect (gelombang Semua OAuth)
  // -------------------------------------------------------------------------

  /**
   * Satu panggilan ke token endpoint Pinterest
   * (`POST /v5/oauth/token`, form-urlencoded, kredensial aplikasi
   * sebagai HTTP Basic base64(appId:appSecret) — bentuk resmi v5,
   * BUKAN di badan form). Dipakai grant authorization_code maupun
   * refresh_token. App secret TIDAK PERNAH masuk error yang
   * dibangun.
   */
  private async oauthTokenRequest(
    appId: string,
    appSecret: string,
    form: URLSearchParams,
  ): Promise<PinterestOAuthTokenResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v5/oauth/token`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
    } catch {
      throw new PinterestApiError(0, "network_error");
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const accessToken =
      typeof body.access_token === "string" ? body.access_token : null;
    if (!response.ok || !accessToken) {
      const description =
        typeof body.message === "string"
          ? body.message.slice(0, 200)
          : `pinterest_oauth_error_${response.status}`;
      throw new PinterestApiError(response.status, description);
    }
    return {
      accessToken,
      expiresInSeconds:
        typeof body.expires_in === "number" ? body.expires_in : null,
      refreshToken:
        typeof body.refresh_token === "string" ? body.refresh_token : null,
    };
  }

  /**
   * Tukar authorization code → access token (30 hari) + refresh
   * token: grant `authorization_code` dengan redirect_uri yang
   * IDENTIK dengan dialog authorize.
   */
  async exchangePinterestCode(input: {
    appId: string;
    appSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<PinterestOAuthTokenResult> {
    return this.oauthTokenRequest(
      input.appId,
      input.appSecret,
      new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    );
  }

  /**
   * Segarkan access token dari refresh token: grant `refresh_token`.
   * Pinterest mendukung penyegaran berkelanjutan; respons bisa
   * membawa refresh token baru (rotasi) atau tidak — pemanggil
   * menyimpan yang baru bila ada dan mempertahankan yang lama bila
   * tidak (pola runner lifecycle Pinterest di worker). Refresh yang
   * mati/dicabut dijawab 401 oleh provider (dipetakan lifecycle ke
   * akun 'error' pinterest_unauthorized).
   */
  async refreshPinterestAccessToken(input: {
    appId: string;
    appSecret: string;
    refreshToken: string;
  }): Promise<PinterestOAuthTokenResult> {
    return this.oauthTokenRequest(
      input.appId,
      input.appSecret,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
    );
  }

  /**
   * Akun pemilik token (`GET /v5/user_account`, Bearer; butuh scope
   * `user_accounts:read` yang memang diminta dialog connect): id =
   * external_id, username = identitas, `profile_image` = URL foto
   * profil.
   */
  async getPinterestUserAccount(
    accessToken: string,
  ): Promise<PinterestUserAccount> {
    const body = (await this.request(accessToken, "/v5/user_account", {
      method: "GET",
    })) as { id?: unknown; username?: unknown; profile_image?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      throw new PinterestApiError(200, "missing_account_id");
    }
    return {
      id: body.id,
      username: typeof body.username === "string" ? body.username : null,
      profileImageUrl:
        typeof body.profile_image === "string" ? body.profile_image : null,
    };
  }

  /** Daftar board milik akun (satu halaman cukup untuk board bawaan). */
  async listBoards(accessToken: string): Promise<PinterestBoard[]> {
    const body = (await this.request(accessToken, "/v5/boards?page_size=25", {
      method: "GET",
    })) as BoardsResponse;
    return (body.items ?? [])
      .filter((item) => typeof item.id === "string")
      .map((item) => ({
        id: item.id as string,
        name: typeof item.name === "string" ? item.name : null,
      }));
  }

  /**
   * Board tujuan bawaan: board PERTAMA akun, atau null bila akun
   * belum punya board sama sekali (pemanggil memetakannya ke
   * `pinterest_board_missing`).
   */
  async resolveDefaultBoardId(accessToken: string): Promise<string | null> {
    const boards = await this.listBoards(accessToken);
    return boards[0]?.id ?? null;
  }

  /** Buat Pin; mengembalikan id Pin yang menjadi providerMessageId. */
  async createPin(input: {
    accessToken: string;
    payload: PinterestPinPayload;
  }): Promise<{ pinId: string }> {
    const body = (await this.request(input.accessToken, "/v5/pins", {
      method: "POST",
      body: input.payload,
    })) as CreatePinResponse;
    if (typeof body.id !== "string" || !body.id) {
      throw new PinterestApiError(201, "missing_pin_id");
    }
    return { pinId: body.id };
  }
}

// ---------------------------------------------------------------------------
// Pembangun payload Pin (fungsi murni — diuji tanpa jaringan)
// ---------------------------------------------------------------------------

export type PinterestMediaSource =
  | {
      source_type: "image_base64";
      content_type: string;
      data: string;
    }
  | { source_type: "image_url"; url: string };

export interface PinterestPinPayload {
  board_id: string;
  title: string;
  description: string;
  link?: string;
  alt_text?: string;
  media_source: PinterestMediaSource;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * URL tujuan Pin: URL http(s) PERTAMA di dalam caption, atau null.
 * Model post tidak punya field tautan khusus; mengekstrak dari
 * caption adalah pemetaan yang sama seperti facet tautan Bluesky —
 * Pin tanpa tautan di caption terbit tanpa `link` (tautan memang
 * opsional untuk Pin).
 */
export function extractPinterestLink(caption: string): string | null {
  const match = caption.match(URL_PATTERN);
  if (!match) return null;
  const url = match[0].replace(TRAILING_PUNCTUATION, "");
  return url || null;
}

/** Base64 dari biner (per potongan agar tumpukan panggilan aman). */
export function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    binary += String.fromCharCode(...data.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * Rakit payload `POST /v5/pins` (murni): `title` post menjadi judul
 * Pin dan caption menjadi deskripsi — batas 100/800 ditegakkan
 * capability di core saat penjadwalan (judul lewat POST_TITLE_TOO_LONG,
 * caption dipotong per capability); pemotongan di sini pertahanan
 * terakhir. Judul kosong (defensif) jatuh ke baris pertama caption,
 * lalu ke "Pin".
 */
export function buildPinterestPinPayload(input: {
  boardId: string;
  title: string;
  caption: string;
  mediaSource: PinterestMediaSource;
  altText?: string | undefined;
}): PinterestPinPayload {
  const firstCaptionLine = input.caption
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const title = (
    input.title.trim() ||
    firstCaptionLine ||
    "Pin"
  ).slice(0, PINTEREST_TITLE_MAX);
  const link = extractPinterestLink(input.caption);
  return {
    board_id: input.boardId,
    title,
    description: input.caption.slice(0, PINTEREST_DESCRIPTION_MAX),
    ...(link ? { link } : {}),
    ...(input.altText ? { alt_text: input.altText } : {}),
    media_source: input.mediaSource,
  };
}
