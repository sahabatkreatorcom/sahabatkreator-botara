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
