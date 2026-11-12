/**
 * Bentuk data graf flow + navigasi graf.
 *
 * Berisi kontrak yang dipakai SEMUA sisi mesin flow: tipe node/edge,
 * `normalizeFlowGraph` (defensif terhadap graf lama/rusak), keadaan
 * konteks run (`FlowRunContextData`) beserta pembacanya, penelusuran
 * node (trigger -> node berikutnya), dan render templat HTTP.
 *
 * Tidak mengimpor modul flow lain — ini daun pohon dependensi.
 */
import {
  type Contact,
  type Flow,
  type FlowRun,
} from "@sahabat-kreator/db";

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

export const NODE_TYPES = new Set([
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

export function triggerOf(graph: FlowGraphData): FlowGraphNode | null {
  return graph.nodes.find((n) => n.type === "trigger") ?? null;
}

/** Node pertama sesudah trigger (edge keluar trigger tanpa branch). */
export function firstNodeAfterTrigger(graph: FlowGraphData): string | null {
  const trigger = triggerOf(graph);
  if (!trigger) return null;
  const edge = graph.edges.find((e) => e.from === trigger.id);
  return edge ? edge.to : null;
}

/** Node lanjutan: untuk node bercabang wajib menyebut branch; selain itu edge pertama. */
export function nextNodeId(
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
  /**
   * Sinyal tombol pesan pemicu (G5) — hanya untuk run yang dimulai
   * ketukan postback/quick reply: { kind, payload } sebagaimana
   * tercatat di messages.trigger_signal pesan pemicunya.
   */
  triggerSignal?: { kind: "postback" | "quick_reply"; payload: string };
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

export function runContextOf(run: FlowRun): FlowRunContextData {
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
export function effectiveTriggerMessageId(run: FlowRun): string | null {
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
