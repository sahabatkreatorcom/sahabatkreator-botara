import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

/**
 * @sahabat-kreator/queue — abstraksi BullMQ (Fase 2A, RANCANGAN §2 & §4).
 *
 * Satu antrean fisik `sahabat-kreator` menampung semua job aplikasi; nama
 * job membedakan jenisnya:
 *  - `automation.evaluate` — evaluasi satu pesan inbound terhadap automation
 *    tenant (Fase 2A). Job berikutnya (broadcast.send, sequence.step, ...)
 *    ditambahkan sebagai nama job baru di antrean yang sama, bukan antrean
 *    fisik baru.
 *  - `agent.respond` — agent AI menanggapi satu pesan inbound (Fase 3A),
 *    di-enqueue processor automation.evaluate SETELAH evaluasi selesai
 *    tanpa tembakan (keyword dulu, AI kemudian).
 *  - `sequence.step` — satu langkah sequence automation (Fase 2C), job
 *    TERTUNDA yang di-enqueue relay dari event outbox `sequence.step_due`
 *    dengan jobId `seq-<enrollmentId>-<position>`.
 *  - `outbox.relay` — BUKAN job yang di-enqueue siapa pun: relay adalah pola
 *    polling yang dijalankan worker. Worker membaca `outbox_events` yang
 *    belum ter-publish langsung dari Postgres (klaim FOR UPDATE SKIP
 *    LOCKED, lihat `relayUnpublishedOutboxEvents` di @sahabat-kreator/core)
 *    dan menerjemahkan event `message.received` menjadi job
 *    `automation.evaluate`. Konstanta namanya tetap diekspor di sini agar
 *    kosakata job terpusat.
 *
 * Idempotensi adalah kontrak paket ini: jobId untuk `automation.evaluate`
 * DITURUNKAN dari id event outbox (`automation-evaluate-<eventId>`), jadi
 * relay yang crash di tengah jalan dan memproses event yang sama lagi
 * tidak menghasilkan job ganda — BullMQ mengembalikan job yang sudah ada.
 *
 * JEMBATAN PENGIRIMAN LINTAS PROSES (penting, Fase 2A → digantikan 6G):
 * Worker TIDAK mengirim pesan ke channel secara langsung untuk webchat.
 * Alur sejak Fase 6G (pub/sub Redis — lihat `./realtime.ts`):
 *   worker/api membuat pesan outbound berstatus `queued` di DB
 *   → penerbit menerbitkan nudge `message.queued` ke Redis setelah commit
 *   → apps/realtime (pemilik socket pengunjung sekarang) mem-flush pesan
 *     `queued` percakapan itu menjadi `sent` dan mendorong nudge ke
 *     widget; widget memuat ulang lewat REST.
 * Pesan untuk pengunjung yang offline tetap `queued` dan ter-flush saat
 * pengunjung reconnect. (Di Fase 2A–6A.2 langkah tengah ini adalah poller
 * DB di proses API + hub WebSocket in-memory; keduanya pensiun di 6G.)
 */

export const MAIN_QUEUE_NAME = "sahabat-kreator";

export const OUTBOX_RELAY_JOB = "outbox.relay";
export const AUTOMATION_EVALUATE_JOB = "automation.evaluate";
export const AGENT_RESPOND_JOB = "agent.respond";
export const SEQUENCE_STEP_JOB = "sequence.step";
export const BROADCAST_DISPATCH_JOB = "broadcast.dispatch";
export const FLOW_STEP_JOB = "flow.step";
export const COMMENT_EVALUATE_JOB = "comment.evaluate";
export const KB_EMBED_JOB = "kb.embed";
export const TEAM_INVITATION_EMAIL_JOB = "team.invitation_email";
export const APPOINTMENT_GOOGLE_SYNC_JOB = "appointment.google_sync";
export const POST_PUBLISH_JOB = "post.publish";
export const OUTBOUND_WEBHOOK_FANOUT_JOB = "outbound-webhook.fanout";
export const AD_CONVERSION_SEND_JOB = "ad-conversion.send";

export interface AutomationEvaluateJobData {
  tenantId: string;
  conversationId: string;
  messageId: string;
  /** Id event outbox `message.received` yang memicu job ini (jejak/idempotensi). */
  outboxEventId: string;
}

/**
 * Job Fase 3A: agent AI menanggapi satu pesan inbound. Di-enqueue oleh
 * processor `automation.evaluate` di worker SETELAH evaluasi automation
 * selesai TANPA tembakan apa pun (urutan pasti: keyword → AI; pesan yang
 * sudah dijawab automation tidak dijawab lagi oleh agent). jobId
 * deterministik dari id PESAN pemicu (`agent-respond-<messageId>`):
 * enqueue ganda untuk pesan yang sama selalu menunjuk job yang sama.
 */
export interface AgentRespondJobData {
  tenantId: string;
  conversationId: string;
  messageId: string;
}

/**
 * Job Fase 2C: jalankan SATU langkah sequence untuk satu enrollment.
 * Di-enqueue oleh relay outbox dari event `sequence.step_due` (yang ditulis
 * core saat enrollment dibuat dan setiap langkah selesai), sebagai job
 * TERTUNDA BullMQ dengan delay = delay_minutes langkah itu. jobId
 * deterministik `seq-<enrollmentId>-<stepPosition>`: relay yang memproses
 * event yang sama dua kali tidak menghasilkan dua job untuk langkah yang
 * sama; eksekusi ganda pun aman karena core menolak posisi basi.
 */
export interface SequenceStepJobData {
  tenantId: string;
  enrollmentId: string;
  stepPosition: number;
}

/**
 * Job Fase 7C: dispatch satu broadcast (materialisasi penerima + pesan
 * `queued` per penerima di core `dispatchBroadcast`). Di-enqueue oleh
 * relay outbox dari event `broadcast.dispatch_due` (ditulis API saat
 * broadcast dijadwalkan) sebagai job TERTUNDA dengan delay =
 * scheduled_at − sekarang; kirim-sekarang adalah kasus delay 0 dari
 * jalur yang sama. jobId deterministik `broadcast-<broadcastId>`:
 * satu broadcast tidak pernah punya dua job dispatch; eksekusi ulang
 * pun aman (klaim atomik + materialisasi yang bisa dilanjutkan di
 * core). Pembatalan broadcast terjadwal TIDAK menghapus job ini —
 * job yang terlanjur terjadwal akan menemukan status `cancelled`
 * dan selesai tanpa efek (core menolak status selain scheduled).
 */
export interface BroadcastDispatchJobData {
  tenantId: string;
  broadcastId: string;
}

/**
 * Job Fase 8A: jalankan langkah-langkah flow untuk satu run sampai
 * run menunggu (node delay) atau terminal. Di-enqueue oleh relay
 * outbox dari event `flow.step_due` (ditulis core saat run dibuat dan
 * setiap kali run masuk status `waiting`), sebagai job TERTUNDA
 * BullMQ dengan delay = sisa waktu node delay. jobId deterministik
 * `flow-<runId>-<nextStepSeq>`: resume yang sama tidak pernah punya
 * dua job; eksekusi ganda pun aman karena core menolak seq basi
 * (next_step_seq sudah maju) dan run yang sudah terminal.
 */
export interface FlowStepJobData {
  tenantId: string;
  runId: string;
  stepSeq: number;
}

/**
 * Job Fase 10B: evaluasi SATU komentar terhadap aturan komentar aktif
 * akunnya (comment-to-DM + moderasi). Di-enqueue oleh relay outbox
 * dari event `comment.received` (hanya ditulis core untuk komentar
 * yang benar-benar baru). jobId deterministik dari id event outbox;
 * core sendiri idempoten (actions.evaluatedAt + penanda DM terantre),
 * jadi eksekusi ulang/replay tidak menembak dua kali.
 */
export interface CommentEvaluateJobData {
  tenantId: string;
  commentId: string;
  outboxEventId: string;
}

/**
 * Job Fase 12D: bangkitkan embedding untuk chunk satu dokumen KB
 * (retrieval semantik). Di-enqueue oleh relay outbox dari event
 * `kb.embed_requested` (ditulis core dalam transaksi yang sama dengan
 * pembuatan dokumen/impor berkas). jobId deterministik dari id event
 * outbox; core sendiri idempoten (hanya chunk ber-embedding NULL yang
 * diproses), jadi eksekusi ulang aman. Tanpa provider embedding aktif,
 * processor selesai tanpa efek — chunk tetap bisa dicari full-text.
 */
export interface KbEmbedJobData {
  tenantId: string;
  documentId: string;
  outboxEventId: string;
}

/**
 * Job Fase 11B: kirim email SATU undangan tim lewat Resend. Di-enqueue
 * oleh relay outbox dari event `team.invitation_email_requested`
 * (ditulis lapisan API sesudah undangan tercipta, hanya bila email
 * platform terkonfigurasi). `tokenEnc` adalah token undangan sebagai
 * CIPHERTEXT envelope AES-256-GCM (secret env CHANNEL_TOKEN_SECRET) —
 * token mentah tidak pernah masuk antrean/DB; tabel invitations tetap
 * hanya menyimpan hash-nya. jobId deterministik dari id event outbox;
 * core idempoten (email_sent_at + status pending diperiksa ulang),
 * jadi eksekusi ulang aman.
 */
export interface InvitationEmailJobData {
  tenantId: string;
  invitationId: string;
  tokenEnc: string;
  outboxEventId: string;
}

/**
 * Job Fase 13G: sinkronkan SATU booking ke Google Calendar (buat /
 * hapus event). Di-enqueue oleh relay outbox dari event
 * `appointment.google_sync_requested` (ditulis transaksi booking
 * hanya bila tenant terhubung Google). Booking TIDAK PERNAH menunggu
 * job ini — hasil sinkron tercatat di baris booking
 * (google_sync_status/error) oleh core; jobId deterministik dari id
 * event outbox dan core membaca keadaan booking terkini sebelum
 * bertindak, jadi eksekusi ulang/urutan bertukar aman.
 */
export interface AppointmentGoogleSyncJobData {
  tenantId: string;
  bookingId: string;
  action: "create" | "delete";
  outboxEventId: string;
}

/**
 * Job Fase 23: terbitkan SATU postingan channel. Di-enqueue oleh relay
 * outbox dari event `post.publish_due`, sebagai job TERTUNDA dengan delay
 * = jam tayang.
 *
 * `scheduledAt` ikut dibawa dan WAJIB dicocokkan dengan kolom
 * `posts.scheduled_at` sebelum mengirim: penjadwalan ulang membuat job
 * baru, dan job lama (yang masih hidup di Redis) tidak boleh menerbitkan
 * lebih awal. jobId memuat `scheduledAt` supaya dua jadwal berbeda tidak
 * saling menimpa di antrean.
 */
export interface PostPublishJobData {
  tenantId: string;
  postId: string;
  scheduledAt: string;
}

/**
 * Job G11: fan-out SATU event outbox katalog webhook keluar
 * (`message.received` / `message.status_updated`) ke endpoint tenant
 * yang melanggan. Di-enqueue oleh relay outbox; jobId deterministik
 * dari id event outbox — relay yang mengulang event yang sama tidak
 * melahirkan fan-out kedua (dan core pun idempoten lewat UNIQUE
 * (endpoint_id, source_event_id) pada baris pengiriman).
 */
export interface OutboundWebhookFanoutJobData {
  tenantId: string;
  outboxEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Job G16: kirim SATU baris ledger konversi iklan
 * (`ad_conversion_events`) ke platformnya (Meta CAPI / Google Ads).
 * Di-enqueue oleh relay outbox dari event `ad_conversion.requested`;
 * jobId deterministik dari id event outbox. Pengiriman sendiri
 * idempoten per baris (baris 'sent' tidak dikirim ulang), dan
 * kegagalan platform tercatat di baris — bukan kegagalan job.
 */
export interface AdConversionSendJobData {
  tenantId: string;
  outboxEventId: string;
  /** Id baris `ad_conversion_events` yang dikirim. */
  adConversionEventRowId: string;
}

/** jobId deterministik dari id event outbox — fondasi idempotensi relay. */
export function automationEvaluateJobId(outboxEventId: string): string {
  return `automation-evaluate-${outboxEventId}`;
}

/** jobId deterministik satu langkah sequence: `seq-<enrollmentId>-<position>`. */
export function sequenceStepJobId(
  enrollmentId: string,
  stepPosition: number,
): string {
  return `seq-${enrollmentId}-${stepPosition}`;
}

/** jobId deterministik dari id pesan pemicu agent. */
export function agentRespondJobId(messageId: string): string {
  return `agent-respond-${messageId}`;
}

/** jobId deterministik dispatch broadcast: `broadcast-<broadcastId>`. */
export function broadcastDispatchJobId(broadcastId: string): string {
  return `broadcast-${broadcastId}`;
}

/** jobId deterministik satu resume flow: `flow-<runId>-<stepSeq>`. */
export function flowStepJobId(runId: string, stepSeq: number): string {
  return `flow-${runId}-${stepSeq}`;
}

/** jobId deterministik evaluasi komentar dari id event outbox. */
export function commentEvaluateJobId(outboxEventId: string): string {
  return `comment-evaluate-${outboxEventId}`;
}

/** jobId deterministik embedding KB dari id event outbox. */
export function kbEmbedJobId(outboxEventId: string): string {
  return `kb-embed-${outboxEventId}`;
}

/** jobId deterministik email undangan dari id event outbox. */
export function invitationEmailJobId(outboxEventId: string): string {
  return `invitation-email-${outboxEventId}`;
}

/** jobId deterministik sinkron Google janji dari id event outbox. */
export function appointmentGoogleSyncJobId(outboxEventId: string): string {
  return `appointment-google-sync-${outboxEventId}`;
}

/** jobId deterministik fan-out webhook keluar dari id event outbox. */
export function outboundWebhookFanoutJobId(outboxEventId: string): string {
  return `outbound-webhook-fanout-${outboxEventId}`;
}

/** jobId deterministik pengiriman konversi iklan dari id event outbox. */
export function adConversionSendJobId(outboxEventId: string): string {
  return `ad-conversion-${outboxEventId}`;
}

/**
 * Koneksi Redis untuk BullMQ. `maxRetriesPerRequest: null` adalah syarat
 * BullMQ untuk koneksi blocking (Worker). Buat SATU instance per peran
 * (queue / worker) per proses — jangan berbagi satu instance untuk keduanya.
 */
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * Koneksi Redis "fail-fast" untuk pemakaian di jalur request (mis.
 * penyimpanan rate limit Better Auth, Fase 13D).
 *
 * Beda dari `createRedisConnection`: perintah TIDAK diantrekan saat
 * Redis belum tersambung (`enableOfflineQueue: false`) dan gagal
 * setelah satu percobaan (`maxRetriesPerRequest: 1`). Ini penting agar
 * request auth tidak menggantung menunggu Redis yang mati — pemanggil
 * memperlakukan kegagalan sebagai "tidak ada data" (fail-open) dan
 * melanjutkan tanpa rate limit bersama.
 *
 * JANGAN dipakai untuk BullMQ: Worker/Queue membutuhkan koneksi
 * blocking dengan `maxRetriesPerRequest: null`.
 */
export function createEphemeralRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    lazyConnect: true,
  });
}

/** Semua data job yang berjalan di antrean fisik utama. */
export type MainJobData =
  | AutomationEvaluateJobData
  | AgentRespondJobData
  | SequenceStepJobData
  | BroadcastDispatchJobData
  | FlowStepJobData
  | CommentEvaluateJobData
  | KbEmbedJobData
  | InvitationEmailJobData
  | AppointmentGoogleSyncJobData
  | PostPublishJobData
  | OutboundWebhookFanoutJobData
  | AdConversionSendJobData;

export type MainQueue = Queue<MainJobData>;

export function createMainQueue(connection: Redis): MainQueue {
  return new Queue<MainJobData>(MAIN_QUEUE_NAME, { connection });
}

export type AutomationQueue = MainQueue;

/** Alias kompatibilitas (nama Fase 2A) untuk createMainQueue. */
export const createAutomationQueue = createMainQueue;

/**
 * Meng-enqueue evaluasi automation untuk satu event `message.received`.
 * Mengembalikan id job yang ada bila jobId yang sama sudah pernah
 * di-enqueue (BullMQ dedupe) — pemanggil tidak perlu mengecek duplikasi.
 */
export async function enqueueAutomationEvaluate(
  queue: MainQueue,
  data: AutomationEvaluateJobData,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(AUTOMATION_EVALUATE_JOB, data, {
    jobId: automationEvaluateJobId(data.outboxEventId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? automationEvaluateJobId(data.outboxEventId);
}

/**
 * Meng-enqueue respons agent untuk satu pesan inbound. Aman dipanggil
 * berulang: jobId diturunkan dari id pesan, BullMQ mengembalikan job yang
 * sudah ada.
 */
export async function enqueueAgentRespond(
  queue: MainQueue,
  data: AgentRespondJobData,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(AGENT_RESPOND_JOB, data, {
    jobId: agentRespondJobId(data.messageId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? agentRespondJobId(data.messageId);
}

/**
 * Meng-enqueue satu langkah sequence sebagai job TERTUNDA BullMQ.
 * `delayMs` dihitung pemanggil dari delay_minutes langkah (relay menggeser
 * titik mulai delay ke saat event ter-relay, ±2 dtk dari jadwal ideal —
 * toleransi yang terdokumentasi untuk staging). Aman dipanggil berulang:
 * jobId diturunkan dari (enrollmentId, posisi langkah).
 */
export async function enqueueSequenceStep(
  queue: MainQueue,
  data: SequenceStepJobData,
  delayMs: number,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(SEQUENCE_STEP_JOB, data, {
    jobId: sequenceStepJobId(data.enrollmentId, data.stepPosition),
    delay: Math.max(0, Math.floor(delayMs)),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? sequenceStepJobId(data.enrollmentId, data.stepPosition);
}

/**
 * Meng-enqueue dispatch broadcast sebagai job TERTUNDA BullMQ.
 * `delayMs` dihitung relay dari `dispatchAt` event outbox (titik mulai
 * delay bergeser ±2 dtk dari jadwal ideal — toleransi yang sama
 * seperti sequence). Aman dipanggil berulang: jobId diturunkan dari
 * id broadcast.
 */
export async function enqueueBroadcastDispatch(
  queue: MainQueue,
  data: BroadcastDispatchJobData,
  delayMs: number,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(BROADCAST_DISPATCH_JOB, data, {
    jobId: broadcastDispatchJobId(data.broadcastId),
    delay: Math.max(0, Math.floor(delayMs)),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? broadcastDispatchJobId(data.broadcastId);
}

/**
 * Meng-enqueue eksekusi flow sebagai job TERTUNDA BullMQ. `delayMs`
 * dihitung relay dari `resumeAt` event outbox (titik mulai delay
 * bergeser ±2 dtk dari jadwal ideal node delay — toleransi yang sama
 * seperti sequence/broadcast). Aman dipanggil berulang: jobId
 * diturunkan dari (runId, stepSeq).
 */
export async function enqueueFlowStep(
  queue: MainQueue,
  data: FlowStepJobData,
  delayMs: number,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(FLOW_STEP_JOB, data, {
    jobId: flowStepJobId(data.runId, data.stepSeq),
    delay: Math.max(0, Math.floor(delayMs)),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? flowStepJobId(data.runId, data.stepSeq);
}

/**
 * Meng-enqueue evaluasi aturan komentar untuk satu event
 * `comment.received`. Aman dipanggil berulang: jobId diturunkan dari
 * id event outbox, BullMQ mengembalikan job yang sudah ada.
 */
export async function enqueueCommentEvaluate(
  queue: MainQueue,
  data: CommentEvaluateJobData,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(COMMENT_EVALUATE_JOB, data, {
    jobId: commentEvaluateJobId(data.outboxEventId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? commentEvaluateJobId(data.outboxEventId);
}

/**
 * Meng-enqueue pembangkitan embedding untuk satu dokumen KB dari
 * event `kb.embed_requested`. Aman dipanggil berulang: jobId diturunkan
 * dari id event outbox. attempts 3 + backoff eksponensial = retry
 * wajar untuk kegagalan provider sesaat; kegagalan permanen (mis.
 * model salah dimensi) berakhir sebagai job gagal yang terlihat di
 * log, BUKAN dokumen yang gagal disimpan (dokumen sudah tersimpan
 * lebih dulu; embedding menyusul atau tidak sama sekali).
 */
export async function enqueueKbEmbed(
  queue: MainQueue,
  data: KbEmbedJobData,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(KB_EMBED_JOB, data, {
    jobId: kbEmbedJobId(data.outboxEventId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? kbEmbedJobId(data.outboxEventId);
}

/**
 * Meng-enqueue pengiriman email untuk satu undangan dari event
 * `team.invitation_email_requested`. Aman dipanggil berulang: jobId
 * diturunkan dari id event outbox. attempts 3 + backoff eksponensial =
 * retry wajar untuk kegagalan provider sesaat; kegagalan permanen
 * berakhir sebagai job gagal yang terlihat di log DAN tercatat di
 * `invitations.email_error` — undangan sendiri tetap sah lewat tautan
 * salin, jadi email yang gagal tidak menggantungkan apa pun.
 */
export async function enqueueInvitationEmail(
  queue: MainQueue,
  data: InvitationEmailJobData,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(TEAM_INVITATION_EMAIL_JOB, data, {
    jobId: invitationEmailJobId(data.outboxEventId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? invitationEmailJobId(data.outboxEventId);
}

/**
 * Meng-enqueue sinkron Google Calendar untuk satu booking dari event
 * `appointment.google_sync_requested`. Aman dipanggil berulang: jobId
 * diturunkan dari id event outbox. attempts 3 + backoff eksponensial
 * untuk kegagalan provider sesaat; hasil akhir (termasuk kegagalan
 * permanen) tercatat core di baris booking — job tidak melempar untuk
 * kegagalan provider, jadi antrean tidak macet oleh satu tenant yang
 * grant-nya dicabut.
 */
export async function enqueueAppointmentGoogleSync(
  queue: MainQueue,
  data: AppointmentGoogleSyncJobData,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(APPOINTMENT_GOOGLE_SYNC_JOB, data, {
    jobId: appointmentGoogleSyncJobId(data.outboxEventId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? appointmentGoogleSyncJobId(data.outboxEventId);
}

/**
 * jobId deterministik untuk publikasi postingan: SATU jadwal = SATU job.
 * `scheduledAt` ikut di dalam id supaya penjadwalan ulang menghasilkan job
 * baru (jadwal lama tetap hidup sampai waktunya tiba, lalu ditolak
 * publisher karena `scheduled_at` sudah berbeda).
 */
export function postPublishJobId(postId: string, scheduledAt: string): string {
  const stamp = new Date(scheduledAt).getTime();
  return `post-${postId}-${Number.isFinite(stamp) ? stamp : scheduledAt}`;
}

/**
 * Meng-enqueue publikasi postingan sebagai job TERTUNDA BullMQ.
 *
 * `attempts: 1` SENGAJA — berbeda dari broadcast/sequence. Menerbitkan
 * postingan ke linimasa publik TIDAK idempoten: percobaan ulang setelah
 * provider menerima (tetapi sebelum penandaan berhasil) akan menghasilkan
 * dua postingan. Kegagalan dicatat sebagai `failed` dan operator yang
 * memutuskan, bukan mesin yang mencoba lagi diam-diam.
 */
export async function enqueuePostPublish(
  queue: MainQueue,
  data: PostPublishJobData,
  delayMs: number,
  options?: JobsOptions,
): Promise<string> {
  const jobId = postPublishJobId(data.postId, data.scheduledAt);
  const job = await queue.add(POST_PUBLISH_JOB, data, {
    jobId,
    delay: Math.max(0, Math.floor(delayMs)),
    attempts: 1,
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? jobId;
}

/**
 * Meng-enqueue fan-out webhook keluar untuk satu event outbox.
 * Aman dipanggil berulang: jobId diturunkan dari id event outbox,
 * BullMQ mengembalikan job yang sudah ada.
 */
export async function enqueueOutboundWebhookFanout(
  queue: MainQueue,
  data: OutboundWebhookFanoutJobData,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(OUTBOUND_WEBHOOK_FANOUT_JOB, data, {
    jobId: outboundWebhookFanoutJobId(data.outboxEventId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? outboundWebhookFanoutJobId(data.outboxEventId);
}

/**
 * Meng-enqueue pengiriman satu konversi iklan. Aman dipanggil
 * berulang: jobId diturunkan dari id event outbox, BullMQ
 * mengembalikan job yang sudah ada.
 */
export async function enqueueAdConversionSend(
  queue: MainQueue,
  data: AdConversionSendJobData,
  options?: JobsOptions,
): Promise<string> {
  const job = await queue.add(AD_CONVERSION_SEND_JOB, data, {
    jobId: adConversionSendJobId(data.outboxEventId),
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    ...options,
  });
  return job.id ?? adConversionSendJobId(data.outboxEventId);
}

export {
  createRealtimePublisher,
  realtimeTenantChannel,
  REALTIME_TENANT_CHANNEL_PATTERN,
  REALTIME_TENANT_CHANNEL_PREFIX,
  type RealtimePublisher,
} from "./realtime";
