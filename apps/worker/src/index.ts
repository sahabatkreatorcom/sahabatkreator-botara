import { Worker } from "bullmq";
import {
  loadEnv,
  META_GRAPH_API_VERSION,
  resolveMediaStorageRoot,
} from "@sahabat-kreator/config";
import { createDb } from "@sahabat-kreator/db";
import {
  createLlmProvider,
  type EmbeddingProvider,
  type LlmProvider,
} from "@sahabat-kreator/ai";
import {
  MetaGraphClient,
  ThreadsGraphClient,
} from "@sahabat-kreator/channel-messenger";
import {
  APPOINTMENT_GOOGLE_SYNC_OUTBOX_TYPE,
  AUTH_SESSION_GRACE_DAYS,
  INTEGRATION_LOG_RETENTION_DAYS,
  INVITATION_EMAIL_OUTBOX_TYPE,
  OUTBOX_DEAD_LETTER_RETENTION_DAYS,
  OUTBOX_PUBLISHED_RETENTION_DAYS,
  createDiskMediaStore,
  deliverInvitationEmail,
  dispatchBroadcast,
  embedKbDocumentChunks,
  evaluateCommentForAutomations,
  evaluateInboundMessageForAutomations,
  executeFlowStep,
  executeSequenceStep,
  pruneExpiredAuthSessions,
  pruneIntegrationLogs,
  pruneOutboxEvents,
  processBroadcastRecurrences,
  processPostRecurrences,
  processPostQueueSlots,
  dispatchOutboundWebhookEvent,
  processDueOutboundWebhookRetries,
  OUTBOUND_WEBHOOK_EVENT_TYPES,
  AD_CONVERSION_REQUESTED_OUTBOX_TYPE,
  deliverAdConversion,
  type AdConversionDeps,
  CONTACT_SCAN_REQUESTED_OUTBOX_TYPE,
  executeContactScan,
  purgeExpiredTrashedChannels,
  reconcileBroadcasts,
  recordPermanentJobFailure,
  relayUnpublishedOutboxEvents,
  resolveEmbeddingProvider,
  resolveOpenRouterConfig,
  resolvePostMediaPublicBaseUrl,
  resolveTikTokPrivacyLevel,
  resolveYouTubePrivacyStatus,
  respondToInboundMessage,
  syncBookingToGoogle,
  type CommentGraphActions,
  type GoogleDeps,
  type PaymentDeps,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import { runMetaTokenLifecycle } from "./meta-token-lifecycle";
import { runThreadsTokenLifecycle } from "./threads-token-lifecycle";
import { runTikTokTokenLifecycle } from "./tiktok-token-lifecycle";
import { runLinkedInTokenLifecycle } from "./linkedin-token-lifecycle";
import { runPinterestTokenLifecycle } from "./pinterest-token-lifecycle";
import { startMediaIngestLoop } from "./media-ingest";
import { MEDIA_GC_INTERVAL_MS, startMediaGcLoop } from "./media-gc";
import {
  startMetaDeliveryPoller,
  startTelegramDeliveryPoller,
  type DeliveryPoller,
} from "./delivery";
import { publishPost } from "./delivery/post-publisher";
import { processPostAnalytics } from "./delivery/post-metrics";
import {
  AGENT_RESPOND_JOB,
  AUTOMATION_EVALUATE_JOB,
  BROADCAST_DISPATCH_JOB,
  COMMENT_EVALUATE_JOB,
  FLOW_STEP_JOB,
  KB_EMBED_JOB,
  MAIN_QUEUE_NAME,
  SEQUENCE_STEP_JOB,
  TEAM_INVITATION_EMAIL_JOB,
  APPOINTMENT_GOOGLE_SYNC_JOB,
  POST_PUBLISH_JOB,
  OUTBOUND_WEBHOOK_FANOUT_JOB,
  AD_CONVERSION_SEND_JOB,
  CONTACT_SCAN_JOB,
  createAutomationQueue,
  createRealtimePublisher,
  createRedisConnection,
  enqueueAgentRespond,
  enqueueAutomationEvaluate,
  enqueueBroadcastDispatch,
  enqueueCommentEvaluate,
  enqueueFlowStep,
  enqueueAppointmentGoogleSync,
  enqueueInvitationEmail,
  enqueuePostPublish,
  enqueueOutboundWebhookFanout,
  enqueueAdConversionSend,
  enqueueContactScan,
  enqueueKbEmbed,
  enqueueSequenceStep,
  type AgentRespondJobData,
  type AutomationEvaluateJobData,
  type BroadcastDispatchJobData,
  type CommentEvaluateJobData,
  type FlowStepJobData,
  type AppointmentGoogleSyncJobData,
  type PostPublishJobData,
  type OutboundWebhookFanoutJobData,
  type AdConversionSendJobData,
  type ContactScanJobData,
  type InvitationEmailJobData,
  type KbEmbedJobData,
  type MainJobData,
  type SequenceStepJobData,
} from "@sahabat-kreator/queue";

/**
 * Worker Sahabat Kreator (Fase 2A) — proses terpisah dari API.
 *
 * Dua tanggung jawab:
 * 1. RELAY OUTBOX (pola polling, interval RELAY_INTERVAL_MS):
 *    mengklaim event `outbox_events` yang belum ter-publish (semua tenant,
 *    lewat policy `system_relay` + klaim FOR UPDATE SKIP LOCKED di core)
 *    dan menerjemahkannya:
 *      - `message.received` → enqueue job `automation.evaluate` dengan
 *        jobId deterministik dari id event (idempoten: event yang sama
 *        tidak pernah menghasilkan dua job).
 *      - tipe lain (mis. `message.queued`) → tidak ada konsumen relay saat
 *        ini; event tetap ditandai published agar antrean relay tidak
 *        menumpuk. (Konsumen `message.queued` adalah poller pengiriman di
 *        proses worker ini yang membaca tabel messages langsung —
 *        lihat butir 10 di bawah.)
 * 2. EVALUASI AUTOMATION (BullMQ Worker): job `automation.evaluate`
 *    menjalankan `evaluateInboundMessageForAutomations` di core — pencocokan
 *    keyword, pembuatan balasan `queued`, run, dan audit terjadi di sana
 *    dalam konteks RLS tenant.
 * 3. RESPONS AGENT (Fase 3A): bila evaluasi automation selesai TANPA
 *    tembakan, processor yang sama meng-enqueue job `agent.respond`
 *    (jobId deterministik dari id pesan). Job itu menjalankan
 *    `respondToInboundMessage` di core: retrieval KB full-text → provider
 *    LLM (mock default / OpenRouter via env) → eksekusi tool / draf
 *    saran → metering usage_ledger + audit. Balasan agent juga berhenti
 *    sebagai pesan `queued`; poller worker yang mengirimkannya (butir 10).
 *    Fase 9A: job di-enqueue dengan delay jendela batch
 *    (AGENT_BATCH_WINDOW_MS, default 5000) dan core menyerah
 *    (agent.batched) bila ada pesan masuk yang lebih baru — satu
 *    rentetan pesan hanya dijawab sekali; automation/flow tidak ikut
 *    tertunda.
 * 4. LANGKAH SEQUENCE (Fase 2C): relay juga menerjemahkan event outbox
 *    `sequence.step_due` menjadi job tertunda `sequence.step`
 *    (delay = delay_minutes langkah, jobId `seq-<enrollmentId>-<posisi>`).
 *    Processor-nya menjalankan `executeSequenceStep` di core: kirim satu
 *    langkah sebagai pesan `queued`, majukan enrollment, jadwalkan
 *    langkah berikut (atau selesaikan). Pesan pemicu sequence dihitung
 *    sebagai tembakan automation — tidak diteruskan ke agent.
 * 5. BROADCAST (Fase 7C): relay menerjemahkan event outbox
 *    `broadcast.dispatch_due` menjadi job tertunda `broadcast.dispatch`
 *    (delay = scheduled_at; jobId `broadcast-<broadcastId>`).
 *    Processor-nya menjalankan `dispatchBroadcast` di core:
 *    materialisasi penerima + pesan `queued` per penerima (opt-out &
 *    jendela 24 jam Meta menjadi `skipped`). Pengiriman tetap oleh
 *    poller worker (butir 10); penyapu berkala menutup broadcast
 *    `reconcileBroadcasts` (sinkron status penerima ← status pesan).
 * 6. FLOW ENGINE (Fase 8A): evaluasi pesan masuk (processor yang sama)
 *    diperluas — sesudah automation keyword/sequence, flow AKTIF yang
 *    trigger-nya cocok memulai run di core; agent hanya menerima pesan
 *    yang tidak ditangani keduanya. Relay menerjemahkan event outbox
 *    `flow.step_due` menjadi job tertunda `flow.step`
 *    (jobId `flow-<runId>-<seq>`); processor-nya menjalankan
 *    `executeFlowStep` di core (graf node: kirim pesan, kondisi, delay,
 *    tag/stage, enroll sequence, respons AI, handoff) dengan log per
 *    langkah di `flow_run_steps`.`
 * 7. EMBEDDING KB (Fase 12D): relay menerjemahkan event outbox
 *    `kb.embed_requested` (ditulis core saat dokumen KB dibuat atau
 *    berkas diimpor) menjadi job `kb.embed`; processor-nya menjalankan
 *    `embedKbDocumentChunks` di core dengan provider embedding yang
 *    di-resolve per job (mock paksa via env / OpenRouter panel→env /
 *    nonaktif). Retrieval agent & node flow ai_response memakai
 *    provider yang sama untuk meng-embed kueri — hibrida bila aktif.
 * 8. EMAIL UNDANGAN TIM (Fase 11B): relay menerjemahkan event outbox
 *    `team.invitation_email_requested` (ditulis API sesudah undangan
 *    tercipta, hanya bila email platform terkonfigurasi) menjadi job
 *    `team.invitation_email`; processor-nya menjalankan
 *    `deliverInvitationEmail` di core: konfigurasi Resend di-resolve
 *    per job (panel → env), token undangan dibuka dari ciphertext
 *    payload, email dwibahasa dikirim, dan hasil tercatat di baris
 *    undangan (email_sent_at / email_error). Kegagalan provider
 *    DILEMPAR agar BullMQ retry (attempts 3) — undangan sendiri tetap
 *    sah lewat tautan salin apa pun hasil emailnya.
 * 9. SINKRON GOOGLE CALENDAR (Fase 13G): relay menerjemahkan event
 *    outbox `appointment.google_sync_requested` (ditulis transaksi
 *    booking buat/batal pada tenant terhubung Google) menjadi job
 *    `appointment.google_sync`; processor-nya menjalankan sinkron di
 *    core — booking tidak pernah menunggu atau gagal karena Google.
 * 10. PENGIRIMAN OUTBOUND TELEGRAM & META: dua poller berkala
 *    (`delivery/telegram.ts`, `delivery/meta.ts`) memindai pesan
 *    `queued` lintas tenant, mengklaim tiap baris, mendekripsi token
 *    akun sesaat di memori, lalu memanggil Bot API / Graph Send API.
 *    Keduanya berbagi satu runner (`delivery/runner.ts`) sehingga
 *    siklus klaim → validasi → kirim → tandai → log → nudge hanya ada
 *    di satu tempat. Poller ini SEBELUMNYA hidup di proses API;
 *    dipindahkan ke sini agar replika HTTP tetap stateless dan rolling
 *    deploy tidak memotong pengiriman yang sedang berjalan.
 *
 * Worker TIDAK mengirim pesan ke pengunjung: sejak Fase 6G socket
 * pengunjung & dashboard milik apps/realtime. Balasan automation/agent/
 * sequence berhenti sebagai pesan `queued`; worker menerbitkan nudge
 * `message.queued` ke Redis pub/sub setelah job selesai, dan
 * apps/realtime mem-flush-nya ke pengunjung webchat yang terhubung
 * (→ `sent`) + mendorong nudge ke dashboard (lihat @sahabat-kreator/queue
 * soal jembatan pub/sub ini). Nudge bersifat fail-soft — Redis mati
 * hanya menurunkan kesegaran ke polling fallback klien.
 */

const RELAY_INTERVAL_MS = 2_000;

const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new Error("[worker] DATABASE_URL wajib diisi");
}
if (!env.REDIS_URL) {
  throw new Error("[worker] REDIS_URL wajib diisi");
}

// Worker menjalankan fan-out massal (broadcast, automasi), jadi batas
// statement-nya lebih longgar daripada API — tetap ada batas, supaya satu
// job yang menggantung tidak menahan pool selamanya.
const { db, pool } = createDb(env.DATABASE_URL, {
  applicationName: "sk-worker",
  statementTimeoutMs: 60_000,
});
const queueConnection = createRedisConnection(env.REDIS_URL);
const workerConnection = createRedisConnection(env.REDIS_URL);
const queue = createAutomationQueue(queueConnection);
// Penerbit nudge realtime (Fase 6G) — koneksi Redis khusus publish,
// terpisah dari koneksi BullMQ (lihat @sahabat-kreator/queue/realtime).
const realtimePublisher = createRealtimePublisher(env.REDIS_URL);

// Provider LLM agent (Fase 3A; resolusi per job sejak Fase 6C):
// provider TIDAK lagi dibekukan saat boot. Setiap job agent.respond
// me-resolve kunci OpenRouter efektif lewat resolver core Panel Admin —
// panel terenkripsi lebih dulu, env fallback (cache ±60 dtk di core) —
// jadi kunci yang disimpan/diubah pemilik platform di panel berlaku
// tanpa restart worker:
//   - ada kunci efektif → OpenRouterProvider (model: panel → env →
//     default provider);
//   - tidak ada kunci di mana pun → MockProvider (perilaku staging 3A);
//   - LLM_PROVIDER=openrouter eksplisit TANPA kunci di mana pun →
//     createLlmProvider melempar (salah konfigurasi tetap GAGAL KERAS,
//     tidak diam-diam jatuh ke mock — sama seperti fail-fast boot 3A;
//     resolusi awal di bawah menjaga kegagalan itu terlihat saat start).
const platformSettingsOptions: PlatformSettingsOptions = {
  masterSecret: env.PLATFORM_SETTINGS_SECRET,
  env: {
    openrouter_api_key: env.OPENROUTER_API_KEY,
    openrouter_model: env.OPENROUTER_MODEL,
    // Fase 11B: fallback env konfigurasi email Resend (sumber utama
    // Panel Admin) agar job email undangan me-resolve konfigurasi yang
    // sama seperti API.
    resend_api_key: env.RESEND_API_KEY,
    resend_from_email: env.RESEND_FROM_EMAIL,
    resend_from_name: env.RESEND_FROM_NAME,
    // Fase 13G: fallback env klien OAuth Google (sumber utama Panel
    // Admin) agar job sinkron Calendar + node book_appointment
    // me-resolve klien yang sama seperti API.
    google_oauth_client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    google_oauth_client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    // Gelombang Pemisahan Google: klien OAuth per layanan — refresh
    // token YouTube/Business di worker WAJIB memakai klien layanan
    // penerbit tokennya; env di sini fallback berjenjang yang sama
    // seperti API (panel per-layanan → panel bersama → env).
    google_calendar_client_id: env.GOOGLE_CALENDAR_CLIENT_ID,
    google_calendar_client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
    google_youtube_client_id: env.GOOGLE_YOUTUBE_CLIENT_ID,
    google_youtube_client_secret: env.GOOGLE_YOUTUBE_CLIENT_SECRET,
    google_business_client_id: env.GOOGLE_BUSINESS_CLIENT_ID,
    google_business_client_secret: env.GOOGLE_BUSINESS_CLIENT_SECRET,
    // G16: klien OAuth layanan 'ads' + developer token Google Ads —
    // refresh token layanan 'ads' (job pengiriman konversi) WAJIB
    // memakai klien penerbitnya; developer token dibaca
    // deliverAdConversion dari resolver platform yang sama.
    google_ads_client_id: env.GOOGLE_ADS_CLIENT_ID,
    google_ads_client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
    google_ads_developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    // Kredensial aplikasi LinkedIn (gelombang Semua OAuth): lifecycle
    // token LinkedIn tidak me-refresh (LinkedIn tidak menerbitkan
    // refresh token untuk program standar), tetapi resolusi panel →
    // env tetap dipetakan agar objek opsi proses ini lengkap.
    linkedin_client_id: env.LINKEDIN_CLIENT_ID,
    linkedin_client_secret: env.LINKEDIN_CLIENT_SECRET,
    // Kredensial aplikasi Pinterest (gelombang Semua OAuth): dipakai
    // lifecycle refresh token Pinterest sebagai Basic auth token
    // endpoint v5 — panel menang, env fallback, sama seperti API.
    pinterest_app_id: env.PINTEREST_APP_ID,
    pinterest_app_secret: env.PINTEREST_APP_SECRET,
    // Kredensial aplikasi TikTok (gelombang Semua OAuth): dipakai
    // lifecycle refresh token TikTok (grant refresh_token butuh
    // client_key + client_secret) — panel menang, env fallback.
    tiktok_client_key: env.TIKTOK_CLIENT_KEY,
    tiktok_client_secret: env.TIKTOK_CLIENT_SECRET,
    // Lifecycle token Meta (0010): kredensial aplikasi untuk refresh
    // `tbft` — panel menang, env fallback, sama seperti API.
    meta_app_id: env.META_APP_ID,
    meta_app_secret: env.META_APP_SECRET,
    // Instruksi pemilik 2026-11-12: model embedding + pengaturan
    // content schedule ikut resolver panel — env hanya fallback,
    // sama seperti API (dipakai resolusi embedding per job dan
    // resolusi pengaturan publikasi per job post.publish di bawah).
    openrouter_embedding_model: env.OPENROUTER_EMBEDDING_MODEL,
    post_media_public_base_url: env.POST_MEDIA_PUBLIC_BASE_URL,
    youtube_privacy_status: env.YOUTUBE_PRIVACY_STATUS,
    tiktok_privacy_level: env.TIKTOK_PRIVACY_LEVEL,
    // Identitas R2: bucket adalah satu-satunya kunci identitas yang
    // punya fallback env (R2_BUCKET) — dipetakan agar objek opsi
    // proses ini lengkap bila konsumen worker me-resolve
    // `resolveR2Identity` (semantik panel → env → bawaan yang sama
    // seperti API). Account id & endpoint memang tanpa env.
    r2_bucket: env.R2_BUCKET,
  },
};

/**
 * Dependensi Google Calendar (Fase 13G) untuk node book_appointment
 * (freebusy mesin slot) + job sinkron event. Base URL dioverride env
 * untuk mock rantai — pola RESEND_API_BASE. Tanpa klien platform,
 * core menjawab fail-soft (slot internal tetap jalan; sinkron
 * tercatat not_connected) — worker tidak perlu bercabang.
 */
const googleDeps: GoogleDeps = {
  platform: platformSettingsOptions,
  tokenSecret: env.CHANNEL_TOKEN_SECRET,
  bases: {
    apiBase: env.GOOGLE_API_BASE,
    tokenBase: env.GOOGLE_TOKEN_BASE,
    authBase: env.GOOGLE_AUTH_BASE,
  },
};

/**
 * Dependensi gerbang pembayaran (Fase 14A) untuk node flow
 * send_payment_link/cart_checkout + tool agent send_payment_link:
 * secret enkripsi kredensial tenant + override base URL provider
 * untuk mock rantai. Konfigurasi providernya sendiri dibaca core
 * dari DB per tenant.
 */
const paymentDeps: PaymentDeps = {
  tokenSecret: env.CHANNEL_TOKEN_SECRET,
  midtransApiBase: env.MIDTRANS_API_BASE,
  xenditApiBase: env.XENDIT_API_BASE,
  publicBaseUrl: env.BETTER_AUTH_URL,
};

/**
 * Dependensi konversi iklan (G16) untuk job `ad-conversion.send`:
 * secret enkripsi kredensial tenant + resolver kredensial platform
 * (developer token Google Ads) + override base URL platform untuk
 * mock rantai (META_API_BASE pola yang sama seperti Meta lain;
 * GOOGLE_ADS_API_BASE untuk Ads API; base token Google dipakai
 * refresh token layanan 'ads'). Konfigurasinya sendiri dibaca core
 * dari DB per tenant.
 */
const adConversionDeps: AdConversionDeps = {
  tokenSecret: env.CHANNEL_TOKEN_SECRET,
  platform: platformSettingsOptions,
  metaApiBase: env.META_API_BASE,
  googleBases: {
    apiBase: env.GOOGLE_API_BASE,
    tokenBase: env.GOOGLE_TOKEN_BASE,
    authBase: env.GOOGLE_AUTH_BASE,
    adsBase: env.GOOGLE_ADS_API_BASE,
  },
};

async function resolveAgentLlmProvider(): Promise<LlmProvider> {
  const orConfig = await resolveOpenRouterConfig(db, platformSettingsOptions);
  return createLlmProvider({
    provider: orConfig ? "openrouter" : env.LLM_PROVIDER,
    openrouterApiKey: orConfig?.apiKey,
    openrouterModel: orConfig?.model,
  });
}

// Provider EMBEDDING agent (Fase 12D): di-resolve per job dengan
// resolver core yang sama seperti LLM (kunci OpenRouter Panel → env),
// DITAMBAH env EMBEDDING_PROVIDER: 'mock' memaksa mock deterministik
// (rantai uji — tidak pernah menyentuh provider asli walau kunci panel
// terisi). Tanpa kunci & tanpa paksaan mock → null: job `kb.embed`
// selesai tanpa efek dan retrieval agent berjalan full-text murni.
// Kegagalan resolusi TIDAK boleh mematikan job agent — diperlakukan
// sama seperti "tidak aktif".
async function resolveWorkerEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  try {
    return await resolveEmbeddingProvider(db, {
      platform: platformSettingsOptions,
      providerEnv: env.EMBEDDING_PROVIDER,
      modelEnv: env.OPENROUTER_EMBEDDING_MODEL,
    });
  } catch (err) {
    console.error("[worker] resolusi provider embedding gagal (diperlakukan nonaktif):", err);
    return null;
  }
}

/**
 * Pengaturan publikasi content schedule efektif per job post.publish
 * (instruksi pemilik 2026-11-12): Panel Admin → env lewat resolver
 * bertipe core, cache ±60 dtk — perubahan panel berlaku tanpa restart
 * worker. Kegagalan resolusi TIDAK boleh mematikan publikasi (pola
 * resolver embedding di atas): jatuh ke nilai env proses ini, yang
 * juga membawa bawaan aman config bila env kosong.
 *
 * Sejak gelombang Pilihan Privasi & AI per Postingan, dua level
 * privasi di sini berperan sebagai NILAI BAWAAN platform: pilihan
 * pengguna pada postingan (payload `publishOptions`) menimpanya di
 * adapter; bawaan hanya berlaku untuk postingan tanpa pilihan.
 */
async function resolvePostPublishSettings(): Promise<{
  publicMediaBaseUrl?: string;
  youtubePrivacyStatus: string;
  tiktokPrivacyLevel: string;
}> {
  try {
    const [baseUrl, youtubePrivacyStatus, tiktokPrivacyLevel] =
      await Promise.all([
        resolvePostMediaPublicBaseUrl(db, platformSettingsOptions),
        resolveYouTubePrivacyStatus(db, platformSettingsOptions),
        resolveTikTokPrivacyLevel(db, platformSettingsOptions),
      ]);
    return {
      publicMediaBaseUrl: baseUrl ?? undefined,
      youtubePrivacyStatus,
      tiktokPrivacyLevel,
    };
  } catch (err) {
    console.error(
      "[worker] resolusi pengaturan publikasi gagal (jatuh ke env):",
      err,
    );
    return {
      publicMediaBaseUrl: env.POST_MEDIA_PUBLIC_BASE_URL,
      youtubePrivacyStatus: env.YOUTUBE_PRIVACY_STATUS,
      tiktokPrivacyLevel: env.TIKTOK_PRIVACY_LEVEL,
    };
  }
}

void resolveAgentLlmProvider()
  .then((provider) => {
    console.log(`[worker] provider LLM agent (resolusi awal): ${provider.name}`);
  })
  .catch((err) => {
    console.error("[worker] resolusi provider LLM gagal saat start:", err);
    process.exit(1);
  });

// Aksi Graph langsung untuk evaluasi komentar (Fase 10B; G7 menambah
// Threads): balasan publik + sembunyikan komentar dijalankan worker
// (bukan pesan percakapan, jadi tidak lewat antrean/poller). Klien
// dibangun per panggilan dengan token akun pemilik komentar yang
// diserahkan core; base URL mengikuti env META_API_BASE /
// THREADS_API_BASE (mock pada rantai uji). DM TIDAK lewat sini — DM
// Meta diantrekan core sebagai pesan; Threads tidak punya DM sama
// sekali (core mencatatnya skipped, worker tidak pernah dipanggil).
const commentGraphActions: CommentGraphActions = {
  async replyToComment(input) {
    if (input.provider === "threads") {
      // Balasan publik Threads: container teks dengan reply_to_id =
      // media yang dikomentari, tunggu FINISHED, lalu terbitkan.
      const client = new ThreadsGraphClient({
        baseUrl: env.THREADS_API_BASE,
        accessToken: input.accessToken,
      });
      const container = await client.createThreadsContainer({
        threadsUserId: input.accountExternalId,
        mediaType: "TEXT",
        text: input.text,
        replyToId: input.commentId,
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await client.getThreadsContainerStatus(
          container.containerId,
        );
        if (status === "FINISHED" || status === "PUBLISHED") break;
        if (status === "ERROR" || status === "EXPIRED") {
          throw new Error("threads_container_failed");
        }
        if (attempt === 19) throw new Error("threads_container_timeout");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const published = await client.publishThreadsContainer({
        threadsUserId: input.accountExternalId,
        containerId: container.containerId,
      });
      return { replyId: published.providerPostId };
    }
    const client = new MetaGraphClient({
      baseUrl: env.META_API_BASE,
      apiVersion: META_GRAPH_API_VERSION,
      accessToken: input.accessToken,
    });
    return client.replyToComment({
      provider: input.provider,
      commentId: input.commentId,
      text: input.text,
    });
  },
  async setCommentHidden(input) {
    if (input.provider === "threads") {
      const client = new ThreadsGraphClient({
        baseUrl: env.THREADS_API_BASE,
        accessToken: input.accessToken,
      });
      await client.manageThreadsReply({
        replyId: input.commentId,
        hide: input.hidden,
      });
      return;
    }
    const client = new MetaGraphClient({
      baseUrl: env.META_API_BASE,
      apiVersion: META_GRAPH_API_VERSION,
      accessToken: input.accessToken,
    });
    await client.setCommentHidden({
      provider: input.provider,
      commentId: input.commentId,
      hidden: input.hidden,
    });
  },
};

const bullWorker = new Worker<MainJobData>(
  MAIN_QUEUE_NAME,
  async (job) => {
    if (job.name === OUTBOUND_WEBHOOK_FANOUT_JOB) {
      // G11: fan-out satu event outbox katalog webhook keluar ke
      // endpoint tenant yang melanggan. Core membuat baris pengiriman
      // (idempoten per (endpoint, event)) + melakukan percobaan
      // pertama; percobaan ulang ditangani penyapu berbasis
      // next_attempt_at, BUKAN retry job ini. Kegagalan tingkat DB
      // dilempar agar BullMQ mencoba lagi (jobId deterministik
      // menjaga tidak ada fan-out ganda).
      const data = job.data as OutboundWebhookFanoutJobData;
      const result = await dispatchOutboundWebhookEvent(
        db,
        {
          tenantId: data.tenantId,
          eventType: data.eventType,
          sourceEventId: data.outboxEventId,
          sourcePayload: data.payload ?? {},
        },
        { encryptionSecret: env.CHANNEL_TOKEN_SECRET ?? "" },
      );
      if (result.created > 0) {
        console.log(
          `[worker] outbound-webhook.fanout event=${data.outboxEventId} type=${data.eventType} matched=${result.matched} created=${result.created}`,
        );
      }
      return result;
    }
    if (job.name === AD_CONVERSION_SEND_JOB) {
      // G16: kirim satu baris ledger konversi iklan ke platformnya.
      // Hasil platform (termasuk kegagalan provider) dicatat core di
      // baris + log integrasi dan BUKAN kegagalan job — yang dilempar
      // hanya kegagalan DB agar BullMQ mencoba lagi (pengiriman
      // idempoten per baris: 'sent' tidak pernah dikirim ulang).
      const data = job.data as AdConversionSendJobData;
      const result = await deliverAdConversion(
        db,
        { tenantId: data.tenantId, eventRowId: data.adConversionEventRowId },
        adConversionDeps,
      );
      console.log(
        `[worker] ad-conversion.send event=${data.outboxEventId} row=${data.adConversionEventRowId} result=${result.kind}`,
      );
      return result;
    }
    if (job.name === CONTACT_SCAN_JOB) {
      // G18 butir 2: jalankan satu pindai pelanggan otomatis.
      // Kegagalan DB dilempar core (baris pindai ditandai 'failed')
      // agar BullMQ mencoba lagi; eksekusi idempoten per baris.
      const data = job.data as ContactScanJobData;
      const result = await executeContactScan(db, {
        tenantId: data.tenantId,
        scanRunId: data.scanRunId,
      });
      console.log(
        `[worker] contact-scan.run event=${data.outboxEventId} scan=${data.scanRunId} result=${result.kind}`,
      );
      return result;
    }
    if (job.name === AUTOMATION_EVALUATE_JOB) {
      const data = job.data as AutomationEvaluateJobData;
      const result = await evaluateInboundMessageForAutomations(
        db,
        {
          tenantId: data.tenantId,
          conversationId: data.conversationId,
          messageId: data.messageId,
        },
        { googleDeps },
      );
      if (
        result.fired.length > 0 ||
        result.skippedDuplicates > 0 ||
        result.flowRunsStarted > 0
      ) {
        console.log(
          `[worker] automation.evaluate event=${data.outboxEventId} fired=${result.fired.length} duplicates=${result.skippedDuplicates} flowRuns=${result.flowRunsStarted}`,
        );
      }
      // Fase 6G: automation yang menembak membuat pesan outbound
      // `queued` — nudge agar apps/realtime mem-flush ke pengunjung
      // webchat & dashboard menyegar (terbit SETELAH core commit).
      // Fase 13C: transisi opt-in juga bisa mengantrekan balasan
      // konfirmasi — nudge yang sama (kelebihan nudge = refetch murah).
      if (result.fired.length > 0 || result.consentAction === "opt_in") {
        await realtimePublisher.publishNudge({
          kind: "message.queued",
          tenantId: data.tenantId,
          conversationId: data.conversationId,
        });
      }
      // Fase 3A — urutan pasti keyword → AI: hanya bila evaluasi berjalan
      // dan TIDAK ada automation yang menembak (dan bukan duplikat dari
      // tembakan sebelumnya), pesan diteruskan ke agent. Agent sendiri
      // memeriksa ulang kelayakannya (agent aktif, ai_enabled, caps).
      // Fase 2C: pendaftaran sequence dihitung sebagai tembakan (fired),
      // jadi pesan pemicu sequence TIDAK pernah diteruskan ke agent.
      // Fase 8A: run flow yang dimulai (atau duplikatnya) juga dihitung
      // tertangani — urutan lengkapnya keyword → flow → AI.
      if (
        result.evaluated &&
        result.fired.length === 0 &&
        result.skippedDuplicates === 0 &&
        result.flowRunsStarted === 0 &&
        result.flowDuplicateStarts === 0 &&
        // Fase 12A: pesan yang melanjutkan run wait_reply parkir juga
        // tertangani flow — cabang replied adalah responsnya.
        result.flowWaitReplyResumed === 0 &&
        // Fase 13E: pesan yang menjadi jawaban questionnaire parkir
        // juga tertangani flow — agent tidak ikut menjawab survei
        // yang sedang berjalan.
        result.flowQuestionnaireResumed === 0 &&
        // Fase 13F: pesan yang menjadi pilihan katalog parkir juga
        // tertangani flow — agent tidak ikut menjawab sesi belanja
        // yang sedang berjalan.
        result.flowCatalogResumed === 0 &&
        // Fase 13G: pesan yang menjadi pilihan slot book_appointment
        // parkir juga tertangani flow — agent tidak ikut menjawab
        // sesi pemesanan yang sedang berjalan.
        result.flowAppointmentResumed === 0 &&
        // Fase 13C: pesan consent (kata opt-in/opt-out persis) adalah
        // perintah persetujuan yang tertangani sistem — tidak pernah
        // diteruskan ke agent sebagai pertanyaan biasa.
        result.consentAction === null &&
        // G5: sinyal POSTBACK tidak pernah diteruskan ke agent —
        // payload mesin (termasuk yang tidak dikenal aturan mana
        // pun) bukan percakapan. Quick reply TIDAK diblokir di sini:
        // tanpa pemicu QR yang cocok ia turun kelas menjadi teks
        // biasa (judul tombolnya) dan agent boleh menjawabnya.
        // Urutan lengkapnya: trigger-priority.ts di core.
        result.triggerSignalKind !== "postback"
      ) {
        // Fase 9A — batching: job respond ditunda sebesar jendela
        // batch (env AGENT_BATCH_WINDOW_MS, default 5000). Job yang
        // pesannya sudah disusul pesan yang lebih baru akan menyerah
        // di core (agent.batched); hanya job pesan terbaru yang
        // benar-benar memanggil LLM. Automation/flow di atas TIDAK
        // ikut tertunda — penundaan hanya milik jalur agent.
        await enqueueAgentRespond(
          queue,
          {
            tenantId: data.tenantId,
            conversationId: data.conversationId,
            messageId: data.messageId,
          },
          { delay: env.AGENT_BATCH_WINDOW_MS },
        );
      }
      return result;
    }
    if (job.name === SEQUENCE_STEP_JOB) {
      // Fase 2C: satu langkah sequence. Eksekusi, aturan berhenti, dan
      // penjadwalan langkah berikutnya (lewat event outbox) ada di core;
      // worker hanya menjalankan dan mencatat hasilnya.
      const data = job.data as SequenceStepJobData;
      const result = await executeSequenceStep(db, {
        tenantId: data.tenantId,
        enrollmentId: data.enrollmentId,
        stepPosition: data.stepPosition,
      });
      // Fase 6G: langkah tereksekusi = pesan `queued` baru → nudge.
      if (result.executed && result.conversationId) {
        await realtimePublisher.publishNudge({
          kind: "message.queued",
          tenantId: data.tenantId,
          conversationId: result.conversationId,
        });
      }
      console.log(
        `[worker] sequence.step enrollment=${data.enrollmentId} position=${data.stepPosition} executed=${result.executed}` +
          (result.reason ? ` reason=${result.reason}` : "") +
          (result.nextStepPosition !== undefined
            ? ` next=${result.nextStepPosition ?? "done"}`
            : ""),
      );
      return result;
    }
    if (job.name === BROADCAST_DISPATCH_JOB) {
      // Fase 7C: dispatch satu broadcast — klaim atomik, materialisasi
      // penerima + pesan `queued`, aturan opt-out & jendela 24 jam Meta
      // semuanya di core. Pengiriman sesungguhnya tetap oleh poller
      // telegram/meta di proses worker ini; penutupan status akhir oleh
      // penyapu `reconcileBroadcasts` di bawah.
      const data = job.data as BroadcastDispatchJobData;
      const result = await dispatchBroadcast(db, {
        tenantId: data.tenantId,
        broadcastId: data.broadcastId,
      });
      console.log(
        `[worker] broadcast.dispatch broadcast=${data.broadcastId} dispatched=${result.dispatched}` +
          (result.reason ? ` reason=${result.reason}` : "") +
          (result.materialized !== undefined
            ? ` materialized=${result.materialized} queued=${result.queued ?? 0} skipped=${result.skipped ?? 0}`
            : ""),
      );
      return result;
    }
    if (job.name === POST_PUBLISH_JOB) {
      // Fase 23: terbitkan SATU postingan channel. Klaim atomik, validasi
      // ulang, dan penandaan status ada di core; pengiriman diserahkan ke
      // `PublisherAdapter` provider sasaran (Gelombang 0) — handler ini
      // tidak lagi tahu platform apa yang sedang diterbitkan.
      const data = job.data as PostPublishJobData;
      // Pengaturan publikasi di-resolve per job lewat Panel Admin →
      // env (bukan statis saat boot) agar perubahan panel — mis.
      // menaikkan privasi TikTok sesudah audit — berlaku tanpa
      // restart worker.
      const postSettings = await resolvePostPublishSettings();
      const result = await publishPost(
        db,
        {
          tenantId: data.tenantId,
          postId: data.postId,
          scheduledAt: data.scheduledAt,
        },
        {
          channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
          telegramApiBase: env.TELEGRAM_API_BASE,
          metaApiBase: env.META_API_BASE,
          metaGraphApiVersion: META_GRAPH_API_VERSION,
          threadsApiBase: env.THREADS_API_BASE,
          blueskyApiBase: env.BLUESKY_API_BASE,
          publicMediaBaseUrl: postSettings.publicMediaBaseUrl,
          google: googleDeps,
          youtubePrivacyStatus: postSettings.youtubePrivacyStatus,
          linkedinApiBase: env.LINKEDIN_API_BASE,
          pinterestApiBase: env.PINTEREST_API_BASE,
          googleBusinessApiBase: env.GOOGLE_BUSINESS_API_BASE,
          tiktokApiBase: env.TIKTOK_API_BASE,
          tiktokPrivacyLevel: postSettings.tiktokPrivacyLevel,
          mediaStore,
        },
      );
      console.log(
        `[worker] post.publish post=${data.postId} published=${result.published}` +
          (result.reason ? ` reason=${result.reason}` : ""),
      );
      return result;
    }
    if (job.name === FLOW_STEP_JOB) {
      // Fase 8A: eksekusi run flow — node demi node di core sampai run
      // menunggu (delay) atau terminal. Node `ai_response` me-resolve
      // provider LLM per job (panel → env → mock), sama seperti
      // agent.respond; resolusi diteruskan sebagai callback agar core
      // hanya memakainya bila node itu benar-benar dicapai.
      const data = job.data as FlowStepJobData;
      const result = await executeFlowStep(
        db,
        {
          tenantId: data.tenantId,
          runId: data.runId,
          stepSeq: data.stepSeq,
        },
        {
          resolveLlmProvider: resolveAgentLlmProvider,
          resolveEmbeddingProvider: resolveWorkerEmbeddingProvider,
          publicBaseUrl: env.BETTER_AUTH_URL,
          google: googleDeps,
          payments: paymentDeps,
          // G17: node send_dynamic_image menyimpan kartu PNG ke
          // store yang sama dengan jalur media lain.
          mediaStore,
        },
      );
      // Pesan `queued` yang dibuat langkah ini → nudge pengiriman.
      if (result.outboundMessageId && result.conversationId) {
        await realtimePublisher.publishNudge({
          kind: "message.queued",
          tenantId: data.tenantId,
          conversationId: result.conversationId,
        });
      }
      if (result.stepsExecuted || result.reason) {
        console.log(
          `[worker] flow.step run=${data.runId} seq=${data.stepSeq} executed=${result.executed}` +
            (result.status ? ` status=${result.status}` : "") +
            (result.reason ? ` reason=${result.reason}` : "") +
            (result.stepsExecuted !== undefined
              ? ` steps=${result.stepsExecuted}`
              : ""),
        );
      }
      return result;
    }
    if (job.name === COMMENT_EVALUATE_JOB) {
      // Fase 10B: evaluasi satu komentar terhadap aturan komentar
      // akunnya. DM menjadi pesan `queued` di core (poller worker yang
      // mengirim private reply-nya); balasan publik + sembunyikan
      // adalah panggilan Graph langsung lewat commentGraphActions.
      const data = job.data as CommentEvaluateJobData;
      const result = await evaluateCommentForAutomations(
        db,
        { tenantId: data.tenantId, commentId: data.commentId },
        {
          channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
          graph: commentGraphActions,
        },
      );
      if (result.evaluated) {
        console.log(
          `[worker] comment.evaluate comment=${data.commentId} matched=${result.matchedAutomationId ?? "none"}` +
            (result.skippedOwnComment ? " skipped=own_comment" : "") +
            (result.actions?.dm
              ? ` dm=${result.actions.dm.status}`
              : "") +
            (result.actions?.publicReply
              ? ` publicReply=${result.actions.publicReply.status}`
              : "") +
            (result.actions?.hide
              ? ` hide=${result.actions.hide.status}`
              : ""),
        );
        // DM yang terantre = pesan `queued` baru → nudge agar
        // dashboard menyegar (pengiriman sesungguhnya oleh poller worker).
        if (result.actions?.dm?.status === "queued" && result.conversationId) {
          await realtimePublisher.publishNudge({
            kind: "message.queued",
            tenantId: data.tenantId,
            conversationId: result.conversationId,
          });
        }
      }
      return result;
    }
    if (job.name === KB_EMBED_JOB) {
      // Fase 12D: bangkitkan embedding chunk satu dokumen KB. Tanpa
      // provider aktif → selesai tanpa efek (chunk tetap NULL, bisa
      // di-backfill nanti saat kunci tersedia). Error provider
      // DILEMPAR agar BullMQ retry (attempts 3, backoff) — kegagalan
      // permanen terlihat sebagai job gagal, bukan dokumen hilang
      // (dokumennya sudah tersimpan sejak event ditulis).
      const data = job.data as KbEmbedJobData;
      const embeddingProvider = await resolveWorkerEmbeddingProvider();
      if (!embeddingProvider) {
        return { embedded: 0, reason: "embedding_inactive" };
      }
      const result = await embedKbDocumentChunks(db, embeddingProvider, {
        tenantId: data.tenantId,
        documentId: data.documentId,
      });
      if (result.embedded > 0) {
        console.log(
          `[worker] kb.embed document=${data.documentId} embedded=${result.embedded} tokensIn=${result.tokensIn} provider=${embeddingProvider.name}`,
        );
      }
      return result;
    }
    if (job.name === TEAM_INVITATION_EMAIL_JOB) {
      // Fase 11B: kirim email satu undangan tim via Resend. Seluruh
      // keputusan (konfigurasi per job, idempotensi, pencatatan hasil
      // di baris undangan) ada di core; worker hanya memetakan hasil:
      // "failed" DILEMPAR agar BullMQ retry (attempts 3 + backoff) —
      // kegagalan permanen berakhir sebagai job gagal yang terlihat,
      // dengan email_error sudah tercatat di baris undangan.
      const data = job.data as InvitationEmailJobData;
      const result = await deliverInvitationEmail(
        db,
        {
          platform: platformSettingsOptions,
          tokenSecret: env.CHANNEL_TOKEN_SECRET,
          apiBase: env.RESEND_API_BASE,
          publicBaseUrl: env.BETTER_AUTH_URL,
        },
        {
          tenantId: data.tenantId,
          invitationId: data.invitationId,
          tokenEnc: data.tokenEnc,
        },
      );
      if (result.kind === "failed") {
        throw new Error(
          `[worker] team.invitation_email invitation=${data.invitationId} gagal: ${result.code}: ${result.message}`,
        );
      }
      console.log(
        `[worker] team.invitation_email invitation=${data.invitationId} hasil=${result.kind}` +
          (result.kind === "skipped" ? ` reason=${result.reason}` : ""),
      );
      return result;
    }
    if (job.name === APPOINTMENT_GOOGLE_SYNC_JOB) {
      // Fase 13G: sinkronkan SATU booking ke Google Calendar. Seluruh
      // keputusan ada di core (keadaan booking terkini dibaca ulang;
      // hasil tercatat di baris booking). Kegagalan provider TIDAK
      // dilempar: booking tidak pernah bergantung pada Google, dan
      // jejak `failed` + google_sync_error di booking adalah permukaan
      // kegagalannya — melempar hanya akan mengulang panggilan yang
      // hasil akhirnya sama-sama tercatat di sana.
      const data = job.data as AppointmentGoogleSyncJobData;
      const result = await syncBookingToGoogle(db, googleDeps, {
        tenantId: data.tenantId,
        bookingId: data.bookingId,
        action: data.action,
      });
      console.log(
        `[worker] appointment.google_sync booking=${data.bookingId} action=${data.action} hasil=${result.kind}` +
          (result.kind === "failed" ? ` error=${result.error}` : "") +
          (result.kind === "skipped" ? ` reason=${result.reason}` : ""),
      );
      return result;
    }
    if (job.name === AGENT_RESPOND_JOB) {
      const data = job.data as AgentRespondJobData;
      // Fase 6C: provider di-resolve per job (panel → env; lihat di atas).
      const llmProvider = await resolveAgentLlmProvider();
      // Fase 12D: provider embedding juga per job — retrieval KB di
      // core menjadi hibrida bila aktif, full-text murni bila tidak.
      const embeddingProvider = await resolveWorkerEmbeddingProvider();
      const result = await respondToInboundMessage(db, llmProvider, {
        tenantId: data.tenantId,
        conversationId: data.conversationId,
        messageId: data.messageId,
        embeddingProvider,
        // Untuk tool send_payment_link (Fase 4A): URL /pay/:code yang
        // dikirim agent harus absolut, berbasis URL publik aplikasi.
        publicBaseUrl: env.BETTER_AUTH_URL,
        // Fase 14A: deps gerbang pembayaran untuk tool yang sama.
        payments: paymentDeps,
        // Fase 9A: jalur job inilah yang dibatch (lihat enqueue di
        // processor automation.evaluate) — menyerah bila ada pesan
        // masuk yang lebih baru di percakapan yang sama.
        yieldToNewerMessage: true,
      });
      if (result.responded || result.reason) {
        console.log(
          `[worker] agent.respond message=${data.messageId} responded=${result.responded}` +
            (result.reason ? ` reason=${result.reason}` : "") +
            (result.mode ? ` mode=${result.mode}` : ""),
        );
      }
      // Fase 6G: balasan agent (mode auto) = pesan `queued` baru → nudge
      // pengiriman; draf saran (mode suggest) → nudge khusus agar badge
      // persetujuan dashboard menyegar seketika.
      if (result.responded && result.outboundMessageId) {
        await realtimePublisher.publishNudge({
          kind: "message.queued",
          tenantId: data.tenantId,
          conversationId: data.conversationId,
        });
      } else if (result.suggestionId) {
        await realtimePublisher.publishNudge({
          kind: "agent.suggestion",
          tenantId: data.tenantId,
          conversationId: data.conversationId,
        });
      }
      return result;
    }
    throw new Error(`[worker] job tidak dikenal: ${job.name}`);
  },
  { connection: workerConnection, concurrency: 5 },
);

bullWorker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} gagal:`, err);
  // Fase 16E: `failed` berbunyi pada SETIAP percobaan, jadi tanpa
  // pemeriksaan ini "gagal 1x lalu berhasil" dan "menyerah setelah 3x"
  // terlihat sama di log. Hanya yang terakhir yang ditinggalkan sebagai
  // jejak audit — itu yang perlu ditindaklanjuti.
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;
  const tenantId = (job.data as { tenantId?: unknown } | undefined)?.tenantId;
  if (typeof tenantId !== "string") return;
  void recordPermanentJobFailure(db, {
    tenantId,
    jobName: job.name,
    jobId: String(job.id ?? ""),
    attempts: job.attemptsMade,
    error: err,
  }).then((saved) => {
    if (!saved) {
      console.error(
        `[worker] jejak audit job ${job.id} (${job.name}) gagal disimpan — hanya ada log di atas`,
      );
    }
  });
});
bullWorker.on("error", (err) => {
  console.error("[worker] bullmq worker error:", err);
});

// ---------------------------------------------------------------------------
// Relay outbox — satu siklus tidak boleh tumpang tindih dengan siklus lain
// di proses yang sama (klaim SKIP LOCKED tetap aman bila kelak ada >1 worker).
// ---------------------------------------------------------------------------
let relayRunning = false;
async function relayTick(): Promise<void> {
  if (relayRunning) return;
  relayRunning = true;
  try {
    const relay = await relayUnpublishedOutboxEvents(db, async (_tx, event) => {
      if (!event.tenantId) return;
      // G11: event katalog webhook keluar → job fan-out ke endpoint
      // tenant yang melanggan (di SAMPING konsumen yang sudah ada di
      // bawah — automation untuk message.received tetap berjalan).
      // jobId deterministik dari id event: relay ulang tidak
      // menggandakan, dan core idempoten per (endpoint, event).
      if (
        (OUTBOUND_WEBHOOK_EVENT_TYPES as readonly string[]).includes(event.type)
      ) {
        await enqueueOutboundWebhookFanout(queue, {
          tenantId: event.tenantId,
          outboxEventId: event.id,
          eventType: event.type,
          payload: event.payload,
        });
      }
      // G16: peristiwa konversi terantre dari node flow
      // send_ad_conversion → job pengiriman ke platform iklan.
      // jobId deterministik dari id event: relay ulang tidak
      // menggandakan; payload tidak lengkap ditandai published
      // tanpa job (pola sequence.step_due di bawah).
      if (event.type === AD_CONVERSION_REQUESTED_OUTBOX_TYPE) {
        const payload = event.payload as {
          adConversionEventRowId?: unknown;
        };
        if (typeof payload.adConversionEventRowId !== "string") {
          console.warn(
            `[worker] event ad_conversion.requested ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        await enqueueAdConversionSend(queue, {
          tenantId: event.tenantId,
          outboxEventId: event.id,
          adConversionEventRowId: payload.adConversionEventRowId,
        });
        return;
      }
      // G18 butir 2: pindai pelanggan otomatis diminta dari halaman
      // Kontak → job eksekusi pindai. jobId deterministik dari id
      // event; payload tidak lengkap ditandai published tanpa job.
      if (event.type === CONTACT_SCAN_REQUESTED_OUTBOX_TYPE) {
        const payload = event.payload as { scanRunId?: unknown };
        if (typeof payload.scanRunId !== "string") {
          console.warn(
            `[worker] event contact_scan.requested ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        await enqueueContactScan(queue, {
          tenantId: event.tenantId,
          outboxEventId: event.id,
          scanRunId: payload.scanRunId,
        });
        return;
      }
      // Fase 2C: langkah sequence jatuh tempo → job BullMQ TERTUNDA.
      // Titik mulai delay digeser ke saat event ter-relay (±2 dtk dari
      // jadwal ideal di next_run_at) — toleransi terdokumentasi.
      if (event.type === "sequence.step_due") {
        const payload = event.payload as {
          enrollmentId?: unknown;
          stepPosition?: unknown;
          delayMinutes?: unknown;
        };
        if (
          typeof payload.enrollmentId !== "string" ||
          typeof payload.stepPosition !== "number" ||
          typeof payload.delayMinutes !== "number"
        ) {
          console.warn(
            `[worker] event sequence.step_due ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        await enqueueSequenceStep(
          queue,
          {
            tenantId: event.tenantId,
            enrollmentId: payload.enrollmentId,
            stepPosition: payload.stepPosition,
          },
          payload.delayMinutes * 60_000,
        );
        return;
      }
      // Fase 7C: broadcast jatuh tempo → job BullMQ TERTUNDA
      // `broadcast.dispatch` (delay = dispatchAt − sekarang; kirim-
      // sekarang adalah delay ±0 dari jalur yang sama). Broadcast yang
      // dibatalkan sebelum waktunya tetap menghasilkan job — job-nya
      // menemukan status `cancelled` di core dan selesai tanpa efek.
      if (event.type === "broadcast.dispatch_due") {
        const payload = event.payload as {
          broadcastId?: unknown;
          dispatchAt?: unknown;
        };
        if (
          typeof payload.broadcastId !== "string" ||
          typeof payload.dispatchAt !== "string"
        ) {
          console.warn(
            `[worker] event broadcast.dispatch_due ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        const delayMs = Date.parse(payload.dispatchAt) - Date.now();
        await enqueueBroadcastDispatch(
          queue,
          { tenantId: event.tenantId, broadcastId: payload.broadcastId },
          Number.isNaN(delayMs) ? 0 : delayMs,
        );
        return;
      }
      // Fase 23: postingan jatuh tempo → job BullMQ TERTUNDA
      // `post.publish` (delay = scheduledAt − sekarang). Postingan yang
      // dibatalkan atau dijadwal ulang tetap menghasilkan job; publisher
      // menolaknya lewat pencocokan `scheduled_at`, jadi tidak pernah
      // terbit lebih awal.
      if (event.type === "post.publish_due") {
        const payload = event.payload as {
          postId?: unknown;
          scheduledAt?: unknown;
        };
        if (
          typeof payload.postId !== "string" ||
          typeof payload.scheduledAt !== "string"
        ) {
          console.warn(
            `[worker] event post.publish_due ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        const delayMs = Date.parse(payload.scheduledAt) - Date.now();
        await enqueuePostPublish(
          queue,
          {
            tenantId: event.tenantId,
            postId: payload.postId,
            scheduledAt: payload.scheduledAt,
          },
          Number.isNaN(delayMs) ? 0 : delayMs,
        );
        return;
      }
      // Fase 8A: resume flow jatuh tempo → job BullMQ TERTUNDA
      // `flow.step` (delay = resumeAt − sekarang; run yang dimulai
      // menulis resumeAt = sekarang sehingga eksekusi pertama praktis
      // tanpa delay dari jalur yang sama). Run yang dibatalkan/opt-out
      // sebelum waktunya tetap menghasilkan job — core menolaknya
      // dengan aman (status terminal / seq basi).
      if (event.type === "flow.step_due") {
        const payload = event.payload as {
          runId?: unknown;
          stepSeq?: unknown;
          resumeAt?: unknown;
        };
        if (
          typeof payload.runId !== "string" ||
          typeof payload.stepSeq !== "number" ||
          typeof payload.resumeAt !== "string"
        ) {
          console.warn(
            `[worker] event flow.step_due ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        const delayMs = Date.parse(payload.resumeAt) - Date.now();
        await enqueueFlowStep(
          queue,
          {
            tenantId: event.tenantId,
            runId: payload.runId,
            stepSeq: payload.stepSeq,
          },
          Number.isNaN(delayMs) ? 0 : delayMs,
        );
        return;
      }
      // Fase 10B: komentar baru tercatat → job `comment.evaluate`.
      // Event hanya ditulis core untuk komentar yang benar-benar baru
      // (dedup index unik), jadi jobId deterministik dari id event
      // cukup; core pun idempoten untuk eksekusi ulang.
      if (event.type === "comment.received") {
        const payload = event.payload as { commentId?: unknown };
        if (typeof payload.commentId !== "string") {
          console.warn(
            `[worker] event comment.received ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        await enqueueCommentEvaluate(queue, {
          tenantId: event.tenantId,
          commentId: payload.commentId,
          outboxEventId: event.id,
        });
        return;
      }
      // Fase 12D: dokumen KB baru/diimpor meminta embedding → job
      // `kb.embed` (jobId deterministik dari id event). Job menemukan
      // provider nonaktif → selesai tanpa efek; chunk yang tertunda
      // bisa di-backfill kapan pun lewat skrip backfill:kb-embeddings.
      if (event.type === "kb.embed_requested") {
        const payload = event.payload as { documentId?: unknown };
        if (typeof payload.documentId !== "string") {
          console.warn(
            `[worker] event kb.embed_requested ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        await enqueueKbEmbed(queue, {
          tenantId: event.tenantId,
          documentId: payload.documentId,
          outboxEventId: event.id,
        });
        return;
      }
      // Fase 11B: undangan tim baru meminta pengiriman email → job
      // `team.invitation_email` (jobId deterministik dari id event).
      // Payload membawa token undangan sebagai CIPHERTEXT (bukan teks
      // terang); event hanya ditulis API bila email platform
      // terkonfigurasi saat undangan dibuat.
      if (event.type === INVITATION_EMAIL_OUTBOX_TYPE) {
        const payload = event.payload as {
          invitationId?: unknown;
          tokenEnc?: unknown;
        };
        if (
          typeof payload.invitationId !== "string" ||
          typeof payload.tokenEnc !== "string"
        ) {
          console.warn(
            `[worker] event ${INVITATION_EMAIL_OUTBOX_TYPE} ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        await enqueueInvitationEmail(queue, {
          tenantId: event.tenantId,
          invitationId: payload.invitationId,
          tokenEnc: payload.tokenEnc,
          outboxEventId: event.id,
        });
        return;
      }
      // Fase 13G: booking dibuat/dibatalkan pada tenant yang terhubung
      // Google → job `appointment.google_sync` (jobId deterministik
      // dari id event). Event hanya ditulis core bila koneksi Google
      // ada saat booking berubah; job membaca keadaan terkini.
      if (event.type === APPOINTMENT_GOOGLE_SYNC_OUTBOX_TYPE) {
        const payload = event.payload as {
          bookingId?: unknown;
          action?: unknown;
        };
        if (
          typeof payload.bookingId !== "string" ||
          (payload.action !== "create" && payload.action !== "delete")
        ) {
          console.warn(
            `[worker] event ${APPOINTMENT_GOOGLE_SYNC_OUTBOX_TYPE} ${event.id} payload tidak lengkap — ditandai published tanpa job`,
          );
          return;
        }
        await enqueueAppointmentGoogleSync(queue, {
          tenantId: event.tenantId,
          bookingId: payload.bookingId,
          action: payload.action,
          outboxEventId: event.id,
        });
        return;
      }
      if (event.type !== "message.received") return;
      const payload = event.payload as {
        conversationId?: unknown;
        messageId?: unknown;
      };
      if (
        typeof payload.conversationId !== "string" ||
        typeof payload.messageId !== "string"
      ) {
        console.warn(
          `[worker] event message.received ${event.id} payload tidak lengkap — ditandai published tanpa job`,
        );
        return;
      }
      await enqueueAutomationEvaluate(queue, {
        tenantId: event.tenantId,
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        outboxEventId: event.id,
      });
    });
    // Fase 16D: event yang menyerah dikarantina, bukan diulang selamanya.
    // Satu baris per event dengan id-nya supaya operator bisa langsung
    // menelusuri (`SELECT * FROM outbox_events WHERE id = ...`) — bukan
    // hanya "ada yang gagal" tanpa alamat.
    for (const dead of relay.deadLettered) {
      console.error(
        `[worker] outbox DEAD-LETTER id=${dead.id} type=${dead.type} ` +
          `tenant=${dead.tenantId ?? "-"} attempts=${dead.attempts} error=${dead.error}`,
      );
    }
    if (relay.relayed > 0) {
      console.log(`[worker] outbox relay: ${relay.relayed} event ter-publish`);
    }
  } catch (err) {
    // Hanya kegagalan TINGKAT TRANSAKSI sampai di sini (koneksi DB putus,
    // lock timeout). Kegagalan per handler sudah ditangani di dalam core
    // lewat savepoint per event, jadi satu event rusak tidak lagi
    // menggagalkan seluruh siklus.
    console.error("[worker] outbox relay gagal (akan dicoba lagi):", err);
  } finally {
    relayRunning = false;
  }
}

const relayTimer = setInterval(() => void relayTick(), RELAY_INTERVAL_MS);
void relayTick();

// ---------------------------------------------------------------------------
// Purge Sampah channel (Fase 6I): akun channel yang dibuang ke Sampah
// lebih dari 30 hari lalu dihapus PERMANEN oleh core
// (purgeExpiredTrashedChannels — satu transaksi per akun, audit
// `channel.purged` dengan hitungan). Pola poller yang sama seperti relay
// outbox: jalan sekali saat boot lalu tiap jam, dengan penjaga anti-
// tumpang-tindih. Tidak memakai job BullMQ terjadwal: tidak ada antrean
// yang perlu diantar — cukup pemindaian berkala yang idempoten. Jalan
// run-once untuk pengujian/operasi: `pnpm purge:channels` (skrip
// scripts/purge-trashed-channels.ts).
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let purgeRunning = false;
async function purgeTick(): Promise<void> {
  if (purgeRunning) return;
  purgeRunning = true;
  try {
    const result = await purgeExpiredTrashedChannels(db);
    for (const p of result.purged) {
      console.log(
        `[worker] channel purge: ${p.channelAccountId} (tenant ${p.tenantId}) terhapus permanen — ${p.counts.conversations} percakapan, ${p.counts.messages} pesan`,
      );
    }
    for (const f of result.failed) {
      console.error(
        `[worker] channel purge GAGAL untuk ${f.channelAccountId} (tenant ${f.tenantId}): ${f.error}`,
      );
    }
  } catch (err) {
    console.error("[worker] channel purge gagal (akan dicoba lagi):", err);
  } finally {
    purgeRunning = false;
  }
}
const purgeTimer = setInterval(() => void purgeTick(), PURGE_INTERVAL_MS);
void purgeTick();

// ---------------------------------------------------------------------------
// Prune log integrasi (Fase 7B.1): baris `integration_log` lebih tua dari
// retensi (30 hari) dihapus oleh core `pruneIntegrationLogs` di bawah
// flag RLS prune. Pola poller yang sama seperti purge Sampah: sekali
// saat boot lalu tiap jam, penjaga anti-tumpang-tindih, tanpa BullMQ.
// Jalan run-once untuk pengujian/operasi: `pnpm prune:logs` (skrip
// scripts/prune-integration-logs.ts).
const LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let logPruneRunning = false;
async function logPruneTick(): Promise<void> {
  if (logPruneRunning) return;
  logPruneRunning = true;
  try {
    const result = await pruneIntegrationLogs(db);
    if (result.deleted > 0) {
      console.log(
        `[worker] integration log prune: ${result.deleted} baris >${INTEGRATION_LOG_RETENTION_DAYS} hari terhapus`,
      );
    }
  } catch (err) {
    console.error("[worker] integration log prune gagal (akan dicoba lagi):", err);
  } finally {
    logPruneRunning = false;
  }
}
const logPruneTimer = setInterval(() => void logPruneTick(), LOG_PRUNE_INTERVAL_MS);
void logPruneTick();

// ---------------------------------------------------------------------------
// Retensi outbox (Fase 20, temuan audit A3). Sebelum ini `outbox_events`
// TIDAK PERNAH dihapus — baris terbit maupun dead-letter — sehingga setiap
// event domain tersimpan permanen dengan payload penuhnya. Baris terbit
// dibuang setelah 7 hari; baris dead-letter setelah 30 hari sebagai bukti
// yang masih bisa ditindaklanjuti operator. Event yang BELUM terbit tidak
// pernah disentuh.
//
// Jalan run-once untuk operasi: `pnpm prune:outbox`
// (scripts/prune-outbox.ts).
const OUTBOX_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let outboxPruneRunning = false;
async function outboxPruneTick(): Promise<void> {
  if (outboxPruneRunning) return;
  outboxPruneRunning = true;
  try {
    const result = await pruneOutboxEvents(db);
    if (result.publishedDeleted > 0 || result.deadLetterDeleted > 0) {
      console.log(
        `[worker] outbox prune: ${result.publishedDeleted} terbit >${OUTBOX_PUBLISHED_RETENTION_DAYS} hari, ` +
          `${result.deadLetterDeleted} dead-letter >${OUTBOX_DEAD_LETTER_RETENTION_DAYS} hari terhapus`,
      );
    }
  } catch (err) {
    console.error("[worker] outbox prune gagal (akan dicoba lagi):", err);
  } finally {
    outboxPruneRunning = false;
  }
}
const outboxPruneTimer = setInterval(
  () => void outboxPruneTick(),
  OUTBOX_PRUNE_INTERVAL_MS,
);
void outboxPruneTick();

// ---------------------------------------------------------------------------
// Sapuan sesi login kedaluwarsa (Fase 22, audit A5). Better Auth menolak
// sesi kedaluwarsa pada setiap permintaan, tetapi barisnya tidak pernah
// dihapus — sesi hanya hilang saat logout eksplisit. Yang ditinggalkan
// (tutup browser tanpa logout) tersimpan selamanya, lengkap dengan
// ip_address dan user_agent. Masa tenggang 7 hari setelah kedaluwarsa
// supaya barisnya masih bisa dibaca saat pengguna melapor "kenapa saya
// diminta login lagi".
const AUTH_SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let authSessionPruneRunning = false;
async function authSessionPruneTick(): Promise<void> {
  if (authSessionPruneRunning) return;
  authSessionPruneRunning = true;
  try {
    const result = await pruneExpiredAuthSessions(db);
    if (result.deleted > 0) {
      console.log(
        `[worker] sesi login kedaluwarsa: ${result.deleted} baris >${AUTH_SESSION_GRACE_DAYS} hari setelah kedaluwarsa terhapus`,
      );
    }
  } catch (err) {
    console.error("[worker] sapuan sesi gagal (akan dicoba lagi):", err);
  } finally {
    authSessionPruneRunning = false;
  }
}
const authSessionPruneTimer = setInterval(
  () => void authSessionPruneTick(),
  AUTH_SESSION_PRUNE_INTERVAL_MS,
);
void authSessionPruneTick();

// ---------------------------------------------------------------------------
// Finalisasi broadcast (Fase 7C): penyapu `reconcileBroadcasts` —
// menemukan broadcast `sending` lintas tenant (lengan baca
// system_broadcast_scan), menyinkronkan status penerima dari status
// pesannya di konteks tenant masing-masing, dan menutup broadcast
// yang penerimanya sudah terminal semua (completed / partially_failed
// / failed + audit). Poller pola yang sama: sekali saat boot lalu
// tiap 10 detik — cukup rapat agar status akhir tampil segera setelah
// poller pengiriman menyelesaikan antrean, tanpa membebani DB.
const BROADCAST_RECONCILE_INTERVAL_MS = 10_000;
let broadcastReconcileRunning = false;
async function broadcastReconcileTick(): Promise<void> {
  if (broadcastReconcileRunning) return;
  broadcastReconcileRunning = true;
  try {
    const result = await reconcileBroadcasts(db);
    if (result.finalized > 0) {
      console.log(
        `[worker] broadcast reconcile: ${result.finalized} broadcast ditutup dari ${result.scanned} yang sending`,
      );
    }
  } catch (err) {
    console.error("[worker] broadcast reconcile gagal (akan dicoba lagi):", err);
  } finally {
    broadcastReconcileRunning = false;
  }
}
const broadcastReconcileTimer = setInterval(
  () => void broadcastReconcileTick(),
  BROADCAST_RECONCILE_INTERVAL_MS,
);
void broadcastReconcileTick();

// ---------------------------------------------------------------------------
// Broadcast berulang (G9): penyapu `processBroadcastRecurrences` —
// memindai aturan yang slotnya jatuh tempo lintas tenant (lengan baca
// system_broadcast_recurrence_scan), lalu per slot MEMBUAT broadcast
// anak lewat jalur pembuatan + penjadwalan broadcast yang ada (event
// outbox broadcast.dispatch_due → job dispatch → poller, persis
// seperti broadcast manual terjadwal). Hasil tiap slot tercatat di
// ledger kejadian aturan (created/skipped/missed + alasan). Pola
// poller yang sama seperti reconcile: sekali saat boot lalu tiap
// menit — cukup rapat untuk jadwal harian/mingguan/bulanan, dan
// ambang keterlambatan core (1 jam) menjaga slot basi tidak
// ditembakkan sesudah worker mati lama.
const BROADCAST_RECURRENCE_INTERVAL_MS = 60_000;
let broadcastRecurrenceRunning = false;
async function broadcastRecurrenceTick(): Promise<void> {
  if (broadcastRecurrenceRunning) return;
  broadcastRecurrenceRunning = true;
  try {
    const result = await processBroadcastRecurrences(db);
    if (result.created > 0 || result.skipped > 0 || result.missed > 0) {
      console.log(
        `[worker] broadcast berulang: ${result.rulesScanned} aturan jatuh tempo — created=${result.created} skipped=${result.skipped} missed=${result.missed} completed=${result.completed}`,
      );
    }
  } catch (err) {
    console.error("[worker] broadcast berulang gagal (akan dicoba lagi):", err);
  } finally {
    broadcastRecurrenceRunning = false;
  }
}
const broadcastRecurrenceTimer = setInterval(
  () => void broadcastRecurrenceTick(),
  BROADCAST_RECURRENCE_INTERVAL_MS,
);
void broadcastRecurrenceTick();

// ---------------------------------------------------------------------------
// Postingan berulang + antrean rutin (S2): dua penyapu di atas posts —
// `processPostRecurrences` mematerialisasi slot aturan menjadi
// postingan terjadwal lewat createPost/createPostGroup →
// schedulePost yang ada; `processPostQueueSlots` menarik item
// antrean teratas pada slot rutin mingguan. Keduanya berbagi lengan
// baca system_post_recurrence_scan dan menulis ledger masing-masing
// (kejadian aturan / tembakan slot). Postingan anak lahir sebagai
// draf persetujuan — gerbang S1 di poller penerbitan yang menahan
// bila tenant mewajibkan persetujuan; penyapu tidak punya jalur
// pintas. Pola poller yang sama: boot + tiap menit, jaga masuk ulang.
const POST_RECURRENCE_INTERVAL_MS = 60_000;
let postRecurrenceRunning = false;
async function postRecurrenceTick(): Promise<void> {
  if (postRecurrenceRunning) return;
  postRecurrenceRunning = true;
  try {
    const rules = await processPostRecurrences(db);
    if (rules.created > 0 || rules.skipped > 0 || rules.missed > 0) {
      console.log(
        `[worker] postingan berulang: ${rules.rulesScanned} aturan jatuh tempo — created=${rules.created} skipped=${rules.skipped} missed=${rules.missed} completed=${rules.completed}`,
      );
    }
    const queue = await processPostQueueSlots(db);
    if (queue.pulled > 0 || queue.empty > 0 || queue.skipped > 0 || queue.missed > 0) {
      console.log(
        `[worker] antrean rutin: ${queue.slotsScanned} slot jatuh tempo — pulled=${queue.pulled} empty=${queue.empty} skipped=${queue.skipped} missed=${queue.missed}`,
      );
    }
  } catch (err) {
    console.error("[worker] postingan berulang/antrean gagal (akan dicoba lagi):", err);
  } finally {
    postRecurrenceRunning = false;
  }
}
const postRecurrenceTimer = setInterval(
  () => void postRecurrenceTick(),
  POST_RECURRENCE_INTERVAL_MS,
);
void postRecurrenceTick();

// ---------------------------------------------------------------------------
// Analitik postingan (S3): penyapu penarikan metrik per platform —
// memindai postingan terbit yang jatuh tempo tarik lintas tenant
// (lengan baca system_post_analytics_scan; matematika jadwalnya di
// core post-analytics: jendela 30 hari sejak terbit, snapshot ok
// disegarkan ≥6 jam, gagal dicoba lagi ≥24 jam, unavailable
// terminal) lalu `processPostAnalytics` menarik angka dari API resmi
// tiap platform lewat MetricsAdapter dan MENAMBAH snapshot deret
// waktu. Sapuan tiap 15 menit: angka organik tidak butuh kesegaran
// menit, dan kuota/batas laju platform dihormati lewat batas batch +
// jeda antar target di orkestrator.
const POST_ANALYTICS_INTERVAL_MS = 15 * 60_000;
let postAnalyticsRunning = false;
async function postAnalyticsTick(): Promise<void> {
  if (postAnalyticsRunning) return;
  postAnalyticsRunning = true;
  try {
    const result = await processPostAnalytics(db, {
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      metaApiBase: env.META_API_BASE,
      metaGraphApiVersion: META_GRAPH_API_VERSION,
      threadsApiBase: env.THREADS_API_BASE,
      blueskyAppViewBase: env.BLUESKY_APPVIEW_API_BASE,
      google: googleDeps,
      linkedinApiBase: env.LINKEDIN_API_BASE,
      pinterestApiBase: env.PINTEREST_API_BASE,
      tiktokApiBase: env.TIKTOK_API_BASE,
    });
    if (result.scanned > 0) {
      console.log(
        `[worker] analitik postingan: ${result.scanned} target jatuh tempo — ok=${result.ok} unavailable=${result.unavailable} failed=${result.failed} skipped=${result.skipped}`,
      );
    }
  } catch (err) {
    console.error("[worker] analitik postingan gagal (akan dicoba lagi):", err);
  } finally {
    postAnalyticsRunning = false;
  }
}
const postAnalyticsTimer = setInterval(
  () => void postAnalyticsTick(),
  POST_ANALYTICS_INTERVAL_MS,
);
void postAnalyticsTick();

// ---------------------------------------------------------------------------
// Webhook keluar (G11): penyapu percobaan ulang pengiriman — memindai
// baris `outbound_webhook_deliveries` yang jatuh tempo lintas tenant
// (lengan baca system_outbound_webhook_scan), lalu tiap baris dicoba
// lagi di konteks tenant-nya lewat jalur percobaan yang sama seperti
// percobaan pertama (klaim sewa per baris menjaga tidak ada kirim
// ganda bersamaan). Interval 30 detik: jeda backoff terpendek core
// juga 30 detik, jadi sapuan ini tidak pernah terlambat berarti.
const OUTBOUND_WEBHOOK_RETRY_INTERVAL_MS = 30_000;
let outboundWebhookRetryRunning = false;
async function outboundWebhookRetryTick(): Promise<void> {
  if (outboundWebhookRetryRunning) return;
  outboundWebhookRetryRunning = true;
  try {
    const result = await processDueOutboundWebhookRetries(db, {
      encryptionSecret: env.CHANNEL_TOKEN_SECRET ?? "",
    });
    if (result.scanned > 0) {
      console.log(
        `[worker] webhook keluar: ${result.scanned} pengiriman jatuh tempo — delivered=${result.delivered} retry=${result.retryScheduled} failed=${result.failed} skipped=${result.skipped}`,
      );
    }
  } catch (err) {
    console.error("[worker] webhook keluar gagal (akan dicoba lagi):", err);
  } finally {
    outboundWebhookRetryRunning = false;
  }
}
const outboundWebhookRetryTimer = setInterval(
  () => void outboundWebhookRetryTick(),
  OUTBOUND_WEBHOOK_RETRY_INTERVAL_MS,
);
void outboundWebhookRetryTick();

// ---------------------------------------------------------------------------
// Lifecycle token Meta (0010): worker harian memindai akun Meta aktif yang
// tokennya mendekati kedaluwarsa (≤7 hari), mencoba REFRESH `tbft` untuk
// varian refreshable (system_user_token/business_token — token Unified
// Login & bisnis), dan menandai kesehatan ("expiring"/"expired") untuk
// varian yang tidak bisa di-refresh (Page token) supaya pemilik
// menghubungkan ulang SEBELUM token mati. Refresh yang ditolak Graph 190
// menandai akun 'error' — sama seperti runner pengiriman. Pola poller
// purge: sekali saat boot lalu tiap 6 jam, penjaga anti-tumpang-tindih,
// tanpa BullMQ. Jalan run-once: `pnpm --filter @sahabat-kreator/worker
// meta:token-lifecycle` (skrip scripts/meta-token-lifecycle.ts).
const TOKEN_LIFECYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let tokenLifecycleRunning = false;
async function tokenLifecycleTick(): Promise<void> {
  if (tokenLifecycleRunning) return;
  tokenLifecycleRunning = true;
  try {
    const result = await runMetaTokenLifecycle({
      db,
      platform: platformSettingsOptions,
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      metaApiBase: env.META_API_BASE,
    });
    if (result.scanned > 0) {
      console.log(
        `[worker] lifecycle token: ${result.scanned} akun terpindai — refresh=${result.refreshed} warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[worker] lifecycle token gagal (akan dicoba lagi):", err);
  } finally {
    tokenLifecycleRunning = false;
  }
}
const tokenLifecycleTimer = setInterval(
  () => void tokenLifecycleTick(),
  TOKEN_LIFECYCLE_INTERVAL_MS,
);
void tokenLifecycleTick();

// ---------------------------------------------------------------------------
// Lifecycle token Threads (integrasi Threads): putaran sejajar Meta di
// atas — pindai akun Threads aktif yang token berumur panjangnya
// mendekati kedaluwarsa (≤7 hari) dan segarkan via grant
// `th_refresh_token` (tanpa app secret; lihat
// src/threads-token-lifecycle.ts). Tick terpisah dengan penjaga
// anti-tumpang-tindih sendiri, interval yang sama (boot + tiap 6 jam).
// Jalan run-once: `pnpm --filter @sahabat-kreator/worker
// threads:token-lifecycle` (skrip scripts/threads-token-lifecycle.ts).
let threadsTokenLifecycleRunning = false;
async function threadsTokenLifecycleTick(): Promise<void> {
  if (threadsTokenLifecycleRunning) return;
  threadsTokenLifecycleRunning = true;
  try {
    const result = await runThreadsTokenLifecycle({
      db,
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      threadsApiBase: env.THREADS_API_BASE,
    });
    if (result.scanned > 0) {
      console.log(
        `[worker] lifecycle token Threads: ${result.scanned} akun terpindai — refresh=${result.refreshed} warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[worker] lifecycle token Threads gagal (akan dicoba lagi):", err);
  } finally {
    threadsTokenLifecycleRunning = false;
  }
}
const threadsTokenLifecycleTimer = setInterval(
  () => void threadsTokenLifecycleTick(),
  TOKEN_LIFECYCLE_INTERVAL_MS,
);
void threadsTokenLifecycleTick();

// ---------------------------------------------------------------------------
// Lifecycle token TikTok (gelombang Semua OAuth): putaran sejajar
// Threads di atas — access token TikTok hanya ±24 jam, jadi runner
// menyegarkannya dengan grant `refresh_token` SEBELUM kedaluwarsa
// (jendela default 7 hari menutupi masa aktifnya) dan menyimpan
// rotasi access+refresh atomik (lihat src/tiktok-token-lifecycle.ts).
// Tick terpisah, penjaga anti-tumpang-tindih sendiri, interval sama.
// Jalan run-once: `pnpm --filter @sahabat-kreator/worker
// tiktok:token-lifecycle` (skrip scripts/tiktok-token-lifecycle.ts).
let tiktokTokenLifecycleRunning = false;
async function tiktokTokenLifecycleTick(): Promise<void> {
  if (tiktokTokenLifecycleRunning) return;
  tiktokTokenLifecycleRunning = true;
  try {
    const result = await runTikTokTokenLifecycle({
      db,
      platform: platformSettingsOptions,
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      tiktokApiBase: env.TIKTOK_API_BASE,
    });
    if (result.scanned > 0) {
      console.log(
        `[worker] lifecycle token TikTok: ${result.scanned} akun terpindai — refresh=${result.refreshed} warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[worker] lifecycle token TikTok gagal (akan dicoba lagi):", err);
  } finally {
    tiktokTokenLifecycleRunning = false;
  }
}
const tiktokTokenLifecycleTimer = setInterval(
  () => void tiktokTokenLifecycleTick(),
  TOKEN_LIFECYCLE_INTERVAL_MS,
);
void tiktokTokenLifecycleTick();

// ---------------------------------------------------------------------------
// Lifecycle token LinkedIn (gelombang Semua OAuth): TANDAI-RECONNECT
// — LinkedIn tidak menerbitkan refresh token untuk program standar,
// jadi putaran ini murni pemindaian + penandaan: akun mendekati
// kedaluwarsa ditandai 'expiring'; yang sudah lewat jadwal menjadi
// 'error' linkedin_token_expired agar dihubungkan ulang (lihat
// src/linkedin-token-lifecycle.ts). Tanpa panggilan API provider.
// Jalan run-once: `pnpm --filter @sahabat-kreator/worker
// linkedin:token-lifecycle` (skrip scripts/linkedin-token-lifecycle.ts).
let linkedinTokenLifecycleRunning = false;
async function linkedinTokenLifecycleTick(): Promise<void> {
  if (linkedinTokenLifecycleRunning) return;
  linkedinTokenLifecycleRunning = true;
  try {
    const result = await runLinkedInTokenLifecycle({ db });
    if (result.scanned > 0) {
      console.log(
        `[worker] lifecycle token LinkedIn: ${result.scanned} akun terpindai — warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[worker] lifecycle token LinkedIn gagal (akan dicoba lagi):", err);
  } finally {
    linkedinTokenLifecycleRunning = false;
  }
}
const linkedinTokenLifecycleTimer = setInterval(
  () => void linkedinTokenLifecycleTick(),
  TOKEN_LIFECYCLE_INTERVAL_MS,
);
void linkedinTokenLifecycleTick();

// ---------------------------------------------------------------------------
// Lifecycle token Pinterest (gelombang Semua OAuth): putaran sejajar
// TikTok — access token ±30 hari disegarkan dengan grant
// `refresh_token` API v5 SEBELUM kedaluwarsa (rotasi refresh token
// disimpan hanya bila grant menerbitkan yang baru). Tick terpisah,
// interval sama. Jalan run-once: `pnpm --filter
// @sahabat-kreator/worker pinterest:token-lifecycle`.
let pinterestTokenLifecycleRunning = false;
async function pinterestTokenLifecycleTick(): Promise<void> {
  if (pinterestTokenLifecycleRunning) return;
  pinterestTokenLifecycleRunning = true;
  try {
    const result = await runPinterestTokenLifecycle({
      db,
      platform: platformSettingsOptions,
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      pinterestApiBase: env.PINTEREST_API_BASE,
    });
    if (result.scanned > 0) {
      console.log(
        `[worker] lifecycle token Pinterest: ${result.scanned} akun terpindai — refresh=${result.refreshed} warned=${result.warned} authError=${result.authErrored} failed=${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[worker] lifecycle token Pinterest gagal (akan dicoba lagi):", err);
  } finally {
    pinterestTokenLifecycleRunning = false;
  }
}
const pinterestTokenLifecycleTimer = setInterval(
  () => void pinterestTokenLifecycleTick(),
  TOKEN_LIFECYCLE_INTERVAL_MS,
);
void pinterestTokenLifecycleTick();

// ---------------------------------------------------------------------------
// Poller pengiriman pesan outbound (Telegram + Meta).
//
// DIPINDAHKAN dari proses API ke worker (rekomendasi analisis). Selama
// poller hidup di API, setiap replika HTTP ikut menjalankan siklus
// kirim tiap 2 detik: klaim atomik memang mencegah kirim ganda, tetapi
// beban panggilan provider menempel pada replika yang seharusnya hanya
// melayani permintaan, dan `SIGTERM` saat rolling deploy dapat memotong
// pengiriman di tengah jalan (API tidak menunggu poller selesai).
//
// Kedua poller memakai runner bersama `delivery/runner.ts` — satu
// implementasi siklus klaim → validasi → dekripsi → kirim → tandai →
// log → nudge. Perbedaan provider hanya pada spec (scan, send, kode
// error). Token didekripsi sesaat di memori dari CHANNEL_TOKEN_SECRET
// dan tidak pernah dicatat.
//
// Interval 2 detik dipertahankan persis seperti sebelumnya: latensi
// balasan dashboard tidak boleh berubah hanya karena prosesnya pindah.
// Fase 18B: SATU penyimpanan untuk pembacaan lampiran (poller) dan
// penulisan/penyajian (API memakai akar yang sama lewat
// resolveMediaStorageRoot). Dibuat sekali agar tidak ada dua instance
// yang bisa menunjuk direktori berbeda.
const mediaStore = createDiskMediaStore(
  resolveMediaStorageRoot(env.MEDIA_STORAGE_ROOT),
);

const DELIVERY_POLL_INTERVAL_MS = 2_000;
/** Interval ingest media masuk — tidak ada SLA, 5 dtk cukup. */
const MEDIA_INGEST_INTERVAL_MS = 5_000;
const deliveryPollers: DeliveryPoller[] = [
  startTelegramDeliveryPoller(
    db,
    {
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      telegramApiBase: env.TELEGRAM_API_BASE,
      publisher: realtimePublisher,
    },
    DELIVERY_POLL_INTERVAL_MS,
  ),
  startMetaDeliveryPoller(
    db,
    {
      channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
      metaApiBase: env.META_API_BASE,
      graphApiVersion: META_GRAPH_API_VERSION,
      publisher: realtimePublisher,
      // Fase 18B: sumber byte untuk pesan berlampiran.
      mediaStore: mediaStore,
    },
    DELIVERY_POLL_INTERVAL_MS,
  ),
];

// Ingest media MASUK (Fase 18). Bukan poller pengiriman: yang dipindai
// adalah pesan yang sudah tercatat tetapi berkasnya belum diunduh.
// Interval lebih longgar (5 dtk) karena tidak ada SLA balasan yang
// bergantung padanya — yang penting berkasnya akhirnya ada.
const mediaIngestLoop = startMediaIngestLoop(
  db,
  {
    channelTokenSecret: env.CHANNEL_TOKEN_SECRET,
    metaApiBase: env.META_API_BASE,
    graphApiVersion: META_GRAPH_API_VERSION,
    storageRoot: resolveMediaStorageRoot(env.MEDIA_STORAGE_ROOT),
  },
  MEDIA_INGEST_INTERVAL_MS,
);

// Pembersihan media (Fase 19). Memakai `mediaStore` yang SAMA dengan
// poller: dua instance dengan akar berbeda akan membuat GC memeriksa
// direktori yang salah dan menyimpulkan semua berkas hilang. Retensi
// default 0 (simpan selamanya) — lihat catatan di packages/config.
const mediaGcLoop = startMediaGcLoop(
  db,
  { store: mediaStore, retentionDays: env.MEDIA_RETENTION_DAYS },
  MEDIA_GC_INTERVAL_MS,
);

console.log(
  `[worker] Sahabat Kreator worker aktif — antrean "${MAIN_QUEUE_NAME}", relay outbox tiap ${RELAY_INTERVAL_MS}ms`,
);
console.log(
  `[worker] media: akar penyimpanan ${resolveMediaStorageRoot(env.MEDIA_STORAGE_ROOT)}, ` +
    `retensi ${env.MEDIA_RETENTION_DAYS > 0 ? `${env.MEDIA_RETENTION_DAYS} hari` : "nonaktif (simpan selamanya)"}`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] menerima ${signal}, berhenti secara anggun...`);
  clearInterval(relayTimer);
  clearInterval(purgeTimer);
  clearInterval(logPruneTimer);
  clearInterval(outboxPruneTimer);
  clearInterval(authSessionPruneTimer);
  clearInterval(broadcastReconcileTimer);
  clearInterval(broadcastRecurrenceTimer);
  clearInterval(postRecurrenceTimer);
  clearInterval(postAnalyticsTimer);
  clearInterval(outboundWebhookRetryTimer);
  clearInterval(tokenLifecycleTimer);
  clearInterval(threadsTokenLifecycleTimer);
  clearInterval(tiktokTokenLifecycleTimer);
  clearInterval(linkedinTokenLifecycleTimer);
  clearInterval(pinterestTokenLifecycleTimer);
  // Hentikan poller pengiriman SEBELUM menutup pool: tick yang sedang
  // berjalan memakai `db`, dan memutus pool di bawahnya mengubah
  // pengiriman yang sedang berlangsung menjadi kegagalan palsu yang
  // tercatat di integration_log. `stop()` hanya menghentikan timer —
  // tick aktif dibiarkan selesai (penjaga `running` di runner membuat
  // tidak ada tick baru yang dimulai).
  for (const poller of deliveryPollers) poller.stop();
  // Sama alasannya dengan poller: siklus ingest media memakai `db`, jadi
  // timer-nya dihentikan sebelum pool ditutup. Berkas yang belum
  // terunduh tidak hilang — barisnya tetap menunggu dan diambil lagi
  // saat worker hidup kembali.
  mediaIngestLoop.stop();
  // Siklus GC juga memakai `db`; dihentikan sebelum pool ditutup. Satu
  // putaran yang terlewat tidak berakibat apa-apa — pekerjaan ini
  // berulang tiap jam dan tidak menyimpan state di antara putaran.
  mediaGcLoop.stop();
  await bullWorker.close();
  await queue.close();
  realtimePublisher.close();
  queueConnection.disconnect();
  workerConnection.disconnect();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
