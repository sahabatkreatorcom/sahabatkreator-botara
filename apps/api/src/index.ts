import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  HealthResponseSchema,
  ReadyResponseSchema,
  VersionResponseSchema,
  type HealthResponse,
  type ReadyResponse,
  type VersionResponse,
} from "@sahabat-kreator/contracts";
import {
  APP_VERSION,
  META_GRAPH_API_VERSION,
  createLogger,
  loadEnv,
  resolveMediaStorageRoot,
} from "@sahabat-kreator/config";
import { createAuthBundle, type AuthBundle } from "./auth";
import { createRedisRateLimitStorage } from "./rate-limit-store";
import { createRateLimiter } from "./rate-limit";
import {
  createErrorHandler,
  createNotFoundHandler,
  createRequestMiddleware,
  securityHeaders,
} from "./observability";
import { checkDatabase, combineReadiness } from "./readiness";
import type { AppVariables } from "./http";
import { requireAuth } from "./modules/auth/session";
import { createTenantsRoutes } from "./modules/tenants/routes";
import { createContactsRoutes } from "./modules/contacts/routes";
import { createInboxRoutes } from "./modules/inbox/routes";
import { createChannelsRoutes } from "./modules/channels/routes";
import { createAutomationsRoutes } from "./modules/automations/routes";
import { createAgentsRoutes } from "./modules/agents/routes";
import { createKnowledgeRoutes } from "./modules/knowledge/routes";
import { createProductsRoutes } from "./modules/products/routes";
import { createPayRoutes } from "./modules/pay/routes";
import { createPaymentsRoutes } from "./modules/payments/routes";
import { createAdConnectionsRoutes } from "./modules/ad-connections/routes";
import { createApiKeysRoutes } from "./modules/api-keys/routes";
import { createPublicV1Routes } from "./modules/public-v1/routes";
import { createWebchatRoutes } from "./modules/webchat/routes";
import { createTelegramRoutes } from "./modules/telegram/routes";
import { createMetaRoutes } from "./modules/meta/routes";
import { createMetaOAuthRoutes } from "./modules/meta-oauth/routes";
import { createThreadsOAuthRoutes } from "./modules/threads-oauth/routes";
import { createTikTokOAuthRoutes } from "./modules/tiktok-oauth/routes";
import { createTikTokWebhookRoutes } from "./modules/tiktok-webhook/routes";
import { createThreadsWebhookRoutes } from "./modules/threads-webhook/routes";
import { createLinkedInOAuthRoutes } from "./modules/linkedin-oauth/routes";
import { createPinterestOAuthRoutes } from "./modules/pinterest-oauth/routes";
import { createBlueskyConnectRoutes } from "./modules/bluesky-connect/routes";
import { createAvatarsRoutes } from "./modules/avatars/routes";
import { createMediaRoutes } from "./modules/media/routes";
import { createAdminRoutes } from "./modules/admin/routes";
import { createLogsRoutes } from "./modules/logs/routes";
import { createAuditRoutes } from "./modules/audit/routes";
import { createBroadcastsRoutes } from "./modules/broadcasts/routes";
import { createBroadcastRecurrenceRoutes } from "./modules/broadcast-recurrences/routes";
import { createOutboundWebhooksRoutes } from "./modules/outbound-webhooks/routes";
import { createDealsRoutes } from "./modules/deals/routes";
import { createDiscountCodesRoutes } from "./modules/discount-codes/routes";
import { createPostsRoutes } from "./modules/posts/routes";
import { createWhatsAppTemplatesRoutes } from "./modules/whatsapp-templates/routes";
import { createCommentsRoutes } from "./modules/comments/routes";
import { createFlowsRoutes } from "./modules/flows/routes";
import { createFlowWebhooksRoutes } from "./modules/flow-webhooks/routes";
import { createSavedRepliesRoutes } from "./modules/saved-replies/routes";
import { createGrowthRoutes } from "./modules/growth/routes";
import { createSegmentsRoutes } from "./modules/segments/routes";
import { createAppointmentsRoutes } from "./modules/appointments/routes";
import { createNotesRoutes } from "./modules/notes/routes";
import { createTeamRoutes } from "./modules/team/routes";
import { createSlaRoutes } from "./modules/sla/routes";
import { createAnalyticsRoutes } from "./modules/analytics/routes";
import { createDashboardRoutes } from "./modules/dashboard/routes";
import {
  createRealtimePublisher,
  type RealtimePublisher,
} from "@sahabat-kreator/queue";
import {
  createDiskMediaStore,
  getProviderSecret,
  googleOAuthCallbackPath,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";

const env = loadEnv();
const startedAt = Date.now();
const logger = createLogger("api", {
  level: env.LOG_LEVEL,
  base: { version: APP_VERSION, environment: env.NODE_ENV },
});

// Opsi resolver Panel Admin Platform (Fase 6C) — SATU objek dipakai
// bersama modul admin, meta, penanda channels, dan hook email reset
// kata sandi (Fase 14C): cache resolver ter-bucket per identitas objek,
// jadi berbagi objek = berbagi semantik env proses ini + invalidasi
// set/clear berlaku untuk semua pemakai. Env hanya fallback per kunci;
// sumber utama nilai panel terenkripsi. (Blok ini didahulukan dari
// pembuatan bundle auth sejak 14C karena hook reset membutuhkannya.)
const platformOptions: PlatformSettingsOptions = {
  masterSecret: env.PLATFORM_SETTINGS_SECRET,
  env: {
    openrouter_api_key: env.OPENROUTER_API_KEY,
    openrouter_model: env.OPENROUTER_MODEL,
    r2_access_key_id: env.R2_ACCESS_KEY_ID,
    r2_secret_access_key: env.R2_SECRET_ACCESS_KEY,
    // Identitas R2: bucket adalah satu-satunya yang punya env
    // (R2_BUCKET) — account id & endpoint tidak punya env; fallback
    // mereka adalah bawaan kode di resolver core `resolveR2Identity`
    // (konstanta account id / endpoint turunan), persis perilaku
    // sebelum identitas ini bisa diisi panel.
    r2_bucket: env.R2_BUCKET,
    // Fase 7A.1: App Secret Meta ikut dikelola panel; env placeholder
    // staging tetap fallback sampai pemilik mengisi panel.
    meta_app_secret: env.META_APP_SECRET,
    // Fase 7D: identifier publik Meta untuk OAuth (App ID + config ID)
    // — env hanya fallback; sumber utama Panel Admin.
    meta_app_id: env.META_APP_ID,
    meta_ig_config_id: env.META_IG_CONFIG_ID,
    meta_wa_config_id: env.META_WA_CONFIG_ID,
    // Kredensial aplikasi Threads (aplikasi terpisah dari Meta App):
    // env hanya fallback; sumber utama Panel Admin grup Meta. Belum
    // ada konsumen — disiapkan untuk alur connect/OAuth Threads.
    threads_app_id: env.THREADS_APP_ID,
    threads_app_secret: env.THREADS_APP_SECRET,
    // Kredensial aplikasi TikTok (TikTok for Developers): env hanya
    // fallback; sumber utama Panel Admin grup TikTok. Belum ada
    // konsumen — disiapkan untuk alur connect/OAuth TikTok.
    tiktok_client_key: env.TIKTOK_CLIENT_KEY,
    tiktok_client_secret: env.TIKTOK_CLIENT_SECRET,
    // Kredensial aplikasi LinkedIn (LinkedIn Developer Portal): env
    // hanya fallback; sumber utama Panel Admin. Konsumen: alur
    // connect/OAuth LinkedIn (gelombang Semua OAuth).
    linkedin_client_id: env.LINKEDIN_CLIENT_ID,
    linkedin_client_secret: env.LINKEDIN_CLIENT_SECRET,
    // Kredensial aplikasi Pinterest (Pinterest Developers): env
    // hanya fallback; sumber utama Panel Admin. Konsumen: alur
    // connect/OAuth Pinterest (gelombang Semua OAuth).
    pinterest_app_id: env.PINTEREST_APP_ID,
    pinterest_app_secret: env.PINTEREST_APP_SECRET,
    // Fase 11B: email Resend — env hanya fallback; sumber utama Panel
    // Admin (resend_api_key rahasia + identitas pengirim publik).
    resend_api_key: env.RESEND_API_KEY,
    resend_from_email: env.RESEND_FROM_EMAIL,
    resend_from_name: env.RESEND_FROM_NAME,
    // Fase 13G: klien OAuth Google untuk sinkronisasi Calendar —
    // env hanya fallback; sumber utama Panel Admin (client_id publik
    // + client_secret rahasia).
    google_oauth_client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    google_oauth_client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    // Gelombang Pemisahan Google: klien OAuth per layanan (Calendar /
    // YouTube / Business) — env hanya fallback berjenjang di bawah
    // panel per-layanan dan panel bersama; sumber utama Panel Admin.
    google_calendar_client_id: env.GOOGLE_CALENDAR_CLIENT_ID,
    google_calendar_client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
    google_youtube_client_id: env.GOOGLE_YOUTUBE_CLIENT_ID,
    google_youtube_client_secret: env.GOOGLE_YOUTUBE_CLIENT_SECRET,
    google_business_client_id: env.GOOGLE_BUSINESS_CLIENT_ID,
    google_business_client_secret: env.GOOGLE_BUSINESS_CLIENT_SECRET,
    // G16: klien OAuth layanan 'ads' + developer token Google Ads
    // milik platform — env hanya fallback; sumber utama Panel Admin.
    google_ads_client_id: env.GOOGLE_ADS_CLIENT_ID,
    google_ads_client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
    google_ads_developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    // Instruksi pemilik 2026-11-12: sisa kredensial/pengaturan platform
    // ikut dikelola Panel Admin — env hanya fallback per kunci.
    meta_webhook_verify_token: env.META_WEBHOOK_VERIFY_TOKEN,
    threads_webhook_verify_token: env.THREADS_WEBHOOK_VERIFY_TOKEN,
    openrouter_embedding_model: env.OPENROUTER_EMBEDDING_MODEL,
    post_media_public_base_url: env.POST_MEDIA_PUBLIC_BASE_URL,
    youtube_privacy_status: env.YOUTUBE_PRIVACY_STATUS,
    tiktok_privacy_level: env.TIKTOK_PRIVACY_LEVEL,
  },
};

// Bundle auth + DB hanya dibuat bila env-nya lengkap; tanpa itu API tetap
// melayani /health & /version (mode Fase 0) dan modul tenants menjawab 503.
let authBundle: AuthBundle | null = null;
if (env.DATABASE_URL && env.BETTER_AUTH_SECRET) {
  authBundle = createAuthBundle({
    databaseUrl: env.DATABASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL ?? `http://localhost:${env.API_PORT}`,
    platformAdminEmails: env.PLATFORM_ADMIN_EMAILS,
    // Fase 14C: email reset kata sandi lewat Resend (pola 11B) —
    // resolver panel yang sama + override base URL untuk mock rantai.
    passwordResetEmail: {
      platform: platformOptions,
      apiBase: env.RESEND_API_BASE,
    },
    // Fase 13D: rate limit auth di Redis agar berlaku lintas replika
    // dan tidak reset saat restart. Tanpa REDIS_URL → null → storage
    // in-memory bawaan Better Auth (mode pengembangan).
    rateLimitStorage: createRedisRateLimitStorage(env.REDIS_URL),
  });
}

// Route inti didefinisikan sekali di sub-app `routes`, lalu di-mount dua kali
// di app utama: di root (akses langsung ke API) dan di bawah prefix /api
// (akses lewat proxy web — staging & publik memakai https://<domain>/api/...).
const routes = new Hono<{ Variables: AppVariables }>();

/**
 * Rate limit in-app permukaan publik (Fase 16A). Batas ini adalah jaring
 * pengaman dasar yang SELALU aktif; ruleset Cloudflare di
 * docs/PRODUCTION.md §2 tetap lapisan pertama yang dianjurkan.
 * Angkanya sengaja sama dengan usulan edge agar tidak mengejutkan klien.
 */
const rateLimiter = createRateLimiter({
  redisUrl: env.REDIS_URL,
  logger,
  rules: {
    v1: { limit: 600, windowSeconds: 60 },
    // G10: kuota per KUNCI API (bucket = id kunci, ditegakkan di modul
    // public-v1 sesudah autentikasi). Lebih ketat dari jaring per-IP
    // karena bucket ini tidak dibagi dengan kunci/IP lain.
    "v1-key": { limit: 300, windowSeconds: 60 },
    webchat: { limit: 300, windowSeconds: 60 },
    public: { limit: 120, windowSeconds: 60 },
  },
});
routes.use("/v1/*", rateLimiter.middleware("v1"));
routes.use("/webchat/*", rateLimiter.middleware("webchat"));
routes.use("/pay/*", rateLimiter.middleware("public"));
routes.use("/go/*", rateLimiter.middleware("public"));

routes.get("/health", (c) => {
  const body: HealthResponse = HealthResponseSchema.parse({
    status: "ok",
    service: "api",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
  return c.json(body);
});

routes.get("/version", (c) => {
  const body: VersionResponse = VersionResponseSchema.parse({
    service: "api",
    version: APP_VERSION,
    metaGraphApiVersion: META_GRAPH_API_VERSION,
  });
  return c.json(body);
});

/**
 * Readiness (Fase 16A): beda dari /health. Memeriksa DB (SELECT 1) dan
 * Redis (PING) dengan timeout pendek; 503 saat tidak siap agar replika
 * ditarik dari rotasi tanpa memicu restart loop.
 */
routes.get("/ready", async (c) => {
  const database = await checkDatabase(authBundle?.pool ?? null);
  const redis = await rateLimiter.health();
  const combined = combineReadiness(database, redis, {
    requireRedis: env.NODE_ENV === "production",
  });
  const body: ReadyResponse = ReadyResponseSchema.parse({
    status: combined.status,
    service: "api",
    checks: { database, redis },
    timestamp: new Date().toISOString(),
  });
  return c.json(body, combined.ok ? 200 : 503);
});

// Penerbit nudge realtime (Fase 6G) — satu instance per proses; route &
// poller menerbitkan event kecil ke Redis pub/sub SETELAH commit, dan
// apps/realtime meneruskannya ke socket dashboard/widget. Fail-soft:
// tanpa REDIS_URL penerbit null dan klien menutupi lewat polling.
const realtimePublisher: RealtimePublisher | null = env.REDIS_URL
  ? createRealtimePublisher(env.REDIS_URL)
  : null;
const webchatOpts = { secret: env.WEBCHAT_SECRET, publisher: realtimePublisher };

/**
 * Autentikasi permukaan dashboard dipasang SATU KALI di sini.
 *
 * Sebelumnya setiap modul mendaftarkan `app.use("/tenants/*", auth)` sendiri
 * — 26 modul — dan Hono menjalankan SEMUA handler yang cocok dengan pola path
 * itu. Akibatnya satu request dashboard mengeksekusi `getSession` +
 * `select users` 26 kali (terukur 217 ms untuk `GET /api/tenants`, sementara
 * query-nya sendiri hanya 1–11 ms).
 *
 * `requireAuth` tetap idempoten sebagai jaring pengaman: modul baru yang
 * (keliru) mendaftarkannya lagi tidak akan berbiaya. Lihat catatan di
 * modules/auth/session.ts.
 *
 * PENTING: harus didaftarkan SEBELUM `routes.route(...)` di bawah. Hono
 * menjalankan handler sesuai urutan registrasi — kalau dipasang sesudahnya,
 * handler modul berjalan lebih dulu dan route jadi terbuka tanpa sesi.
 */
if (authBundle) {
  routes.use("/tenants/*", requireAuth(authBundle));
}

// Modul log integrasi (Fase 7B.1) — pembacaan integration_log:
// /tenants/:tenantId/logs (owner/admin) + /logs/unresolved (platform admin).
// Fase 7B.2: replay memakai dependensi transport yang sama seperti
// route webhook live (publisher + kredensial + base URL provider).
routes.route(
  "/",
  createLogsRoutes(authBundle, {
    platformAdminEmails: env.PLATFORM_ADMIN_EMAILS,
    replay: {
      publisher: realtimePublisher,
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      telegramApiBase: env.TELEGRAM_API_BASE,
      metaApiBase: env.META_API_BASE,
      graphApiVersion: META_GRAPH_API_VERSION,
    },
  }),
);
// Modul penelusur audit (Fase 7B.4) — pembacaan audit_logs:
// /tenants/:tenantId/audit (owner/admin) + /audit/platform (admin platform).
routes.route(
  "/",
  createAuditRoutes(authBundle, {
    platformAdminEmails: env.PLATFORM_ADMIN_EMAILS,
  }),
);
// Modul broadcasts (Fase 7C) — kampanye siaran /tenants/:tenantId/broadcasts;
// eksekusi dispatch ada di worker (event outbox broadcast.dispatch_due).
routes.route("/", createBroadcastsRoutes(authBundle));
// Modul broadcast berulang (G9) — aturan penjadwal di atas broadcasts:
// /tenants/:tenantId/broadcast-recurrences; materialisasi slot oleh
// penyapu worker menjadi broadcast biasa lewat jalur Fase 7C.
routes.route("/", createBroadcastRecurrenceRoutes(authBundle));
// Modul outbound-webhooks (G11) — webhook KELUAR tenant:
// /tenants/:tenantId/outbound-webhooks; pengiriman peristiwa oleh
// worker (relay outbox → job fan-out → penyapu percobaan ulang).
routes.route(
  "/",
  createOutboundWebhooksRoutes(authBundle, {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
  }),
);
// Modul deals (G12) — pipeline penjualan & papan Kanban:
// /tenants/:tenantId/deal-pipelines + /deals + /deal-settings.
routes.route("/", createDealsRoutes(authBundle));
// Modul discount-codes (G14) — kode diskon & statistik penukaran:
// /tenants/:tenantId/discount-codes.
routes.route("/", createDiscountCodesRoutes(authBundle));
// Modul posts (Fase 23) — Content Schedule untuk channel Telegram
// /tenants/:tenantId/posts; penerbitan oleh worker (event outbox
// post.publish_due → job post.publish). Opsi modul dipakai
// validasi board Pinterest pada opsi postingan (pola Channels).
routes.route(
  "/",
  createPostsRoutes(authBundle, {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    pinterestApiBase: env.PINTEREST_API_BASE,
  }),
);
// Modul whatsapp-templates (Fase 10A) — template pesan resmi WhatsApp
// /tenants/:tenantId/whatsapp-templates (cermin lokal + Graph Meta).
routes.route(
  "/",
  createWhatsAppTemplatesRoutes(authBundle, {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    metaApiBase: env.META_API_BASE,
  }),
);
// Modul comments (Fase 10B; G7 menambah Threads) — komentar
// IG/Messenger + balasan Threads tercatat
// /tenants/:tenantId/comments + moderasi manual (Graph Meta /
// manage_reply Threads).
routes.route(
  "/",
  createCommentsRoutes(authBundle, {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    metaApiBase: env.META_API_BASE,
    threadsApiBase: env.THREADS_API_BASE,
  }),
);
// Modul flows (Fase 8A) — definisi flow graf /tenants/:tenantId/flows +
// run & langkah; eksekusi oleh worker (job flow.step dari event outbox).
routes.route("/", createFlowsRoutes(authBundle));
// Modul flow-webhooks (G17) — titik masuk PUBLIK pemicu webhook flow:
// POST /webhooks/flow/:endpointId (kanonis /api/webhooks/flow/...) —
// autentikasi token hash-only per endpoint; 404 tunggal untuk
// endpoint tak dikenal maupun token salah.
routes.route("/", createFlowWebhooksRoutes(authBundle));
// Modul saved-replies (Fase 9A) — macro balasan /tenants/:tenantId/saved-replies.
routes.route("/", createSavedRepliesRoutes(authBundle));
// Modul growth (Fase 13B) — tautan publik /tenants/:tenantId/growth-links
// + rute publik /go/:slug (redirect platform & landing picker, tanpa sesi).
routes.route("/", createGrowthRoutes(authBundle));
// Modul segments (Fase 13C) — segmen audiens /tenants/:tenantId/segments
// (CRUD dashboard + pratinjau hitungan; evaluator tunggal di core).
routes.route("/", createSegmentsRoutes(authBundle));
// Modul appointments (Fase 13G) — janji temu /tenants/:tenantId/appointments
// (layanan, ketersediaan, booking, pratinjau slot) + koneksi Google
// tenant (OAuth platform dari Panel Admin; callback publik kanonis
// per layanan /api/oauth/<layanan>/callback). Base URL Google
// dioverride env untuk mock.
routes.route(
  "/",
  createAppointmentsRoutes(authBundle, {
    platform: platformOptions,
    tokenSecret: env.CHANNEL_TOKEN_SECRET,
    googleBases: {
      apiBase: env.GOOGLE_API_BASE,
      tokenBase: env.GOOGLE_TOKEN_BASE,
      authBase: env.GOOGLE_AUTH_BASE,
    },
    publicBaseUrl: env.BETTER_AUTH_URL,
    stateSecret: env.BETTER_AUTH_SECRET,
    redisUrl: env.REDIS_URL,
  }),
);
// Modul notes (Fase 9C) — catatan internal /tenants/:tenantId/conversations/:id/notes.
routes.route("/", createNotesRoutes(authBundle));
// Modul team (Fase 9C) — member & undangan /tenants/:tenantId/team/*
// + penerimaan undangan /invitations/:token/*. Basis URL publik sama
// dengan tautan bayar (BETTER_AUTH_URL = origin web publik).
// Fase 11B: opsi platform + secret enkripsi token agar pembuatan
// undangan bisa mengantrekan email Resend lewat outbox.
routes.route(
  "/",
  createTeamRoutes(authBundle, {
    publicBaseUrl: env.BETTER_AUTH_URL,
    platform: platformOptions,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
  }),
);
// Modul SLA & jam kerja (G15) — jadwal anggota
// /tenants/:tenantId/team/members/:userId/work-schedule +
// pengaturan /tenants/:tenantId/sla/settings.
routes.route("/", createSlaRoutes(authBundle));
// Modul analitik (Fase 9B) — pemakaian AI /tenants/:tenantId/analytics/ai-usage.
routes.route("/", createAnalyticsRoutes(authBundle));
// Modul dashboard (Fase 16A) — ringkasan live /tenants/:tenantId/dashboard/summary.
routes.route("/", createDashboardRoutes(authBundle));
// Modul tenants (Fase 1B) — route /tenants* dengan middleware sesi di dalamnya.
routes.route("/", createTenantsRoutes(authBundle));
// Modul contacts & inbox (Fase 1D) — route bersarang /tenants/:tenantId/...
// Opsi backfill foto kontak (perbaikan avatar inbox): daftar yang dibaca
// menjadwalkan pengambilan foto kontak lama (telegram/meta) di latar —
// kredensial channel + base API yang sama seperti modul channels.
const contactPhotoBackfillOpts = {
  channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
  telegramApiBase: env.TELEGRAM_API_BASE,
  metaApiBase: env.META_API_BASE,
  graphApiVersion: META_GRAPH_API_VERSION,
};
routes.route("/", createContactsRoutes(authBundle, contactPhotoBackfillOpts));
routes.route(
  "/",
  createInboxRoutes(authBundle, realtimePublisher, contactPhotoBackfillOpts, {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    metaApiBase: env.META_API_BASE,
    telegramApiBase: env.TELEGRAM_API_BASE,
  }),
);
// Modul channels (Fase 1F, telegram 6A) — manajemen channel workspace
// /tenants/:tenantId/channels. Opsi telegram: kunci enkripsi kredensial +
// base URL Bot API + URL publik untuk mendaftarkan webhook.
routes.route(
  "/",
  createChannelsRoutes(authBundle, {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    // Resolver panel bersama — backfill foto TikTok menyimpan avatar
    // ke R2 lewat resolver yang sama seperti modul lain.
    platform: platformOptions,
    telegramApiBase: env.TELEGRAM_API_BASE,
    publicBaseUrl: env.BETTER_AUTH_URL,
    metaApiBase: env.META_API_BASE,
    threadsApiBase: env.THREADS_API_BASE,
    tiktokApiBase: env.TIKTOK_API_BASE,
    linkedinApiBase: env.LINKEDIN_API_BASE,
    pinterestApiBase: env.PINTEREST_API_BASE,
    blueskyApiBase: env.BLUESKY_API_BASE,
    // Token verifikasi efektif (Panel Admin → env) agar info webhook
    // yang dilihat owner/admin workspace selalu token yang berlaku —
    // pola yang sama seperti metaAppSecretConfigured di bawah.
    metaWebhookVerifyToken: async () => {
      if (!authBundle) return env.META_WEBHOOK_VERIFY_TOKEN ?? null;
      return getProviderSecret(
        authBundle.db,
        "meta_webhook_verify_token",
        platformOptions,
      );
    },
    // Fase 7A.1: penanda "app secret terkonfigurasi" menyelesaikan nilai
    // efektif panel → env (bukan env semata) — boolean saja yang keluar.
    metaAppSecretConfigured: async () => {
      if (!authBundle) return Boolean(env.META_APP_SECRET);
      return Boolean(
        await getProviderSecret(authBundle.db, "meta_app_secret", platformOptions),
      );
    },
    // Dependensi Google untuk backfill foto/handle YouTube (akun
    // youtube tidak menyimpan token; sumbernya koneksi layanan
    // youtube tenant) — basis yang sama seperti modul appointments.
    google: {
      platform: platformOptions,
      tokenSecret: env.CHANNEL_TOKEN_SECRET,
      bases: {
        apiBase: env.GOOGLE_API_BASE,
        tokenBase: env.GOOGLE_TOKEN_BASE,
        authBase: env.GOOGLE_AUTH_BASE,
      },
    },
  }),
);
// Modul meta publik (Fase 7A) — webhook Meta /webhooks/meta untuk
// Messenger + Instagram + /webhooks/whatsapp untuk WhatsApp (handler
// yang sama): handshake verify token + event bertanda tangan
// HMAC app secret (fail-closed 503 META_NOT_CONFIGURED tanpa secret).
// App secret diselesaikan panel → env per request (Fase 7A.1).
routes.route(
  "/",
  createMetaRoutes(authBundle, realtimePublisher, {
    platform: platformOptions,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    metaApiBase: env.META_API_BASE,
    graphApiVersion: META_GRAPH_API_VERSION,
    publicBaseUrl: env.BETTER_AUTH_URL,
  }),
);
// Modul telegram publik (Fase 6A) — webhook Bot API /telegram/webhook/:id.
// Opsi Fase 6D: kunci dekripsi token + base URL Bot API untuk pengambilan
// foto profil kontak saat pengirim pertama kali terlihat.
routes.route(
  "/",
  createTelegramRoutes(authBundle, realtimePublisher, {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    telegramApiBase: env.TELEGRAM_API_BASE,
  }),
);
// Modul avatars (Fase 6D) — penyajian foto profil bot & kontak dari DB
// /tenants/:tenantId/avatars/... (di balik sesi + membership; URL file
// provider yang bertoken tidak pernah diedarkan). Opsi platform
// dipakai menyajikan baris berbentuk R2 (avatar TikTok) — objek
// diambil server-side per request dari resolver panel.
routes.route(
  "/",
  createAvatarsRoutes(authBundle, { platform: platformOptions }),
);
// Modul media (Fase 18) — penyajian berkas yang dikirim pelanggan
// /tenants/:tenantId/media/:mediaId (sesi + membership; bucket tetap
// privat, key objek tidak pernah diedarkan).
routes.route(
  "/",
  createMediaRoutes(
    authBundle,
    createDiskMediaStore(resolveMediaStorageRoot(env.MEDIA_STORAGE_ROOT)),
  ),
);
// Modul automations (Fase 2A) — manajemen automation keyword /tenants/:tenantId/automations.
routes.route("/", createAutomationsRoutes(authBundle));
// Modul agents & knowledge (Fase 3A) — agent AI + KB + draf saran.
// Fase 12E: agents menerima deps resolver Panel Admin + env provider
// (pola knowledge 12D) agar playground menguji provider yang sama
// persis seperti yang dipakai worker (kunci panel → env).
routes.route(
  "/",
  createAgentsRoutes(authBundle, realtimePublisher, {
    platform: platformOptions,
    llmProviderEnv: env.LLM_PROVIDER,
    embeddingProviderEnv: env.EMBEDDING_PROVIDER,
    embeddingModelEnv: env.OPENROUTER_EMBEDDING_MODEL,
  }),
);
// Fase 12D: knowledge menerima deps resolver Panel Admin + env
// embedding agar /kb/stats melaporkan status indeks semantik yang
// benar-benar di-resolve proses ini (selaras worker).
routes.route(
  "/",
  createKnowledgeRoutes(authBundle, {
    platform: platformOptions,
    embeddingProviderEnv: env.EMBEDDING_PROVIDER,
    embeddingModelEnv: env.OPENROUTER_EMBEDDING_MODEL,
  }),
);
// Modul products (Fase 4A) — katalog produk & tautan bayar /tenants/:tenantId/products|payment-links.
// Fase 14A: deps gerbang pembayaran diteruskan agar pembuatan tautan
// memakai provider tenant (Midtrans/Xendit) bila terkonfigurasi.
routes.route(
  "/",
  createProductsRoutes(authBundle, {
    publicBaseUrl: env.BETTER_AUTH_URL,
    payments: {
      tokenSecret: env.CHANNEL_TOKEN_SECRET,
      midtransApiBase: env.MIDTRANS_API_BASE,
      xenditApiBase: env.XENDIT_API_BASE,
    },
  }),
);
// Modul pay publik (Fase 4A) — halaman bayar /pay/:code (tanpa sesi).
routes.route("/", createPayRoutes(authBundle));
// Modul payments (Fase 14A) — konfigurasi gerbang per tenant
// /tenants/:tenantId/payment-settings (Settings → Payments) + webhook
// provider publik /payments/webhook/{midtrans,xendit} (verifikasi
// kriptografis per tenant di core; tanpa sesi).
routes.route(
  "/",
  createPaymentsRoutes(authBundle, {
    tokenSecret: env.CHANNEL_TOKEN_SECRET,
    midtransApiBase: env.MIDTRANS_API_BASE,
    xenditApiBase: env.XENDIT_API_BASE,
    publicBaseUrl: env.BETTER_AUTH_URL,
  }),
);
// Modul ad-connections (Gelombang G16) — koneksi iklan per tenant
// /tenants/:tenantId/ad-connections (Settings → Konversi Iklan):
// dataset + token CAPI Meta terenkripsi, customer + aksi konversi
// Google Ads; consent OAuth Ads lewat rute generik google/:service.
routes.route(
  "/",
  createAdConnectionsRoutes(authBundle, {
    tokenSecret: env.CHANNEL_TOKEN_SECRET,
    platform: platformOptions,
  }),
);
// Modul api-keys (Fase 5A) — manajemen kunci workspace /tenants/:tenantId/api-keys (sesi + owner/admin).
routes.route("/", createApiKeysRoutes(authBundle));
// Modul API publik /v1 (Fase 5A) — auth API key per tenant, tenant dari kunci (bukan URL).
// Fase 15A: deps KB diteruskan agar /v1/knowledge/stats me-resolve status
// provider embedding dengan resolver yang sama seperti modul knowledge.
routes.route(
  "/",
  createPublicV1Routes(
    authBundle,
    realtimePublisher,
    {
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      metaApiBase: env.META_API_BASE,
      threadsApiBase: env.THREADS_API_BASE,
    },
    {
      platform: platformOptions,
      embeddingProviderEnv: env.EMBEDDING_PROVIDER,
      embeddingModelEnv: env.OPENROUTER_EMBEDDING_MODEL,
    },
    // G10: batas laju per kunci API (aturan "v1-key" di rateLimiter).
    { limiter: rateLimiter },
  ),
);
// Modul webchat publik (Fase 1F) — API widget pengunjung /webchat/*.
routes.route("/", createWebchatRoutes(authBundle, webchatOpts));
// Modul Panel Admin Platform (Fase 6C) — kredensial provider milik
// platform /admin/* (sesi + allowlist email; non-admin 404). Env hanya
// fallback per kunci; sumber utama panel terenkripsi di DB (core).
routes.route(
  "/",
  createAdminRoutes(authBundle, {
    platformAdminEmails: env.PLATFORM_ADMIN_EMAILS,
    platform: platformOptions,
    // Identitas R2 tidak dioper lagi: modul admin me-resolve-nya per
    // request lewat `resolveR2Identity` (panel → env → bawaan kode).
    // Fase 7D: redirect URI OAuth tunggal ditampilkan read-only di panel.
    metaOAuthRedirectUri: `${(env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "")}/api/oauth/meta/callback`,
    // Fase 11B: base URL API Resend untuk probe uji koneksi panel.
    resendApiBase: env.RESEND_API_BASE,
    // Redirect URI OAuth Google KANONIS per layanan ditampilkan
    // read-only di panel (/api/oauth/<layanan>/callback, keputusan
    // pemilik 2026-11-12) — satu per proyek Cloud layanan.
    googleOAuthRedirectUris: {
      calendar: `${(env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "")}${googleOAuthCallbackPath("calendar")}`,
      youtube: `${(env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "")}${googleOAuthCallbackPath("youtube")}`,
      business: `${(env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "")}${googleOAuthCallbackPath("business")}`,
      ads: `${(env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "")}${googleOAuthCallbackPath("ads")}`,
    },
  }),
);
// Modul Meta OAuth Connect (Fase 7D) — "Lanjutkan dengan Facebook":
// start ber-sesi + callback tunggal publik /oauth/meta/callback + sesi
// aset + info ketersediaan. State HMAC sekali pakai & sesi terenkripsi
// disimpan di Redis platform (fallback in-memory tanpa REDIS_URL).
routes.route(
  "/",
  createMetaOAuthRoutes(authBundle, {
    platform: platformOptions,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    metaApiBase: env.META_API_BASE,
    graphApiVersion: META_GRAPH_API_VERSION,
    publicBaseUrl: env.BETTER_AUTH_URL,
    redisUrl: env.REDIS_URL,
    stateSecret: env.BETTER_AUTH_SECRET,
    // Default mati: izin engagement Page butuh Advanced Access App
    // Review; memintanya sebelum disetujui membuat dialog Facebook
    // Login menjawab "Invalid Scopes" dan mematikan onboarding
    // Messenger. Lihat docs/APP-REVIEW.md §0.
    engagementScopes: env.META_ENGAGEMENT_SCOPES,
  }),
);
// Modul Threads OAuth Connect (integrasi Threads) — "Hubungkan dengan
// Threads": start ber-state sekali pakai + callback tunggal publik
// /oauth/threads/callback + info ketersediaan. Kredensial aplikasi
// dari Panel Admin (threads_app_id/secret; env hanya fallback) —
// diselesaikan per request oleh modul lewat platformOptions.
routes.route(
  "/",
  createThreadsOAuthRoutes(authBundle, {
    platform: platformOptions,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    threadsApiBase: env.THREADS_API_BASE,
    publicBaseUrl: env.BETTER_AUTH_URL,
    redisUrl: env.REDIS_URL,
    stateSecret: env.BETTER_AUTH_SECRET,
  }),
);
// Modul TikTok OAuth Connect (gelombang Semua OAuth) — "Hubungkan
// dengan TikTok" via Login Kit: start ber-state sekali pakai +
// callback tunggal publik /oauth/tiktok/callback + info
// ketersediaan. Kredensial aplikasi dari Panel Admin
// (tiktok_client_key/secret; env hanya fallback).
routes.route(
  "/",
  createTikTokOAuthRoutes(authBundle, {
    platform: platformOptions,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    tiktokApiBase: env.TIKTOK_API_BASE,
    publicBaseUrl: env.BETTER_AUTH_URL,
    redisUrl: env.REDIS_URL,
    stateSecret: env.BETTER_AUTH_SECRET,
  }),
);
// Webhook TikTok tingkat platform: POST /webhooks/tiktok (publik
// /api/webhooks/tiktok) — tanda tangan TikTok-Signature berbasis
// client secret (resolver panel); consumer pencabutan otorisasi
// (akun ditandai disconnected) + pencatatan event resmi lainnya.
routes.route("/", createTikTokWebhookRoutes(authBundle, { platform: platformOptions }));
// Webhook Threads tingkat platform: GET|POST /webhooks/threads
// (publik /api/webhooks/threads) — handshake threads_webhook_verify_
// token + POST bertanda tangan threads_app_secret (kredensial aplikasi
// Threads sendiri, resolver panel); consumer = pencatatan log.
routes.route(
  "/",
  createThreadsWebhookRoutes(authBundle, {
    platform: platformOptions,
    verifyToken: env.THREADS_WEBHOOK_VERIFY_TOKEN,
  }),
);
// Modul LinkedIn OAuth Connect (gelombang Semua OAuth) —
// "Hubungkan dengan LinkedIn" untuk profil pribadi: start ber-state
// sekali pakai + callback tunggal publik /oauth/linkedin/callback +
// info ketersediaan. Kredensial aplikasi dari Panel Admin
// (linkedin_client_id/secret; env hanya fallback). TANPA refresh
// token (program standar LinkedIn tidak menerbitkannya) —
// lifecycle worker bersifat tandai-reconnect.
routes.route(
  "/",
  createLinkedInOAuthRoutes(authBundle, {
    platform: platformOptions,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    linkedinApiBase: env.LINKEDIN_API_BASE,
    publicBaseUrl: env.BETTER_AUTH_URL,
    redisUrl: env.REDIS_URL,
    stateSecret: env.BETTER_AUTH_SECRET,
  }),
);
// Modul Pinterest OAuth Connect (gelombang Semua OAuth) —
// "Hubungkan dengan Pinterest": start ber-state sekali pakai +
// callback tunggal publik /oauth/pinterest/callback + info
// ketersediaan. Kredensial aplikasi dari Panel Admin
// (pinterest_app_id/secret; env hanya fallback). Access token
// ±30 hari disegarkan worker lifecycle via refresh token.
routes.route(
  "/",
  createPinterestOAuthRoutes(authBundle, {
    platform: platformOptions,
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    pinterestApiBase: env.PINTEREST_API_BASE,
    publicBaseUrl: env.BETTER_AUTH_URL,
    redisUrl: env.REDIS_URL,
    stateSecret: env.BETTER_AUTH_SECRET,
  }),
);
// Modul Bluesky Connect (gelombang Semua OAuth) — BUKAN OAuth:
// formulir handle + App Password divalidasi lewat createSession
// AT Protocol; DID menjadi external_id dan app password disimpan
// terenkripsi persis format adapter Gelombang 1.5.
routes.route(
  "/",
  createBlueskyConnectRoutes(authBundle, {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    blueskyApiBase: env.BLUESKY_API_BASE,
  }),
);

export const app = new Hono<{ Variables: AppVariables }>();
// Observability & header keamanan dipasang SEBELUM route: Hono mengeksekusi
// middleware sesuai urutan registrasi.
app.use("*", createRequestMiddleware(logger));
app.use("*", securityHeaders);
app.route("/", routes);
app.route("/api", routes);

// Better Auth handler: jalur kanonis publik adalah /api/auth/* (basePath
// default Better Auth memang /api/auth, cocok dengan mount ini).
if (authBundle) {
  const bundle = authBundle;
  app.on(["POST", "GET"], "/api/auth/*", (c) => bundle.auth.handler(c.req.raw));
}

// Kontrak error seragam untuk seluruh API (termasuk exception tak tertangani).
app.onError(createErrorHandler(logger));
app.notFound(createNotFoundHandler());

// Modul bisnis lain (channels, inbox, automations, agents, ...) dipasang
// sebagai sub-app Hono per modul — lihat src/modules/.

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
    logger.info("api.listening", {
      url: `http://localhost:${info.port}`,
      port: info.port,
      databaseConfigured: Boolean(authBundle),
      redisConfigured: Boolean(env.REDIS_URL),
      metaGraphApiVersion: META_GRAPH_API_VERSION,
    });
  });
  // WebSocket TIDAK dilayani proses ini (Fase 6G): hub webchat pensiun —
  // socket dashboard & pengunjung kini milik apps/realtime, dijangkau
  // publik lewat proxy `/realtime`.
  //
  // POLLER PENGIRIMAN JUGA TIDAK DI SINI: sejak rekomendasi analisis,
  // pengiriman outbound Telegram/Meta hidup di apps/worker (lihat
  // apps/worker/src/delivery). Proses ini sengaja tetap stateless — ia
  // hanya melayani permintaan HTTP dan boleh di-replika/di-restart
  // kapan pun tanpa memotong pengiriman yang sedang berjalan.
}
