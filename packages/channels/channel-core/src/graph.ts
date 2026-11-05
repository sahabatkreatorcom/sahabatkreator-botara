/**
 * Kerangka klien Meta Graph API bersama (Fase 13D).
 *
 * Sebelumnya `channel-messenger` dan `channel-whatsapp` masing-masing
 * menyalin blok yang sama persis: pembentukan header Bearer, pembacaan
 * body error Graph, GET/POST JSON dengan timeout, dan penanganan
 * `network_error` / `invalid_response`. Perbedaan satu-satunya adalah
 * KELAS ERROR yang dilempar (dipakai lapisan API untuk menerjemahkan
 * kode Graph menjadi kode kontrak).
 *
 * Karena itu bagian yang sama hidup di sini, dan tiap adapter hanya
 * menyediakan `createError()` untuk memetakan kegagalan ke kelas
 * error-nya sendiri. Kelas error publik tiap paket TIDAK berubah, jadi
 * `instanceof MetaGraphError` / `WhatsAppGraphError` di route tetap
 * bekerja.
 *
 * KEAMANAN (warisan kedua adapter): token dikirim sebagai header
 * `Authorization: Bearer` — tidak pernah sebagai query `access_token=`
 * — dan pesan error hanya memuat status HTTP + kode/pesan resmi Graph.
 */

/** Base URL Graph API default (override lewat env META_API_BASE untuk mock uji). */
export const DEFAULT_META_API_BASE = "https://graph.facebook.com";

/** Versi Graph ter-pin (RANCANGAN §12.1) — sumber kebenaran ada di @sahabat-kreator/config. */
export const DEFAULT_META_GRAPH_API_VERSION = "v26.0";

/** Bentuk body error resmi Graph yang kita baca (sisanya diabaikan). */
interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

type FetchLike = typeof fetch;

export interface GraphClientOptions {
  /** Base URL Graph API — default https://graph.facebook.com. */
  baseUrl?: string;
  /** Versi Graph ter-pin — default v26.0; lapisan API meneruskan nilai config. */
  apiVersion?: string;
  /** Access token (Page/System User). */
  accessToken?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Error Graph generik. Adapter menurunkan kelasnya sendiri
 * (`MetaGraphError`, `WhatsAppGraphError`) agar tipe error yang
 * diperiksa route tetap spesifik per provider.
 */
export class GraphApiError extends Error {
  readonly status: number;
  /** Kode error numerik Graph (mis. 190 token tidak valid); null bila tak ada. */
  readonly graphCode: number | null;
  /** Subkode error Graph (mis. 36003 kegagalan exchange OAuth); null bila tak ada. */
  readonly graphSubcode: number | null;
  readonly description: string;

  constructor(
    label: string,
    status: number,
    graphCode: number | null,
    description: string,
    graphSubcode: number | null = null,
  ) {
    super(
      `${label} error (HTTP ${status}${graphCode !== null ? `, code ${graphCode}` : ""}): ${description}`,
    );
    this.name = "GraphApiError";
    this.status = status;
    this.graphCode = graphCode;
    this.graphSubcode = graphSubcode;
    this.description = description;
  }
}

/**
 * Klien Graph tipis di atas fetch. Satu instance per token.
 *
 * Subclass WAJIB mengimplementasikan `createError()` supaya semua
 * kegagalan yang dilempar bertipe kelas error provider-nya.
 */
export abstract class GraphHttpClient {
  protected readonly baseUrl: string;
  protected readonly apiVersion: string;
  protected readonly accessToken: string | undefined;
  protected readonly fetchImpl: FetchLike;
  protected readonly timeoutMs: number;

  constructor(options: GraphClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_META_API_BASE).replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? DEFAULT_META_GRAPH_API_VERSION;
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Memetakan kegagalan Graph ke kelas error provider (diisi subclass). */
  protected abstract createError(
    status: number,
    graphCode: number | null,
    description: string,
    graphSubcode: number | null,
  ): GraphApiError;

  protected headers(): Record<string, string> {
    return this.accessToken
      ? { authorization: `Bearer ${this.accessToken}` }
      : {};
  }

  protected async parseError(response: Response): Promise<GraphApiError> {
    let body: GraphErrorBody = {};
    try {
      body = (await response.json()) as GraphErrorBody;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const graphCode =
      typeof body.error?.code === "number" ? body.error.code : null;
    const graphSubcode =
      typeof body.error?.error_subcode === "number"
        ? body.error.error_subcode
        : null;
    const description =
      typeof body.error?.message === "string"
        ? body.error.message.slice(0, 200)
        : "meta_graph_error";
    return this.createError(response.status, graphCode, description, graphSubcode);
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.apiVersion}/${path}`;
  }

  private async sendJson<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    payload?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers:
          payload === undefined
            ? this.headers()
            : { ...this.headers(), "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Error jaringan/timeout: jangan teruskan objek asli.
      throw this.createError(0, null, "network_error", null);
    }
    if (!response.ok) throw await this.parseError(response);
    try {
      return (await response.json()) as T;
    } catch {
      throw this.createError(response.status, null, "invalid_response", null);
    }
  }

  protected async getJson<T>(path: string): Promise<T> {
    return this.sendJson<T>("GET", path);
  }

  /** GET dengan parameter query ter-encode (endpoint OAuth & penemuan aset). */
  protected async getJsonParams<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const query = new URLSearchParams(params).toString();
    return this.getJson<T>(query ? `${path}?${query}` : path);
  }

  protected async postJson<T>(path: string, payload: unknown): Promise<T> {
    return this.sendJson<T>("POST", path, payload);
  }

  protected async deleteJson<T>(path: string): Promise<T> {
    return this.sendJson<T>("DELETE", path);
  }
}
