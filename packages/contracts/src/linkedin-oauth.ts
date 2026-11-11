import { z } from "zod";

// ---------------------------------------------------------------------------
// LinkedIn Connect — gelombang Semua OAuth. Menghubungkan PROFIL
// PRIBADI LinkedIn tenant memakai kredensial APLIKASI LinkedIn milik
// platform (Panel Admin: linkedin_client_id / linkedin_client_secret;
// env hanya fallback). Pola kepercayaan & kustodi mengikuti Threads:
// state bertanda tangan HMAC sekali pakai, kredensial aplikasi
// diselesaikan panel → env per request, token TIDAK PERNAH masuk
// URL/browser/log.
//
// Alur resmi: authorize di `linkedin.com/oauth/v2/authorization`
// (scope `openid profile w_member_social`) → callback menukar code
// di `POST /oauth/v2/accessToken` → profil OIDC `GET /v2/userinfo`
// (klaim `sub` = member ID = external_id; adapter menyusun author
// `urn:li:person:{sub}`), lalu callback langsung membuat /
// menghidupkan channel_accounts provider `linkedin` dan me-redirect
// browser kembali ke /channels dengan penanda hasil:
//   ?linkedin_oauth=connected         berhasil
//   ?linkedin_oauth_error=<KODE>      gagal (kode = errors.* di i18n)
// Login LinkedIn selalu menghasilkan TEPAT SATU akun (anggota yang
// memberi izin) — tidak ada pemilih aset, sama seperti Threads.
//
// BATAS PLATFORM YANG JUJUR: sasaran connect SELALU profil pribadi.
// Menerbitkan sebagai Company Page membutuhkan persetujuan program
// Community Management LinkedIn yang terpisah dan TIDAK dibangun.
// Token LinkedIn berumur ±60 hari dan program standar TIDAK
// menerbitkan refresh token — lifecycle di sini adalah
// TANDAI-RECONNECT: worker menandai "expiring" menjelang kedaluwarsa
// dan memindahkan akun ke 'error' (linkedin_token_expired) sesudah
// lewat, agar pemilik menghubungkan ulang; tidak ada grant refresh
// yang dipanggil, dan kontrak ini tidak berpura-pura sebaliknya.
// ---------------------------------------------------------------------------

/** Start tidak membawa pilihan apa pun (satu provider, satu akun). */
export const LinkedInOAuthStartRequestSchema = z.object({});
export type LinkedInOAuthStartRequest = z.infer<
  typeof LinkedInOAuthStartRequestSchema
>;

export const LinkedInOAuthStartResponseSchema = z.object({
  /** URL dialog authorize linkedin.com yang siap diarahkan browser. */
  dialogUrl: z.string(),
  /** Kapan state dialog ini kedaluwarsa (state sekali pakai, ≤10 menit). */
  expiresAt: z.string().datetime(),
});
export type LinkedInOAuthStartResponse = z.infer<
  typeof LinkedInOAuthStartResponseSchema
>;

/**
 * Ketersediaan connect LinkedIn untuk workspace (owner/admin) —
 * dasar UI menampilkan tombol "Hubungkan dengan LinkedIn"
 * aktif/nonaktif dan Redirect URI yang harus didaftarkan pemilik di
 * aplikasi LinkedIn (Auth → Authorized redirect URLs). `available`
 * = client ID terisi DAN client secret terisi. Client Secret tidak
 * pernah muncul; Client ID adalah identifier publik.
 */
export const LinkedInOAuthInfoResponseSchema = z.object({
  /** Redirect URI yang harus didaftarkan persis di aplikasi LinkedIn. */
  oauthRedirectUri: z.string(),
  /** Client ID aplikasi LinkedIn platform (identifier publik); null bila belum diatur. */
  clientId: z.string().nullable(),
  clientIdConfigured: z.boolean(),
  clientSecretConfigured: z.boolean(),
  available: z.boolean(),
});
export type LinkedInOAuthInfoResponse = z.infer<
  typeof LinkedInOAuthInfoResponseSchema
>;
