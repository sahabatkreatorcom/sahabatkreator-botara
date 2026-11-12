/**
 * Eksekusi run flow (sisi worker, job `flow.step`).
 *
 * `executeFlowStep` menjalankan node demi node — satu transaksi tenant
 * per node — sampai run menunggu (node delay/parkir) atau terminal.
 * Setiap node menulis satu baris `flow_run_steps`. Cap FLOW_MAX_STEPS
 * menahan graf melingkar: run `failed` beralasan `step_cap_exceeded`,
 * worker tetap sehat.
 *
 * Eksekutor per tipe node berada di bagian bawah berkas ini; semuanya
 * berjalan DI DALAM transaksi langkah dan mengembalikan `NodeEffects`.
 */
import {
  and,
  eq,
  or,
} from "drizzle-orm";
import { APPOINTMENT_DEFAULT_NO_SLOTS_MESSAGE } from "@sahabat-kreator/contracts";
import {
  auditLogs,
  contacts,
  conversations,
  flowExperimentAssignments,
  flowRunSteps,
  flowRuns,
  flows,
  messages,
  outboxEvents,
  products,
  type Contact,
  type Conversation,
  type Database,
  type Flow,
  type FlowRun,
} from "@sahabat-kreator/db";
import {
  EmbeddingProvider,
  LlmProvider,
} from "@sahabat-kreator/ai";
import {
  withTenantDb,
  type DbTx,
} from "../tx";
import {
  experimentBucket,
  flowBranchForBucket,
  flowExperimentKey,
} from "../experiments";
import { renderMessageText } from "../render-text";
import { enrollContactInSequence } from "../sequence-enroll";
import { createDealForContact, moveLatestOpenDealStage } from "../deals";
import {
  buildAdConversionUserData,
  queueAdConversionTx,
  resolveAdConversionValueTx,
} from "../ad-conversions";
import {
  DiscountClaimLostError,
  previewDiscount,
  type DiscountPreview,
} from "../discount-codes";
import { respondToInboundMessage } from "../agent-runtime";
import {
  buildPaymentUrl,
  createPaymentLink,
  PAYMENT_LINK_TTL_DAYS,
} from "../products";
import {
  checkoutCartTx,
  getCartView,
  listActiveCatalogProductsTx,
  prepareOrderCheckoutLink,
  renderCartSummaryText,
  renderCatalogText,
} from "../commerce";
import {
  PaymentProviderError,
  type PaymentDeps,
} from "../payments";
import {
  getBookableSlots,
  renderSlotListText,
} from "../appointments";
import { GoogleDeps } from "../google-calendar";

import {
  isNonEmptyString,
  isUuidLike,
} from "./util";
import {
  AppointmentRunState,
  CatalogRunState,
  FLOW_GOTO_MAX_DEPTH,
  FLOW_HTTP_TIMEOUT_MS,
  FLOW_MAX_STEPS,
  FlowBranch,
  FlowGraphData,
  FlowGraphNode,
  FlowRunContextData,
  FlowRunStatus,
  QuestionnaireRunState,
  effectiveTriggerMessageId,
  firstNodeAfterTrigger,
  nextNodeId,
  normalizeFlowGraph,
  renderFlowHttpTemplate,
  runContextOf,
} from "./graph";
import {
  questionnaireConfigOf,
  questionnaireTargetKey,
  renderQuestionnairePrompt,
} from "./questionnaire";
import {
  cartCheckoutConfigOf,
  catalogConfigOf,
} from "./catalog";
import {
  appointmentConfigOf,
} from "./appointment";
import {
  tenantCustomFieldKeys,
} from "./validate";
import {
  flowAudit,
} from "./crud";
import {
  latestFlowVersion,
  resolveRunGraph,
} from "./versions";
import {
  exitParkedAppointment,
  exitParkedCatalog,
  exitParkedQuestionnaire,
  normalizeText,
  queueFlowOutboundText,
  resolveParkedWaitReply,
  skipMissingQuestionnaireTargets,
} from "./evaluate";

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
    // G3: graf eksekusi berasal dari SNAPSHOT versi ter-pin run
    // (resolveRunGraph) — BUKAN graf live flow. Run warisan tanpa pin
    // jatuh ke graf live secara jujur (pinned: false di resolver).
    const resolved = await resolveRunGraph(tx, tenantId, run);
    if (!resolved) return null;
    return {
      run,
      flow,
      graph: resolved.graph,
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
  const { run } = ctx;
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
      // Pendaftaran berjalan lewat service bersama (sequence-enroll,
      // G2b) — implementasi yang sama dengan evaluasi kata kunci dan
      // pendaftaran manual dari dashboard. Konteks flow disalurkan
      // sebagai field ekstra detail run & meta audit. Nama kunci via*
      // di meta audit disengaja: target audit sequence.enrolled harus
      // tetap sequence_enrollment (lihat deriveAuditTarget).
      const result = await enrollContactInSequence(tx, {
        tenantId,
        automationId,
        contactId: run.contactId,
        conversationId: run.conversationId,
        triggerMessageId: run.triggerMessageId,
        runDetailExtra: { via: "flow", flowId: run.flowId, flowRunId: run.id },
        auditMetaExtra: {
          via: "flow",
          viaFlowId: run.flowId,
          viaFlowRunId: run.id,
        },
      });
      switch (result.kind) {
        case "enrolled":
          return {
            detail: {
              outcome: "enrolled",
              automationId,
              enrollmentId: result.enrollmentId,
            },
          };
        case "already_enrolled":
          return {
            detail: {
              outcome: "skipped",
              reason: "already_enrolled",
              automationId,
              enrollmentId: result.enrollmentId,
            },
          };
        case "no_steps":
          return {
            detail: { outcome: "skipped", reason: "no_steps", automationId },
          };
        case "sequence_unavailable":
          // Sequence hilang/dinonaktifkan SETELAH aktivasi flow:
          // langkah dilewati beralasan, run lanjut — bukan kegagalan run.
          return {
            detail: {
              outcome: "skipped",
              reason: "sequence_unavailable",
              automationId,
            },
          };
      }
      // Tidak tercapai: union hasil service tertutup oleh switch di atas.
      throw new FlowNodeError("enroll_sequence: hasil pendaftaran tidak dikenal");
    }

    case "create_deal": {
      // G12: buat deal untuk kontak run lewat service bersama deals —
      // implementasi yang sama dengan API dashboard (validasi rujukan,
      // peristiwa pembuatan, audit). Judul dirender persis seperti
      // send_message ({name} + spintax). Kegagalan lunak (tahap
      // terhapus sesudah aktivasi, assignee keluar) = langkah
      // terlewat beralasan; run lanjut — pola enroll_sequence.
      if (!ctx.contact) throw new FlowNodeError("kontak run tidak ditemukan");
      const stageId = String(c.dealStageId ?? "");
      if (!stageId) {
        throw new FlowNodeError("create_deal tanpa config.dealStageId");
      }
      const title = renderMessageText(
        typeof c.title === "string" ? c.title : "",
        { name: ctx.contact.name },
      );
      if (!title.trim()) {
        throw new FlowNodeError("create_deal: judul hasil render kosong");
      }
      const result = await createDealForContact(tx, {
        tenantId,
        contactId: run.contactId,
        conversationId: run.conversationId,
        title,
        value: typeof c.value === "number" ? c.value : undefined,
        stageId,
        assigneeUserId:
          typeof c.assigneeUserId === "string" ? c.assigneeUserId : null,
        actor: { type: "flow" },
        auditMetaExtra: {
          via: "flow",
          viaFlowId: run.flowId,
          viaFlowRunId: run.id,
        },
      });
      switch (result.kind) {
        case "created":
          return {
            detail: { outcome: "created", dealId: result.dealId, stageId },
          };
        case "skipped":
          return {
            detail: {
              outcome: "skipped",
              reason:
                result.reason === "stage_unavailable"
                  ? "deal_stage_unavailable"
                  : result.reason,
              stageId,
            },
          };
      }
      throw new FlowNodeError("create_deal: hasil pembuatan tidak dikenal");
    }

    case "move_deal_stage": {
      // G12: pindahkan deal OPEN TERBARU kontak run ke tahap tujuan.
      // Kontak tanpa deal open adalah keadaan sah (bukan kegagalan):
      // langkah dicatat terlewat beralasan `no_open_deal`, run lanjut.
      const stageId = String(c.dealStageId ?? "");
      if (!stageId) {
        throw new FlowNodeError("move_deal_stage tanpa config.dealStageId");
      }
      const result = await moveLatestOpenDealStage(tx, {
        tenantId,
        contactId: run.contactId,
        stageId,
        actor: { type: "flow" },
        auditMetaExtra: {
          via: "flow",
          viaFlowId: run.flowId,
          viaFlowRunId: run.id,
        },
      });
      switch (result.kind) {
        case "moved":
          return {
            detail: {
              outcome: "moved",
              dealId: result.dealId,
              fromStageId: result.fromStageId,
              toStageId: result.toStageId,
              changed: result.changed,
            },
          };
        case "skipped":
          return {
            detail: {
              outcome: "skipped",
              reason:
                result.reason === "stage_unavailable"
                  ? "deal_stage_unavailable"
                  : result.reason,
              stageId,
            },
          };
      }
      throw new FlowNodeError("move_deal_stage: hasil perpindahan tidak dikenal");
    }

    case "send_ad_conversion": {
      // G16: antrekan peristiwa konversi iklan untuk kontak run.
      // Node TIDAK memanggil API iklan di sini: ia mengambil snapshot
      // konteks (hash pengenal + nilai nyata) dan menulis baris
      // ledger + event outbox dalam transaksi langkah ini (pola
      // send_message); worker yang mengirimkannya. Hasil pengiriman
      // (termasuk kegagalannya) hidup di ledger, BUKAN di run —
      // iklan yang mati tidak pernah membatalkan percakapan. Baris
      // yang sudah ada untuk (run, node) ini → langkah tercatat
      // `already_queued` (dedup), tanpa outbox kedua.
      if (!ctx.contact) throw new FlowNodeError("kontak run tidak ditemukan");
      const platform = c.platform === "google" ? "google" : "meta";
      const eventName =
        typeof c.eventName === "string" ? c.eventName.trim() : "";
      if (!eventName) {
        throw new FlowNodeError("send_ad_conversion tanpa config.eventName");
      }
      const resolvedValue = await resolveAdConversionValueTx(tx, {
        tenantId,
        contactId: run.contactId,
        staticValue: typeof c.value === "number" ? c.value : undefined,
        staticCurrency:
          typeof c.currency === "string" ? c.currency : undefined,
      });
      const queued = await queueAdConversionTx(tx, {
        tenantId,
        platform,
        eventName,
        flowId: run.flowId,
        runId: run.id,
        nodeId: node.id,
        contactId: run.contactId,
        userData: buildAdConversionUserData({
          id: run.contactId,
          email: ctx.contact.email,
          phone: ctx.contact.phone,
        }),
        value: resolvedValue,
        occurredAt: new Date(),
      });
      return {
        detail: {
          outcome: queued.kind === "queued" ? "queued" : "already_queued",
          platform,
          eventName,
          eventId: queued.eventId,
          adConversionEventId: queued.rowId,
          value: resolvedValue.value,
          currency: resolvedValue.currency,
          valueSource: resolvedValue.source,
        },
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
      // G3: run anak goto mem-pin versi terbaru flow tujuan; node
      // pertama ditentukan dari SNAPSHOT itu juga (tujuan aktif →
      // snapshot terbaru == graf live menurut invarian aktivasi).
      // Tujuan warisan tanpa baris versi → pin NULL + graf live.
      const targetLatest = await latestFlowVersion(tx, tenantId, target.id);
      const targetGraph = targetLatest
        ? normalizeFlowGraph(targetLatest.graph)
        : normalizeFlowGraph(target.graph);
      const firstNodeId = firstNodeAfterTrigger(targetGraph);
      const now = new Date();
      const rootTriggerMessageId = effectiveTriggerMessageId(run);
      const [newRun] = await tx
        .insert(flowRuns)
        .values({
          tenantId,
          flowId: target.id,
          flowVersionId: targetLatest?.id ?? null,
          flowVersion: targetLatest?.version ?? null,
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
          flowVersion: targetLatest?.version ?? null,
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
      // G14: kode diskon untuk checkout ini. Sumbernya: field kustom
      // kontak (kode dari pelanggan, mis. jawaban questionnaire
      // bertarget custom:<field>) MENANG atas kode statis config.
      // Pratinjau di sini advisori (untuk menyiapkan sesi provider
      // dengan total yang benar); klaim yang mengikat diulang secara
      // atomik oleh checkoutCartTx di dalam transaksi langkah.
      let discountCodeForCheckout: string | null = null;
      let discountInvalidReason: string | null = null;
      if (ctxState.conversation && ctxState.contact) {
        const cartView = await getCartView(
          db,
          { tenantId },
          run.contactId,
        );
        if (cartView && cartView.items.length > 0) {
          let amountForLink = cartView.totalIdr;
          let resolvedCode: string | null = checkoutConfig.discountCode;
          if (checkoutConfig.discountCodeField) {
            const [freshContact] = await withTenantDb(
              db,
              tenantId,
              (tx) =>
                tx
                  .select({ customFields: contacts.customFields })
                  .from(contacts)
                  .where(
                    and(
                      eq(contacts.tenantId, tenantId),
                      eq(contacts.id, run.contactId),
                    ),
                  )
                  .limit(1),
            );
            const raw = (
              freshContact?.customFields as Record<string, unknown> | null
            )?.[checkoutConfig.discountCodeField];
            if (typeof raw === "string" && raw.trim().length > 0) {
              resolvedCode = raw;
            }
          }
          if (resolvedCode) {
            const preview: DiscountPreview = await previewDiscount(
              db,
              { tenantId },
              {
                code: resolvedCode,
                contactId: run.contactId,
                subtotalIdr: cartView.totalIdr,
              },
            );
            if (preview.kind === "ok") {
              discountCodeForCheckout = resolvedCode;
              amountForLink = preview.totalIdr;
            } else {
              discountInvalidReason = preview.reason;
            }
          }
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
                amountIdr: amountForLink,
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
            discountCode: discountCodeForCheckout,
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
          // G14: klaim di dalam transaksi bisa melaporkan kode tidak
          // berlaku (balapan kuota pada jalur simulasi) — alasannya
          // menggantikan hasil pratinjau untuk pesan + detail run.
          if (result.discount.kind === "invalid") {
            discountInvalidReason = result.discount.reason;
          }
          if (
            discountInvalidReason &&
            checkoutConfig.discountInvalidMessage
          ) {
            await queueFlowOutboundText(
              tx,
              tenantId,
              fresh,
              ctxState.conversation,
              renderMessageText(checkoutConfig.discountInvalidMessage, {
                name: ctxState.contact.name,
              }),
            );
          }
          const paymentUrl = buildPaymentUrl(
            deps.publicBaseUrl,
            result.link.code,
          );
          const checkoutText = `${renderCartSummaryText(
            result.view,
            result.discount.kind === "applied"
              ? {
                  code: result.discount.code,
                  discountAmountIdr: result.discount.discountAmountIdr,
                }
              : null,
          )}\nLink pembayaran: ${paymentUrl} (berlaku ${PAYMENT_LINK_TTL_DAYS} hari)`;
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
              ...(result.discount.kind === "applied"
                ? {
                    discountCode: result.discount.code,
                    discountAmountIdr: result.discount.discountAmountIdr,
                    subtotalIdr: result.discount.subtotalIdr,
                  }
                : {}),
              ...(discountInvalidReason
                ? { discountRejected: discountInvalidReason }
                : {}),
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
        // G14: klaim diskon kalah balapan sesudah sesi provider
        // disiapkan dengan total diskon → transaksi langkah rollback
        // (keranjang tetap terbuka, belum ada order/tautan). Run
        // gagal dengan alasan khusus agar operator bisa membedakan
        // dari kegagalan provider; pelanggan bisa mencoba lagi.
        if (err instanceof DiscountClaimLostError) {
          await withTenantDb(db, tenantId, (tx) =>
            failRun(
              tx,
              tenantId,
              run,
              node,
              "discount_claim_lost",
              `klaim kode diskon gagal saat checkout: ${err.reason}`,
              {
                outcome: "failed",
                reason: "discount_claim_lost",
                discountRejected: err.reason,
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
