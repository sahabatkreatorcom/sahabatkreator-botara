import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  PlatformSettingsResponseSchema,
  PlatformSettingStatusSchema,
  PlatformSettingTestResultSchema,
  SetPlatformSettingRequestSchema,
  type PlatformSettingStatus,
} from "@sahabat-kreator/contracts";
import {
  PlatformSettingsUnavailableError,
  clearPlatformSetting,
  getPlatformPublicConfig,
  getProviderSecret,
  isPlatformAdmin,
  isPlatformSettingKey,
  isValidPlatformSettingValue,
  listPlatformSettingStatuses,
  recordPlatformSettingTest,
  resolvePostMediaPublicBaseUrl,
  resolveR2Identity,
  resolveTikTokPrivacyLevel,
  resolveYouTubePrivacyStatus,
  setPlatformSetting,
  type PlatformSettingKey,
  type PlatformSettingsOptions,
  type PlatformSettingStatus as CorePlatformSettingStatus,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { registerAdminConsoleRoutes } from "./console";
import { probeOpenRouterKey, probeR2Bucket, probeResendKey, type ProbeResult } from "./probes";

export interface AdminRoutesOptions {
  /** Allowlist mentah env PLATFORM_ADMIN_EMAILS (koma-terpisah). */
  platformAdminEmails?: string;
  /** Kunci induk env PLATFORM_SETTINGS_SECRET + fallback env per kunci. */
  platform: PlatformSettingsOptions;
  /**
   * Identitas R2 TIDAK lagi dioper sebagai info statis: status & probe
   * me-resolve `resolveR2Identity` per request dari core (panel → env
   * → bawaan kode), jadi perubahan identitas di panel berlaku tanpa
   * restart dalam jendela cache resolver (±60 detik).
   */
  /**
   * Redirect URI OAuth Meta (Fase 7D) — callback tunggal yang ditampilkan
   * read-only di grup Meta panel agar pemilik mendaftarkannya persis di
   * Meta App. Dihitung dari BETTER_AUTH_URL oleh pemanggil.
   */
  metaOAuthRedirectUri?: string;
  /**
   * Base URL API Resend (Fase 11B) — hanya untuk probe uji koneksi;
   * default https://api.resend.com, override env RESEND_API_BASE untuk
   * mock rantai. Pengiriman sungguhan di-resolve worker dari env-nya.
   */
  resendApiBase?: string;
  /**
   * Redirect URI OAuth Google KANONIS per layanan (keputusan pemilik
   * 2026-11-12: `/api/oauth/<layanan>/callback`) — ditampilkan
   * read-only di grup Google panel agar pemilik mendaftarkannya
   * persis di proyek Cloud tiap layanan. Dihitung dari
   * BETTER_AUTH_URL oleh pemanggil.
   */
  googleOAuthRedirectUris?: {
    calendar: string;
    youtube: string;
    business: string;
    ads: string;
    sheets: string;
  };
}

function serializeStatus(s: CorePlatformSettingStatus): PlatformSettingStatus {
  return PlatformSettingStatusSchema.parse({
    key: s.key,
    isSet: s.isSet,
    source: s.source,
    updatedAt: s.updatedAt?.toISOString() ?? null,
    updatedBy: s.updatedBy,
  });
}

/** Batas panjang per kunci: nama model jauh lebih pendek dari kredensial. */
const KEY_MAX_LENGTH: Record<PlatformSettingKey, number> = {
  openrouter_api_key: 512,
  openrouter_model: 128,
  r2_access_key_id: 512,
  r2_secret_access_key: 512,
  // Identitas R2 publik: account id tepat 32 heksadesimal, nama bucket
  // maks 63 (aturan S3), endpoint URL https — bentuk ditegakkan
  // isValidPlatformSettingValue; batas ini hanya pagar panjang.
  r2_account_id: 64,
  r2_endpoint: 512,
  r2_bucket: 64,
  meta_app_secret: 512,
  // Fase 7D: identifier publik Meta (App ID + config ID Login for
  // Business) — pendek, bukan kredensial; nilainya DITAMPILKAN di panel.
  meta_app_id: 128,
  meta_ig_config_id: 128,
  meta_wa_config_id: 128,
  // Aplikasi Threads: app id publik pendek (ditampilkan panel),
  // app secret rahasia mengikuti batas kunci rahasia lain.
  threads_app_id: 128,
  threads_app_secret: 512,
  // Aplikasi TikTok: client key publik pendek (ditampilkan panel),
  // client secret rahasia mengikuti batas kunci rahasia lain.
  tiktok_client_key: 128,
  tiktok_client_secret: 512,
  // Aplikasi LinkedIn: client ID publik pendek (ditampilkan panel),
  // client secret rahasia mengikuti batas kunci rahasia lain.
  linkedin_client_id: 128,
  linkedin_client_secret: 512,
  // Aplikasi Pinterest: app ID publik pendek (ditampilkan panel),
  // app secret rahasia mengikuti batas kunci rahasia lain.
  pinterest_app_id: 128,
  pinterest_app_secret: 512,
  // Fase 11B: kunci Resend rahasia; identitas pengirim publik (alamat
  // email + nama tampil) — panjang mengikuti sifat nilainya.
  resend_api_key: 512,
  resend_from_email: 320,
  resend_from_name: 128,
  // Fase 13G: klien OAuth Google — client ID identifier publik
  // (ditampilkan panel), client secret rahasia. Panjang mengikuti
  // format Google (client ID ±72 char, secret ±40 char) + ruang aman.
  google_oauth_client_id: 256,
  google_oauth_client_secret: 512,
  // Gelombang Pemisahan Google: klien OAuth per layanan — batas
  // panjang sama seperti pasangan bersama di atas.
  google_calendar_client_id: 256,
  google_calendar_client_secret: 512,
  google_youtube_client_id: 256,
  google_youtube_client_secret: 512,
  google_business_client_id: 256,
  google_business_client_secret: 512,
  // G16: klien OAuth layanan 'ads' (pola per-layanan yang sama) +
  // developer token Google Ads milik platform (rahasia; diterbitkan
  // Google ±22 char — batas mengikuti kunci rahasia lain).
  google_ads_client_id: 256,
  google_ads_client_secret: 512,
  google_ads_developer_token: 512,
  // G17: klien OAuth layanan 'sheets' (pola per-layanan yang sama).
  google_sheets_client_id: 256,
  google_sheets_client_secret: 512,
  // Token verifikasi webhook Meta: nilai bebas yang ditempel ke
  // dashboard Meta App; panjang mengikuti kunci rahasia lain.
  meta_webhook_verify_token: 512,
  threads_webhook_verify_token: 512,
  // Nama model embedding — pendek seperti openrouter_model.
  openrouter_embedding_model: 128,
  // Pengaturan content schedule: URL publik (batas URL wajar) dan dua
  // enum privasi (nilai sahnya jauh di bawah batas ini; keabsahan
  // bentuk ditegakkan isValidPlatformSettingValue di handler PUT).
  post_media_public_base_url: 512,
  youtube_privacy_status: 32,
  tiktok_privacy_level: 32,
};

/**
 * Kunci yang punya uji koneksi (model adalah teks bebas — tidak diuji).
 * `meta_app_secret` SENGAJA tidak diuji (Fase 7A.1): Meta tidak menyediakan
 * panggilan yang memvalidasi app secret secara berdiri sendiri
 * (debug_token butuh access token), jadi tombol uji di sini hanya akan
 * jadi uji palsu. Kebenaran nilainya terbukti dari tanda tangan webhook
 * yang lolos/gagal — persis seperti pemakaiannya.
 * `google_oauth_client_secret` SENGAJA tidak diuji (Fase 13G) dengan
 * alasan yang sama: token endpoint Google hanya memvalidasi pasangan
 * klien saat ada authorization code / refresh token yang ditukar —
 * tidak ada panggilan validasi klien yang berdiri sendiri. Kebenarannya
 * terbukti dari dialog Hubungkan Google tenant yang berhasil/gagal.
 * Secret per layanan (google_calendar/youtube/business_client_secret)
 * sama: tidak diuji, dengan alasan yang persis sama.
 * `threads_app_secret` juga tidak diuji — alasan yang sama seperti
 * meta_app_secret (dan alur OAuth Threads-nya sendiri belum dibuka).
 * `tiktok_client_secret` sama: tidak ada panggilan validasi mandiri
 * TikTok untuk client secret, dan OAuth TikTok belum dibuka.
 * `linkedin_client_secret` sama: token endpoint LinkedIn hanya
 * memvalidasi pasangan klien saat ada authorization code yang
 * ditukar — tidak ada panggilan validasi klien yang berdiri sendiri.
 * `pinterest_app_secret` sama: token endpoint Pinterest v5 hanya
 * memvalidasi pasangan aplikasi saat ada authorization code /
 * refresh token yang ditukar.
 */
const TESTABLE_KEYS: ReadonlySet<PlatformSettingKey> = new Set([
  "openrouter_api_key",
  "r2_access_key_id",
  "r2_secret_access_key",
  // Fase 11B: GET /domains Resend memvalidasi kunci tanpa mengirim
  // email apa pun — uji yang jujur untuk kredensial email.
  "resend_api_key",
]);

/**
 * Modul Panel Admin Platform (Fase 6C) — kredensial provider MILIK
 * PLATFORM, bukan tenant:
 *   GET    /admin/settings             status semua kunci (tanpa nilai)
 *   PUT    /admin/settings/:key        simpan nilai panel (terenkripsi)
 *   DELETE /admin/settings/:key        hapus nilai panel → env fallback
 *   POST   /admin/settings/:key/test   uji koneksi dengan kunci efektif
 *
 * Gerbang berlapis: sesi wajib (requireAuth, 401 tanpa sesi); non-admin
 * (email tak ada di allowlist env PLATFORM_ADMIN_EMAILS) → 404 NOT_FOUND
 * agar eksistensi panel tidak dibocorkan (pola non-member Fase 1B).
 * Akses data hanya lewat core platform-settings (transaksi ber-flag
 * `app.platform_settings='admin'`; RLS fail-closed di luar itu).
 * Semua aksi set/clear/test menulis audit `platform_settings.*` TANPA nilai.
 */
export function createAdminRoutes(
  bundle: AuthBundle | null,
  options: AdminRoutesOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  if (!bundle) {
    app.get("/admin/settings", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.put("/admin/settings/:key", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.delete("/admin/settings/:key", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    app.post("/admin/settings/:key/test", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    // Konsol (migrasi 0010) butuh database untuk apa pun; satu gerbang
    // menyeluruh lebih jujur daripada 9 route yang masing-masing menjawab 404.
    app.all("/admin/*", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  const auth = requireAuth(bundle);
  const adminGate: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    const appUser = c.get("appUser");
    // Env ATAU daftar yang dikelola panel. Tidak di-cache: pencabutan hak
    // harus langsung berlaku pada cookie yang sudah ada.
    const allowed = await isPlatformAdmin(
      bundle.db,
      appUser.email,
      options.platformAdminEmails,
    );
    if (!allowed) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }
    await next();
  };
  app.use("/admin/*", auth);
  app.use("/admin/*", adminGate);

  const statusFor = async (key: PlatformSettingKey) => {
    const all = await listPlatformSettingStatuses(bundle.db, options.platform);
    return serializeStatus(all.find((s) => s.key === key)!);
  };

  app.get("/admin/settings", async (c) => {
    const statuses = await listPlatformSettingStatuses(
      bundle.db,
      options.platform,
    );
    // Fase 7D: nilai efektif identifier publik Meta (panel → env)
    // disertakan agar bisa diverifikasi pemilik — BUKAN rahasia.
    const publicConfig = await getPlatformPublicConfig(
      bundle.db,
      options.platform,
    );
    const body = PlatformSettingsResponseSchema.parse({
      settings: statuses.map(serializeStatus),
      // Identitas R2 efektif dari resolver core (panel → env →
      // bawaan) — selalu terisi penuh, menggantikan info statis
      // config yang sebelumnya dioper pemanggil.
      r2: await resolveR2Identity(bundle.db, options.platform),
      meta: {
        appId: publicConfig.meta_app_id,
        igConfigId: publicConfig.meta_ig_config_id,
        waConfigId: publicConfig.meta_wa_config_id,
        oauthRedirectUri: options.metaOAuthRedirectUri ?? "",
      },
      // Aplikasi Threads (terpisah dari Meta App): hanya App ID yang
      // ditampilkan (publik); App Secret tidak pernah keluar — pola
      // yang sama seperti meta_app_secret di grup Meta.
      threads: {
        appId: publicConfig.threads_app_id,
      },
      // Aplikasi TikTok (TikTok for Developers): hanya Client Key
      // yang ditampilkan (pengenal publik); Client Secret tidak
      // pernah keluar — pola yang sama seperti kunci rahasia lain.
      tiktok: {
        clientKey: publicConfig.tiktok_client_key,
      },
      // Aplikasi LinkedIn (LinkedIn Developer Portal): hanya Client
      // ID yang ditampilkan (publik); Client Secret tidak pernah
      // keluar — pola yang sama seperti kunci rahasia lain.
      linkedin: {
        clientId: publicConfig.linkedin_client_id,
      },
      // Aplikasi Pinterest (Pinterest Developers): hanya App ID yang
      // ditampilkan (publik); App Secret tidak pernah keluar — pola
      // yang sama seperti kunci rahasia lain.
      pinterest: {
        appId: publicConfig.pinterest_app_id,
      },
      // Fase 11B: identitas pengirim email efektif (panel → env) —
      // publik menurut sifatnya, ditampilkan untuk verifikasi pemilik.
      email: {
        fromEmail: publicConfig.resend_from_email,
        fromName: publicConfig.resend_from_name,
      },
      // Fase 13G: Client ID OAuth Google efektif (publik) + redirect
      // URI yang harus didaftarkan persis di Google Cloud Console.
      // Gelombang Pemisahan Google: `services` menampilkan client ID
      // EFEKTIF per layanan (per-layanan → bersama) — nilai yang
      // benar-benar dipakai dialog OAuth layanan itu — dan redirect
      // URI KANONIS per layanan (/api/oauth/<layanan>/callback)
      // untuk didaftarkan di proyek Cloud layanan itu masing-masing.
      google: {
        clientId: publicConfig.google_oauth_client_id,
        oauthRedirectUri: options.googleOAuthRedirectUris?.calendar ?? "",
        services: {
          calendar: {
            clientId:
              publicConfig.google_calendar_client_id ??
              publicConfig.google_oauth_client_id,
            redirectUri: options.googleOAuthRedirectUris?.calendar ?? "",
          },
          youtube: {
            clientId:
              publicConfig.google_youtube_client_id ??
              publicConfig.google_oauth_client_id,
            redirectUri: options.googleOAuthRedirectUris?.youtube ?? "",
          },
          business: {
            clientId:
              publicConfig.google_business_client_id ??
              publicConfig.google_oauth_client_id,
            redirectUri: options.googleOAuthRedirectUris?.business ?? "",
          },
          ads: {
            clientId:
              publicConfig.google_ads_client_id ??
              publicConfig.google_oauth_client_id,
            redirectUri: options.googleOAuthRedirectUris?.ads ?? "",
          },
          sheets: {
            clientId:
              publicConfig.google_sheets_client_id ??
              publicConfig.google_oauth_client_id,
            redirectUri: options.googleOAuthRedirectUris?.sheets ?? "",
          },
        },
      },
      // Pengaturan content schedule efektif — diselesaikan lewat
      // resolver BERTIPE core (panel → env tervalidasi → bawaan aman),
      // bukan nilai mentah, agar tampilan panel selalu menunjukkan
      // level yang benar-benar akan dipakai adapter.
      contentSchedule: {
        publicMediaBaseUrl: await resolvePostMediaPublicBaseUrl(
          bundle.db,
          options.platform,
        ),
        youtubePrivacyStatus: await resolveYouTubePrivacyStatus(
          bundle.db,
          options.platform,
        ),
        tiktokPrivacyLevel: await resolveTikTokPrivacyLevel(
          bundle.db,
          options.platform,
        ),
      },
    });
    return c.json(body);
  });

  app.put("/admin/settings/:key", async (c) => {
    const key = c.req.param("key");
    if (!isPlatformSettingKey(key)) {
      return apiError(c, 404, "NOT_FOUND", "Unknown platform setting key");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = SetPlatformSettingRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "A non-empty value is required");
    }
    if (parsed.data.value.length > KEY_MAX_LENGTH[key]) {
      return apiError(c, 400, "VALIDATION_ERROR", "Value is too long for this setting");
    }
    // Kunci berbentuk (enum privasi / URL publik): bentuk tidak sah
    // ditolak di sini agar nilai panel selalu bisa dipakai resolver;
    // resolver core tetap memvalidasi ulang sebagai lapis kedua.
    if (!isValidPlatformSettingValue(key, parsed.data.value)) {
      return apiError(c, 400, "VALIDATION_ERROR", "Value is not valid for this setting");
    }
    try {
      await setPlatformSetting(
        bundle.db,
        {
          key,
          value: parsed.data.value,
          updatedByUserId: c.get("appUser").id,
        },
        options.platform,
      );
    } catch (err) {
      if (err instanceof PlatformSettingsUnavailableError) {
        return apiError(
          c,
          503,
          "INTERNAL_ERROR",
          "Platform settings storage is not configured on this server",
        );
      }
      throw err;
    }
    return c.json(await statusFor(key));
  });

  app.delete("/admin/settings/:key", async (c) => {
    const key = c.req.param("key");
    if (!isPlatformSettingKey(key)) {
      return apiError(c, 404, "NOT_FOUND", "Unknown platform setting key");
    }
    await clearPlatformSetting(bundle.db, {
      key,
      updatedByUserId: c.get("appUser").id,
    });
    return c.json(await statusFor(key));
  });

  app.post("/admin/settings/:key/test", async (c) => {
    const key = c.req.param("key");
    if (!isPlatformSettingKey(key)) {
      return apiError(c, 404, "NOT_FOUND", "Unknown platform setting key");
    }
    if (!TESTABLE_KEYS.has(key)) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "This setting does not have a connection test",
      );
    }

    let result: ProbeResult;
    if (key === "openrouter_api_key") {
      const effective = await getProviderSecret(
        bundle.db,
        "openrouter_api_key",
        options.platform,
      );
      result = await probeOpenRouterKey(effective);
    } else if (key === "resend_api_key") {
      const effective = await getProviderSecret(
        bundle.db,
        "resend_api_key",
        options.platform,
      );
      result = await probeResendKey(effective, options.resendApiBase);
    } else {
      const [accessKeyId, secretAccessKey] = await Promise.all([
        getProviderSecret(bundle.db, "r2_access_key_id", options.platform),
        getProviderSecret(bundle.db, "r2_secret_access_key", options.platform),
      ]);
      // Target probe = identitas efektif SAAT INI (resolver, bukan
      // nilai boot): uji koneksi harus menguji bucket yang benar-
      // benar akan dipakai konsumen setelah perubahan panel.
      const identity = await resolveR2Identity(bundle.db, options.platform);
      result = await probeR2Bucket(
        { accessKeyId, secretAccessKey },
        { endpoint: identity.endpoint, bucket: identity.bucket },
      );
    }

    await recordPlatformSettingTest(bundle.db, {
      key,
      actorUserId: c.get("appUser").id,
      ok: result.ok,
      code: result.code,
    });

    const body = PlatformSettingTestResultSchema.parse({
      key,
      ok: result.ok,
      code: result.code,
      ...(result.info ? { info: result.info } : {}),
    });
    return c.json(body);
  });

  // Konsol operasi (Ringkasan, Tenant, Pengguna, Operasional, Sistem).
  // Didaftarkan DI SINI, setelah kedua gerbang di atas terpasang pada
  // "/admin/*", supaya route baru tidak mungkin lupa digerbangi.
  registerAdminConsoleRoutes(app, bundle, options.platformAdminEmails);

  return app;
}
