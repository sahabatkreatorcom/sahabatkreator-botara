import type { PlatformSettingKey } from "@sahabat-kreator/contracts";

/**
 * Registry kartu Panel Admin per platform (permintaan pemilik
 * 2026-11-12, referensi UI tangkapan layar): halaman admin ditata
 * sebagai GRID KARTU — satu kartu per platform/layanan — menggantikan
 * daftar grup vertikal lama. Modul ini MURNI (tanpa React) agar
 * pemetaan kunci → kartu bisa dibuktikan test:
 *
 *  - SETIAP kunci `PlatformSettingKey` muncul di TEPAT SATU kartu —
 *    tidak ada kunci yang hilang dari panel dan tidak ada yang ganda.
 *  - Grup lama "Content schedule" TIDAK diteruskan sebagai grup:
 *    isinya tersebar ke kartu pemiliknya — `post_media_public_base_url`
 *    ke kartu R2 (alamat publik bucket yang sama), dan dua kunci
 *    privasi ke kartu platform masing-masing.
 *  - Koreksi pemilik 2026-11-12: kunci privasi TIDAK dicabut dari
 *    panel. Nilai panel adalah DEFAULT penerbitan; pengguna dapat
 *    menimpanya per postingan di formulir /posts. Karena itu
 *    `youtube_privacy_status` tampil di kartu YouTube dan
 *    `tiktok_privacy_level` di kartu TikTok dengan label "Privasi
 *    bawaan postingan" — kunci & resolver yang sama, hanya penempatan
 *    + label yang berubah.
 *
 * URL kanonis di bawah mengikuti skema gelombang penyeragaman URL:
 * callback OAuth `/api/oauth/<provider>/callback` dan webhook
 * `/api/webhooks/<...>`. Kartu menampilkannya di atas origin publik
 * aplikasi saat ini (pola baris URL legal yang sudah ada di halaman
 * ini); untuk Meta & layanan Google, URL dari info server (dihitung
 * dari BETTER_AUTH_URL) tetap diutamakan bila tersedia.
 */

export type AdminCardId =
  | "meta"
  | "threads"
  | "tiktok"
  | "linkedin"
  | "pinterest"
  | "google-calendar"
  | "youtube"
  | "google-business"
  | "google-shared"
  | "r2"
  | "openrouter"
  | "resend";

export interface AdminCardFieldSpec {
  key: PlatformSettingKey;
  /**
   * True = input password (kredensial rahasia — nilai tersimpan tidak
   * pernah dirender); false = teks biasa (identifier publik / nama
   * model / enum privasi).
   */
  secret: boolean;
  /**
   * True = sesudah kartu disimpan, muat ulang seluruh data halaman
   * agar tampilan nilai efektif (identifier publik, identitas R2,
   * level privasi efektif) segar — pola grup identifier yang lama.
   */
  reloadOnChange?: boolean;
}

export interface AdminCardSpec {
  id: AdminCardId;
  fields: readonly AdminCardFieldSpec[];
  /**
   * Kunci yang menentukan lencana status kartu: kartu "Aktif" bila
   * semua kunci ini punya nilai efektif (panel atau env). Untuk kartu
   * layanan Google, halaman menimpanya dengan perhitungan efektif
   * (pasangan per-layanan ATAU pasangan bersama) — lihat AdminPage.
   */
  requiredKeys: readonly PlatformSettingKey[];
  /** Path callback OAuth kanonis kartu ini (tanpa origin); bila ada. */
  callbackPath?: string;
  /** Path webhook kanonis kartu ini (tanpa origin); bila ada. */
  webhookPaths?: readonly string[];
}

const pub = (key: PlatformSettingKey): AdminCardFieldSpec => ({
  key,
  secret: false,
  reloadOnChange: true,
});
const sec = (key: PlatformSettingKey): AdminCardFieldSpec => ({
  key,
  secret: true,
});

/** Path callback OAuth kanonis per provider (gelombang URL). */
export const OAUTH_CALLBACK_PATHS = {
  meta: "/api/oauth/meta/callback",
  threads: "/api/oauth/threads/callback",
  tiktok: "/api/oauth/tiktok/callback",
  linkedin: "/api/oauth/linkedin/callback",
  pinterest: "/api/oauth/pinterest/callback",
  googleCalendar: "/api/oauth/google_calendar/callback",
  youtube: "/api/oauth/youtube/callback",
  googleBusiness: "/api/oauth/google_business/callback",
} as const;

/** Path webhook kanonis per platform (gelombang URL). */
export const WEBHOOK_PATHS = {
  meta: "/api/webhooks/meta",
  metaDataDeletion: "/api/webhooks/meta/data-deletion",
  whatsapp: "/api/webhooks/whatsapp",
  tiktok: "/api/webhooks/tiktok",
  threads: "/api/webhooks/threads",
} as const;

export const ADMIN_CARDS: readonly AdminCardSpec[] = [
  {
    id: "meta",
    fields: [
      pub("meta_app_id"),
      pub("meta_ig_config_id"),
      pub("meta_wa_config_id"),
      sec("meta_app_secret"),
      sec("meta_webhook_verify_token"),
    ],
    requiredKeys: ["meta_app_id", "meta_app_secret"],
    callbackPath: OAUTH_CALLBACK_PATHS.meta,
    webhookPaths: [
      WEBHOOK_PATHS.meta,
      WEBHOOK_PATHS.whatsapp,
      WEBHOOK_PATHS.metaDataDeletion,
    ],
  },
  {
    id: "threads",
    fields: [
      pub("threads_app_id"),
      sec("threads_app_secret"),
      sec("threads_webhook_verify_token"),
    ],
    requiredKeys: ["threads_app_id", "threads_app_secret"],
    callbackPath: OAUTH_CALLBACK_PATHS.threads,
    webhookPaths: [WEBHOOK_PATHS.threads],
  },
  {
    id: "tiktok",
    fields: [
      pub("tiktok_client_key"),
      sec("tiktok_client_secret"),
      // Privasi bawaan postingan TikTok (default panel; pengguna
      // menimpa per postingan di /posts) — grup Content schedule lama.
      pub("tiktok_privacy_level"),
    ],
    requiredKeys: ["tiktok_client_key", "tiktok_client_secret"],
    callbackPath: OAUTH_CALLBACK_PATHS.tiktok,
    webhookPaths: [WEBHOOK_PATHS.tiktok],
  },
  {
    id: "linkedin",
    fields: [pub("linkedin_client_id"), sec("linkedin_client_secret")],
    requiredKeys: ["linkedin_client_id", "linkedin_client_secret"],
    callbackPath: OAUTH_CALLBACK_PATHS.linkedin,
  },
  {
    id: "pinterest",
    fields: [pub("pinterest_app_id"), sec("pinterest_app_secret")],
    requiredKeys: ["pinterest_app_id", "pinterest_app_secret"],
    callbackPath: OAUTH_CALLBACK_PATHS.pinterest,
  },
  {
    id: "google-calendar",
    fields: [
      pub("google_calendar_client_id"),
      sec("google_calendar_client_secret"),
    ],
    requiredKeys: ["google_calendar_client_id", "google_calendar_client_secret"],
    callbackPath: OAUTH_CALLBACK_PATHS.googleCalendar,
  },
  {
    id: "youtube",
    fields: [
      pub("google_youtube_client_id"),
      sec("google_youtube_client_secret"),
      // Privasi bawaan postingan YouTube (default panel; pengguna
      // menimpa per postingan di /posts) — grup Content schedule lama.
      pub("youtube_privacy_status"),
    ],
    requiredKeys: ["google_youtube_client_id", "google_youtube_client_secret"],
    callbackPath: OAUTH_CALLBACK_PATHS.youtube,
  },
  {
    id: "google-business",
    fields: [
      pub("google_business_client_id"),
      sec("google_business_client_secret"),
    ],
    requiredKeys: [
      "google_business_client_id",
      "google_business_client_secret",
    ],
    callbackPath: OAUTH_CALLBACK_PATHS.googleBusiness,
  },
  {
    // Pasangan klien OAuth Google BERSAMA — fallback ketiga layanan di
    // atas (rantai resolusi per-layanan → bersama). Tanpa callback
    // sendiri: tiap layanan mendaftarkan URI kanonisnya masing-masing.
    id: "google-shared",
    fields: [pub("google_oauth_client_id"), sec("google_oauth_client_secret")],
    requiredKeys: ["google_oauth_client_id", "google_oauth_client_secret"],
  },
  {
    id: "r2",
    fields: [
      pub("r2_account_id"),
      pub("r2_endpoint"),
      pub("r2_bucket"),
      sec("r2_access_key_id"),
      sec("r2_secret_access_key"),
      // Alamat publik bucket yang sama — dari grup Content schedule
      // lama, sudah menyatu ke grup R2 sejak permintaan pemilik
      // sebelumnya dan dipertahankan di kartu ini.
      pub("post_media_public_base_url"),
    ],
    requiredKeys: ["r2_access_key_id", "r2_secret_access_key"],
  },
  {
    id: "openrouter",
    fields: [
      sec("openrouter_api_key"),
      { key: "openrouter_model", secret: false },
      { key: "openrouter_embedding_model", secret: false },
    ],
    requiredKeys: ["openrouter_api_key"],
  },
  {
    id: "resend",
    fields: [
      sec("resend_api_key"),
      pub("resend_from_email"),
      pub("resend_from_name"),
    ],
    requiredKeys: ["resend_api_key", "resend_from_email"],
  },
];

export function adminCardById(id: AdminCardId): AdminCardSpec {
  const card = ADMIN_CARDS.find((c) => c.id === id);
  if (!card) throw new Error(`Kartu admin tidak dikenal: ${id}`);
  return card;
}
