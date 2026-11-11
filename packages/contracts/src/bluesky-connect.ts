import { z } from "zod";

// ---------------------------------------------------------------------------
// Bluesky Connect — gelombang Semua OAuth. Bluesky (AT Protocol)
// TIDAK memiliki OAuth untuk aplikasi pihak ketiga seperti ini, jadi
// connect adalah FORMULIR handle + App Password (pola blok connect
// non-OAuth yang sudah ada — Telegram token bot), BUKAN dialog
// authorize:
//
//   POST /tenants/:tenantId/bluesky-connect
//     { handle, appPassword } → server memvalidasi kredensial lewat
//     `com.atproto.server.createSession` ke entryway Bluesky, lalu
//     menyimpan akun channel `bluesky` (external_id = DID dari sesi,
//     public_handle = handle sesi) dengan APP PASSWORD TERENKRIPSI
//     di kolom token akun — persis format yang dibaca adapter
//     penerbit Gelombang 1.5 (sesi XRPC dibuat segar tiap publikasi;
//     accessJwt TIDAK disimpan).
//
// App Password dibuat pemilik akun di pengaturan Bluesky (Privacy
// and Security → App Passwords) dan BUKAN kata sandi akun utama —
// ia bisa dicabut sendiri tanpa mengganggu login. Password TIDAK
// PERNAH masuk respons/log/audit: respons hanya membawa ringkasan
// akun channel yang terhubung. Kredensial yang ditolak Bluesky
// dijawab 422 BLUESKY_CREDENTIALS_INVALID; akun yang sudah aktif di
// workspace lain dijawab 409 BLUESKY_ACCOUNT_ALREADY_CONNECTED
// (penjaga satu akun = satu koneksi yang sama seperti provider lain).
// ---------------------------------------------------------------------------

export const BlueskyConnectRequestSchema = z.object({
  /** Handle Bluesky (mis. `kreator.bsky.social`, boleh berawalan '@') atau DID. */
  handle: z.string().trim().min(3).max(253),
  /** App Password dari pengaturan Bluesky (format xxxx-xxxx-xxxx-xxxx). */
  appPassword: z.string().trim().min(1).max(255),
});
export type BlueskyConnectRequest = z.infer<typeof BlueskyConnectRequestSchema>;

/** Ringkasan akun yang terhubung — TANPA kredensial apa pun. */
export const BlueskyConnectResponseSchema = z.object({
  channelAccountId: z.string().uuid(),
  /** DID akun — identitas stabil akun channel. */
  did: z.string(),
  /** Handle akun dari sesi tervalidasi (tanpa '@'). */
  handle: z.string(),
  status: z.literal("connected"),
});
export type BlueskyConnectResponse = z.infer<
  typeof BlueskyConnectResponseSchema
>;
