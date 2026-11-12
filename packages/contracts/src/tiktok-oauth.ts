import { z } from "zod";

// ---------------------------------------------------------------------------
// TikTok Connect (Login Kit) — gelombang Semua OAuth. Menghubungkan
// akun TikTok tenant memakai kredensial APLIKASI TikTok milik
// platform (Panel Admin: tiktok_client_key / tiktok_client_secret;
// env hanya fallback). Pola kepercayaan & kustodi mengikuti Meta
// OAuth (7D) dan Threads: state bertanda tangan HMAC sekali pakai
// (nonce diklaim & dikonsumsi atomik), kredensial aplikasi
// diselesaikan panel → env per request, token TIDAK PERNAH masuk
// URL/browser/log.
//
// Beda bentuk dari Meta — SENGAJA dan terdokumentasi (sama seperti
// Threads): login TikTok selalu menghasilkan TEPAT SATU akun —
// kreator yang memberi izin — jadi tidak ada pemilih aset: callback
// menukar code di token endpoint Login Kit
// (`POST /v2/oauth/token/`, grant authorization_code) → open_id dari
// respons token + profil berjenjang dua sumber, lalu langsung
// membuat / menghidupkan channel_accounts provider `tiktok` dan
// me-redirect browser kembali ke /channels dengan penanda hasil:
//   ?tiktok_oauth=connected           berhasil
//   ?tiktok_oauth=connected_profile_incomplete
//                                     berhasil, tetapi profil akhir
//                                     tetap kosong (banner peringatan)
//   ?tiktok_oauth_error=<KODE>        gagal (kode = errors.* di i18n)
// Scopes dialog: user.info.basic + video.publish (profil + penerbitan
// content schedule). Profil TikTok berjenjang: (1) user info
// (`GET /v2/user/info/`, scope user.info.basic) sebagai sumber utama;
// (2) creator_info Content Posting (`POST
// /v2/post/publish/creator_info/query/`, scope video.publish) sebagai
// cadangan username/nickname/avatar bila sumber utama ditolak —
// persetujuan produk Login Kit dapat tertinggal dari scope inti
// penerbitan. Penanda profil-belum-lengkap hanya dipakai bila kedua
// sumber tidak menghasilkan nama tampil.
//
// Access token TikTok hanya berumur ±24 jam; connect menyimpan
// refresh token (±365 hari) terenkripsi (migrasi 0022) dan worker
// lifecycle menyegarkannya via grant refresh_token SEBELUM
// kedaluwarsa — menutup batas Gelombang 4 yang dulu mengharuskan
// hubungkan ulang manual.
// ---------------------------------------------------------------------------

/** Start tidak membawa pilihan apa pun (satu provider, satu akun). */
export const TikTokOAuthStartRequestSchema = z.object({});
export type TikTokOAuthStartRequest = z.infer<
  typeof TikTokOAuthStartRequestSchema
>;

export const TikTokOAuthStartResponseSchema = z.object({
  /** URL dialog authorize tiktok.com yang siap diarahkan browser. */
  dialogUrl: z.string(),
  /** Kapan state dialog ini kedaluwarsa (state sekali pakai, ≤10 menit). */
  expiresAt: z.string().datetime(),
});
export type TikTokOAuthStartResponse = z.infer<
  typeof TikTokOAuthStartResponseSchema
>;

/**
 * Ketersediaan connect TikTok untuk workspace (owner/admin) — dasar
 * UI menampilkan tombol "Hubungkan dengan TikTok" aktif/nonaktif dan
 * Redirect URI yang harus didaftarkan pemilik di aplikasi TikTok
 * (Login Kit). `available` = client key terisi DAN client secret
 * terisi. Client Secret tidak pernah muncul; Client Key adalah
 * pengenal publik.
 */
export const TikTokOAuthInfoResponseSchema = z.object({
  /** Redirect URI yang harus didaftarkan persis di aplikasi TikTok. */
  oauthRedirectUri: z.string(),
  /** Client Key aplikasi TikTok platform (pengenal publik); null bila belum diatur. */
  clientKey: z.string().nullable(),
  clientKeyConfigured: z.boolean(),
  clientSecretConfigured: z.boolean(),
  available: z.boolean(),
});
export type TikTokOAuthInfoResponse = z.infer<
  typeof TikTokOAuthInfoResponseSchema
>;
