/**
 * Simulator flow (G4 — Tier 1 butir 4 program adopsi; konsep "efek
 * sebagai data" diadopsi dari riset zernflow
 * `lib/flow-engine/simulator.ts`, MIT).
 *
 * Interpreter KERING di atas graf flow: menelusuri graf dengan kontak
 * mock dan mengumpulkan JEJAK langkah + EFEK sebagai data. Fungsi
 * intinya (`simulateFlowRun`) MURNI — tidak menerima `db`, tidak
 * menulis apa pun, tidak mengantre job, tidak memanggil LLM/jaringan:
 *
 * - Node yang bisa disimulasikan setia dari data graf + kontak mock
 *   dijalankan dengan logika yang sama seperti eksekutor
 *   (`execute.ts`): render pesan memakai `renderMessageText` yang
 *   sama, predikat condition yang sama, config reader yang sama
 *   (questionnaire/catalog/appointment), render katalog yang sama.
 *   Bedanya: mutasi diterapkan ke SALINAN kontak mock, pesan menjadi
 *   efek `send_message`, dan pilihan acak (spintax, smart delay,
 *   ab_split non-eksperimen) diambil dari RNG BERBENIH deterministik
 *   (benih = flowId + id kontak mock + teks pemicu) agar simulasi
 *   yang sama selalu menghasilkan jejak yang sama.
 * - ab_split mode eksperimen memakai hash lengket eksekutor yang
 *   sama persis (`experimentBucket` + `flowExperimentKey` +
 *   `flowBranchForBucket`) — tanpa menulis baris penugasan.
 *   `splitChoices` pemanggil mengalahkan semua pilihan otomatis.
 * - Node parkir (wait_reply/questionnaire/show_catalog/
 *   book_appointment) MENGHENTIKAN penelusuran: status `parked` +
 *   alasan + efek parkir. Khusus wait_reply, `replyText` melanjutkan
 *   lewat cabang "replied" (mesin jawaban node parkir lain hidup di
 *   jalur evaluasi pesan masuk — di luar cakupan panel uji).
 * - Node yang efeknya tidak bisa disimulasikan setia TIDAK
 *   berpura-pura dijalankan: http_request tidak ditembak,
 *   ai_response tidak memanggil LLM, enroll_sequence/goto_flow/
 *   tautan pembayaran/checkout/slot janji hanya DICATAT sebagai efek
 *   ber-`fidelity: "recorded"` (daftar lengkap di kontrak
 *   FlowSimulateResponseSchema, packages/contracts).
 * - delay dicatat sebagai efek lalu penelusuran LANJUT ke node
 *   berikutnya (seolah tenggatnya sudah lewat) — itulah gunanya
 *   pratinjau: melihat seluruh jalur tanpa menunggu.
 *
 * Bungkus tipis `simulateFlow` (satu-satunya bagian yang menyentuh
 * DB, dan hanya MEMBACA) menyuntikkan daftar produk aktif tenant
 * sebagai data lingkungan bila graf memuat node show_catalog, agar
 * teks katalog yang dirender persis seperti run sungguhan.
 */
import {
  type Contact,
  type Database,
  type Product,
} from "@sahabat-kreator/db";
import {
  experimentBucket,
  flowBranchForBucket,
  flowExperimentKey,
} from "../experiments";
import { renderMessageText } from "../render-text";
import {
  listActiveCatalogProductsTx,
  renderCatalogText,
} from "../commerce";
import { withTenantDb } from "../tx";

import { isNonEmptyString, isUuidLike } from "./util";
import {
  FLOW_GOTO_MAX_DEPTH,
  FLOW_MAX_STEPS,
  firstNodeAfterTrigger,
  nextNodeId,
  normalizeFlowGraph,
  renderFlowHttpTemplate,
  triggerOf,
  type FlowBranch,
  type FlowGraphData,
  type FlowGraphNode,
} from "./graph";
import { questionnaireConfigOf, renderQuestionnairePrompt } from "./questionnaire";
import { catalogConfigOf, cartCheckoutConfigOf } from "./catalog";
import { appointmentConfigOf } from "./appointment";

// ---------------------------------------------------------------------------
// Bentuk hasil (selaras skema kontrak FlowSimulate*)
// ---------------------------------------------------------------------------

export interface FlowSimContactState {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
  pipelineStage: string | null;
  customFields: Record<string, unknown>;
}

export interface FlowSimStep {
  seq: number;
  nodeId: string;
  nodeType: string;
  detail: Record<string, unknown>;
}

export type FlowSimEffectKind =
  | "send_message"
  | "delay"
  | "add_tag"
  | "remove_tag"
  | "set_stage"
  | "set_field"
  | "enroll_sequence"
  | "goto_flow"
  | "handoff"
  | "ai_response"
  | "http_request"
  | "payment_link"
  | "catalog_message"
  | "checkout"
  | "appointment_offer"
  | "park";

export interface FlowSimEffect {
  kind: FlowSimEffectKind;
  nodeId: string;
  fidelity: "faithful" | "recorded";
  data: Record<string, unknown>;
}

export type FlowSimStatus =
  | "completed"
  | "parked"
  | "failed"
  | "trigger_not_matched";

export interface FlowSimulateResult {
  triggerMatched: boolean;
  status: FlowSimStatus;
  parkedNodeId: string | null;
  parkReason: string | null;
  failReason: string | null;
  steps: FlowSimStep[];
  effects: FlowSimEffect[];
  contact: FlowSimContactState;
}

export interface FlowSimulateOptions {
  /** Id flow pemilik graf — bagian dari benih deterministik + kunci eksperimen. */
  flowId: string;
  /** Teks pesan pemicu (yang akan memulai run sungguhan). */
  triggerText: string;
  contact: {
    id?: string;
    name?: string;
    phone?: string | null;
    email?: string | null;
    tags?: string[];
    pipelineStage?: string | null;
    customFields?: Record<string, unknown>;
  };
  /** Balasan simulasi: hanya melanjutkan node wait_reply lewat cabang "replied". */
  replyText?: string;
  /** Pilihan cabang paksa per node ab_split (mengalahkan undian/hash). */
  splitChoices?: Record<string, "a" | "b">;
  /** Jumlah item keranjang mock untuk cabang cart_checkout. */
  cartItemCount?: number;
  /**
   * Data lingkungan baca-saja: produk aktif tenant untuk node
   * show_catalog. Absen = katalog tidak bisa dirender (efek dicatat).
   */
  catalogProducts?: ReadonlyArray<{
    id: string;
    name: string;
    priceIdr: number;
    description: string | null;
  }>;
  /** Jam acuan (uji deterministik); bawaan = waktu pemanggilan. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Helper deterministik + pencocok pemicu
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit lokal (pendamping experimentBucket di experiments.ts yang memakai algoritma sama secara internal). */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** RNG berbenih (LCG) — satu aliran untuk semua pilihan acak satu simulasi. */
function seededRng(seed: string): () => number {
  let state = fnv1a32(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Selaras normalizeText di evaluate.ts (trim + lowercase). */
function simNormalizeText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Pencocok pemicu — semantik yang sama dengan `flowTriggerMatches` di
 * evaluate.ts (disalin lokal mengikuti preseden modul itu sendiri,
 * yang menyalin pencocok keyword automation demi menghindari impor
 * melingkar).
 */
function simTriggerMatches(node: FlowGraphNode, messageText: string): boolean {
  const c = node.config;
  if (c.kind === "any_message") return true;
  if (c.kind === "keyword") {
    const keywords = Array.isArray(c.keywords)
      ? c.keywords.filter(isNonEmptyString)
      : [];
    const match = c.match === "exact" ? "exact" : "contains";
    return keywords.some((kw) => {
      const text = simNormalizeText(messageText);
      const k = simNormalizeText(kw);
      if (!k) return false;
      return match === "exact" ? text === k : text.includes(k);
    });
  }
  return false;
}

/** Kegagalan keras satu node di simulasi — cermin FlowNodeError eksekutor. */
class SimNodeError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

type Directive =
  | { type: "advance"; branch?: FlowBranch }
  | { type: "complete" }
  | { type: "park"; reason: string };

// ---------------------------------------------------------------------------
// Interpreter kering
// ---------------------------------------------------------------------------

export function simulateFlowRun(
  graphRaw: unknown,
  options: FlowSimulateOptions,
): FlowSimulateResult {
  const graph: FlowGraphData = normalizeFlowGraph(graphRaw);
  const now = options.now ?? new Date();
  const contact: FlowSimContactState = {
    id: options.contact.id ?? "sim-contact",
    name: options.contact.name ?? "",
    phone: options.contact.phone ?? null,
    email: options.contact.email ?? null,
    tags: [...(options.contact.tags ?? [])],
    pipelineStage: options.contact.pipelineStage ?? null,
    customFields: { ...(options.contact.customFields ?? {}) },
  };
  const rng = seededRng(
    `${options.flowId}|${contact.id}|${options.triggerText}`,
  );
  const steps: FlowSimStep[] = [];
  const effects: FlowSimEffect[] = [];

  const contactSnapshot = (): FlowSimContactState => ({
    ...contact,
    tags: [...contact.tags],
    customFields: { ...contact.customFields },
  });
  /** Merakit hasil akhir — snapshot kontak SELALU diambil saat kembali (sesudah mutasi mock). */
  const result = (
    p: Omit<FlowSimulateResult, "steps" | "effects" | "contact">,
  ): FlowSimulateResult => ({
    ...p,
    steps,
    effects,
    contact: contactSnapshot(),
  });
  /** Kedalaman goto run ini (konteks run sungguhan membawanya di context.gotoDepth; satu graf per simulasi → selalu 0). */
  const gotoDepth = 0;
  /** Bentuk kontak sempit untuk renderer bersama (renderQuestionnairePrompt / renderFlowHttpTemplate membaca name + customFields). */
  const contactLike = (): Contact =>
    ({
      name: contact.name,
      customFields: contact.customFields,
    }) as unknown as Contact;

  const trigger = triggerOf(graph);
  if (!trigger || !simTriggerMatches(trigger, options.triggerText)) {
    return result({
      triggerMatched: false,
      status: "trigger_not_matched",
      parkedNodeId: null,
      parkReason: null,
      failReason: null,
    });
  }

  let currentId: string | null = firstNodeAfterTrigger(graph);
  if (!currentId) {
    return result({
      triggerMatched: true,
      status: "completed",
      parkedNodeId: null,
      parkReason: null,
      failReason: null,
    });
  }

  const pushStep = (
    node: FlowGraphNode,
    detail: Record<string, unknown>,
  ): void => {
    steps.push({
      seq: steps.length + 1,
      nodeId: node.id,
      nodeType: node.type,
      detail,
    });
  };
  const pushEffect = (
    kind: FlowSimEffectKind,
    node: FlowGraphNode,
    fidelity: "faithful" | "recorded",
    data: Record<string, unknown>,
  ): void => {
    effects.push({ kind, nodeId: node.id, fidelity, data });
  };

  /** Menjalankan SATU node: menulis langkah + efeknya, mengembalikan arah lanjut. */
  const runNode = (node: FlowGraphNode): Directive => {
    const c = node.config;
    switch (node.type) {
      case "trigger":
        pushStep(node, { outcome: "passed" });
        return { type: "advance" };

      case "send_message": {
        const text = isNonEmptyString(c.text) ? c.text : "";
        if (!text) throw new SimNodeError("send_message tanpa config.text");
        const rendered = renderMessageText(text, { name: contact.name }, rng);
        pushStep(node, { outcome: "queued", text: rendered });
        pushEffect("send_message", node, "faithful", { text: rendered });
        return { type: "advance" };
      }

      case "condition": {
        // Predikat persis eksekutor (execute.ts): field selain
        // phone/email dibaca sebagai name; message_contains memakai
        // teks pemicu run (konstan sepanjang simulasi, seperti
        // context.triggerText run sungguhan).
        let result = false;
        if (c.predicate === "has_tag") {
          result = contact.tags.includes(String(c.tag ?? ""));
        } else if (c.predicate === "stage_equals") {
          result = contact.pipelineStage === String(c.stage ?? "");
        } else if (c.predicate === "field_equals") {
          const field =
            c.field === "phone" || c.field === "email" ? c.field : "name";
          const actual = contact[field];
          result = actual !== null && actual === String(c.value ?? "");
        } else if (c.predicate === "message_contains") {
          result = simNormalizeText(options.triggerText).includes(
            simNormalizeText(String(c.text ?? "")),
          );
        } else {
          throw new SimNodeError(
            `predicate tidak dikenal: ${String(c.predicate)}`,
          );
        }
        pushStep(node, {
          outcome: "evaluated",
          predicate: String(c.predicate ?? ""),
          result,
        });
        return { type: "advance", branch: result ? "yes" : "no" };
      }

      case "delay": {
        const amount = typeof c.amount === "number" ? c.amount : NaN;
        const unitMs =
          c.unit === "seconds"
            ? 1_000
            : c.unit === "minutes"
              ? 60_000
              : c.unit === "hours"
                ? 3_600_000
                : NaN;
        if (!Number.isFinite(amount) || !Number.isFinite(unitMs)) {
          throw new SimNodeError("delay dengan config amount/unit tidak sah");
        }
        // Smart Delay: rentang sah mengalahkan amount (aturan sah
        // yang sama dengan eksekutor); pilihan acaknya dari RNG
        // berbenih agar bisa direproduksi, dan tetap DICATAT.
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
          const chosenAmount =
            min + Math.floor(rng() * (max - min + 1));
          const waitMs = Math.max(0, Math.floor(chosenAmount * unitMs));
          pushStep(node, {
            outcome: "waiting",
            delayMs: waitMs,
            resumeAt: new Date(now.getTime() + waitMs).toISOString(),
            random: { min, max, unit: String(c.unit) },
            chosenAmount,
          });
          pushEffect("delay", node, "faithful", {
            delayMs: waitMs,
            amount: chosenAmount,
            unit: String(c.unit),
            random: { min, max },
          });
          return { type: "advance" };
        }
        const waitMs = Math.max(0, Math.floor(amount * unitMs));
        pushStep(node, {
          outcome: "waiting",
          delayMs: waitMs,
          resumeAt: new Date(now.getTime() + waitMs).toISOString(),
        });
        pushEffect("delay", node, "faithful", {
          delayMs: waitMs,
          amount,
          unit: String(c.unit),
        });
        return { type: "advance" };
      }

      case "add_tag":
      case "remove_tag": {
        const tag = String(c.tag ?? "");
        if (!tag) throw new SimNodeError(`${node.type} tanpa config.tag`);
        const has = contact.tags.includes(tag);
        const changed = node.type === "add_tag" ? !has : has;
        if (node.type === "add_tag" && !has) contact.tags.push(tag);
        if (node.type === "remove_tag" && has) {
          contact.tags = contact.tags.filter((t) => t !== tag);
        }
        pushStep(node, {
          outcome: node.type === "add_tag" ? "tag_added" : "tag_removed",
          tag,
          changed,
        });
        pushEffect(
          node.type === "add_tag" ? "add_tag" : "remove_tag",
          node,
          "faithful",
          { tag, changed },
        );
        return { type: "advance" };
      }

      case "set_stage": {
        const stage = String(c.stage ?? "");
        if (!stage) throw new SimNodeError("set_stage tanpa config.stage");
        const previousStage = contact.pipelineStage;
        contact.pipelineStage = stage;
        pushStep(node, { outcome: "stage_set", stage, previousStage });
        pushEffect("set_stage", node, "faithful", { stage, previousStage });
        return { type: "advance" };
      }

      case "set_field": {
        const field = String(c.field ?? "");
        const rendered = renderMessageText(
          typeof c.value === "string" ? c.value : "",
          { name: contact.name },
          rng,
        );
        if (field === "name") {
          if (!rendered) {
            throw new SimNodeError("set_field name menghasilkan nilai kosong");
          }
          contact.name = rendered;
        } else if (field === "phone" || field === "email") {
          contact[field] = rendered ? rendered : null;
        } else if (
          field.startsWith("custom:") &&
          field.length > "custom:".length
        ) {
          const key = field.slice("custom:".length);
          contact.customFields = { ...contact.customFields, [key]: rendered };
        } else {
          throw new SimNodeError(`set_field dengan field tidak sah: ${field}`);
        }
        pushStep(node, {
          outcome: "field_set",
          field,
          value: rendered.slice(0, 200),
        });
        pushEffect("set_field", node, "faithful", { field, value: rendered });
        return { type: "advance" };
      }

      case "enroll_sequence": {
        const automationId = String(c.automationId ?? "");
        if (!automationId) {
          throw new SimNodeError("enroll_sequence tanpa config.automationId");
        }
        // Pendaftaran adalah tulisan DB lewat service bersama —
        // di simulasi hanya dicatat (keadaan sequence di luar graf).
        pushStep(node, {
          outcome: "simulated",
          reason: "enrollment_not_executed",
          automationId,
        });
        pushEffect("enroll_sequence", node, "recorded", { automationId });
        return { type: "advance" };
      }

      case "ai_response":
        // LLM TIDAK dipanggil — tidak ada provider di interpreter ini.
        pushStep(node, { outcome: "simulated", reason: "llm_not_called" });
        pushEffect("ai_response", node, "recorded", {});
        return { type: "advance" };

      case "handoff":
        pushStep(node, { outcome: "handed_off" });
        pushEffect("handoff", node, "faithful", { agentEnabled: false });
        return { type: "advance" };

      case "end":
        pushStep(node, { outcome: "ended" });
        return { type: "complete" };

      case "http_request": {
        // Permintaan TIDAK ditembak; yang ditampilkan adalah bentuk
        // rendernya (substitusi sempit eksekutor yang sama).
        const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(
          String(c.method),
        )
          ? String(c.method)
          : "POST";
        const url = renderFlowHttpTemplate(
          typeof c.url === "string" ? c.url : "",
          contactLike(),
        );
        // Header & body dirender dengan substitusi yang sama seperti
        // eksekutor (keduanya bagian dari "yang akan dikirim").
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
              headers[k] = renderFlowHttpTemplate(v, contactLike());
            }
          }
        }
        const body =
          typeof c.body === "string"
            ? renderFlowHttpTemplate(c.body, contactLike())
            : "";
        const saveFieldRaw =
          typeof c.saveToField === "string" ? c.saveToField : "";
        const saveKey =
          saveFieldRaw.startsWith("custom:") && saveFieldRaw.length > 7
            ? saveFieldRaw.slice("custom:".length)
            : null;
        pushStep(node, {
          outcome: "simulated",
          reason: "http_not_executed",
          method,
          url: url.slice(0, 300),
          ...(saveKey ? { savedToField: `custom:${saveKey}` } : {}),
        });
        pushEffect("http_request", node, "recorded", {
          method,
          url,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(body ? { body } : {}),
          ...(saveKey ? { saveToField: `custom:${saveKey}` } : {}),
        });
        return { type: "advance" };
      }

      case "goto_flow": {
        const targetId = String(c.flowId ?? "");
        if (!targetId || !isUuidLike(targetId)) {
          throw new SimNodeError(
            "flow tujuan goto tidak ada atau tidak aktif",
            "goto_target_unavailable",
          );
        }
        // Pemeriksaan batas yang sama dengan eksekutor (kedalaman
        // konteks run ini selalu 0 — satu graf per simulasi).
        if (gotoDepth + 1 > FLOW_GOTO_MAX_DEPTH) {
          throw new SimNodeError(
            `rantai goto melebihi kedalaman maksimum ${FLOW_GOTO_MAX_DEPTH}`,
            "goto_depth_exceeded",
          );
        }
        pushStep(node, {
          outcome: "goto",
          targetFlowId: targetId,
          gotoDepth: gotoDepth + 1,
        });
        pushEffect("goto_flow", node, "recorded", {
          targetFlowId: targetId,
          gotoDepth: gotoDepth + 1,
        });
        // Run asal selesai di sini pada run sungguhan; flow tujuan
        // adalah graf lain dan tidak ditelusuri panel uji.
        return { type: "complete" };
      }

      case "ab_split": {
        const percentA = c.percentA;
        if (
          typeof percentA !== "number" ||
          !Number.isInteger(percentA) ||
          percentA < 1 ||
          percentA > 99
        ) {
          throw new SimNodeError("ab_split dengan config.percentA tidak sah");
        }
        const forced = options.splitChoices?.[node.id];
        if (forced === "a" || forced === "b") {
          pushStep(node, {
            outcome: "split",
            percentA,
            branch: forced,
            selection: "forced",
          });
          return { type: "advance", branch: forced };
        }
        if (c.experiment === true) {
          // Hash lengket yang sama dengan penugasan eksekutor —
          // cabang yang akan diterima kontak ber-id ini pada run
          // sungguhan pertamanya (tanpa menulis penugasannya).
          const bucket = experimentBucket(
            flowExperimentKey(options.flowId, node.id, contact.id),
          );
          const branch = flowBranchForBucket(bucket, percentA);
          pushStep(node, {
            outcome: "split",
            experiment: true,
            percentA,
            bucket,
            branch,
            sticky: false,
            selection: "experiment_hash",
          });
          return { type: "advance", branch };
        }
        const roll = Math.floor(rng() * 100);
        const branch: "a" | "b" = roll < percentA ? "a" : "b";
        pushStep(node, {
          outcome: "split",
          percentA,
          roll,
          branch,
          selection: "seeded_roll",
        });
        return { type: "advance", branch };
      }

      case "send_payment_link": {
        const productId = String(c.productId ?? "");
        if (!isUuidLike(productId)) {
          throw new SimNodeError(
            "produk untuk send_payment_link tidak ditemukan atau tidak aktif",
            "payment_product_unavailable",
          );
        }
        // Tautan TIDAK dibuat (membuatnya = tulisan + panggilan
        // provider); run sungguhan lanjut ke node berikutnya.
        pushStep(node, {
          outcome: "simulated",
          reason: "payment_link_not_created",
          productId,
        });
        pushEffect("payment_link", node, "recorded", { productId });
        return { type: "advance" };
      }

      case "wait_reply": {
        const amount = typeof c.amount === "number" ? c.amount : NaN;
        const unitMs =
          c.unit === "seconds"
            ? 1_000
            : c.unit === "minutes"
              ? 60_000
              : c.unit === "hours"
                ? 3_600_000
                : NaN;
        if (!Number.isFinite(amount) || !Number.isFinite(unitMs)) {
          throw new SimNodeError(
            "wait_reply dengan config amount/unit tidak sah",
          );
        }
        const waitMs = Math.max(0, Math.floor(amount * unitMs));
        const deadline = new Date(now.getTime() + waitMs).toISOString();
        if (
          typeof options.replyText === "string" &&
          options.replyText.trim().length > 0
        ) {
          // Balasan simulasi: run sungguhan melanjutkan lewat cabang
          // "replied" apa pun isi balasannya.
          pushStep(node, {
            outcome: "replied",
            simulatedReply: true,
            waitMs,
            deadline,
          });
          return { type: "advance", branch: "replied" };
        }
        pushStep(node, {
          outcome: "waiting",
          waitMs,
          deadline,
          amount,
          unit: String(c.unit),
        });
        pushEffect("park", node, "faithful", {
          reason: "waiting_for_reply",
          branches: ["replied", "timeout"],
        });
        return { type: "park", reason: "waiting_for_reply" };
      }

      case "questionnaire": {
        const config = questionnaireConfigOf(node);
        if (config.questions.length === 0) {
          throw new SimNodeError("questionnaire tanpa pertanyaan yang sah");
        }
        const question = config.questions[0];
        const promptText = renderQuestionnairePrompt(question, contactLike());
        // Pertanyaan pertama dirender setia; gerbang target custom
        // (himpunan kunci tenant) dan mesin jawaban TIDAK dijalankan
        // — simulasi berhenti di parkir pertanyaan pertama.
        pushEffect("send_message", node, "faithful", {
          text: promptText,
          via: "questionnaire",
          questionId: question.id,
        });
        pushStep(node, {
          outcome: "question_asked",
          questionIndex: 0,
          questionId: question.id,
          questionCount: config.questions.length,
          simulated: true,
          note: "target_gate_not_evaluated",
        });
        pushEffect("park", node, "faithful", {
          reason: "waiting_for_questionnaire_answer",
          questionId: question.id,
          questionCount: config.questions.length,
        });
        return { type: "park", reason: "waiting_for_questionnaire_answer" };
      }

      case "show_catalog": {
        const config = catalogConfigOf(node);
        const products = options.catalogProducts;
        if (!products) {
          pushStep(node, {
            outcome: "simulated",
            reason: "catalog_data_unavailable",
          });
          pushEffect("catalog_message", node, "recorded", {
            note: "catalog_data_unavailable",
          });
          pushEffect("park", node, "faithful", {
            reason: "waiting_for_catalog_choice",
          });
          return { type: "park", reason: "waiting_for_catalog_choice" };
        }
        if (products.length === 0) {
          throw new SimNodeError("show_catalog tanpa produk aktif", "catalog_empty");
        }
        const intro = config.introText
          ? renderMessageText(config.introText, { name: contact.name }, rng)
          : null;
        const text = renderCatalogText(products as unknown as Product[], {
          introText: intro,
          showDescription: config.showDescription,
        });
        pushEffect("send_message", node, "faithful", {
          text,
          via: "show_catalog",
        });
        pushStep(node, {
          outcome: "catalog_shown",
          productCount: products.length,
          productIds: products.map((p) => p.id),
        });
        pushEffect("park", node, "faithful", {
          reason: "waiting_for_catalog_choice",
          productCount: products.length,
        });
        return { type: "park", reason: "waiting_for_catalog_choice" };
      }

      case "cart_checkout": {
        const config = cartCheckoutConfigOf(node);
        const itemCount = options.cartItemCount ?? 0;
        if (itemCount > 0) {
          // Order + tautan adalah tulisan — hanya dicatat; cabang
          // mengikuti keadaan keranjang mock yang dinyatakan.
          pushStep(node, {
            outcome: "checked_out",
            simulated: true,
            itemCount,
          });
          pushEffect("checkout", node, "recorded", { itemCount });
          return { type: "advance", branch: "checked_out" };
        }
        if (config.emptyMessage) {
          const text = renderMessageText(
            config.emptyMessage,
            { name: contact.name },
            rng,
          );
          pushEffect("send_message", node, "faithful", {
            text,
            via: "cart_checkout",
          });
        }
        pushStep(node, { outcome: "empty_cart" });
        return { type: "advance", branch: "empty_cart" };
      }

      case "book_appointment": {
        const config = appointmentConfigOf(node);
        if (!config.serviceId) {
          throw new SimNodeError(
            "layanan janji node book_appointment tidak ditemukan",
            "appointment_service_unavailable",
          );
        }
        // Daftar slot TIDAK dihitung (mesin slot + kesibukan
        // kalender di luar interpreter) — node dicatat lalu parkir,
        // persis titik berhentinya sesudah daftar terkirim.
        pushStep(node, {
          outcome: "simulated",
          reason: "slots_not_computed",
          serviceId: config.serviceId,
          daysAhead: config.daysAhead,
          slotsPerMessage: config.slotsPerMessage,
        });
        pushEffect("appointment_offer", node, "recorded", {
          serviceId: config.serviceId,
          daysAhead: config.daysAhead,
          slotsPerMessage: config.slotsPerMessage,
        });
        pushEffect("park", node, "faithful", {
          reason: "waiting_for_slot_choice",
          serviceId: config.serviceId,
        });
        return { type: "park", reason: "waiting_for_slot_choice" };
      }

      default:
        throw new SimNodeError(`tipe node tidak dikenal: ${node.type}`);
    }
  };

  for (;;) {
    const node = graph.nodes.find((n) => n.id === currentId);
    if (!node) {
      steps.push({
        seq: steps.length + 1,
        nodeId: currentId as string,
        nodeType: "unknown",
        detail: { outcome: "failed", reason: "node_missing" },
      });
      return result({
        triggerMatched: true,
        status: "failed",
        parkedNodeId: null,
        parkReason: null,
        failReason: "node_missing",
      });
    }
    // Cap langkah — cermin eksekutor: pemeriksaan SEBELUM node
    // berjalan, saat hitungan langkah sudah mencapai FLOW_MAX_STEPS.
    if (steps.length >= FLOW_MAX_STEPS) {
      steps.push({
        seq: steps.length + 1,
        nodeId: node.id,
        nodeType: node.type,
        detail: { outcome: "cap_exceeded", stepCap: FLOW_MAX_STEPS },
      });
      return result({
        triggerMatched: true,
        status: "failed",
        parkedNodeId: null,
        parkReason: null,
        failReason: "step_cap_exceeded",
      });
    }
    let directive: Directive;
    try {
      directive = runNode(node);
    } catch (err) {
      if (err instanceof SimNodeError) {
        steps.push({
          seq: steps.length + 1,
          nodeId: node.id,
          nodeType: node.type,
          detail: {
            outcome: "failed",
            ...(err.code ? { reason: err.code } : {}),
            error: err.message,
          },
        });
        return result({
          triggerMatched: true,
          status: "failed",
          parkedNodeId: null,
          parkReason: null,
          failReason: err.code ?? "step_error",
        });
      }
      throw err;
    }
    if (directive.type === "complete") {
      return result({
        triggerMatched: true,
        status: "completed",
        parkedNodeId: null,
        parkReason: null,
        failReason: null,
      });
    }
    if (directive.type === "park") {
      return result({
        triggerMatched: true,
        status: "parked",
        parkedNodeId: node.id,
        parkReason: directive.reason,
        failReason: null,
      });
    }
    const nextId = nextNodeId(graph, node.id, directive.branch);
    if (nextId === null) {
      return result({
        triggerMatched: true,
        status: "completed",
        parkedNodeId: null,
        parkReason: null,
        failReason: null,
      });
    }
    currentId = nextId;
  }
}

// ---------------------------------------------------------------------------
// Bungkus baca-saja untuk lapisan API
// ---------------------------------------------------------------------------

export interface SimulateFlowInput {
  tenantId: string;
  flowId: string;
  graph: FlowGraphData;
  triggerText: string;
  contact: FlowSimulateOptions["contact"] & { cartItemCount?: number };
  replyText?: string;
  splitChoices?: Record<string, "a" | "b">;
}

/**
 * Simulasi untuk lapisan API: menyuntikkan data lingkungan baca-saja
 * (produk aktif tenant — hanya bila graf memuat show_catalog) lalu
 * menjalankan interpreter murni. Tidak ada tulisan di jalur ini.
 */
export async function simulateFlow(
  db: Database,
  input: SimulateFlowInput,
): Promise<FlowSimulateResult> {
  let catalogProducts: FlowSimulateOptions["catalogProducts"];
  if (input.graph.nodes.some((n) => n.type === "show_catalog")) {
    catalogProducts = await withTenantDb(db, input.tenantId, async (tx) => {
      const rows = await listActiveCatalogProductsTx(tx, input.tenantId);
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        priceIdr: p.priceIdr,
        description: p.description,
      }));
    });
  }
  return simulateFlowRun(input.graph, {
    flowId: input.flowId,
    triggerText: input.triggerText,
    contact: input.contact,
    replyText: input.replyText,
    splitChoices: input.splitChoices,
    cartItemCount: input.contact.cartItemCount,
    catalogProducts,
  });
}
