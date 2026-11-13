/**
 * @sahabat-kreator/channel-bluesky — klien XRPC AT Protocol untuk
 * PUBLIKASI content schedule saja (Gelombang 1.5).
 *
 * Bluesky bukan Meta dan bukan Telegram: tidak ada host Graph, tidak
 * ada token bot di URL. Yang dipakai paket ini hanya tiga panggilan
 * XRPC ke PDS (Personal Data Server) akun:
 *
 *   1. `com.atproto.server.createSession` — identifier (DID/handle) +
 *      app password ditukar menjadi sesi ber-accessJwt singkat;
 *   2. `com.atproto.repo.uploadBlob` — biner media diunggah apa adanya
 *      dan dibalas blob ref. Inilah keunggulan Bluesky untuk repo ini:
 *      media internal yang privat TIDAK perlu URL publik seperti yang
 *      dituntut API container Instagram/Threads;
 *   3. `com.atproto.repo.createRecord` — record `app.bsky.feed.post`
 *      ditulis ke repo akun; URI record menjadi id postingan.
 *
 * Paket ini SENGAJA bukan `ChannelAdapter`: tidak ada webhook, pesan,
 * atau DM. Video juga tidak ada di sini — unggah video Bluesky
 * berjalan lewat layanan video terpisah (`app.bsky.video.uploadVideo`
 * + polling job + token layanan), bukan `uploadBlob`; capability di
 * kontrak menyatakannya `supportsVideo: false`.
 *
 * Base URL default `https://bsky.social` adalah entryway Bluesky: ia
 * meneruskan panggilan XRPC ke PDS tempat akun tinggal, jadi akun
 * yang di-hosting Bluesky bekerja ujung-ke-ujung dengan satu base.
 * Akun pada PDS mandiri di luar entryway memerlukan resolusi DID → PDS
 * per akun — di luar cakupan gelombang ini (dicatat di OWNER-ACTIONS
 * roadmap).
 *
 * KEAMANAN: app password dan accessJwt adalah kredensial penuh.
 * Keduanya TIDAK PERNAH masuk pesan error/log di paket ini —
 * `BlueskyApiError` hanya membawa status HTTP + nama error resmi XRPC
 * + pesan resmi yang dipotong (pesan resmi AT Protocol tidak memuat
 * kredensial).
 */

export const DEFAULT_BLUESKY_API_BASE = "https://bsky.social";

/**
 * Base AppView publik untuk pembacaan agregat (S3 `getPostCounts`):
 * host ini melayani `app.bsky.feed.getPosts` tanpa sesi, berbeda dari
 * entryway PDS di atas yang untuk tulis/sesi.
 */
export const DEFAULT_BLUESKY_APPVIEW_BASE = "https://public.api.bsky.app";

/** Koleksi record postingan linimasa Bluesky. */
export const BLUESKY_POST_COLLECTION = "app.bsky.feed.post";

/** Batas gambar per postingan Bluesky (embed `app.bsky.embed.images`). */
export const BLUESKY_MAX_IMAGES = 4;

/** Error XRPC yang aman dicatat: status HTTP + nama error resmi provider. */
export class BlueskyApiError extends Error {
  constructor(
    readonly status: number,
    /** Nama error XRPC resmi (mis. `AuthenticationRequired`); null bila tak terbaca. */
    readonly xrpcError: string | null,
    readonly description: string,
  ) {
    super(`Bluesky XRPC ${status}${xrpcError ? ` ${xrpcError}` : ""}: ${description}`);
    this.name = "BlueskyApiError";
  }
}

export interface BlueskyClientOptions {
  /** Base URL entryway/PDS; default https://bsky.social. Override hanya untuk uji mock. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface BlueskySession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

/** Profil aktor Bluesky (`app.bsky.actor.getProfile`). */
export interface BlueskyProfile {
  did: string;
  handle: string;
  /** URL avatar aktor; null bila akun tidak memasang avatar. */
  avatarUrl: string | null;
}

/** Referensi blob hasil `uploadBlob`, siap disematkan ke record. */
export interface BlueskyBlobRef {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: "app.bsky.richtext.facet#link"; uri: string }
    | { $type: "app.bsky.richtext.facet#mention"; did: string }
    | { $type: "app.bsky.richtext.facet#tag"; tag: string }
  >;
}

export interface BlueskyPostRecord {
  $type: typeof BLUESKY_POST_COLLECTION;
  text: string;
  createdAt: string;
  facets?: BlueskyFacet[];
  embed?: {
    $type: "app.bsky.embed.images";
    images: Array<{ alt: string; image: BlueskyBlobRef }>;
  };
}

interface XrpcErrorBody {
  error?: unknown;
  message?: unknown;
}

export class BlueskyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BlueskyClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BLUESKY_API_BASE).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async parseError(response: Response): Promise<BlueskyApiError> {
    let body: XrpcErrorBody = {};
    try {
      body = (await response.json()) as XrpcErrorBody;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const xrpcError =
      typeof body.error === "string" ? body.error.slice(0, 64) : null;
    const description =
      typeof body.message === "string"
        ? body.message.slice(0, 200)
        : "bluesky_xrpc_error";
    return new BlueskyApiError(response.status, xrpcError, description);
  }

  private async request(
    path: string,
    init: {
      body?: string | Uint8Array | undefined;
      contentType?: string | undefined;
      accessJwt?: string | undefined;
    },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/xrpc/${path}`, {
        method: "POST",
        headers: {
          ...(init.contentType
            ? { "content-type": init.contentType }
            : {}),
          ...(init.accessJwt
            ? { authorization: `Bearer ${init.accessJwt}` }
            : {}),
        },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Error jaringan/timeout: jangan teruskan objek asli (bisa memuat
      // URL/konteks yang tidak perlu); status 0 = tidak sampai provider.
      throw new BlueskyApiError(0, null, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    try {
      return await response.json();
    } catch {
      throw new BlueskyApiError(response.status, null, "invalid_response");
    }
  }

  private postJson(
    path: string,
    payload: unknown,
    accessJwt?: string,
  ): Promise<unknown> {
    return this.request(path, {
      body: JSON.stringify(payload),
      contentType: "application/json",
      accessJwt,
    });
  }

  /**
   * Tukarkan identifier + app password menjadi sesi.
   *
   * App password dibuat pemilik di pengaturan Bluesky (Privacy and
   * Security → App Passwords) dan BUKAN kata sandi akun utama: ia bisa
   * dicabut sendiri tanpa mengganggu login. Sesi dibuat segar setiap
   * publikasi dan accessJwt-nya tidak disimpan — tidak ada token
   * berumur panjang yang perlu dirotasi di sisi kita.
   */
  async createSession(input: {
    identifier: string;
    password: string;
  }): Promise<BlueskySession> {
    const body = (await this.postJson("com.atproto.server.createSession", {
      identifier: input.identifier,
      password: input.password,
    })) as Partial<BlueskySession>;
    if (!body.did || !body.accessJwt || !body.refreshJwt) {
      throw new BlueskyApiError(200, null, "missing_session_fields");
    }
    return {
      did: body.did,
      handle: body.handle ?? input.identifier,
      accessJwt: body.accessJwt,
      refreshJwt: body.refreshJwt,
    };
  }

  /**
   * Profil aktor (`GET /xrpc/app.bsky.actor.getProfile?actor=…`,
   * Bearer accessJwt sesi): handle kanonis + URL avatar. Dipakai
   * connect untuk mengambil foto profil sesudah sesi tervalidasi,
   * dan backfill avatar di API. Permukaan ini GET — plumbing kelas
   * ini berbasis POST, jadi panggilannya berdiri sendiri dengan
   * aturan error yang sama. accessJwt TIDAK PERNAH masuk error.
   */
  async getProfile(input: {
    actor: string;
    accessJwt: string;
  }): Promise<BlueskyProfile> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(input.actor)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${input.accessJwt}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new BlueskyApiError(0, null, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    const body = (await response.json().catch(() => ({}))) as {
      did?: unknown;
      handle?: unknown;
      avatar?: unknown;
    };
    if (typeof body.did !== "string" || !body.did) {
      throw new BlueskyApiError(200, null, "missing_profile_did");
    }
    return {
      did: body.did,
      handle: typeof body.handle === "string" ? body.handle : input.actor,
      avatarUrl: typeof body.avatar === "string" ? body.avatar : null,
    };
  }

  /** Unggah biner media ke PDS; mengembalikan blob ref untuk embed. */
  async uploadBlob(input: {
    accessJwt: string;
    data: Uint8Array;
    contentType: string;
  }): Promise<BlueskyBlobRef> {
    const body = (await this.request("com.atproto.repo.uploadBlob", {
      body: input.data,
      contentType: input.contentType,
      accessJwt: input.accessJwt,
    })) as { blob?: BlueskyBlobRef };
    if (!body.blob?.ref?.$link) {
      throw new BlueskyApiError(200, null, "missing_blob_ref");
    }
    return body.blob;
  }

  /** Tulis record post ke repo akun; URI record = id postingan terbit. */
  async createRecord(input: {
    accessJwt: string;
    repo: string;
    record: BlueskyPostRecord;
  }): Promise<{ uri: string; cid: string }> {
    const body = (await this.postJson(
      "com.atproto.repo.createRecord",
      {
        repo: input.repo,
        collection: BLUESKY_POST_COLLECTION,
        record: input.record,
      },
      input.accessJwt,
    )) as { uri?: string; cid?: string };
    if (!body.uri || !body.cid) {
      throw new BlueskyApiError(200, null, "missing_record_uri");
    }
    return { uri: body.uri, cid: body.cid };
  }

  /**
   * Hitungan keterlibatan SATU post (Fase Susulan S3):
   * `GET /xrpc/app.bsky.feed.getPosts?uris=<at-uri>`. Ini metode
   * AppView — klien untuk panggilan ini dibangun dengan base URL
   * AppView (publik `https://public.api.bsky.app`), BUKAN entryway
   * PDS sesi. Hitungan tertanam pada objek post dan bersifat publik:
   * tanpa kredensial. null bila AppView tidak menemukan post-nya;
   * field hitungan yang absen tetap absen (bukan 0).
   */
  async getPostCounts(uri: string): Promise<{
    likes?: number;
    comments?: number;
    shares?: number;
    quotes?: number;
  } | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new BlueskyApiError(0, null, "network_error");
    }
    if (!response.ok) throw await this.parseError(response);
    const body = (await response.json().catch(() => ({}))) as {
      posts?: Array<{
        likeCount?: unknown;
        replyCount?: unknown;
        repostCount?: unknown;
        quoteCount?: unknown;
      }>;
    };
    const post = body.posts?.[0];
    if (!post) return null;
    const out: {
      likes?: number;
      comments?: number;
      shares?: number;
      quotes?: number;
    } = {};
    if (typeof post.likeCount === "number") out.likes = post.likeCount;
    if (typeof post.replyCount === "number") out.comments = post.replyCount;
    if (typeof post.repostCount === "number") out.shares = post.repostCount;
    if (typeof post.quoteCount === "number") out.quotes = post.quoteCount;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Pembangun record (fungsi murni — diuji tanpa jaringan)
// ---------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Facet tautan untuk URL http(s) di dalam teks.
 *
 * AT Protocol mengindeks facet dengan offset BYTE UTF-8, bukan indeks
 * karakter JS — teks ber-emoji sebelum tautan menggeser posisi byte
 * lebih jauh daripada posisi karakternya. Tanda baca menggantung di
 * akhir URL mentah (koma/titik kalimat) dibuang dari cakupan facet.
 * Facet mention TIDAK dibangun di sini: mention yang sah butuh DID
 * hasil resolusi handle (`com.atproto.identity.resolveHandle`) —
 * panggilan jaringan tambahan yang di luar pola fungsi murni ini;
 * teks `@handle` tetap terbit sebagai teks biasa.
 */
export function buildLinkFacets(text: string): BlueskyFacet[] {
  const encoder = new TextEncoder();
  const byteLength = (value: string) => encoder.encode(value).length;
  const facets: BlueskyFacet[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const uri = raw.replace(TRAILING_PUNCTUATION, "");
    if (!uri) continue;
    const charStart = match.index ?? 0;
    const byteStart = byteLength(text.slice(0, charStart));
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLength(uri) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    });
  }
  return facets;
}

/**
 * Rakit record `app.bsky.feed.post` dari caption + blob gambar.
 *
 * Batas jumlah gambar (maks 4) dan panjang teks (maks 300 grapheme)
 * ditegakkan capability di core sebelum penjadwalan; fungsi ini hanya
 * menolak gambar berlebih sebagai pertahanan terakhir, karena embed
 * yang ditolak PDS di jam tayang adalah kegagalan paling mahal.
 */
export function buildBlueskyPostRecord(input: {
  text: string;
  images?: Array<{ blob: BlueskyBlobRef; alt: string }> | undefined;
  createdAt?: Date | undefined;
}): BlueskyPostRecord {
  const images = input.images ?? [];
  if (images.length > BLUESKY_MAX_IMAGES) {
    throw new Error("bluesky_media_too_many");
  }
  const facets = buildLinkFacets(input.text);
  return {
    $type: BLUESKY_POST_COLLECTION,
    text: input.text,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    ...(facets.length > 0 ? { facets } : {}),
    ...(images.length > 0
      ? {
          embed: {
            $type: "app.bsky.embed.images" as const,
            images: images.map((item) => ({
              alt: item.alt,
              image: item.blob,
            })),
          },
        }
      : {}),
  };
}
