import { z } from "zod";

// ---------------------------------------------------------------------------
// Pinterest Connect — gelombang Semua OAuth. Menghubungkan akun
// Pinterest tenant memakai kredensial APLIKASI Pinterest milik
// platform (Panel Admin: pinterest_app_id / pinterest_app_secret;
// env hanya fallback). Pola kepercayaan & kustodi mengikuti Threads:
// state bertanda tangan HMAC sekali pakai, kredensial aplikasi
// diselesaikan panel → env per request, token TIDAK PERNAH masuk
// URL/browser/log.
//
// Alur resmi API v5: authorize di `pinterest.com/oauth/` (scope
// boards:read,boards:write,pins:read,pins:write) → callback menukar
// code di `POST /v5/oauth/token` dengan Basic auth app id:secret →
// profil `GET /v5/user_account` (id + username), lalu callback
// langsung membuat / menghidupkan channel_accounts provider
// `pinterest` dan me-redirect browser kembali ke /channels dengan
// penanda hasil:
//   ?pinterest_oauth=connected        berhasil
//   ?pinterest_oauth_error=<KODE>     gagal (kode = errors.* di i18n)
// Login Pinterest selalu menghasilkan TEPAT SATU akun — tidak ada
// pemilih aset, sama seperti Threads.
//
// Access token berumur 30 hari; connect menyimpan refresh token
// terenkripsi (migrasi 0022) dan worker lifecycle menyegarkannya
// via grant `refresh_token` — Pinterest mendukung penyegaran
// BERKELANJUTAN (refresh token tidak berkedaluwarsa selama tidak
// dicabut, dan setiap grant menerbitkan refresh token baru).
// Board tujuan penerbitan: pilihan per akun dari pemilih board
// (lihat pinterest-boards.ts); tanpa pilihan adapter memakai
// board pertama akun (keputusan Gelombang 3) — connect tidak
// mengubah pilihan itu.
// ---------------------------------------------------------------------------

/** Start tidak membawa pilihan apa pun (satu provider, satu akun). */
export const PinterestOAuthStartRequestSchema = z.object({});
export type PinterestOAuthStartRequest = z.infer<
  typeof PinterestOAuthStartRequestSchema
>;

export const PinterestOAuthStartResponseSchema = z.object({
  /** URL dialog authorize pinterest.com yang siap diarahkan browser. */
  dialogUrl: z.string(),
  /** Kapan state dialog ini kedaluwarsa (state sekali pakai, ≤10 menit). */
  expiresAt: z.string().datetime(),
});
export type PinterestOAuthStartResponse = z.infer<
  typeof PinterestOAuthStartResponseSchema
>;

/**
 * Ketersediaan connect Pinterest untuk workspace (owner/admin) —
 * dasar UI menampilkan tombol "Hubungkan dengan Pinterest"
 * aktif/nonaktif dan Redirect URI yang harus didaftarkan pemilik
 * di aplikasi Pinterest. `available` = app ID terisi DAN app secret
 * terisi. App Secret tidak pernah muncul; App ID adalah identifier
 * publik.
 */
export const PinterestOAuthInfoResponseSchema = z.object({
  /** Redirect URI yang harus didaftarkan persis di aplikasi Pinterest. */
  oauthRedirectUri: z.string(),
  /** App ID aplikasi Pinterest platform (identifier publik); null bila belum diatur. */
  appId: z.string().nullable(),
  appIdConfigured: z.boolean(),
  appSecretConfigured: z.boolean(),
  available: z.boolean(),
});
export type PinterestOAuthInfoResponse = z.infer<
  typeof PinterestOAuthInfoResponseSchema
>;
