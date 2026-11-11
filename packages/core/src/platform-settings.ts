import { eq, sql } from "drizzle-orm";
import {
  auditLogs,
  platformSettings,
  users,
  type Database,
} from "@sahabat-kreator/db";
import {
  decryptChannelSecret,
  encryptChannelSecret,
} from "./channel-secrets";
import type { DbTx } from "./tx";

/**
 * Panel Admin Platform (Fase 6C) — kredensial provider milik PLATFORM.
 *
 * Usulan user: kunci provider (OpenRouter, R2, Meta) diisi pemilik platform
 * lewat dashboard admin, env hanya fallback. Modul ini adalah satu-satunya
 * jalan aplikasi menyentuh tabel `platform_settings`:
 *
 * - GERBANG: tabel BUKAN tenant-scoped dan RLS-nya fail-closed. Semua
 *   akses di sini berjalan dalam transaksi yang men-set flag
 *   transaction-local `app.platform_settings = 'admin'` (pola
 *   system_relay, migrasi 0008/0022). Flag hanya boleh di-set untuk
 *   pemanggil yang sudah lolos gerbang platform-admin di lapisan API
 *   (allowlist env `PLATFORM_ADMIN_EMAILS`) atau resolver internal —
 *   helper ini sendiri tidak tahu HTTP/sesi.
 * - ENKRIPSI: nilai disimpan sebagai envelope AES-256-GCM `v1:` (helper
 *   yang sama dengan kredensial channel, Fase 6A) dengan kunci induk env
 *   `PLATFORM_SETTINGS_SECRET` — satu-satunya rahasia yang tetap di env
 *   (bootstrap). Nilai TIDAK PERNAH dikembalikan oleh fungsi status, tidak
 *   masuk log, dan tidak masuk audit (audit hanya mencatat key + aksi).
 * - RESOLUSI: `getProviderSecret` = panel dulu, env fallback, else null
 *   (persis urutan yang diminta user). Hasil di-cache per proses ±60
 *   detik agar perubahan panel berlaku tanpa restart; set/clear membuang
 *   entri cache kunci itu seketika di proses yang sama.
 */

// ---------------------------------------------------------------------------
// Kunci yang dikelola panel (v1)
// ---------------------------------------------------------------------------

export const PLATFORM_SETTING_KEYS = [
  "openrouter_api_key",
  "openrouter_model",
  "r2_access_key_id",
  "r2_secret_access_key",
  // Fase 7A.1: App Secret Meta App platform (verifikasi tanda tangan
  // webhook Meta) ikut dikelola panel; env META_APP_SECRET hanya fallback
  // (di staging saat ini placeholder acak sampai pemilik mengisi panel).
  "meta_app_secret",
  // Fase 7D: identifier PUBLIK Meta untuk OAuth — BUKAN rahasia. App ID
  // tampil di setiap URL dialog OAuth; config ID (konfigurasi Unified
  // Login IG & Embedded Signup WA) diakui dokumentasi Meta bukan
  // rahasia. Ketiganya tetap disimpan lewat mekanisme panel yang sama
  // (enkripsi tidak merugikan), tetapi NILAINYA boleh ditampilkan di UI
  // admin lewat `getPlatformPublicConfig` — perlakuan yang sengaja
  // berbeda dari kunci rahasia di atas, yang nilainya tidak pernah
  // keluar dari modul ini.
  "meta_app_id",
  "meta_ig_config_id",
  "meta_wa_config_id",
  // Fase 11B: email transaksional Resend (keputusan user 2026-11-02).
  // resend_api_key = rahasia (tidak pernah keluar dari modul ini);
  // resend_from_email / resend_from_name = identitas pengirim, BUKAN
  // rahasia — lihat PLATFORM_PUBLIC_CONFIG_KEYS di bawah.
  "resend_api_key",
  "resend_from_email",
  "resend_from_name",
  // Fase 13G: klien OAuth Google milik platform untuk sinkronisasi
  // Google Calendar tenant. client_id BUKAN rahasia (identifier publik
  // di URL dialog OAuth — lihat PLATFORM_PUBLIC_CONFIG_KEYS);
  // client_secret RAHASIA seperti kunci lain. Keduanya dibuat pemilik
  // platform di Google Cloud Console; tanpa keduanya fitur Hubungkan
  // Google menjawab GOOGLE_NOT_CONFIGURED secara jujur (pola Resend).
  "google_oauth_client_id",
  "google_oauth_client_secret",
  // Instruksi pemilik 2026-11-12: SEMUA kredensial integrasi platform
  // diisi lewat Panel Admin, env hanya fallback — kunci-kunci di bawah
  // menutup sisa pembacaan env langsung agar perlakuannya konsisten.
  // Token verifikasi handshake webhook Meta: nilai bebas yang KITA
  // tentukan dan ditempel pemilik ke dashboard Meta App. Dulu env-only
  // (META_WEBHOOK_VERIFY_TOKEN); sekarang panel dengan env fallback.
  // Ia tetap dibagikan ke owner/admin workspace lewat endpoint
  // meta-webhook-info (memang harus diketahui pemasang webhook), tetapi
  // tidak pernah ditampilkan di panel sebagai konfigurasi publik.
  "meta_webhook_verify_token",
  // Model embedding OpenRouter: dulu env-only (OPENROUTER_EMBEDDING_MODEL)
  // padahal model LLM chat-nya (openrouter_model) sudah panel sejak 6C.
  "openrouter_embedding_model",
  // Pengaturan content schedule (bukan kredensial, tetapi nilai platform
  // yang pemilik ubah dari tempat yang sama agar konsisten — lihat
  // PLATFORM_PUBLIC_CONFIG_KEYS untuk sifat tampilnya):
  // - base URL publik media untuk adapter yang mewajibkan URL publik
  //   (Instagram/Threads/Google Business/Pinterest); dulu env-only
  //   (POST_MEDIA_PUBLIC_BASE_URL).
  // - status privasi bawaan unggahan YouTube; dulu env-only
  //   (YOUTUBE_PRIVACY_STATUS) — pemilik menaikkannya dari panel setelah
  //   verifikasi aplikasi Google, tanpa edit env + restart.
  // - level privasi direct post TikTok; dulu env-only
  //   (TIKTOK_PRIVACY_LEVEL) — gerbang audit TikTok, pola yang sama.
  "post_media_public_base_url",
  "youtube_privacy_status",
  "tiktok_privacy_level",
] as const;

/** Kunci platform yang nilainya identifier PUBLIK (Fase 7D, lihat atas). */
export const PLATFORM_PUBLIC_CONFIG_KEYS = [
  "meta_app_id",
  "meta_ig_config_id",
  "meta_wa_config_id",
  // Fase 11B: identitas pengirim email (nama + alamat tampil di setiap
  // email yang diterima orang — memang publik menurut sifatnya).
  "resend_from_email",
  "resend_from_name",
  // Fase 13G: Client ID OAuth Google — identifier publik yang tampil
  // di setiap URL dialog OAuth Google (sifatnya sama seperti Meta App
  // ID). Client secret TIDAK ikut: rahasia penuh seperti kunci lain.
  "google_oauth_client_id",
  // Pengaturan content schedule: base URL publik menurut definisinya
  // PUBLIK (itulah gunanya — provider mengambil media dari sana), dan
  // dua status privasi adalah pilihan enum yang memang harus terlihat
  // agar pemilik sadar level yang sedang berlaku (mis. TikTok masih
  // SELF_ONLY selama audit belum lolos). Ketiganya ditampilkan panel
  // lewat getPlatformPublicConfig. meta_webhook_verify_token TIDAK
  // ikut: token itu dibagikan hanya lewat endpoint meta-webhook-info
  // ke owner/admin workspace, bukan daftar konfigurasi publik panel.
  "post_media_public_base_url",
  "youtube_privacy_status",
  "tiktok_privacy_level",
] as const;

export type PlatformPublicConfigKey =
  (typeof PLATFORM_PUBLIC_CONFIG_KEYS)[number];

export type PlatformPublicConfig = Record<PlatformPublicConfigKey, string | null>;

/**
 * Nilai efektif identifier publik Meta (panel → env → null per kunci).
 * Berbeda dari kunci rahasia: fungsi ini MEMANG mengembalikan nilai,
 * karena App ID & config ID bukan kredensial — UI admin menampilkannya
 * agar pemilik platform bisa memverifikasi isian panelnya, dan endpoint
 * info OAuth membagikannya ke UI connect (URL dialog dibangun server,
 * tetapi identifier-nya sendiri publik). Fase 11B: identitas pengirim
 * email Resend ikut dikembalikan dari fungsi yang sama (sifatnya sama:
 * nilai tampil, bukan rahasia).
 */
export async function getPlatformPublicConfig(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<PlatformPublicConfig> {
  const [
    appId,
    igConfigId,
    waConfigId,
    resendFromEmail,
    resendFromName,
    googleClientId,
    postMediaPublicBaseUrl,
    youtubePrivacyStatus,
    tiktokPrivacyLevel,
  ] = await Promise.all([
    getProviderSecret(db, "meta_app_id", opts),
    getProviderSecret(db, "meta_ig_config_id", opts),
    getProviderSecret(db, "meta_wa_config_id", opts),
    getProviderSecret(db, "resend_from_email", opts),
    getProviderSecret(db, "resend_from_name", opts),
    getProviderSecret(db, "google_oauth_client_id", opts),
    getProviderSecret(db, "post_media_public_base_url", opts),
    getProviderSecret(db, "youtube_privacy_status", opts),
    getProviderSecret(db, "tiktok_privacy_level", opts),
  ]);
  return {
    meta_app_id: appId,
    meta_ig_config_id: igConfigId,
    meta_wa_config_id: waConfigId,
    resend_from_email: resendFromEmail,
    resend_from_name: resendFromName,
    google_oauth_client_id: googleClientId,
    post_media_public_base_url: postMediaPublicBaseUrl,
    youtube_privacy_status: youtubePrivacyStatus,
    tiktok_privacy_level: tiktokPrivacyLevel,
  };
}

export type PlatformSettingKey = (typeof PLATFORM_SETTING_KEYS)[number];

export function isPlatformSettingKey(
  value: string,
): value is PlatformSettingKey {
  return (PLATFORM_SETTING_KEYS as readonly string[]).includes(value);
}

/** Sumber nilai efektif sebuah kunci. */
export type PlatformSettingSource = "panel" | "env";

export interface PlatformSettingStatus {
  key: PlatformSettingKey;
  /** True bila ada nilai efektif (panel atau env). */
  isSet: boolean;
  /** Sumber nilai efektif; null bila belum diatur di mana pun. */
  source: PlatformSettingSource | null;
  /** Waktu ubah terakhir di panel; null bila nilai efektif bukan dari panel. */
  updatedAt: Date | null;
  /** Email user yang terakhir mengubah nilai panel; null bila bukan dari panel. */
  updatedBy: string | null;
}

export interface PlatformSettingsOptions {
  /**
   * Kunci induk enkripsi (env PLATFORM_SETTINGS_SECRET, base64 32 byte).
   * Tanpa ini panel tidak bisa dibaca/ditulis (resolver jatuh ke env).
   */
  masterSecret?: string;
  /** Nilai fallback per kunci dari env proses pemanggil. */
  env: Partial<Record<PlatformSettingKey, string | undefined>>;
}

/** Panel tidak bisa dipakai (kunci induk env belum terpasang). */
export class PlatformSettingsUnavailableError extends Error {
  constructor(message = "PLATFORM_SETTINGS_SECRET tidak tersedia di env") {
    super(message);
    this.name = "PlatformSettingsUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Allowlist platform-admin (v1)
// ---------------------------------------------------------------------------

/** Parse allowlist env `PLATFORM_ADMIN_EMAILS` (koma-terpisah) → set huruf kecil. */
export function parsePlatformAdminEmails(
  raw: string | undefined,
): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/** True bila email user sesi ada di allowlist platform-admin (case-insensitive). */
export function isPlatformAdminEmail(
  email: string,
  rawAllowlist: string | undefined,
): boolean {
  if (!email) return false;
  return parsePlatformAdminEmails(rawAllowlist).has(email.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Transaksi ber-flag — SATU-SATUNYA cara menyentuh data platform
// ---------------------------------------------------------------------------

async function withPlatformAdminTx<T>(
  db: Database,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.platform_settings', 'admin', true)`,
    );
    return fn(tx as unknown as DbTx);
  });
}

async function insertPlatformAudit(
  tx: DbTx,
  actorUserId: string,
  action: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId: null,
    actorType: "user",
    actorId: actorUserId,
    action,
    meta,
  });
}

// ---------------------------------------------------------------------------
// Status (TIDAK PERNAH memuat nilai)
// ---------------------------------------------------------------------------

interface PanelRowInfo {
  updatedAt: Date;
  updatedByEmail: string | null;
}

async function readPanelRowInfos(
  db: Database,
): Promise<Map<PlatformSettingKey, PanelRowInfo>> {
  return withPlatformAdminTx(db, async (tx) => {
    const rows = await tx
      .select({
        key: platformSettings.key,
        updatedAt: platformSettings.updatedAt,
        updatedByEmail: users.email,
      })
      .from(platformSettings)
      .leftJoin(users, eq(users.id, platformSettings.updatedBy));
    const map = new Map<PlatformSettingKey, PanelRowInfo>();
    for (const row of rows) {
      if (isPlatformSettingKey(row.key)) {
        map.set(row.key, {
          updatedAt: row.updatedAt,
          updatedByEmail: row.updatedByEmail,
        });
      }
    }
    return map;
  });
}

/** Status semua kunci yang dikelola: isSet + sumber efektif + jejak panel. */
export async function listPlatformSettingStatuses(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<PlatformSettingStatus[]> {
  const panel = await readPanelRowInfos(db);
  return PLATFORM_SETTING_KEYS.map((key) => {
    const row = panel.get(key);
    if (row) {
      return {
        key,
        isSet: true,
        source: "panel" as const,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedByEmail,
      };
    }
    const envValue = opts.env[key];
    if (envValue) {
      return {
        key,
        isSet: true,
        source: "env" as const,
        updatedAt: null,
        updatedBy: null,
      };
    }
    return { key, isSet: false, source: null, updatedAt: null, updatedBy: null };
  });
}

// ---------------------------------------------------------------------------
// Resolver nilai efektif: panel → env → null (cache ±60 detik per proses)
// ---------------------------------------------------------------------------

export const PLATFORM_SETTINGS_CACHE_TTL_MS = 60_000;

/**
 * Cache per OBJEK opsi: setiap proses pemanggil (api, worker) punya
 * tepat satu objek opsi (env-nya konstan seumur proses), jadi bucket per
 * identitas objek menjaga semantik "env proses ini" tetap benar. Set/
 * clear membuang entri kunci terkait dari SEMUA bucket (registry di
 * bawah) karena aksi tulis bisa datang dari objek opsi mana pun.
 */
type SecretCacheBucket = Map<
  PlatformSettingKey,
  { value: string | null; expiresAt: number }
>;
const secretCacheBuckets = new WeakMap<
  PlatformSettingsOptions,
  SecretCacheBucket
>();
const knownBuckets = new Set<SecretCacheBucket>();

function bucketFor(opts: PlatformSettingsOptions): SecretCacheBucket {
  let bucket = secretCacheBuckets.get(opts);
  if (!bucket) {
    bucket = new Map();
    secretCacheBuckets.set(opts, bucket);
    knownBuckets.add(bucket);
  }
  return bucket;
}

function invalidateCachedSecret(key: PlatformSettingKey): void {
  for (const bucket of knownBuckets) bucket.delete(key);
}

/** Buang seluruh cache resolver (dipakai uji & saat set/clear di proses lain tidak terjangkau). */
export function clearPlatformSettingsCache(): void {
  for (const bucket of knownBuckets) bucket.clear();
}

async function readPanelValue(
  db: Database,
  key: PlatformSettingKey,
  masterSecret: string,
): Promise<string | null> {
  const stored = await withPlatformAdminTx(db, async (tx) => {
    const [row] = await tx
      .select({ valueEncrypted: platformSettings.valueEncrypted })
      .from(platformSettings)
      .where(eq(platformSettings.key, key))
      .limit(1);
    return row?.valueEncrypted ?? null;
  });
  if (!stored) return null;
  // Envelope rusak / kunci induk berganti → null (pemanggil jatuh ke env),
  // bukan crash: panel yang tak terbaca tidak boleh mematikan jalur AI.
  return decryptChannelSecret(masterSecret, stored);
}

/**
 * Nilai efektif satu kunci: panel terdekripsi lebih dulu, lalu env, lalu
 * null. Hasil (termasuk null) di-cache ±60 detik per proses — perubahan
 * panel berlaku tanpa restart dalam jendela itu; set/clear yang terjadi
 * di proses yang sama membuang cache-nya seketika.
 */
export async function getProviderSecret(
  db: Database,
  key: PlatformSettingKey,
  opts: PlatformSettingsOptions,
): Promise<string | null> {
  const bucket = bucketFor(opts);
  const cached = bucket.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: string | null = null;
  if (opts.masterSecret) {
    value = await readPanelValue(db, key, opts.masterSecret);
  }
  if (value === null) {
    const envValue = opts.env[key];
    value = envValue ? envValue : null;
  }
  bucket.set(key, {
    value,
    expiresAt: Date.now() + PLATFORM_SETTINGS_CACHE_TTL_MS,
  });
  return value;
}

/**
 * Konfigurasi OpenRouter efektif untuk jalur agent: kunci dari resolver;
 * model dari panel `openrouter_model` → env. Null = tidak ada kunci di
 * mana pun (pemanggil memakai provider mock).
 */
export async function resolveOpenRouterConfig(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<{ apiKey: string; model?: string } | null> {
  const apiKey = await getProviderSecret(db, "openrouter_api_key", opts);
  if (!apiKey) return null;
  const model = await getProviderSecret(db, "openrouter_model", opts);
  return { apiKey, model: model ?? undefined };
}

// ---------------------------------------------------------------------------
// Kunci berbentuk (enum / URL): validasi saat tulis + resolver bertipe
// ---------------------------------------------------------------------------

/** Status privasi unggahan YouTube yang sah (cermin enum env di config). */
export const YOUTUBE_PRIVACY_STATUSES = ["private", "unlisted", "public"] as const;
export type YouTubePrivacyStatus = (typeof YOUTUBE_PRIVACY_STATUSES)[number];

/** Level privasi direct post TikTok yang sah (cermin enum env di config). */
export const TIKTOK_PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validasi bentuk untuk kunci yang nilainya bukan teks bebas. Dipakai
 * lapisan API saat PUT (nilai tidak sah ditolak 400) DAN resolver
 * bertipe di bawah (nilai panel/env yang tidak sah diabaikan) — dua
 * lapis agar baris yang ditulis di luar API (mis. SQL manual) tidak
 * pernah mengalir mentah ke adapter platform.
 */
export function isValidPlatformSettingValue(
  key: PlatformSettingKey,
  value: string,
): boolean {
  switch (key) {
    case "post_media_public_base_url":
      return isHttpUrl(value);
    case "youtube_privacy_status":
      return (YOUTUBE_PRIVACY_STATUSES as readonly string[]).includes(value);
    case "tiktok_privacy_level":
      return (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(value);
    default:
      return true;
  }
}

/**
 * Resolusi kunci berbentuk: nilai efektif panel → env yang SAH menang;
 * bila nilai efektif tidak sah (hanya mungkin lewat tulisan di luar
 * API), env yang sah dicoba sekali lagi sebelum menyerah ke `null`.
 */
async function resolveValidatedSetting(
  db: Database,
  key: PlatformSettingKey,
  opts: PlatformSettingsOptions,
): Promise<string | null> {
  const effective = await getProviderSecret(db, key, opts);
  if (effective !== null && isValidPlatformSettingValue(key, effective)) {
    return effective;
  }
  const envValue = opts.env[key];
  if (envValue && isValidPlatformSettingValue(key, envValue)) return envValue;
  return null;
}

/** Base URL publik media efektif (panel → env → null) untuk adapter container. */
export async function resolvePostMediaPublicBaseUrl(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<string | null> {
  return resolveValidatedSetting(db, "post_media_public_base_url", opts);
}

/** Status privasi YouTube efektif; bawaan aman `private` (pola env Gelombang 2). */
export async function resolveYouTubePrivacyStatus(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<YouTubePrivacyStatus> {
  const value = await resolveValidatedSetting(db, "youtube_privacy_status", opts);
  return (value as YouTubePrivacyStatus | null) ?? "private";
}

/** Level privasi TikTok efektif; bawaan gerbang audit `SELF_ONLY` (pola env Gelombang 4). */
export async function resolveTikTokPrivacyLevel(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<TikTokPrivacyLevel> {
  const value = await resolveValidatedSetting(db, "tiktok_privacy_level", opts);
  return (value as TikTokPrivacyLevel | null) ?? "SELF_ONLY";
}

// ---------------------------------------------------------------------------
// Tulis: set / clear / audit uji (nilai TIDAK PERNAH masuk audit/log)
// ---------------------------------------------------------------------------

/** Simpan nilai baru untuk satu kunci (terenkripsi) + audit `platform_settings.set`. */
export async function setPlatformSetting(
  db: Database,
  input: { key: PlatformSettingKey; value: string; updatedByUserId: string },
  opts: PlatformSettingsOptions,
): Promise<void> {
  if (!opts.masterSecret) throw new PlatformSettingsUnavailableError();
  const valueEncrypted = encryptChannelSecret(opts.masterSecret, input.value);
  await withPlatformAdminTx(db, async (tx) => {
    await tx
      .insert(platformSettings)
      .values({
        key: input.key,
        valueEncrypted,
        updatedBy: input.updatedByUserId,
      })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: {
          valueEncrypted,
          updatedBy: input.updatedByUserId,
          updatedAt: new Date(),
        },
      });
    await insertPlatformAudit(tx, input.updatedByUserId, "platform_settings.set", {
      key: input.key,
    });
  });
  invalidateCachedSecret(input.key);
}

/**
 * Hapus nilai panel satu kunci (resolusi kembali ke env fallback) + audit
 * `platform_settings.cleared`. Mengembalikan true bila memang ada baris.
 */
export async function clearPlatformSetting(
  db: Database,
  input: { key: PlatformSettingKey; updatedByUserId: string },
): Promise<boolean> {
  const existed = await withPlatformAdminTx(db, async (tx) => {
    const deleted = await tx
      .delete(platformSettings)
      .where(eq(platformSettings.key, input.key))
      .returning({ key: platformSettings.key });
    if (deleted.length === 0) return false;
    await insertPlatformAudit(
      tx,
      input.updatedByUserId,
      "platform_settings.cleared",
      { key: input.key },
    );
    return true;
  });
  if (existed) invalidateCachedSecret(input.key);
  return existed;
}

/**
 * Catat hasil uji koneksi (audit `platform_settings.test`). Meta hanya
 * berisi key + hasil berkode — TIDAK PERNAH nilai atau detail rahasia.
 */
export async function recordPlatformSettingTest(
  db: Database,
  input: {
    key: PlatformSettingKey;
    actorUserId: string;
    ok: boolean;
    code: string;
  },
): Promise<void> {
  await withPlatformAdminTx(db, async (tx) => {
    await insertPlatformAudit(tx, input.actorUserId, "platform_settings.test", {
      key: input.key,
      ok: input.ok,
      code: input.code,
    });
  });
}
