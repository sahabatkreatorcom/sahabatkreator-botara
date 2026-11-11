import { z } from "zod";

// ---------------------------------------------------------------------------
// Panel Admin Platform (Fase 6C) — kredensial provider milik PLATFORM,
// dikelola pemilik platform (allowlist env PLATFORM_ADMIN_EMAILS), BUKAN
// pengaturan tenant. Nilai rahasia TIDAK PERNAH muncul dalam kontrak mana
// pun: yang dipertukarkan hanya status (isSet + sumber efektif), aksi
// set/clear, dan hasil uji koneksi non-rahasia. Resolusi server: panel
// dulu, env fallback (urutan yang diminta pemilik platform).
// ---------------------------------------------------------------------------

export const PlatformSettingKeySchema = z.enum([
  "openrouter_api_key",
  "openrouter_model",
  "r2_access_key_id",
  "r2_secret_access_key",
  // Identitas R2 BUKAN rahasia (instruksi pemilik 2026-11-12): account
  // id, endpoint, dan bucket kini juga diisi lewat panel agar satu grup
  // dengan kredensial R2 + base URL media publik — pola identifier
  // publik Meta (nilai efektif ditampilkan lewat PlatformR2Info).
  // Resolusi: panel → env (khusus bucket: R2_BUCKET) → bawaan kode
  // (konstanta account id / turunan endpoint / logika resolveR2Bucket).
  "r2_account_id",
  "r2_endpoint",
  "r2_bucket",
  // Fase 7A.1: App Secret Meta App platform — memverifikasi tanda tangan
  // webhook Instagram/Messenger. Sengaja TANPA uji koneksi: Meta tidak
  // menyediakan validasi app secret yang berdiri sendiri.
  "meta_app_secret",
  // Fase 7D: identifier PUBLIK Meta untuk OAuth — BUKAN rahasia (App ID
  // tampil di setiap URL dialog; config ID diakui Meta bukan rahasia).
  // Berbeda dari kunci lain, nilainya DITAMPILKAN di UI admin lewat
  // PlatformMetaInfo agar bisa diverifikasi pemilik platform.
  "meta_app_id",
  "meta_ig_config_id",
  "meta_wa_config_id",
  // Kredensial APLIKASI Threads milik platform — aplikasi TERPISAH
  // dari Meta App utama, dengan OAuth & review-nya sendiri.
  // `threads_app_id` identifier PUBLIK (nilainya ditampilkan panel
  // lewat PlatformThreadsInfo, pola meta_app_id); `threads_app_secret`
  // RAHASIA (pola meta_app_secret: hanya status yang dipertukarkan).
  // Untuk connect/OAuth Threads kelak; penerbitan saat ini memakai
  // token per akun tenant.
  "threads_app_id",
  "threads_app_secret",
  // Fase 11B: email transaksional via Resend (keputusan user 2026-11-02).
  // `resend_api_key` adalah RAHASIA (pola kunci lain: status saja yang
  // dipertukarkan). `resend_from_email` / `resend_from_name` adalah
  // identitas pengirim — BUKAN rahasia; nilai efektifnya ditampilkan di
  // panel lewat PlatformEmailInfo agar bisa diverifikasi pemilik.
  "resend_api_key",
  "resend_from_email",
  "resend_from_name",
  // Fase 13G: klien OAuth Google milik PLATFORM untuk sinkronisasi
  // Google Calendar tenant. `google_oauth_client_id` adalah identifier
  // PUBLIK (tampil di setiap URL dialog OAuth Google, sama seperti
  // Meta App ID) — nilainya ditampilkan panel lewat PlatformGoogleInfo.
  // `google_oauth_client_secret` adalah RAHASIA (pola kunci lain:
  // hanya status yang dipertukarkan). Keduanya dibuat pemilik platform
  // di Google Cloud Console; tanpa keduanya tombol Hubungkan Google
  // menjawab GOOGLE_NOT_CONFIGURED secara jujur (pola Resend 11B).
  "google_oauth_client_id",
  "google_oauth_client_secret",
  // Instruksi pemilik 2026-11-12: semua kredensial integrasi diisi lewat
  // Panel Admin, env hanya fallback. `meta_webhook_verify_token` adalah
  // token handshake webhook Meta (nilai yang KITA tentukan) — RAHASIA
  // bersama dengan dashboard Meta App; pola kunci lain (hanya status).
  // `openrouter_embedding_model` adalah nama model (bukan rahasia, pola
  // openrouter_model: hanya status yang dipertukarkan di daftar ini).
  "meta_webhook_verify_token",
  "openrouter_embedding_model",
  // Pengaturan content schedule — BUKAN kredensial, tetapi nilai
  // platform yang diubah pemilik dari panel yang sama agar konsisten.
  // Nilai efektif ketiganya DITAMPILKAN lewat PlatformContentScheduleInfo
  // (base URL publik menurut definisinya publik; dua status privasi
  // adalah enum yang harus terlihat level berlakunya).
  "post_media_public_base_url",
  "youtube_privacy_status",
  "tiktok_privacy_level",
]);
export type PlatformSettingKey = z.infer<typeof PlatformSettingKeySchema>;

export const PlatformSettingStatusSchema = z.object({
  key: PlatformSettingKeySchema,
  /** True bila ada nilai efektif (panel atau env). */
  isSet: z.boolean(),
  /** Sumber nilai efektif; null bila belum diatur di mana pun. */
  source: z.enum(["panel", "env"]).nullable(),
  /** Waktu ubah terakhir di panel (ISO); null bila bukan dari panel. */
  updatedAt: z.string().datetime().nullable(),
  /** Email user yang terakhir mengubah nilai panel; null bila bukan dari panel. */
  updatedBy: z.string().nullable(),
});
export type PlatformSettingStatus = z.infer<
  typeof PlatformSettingStatusSchema
>;

/**
 * Info R2 BUKAN rahasia yang ditampilkan panel: identitas efektif
 * (panel → env → bawaan kode) hasil `resolveR2Identity` di core —
 * selalu terisi penuh karena resolver menerapkan bawaan yang sama
 * seperti sebelum panel ada (account id konstanta, endpoint turunan,
 * bucket hasil logika resolveR2Bucket).
 */
export const PlatformR2InfoSchema = z.object({
  accountId: z.string(),
  endpoint: z.string(),
  /** Bucket yang akan dipakai konsumen R2 & target uji koneksi. */
  bucket: z.string(),
});
export type PlatformR2Info = z.infer<typeof PlatformR2InfoSchema>;

/**
 * Info Meta BUKAN rahasia (Fase 7D): nilai efektif App ID + config ID
 * (panel → env) DITAMPILKAN agar pemilik bisa memverifikasinya — ketiganya
 * identifier publik, bukan kredensial. `oauthRedirectUri` adalah callback
 * tunggal yang harus didaftarkan persis di Meta App (Facebook Login /
 * konfigurasi Login for Business).
 */
export const PlatformMetaInfoSchema = z.object({
  appId: z.string().nullable(),
  igConfigId: z.string().nullable(),
  waConfigId: z.string().nullable(),
  oauthRedirectUri: z.string(),
});
export type PlatformMetaInfo = z.infer<typeof PlatformMetaInfoSchema>;

/**
 * Info Threads BUKAN rahasia: App ID aplikasi Threads efektif
 * (panel → env) DITAMPILKAN agar pemilik bisa memverifikasinya —
 * identifier publik, pola PlatformMetaInfo. App Secret TIDAK PERNAH
 * muncul di kontrak mana pun.
 */
export const PlatformThreadsInfoSchema = z.object({
  appId: z.string().nullable(),
});
export type PlatformThreadsInfo = z.infer<typeof PlatformThreadsInfoSchema>;

/**
 * Info email BUKAN rahasia (Fase 11B): identitas pengirim Resend efektif
 * (panel → env) DITAMPILKAN agar pemilik bisa memverifikasinya. Kunci
 * API Resend sendiri rahasia dan tidak pernah muncul di kontrak mana pun
 * (hanya statusnya, seperti kunci lain).
 */
export const PlatformEmailInfoSchema = z.object({
  fromEmail: z.string().nullable(),
  fromName: z.string().nullable(),
});
export type PlatformEmailInfo = z.infer<typeof PlatformEmailInfoSchema>;

/**
 * Info Google BUKAN rahasia (Fase 13G): Client ID OAuth Google efektif
 * (panel → env) DITAMPILKAN agar pemilik bisa memverifikasinya — Client
 * ID identifier publik (muncul di URL dialog). `oauthRedirectUri`
 * adalah callback yang harus didaftarkan PERSIS di Google Cloud
 * Console (APIs & Services → Credentials → OAuth client → Authorized
 * redirect URIs). Client secret TIDAK PERNAH muncul di kontrak.
 */
export const PlatformGoogleInfoSchema = z.object({
  clientId: z.string().nullable(),
  oauthRedirectUri: z.string(),
});
export type PlatformGoogleInfo = z.infer<typeof PlatformGoogleInfoSchema>;

/**
 * Info content schedule BUKAN rahasia: nilai efektif pengaturan
 * publikasi multi-platform (panel → env) DITAMPILKAN agar pemilik bisa
 * memverifikasi level yang sedang berlaku. Dua status privasi selalu
 * terisi karena server menerapkan bawaan aman yang sama seperti env
 * (YouTube `private`, TikTok `SELF_ONLY`) bila belum diatur di mana pun.
 */
export const PlatformContentScheduleInfoSchema = z.object({
  publicMediaBaseUrl: z.string().nullable(),
  youtubePrivacyStatus: z.enum(["private", "unlisted", "public"]),
  tiktokPrivacyLevel: z.enum([
    "PUBLIC_TO_EVERYONE",
    "MUTUAL_FOLLOW_FRIENDS",
    "FOLLOWER_OF_CREATOR",
    "SELF_ONLY",
  ]),
});
export type PlatformContentScheduleInfo = z.infer<
  typeof PlatformContentScheduleInfoSchema
>;

export const PlatformSettingsResponseSchema = z.object({
  settings: z.array(PlatformSettingStatusSchema),
  r2: PlatformR2InfoSchema,
  meta: PlatformMetaInfoSchema,
  threads: PlatformThreadsInfoSchema,
  email: PlatformEmailInfoSchema,
  google: PlatformGoogleInfoSchema,
  contentSchedule: PlatformContentScheduleInfoSchema,
});
export type PlatformSettingsResponse = z.infer<
  typeof PlatformSettingsResponseSchema
>;

export const SetPlatformSettingRequestSchema = z.object({
  /** Nilai baru; string kosong ditolak (gunakan DELETE untuk mengosongkan). */
  value: z.string().trim().min(1).max(1024),
});
export type SetPlatformSettingRequest = z.infer<
  typeof SetPlatformSettingRequestSchema
>;

/**
 * Hasil uji koneksi — selalu 200 untuk kegagalan upstream (ok=false +
 * kode stabil), karena "uji" adalah operasi baca yang hasilnya memang
 * bisa "tidak tersambung". `info` hanya berisi data NON-rahasia dari
 * provider (mis. label & sisa limit kunci OpenRouter).
 */
export const PlatformSettingTestResultSchema = z.object({
  key: PlatformSettingKeySchema,
  ok: z.boolean(),
  /** Kode hasil stabil, mis. OK | NOT_CONFIGURED | OPENROUTER_AUTH_FAILED | OPENROUTER_UNREACHABLE | R2_AUTH_FAILED | R2_BUCKET_NOT_FOUND | R2_UNREACHABLE. */
  code: z.string(),
  info: z.record(z.string(), z.unknown()).optional(),
});
export type PlatformSettingTestResult = z.infer<
  typeof PlatformSettingTestResultSchema
>;
