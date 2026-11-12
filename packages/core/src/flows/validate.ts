/**
 * Validasi graf flow (dijalankan saat aktivasi).
 *
 * `validateFlowGraph` mengumpulkan SEMUA masalah sekaligus
 * (`FlowGraphIssue[]`) alih-alih melempar pada yang pertama — dashboard
 * menampilkannya sebagai daftar. `validateFlowNodeConfig` memvalidasi
 * satu node; dipakai juga oleh editor untuk umpan balik per node.
 */
import {
  and,
  eq,
  sql,
} from "drizzle-orm";
import {
  automations,
  channelAccounts,
  contacts,
  dealStages,
  flows,
  flowWebhookEndpoints,
  products,
  tenantMembers,
  type Database,
} from "@sahabat-kreator/db";
import {
  withTenantDb,
  type DbTx,
} from "../tx";

import {
  isNonEmptyString,
  isUuidLike,
} from "./util";
import {
  FLOW_WEBHOOK_MESSAGING_PROVIDERS,
  FlowBranch,
  FlowGraphData,
  FlowGraphNode,
  NODE_TYPES,
} from "./graph";
import {
  QUESTIONNAIRE_ANSWER_TYPES,
  isQuestionnaireTarget,
  questionnaireConfigOf,
  questionnaireTargetKey,
} from "./questionnaire";

/**
 * Satu masalah pada graf flow. Dikumpulkan (bukan dilempar satu per satu)
 * agar dashboard dapat menampilkan seluruh daftar sekaligus, dan agar
 * editor per node dapat memakai validator yang sama.
 */
export interface FlowGraphIssue {
  code: string;
  severity: "error" | "warning";
  nodeId: string | null;
  message: string;
}

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
      } else if (c.kind === "postback" || c.kind === "quick_reply") {
        // G5: pemicu sinyal wajib membawa ≥1 payload non-kosong —
        // tanpa payload tidak ada yang bisa dicocokkan PERSIS.
        if (
          !Array.isArray(c.payloads) ||
          c.payloads.length === 0 ||
          !c.payloads.every(isNonEmptyString)
        ) {
          err("TRIGGER_PAYLOADS_REQUIRED", "Trigger postback/quick_reply membutuhkan minimal satu payload non-kosong");
        }
      } else if (c.kind === "webhook") {
        // G17: pemicu webhook menempatkan run pada akun channel ini —
        // bentuk uuid ditegakkan di sini; keberadaan akun + endpoint
        // terprovision diperiksa validasi graf penuh (butuh DB).
        if (!isNonEmptyString(c.channelAccountId) || !isUuidLike(c.channelAccountId)) {
          err("TRIGGER_WEBHOOK_ACCOUNT_REQUIRED", "Trigger webhook membutuhkan config.channelAccountId (uuid akun channel)");
        }
      } else if (c.kind !== "any_message" && c.kind !== "welcome") {
        err("TRIGGER_KIND_INVALID", "Trigger membutuhkan kind 'keyword', 'any_message', 'postback', 'quick_reply', 'welcome', atau 'webhook'");
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
    case "create_deal": {
      // G12: judul = templat teks (dirender seperti send_message);
      // dealStageId wajib; value opsional ≥ 0; assigneeUserId opsional
      // uuid. Keberadaan tahap & keanggotaan assignee diperiksa di
      // bagian referensi DB di bawah.
      if (!isNonEmptyString(c.title)) {
        err("DEAL_TITLE_REQUIRED", "Node create_deal membutuhkan config.title (templat judul deal)");
      }
      if (!isNonEmptyString(c.dealStageId)) {
        err("DEAL_STAGE_ID_REQUIRED", "Node create_deal membutuhkan config.dealStageId");
      }
      if (
        c.value !== undefined &&
        (typeof c.value !== "number" ||
          !Number.isFinite(c.value) ||
          c.value < 0 ||
          c.value > 999_999_999_999)
      ) {
        err("DEAL_VALUE_INVALID", "Node create_deal: config.value harus bilangan 0..999999999999");
      }
      if (c.assigneeUserId !== undefined && !isNonEmptyString(c.assigneeUserId)) {
        err("DEAL_ASSIGNEE_INVALID", "Node create_deal: config.assigneeUserId harus uuid member tenant");
      }
      break;
    }
    case "move_deal_stage":
      if (!isNonEmptyString(c.dealStageId)) {
        err("DEAL_STAGE_ID_REQUIRED", "Node move_deal_stage membutuhkan config.dealStageId");
      }
      break;
    case "send_ad_conversion": {
      // G16: platform wajib meta|google; eventName wajib (nama
      // peristiwa Meta / label aksi Google); value statis opsional
      // ≥ 0; currency opsional ISO 4217 huruf besar. Koneksi iklan
      // tenant TIDAK diperiksa di sini — koneksi boleh dipasang
      // sesudah flow aktif; ketiadaannya tercatat jujur di ledger
      // saat pengiriman, bukan menggagalkan aktivasi/executor.
      if (c.platform !== "meta" && c.platform !== "google") {
        err(
          "AD_PLATFORM_INVALID",
          "Node send_ad_conversion membutuhkan config.platform 'meta'|'google'",
        );
      }
      if (!isNonEmptyString(c.eventName) || String(c.eventName).length > 128) {
        err(
          "AD_EVENT_NAME_REQUIRED",
          "Node send_ad_conversion membutuhkan config.eventName (maks 128 karakter)",
        );
      }
      if (
        c.value !== undefined &&
        (typeof c.value !== "number" ||
          !Number.isFinite(c.value) ||
          c.value < 0 ||
          c.value > 999_999_999_999)
      ) {
        err(
          "AD_VALUE_INVALID",
          "Node send_ad_conversion: config.value harus bilangan 0..999999999999",
        );
      }
      if (
        c.currency !== undefined &&
        (typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency))
      ) {
        err(
          "AD_CURRENCY_INVALID",
          "Node send_ad_conversion: config.currency harus kode ISO 4217 (3 huruf besar)",
        );
      }
      break;
    }
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
      // G14: sumber kode diskon opsional — bentuknya saja yang
      // divalidasi di sini; keberlakuan kode ditegakkan core commerce
      // saat checkout (kode yang tidak ada menghasilkan penolakan
      // jujur 'not_found', bukan flow yang gagal diaktifkan).
      if (
        c.discountCode !== undefined &&
        (!isNonEmptyString(c.discountCode) || c.discountCode.length > 64)
      ) {
        err(
          "CHECKOUT_DISCOUNT_CODE_INVALID",
          "Node cart_checkout membutuhkan discountCode string non-kosong ≤ 64 karakter bila diisi",
        );
      }
      if (
        c.discountCodeField !== undefined &&
        (!isNonEmptyString(c.discountCodeField) ||
          c.discountCodeField.length > 128)
      ) {
        err(
          "CHECKOUT_DISCOUNT_FIELD_INVALID",
          "Node cart_checkout membutuhkan discountCodeField string non-kosong ≤ 128 karakter bila diisi",
        );
      }
      if (
        c.discountInvalidMessage !== undefined &&
        (!isNonEmptyString(c.discountInvalidMessage) ||
          c.discountInvalidMessage.length > 1000)
      ) {
        err(
          "CHECKOUT_DISCOUNT_MESSAGE_INVALID",
          "Node cart_checkout membutuhkan discountInvalidMessage string non-kosong ≤ 1000 karakter bila diisi",
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

  // Referensi deals (G12, butuh DB, konteks tenant): tahap tujuan
  // create_deal/move_deal_stage harus ada di tenant ini; assignee
  // create_deal harus member tenant. Tahap yang dihapus SESUDAH
  // aktivasi bukan error aktivasi — eksekutor mencatatnya sebagai
  // langkah terlewat beralasan (deal_stage_unavailable).
  const dealStageRefs = graph.nodes.filter(
    (n) =>
      (n.type === "create_deal" || n.type === "move_deal_stage") &&
      isNonEmptyString(n.config.dealStageId),
  );
  const dealAssigneeRefs = graph.nodes.filter(
    (n) => n.type === "create_deal" && isNonEmptyString(n.config.assigneeUserId),
  );
  if (dealStageRefs.length > 0 || dealAssigneeRefs.length > 0) {
    await withTenantDb(db, tenantId, async (tx) => {
      for (const node of dealStageRefs) {
        const stageId = node.config.dealStageId as string;
        const [stage] = await tx
          .select({ id: dealStages.id })
          .from(dealStages)
          .where(
            and(eq(dealStages.tenantId, tenantId), eq(dealStages.id, stageId)),
          )
          .limit(1);
        if (!stage) {
          err("DEAL_STAGE_NOT_FOUND", node.id, "Tahap deal rujukan tidak ada di workspace ini");
        }
      }
      for (const node of dealAssigneeRefs) {
        const userId = node.config.assigneeUserId as string;
        const [member] = await tx
          .select({ id: tenantMembers.id })
          .from(tenantMembers)
          .where(
            and(
              eq(tenantMembers.tenantId, tenantId),
              eq(tenantMembers.userId, userId),
            ),
          )
          .limit(1);
        if (!member) {
          err("DEAL_ASSIGNEE_NOT_MEMBER", node.id, "Penanggung jawab deal bukan member workspace ini");
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

  // G17: rujukan pemicu webhook (butuh DB) — akun channel config
  // trigger harus akun PESAN milik tenant ini (run ditempatkan pada
  // percakapan akun itu; akun publikasi murni tidak punya percakapan
  // kontak), dan endpoint webhook flow HARUS sudah diprovision dari
  // panel builder: mengaktifkan flow webhook tanpa kredensial akan
  // melahirkan pemicu yang tidak bisa dipanggil siapa pun.
  const webhookTrigger = triggers.find(
    (n) => n.config.kind === "webhook",
  );
  if (webhookTrigger) {
    const accountId = webhookTrigger.config.channelAccountId;
    await withTenantDb(db, tenantId, async (tx) => {
      if (isNonEmptyString(accountId) && isUuidLike(accountId)) {
        const [account] = await tx
          .select({
            id: channelAccounts.id,
            provider: channelAccounts.provider,
          })
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.tenantId, tenantId),
              eq(channelAccounts.id, accountId),
            ),
          )
          .limit(1);
        if (!account) {
          err(
            "TRIGGER_WEBHOOK_ACCOUNT_NOT_FOUND",
            webhookTrigger.id,
            "Akun channel pemicu webhook tidak ada di workspace ini",
          );
        } else if (
          !(FLOW_WEBHOOK_MESSAGING_PROVIDERS as readonly string[]).includes(
            account.provider,
          )
        ) {
          err(
            "TRIGGER_WEBHOOK_ACCOUNT_NOT_MESSAGING",
            webhookTrigger.id,
            "Akun channel pemicu webhook harus akun pesan (WhatsApp/Messenger/Instagram/Telegram/Webchat)",
          );
        }
      }
      if (options.selfFlowId) {
        const [endpoint] = await tx
          .select({ id: flowWebhookEndpoints.id })
          .from(flowWebhookEndpoints)
          .where(eq(flowWebhookEndpoints.flowId, options.selfFlowId))
          .limit(1);
        if (!endpoint) {
          err(
            "TRIGGER_WEBHOOK_NOT_PROVISIONED",
            webhookTrigger.id,
            "Endpoint webhook flow ini belum dibuat — buat/rotasi token dari panel pemicu di builder lebih dulu",
          );
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

