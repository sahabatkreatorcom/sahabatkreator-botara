import { z } from "zod";

// ---------------------------------------------------------------------------
// Threads OAuth Connect (integrasi Threads) — menghubungkan akun
// Threads tenant memakai kredensial APLIKASI Threads milik platform
// (Panel Admin: threads_app_id / threads_app_secret; env hanya
// fallback). Pola mengikuti Meta OAuth (Fase 7D) pada kepercayaan &
// kustodi: state bertanda tangan HMAC sekali pakai (nonce diklaim &
// dikonsumsi atomik), kredensial aplikasi diselesaikan panel → env
// per request, token TIDAK PERNAH masuk URL/browser/log.
//
// Beda bentuk dari Meta — SENGAJA dan terdokumentasi: login Meta bisa
// menghasilkan BANYAK aset (Page/WABA) sehingga callback-nya menyimpan
// "sesi pemilih" server-side dan browser memilih aset di langkah
// complete. Login Threads selalu menghasilkan TEPAT SATU akun — akun
// Threads milik pengguna yang memberi izin — jadi tidak ada pemilih:
// callback menukar code → token pendek → token berumur panjang
// (grant th_exchange_token) → profil /me, lalu langsung membuat /
// menghidupkan channel_accounts provider `threads` dan me-redirect
// browser kembali ke /channels dengan penanda hasil:
//   ?threads_oauth=connected          berhasil
//   ?threads_oauth_error=<KODE>       gagal (kode = errors.* di i18n)
// Scopes dialog: threads_basic + threads_content_publish (minimum
// untuk profil + penerbitan content schedule).
// ---------------------------------------------------------------------------

/** Start tidak membawa pilihan apa pun (satu provider, satu akun). */
export const ThreadsOAuthStartRequestSchema = z.object({});
export type ThreadsOAuthStartRequest = z.infer<
  typeof ThreadsOAuthStartRequestSchema
>;

export const ThreadsOAuthStartResponseSchema = z.object({
  /** URL dialog authorize threads.net yang siap diarahkan browser. */
  dialogUrl: z.string(),
  /** Kapan state dialog ini kedaluwarsa (state sekali pakai, ≤10 menit). */
  expiresAt: z.string().datetime(),
});
export type ThreadsOAuthStartResponse = z.infer<
  typeof ThreadsOAuthStartResponseSchema
>;

/**
 * Ketersediaan connect Threads untuk workspace (owner/admin) — dasar
 * UI menampilkan tombol "Hubungkan dengan Threads" aktif/nonaktif dan
 * Redirect URI yang harus didaftarkan pemilik di aplikasi Threads.
 * `available` = appId terisi DAN app secret terisi. App Secret tidak
 * pernah muncul; App ID adalah identifier publik.
 */
export const ThreadsOAuthInfoResponseSchema = z.object({
  /** Redirect URI yang harus didaftarkan persis di aplikasi Threads. */
  oauthRedirectUri: z.string(),
  /** URL webhook yang didaftarkan di pengaturan webhook aplikasi Threads: `{publicBaseUrl}/api/webhooks/threads`. */
  webhookUrl: z.string(),
  /** App ID aplikasi Threads platform (identifier publik); null bila belum diatur. */
  appId: z.string().nullable(),
  appIdConfigured: z.boolean(),
  appSecretConfigured: z.boolean(),
  available: z.boolean(),
});
export type ThreadsOAuthInfoResponse = z.infer<
  typeof ThreadsOAuthInfoResponseSchema
>;
