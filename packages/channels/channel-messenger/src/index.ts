import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_META_API_BASE,
  DEFAULT_META_GRAPH_API_VERSION,
  GraphApiError,
  GraphHttpClient,
  type ChannelAdapter,
  type GraphClientOptions,
  type SendMessageInput,
  type SendMessageResult,
  type StandardEvent,
  type VerifyWebhookInput,
} from "@sahabat-kreator/channel-core";

/**
 * @sahabat-kreator/channel-messenger — adapter Meta (Fase 7A).
 *
 * Paket ini memiliki KLIEN Graph API bersama untuk KEDUA channel Meta
 * kita (Messenger & Instagram): Instagram Messaging lewat Facebook Login
 * berjalan di atas Page yang sama dan Send API yang sama (endpoint
 * `/{account-id}/messages`), jadi satu klien tipis melayani keduanya —
 * perbedaan provider hanya di segmen id akun & objek webhook. Logika DB
 * (kontak/percakapan/pesan/outbox) hidup di @sahabat-kreator/core
 * (`meta.ts`), meniru pembagian kerja Telegram.
 *
 * Versi Graph API TER-PIN v26.0 (RANCANGAN §12.1) — tidak ada panggilan
 * unversioned: versi selalu segmen path pertama sesudah base URL. Nilai
 * pin sumber kebenarannya di @sahabat-kreator/config
 * (`META_GRAPH_API_VERSION`); konstanta di sini adalah default klien dan
 * lapisan API meneruskan nilai config secara eksplisit.
 *
 * KEAMANAN: Page Access Token adalah kredensial penuh. Ia dikirim
 * sebagai header `Authorization: Bearer` — TIDAK PERNAH sebagai query
 * `access_token=` — agar tidak bocor ke log proxy/CDN; pesan error di
 * paket ini juga tidak memuat URL/headers, hanya status HTTP + kode &
 * pesan resmi Graph (yang tidak memuat token).
 */

/**
 * Konstanta base URL & versi Graph kini hidup di @sahabat-kreator/channel-core
 * (Fase 13D) supaya adapter Meta lain memakai nilai yang sama persis.
 * Diekspor ulang di sini agar impor lama tetap bekerja.
 */
export { DEFAULT_META_API_BASE, DEFAULT_META_GRAPH_API_VERSION };

/** Error Graph API yang AMAN dicatat: status HTTP + kode Graph resmi. */
export class MetaGraphError extends GraphApiError {
  constructor(
    status: number,
    graphCode: number | null,
    description: string,
    graphSubcode: number | null = null,
  ) {
    super("Meta Graph API", status, graphCode, description, graphSubcode);
    this.name = "MetaGraphError";
  }
}

export interface MetaGraphClientOptions extends GraphClientOptions {
  /** Page Access Token. */
  accessToken?: string;
}

/** Berkas media utuh di memori untuk unggahan multipart Graph. */
export interface MetaPublishFile {
  data: Uint8Array;
  filename: string;
  contentType: string;
}

/** Profil objek Graph yang dipakai connect (Page / akun IG). */
export interface MetaObjectProfile {
  id: string;
  name: string | null;
  username: string | null;
}

/** Hasil exchange OAuth (Fase 7D): token + sisa umur bila Graph melaporkannya. */
export interface MetaOAuthTokenResult {
  accessToken: string;
  expiresInSeconds: number | null;
}

/** Satu Page dari /me/accounts beserta Page Access Token turunannya (Fase 7D). */
export interface MetaManagedPage {
  id: string;
  name: string | null;
  username: string | null;
  accessToken: string;
  /** Akun IG Professional terhubung ke Page ini — info pemilih saja. */
  linkedIg: { id: string; username: string | null } | null;
}

/**
 * Satu baris jejak penemuan aset (Fase 7D.3): tiap edge Graph yang
 * dicoba rantai penemuan meninggalkan label + jumlah hasil mentahnya,
 * atau kelas error AMAN bila edge gagal (`graph_<kode>` /
 * `http_<status>` / `network` / `unknown` — pesan resmi Graph dan
 * token tidak pernah masuk jejak). Lapisan route menulis seluruh jejak
 * sebagai satu baris log `[meta-oauth] discovery ...` agar kegagalan
 * penemuan live terdiagnosis per edge dari log saja.
 */
export interface MetaDiscoveryTraceEntry {
  label: string;
  count: number;
  error: string | null;
}

/** Kelas error aman untuk jejak penemuan (lihat MetaDiscoveryTraceEntry). */
function discoveryErrorClass(err: unknown): string {
  if (err instanceof MetaGraphError) {
    if (err.status === 0) return "network";
    return err.graphCode !== null ? `graph_${err.graphCode}` : `http_${err.status}`;
  }
  return "unknown";
}

/**
 * Kandidat akun IG hasil rantai penemuan (Fase 7D.3). Kandidat yang
 * ditemukan LEWAT sebuah Page (tepi accounts/per-Page) membawa Page
 * Access Token Page itu — saat complete, token itulah yang disimpan
 * (semantik yang sama seperti connect manual IG via Page 7A); kandidat
 * dari tepi lain memakai token alur (SUAT Unified Login).
 */
export interface MetaInstagramCandidate {
  id: string;
  username: string | null;
  pageAccessToken: string | null;
}

/**
 * Target hibah token hasil `debug_token` (fase penemuan SU): union
 * `target_ids` dari `granular_scopes` token yang diperiksa, dipisah
 * menurut keluarganya. `instagramTargetIds` = akun IG yang SECARA
 * EKSPLISIT dihibahkan konfigurasi Login untuk Bisnis kepada token —
 * satu-satunya sumber kebenaran yang tersisa bila token System User
 * tidak memegang penugasan aset portofolio (kasus BISU satu
 * portofolio: tepi assigned_* kosong & /me/businesses graph_100
 * secara desain). `businessTargetIds` = target business_management,
 * disimpan sebagai cek silang portofolio (tidak dipakai rantai
 * sebagai sumber kandidat). `error` = kelas error aman bila
 * debug_token gagal; pemanggil memperlakukannya best-effort persis
 * seperti tepi penemuan lain. ID target TIDAK PERNAH masuk log —
 * hanya JUMLAHNYA yang boleh dicatat lapisan route.
 */
export interface MetaTokenGrantTargets {
  instagramTargetIds: string[];
  businessTargetIds: string[];
  error: string | null;
}

/**
 * Konteks System User untuk rantai penemuan Instagram (fase penemuan
 * SU): diisi lapisan route dari probe `getTokenProfile` + konfigurasi
 * aplikasi. Tepi bisnis-jangkar (e) & target-hibah (f) HANYA berjalan
 * bila `clientBusinessId` terisi — token user klasik tidak
 * menyentuhnya sama sekali (perilaku & jejak identik seperti
 * sebelumnya). `grantTargetCount` adalah kanal keluar gaya trace:
 * rantai mengisinya dengan jumlah target IG dari debug_token agar
 * lapisan route bisa mencatat `grants=<n>` di baris log penemuan
 * (hitung saja — id target tidak pernah keluar dari klien).
 */
export interface MetaInstagramDiscoveryContext {
  clientBusinessId: string | null;
  appId: string | null;
  appSecret: string | null;
  grantTargetCount: number;
}

/** Kandidat Page dari rantai daftar Page (token bisa belum terisi). */
export interface MetaPageCandidate {
  id: string;
  name: string | null;
  username: string | null;
  accessToken: string | null;
  linkedIg: { id: string; username: string | null } | null;
}

/** Satu nomor telepon di bawah WABA (Fase 7D, penemuan Embedded Signup). */
export interface MetaWabaPhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}

/**
 * Klien Graph API tipis di atas fetch. Satu instance per token.
 * Plumbing HTTP (header Bearer, parse error, GET/POST JSON, timeout)
 * diwarisi dari `GraphHttpClient` di channel-core (Fase 13D); kelas ini
 * hanya memetakan kegagalan ke `MetaGraphError`.
 */
export class MetaGraphClient extends GraphHttpClient {
  constructor(options: MetaGraphClientOptions = {}) {
    super(options);
  }

  protected createError(
    status: number,
    graphCode: number | null,
    description: string,
    graphSubcode: number | null,
  ): MetaGraphError {
    return new MetaGraphError(status, graphCode, description, graphSubcode);
  }

  /**
   * Profil sebuah objek Graph (`GET /{id}?fields=name,username`) —
   * memvalidasi token + mengambil nama/handle publik saat connect.
   * Token yang ditolak Graph (HTTP 4xx berkode) melempar MetaGraphError.
   */
  async getObjectProfile(id: string): Promise<MetaObjectProfile> {
    const body = await this.getJson<{
      id?: string;
      name?: string;
      username?: string;
    }>(`${encodeURIComponent(id)}?fields=name,username`);
    return {
      id: typeof body.id === "string" ? body.id : id,
      name: typeof body.name === "string" ? body.name : null,
      username: typeof body.username === "string" ? body.username : null,
    };
  }

  /**
   * Profil ringkas akun IG (`GET /{ig-id}?fields=id,username`) — bentuk
   * validasi connect manual Instagram varian System User Token (Fase
   * 7D.3): SUAT memvalidasi akun IG-nya langsung, tanpa perantara Page,
   * jadi field yang diminta persis id + username (username menjadi
   * handle publik akun). Token yang ditolak Graph melempar
   * MetaGraphError seperti getObjectProfile.
   */
  async getInstagramAccountProfile(
    id: string,
  ): Promise<{ id: string; username: string | null }> {
    const body = await this.getJson<{
      id?: string;
      username?: string;
    }>(`${encodeURIComponent(id)}?fields=id,username`);
    return {
      id: typeof body.id === "string" ? body.id : id,
      username: typeof body.username === "string" ? body.username : null,
    };
  }

  /**
   * Foto profil Page (`GET /{id}/picture?type=large`): Graph menjawab
   * redirect ke CDN atau langsung byte gambar. Mengembalikan byte +
   * content-type, atau null bila tidak ada gambar (404). Catatan jujur:
   * untuk Page yang belum memasang foto, Graph bisa mengembalikan
   * gambar siluet bawaan Meta — dari sisi API itu tak terbedakan dari
   * foto asli.
   *
   * PERMUKAAN INI HANYA UNTUK PAGE. Untuk akun IG endpoint /picture
   * TIDAK bekerja di graph.facebook.com (Hotfix R1 — terbukti live
   * 2026-11-03: connect IG user berhasil tetapi pengambilan foto lewat
   * /picture selalu gagal dan akun tersimpan tanpa avatar); akun IG
   * memakai `getInstagramProfilePicture` di bawah.
   */
  async getAccountPicture(
    id: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/${this.apiVersion}/${encodeURIComponent(id)}/picture?type=large`,
        {
          method: "GET",
          headers: this.headers(),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new MetaGraphError(0, null, "network_error");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw await this.parseError(response);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) return null;
    return {
      data,
      contentType:
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        "image/jpeg",
    };
  }

  /**
   * Foto profil akun IG (`GET /{ig-id}?fields=profile_picture_url`
   * lalu unduh byte dari URL CDN-nya) — permukaan yang benar untuk
   * akun Instagram di graph.facebook.com (Hotfix R1; pola yang sama
   * seperti foto profil bisnis WhatsApp). Field ini tersedia pada node
   * akun IG untuk token Page maupun SUAT dengan izin instagram_basic.
   * Mengembalikan byte + content-type, atau null bila akun tidak
   * memasang foto / URL kosong / unduhan kosong. Penolakan Graph pada
   * pembacaan field melempar MetaGraphError seperti getAccountPicture
   * — pemanggil memperlakukannya best-effort (koneksi tidak pernah
   * gagal karena foto). URL CDN bertanda tangan diunduh TANPA header
   * Authorization (beda host; token tidak boleh bocor ke CDN).
   */
  async getInstagramProfilePicture(
    igUserId: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    const body = await this.getJson<{ profile_picture_url?: string }>(
      `${encodeURIComponent(igUserId)}?fields=profile_picture_url`,
    );
    const url =
      typeof body.profile_picture_url === "string" && body.profile_picture_url
        ? body.profile_picture_url
        : null;
    if (!url) return null;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MetaGraphError(0, null, "network_error");
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new MetaGraphError(response.status, null, "picture_download_failed");
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) return null;
    return {
      data,
      contentType:
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        "image/jpeg",
    };
  }

  /**
   * Foto profil akun channel Meta sesuai provider-nya (Hotfix R1):
   * Messenger memakai tepi /picture milik Page; Instagram memakai
   * field profile_picture_url milik akun IG. Satu titik dispatch agar
   * jalur connect (manual/OAuth/SUAT) dan backfill daftar tidak bisa
   * tertukar permukaan lagi.
   */
  async getChannelProfilePicture(
    provider: "messenger" | "instagram",
    externalId: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    return provider === "instagram"
      ? this.getInstagramProfilePicture(externalId)
      : this.getAccountPicture(externalId);
  }

  // -------------------------------------------------------------------------
  // OAuth & penemuan aset (Fase 7D) — "Lanjutkan dengan Facebook".
  // Bentuk panggilan mengikuti dokumentasi resmi Meta yang terverifikasi:
  // - "Manually Build a Login Flow" + "Get Long-Lived Tokens" (Messenger):
  //   code → user token → fb_exchange_token → long-lived → /me/accounts.
  // - Instagram API with Unified Login (get-started + authentication):
  //   exchange DENGAN redirect_uri yang identik dengan dialog (Hotfix
  //   7D.2 — asumsi awal "tanpa redirect_uri" gugur oleh bukti live:
  //   Graph menolak code dengan error 100 bila redirect_uri absen)
  //   menghasilkan Business Integration System User Access Token (SUAT);
  //   aset dari RANTAI penemuan multi-tepi (Fase 7D.3:
  //   discoverInstagramAccounts — assigned + IG-di-Page + IG-portofolio
  //   + per-Page; konteks portfolio dari probe /me?fields=
  //   client_business_id). Satu tepi saja terbukti tidak cukup: dialog
  //   tampaknya menyerahkan Page sebagai aset dan IG menumpang padanya,
  //   dan akun aset portofolio tanpa Page hanya terlihat dari tepi
  //   businesses.
  // - WhatsApp Embedded Signup (advanced implementation): exchange yang
  //   sama menghasilkan token bisnis; WABA ter-assign ditemukan dari
  //   token, nomor-nomornya dari tepi phone_numbers WABA.
  // client_secret memang parameter query pada endpoint oauth/access_token
  // (pola resmi Meta); ia tidak pernah masuk log/error paket ini.
  // -------------------------------------------------------------------------

  /**
   * Tukar authorization `code` → access token:
   * `GET /oauth/access_token?client_id&client_secret&code[&redirect_uri]`.
   * `redirectUri` WAJIB disertakan bila dialog yang menerbitkan code
   * dibangun dengan `redirect_uri` — dan dialog ketiga provider kita
   * memang dibangun begitu (Hotfix 7D.2: asumsi awal bahwa alur
   * berbasis konfigurasi menukarnya TANPA redirect_uri GUGUR oleh bukti
   * live — Graph menolak dengan error 100 "Error validating
   * verification code"). Ketiga cabang routes OAuth kini selalu
   * meneruskan redirectUri callback yang identik.
   */
  async exchangeOAuthCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri?: string;
  }): Promise<MetaOAuthTokenResult> {
    const params: Record<string, string> = {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
    };
    if (input.redirectUri) params.redirect_uri = input.redirectUri;
    const body = await this.getJsonParams<{
      access_token?: string;
      expires_in?: number;
    }>("oauth/access_token", params);
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new MetaGraphError(200, null, "missing_access_token");
    }
    return {
      accessToken: body.access_token,
      expiresInSeconds:
        typeof body.expires_in === "number" ? body.expires_in : null,
    };
  }

  /**
   * Tukar user token berumur pendek → long-lived (±60 hari):
   * `GET /oauth/access_token?grant_type=fb_exchange_token&...`.
   * Page Access Token yang diturunkan dari token long-lived ini ikut
   * berumur panjang — dasar connect Messenger Fase 7D.
   */
  async exchangeLongLivedToken(input: {
    clientId: string;
    clientSecret: string;
    shortLivedToken: string;
  }): Promise<MetaOAuthTokenResult> {
    const body = await this.getJsonParams<{
      access_token?: string;
      expires_in?: number;
    }>("oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      fb_exchange_token: input.shortLivedToken,
    });
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new MetaGraphError(200, null, "missing_access_token");
    }
    return {
      accessToken: body.access_token,
      expiresInSeconds:
        typeof body.expires_in === "number" ? body.expires_in : null,
    };
  }

  /**
   * Refresh token System User / bisnis ber-kedaluwarsa (lifecycle 0010):
   * `GET /refresh_access_token?grant_type=tbft&client_id=…&client_secret=…`
   * dengan token LAMA sebagai Bearer header (docs Meta "Refresh a System
   * User access token" — grant `tbft`, token baru berlaku ±60 hari).
   * Token TIDAK PERNAH dikirim sebagai query `access_token=` (kebijakan
   * keamanan paket ini). Melempar MetaGraphError pada penolakan Graph —
   * code 190 berarti token sudah mati (harus hubungkan ulang).
   */
  async refreshSystemUserToken(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<MetaOAuthTokenResult> {
    const body = await this.getJsonParams<{
      access_token?: string;
      expires_in?: number;
    }>("refresh_access_token", {
      grant_type: "tbft",
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new MetaGraphError(200, null, "missing_access_token");
    }
    return {
      accessToken: body.access_token,
      expiresInSeconds:
        typeof body.expires_in === "number" ? body.expires_in : null,
    };
  }

  /**
   * Probe profil token (`GET /me?fields=id,client_business_id`) —
   * Fase 7D.3: `client_business_id` yang terisi menandai token System
   * User (Business Integration System User dari Unified Login / SUAT
   * eksplisit); token user klasik tidak memilikinya. Lapisan route
   * memakainya untuk pesan kegagalan penemuan yang spesifik. Melempar
   * MetaGraphError pada penolakan Graph — pemanggil memperlakukannya
   * best-effort.
   */
  async getTokenProfile(): Promise<{
    id: string | null;
    clientBusinessId: string | null;
  }> {
    const body = await this.getJsonParams<{
      id?: string;
      client_business_id?: string;
    }>("me", { fields: "id,client_business_id" });
    return {
      id: typeof body.id === "string" ? body.id : null,
      clientBusinessId:
        typeof body.client_business_id === "string"
          ? body.client_business_id
          : null,
    };
  }

  /**
   * ID portfolio bisnis klien pemilik token (`GET
   * /me?fields=client_business_id`) — disimpan sebagai konteks induk
   * akun IG (parent_external_id) untuk manajemen token kelak.
   */
  async getClientBusinessId(): Promise<string | null> {
    return (await this.getTokenProfile()).clientBusinessId;
  }

  /**
   * Target hibah token ini sendiri (`GET /debug_token?input_token=…`)
   * — fase penemuan SU. Panggilan diautentikasi TOKEN APLIKASI
   * (`{appId}|{appSecret}`) lewat klien pendamping bertoken aplikasi
   * yang berbagi base URL/versi/fetch/timeout dengan klien ini —
   * pola resmi Meta untuk debug_token; token yang diperiksa hanya
   * menjadi `input_token`, tidak pernah menjadi kredensial panggilan
   * lain dan tidak pernah dicatat. Yang dibaca hanya
   * `data.granular_scopes`: union `target_ids` untuk keluarga
   * instagram_basic / instagram_manage_messages /
   * instagram_manage_comments (akun IG yang dihibahkan konfigurasi
   * ke token) + business_management (cek silang portofolio).
   * BEST-EFFORT TOTAL: kegagalan apa pun (Graph menolak, jaringan,
   * bentuk respons asing) menghasilkan daftar kosong + kelas error
   * aman di `error` — TIDAK PERNAH melempar ke pemanggil, karena
   * penemuan tidak boleh mati oleh panggilan diagnostik.
   */
  async getTokenGrantTargets(input: {
    appId: string;
    appSecret: string;
  }): Promise<MetaTokenGrantTargets> {
    const empty: MetaTokenGrantTargets = {
      instagramTargetIds: [],
      businessTargetIds: [],
      error: null,
    };
    const inspected = this.accessToken;
    if (!inspected) return { ...empty, error: "unknown" };
    try {
      const appClient = new MetaGraphClient({
        baseUrl: this.baseUrl,
        apiVersion: this.apiVersion,
        accessToken: `${input.appId}|${input.appSecret}`,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
      });
      const body = await appClient.getJsonParams<{
        data?: {
          granular_scopes?: Array<{
            scope?: string;
            target_ids?: Array<string>;
          }>;
        };
      }>("debug_token", { input_token: inspected });
      const instagramScopes = new Set([
        "instagram_basic",
        "instagram_manage_messages",
        "instagram_manage_comments",
      ]);
      const instagramIds = new Set<string>();
      const businessIds = new Set<string>();
      for (const grant of body.data?.granular_scopes ?? []) {
        const targets = (grant.target_ids ?? []).filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        if (typeof grant.scope === "string" && instagramScopes.has(grant.scope)) {
          for (const id of targets) instagramIds.add(id);
        } else if (grant.scope === "business_management") {
          for (const id of targets) businessIds.add(id);
        }
      }
      return {
        instagramTargetIds: [...instagramIds],
        businessTargetIds: [...businessIds],
        error: null,
      };
    } catch (err) {
      return { ...empty, error: discoveryErrorClass(err) };
    }
  }

  /**
   * Akun IG milik SATU portofolio bisnis (`GET
   * /{business-id}/instagram_accounts?fields=id,username`) — fase
   * penemuan SU: tepi berjangkar-bisnis untuk akun yang merupakan
   * aset portofolio tetapi TIDAK tertaut Page dan TIDAK terlihat dari
   * /me milik System User (identitas SU memang tidak memegang daftar
   * itu). Bila tepi utama ditolak `graph_100` (bentuk error identitas
   * SU yang sama seperti /me/businesses), jatuh ke gabungan
   * `owned_instagram_accounts` + `client_instagram_accounts` pada
   * node yang sama — pola union multi-tepi yang sama seperti
   * `listPageCandidates`: masing-masing best-effort selama salah satu
   * berhasil; error pertama dilempar hanya bila keduanya juga gagal
   * agar jejak rantai mencatat kelas yang benar. Error non-100 pada
   * tepi utama dilempar apa adanya.
   */
  async getBusinessInstagramAccounts(
    businessId: string,
  ): Promise<Array<{ id: string; username: string | null }>> {
    const node = encodeURIComponent(businessId);
    const parse = (body: {
      data?: Array<{ id?: string; username?: string }>;
    }): Array<{ id: string; username: string | null }> => {
      const accounts: Array<{ id: string; username: string | null }> = [];
      for (const row of body.data ?? []) {
        if (typeof row.id !== "string" || !row.id) continue;
        accounts.push({
          id: row.id,
          username: typeof row.username === "string" ? row.username : null,
        });
      }
      return accounts;
    };
    const fetchEdge = async (
      edge: string,
    ): Promise<Array<{ id: string; username: string | null }>> =>
      parse(
        await this.getJsonParams<{
          data?: Array<{ id?: string; username?: string }>;
        }>(`${node}/${edge}`, { fields: "id,username", limit: "100" }),
      );
    try {
      return await fetchEdge("instagram_accounts");
    } catch (err) {
      if (!(err instanceof MetaGraphError) || err.graphCode !== 100) {
        throw err;
      }
      // graph_100 pada tepi utama → union dua tepi turunan.
      const byId = new Map<string, { id: string; username: string | null }>();
      let firstError: unknown = null;
      let anySuccess = false;
      for (const edge of [
        "owned_instagram_accounts",
        "client_instagram_accounts",
      ]) {
        try {
          const rows = await fetchEdge(edge);
          anySuccess = true;
          for (const row of rows) {
            if (!byId.has(row.id)) byId.set(row.id, row);
          }
        } catch (edgeErr) {
          if (firstError === null) firstError = edgeErr;
        }
      }
      if (!anySuccess) throw firstError ?? err;
      return [...byId.values()];
    }
  }

  /**
   * Akun IG yang dibagikan klien ke aplikasi (`GET
   * /me/assigned_instagram_accounts?fields=id,username`) — klien dibangun
   * dengan SUAT Unified Login. Satu SUAT bisa mencakup banyak akun.
   */
  async getAssignedInstagramAccounts(): Promise<
    Array<{ id: string; username: string | null }>
  > {
    const body = await this.getJsonParams<{
      data?: Array<{ id?: string; username?: string }>;
    }>("me/assigned_instagram_accounts", { fields: "id,username", limit: "100" });
    const accounts: Array<{ id: string; username: string | null }> = [];
    for (const row of body.data ?? []) {
      if (typeof row.id !== "string" || !row.id) continue;
      accounts.push({
        id: row.id,
        username: typeof row.username === "string" ? row.username : null,
      });
    }
    return accounts;
  }

  /**
   * Rantai daftar Page terkelola (Fase 7D.3) — dipakai penemuan
   * Messenger DAN tepi per-Page penemuan Instagram:
   *   1. `GET /me/accounts?fields=id,name,username,access_token,
   *      instagram_business_account{id,username}` (Page + tokennya)
   *   2. `GET /me/assigned_pages?fields=id,name` (Page ter-assign yang
   *      tidak muncul di /me/accounts untuk token bisnis)
   *   3. `GET /me/businesses?fields=id,name,owned_pages{id,name},
   *      client_pages{id,name}` (Page milik/terhubung portofolio)
   * Dedupe by Page ID — kemunculan pertama menang, jadi hasil
   * /me/accounts untuk token user klasik TIDAK berubah (rantai hanya
   * MENAMBAH Page yang belum terlihat). Page tanpa token diisi
   * best-effort lewat `GET /{page-id}?fields=...,access_token,...`
   * (respons yang sama sekaligus mengisi username & akun IG tertaut).
   * Setiap tepi dicatat ke `trace` bila diberikan; kegagalan satu tepi
   * tidak menggagalkan tepi lain. Mengembalikan SEMUA kandidat
   * (termasuk yang tokennya tetap kosong — pemanggil memutuskan).
   */
  async listPageCandidates(
    trace?: MetaDiscoveryTraceEntry[],
  ): Promise<MetaPageCandidate[]> {
    const byId = new Map<string, MetaPageCandidate>();
    const addPage = (page: MetaPageCandidate) => {
      const existing = byId.get(page.id);
      if (!existing) {
        byId.set(page.id, page);
        return;
      }
      // Kemunculan pertama menang untuk identitas; field yang masih
      // kosong boleh diisi kemunculan berikutnya.
      if (!existing.accessToken && page.accessToken) {
        existing.accessToken = page.accessToken;
      }
      if (!existing.username && page.username) existing.username = page.username;
      if (!existing.name && page.name) existing.name = page.name;
      if (!existing.linkedIg && page.linkedIg) existing.linkedIg = page.linkedIg;
    };
    const note = (
      label: string,
      count: number,
      error: string | null,
    ): void => {
      trace?.push({ label, count, error });
    };

    // Tepi 1 — /me/accounts (Page yang dikelola langsung + tokennya).
    try {
      const body = await this.getJsonParams<{
        data?: Array<{
          id?: string;
          name?: string;
          username?: string;
          access_token?: string;
          instagram_business_account?: { id?: string; username?: string };
        }>;
      }>("me/accounts", {
        fields:
          "id,name,username,access_token,instagram_business_account{id,username}",
        limit: "100",
      });
      let count = 0;
      for (const row of body.data ?? []) {
        if (typeof row.id !== "string" || !row.id) continue;
        count += 1;
        addPage({
          id: row.id,
          name: typeof row.name === "string" ? row.name : null,
          username: typeof row.username === "string" ? row.username : null,
          accessToken:
            typeof row.access_token === "string" && row.access_token
              ? row.access_token
              : null,
          linkedIg:
            typeof row.instagram_business_account?.id === "string"
              ? {
                  id: row.instagram_business_account.id,
                  username:
                    typeof row.instagram_business_account.username === "string"
                      ? row.instagram_business_account.username
                      : null,
                }
              : null,
        });
      }
      note("pages_accounts", count, null);
    } catch (err) {
      note("pages_accounts", 0, discoveryErrorClass(err));
    }

    // Tepi 2 — /me/assigned_pages (tanpa token; diisi di langkah isi).
    try {
      const body = await this.getJsonParams<{
        data?: Array<{ id?: string; name?: string }>;
      }>("me/assigned_pages", { fields: "id,name", limit: "100" });
      let count = 0;
      for (const row of body.data ?? []) {
        if (typeof row.id !== "string" || !row.id) continue;
        count += 1;
        addPage({
          id: row.id,
          name: typeof row.name === "string" ? row.name : null,
          username: null,
          accessToken: null,
          linkedIg: null,
        });
      }
      note("pages_assigned_pages", count, null);
    } catch (err) {
      note("pages_assigned_pages", 0, discoveryErrorClass(err));
    }

    // Tepi 3 — Page dari portofolio bisnis yang terlihat token.
    try {
      const body = await this.getJsonParams<{
        data?: Array<{
          owned_pages?: { data?: Array<{ id?: string; name?: string }> };
          client_pages?: { data?: Array<{ id?: string; name?: string }> };
        }>;
      }>("me/businesses", {
        fields: "id,name,owned_pages{id,name},client_pages{id,name}",
        limit: "100",
      });
      let count = 0;
      for (const business of body.data ?? []) {
        for (const group of [business.owned_pages, business.client_pages]) {
          for (const row of group?.data ?? []) {
            if (typeof row.id !== "string" || !row.id) continue;
            count += 1;
            addPage({
              id: row.id,
              name: typeof row.name === "string" ? row.name : null,
              username: null,
              accessToken: null,
              linkedIg: null,
            });
          }
        }
      }
      note("pages_businesses", count, null);
    } catch (err) {
      note("pages_businesses", 0, discoveryErrorClass(err));
    }

    // Isi token Page yang masih kosong (best-effort per Page) — respons
    // tepi objek Page sekaligus membawa username + akun IG tertaut.
    let filled = 0;
    for (const page of byId.values()) {
      if (page.accessToken) continue;
      if (filled >= 25) break;
      try {
        const body = await this.getJson<{
          name?: string;
          username?: string;
          access_token?: string;
          instagram_business_account?: { id?: string; username?: string };
        }>(
          `${encodeURIComponent(page.id)}?fields=id,name,username,access_token,instagram_business_account{id,username}`,
        );
        if (typeof body.access_token === "string" && body.access_token) {
          page.accessToken = body.access_token;
          filled += 1;
        }
        if (!page.name && typeof body.name === "string") page.name = body.name;
        if (!page.username && typeof body.username === "string") {
          page.username = body.username;
        }
        if (
          !page.linkedIg &&
          typeof body.instagram_business_account?.id === "string"
        ) {
          page.linkedIg = {
            id: body.instagram_business_account.id,
            username:
              typeof body.instagram_business_account.username === "string"
                ? body.instagram_business_account.username
                : null,
          };
        }
      } catch {
        /* best-effort — Page ini tetap kandidat tanpa token */
      }
    }
    note("pages_backfill", filled, null);

    return [...byId.values()];
  }

  /**
   * Page yang dikelola pemilik token BESERTA Page Access Token-nya —
   * bentuk yang dipakai penemuan Messenger: hasil `listPageCandidates`
   * disaring ke Page bertoken. Untuk token user klasik (alur terbukti
   * live 7D) himpunannya sama seperti /me/accounts lama: Page-Page itu
   * muncul pertama di rantai dan tokennya langsung terisi; rantai hanya
   * menambah Page ter-assign/portofolio yang tokennya berhasil diisi.
   */
  async getManagedPages(
    trace?: MetaDiscoveryTraceEntry[],
  ): Promise<MetaManagedPage[]> {
    const candidates = await this.listPageCandidates(trace);
    const pages: MetaManagedPage[] = [];
    for (const page of candidates) {
      if (!page.accessToken) continue;
      pages.push({
        id: page.id,
        name: page.name,
        username: page.username,
        accessToken: page.accessToken,
        linkedIg: page.linkedIg,
      });
    }
    return pages;
  }

  /**
   * Akun IG tertaut ke SATU Page (`GET
   * /{page-id}?fields=instagram_business_account{id,username}`) —
   * dipanggil dengan token alur; null bila Page tak punya IG tertaut.
   * Melempar MetaGraphError pada penolakan Graph (pemanggil rantai
   * memperlakukannya best-effort per Page).
   */
  async getPageInstagramBusinessAccount(
    pageId: string,
  ): Promise<{ id: string; username: string | null } | null> {
    const body = await this.getJson<{
      instagram_business_account?: { id?: string; username?: string };
    }>(
      `${encodeURIComponent(pageId)}?fields=instagram_business_account{id,username}`,
    );
    const ig = body.instagram_business_account;
    if (typeof ig?.id !== "string" || !ig.id) return null;
    return {
      id: ig.id,
      username: typeof ig.username === "string" ? ig.username : null,
    };
  }

  /**
   * RANTAI PENEMUAN akun IG untuk callback OAuth (Fase 7D.3) — adopsi
   * pendekatan kode referensi yang terbukti menghubungkan IG pemilik:
   * dialog Unified Login pada praktiknya menyerahkan aset lewat
   * BEBERAPA tepi sekaligus, jadi satu tepi saja (pola 7D:
   * /me/assigned_instagram_accounts) tidak cukup. Tepi dicoba
   * berurutan, kandidat digabung & di-dedupe by ID akun IG:
   *   a. `assigned_instagram_accounts` — /me/assigned_instagram_accounts
   *      (jalur SUAT murni).
   *   b. `accounts_instagram_business_account` — /me/accounts dengan
   *      instagram_business_account: IG yang menempel pada Page;
   *      kandidat membawa Page token Page itu. (Dialog Unified
   *      tampaknya menyerahkan PAGE sebagai aset dan IG menumpang
   *      padanya — inilah tepi yang menemukan akun pada kode referensi.)
   *   c. `businesses_instagram_accounts` — /me/businesses dengan
   *      instagram_accounts: IG MILIK portofolio yang terlihat token.
   *      Tepi kritis untuk akun IG yang merupakan aset portofolio dan
   *      TIDAK tertaut ke Page mana pun; tepi ini bisa menolak dengan
   *      error izin (mis. graph_200) bila konfigurasi Login untuk
   *      Bisnis tidak memuat business_management — jejaknya sengaja
   *      terbaca jelas agar lapisan route bisa menyebutkannya di
   *      petunjuk picker.
   *   e. `business_instagram_accounts` — /{client_business_id}/
   *      instagram_accounts (fase penemuan SU; HANYA bila konteks SU
   *      diberikan): akun IG milik portofolio KLIEN yang menjadi
   *      jangkar token, dibaca dari node bisnisnya langsung — bukan
   *      dari /me yang bagi System User memang kosong/galat. Jatuh ke
   *      owned_/client_instagram_accounts pada graph_100.
   *   f. `grant_target_instagram_accounts` — target hibah token dari
   *      debug_token (fase penemuan SU; konteks yang sama): akun yang
   *      SECARA EKSPLISIT dihibahkan konfigurasi ke token ini,
   *      diselesaikan username-nya per akun lewat profil objek
   *      (maks 25 panggilan). Inilah tepi terakhir yang tetap bekerja
   *      pada kasus portofolio-sama (BISU tanpa penugasan aset):
   *      hibah konfigurasi adalah satu-satunya daftar yang ada.
   *   d. `page_instagram_business_account` — per-Page lewat rantai
   *      daftar Page (`listPageCandidates`, dibatasi 10 Page): IG
   *      tertaut tiap Page; kandidat membawa token Page itu bila ada.
   * Dedupe: kandidat yang sama dari banyak tepi menjadi satu; username
   * terisi dari tepi mana pun yang memilikinya; Page token dari tepi
   * mana pun MENANG atas kandidat tanpa token (kredensial Page adalah
   * semantik connect IG yang sudah terbukti). Kegagalan satu tepi
   * dicatat di `trace` dan TIDAK menggagalkan tepi berikutnya.
   */
  async discoverInstagramAccounts(
    trace: MetaDiscoveryTraceEntry[],
    suContext?: MetaInstagramDiscoveryContext | null,
  ): Promise<MetaInstagramCandidate[]> {
    const byId = new Map<string, MetaInstagramCandidate>();
    const addCandidate = (
      id: string,
      username: string | null,
      pageAccessToken: string | null,
    ): void => {
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, { id, username, pageAccessToken });
        return;
      }
      if (!existing.username && username) existing.username = username;
      if (!existing.pageAccessToken && pageAccessToken) {
        existing.pageAccessToken = pageAccessToken;
      }
    };

    // Tepi (a) — assigned_instagram_accounts (jalur SUAT).
    try {
      const accounts = await this.getAssignedInstagramAccounts();
      for (const account of accounts) {
        addCandidate(account.id, account.username, null);
      }
      trace.push({
        label: "assigned_instagram_accounts",
        count: accounts.length,
        error: null,
      });
    } catch (err) {
      trace.push({
        label: "assigned_instagram_accounts",
        count: 0,
        error: discoveryErrorClass(err),
      });
    }

    // Tepi (b) — IG yang menempel pada Page dari /me/accounts.
    try {
      const body = await this.getJsonParams<{
        data?: Array<{
          id?: string;
          access_token?: string;
          instagram_business_account?: { id?: string; username?: string };
        }>;
      }>("me/accounts", {
        fields: "id,access_token,instagram_business_account{id,username}",
        limit: "100",
      });
      let found = 0;
      for (const row of body.data ?? []) {
        const ig = row.instagram_business_account;
        if (typeof ig?.id !== "string" || !ig.id) continue;
        found += 1;
        addCandidate(
          ig.id,
          typeof ig.username === "string" ? ig.username : null,
          typeof row.access_token === "string" && row.access_token
            ? row.access_token
            : null,
        );
      }
      trace.push({
        label: "accounts_instagram_business_account",
        count: found,
        error: null,
      });
    } catch (err) {
      trace.push({
        label: "accounts_instagram_business_account",
        count: 0,
        error: discoveryErrorClass(err),
      });
    }

    // Tepi (c) — IG milik portofolio dari /me/businesses.
    try {
      const body = await this.getJsonParams<{
        data?: Array<{
          instagram_accounts?: {
            data?: Array<{ id?: string; username?: string }>;
          };
        }>;
      }>("me/businesses", {
        fields: "id,instagram_accounts{id,username}",
        limit: "100",
      });
      let found = 0;
      for (const business of body.data ?? []) {
        for (const row of business.instagram_accounts?.data ?? []) {
          if (typeof row.id !== "string" || !row.id) continue;
          found += 1;
          addCandidate(
            row.id,
            typeof row.username === "string" ? row.username : null,
            null,
          );
        }
      }
      trace.push({
        label: "businesses_instagram_accounts",
        count: found,
        error: null,
      });
    } catch (err) {
      trace.push({
        label: "businesses_instagram_accounts",
        count: 0,
        error: discoveryErrorClass(err),
      });
    }

    // Tepi (e) + (f) — penemuan berjangkar portofolio & hibah token
    // (fase penemuan SU). HANYA berjalan bila konteks SU membawa
    // client_business_id; token user klasik tidak menyentuhnya sama
    // sekali (tak ada panggilan, tak ada entri jejak).
    const clientBusinessId = suContext?.clientBusinessId ?? null;
    if (suContext && clientBusinessId) {
      // Tepi (e) — IG milik portofolio klien dari node bisnisnya.
      try {
        const accounts =
          await this.getBusinessInstagramAccounts(clientBusinessId);
        for (const account of accounts) {
          addCandidate(account.id, account.username, null);
        }
        trace.push({
          label: "business_instagram_accounts",
          count: accounts.length,
          error: null,
        });
      } catch (err) {
        trace.push({
          label: "business_instagram_accounts",
          count: 0,
          error: discoveryErrorClass(err),
        });
      }

      // Tepi (f) — target hibah konfigurasi dari debug_token. Jumlah
      // target dicerminkan ke konteks untuk baris log route SEBELUM
      // resolusi profil, karena grants mengukur hibahnya, bukan
      // keberhasilan pengambilan profilnya.
      const grants =
        suContext.appId && suContext.appSecret
          ? await this.getTokenGrantTargets({
              appId: suContext.appId,
              appSecret: suContext.appSecret,
            })
          : { instagramTargetIds: [], businessTargetIds: [], error: null };
      suContext.grantTargetCount = grants.instagramTargetIds.length;
      let grantFound = 0;
      const freshTargets = grants.instagramTargetIds
        .filter((id) => !byId.has(id))
        .slice(0, 25);
      for (const targetId of freshTargets) {
        try {
          const profile = await this.getInstagramAccountProfile(targetId);
          addCandidate(profile.id, profile.username, null);
          grantFound += 1;
        } catch {
          /* best-effort per akun — target lain tetap dicoba */
        }
      }
      trace.push({
        label: "grant_target_instagram_accounts",
        count: grantFound,
        error: grants.error,
      });
    }

    // Tepi (d) — per-Page lewat rantai daftar Page (jejak rantainya
    // sendiri ikut tercatat lebih dulu di trace yang sama).
    try {
      const pages = await this.listPageCandidates(trace);
      let found = 0;
      for (const page of pages.slice(0, 10)) {
        let ig = page.linkedIg;
        if (!ig) {
          ig = await this.getPageInstagramBusinessAccount(page.id).catch(
            () => null,
          );
        }
        if (!ig) continue;
        found += 1;
        addCandidate(ig.id, ig.username, page.accessToken);
      }
      trace.push({
        label: "page_instagram_business_account",
        count: found,
        error: null,
      });
    } catch (err) {
      trace.push({
        label: "page_instagram_business_account",
        count: 0,
        error: discoveryErrorClass(err),
      });
    }

    return [...byId.values()];
  }

  /**
   * WABA yang ter-assign ke pemilik token bisnis Embedded Signup
   * (`GET /me/assigned_whatsapp_business_accounts?fields=id,name`) —
   * pola tepi `assigned_*` yang sama seperti assigned_instagram_accounts
   * pada Unified Login (dokumen advanced implementation "Get WABA IDs
   * and Phone Numbers").
   */
  async getAssignedWhatsAppBusinessAccounts(): Promise<
    Array<{ id: string; name: string | null }>
  > {
    const body = await this.getJsonParams<{
      data?: Array<{ id?: string; name?: string }>;
    }>("me/assigned_whatsapp_business_accounts", {
      fields: "id,name",
      limit: "100",
    });
    const wabas: Array<{ id: string; name: string | null }> = [];
    for (const row of body.data ?? []) {
      if (typeof row.id !== "string" || !row.id) continue;
      wabas.push({
        id: row.id,
        name: typeof row.name === "string" ? row.name : null,
      });
    }
    return wabas;
  }

  /**
   * Nomor telepon di bawah satu WABA (`GET /{waba-id}/phone_numbers`)
   * — field yang sama seperti profil nomor pada connect manual 7B.
   */
  async getWabaPhoneNumbers(
    wabaId: string,
  ): Promise<MetaWabaPhoneNumber[]> {
    const body = await this.getJsonParams<{
      data?: Array<{
        id?: string;
        display_phone_number?: string;
        verified_name?: string;
      }>;
    }>(`${encodeURIComponent(wabaId)}/phone_numbers`, {
      fields: "id,display_phone_number,verified_name",
      limit: "100",
    });
    const numbers: MetaWabaPhoneNumber[] = [];
    for (const row of body.data ?? []) {
      if (typeof row.id !== "string" || !row.id) continue;
      numbers.push({
        id: row.id,
        displayPhoneNumber:
          typeof row.display_phone_number === "string"
            ? row.display_phone_number
            : null,
        verifiedName:
          typeof row.verified_name === "string" ? row.verified_name : null,
      });
    }
    return numbers;
  }

  /**
   * Subscribe aplikasi ke webhook sebuah objek (`POST
   * /{object-id}/subscribed_apps`) — dipakai Page (Messenger), akun IG
   * (Unified Login: "subscribe each of their Instagram accounts"), dan
   * WABA (Embedded Signup webhook-subscription). Kegagalan melempar
   * MetaGraphError; pemanggil (complete OAuth) mengubahnya menjadi
   * peringatan, bukan menggagalkan koneksi.
   */
  async subscribeAppToObject(
    objectId: string,
    subscribedFields?: string[],
  ): Promise<void> {
    const path = subscribedFields?.length
      ? `${encodeURIComponent(objectId)}/subscribed_apps?subscribed_fields=${encodeURIComponent(subscribedFields.join(","))}`
      : `${encodeURIComponent(objectId)}/subscribed_apps`;
    await this.postJson(path, {});
  }

  /**
   * Langganan webhook untuk akun Messenger/Instagram termasuk field
   * KOMENTAR (Fase 10B): messenger meminta `messages,feed` (komentar
   * Page tiba sebagai perubahan feed item comment), instagram meminta
   * `messages,comments`. BEST-EFFORT BERLAPIS: bila permintaan lebar
   * ditolak Graph (mis. izin/langganan field belum tersedia), mundur
   * ke `messages` saja agar koneksi tidak pernah gagal hanya karena
   * field komentar — akun lama yang sudah terhubung mendapat field
   * komentar saat RECONNECT (langganan ulang), bukan otomatis.
   * Melempar hanya bila langganan dasar `messages` pun gagal.
   */
  async subscribeAppToObjectWithComments(
    objectId: string,
    provider: "messenger" | "instagram",
  ): Promise<void> {
    const wide =
      provider === "messenger"
        ? ["messages", "feed"]
        : ["messages", "comments"];
    try {
      await this.subscribeAppToObject(objectId, wide);
    } catch {
      await this.subscribeAppToObject(objectId, ["messages"]);
    }
  }

  /**
   * Kirim pesan teks (Send API): `POST /{accountId}/messages` dengan
   * messaging_type RESPONSE — balasan di dalam jendela 24 jam sejak
   * pesan terakhir pengguna (kebijakan Meta; di luar jendela Graph
   * menolak dan pemanggil menandai pesan failed dengan kode Graph,
   * TANPA retry tanpa henti). `accountId` = Page ID (messenger) atau
   * ID akun IG (instagram) — endpoint yang sama, token Page yang sama.
   *
   * KUTIPAN KELUAR (Fase 7B.5) — KETERBATASAN TERDOKUMENTASI: referensi
   * resmi Send API untuk objek `message` hanya mendokumentasikan
   * `text`, `attachment`, `quick_replies`, dan `metadata` — TIDAK ada
   * parameter balasan-terkutip untuk pengiriman Page/IG; `reply_to`
   * hanya ada di payload WEBHOOK (arah masuk, diparse di bawah).
   * Karena itu metode ini SENGAJA tidak menerima parameter kutipan:
   * tautan kutipan tetap tersimpan di baris pesan kita dan tampil
   * sebagai blok kutipan di inbox, tetapi balasan terkirim ke pengguna
   * Messenger/IG sebagai pesan biasa tanpa kutipan native. Jangan
   * menambahkan field tak terdokumentasi ke body ini — risikonya
   * penolakan Graph pada pesan yang seharusnya terkirim polos.
   */
  async sendMessage(input: {
    accountExternalId: string;
    recipientExternalId: string;
    text: string;
    /**
     * Fase 10B — private reply: bila terisi, pesan dikirim ke PENULIS
     * komentar ini lewat `recipient: { comment_id }` (satu-satunya cara
     * Send API membuka DM ke orang yang belum pernah mengirim pesan;
     * sesudah ia membalas, percakapan berlanjut sebagai DM biasa).
     * `recipientExternalId` diabaikan dalam mode ini. Private reply
     * TIDAK memakai messaging_type (bentuk terdokumentasi Meta untuk
     * balasan privat atas komentar).
     */
    recipientCommentId?: string | null;
  }): Promise<{ providerMessageId: string }> {
    const body = await this.postJson<{ message_id?: string }>(
      `${encodeURIComponent(input.accountExternalId)}/messages`,
      input.recipientCommentId
        ? {
            recipient: { comment_id: input.recipientCommentId },
            message: { text: input.text },
          }
        : {
            recipient: { id: input.recipientExternalId },
            messaging_type: "RESPONSE",
            message: { text: input.text },
          },
    );
    if (typeof body.message_id !== "string" || !body.message_id) {
      throw new MetaGraphError(200, null, "missing_message_id");
    }
    return { providerMessageId: body.message_id };
  }

  /**
   * Balasan PUBLIK pada sebuah komentar (Fase 10B):
   * - Instagram: `POST /{comment-id}/replies` body { message }.
   * - Messenger/Page: `POST /{comment-id}/comments` body { message }.
   * Mengembalikan id balasan bila Meta menyertakannya.
   */
  async replyToComment(input: {
    provider: "instagram" | "messenger";
    commentId: string;
    text: string;
  }): Promise<{ replyId: string | null }> {
    const edge = input.provider === "instagram" ? "replies" : "comments";
    const body = await this.postJson<{ id?: string }>(
      `${encodeURIComponent(input.commentId)}/${edge}`,
      { message: input.text },
    );
    return { replyId: typeof body.id === "string" && body.id ? body.id : null };
  }

  /**
   * Sembunyikan / tampilkan komentar (moderasi, Fase 10B):
   * - Instagram: `POST /{comment-id}?hidden=true|false`.
   * - Messenger/Page: `POST /{comment-id}?is_hidden=true|false`.
   * Parameter lewat query string (preseden subscribed_apps di kelas
   * ini); body kosong. Kegagalan Graph melempar MetaGraphError seperti
   * metode lain — pemanggil yang mencatat status lokal.
   */
  async setCommentHidden(input: {
    provider: "instagram" | "messenger";
    commentId: string;
    hidden: boolean;
  }): Promise<void> {
    const param =
      input.provider === "instagram"
        ? `hidden=${input.hidden ? "true" : "false"}`
        : `is_hidden=${input.hidden ? "true" : "false"}`;
    await this.postJson(
      `${encodeURIComponent(input.commentId)}?${param}`,
      {},
    );
  }

  /**
   * Terbitkan postingan teks/tautan Facebook Page:
   * `POST /{page-id}/feed` dengan Page Access Token milik instance ini.
   * Mengembalikan id postingan Page (Graph kadang menyebutnya `id`,
   * kadang `post_id` pada permukaan terkait).
   */
  async publishPagePost(input: {
    pageId: string;
    message: string;
    link?: string;
    /** Lampiran foto yang sudah diunggah unpublished (rakitan album). */
    attachedMedia?: Array<{ media_fbid: string }>;
  }): Promise<{ providerPostId: string }> {
    const body = await this.postJson<{ id?: string; post_id?: string }>(
      `${encodeURIComponent(input.pageId)}/feed`,
      {
        message: input.message,
        ...(input.link ? { link: input.link } : {}),
        ...(input.attachedMedia
          ? { attached_media: input.attachedMedia }
          : {}),
      },
    );
    const providerPostId = body.post_id ?? body.id;
    if (!providerPostId) {
      throw new MetaGraphError(200, null, "missing_post_id");
    }
    return { providerPostId };
  }

  /**
   * Unggah SATU foto Page lewat multipart `POST /{page-id}/photos`.
   * `published=false` dipakai tahap album: foto ditahan sampai postingan
   * feed yang merangkainya dibuat, agar tidak muncul sebagai kiriman
   * lepas sebelum albumnya jadi.
   */
  async publishPagePhoto(input: {
    pageId: string;
    file: MetaPublishFile;
    caption?: string;
    published?: boolean;
  }): Promise<{ providerPostId: string; mediaId: string }> {
    const form = new FormData();
    form.set(
      "source",
      new Blob([input.file.data], {
        type: input.file.contentType,
      }),
      input.file.filename,
    );
    if (input.caption) form.set("caption", input.caption);
    form.set("published", input.published === false ? "false" : "true");
    const body = await this.postForm<{ id?: string; post_id?: string }>(
      `${encodeURIComponent(input.pageId)}/photos`,
      form,
    );
    if (!body.id) throw new MetaGraphError(200, null, "missing_media_id");
    return {
      mediaId: body.id,
      providerPostId: body.post_id ?? body.id,
    };
  }

  /**
   * Terbitkan album foto Page. Satu foto memakai tepi photos secara
   * langsung; banyak foto diunggah `published=false`, lalu SATU feed
   * merangkai `attached_media`-nya. Urutan array adalah urutan album.
   */
  async publishPagePhotoAlbum(input: {
    pageId: string;
    files: MetaPublishFile[];
    caption: string;
  }): Promise<{ providerPostId: string }> {
    if (input.files.length === 1) {
      return this.publishPagePhoto({
        pageId: input.pageId,
        file: input.files[0]!,
        caption: input.caption,
        published: true,
      });
    }
    const mediaIds: string[] = [];
    for (const file of input.files) {
      const uploaded = await this.publishPagePhoto({
        pageId: input.pageId,
        file,
        published: false,
      });
      mediaIds.push(uploaded.mediaId);
    }
    return this.publishPagePost({
      pageId: input.pageId,
      message: input.caption,
      attachedMedia: mediaIds.map((media_fbid) => ({ media_fbid })),
    });
  }

  /**
   * Unggah video Page lewat multipart `POST /{page-id}/videos`.
   * Ini jalur unggah Graph non-resumable untuk berkas yang sudah utuh
   * di memori worker; berkas raksasa yang perlu resumable upload berada
   * di luar pola MediaObjectStore repo saat ini.
   */
  async publishPageVideo(input: {
    pageId: string;
    file: MetaPublishFile;
    description: string;
    title?: string;
  }): Promise<{ providerPostId: string }> {
    const form = new FormData();
    form.set(
      "source",
      new Blob([input.file.data], {
        type: input.file.contentType,
      }),
      input.file.filename,
    );
    if (input.description) form.set("description", input.description);
    if (input.title) form.set("title", input.title);
    const body = await this.postForm<{ id?: string }>(
      `${encodeURIComponent(input.pageId)}/videos`,
      form,
    );
    if (!body.id) throw new MetaGraphError(200, null, "missing_post_id");
    return { providerPostId: body.id };
  }

  /**
   * Content Publishing Instagram, tahap 1: buat SATU media container.
   * API ini tidak menerima unggahan multipart — Meta mengambil media
   * dari `imageUrl`/`videoUrl` yang dapat dijangkau publik. Pemanggil
   * bertanggung jawab menyediakan URL itu; klien ini hanya menjalankan
   * protokol Graph-nya. Untuk video, `mediaType: "REELS"` adalah jalur
   * publikasi video yang didukung adapter content schedule.
   */
  async createInstagramMediaContainer(input: {
    instagramAccountId: string;
    imageUrl?: string;
    videoUrl?: string;
    caption?: string;
    mediaType?: "REELS";
    isCarouselItem?: boolean;
  }): Promise<{ containerId: string }> {
    const payload: Record<string, string | boolean> = {};
    if (input.imageUrl) payload.image_url = input.imageUrl;
    if (input.videoUrl) {
      payload.video_url = input.videoUrl;
      // Item karousel bukan Reels: media_type REELS hanya untuk video
      // tunggal. Karousel menentukan jenisnya dari container induk.
      if (!input.isCarouselItem) {
        payload.media_type = input.mediaType ?? "REELS";
      }
    }
    if (input.isCarouselItem) payload.is_carousel_item = true;
    if (input.caption && !input.isCarouselItem) {
      payload.caption = input.caption;
    }
    const body = await this.postJson<{ id?: string }>(
      `${encodeURIComponent(input.instagramAccountId)}/media`,
      payload,
    );
    if (!body.id) throw new MetaGraphError(200, null, "missing_container_id");
    return { containerId: body.id };
  }

  /** Content Publishing Instagram: buat container karousel dari container item. */
  async createInstagramCarouselContainer(input: {
    instagramAccountId: string;
    children: string[];
    caption?: string;
  }): Promise<{ containerId: string }> {
    const body = await this.postJson<{ id?: string }>(
      `${encodeURIComponent(input.instagramAccountId)}/media`,
      {
        media_type: "CAROUSEL",
        children: input.children.join(","),
        ...(input.caption ? { caption: input.caption } : {}),
      },
    );
    if (!body.id) throw new MetaGraphError(200, null, "missing_container_id");
    return { containerId: body.id };
  }

  /** Baca status pemrosesan container Instagram sampai provider melaporkannya. */
  async getInstagramContainerStatus(containerId: string): Promise<string> {
    const body = await this.getJson<{ status_code?: string; status?: string }>(
      `${encodeURIComponent(containerId)}?fields=status_code,status`,
    );
    return body.status_code ?? body.status ?? "UNKNOWN";
  }

  /** Content Publishing Instagram, tahap 2: terbitkan container yang siap. */
  async publishInstagramContainer(input: {
    instagramAccountId: string;
    containerId: string;
  }): Promise<{ providerPostId: string }> {
    const body = await this.postJson<{ id?: string }>(
      `${encodeURIComponent(input.instagramAccountId)}/media_publish`,
      { creation_id: input.containerId },
    );
    if (!body.id) throw new MetaGraphError(200, null, "missing_post_id");
    return { providerPostId: body.id };
  }
}

/** Base URL Threads API — host dan versi terpisah dari Graph Facebook. */
export const DEFAULT_THREADS_API_BASE = "https://graph.threads.net";
export const DEFAULT_THREADS_API_VERSION = "v1.0";

/** Error Threads API yang aman dicatat: status + kode resmi provider. */
export class ThreadsGraphError extends GraphApiError {
  constructor(
    status: number,
    graphCode: number | null,
    description: string,
    graphSubcode: number | null = null,
  ) {
    super("Threads API", status, graphCode, description, graphSubcode);
    this.name = "ThreadsGraphError";
  }
}

/** Hasil exchange/refresh token Threads: token + sisa umur dari provider. */
export interface ThreadsOAuthTokenResult {
  accessToken: string;
  /** Threads user ID pemilik token (hanya dari exchange code). */
  userId: string | null;
  expiresInSeconds: number | null;
}

/** Profil akun Threads pemilik token (`GET /me`). */
export interface ThreadsProfile {
  id: string;
  username: string | null;
  name: string | null;
  /**
   * URL foto profil — field resminya pada `/me` Threads adalah
   * `threads_profile_picture_url` (BUKAN `profile_picture_url` —
   * nama itu hanya milik endpoint profile_lookup). Null bila akun
   * tidak memasang foto / field tidak dikembalikan.
   */
  profilePictureUrl: string | null;
}

/**
 * Klien Threads API: publikasi + OAuth connect (BUKAN inbox).
 *
 * Ia berbagi plumbing HTTP Graph dengan MetaGraphClient, tetapi bukan
 * adapter inbox dan tidak punya metode pesan/webhook. Threads memakai
 * host `graph.threads.net` dan versi v1.0; tokennya adalah Threads
 * user access token dari aplikasi Threads yang terpisah.
 *
 * Endpoint OAuth Threads TIDAK berversi (dokumentasi resmi):
 * `POST /oauth/access_token`, `GET /access_token` (th_exchange_token),
 * dan `GET /refresh_access_token` (th_refresh_token) hidup di root
 * host, sedangkan permukaan Graph biasa (termasuk `/me`) di bawah
 * `/v1.0`. Karena plumbing bersama selalu menyisipkan versi, metode
 * OAuth memakai helper mentah di kelas ini. Khusus Threads, token
 * pada dua grant GET memang WAJIB dikirim sebagai query `access_token`
 * (satu-satunya bentuk yang diterima API Threads — tidak ada varian
 * header); token tetap tidak pernah masuk log/error paket ini, yang
 * hanya membawa status + kode/pesan resmi provider.
 */
export class ThreadsGraphClient extends GraphHttpClient {
  constructor(options: GraphClientOptions = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? DEFAULT_THREADS_API_BASE,
      apiVersion: options.apiVersion ?? DEFAULT_THREADS_API_VERSION,
    });
  }

  protected createError(
    status: number,
    graphCode: number | null,
    description: string,
    graphSubcode: number | null,
  ): ThreadsGraphError {
    return new ThreadsGraphError(status, graphCode, description, graphSubcode);
  }

  /** Buat satu container Threads (teks, gambar, video, atau karousel). */
  async createThreadsContainer(input: {
    threadsUserId: string;
    mediaType: "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL";
    text?: string;
    imageUrl?: string;
    videoUrl?: string;
    children?: string[];
    isCarouselItem?: boolean;
  }): Promise<{ containerId: string }> {
    const payload: Record<string, string | boolean> = {
      media_type: input.mediaType,
    };
    if (input.text && !input.isCarouselItem) payload.text = input.text;
    if (input.imageUrl) payload.image_url = input.imageUrl;
    if (input.videoUrl) payload.video_url = input.videoUrl;
    if (input.children) payload.children = input.children.join(",");
    if (input.isCarouselItem) payload.is_carousel_item = true;
    const body = await this.postJson<{ id?: string }>(
      `${encodeURIComponent(input.threadsUserId)}/threads`,
      payload,
    );
    if (!body.id) {
      throw new ThreadsGraphError(200, null, "missing_container_id");
    }
    return { containerId: body.id };
  }

  /** Baca status container Threads. */
  async getThreadsContainerStatus(containerId: string): Promise<string> {
    const body = await this.getJson<{ status?: string; error_message?: string }>(
      `${encodeURIComponent(containerId)}?fields=status,error_message`,
    );
    return body.status ?? "UNKNOWN";
  }

  /** Terbitkan container Threads yang sudah `FINISHED`. */
  async publishThreadsContainer(input: {
    threadsUserId: string;
    containerId: string;
  }): Promise<{ providerPostId: string }> {
    const body = await this.postJson<{ id?: string }>(
      `${encodeURIComponent(input.threadsUserId)}/threads_publish`,
      { creation_id: input.containerId },
    );
    if (!body.id) throw new ThreadsGraphError(200, null, "missing_post_id");
    return { providerPostId: body.id };
  }

  // -------------------------------------------------------------------------
  // OAuth (integrasi Threads): endpoint TANPA versi di root graph.threads.net
  // -------------------------------------------------------------------------

  /** Satu panggilan ke endpoint OAuth tak-berversi (root host). */
  private async oauthRequest<T>(
    path: string,
    init: { method: "GET" | "POST"; form?: URLSearchParams },
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        method: init.method,
        headers: init.form
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {},
        body: init.form?.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw this.createError(0, null, "network_error", null);
    }
    if (!response.ok) throw await this.parseError(response);
    try {
      return (await response.json()) as T;
    } catch {
      throw this.createError(response.status, null, "invalid_response", null);
    }
  }

  /**
   * Tukar authorization code → token berumur pendek (±1 jam) + Threads
   * user ID: `POST /oauth/access_token` (form: client_id,
   * client_secret, grant_type=authorization_code, redirect_uri yang
   * IDENTIK dengan dialog authorize, code).
   */
  async exchangeThreadsCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<ThreadsOAuthTokenResult> {
    const form = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
      code: input.code,
    });
    const body = await this.oauthRequest<{
      access_token?: string;
      user_id?: string | number;
    }>("oauth/access_token", { method: "POST", form });
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new ThreadsGraphError(200, null, "missing_access_token");
    }
    return {
      accessToken: body.access_token,
      userId:
        typeof body.user_id === "string" || typeof body.user_id === "number"
          ? String(body.user_id)
          : null,
      expiresInSeconds: null,
    };
  }

  /**
   * Tukar token berumur pendek → token berumur panjang (±60 hari):
   * `GET /access_token?grant_type=th_exchange_token&client_secret=…&
   * access_token=…` (bentuk resmi Threads; secret & token memang
   * parameter query di grant ini).
   */
  async exchangeThreadsLongLivedToken(input: {
    clientSecret: string;
    shortLivedToken: string;
  }): Promise<ThreadsOAuthTokenResult> {
    const query = new URLSearchParams({
      grant_type: "th_exchange_token",
      client_secret: input.clientSecret,
      access_token: input.shortLivedToken,
    });
    const body = await this.oauthRequest<{
      access_token?: string;
      expires_in?: number;
    }>(`access_token?${query.toString()}`, { method: "GET" });
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new ThreadsGraphError(200, null, "missing_access_token");
    }
    return {
      accessToken: body.access_token,
      userId: null,
      expiresInSeconds:
        typeof body.expires_in === "number" ? body.expires_in : null,
    };
  }

  /**
   * Segarkan token berumur panjang (grant `th_refresh_token`): token
   * BARU berumur ±60 hari sejak penyegaran. Token saat ini dibaca dari
   * konstruktor klien (accessToken) dan dikirim sebagai query
   * `access_token` — satu-satunya bentuk grant ini; app secret TIDAK
   * diperlukan (beda dari refresh `tbft` Meta). Syarat provider: token
   * masih sah, berumur ≥24 jam, dan belum kedaluwarsa; pelanggaran
   * dijawab error Graph (190 untuk token mati → hubungkan ulang).
   */
  async refreshThreadsToken(): Promise<ThreadsOAuthTokenResult> {
    if (!this.accessToken) {
      throw new ThreadsGraphError(0, null, "missing_access_token");
    }
    const query = new URLSearchParams({
      grant_type: "th_refresh_token",
      access_token: this.accessToken,
    });
    const body = await this.oauthRequest<{
      access_token?: string;
      expires_in?: number;
    }>(`refresh_access_token?${query.toString()}`, { method: "GET" });
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new ThreadsGraphError(200, null, "missing_access_token");
    }
    return {
      accessToken: body.access_token,
      userId: null,
      expiresInSeconds:
        typeof body.expires_in === "number" ? body.expires_in : null,
    };
  }

  /**
   * Profil akun pemilik token (`GET /v1.0/me?fields=id,username,name,
   * threads_profile_picture_url`) — permukaan berversi biasa, token
   * sebagai Bearer (klien dibangun dengan token berumur panjang).
   * Dipakai connect untuk external_id (id) + display_name (name) +
   * public_handle (username) + foto profil (profilePictureUrl).
   */
  async getThreadsProfile(): Promise<ThreadsProfile> {
    const body = await this.getJsonParams<{
      id?: string;
      username?: string;
      name?: string;
      threads_profile_picture_url?: string;
    }>("me", { fields: "id,username,name,threads_profile_picture_url" });
    if (typeof body.id !== "string" || !body.id) {
      throw new ThreadsGraphError(200, null, "missing_profile_id");
    }
    return {
      id: body.id,
      username: typeof body.username === "string" ? body.username : null,
      name: typeof body.name === "string" ? body.name : null,
      profilePictureUrl:
        typeof body.threads_profile_picture_url === "string" &&
        body.threads_profile_picture_url
          ? body.threads_profile_picture_url
          : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Webhook: verifikasi tanda tangan + normalisasi payload (fungsi murni)
// ---------------------------------------------------------------------------

/**
 * Verifikasi `X-Hub-Signature-256`: HMAC-SHA256 atas RAW BODY dengan app
 * secret, format header `sha256=<hex>`. Perbandingan aman-timing.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected =
    "sha256=" +
    createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const presented = Buffer.from(signatureHeader, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (presented.length !== wanted.length) return false;
  return timingSafeEqual(presented, wanted);
}

/** Hasil parse `signed_request` Meta yang LOLOS verifikasi tanda tangan. */
export interface MetaSignedRequestPayload {
  /** ID pengguna dalam lingkup aplikasi (app-scoped user id). */
  userId: string;
  /** Waktu terbit (epoch detik) bila disertakan platform. */
  issuedAt: number | null;
  /** Payload mentah terverifikasi (field lain milik platform). */
  raw: Record<string, unknown>;
}

/**
 * Verifikasi + parse `signed_request` Meta (callback penghapusan data
 * dan deauthorize): format `<base64url(tanda tangan)>.<base64url(JSON
 * payload)>`; tanda tangan = HMAC-SHA256 atas string bagian payload
 * PERSIS sebagaimana terkirim, dikunci app secret; payload wajib
 * mengaku `algorithm: "HMAC-SHA256"`. Mengembalikan null untuk segala
 * bentuk tidak sah — format rusak, algoritma lain, tanda tangan tidak
 * cocok, atau `user_id` hilang — agar pemanggil menolak tanpa
 * membedakan alasannya ke luar.
 */
export function parseMetaSignedRequest(
  signedRequest: string,
  appSecret: string,
): MetaSignedRequestPayload | null {
  const dot = signedRequest.indexOf(".");
  if (dot <= 0) return null;
  const signaturePart = signedRequest.slice(0, dot);
  const payloadPart = signedRequest.slice(dot + 1);
  if (!signaturePart || !payloadPart) return null;
  let presented: Buffer;
  let payloadJson: string;
  try {
    presented = Buffer.from(signaturePart, "base64url");
    payloadJson = Buffer.from(payloadPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", appSecret)
    .update(payloadPart, "utf8")
    .digest();
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.algorithm !== "HMAC-SHA256") return null;
  if (typeof payload.user_id !== "string" || !payload.user_id) return null;
  return {
    userId: payload.user_id,
    issuedAt: typeof payload.issued_at === "number" ? payload.issued_at : null,
    raw: payload,
  };
}

/** Satu event messaging yang dinormalisasi dari payload webhook Meta. */
export interface MetaMessagingEvent {
  /** Objek webhook: 'page' → messenger, 'instagram' → instagram. */
  objectKind: "page" | "instagram";
  /** entry.id: Page ID (page) / ID akun IG (instagram) — penerima pesan. */
  entryExternalId: string;
  /** PSID/IGSID pengirim. */
  senderExternalId: string;
  /** message.mid — id dedup provider. */
  providerMessageId: string;
  /**
   * Mid pesan yang dikutip pesan ini (`message.reply_to.mid`, Fase
   * 7B.5); null bila pesan bukan balasan terkutip. Webhook Meta memang
   * menyertakan field ini saat pengguna membalas pesan tertentu —
   * arah MASUK didukung penuh, berbeda dari arah keluar (lihat catatan
   * keterbatasan pada MetaGraphClient.sendMessage).
   */
  replyToProviderMessageId: string | null;
  /** Teks pesan; null untuk event non-teks (lampiran/stiker/like). */
  text: string | null;
  /**
   * Payload quick reply (G5): terisi bila pesan ini adalah KETUKAN
   * tombol quick reply (`message.quick_reply.payload`) — teksnya
   * adalah JUDUL tombol, payload-nya string mesin yang dikonfigurasi
   * pengirim tombol. Null untuk pesan ketikan biasa: teks yang
   * kebetulan sama dengan judul tombol TIDAK naik kelas.
   */
  quickReplyPayload: string | null;
  /** Pantulan pesan yang KITA kirim (message.is_echo) — pemanggil melewatinya. */
  isEcho: boolean;
  timestamp: number | null;
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: Array<{
      sender?: { id?: string };
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        reply_to?: { mid?: string };
        quick_reply?: { payload?: string };
      };
      timestamp?: number;
    }>;
  }>;
}

/**
 * Menormalkan payload webhook Meta menjadi daftar event messaging.
 * Hanya entri `messaging` berisi `message` yang diambil (delivery/read
 * receipts dilewati; postback punya parsernya sendiri sejak G5 —
 * `parseMetaPostbackEvents`). Event non-teks tetap dikembalikan
 * dengan text null agar pemanggil bisa memutuskan; echo ditandai apa
 * adanya (pemanggil melewatinya agar pantulan kiriman sendiri tidak
 * menjadi pesan masuk ganda).
 */
export function parseMetaWebhookEvents(payload: unknown): MetaMessagingEvent[] {
  if (typeof payload !== "object" || payload === null) return [];
  const body = payload as MetaWebhookPayload;
  if (body.object !== "page" && body.object !== "instagram") return [];
  const objectKind = body.object;
  const events: MetaMessagingEvent[] = [];
  for (const entry of body.entry ?? []) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    for (const item of entry.messaging ?? []) {
      const senderId = item?.sender?.id;
      const message = item?.message;
      if (typeof senderId !== "string" || !senderId || !message) continue;
      if (typeof message.mid !== "string" || !message.mid) continue;
      events.push({
        objectKind,
        entryExternalId: entry.id,
        senderExternalId: senderId,
        providerMessageId: message.mid,
        replyToProviderMessageId:
          typeof message.reply_to?.mid === "string" && message.reply_to.mid
            ? message.reply_to.mid
            : null,
        text: typeof message.text === "string" ? message.text : null,
        quickReplyPayload:
          typeof message.quick_reply?.payload === "string" &&
          message.quick_reply.payload
            ? message.quick_reply.payload
            : null,
        isEcho: message.is_echo === true,
        timestamp:
          typeof item.timestamp === "number" ? item.timestamp : null,
      });
    }
  }
  return events;
}

/**
 * Satu event POSTBACK yang dinormalisasi (G5): ketukan tombol
 * postback pada Messenger/Instagram — tombol Get Started, menu
 * persisten, tombol pada template pesan, ice breaker, dsb.
 *
 * Bentuk terdokumentasi Meta: `entry.messaging[].postback =
 * { mid?, payload, title?, referral? }`. `payload` adalah string
 * mesin yang dikonfigurasi saat tombol dibuat — itulah yang
 * dicocokkan PERSIS oleh pemicu postback. `title` adalah label
 * tombol yang terlihat pengguna (bahan teks tampil pesan).
 *
 * Id dedup: `postback.mid` dipakai bila ada; payload lama tidak
 * selalu membawanya, jadi cadangan deterministik disusun dari
 * (entry, pengirim, timestamp, payload) — retry webhook yang sama
 * menghasilkan id yang sama dan ter-dedup di core.
 */
export interface MetaPostbackEvent {
  /** Objek webhook: 'page' → messenger, 'instagram' → instagram. */
  objectKind: "page" | "instagram";
  /** entry.id: Page ID (page) / ID akun IG (instagram) — penerima. */
  entryExternalId: string;
  /** PSID/IGSID pengguna yang mengetuk tombol. */
  senderExternalId: string;
  /** Id dedup (postback.mid atau cadangan deterministik). */
  providerMessageId: string;
  /** Payload mesin tombol — kunci pencocokan pemicu postback. */
  payload: string;
  /** Label tombol yang terlihat pengguna; null bila Meta tak mengirimnya. */
  title: string | null;
  timestamp: number | null;
}

interface MetaPostbackPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: Array<{
      sender?: { id?: string };
      postback?: { mid?: string; payload?: string; title?: string };
      timestamp?: number;
    }>;
  }>;
}

/**
 * Menormalkan event postback (`messaging[].postback`) dari payload
 * webhook Meta. Parser messaging utama sengaja tidak diubah —
 * postback tidak membawa `message`, jadi tidak pernah lolos parser
 * pesan; jalur ini terpisah seperti parser referral/komentar.
 * Postback tanpa payload string non-kosong dibuang: tidak ada yang
 * bisa dicocokkan dan tidak ada yang bisa ditampilkan dengan jujur.
 */
export function parseMetaPostbackEvents(payload: unknown): MetaPostbackEvent[] {
  if (typeof payload !== "object" || payload === null) return [];
  const body = payload as MetaPostbackPayload;
  if (body.object !== "page" && body.object !== "instagram") return [];
  const objectKind = body.object;
  const events: MetaPostbackEvent[] = [];
  for (const entry of body.entry ?? []) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    for (const item of entry.messaging ?? []) {
      const senderId = item?.sender?.id;
      const postback = item?.postback;
      if (typeof senderId !== "string" || !senderId || !postback) continue;
      if (typeof postback.payload !== "string" || !postback.payload) continue;
      const timestamp =
        typeof item.timestamp === "number" ? item.timestamp : null;
      events.push({
        objectKind,
        entryExternalId: entry.id,
        senderExternalId: senderId,
        providerMessageId:
          typeof postback.mid === "string" && postback.mid
            ? postback.mid
            : `postback:${entry.id}:${senderId}:${timestamp ?? 0}:${postback.payload}`,
        payload: postback.payload,
        title:
          typeof postback.title === "string" && postback.title
            ? postback.title
            : null,
        timestamp,
      });
    }
  }
  return events;
}

/**
 * Satu event REFERRAL yang dinormalisasi dari payload webhook Meta
 * (Fase 13B): kedatangan pengguna lewat tautan m.me / ig.me yang
 * membawa parameter ref — di sini ref = slug growth link.
 *
 * Bentuk terdokumentasi Meta (objek 'page' & 'instagram' simetris):
 * - entry.messaging[].referral = { ref, source, type } — referral
 *   berdiri sendiri saat percakapan DIBUKA dari tautan ref;
 * - entry.messaging[].postback.referral = { ref, source, type } —
 *   referral yang menempel pada ketukan tombol Get Started.
 * Keduanya dinormalkan ke bentuk yang sama; ref kosong dilewati.
 */
export interface MetaReferralEvent {
  /** Objek webhook: 'page' → messenger, 'instagram' → instagram. */
  objectKind: "page" | "instagram";
  /** entry.id: Page ID (page) / ID akun IG (instagram) — penerima. */
  entryExternalId: string;
  /** PSID/IGSID pengguna yang datang lewat tautan ref. */
  senderExternalId: string;
  /** Parameter ref pada tautan (di sini: slug growth link). */
  ref: string;
  /** Sumber Meta: 'SHORTLINK' | 'ADS' | 'CUSTOMER_CHAT_PLUGIN' | ... */
  source: string | null;
  timestamp: number | null;
}

interface MetaReferralPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: Array<{
      sender?: { id?: string };
      referral?: { ref?: string; source?: string };
      postback?: { referral?: { ref?: string; source?: string } };
      timestamp?: number;
    }>;
  }>;
}

/**
 * Menormalkan event referral (`messaging_referrals`) dari payload
 * webhook Meta. Parser messaging utama sengaja tidak diubah —
 * referral tidak membawa `message`, jadi tidak pernah lolos parser
 * pesan; jalur ini terpisah agar pemanggil bisa mengatribusikan
 * kontak tanpa membuat pesan masuk.
 */
export function parseMetaReferralEvents(payload: unknown): MetaReferralEvent[] {
  if (typeof payload !== "object" || payload === null) return [];
  const body = payload as MetaReferralPayload;
  if (body.object !== "page" && body.object !== "instagram") return [];
  const objectKind = body.object;
  const events: MetaReferralEvent[] = [];
  for (const entry of body.entry ?? []) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    for (const item of entry.messaging ?? []) {
      const senderId = item?.sender?.id;
      if (typeof senderId !== "string" || !senderId) continue;
      const referral = item?.referral ?? item?.postback?.referral;
      if (!referral || typeof referral.ref !== "string" || !referral.ref) {
        continue;
      }
      events.push({
        objectKind,
        entryExternalId: entry.id,
        senderExternalId: senderId,
        ref: referral.ref,
        source: typeof referral.source === "string" ? referral.source : null,
        timestamp: typeof item.timestamp === "number" ? item.timestamp : null,
      });
    }
  }
  return events;
}

/** Satu event komentar yang dinormalisasi dari payload webhook Meta (Fase 10B). */
export interface MetaCommentEvent {
  /** Objek webhook: 'page' → messenger, 'instagram' → instagram. */
  objectKind: "page" | "instagram";
  /** entry.id: ID akun IG / Page ID pemilik komentar. */
  entryExternalId: string;
  /** Id komentar di Meta — kunci dedup bersama akun. */
  providerCommentId: string;
  /** Id media IG (instagram saja); null selain itu. */
  mediaId: string | null;
  /** Id postingan Page (messenger saja); null selain itu. */
  postId: string | null;
  /** Id komentar induk bila komentar ini balasan atas komentar lain. */
  parentId: string | null;
  /** IGSID / PSID penulis komentar. */
  authorExternalId: string;
  /** Username IG / nama penulis Page, bila payload membawanya. */
  authorUsername: string | null;
  /** Isi komentar. */
  text: string;
  /** Waktu komentar menurut provider (created_time, detik epoch); null bila absen. */
  providerCreatedAt: Date | null;
}

interface MetaCommentChangesPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        // Instagram (field 'comments')
        id?: string;
        text?: string;
        from?: { id?: string; username?: string; name?: string };
        media?: { id?: string };
        parent_id?: string;
        // Page feed (field 'feed', item 'comment')
        item?: string;
        verb?: string;
        comment_id?: string;
        post_id?: string;
        message?: string;
        created_time?: number;
      };
    }>;
  }>;
}

/**
 * Menormalkan event KOMENTAR dari payload webhook Meta (Fase 10B).
 * Parser messaging (`parseMetaWebhookEvents`) sengaja TIDAK diubah —
 * komentar hidup di `entry.changes`, bukan `entry.messaging`:
 * - Instagram: objek 'instagram', changes field 'comments',
 *   value { id, text, from { id, username }, media { id }, parent_id? }.
 * - Messenger/Page: objek 'page', changes field 'feed' dengan
 *   value.item='comment' & verb='add', value { comment_id, post_id,
 *   message, from { id, name }, created_time, parent_id? }.
 * Bentuk field 'comments' ala IG pada objek page juga ditoleransi
 * (beberapa konfigurasi langganan mengirimkannya). Perubahan feed
 * selain penambahan komentar (post, like, verb edit/remove) dilewati:
 * v1 hanya mencatat komentar baru; penghapusan komentar di sisi Meta
 * tidak diselaraskan (status lokal tetap yang terakhir diketahui).
 */
export function parseMetaCommentEvents(
  payload: unknown,
): MetaCommentEvent[] {
  if (typeof payload !== "object" || payload === null) return [];
  const body = payload as MetaCommentChangesPayload;
  if (body.object !== "page" && body.object !== "instagram") return [];
  const objectKind = body.object;
  const events: MetaCommentEvent[] = [];
  for (const entry of body.entry ?? []) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    for (const change of entry.changes ?? []) {
      const value = change?.value;
      if (!value) continue;
      if (objectKind === "instagram" || change.field === "comments") {
        // Bentuk IG: field 'comments'.
        if (change.field !== "comments") continue;
        const commentId = value.id;
        const authorId = value.from?.id;
        if (typeof commentId !== "string" || !commentId) continue;
        if (typeof authorId !== "string" || !authorId) continue;
        events.push({
          objectKind,
          entryExternalId: entry.id,
          providerCommentId: commentId,
          mediaId:
            typeof value.media?.id === "string" && value.media.id
              ? value.media.id
              : null,
          postId: null,
          parentId:
            typeof value.parent_id === "string" && value.parent_id
              ? value.parent_id
              : null,
          authorExternalId: authorId,
          authorUsername:
            (typeof value.from?.username === "string" &&
            value.from.username
              ? value.from.username
              : null) ??
            (typeof value.from?.name === "string" && value.from.name
              ? value.from.name
              : null),
          text: typeof value.text === "string" ? value.text : "",
          providerCreatedAt: null,
        });
        continue;
      }
      // Bentuk Page feed: hanya komentar baru.
      if (change.field !== "feed") continue;
      if (value.item !== "comment" || value.verb !== "add") continue;
      const commentId = value.comment_id;
      const authorId = value.from?.id;
      if (typeof commentId !== "string" || !commentId) continue;
      if (typeof authorId !== "string" || !authorId) continue;
      events.push({
        objectKind,
        entryExternalId: entry.id,
        providerCommentId: commentId,
        mediaId: null,
        postId:
          typeof value.post_id === "string" && value.post_id
            ? value.post_id
            : null,
        parentId:
          typeof value.parent_id === "string" && value.parent_id
            ? value.parent_id
            : null,
        authorExternalId: authorId,
        authorUsername:
          typeof value.from?.name === "string" && value.from.name
            ? value.from.name
            : null,
        text: typeof value.message === "string" ? value.message : "",
        providerCreatedAt:
          typeof value.created_time === "number" && value.created_time > 0
            ? new Date(value.created_time * 1000)
            : null,
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Adapter channel-core
// ---------------------------------------------------------------------------

/**
 * Adapter Meta untuk satu akun (satu klien = satu token Page). Dipakai
 * provider 'messenger'; untuk 'instagram' lapisan API memakai klien
 * yang sama dengan accountExternalId akun IG (lihat core/meta.ts).
 * Pengiriman produksi kita tetap lewat antrean `queued` + poller API.
 */
export class MessengerChannelAdapter implements ChannelAdapter {
  readonly provider = "messenger" as const;
  private readonly client: MetaGraphClient;

  constructor(client: MetaGraphClient) {
    this.client = client;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const result = await this.client.sendMessage({
      accountExternalId: input.account.externalId,
      recipientExternalId: input.toExternalId,
      text: input.text,
    });
    return { providerMessageId: result.providerMessageId };
  }

  /**
   * Verifikasi adapter memerlukan app secret platform (bukan milik
   * instance akun) — jalur produksi memverifikasi di route webhook
   * terhadap env platform. Selalu false di sini agar tidak ada jalur
   * yang menganggap payload tepercaya tanpa secret itu (pola Telegram).
   */
  verifyWebhookSignature(_input: VerifyWebhookInput): boolean {
    return false;
  }

  parseWebhookEvents(payload: unknown): StandardEvent[] {
    return parseMetaWebhookEvents(payload)
      .filter((e) => e.objectKind === "page" && !e.isEcho && e.text)
      .map((e) => ({
        type: "message.received" as const,
        provider: "messenger" as const,
        providerEventId: e.providerMessageId,
        message: {
          providerMessageId: e.providerMessageId,
          conversationExternalId: e.senderExternalId,
          conversationKind: "private" as const,
          senderExternalId: e.senderExternalId,
          direction: "inbound" as const,
          type: "text" as const,
          text: e.text as string,
          replyToProviderMessageId: e.replyToProviderMessageId ?? undefined,
          sentAt: e.timestamp
            ? new Date(e.timestamp).toISOString()
            : new Date().toISOString(),
        },
        raw: payload,
        receivedAt: new Date().toISOString(),
      }));
  }
}
