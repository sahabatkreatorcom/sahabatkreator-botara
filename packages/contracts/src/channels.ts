import { z } from "zod";

import { ChannelProviderSchema } from "./inbox";

// ---------------------------------------------------------------------------
// Channel accounts (Fase 1F — manajemen channel workspace)
// ---------------------------------------------------------------------------

export const ChannelAccountStatusSchema = z.enum([
  "connected",
  "disconnected",
  "error",
]);
export type ChannelAccountStatus = z.infer<typeof ChannelAccountStatusSchema>;

/** Outcome terkendali log integrasi — union arah masuk & keluar (kolom `outcome`). */
export const IntegrationLogOutcomeSchema = z.enum([
  // arah masuk
  "recorded",
  "duplicate",
  "ignored_disconnected",
  "ignored_echo",
  "ignored_status_only",
  "rejected_signature",
  "rejected_unconfigured",
  "unresolved_account",
  "error",
  // arah keluar
  "sent",
  "failed",
]);
export type IntegrationLogOutcome = z.infer<typeof IntegrationLogOutcomeSchema>;

/**
 * Status kesehatan operasional channel (Fase 7B.3), dihitung server dari
 * log integrasi (telegram/messenger/instagram/whatsapp) atau aktivitas
 * pesan (webchat — flush-nya tidak dicatat log integrasi by design):
 * - `idle`: belum ada aktivitas apa pun yang tercatat untuk akun ini;
 * - `attention`: sinyal kegagalan terakhir LEBIH BARU daripada aktivitas
 *   sehat terakhir (webhook tercatat / pengiriman sukses);
 * - `ok`: ada aktivitas dan tidak ada kegagalan yang lebih baru dari
 *   aktivitas sehat terakhir.
 */
export const ChannelHealthStatusSchema = z.enum(["ok", "attention", "idle"]);
export type ChannelHealthStatus = z.infer<typeof ChannelHealthStatusSchema>;

/**
 * Kesehatan operasional satu akun channel (Fase 7B.3) — fakta mentahnya
 * dari `integration_log` per akun (satu kueri agregat untuk seluruh
 * daftar, bukan N+1):
 * - `lastInboundAt`/`lastInboundOutcome`: hit webhook arah masuk
 *   terakhir (outcome apa pun). Untuk webchat: waktu pesan pengunjung
 *   terakhir dari tabel messages, dan outcome selalu null (webchat
 *   tidak punya konsep outcome webhook).
 * - `lastDeliveredAt`: pengiriman keluar sukses terakhir (log 'out'
 *   outcome `sent`). Untuk webchat: waktu flush gateway terakhir dari
 *   audit `message.sent` (satu-satunya jalur penanda `sent` webchat =
 *   waktu antar yang sesungguhnya, bukan waktu tulis balasan).
 * - `lastFailureAt`/`lastFailureOutcome`/`lastFailureErrorCode`: sinyal
 *   kegagalan terakhir — arah masuk: rejected_*, unresolved_account,
 *   error, ignored_disconnected; arah keluar: failed. Untuk webchat
 *   selalu null (pesan webchat tidak pernah berstatus failed).
 * Hit Meta yang gagal di gerbang bersama (tanda tangan buruk dsb.)
 * ber-channel_account_id NULL sehingga tidak menempel ke kartu mana
 * pun — kesehatan per kartu hanya mencerminkan event yang memang
 * teratribusi ke akun itu.
 */
export const ChannelHealthSchema = z.object({
  status: ChannelHealthStatusSchema,
  lastInboundAt: z.string().datetime().nullable(),
  lastInboundOutcome: IntegrationLogOutcomeSchema.nullable(),
  lastDeliveredAt: z.string().datetime().nullable(),
  lastFailureAt: z.string().datetime().nullable(),
  lastFailureOutcome: IntegrationLogOutcomeSchema.nullable(),
  lastFailureErrorCode: z.string().nullable(),
});
export type ChannelHealth = z.infer<typeof ChannelHealthSchema>;

/**
 * Permintaan connect channel INBOX.
 *
 * `provider: "threads"` valid sebagai identitas akun linimasa pada
 * skema akun/sasaran, tetapi SENGAJA belum dapat dibuat lewat endpoint
 * generik ini: Threads bukan channel inbox dan provisioning-nya adalah
 * OAuth aplikasi Threads yang terpisah (dimock pada Gelombang 1).
 * Route channel menjawabnya `CHANNEL_NOT_AVAILABLE_YET`, bukan
 * mengalirkannya ke connect Meta graph.facebook.com.
 *
 * Hal yang sama berlaku untuk `provider: "bluesky"` (Gelombang 1.5):
 * identitas akun linimasa (DID + handle) valid pada skema akun/sasaran,
 * tetapi provisioning-nya — pemilik membuat app password di pengaturan
 * Bluesky lalu akun didaftarkan dengan kredensial itu — belum dibuka
 * lewat endpoint generik ini dan dijawab `CHANNEL_NOT_AVAILABLE_YET`
 * yang sama.
 */
export const CreateChannelRequestSchema = z.object({
  provider: ChannelProviderSchema,
  displayName: z.string().trim().min(1).max(255).optional(),
  /**
   * Token bot Telegram (Fase 6A) — wajib hanya untuk provider 'telegram'.
   * Token TIDAK PERNAH dikembalikan API: ia divalidasi ke Bot API, lalu
   * disimpan terenkripsi di server.
   */
  botToken: z.string().trim().min(10).max(255).optional(),
  /**
   * Page Access Token Meta (Fase 7A) — wajib hanya untuk provider
   * 'messenger'/'instagram'. Pola yang sama seperti botToken: divalidasi
   * ke Graph API, disimpan terenkripsi, TIDAK PERNAH dikembalikan API.
   */
  pageAccessToken: z.string().trim().min(10).max(1024).optional(),
  /**
   * Facebook Page ID (Fase 7A) — untuk 'messenger' ini menjadi
   * external_id akun; untuk 'instagram' ini Page yang terhubung ke akun
   * IG (token divalidasi terhadap Page ini juga).
   */
  pageId: z.string().trim().min(1).max(64).optional(),
  /**
   * ID akun Instagram Professional (Fase 7A) — wajib hanya untuk
   * provider 'instagram'; menjadi external_id akun itu.
   */
  igUserId: z.string().trim().min(1).max(64).optional(),
  /**
   * Jenis token untuk connect manual Instagram (Fase 7D.3):
   * - 'page_access_token' (bawaan bila absen) — perilaku 7A: token di
   *   field `pageAccessToken` adalah Page Access Token dan `pageId`
   *   (Page yang terhubung) WAJIB untuk memvalidasinya.
   * - 'system_user_token' — token di field `pageAccessToken` adalah
   *   System User Access Token (SUAT) dari Pengaturan Bisnis Meta;
   *   `pageId` TIDAK dipakai: validasi langsung ke akun IG
   *   (`GET /{ig-id}?fields=id,username`) dan konteks portofolio
   *   (`client_business_id`) disimpan sebagai parent_external_id.
   *   Varian ini untuk akun IG yang portofolionya sama dengan aplikasi
   *   (kasus pemilik sendiri), yang tidak terjangkau OAuth Unified
   *   Login. Untuk provider selain 'instagram' field ini diabaikan.
   */
  tokenType: z
    .enum(["page_access_token", "system_user_token"])
    .optional(),
  /**
   * WABA ID (Fase 7B) — wajib hanya untuk provider 'whatsapp': id
   * WhatsApp Business Account yang menaungi nomor; disimpan sebagai
   * konteks induk (`parent_external_id`), bukan kunci resolusi.
   */
  wabaId: z.string().trim().min(1).max(64).optional(),
  /**
   * Phone Number ID WhatsApp (Fase 7B) — wajib hanya untuk provider
   * 'whatsapp'; menjadi external_id akun (kunci resolusi webhook &
   * penjaga satu-nomor-satu-koneksi).
   */
  phoneNumberId: z.string().trim().min(1).max(64).optional(),
  /**
   * Access Token WhatsApp (Fase 7B) — wajib hanya untuk provider
   * 'whatsapp'. Pola resminya adalah token System User permanen dari
   * Meta Business Settings. Sama seperti token lain: divalidasi ke
   * Graph API, disimpan terenkripsi, TIDAK PERNAH dikembalikan API.
   */
  accessToken: z.string().trim().min(10).max(1024).optional(),
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

export const ChannelAccountResponseSchema = z.object({
  id: z.string().uuid(),
  provider: ChannelProviderSchema,
  /** Untuk webchat: siteKey publik (`wc_...`) yang dipasang di situs tenant. */
  externalId: z.string(),
  displayName: z.string().nullable(),
  /** Untuk telegram: username bot (`@...` tanpa '@') dari getMe. Provider lain: null. */
  botUsername: z.string().nullable(),
  /**
   * Handle publik akun Meta (Fase 7A): username Page Facebook untuk
   * 'messenger', username akun untuk 'instagram' — dipakai kartu
   * Channels sebagai baris @handle dan menyusun tautan publik
   * (m.me / ig.me). Null bila akun tidak punya username (Page tanpa
   * username adalah hal yang sah) atau provider non-Meta.
   * Fase 7B: untuk 'whatsapp' kolom ini adalah `display_phone_number`
   * terformat dari Graph (mis. "+62 812-3456-7890"); chip kartu
   * menyusun tautan wa.me dari digitnya saja.
   */
  publicHandle: z.string().nullable(),
  /**
   * URL foto profil akun (Fase 6D): endpoint avatar kita sendiri
   * (`/api/tenants/:tenantId/avatars/channels/:id`) bila foto tersimpan
   * (saat ini foto bot Telegram), selain itu null dan kartu Channels
   * menampilkan inisial/glyph provider. TIDAK PERNAH URL file provider
   * (URL file Telegram menyematkan token bot).
   */
  avatarUrl: z.string().nullable(),
  status: ChannelAccountStatusSchema,
  /**
   * Kesehatan operasional akun (Fase 7B.3) — selalu hadir; akun tanpa
   * aktivitas tercatat menjawab status `idle` dengan semua waktu null.
   */
  health: ChannelHealthSchema,
  /**
   * Nama yang harus diketik PERSIS untuk mengonfirmasi pembuangan ke
   * Sampah (Fase 6I): displayName bila ada, else botUsername (telegram),
   * else externalId. Dihitung server agar UI & validasi server selalu
   * sepakat — ini nama yang memang sudah terlihat di kartu, bukan rahasia.
   */
  confirmationName: z.string(),
  /** Kapan akun dibuang ke Sampah (Fase 6I); null = akun hidup normal. */
  trashedAt: z.string().datetime().nullable(),
  /** trashedAt + 30 hari masa tenggang; null bila tidak di Sampah. */
  purgeAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChannelAccountResponse = z.infer<
  typeof ChannelAccountResponseSchema
>;

export const ChannelAccountListResponseSchema = z.object({
  channels: z.array(ChannelAccountResponseSchema),
});
export type ChannelAccountListResponse = z.infer<
  typeof ChannelAccountListResponseSchema
>;

/**
 * Info pemasangan webhook Meta (Fase 7A) — hanya untuk owner/admin
 * workspace (endpoint menjawab 403 untuk peran lain): URL webhook publik
 * platform + verify token yang harus ditempel ke dashboard Meta App.
 * Verify token BUKAN kredensial Meta; ia nilai yang kita tentukan
 * sendiri. App secret TIDAK pernah termasuk di sini.
 */
export const MetaWebhookInfoResponseSchema = z.object({
  /** URL publik webhook tunggal: `{publicBaseUrl}/api/meta/webhook`. */
  webhookUrl: z.string(),
  /** Verify token untuk ditempel ke Meta App; null bila env belum diset. */
  verifyToken: z.string().nullable(),
  /** True bila platform sudah punya app secret untuk memverifikasi tanda tangan. */
  appSecretConfigured: z.boolean(),
});
export type MetaWebhookInfoResponse = z.infer<
  typeof MetaWebhookInfoResponseSchema
>;
