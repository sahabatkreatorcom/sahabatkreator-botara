/**
 * @sahabat-kreator/channel-pinterest — klien Pinterest API v5 untuk
 * PUBLIKASI content schedule saja (Gelombang 3).
 *
 * Pinterest bukan channel inbox: tidak ada webhook, pesan, atau DM
 * di paket ini, dan paket ini SENGAJA bukan `ChannelAdapter`. Satu
 * post = satu Pin pada SATU board milik akun yang terhubung.
 *
 * Keputusan board: Pin WAJIB masuk sebuah board (`board_id` pada
 * `POST /v5/pins` — Pinterest tidak mengenal Pin tanpa board).
 * Pemilik workspace bisa memilih board tujuan PER AKUN di Channels
 * (pemilih board; pilihan tersimpan di kolom akun + dibuatkan dari
 * pemilih yang sama lewat `POST /v5/boards`). Penerbit memutuskan
 * board lewat `resolvePinBoard`: pilihan tersimpan yang masih ada
 * di daftar board akun menang; pilihan yang sudah hilang di sisi
 * Pinterest jatuh ke board PERTAMA akun (dengan penanda agar
 * pemanggil mencatatnya); tanpa pilihan → board pertama seperti
 * perilaku awal. Akun tanpa board sama sekali gagal aman dengan
 * `pinterest_board_missing` SEBELUM Pin dibuat.
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

/** Batas halaman daftar board yang diikuti `listBoards` (25/halaman). */
const MAX_BOARD_PAGES = 10;

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

/**
 * Privasi board yang boleh dibuat dari pemilih board. API v5 juga
 * mengenal `SECRET`, tetapi board rahasia menuntut scope terpisah
 * (`boards:write_secret`) yang SENGAJA tidak diminta connect kita —
 * jadi SECRET tidak ditawarkan di sini.
 */
export type PinterestBoardPrivacy = "PUBLIC" | "PROTECTED";

/** Hasil keputusan board tujuan satu Pin (lihat `resolvePinBoard`). */
export interface PinterestPinBoardResolution {
  /** Board tujuan final; null bila akun tidak punya board sama sekali. */
  boardId: string | null;
  /** Asal boardId: pilihan tersimpan pemilik / board pertama / tidak ada. */
  source: "chosen" | "first" | "missing";
  /**
   * true bila ada pilihan tersimpan tetapi board-nya tidak ditemukan
   * lagi di daftar board akun (dihapus/diubah di Pinterest) sehingga
   * keputusan jatuh ke board pertama — pemanggil WAJIB mencatatnya
   * secara jujur, bukan diam-diam.
   */
  preferredMissing: boolean;
  /** Daftar board akun yang menjadi dasar keputusan. */
  boards: PinterestBoard[];
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
  /** Penanda halaman berikutnya daftar board API v5; kosong = terakhir. */
  bookmark?: unknown;
}

interface CreateBoardResponse {
  id?: unknown;
  name?: unknown;
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

  /**
   * Daftar board milik akun — mengikuti paginasi `bookmark` API v5
   * sampai habis, dibatasi MAX_BOARD_PAGES halaman agar akun dengan
   * board sangat banyak tidak memicu panggilan tanpa batas. Urutan
   * mengikuti urutan provider (board pertama daftar = board pertama
   * akun, dasar fallback penerbit sejak Gelombang 3).
   */
  /**
   * Analitik SATU Pin (Fase Susulan S3): `GET /v5/pins/{pin_id}
   * /analytics?start_date&end_date&metric_types=IMPRESSION,SAVE,
   * PIN_CLICK,OUTBOUND_CLICK` (scope `pins:read`; hanya akun
   * bisnis). Respons v5 membawa `all_time.metrics` (agregat seumur
   * Pin sampai end_date) dan/atau `daily_metrics[]` per hari —
   * metode ini mengutamakan all_time; bila absen, menjumlahkan
   * baris harian pada rentang yang diminta. Mengembalikan peta nama
   * metrik platform → nilai; metrik yang tidak dilaporkan absen.
   */
  async getPinAnalytics(input: {
    accessToken: string;
    pinId: string;
    startDate: string;
    endDate: string;
  }): Promise<Record<string, number>> {
    const query = new URLSearchParams({
      start_date: input.startDate,
      end_date: input.endDate,
      metric_types: "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK",
    }).toString();
    const body = (await this.request(
      input.accessToken,
      `/v5/pins/${encodeURIComponent(input.pinId)}/analytics?${query}`,
      { method: "GET" },
    )) as {
      all_time?: { metrics?: Record<string, unknown> };
      daily_metrics?: Array<{ metrics?: Record<string, unknown> }>;
    };
    const out: Record<string, number> = {};
    const absorb = (
      metrics: Record<string, unknown> | undefined,
      sum: boolean,
    ): void => {
      if (!metrics) return;
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === "number") {
          out[key] = sum ? (out[key] ?? 0) + value : value;
        }
      }
    };
    if (body.all_time?.metrics) {
      absorb(body.all_time.metrics, false);
    } else {
      for (const day of body.daily_metrics ?? []) absorb(day.metrics, true);
    }
    return out;
  }

  async listBoards(accessToken: string): Promise<PinterestBoard[]> {
    const boards: PinterestBoard[] = [];
    let bookmark: string | null = null;
    for (let page = 0; page < MAX_BOARD_PAGES; page += 1) {
      const path = bookmark
        ? `/v5/boards?page_size=25&bookmark=${encodeURIComponent(bookmark)}`
        : "/v5/boards?page_size=25";
      const body = (await this.request(accessToken, path, {
        method: "GET",
      })) as BoardsResponse;
      for (const item of body.items ?? []) {
        if (typeof item.id !== "string") continue;
        boards.push({
          id: item.id,
          name: typeof item.name === "string" ? item.name : null,
        });
      }
      bookmark =
        typeof body.bookmark === "string" && body.bookmark
          ? body.bookmark
          : null;
      if (!bookmark) break;
    }
    return boards;
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

  /**
   * Putuskan board tujuan SATU Pin dari pilihan tersimpan pemilik
   * (per akun, dari pemilih board Channels):
   * - pilihan masih ada di daftar board akun → pakai pilihan itu;
   * - pilihan tersimpan tetapi sudah hilang di Pinterest → jatuh ke
   *   board pertama dengan `preferredMissing: true` (pemanggil
   *   mencatatnya — keputusan tidak boleh senyap);
   * - tanpa pilihan → board pertama (perilaku awal Gelombang 3);
   * - akun tanpa board → `boardId: null` (pemanggil memetakannya
   *   ke `pinterest_board_missing`).
   */
  async resolvePinBoard(
    accessToken: string,
    preferredBoardId: string | null,
  ): Promise<PinterestPinBoardResolution> {
    const boards = await this.listBoards(accessToken);
    if (boards.length === 0) {
      return {
        boardId: null,
        source: "missing",
        preferredMissing: Boolean(preferredBoardId),
        boards,
      };
    }
    if (preferredBoardId) {
      const chosen = boards.find((board) => board.id === preferredBoardId);
      if (chosen) {
        return {
          boardId: chosen.id,
          source: "chosen",
          preferredMissing: false,
          boards,
        };
      }
      return {
        boardId: boards[0]!.id,
        source: "first",
        preferredMissing: true,
        boards,
      };
    }
    return {
      boardId: boards[0]!.id,
      source: "first",
      preferredMissing: false,
      boards,
    };
  }

  /**
   * Buat board baru milik akun (`POST /v5/boards`, scope
   * `boards:write` yang sudah diminta connect). Badan mengikuti
   * bentuk resmi API v5: `name` wajib; `description` opsional
   * (diabaikan bila kosong); `privacy` PUBLIC/PROTECTED — SECRET
   * tidak ditawarkan karena scope-nya tidak kita minta. Board yang
   * baru dibuat langsung bisa dipilih sebagai board tujuan.
   */
  async createBoard(
    accessToken: string,
    input: {
      name: string;
      description?: string | undefined;
      privacy?: PinterestBoardPrivacy | undefined;
    },
  ): Promise<PinterestBoard> {
    const description = input.description?.trim();
    const body = (await this.request(accessToken, "/v5/boards", {
      method: "POST",
      body: {
        name: input.name,
        ...(description ? { description } : {}),
        privacy: input.privacy ?? "PUBLIC",
      },
    })) as CreateBoardResponse;
    if (typeof body.id !== "string" || !body.id) {
      throw new PinterestApiError(201, "missing_board_id");
    }
    return {
      id: body.id,
      name: typeof body.name === "string" ? body.name : input.name,
    };
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
