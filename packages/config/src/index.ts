import { z } from "zod";

export {
  createLogger,
  sanitizeLogValue,
  type LogFields,
  type LogLevel,
  type Logger,
  type LoggerOptions,
} from "./logger";

/** Versi aplikasi (semver paket root). */
export const APP_VERSION = "0.1.0";

/**
 * Baseline Meta Graph API: v26.0 (RANCANGAN §12.1).
 * Ter-pin secara eksplisit — TIDAK ada panggilan unversioned ke Meta.
 * Upgrade versi adalah proses terjadwal: cek changelog Meta + contract test.
 */
export const META_GRAPH_API_VERSION = "v26.0" as const;

export const META_GRAPH_API_VERSION_BY_CHANNEL = {
  whatsapp: META_GRAPH_API_VERSION,
  instagram: META_GRAPH_API_VERSION,
  messenger: META_GRAPH_API_VERSION,
} as const;

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Ambang log terstruktur (JSON lines). Default "info"; "debug" hanya
   * untuk investigasi lokal — jangan di produksi karena payload ikut
   * tercetak (nilai sensitif tetap di-redact oleh logger).
   */
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  /**
   * Port apps/realtime (Fase 6G) — gateway WebSocket mandiri. Bind
   * 127.0.0.1 di server; publik menjangkaunya lewat proxy `/realtime`
   * pada web preview (staging) / reverse-proxy (produksi).
   */
  REALTIME_PORT: z.coerce.number().int().positive().default(3103),
  /**
   * Alamat bind gateway WebSocket realtime. Default 127.0.0.1 (deployment
   * bare-metal: nginx di host yang sama menjangkaunya lewat loopback).
   *
   * Di Docker nilainya WAJIB 0.0.0.0: container `realtime` dan `web`
   * (nginx) adalah dua netns berbeda, sehingga 127.0.0.1 di dalam
   * container realtime tidak dapat dijangkau nginx. Bind 0.0.0.0 di sini
   * tetap privat karena port-nya hanya di-publish ke loopback HOST
   * (127.0.0.1:3103) — bukan ke antarmuka publik.
   */
  REALTIME_HOST: z.string().min(1).optional(),
  DATABASE_URL: z.string().url().optional(),
  /** Better Auth (Fase 1B): secret penandatanganan sesi & URL publik aplikasi. */
  BETTER_AUTH_SECRET: z.string().min(16).optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  /** Secret HMAC untuk token sesi pengunjung webchat (Fase 1F). */
  WEBCHAT_SECRET: z.string().min(16).optional(),
  /**
   * Kunci enkripsi kredensial channel (Fase 6A): base64 dari 32 byte acak,
   * dipakai AES-256-GCM untuk token bot Telegram (dan kelak token Meta).
   * Hanya di env server — tidak pernah masuk repo/log.
   */
  CHANNEL_TOKEN_SECRET: z.string().min(16).optional(),
  /**
   * Base URL Telegram Bot API (Fase 6A). Default https://api.telegram.org;
   * override hanya untuk uji mock lokal di staging.
   */
  TELEGRAM_API_BASE: z.string().url().optional(),
  /**
   * Base URL Meta Graph API (Fase 7A). Default https://graph.facebook.com
   * (versi ter-pin v26.0 ditambahkan klien sebagai segmen path); override
   * hanya untuk uji mock lokal di staging — pola yang sama dengan
   * TELEGRAM_API_BASE.
   */
  META_API_BASE: z.string().url().optional(),
  /**
   * Base URL PUBLIK opsional untuk media content schedule: URL final
   * adalah `{base}/{r2Key}`. Dipakai hanya oleh API publikasi yang
   * mewajibkan provider mengambil media dari URL (Instagram/Threads).
   * Endpoint media internal repo tetap privat dan bersesi — JANGAN
   * mengisi nilai ini dengan URL API internal. Kosong berarti adapter
   * container gagal aman dengan kode `*_public_media_url_unavailable`.
   */
  POST_MEDIA_PUBLIC_BASE_URL: z.string().url().optional(),
  /**
   * Base URL Threads API. Default https://graph.threads.net (versi
   * v1.0 ditambahkan klien); override hanya untuk uji mock — pola yang
   * sama dengan META_API_BASE. Threads memakai aplikasi, token, dan
   * permukaan API yang terpisah dari graph.facebook.com.
   */
  THREADS_API_BASE: z.string().url().optional(),
  /**
   * Base URL entryway Bluesky (AT Protocol). Default
   * https://bsky.social — entryway meneruskan panggilan XRPC ke PDS
   * akun; override hanya untuk uji mock atau PDS mandiri — pola yang
   * sama dengan META_API_BASE. Kredensial per akun (app password)
   * tersimpan terenkripsi pada akun channel, bukan di env.
   */
  BLUESKY_API_BASE: z.string().url().optional(),
  /**
   * Base URL LinkedIn API (Posts API). Default https://api.linkedin.com;
   * override hanya untuk uji mock — pola yang sama dengan
   * META_API_BASE/BLUESKY_API_BASE. Versi REST bulanan ter-pin di
   * paket channel-linkedin, bukan di env; kredensial per akun (access
   * token OAuth) tersimpan terenkripsi pada akun channel.
   */
  LINKEDIN_API_BASE: z.string().url().optional(),
  /**
   * Base URL Pinterest API v5. Default https://api.pinterest.com;
   * override hanya untuk uji mock — pola yang sama dengan
   * LINKEDIN_API_BASE. Kredensial per akun (access token OAuth)
   * tersimpan terenkripsi pada akun channel, bukan di env.
   */
  PINTEREST_API_BASE: z.string().url().optional(),
  /**
   * Secret Meta App milik PLATFORM (Fase 7A): memverifikasi tanda tangan
   * `X-Hub-Signature-256` pada webhook /api/meta/webhook. Hanya di env
   * server — tidak pernah masuk repo/log. Belum diset = webhook Meta
   * menjawab 503 META_NOT_CONFIGURED (fail-closed). Nilai staging saat
   * ini PLACEHOLDER dan WAJIB diganti secret Meta App asli sebelum
   * trafik live (lihat docs/DEPLOY-STAGING.md).
   */
  META_APP_SECRET: z.string().min(1).optional(),
  /**
   * Token verifikasi handshake webhook Meta (Fase 7A): nilai bebas yang
   * KITA tentukan dan ditempel pemilik platform ke dashboard Meta App
   * (Webhook > Verify Token). Bukan rahasia dari Meta — ia dibagikan ke
   * owner/admin workspace lewat endpoint meta-webhook-info agar mereka
   * bisa memasang webhook. Hanya di env server.
   */
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
  /**
   * Identifier PUBLIK Meta untuk OAuth (Fase 7D) — FALLBACK env saja;
   * sumber utama adalah Panel Admin (kunci `meta_app_id` /
   * `meta_ig_config_id` / `meta_wa_config_id` di platform_settings).
   * Ketiganya bukan rahasia: App ID muncul di URL dialog OAuth dan
   * config ID diakui Meta bukan rahasia.
   */
  META_APP_ID: z.string().min(1).optional(),
  META_IG_CONFIG_ID: z.string().min(1).optional(),
  META_WA_CONFIG_ID: z.string().min(1).optional(),
  /**
   * Minta izin ENGAGEMENT Page di dialog Messenger
   * (`pages_read_engagement`, `pages_read_user_content`,
   * `pages_manage_engagement`) — dipakai fitur komentar Fase 10B.
   *
   * DEFAULT NONAKTIF, dan itu disengaja. Ketiganya butuh Advanced
   * Access dari App Review; selama aplikasi belum disetujui, Meta
   * MENOLAK dialog Facebook Login dengan "Invalid Scopes" dan
   * koneksi Messenger baru tidak bisa dibuat sama sekali — terbukti
   * live 2026-11-03. Menyalakannya hanya setelah App Review
   * menyetujui ketiga izin (docs/APP-REVIEW.md §0).
   *
   * Tanpa flag ini, moderasi komentar tetap berjalan di mode
   * pengembangan tetapi ditolak Graph untuk Page hasil OAuth biasa —
   * kegagalan yang jujur dan tercatat, bukan dialog mati.
   */
  META_ENGAGEMENT_SCOPES: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  REDIS_URL: z.string().url().optional(),
  /**
   * Pemilihan provider LLM agent (Fase 3A): 'mock' (default, deterministik,
   * tanpa biaya) atau 'openrouter' (model sungguhan via OpenRouter).
   */
  LLM_PROVIDER: z.enum(["mock", "openrouter"]).default("mock"),
  /**
   * Pemilihan provider EMBEDDING untuk retrieval semantik KB (Fase 12D):
   * - tidak diisi (auto): embedding aktif memakai OpenRouter bila ada
   *   kunci efektif (Panel Admin → env), selain itu NONAKTIF dan
   *   retrieval jatuh ke full-text murni;
   * - 'mock': paksa provider mock deterministik (rantai uji — vektor
   *   diturunkan dari hash token + peta konsep kecil, BUKAN model asli);
   * - 'openrouter': paksa OpenRouter (tetap nonaktif-anggun tanpa kunci,
   *   tidak pernah gagal keras seperti LLM_PROVIDER).
   */
  EMBEDDING_PROVIDER: z.enum(["mock", "openrouter"]).optional(),
  /** Model embedding OpenRouter (wajib 1536 dimensi); default di kode provider. */
  OPENROUTER_EMBEDDING_MODEL: z.string().min(1).optional(),
  /**
   * Jendela batching balasan AI (Fase 9A): job `agent.respond` untuk
   * pesan pemicu dijadwalkan worker dengan delay sebesar ini; job yang
   * pesannya sudah disusul pesan masuk yang lebih baru MENYERAH
   * (audit agent.batched) sehingga satu rentetan pesan beruntun hanya
   * dijawab sekali. Trade-off yang disengaja: balasan agent tiba
   * ±satu jendela lebih lambat. 0 = tanpa penundaan (penyerahan tetap
   * mungkin bila pesan berikutnya tiba sebelum job berjalan).
   */
  AGENT_BATCH_WINDOW_MS: z.coerce.number().int().min(0).max(120_000).default(5_000),
  /** Provider AI untuk pengembangan (OpenRouter free tier). Mock LLM adalah default di test. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).optional(),
  /**
   * Panel Admin Platform (Fase 6C): daftar email pemilik platform yang
   * boleh membuka /api/admin/* & halaman /admin — koma-terpisah,
   * pencocokan tidak peka huruf. Kosong = tidak ada admin (panel terkunci).
   * Ini SATU-SATUNYA gerbang admin v1; peran per-tenant tidak terlibat.
   */
  PLATFORM_ADMIN_EMAILS: z.string().min(1).optional(),
  /**
   * Kunci induk enkripsi Panel Admin (Fase 6C): base64 dari 32 byte acak,
   * AES-256-GCM untuk nilai `platform_settings` di DB. Hanya di env server
   * (bootstrap secret) — nilai panel yang ia lindungi TIDAK pernah di env.
   */
  PLATFORM_SETTINGS_SECRET: z.string().min(16).optional(),
  /**
   * Kredensial Cloudflare R2 sebagai FALLBACK env (Fase 6C): sumber utama
   * adalah Panel Admin (tabel platform_settings terenkripsi); env hanya
   * dipakai bila panel kosong untuk kunci itu. Nilai fallback lama dari
   * masa pra-panel; jangan menambah pemasangan baru lewat env.
   */
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** Override nama bucket R2; default diturunkan dari NODE_ENV (lihat R2_BUCKET_NAMES). */
  R2_BUCKET: z.string().min(1).optional(),
  /**
   * Akar penyimpanan media di disk (Fase 18).
   *
   * Dipakai saat bucket R2 belum dipakai untuk media: berkas masuk
   * (foto/dokumen dari pelanggan) dan kelak lampiran keluar disimpan
   * sebagai berkas biasa di bawah direktori ini, dengan key
   * `tenants/{tenantId}/media/{yyyy-mm}/{uuid}`.
   *
   * WAJIB berupa volume yang bertahan antar-deploy. Di container tanpa
   * volume, media hilang setiap kali proses diganti — pesan tetap ada
   * tetapi gambarnya menjadi tautan mati. Lihat docs/PRODUCTION.md.
   */
  MEDIA_STORAGE_ROOT: z.string().min(1).optional(),
  /**
   * Retensi media (Fase 19). `0` atau kosong = SIMPAN SELAMANYA (default).
   *
   * Menyalakannya berarti berkas media yang lebih tua dari N hari
   * dihapus, termasuk foto yang dikirim pelanggan — pesannya tetap ada
   * dan caption-nya tetap terbaca, tetapi lampirannya hilang. Itu
   * keputusan produk, bukan efek samping: karena itu default-nya mati,
   * dan nilainya dibaca dari env supaya bisa diubah tanpa deploy kode.
   *
   * Lampiran milik pesan yang masih `queued` TIDAK ikut dihapus.
   */
  MEDIA_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  /**
   * Email transaksional via Resend (keputusan user 2026-11-02; Fase 11B)
   * — FALLBACK env saja; sumber utama adalah Panel Admin (kunci
   * `resend_api_key` / `resend_from_email` / `resend_from_name` di
   * platform_settings, resolusi panel → env seperti kunci lain).
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().min(1).optional(),
  RESEND_FROM_NAME: z.string().min(1).optional(),
  /**
   * Base URL API Resend (Fase 11B). Default https://api.resend.com di
   * kode klien core; override hanya untuk mock rantai uji — pola yang
   * sama dengan TELEGRAM_API_BASE / META_API_BASE.
   */
  RESEND_API_BASE: z.string().url().optional(),
  /**
   * Base URL API gerbang pembayaran (Fase 14A) — override hanya untuk
   * mock rantai uji, pola yang sama dengan RESEND_API_BASE. Default di
   * kode klien core: Midtrans per environment (app.sandbox.midtrans.com
   * / app.midtrans.com; override berlaku untuk keduanya), Xendit
   * https://api.xendit.co. Kredensialnya sendiri MILIK TENANT
   * (payment_provider_configs terenkripsi), bukan env/panel.
   */
  MIDTRANS_API_BASE: z.string().url().optional(),
  XENDIT_API_BASE: z.string().url().optional(),
  /**
   * Klien OAuth Google milik platform (Fase 13G) — FALLBACK env saja;
   * sumber utama adalah Panel Admin (kunci `google_oauth_client_id` /
   * `google_oauth_client_secret` di platform_settings, resolusi
   * panel → env seperti kunci lain). Client ID bukan rahasia;
   * client secret rahasia penuh dan hanya di env server.
   */
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * Base URL Google untuk mock rantai uji (Fase 13G) — pola yang sama
   * dengan RESEND_API_BASE: GOOGLE_API_BASE (Calendar API + userinfo;
   * default https://www.googleapis.com), GOOGLE_TOKEN_BASE (token
   * endpoint; default https://oauth2.googleapis.com), GOOGLE_AUTH_BASE
   * (dialog authorize; default https://accounts.google.com).
   */
  GOOGLE_API_BASE: z.string().url().optional(),
  GOOGLE_TOKEN_BASE: z.string().url().optional(),
  GOOGLE_AUTH_BASE: z.string().url().optional(),
  /**
   * Status privasi video YouTube hasil content schedule (Gelombang 2).
   * Bawaan `private` DISENGAJA: untuk aplikasi Google yang belum
   * terverifikasi, video yang diunggah lewat API memang dikunci
   * Google ke private — bawaan ini membuat perilaku konsisten dan
   * aman di semua keadaan. Pemilik platform menaikkan ke `unlisted`
   * atau `public` lewat env ini setelah verifikasi aplikasi Google
   * selesai (lihat OWNER-ACTIONS roadmap content schedule).
   */
  YOUTUBE_PRIVACY_STATUS: z
    .enum(["private", "unlisted", "public"])
    .default("private"),
});

/**
 * Cloudflare R2 (keputusan user 2026-11-01) — konfigurasi BUKAN rahasia:
 * account id & nama bucket boleh tampil di UI Panel Admin sebagai info
 * tetap. Endpoint S3-compatible diturunkan dari account id. Yang rahasia
 * hanya Access Key ID + Secret Access Key (panel/env, lihat di atas).
 */
export const R2_ACCOUNT_ID = "bb2c1b6af93981fdd0a97da3b26aa82c";
export const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
export const R2_BUCKET_NAMES = {
  staging: "sahabat-kreator-staging",
  production: "sahabat-kreator-prod",
} as const;

/**
 * Bucket aktif: override env `R2_BUCKET` menang; tanpa override defaultnya
 * bucket STAGING. Sengaja TIDAK diturunkan dari NODE_ENV — di server
 * staging pun NODE_ENV=production (mode runtime), jadi turunan dari sana
 * akan salah sasaran. Deployment production WAJIB men-set R2_BUCKET ke
 * bucket prod secara eksplisit (arah gagal yang aman: ke bucket dev).
 */
export function resolveR2Bucket(override?: string): string {
  return override || R2_BUCKET_NAMES.staging;
}

/**
 * Akar penyimpanan media di disk (Fase 18).
 *
 * Satu fungsi dipakai API (menyajikan) DAN worker (menulis) supaya
 * keduanya tidak bisa menunjuk direktori berbeda — kalau itu terjadi,
 * media tersimpan tetapi tidak pernah bisa ditampilkan, tanpa error.
 * Default relatif terhadap `cwd` proses, yang di deployment mana pun
 * adalah akar aplikasi.
 */
export function resolveMediaStorageRoot(override?: string): string {
  return override || ".data/media";
}

export type Env = z.infer<typeof EnvSchema>;

/**
 * Kunci yang WAJIB ada saat NODE_ENV=production (Hotfix analisis
 * 2026-11-03). Sebelumnya semua kunci `.optional()` sehingga API bisa
 * boot di produksi tanpa secret sesi/enkripsi — kegagalan baru muncul
 * sebagai 503 per request atau, lebih buruk, kredensial channel tak bisa
 * didekripsi. Arah gagal yang benar: tolak boot, sebutkan kuncinya.
 *
 * Yang TIDAK masuk daftar (sengaja): kredensial provider (META_APP_SECRET,
 * RESEND_*, OPENROUTER_*) karena punya jalur Panel Admin + perilaku
 * fail-closed sendiri, dan R2_BUCKET karena default-nya sudah aman
 * (bucket staging) — lihat resolveR2Bucket.
 */
export const PRODUCTION_REQUIRED_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CHANNEL_TOKEN_SECRET",
  "WEBCHAT_SECRET",
  "PLATFORM_SETTINGS_SECRET",
] as const satisfies readonly (keyof Env)[];

/**
 * Buang kunci yang nilainya string kosong SEBELUM validasi.
 *
 * Alasannya: `.env` gaya shell (`set -a; . ./.env`) dan systemd
 * `EnvironmentFile` sama-sama mengekspor `KUNCI=` sebagai string kosong,
 * bukan menghilangkannya. Bagi zod itu nilai yang HADIR — sehingga
 * `.optional()` tidak berlaku dan `z.string().url()` / `.min(1)` menolak
 * `""`. Akibatnya berkas yang menyalin `.env.example` apa adanya (banyak
 * kunci sengaja dibiarkan kosong) membuat API gagal boot dengan puluhan
 * error yang membingungkan, padahal maksudnya "tidak diset".
 *
 * Konvensi yang dipakai di sini: kosong = tidak diset. Untuk kunci wajib,
 * `PRODUCTION_REQUIRED_KEYS` tetap menolak boot — jadi fail-closed tidak
 * berubah, hanya pesannya yang lebih jujur.
 */
function stripEmptyValues(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Parse & validasi env; gagal cepat (throw) bila ada nilai yang tidak valid.
 * Di produksi juga menolak boot bila kunci kritikal belum diisi.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.parse(stripEmptyValues(source));
  if (parsed.NODE_ENV === "production") {
    const missing = PRODUCTION_REQUIRED_KEYS.filter((key) => !parsed[key]);
    if (missing.length > 0) {
      throw new Error(
        `[config] env produksi tidak lengkap — wajib diisi: ${missing.join(", ")}. ` +
          "API menolak boot tanpa kunci ini (fail-closed). Lihat .env.example.",
      );
    }
  }
  return parsed;
}
