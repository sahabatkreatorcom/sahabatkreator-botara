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
  listPlatformSettingStatuses,
  recordPlatformSettingTest,
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
  /** Info R2 bukan rahasia (dari @sahabat-kreator/config) untuk status & probe. */
  r2: { accountId: string; endpoint: string; bucket: string };
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
   * Redirect URI OAuth Google (Fase 13G) — callback yang ditampilkan
   * read-only di grup Google panel agar pemilik mendaftarkannya persis
   * di Google Cloud Console. Dihitung dari BETTER_AUTH_URL oleh pemanggil.
   */
  googleOAuthRedirectUri?: string;
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
  meta_app_secret: 512,
  // Fase 7D: identifier publik Meta (App ID + config ID Login for
  // Business) — pendek, bukan kredensial; nilainya DITAMPILKAN di panel.
  meta_app_id: 128,
  meta_ig_config_id: 128,
  meta_wa_config_id: 128,
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
      r2: options.r2,
      meta: {
        appId: publicConfig.meta_app_id,
        igConfigId: publicConfig.meta_ig_config_id,
        waConfigId: publicConfig.meta_wa_config_id,
        oauthRedirectUri: options.metaOAuthRedirectUri ?? "",
      },
      // Fase 11B: identitas pengirim email efektif (panel → env) —
      // publik menurut sifatnya, ditampilkan untuk verifikasi pemilik.
      email: {
        fromEmail: publicConfig.resend_from_email,
        fromName: publicConfig.resend_from_name,
      },
      // Fase 13G: Client ID OAuth Google efektif (publik) + redirect
      // URI yang harus didaftarkan persis di Google Cloud Console.
      google: {
        clientId: publicConfig.google_oauth_client_id,
        oauthRedirectUri: options.googleOAuthRedirectUri ?? "",
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
      result = await probeR2Bucket(
        { accessKeyId, secretAccessKey },
        { endpoint: options.r2.endpoint, bucket: options.r2.bucket },
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
