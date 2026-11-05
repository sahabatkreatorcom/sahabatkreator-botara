import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  APPOINTMENT_DEFAULT_INVALID_PROMPT,
  APPOINTMENT_DEFAULT_NO_SLOTS_MESSAGE,
  APPOINTMENT_DEFAULT_SLOT_TAKEN_PROMPT,
  CATALOG_DEFAULT_INVALID_PROMPT,
  findFlowTemplate,
  QUESTIONNAIRE_DEFAULT_INVALID_PROMPT,
} from "@sahabat-kreator/contracts";
import {
  auditLogs,
  automationRuns,
  automationSteps,
  automations,
  contacts,
  conversations,
  flowExperimentAssignments,
  flowRunSteps,
  flowRuns,
  flows,
  messages,
  outboxEvents,
  products,
  sequenceEnrollments,
  type Contact,
  type Conversation,
  type Database,
  type Flow,
  type FlowRun,
  type FlowRunStep,
} from "@sahabat-kreator/db";
import type { EmbeddingProvider, LlmProvider } from "@sahabat-kreator/ai";
import { withTenantDb, type DbTx } from "./tx";
import {
  experimentBucket,
  flowBranchForBucket,
  flowExperimentKey,
} from "./experiments";
import { renderMessageText } from "./render-text";
import { normalizeContactPhone } from "./contacts";
import { respondToInboundMessage } from "./agent-runtime";
import { buildPaymentUrl, createPaymentLink, PAYMENT_LINK_TTL_DAYS } from "./products";
import {
  addToCartTx,
  checkoutCartTx,
  getCartView,
  getCartViewTx,
  listActiveCatalogProductsTx,
  parseCatalogSelection,
  prepareOrderCheckoutLink,
  renderCartSummaryText,
  renderCatalogText,
} from "./commerce";
import {
  PaymentProviderError,
  type PaymentDeps,
} from "./payments";
import {
  createBooking,
  getAppointmentSettings,
  getBookableSlots,
  parseSlotSelection,
  renderSlotListText,
  AppointmentServiceNotFoundError,
  SlotTakenError,
  type BookableSlot,
} from "./appointments";
import type { GoogleDeps } from "./google-calendar";

/**
 * Flow Engine (Fase 8A) — eksekutor graf node di worker.
 *
 * FORMAT GRAF adalah kontrak di @sahabat-kreator/contracts (`FlowGraph`):
 * { nodes: [{id, type, config}], edges: [{from, to, branch?}] }, tepat
 * satu node `trigger`. Modul ini punya tiga sisi:
 *
 * 1. MANAJEMEN (API dashboard): CRUD flow + aktivasi dengan validasi
 *    graf menyeluruh (`validateFlowGraph`). Graf draft boleh belum sah;
 *    yang ditegakkan di sini: edit hanya saat draft, transisi status
 *    yang sah, dan aktivasi menolak graf rusak dengan daftar masalah
 *    terstruktur (kode FLOW_GRAPH_INVALID di lapisan API).
 * 2. PEMICU (dipanggil evaluasi pesan masuk di automations.ts SETELAH
 *    pencocokan automation keyword/sequence): flow AKTIF yang
 *    trigger-nya cocok memulai satu run. Idempotensi berlapis: cek run
 *    yang sudah ada + index unik parsial (flow_id, trigger_message_id).
 *    Pesan dari kontak opt-out tidak memulai run baru dan MEMBATALKAN
 *    run `waiting` di percakapan itu (konsisten aturan opt-out
 *    sequence; audit `flow.run_cancelled`).
 * 3. EKSEKUSI (worker, job `flow.step`): `executeFlowStep` menjalankan
 *    node demi node — satu transaksi tenant per node — sampai run
 *    menunggu (node `delay`: status `waiting` + event outbox
 *    `flow.step_due` yang diterjemahkan relay menjadi job tertunda
 *    dengan jobId `flow-<runId>-<seq>`) atau terminal. Setiap node
 *    menulis satu baris `flow_run_steps` (log per langkah). Cap
 *    FLOW_MAX_STEPS langkah per run menahan graf melingkar: run
 *    `failed` beralasan `step_cap_exceeded`, worker tetap sehat.
 *
 * KEPUTUSAN DESAIN v1 (terdokumentasi di DEPLOY-STAGING.md):
 * - Balasan kontak biasa TIDAK membatalkan run flow (berbeda dengan
 *   sequence 2C yang berhenti saat kontak membalas): flow adalah alur
 *   percakapan yang memang mengharapkan balasan di tengah jalan
 *   (mis. sesudah node ai_response). Yang membatalkan run: opt-out
 *   kontak dan cap langkah.
 * - Menonaktifkan/mengarsipkan flow TIDAK membatalkan run yang sedang
 *   berjalan (konsisten sequence: is_active hanya memblokir pemicu
 *   baru) — run menyelesaikan graf versi SAAT RUN DIMULAI? Tidak:
 *   eksekutor membaca graf flow saat ini. Mengedit graf flow aktif
 *   memang dicegah (edit hanya draft), jadi graf tidak berubah di
 *   bawah run yang hidup kecuali lewat nonaktifkan→edit→aktifkan;
 *   risiko itu diterima v1 dan dicatat.
 * - Node `ai_response` memanggil jalur agent.respond yang ADA
 *   (`respondToInboundMessage`) untuk pesan pemicu run: mode auto →
 *   balasan terkirim; suggest → saran tercatat; agent tak ada/
 *   nonaktif untuk percakapan → langkah `skipped` beralasan, run
 *   lanjut (BUKAN crash).
 *
 * FASE 12A — enam tipe node baru (kontrak didokumentasikan penuh di
 * packages/contracts): set_field, http_request, goto_flow, ab_split,
 * send_payment_link, wait_reply. Keputusan desain yang mengikat:
 * - http_request TIDAK PERNAH menggagalkan run: kegagalan jaringan/
 *   non-2xx tercatat di detail langkah (`http_error`) dan run lanjut
 *   ke node berikutnya. Timeout 10 detik; substitusi variabel sempit
 *   ({name} + {{field:<key>}}, tanpa spintax).
 * - goto_flow memulai run BARU (trigger_message_id NULL — migrasi
 *   0038) dan menyelesaikan run asal; kedalaman rantai di context
 *   (`gotoDepth`, maks FLOW_GOTO_MAX_DEPTH) menahan siklus A→B→A.
 * - wait_reply parkir PADA nodenya (context.wait {nodeId, deadline,
 *   parkedAt}): balasan kontak melanjutkannya lewat branch "replied"
 *   dari jalur evaluasi pesan masuk (pesan yang sama TETAP diproses
 *   pemicu lain seperti biasa), tenggat lewat → job resume yang sama
 *   menjalankan branch "timeout". Opt-out membatalkan seperti delay.
 *
 * FASE 13E — node `questionnaire` (kontrak didokumentasikan penuh di
 * packages/contracts): daftar pertanyaan berurutan dalam satu node
 * yang MEMAKAI ULANG mesin parkir wait_reply — penanda parkirnya
 * tetap context.wait, keadaan kuesionernya hidup di
 * context.questionnaire {nodeId, qIndex, attempts, answers,
 * startedAt}. Bedanya dari wait_reply: (1) tenggat berlaku PER
 * PERTANYAAN (setiap parkir — pertanyaan baru maupun prompt ulang —
 * memasang tenggat baru, persis semantik per-parkir wait_reply);
 * (2) resolusi balasan BUKAN sekadar memilih branch: balasan
 * divalidasi menurut tipe jawaban, jawaban sah langsung ditulis ke
 * field target kontak, lalu run parkir lagi untuk pertanyaan
 * berikutnya atau keluar lewat branch completed/invalid; (3) target
 * `custom:<key>` harus kunci yang dikenal tenant — produk tidak
 * punya registri definisi field, jadi "definisi" = himpunan kunci
 * custom_fields yang dibawa kontak-kontak tenant (ditegakkan saat
 * aktivasi + diperiksa ulang setiap pertanyaan hendak dikirim).
 *
 * FASE 13F — node commerce `show_catalog` + `cart_checkout` (kontrak
 * didokumentasikan penuh di packages/contracts):
 * - show_catalog MEMAKAI ULANG mesin parkir yang sama (context.wait;
 *   keadaan katalog di context.catalog {nodeId, productIds, attempts,
 *   listedAt} — daftar id produk SESUAI urutan pengiriman, agar nomor
 *   balasan selalu menunjuk produk yang dilihat kontak walau katalog
 *   berubah di tengah parkir). Balasan diparsing parseCatalogSelection
 *   ("N" / "NxM"); produk yang sudah nonaktif/terhapus sejak daftar
 *   dikirim adalah percobaan tidak sah beralasan product_inactive /
 *   product_unavailable (BUKAN penambahan diam-diam). Penambahan sah
 *   menulis ke keranjang lewat commerce.addToCartTx (snapshot harga
 *   saat tambah), mengirim ringkasan keranjang, lalu keluar branch
 *   "added" — node TIDAK parkir ulang sesudah menambah; kelanjutan
 *   belanja adalah komposisi graf (catalog → catalog / checkout).
 * - cart_checkout TIDAK parkir: pola node khusus di executeFlowStep
 *   seperti send_payment_link (butuh deps.publicBaseUrl untuk URL
 *   tautan) — checkout atomik di commerce.checkoutCartTx, pesan
 *   ringkasan + tautan antre, lalu branch checked_out / empty_cart.
 *
 * FASE 13G — node `book_appointment` (kontrak didokumentasikan penuh
 * di packages/contracts): pola node khusus di executeFlowStep seperti
 * ai_response, karena daftar slot dihitung mesin slot inti
 * (appointments.getBookableSlots) yang boleh memotong kesibukan
 * Google (HTTP freebusy) — hitungan itu berjalan DI LUAR transaksi
 * langkah; transaksi hanya menulis baris langkah + pesan daftar +
 * keadaan parkir (context.appointment {nodeId, serviceId,
 * offeredSlots, attempts, listedAt} — slot yang DITAWARKAN dibekukan
 * sebagai instan ISO agar nomor balasan selalu menunjuk slot yang
 * dilihat kontak). Balasan diproses processParkedAppointmentReply di
 * jalur evaluasi: nomor sah → booking dibuat lewat createBooking
 * (transaksinya SENDIRI di luar transaksi evaluasi — pola jalur
 * dashboard; pelanggaran constraint eksklusi = SlotTakenError yang
 * ditangkap bersih tanpa savepoint bersarang)
 * → branch "booked"; slot keburu diambil & daftar segar kosong →
 * branch "slot_taken"; daftar segar masih ada → pemberitahuan +
 * daftar segar ditawarkan ulang (parkir lagi, attempts TIDAK
 * bertambah — balapan bukan kesalahan kontak). Tenggat lewat →
 * branch "timeout" lewat blok parkir eksekutor yang sama.
 */

export const FLOW_MAX_STEPS = 100;

/** Kedalaman rantai goto_flow maksimum (context.gotoDepth run baru). */
export const FLOW_GOTO_MAX_DEPTH = 5;

/** Timeout permintaan node http_request (milidetik). */
export const FLOW_HTTP_TIMEOUT_MS = 10_000;

export type FlowStatus = Flow["status"];
export type FlowRunStatus = FlowRun["status"];

export interface FlowGraphNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  /**
   * Posisi canvas builder (Fase 8B) — metadata tampilan yang dibawa apa
   * adanya oleh normalisasi agar round-trip API utuh; eksekutor tidak
   * pernah membacanya.
   */
  position?: { x: number; y: number };
}

/** Cabang edge — selaras FlowEdgeBranchSchema di kontrak. */
export type FlowBranch =
  | "yes"
  | "no"
  | "a"
  | "b"
  | "replied"
  | "timeout"
  | "completed"
  | "invalid"
  | "added"
  | "checked_out"
  | "empty_cart"
  | "booked"
  | "slot_taken";

export interface FlowGraphEdge {
  from: string;
  to: string;
  branch?: FlowBranch;
}

export interface FlowGraphData {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

const NODE_TYPES = new Set([
  "trigger",
  "send_message",
  "condition",
  "delay",
  "add_tag",
  "remove_tag",
  "set_stage",
  "enroll_sequence",
  "ai_response",
  "handoff",
  "end",
  // Fase 12A
  "set_field",
  "http_request",
  "goto_flow",
  "ab_split",
  "send_payment_link",
  "wait_reply",
  // Fase 13E
  "questionnaire",
  // Fase 13F
  "show_catalog",
  "cart_checkout",
  // Fase 13G
  "book_appointment",
]);

const FLOW_BRANCHES: readonly FlowBranch[] = [
  "yes",
  "no",
  "a",
  "b",
  "replied",
  "timeout",
  "completed",
  "invalid",
  "added",
  "checked_out",
  "empty_cart",
  "booked",
  "slot_taken",
];

function isValidFlowPosition(
  value: unknown,
): value is { x: number; y: number } {
  if (typeof value !== "object" || value === null) return false;
  const p = value as { x?: unknown; y?: unknown };
  return (
    typeof p.x === "number" &&
    Number.isFinite(p.x) &&
    typeof p.y === "number" &&
    Number.isFinite(p.y)
  );
}

/** Normalisasi jsonb graf menjadi bentuk kerja (defensif terhadap data lama). */
export function normalizeFlowGraph(raw: unknown): FlowGraphData {
  const graph = (raw ?? {}) as { nodes?: unknown; edges?: unknown };
  const nodes: FlowGraphNode[] = Array.isArray(graph.nodes)
    ? graph.nodes
        .filter(
          (n): n is FlowGraphNode =>
            typeof n === "object" &&
            n !== null &&
            typeof (n as FlowGraphNode).id === "string" &&
            typeof (n as FlowGraphNode).type === "string",
        )
        .map((n) => ({
          id: n.id,
          type: n.type,
          config:
            typeof n.config === "object" && n.config !== null
              ? (n.config as Record<string, unknown>)
              : {},
          // `position` builder (8B) dipertahankan hanya bila bentuknya
          // sah (dua angka finite); selain itu dibuang diam-diam —
          // normalisasi memang defensif terhadap data lama/rusak.
          ...(isValidFlowPosition(n.position)
            ? { position: { x: n.position.x, y: n.position.y } }
            : {}),
        }))
    : [];
  const edges: FlowGraphEdge[] = Array.isArray(graph.edges)
    ? graph.edges
        .filter(
          (e): e is FlowGraphEdge =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as FlowGraphEdge).from === "string" &&
            typeof (e as FlowGraphEdge).to === "string",
        )
        .map((e) => ({
          from: e.from,
          to: e.to,
          branch:
            typeof e.branch === "string" &&
            (FLOW_BRANCHES as readonly string[]).includes(e.branch)
              ? (e.branch as FlowBranch)
              : undefined,
        }))
    : [];
  return { nodes, edges };
}

function triggerOf(graph: FlowGraphData): FlowGraphNode | null {
  return graph.nodes.find((n) => n.type === "trigger") ?? null;
}

/** Node pertama sesudah trigger (edge keluar trigger tanpa branch). */
function firstNodeAfterTrigger(graph: FlowGraphData): string | null {
  const trigger = triggerOf(graph);
  if (!trigger) return null;
  const edge = graph.edges.find((e) => e.from === trigger.id);
  return edge ? edge.to : null;
}

/** Node lanjutan: untuk node bercabang wajib menyebut branch; selain itu edge pertama. */
function nextNodeId(
  graph: FlowGraphData,
  nodeId: string,
  branch?: FlowBranch,
): string | null {
  const out = graph.edges.filter((e) => e.from === nodeId);
  if (branch) {
    const picked = out.find((e) => e.branch === branch);
    return picked ? picked.to : null;
  }
  const picked = out.find((e) => e.branch === undefined) ?? out[0];
  return picked ? picked.to : null;
}

/** Satu jawaban tercatat di transkrip kuesioner (Fase 13E). */
export interface QuestionnaireAnswerRecord {
  questionId: string;
  prompt: string;
  target: string;
  answerType: string;
  outcome: "answered" | "skipped" | "failed" | "target_missing";
  /** Balasan mentah terakhir untuk pertanyaan ini (null bila tak pernah dijawab). */
  raw: string | null;
  /** Nilai yang benar-benar ditulis ke field target (null bila tidak ada). */
  stored: unknown;
  /** Percobaan tidak sah yang terpakai untuk pertanyaan ini. */
  attempts: number;
}

/** Keadaan node questionnaire yang parkir, di `flow_runs.context`. */
export interface QuestionnaireRunState {
  nodeId: string;
  /** Indeks pertanyaan yang sedang menunggu jawaban. */
  qIndex: number;
  /** Percobaan tidak sah pada pertanyaan berjalan. */
  attempts: number;
  answers: QuestionnaireAnswerRecord[];
  startedAt: string;
}

/** Keadaan node show_catalog yang parkir, di `flow_runs.context` (Fase 13F). */
export interface CatalogRunState {
  nodeId: string;
  /**
   * Id produk SESUAI urutan daftar yang dikirim ke kontak — nomor
   * balasan menunjuk daftar ini, bukan katalog berjalan, agar
   * perubahan katalog di tengah parkir tidak menggeser arti nomor.
   */
  productIds: string[];
  /** Percobaan tidak sah selama parkir ini. */
  attempts: number;
  listedAt: string;
}

/** Keadaan node book_appointment yang parkir, di `flow_runs.context` (Fase 13G). */
export interface AppointmentRunState {
  nodeId: string;
  serviceId: string;
  /**
   * Slot yang DITAWARKAN ke kontak sebagai instan ISO, SESUAI urutan
   * daftar yang dikirim — nomor balasan menunjuk daftar ini, bukan
   * hitungan slot berjalan, agar perubahan ketersediaan di tengah
   * parkir tidak menggeser arti nomor. Ketersediaan slot tetap
   * divalidasi ulang oleh constraint eksklusi saat dipilih.
   */
  offeredSlots: Array<{ startsAt: string; endsAt: string }>;
  /** Percobaan tidak sah selama parkir ini. */
  attempts: number;
  listedAt: string;
}

/** Bentuk `flow_runs.context` yang dibaca eksekutor (defensif). */
export interface FlowRunContextData {
  triggerText?: string;
  /** Kedalaman rantai goto_flow (0/absen = run dari pesan masuk). */
  gotoDepth?: number;
  /** Pesan pemicu run akar — untuk run yang lahir dari goto_flow. */
  rootTriggerMessageId?: string;
  /** Parkir wait_reply: node yang menunggu + tenggatnya. */
  wait?: { nodeId: string; deadline: string; parkedAt: string };
  /** Keadaan questionnaire (Fase 13E) selama node-nya parkir. */
  questionnaire?: QuestionnaireRunState;
  /** Keadaan show_catalog (Fase 13F) selama node-nya parkir. */
  catalog?: CatalogRunState;
  /** Keadaan book_appointment (Fase 13G) selama node-nya parkir. */
  appointment?: AppointmentRunState;
  [key: string]: unknown;
}

function runContextOf(run: FlowRun): FlowRunContextData {
  const raw = (run.context ?? {}) as Record<string, unknown>;
  const out: FlowRunContextData = { ...raw };
  if (typeof raw.triggerText !== "string") delete out.triggerText;
  if (typeof raw.gotoDepth !== "number") delete out.gotoDepth;
  if (typeof raw.rootTriggerMessageId !== "string") {
    delete out.rootTriggerMessageId;
  }
  const w = raw.wait as
    | { nodeId?: unknown; deadline?: unknown; parkedAt?: unknown }
    | undefined;
  if (
    typeof w !== "object" ||
    w === null ||
    typeof w.nodeId !== "string" ||
    typeof w.deadline !== "string"
  ) {
    delete out.wait;
  } else {
    out.wait = {
      nodeId: w.nodeId,
      deadline: w.deadline,
      parkedAt: typeof w.parkedAt === "string" ? w.parkedAt : w.deadline,
    };
  }
  const q = raw.questionnaire as Partial<QuestionnaireRunState> | undefined;
  if (
    typeof q !== "object" ||
    q === null ||
    typeof q.nodeId !== "string" ||
    typeof q.qIndex !== "number" ||
    !Number.isInteger(q.qIndex) ||
    q.qIndex < 0 ||
    !Array.isArray(q.answers)
  ) {
    delete out.questionnaire;
  } else {
    out.questionnaire = {
      nodeId: q.nodeId,
      qIndex: q.qIndex,
      attempts:
        typeof q.attempts === "number" && Number.isInteger(q.attempts)
          ? Math.max(0, q.attempts)
          : 0,
      answers: q.answers as QuestionnaireAnswerRecord[],
      startedAt: typeof q.startedAt === "string" ? q.startedAt : "",
    };
  }
  const cat = raw.catalog as Partial<CatalogRunState> | undefined;
  if (
    typeof cat !== "object" ||
    cat === null ||
    typeof cat.nodeId !== "string" ||
    !Array.isArray(cat.productIds) ||
    !cat.productIds.every((id) => typeof id === "string")
  ) {
    delete out.catalog;
  } else {
    out.catalog = {
      nodeId: cat.nodeId,
      productIds: cat.productIds as string[],
      attempts:
        typeof cat.attempts === "number" && Number.isInteger(cat.attempts)
          ? Math.max(0, cat.attempts)
          : 0,
      listedAt: typeof cat.listedAt === "string" ? cat.listedAt : "",
    };
  }
  const appt = raw.appointment as Partial<AppointmentRunState> | undefined;
  if (
    typeof appt !== "object" ||
    appt === null ||
    typeof appt.nodeId !== "string" ||
    typeof appt.serviceId !== "string" ||
    !Array.isArray(appt.offeredSlots) ||
    !appt.offeredSlots.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as { startsAt?: unknown }).startsAt === "string" &&
        typeof (s as { endsAt?: unknown }).endsAt === "string",
    )
  ) {
    delete out.appointment;
  } else {
    out.appointment = {
      nodeId: appt.nodeId,
      serviceId: appt.serviceId,
      offeredSlots: appt.offeredSlots as Array<{
        startsAt: string;
        endsAt: string;
      }>,
      attempts:
        typeof appt.attempts === "number" && Number.isInteger(appt.attempts)
          ? Math.max(0, appt.attempts)
          : 0,
      listedAt: typeof appt.listedAt === "string" ? appt.listedAt : "",
    };
  }
  return out;
}

/** Id pesan pemicu efektif run (langsung, atau akar rantai goto). */
function effectiveTriggerMessageId(run: FlowRun): string | null {
  if (run.triggerMessageId) return run.triggerMessageId;
  const ctx = runContextOf(run);
  return ctx.rootTriggerMessageId ?? null;
}

/**
 * Substitusi variabel node http_request (Fase 12A) — SENGAJA SEMPIT,
 * selaras kontrak: `{name}` → nama kontak; `{{field:<key>}}` → nilai
 * contacts.custom_fields[key] (string apa adanya; nilai non-string
 * di-JSON-kan; kunci hilang/null → string kosong). TANPA spintax —
 * payload HTTP harus deterministik. Urutan: field dulu, lalu {name}.
 */
export function renderFlowHttpTemplate(
  template: string,
  contact: Contact | null,
): string {
  const custom = (contact?.customFields ?? {}) as Record<string, unknown>;
  const withFields = template.replace(
    /\{\{field:([^}]+)\}\}/g,
    (_match, key: string) => {
      const value = custom[key.trim()];
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
  return withFields.replaceAll("{name}", contact?.name ?? "");
}

// ---------------------------------------------------------------------------
// Validasi graf (aktivasi)
// ---------------------------------------------------------------------------

export interface FlowGraphIssue {
  code: string;
  severity: "error" | "warning";
  nodeId: string | null;
  message: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Id rujukan yang bukan UUID pasti tidak ditemukan (menghindari error PG). */
function isUuidLike(v: string): boolean {
  return UUID_LIKE_RE.test(v);
}

// ---------------------------------------------------------------------------
// Questionnaire (Fase 13E) — bentuk config + validasi jawaban
// ---------------------------------------------------------------------------

export type QuestionnaireAnswerType =
  | "text"
  | "number"
  | "email"
  | "phone"
  | "choice";

export interface QuestionnaireQuestion {
  id: string;
  prompt: string;
  answerType: QuestionnaireAnswerType;
  target: string;
  required: boolean;
  options: string[];
}

export interface QuestionnaireConfig {
  questions: QuestionnaireQuestion[];
  timeoutMs: number;
  maxInvalidAttempts: number;
  invalidPrompt: string | null;
  completionTag: string | null;
}

const QUESTIONNAIRE_ANSWER_TYPES: readonly string[] = [
  "text",
  "number",
  "email",
  "phone",
  "choice",
];

/** Target sah: kolom standar atau `custom:<key>` non-kosong ≤ 128 char total. */
export function isQuestionnaireTarget(value: unknown): value is string {
  if (value === "name" || value === "email" || value === "phone") return true;
  return (
    typeof value === "string" &&
    value.startsWith("custom:") &&
    value.slice("custom:".length).trim().length > 0 &&
    value.length <= 128
  );
}

function questionnaireTargetKey(target: string): string | null {
  return target.startsWith("custom:")
    ? target.slice("custom:".length)
    : null;
}

/**
 * Membaca config node questionnaire menjadi bentuk kerja (DEFENSIF —
 * graf aktif lama/rusak tidak boleh meledakkan eksekutor; keabsahan
 * ditegakkan validasi aktivasi). Pertanyaan yang bentuknya rusak
 * dibuang; daftar kosong ditangani pemanggil sebagai kegagalan node.
 */
export function questionnaireConfigOf(
  node: FlowGraphNode,
): QuestionnaireConfig {
  const c = node.config;
  const rawQuestions = Array.isArray(c.questions) ? c.questions : [];
  const questions: QuestionnaireQuestion[] = [];
  for (const raw of rawQuestions) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    if (
      typeof q.id !== "string" ||
      !q.id ||
      typeof q.prompt !== "string" ||
      !q.prompt.trim() ||
      typeof q.answerType !== "string" ||
      !QUESTIONNAIRE_ANSWER_TYPES.includes(q.answerType) ||
      !isQuestionnaireTarget(q.target)
    ) {
      continue;
    }
    questions.push({
      id: q.id,
      prompt: q.prompt,
      answerType: q.answerType as QuestionnaireAnswerType,
      target: q.target,
      required: q.required !== false,
      options: Array.isArray(q.options)
        ? q.options.filter(isNonEmptyString)
        : [],
    });
  }
  const amount = typeof c.amount === "number" ? c.amount : NaN;
  const unitMs =
    c.unit === "seconds"
      ? 1_000
      : c.unit === "minutes"
        ? 60_000
        : c.unit === "hours"
          ? 3_600_000
          : NaN;
  const timeoutMs =
    Number.isFinite(amount) && Number.isFinite(unitMs)
      ? Math.max(0, Math.floor(amount * unitMs))
      : 3_600_000;
  const attempts = c.maxInvalidAttempts;
  return {
    questions,
    timeoutMs,
    maxInvalidAttempts:
      typeof attempts === "number" &&
      Number.isInteger(attempts) &&
      attempts >= 1 &&
      attempts <= 5
        ? attempts
        : 2,
    invalidPrompt: isNonEmptyString(c.invalidPrompt) ? c.invalidPrompt : null,
    completionTag: isNonEmptyString(c.completionTag)
      ? c.completionTag.trim()
      : null,
  };
}

export type QuestionnaireAnswerValidation =
  | { ok: true; value: string | number }
  | { ok: false; reason: "empty" | "not_a_number" | "not_an_email" | "not_a_phone" | "not_a_choice" };

const QUESTIONNAIRE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validasi SATU balasan terhadap tipe pertanyaannya. Nilai hasil
 * adalah nilai yang ditulis ke field target: text/email/phone/choice
 * string (email dilowercase, phone digit ternormalisasi dedup,
 * choice = teks opsi kanonis), number angka (target standar menerima
 * bentuk stringnya di penulis field). Koma desimal Indonesia
 * ("12,5") diterima untuk number bila tidak ada titik.
 */
export function validateQuestionnaireAnswer(
  question: QuestionnaireQuestion,
  rawText: string,
): QuestionnaireAnswerValidation {
  const text = rawText.trim();
  switch (question.answerType) {
    case "text":
      return text
        ? { ok: true, value: text }
        : { ok: false, reason: "empty" };
    case "email": {
      const email = text.toLowerCase();
      return QUESTIONNAIRE_EMAIL_RE.test(email)
        ? { ok: true, value: email }
        : { ok: false, reason: "not_an_email" };
    }
    case "phone": {
      const normalized = normalizeContactPhone(text);
      return normalized
        ? { ok: true, value: normalized }
        : { ok: false, reason: "not_a_phone" };
    }
    case "number": {
      if (!text) return { ok: false, reason: "empty" };
      const candidate =
        text.includes(",") && !text.includes(".")
          ? text.replace(",", ".")
          : text;
      const value = Number(candidate);
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, reason: "not_a_number" };
    }
    case "choice": {
      if (/^\d+$/.test(text)) {
        const idx = Number.parseInt(text, 10);
        if (idx >= 1 && idx <= question.options.length) {
          return { ok: true, value: question.options[idx - 1] };
        }
      }
      const match = question.options.find(
        (o) => o.trim().toLowerCase() === text.toLowerCase(),
      );
      return match
        ? { ok: true, value: match }
        : { ok: false, reason: "not_a_choice" };
    }
  }
}

/**
 * Render teks pertanyaan yang dikirim ke kontak: prompt dirender
 * seperti send_message ({name} + spintax); choice menambahkan daftar
 * opsi BERNOMOR — render seragam di semua channel karena lapisan
 * keluar flow tidak punya tombol quick-reply (lihat kontrak).
 */
export function renderQuestionnairePrompt(
  question: QuestionnaireQuestion,
  contact: Contact | null,
): string {
  const base = renderMessageText(question.prompt, {
    name: contact?.name,
  });
  if (question.answerType !== "choice" || question.options.length === 0) {
    return base;
  }
  const list = question.options
    .map((option, i) => `${i + 1}. ${option}`)
    .join("\n");
  return `${base}\n${list}`;
}

// ---------------------------------------------------------------------------
// Katalog commerce (Fase 13F) — bentuk config node show_catalog
// ---------------------------------------------------------------------------

export interface CatalogConfig {
  /** Teks pembuka opsional (dirender seperti send_message). */
  introText: string | null;
  showDescription: boolean;
  timeoutMs: number;
  maxInvalidAttempts: number;
  invalidPrompt: string | null;
  /** Teks tambahan opsional sesudah ringkasan keranjang saat item ditambahkan. */
  addedMessage: string | null;
}

function parkTimeoutMsOf(c: Record<string, unknown>): number {
  const amount = typeof c.amount === "number" ? c.amount : NaN;
  const unitMs =
    c.unit === "seconds"
      ? 1_000
      : c.unit === "minutes"
        ? 60_000
        : c.unit === "hours"
          ? 3_600_000
          : NaN;
  return Number.isFinite(amount) && Number.isFinite(unitMs)
    ? Math.max(0, Math.floor(amount * unitMs))
    : 3_600_000;
}

/**
 * Membaca config node show_catalog menjadi bentuk kerja (DEFENSIF —
 * pola questionnaireConfigOf; keabsahan ditegakkan validasi aktivasi).
 */
export function catalogConfigOf(node: FlowGraphNode): CatalogConfig {
  const c = node.config;
  const attempts = c.maxInvalidAttempts;
  return {
    introText: isNonEmptyString(c.introText) ? c.introText : null,
    showDescription: c.showDescription === true,
    timeoutMs: parkTimeoutMsOf(c),
    maxInvalidAttempts:
      typeof attempts === "number" &&
      Number.isInteger(attempts) &&
      attempts >= 1 &&
      attempts <= 5
        ? attempts
        : 2,
    invalidPrompt: isNonEmptyString(c.invalidPrompt) ? c.invalidPrompt : null,
    addedMessage: isNonEmptyString(c.addedMessage) ? c.addedMessage : null,
  };
}

/** Membaca config node cart_checkout (Fase 13F) — DEFENSIF seperti di atas. */
export function cartCheckoutConfigOf(node: FlowGraphNode): {
  emptyMessage: string | null;
} {
  return {
    emptyMessage: isNonEmptyString(node.config.emptyMessage)
      ? node.config.emptyMessage
      : null,
  };
}

// ---------------------------------------------------------------------------
// Janji temu (Fase 13G) — bentuk config node book_appointment
// ---------------------------------------------------------------------------

export interface AppointmentNodeConfig {
  /** Layanan janji yang ditawarkan; null bila config rusak (validasi aktivasi menolak). */
  serviceId: string | null;
  /** Jendela penawaran: slot sampai sekarang + sekian hari (1..30). */
  daysAhead: number;
  /** Jumlah slot per daftar yang dikirim (1..10). */
  slotsPerMessage: number;
  timeoutMs: number;
  maxInvalidAttempts: number;
  invalidPrompt: string | null;
  /** Pesan tambahan opsional yang dikirim node tepat sesudah booking tercipta. */
  bookedMessage: string | null;
}

/**
 * Membaca config node book_appointment menjadi bentuk kerja (DEFENSIF —
 * pola catalogConfigOf; keabsahan ditegakkan validasi aktivasi).
 */
export function appointmentConfigOf(node: FlowGraphNode): AppointmentNodeConfig {
  const c = node.config;
  const attempts = c.maxInvalidAttempts;
  const days = c.daysAhead;
  const perMessage = c.slotsPerMessage;
  return {
    serviceId: isNonEmptyString(c.serviceId) ? c.serviceId : null,
    daysAhead:
      typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 30
        ? days
        : 7,
    slotsPerMessage:
      typeof perMessage === "number" &&
      Number.isInteger(perMessage) &&
      perMessage >= 1 &&
      perMessage <= 10
        ? perMessage
        : 5,
    timeoutMs: parkTimeoutMsOf(c),
    maxInvalidAttempts:
      typeof attempts === "number" &&
      Number.isInteger(attempts) &&
      attempts >= 1 &&
      attempts <= 5
        ? attempts
        : 2,
    invalidPrompt: isNonEmptyString(c.invalidPrompt) ? c.invalidPrompt : null,
    bookedMessage: isNonEmptyString(c.bookedMessage) ? c.bookedMessage : null,
  };
}

/**
 * Himpunan kunci custom_fields yang DIKENAL tenant = union kunci pada
 * custom_fields seluruh kontak tenant. Produk tidak memiliki registri
 * definisi field terpisah (set_field/segment/API v1 semuanya memakai
 * kunci bebas), jadi himpunan inilah "definisi" yang dirujuk kontrak
 * questionnaire. Dipakai validasi aktivasi + pemeriksaan runtime.
 */
export async function tenantCustomFieldKeys(
  tx: DbTx,
  tenantId: string,
): Promise<Set<string>> {
  const result = await tx.execute(sql`
    select distinct jsonb_object_keys(${contacts.customFields}) as key
    from ${contacts}
    where ${contacts.tenantId} = ${tenantId}
  `);
  // Driver pg membungkus hasil execute sebagai { rows } (pola outbox).
  const rows = (
    result as unknown as { rows: Array<{ key?: unknown }> }
  ).rows;
  const keys = new Set<string>();
  for (const row of rows) {
    if (typeof row.key === "string" && row.key) keys.add(row.key);
  }
  return keys;
}

/**
 * Validasi bentuk config satu node (tanpa konteks DB). Mengembalikan
 * daftar masalah; kosong = sah. Dipakai validasi aktivasi penuh.
 */
export function validateFlowNodeConfig(node: FlowGraphNode): FlowGraphIssue[] {
  const issues: FlowGraphIssue[] = [];
  const err = (code: string, message: string) =>
    issues.push({ code, severity: "error", nodeId: node.id, message });
  const c = node.config;
  switch (node.type) {
    case "trigger": {
      if (c.kind === "keyword") {
        if (
          !Array.isArray(c.keywords) ||
          c.keywords.length === 0 ||
          !c.keywords.every(isNonEmptyString)
        ) {
          err("TRIGGER_KEYWORDS_REQUIRED", "Trigger keyword membutuhkan minimal satu keyword non-kosong");
        }
        if (c.match !== "exact" && c.match !== "contains") {
          err("TRIGGER_MATCH_INVALID", "Trigger keyword membutuhkan match 'exact' atau 'contains'");
        }
      } else if (c.kind !== "any_message") {
        err("TRIGGER_KIND_INVALID", "Trigger membutuhkan kind 'keyword' atau 'any_message'");
      }
      break;
    }
    case "send_message":
      if (!isNonEmptyString(c.text)) {
        err("SEND_TEXT_REQUIRED", "Node send_message membutuhkan config.text non-kosong");
      }
      break;
    case "condition": {
      if (c.predicate === "has_tag") {
        if (!isNonEmptyString(c.tag)) err("CONDITION_TAG_REQUIRED", "Predikat has_tag membutuhkan config.tag");
      } else if (c.predicate === "stage_equals") {
        if (!isNonEmptyString(c.stage)) err("CONDITION_STAGE_REQUIRED", "Predikat stage_equals membutuhkan config.stage");
      } else if (c.predicate === "field_equals") {
        if (c.field !== "name" && c.field !== "phone" && c.field !== "email") {
          err("CONDITION_FIELD_INVALID", "Predikat field_equals membutuhkan field 'name'|'phone'|'email'");
        }
        if (!isNonEmptyString(c.value)) err("CONDITION_VALUE_REQUIRED", "Predikat field_equals membutuhkan config.value");
      } else if (c.predicate === "message_contains") {
        if (!isNonEmptyString(c.text)) err("CONDITION_TEXT_REQUIRED", "Predikat message_contains membutuhkan config.text");
      } else {
        err("CONDITION_PREDICATE_INVALID", "Node condition membutuhkan predicate yang dikenal");
      }
      break;
    }
    case "delay": {
      const amount = c.amount;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
        err("DELAY_AMOUNT_INVALID", "Node delay membutuhkan config.amount bilangan bulat ≥ 0");
      }
      if (c.unit !== "seconds" && c.unit !== "minutes" && c.unit !== "hours") {
        err("DELAY_UNIT_INVALID", "Node delay membutuhkan unit 'seconds'|'minutes'|'hours'");
      }
      // Smart Delay (Fase 9A): random opsional {min, max} dalam satuan
      // node yang sama — keduanya bilangan bulat positif, min ≤ max,
      // dalam batas yang sama seperti amount. Rentang rusak = error
      // aktivasi, bukan kejutan saat eksekusi.
      if (c.random !== undefined) {
        const r = c.random as { min?: unknown; max?: unknown } | null;
        const valid =
          typeof r === "object" &&
          r !== null &&
          typeof r.min === "number" &&
          Number.isInteger(r.min) &&
          typeof r.max === "number" &&
          Number.isInteger(r.max) &&
          r.min >= 1 &&
          r.max >= r.min &&
          r.max <= 100_000;
        if (!valid) {
          err(
            "DELAY_RANDOM_INVALID",
            "Smart Delay membutuhkan config.random {min, max} bilangan bulat dengan 1 ≤ min ≤ max",
          );
        }
      }
      break;
    }
    case "add_tag":
    case "remove_tag":
      if (!isNonEmptyString(c.tag)) err("TAG_REQUIRED", `Node ${node.type} membutuhkan config.tag`);
      break;
    case "set_stage":
      if (!isNonEmptyString(c.stage)) err("STAGE_REQUIRED", "Node set_stage membutuhkan config.stage");
      break;
    case "enroll_sequence":
      if (!isNonEmptyString(c.automationId)) {
        err("SEQUENCE_ID_REQUIRED", "Node enroll_sequence membutuhkan config.automationId");
      }
      break;
    case "set_field": {
      const field = c.field;
      const customKey =
        typeof field === "string" && field.startsWith("custom:")
          ? field.slice("custom:".length)
          : null;
      const fieldOk =
        field === "name" ||
        field === "phone" ||
        field === "email" ||
        (customKey !== null &&
          customKey.trim().length > 0 &&
          (field as string).length <= 128);
      if (!fieldOk) {
        err(
          "SET_FIELD_FIELD_INVALID",
          "Node set_field membutuhkan field 'name'|'phone'|'email'|'custom:<key>'",
        );
      }
      if (typeof c.value !== "string") {
        err(
          "SET_FIELD_VALUE_INVALID",
          "Node set_field membutuhkan config.value string (boleh kosong — membersihkan field)",
        );
      }
      break;
    }
    case "http_request": {
      if (
        c.method !== "GET" &&
        c.method !== "POST" &&
        c.method !== "PUT" &&
        c.method !== "PATCH" &&
        c.method !== "DELETE"
      ) {
        err(
          "HTTP_METHOD_INVALID",
          "Node http_request membutuhkan method GET|POST|PUT|PATCH|DELETE",
        );
      }
      if (!isNonEmptyString(c.url) || !/^https?:\/\//i.test(c.url)) {
        err(
          "HTTP_URL_INVALID",
          "Node http_request membutuhkan config.url http(s) non-kosong",
        );
      }
      if (c.headers !== undefined) {
        const h = c.headers;
        const headersOk =
          typeof h === "object" &&
          h !== null &&
          !Array.isArray(h) &&
          Object.values(h as Record<string, unknown>).every(
            (v) => typeof v === "string",
          );
        if (!headersOk) {
          err(
            "HTTP_HEADERS_INVALID",
            "Node http_request membutuhkan config.headers objek nama→string",
          );
        }
      }
      if (c.body !== undefined && typeof c.body !== "string") {
        err("HTTP_BODY_INVALID", "Node http_request membutuhkan config.body string");
      }
      if (c.saveToField !== undefined) {
        const f = c.saveToField;
        const ok =
          typeof f === "string" &&
          f.startsWith("custom:") &&
          f.slice("custom:".length).trim().length > 0;
        if (!ok) {
          err(
            "HTTP_SAVE_FIELD_INVALID",
            "Node http_request membutuhkan saveToField 'custom:<key>'",
          );
        }
      }
      break;
    }
    case "goto_flow":
      if (!isNonEmptyString(c.flowId)) {
        err("GOTO_FLOW_ID_REQUIRED", "Node goto_flow membutuhkan config.flowId");
      }
      break;
    case "ab_split": {
      const p = c.percentA;
      if (
        typeof p !== "number" ||
        !Number.isInteger(p) ||
        p < 1 ||
        p > 99
      ) {
        err(
          "AB_PERCENT_INVALID",
          "Node ab_split membutuhkan config.percentA bilangan bulat 1..99",
        );
      }
      // Fase 13D — mode eksperimen: flag harus boolean bila diisi;
      // label string pendek; conversionNodeId string id node (rujukan
      // ke node yang ADA di graf yang sama diperiksa validateFlowGraph
      // yang punya konteks graf utuh).
      if (c.experiment !== undefined && typeof c.experiment !== "boolean") {
        err(
          "AB_EXPERIMENT_INVALID",
          "Node ab_split membutuhkan config.experiment boolean bila diisi",
        );
      }
      if (
        c.experimentLabel !== undefined &&
        (typeof c.experimentLabel !== "string" ||
          c.experimentLabel.length > 128)
      ) {
        err(
          "AB_EXPERIMENT_LABEL_INVALID",
          "Label eksperimen ab_split harus string ≤ 128 karakter",
        );
      }
      if (
        c.conversionNodeId !== undefined &&
        !isNonEmptyString(c.conversionNodeId)
      ) {
        err(
          "AB_CONVERSION_NODE_INVALID",
          "Node ab_split membutuhkan config.conversionNodeId id node non-kosong bila diisi",
        );
      }
      break;
    }
    case "send_payment_link":
      if (!isNonEmptyString(c.productId)) {
        err(
          "PAYMENT_PRODUCT_ID_REQUIRED",
          "Node send_payment_link membutuhkan config.productId",
        );
      }
      break;
    case "wait_reply": {
      const amount = c.amount;
      if (
        typeof amount !== "number" ||
        !Number.isInteger(amount) ||
        amount < 0
      ) {
        err(
          "WAIT_AMOUNT_INVALID",
          "Node wait_reply membutuhkan config.amount bilangan bulat ≥ 0",
        );
      }
      if (c.unit !== "seconds" && c.unit !== "minutes" && c.unit !== "hours") {
        err(
          "WAIT_UNIT_INVALID",
          "Node wait_reply membutuhkan unit 'seconds'|'minutes'|'hours'",
        );
      }
      break;
    }
    case "questionnaire": {
      const rawQuestions = c.questions;
      if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        err(
          "QUESTIONNAIRE_QUESTIONS_REQUIRED",
          "Node questionnaire membutuhkan minimal satu pertanyaan",
        );
      } else if (rawQuestions.length > 20) {
        err(
          "QUESTIONNAIRE_QUESTIONS_REQUIRED",
          "Node questionnaire maksimal 20 pertanyaan",
        );
      } else {
        const seenIds = new Set<string>();
        rawQuestions.forEach((raw, idx) => {
          const q = (
            typeof raw === "object" && raw !== null ? raw : {}
          ) as Record<string, unknown>;
          const label = `pertanyaan #${idx + 1}`;
          if (!isNonEmptyString(q.id) || q.id.length > 64) {
            err(
              "QUESTIONNAIRE_QUESTION_ID_INVALID",
              `Node questionnaire: ${label} membutuhkan id non-kosong ≤ 64 karakter`,
            );
          } else if (seenIds.has(q.id)) {
            err(
              "QUESTIONNAIRE_QUESTION_ID_INVALID",
              `Node questionnaire: id pertanyaan ganda: ${q.id}`,
            );
          } else {
            seenIds.add(q.id);
          }
          if (!isNonEmptyString(q.prompt) || q.prompt.length > 1000) {
            err(
              "QUESTIONNAIRE_PROMPT_REQUIRED",
              `Node questionnaire: ${label} membutuhkan prompt non-kosong ≤ 1000 karakter`,
            );
          }
          if (
            typeof q.answerType !== "string" ||
            !QUESTIONNAIRE_ANSWER_TYPES.includes(q.answerType)
          ) {
            err(
              "QUESTIONNAIRE_ANSWER_TYPE_INVALID",
              `Node questionnaire: ${label} membutuhkan answerType text|number|email|phone|choice`,
            );
          }
          if (!isQuestionnaireTarget(q.target)) {
            err(
              "QUESTIONNAIRE_TARGET_INVALID",
              `Node questionnaire: ${label} membutuhkan target 'name'|'email'|'phone'|'custom:<key>'`,
            );
          }
          if (q.required !== undefined && typeof q.required !== "boolean") {
            err(
              "QUESTIONNAIRE_REQUIRED_INVALID",
              `Node questionnaire: ${label} membutuhkan required boolean bila diisi`,
            );
          }
          if (q.answerType === "choice") {
            const options = q.options;
            if (
              !Array.isArray(options) ||
              options.length < 2 ||
              options.length > 10 ||
              !options.every(
                (o) => isNonEmptyString(o) && o.length <= 200,
              )
            ) {
              err(
                "QUESTIONNAIRE_OPTIONS_REQUIRED",
                `Node questionnaire: ${label} choice membutuhkan 2..10 opsi non-kosong`,
              );
            }
          }
        });
      }
      const amount = c.amount;
      if (
        typeof amount !== "number" ||
        !Number.isInteger(amount) ||
        amount < 0
      ) {
        err(
          "QUESTIONNAIRE_AMOUNT_INVALID",
          "Node questionnaire membutuhkan config.amount (tenggat per pertanyaan) bilangan bulat ≥ 0",
        );
      }
      if (c.unit !== "seconds" && c.unit !== "minutes" && c.unit !== "hours") {
        err(
          "QUESTIONNAIRE_UNIT_INVALID",
          "Node questionnaire membutuhkan unit 'seconds'|'minutes'|'hours'",
        );
      }
      const attempts = c.maxInvalidAttempts;
      if (
        typeof attempts !== "number" ||
        !Number.isInteger(attempts) ||
        attempts < 1 ||
        attempts > 5
      ) {
        err(
          "QUESTIONNAIRE_ATTEMPTS_INVALID",
          "Node questionnaire membutuhkan config.maxInvalidAttempts bilangan bulat 1..5",
        );
      }
      if (
        c.invalidPrompt !== undefined &&
        (!isNonEmptyString(c.invalidPrompt) || c.invalidPrompt.length > 1000)
      ) {
        err(
          "QUESTIONNAIRE_INVALID_PROMPT_INVALID",
          "Node questionnaire membutuhkan invalidPrompt string non-kosong ≤ 1000 karakter bila diisi",
        );
      }
      if (
        c.completionTag !== undefined &&
        (!isNonEmptyString(c.completionTag) || c.completionTag.length > 64)
      ) {
        err(
          "QUESTIONNAIRE_TAG_INVALID",
          "Node questionnaire membutuhkan completionTag string non-kosong ≤ 64 karakter bila diisi",
        );
      }
      break;
    }
    case "show_catalog": {
      if (
        c.introText !== undefined &&
        (!isNonEmptyString(c.introText) || c.introText.length > 1000)
      ) {
        err(
          "CATALOG_INTRO_INVALID",
          "Node show_catalog membutuhkan introText string non-kosong ≤ 1000 karakter bila diisi",
        );
      }
      if (c.showDescription !== undefined && typeof c.showDescription !== "boolean") {
        err(
          "CATALOG_SHOW_DESCRIPTION_INVALID",
          "Node show_catalog membutuhkan showDescription boolean bila diisi",
        );
      }
      const amount = c.amount;
      if (
        typeof amount !== "number" ||
        !Number.isInteger(amount) ||
        amount < 0
      ) {
        err(
          "CATALOG_AMOUNT_INVALID",
          "Node show_catalog membutuhkan config.amount (tenggat per parkir) bilangan bulat ≥ 0",
        );
      }
      if (c.unit !== "seconds" && c.unit !== "minutes" && c.unit !== "hours") {
        err(
          "CATALOG_UNIT_INVALID",
          "Node show_catalog membutuhkan unit 'seconds'|'minutes'|'hours'",
        );
      }
      const attempts = c.maxInvalidAttempts;
      if (
        typeof attempts !== "number" ||
        !Number.isInteger(attempts) ||
        attempts < 1 ||
        attempts > 5
      ) {
        err(
          "CATALOG_ATTEMPTS_INVALID",
          "Node show_catalog membutuhkan config.maxInvalidAttempts bilangan bulat 1..5",
        );
      }
      if (
        c.invalidPrompt !== undefined &&
        (!isNonEmptyString(c.invalidPrompt) || c.invalidPrompt.length > 1000)
      ) {
        err(
          "CATALOG_INVALID_PROMPT_INVALID",
          "Node show_catalog membutuhkan invalidPrompt string non-kosong ≤ 1000 karakter bila diisi",
        );
      }
      if (
        c.addedMessage !== undefined &&
        (!isNonEmptyString(c.addedMessage) || c.addedMessage.length > 1000)
      ) {
        err(
          "CATALOG_ADDED_MESSAGE_INVALID",
          "Node show_catalog membutuhkan addedMessage string non-kosong ≤ 1000 karakter bila diisi",
        );
      }
      break;
    }
    case "cart_checkout": {
      if (
        c.emptyMessage !== undefined &&
        (!isNonEmptyString(c.emptyMessage) || c.emptyMessage.length > 1000)
      ) {
        err(
          "CHECKOUT_EMPTY_MESSAGE_INVALID",
          "Node cart_checkout membutuhkan emptyMessage string non-kosong ≤ 1000 karakter bila diisi",
        );
      }
      break;
    }
    case "book_appointment": {
      if (!isNonEmptyString(c.serviceId) || !isUuidLike(c.serviceId)) {
        err(
          "APPOINTMENT_SERVICE_INVALID",
          "Node book_appointment membutuhkan config.serviceId UUID layanan janji",
        );
      }
      const days = c.daysAhead;
      if (
        typeof days !== "number" ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > 30
      ) {
        err(
          "APPOINTMENT_DAYS_AHEAD_INVALID",
          "Node book_appointment membutuhkan config.daysAhead bilangan bulat 1..30",
        );
      }
      const perMessage = c.slotsPerMessage;
      if (
        typeof perMessage !== "number" ||
        !Number.isInteger(perMessage) ||
        perMessage < 1 ||
        perMessage > 10
      ) {
        err(
          "APPOINTMENT_SLOTS_PER_MESSAGE_INVALID",
          "Node book_appointment membutuhkan config.slotsPerMessage bilangan bulat 1..10",
        );
      }
      const amount = c.amount;
      if (
        typeof amount !== "number" ||
        !Number.isInteger(amount) ||
        amount < 0
      ) {
        err(
          "APPOINTMENT_AMOUNT_INVALID",
          "Node book_appointment membutuhkan config.amount (tenggat per parkir) bilangan bulat ≥ 0",
        );
      }
      if (c.unit !== "seconds" && c.unit !== "minutes" && c.unit !== "hours") {
        err(
          "APPOINTMENT_UNIT_INVALID",
          "Node book_appointment membutuhkan unit 'seconds'|'minutes'|'hours'",
        );
      }
      const attempts = c.maxInvalidAttempts;
      if (
        typeof attempts !== "number" ||
        !Number.isInteger(attempts) ||
        attempts < 1 ||
        attempts > 5
      ) {
        err(
          "APPOINTMENT_ATTEMPTS_INVALID",
          "Node book_appointment membutuhkan config.maxInvalidAttempts bilangan bulat 1..5",
        );
      }
      if (
        c.invalidPrompt !== undefined &&
        (!isNonEmptyString(c.invalidPrompt) || c.invalidPrompt.length > 1000)
      ) {
        err(
          "APPOINTMENT_INVALID_PROMPT_INVALID",
          "Node book_appointment membutuhkan invalidPrompt string non-kosong ≤ 1000 karakter bila diisi",
        );
      }
      if (
        c.bookedMessage !== undefined &&
        (!isNonEmptyString(c.bookedMessage) || c.bookedMessage.length > 1000)
      ) {
        err(
          "APPOINTMENT_BOOKED_MESSAGE_INVALID",
          "Node book_appointment membutuhkan bookedMessage string non-kosong ≤ 1000 karakter bila diisi",
        );
      }
      break;
    }
    case "ai_response":
    case "handoff":
    case "end":
      break;
    default:
      err("NODE_TYPE_UNKNOWN", `Tipe node tidak dikenal: ${node.type}`);
  }
  return issues;
}

/**
 * Validasi graf MENYELURUH untuk aktivasi. ERROR memblokir aktivasi;
 * WARNING (node tak terjangkau dari trigger) tidak memblokir tetapi
 * selalu dikembalikan agar pemanggil bisa menampilkannya.
 * Pemeriksaan referensi sequence butuh DB: automationId harus menunjuk
 * automation kind='sequence' yang AKTIF milik tenant yang sama.
 */
export async function validateFlowGraph(
  db: Database,
  tenantId: string,
  graph: FlowGraphData,
  options: {
    /**
     * Id flow yang sedang divalidasi (saat aktivasi/endpoint validate).
     * Node goto_flow yang menunjuk flow ITU SENDIRI sah: pada saat
     * aktivasi berhasil flow menjadi active, jadi targetnya terpenuhi.
     */
    selfFlowId?: string;
  } = {},
): Promise<FlowGraphIssue[]> {
  const issues: FlowGraphIssue[] = [];
  const err = (code: string, nodeId: string | null, message: string) =>
    issues.push({ code, severity: "error", nodeId, message });
  const warn = (code: string, nodeId: string | null, message: string) =>
    issues.push({ code, severity: "warning", nodeId, message });

  if (graph.nodes.length === 0) {
    err("GRAPH_EMPTY", null, "Graf tidak memiliki node apa pun");
    return issues;
  }
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      err("NODE_ID_DUPLICATE", node.id, `Id node ganda: ${node.id}`);
    }
    ids.add(node.id);
    if (!NODE_TYPES.has(node.type)) {
      err("NODE_TYPE_UNKNOWN", node.id, `Tipe node tidak dikenal: ${node.type}`);
    }
  }
  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (triggers.length === 0) {
    err("TRIGGER_MISSING", null, "Graf membutuhkan tepat satu node trigger");
  } else if (triggers.length > 1) {
    for (const t of triggers.slice(1)) {
      err("TRIGGER_MULTIPLE", t.id, "Graf memiliki lebih dari satu node trigger");
    }
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) {
      err("EDGE_FROM_UNKNOWN", null, `Edge berasal dari node yang tidak ada: ${edge.from}`);
    }
    if (!ids.has(edge.to)) {
      err("EDGE_TO_UNKNOWN", edge.from, `Edge menuju node yang tidak ada: ${edge.to}`);
    }
  }
  // Aturan branch per tipe node bercabang (Fase 12A menggeneralisasi
  // aturan condition 8A): himpunan branch wajib lengkap, branch di
  // luar himpunan = EDGE_BRANCH_MISPLACED, dan node non-bercabang
  // tidak boleh membawa branch sama sekali.
  const BRANCH_RULES: Record<
    string,
    { required: { branch: FlowBranch; code: string; label: string }[] }
  > = {
    condition: {
      required: [
        { branch: "yes", code: "CONDITION_BRANCH_YES_MISSING", label: "Node condition membutuhkan edge branch 'yes'" },
        { branch: "no", code: "CONDITION_BRANCH_NO_MISSING", label: "Node condition membutuhkan edge branch 'no'" },
      ],
    },
    ab_split: {
      required: [
        { branch: "a", code: "AB_BRANCH_A_MISSING", label: "Node ab_split membutuhkan edge branch 'a'" },
        { branch: "b", code: "AB_BRANCH_B_MISSING", label: "Node ab_split membutuhkan edge branch 'b'" },
      ],
    },
    wait_reply: {
      required: [
        { branch: "replied", code: "WAIT_BRANCH_REPLIED_MISSING", label: "Node wait_reply membutuhkan edge branch 'replied'" },
        { branch: "timeout", code: "WAIT_BRANCH_TIMEOUT_MISSING", label: "Node wait_reply membutuhkan edge branch 'timeout'" },
      ],
    },
    questionnaire: {
      required: [
        { branch: "completed", code: "QUESTIONNAIRE_BRANCH_COMPLETED_MISSING", label: "Node questionnaire membutuhkan edge branch 'completed'" },
        { branch: "invalid", code: "QUESTIONNAIRE_BRANCH_INVALID_MISSING", label: "Node questionnaire membutuhkan edge branch 'invalid'" },
        { branch: "timeout", code: "QUESTIONNAIRE_BRANCH_TIMEOUT_MISSING", label: "Node questionnaire membutuhkan edge branch 'timeout'" },
      ],
    },
    show_catalog: {
      required: [
        { branch: "added", code: "CATALOG_BRANCH_ADDED_MISSING", label: "Node show_catalog membutuhkan edge branch 'added'" },
        { branch: "invalid", code: "CATALOG_BRANCH_INVALID_MISSING", label: "Node show_catalog membutuhkan edge branch 'invalid'" },
        { branch: "timeout", code: "CATALOG_BRANCH_TIMEOUT_MISSING", label: "Node show_catalog membutuhkan edge branch 'timeout'" },
      ],
    },
    cart_checkout: {
      required: [
        { branch: "checked_out", code: "CHECKOUT_BRANCH_CHECKED_OUT_MISSING", label: "Node cart_checkout membutuhkan edge branch 'checked_out'" },
        { branch: "empty_cart", code: "CHECKOUT_BRANCH_EMPTY_CART_MISSING", label: "Node cart_checkout membutuhkan edge branch 'empty_cart'" },
      ],
    },
    book_appointment: {
      required: [
        { branch: "booked", code: "APPOINTMENT_BRANCH_BOOKED_MISSING", label: "Node book_appointment membutuhkan edge branch 'booked'" },
        { branch: "invalid", code: "APPOINTMENT_BRANCH_INVALID_MISSING", label: "Node book_appointment membutuhkan edge branch 'invalid'" },
        { branch: "timeout", code: "APPOINTMENT_BRANCH_TIMEOUT_MISSING", label: "Node book_appointment membutuhkan edge branch 'timeout'" },
        { branch: "slot_taken", code: "APPOINTMENT_BRANCH_SLOT_TAKEN_MISSING", label: "Node book_appointment membutuhkan edge branch 'slot_taken'" },
      ],
    },
  };
  for (const node of graph.nodes) {
    issues.push(...validateFlowNodeConfig(node));
    const out = graph.edges.filter((e) => e.from === node.id);
    const rule = BRANCH_RULES[node.type];
    if (rule) {
      const allowed = new Set(rule.required.map((r) => r.branch));
      for (const req of rule.required) {
        if (!out.some((e) => e.branch === req.branch)) {
          err(req.code, node.id, req.label);
        }
      }
      for (const e of out) {
        if (e.branch === undefined || !allowed.has(e.branch)) {
          err(
            "EDGE_BRANCH_MISPLACED",
            node.id,
            `Branch edge keluar node ${node.type} harus salah satu dari: ${[...allowed].join(", ")}`,
          );
        }
      }
    } else {
      for (const e of out) {
        if (e.branch !== undefined) {
          err("EDGE_BRANCH_MISPLACED", node.id, "Branch hanya sah pada edge keluar node condition, ab_split, wait_reply, questionnaire, show_catalog, cart_checkout, atau book_appointment");
        }
      }
    }
    if (node.type === "trigger" && out.length === 0) {
      warn("TRIGGER_NO_NEXT", node.id, "Trigger tidak punya node lanjutan — run akan langsung selesai");
    }
  }

  // Fase 13D: titik konversi eksperimen ab_split harus menunjuk node
  // LAIN yang ada di graf yang sama (menunjuk diri sendiri = konversi
  // selalu/ tak pernah bermakna — ditolak di sini, bukan ditebak).
  for (const node of graph.nodes) {
    if (node.type !== "ab_split" || node.config.experiment !== true) {
      continue;
    }
    const conv = node.config.conversionNodeId;
    if (conv === undefined) continue;
    if (
      typeof conv !== "string" ||
      conv === node.id ||
      !ids.has(conv)
    ) {
      err(
        "AB_CONVERSION_NODE_INVALID",
        node.id,
        "Titik konversi eksperimen ab_split harus menunjuk node lain yang ada di graf ini",
      );
    }
  }

  // Referensi sequence (butuh DB, konteks tenant).
  const sequenceRefs = graph.nodes.filter(
    (n) => n.type === "enroll_sequence" && isNonEmptyString(n.config.automationId),
  );
  if (sequenceRefs.length > 0) {
    await withTenantDb(db, tenantId, async (tx) => {
      for (const node of sequenceRefs) {
        const automationId = node.config.automationId as string;
        const [target] = await tx
          .select({
            id: automations.id,
            kind: automations.kind,
            isActive: automations.isActive,
          })
          .from(automations)
          .where(
            and(
              eq(automations.tenantId, tenantId),
              eq(automations.id, automationId),
            ),
          )
          .limit(1);
        if (!target) {
          err("SEQUENCE_NOT_FOUND", node.id, "Sequence rujukan tidak ada di workspace ini");
        } else if (target.kind !== "sequence") {
          err("SEQUENCE_WRONG_KIND", node.id, "Automation rujukan bukan sequence");
        } else if (!target.isActive) {
          err("SEQUENCE_INACTIVE", node.id, "Sequence rujukan tidak aktif");
        }
      }
    });
  }

  // Referensi goto_flow & send_payment_link (Fase 12A, butuh DB):
  // flow tujuan harus ada di tenant yang sama dan ACTIVE (flow itu
  // sendiri dikecualikan — aktivasi membuatnya active); produk harus
  // ada dan tidak diarsipkan (is_active).
  const gotoRefs = graph.nodes.filter(
    (n) => n.type === "goto_flow" && isNonEmptyString(n.config.flowId),
  );
  const productRefs = graph.nodes.filter(
    (n) => n.type === "send_payment_link" && isNonEmptyString(n.config.productId),
  );
  if (gotoRefs.length > 0 || productRefs.length > 0) {
    await withTenantDb(db, tenantId, async (tx) => {
      for (const node of gotoRefs) {
        const flowId = node.config.flowId as string;
        if (options.selfFlowId && flowId === options.selfFlowId) continue;
        if (!isUuidLike(flowId)) {
          err("GOTO_FLOW_NOT_FOUND", node.id, "Flow tujuan goto tidak ada di workspace ini");
          continue;
        }
        const [target] = await tx
          .select({ id: flows.id, status: flows.status })
          .from(flows)
          .where(and(eq(flows.tenantId, tenantId), eq(flows.id, flowId)))
          .limit(1);
        if (!target) {
          err("GOTO_FLOW_NOT_FOUND", node.id, "Flow tujuan goto tidak ada di workspace ini");
        } else if (target.status !== "active") {
          err("GOTO_FLOW_INACTIVE", node.id, "Flow tujuan goto harus berstatus aktif");
        }
      }
      for (const node of productRefs) {
        const productId = node.config.productId as string;
        if (!isUuidLike(productId)) {
          err("PAYMENT_PRODUCT_NOT_FOUND", node.id, "Produk rujukan tidak ada di workspace ini");
          continue;
        }
        const [target] = await tx
          .select({ id: products.id, isActive: products.isActive })
          .from(products)
          .where(
            and(eq(products.tenantId, tenantId), eq(products.id, productId)),
          )
          .limit(1);
        if (!target) {
          err("PAYMENT_PRODUCT_NOT_FOUND", node.id, "Produk rujukan tidak ada di workspace ini");
        } else if (!target.isActive) {
          err("PAYMENT_PRODUCT_INACTIVE", node.id, "Produk rujukan tidak aktif (diarsipkan)");
        }
      }
    });
  }

  // Fase 13E: target custom questionnaire harus kunci yang DIKENAL
  // tenant (dibawa ≥ 1 kontak) — "definisi" field custom produk ini
  // adalah himpunan kunci pada kontak (lihat tenantCustomFieldKeys).
  // Target yang tidak dikenal hampir pasti salah ketik yang akan
  // menulis kunci sampah selamanya, jadi ditolak saat aktivasi.
  const questionnaireNodes = graph.nodes.filter(
    (n) => n.type === "questionnaire",
  );
  if (questionnaireNodes.length > 0) {
    await withTenantDb(db, tenantId, async (tx) => {
      const knownKeys = await tenantCustomFieldKeys(tx, tenantId);
      for (const node of questionnaireNodes) {
        const config = questionnaireConfigOf(node);
        for (const question of config.questions) {
          const key = questionnaireTargetKey(question.target);
          if (key !== null && !knownKeys.has(key)) {
            err(
              "QUESTIONNAIRE_TARGET_UNKNOWN",
              node.id,
              `Target custom '${key}' untuk pertanyaan '${question.id}' belum dikenal workspace ini (belum ada kontak yang membawa field itu)`,
            );
          }
        }
      }
    });
  }

  // Keterjangkauan dari trigger → warning saja.
  const trigger = triggers[0];
  if (trigger) {
    const reachable = new Set<string>([trigger.id]);
    const queue = [trigger.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const e of graph.edges.filter((x) => x.from === current)) {
        if (!reachable.has(e.to)) {
          reachable.add(e.to);
          queue.push(e.to);
        }
      }
    }
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) {
        warn("NODE_UNREACHABLE", node.id, `Node tidak terjangkau dari trigger: ${node.id}`);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Util kursor (pola broadcasts 7C — base64url {createdAt, id})
// ---------------------------------------------------------------------------

interface PageCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  const raw: PageCursor = { createdAt: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(raw), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): PageCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<PageCursor>;
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Kursor rusak → halaman pertama (pola terdokumentasi).
  }
  return null;
}

function clampLimit(limit: number | undefined, fallback = 50, max = 100): number {
  if (!limit || Number.isNaN(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function cursorCondition(
  cursor: PageCursor | null,
  createdAtCol: unknown,
  idCol: unknown,
) {
  if (!cursor) return undefined;
  // Kolom (created_at, id) dari tabel mana pun (flows / flow_runs) —
  // bentuk kursornya identik; casting lokal agar helper bisa dipakai
  // ulang tanpa duplikasi.
  const createdAt = createdAtCol as typeof flows.createdAt;
  const id = idCol as typeof flows.id;
  const cursorDate = new Date(cursor.createdAt);
  return or(
    lt(createdAt, cursorDate),
    and(eq(createdAt, cursorDate), lt(id, cursor.id)),
  );
}

// ---------------------------------------------------------------------------
// Manajemen flow (sisi API)
// ---------------------------------------------------------------------------

export type FlowWithRunCount = Flow & { runCount: number };

async function flowAudit(
  tx: DbTx,
  tenantId: string,
  input: {
    actorType: "user" | "system";
    actorId: string;
    action: string;
    flowId: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    meta: { flowId: input.flowId, ...(input.meta ?? {}) },
  });
}

/**
 * Fase 13D: audit nyala/mati mode eksperimen per node ab_split —
 * bandingkan flag `experiment` per id node antara graf lama (null =
 * belum ada) dan graf baru; setiap perubahan arah menulis satu baris
 * `flow.experiment_enabled` / `flow.experiment_disabled`. Perubahan
 * persen/label saja tidak diaudit di sini (tercakup flow.updated).
 */
async function auditExperimentToggles(
  tx: DbTx,
  tenantId: string,
  input: {
    userId: string;
    flowId: string;
    oldGraph: FlowGraphData | null;
    newGraph: FlowGraphData;
  },
): Promise<void> {
  const oldSplits = new Map(
    (input.oldGraph?.nodes ?? [])
      .filter((n) => n.type === "ab_split")
      .map((n) => [n.id, n.config.experiment === true] as const),
  );
  for (const node of input.newGraph.nodes) {
    if (node.type !== "ab_split") continue;
    const was = oldSplits.get(node.id) ?? false;
    const is = node.config.experiment === true;
    if (was === is) continue;
    await flowAudit(tx, tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: is ? "flow.experiment_enabled" : "flow.experiment_disabled",
      flowId: input.flowId,
      meta: {
        nodeId: node.id,
        label:
          typeof node.config.experimentLabel === "string"
            ? node.config.experimentLabel
            : null,
        percentA:
          typeof node.config.percentA === "number"
            ? node.config.percentA
            : null,
      },
    });
  }
}

export async function createFlow(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    name: string;
    graph?: FlowGraphData;
  },
): Promise<{ kind: "created"; flow: FlowWithRunCount }> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(flows)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        status: "draft",
        graph: input.graph ?? { nodes: [], edges: [] },
        createdByUserId: input.userId,
      })
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.created",
      flowId: row.id,
      meta: { name: row.name },
    });
    if (input.graph) {
      await auditExperimentToggles(tx, input.tenantId, {
        userId: input.userId,
        flowId: row.id,
        oldGraph: null,
        newGraph: input.graph,
      });
    }
    return { kind: "created" as const, flow: { ...row, runCount: 0 } };
  });
}

export type InstantiateFlowTemplateResult =
  | { kind: "created"; flow: FlowWithRunCount }
  | { kind: "template_not_found" };

/**
 * Membuat flow DRAFT dari template katalog (Fase 12B — definisi
 * template hidup di kontrak, `FLOW_TEMPLATES`). Graf template disalin
 * DALAM (JSON round-trip: definisi statis tidak boleh berubah karena
 * flow hasil instantiate diedit) dan id setiap node diregenerasi
 * dengan pola id acak core (`n_<base64url>`) agar dua hasil
 * instantiate dari template yang sama tidak pernah berbagi id node —
 * rujukan silang seperti goto_flow selalu menunjuk flow, bukan node,
 * jadi regenerasi aman. Nama bawaan = `input.name` atau
 * `template.defaultName`. Audit: `flow.created` (konsisten buat
 * manual) + `flow.template_instantiated` bermeta slug.
 */
export async function instantiateFlowTemplate(
  db: Database,
  input: { tenantId: string; userId: string; slug: string; name?: string },
): Promise<InstantiateFlowTemplateResult> {
  const template = findFlowTemplate(input.slug);
  if (!template) return { kind: "template_not_found" as const };
  const idMap = new Map<string, string>();
  for (const node of template.graph.nodes) {
    idMap.set(node.id, `n_${randomBytes(9).toString("base64url")}`);
  }
  const copy = JSON.parse(JSON.stringify(template.graph)) as {
    nodes: FlowGraphNode[];
    edges: FlowGraphEdge[];
  };
  const graph: FlowGraphData = {
    nodes: copy.nodes.map((n) => ({
      ...n,
      id: idMap.get(n.id) ?? n.id,
    })),
    edges: copy.edges.map((e) => ({
      ...e,
      from: idMap.get(e.from) ?? e.from,
      to: idMap.get(e.to) ?? e.to,
    })),
  };
  const name = input.name?.trim() ? input.name.trim() : template.defaultName;
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(flows)
      .values({
        tenantId: input.tenantId,
        name,
        status: "draft",
        graph,
        createdByUserId: input.userId,
      })
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.created",
      flowId: row.id,
      meta: { name: row.name },
    });
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.template_instantiated",
      flowId: row.id,
      meta: { templateSlug: template.slug, name: row.name },
    });
    return {
      kind: "created" as const,
      flow: { ...row, runCount: 0 },
    };
  });
}

export async function listFlows(
  db: Database,
  input: {
    tenantId: string;
    status?: FlowStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<{ flows: FlowWithRunCount[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  return withTenantDb(db, input.tenantId, async (tx) => {
    const conditions = [eq(flows.tenantId, input.tenantId)];
    if (input.status) conditions.push(eq(flows.status, input.status));
    const cc = cursorCondition(decodeCursor(input.cursor), flows.createdAt, flows.id);
    if (cc) conditions.push(cc);
    const rows = await tx
      .select({
        flow: flows,
        runCount: sql<number>`count(${flowRuns.id})::int`,
      })
      .from(flows)
      .leftJoin(flowRuns, eq(flowRuns.flowId, flows.id))
      .where(and(...conditions))
      .groupBy(flows.id)
      .orderBy(desc(flows.createdAt), desc(flows.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      flows: page.map((r) => ({ ...r.flow, runCount: r.runCount })),
      nextCursor: hasMore
        ? encodeCursor(page[page.length - 1].flow)
        : null,
    };
  });
}

/** Null bila flow tidak ada DI tenant ini. */
export async function getFlow(
  db: Database,
  input: { tenantId: string; flowId: string },
): Promise<FlowWithRunCount | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        flow: flows,
        runCount: sql<number>`count(${flowRuns.id})::int`,
      })
      .from(flows)
      .leftJoin(flowRuns, eq(flowRuns.flowId, flows.id))
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .groupBy(flows.id)
      .limit(1);
    return row ? { ...row.flow, runCount: row.runCount } : null;
  });
}

export type UpdateFlowResult =
  | { kind: "updated"; flow: Flow }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: FlowStatus };

/** Edit nama/graf — hanya saat draft (graf flow aktif tidak boleh berubah di bawah run hidup). */
export async function updateFlow(
  db: Database,
  input: {
    tenantId: string;
    flowId: string;
    userId: string;
    patch: { name?: string; graph?: FlowGraphData };
  },
): Promise<UpdateFlowResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "draft") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const patch: Partial<Flow> = { updatedAt: new Date() };
    if (input.patch.name !== undefined) patch.name = input.patch.name;
    if (input.patch.graph !== undefined) patch.graph = input.patch.graph;
    const [row] = await tx
      .update(flows)
      .set(patch)
      .where(eq(flows.id, input.flowId))
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.updated",
      flowId: row.id,
      meta: {
        name: input.patch.name !== undefined,
        graph: input.patch.graph !== undefined,
      },
    });
    // Fase 13D: nyala/mati mode eksperimen per node ab_split diaudit
    // tersendiri (mengubah cara kontak ditugaskan) — lihat
    // auditExperimentToggles.
    if (input.patch.graph !== undefined) {
      await auditExperimentToggles(tx, input.tenantId, {
        userId: input.userId,
        flowId: row.id,
        oldGraph: normalizeFlowGraph(existing.graph),
        newGraph: input.patch.graph,
      });
    }
    return { kind: "updated" as const, flow: row };
  });
}

export type ActivateFlowResult =
  | { kind: "activated"; flow: Flow; warnings: FlowGraphIssue[] }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: FlowStatus }
  | { kind: "invalid"; issues: FlowGraphIssue[] };

/**
 * Aktivasi: validasi graf menyeluruh dulu (di luar transaksi tulis).
 * Ada ERROR → ditolak utuh dengan daftar masalah; WARNING diteruskan
 * ke pemanggil bersama hasil sukses.
 */
export async function activateFlow(
  db: Database,
  input: { tenantId: string; flowId: string; userId: string },
): Promise<ActivateFlowResult> {
  const existing = await getFlow(db, input);
  if (!existing) return { kind: "not_found" };
  if (existing.status !== "draft") {
    return { kind: "invalid_state", status: existing.status };
  }
  const graph = normalizeFlowGraph(existing.graph);
  const issues = await validateFlowGraph(db, input.tenantId, graph, {
    selfFlowId: input.flowId,
  });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) return { kind: "invalid", issues };
  const warnings = issues.filter((i) => i.severity === "warning");
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .update(flows)
      .set({ status: "active", updatedAt: new Date() })
      .where(
        and(
          eq(flows.id, input.flowId),
          eq(flows.status, "draft"),
        ),
      )
      .returning();
    if (!row) return { kind: "invalid_state" as const, status: existing.status };
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.activated",
      flowId: row.id,
      meta: { warnings: warnings.map((w) => w.code) },
    });
    return { kind: "activated" as const, flow: row, warnings };
  });
}

export type FlowStatusActionResult =
  | { kind: "ok"; flow: Flow }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: FlowStatus };

/** Nonaktifkan: active → draft (pemicu baru berhenti; run hidup tidak dibatalkan). */
export async function deactivateFlow(
  db: Database,
  input: { tenantId: string; flowId: string; userId: string },
): Promise<FlowStatusActionResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "active") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const [row] = await tx
      .update(flows)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(flows.id, input.flowId))
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.deactivated",
      flowId: row.id,
    });
    return { kind: "ok" as const, flow: row };
  });
}

/** Arsip: draft|active → archived. Keluar arsip: archived → draft. */
export async function setFlowArchived(
  db: Database,
  input: { tenantId: string; flowId: string; userId: string; archived: boolean },
): Promise<FlowStatusActionResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (input.archived && existing.status === "archived") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    if (!input.archived && existing.status !== "archived") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const [row] = await tx
      .update(flows)
      .set({
        status: input.archived ? "archived" : "draft",
        updatedAt: new Date(),
      })
      .where(eq(flows.id, input.flowId))
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.updated",
      flowId: row.id,
      meta: { archived: input.archived },
    });
    return { kind: "ok" as const, flow: row };
  });
}

export type DeleteFlowResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: FlowStatus };

/** Hapus — hanya draft (run & langkah ikut terhapus lewat FK cascade). */
export async function deleteFlow(
  db: Database,
  input: { tenantId: string; flowId: string; userId: string },
): Promise<DeleteFlowResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "draft") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    await tx.delete(flows).where(eq(flows.id, input.flowId));
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.updated",
      flowId: input.flowId,
      meta: { deleted: true, name: existing.name },
    });
    return { kind: "deleted" as const };
  });
}

// ---------------------------------------------------------------------------
// Baca run & langkah (untuk 8B / debugging)
// ---------------------------------------------------------------------------

export type FlowRunWithContact = FlowRun & { contactName: string };

export async function listFlowRuns(
  db: Database,
  input: {
    tenantId: string;
    flowId: string;
    status?: FlowRunStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<
  | { kind: "ok"; runs: FlowRunWithContact[]; nextCursor: string | null }
  | { kind: "not_found" }
> {
  const limit = clampLimit(input.limit);
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [owner] = await tx
      .select({ id: flows.id })
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!owner) return { kind: "not_found" as const };
    const conditions = [
      eq(flowRuns.tenantId, input.tenantId),
      eq(flowRuns.flowId, input.flowId),
    ];
    if (input.status) conditions.push(eq(flowRuns.status, input.status));
    const cc = cursorCondition(
      decodeCursor(input.cursor),
      flowRuns.createdAt,
      flowRuns.id,
    );
    if (cc) conditions.push(cc);
    const rows = await tx
      .select({ run: flowRuns, contactName: contacts.name })
      .from(flowRuns)
      .innerJoin(contacts, eq(flowRuns.contactId, contacts.id))
      .where(and(...conditions))
      .orderBy(desc(flowRuns.createdAt), desc(flowRuns.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      kind: "ok" as const,
      runs: page.map((r) => ({ ...r.run, contactName: r.contactName })),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1].run) : null,
    };
  });
}

export async function listFlowRunSteps(
  db: Database,
  input: {
    tenantId: string;
    runId: string;
    cursor?: string;
    limit?: number;
  },
): Promise<
  | { kind: "ok"; steps: FlowRunStep[]; nextCursor: string | null }
  | { kind: "not_found" }
> {
  const limit = clampLimit(input.limit, 100, 200);
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [run] = await tx
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(
        and(
          eq(flowRuns.tenantId, input.tenantId),
          eq(flowRuns.id, input.runId),
        ),
      )
      .limit(1);
    if (!run) return { kind: "not_found" as const };
    // Paginasi langkah memakai seq menaik (kursor = seq terakhir).
    let afterSeq = 0;
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const parsed = Number.parseInt(cursor.id, 10);
      if (!Number.isNaN(parsed)) afterSeq = parsed;
    }
    const rows = await tx
      .select()
      .from(flowRunSteps)
      .where(
        and(
          eq(flowRunSteps.tenantId, input.tenantId),
          eq(flowRunSteps.runId, input.runId),
          sql`${flowRunSteps.seq} > ${afterSeq}`,
        ),
      )
      .orderBy(asc(flowRunSteps.seq))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      kind: "ok" as const,
      steps: page,
      nextCursor: hasMore
        ? Buffer.from(
            JSON.stringify({
              createdAt: page[page.length - 1].createdAt.toISOString(),
              id: String(page[page.length - 1].seq),
            }),
            "utf8",
          ).toString("base64url")
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Pemicu: evaluasi flow untuk satu pesan masuk (dipanggil automations.ts)
// ---------------------------------------------------------------------------

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

/** Salinan lokal pencocok keyword automation (menghindari impor melingkar). */
function flowKeywordMatches(
  messageText: string,
  keyword: string,
  match: "exact" | "contains",
): boolean {
  const text = normalizeText(messageText);
  const kw = normalizeText(keyword);
  if (!kw) return false;
  return match === "exact" ? text === kw : text.includes(kw);
}

function flowTriggerMatches(
  node: FlowGraphNode,
  messageText: string,
): boolean {
  const c = node.config;
  if (c.kind === "any_message") return true;
  if (c.kind === "keyword") {
    const keywords = Array.isArray(c.keywords)
      ? c.keywords.filter(isNonEmptyString)
      : [];
    const match = c.match === "exact" ? "exact" : "contains";
    return keywords.some((kw) => flowKeywordMatches(messageText, kw, match));
  }
  return false;
}

export interface FlowEvaluationOutcome {
  /** Run yang BARU dimulai oleh pesan ini. */
  startedRunIds: string[];
  /** Flow cocok yang tidak memulai run baru (run untuk pesan ini sudah ada). */
  duplicateStarts: number;
  /** Run waiting yang dibatalkan karena kontak opt-out. */
  cancelledRunIds: string[];
  /** Run wait_reply parkir yang dilanjutkan pesan ini (branch replied). */
  resumedRunIds: string[];
  /** Run questionnaire parkir yang memproses pesan ini sebagai jawaban (Fase 13E). */
  questionnaireResumedRunIds: string[];
  /** Run show_catalog parkir yang memproses pesan ini sebagai pilihan (Fase 13F). */
  catalogResumedRunIds: string[];
  /** Run book_appointment parkir yang memproses pesan ini sebagai pilihan slot (Fase 13G). */
  appointmentResumedRunIds: string[];
}

/**
 * Menyelesaikan parkir wait_reply satu run DALAM transaksi berjalan:
 * menulis baris langkah resolusi (outcome = branch), membersihkan
 * context.wait, dan memajukan run ke node cabang — atau menyelesaikan
 * run bila cabang tidak punya node lanjutan. `run` harus keadaan
 * segar yang dibaca dalam transaksi ini. Dipakai dua jalur: balasan
 * kontak (jalur evaluasi pesan masuk) dan tenggat lewat (eksekutor).
 */
async function resolveParkedWaitReply(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  resolution: { branch: "replied" | "timeout"; extraDetail: Record<string, unknown> },
): Promise<{ status: FlowRunStatus; nextStepSeq: number }> {
  const now = new Date();
  const seq = run.nextStepSeq;
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq,
    nodeId: node.id,
    nodeType: "wait_reply",
    detail: { outcome: resolution.branch, ...resolution.extraDetail },
  });
  const nextId = nextNodeId(graph, node.id, resolution.branch);
  const context = { ...runContextOf(run) };
  delete context.wait;
  const patch: Partial<FlowRun> = {
    stepCount: run.stepCount + 1,
    nextStepSeq: seq + 1,
    context,
    updatedAt: now,
  };
  if (nextId === null) {
    patch.status = "completed";
    patch.currentNodeId = null;
    patch.completedAt = now;
    await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
    await flowAudit(tx, tenantId, {
      actorType: "system",
      actorId: `flow:${run.flowId}`,
      action: "flow.run_completed",
      flowId: run.flowId,
      meta: {
        flowRunId: run.id,
        conversationId: run.conversationId,
        stepCount: run.stepCount + 1,
        reason: `wait_reply_${resolution.branch}`,
      },
    });
    return { status: "completed", nextStepSeq: seq + 1 };
  }
  patch.status = "running";
  patch.currentNodeId = nextId;
  await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
  return { status: "running", nextStepSeq: seq + 1 };
}

/**
 * Mengantrekan SATU pesan keluar flow pada percakapan run (pola
 * send_message: baris messages `queued` + sentuhan percakapan +
 * event outbox message.queued via "flow"). Dipakai node questionnaire
 * untuk pertanyaan, prompt ulang, dan konfirmasi.
 */
async function queueFlowOutboundText(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  conversation: Conversation,
  text: string,
): Promise<string> {
  const [outbound] = await tx
    .insert(messages)
    .values({
      tenantId,
      conversationId: run.conversationId,
      direction: "outbound",
      senderType: "system",
      type: "text",
      contentText: text,
      status: "queued",
    })
    .returning();
  const now = new Date();
  await tx
    .update(conversations)
    .set({ lastMessageAt: now, updatedAt: now })
    .where(eq(conversations.id, run.conversationId));
  await tx.insert(outboxEvents).values({
    tenantId,
    type: "message.queued",
    payload: {
      provider: conversation.provider,
      conversationId: run.conversationId,
      messageId: outbound.id,
      via: "flow",
      flowId: run.flowId,
      runId: run.id,
    },
  });
  return outbound.id;
}

/**
 * Menulis jawaban sah ke field target kontak (pola set_field: kolom
 * standar atau custom_fields yang digabung). Mengembalikan nilai yang
 * BENAR-BENAR tersimpan (target standar menerima bentuk string dari
 * nilai number; target custom menyimpan nilai apa adanya).
 */
async function writeQuestionnaireAnswer(
  tx: DbTx,
  contact: Contact,
  question: QuestionnaireQuestion,
  value: string | number,
): Promise<unknown> {
  const patch: Partial<Contact> = { updatedAt: new Date() };
  let stored: unknown = value;
  if (question.target === "name") {
    stored = String(value);
    patch.name = String(value);
  } else if (question.target === "phone") {
    stored = String(value);
    patch.phone = String(value);
  } else if (question.target === "email") {
    stored = String(value);
    patch.email = String(value);
  } else {
    const key = questionnaireTargetKey(question.target)!;
    patch.customFields = {
      ...(contact.customFields as Record<string, unknown>),
      [key]: value,
    };
  }
  await tx
    .update(contacts)
    .set(patch)
    .where(eq(contacts.id, contact.id));
  return stored;
}

/**
 * Gerbang "pertanyaan hendak dikirim": mulai dari state.qIndex,
 * lewati pertanyaan yang target custom-nya TIDAK lagi dikenal tenant
 * (kunci hilang dari semua kontak sesudah aktivasi) — tercatat di
 * transkrip sebagai `target_missing`. Pertanyaan WAJIB yang targetnya
 * hilang menghentikan kuesioner (pemanggil keluar branch "invalid");
 * pertanyaan opsional dilewati. Mengembalikan posisi pertanyaan yang
 * siap dikirim, atau penanda selesai/berhenti.
 */
function skipMissingQuestionnaireTargets(
  state: QuestionnaireRunState,
  config: QuestionnaireConfig,
  knownKeys: Set<string>,
):
  | { kind: "ask"; index: number }
  | { kind: "finished" }
  | { kind: "missing_required"; question: QuestionnaireQuestion } {
  while (state.qIndex < config.questions.length) {
    const question = config.questions[state.qIndex];
    const key = questionnaireTargetKey(question.target);
    if (key === null || knownKeys.has(key)) {
      return { kind: "ask", index: state.qIndex };
    }
    state.answers.push({
      questionId: question.id,
      prompt: question.prompt,
      target: question.target,
      answerType: question.answerType,
      outcome: "target_missing",
      raw: null,
      stored: null,
      attempts: state.attempts,
    });
    if (question.required) {
      return { kind: "missing_required", question };
    }
    state.qIndex += 1;
    state.attempts = 0;
  }
  return { kind: "finished" };
}

/**
 * Keluar dari node questionnaire lewat satu branch (completed /
 * invalid / timeout): menulis baris langkah penutup dengan detail
 * yang diberikan pemanggil, membersihkan context.wait +
 * context.questionnaire, menerapkan completionTag pada branch
 * completed bila dikonfigurasi, dan memajukan run (atau
 * menyelesaikannya) — pasangan `resolveParkedWaitReply` untuk node
 * ini. `run` harus keadaan segar dalam transaksi ini.
 */
async function exitParkedQuestionnaire(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  input: {
    branch: "completed" | "invalid" | "timeout";
    detail: Record<string, unknown>;
    config: QuestionnaireConfig;
  },
): Promise<{ status: FlowRunStatus; nextStepSeq: number }> {
  const now = new Date();
  const seq = run.nextStepSeq;
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq,
    nodeId: node.id,
    nodeType: "questionnaire",
    detail: { ...input.detail, branch: input.branch },
  });
  if (input.branch === "completed" && input.config.completionTag) {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, tenantId), eq(contacts.id, run.contactId)),
      )
      .limit(1);
    if (contact && !contact.tags.includes(input.config.completionTag)) {
      await tx
        .update(contacts)
        .set({
          tags: [...contact.tags, input.config.completionTag],
          updatedAt: now,
        })
        .where(eq(contacts.id, contact.id));
    }
  }
  const nextId = nextNodeId(graph, node.id, input.branch);
  const context = { ...runContextOf(run) };
  delete context.wait;
  delete context.questionnaire;
  const patch: Partial<FlowRun> = {
    stepCount: run.stepCount + 1,
    nextStepSeq: seq + 1,
    context,
    updatedAt: now,
  };
  if (nextId === null) {
    patch.status = "completed";
    patch.currentNodeId = null;
    patch.completedAt = now;
    await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
    await flowAudit(tx, tenantId, {
      actorType: "system",
      actorId: `flow:${run.flowId}`,
      action: "flow.run_completed",
      flowId: run.flowId,
      meta: {
        flowRunId: run.id,
        conversationId: run.conversationId,
        stepCount: run.stepCount + 1,
        reason: `questionnaire_${input.branch}`,
      },
    });
    return { status: "completed", nextStepSeq: seq + 1 };
  }
  patch.status = "running";
  patch.currentNodeId = nextId;
  await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
  return { status: "running", nextStepSeq: seq + 1 };
}

/**
 * Parkir (ulang) run pada node questionnaire sesudah satu langkah
 * balasan diproses: menulis baris langkah, menyimpan keadaan
 * kuesioner + penanda parkir wait dengan tenggat BARU (semantik
 * per-parkir wait_reply diterapkan per pertanyaan), dan menulis
 * event tenggat flow.step_due.
 */
async function parkQuestionnaire(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  node: FlowGraphNode,
  state: QuestionnaireRunState,
  timeoutMs: number,
  detail: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const seq = run.nextStepSeq;
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq,
    nodeId: node.id,
    nodeType: "questionnaire",
    detail,
  });
  const resumeAt = new Date(now.getTime() + timeoutMs);
  const context: FlowRunContextData = {
    ...runContextOf(run),
    questionnaire: state,
    wait: {
      nodeId: node.id,
      deadline: resumeAt.toISOString(),
      parkedAt: now.toISOString(),
    },
  };
  await tx
    .update(flowRuns)
    .set({
      stepCount: run.stepCount + 1,
      nextStepSeq: seq + 1,
      status: "waiting",
      currentNodeId: node.id,
      context,
      updatedAt: now,
    })
    .where(eq(flowRuns.id, run.id));
  await tx.insert(outboxEvents).values({
    tenantId,
    type: "flow.step_due",
    payload: {
      runId: run.id,
      stepSeq: seq + 1,
      resumeAt: resumeAt.toISOString(),
    },
  });
}

/**
 * Sesudah satu pertanyaan terjawab (sah) atau habis percobaannya
 * (opsional): majukan kuesioner — gerbang target-hilang, lalu kirim
 * pertanyaan berikutnya dan parkir lagi, atau keluar lewat branch
 * yang sesuai. `stepBase` membawa detail peristiwa pemicu (jawaban
 * tercatat / percobaan habis) ke baris langkah yang ditulis di sini.
 */
async function advanceQuestionnaireAfterAnswer(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  config: QuestionnaireConfig,
  state: QuestionnaireRunState,
  contact: Contact,
  conversation: Conversation,
  stepBase: Record<string, unknown>,
  exhausted: boolean,
): Promise<{ status: FlowRunStatus; nextStepSeq: number } | null> {
  const hasCustomTargets = config.questions.some(
    (q) => questionnaireTargetKey(q.target) !== null,
  );
  const knownKeys = hasCustomTargets
    ? await tenantCustomFieldKeys(tx, tenantId)
    : new Set<string>();
  const gate = skipMissingQuestionnaireTargets(state, config, knownKeys);
  if (gate.kind === "missing_required") {
    return exitParkedQuestionnaire(tx, tenantId, run, graph, node, {
      branch: "invalid",
      config,
      detail: {
        ...stepBase,
        outcome: "target_missing",
        questionId: gate.question.id,
        target: gate.question.target,
        answers: state.answers,
      },
    });
  }
  if (gate.kind === "finished") {
    return exitParkedQuestionnaire(tx, tenantId, run, graph, node, {
      branch: "completed",
      config,
      detail: {
        ...stepBase,
        outcome: exhausted ? "attempts_exhausted" : "completed",
        answers: state.answers,
      },
    });
  }
  const nextQuestion = config.questions[gate.index];
  const outboundId = await queueFlowOutboundText(
    tx,
    tenantId,
    run,
    conversation,
    renderQuestionnairePrompt(nextQuestion, contact),
  );
  await parkQuestionnaire(tx, tenantId, run, node, state, config.timeoutMs, {
    ...stepBase,
    nextQuestionIndex: gate.index,
    nextQuestionId: nextQuestion.id,
    outboundMessageId: outboundId,
  });
  return null;
}

/**
 * Memproses SATU pesan masuk sebagai balasan bagi run questionnaire
 * yang parkir: validasi jawaban → tulis field / prompt ulang / lewati
 * / keluar branch. Seluruhnya dalam transaksi pemanggil (jalur
 * evaluasi pesan masuk, pasangan resumeParkedFlowRuns). Mengembalikan
 * hasil keluar-parkir bila run meninggalkan node-nya (pemanggil
 * mengantrekan langkah lanjutannya), null bila run parkir lagi.
 */
async function processParkedQuestionnaireReply(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  input: { messageId: string; messageText: string },
): Promise<{ status: FlowRunStatus; nextStepSeq: number } | null> {
  const config = questionnaireConfigOf(node);
  const ctxData = runContextOf(run);
  const state = ctxData.questionnaire;
  if (!state || state.nodeId !== node.id) {
    // Keadaan parkir rusak/hilang — degrade jujur: keluar lewat
    // branch invalid dengan langkah yang mencatat alasannya, bukan
    // menggantungkan run selamanya.
    return exitParkedQuestionnaire(tx, tenantId, run, graph, node, {
      branch: "invalid",
      config,
      detail: { outcome: "state_missing", answers: [] },
    });
  }
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.tenantId, tenantId), eq(contacts.id, run.contactId)),
    )
    .limit(1);
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.id, run.conversationId),
      ),
    )
    .limit(1);
  if (!contact || !conversation) {
    return exitParkedQuestionnaire(tx, tenantId, run, graph, node, {
      branch: "invalid",
      config,
      detail: { outcome: "state_missing", answers: state.answers },
    });
  }
  const question = config.questions[state.qIndex];
  if (!question) {
    return exitParkedQuestionnaire(tx, tenantId, run, graph, node, {
      branch: "completed",
      config,
      detail: { outcome: "completed", answers: state.answers },
    });
  }
  const validation = validateQuestionnaireAnswer(question, input.messageText);
  if (!validation.ok) {
    const attempts = state.attempts + 1;
    if (attempts >= config.maxInvalidAttempts) {
      state.answers.push({
        questionId: question.id,
        prompt: question.prompt,
        target: question.target,
        answerType: question.answerType,
        outcome: question.required ? "failed" : "skipped",
        raw: input.messageText.slice(0, 500),
        stored: null,
        attempts,
      });
      const answeredIndex = state.qIndex;
      state.qIndex += 1;
      state.attempts = 0;
      if (question.required) {
        return exitParkedQuestionnaire(tx, tenantId, run, graph, node, {
          branch: "invalid",
          config,
          detail: {
            outcome: "attempts_exhausted",
            questionIndex: answeredIndex,
            questionId: question.id,
            reason: validation.reason,
            attempts,
            messageId: input.messageId,
            answers: state.answers,
          },
        });
      }
      return advanceQuestionnaireAfterAnswer(
        tx,
        tenantId,
        run,
        graph,
        node,
        config,
        state,
        contact,
        conversation,
        {
          outcome: "attempts_exhausted",
          questionIndex: answeredIndex,
          questionId: question.id,
          reason: validation.reason,
          attempts,
          messageId: input.messageId,
        },
        true,
      );
    }
    // Prompt ulang: teks tidak-valid (config atau bawaan dwibahasa
    // kontrak) + pertanyaan yang sama dirender ulang, lalu parkir
    // lagi dengan tenggat baru.
    state.attempts = attempts;
    const invalidText = renderMessageText(
      config.invalidPrompt ?? QUESTIONNAIRE_DEFAULT_INVALID_PROMPT,
      { name: contact.name },
    );
    const outboundId = await queueFlowOutboundText(
      tx,
      tenantId,
      run,
      conversation,
      `${invalidText}\n${renderQuestionnairePrompt(question, contact)}`,
    );
    await parkQuestionnaire(tx, tenantId, run, node, state, config.timeoutMs, {
      outcome: "answer_invalid",
      questionIndex: state.qIndex,
      questionId: question.id,
      raw: input.messageText.slice(0, 200),
      reason: validation.reason,
      attempts,
      messageId: input.messageId,
      outboundMessageId: outboundId,
    });
    return null;
  }
  // Jawaban sah: tulis SEKARANG (progres parsial selamat), catat,
  // lalu majukan ke pertanyaan berikutnya / selesai.
  const stored = await writeQuestionnaireAnswer(
    tx,
    contact,
    question,
    validation.value,
  );
  state.answers.push({
    questionId: question.id,
    prompt: question.prompt,
    target: question.target,
    answerType: question.answerType,
    outcome: "answered",
    raw: input.messageText.slice(0, 500),
    stored,
    attempts: state.attempts,
  });
  const answeredIndex = state.qIndex;
  state.qIndex += 1;
  state.attempts = 0;
  return advanceQuestionnaireAfterAnswer(
    tx,
    tenantId,
    run,
    graph,
    node,
    config,
    state,
    contact,
    conversation,
    {
      outcome: "answer_recorded",
      questionIndex: answeredIndex,
      questionId: question.id,
      storedValue: stored,
      messageId: input.messageId,
    },
    false,
  );
}
/**
 * Keluar dari node show_catalog lewat satu branch (added / invalid /
 * timeout): menulis baris langkah penutup, membersihkan context.wait
 * + context.catalog, dan memajukan run (atau menyelesaikannya) —
 * pasangan `exitParkedQuestionnaire` untuk node ini (Fase 13F).
 * `run` harus keadaan segar dalam transaksi ini.
 */
async function exitParkedCatalog(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  input: {
    branch: "added" | "invalid" | "timeout";
    detail: Record<string, unknown>;
  },
): Promise<{ status: FlowRunStatus; nextStepSeq: number }> {
  const now = new Date();
  const seq = run.nextStepSeq;
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq,
    nodeId: node.id,
    nodeType: "show_catalog",
    detail: { ...input.detail, branch: input.branch },
  });
  const nextId = nextNodeId(graph, node.id, input.branch);
  const context = { ...runContextOf(run) };
  delete context.wait;
  delete context.catalog;
  const patch: Partial<FlowRun> = {
    stepCount: run.stepCount + 1,
    nextStepSeq: seq + 1,
    context,
    updatedAt: now,
  };
  if (nextId === null) {
    patch.status = "completed";
    patch.currentNodeId = null;
    patch.completedAt = now;
    await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
    await flowAudit(tx, tenantId, {
      actorType: "system",
      actorId: `flow:${run.flowId}`,
      action: "flow.run_completed",
      flowId: run.flowId,
      meta: {
        flowRunId: run.id,
        conversationId: run.conversationId,
        stepCount: run.stepCount + 1,
        reason: `show_catalog_${input.branch}`,
      },
    });
    return { status: "completed", nextStepSeq: seq + 1 };
  }
  patch.status = "running";
  patch.currentNodeId = nextId;
  await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
  return { status: "running", nextStepSeq: seq + 1 };
}

/**
 * Parkir (ulang) run pada node show_catalog sesudah prompt ulang:
 * baris langkah + keadaan katalog + penanda parkir wait dengan
 * tenggat BARU (semantik per-parkir wait_reply) + event tenggat.
 * Pasangan `parkQuestionnaire` untuk node ini.
 */
async function parkCatalog(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  node: FlowGraphNode,
  state: CatalogRunState,
  timeoutMs: number,
  detail: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const seq = run.nextStepSeq;
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq,
    nodeId: node.id,
    nodeType: "show_catalog",
    detail,
  });
  const resumeAt = new Date(now.getTime() + timeoutMs);
  const context: FlowRunContextData = {
    ...runContextOf(run),
    catalog: state,
    wait: {
      nodeId: node.id,
      deadline: resumeAt.toISOString(),
      parkedAt: now.toISOString(),
    },
  };
  await tx
    .update(flowRuns)
    .set({
      stepCount: run.stepCount + 1,
      nextStepSeq: seq + 1,
      status: "waiting",
      currentNodeId: node.id,
      context,
      updatedAt: now,
    })
    .where(eq(flowRuns.id, run.id));
  await tx.insert(outboxEvents).values({
    tenantId,
    type: "flow.step_due",
    payload: {
      runId: run.id,
      stepSeq: seq + 1,
      resumeAt: resumeAt.toISOString(),
    },
  });
}

/**
 * Memproses SATU pesan masuk sebagai balasan bagi run show_catalog
 * yang parkir (Fase 13F): parsing pilihan → tambah keranjang + keluar
 * "added", atau prompt ulang / keluar "invalid" bila percobaan habis.
 * Seluruhnya dalam transaksi pemanggil (jalur evaluasi pesan masuk).
 * Mengembalikan hasil keluar-parkir bila run meninggalkan node-nya,
 * null bila run parkir lagi (prompt ulang).
 */
async function processParkedCatalogReply(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  input: { messageId: string; messageText: string },
): Promise<{ status: FlowRunStatus; nextStepSeq: number } | null> {
  const config = catalogConfigOf(node);
  const ctxData = runContextOf(run);
  const state = ctxData.catalog;
  if (!state || state.nodeId !== node.id) {
    // Keadaan parkir rusak/hilang — degrade jujur seperti questionnaire.
    return exitParkedCatalog(tx, tenantId, run, graph, node, {
      branch: "invalid",
      detail: { outcome: "state_missing" },
    });
  }
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.tenantId, tenantId), eq(contacts.id, run.contactId)),
    )
    .limit(1);
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.id, run.conversationId),
      ),
    )
    .limit(1);
  if (!contact || !conversation) {
    return exitParkedCatalog(tx, tenantId, run, graph, node, {
      branch: "invalid",
      detail: { outcome: "state_missing" },
    });
  }

  // Satu jalur kegagalan pilihan: hitung percobaan, lalu prompt ulang
  // (daftar dirender ulang dari KEADAAN parkir — id produk yang sama,
  // harga/nama berjalan produk yang masih ada) atau keluar "invalid".
  const failSelection = async (
    reason: "not_a_selection" | "product_inactive" | "product_unavailable",
    extra: Record<string, unknown>,
  ): Promise<{ status: FlowRunStatus; nextStepSeq: number } | null> => {
    const attempts = state.attempts + 1;
    if (attempts >= config.maxInvalidAttempts) {
      return exitParkedCatalog(tx, tenantId, run, graph, node, {
        branch: "invalid",
        detail: {
          outcome: "attempts_exhausted",
          reason,
          attempts,
          messageId: input.messageId,
          ...extra,
        },
      });
    }
    state.attempts = attempts;
    const listed = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          inArray(products.id, state.productIds),
        ),
      );
    const byId = new Map(listed.map((p) => [p.id, p]));
    const stillListed = state.productIds
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    const invalidText = renderMessageText(
      config.invalidPrompt ?? CATALOG_DEFAULT_INVALID_PROMPT,
      { name: contact.name },
    );
    const outboundId = await queueFlowOutboundText(
      tx,
      tenantId,
      run,
      conversation,
      `${invalidText}\n${renderCatalogText(stillListed, { showDescription: config.showDescription })}`,
    );
    await parkCatalog(tx, tenantId, run, node, state, config.timeoutMs, {
      outcome: "selection_invalid",
      reason,
      raw: input.messageText.slice(0, 200),
      attempts,
      messageId: input.messageId,
      outboundMessageId: outboundId,
      ...extra,
    });
    return null;
  };

  const selection = parseCatalogSelection(
    input.messageText,
    state.productIds.length,
  );
  if (!selection) {
    return failSelection("not_a_selection", {});
  }
  const productId = state.productIds[selection.index];
  const [product] = await tx
    .select()
    .from(products)
    .where(
      and(eq(products.tenantId, tenantId), eq(products.id, productId)),
    )
    .limit(1);
  if (!product) {
    return failSelection("product_unavailable", { productId });
  }
  if (!product.isActive) {
    // Produk dinonaktifkan SETELAH daftar terkirim: tidak bisa
    // ditambahkan — percobaan tidak sah, bukan penambahan diam-diam.
    return failSelection("product_inactive", { productId });
  }

  // Pilihan sah: tulis ke keranjang (snapshot harga saat ini oleh
  // commerce), kirim ringkasan keranjang (+ addedMessage), keluar
  // branch "added" — kelanjutan adalah komposisi graf.
  const view = await addToCartTx(tx, tenantId, run.contactId, product, selection.qty);
  const summary = renderCartSummaryText(view);
  const addedText = config.addedMessage
    ? `\n${renderMessageText(config.addedMessage, { name: contact.name })}`
    : "";
  const outboundId = await queueFlowOutboundText(
    tx,
    tenantId,
    run,
    conversation,
    `${summary}${addedText}`,
  );
  return exitParkedCatalog(tx, tenantId, run, graph, node, {
    branch: "added",
    detail: {
      outcome: "added",
      productId: product.id,
      productName: product.name,
      qty: selection.qty,
      unitPriceIdr: product.priceIdr,
      cartTotalIdr: view.totalIdr,
      cartItemCount: view.itemCount,
      messageId: input.messageId,
      outboundMessageId: outboundId,
    },
  });
}
/**
 * Keluar dari node book_appointment lewat satu branch (booked /
 * invalid / timeout / slot_taken): menulis baris langkah penutup,
 * membersihkan context.wait + context.appointment, dan memajukan run
 * (atau menyelesaikannya) — pasangan `exitParkedCatalog` untuk node
 * ini (Fase 13G). `run` harus keadaan segar dalam transaksi ini.
 */
async function exitParkedAppointment(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  input: {
    branch: "booked" | "invalid" | "timeout" | "slot_taken";
    detail: Record<string, unknown>;
  },
): Promise<{ status: FlowRunStatus; nextStepSeq: number }> {
  const now = new Date();
  const seq = run.nextStepSeq;
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq,
    nodeId: node.id,
    nodeType: "book_appointment",
    detail: { ...input.detail, branch: input.branch },
  });
  const nextId = nextNodeId(graph, node.id, input.branch);
  const context = { ...runContextOf(run) };
  delete context.wait;
  delete context.appointment;
  const patch: Partial<FlowRun> = {
    stepCount: run.stepCount + 1,
    nextStepSeq: seq + 1,
    context,
    updatedAt: now,
  };
  if (nextId === null) {
    patch.status = "completed";
    patch.currentNodeId = null;
    patch.completedAt = now;
    await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
    await flowAudit(tx, tenantId, {
      actorType: "system",
      actorId: `flow:${run.flowId}`,
      action: "flow.run_completed",
      flowId: run.flowId,
      meta: {
        flowRunId: run.id,
        conversationId: run.conversationId,
        stepCount: run.stepCount + 1,
        reason: `book_appointment_${input.branch}`,
      },
    });
    return { status: "completed", nextStepSeq: seq + 1 };
  }
  patch.status = "running";
  patch.currentNodeId = nextId;
  await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
  return { status: "running", nextStepSeq: seq + 1 };
}

/**
 * Parkir (ulang) run pada node book_appointment: baris langkah +
 * keadaan janji + penanda parkir wait dengan tenggat BARU (semantik
 * per-parkir wait_reply) + event tenggat. Pasangan `parkCatalog`.
 */
async function parkAppointment(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  node: FlowGraphNode,
  state: AppointmentRunState,
  timeoutMs: number,
  detail: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const seq = run.nextStepSeq;
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq,
    nodeId: node.id,
    nodeType: "book_appointment",
    detail,
  });
  const resumeAt = new Date(now.getTime() + timeoutMs);
  const context: FlowRunContextData = {
    ...runContextOf(run),
    appointment: state,
    wait: {
      nodeId: node.id,
      deadline: resumeAt.toISOString(),
      parkedAt: now.toISOString(),
    },
  };
  await tx
    .update(flowRuns)
    .set({
      stepCount: run.stepCount + 1,
      nextStepSeq: seq + 1,
      status: "waiting",
      currentNodeId: node.id,
      context,
      updatedAt: now,
    })
    .where(eq(flowRuns.id, run.id));
  await tx.insert(outboxEvents).values({
    tenantId,
    type: "flow.step_due",
    payload: {
      runId: run.id,
      stepSeq: seq + 1,
      resumeAt: resumeAt.toISOString(),
    },
  });
}

/**
 * Memproses SATU pesan masuk sebagai balasan bagi run
 * book_appointment yang parkir (Fase 13G): parsing nomor slot →
 * booking dalam savepoint → keluar "booked"; slot keburu diambil →
 * daftar segar ditawarkan ulang (parkir lagi) atau keluar
 * "slot_taken" bila daftar segar kosong; balasan tidak sah → prompt
 * ulang / keluar "invalid". Seluruhnya dalam transaksi pemanggil
 * (jalur evaluasi pesan masuk), kecuali hitungan daftar segar yang
 * membaca lewat `db` (transaksi baca sendiri + freebusy Google di
 * luar transaksi evaluasi — data ter-commit terbaru adalah yang
 * benar untuk penawaran ulang). Mengembalikan hasil keluar-parkir
 * bila run meninggalkan node-nya, null bila run parkir lagi.
 */
async function processParkedAppointmentReply(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  input: { messageId: string; messageText: string },
  ctx: { db: Database; googleDeps?: GoogleDeps },
): Promise<{ status: FlowRunStatus; nextStepSeq: number } | null> {
  const config = appointmentConfigOf(node);
  const ctxData = runContextOf(run);
  const state = ctxData.appointment;
  if (!state || state.nodeId !== node.id) {
    // Keadaan parkir rusak/hilang — degrade jujur seperti katalog.
    return exitParkedAppointment(tx, tenantId, run, graph, node, {
      branch: "invalid",
      detail: { outcome: "state_missing" },
    });
  }
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.tenantId, tenantId), eq(contacts.id, run.contactId)),
    )
    .limit(1);
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.id, run.conversationId),
      ),
    )
    .limit(1);
  if (!contact || !conversation) {
    return exitParkedAppointment(tx, tenantId, run, graph, node, {
      branch: "invalid",
      detail: { outcome: "state_missing" },
    });
  }

  // Satu jalur kegagalan pilihan: hitung percobaan, lalu prompt ulang
  // (daftar yang DITAWARKAN dirender ulang apa adanya — nomor tidak
  // bergeser) atau keluar "invalid" bila percobaan habis.
  const failSelection = async (
    reason: "not_a_selection",
    extra: Record<string, unknown>,
  ): Promise<{ status: FlowRunStatus; nextStepSeq: number } | null> => {
    const attempts = state.attempts + 1;
    if (attempts >= config.maxInvalidAttempts) {
      return exitParkedAppointment(tx, tenantId, run, graph, node, {
        branch: "invalid",
        detail: {
          outcome: "attempts_exhausted",
          reason,
          attempts,
          messageId: input.messageId,
          ...extra,
        },
      });
    }
    state.attempts = attempts;
    const offered: BookableSlot[] = state.offeredSlots.map((s) => ({
      startsAt: new Date(s.startsAt),
      endsAt: new Date(s.endsAt),
    }));
    const settings = await getAppointmentSettings(ctx.db, tenantId).catch(
      () => null,
    );
    const tz = settings?.timezone ?? "Asia/Jakarta";
    const invalidText = renderMessageText(
      config.invalidPrompt ?? APPOINTMENT_DEFAULT_INVALID_PROMPT,
      { name: contact.name },
    );
    const outboundId = await queueFlowOutboundText(
      tx,
      tenantId,
      run,
      conversation,
      `${invalidText}\n${renderSlotListText(offered, tz)}`,
    );
    await parkAppointment(tx, tenantId, run, node, state, config.timeoutMs, {
      outcome: "selection_invalid",
      reason,
      raw: input.messageText.slice(0, 200),
      attempts,
      messageId: input.messageId,
      outboundMessageId: outboundId,
      ...extra,
    });
    return null;
  };

  const selection = parseSlotSelection(
    input.messageText,
    state.offeredSlots.length,
  );
  if (!selection) {
    return failSelection("not_a_selection", {});
  }
  const chosen = state.offeredSlots[selection.index]!;

  // Booking dibuat lewat transaksinya SENDIRI (createBooking di
  // ctx.db — pola yang sama dengan jalur dashboard): pelanggaran
  // constraint eksklusi (slot keburu diambil sejak daftar dikirim)
  // menjadi SlotTakenError yang ditangkap bersih, TANPA savepoint
  // bersarang di dalam transaksi evaluasi. Konsekuensi atomisitas
  // yang diterima: booking ter-commit lebih dulu; tulisan langkah/
  // keluar parkir menyusul di transaksi evaluasi. Bila transaksi
  // evaluasi gagal SETELAH booking ter-commit (langka), run tetap
  // parkir dan pilihan berikutnya atas slot yang sama terselesaikan
  // lewat jalur slot_taken (tawaran segar) — konsisten, tanpa
  // booking ganda (constraint eksklusi tetap penegak tunggal).
  let booking: Awaited<ReturnType<typeof createBooking>> | null = null;
  let slotTaken = false;
  try {
    booking = await createBooking(ctx.db, tenantId, {
      serviceId: state.serviceId,
      contactId: run.contactId,
      conversationId: run.conversationId,
      startsAt: new Date(chosen.startsAt),
      source: "flow",
      actorType: "system",
      actorId: `flow:${run.flowId}`,
    });
  } catch (err) {
    if (err instanceof SlotTakenError) {
      slotTaken = true;
    } else if (err instanceof AppointmentServiceNotFoundError) {
      // Layanan terhapus di tengah parkir — keluar invalid tercatat.
      return exitParkedAppointment(tx, tenantId, run, graph, node, {
        branch: "invalid",
        detail: {
          outcome: "service_unavailable",
          serviceId: state.serviceId,
          messageId: input.messageId,
        },
      });
    } else {
      throw err;
    }
  }

  if (slotTaken) {
    // Hitung daftar SEGAR (booking terbaru + kesibukan Google) lewat
    // mesin slot yang sama, di luar transaksi evaluasi.
    const now = new Date();
    const fresh = await getBookableSlots(
      ctx.db,
      tenantId,
      state.serviceId,
      {
        from: now,
        to: new Date(now.getTime() + config.daysAhead * 86_400_000),
        now,
      },
      ctx.googleDeps,
    ).catch(() => null);
    const freshOffered = (fresh?.slots ?? []).slice(
      0,
      config.slotsPerMessage,
    );
    if (!fresh || freshOffered.length === 0) {
      return exitParkedAppointment(tx, tenantId, run, graph, node, {
        branch: "slot_taken",
        detail: {
          outcome: "slot_taken",
          serviceId: state.serviceId,
          chosenStartsAt: chosen.startsAt,
          messageId: input.messageId,
        },
      });
    }
    const notice = renderMessageText(APPOINTMENT_DEFAULT_SLOT_TAKEN_PROMPT, {
      name: contact.name,
    });
    const outboundId = await queueFlowOutboundText(
      tx,
      tenantId,
      run,
      conversation,
      `${notice}\n${renderSlotListText(freshOffered, fresh.settings.timezone)}`,
    );
    const newState: AppointmentRunState = {
      nodeId: node.id,
      serviceId: state.serviceId,
      offeredSlots: freshOffered.map((s) => ({
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
      })),
      attempts: state.attempts,
      listedAt: now.toISOString(),
    };
    await parkAppointment(
      tx,
      tenantId,
      run,
      node,
      newState,
      config.timeoutMs,
      {
        outcome: "slot_taken_reoffered",
        serviceId: state.serviceId,
        chosenStartsAt: chosen.startsAt,
        freshSlotCount: freshOffered.length,
        messageId: input.messageId,
        outboundMessageId: outboundId,
      },
    );
    return null;
  }

  // Booking tercipta: bookedMessage opsional dikirim node ini;
  // konfirmasi utama adalah komposisi graf sesudah branch "booked".
  let outboundId: string | undefined;
  if (config.bookedMessage) {
    outboundId = await queueFlowOutboundText(
      tx,
      tenantId,
      run,
      conversation,
      renderMessageText(config.bookedMessage, { name: contact.name }),
    );
  }
  return exitParkedAppointment(tx, tenantId, run, graph, node, {
    branch: "booked",
    detail: {
      outcome: "booked",
      bookingId: booking!.id,
      serviceId: state.serviceId,
      startsAt: booking!.startsAt.toISOString(),
      endsAt: booking!.endsAt.toISOString(),
      googleSyncStatus: booking!.googleSyncStatus,
      messageId: input.messageId,
      ...(outboundId ? { outboundMessageId: outboundId } : {}),
    },
  });
}

/**
 * Melanjutkan SEMUA run parkir (wait_reply, questionnaire &
 * show_catalog) di percakapan ini dengan pesan masuk yang baru tiba,
 * lalu mengantrekan langkah lanjutan tiap run yang keluar dari
 * parkirnya lewat outbox. Run waiting biasa (delay) tidak disentuh —
 * penandanya adalah context.wait yang nodeId-nya sama dengan
 * currentNodeId. wait_reply selesai lewat branch "replied";
 * questionnaire MEMPROSES pesan sebagai jawaban (validasi + tulis
 * field + pertanyaan berikutnya) dan hanya keluar parkir saat
 * kuesionernya selesai/gagal — lihat processParkedQuestionnaireReply.
 * show_catalog MEMPROSES pesan sebagai pilihan katalog (tambah
 * keranjang / prompt ulang) — lihat processParkedCatalogReply.
 */
async function resumeParkedFlowRuns(
  tx: DbTx,
  tenantId: string,
  input: { conversationId: string; messageId: string; messageText: string },
  deps: { db: Database; googleDeps?: GoogleDeps },
): Promise<{
  waitReplyRunIds: string[];
  questionnaireRunIds: string[];
  catalogRunIds: string[];
  appointmentRunIds: string[];
}> {
  const waiting = await tx
    .select()
    .from(flowRuns)
    .where(
      and(
        eq(flowRuns.tenantId, tenantId),
        eq(flowRuns.conversationId, input.conversationId),
        eq(flowRuns.status, "waiting"),
      ),
    );
  const waitReplyRunIds: string[] = [];
  const questionnaireRunIds: string[] = [];
  const catalogRunIds: string[] = [];
  const appointmentRunIds: string[] = [];
  for (const run of waiting) {
    const ctx = runContextOf(run);
    if (!ctx.wait || run.currentNodeId !== ctx.wait.nodeId) continue;
    const [flow] = await tx
      .select()
      .from(flows)
      .where(and(eq(flows.tenantId, tenantId), eq(flows.id, run.flowId)))
      .limit(1);
    if (!flow) continue;
    const graph = normalizeFlowGraph(flow.graph);
    const node = graph.nodes.find((n) => n.id === ctx.wait!.nodeId);
    if (!node) continue;
    if (node.type === "questionnaire") {
      if (!ctx.questionnaire || ctx.questionnaire.nodeId !== node.id) {
        continue;
      }
      const exited = await processParkedQuestionnaireReply(
        tx,
        tenantId,
        run,
        graph,
        node,
        {
          messageId: input.messageId,
          messageText: input.messageText,
        },
      );
      if (exited && exited.status === "running") {
        await tx.insert(outboxEvents).values({
          tenantId,
          type: "flow.step_due",
          payload: {
            runId: run.id,
            stepSeq: exited.nextStepSeq,
            resumeAt: new Date().toISOString(),
          },
        });
      }
      questionnaireRunIds.push(run.id);
      continue;
    }
    if (node.type === "show_catalog") {
      if (!ctx.catalog || ctx.catalog.nodeId !== node.id) {
        continue;
      }
      const exited = await processParkedCatalogReply(
        tx,
        tenantId,
        run,
        graph,
        node,
        {
          messageId: input.messageId,
          messageText: input.messageText,
        },
      );
      if (exited && exited.status === "running") {
        await tx.insert(outboxEvents).values({
          tenantId,
          type: "flow.step_due",
          payload: {
            runId: run.id,
            stepSeq: exited.nextStepSeq,
            resumeAt: new Date().toISOString(),
          },
        });
      }
      catalogRunIds.push(run.id);
      continue;
    }
    if (node.type === "book_appointment") {
      if (!ctx.appointment || ctx.appointment.nodeId !== node.id) {
        continue;
      }
      const exited = await processParkedAppointmentReply(
        tx,
        tenantId,
        run,
        graph,
        node,
        {
          messageId: input.messageId,
          messageText: input.messageText,
        },
        deps,
      );
      if (exited && exited.status === "running") {
        await tx.insert(outboxEvents).values({
          tenantId,
          type: "flow.step_due",
          payload: {
            runId: run.id,
            stepSeq: exited.nextStepSeq,
            resumeAt: new Date().toISOString(),
          },
        });
      }
      appointmentRunIds.push(run.id);
      continue;
    }
    if (node.type !== "wait_reply") continue;
    const result = await resolveParkedWaitReply(tx, tenantId, run, graph, node, {
      branch: "replied",
      extraDetail: { messageId: input.messageId, deadline: ctx.wait.deadline },
    });
    if (result.status === "running") {
      await tx.insert(outboxEvents).values({
        tenantId,
        type: "flow.step_due",
        payload: {
          runId: run.id,
          stepSeq: result.nextStepSeq,
          resumeAt: new Date().toISOString(),
        },
      });
    }
    waitReplyRunIds.push(run.id);
  }
  return { waitReplyRunIds, questionnaireRunIds, catalogRunIds, appointmentRunIds };
}

/**
 * Membatalkan run `waiting` pada percakapan (aturan opt-out). Dipakai
 * jalur evaluasi saat pesan masuk berasal dari kontak yang sudah
 * opt-out. Mengembalikan id run yang dibatalkan.
 */
async function cancelWaitingFlowRuns(
  tx: DbTx,
  tenantId: string,
  conversationId: string,
  reason: string,
): Promise<string[]> {
  const waiting = await tx
    .select()
    .from(flowRuns)
    .where(
      and(
        eq(flowRuns.tenantId, tenantId),
        eq(flowRuns.conversationId, conversationId),
        eq(flowRuns.status, "waiting"),
      ),
    );
  const cancelled: string[] = [];
  const now = new Date();
  for (const run of waiting) {
    const [updated] = await tx
      .update(flowRuns)
      .set({
        status: "cancelled",
        errorCode: reason,
        currentNodeId: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(flowRuns.id, run.id), eq(flowRuns.status, "waiting")),
      )
      .returning();
    if (!updated) continue;
    await flowAudit(tx, tenantId, {
      actorType: "system",
      actorId: `flow:${run.flowId}`,
      action: "flow.run_cancelled",
      flowId: run.flowId,
      meta: { flowRunId: run.id, conversationId, reason },
    });
    cancelled.push(run.id);
  }
  return cancelled;
}

/**
 * Memulai run untuk semua flow AKTIF yang trigger-nya cocok dengan
 * pesan masuk ini. Dipanggil `evaluateInboundMessageForAutomations`
 * SETELAH pencocokan automation (keyword → flow → agent). Satu
 * transaksi per flow agar kegagalan satu flow tidak menggagalkan yang
 * lain; pelanggaran unik (run sudah ada untuk pesan ini) diperlakukan
 * sebagai duplikat, BUKAN kegagalan.
 */
export async function startFlowRunsForInboundMessage(
  db: Database,
  input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    messageText: string;
    contact: Contact | null;
    conversation: Conversation;
  },
  opts?: { googleDeps?: GoogleDeps },
): Promise<FlowEvaluationOutcome> {
  const { tenantId, conversationId, messageId } = input;
  const outcome: FlowEvaluationOutcome = {
    startedRunIds: [],
    duplicateStarts: 0,
    cancelledRunIds: [],
    resumedRunIds: [],
    questionnaireResumedRunIds: [],
    catalogResumedRunIds: [],
    appointmentResumedRunIds: [],
  };
  if (!input.contact) return outcome;

  // Kontak opt-out: tidak ada run baru; run waiting di percakapan ini
  // dibatalkan (aturan berhenti opt-out — konsisten sequence 2C).
  if (input.contact.optInStatus === "opted_out") {
    outcome.cancelledRunIds = await withTenantDb(db, tenantId, (tx) =>
      cancelWaitingFlowRuns(tx, tenantId, conversationId, "contact_opted_out"),
    );
    return outcome;
  }

  // Fase 12A: pesan ini adalah BALASAN bagi run wait_reply yang parkir
  // di percakapan ini — lanjutkan semuanya lewat branch "replied"
  // SEBELUM pemicu flow biasa dievaluasi. Pesan yang sama tetap
  // diproses pemicu lain seperti biasa (keputusan desain terdokumentasi
  // di kontrak): melanjutkan wait_reply tidak menekan trigger lain.
  // Fase 13E: run questionnaire yang parkir memproses pesan yang sama
  // sebagai JAWABAN (bukan sekadar resume) lewat jalur yang sama.
  const resumedParked = await withTenantDb(db, tenantId, (tx) =>
    resumeParkedFlowRuns(
      tx,
      tenantId,
      {
        conversationId,
        messageId,
        messageText: input.messageText,
      },
      { db, googleDeps: opts?.googleDeps },
    ),
  );
  outcome.resumedRunIds = resumedParked.waitReplyRunIds;
  outcome.questionnaireResumedRunIds = resumedParked.questionnaireRunIds;
  outcome.catalogResumedRunIds = resumedParked.catalogRunIds;
  outcome.appointmentResumedRunIds = resumedParked.appointmentRunIds;

  const activeFlows = await withTenantDb(db, tenantId, (tx) =>
    tx
      .select()
      .from(flows)
      .where(and(eq(flows.tenantId, tenantId), eq(flows.status, "active")))
      .orderBy(asc(flows.createdAt)),
  );

  for (const flow of activeFlows) {
    const graph = normalizeFlowGraph(flow.graph);
    const trigger = triggerOf(graph);
    if (!trigger) continue;
    if (!flowTriggerMatches(trigger, input.messageText)) continue;

    const started = await withTenantDb(db, tenantId, async (tx) => {
      const [existing] = await tx
        .select({ id: flowRuns.id })
        .from(flowRuns)
        .where(
          and(
            eq(flowRuns.flowId, flow.id),
            eq(flowRuns.triggerMessageId, messageId),
          ),
        )
        .limit(1);
      if (existing) return { kind: "duplicate" as const };

      const firstNodeId = firstNodeAfterTrigger(graph);
      const now = new Date();
      const [run] = await tx
        .insert(flowRuns)
        .values({
          tenantId,
          flowId: flow.id,
          conversationId,
          contactId: input.contact!.id,
          triggerMessageId: messageId,
          status: firstNodeId ? "running" : "completed",
          currentNodeId: firstNodeId,
          nextStepSeq: 1,
          stepCount: 0,
          context: { triggerText: input.messageText },
          completedAt: firstNodeId ? null : now,
        })
        .returning();
      await flowAudit(tx, tenantId, {
        actorType: "system",
        actorId: `flow:${flow.id}`,
        action: "flow.run_started",
        flowId: flow.id,
        meta: {
          flowRunId: run.id,
          triggerMessageId: messageId,
          conversationId,
        },
      });
      if (!firstNodeId) {
        await flowAudit(tx, tenantId, {
          actorType: "system",
          actorId: `flow:${flow.id}`,
          action: "flow.run_completed",
          flowId: flow.id,
          meta: { flowRunId: run.id, conversationId, reason: "empty_flow" },
        });
        return { kind: "started" as const, runId: run.id, queued: false };
      }
      // Eksekusi diserahkan ke worker lewat rel outbox (pola sequence/
      // broadcast): event → relay → job `flow.step` jobId deterministik.
      await tx.insert(outboxEvents).values({
        tenantId,
        type: "flow.step_due",
        payload: {
          runId: run.id,
          stepSeq: 1,
          resumeAt: now.toISOString(),
        },
      });
      return { kind: "started" as const, runId: run.id, queued: true };
    }).catch((err: unknown) => {
      if (
        err instanceof Error &&
        /flow_runs_flow_trigger_message_unique/.test(err.message)
      ) {
        return { kind: "duplicate" as const };
      }
      throw err;
    });

    if (started.kind === "duplicate") {
      outcome.duplicateStarts += 1;
    } else {
      outcome.startedRunIds.push(started.runId);
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Eksekusi run (sisi worker, job `flow.step`)
// ---------------------------------------------------------------------------

export interface FlowStepDeps {
  /**
   * Resolver provider LLM untuk node `ai_response` — worker me-resolve
   * per job lewat Panel Admin (pola agent.respond Fase 6C). Tanpa
   * resolver, node ai_response tercatat `skipped/llm_unavailable`.
   */
  resolveLlmProvider?: () => Promise<LlmProvider>;
  /**
   * Resolver provider embedding untuk node `ai_response` (Fase 12D) —
   * pola yang sama seperti resolver LLM; null/absen = retrieval
   * full-text murni di dalam jalur agent.
   */
  resolveEmbeddingProvider?: () => Promise<EmbeddingProvider | null>;
  /** Base URL publik untuk tool agent (send_payment_link). */
  publicBaseUrl?: string;
  /**
   * Dependensi Google Calendar untuk node `book_appointment`
   * (Fase 13G) — mesin slot memotong kesibukan freebusy tenant yang
   * terhubung. Tanpa deps ini node tetap bekerja: slot dihitung dari
   * data internal saja (Google adalah peningkatan, bukan syarat).
   */
  google?: GoogleDeps;
  /**
   * Dependensi gerbang pembayaran (Fase 14A) untuk node
   * `send_payment_link` & `cart_checkout` — konfigurasi provider tenant
   * dibaca dari DB; deps ini membawa secret enkripsi + override base
   * URL provider. Tanpa deps, tautan hanya bisa lahir bila provider
   * tenant 'simulation' (provider sungguhan → provider_error jujur).
   */
  payments?: PaymentDeps;
}

export interface ExecuteFlowStepResult {
  executed: boolean;
  reason?:
    | "run_not_found"
    | "run_terminal"
    | "stale_step"
    | "contact_opted_out";
  /** Status run sesudah pemanggilan ini (bila run ada). */
  status?: FlowRunStatus;
  conversationId?: string;
  /** Pesan keluar terakhir yang dibuat pemanggilan ini (nudge realtime). */
  outboundMessageId?: string;
  stepsExecuted?: number;
}

interface RunContext {
  run: FlowRun;
  flow: Flow;
  graph: FlowGraphData;
  conversation: Conversation | null;
  contact: Contact | null;
}

async function loadRunContext(
  db: Database,
  tenantId: string,
  runId: string,
): Promise<RunContext | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [run] = await tx
      .select()
      .from(flowRuns)
      .where(and(eq(flowRuns.tenantId, tenantId), eq(flowRuns.id, runId)))
      .limit(1);
    if (!run) return null;
    const [flow] = await tx
      .select()
      .from(flows)
      .where(and(eq(flows.tenantId, tenantId), eq(flows.id, run.flowId)))
      .limit(1);
    if (!flow) return null;
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.id, run.conversationId),
        ),
      )
      .limit(1);
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, tenantId), eq(contacts.id, run.contactId)),
      )
      .limit(1);
    return {
      run,
      flow,
      graph: normalizeFlowGraph(flow.graph),
      conversation: conversation ?? null,
      contact: contact ?? null,
    };
  });
}

function isTerminalStatus(status: FlowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Hasil penerapan satu node: apakah run berhenti di sini, dan kenapa. */
interface AdvanceResult {
  applied: boolean;
  reason?: "stale_step" | "run_terminal";
  status?: FlowRunStatus;
  outboundMessageId?: string;
}

/**
 * Menulis baris langkah + memajukan run dalam transaksi yang sedang
 * berjalan. `run` adalah keadaan run yang dimuat DALAM transaksi ini
 * dan seq-nya sudah diverifikasi pemanggil.
 */
async function advanceRun(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  graph: FlowGraphData,
  node: FlowGraphNode,
  input: {
    detail: Record<string, unknown>;
    branch?: FlowBranch;
    /** Node delay: run menunggu selama ini lalu resume. */
    waitMs?: number;
    /**
     * Node wait_reply (Fase 12A): run parkir PADA node ini sendiri
     * (bukan node berikutnya) — context.wait menandai parkirnya agar
     * jalur balasan & jalur tenggat bisa membedakannya dari delay.
     */
    parkWaitReplyMs?: number;
    /** Node end: selesaikan walau ada edge keluar. */
    forceComplete?: boolean;
    /**
     * Fase 13E: tambalan konteks run yang ditulis bersama langkah ini
     * (keadaan questionnaire saat parkir) + kunci konteks yang
     * dibersihkan (keadaan questionnaire saat keluar node).
     */
    contextPatch?: Record<string, unknown>;
    contextClear?: string[];
  },
): Promise<{ status: FlowRunStatus }> {
  const now = new Date();
  const seq = run.nextStepSeq;
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq,
    nodeId: node.id,
    nodeType: node.type,
    detail: input.detail,
  });

  const patchedContext = (): FlowRunContextData => {
    const context: FlowRunContextData = {
      ...runContextOf(run),
      ...(input.contextPatch ?? {}),
    };
    for (const key of input.contextClear ?? []) {
      delete context[key];
    }
    return context;
  };
  const hasContextChange =
    input.contextPatch !== undefined || input.contextClear !== undefined;

  if (input.parkWaitReplyMs !== undefined) {
    const resumeAt = new Date(now.getTime() + input.parkWaitReplyMs);
    const context: FlowRunContextData = {
      ...patchedContext(),
      wait: {
        nodeId: node.id,
        deadline: resumeAt.toISOString(),
        parkedAt: now.toISOString(),
      },
    };
    await tx
      .update(flowRuns)
      .set({
        stepCount: run.stepCount + 1,
        nextStepSeq: seq + 1,
        status: "waiting",
        currentNodeId: node.id,
        context,
        updatedAt: now,
      })
      .where(eq(flowRuns.id, run.id));
    // Job tenggat: relay menerjemahkannya menjadi job flow.step
    // tertunda; job itu menjalankan branch "timeout" bila run masih
    // parkir (balasan yang datang lebih dulu membuatnya basi).
    await tx.insert(outboxEvents).values({
      tenantId,
      type: "flow.step_due",
      payload: {
        runId: run.id,
        stepSeq: seq + 1,
        resumeAt: resumeAt.toISOString(),
      },
    });
    return { status: "waiting" };
  }

  const nextId = input.forceComplete
    ? null
    : nextNodeId(graph, node.id, input.branch);
  const patch: Partial<FlowRun> = {
    stepCount: run.stepCount + 1,
    nextStepSeq: seq + 1,
    updatedAt: now,
    ...(hasContextChange ? { context: patchedContext() } : {}),
  };

  if (input.waitMs !== undefined) {
    // Node delay: run menunggu; resume ditulis sebagai event outbox
    // (relay → job flow.step tertunda, jobId flow-<runId>-<seq+1>).
    // Node delay di UJUNG graf: currentNodeId null — resume akan
    // menemukan tidak ada node tersisa dan menyelesaikan run.
    const resumeAt = new Date(now.getTime() + input.waitMs);
    patch.status = "waiting";
    patch.currentNodeId = nextId;
    await tx
      .update(flowRuns)
      .set(patch)
      .where(eq(flowRuns.id, run.id));
    await tx.insert(outboxEvents).values({
      tenantId,
      type: "flow.step_due",
      payload: {
        runId: run.id,
        stepSeq: seq + 1,
        resumeAt: resumeAt.toISOString(),
      },
    });
    return { status: "waiting" };
  }

  if (nextId === null) {
    patch.status = "completed";
    patch.currentNodeId = null;
    patch.completedAt = now;
    await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
    await flowAudit(tx, tenantId, {
      actorType: "system",
      actorId: `flow:${run.flowId}`,
      action: "flow.run_completed",
      flowId: run.flowId,
      meta: {
        flowRunId: run.id,
        conversationId: run.conversationId,
        stepCount: run.stepCount + 1,
      },
    });
    return { status: "completed" };
  }

  patch.status = "running";
  patch.currentNodeId = nextId;
  await tx.update(flowRuns).set(patch).where(eq(flowRuns.id, run.id));
  return { status: "running" };
}

/** Menandai run gagal + baris langkah error + audit, dalam transaksi berjalan. */
async function failRun(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  node: FlowGraphNode | null,
  errorCode: string,
  errorMessage: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await tx.insert(flowRunSteps).values({
    tenantId,
    runId: run.id,
    seq: run.nextStepSeq,
    nodeId: node?.id ?? run.currentNodeId ?? "unknown",
    nodeType: node?.type ?? "unknown",
    detail,
    error: errorMessage.slice(0, 1000),
  });
  await tx
    .update(flowRuns)
    .set({
      status: "failed",
      errorCode,
      currentNodeId: null,
      stepCount: run.stepCount + 1,
      nextStepSeq: run.nextStepSeq + 1,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(flowRuns.id, run.id));
  await flowAudit(tx, tenantId, {
    actorType: "system",
    actorId: `flow:${run.flowId}`,
    action: "flow.run_failed",
    flowId: run.flowId,
    meta: {
      flowRunId: run.id,
      conversationId: run.conversationId,
      reason: errorCode,
      error: errorMessage.slice(0, 300),
    },
  });
}

// --- Eksekutor per tipe node (dalam transaksi) ------------------------------

interface NodeEffects {
  detail: Record<string, unknown>;
  branch?: FlowBranch;
  waitMs?: number;
  parkWaitReplyMs?: number;
  forceComplete?: boolean;
  outboundMessageId?: string;
  /** Fase 13E: tambalan/pembersihan context run (keadaan questionnaire). */
  contextPatch?: Record<string, unknown>;
  contextClear?: string[];
}

/**
 * Kegagalan keras satu node: run menjadi `failed`. `code` opsional
 * menjadi error_code run (default lapisan eksekutor: "step_error") —
 * dipakai kode spesifik seperti goto_depth_exceeded.
 */
class FlowNodeError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function executeNodeInTx(
  tx: DbTx,
  tenantId: string,
  ctx: RunContext,
  node: FlowGraphNode,
): Promise<NodeEffects> {
  const { run, graph } = ctx;
  const c = node.config;
  switch (node.type) {
    case "trigger":
      return { detail: { outcome: "passed" } };

    case "send_message": {
      const text = isNonEmptyString(c.text) ? c.text : "";
      if (!text) throw new FlowNodeError("send_message tanpa config.text");
      if (!ctx.conversation) {
        throw new FlowNodeError("percakapan run tidak ditemukan");
      }
      const rendered = renderMessageText(text, { name: ctx.contact?.name });
      const [outbound] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId: run.conversationId,
          direction: "outbound",
          senderType: "system",
          type: "text",
          contentText: rendered,
          status: "queued",
        })
        .returning();
      const now = new Date();
      await tx
        .update(conversations)
        .set({ lastMessageAt: now, updatedAt: now })
        .where(eq(conversations.id, run.conversationId));
      await tx.insert(outboxEvents).values({
        tenantId,
        type: "message.queued",
        payload: {
          provider: ctx.conversation.provider,
          conversationId: run.conversationId,
          messageId: outbound.id,
          via: "flow",
          flowId: run.flowId,
          runId: run.id,
        },
      });
      return {
        detail: { outcome: "queued", outboundMessageId: outbound.id },
        outboundMessageId: outbound.id,
      };
    }

    case "condition": {
      const contact = ctx.contact;
      const runContext = (run.context ?? {}) as { triggerText?: unknown };
      const triggerText =
        typeof runContext.triggerText === "string" ? runContext.triggerText : "";
      let result = false;
      if (c.predicate === "has_tag") {
        result = !!contact && contact.tags.includes(String(c.tag ?? ""));
      } else if (c.predicate === "stage_equals") {
        result = !!contact && contact.pipelineStage === String(c.stage ?? "");
      } else if (c.predicate === "field_equals") {
        const field = c.field === "phone" || c.field === "email" ? c.field : "name";
        const actual = contact ? contact[field] : null;
        result = actual !== null && actual === String(c.value ?? "");
      } else if (c.predicate === "message_contains") {
        result = normalizeText(triggerText).includes(
          normalizeText(String(c.text ?? "")),
        );
      } else {
        throw new FlowNodeError(`predicate tidak dikenal: ${String(c.predicate)}`);
      }
      return {
        detail: {
          outcome: "evaluated",
          predicate: String(c.predicate ?? ""),
          result,
        },
        branch: result ? "yes" : "no",
      };
    }

    case "delay": {
      const amount = typeof c.amount === "number" ? c.amount : NaN;
      const unitMs =
        c.unit === "seconds" ? 1_000 : c.unit === "minutes" ? 60_000 : c.unit === "hours" ? 3_600_000 : NaN;
      if (!Number.isFinite(amount) || !Number.isFinite(unitMs)) {
        throw new FlowNodeError("delay dengan config amount/unit tidak sah");
      }
      // Smart Delay (Fase 9A): config.random {min, max} yang sah
      // mengalahkan amount tetap — durasi dipilih acak bilangan bulat
      // dalam [min, max] pada satuan node, dan pilihan itu DICATAT di
      // detail langkah (chosenAmount + rentangnya) agar bisa diaudit.
      // Random yang rusak di graf aktif lama (pra-validasi) diabaikan:
      // jatuh ke amount, tidak pernah menggagalkan run.
      const r = c.random as { min?: unknown; max?: unknown } | undefined;
      const randomValid =
        typeof r === "object" &&
        r !== null &&
        typeof r.min === "number" &&
        Number.isInteger(r.min) &&
        typeof r.max === "number" &&
        Number.isInteger(r.max) &&
        r.min >= 1 &&
        r.max >= r.min;
      if (randomValid) {
        const min = r.min as number;
        const max = r.max as number;
        const chosenAmount = min + Math.floor(Math.random() * (max - min + 1));
        const waitMs = Math.max(0, Math.floor(chosenAmount * unitMs));
        return {
          detail: {
            outcome: "waiting",
            delayMs: waitMs,
            resumeAt: new Date(Date.now() + waitMs).toISOString(),
            random: { min, max, unit: String(c.unit) },
            chosenAmount,
          },
          waitMs,
        };
      }
      const waitMs = Math.max(0, Math.floor(amount * unitMs));
      return {
        detail: {
          outcome: "waiting",
          delayMs: waitMs,
          resumeAt: new Date(Date.now() + waitMs).toISOString(),
        },
        waitMs,
      };
    }

    case "add_tag":
    case "remove_tag": {
      if (!ctx.contact) throw new FlowNodeError("kontak run tidak ditemukan");
      const tag = String(c.tag ?? "");
      if (!tag) throw new FlowNodeError(`${node.type} tanpa config.tag`);
      const has = ctx.contact.tags.includes(tag);
      if (node.type === "add_tag" && !has) {
        await tx
          .update(contacts)
          .set({ tags: [...ctx.contact.tags, tag], updatedAt: new Date() })
          .where(eq(contacts.id, ctx.contact.id));
      }
      if (node.type === "remove_tag" && has) {
        await tx
          .update(contacts)
          .set({
            tags: ctx.contact.tags.filter((t) => t !== tag),
            updatedAt: new Date(),
          })
          .where(eq(contacts.id, ctx.contact.id));
      }
      return {
        detail: {
          outcome: node.type === "add_tag" ? "tag_added" : "tag_removed",
          tag,
          changed: node.type === "add_tag" ? !has : has,
        },
      };
    }

    case "set_stage": {
      if (!ctx.contact) throw new FlowNodeError("kontak run tidak ditemukan");
      const stage = String(c.stage ?? "");
      if (!stage) throw new FlowNodeError("set_stage tanpa config.stage");
      await tx
        .update(contacts)
        .set({ pipelineStage: stage, updatedAt: new Date() })
        .where(eq(contacts.id, ctx.contact.id));
      return {
        detail: {
          outcome: "stage_set",
          stage,
          previousStage: ctx.contact.pipelineStage,
        },
      };
    }

    case "enroll_sequence": {
      const automationId = String(c.automationId ?? "");
      if (!automationId) {
        throw new FlowNodeError("enroll_sequence tanpa config.automationId");
      }
      const [automation] = await tx
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.tenantId, tenantId),
            eq(automations.id, automationId),
          ),
        )
        .limit(1);
      if (!automation || automation.kind !== "sequence" || !automation.isActive) {
        // Sequence hilang/dinonaktifkan SETELAH aktivasi flow: langkah
        // dilewati beralasan, run lanjut — bukan kegagalan run.
        return {
          detail: { outcome: "skipped", reason: "sequence_unavailable", automationId },
        };
      }
      const steps = await tx
        .select()
        .from(automationSteps)
        .where(
          and(
            eq(automationSteps.tenantId, tenantId),
            eq(automationSteps.automationId, automationId),
          ),
        )
        .orderBy(asc(automationSteps.position));
      const firstStep = steps[0];
      if (!firstStep) {
        return {
          detail: { outcome: "skipped", reason: "no_steps", automationId },
        };
      }
      const [activeEnrollment] = await tx
        .select({ id: sequenceEnrollments.id })
        .from(sequenceEnrollments)
        .where(
          and(
            eq(sequenceEnrollments.automationId, automationId),
            eq(sequenceEnrollments.contactId, run.contactId),
            eq(sequenceEnrollments.status, "active"),
          ),
        )
        .limit(1);
      if (activeEnrollment) {
        await tx.insert(automationRuns).values({
          tenantId,
          automationId,
          contactId: run.contactId,
          conversationId: run.conversationId,
          triggerMessageId: run.triggerMessageId,
          status: "skipped",
          detail: {
            reason: "already_enrolled",
            enrollmentId: activeEnrollment.id,
            via: "flow",
            flowId: run.flowId,
            flowRunId: run.id,
          },
        });
        return {
          detail: {
            outcome: "skipped",
            reason: "already_enrolled",
            automationId,
            enrollmentId: activeEnrollment.id,
          },
        };
      }
      const now = new Date();
      const nextRunAt = new Date(now.getTime() + firstStep.delayMinutes * 60_000);
      const [enrollment] = await tx
        .insert(sequenceEnrollments)
        .values({
          tenantId,
          automationId,
          contactId: run.contactId,
          conversationId: run.conversationId,
          triggerMessageId: run.triggerMessageId,
          currentStep: 0,
          status: "active",
          nextRunAt,
        })
        .returning();
      const [autoRun] = await tx
        .insert(automationRuns)
        .values({
          tenantId,
          automationId,
          contactId: run.contactId,
          conversationId: run.conversationId,
          triggerMessageId: run.triggerMessageId,
          status: "completed",
          detail: {
            kind: "sequence",
            enrollmentId: enrollment.id,
            via: "flow",
            flowId: run.flowId,
            flowRunId: run.id,
          },
        })
        .returning();
      await tx.insert(auditLogs).values({
        tenantId,
        actorType: "system",
        actorId: `automation:${automationId}`,
        action: "sequence.enrolled",
        meta: {
          automationId,
          runId: autoRun.id,
          enrollmentId: enrollment.id,
          triggerMessageId: run.triggerMessageId,
          conversationId: run.conversationId,
          via: "flow",
          // Nama kunci via* disengaja: target audit sequence.enrolled
          // harus tetap sequence_enrollment (lihat deriveAuditTarget).
          viaFlowId: run.flowId,
          viaFlowRunId: run.id,
          firstStepPosition: firstStep.position,
          nextRunAt: nextRunAt.toISOString(),
        },
      });
      await tx.insert(outboxEvents).values({
        tenantId,
        type: "sequence.step_due",
        payload: {
          enrollmentId: enrollment.id,
          automationId,
          stepPosition: firstStep.position,
          delayMinutes: firstStep.delayMinutes,
        },
      });
      return {
        detail: { outcome: "enrolled", automationId, enrollmentId: enrollment.id },
      };
    }

    case "set_field": {
      if (!ctx.contact) throw new FlowNodeError("kontak run tidak ditemukan");
      const field = String(c.field ?? "");
      // Nilai dirender PERSIS seperti send_message ({name} + spintax).
      const rendered = renderMessageText(
        typeof c.value === "string" ? c.value : "",
        { name: ctx.contact.name },
      );
      const patch: Partial<Contact> = { updatedAt: new Date() };
      if (field === "name") {
        // Kolom name NOT NULL — hasil render kosong adalah kegagalan
        // langkah yang jujur, bukan penulisan nilai rusak.
        if (!rendered) {
          throw new FlowNodeError("set_field name menghasilkan nilai kosong");
        }
        patch.name = rendered;
      } else if (field === "phone" || field === "email") {
        patch[field] = rendered ? rendered : null;
      } else if (field.startsWith("custom:") && field.length > "custom:".length) {
        const key = field.slice("custom:".length);
        patch.customFields = {
          ...(ctx.contact.customFields as Record<string, unknown>),
          [key]: rendered,
        };
      } else {
        throw new FlowNodeError(`set_field dengan field tidak sah: ${field}`);
      }
      await tx
        .update(contacts)
        .set(patch)
        .where(eq(contacts.id, ctx.contact.id));
      return {
        detail: {
          outcome: "field_set",
          field,
          value: rendered.slice(0, 200),
        },
      };
    }

    case "ab_split": {
      const percentA = c.percentA;
      if (
        typeof percentA !== "number" ||
        !Number.isInteger(percentA) ||
        percentA < 1 ||
        percentA > 99
      ) {
        throw new FlowNodeError("ab_split dengan config.percentA tidak sah");
      }
      // Fase 13D — mode eksperimen: penugasan DETERMINISTIK dan
      // LENGKET per (flow, node, kontak). Penugasan pertama
      // dipersistenkan (unik flow+node+kontak) dan selalu menang —
      // kontak tidak berpindah varian walau percentA diubah di
      // tengah eksperimen atau run diulang berapa pun kali.
      if (c.experiment === true && ctx.contact) {
        const contactId = ctx.contact.id;
        const [existing] = await tx
          .select({
            branch: flowExperimentAssignments.branch,
            percentA: flowExperimentAssignments.percentA,
          })
          .from(flowExperimentAssignments)
          .where(
            and(
              eq(flowExperimentAssignments.tenantId, tenantId),
              eq(flowExperimentAssignments.flowId, run.flowId),
              eq(flowExperimentAssignments.nodeId, node.id),
              eq(flowExperimentAssignments.contactId, contactId),
            ),
          )
          .limit(1);
        if (existing) {
          const branch = existing.branch === "b" ? "b" : "a";
          return {
            detail: {
              outcome: "split",
              experiment: true,
              percentA: existing.percentA,
              branch,
              sticky: true,
            },
            branch,
          };
        }
        const bucket = experimentBucket(
          flowExperimentKey(run.flowId, node.id, contactId),
        );
        const branch = flowBranchForBucket(bucket, percentA);
        const label =
          typeof c.experimentLabel === "string" && c.experimentLabel
            ? c.experimentLabel.slice(0, 255)
            : null;
        const [inserted] = await tx
          .insert(flowExperimentAssignments)
          .values({
            tenantId,
            flowId: run.flowId,
            nodeId: node.id,
            contactId,
            runId: run.id,
            branch,
            label,
            percentA,
          })
          .onConflictDoNothing()
          .returning({ branch: flowExperimentAssignments.branch });
        if (!inserted) {
          // Balapan resume ganda: penugasan serentak dari run lain
          // menang — baca ulang dan pakai branch-nya (kelengketan
          // tidak boleh kalah oleh balapan).
          const [raced] = await tx
            .select({ branch: flowExperimentAssignments.branch })
            .from(flowExperimentAssignments)
            .where(
              and(
                eq(flowExperimentAssignments.tenantId, tenantId),
                eq(flowExperimentAssignments.flowId, run.flowId),
                eq(flowExperimentAssignments.nodeId, node.id),
                eq(flowExperimentAssignments.contactId, contactId),
              ),
            )
            .limit(1);
          const racedBranch = raced?.branch === "b" ? "b" : branch;
          return {
            detail: {
              outcome: "split",
              experiment: true,
              percentA,
              bucket,
              branch: racedBranch,
              sticky: true,
            },
            branch: racedBranch,
          };
        }
        return {
          detail: {
            outcome: "split",
            experiment: true,
            percentA,
            bucket,
            branch,
            sticky: false,
          },
          branch,
        };
      }
      // Acak per run (12A, tanpa mode eksperimen); hasil undian
      // DICATAT agar distribusi bisa diaudit dari log langkah.
      const roll = Math.floor(Math.random() * 100);
      const branch = roll < percentA ? ("a" as const) : ("b" as const);
      return {
        detail: { outcome: "split", percentA, roll, branch },
        branch,
      };
    }

    case "wait_reply": {
      const amount = typeof c.amount === "number" ? c.amount : NaN;
      const unitMs =
        c.unit === "seconds" ? 1_000 : c.unit === "minutes" ? 60_000 : c.unit === "hours" ? 3_600_000 : NaN;
      if (!Number.isFinite(amount) || !Number.isFinite(unitMs)) {
        throw new FlowNodeError("wait_reply dengan config amount/unit tidak sah");
      }
      const waitMs = Math.max(0, Math.floor(amount * unitMs));
      return {
        detail: {
          outcome: "waiting",
          waitMs,
          deadline: new Date(Date.now() + waitMs).toISOString(),
          amount,
          unit: String(c.unit),
        },
        parkWaitReplyMs: waitMs,
      };
    }

    case "questionnaire": {
      if (!ctx.contact) throw new FlowNodeError("kontak run tidak ditemukan");
      if (!ctx.conversation) {
        throw new FlowNodeError("percakapan run tidak ditemukan");
      }
      const config = questionnaireConfigOf(node);
      if (config.questions.length === 0) {
        throw new FlowNodeError("questionnaire tanpa pertanyaan yang sah");
      }
      const state: QuestionnaireRunState = {
        nodeId: node.id,
        qIndex: 0,
        attempts: 0,
        answers: [],
        startedAt: new Date().toISOString(),
      };
      const hasCustomTargets = config.questions.some(
        (q) => questionnaireTargetKey(q.target) !== null,
      );
      const knownKeys = hasCustomTargets
        ? await tenantCustomFieldKeys(tx, tenantId)
        : new Set<string>();
      const gate = skipMissingQuestionnaireTargets(state, config, knownKeys);
      if (gate.kind === "missing_required") {
        // Target wajib sudah hilang sebelum pertanyaan pertama
        // sempat dikirim → keluar invalid tanpa mengirim apa pun.
        return {
          detail: {
            outcome: "target_missing",
            questionId: gate.question.id,
            target: gate.question.target,
            answers: state.answers,
          },
          branch: "invalid" as const,
        };
      }
      if (gate.kind === "finished") {
        // Semua pertanyaan opsional yang targetnya hilang: kuesioner
        // selesai tanpa satu pun pertanyaan terkirim.
        if (config.completionTag && !ctx.contact.tags.includes(config.completionTag)) {
          await tx
            .update(contacts)
            .set({
              tags: [...ctx.contact.tags, config.completionTag],
              updatedAt: new Date(),
            })
            .where(eq(contacts.id, ctx.contact.id));
        }
        return {
          detail: { outcome: "completed", answers: state.answers },
          branch: "completed" as const,
        };
      }
      const question = config.questions[gate.index];
      const outboundId = await queueFlowOutboundText(
        tx,
        tenantId,
        run,
        ctx.conversation,
        renderQuestionnairePrompt(question, ctx.contact),
      );
      return {
        detail: {
          outcome: "question_asked",
          questionIndex: gate.index,
          questionId: question.id,
          questionCount: config.questions.length,
          ...(state.answers.length > 0 ? { answers: state.answers } : {}),
          outboundMessageId: outboundId,
        },
        parkWaitReplyMs: config.timeoutMs,
        contextPatch: { questionnaire: state },
        outboundMessageId: outboundId,
      };
    }

    case "show_catalog": {
      if (!ctx.contact) throw new FlowNodeError("kontak run tidak ditemukan");
      if (!ctx.conversation) {
        throw new FlowNodeError("percakapan run tidak ditemukan");
      }
      const config = catalogConfigOf(node);
      const listed = await listActiveCatalogProductsTx(tx, tenantId);
      if (listed.length === 0) {
        // Katalog kosong adalah kegagalan keras yang tercatat —
        // mengirim daftar kosong lalu parkir akan menggantung kontak.
        throw new FlowNodeError(
          "show_catalog tanpa produk aktif",
          "catalog_empty",
        );
      }
      const intro = config.introText
        ? renderMessageText(config.introText, { name: ctx.contact.name })
        : null;
      const outboundId = await queueFlowOutboundText(
        tx,
        tenantId,
        run,
        ctx.conversation,
        renderCatalogText(listed, {
          introText: intro,
          showDescription: config.showDescription,
        }),
      );
      const state: CatalogRunState = {
        nodeId: node.id,
        productIds: listed.map((p) => p.id),
        attempts: 0,
        listedAt: new Date().toISOString(),
      };
      return {
        detail: {
          outcome: "catalog_shown",
          productCount: listed.length,
          productIds: state.productIds,
          outboundMessageId: outboundId,
        },
        parkWaitReplyMs: config.timeoutMs,
        contextPatch: { catalog: state },
        outboundMessageId: outboundId,
      };
    }

    case "goto_flow": {
      const targetId = String(c.flowId ?? "");
      if (!targetId || !isUuidLike(targetId)) {
        throw new FlowNodeError(
          "flow tujuan goto tidak ada atau tidak aktif",
          "goto_target_unavailable",
        );
      }
      const runCtx = runContextOf(run);
      const depth = runCtx.gotoDepth ?? 0;
      // Pengaman siklus: kedalaman dibawa di konteks dan diwariskan ke
      // run tujuan; goto yang melewati batas GAGAL (run asal failed),
      // bukan diam-diam berhenti — operator harus melihat siklusnya.
      if (depth + 1 > FLOW_GOTO_MAX_DEPTH) {
        throw new FlowNodeError(
          `rantai goto melebihi kedalaman maksimum ${FLOW_GOTO_MAX_DEPTH}`,
          "goto_depth_exceeded",
        );
      }
      const [target] = await tx
        .select()
        .from(flows)
        .where(and(eq(flows.tenantId, tenantId), eq(flows.id, targetId)))
        .limit(1);
      if (!target || target.status !== "active") {
        throw new FlowNodeError(
          "flow tujuan goto tidak ada atau tidak aktif",
          "goto_target_unavailable",
        );
      }
      const targetGraph = normalizeFlowGraph(target.graph);
      const firstNodeId = firstNodeAfterTrigger(targetGraph);
      const now = new Date();
      const rootTriggerMessageId = effectiveTriggerMessageId(run);
      const [newRun] = await tx
        .insert(flowRuns)
        .values({
          tenantId,
          flowId: target.id,
          conversationId: run.conversationId,
          contactId: run.contactId,
          // Run goto tidak dipicu pesan masuk (migrasi 0038).
          triggerMessageId: null,
          status: firstNodeId ? "running" : "completed",
          currentNodeId: firstNodeId,
          nextStepSeq: 1,
          stepCount: 0,
          context: {
            triggerText: runCtx.triggerText ?? "",
            gotoDepth: depth + 1,
            ...(rootTriggerMessageId ? { rootTriggerMessageId } : {}),
            viaGoto: {
              fromRunId: run.id,
              fromFlowId: run.flowId,
              nodeId: node.id,
            },
          },
          completedAt: firstNodeId ? null : now,
        })
        .returning();
      await flowAudit(tx, tenantId, {
        actorType: "system",
        actorId: `flow:${target.id}`,
        action: "flow.run_started",
        flowId: target.id,
        meta: {
          flowRunId: newRun.id,
          conversationId: run.conversationId,
          via: "goto",
          fromRunId: run.id,
          fromFlowId: run.flowId,
          gotoDepth: depth + 1,
        },
      });
      if (!firstNodeId) {
        await flowAudit(tx, tenantId, {
          actorType: "system",
          actorId: `flow:${target.id}`,
          action: "flow.run_completed",
          flowId: target.id,
          meta: {
            flowRunId: newRun.id,
            conversationId: run.conversationId,
            reason: "empty_flow",
          },
        });
      } else {
        await tx.insert(outboxEvents).values({
          tenantId,
          type: "flow.step_due",
          payload: {
            runId: newRun.id,
            stepSeq: 1,
            resumeAt: now.toISOString(),
          },
        });
      }
      return {
        detail: {
          outcome: "goto",
          targetFlowId: target.id,
          targetRunId: newRun.id,
          gotoDepth: depth + 1,
        },
        // Run asal selesai di sini — kelanjutannya hidup di run tujuan.
        forceComplete: true,
      };
    }

    case "handoff": {
      await tx
        .update(conversations)
        .set({ agentEnabled: false, updatedAt: new Date() })
        .where(eq(conversations.id, run.conversationId));
      await tx.insert(auditLogs).values({
        tenantId,
        actorType: "system",
        actorId: `flow:${run.flowId}`,
        action: "agent.handoff",
        meta: {
          flowId: run.flowId,
          flowRunId: run.id,
          conversationId: run.conversationId,
          via: "flow",
        },
      });
      return { detail: { outcome: "handed_off" } };
    }

    case "end":
      return { detail: { outcome: "ended" }, forceComplete: true };

    default:
      throw new FlowNodeError(`tipe node tidak dikenal: ${node.type}`);
  }
}

/**
 * Menjalankan run flow untuk job BullMQ `flow.step`. Aman dipanggil
 * berulang: job basi (stepSeq != next_step_seq) dan run terminal
 * selesai diam-diam tanpa efek. Satu pemanggilan menjalankan node
 * demi node (transaksi per node) sampai run menunggu di node delay
 * atau mencapai status terminal.
 */
export async function executeFlowStep(
  db: Database,
  input: { tenantId: string; runId: string; stepSeq: number },
  deps: FlowStepDeps = {},
): Promise<ExecuteFlowStepResult> {
  const { tenantId, runId, stepSeq } = input;

  const initial = await loadRunContext(db, tenantId, runId);
  if (!initial) return { executed: false, reason: "run_not_found" };
  if (isTerminalStatus(initial.run.status)) {
    return {
      executed: false,
      reason: "run_terminal",
      status: initial.run.status,
      conversationId: initial.run.conversationId,
    };
  }
  if (stepSeq !== initial.run.nextStepSeq) {
    return {
      executed: false,
      reason: "stale_step",
      status: initial.run.status,
      conversationId: initial.run.conversationId,
    };
  }

  // Aturan berhenti opt-out: diperiksa saat resume/eksekusi (pasangan
  // pembatalan di jalur evaluasi pesan masuk).
  if (initial.contact?.optInStatus === "opted_out") {
    await withTenantDb(db, tenantId, async (tx) => {
      const now = new Date();
      await tx
        .update(flowRuns)
        .set({
          status: "cancelled",
          errorCode: "contact_opted_out",
          currentNodeId: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(flowRuns.id, runId),
            or(eq(flowRuns.status, "running"), eq(flowRuns.status, "waiting")),
          ),
        );
      await flowAudit(tx, tenantId, {
        actorType: "system",
        actorId: `flow:${initial.run.flowId}`,
        action: "flow.run_cancelled",
        flowId: initial.run.flowId,
        meta: {
          flowRunId: runId,
          conversationId: initial.run.conversationId,
          reason: "contact_opted_out",
        },
      });
    });
    return {
      executed: false,
      reason: "contact_opted_out",
      status: "cancelled",
      conversationId: initial.run.conversationId,
    };
  }

  let stepsExecuted = 0;
  let lastOutboundMessageId: string | undefined;

  for (;;) {
    const ctxState = await loadRunContext(db, tenantId, runId);
    if (!ctxState) return { executed: stepsExecuted > 0, reason: "run_not_found", stepsExecuted };
    const { run, graph } = ctxState;
    if (isTerminalStatus(run.status)) {
      return {
        executed: stepsExecuted > 0,
        status: run.status,
        conversationId: run.conversationId,
        outboundMessageId: lastOutboundMessageId,
        stepsExecuted,
      };
    }

    // Resume run waiting yang node terakhirnya delay di ujung graf:
    // tidak ada node tersisa → selesaikan.
    if (!run.currentNodeId) {
      await withTenantDb(db, tenantId, async (tx) => {
        const now = new Date();
        await tx
          .update(flowRuns)
          .set({ status: "completed", completedAt: now, updatedAt: now })
          .where(eq(flowRuns.id, runId));
        await flowAudit(tx, tenantId, {
          actorType: "system",
          actorId: `flow:${run.flowId}`,
          action: "flow.run_completed",
          flowId: run.flowId,
          meta: {
            flowRunId: runId,
            conversationId: run.conversationId,
            stepCount: run.stepCount,
            reason: "delay_tail",
          },
        });
      });
      return {
        executed: true,
        status: "completed",
        conversationId: run.conversationId,
        outboundMessageId: lastOutboundMessageId,
        stepsExecuted,
      };
    }

    const node = graph.nodes.find((n) => n.id === run.currentNodeId);
    if (!node) {
      await withTenantDb(db, tenantId, (tx) =>
        failRun(tx, tenantId, run, null, "node_missing", `node tidak ditemukan di graf: ${run.currentNodeId}`, { outcome: "failed", reason: "node_missing" }),
      );
      return {
        executed: stepsExecuted > 0,
        status: "failed",
        conversationId: run.conversationId,
        stepsExecuted,
      };
    }

    // Fase 12A — run parkir di wait_reply: job yang tiba adalah job
    // tenggatnya (seq sudah dicocokkan di pintu masuk). Bila run masih
    // parkir saat job ini diproses, tenggat lewat tanpa balasan →
    // selesaikan parkir lewat branch "timeout", lalu loop lanjut ke
    // node cabang seperti langkah biasa. Balasan yang datang lebih
    // dulu sudah menyelesaikan parkir (context.wait hilang / status
    // berubah) sehingga pemeriksaan segar di dalam transaksi menolak.
    // Fase 13E — node questionnaire parkir memakai penanda yang sama:
    // tenggat PERTANYAAN berjalan lewat → keluar branch "timeout"
    // dengan transkrip parsial (jawaban yang sudah masuk tetap
    // tersimpan di field kontak — ditulis saat dijawab).
    // Fase 13F — node show_catalog parkir memakai penanda yang sama:
    // tenggat pilihan lewat → keluar branch "timeout" (item yang
    // sudah masuk keranjang dari parkir SEBELUMNYA tetap di keranjang
    // — keranjang adalah keadaan kontak, bukan keadaan run).
    const parkedCtx = runContextOf(run);
    if (
      run.status === "waiting" &&
      (node.type === "wait_reply" ||
        node.type === "questionnaire" ||
        node.type === "show_catalog" ||
        node.type === "book_appointment") &&
      parkedCtx.wait &&
      parkedCtx.wait.nodeId === node.id
    ) {
      const resolved: AdvanceResult = await withTenantDb(
        db,
        tenantId,
        async (tx) => {
          const [fresh] = await tx
            .select()
            .from(flowRuns)
            .where(and(eq(flowRuns.tenantId, tenantId), eq(flowRuns.id, runId)))
            .limit(1);
          if (!fresh || isTerminalStatus(fresh.status)) {
            return { applied: false, reason: "run_terminal" as const };
          }
          const freshCtx = runContextOf(fresh);
          if (
            fresh.status !== "waiting" ||
            !freshCtx.wait ||
            freshCtx.wait.nodeId !== node.id ||
            fresh.nextStepSeq !== run.nextStepSeq
          ) {
            return { applied: false, reason: "stale_step" as const };
          }
          const parkedAtMs = Date.parse(freshCtx.wait.parkedAt);
          const waitedMs = Number.isNaN(parkedAtMs)
            ? null
            : Math.max(0, Date.now() - parkedAtMs);
          if (node.type === "book_appointment") {
            const aState = freshCtx.appointment;
            const r = await exitParkedAppointment(
              tx,
              tenantId,
              fresh,
              graph,
              node,
              {
                branch: "timeout",
                detail: {
                  outcome: "timeout",
                  deadline: freshCtx.wait.deadline,
                  waitedMs,
                  attempts: aState?.attempts ?? null,
                  slotCount: aState?.offeredSlots.length ?? null,
                  serviceId: aState?.serviceId ?? null,
                },
              },
            );
            return { applied: true, status: r.status };
          }
          if (node.type === "show_catalog") {
            const cState = freshCtx.catalog;
            const r = await exitParkedCatalog(
              tx,
              tenantId,
              fresh,
              graph,
              node,
              {
                branch: "timeout",
                detail: {
                  outcome: "timeout",
                  deadline: freshCtx.wait.deadline,
                  waitedMs,
                  attempts: cState?.attempts ?? null,
                  productCount: cState?.productIds.length ?? null,
                },
              },
            );
            return { applied: true, status: r.status };
          }
          if (node.type === "questionnaire") {
            const qState = freshCtx.questionnaire;
            const currentQuestion =
              qState && qState.nodeId === node.id
                ? questionnaireConfigOf(node).questions[qState.qIndex]
                : undefined;
            const r = await exitParkedQuestionnaire(
              tx,
              tenantId,
              fresh,
              graph,
              node,
              {
                branch: "timeout",
                config: questionnaireConfigOf(node),
                detail: {
                  outcome: "timeout",
                  deadline: freshCtx.wait.deadline,
                  waitedMs,
                  questionIndex: qState?.qIndex ?? null,
                  questionId: currentQuestion?.id ?? null,
                  answers: qState?.answers ?? [],
                },
              },
            );
            return { applied: true, status: r.status };
          }
          const r = await resolveParkedWaitReply(
            tx,
            tenantId,
            fresh,
            graph,
            node,
            {
              branch: "timeout",
              extraDetail: {
                deadline: freshCtx.wait.deadline,
                waitedMs,
              },
            },
          );
          return { applied: true, status: r.status };
        },
      );
      if (!resolved.applied) {
        return {
          executed: stepsExecuted > 0,
          reason:
            resolved.reason === "stale_step" ? "stale_step" : "run_terminal",
          conversationId: run.conversationId,
          stepsExecuted,
        };
      }
      stepsExecuted += 1;
      if (isTerminalStatus(resolved.status!)) {
        return {
          executed: true,
          status: resolved.status,
          conversationId: run.conversationId,
          outboundMessageId: lastOutboundMessageId,
          stepsExecuted,
        };
      }
      continue;
    }

    // Cap langkah: graf melingkar tanpa delay berhenti di sini.
    if (run.stepCount >= FLOW_MAX_STEPS) {
      await withTenantDb(db, tenantId, (tx) =>
        failRun(
          tx,
          tenantId,
          run,
          node,
          "step_cap_exceeded",
          `cap ${FLOW_MAX_STEPS} langkah per run tercapai`,
          { outcome: "cap_exceeded", stepCap: FLOW_MAX_STEPS },
        ),
      );
      return {
        executed: stepsExecuted > 0,
        status: "failed",
        conversationId: run.conversationId,
        stepsExecuted,
      };
    }

    // Node ai_response: panggil jalur agent.respond yang ada DI LUAR
    // transaksi langkah (panggilan LLM tidak boleh menahan transaksi).
    // Hasil apa pun (termasuk skipped) dicatat sebagai langkah; run
    // lanjut — agent yang tidak tersedia BUKAN kegagalan flow.
    if (node.type === "ai_response") {
      let detail: Record<string, unknown>;
      // Run goto tidak punya trigger_message_id sendiri — pakai pesan
      // pemicu run akar dari konteks (Fase 12A).
      const aiMessageId = effectiveTriggerMessageId(run);
      if (!aiMessageId) {
        detail = { outcome: "skipped", reason: "no_trigger_message" };
      } else if (!deps.resolveLlmProvider) {
        detail = { outcome: "skipped", reason: "llm_unavailable" };
      } else {
        try {
          const provider = await deps.resolveLlmProvider();
          const embeddingProvider = deps.resolveEmbeddingProvider
            ? await deps.resolveEmbeddingProvider().catch(() => null)
            : null;
          const res = await respondToInboundMessage(db, provider, {
            tenantId,
            conversationId: run.conversationId,
            messageId: aiMessageId,
            publicBaseUrl: deps.publicBaseUrl,
            payments: deps.payments,
            embeddingProvider,
          });
          detail = {
            outcome: res.responded ? "responded" : "skipped",
            ...(res.reason ? { reason: res.reason } : {}),
            ...(res.mode ? { mode: res.mode } : {}),
            ...(res.outboundMessageId
              ? { outboundMessageId: res.outboundMessageId }
              : {}),
            ...(res.suggestionId ? { suggestionId: res.suggestionId } : {}),
          };
          if (res.outboundMessageId) {
            lastOutboundMessageId = res.outboundMessageId;
          }
        } catch {
          detail = { outcome: "skipped", reason: "provider_error" };
        }
      }
      const applied: AdvanceResult = await withTenantDb(db, tenantId, async (tx) => {
        const [fresh] = await tx
          .select()
          .from(flowRuns)
          .where(and(eq(flowRuns.tenantId, tenantId), eq(flowRuns.id, runId)))
          .limit(1);
        if (!fresh || isTerminalStatus(fresh.status)) {
          return { applied: false, reason: "run_terminal" as const };
        }
        if (fresh.nextStepSeq !== run.nextStepSeq) {
          return { applied: false, reason: "stale_step" as const };
        }
        const adv = await advanceRun(tx, tenantId, fresh, graph, node, { detail });
        return { applied: true, status: adv.status };
      });
      if (!applied.applied) {
        return {
          executed: stepsExecuted > 0,
          reason: applied.reason === "stale_step" ? "stale_step" : "run_terminal",
          conversationId: run.conversationId,
          stepsExecuted,
        };
      }
      stepsExecuted += 1;
      if (applied.status === "waiting" || isTerminalStatus(applied.status!)) {
        return {
          executed: true,
          status: applied.status,
          conversationId: run.conversationId,
          outboundMessageId: lastOutboundMessageId,
          stepsExecuted,
        };
      }
      continue;
    }

    // Node http_request (Fase 12A): fetch DI LUAR transaksi langkah.
    // Node ini TIDAK PERNAH menggagalkan run (keputusan desain di
    // kontrak): config rusak, jaringan mati, dan non-2xx semuanya
    // menjadi detail langkah `http_error` dan run lanjut ke node
    // berikutnya. saveToField hanya menulis pada respons 2xx.
    if (node.type === "http_request") {
      const c = node.config;
      const contact = ctxState.contact;
      const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(
        String(c.method),
      )
        ? String(c.method)
        : "POST";
      const url = renderFlowHttpTemplate(
        typeof c.url === "string" ? c.url : "",
        contact,
      );
      const headers: Record<string, string> = {};
      if (
        typeof c.headers === "object" &&
        c.headers !== null &&
        !Array.isArray(c.headers)
      ) {
        for (const [k, v] of Object.entries(
          c.headers as Record<string, unknown>,
        )) {
          if (typeof v === "string") {
            headers[k] = renderFlowHttpTemplate(v, contact);
          }
        }
      }
      const bodyText =
        typeof c.body === "string"
          ? renderFlowHttpTemplate(c.body, contact)
          : "";
      const saveFieldRaw =
        typeof c.saveToField === "string" ? c.saveToField : "";
      const saveKey =
        saveFieldRaw.startsWith("custom:") && saveFieldRaw.length > 7
          ? saveFieldRaw.slice("custom:".length)
          : null;
      const startedAtMs = Date.now();
      let httpStatus: number | null = null;
      let responseText = "";
      let errorText: string | null = null;
      if (!url) {
        errorText = "url_kosong";
      } else {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          FLOW_HTTP_TIMEOUT_MS,
        );
        try {
          const sendBody = method !== "GET" && bodyText.length > 0;
          const hasContentType = Object.keys(headers).some(
            (k) => k.toLowerCase() === "content-type",
          );
          const res = await fetch(url, {
            method,
            headers: {
              ...(sendBody && !hasContentType
                ? { "content-type": "application/json" }
                : {}),
              ...headers,
            },
            ...(sendBody ? { body: bodyText } : {}),
            signal: controller.signal,
            redirect: "follow",
          });
          httpStatus = res.status;
          responseText = (await res.text()).slice(0, 10_000);
        } catch (err) {
          errorText =
            err instanceof Error
              ? `${err.name}: ${err.message}`.slice(0, 300)
              : "network_error";
        } finally {
          clearTimeout(timer);
        }
      }
      const httpOk =
        httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
      const detail: Record<string, unknown> = {
        outcome: httpOk ? "http_response" : "http_error",
        method,
        url: url.slice(0, 300),
        status: httpStatus,
        durationMs: Date.now() - startedAtMs,
        responsePreview: responseText.slice(0, 500),
        ...(errorText ? { error: errorText } : {}),
        ...(saveKey && httpOk ? { savedToField: `custom:${saveKey}` } : {}),
      };
      const applied: AdvanceResult = await withTenantDb(
        db,
        tenantId,
        async (tx) => {
          const [fresh] = await tx
            .select()
            .from(flowRuns)
            .where(and(eq(flowRuns.tenantId, tenantId), eq(flowRuns.id, runId)))
            .limit(1);
          if (!fresh || isTerminalStatus(fresh.status)) {
            return { applied: false, reason: "run_terminal" as const };
          }
          if (fresh.nextStepSeq !== run.nextStepSeq) {
            return { applied: false, reason: "stale_step" as const };
          }
          if (saveKey && httpOk) {
            const [freshContact] = await tx
              .select({ customFields: contacts.customFields })
              .from(contacts)
              .where(eq(contacts.id, run.contactId))
              .limit(1);
            if (freshContact) {
              await tx
                .update(contacts)
                .set({
                  customFields: {
                    ...(freshContact.customFields as Record<string, unknown>),
                    [saveKey]: responseText.slice(0, 2000),
                  },
                  updatedAt: new Date(),
                })
                .where(eq(contacts.id, run.contactId));
            }
          }
          const adv = await advanceRun(tx, tenantId, fresh, graph, node, {
            detail,
          });
          return { applied: true, status: adv.status };
        },
      );
      if (!applied.applied) {
        return {
          executed: stepsExecuted > 0,
          reason:
            applied.reason === "stale_step" ? "stale_step" : "run_terminal",
          conversationId: run.conversationId,
          stepsExecuted,
        };
      }
      stepsExecuted += 1;
      if (applied.status === "waiting" || isTerminalStatus(applied.status!)) {
        return {
          executed: true,
          status: applied.status,
          conversationId: run.conversationId,
          outboundMessageId: lastOutboundMessageId,
          stepsExecuted,
        };
      }
      continue;
    }

    // Node book_appointment (Fase 13G): daftar slot dihitung mesin
    // slot inti DI LUAR transaksi langkah (freebusy Google adalah
    // HTTP — pola ai_response); transaksi hanya menulis baris langkah
    // + pesan daftar + keadaan parkir. Layanan hilang/nonaktif =
    // kegagalan keras tercatat (pola show_catalog); nol slot = pesan
    // bawaan + keluar branch "invalid" beralasan no_slots (memarkir
    // daftar kosong akan menggantung kontak).
    if (node.type === "book_appointment") {
      const config = appointmentConfigOf(node);
      const offerNow = new Date();
      const offer = config.serviceId
        ? await getBookableSlots(
            db,
            tenantId,
            config.serviceId,
            {
              from: offerNow,
              to: new Date(
                offerNow.getTime() + config.daysAhead * 86_400_000,
              ),
              now: offerNow,
            },
            deps.google,
          ).catch(() => null)
        : null;
      const applied: AdvanceResult = await withTenantDb(
        db,
        tenantId,
        async (tx) => {
          const [fresh] = await tx
            .select()
            .from(flowRuns)
            .where(and(eq(flowRuns.tenantId, tenantId), eq(flowRuns.id, runId)))
            .limit(1);
          if (!fresh || isTerminalStatus(fresh.status)) {
            return { applied: false, reason: "run_terminal" as const };
          }
          if (fresh.nextStepSeq !== run.nextStepSeq) {
            return { applied: false, reason: "stale_step" as const };
          }
          if (!ctxState.conversation || !ctxState.contact) {
            await failRun(
              tx,
              tenantId,
              fresh,
              node,
              "step_error",
              "percakapan/kontak run tidak ditemukan",
              { outcome: "failed" },
            );
            return { applied: true, status: "failed" as const };
          }
          if (!offer || !offer.service.isActive) {
            await failRun(
              tx,
              tenantId,
              fresh,
              node,
              "appointment_service_unavailable",
              offer
                ? "layanan janji node book_appointment nonaktif"
                : "layanan janji node book_appointment tidak ditemukan",
              {
                outcome: "failed",
                reason: "appointment_service_unavailable",
                serviceId: config.serviceId,
              },
            );
            return { applied: true, status: "failed" as const };
          }
          if (offer.slots.length === 0) {
            const outboundId = await queueFlowOutboundText(
              tx,
              tenantId,
              fresh,
              ctxState.conversation,
              APPOINTMENT_DEFAULT_NO_SLOTS_MESSAGE,
            );
            const adv = await advanceRun(tx, tenantId, fresh, graph, node, {
              detail: {
                outcome: "no_slots",
                serviceId: offer.service.id,
                daysAhead: config.daysAhead,
                outboundMessageId: outboundId,
              },
              branch: "invalid",
            });
            return {
              applied: true,
              status: adv.status,
              outboundMessageId: outboundId,
            };
          }
          const offered = offer.slots.slice(0, config.slotsPerMessage);
          const outboundId = await queueFlowOutboundText(
            tx,
            tenantId,
            fresh,
            ctxState.conversation,
            renderSlotListText(offered, offer.settings.timezone),
          );
          const state: AppointmentRunState = {
            nodeId: node.id,
            serviceId: offer.service.id,
            offeredSlots: offered.map((s) => ({
              startsAt: s.startsAt.toISOString(),
              endsAt: s.endsAt.toISOString(),
            })),
            attempts: 0,
            listedAt: new Date().toISOString(),
          };
          const adv = await advanceRun(tx, tenantId, fresh, graph, node, {
            detail: {
              outcome: "slots_offered",
              serviceId: offer.service.id,
              slotCount: offered.length,
              offeredStartsAt: state.offeredSlots.map((s) => s.startsAt),
              outboundMessageId: outboundId,
            },
            parkWaitReplyMs: config.timeoutMs,
            contextPatch: { appointment: state },
          });
          return {
            applied: true,
            status: adv.status,
            outboundMessageId: outboundId,
          };
        },
      );
      if (!applied.applied) {
        return {
          executed: stepsExecuted > 0,
          reason:
            applied.reason === "stale_step" ? "stale_step" : "run_terminal",
          conversationId: run.conversationId,
          stepsExecuted,
        };
      }
      stepsExecuted += 1;
      if (applied.outboundMessageId) {
        lastOutboundMessageId = applied.outboundMessageId;
      }
      if (applied.status === "waiting" || isTerminalStatus(applied.status!)) {
        return {
          executed: true,
          status: applied.status,
          conversationId: run.conversationId,
          outboundMessageId: lastOutboundMessageId,
          stepsExecuted,
        };
      }
      continue;
    }

    // Node cart_checkout (Fase 13F): checkout atomik di core commerce
    // (order + tautan order + keranjang checked_out dalam SATU
    // transaksi tenant di sini) + pesan ringkasan/tautan antre dalam
    // transaksi yang sama. Berbeda dari send_payment_link, checkout
    // yang kosong BUKAN kegagalan: ia branch empty_cart yang sah.
    if (node.type === "cart_checkout") {
      const checkoutConfig = cartCheckoutConfigOf(node);
      // Fase 14A: untuk provider sungguhan, sesi checkout provider
      // disiapkan DI LUAR transaksi langkah (panggilan API tidak boleh
      // menahan transaksi) dari total keranjang yang dibaca sekarang.
      // Kegagalan provider = kegagalan keras run (payment_provider_error)
      // — checkout tidak pernah jatuh diam-diam ke tautan simulasi.
      let preparedLink: Awaited<
        ReturnType<typeof prepareOrderCheckoutLink>
      > = null;
      if (ctxState.conversation && ctxState.contact) {
        const cartView = await getCartView(
          db,
          { tenantId },
          run.contactId,
        );
        if (cartView && cartView.items.length > 0) {
          try {
            preparedLink = await prepareOrderCheckoutLink(
              db,
              tenantId,
              {
                ...deps.payments,
                publicBaseUrl:
                  deps.payments?.publicBaseUrl ?? deps.publicBaseUrl,
              },
              {
                amountIdr: cartView.totalIdr,
                itemLabel: `Order: ${cartView.items
                  .map((i) => i.productName)
                  .join(", ")}`,
              },
            );
          } catch (err) {
            if (err instanceof PaymentProviderError) {
              await withTenantDb(db, tenantId, (tx) =>
                failRun(
                  tx,
                  tenantId,
                  run,
                  node,
                  "payment_provider_error",
                  `checkout gagal di provider: ${err.code}`,
                  {
                    outcome: "failed",
                    reason: "payment_provider_error",
                    provider: err.provider,
                    code: err.code,
                  },
                ),
              );
              return {
                executed: true,
                status: "failed",
                conversationId: run.conversationId,
                stepsExecuted: stepsExecuted + 1,
              };
            }
            throw err;
          }
        }
      }
      let applied: AdvanceResult;
      try {
        applied = await withTenantDb(
        db,
        tenantId,
        async (tx) => {
          const [fresh] = await tx
            .select()
            .from(flowRuns)
            .where(and(eq(flowRuns.tenantId, tenantId), eq(flowRuns.id, runId)))
            .limit(1);
          if (!fresh || isTerminalStatus(fresh.status)) {
            return { applied: false, reason: "run_terminal" as const };
          }
          if (fresh.nextStepSeq !== run.nextStepSeq) {
            return { applied: false, reason: "stale_step" as const };
          }
          if (!ctxState.conversation || !ctxState.contact) {
            await failRun(
              tx,
              tenantId,
              fresh,
              node,
              "step_error",
              "percakapan/kontak run tidak ditemukan",
              { outcome: "failed" },
            );
            return { applied: true, status: "failed" as const };
          }
          const result = await checkoutCartTx(tx, tenantId, {
            contactId: fresh.contactId,
            conversationId: fresh.conversationId,
            actor: { actorType: "system", actorId: `flow:${run.flowId}` },
            preparedLink,
          });
          if (result.kind === "empty_cart") {
            let outboundMessageId: string | undefined;
            if (checkoutConfig.emptyMessage) {
              outboundMessageId = await queueFlowOutboundText(
                tx,
                tenantId,
                fresh,
                ctxState.conversation,
                renderMessageText(checkoutConfig.emptyMessage, {
                  name: ctxState.contact.name,
                }),
              );
            }
            const adv = await advanceRun(tx, tenantId, fresh, graph, node, {
              detail: { outcome: "empty_cart" },
              branch: "empty_cart",
            });
            return {
              applied: true,
              status: adv.status,
              outboundMessageId,
            };
          }
          const paymentUrl = buildPaymentUrl(
            deps.publicBaseUrl,
            result.link.code,
          );
          const checkoutText = `${renderCartSummaryText(result.view)}\nLink pembayaran: ${paymentUrl} (berlaku ${PAYMENT_LINK_TTL_DAYS} hari)`;
          const outboundId = await queueFlowOutboundText(
            tx,
            tenantId,
            fresh,
            ctxState.conversation,
            checkoutText,
          );
          const adv = await advanceRun(tx, tenantId, fresh, graph, node, {
            detail: {
              outcome: "checked_out",
              orderId: result.order.id,
              paymentLinkId: result.link.id,
              code: result.link.code,
              totalIdr: result.order.totalIdr,
              itemCount: result.view.itemCount,
            },
            branch: "checked_out",
          });
          return {
            applied: true,
            status: adv.status,
            outboundMessageId: outboundId,
          };
        },
      );
      } catch (err) {
        // Total berubah sejak sesi disiapkan (PAYMENT_AMOUNT_CHANGED)
        // → transaksi langkah sudah rollback; catat kegagalan run
        // secara jujur, jangan telan sebagai sukses.
        if (err instanceof PaymentProviderError) {
          await withTenantDb(db, tenantId, (tx) =>
            failRun(
              tx,
              tenantId,
              run,
              node,
              "payment_provider_error",
              `checkout gagal di provider: ${err.code}`,
              {
                outcome: "failed",
                reason: "payment_provider_error",
                provider: err.provider,
                code: err.code,
              },
            ),
          );
          return {
            executed: true,
            status: "failed",
            conversationId: run.conversationId,
            stepsExecuted: stepsExecuted + 1,
          };
        }
        throw err;
      }
      if (!applied.applied) {
        return {
          executed: stepsExecuted > 0,
          reason:
            applied.reason === "stale_step" ? "stale_step" : "run_terminal",
          conversationId: run.conversationId,
          stepsExecuted,
        };
      }
      stepsExecuted += 1;
      if (applied.outboundMessageId) {
        lastOutboundMessageId = applied.outboundMessageId;
      }
      if (applied.status === "waiting" || isTerminalStatus(applied.status!)) {
        return {
          executed: true,
          status: applied.status,
          conversationId: run.conversationId,
          outboundMessageId: lastOutboundMessageId,
          stepsExecuted,
        };
      }
      continue;
    }

    // Node send_payment_link (Fase 12A): layanan payment link yang
    // sama dengan tool agent 4A (createPaymentLink membuka
    // transaksinya sendiri) dipanggil DI LUAR transaksi langkah.
    // Produk tak ditemukan/arsip = kegagalan keras yang tercatat
    // (payment_product_unavailable) — berbeda dari http_request,
    // karena mengirim link pembayaran yang salah/tidak ada lebih
    // buruk daripada menghentikan run.
    if (node.type === "send_payment_link") {
      const productId = String(node.config.productId ?? "");
      const product = isUuidLike(productId)
        ? await withTenantDb(db, tenantId, async (tx) => {
            const [row] = await tx
              .select({
                id: products.id,
                name: products.name,
                isActive: products.isActive,
              })
              .from(products)
              .where(
                and(
                  eq(products.tenantId, tenantId),
                  eq(products.id, productId),
                ),
              )
              .limit(1);
            return row ?? null;
          })
        : null;
      if (!product || !product.isActive) {
        await withTenantDb(db, tenantId, (tx) =>
          failRun(
            tx,
            tenantId,
            run,
            node,
            "payment_product_unavailable",
            "produk untuk send_payment_link tidak ditemukan atau tidak aktif",
            {
              outcome: "failed",
              reason: "payment_product_unavailable",
              productId,
            },
          ),
        );
        return {
          executed: true,
          status: "failed",
          conversationId: run.conversationId,
          stepsExecuted: stepsExecuted + 1,
        };
      }
      const created = await createPaymentLink(
        db,
        { tenantId },
        {
          productId: product.id,
          contactId: run.contactId,
          conversationId: run.conversationId,
        },
        { actorType: "system", actorId: `flow:${run.flowId}` },
        {
          ...deps.payments,
          publicBaseUrl: deps.payments?.publicBaseUrl ?? deps.publicBaseUrl,
        },
      );
      if (created.kind !== "ok") {
        await withTenantDb(db, tenantId, (tx) =>
          failRun(
            tx,
            tenantId,
            run,
            node,
            "payment_link_failed",
            created.kind === "provider_error"
              ? `payment link gagal dibuat: provider_error ${created.code}`
              : `payment link gagal dibuat: ${created.kind}`,
            { outcome: "failed", reason: "payment_link_failed", productId },
          ),
        );
        return {
          executed: true,
          status: "failed",
          conversationId: run.conversationId,
          stepsExecuted: stepsExecuted + 1,
        };
      }
      // Format teks PERSIS pola tool agent 4A.
      const paymentUrl = buildPaymentUrl(deps.publicBaseUrl, created.link.code);
      const paymentText = `Link pembayaran ${product.name}: ${paymentUrl} (berlaku 7 hari)`;
      const applied: AdvanceResult = await withTenantDb(
        db,
        tenantId,
        async (tx) => {
          const [fresh] = await tx
            .select()
            .from(flowRuns)
            .where(and(eq(flowRuns.tenantId, tenantId), eq(flowRuns.id, runId)))
            .limit(1);
          if (!fresh || isTerminalStatus(fresh.status)) {
            return { applied: false, reason: "run_terminal" as const };
          }
          if (fresh.nextStepSeq !== run.nextStepSeq) {
            return { applied: false, reason: "stale_step" as const };
          }
          if (!ctxState.conversation) {
            await failRun(
              tx,
              tenantId,
              fresh,
              node,
              "step_error",
              "percakapan run tidak ditemukan",
              { outcome: "failed" },
            );
            return { applied: true, status: "failed" as const };
          }
          const [outbound] = await tx
            .insert(messages)
            .values({
              tenantId,
              conversationId: run.conversationId,
              direction: "outbound",
              senderType: "system",
              type: "text",
              contentText: paymentText,
              status: "queued",
            })
            .returning();
          const now = new Date();
          await tx
            .update(conversations)
            .set({ lastMessageAt: now, updatedAt: now })
            .where(eq(conversations.id, run.conversationId));
          await tx.insert(outboxEvents).values({
            tenantId,
            type: "message.queued",
            payload: {
              provider: ctxState.conversation.provider,
              conversationId: run.conversationId,
              messageId: outbound.id,
              via: "flow",
              flowId: run.flowId,
              runId: run.id,
              paymentLinkId: created.link.id,
            },
          });
          const adv = await advanceRun(tx, tenantId, fresh, graph, node, {
            detail: {
              outcome: "payment_link_sent",
              productId: product.id,
              paymentLinkId: created.link.id,
              code: created.link.code,
              amountIdr: created.link.amountIdr,
            },
          });
          return {
            applied: true,
            status: adv.status,
            outboundMessageId: outbound.id,
          };
        },
      );
      if (!applied.applied) {
        return {
          executed: stepsExecuted > 0,
          reason:
            applied.reason === "stale_step" ? "stale_step" : "run_terminal",
          conversationId: run.conversationId,
          stepsExecuted,
        };
      }
      stepsExecuted += 1;
      if (applied.outboundMessageId) {
        lastOutboundMessageId = applied.outboundMessageId;
      }
      if (applied.status === "waiting" || isTerminalStatus(applied.status!)) {
        return {
          executed: true,
          status: applied.status,
          conversationId: run.conversationId,
          outboundMessageId: lastOutboundMessageId,
          stepsExecuted,
        };
      }
      continue;
    }

    // Node biasa: efek + baris langkah + kemajuan run dalam SATU
    // transaksi tenant. Kegagalan node (FlowNodeError) menandai run
    // failed dengan baris langkah error — job TIDAK melempar.
    const applied: AdvanceResult = await withTenantDb(db, tenantId, async (tx) => {
      const [fresh] = await tx
        .select()
        .from(flowRuns)
        .where(and(eq(flowRuns.tenantId, tenantId), eq(flowRuns.id, runId)))
        .limit(1);
      if (!fresh || isTerminalStatus(fresh.status)) {
        return { applied: false, reason: "run_terminal" as const };
      }
      if (fresh.nextStepSeq !== run.nextStepSeq) {
        return { applied: false, reason: "stale_step" as const };
      }
      const freshCtx: RunContext = { ...ctxState, run: fresh };
      let effects: NodeEffects;
      try {
        effects = await executeNodeInTx(tx, tenantId, freshCtx, node);
      } catch (err) {
        if (err instanceof FlowNodeError) {
          await failRun(
            tx,
            tenantId,
            fresh,
            node,
            err.code ?? "step_error",
            err.message,
            { outcome: "failed", ...(err.code ? { reason: err.code } : {}) },
          );
          return { applied: true, status: "failed" as const };
        }
        throw err;
      }
      const adv = await advanceRun(tx, tenantId, fresh, graph, node, {
        detail: effects.detail,
        branch: effects.branch,
        waitMs: effects.waitMs,
        parkWaitReplyMs: effects.parkWaitReplyMs,
        forceComplete: effects.forceComplete,
        contextPatch: effects.contextPatch,
        contextClear: effects.contextClear,
      });
      return {
        applied: true,
        status: adv.status,
        outboundMessageId: effects.outboundMessageId,
      };
    });
    if (!applied.applied) {
      return {
        executed: stepsExecuted > 0,
        reason: applied.reason === "stale_step" ? "stale_step" : "run_terminal",
        conversationId: run.conversationId,
        stepsExecuted,
      };
    }
    stepsExecuted += 1;
    if (applied.outboundMessageId) {
      lastOutboundMessageId = applied.outboundMessageId;
    }
    if (applied.status === "waiting" || isTerminalStatus(applied.status!)) {
      return {
        executed: true,
        status: applied.status,
        conversationId: run.conversationId,
        outboundMessageId: lastOutboundMessageId,
        stepsExecuted,
      };
    }
    // status 'running' → lanjut ke node berikutnya dalam pemanggilan ini.
  }
}
