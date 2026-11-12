/**
 * Pemicu flow: evaluasi satu pesan masuk (dipanggil automations.ts
 * di TENGAH rantai prioritasnya — lihat trigger-priority.ts, sumber
 * kebenaran urutan kelas pemicu: keselamatan → postback → quick reply
 * → keyword → welcome → any_message → AI).
 *
 * Modul ini juga memegang mesin PARKIR run — `wait_reply`,
 * `questionnaire`, `show_catalog`, `book_appointment` — karena semuanya
 * bereaksi pada pesan masuk yang sama, plus penyapu resume/tenggat dan
 * pembatalan karena opt-out.
 *
 * Idempotensi berlapis: cek run yang sudah ada + index unik parsial
 * (flow_id, trigger_message_id).
 */
import {
  and,
  asc,
  eq,
  inArray,
} from "drizzle-orm";
import {
  APPOINTMENT_DEFAULT_INVALID_PROMPT,
  APPOINTMENT_DEFAULT_SLOT_TAKEN_PROMPT,
  CATALOG_DEFAULT_INVALID_PROMPT,
  QUESTIONNAIRE_DEFAULT_INVALID_PROMPT,
} from "@sahabat-kreator/contracts";
import {
  contacts,
  conversations,
  flowRunSteps,
  flowRuns,
  flows,
  messages,
  outboxEvents,
  products,
  type Contact,
  type Conversation,
  type Database,
  type FlowRun,
  type MessageInteractivePayload,
  type MessageTriggerSignal,
} from "@sahabat-kreator/db";
import {
  triggerPayloadMatches,
  type TriggerClass,
} from "../trigger-priority";
import {
  withTenantDb,
  type DbTx,
} from "../tx";
import { renderMessageText } from "../render-text";
import {
  addToCartTx,
  parseCatalogSelection,
  renderCartSummaryText,
  renderCatalogText,
} from "../commerce";
import {
  createBooking,
  getAppointmentSettings,
  getBookableSlots,
  parseSlotSelection,
  renderSlotListText,
  AppointmentServiceNotFoundError,
  SlotTakenError,
  type BookableSlot,
} from "../appointments";
import { GoogleDeps } from "../google-calendar";

import {
  isNonEmptyString,
} from "./util";
import {
  AppointmentRunState,
  CatalogRunState,
  FlowGraphData,
  FlowGraphNode,
  FlowRunContextData,
  FlowRunStatus,
  QuestionnaireRunState,
  firstNodeAfterTrigger,
  nextNodeId,
  normalizeFlowGraph,
  runContextOf,
  triggerOf,
} from "./graph";
import {
  QuestionnaireConfig,
  QuestionnaireQuestion,
  questionnaireConfigOf,
  questionnaireTargetKey,
  renderQuestionnairePrompt,
  validateQuestionnaireAnswer,
} from "./questionnaire";
import {
  catalogConfigOf,
} from "./catalog";
import { catalogProductIdFromSignal } from "./catalog-native";
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

// ---------------------------------------------------------------------------
// Pemicu: evaluasi flow untuk satu pesan masuk (dipanggil automations.ts)
// ---------------------------------------------------------------------------

export function normalizeText(value: string): string {
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

/** Konteks pengklasifikasi pemicu flow untuk SATU pesan masuk (G5). */
export interface FlowTriggerMatchContext {
  messageText: string;
  /** Sinyal tombol pada pesan (messages.trigger_signal); null = teks biasa. */
  signal: MessageTriggerSignal | null;
  /** Pesan ini pesan masuk pertama di percakapannya (syarat welcome). */
  isFirstInboundMessage: boolean;
}

/**
 * Mengklasifikasikan node pemicu flow terhadap satu pesan: kelas
 * pemicu yang cocok (lihat trigger-priority.ts) atau null. Aturan
 * kelas ditegakkan DI SINI untuk sisi flow:
 * - Pesan bersinyal POSTBACK hanya bisa cocok dengan pemicu postback
 *   (payload PERSIS) — keyword/welcome/any_message tidak melihatnya.
 * - Pemicu quick reply hanya cocok pada sinyal quick reply dengan
 *   payload PERSIS. (Penekanan keyword BILA ada QR yang cocok adalah
 *   keputusan lintas-mesin — diterapkan pemanggil loop & automations.)
 * - Pemicu welcome hanya cocok pada pesan pertama percakapan.
 * - Pemicu keyword TIDAK cocok pada pesan bersinyal apa pun di sini:
 *   untuk quick reply, penurun-kelasan ke teks (bila tak ada QR yang
 *   cocok di mana pun) diputuskan pemanggil; untuk postback tidak
 *   pernah.
 */
export function classifyFlowTrigger(
  node: FlowGraphNode,
  ctx: FlowTriggerMatchContext,
): TriggerClass | null {
  const c = node.config;
  // G17: pemicu webhook adalah pemicu LUAR PITA (panggilan HTTP
  // bertoken, bukan pesan masuk) — ia TIDAK PERNAH cocok dengan pesan
  // masuk mana pun di rantai prioritas ini. Run-nya dimulai
  // startFlowWebhookRun (flows/webhook-trigger.ts), bukan dari sini.
  if (c.kind === "webhook") return null;
  const signal = ctx.signal;
  if (signal?.kind === "postback") {
    if (c.kind !== "postback") return null;
    const payloads = Array.isArray(c.payloads)
      ? c.payloads.filter(isNonEmptyString)
      : [];
    return triggerPayloadMatches(payloads, signal.payload)
      ? "postback"
      : null;
  }
  if (c.kind === "postback") return null;
  if (c.kind === "quick_reply") {
    if (signal?.kind !== "quick_reply") return null;
    const payloads = Array.isArray(c.payloads)
      ? c.payloads.filter(isNonEmptyString)
      : [];
    return triggerPayloadMatches(payloads, signal.payload)
      ? "quick_reply"
      : null;
  }
  if (signal) {
    // Sinyal quick reply yang tidak cocok dengan pemicu quick reply
    // mana pun di flow INI: dari sudut flow ini pesannya teks biasa —
    // tetapi penurunan kelas global (bolehkah keyword menyala)
    // diputuskan pemanggil sesudah seluruh QR diketahui.
    if (c.kind === "welcome") {
      return ctx.isFirstInboundMessage ? "welcome" : null;
    }
    if (c.kind === "keyword") return "keyword";
    if (c.kind === "any_message") return "any_message";
    return null;
  }
  if (c.kind === "keyword") {
    const keywords = Array.isArray(c.keywords)
      ? c.keywords.filter(isNonEmptyString)
      : [];
    const match = c.match === "exact" ? "exact" : "contains";
    return keywords.some((kw) => flowKeywordMatches(ctx.messageText, kw, match))
      ? "keyword"
      : null;
  }
  if (c.kind === "welcome") {
    return ctx.isFirstInboundMessage ? "welcome" : null;
  }
  if (c.kind === "any_message") return "any_message";
  return null;
}

export interface FlowEvaluationOutcome {
  /** Run yang BARU dimulai oleh pesan ini. */
  startedRunIds: string[];
  /** Flow cocok yang tidak memulai run baru (run untuk pesan ini sudah ada). */
  duplicateStarts: number;
  /**
   * G5: kelas pemicu yang COCOK dan benar-benar dieksekusi pada pesan
   * ini (run dimulai atau duplikat) — sesudah aturan penekanan antar
   * kelas diterapkan. Dipakai evaluator automation untuk menekan
   * kelas welcome (kelas di atasnya yang menembak membatalkannya).
   */
  matchedTriggerClasses: TriggerClass[];
  /** G5: kelas pemicu dari run yang BARU dimulai pesan ini. */
  startedTriggerClasses: TriggerClass[];
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
export async function resolveParkedWaitReply(
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
export async function queueFlowOutboundText(
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
 * Varian queueFlowOutboundText dengan muatan interaktif NATIF kanal
 * (G17, node send_catalog): teks tetap disimpan sebagai content_text
 * (body daftar WhatsApp + bacaan fallback inbox), bentuk
 * terstrukturnya di interactive_payload untuk dibentuk poller
 * pengiriman menjadi panggilan API natif.
 */
export async function queueFlowOutboundInteractive(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
  conversation: Conversation,
  input: { text: string; interactivePayload: MessageInteractivePayload },
): Promise<string> {
  const [outbound] = await tx
    .insert(messages)
    .values({
      tenantId,
      conversationId: run.conversationId,
      direction: "outbound",
      senderType: "system",
      type: "text",
      contentText: input.text,
      interactivePayload: input.interactivePayload,
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
export function skipMissingQuestionnaireTargets(
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
export async function exitParkedQuestionnaire(
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
export async function exitParkedCatalog(
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
    // G17: send_catalog berbagi mesin parkir ini — baris langkah
    // penutup tercatat dengan tipe node yang sebenarnya.
    nodeType: node.type,
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
        reason: `${node.type}_${input.branch}`,
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
    nodeType: node.type,
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
  input: {
    messageId: string;
    messageText: string;
    /**
     * Sinyal tombol pesan ini (G17): pada node send_catalog, ketukan
     * daftar WhatsApp (quick_reply ber-payload id produk) dan tombol
     * postback template generik (`catalog_add:<id>`) adalah pilihan
     * katalog yang sah — setara mengetik nomornya, qty 1.
     */
    signal?: MessageTriggerSignal | null;
  },
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

  // Pilihan dari SINYAL tombol lebih dulu (G17): id produk dari
  // ketukan natif dipetakan kembali ke indeks daftar parkir agar
  // seluruh jalur lanjutan (cek aktif, tambah keranjang, ringkasan)
  // identik dengan pilihan teks. Sinyal asing / id di luar daftar
  // parkir jatuh ke parsing teks seperti biasa.
  const signalProductId = catalogProductIdFromSignal(
    input.signal,
    state.productIds,
  );
  const selection = signalProductId
    ? { index: state.productIds.indexOf(signalProductId), qty: 1 }
    : parseCatalogSelection(input.messageText, state.productIds.length);
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
      selectionSource: signalProductId ? `signal_${input.signal?.kind}` : "text",
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
export async function exitParkedAppointment(
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
  input: {
    conversationId: string;
    messageId: string;
    messageText: string;
    /** Sinyal tombol pesan ini (G5/G17) — pilihan katalog natif. */
    signal?: MessageTriggerSignal | null;
  },
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
    // G3: run terparkir melanjutkan SNAPSHOT versinya (resolveRunGraph),
    // bukan graf live — flow yang dinonaktifkan→disunting→diaktifkan
    // selama parkir tidak mengubah sisa perjalanan run ini. Run
    // warisan tanpa pin jatuh ke graf live (fallback jujur).
    const resolved = await resolveRunGraph(tx, tenantId, run);
    if (!resolved) continue;
    const graph = resolved.graph;
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
    if (node.type === "show_catalog" || node.type === "send_catalog") {
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
          signal: input.signal ?? null,
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
 * Pra-pindai TANPA efek samping (G5): kelas pemicu flow aktif mana
 * saja yang cocok dengan pesan ini. Dipakai evaluator automation
 * untuk keputusan penekanan lintas-mesin (pemicu quick reply flow
 * yang cocok menekan automation keyword) SEBELUM fase automation
 * berjalan — semantik pencocokannya tetap satu-satunya
 * `classifyFlowTrigger` di modul ini.
 */
export async function previewFlowTriggerClasses(
  db: Database,
  input: {
    tenantId: string;
    messageText: string;
    signal: MessageTriggerSignal | null;
    isFirstInboundMessage: boolean;
  },
): Promise<TriggerClass[]> {
  const activeFlows = await withTenantDb(db, input.tenantId, (tx) =>
    tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.status, "active")),
      )
      .orderBy(asc(flows.createdAt)),
  );
  const classes = new Set<TriggerClass>();
  for (const flow of activeFlows) {
    const trigger = triggerOf(normalizeFlowGraph(flow.graph));
    if (!trigger) continue;
    const cls = classifyFlowTrigger(trigger, {
      messageText: input.messageText,
      signal: input.signal,
      isFirstInboundMessage: input.isFirstInboundMessage,
    });
    if (cls) classes.add(cls);
  }
  return [...classes];
}

/**
 * Memulai run untuk semua flow AKTIF yang trigger-nya cocok dengan
 * pesan masuk ini. Dipanggil `evaluateInboundMessageForAutomations`
 * di tengah rantai prioritasnya (trigger-priority.ts). Satu
 * transaksi per flow agar kegagalan satu flow tidak menggagalkan yang
 * lain; pelanggaran unik (run sudah ada untuk pesan ini) diperlakukan
 * sebagai duplikat, BUKAN kegagalan.
 *
 * G5 — penekanan antar kelas di dalam fase flow:
 * - `suppressKeywordTriggers`: automation quick reply SUDAH cocok di
 *   fase automation → pemicu keyword flow ikut ditekan.
 * - `suppressWelcomeTriggers`: kelas di atas welcome (keyword/QR
 *   automation) sudah menembak → pemicu welcome flow ditekan.
 * - Pemicu quick reply flow yang cocok juga menekan keyword flow
 *   (dihitung dari kandidat fase ini sendiri), dan keyword flow yang
 *   cocok menekan welcome flow. Welcome per flow hanya menyala SEKALI
 *   per kontak: riwayat flow_runs flow+kontak adalah penjaganya.
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
    /** Sinyal tombol pesan ini (G5); absen/null = pesan teks biasa. */
    triggerSignal?: MessageTriggerSignal | null;
    /** Pesan masuk pertama di percakapannya (syarat welcome, G5). */
    isFirstInboundMessage?: boolean;
    /** Automation quick reply cocok → tekan pemicu keyword flow (G5). */
    suppressKeywordTriggers?: boolean;
    /** Kelas di atas welcome sudah menembak di fase automation (G5). */
    suppressWelcomeTriggers?: boolean;
  },
  opts?: { googleDeps?: GoogleDeps },
): Promise<FlowEvaluationOutcome> {
  const { tenantId, conversationId, messageId } = input;
  const outcome: FlowEvaluationOutcome = {
    startedRunIds: [],
    duplicateStarts: 0,
    matchedTriggerClasses: [],
    startedTriggerClasses: [],
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
        signal: input.triggerSignal ?? null,
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

  // G5 — LULUS 1: klasifikasikan semua pemicu flow aktif terhadap
  // pesan ini (tanpa efek samping), lalu terapkan aturan penekanan
  // antar kelas trigger-priority.ts sebelum ada run yang dimulai.
  const signal = input.triggerSignal ?? null;
  const matchCtx: FlowTriggerMatchContext = {
    messageText: input.messageText,
    signal,
    isFirstInboundMessage: input.isFirstInboundMessage ?? false,
  };
  const candidates: Array<{
    flow: (typeof activeFlows)[number];
    graph: FlowGraphData;
    cls: TriggerClass;
  }> = [];
  for (const flow of activeFlows) {
    const graph = normalizeFlowGraph(flow.graph);
    const trigger = triggerOf(graph);
    if (!trigger) continue;
    const cls = classifyFlowTrigger(trigger, matchCtx);
    if (cls) candidates.push({ flow, graph, cls });
  }
  const quickReplyMatched =
    candidates.some((c) => c.cls === "quick_reply") ||
    (input.suppressKeywordTriggers ?? false);
  const keywordMatched =
    !quickReplyMatched && candidates.some((c) => c.cls === "keyword");
  const welcomeSuppressed =
    quickReplyMatched ||
    keywordMatched ||
    (input.suppressWelcomeTriggers ?? false);

  // LULUS 2: mulai run untuk kandidat yang lolos penekanan.
  for (const { flow, graph, cls } of candidates) {
    if (cls === "keyword" && quickReplyMatched) continue;
    if (cls === "welcome" && welcomeSuppressed) continue;

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

      // G5: welcome hanya SEKALI per kontak per flow — kontak yang
      // membuka percakapan baru tidak memulai sambutan yang sama dua
      // kali. Riwayat run flow ini untuk kontak ini adalah penjaganya
      // (run pesan ini sendiri belum ada — cek duplikat di atas).
      if (cls === "welcome") {
        const [prior] = await tx
          .select({ id: flowRuns.id })
          .from(flowRuns)
          .where(
            and(
              eq(flowRuns.flowId, flow.id),
              eq(flowRuns.contactId, input.contact!.id),
            ),
          )
          .limit(1);
        if (prior) return { kind: "already_welcomed" as const };
      }

      const firstNodeId = firstNodeAfterTrigger(graph);
      const now = new Date();
      // G3: pin versi terbaru flow ke run. Flow aktif warisan yang
      // belum pernah diaktifkan ulang sejak G3 belum punya baris
      // versi → pin NULL (run warisan; eksekutor membaca graf live).
      const latest = await latestFlowVersion(tx, tenantId, flow.id);
      const [run] = await tx
        .insert(flowRuns)
        .values({
          tenantId,
          flowId: flow.id,
          flowVersionId: latest?.id ?? null,
          flowVersion: latest?.version ?? null,
          conversationId,
          contactId: input.contact!.id,
          triggerMessageId: messageId,
          status: firstNodeId ? "running" : "completed",
          currentNodeId: firstNodeId,
          nextStepSeq: 1,
          stepCount: 0,
          context: {
            triggerText: input.messageText,
            // G5: run dari ketukan tombol membawa sinyalnya agar
            // jejak run jujur soal apa yang memicunya.
            ...(signal
              ? {
                  triggerSignal: {
                    kind: signal.kind,
                    payload: signal.payload,
                  },
                }
              : {}),
          },
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
          flowVersion: latest?.version ?? null,
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

    if (started.kind === "already_welcomed") {
      // Sambutan flow ini sudah pernah menyala untuk kontak ini —
      // no-op yang disengaja (bukan duplikat pesan, bukan kegagalan).
      continue;
    }
    if (!outcome.matchedTriggerClasses.includes(cls)) {
      outcome.matchedTriggerClasses.push(cls);
    }
    if (started.kind === "duplicate") {
      outcome.duplicateStarts += 1;
    } else {
      outcome.startedRunIds.push(started.runId);
      if (!outcome.startedTriggerClasses.includes(cls)) {
        outcome.startedTriggerClasses.push(cls);
      }
    }
  }
  return outcome;
}
