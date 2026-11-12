import type {
  FlowEdgeBranch,
  FlowGraph,
  FlowGraphIssue,
  FlowNode,
  FlowNodeType,
} from "@sahabat-kreator/contracts";
import type { TranslationKey } from "@sahabat-kreator/i18n";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Model graf bersama UI Flows (Fase 8B): pemetaan tipe node → kunci
 * label, ringkasan config satu baris, config bawaan node baru, dan
 * terjemahan issue validasi server. Kontrak grafnya sendiri hidup di
 * `@sahabat-kreator/contracts` — berkas ini TIDAK mendefinisikan ulang
 * bentuk graf, hanya cara UI membacanya.
 */

export const FLOW_NODE_LABEL_KEYS: Record<FlowNodeType, TranslationKey> = {
  trigger: "flows.nodeTrigger",
  send_message: "flows.nodeSendMessage",
  condition: "flows.nodeCondition",
  delay: "flows.nodeDelay",
  add_tag: "flows.nodeAddTag",
  remove_tag: "flows.nodeRemoveTag",
  set_stage: "flows.nodeSetStage",
  enroll_sequence: "flows.nodeEnrollSequence",
  create_deal: "flows.nodeCreateDeal",
  move_deal_stage: "flows.nodeMoveDealStage",
  ai_response: "flows.nodeAiResponse",
  handoff: "flows.nodeHandoff",
  end: "flows.nodeEnd",
  set_field: "flows.nodeSetField",
  http_request: "flows.nodeHttpRequest",
  goto_flow: "flows.nodeGotoFlow",
  ab_split: "flows.nodeAbSplit",
  send_payment_link: "flows.nodeSendPaymentLink",
  wait_reply: "flows.nodeWaitReply",
  questionnaire: "flows.nodeQuestionnaire",
  show_catalog: "flows.nodeShowCatalog",
  cart_checkout: "flows.nodeCartCheckout",
  book_appointment: "flows.nodeBookAppointment",
  send_ad_conversion: "flows.nodeSendAdConversion",
  append_sheet_row: "flows.nodeAppendSheetRow",
  send_catalog: "flows.nodeSendCatalog",
  cart_summary: "flows.nodeCartSummary",
  send_dynamic_image: "flows.nodeSendDynamicImage",
  send_action_buttons: "flows.nodeSendActionButtons",
  award_points: "flows.nodeAwardPoints",
};

/** Tipe yang boleh ditambahkan dari palet (trigger dibuat otomatis & tunggal). */
export const ADDABLE_NODE_TYPES: FlowNodeType[] = [
  "send_message",
  "condition",
  "delay",
  "add_tag",
  "remove_tag",
  "set_stage",
  "enroll_sequence",
  "create_deal",
  "move_deal_stage",
  "ai_response",
  "handoff",
  "end",
  "set_field",
  "http_request",
  "goto_flow",
  "ab_split",
  "send_payment_link",
  "wait_reply",
  "questionnaire",
  "show_catalog",
  "cart_checkout",
  "book_appointment",
  "send_ad_conversion",
  "append_sheet_row",
  "send_catalog",
  "cart_summary",
  "send_dynamic_image",
  "send_action_buttons",
  "award_points",
];

/**
 * Node bercabang (Fase 12A menggeneralisasi condition 8B): himpunan
 * branch yang wajib ada pada edge keluar + kunci label chip-nya.
 * Dipakai kartu node (handle sumber berlabel), penurun branch saat
 * connect, dan label edge.
 */
export const FLOW_BRANCHED_TYPES: Partial<
  Record<FlowNodeType, { branch: FlowEdgeBranch; labelKey: TranslationKey }[]>
> = {
  condition: [
    { branch: "yes", labelKey: "flows.branchYes" },
    { branch: "no", labelKey: "flows.branchNo" },
  ],
  ab_split: [
    { branch: "a", labelKey: "flows.branchA" },
    { branch: "b", labelKey: "flows.branchB" },
  ],
  wait_reply: [
    { branch: "replied", labelKey: "flows.branchReplied" },
    { branch: "timeout", labelKey: "flows.branchTimeout" },
  ],
  questionnaire: [
    { branch: "completed", labelKey: "flows.branchCompleted" },
    { branch: "invalid", labelKey: "flows.branchInvalid" },
    { branch: "timeout", labelKey: "flows.branchTimeout" },
  ],
  show_catalog: [
    { branch: "added", labelKey: "flows.branchAdded" },
    { branch: "invalid", labelKey: "flows.branchInvalid" },
    { branch: "timeout", labelKey: "flows.branchTimeout" },
  ],
  send_catalog: [
    { branch: "added", labelKey: "flows.branchAdded" },
    { branch: "invalid", labelKey: "flows.branchInvalid" },
    { branch: "timeout", labelKey: "flows.branchTimeout" },
  ],
  cart_summary: [
    { branch: "has_items", labelKey: "flows.branchHasItems" },
    { branch: "empty", labelKey: "flows.branchEmpty" },
  ],
  cart_checkout: [
    { branch: "checked_out", labelKey: "flows.branchCheckedOut" },
    { branch: "empty_cart", labelKey: "flows.branchEmptyCart" },
  ],
  book_appointment: [
    { branch: "booked", labelKey: "flows.branchBooked" },
    { branch: "invalid", labelKey: "flows.branchInvalid" },
    { branch: "timeout", labelKey: "flows.branchTimeout" },
    { branch: "slot_taken", labelKey: "flows.branchSlotTaken" },
  ],
};

/** Label chip untuk satu branch (semua tipe bercabang); null bila tak dikenal. */
export function branchLabelKey(branch: string): TranslationKey | null {
  for (const list of Object.values(FLOW_BRANCHED_TYPES)) {
    const found = list?.find((b) => b.branch === branch);
    if (found) return found.labelKey;
  }
  return null;
}

/** Config bawaan saat node baru ditambahkan ke kanvas. */
export function defaultNodeConfig(
  type: FlowNodeType,
): Record<string, unknown> {
  switch (type) {
    case "trigger":
      return { kind: "keyword", keywords: [], match: "exact" };
    case "send_message":
      return { text: "" };
    case "condition":
      return { predicate: "has_tag", tag: "" };
    case "delay":
      return { amount: 5, unit: "minutes" };
    case "add_tag":
    case "remove_tag":
      return { tag: "" };
    case "set_stage":
      return { stage: "contacted" };
    case "enroll_sequence":
      return { automationId: "" };
    case "create_deal":
      return { title: "", dealStageId: "" };
    case "move_deal_stage":
      return { dealStageId: "" };
    case "send_ad_conversion":
      return { platform: "meta", eventName: "Lead" };
    case "append_sheet_row":
      return {
        spreadsheetId: "",
        columns: [{ header: "Nama", value: "{name}" }],
      };
    case "set_field":
      return { field: "name", value: "" };
    case "http_request":
      return { method: "POST", url: "", body: "" };
    case "goto_flow":
      return { flowId: "" };
    case "ab_split":
      return { percentA: 50 };
    case "send_payment_link":
      return { productId: "" };
    case "wait_reply":
      return { amount: 1, unit: "hours" };
    case "show_catalog":
      return { amount: 24, unit: "hours", maxInvalidAttempts: 2 };
    case "send_catalog":
      return { amount: 24, unit: "hours", maxInvalidAttempts: 2 };
    case "cart_summary":
      return {};
    case "send_dynamic_image":
      return { titleTemplate: "" };
    case "send_action_buttons":
      return {
        text: "",
        buttons: [{ kind: "copy_text", label: "", value: "" }],
      };
    case "award_points":
      return { points: 10 };
    case "book_appointment":
      return {
        serviceId: "",
        daysAhead: 7,
        slotsPerMessage: 5,
        amount: 24,
        unit: "hours",
        maxInvalidAttempts: 2,
      };
    case "cart_checkout":
      return {};
    case "questionnaire":
      return {
        questions: [
          {
            id: "q1",
            prompt: "",
            answerType: "text",
            target: "name",
            required: true,
          },
        ],
        amount: 24,
        unit: "hours",
        maxInvalidAttempts: 2,
      };
    default:
      return {};
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Pemetaan id → nama untuk ringkasan node rujukan (Fase 12A). */
export interface NodeSummaryResolvers {
  flowName?: (flowId: string) => string | undefined;
  productName?: (productId: string) => string | undefined;
  /** Fase 13G: nama layanan janji temu untuk ringkasan book_appointment. */
  serviceName?: (serviceId: string) => string | undefined;
  /** G12: nama tahap deal untuk ringkasan create_deal/move_deal_stage. */
  dealStageName?: (stageId: string) => string | undefined;
}

/**
 * Ringkasan config SATU baris untuk badan node di kanvas & daftar flow.
 * `sequenceName` memetakan automationId → nama sequence (dari daftar
 * automations tenant) bila pemanggil memilikinya; `resolvers`
 * memetakan rujukan node 12A (flow goto / produk) ke namanya.
 */
export function summarizeNodeConfig(
  t: Translate,
  node: Pick<FlowNode, "type" | "config">,
  sequenceName?: (automationId: string) => string | undefined,
  resolvers?: NodeSummaryResolvers,
): string {
  const c = node.config;
  switch (node.type) {
    case "trigger": {
      if (c.kind === "any_message") return t("flows.summaryAnyMessage");
      if (c.kind === "welcome") return t("flows.summaryWelcome");
      if (c.kind === "webhook") return t("flows.summaryWebhook");
      if (c.kind === "postback" || c.kind === "quick_reply") {
        const payloads = Array.isArray(c.payloads)
          ? c.payloads.filter((k): k is string => typeof k === "string")
          : [];
        return payloads.length > 0
          ? truncate(
              t("flows.summaryPayloads", { payloads: payloads.join(", ") }),
            )
          : t("flows.summaryNotConfigured");
      }
      const keywords = Array.isArray(c.keywords)
        ? c.keywords.filter((k): k is string => typeof k === "string")
        : [];
      return keywords.length > 0
        ? truncate(
            t("flows.summaryKeywords", { keywords: keywords.join(", ") }),
          )
        : t("flows.summaryNotConfigured");
    }
    case "send_message": {
      const text = asString(c.text);
      return text ? truncate(text) : t("flows.summaryNotConfigured");
    }
    case "condition": {
      if (c.predicate === "has_tag") {
        const tag = asString(c.tag);
        return tag
          ? `${t("flows.predicateHasTag")}: ${tag}`
          : t("flows.summaryNotConfigured");
      }
      if (c.predicate === "stage_equals") {
        const stage = asString(c.stage);
        return stage
          ? `${t("flows.predicateStageEquals")}: ${stage}`
          : t("flows.summaryNotConfigured");
      }
      if (c.predicate === "field_equals") {
        const field = asString(c.field);
        const value = asString(c.value);
        return field && value
          ? t("flows.summaryFieldEquals", { field, value })
          : t("flows.summaryNotConfigured");
      }
      if (c.predicate === "message_contains") {
        const text = asString(c.text);
        return text
          ? t("flows.summaryContains", { text })
          : t("flows.summaryNotConfigured");
      }
      return t("flows.summaryNotConfigured");
    }
    case "delay": {
      const amount = typeof c.amount === "number" ? c.amount : 0;
      const unit = asString(c.unit) || "minutes";
      const unitKey =
        unit === "seconds"
          ? "flows.unitSeconds"
          : unit === "hours"
            ? "flows.unitHours"
            : "flows.unitMinutes";
      // Smart Delay (Fase 9A): ringkasan menampilkan rentangnya.
      const r = c.random as { min?: unknown; max?: unknown } | undefined;
      if (
        typeof r === "object" &&
        r !== null &&
        typeof r.min === "number" &&
        typeof r.max === "number"
      ) {
        return t("flows.summaryDelayRandom", {
          min: r.min,
          max: r.max,
          unit: t(unitKey as TranslationKey),
        });
      }
      return t("flows.summaryDelay", { amount, unit: t(unitKey as TranslationKey) });
    }
    case "add_tag":
    case "remove_tag": {
      const tag = asString(c.tag);
      return tag || t("flows.summaryNotConfigured");
    }
    case "set_stage": {
      const stage = asString(c.stage);
      return stage || t("flows.summaryNotConfigured");
    }
    case "enroll_sequence": {
      const id = asString(c.automationId);
      if (!id) return t("flows.summaryNotConfigured");
      return sequenceName?.(id) ?? `${id.slice(0, 8)}…`;
    }
    case "create_deal": {
      const title = asString(c.title);
      if (!title) return t("flows.summaryNotConfigured");
      return truncate(t("flows.summaryCreateDeal", { title }));
    }
    case "move_deal_stage": {
      const id = asString(c.dealStageId);
      if (!id) return t("flows.summaryNotConfigured");
      const stage = resolvers?.dealStageName?.(id) ?? `${id.slice(0, 8)}…`;
      return t("flows.summaryMoveDealStage", { stage });
    }
    case "send_ad_conversion": {
      const eventName = asString(c.eventName);
      if (!eventName) return t("flows.summaryNotConfigured");
      const platform = c.platform === "google" ? "Google Ads" : "Meta";
      return t("flows.summaryAdConversion", { platform, eventName });
    }
    case "append_sheet_row": {
      const spreadsheetId = asString(c.spreadsheetId);
      if (!spreadsheetId) return t("flows.summaryNotConfigured");
      const columnCount = Array.isArray(c.columns) ? c.columns.length : 0;
      return t("flows.summaryAppendSheetRow", { columns: columnCount });
    }
    case "set_field": {
      const field = asString(c.field);
      const value = asString(c.value);
      if (!field) return t("flows.summaryNotConfigured");
      return truncate(`${field} = ${value}`);
    }
    case "http_request": {
      const method = asString(c.method) || "POST";
      const url = asString(c.url);
      return url
        ? truncate(t("flows.summaryHttp", { method, url }), 60)
        : t("flows.summaryNotConfigured");
    }
    case "goto_flow": {
      const id = asString(c.flowId);
      if (!id) return t("flows.summaryNotConfigured");
      return resolvers?.flowName?.(id) ?? `${id.slice(0, 8)}…`;
    }
    case "ab_split": {
      const percentA = typeof c.percentA === "number" ? c.percentA : 50;
      return t("flows.summaryAbSplit", {
        percentA,
        percentB: 100 - percentA,
      });
    }
    case "send_payment_link": {
      const id = asString(c.productId);
      if (!id) return t("flows.summaryNotConfigured");
      return resolvers?.productName?.(id) ?? `${id.slice(0, 8)}…`;
    }
    case "wait_reply": {
      const amount = typeof c.amount === "number" ? c.amount : 0;
      const unit = asString(c.unit) || "hours";
      const unitKey =
        unit === "seconds"
          ? "flows.unitSeconds"
          : unit === "minutes"
            ? "flows.unitMinutes"
            : "flows.unitHours";
      return t("flows.summaryWaitReply", {
        amount,
        unit: t(unitKey as TranslationKey),
      });
    }
    case "questionnaire": {
      const questions = Array.isArray(c.questions) ? c.questions : [];
      return questions.length > 0
        ? t("flows.summaryQuestionnaire", { count: questions.length })
        : t("flows.summaryNotConfigured");
    }
    case "show_catalog": {
      const amount = typeof c.amount === "number" ? c.amount : null;
      const unitKey =
        c.unit === "seconds"
          ? "flows.unitSeconds"
          : c.unit === "minutes"
            ? "flows.unitMinutes"
            : "flows.unitHours";
      return amount !== null
        ? t("flows.summaryCatalog", { amount, unit: t(unitKey as TranslationKey) })
        : t("flows.summaryNotConfigured");
    }
    case "send_catalog": {
      const amount = typeof c.amount === "number" ? c.amount : null;
      const unitKey =
        c.unit === "seconds"
          ? "flows.unitSeconds"
          : c.unit === "minutes"
            ? "flows.unitMinutes"
            : "flows.unitHours";
      return amount !== null
        ? t("flows.summaryCatalog", { amount, unit: t(unitKey as TranslationKey) })
        : t("flows.summaryNotConfigured");
    }
    case "cart_summary": {
      return t("flows.summaryCartSummary");
    }
    case "send_dynamic_image": {
      const title = asString(c.titleTemplate);
      return title ? truncate(title) : t("flows.summaryNotConfigured");
    }
    case "send_action_buttons": {
      const text = asString(c.text);
      return text ? truncate(text) : t("flows.summaryNotConfigured");
    }
    case "award_points": {
      const points = typeof c.points === "number" ? c.points : null;
      return points !== null
        ? t("flows.summaryAwardPoints", { points })
        : t("flows.summaryNotConfigured");
    }
    case "cart_checkout": {
      return t("flows.summaryCheckout");
    }
    case "book_appointment": {
      const serviceId = asString(c.serviceId);
      const name = serviceId
        ? resolvers?.serviceName?.(serviceId)
        : undefined;
      const days = typeof c.daysAhead === "number" ? c.daysAhead : 7;
      return serviceId
        ? `${name ?? t("flows.nodeBookAppointment")} · ${t("flows.summaryAppointment", { days })}`
        : t("flows.summaryNotConfigured");
    }
    default:
      return "";
  }
}

/** Ringkasan pemicu untuk daftar flow (dari node trigger graf). */
export function summarizeTrigger(t: Translate, graph: FlowGraph): string {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (!trigger) return t("flows.triggerNoneSummary");
  if (trigger.config.kind === "any_message") {
    return t("flows.triggerAnySummary");
  }
  return summarizeNodeConfig(t, trigger);
}

const ISSUE_KEY_PREFIX = "flows.issue.";

/** Terjemahkan kode issue server ke teks klien; kode tak dikenal → pesan server. */
export function translateFlowIssue(t: Translate, issue: FlowGraphIssue): string {
  const key = `${ISSUE_KEY_PREFIX}${issue.code}` as TranslationKey;
  const translated = t(key);
  // createTranslator jatuh kembali ke kunci itu sendiri bila tidak ada —
  // itu tanda kode belum diterjemahkan; pakai pesan server apa adanya.
  return translated === key ? issue.message : translated;
}

/** Bentuk issue untuk panel: pisah error vs warning, urutan server dipertahankan. */
export function splitIssues(issues: FlowGraphIssue[]): {
  errors: FlowGraphIssue[];
  warnings: FlowGraphIssue[];
} {
  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

/** Ekstrak issues dari ApiClientError 422 FLOW_GRAPH_INVALID (details.issues). */
export function issuesFromError(err: unknown): FlowGraphIssue[] | null {
  if (typeof err !== "object" || err === null) return null;
  const details = (err as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  return issues.filter(
    (i): i is FlowGraphIssue =>
      typeof i === "object" &&
      i !== null &&
      typeof (i as FlowGraphIssue).code === "string" &&
      ((i as FlowGraphIssue).severity === "error" ||
        (i as FlowGraphIssue).severity === "warning"),
  );
}
