import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "TENANT_NOT_FOUND",
  "CHANNEL_NOT_CONNECTED",
  "CHANNEL_NOT_AVAILABLE_YET",
  "CHANNEL_DISCONNECTED",
  "TELEGRAM_TOKEN_INVALID",
  "TELEGRAM_BOT_ALREADY_CONNECTED",
  "META_TOKEN_INVALID",
  "META_ACCOUNT_ALREADY_CONNECTED",
  "META_NOT_CONFIGURED",
  "META_SIGNATURE_INVALID",
  // Fase 7D: koneksi Meta via OAuth ("Lanjutkan dengan Facebook").
  "META_OAUTH_NOT_CONFIGURED",
  "META_OAUTH_STATE_INVALID",
  "META_OAUTH_SESSION_NOT_FOUND",
  "META_OAUTH_ASSET_NOT_FOUND",
  // Hotfix R1: aset pemilih ditemukan tetapi tidak punya kredensial
  // yang dapat dipakai (Page tanpa Page Access Token) → 422 saat
  // complete dicoba untuk aset nonaktif itu.
  "META_OAUTH_ASSET_NOT_CONNECTABLE",
  "META_OAUTH_EXCHANGE_FAILED",
  "META_OAUTH_CANCELLED",
  "CHANNEL_DELETE_CONFIRMATION_MISMATCH",
  "CHANNEL_ALREADY_TRASHED",
  "CHANNEL_NOT_TRASHED",
  "LOG_REPLAY_NOT_ALLOWED",
  "LOG_PAYLOAD_TRUNCATED",
  "MESSAGE_NOT_FAILED",
  "MESSAGE_RETRY_UNSUPPORTED",
  // Fase 7B.5: target kutipan balasan tidak sah (tak ada / tenant lain /
  // percakapan lain) → 422 pada endpoint balas dashboard & API publik v1.
  "MESSAGE_REPLY_TARGET_INVALID",
  // Fase 7C: broadcast — channel tidak mendukung broadcast (webchat
  // tanpa semantik push) → 422; transisi status tidak sah (edit
  // non-draft, jadwalkan non-draft, batalkan yang sudah terminal) → 409.
  // Fase 10A: WhatsApp terbuka LEWAT template — broadcast WA tanpa
  // template → 422 BROADCAST_TEMPLATE_REQUIRED; template belum
  // APPROVED → 422 BROADCAST_TEMPLATE_NOT_APPROVED.
  "BROADCAST_CHANNEL_UNSUPPORTED",
  "BROADCAST_INVALID_STATE",
  "BROADCAST_TEMPLATE_REQUIRED",
  "BROADCAST_TEMPLATE_NOT_APPROVED",
  // Fase 13D: uji A/B broadcast menyala (abSplitPercentB terisi)
  // tetapi isi varian B tidak sah untuk provider-nya (teks B kosong
  // untuk provider teks) → 422. Template B WhatsApp yang hilang /
  // belum APPROVED memakai kode template yang sama seperti varian A.
  "BROADCAST_AB_INCOMPLETE",
  // Fase 10A: Meta menolak operasi template (buat/sinkron/hapus —
  // nama ganda, bentuk tidak sah, contoh variabel kurang) → 422;
  // akun WhatsApp tanpa WABA induk tercatat → 422.
  "META_TEMPLATE_INVALID",
  "META_WABA_MISSING",
  // Fase 10B: aturan komentar terikat ke akun selain IG/Messenger yang
  // terhubung (atau akun tenant lain) → 422; moderasi manual komentar
  // ditolak Meta / token akun tak tersedia → 422 (status lokal tidak
  // berubah).
  "COMMENT_CHANNEL_UNSUPPORTED",
  "META_COMMENT_ACTION_FAILED",
  // Fase 8A: flow engine — graf tidak sah saat aktivasi (daftar masalah
  // terstruktur di `details.issues`) → 422; transisi status tidak sah
  // (edit flow aktif, aktifkan yang sudah aktif, dst.) → 409.
  "FLOW_GRAPH_INVALID",
  "FLOW_INVALID_STATE",
  // Fase 12B: instantiate galeri template dengan slug tak dikenal → 404.
  "FLOW_TEMPLATE_NOT_FOUND",
  // Fase 12C: lampiran berkas KB — berkas tanpa teks yang bisa
  // diekstrak (PDF hasil pindaian / berkas rusak) → 422 dan dokumen
  // TIDAK disimpan; tipe di luar PDF/TXT/MD → 422; ukuran di atas
  // batas 5MB → 422 (konvensi apiError codebase tidak memakai 413).
  "KB_DOCUMENT_NO_TEXT",
  "KB_DOCUMENT_TYPE_UNSUPPORTED",
  "KB_DOCUMENT_TOO_LARGE",
  // Fase 12E: playground agent — provider LLM gagal menjawab atau
  // salah konfigurasi (mis. LLM_PROVIDER=openrouter tanpa kunci) → 502.
  "AGENT_PROVIDER_ERROR",
  // Fase 13B: growth links — slug publik sudah dipakai workspace lain
  // (slug unik GLOBAL) → 409; konfigurasi channel tidak sah (akun
  // bukan milik tenant / tidak connected / himpunan picker < 2) → 422;
  // URL tujuan platform tidak bisa disusun dari data akun (WhatsApp /
  // Instagram tanpa handle publik) → 422.
  "GROWTH_LINK_SLUG_TAKEN",
  "GROWTH_LINK_CHANNEL_INVALID",
  "GROWTH_LINK_TARGET_UNAVAILABLE",
  // Fase 9B: merge kontak ke dirinya sendiri → 422.
  "CONTACT_MERGE_SAME",
  // Fase 9C: kedalaman inbox tim — penerima tugas bukan member workspace
  // → 422; siklus hidup undangan tim (kedaluwarsa / dicabut / sudah
  // diterima → 422; email sesi != email undangan → 403; email sudah
  // menjadi member → 409); pemilik workspace dilindungi dari penurunan
  // peran & pengeluaran, dan member tidak bisa mengeluarkan dirinya
  // lewat endpoint tim → 422.
  "ASSIGNEE_NOT_MEMBER",
  "INVITATION_EXPIRED",
  "INVITATION_REVOKED",
  "INVITATION_ALREADY_ACCEPTED",
  "INVITATION_EMAIL_MISMATCH",
  "INVITATION_ALREADY_MEMBER",
  "TEAM_OWNER_PROTECTED",
  "TEAM_SELF_ACTION",
  "PRODUCT_HAS_LINKS",
  "API_KEY_INVALID",
  "API_KEY_REVOKED",
  "API_KEY_SCOPE_DENIED",
  "MESSAGING_WINDOW_CLOSED",
  // Fase 16C: kirim template dari inbox — provider bukan WhatsApp → 422;
  // template tidak ada di akun percakapan ini → 404; status belum
  // APPROVED → 422; jumlah/nilai parameter tidak cocok → 422.
  "MESSAGE_TEMPLATE_UNSUPPORTED",
  "MESSAGE_TEMPLATE_NOT_FOUND",
  "MESSAGE_TEMPLATE_NOT_APPROVED",
  "MESSAGE_TEMPLATE_PARAMS_INVALID",
  // Fase 18C: header media kini BISA dikirim. Dua penolakan yang
  // tersisa keduanya bisa ditindaklanjuti pengguna: lampiran belum
  // dipilih, atau jenisnya tidak cocok dengan format header template.
  "MESSAGE_TEMPLATE_MEDIA_HEADER_REQUIRED",
  "MESSAGE_TEMPLATE_MEDIA_HEADER_MISMATCH",
  // Fase 18B: lampiran dari inbox. Media tidak ada di workspace ini →
  // 404; jenis berkas tidak diizinkan → 415; melebihi batas → 413.
  "MEDIA_NOT_FOUND",
  "MEDIA_TYPE_UNSUPPORTED",
  "MEDIA_TOO_LARGE",
  "MEDIA_EMPTY",
  // Fase 13G: janji temu + Google Calendar.
  "APPOINTMENT_TIMEZONE_INVALID",
  "SLOT_TAKEN",
  "GOOGLE_NOT_CONFIGURED",
  "GOOGLE_NOT_CONNECTED",
  "GOOGLE_UNREACHABLE",
  // Fase 14A: gerbang pembayaran sungguhan — endpoint simulasi menolak
  // tautan provider sungguhan (409); pembuatan tautan gagal di provider
  // (502, kode provider diteruskan); kredensial tenant belum terisi.
  "PAYMENT_NOT_SIMULATION",
  "PAYMENT_NOT_CONFIGURED",
  "MIDTRANS_AUTH_FAILED",
  "MIDTRANS_CREATE_FAILED",
  "MIDTRANS_UNREACHABLE",
  "XENDIT_AUTH_FAILED",
  "XENDIT_CREATE_FAILED",
  "XENDIT_UNREACHABLE",
  // Fase 16B: instantiate galeri template automation dengan slug tak
  // dikenal → 404 (padanan FLOW_TEMPLATE_NOT_FOUND untuk /automations).
  "AUTOMATION_TEMPLATE_NOT_FOUND",
  // Fase 23: content schedule. Kode domain PostDomainError dipetakan 1:1
  // ke sini supaya UI menerjemahkan sebabnya, bukan menebak dari status.
  "POST_NOT_FOUND",
  "POST_TARGET_NOT_FOUND",
  "POST_TARGET_NOT_CONNECTED",
  "POST_MEDIA_NOT_FOUND",
  "POST_MEDIA_ALBUM_UNSUPPORTED",
  "POST_NOT_EDITABLE",
  "POST_NOT_SCHEDULABLE",
  "POST_NOT_CANCELLABLE",
  "POST_NOT_RETRYABLE",
  "POST_NOT_PUBLISHING",
  "POST_EMPTY",
  // Gelombang 0: validasi format per capability provider (core/posts).
  "POST_CAPTION_TOO_LONG",
  "POST_MEDIA_REQUIRED",
  "POST_MEDIA_TOO_MANY",
  "POST_MEDIA_KIND_UNSUPPORTED",
  "RATE_LIMITED",
  "ENTITLEMENT_EXCEEDED",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    /** Pesan teknis untuk developer/log — BUKAN teks UI. UI menerjemahkan `code` via i18n. */
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Readiness (kesiapan melayani) — BEDA dari liveness `/health`.
 *
 * `/health` menjawab "proses hidup"; `/ready` menjawab "dependensi yang
 * dibutuhkan untuk melayani request benar-benar bisa dipakai". Load
 * balancer/orchestrator harus memakai `/ready` untuk menarik replika dari
 * rotasi saat DB/Redis bermasalah, dan `/health` hanya untuk restart.
 *
 * `not_configured` sengaja bukan `error`: di lingkungan pengembangan API
 * boleh hidup tanpa DB (mode Fase 0). Di produksi, status keseluruhan
 * menjadi `degraded` bila dependensi wajib tidak terkonfigurasi.
 */
export const ReadinessCheckSchema = z.enum(["ok", "error", "not_configured"]);
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;

export const ReadyResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  checks: z.object({
    database: ReadinessCheckSchema,
    redis: ReadinessCheckSchema,
  }),
  timestamp: z.string().datetime(),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

export const VersionResponseSchema = z.object({
  service: z.string(),
  version: z.string(),
  /** Versi Meta Graph API yang ter-pin untuk integrasi Meta (RANCANGAN §12.1). */
  metaGraphApiVersion: z.string(),
});
export type VersionResponse = z.infer<typeof VersionResponseSchema>;
