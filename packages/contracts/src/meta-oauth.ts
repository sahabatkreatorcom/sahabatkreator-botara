import { z } from "zod";

import { ChannelAccountResponseSchema } from "./channels";

// ---------------------------------------------------------------------------
// Meta OAuth Connect (Fase 7D) — "Lanjutkan dengan Facebook" menggantikan
// tempel token sebagai jalur utama menghubungkan Messenger/Instagram/
// WhatsApp. Tiga rasa alur di balik satu callback platform:
// - messenger: Facebook Login klasik (scope di URL dialog) → user token →
//   long-lived → /me/accounts (Page + Page Access Token turunannya).
// - instagram: Unified Login (config_id) → Business Integration System
//   User Access Token (SUAT) → RANTAI penemuan multi-tepi (Fase 7D.3:
//   assigned_instagram_accounts + IG-pada-Page + IG-milik-portofolio +
//   per-Page; kandidat lewat Page membawa Page token-nya).
// - whatsapp: Embedded Signup / Login for Business (config_id) → token
//   bisnis → penemuan WABA ter-assign + nomor-nomornya.
// Token hasil exchange TIDAK PERNAH meninggalkan server: callback
// menyimpan "sesi OAuth" server-side berumur pendek di bawah id opak;
// browser hanya membawa id itu. App ID & config ID adalah identifier
// PUBLIK (bukan rahasia) — boleh tampil di respons & UI.
// ---------------------------------------------------------------------------

export const MetaOAuthProviderSchema = z.enum([
  "messenger",
  "instagram",
  "whatsapp",
]);
export type MetaOAuthProvider = z.infer<typeof MetaOAuthProviderSchema>;

export const MetaOAuthStartRequestSchema = z.object({
  provider: MetaOAuthProviderSchema,
});
export type MetaOAuthStartRequest = z.infer<typeof MetaOAuthStartRequestSchema>;

export const MetaOAuthStartResponseSchema = z.object({
  /** URL dialog Meta yang siap diarahkan browser (state sudah tertanam). */
  dialogUrl: z.string(),
  /** Kapan state dialog ini kedaluwarsa (state sekali pakai, ≤10 menit). */
  expiresAt: z.string().datetime(),
});
export type MetaOAuthStartResponse = z.infer<
  typeof MetaOAuthStartResponseSchema
>;

/**
 * Ketersediaan OAuth per provider untuk workspace (owner/admin) — dasar
 * UI memutuskan menampilkan tombol "Lanjutkan dengan Facebook" aktif,
 * nonaktif, atau menyembunyikannya. `available` = appId terisi DAN app
 * secret terisi DAN (untuk instagram/whatsapp) config ID provider itu
 * terisi.
 */
export const MetaOAuthInfoResponseSchema = z.object({
  /** Redirect URI tunggal yang harus didaftarkan di Meta App. */
  oauthRedirectUri: z.string(),
  /** App ID Meta platform (identifier publik); null bila belum diatur. */
  appId: z.string().nullable(),
  appIdConfigured: z.boolean(),
  appSecretConfigured: z.boolean(),
  providers: z.object({
    messenger: z.object({ available: z.boolean() }),
    instagram: z.object({
      available: z.boolean(),
      configId: z.string().nullable(),
    }),
    whatsapp: z.object({
      available: z.boolean(),
      configId: z.string().nullable(),
    }),
  }),
});
export type MetaOAuthInfoResponse = z.infer<typeof MetaOAuthInfoResponseSchema>;

/**
 * Satu aset yang bisa dipilih pemilik sesudah login Meta. `assetId`
 * adalah external_id channel masa depan (Page ID / ID akun IG / Phone
 * Number ID). Untuk WhatsApp, `parentId`/`parentName` = WABA pemilik
 * nomor; untuk Instagram, `parentId` = client_business_id portfolio
 * klien; untuk Messenger selalu null dan `linkedIgUsername` hanya info.
 *
 * `connectable` (Hotfix R1): false bila aset DITEMUKAN tetapi tidak
 * memiliki kredensial yang dapat dipakai untuk connect — saat ini
 * hanya untuk Page Messenger yang terlihat lewat tepi bisnis
 * (assigned/businesses) tetapi Page Access Token-nya tidak berhasil
 * diisi dari Graph. Aset seperti itu TETAP ditampilkan di pemilih
 * (ditandai nonaktif + `unavailableReason`), TIDAK hilang diam-diam;
 * endpoint complete menolaknya dengan META_OAUTH_ASSET_NOT_CONNECTABLE.
 * Aset lama di sesi yang tersimpan sebelum field ini ada terbaca
 * connectable=true lewat default skema.
 */
export const MetaOAuthAssetSchema = z.object({
  assetId: z.string(),
  kind: z.enum(["page", "instagram_account", "whatsapp_number"]),
  name: z.string().nullable(),
  handle: z.string().nullable(),
  parentId: z.string().nullable(),
  parentName: z.string().nullable(),
  linkedIgUsername: z.string().nullable(),
  connectable: z.boolean().default(true),
  unavailableReason: z
    .enum(["missing_page_token"])
    .nullable()
    .default(null),
});
export type MetaOAuthAsset = z.infer<typeof MetaOAuthAssetSchema>;

/**
 * Petunjuk keadaan kosong pemilih OAuth (Fase 7D.3) — hanya bermakna
 * untuk provider 'instagram' saat daftar aset kosong; membedakan
 * penyebab yang arahan perbaikannya BERBEDA (ditentukan dari probe
 * profil token + jejak rantai penemuan di callback):
 * - 'not_system_user': token hasil login BUKAN System User token
 *   (client_business_id kosong) — periksa jenis token pada konfigurasi
 *   Facebook Login untuk Bisnis (Unified Login wajib menerbitkan SUAT).
 * - 'no_accounts_shared': SUAT sah tetapi semua tepi penemuan kosong —
 *   akun belum dibagikan ke aplikasi, atau kasus portofolio-sama
 *   (akun pemilik aplikasi sendiri tidak diserahkan lewat login ini;
 *   jalur keluarnya connect manual varian System User Token).
 * - 'business_permission_missing': tepi IG-milik-portofolio
 *   (/me/businesses) menolak dengan error izin — konfigurasi Login
 *   untuk Bisnis kemungkinan belum memuat business_management.
 * null bila tidak relevan (aset tidak kosong / provider lain / probe
 * dan jejak tidak memberi kesimpulan).
 */
export const MetaOAuthEmptyHintSchema = z.enum([
  "not_system_user",
  "no_accounts_shared",
  "business_permission_missing",
]);
export type MetaOAuthEmptyHint = z.infer<typeof MetaOAuthEmptyHintSchema>;

/**
 * Isi sesi OAuth yang boleh dilihat browser: daftar aset TANPA token apa
 * pun. Token hidup terenkripsi di server dan hanya dipakai endpoint
 * complete.
 */
export const MetaOAuthSessionResponseSchema = z.object({
  sessionId: z.string(),
  provider: MetaOAuthProviderSchema,
  assets: z.array(MetaOAuthAssetSchema),
  /** Fase 7D.3: petunjuk spesifik saat `assets` kosong (instagram). */
  emptyHint: MetaOAuthEmptyHintSchema.nullable(),
  expiresAt: z.string().datetime(),
});
export type MetaOAuthSessionResponse = z.infer<
  typeof MetaOAuthSessionResponseSchema
>;

export const MetaOAuthCompleteRequestSchema = z.object({
  assetId: z.string().trim().min(1).max(255),
});
export type MetaOAuthCompleteRequest = z.infer<
  typeof MetaOAuthCompleteRequestSchema
>;

/**
 * Peringatan non-fatal sesudah complete: koneksi berhasil (token & akun
 * valid) tetapi langkah pendamping gagal — saat ini hanya kegagalan
 * auto-subscribe webhook, yang bisa diulang dari "Hubungkan lagi".
 */
export const MetaOAuthWarningSchema = z.enum(["META_SUBSCRIBE_FAILED"]);
export type MetaOAuthWarning = z.infer<typeof MetaOAuthWarningSchema>;

export const MetaOAuthCompleteResponseSchema = z.object({
  channel: ChannelAccountResponseSchema,
  warnings: z.array(MetaOAuthWarningSchema),
});
export type MetaOAuthCompleteResponse = z.infer<
  typeof MetaOAuthCompleteResponseSchema
>;

/**
 * Buang channel ke Sampah (Fase 6I): nama konfirmasi wajib sama PERSIS
 * dengan `confirmationName` akun di respons channel — server memvalidasi
 * ulang; ketidakcocokan ditolak CHANNEL_DELETE_CONFIRMATION_MISMATCH.
 */
export const TrashChannelRequestSchema = z.object({
  confirmationName: z.string().min(1).max(255),
});
export type TrashChannelRequest = z.infer<typeof TrashChannelRequestSchema>;
