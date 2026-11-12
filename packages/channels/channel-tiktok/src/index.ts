/**
 * @sahabat-kreator/channel-tiktok — klien TikTok Content Posting API
 * untuk PUBLIKASI content schedule saja (Gelombang 4, gelombang
 * terakhir roadmap).
 *
 * TikTok bukan channel inbox: tidak ada webhook, pesan, atau DM di
 * paket ini, dan paket ini SENGAJA bukan `ChannelAdapter`. Satu post
 * = satu DIRECT POST ke akun kreator yang terhubung, dalam dua
 * bentuk yang protokolnya berbeda:
 *
 * VIDEO (tepat satu):
 *   1. `POST /v2/post/publish/creator_info/query/` — info kreator
 *      WAJIB dicek sebelum posting: `privacy_level_options` akun,
 *      dan apakah komentar/duet/stitch dimatikan kreator.
 *   2. `POST /v2/post/publish/video/init/` dengan
 *      `source_info.source = "FILE_UPLOAD"` → `publish_id` +
 *      `upload_url`.
 *   3. PUT biner video per potongan ke `upload_url` (header
 *      `Content-Range`) — video dibaca dari object store privat,
 *      TIDAK perlu URL publik (pola Telegram/Bluesky/YouTube).
 *   4. `POST /v2/post/publish/status/fetch/` dipolling sampai
 *      `PUBLISH_COMPLETE` / `FAILED`.
 *
 * FOTO / CAROUSEL (satu foto atau album khusus foto):
 *   1. `creator_info/query/` yang sama (gerbang privasi identik).
 *   2. `POST /v2/post/publish/content/init/` dengan
 *      `media_type: "PHOTO"`, `post_mode: "DIRECT_POST"`, dan
 *      `source_info.source = "PULL_FROM_URL"` → `publish_id`
 *      (tanpa sesi unggah: TikTok MENARIK foto dari URL kita).
 *   3. Polling `status/fetch/` yang sama sampai terminal
 *      (`PROCESSING_DOWNLOAD` adalah keadaan khas jalur tarik ini).
 *
 * GERBANG AUDIT (fakta platform, bukan kekurangan implementasi):
 * aplikasi yang belum lolos audit Content Posting API TikTok HANYA
 * boleh menerbitkan dengan privasi `SELF_ONLY`. Klien ini menerima
 * level privasi yang diminta dari konfigurasi platform (bawaan
 * `SELF_ONLY` di env worker) dan MEMVALIDASINYA terhadap
 * `privacy_level_options` akun sebelum unggahan apa pun — level
 * yang tidak diizinkan akun gagal sebagai
 * `tiktok_privacy_option_mismatch`, bukan diturunkan diam-diam.
 * Postingan yang selesai pada mode `SELF_ONLY` memang hanya terlihat
 * oleh kreator sendiri; ia tercatat terbit (provider menerimanya
 * dan menyelesaikannya) tetapi TIDAK PERNAH diklaim publik di sini —
 * menaikkan level privasi adalah tindakan pemilik setelah audit
 * lolos (lihat OWNER-ACTIONS).
 *
 * FOTO MEMAKAI URL PUBLIK DOMAIN TERVERIFIKASI (fakta platform):
 * foto hanya menerima `PULL_FROM_URL` — tidak ada jalur unggah
 * biner seperti video — dan URL-nya harus berada pada domain yang
 * kepemilikannya diverifikasi pemilik aplikasi di portal TikTok
 * for Developers; tanpa itu init menjawab
 * `url_ownership_unverified` (dipetakan `tiktok_url_unverified`).
 * Pemanggil (adapter worker) menyelesaikan URL dari resolver media
 * publik repo (Panel Admin → env → null) dan gagal aman SEBELUM
 * memanggil paket ini bila URL tidak tersedia. Batas platform:
 * s/d 35 foto per postingan, format JPEG/WebP, judul foto maks 90
 * rune UTF-16 dan deskripsi maks 4000 rune UTF-16 (panjang string
 * JS dihitung dalam unit UTF-16, jadi pemotongan di pembangun
 * payload persis dengan hitungan TikTok).
 *
 * AUTO MUSIC: post_info foto mengenal parameter resmi
 * `auto_add_music` (hanya DIRECT_POST) — bila true, TikTok
 * menambahkan musik rekomendasi ke postingan foto dan kreator
 * dapat menggantinya kemudian di aplikasi. Pemilik meminta musik
 * otomatis untuk postingan foto, jadi adapter menyalakannya
 * secara bawaan dan hasilnya dicatat di log integrasi; parameter
 * ini tidak dikenal post_info video.
 *
 * KREDENSIAL: access token OAuth TikTok (scope `video.publish`)
 * diserahkan pemanggil per panggilan dari akun channel terenkripsi.
 * Access token TikTok berumur ±24 jam; refresh token berumur lebih
 * lama (±365 hari). Sejak gelombang Semua OAuth, connect Login Kit
 * menyimpan KEDUA token terenkripsi (migrasi 0022) dan worker
 * lifecycle menyegarkan access token via grant `refresh_token`
 * SEBELUM kedaluwarsa (metode OAuth di bawah) — batas lama yang
 * dicatat Gelombang 4 di sini sudah tertutup. Token yang
 * kedaluwarsa/dicabut tetap dipetakan ke `tiktok_unauthorized` agar
 * operator menghubungkan ulang akun (mis. refresh token ikut mati).
 *
 * KEAMANAN: access token TIDAK PERNAH masuk pesan error/log —
 * `TikTokApiError` hanya membawa status HTTP + kode/pesan resmi
 * provider yang dipotong.
 */

export const DEFAULT_TIKTOK_API_BASE = "https://open.tiktokapis.com";

/** Batas judul postingan video TikTok (= caption, karakter). */
export const TIKTOK_TITLE_MAX = 2200;

/** Batas judul postingan FOTO TikTok (rune UTF-16, dokumentasi resmi). */
export const TIKTOK_PHOTO_TITLE_MAX = 90;

/** Batas deskripsi postingan FOTO TikTok (rune UTF-16). */
export const TIKTOK_PHOTO_DESCRIPTION_MAX = 4000;

/** Batas foto per postingan menurut platform (repo membatasi 10 lewat capability). */
export const TIKTOK_PHOTO_MAX_IMAGES = 35;

/** Level privasi yang dikenal Content Posting API. */
export type TikTokPrivacyLevel =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";

export const TIKTOK_PRIVACY_LEVELS: readonly TikTokPrivacyLevel[] = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
];

/**
 * Ukuran potongan unggah FILE_UPLOAD. Aturan TikTok: tiap potongan
 * 5–64 MB; potongan terakhir boleh lebih kecil (dan boleh menyerap
 * sisa kecil — lihat `planTikTokUploadChunks`). Bawaan 10 MB.
 */
export const TIKTOK_CHUNK_SIZE = 10 * 1024 * 1024;
export const TIKTOK_MIN_CHUNK_SIZE = 5 * 1024 * 1024;
export const TIKTOK_MAX_CHUNK_SIZE = 64 * 1024 * 1024;

/** Error TikTok yang aman dicatat: status HTTP + kode/pesan resmi provider. */
export class TikTokApiError extends Error {
  constructor(
    readonly status: number,
    /** Kode error resmi pada envelope TikTok (`error.code`), mis. `access_token_invalid`. */
    readonly providerCode: string,
    readonly description: string,
    /** Alasan `fail_reason` bila status publikasi berakhir FAILED. */
    readonly publishFailReason?: string,
  ) {
    super(`TikTok API ${status}: ${description}`);
    this.name = "TikTokApiError";
  }
}

/**
 * Petakan error ke errorCode postingan yang aman & stabil. Kode
 * envelope TikTok yang tindakannya berbeda bagi operator dibedakan:
 * token kedaluwarsa (hubungkan ulang), scope kurang (consent ulang),
 * batas laju/kuota harian posting, dan privasi yang tidak diizinkan
 * akun (gerbang audit — jangan coba-coba menaikkan level).
 */
export function tiktokErrorCode(err: unknown): string {
  if (!(err instanceof TikTokApiError)) return "tiktok_send_error";
  if (err.publishFailReason !== undefined) return "tiktok_publish_failed";
  if (err.providerCode === "access_token_invalid") return "tiktok_unauthorized";
  if (err.providerCode === "scope_not_authorized") return "tiktok_scope_missing";
  if (
    err.providerCode === "rate_limit_exceeded" ||
    err.providerCode === "spam_risk_too_many_posts" ||
    err.providerCode === "spam_risk_too_many_pending_share"
  ) {
    return "tiktok_rate_limited";
  }
  if (
    err.providerCode ===
    "unaudited_client_can_only_post_to_private_accounts"
  ) {
    return "tiktok_unaudited_private_only";
  }
  if (err.providerCode === "spam_risk_user_banned_from_posting") {
    return "tiktok_posting_restricted";
  }
  if (err.providerCode === "privacy_level_option_mismatch") {
    return "tiktok_privacy_option_mismatch";
  }
  if (err.providerCode === "url_ownership_unverified") {
    return "tiktok_url_unverified";
  }
  if (err.providerCode === "publish_status_timeout") {
    return "tiktok_publish_timeout";
  }
  if (err.status === 0) return "tiktok_network_error";
  if (err.status === 401) return "tiktok_unauthorized";
  if (err.status === 403) return "tiktok_forbidden";
  if (err.status === 429) return "tiktok_rate_limited";
  return `tiktok_http_${err.status}`;
}

export interface TikTokClientOptions {
  /** Base URL API; default https://open.tiktokapis.com. Override hanya untuk uji mock. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Timeout panggilan API (metadata/status); default 15 detik. */
  timeoutMs?: number | undefined;
  /** Timeout PUT potongan video (berkas besar); default 120 detik. */
  uploadTimeoutMs?: number | undefined;
}

/** Hasil grant token Login Kit (exchange code / refresh). */
export interface TikTokOAuthTokenResult {
  accessToken: string;
  /** open_id kreator pemilik token (identitas akun channel). */
  openId: string | null;
  /** Sisa umur access token (detik) dari provider; bawaan TikTok 86400. */
  expiresInSeconds: number | null;
  /** Refresh token BARU (rotasi penuh tiap grant); null bila tak diterbitkan. */
  refreshToken: string | null;
  /** Sisa umur refresh token (detik); bawaan TikTok 31536000. */
  refreshExpiresInSeconds: number | null;
  /** Scope yang benar-benar diberikan (string koma dari provider). */
  scope: string | null;
}

/** Profil kreator pemilik token (`GET /v2/user/info/`). */
export interface TikTokUserInfo {
  openId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface TikTokCreatorInfo {
  creatorUsername: string | null;
  /** Nama tampil kreator dari endpoint posting (`creator_nickname`). */
  creatorNickname: string | null;
  /** URL avatar kreator dari endpoint posting (`creator_avatar_url`). */
  creatorAvatarUrl: string | null;
  /** Level privasi yang diizinkan untuk akun ini SAAT INI. */
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
}

/** Sumber profil TikTok: endpoint profil resmi lebih dulu, info kreator posting sebagai cadangan. */
export type TikTokProfileSource = "user_info" | "creator_info";

/**
 * Profil tampilan TikTok yang sudah dinormalisasi dari salah satu
 * sumber resmi. `creator_info` memakai scope inti penerbitan
 * (`video.publish`), sedangkan `user_info` memerlukan persetujuan
 * produk/scope Login Kit `user.info.basic` secara terpisah.
 */
export interface TikTokProfile {
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  source: TikTokProfileSource;
}

/**
 * Hasil resolusi profil berjenjang. Error dipertahankan per sumber
 * agar pemanggil dapat membedakan penolakan scope Login Kit dari
 * kegagalan biasa tanpa menebak dari profil kosong.
 */
export interface TikTokProfileResolution {
  profile: TikTokProfile | null;
  userInfoError: TikTokApiError | null;
  creatorInfoError: TikTokApiError | null;
}

export type TikTokPublishStatusName =
  | "PROCESSING_DOWNLOAD"
  | "PROCESSING_UPLOAD"
  | "SEND_TO_USER_INBOX"
  | "PUBLISH_COMPLETE"
  | "FAILED"
  | string;

export interface TikTokPublishStatus {
  status: TikTokPublishStatusName;
  failReason: string | null;
  /** Id postingan publik (ejaan field memang dari TikTok: `publicaly_…`). */
  publiclyAvailablePostId: string | null;
}

interface TikTokEnvelope {
  data?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown; log_id?: unknown };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class TikTokClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(options: TikTokClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_TIKTOK_API_BASE).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
  }

  /**
   * Panggilan API ber-envelope: sukses HANYA bila HTTP 2xx DAN
   * `error.code === "ok"` (TikTok menjawab sebagian kegagalan
   * sebagai HTTP 200 ber-envelope error). Token tidak pernah masuk
   * pesan error yang dibangun di sini.
   */
  private async request(
    accessToken: string,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TikTokApiError(0, "", "network_error");
    }
    let envelope: TikTokEnvelope = {};
    try {
      envelope = (await response.json()) as TikTokEnvelope;
    } catch {
      /* body bukan JSON — diperlakukan sebagai error generik di bawah */
    }
    const providerCode =
      typeof envelope.error?.code === "string" ? envelope.error.code : "";
    const providerMessage =
      typeof envelope.error?.message === "string"
        ? envelope.error.message.slice(0, 200)
        : "";
    if (!response.ok || providerCode !== "ok") {
      throw new TikTokApiError(
        response.status,
        providerCode,
        providerMessage || `tiktok_api_error_${response.status}`,
      );
    }
    return envelope.data ?? {};
  }

  // -------------------------------------------------------------------------
  // OAuth Login Kit (gelombang Semua OAuth): token endpoint + user info
  // -------------------------------------------------------------------------

  /**
   * Satu panggilan ke token endpoint Login Kit
   * (`POST /v2/oauth/token/`, form-urlencoded). Berbeda dari API
   * posting di atas, respons token endpoint TIDAK ber-envelope
   * `data/error.code`: sukses adalah JSON datar berisi token, gagal
   * adalah HTTP 4xx dengan `error` + `error_description` resmi.
   * client_secret & token TIDAK PERNAH masuk error yang dibangun.
   */
  private async oauthTokenRequest(
    form: URLSearchParams,
  ): Promise<TikTokOAuthTokenResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v2/oauth/token/`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
    } catch {
      throw new TikTokApiError(0, "", "network_error");
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const accessToken = asString(body.access_token);
    if (!response.ok || !accessToken) {
      const providerCode = asString(body.error) ?? "";
      const description =
        asString(body.error_description)?.slice(0, 200) ??
        `tiktok_oauth_error_${response.status}`;
      throw new TikTokApiError(response.status, providerCode, description);
    }
    return {
      accessToken,
      openId: asString(body.open_id),
      expiresInSeconds: asNumber(body.expires_in),
      refreshToken: asString(body.refresh_token),
      refreshExpiresInSeconds: asNumber(body.refresh_expires_in),
      scope: asString(body.scope),
    };
  }

  /**
   * Tukar authorization code Login Kit → access token (±24 jam) +
   * refresh token (±365 hari) + open_id: grant `authorization_code`
   * dengan redirect_uri yang IDENTIK dengan dialog authorize.
   */
  async exchangeTikTokCode(input: {
    clientKey: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<TikTokOAuthTokenResult> {
    return this.oauthTokenRequest(
      new URLSearchParams({
        client_key: input.clientKey,
        client_secret: input.clientSecret,
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
      }),
    );
  }

  /**
   * Segarkan access token dari refresh token: grant `refresh_token`.
   * TikTok menerbitkan access token BARU dan refresh token BARU
   * (rotasi penuh) — pemanggil wajib menyimpan keduanya. Refresh
   * token yang mati/dicabut dijawab error `refresh_token_invalid`
   * (dipetakan lifecycle ke akun 'error' agar operator menghubungkan
   * ulang — TIDAK ada jalur diam-diam lain).
   */
  async refreshTikTokAccessToken(input: {
    clientKey: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<TikTokOAuthTokenResult> {
    return this.oauthTokenRequest(
      new URLSearchParams({
        client_key: input.clientKey,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
    );
  }

  /**
   * Info kreator pemilik token (`GET /v2/user/info/?fields=…`, scope
   * `user.info.basic`): open_id (identitas akun), username, nama
   * tampil. Respons ber-envelope `data.user` seperti API lain,
   * tetapi metodenya GET — jadi helper ini mem-parse envelope-nya
   * sendiri dengan aturan yang sama (sukses = `error.code` "ok").
   */
  async getTikTokUserInfo(accessToken: string): Promise<TikTokUserInfo> {
    const fields = "open_id,username,display_name,avatar_url";
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/v2/user/info/?fields=${fields}`,
        {
          method: "GET",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
    } catch {
      throw new TikTokApiError(0, "", "network_error");
    }
    let envelope: TikTokEnvelope = {};
    try {
      envelope = (await response.json()) as TikTokEnvelope;
    } catch {
      /* body bukan JSON — error generik di bawah */
    }
    const providerCode =
      typeof envelope.error?.code === "string" ? envelope.error.code : "";
    if (!response.ok || providerCode !== "ok") {
      const providerMessage =
        typeof envelope.error?.message === "string"
          ? envelope.error.message.slice(0, 200)
          : "";
      throw new TikTokApiError(
        response.status,
        providerCode,
        providerMessage || `tiktok_api_error_${response.status}`,
      );
    }
    const user = (envelope.data?.user ?? {}) as Record<string, unknown>;
    const openId = asString(user.open_id);
    if (!openId) {
      throw new TikTokApiError(200, "", "missing_open_id");
    }
    return {
      openId,
      username: asString(user.username),
      displayName: asString(user.display_name),
      avatarUrl: asString(user.avatar_url),
    };
  }

  /**
   * Resolusi profil tampilan berjenjang (DUA sumber resmi):
   * 1. `GET /v2/user/info/` — sumber utama, tetapi bergantung pada
   *    scope/produk Login Kit `user.info.basic` yang persetujuannya
   *    terpisah dari scope penerbitan;
   * 2. `POST /v2/post/publish/creator_info/query/` — cadangan dengan
   *    scope inti `video.publish`; endpoint yang sama mengembalikan
   *    username, nickname, dan avatar kreator.
   *
   * Metode ini tidak melempar untuk kegagalan API kedua sumber:
   * hasil membawa profil (bila salah satu sumber memberi field yang
   * dapat dipakai) serta error masing-masing agar jalur connect
   * dapat tetap fail-soft dan memutuskan banner scope secara jujur.
   */
  async getTikTokProfile(
    accessToken: string,
  ): Promise<TikTokProfileResolution> {
    let userInfoError: TikTokApiError | null = null;
    try {
      const info = await this.getTikTokUserInfo(accessToken);
      return {
        profile: {
          username: info.username,
          displayName: info.displayName,
          avatarUrl: info.avatarUrl,
          source: "user_info",
        },
        userInfoError: null,
        creatorInfoError: null,
      };
    } catch (err) {
      userInfoError =
        err instanceof TikTokApiError
          ? err
          : new TikTokApiError(0, "", "non_api_error");
    }

    try {
      const creator = await this.queryCreatorInfo(accessToken);
      const profile: TikTokProfile = {
        username: creator.creatorUsername,
        displayName: creator.creatorNickname,
        avatarUrl: creator.creatorAvatarUrl,
        source: "creator_info",
      };
      return {
        profile:
          profile.username || profile.displayName || profile.avatarUrl
            ? profile
            : null,
        userInfoError,
        creatorInfoError: null,
      };
    } catch (err) {
      return {
        profile: null,
        userInfoError,
        creatorInfoError:
          err instanceof TikTokApiError
            ? err
            : new TikTokApiError(0, "", "non_api_error"),
      };
    }
  }

  /** Info kreator — WAJIB dipanggil sebelum init (aturan platform). */
  async queryCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
    const data = await this.request(
      accessToken,
      "/v2/post/publish/creator_info/query/",
      {},
    );
    const options = Array.isArray(data.privacy_level_options)
      ? data.privacy_level_options.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    return {
      creatorUsername: asString(data.creator_username),
      creatorNickname: asString(data.creator_nickname),
      creatorAvatarUrl: asString(data.creator_avatar_url),
      privacyLevelOptions: options,
      commentDisabled: data.comment_disabled === true,
      duetDisabled: data.duet_disabled === true,
      stitchDisabled: data.stitch_disabled === true,
      maxVideoPostDurationSec: asNumber(data.max_video_post_duration_sec),
    };
  }

  /** Buka sesi unggah video; mengembalikan publish_id + upload_url. */
  async initVideoPublish(
    accessToken: string,
    input: {
      postInfo: TikTokVideoPostInfo;
      sourceInfo: TikTokVideoSourceInfo;
    },
  ): Promise<{ publishId: string; uploadUrl: string }> {
    const data = await this.request(
      accessToken,
      "/v2/post/publish/video/init/",
      { post_info: input.postInfo, source_info: input.sourceInfo },
    );
    const publishId = asString(data.publish_id);
    const uploadUrl = asString(data.upload_url);
    if (!publishId || !uploadUrl) {
      throw new TikTokApiError(200, "", "missing_publish_session");
    }
    return { publishId, uploadUrl };
  }

  /**
   * PUT satu potongan video ke `upload_url` bertanda tangan (tanpa
   * Authorization — URL-nya sendiri adalah kredensial unggah).
   * Rentang byte dinyatakan lewat `Content-Range`, sesuai protokol
   * FILE_UPLOAD TikTok.
   */
  async uploadVideoChunk(input: {
    uploadUrl: string;
    data: Uint8Array;
    offset: number;
    totalSize: number;
    contentType: string;
  }): Promise<void> {
    const end = input.offset + input.data.byteLength - 1;
    let response: Response;
    try {
      response = await this.fetchImpl(input.uploadUrl, {
        method: "PUT",
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
        headers: {
          "Content-Type": input.contentType,
          "Content-Length": String(input.data.byteLength),
          "Content-Range": `bytes ${input.offset}-${end}/${input.totalSize}`,
        },
        body: input.data,
      });
    } catch {
      throw new TikTokApiError(0, "", "upload_network_error");
    }
    if (response.status !== 200 && response.status !== 201) {
      throw new TikTokApiError(
        response.status,
        "",
        `upload_http_${response.status}`,
      );
    }
  }

  /** Baca status publikasi satu kali (pemanggil mengatur polling). */
  async fetchPublishStatus(
    accessToken: string,
    publishId: string,
  ): Promise<TikTokPublishStatus> {
    const data = await this.request(
      accessToken,
      "/v2/post/publish/status/fetch/",
      { publish_id: publishId },
    );
    const rawPostId = data.publicaly_available_post_id;
    const postId = Array.isArray(rawPostId)
      ? rawPostId.length > 0
        ? String(rawPostId[0])
        : null
      : rawPostId !== undefined && rawPostId !== null
        ? String(rawPostId)
        : null;
    return {
      status: asString(data.status) ?? "UNKNOWN",
      failReason: asString(data.fail_reason),
      publiclyAvailablePostId: postId,
    };
  }

  /**
   * Publikasi video utuh: creator_info → validasi privasi → init →
   * unggah per potongan → polling status. Mengembalikan publish_id
   * (jejak yang selalu ada) dan id postingan publik bila TikTok
   * menyerahkannya (postingan `SELF_ONLY` tidak punya id publik —
   * pemanggil memakai publish_id sebagai providerMessageId).
   *
   * `SEND_TO_USER_INBOX` diperlakukan terminal-sukses: itu jalur
   * scope `video.upload` (video mendarat sebagai draf di inbox
   * kreator untuk ditinjau), bukan kegagalan — tetapi ia BUKAN
   * terbit publik, dan hasil `finalStatus`-nya diteruskan apa
   * adanya agar lapisan pemanggil mencatatnya dengan jujur.
   */
  async publishVideo(input: {
    accessToken: string;
    title: string;
    privacyLevel: TikTokPrivacyLevel;
    data: Uint8Array;
    contentType: string;
    chunkSize?: number | undefined;
    pollIntervalMs?: number | undefined;
    maxPolls?: number | undefined;
  }): Promise<{
    publishId: string;
    postId: string | null;
    privacyLevel: TikTokPrivacyLevel;
    finalStatus: TikTokPublishStatusName;
  }> {
    const creatorInfo = await this.queryCreatorInfo(input.accessToken);
    const privacyLevel = resolveTikTokPrivacyLevel(
      input.privacyLevel,
      creatorInfo.privacyLevelOptions,
    );
    if (!privacyLevel) {
      throw new TikTokApiError(
        400,
        "privacy_level_option_mismatch",
        `privacy ${input.privacyLevel} not allowed for this creator`,
      );
    }
    const chunks = planTikTokUploadChunks(
      input.data.byteLength,
      input.chunkSize,
    );
    const { publishId, uploadUrl } = await this.initVideoPublish(
      input.accessToken,
      {
        postInfo: buildTikTokVideoPostInfo({
          title: input.title,
          privacyLevel,
          creatorInfo,
        }),
        sourceInfo: {
          source: "FILE_UPLOAD",
          video_size: input.data.byteLength,
          chunk_size: chunks[0]!.length,
          total_chunk_count: chunks.length,
        },
      },
    );
    for (const chunk of chunks) {
      await this.uploadVideoChunk({
        uploadUrl,
        data: input.data.subarray(chunk.offset, chunk.offset + chunk.length),
        offset: chunk.offset,
        totalSize: input.data.byteLength,
        contentType: input.contentType,
      });
    }
    const status = await this.pollPublishStatus(input.accessToken, publishId, {
      pollIntervalMs: input.pollIntervalMs,
      maxPolls: input.maxPolls,
    });
    return {
      publishId,
      postId:
        status.status === "PUBLISH_COMPLETE"
          ? status.publiclyAvailablePostId
          : null,
      privacyLevel,
      finalStatus: status.status,
    };
  }

  /** Buka sesi publikasi foto; mengembalikan publish_id (tanpa upload_url). */
  async initPhotoPublish(
    accessToken: string,
    input: {
      postInfo: TikTokPhotoPostInfo;
      sourceInfo: TikTokPhotoSourceInfo;
    },
  ): Promise<{ publishId: string }> {
    const data = await this.request(
      accessToken,
      "/v2/post/publish/content/init/",
      {
        media_type: "PHOTO",
        post_mode: "DIRECT_POST",
        post_info: input.postInfo,
        source_info: input.sourceInfo,
      },
    );
    const publishId = asString(data.publish_id);
    if (!publishId) {
      throw new TikTokApiError(200, "", "missing_publish_id");
    }
    return { publishId };
  }

  /**
   * Publikasi foto/carousel utuh: creator_info → validasi privasi →
   * init PULL_FROM_URL → polling status. Semantik status terminal
   * sama persis dengan video (lihat `pollPublishStatus`):
   * SEND_TO_USER_INBOX diteruskan apa adanya sebagai finalStatus,
   * bukan diklaim terbit publik.
   *
   * `autoAddMusic` bawaan TRUE (permintaan pemilik): parameter
   * resmi `auto_add_music` pada post_info foto — TikTok
   * menambahkan musik rekomendasi ke postingan foto DIRECT_POST.
   */
  async publishPhotos(input: {
    accessToken: string;
    caption: string;
    privacyLevel: TikTokPrivacyLevel;
    photoUrls: string[];
    autoAddMusic?: boolean | undefined;
    photoCoverIndex?: number | undefined;
    pollIntervalMs?: number | undefined;
    maxPolls?: number | undefined;
  }): Promise<{
    publishId: string;
    postId: string | null;
    privacyLevel: TikTokPrivacyLevel;
    finalStatus: TikTokPublishStatusName;
    autoAddMusic: boolean;
  }> {
    if (
      input.photoUrls.length === 0 ||
      input.photoUrls.length > TIKTOK_PHOTO_MAX_IMAGES
    ) {
      throw new TikTokApiError(
        400,
        "invalid_param",
        `photo_images must contain 1..${TIKTOK_PHOTO_MAX_IMAGES} urls`,
      );
    }
    const autoAddMusic = input.autoAddMusic ?? true;
    const creatorInfo = await this.queryCreatorInfo(input.accessToken);
    const privacyLevel = resolveTikTokPrivacyLevel(
      input.privacyLevel,
      creatorInfo.privacyLevelOptions,
    );
    if (!privacyLevel) {
      throw new TikTokApiError(
        400,
        "privacy_level_option_mismatch",
        `privacy ${input.privacyLevel} not allowed for this creator`,
      );
    }
    const coverIndex = Math.min(
      Math.max(input.photoCoverIndex ?? 0, 0),
      input.photoUrls.length - 1,
    );
    const { publishId } = await this.initPhotoPublish(input.accessToken, {
      postInfo: buildTikTokPhotoPostInfo({
        caption: input.caption,
        privacyLevel,
        creatorInfo,
        autoAddMusic,
      }),
      sourceInfo: {
        source: "PULL_FROM_URL",
        photo_images: [...input.photoUrls],
        photo_cover_index: coverIndex,
      },
    });
    const status = await this.pollPublishStatus(input.accessToken, publishId, {
      pollIntervalMs: input.pollIntervalMs,
      maxPolls: input.maxPolls,
    });
    return {
      publishId,
      postId:
        status.status === "PUBLISH_COMPLETE"
          ? status.publiclyAvailablePostId
          : null,
      privacyLevel,
      finalStatus: status.status,
      autoAddMusic,
    };
  }

  /**
   * Polling status publikasi sampai terminal, dipakai bersama oleh
   * jalur video dan foto (endpoint status/fetch yang sama).
   * Terminal sukses: `PUBLISH_COMPLETE` (terbit) dan
   * `SEND_TO_USER_INBOX` (jalur scope `video.upload` — konten
   * mendarat sebagai draf inbox kreator; BUKAN terbit, dan
   * pemanggil mencatat finalStatus-nya apa adanya). `FAILED`
   * menjadi TikTokApiError dengan fail_reason terbawa; kehabisan
   * anggaran polling menjadi `tiktok_publish_timeout`.
   */
  private async pollPublishStatus(
    accessToken: string,
    publishId: string,
    opts: {
      pollIntervalMs?: number | undefined;
      maxPolls?: number | undefined;
    },
  ): Promise<TikTokPublishStatus> {
    const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    const maxPolls = opts.maxPolls ?? 20;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      if (attempt > 0 && pollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      const status = await this.fetchPublishStatus(accessToken, publishId);
      if (
        status.status === "PUBLISH_COMPLETE" ||
        status.status === "SEND_TO_USER_INBOX"
      ) {
        return status;
      }
      if (status.status === "FAILED") {
        const reason = status.failReason ?? "unknown_fail_reason";
        throw new TikTokApiError(
          200,
          "",
          `publish_failed: ${reason.slice(0, 200)}`,
          reason,
        );
      }
    }
    throw new TikTokApiError(
      0,
      "publish_status_timeout",
      "publish status did not complete within polling budget",
    );
  }
}

// ---------------------------------------------------------------------------
// Pembangun payload & perencana unggah (fungsi murni — diuji tanpa jaringan)
// ---------------------------------------------------------------------------

export interface TikTokVideoPostInfo {
  title: string;
  privacy_level: TikTokPrivacyLevel;
  disable_duet: boolean;
  disable_comment: boolean;
  disable_stitch: boolean;
}

export interface TikTokVideoSourceInfo {
  source: "FILE_UPLOAD";
  video_size: number;
  chunk_size: number;
  total_chunk_count: number;
}

export interface TikTokPhotoPostInfo {
  title: string;
  description: string;
  privacy_level: TikTokPrivacyLevel;
  disable_comment: boolean;
  auto_add_music: boolean;
}

export interface TikTokPhotoSourceInfo {
  source: "PULL_FROM_URL";
  photo_images: string[];
  photo_cover_index: number;
}

/**
 * Rakit `post_info` init foto (murni). Berbeda dari video, foto
 * memisahkan `title` (maks 90 rune UTF-16) dan `description`
 * (maks 4000): caption post mengisi keduanya — judul adalah
 * potongan awal caption, deskripsi caption utuh — supaya satu
 * teks komposer melayani kedua bentuk postingan TikTok tanpa
 * field komposer baru. Pemotongan memakai panjang string JS
 * (unit UTF-16), persis hitungan batas TikTok, dan merupakan
 * pertahanan terakhir di samping capability core (caption maks
 * 2200). Foto tidak mengenal duet/stitch — satu-satunya
 * `disable_*` di post_info foto adalah `disable_comment`, yang
 * meniru pengaturan kreator seperti jalur video.
 * `auto_add_music` diteruskan apa adanya dari keputusan
 * pemanggil (adapter: selalu true, permintaan pemilik).
 */
export function buildTikTokPhotoPostInfo(input: {
  caption: string;
  privacyLevel: TikTokPrivacyLevel;
  creatorInfo: TikTokCreatorInfo;
  autoAddMusic: boolean;
}): TikTokPhotoPostInfo {
  return {
    title: input.caption.slice(0, TIKTOK_PHOTO_TITLE_MAX),
    description: input.caption.slice(0, TIKTOK_PHOTO_DESCRIPTION_MAX),
    privacy_level: input.privacyLevel,
    disable_comment: input.creatorInfo.commentDisabled,
    auto_add_music: input.autoAddMusic,
  };
}

/**
 * Level privasi yang diminta BOLEH dipakai hanya bila akun
 * mencantumkannya di `privacy_level_options` (aturan platform:
 * memeriksa creator_info lebih dulu adalah kewajiban integrator,
 * dan level di luar daftar ditolak API). Mengembalikan null bila
 * tidak diizinkan — pemanggil memetakannya ke
 * `tiktok_privacy_option_mismatch`; TIDAK ada penurunan diam-diam
 * ke level lain, karena privasi adalah janji ke pemilik konten.
 */
export function resolveTikTokPrivacyLevel(
  requested: TikTokPrivacyLevel,
  privacyLevelOptions: readonly string[],
): TikTokPrivacyLevel | null {
  return privacyLevelOptions.includes(requested) ? requested : null;
}

/**
 * Rakit `post_info` init video (murni). Judul postingan TikTok
 * adalah caption post (dipotong 2200 sebagai pertahanan terakhir;
 * batas yang mengikat ditegakkan capability di core). Interaksi
 * yang DIMATIKAN kreator di pengaturan TikTok-nya harus dinyatakan
 * `disable_*` pada post_info — API menolak post yang mencoba
 * mengaktifkan interaksi yang dimatikan kreator — jadi nilai
 * disable di sini meniru persis keadaan kreator, bukan pilihan
 * tenant.
 */
export function buildTikTokVideoPostInfo(input: {
  title: string;
  privacyLevel: TikTokPrivacyLevel;
  creatorInfo: TikTokCreatorInfo;
}): TikTokVideoPostInfo {
  return {
    title: input.title.slice(0, TIKTOK_TITLE_MAX),
    privacy_level: input.privacyLevel,
    disable_duet: input.creatorInfo.duetDisabled,
    disable_comment: input.creatorInfo.commentDisabled,
    disable_stitch: input.creatorInfo.stitchDisabled,
  };
}

export interface TikTokUploadChunk {
  offset: number;
  length: number;
}

/**
 * Rencana potongan FILE_UPLOAD (murni). Aturan ukuran TikTok:
 * potongan 5–64 MB; video di bawah satu potongan diunggah utuh
 * (chunk_size = video_size); sisa ekor yang lebih kecil dari
 * potongan minimum DIGABUNG ke potongan terakhir (mengirim potongan
 * 1–2 MB di akhir ditolak/diabaikan protokol unggahnya) — potongan
 * terakhir hasil gabungan tetap jauh di bawah batas 64 MB.
 */
export function planTikTokUploadChunks(
  videoSize: number,
  chunkSize: number = TIKTOK_CHUNK_SIZE,
): TikTokUploadChunk[] {
  if (!Number.isFinite(videoSize) || videoSize <= 0) {
    throw new TikTokApiError(400, "invalid_param", "video_size must be > 0");
  }
  const size = Math.min(
    Math.max(Math.floor(chunkSize), TIKTOK_MIN_CHUNK_SIZE),
    TIKTOK_MAX_CHUNK_SIZE,
  );
  if (videoSize <= size) return [{ offset: 0, length: videoSize }];
  const fullCount = Math.floor(videoSize / size);
  const remainder = videoSize - fullCount * size;
  const chunks: TikTokUploadChunk[] = [];
  for (let i = 0; i < fullCount; i += 1) {
    chunks.push({ offset: i * size, length: size });
  }
  if (remainder > 0) {
    if (remainder < TIKTOK_MIN_CHUNK_SIZE && chunks.length > 0) {
      chunks[chunks.length - 1]!.length += remainder;
    } else {
      chunks.push({ offset: fullCount * size, length: remainder });
    }
  }
  return chunks;
}
