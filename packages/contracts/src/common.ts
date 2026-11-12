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
  // Integrasi Threads: koneksi Threads via OAuth ("Hubungkan dengan
  // Threads") — keluarga kode sendiri karena aplikasi & callback-nya
  // terpisah dari Meta App. Kode-kode ini juga menjadi nilai penanda
  // redirect callback (?threads_oauth_error=<KODE>).
  "THREADS_OAUTH_NOT_CONFIGURED",
  // Webhook Threads (pola Meta, aplikasi Threads sendiri): verify
  // token webhook belum terisi → 503; tanda tangan POST tidak sah → 401.
  "THREADS_NOT_CONFIGURED",
  "THREADS_SIGNATURE_INVALID",
  "THREADS_OAUTH_STATE_INVALID",
  "THREADS_OAUTH_EXCHANGE_FAILED",
  "THREADS_OAUTH_CANCELLED",
  "THREADS_ACCOUNT_ALREADY_CONNECTED",
  // Gelombang Semua OAuth: koneksi TikTok via Login Kit, LinkedIn,
  // dan Pinterest via OAuth — keluarga kode per provider seperti
  // Threads (aplikasi & callback masing-masing terpisah). Kode-kode
  // ini juga menjadi nilai penanda redirect callback
  // (?<provider>_oauth_error=<KODE>).
  "TIKTOK_OAUTH_NOT_CONFIGURED",
  // Webhook TikTok: client secret belum terisi → 503; tanda tangan
  // TikTok-Signature tidak sah/basi → 401.
  "TIKTOK_NOT_CONFIGURED",
  "TIKTOK_SIGNATURE_INVALID",
  "TIKTOK_OAUTH_STATE_INVALID",
  "TIKTOK_OAUTH_EXCHANGE_FAILED",
  "TIKTOK_OAUTH_CANCELLED",
  "TIKTOK_ACCOUNT_ALREADY_CONNECTED",
  "LINKEDIN_OAUTH_NOT_CONFIGURED",
  "LINKEDIN_OAUTH_STATE_INVALID",
  "LINKEDIN_OAUTH_EXCHANGE_FAILED",
  "LINKEDIN_OAUTH_CANCELLED",
  "LINKEDIN_ACCOUNT_ALREADY_CONNECTED",
  "PINTEREST_OAUTH_NOT_CONFIGURED",
  "PINTEREST_OAUTH_STATE_INVALID",
  "PINTEREST_OAUTH_EXCHANGE_FAILED",
  "PINTEREST_OAUTH_CANCELLED",
  "PINTEREST_ACCOUNT_ALREADY_CONNECTED",
  // Pemilih board Pinterest: board_id yang hendak disimpan tidak
  // ada di daftar board akun saat divalidasi → 422; daftar board /
  // pembuatan board ditolak atau tak terjangkau di provider → 502.
  "PINTEREST_BOARD_NOT_FOUND",
  "PINTEREST_BOARDS_UNAVAILABLE",
  // Bluesky connect BUKAN OAuth (formulir handle + App Password):
  // kredensial ditolak Bluesky → 422; server tidak bisa menjangkau
  // entryway Bluesky → 502; penyimpanan kredensial belum
  // terkonfigurasi di server → 503.
  "BLUESKY_CREDENTIALS_INVALID",
  "BLUESKY_ACCOUNT_ALREADY_CONNECTED",
  "BLUESKY_UNREACHABLE",
  "BLUESKY_CONNECT_NOT_CONFIGURED",
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
  // G9: broadcast berulang — transisi status aturan tidak sah (jeda
  // aturan yang tidak aktif, edit aturan terminal, dst.) → 409.
  "BROADCAST_RECURRENCE_INVALID_STATE",
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
  // G10: perbaikan-di-tempat template WhatsApp hanya sah untuk status
  // REJECTED (APPROVED tidak diubah di tempat — buat versi baru;
  // PENDING sedang ditinjau dan terkunci) → 409.
  "WHATSAPP_TEMPLATE_NOT_EDITABLE",
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
  // G3 (versioning flow): pemulihan versi ditolak karena flow sedang
  // draft dengan suntingan yang belum diaktifkan — memulihkan akan
  // menimpa draft itu diam-diam. Pengguna harus mengaktifkan draft
  // dulu (yang menyimpannya sebagai versi) sebelum memulihkan → 409.
  "FLOW_RESTORE_DIRTY_DRAFT",
  "FLOW_NOT_ACTIVE",
  "FLOW_TRIGGER_CHANGED",
  "FLOW_CHANNEL_MISSING",
  "WEBHOOK_PAYLOAD_INVALID",
  "WEBHOOK_CONTACT_UNRESOLVED",
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
  // G13 butir 11: reaksi pesan — provider tanpa API reaksi keluar →
  // 422; pesan tanpa alamat provider → 422; kredensial channel tak
  // tersedia → 503; provider menolak pengiriman → 502.
  "REACTION_NOT_SUPPORTED",
  "REACTION_TARGET_UNADDRESSABLE",
  "REACTION_UNAVAILABLE",
  "REACTION_DELIVERY_FAILED",
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
  // G2b: pendaftaran sequence MANUAL (per kontak / per tag) ditolak
  // dengan sebab yang bisa ditindaklanjuti pengguna, bukan 400 generik:
  // sequence nonaktif/bukan sequence, sequence tanpa langkah, kontak
  // tanpa percakapan pesan sebagai jangkar, percakapan pilihan bukan
  // percakapan pesan kontak itu, atau kontak sudah opt-out.
  "SEQUENCE_UNAVAILABLE",
  "SEQUENCE_NO_STEPS",
  "ENROLL_NO_CONVERSATION",
  "ENROLL_CONVERSATION_INVALID",
  "ENROLL_CONTACT_OPTED_OUT",
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
  // Gelombang 2: judul post melebihi batas judul platform (YouTube).
  "POST_TITLE_TOO_LONG",
  "POST_MEDIA_REQUIRED",
  "POST_MEDIA_TOO_MANY",
  "POST_MEDIA_KIND_UNSUPPORTED",
  // Gelombang Pilihan Privasi & AI per Postingan: pilihan penerbitan
  // yang diwajibkan platform (privasi + pengungkapan AI) belum dibuat
  // pengguna, atau kombinasinya tidak sah (konten bermerek privat).
  "POST_PUBLISH_OPTIONS_REQUIRED",
  "POST_PUBLISH_OPTIONS_INVALID",
  // Gelombang Perbaikan /contacts: berkas impor CSV melewati batas
  // baris per impor (MAX_IMPORT_ROWS di core).
  "CONTACTS_IMPORT_TOO_MANY_ROWS",
  // Gelombang G11: webhook keluar tenant — URL endpoint ditolak
  // (format/skema/anti-SSRF), peristiwa di luar katalog, atau batas
  // jumlah endpoint per tenant tercapai.
  "WEBHOOK_URL_INVALID",
  "WEBHOOK_URL_NOT_HTTPS",
  "WEBHOOK_URL_UNSAFE_HOST",
  "WEBHOOK_EVENT_UNKNOWN",
  "WEBHOOK_EVENTS_EMPTY",
  "WEBHOOK_ENDPOINT_LIMIT",
  // Gelombang G12: deals/pipeline — rujukan tidak ditemukan di tenant
  // ini, atau penghapusan ditolak karena isi (pipeline berisi deal,
  // tahap berisi deal tanpa tujuan pindah, pipeline tanpa tahap).
  "DEAL_NOT_FOUND",
  "PIPELINE_NOT_FOUND",
  "STAGE_NOT_FOUND",
  "CONTACT_NOT_FOUND",
  "CONVERSATION_NOT_FOUND",
  "PIPELINE_HAS_DEALS",
  "STAGE_NOT_EMPTY",
  "PIPELINE_HAS_NO_STAGES",
  // Gelombang G14: kode diskon — tidak ditemukan di tenant ini, atau
  // teks kode yang sama sudah dipakai kode lain di tenant yang sama.
  "DISCOUNT_CODE_NOT_FOUND",
  "DISCOUNT_CODE_DUPLICATE",
  // Gelombang G15: jadwal kerja — user sasaran bukan anggota tenant ini.
  "MEMBER_NOT_FOUND",
  // Gelombang G18 butir 1: skema field kustom bertipe — nilai kontak
  // melanggar definisi field tenant (details memuat isu per field),
  // atau kunci definisi sudah dipakai definisi lain di tenant ini.
  "CONTACT_FIELD_INVALID",
  "CONTACT_FIELD_DEFINITION_DUPLICATE",
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
