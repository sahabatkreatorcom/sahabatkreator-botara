/**
 * Node `questionnaire` (Fase 13E) — bentuk config + validasi jawaban +
 * render prompt.
 *
 * Murni: tidak menyentuh DB dan tidak mengimpor modul flow lain selain
 * bentuk graf dan helper util.
 */
import { type Contact } from "@sahabat-kreator/db";
import { renderMessageText } from "../render-text";
import { normalizeContactPhone } from "../contacts";

import {
  isNonEmptyString,
} from "./util";
import {
  FlowGraphNode,
} from "./graph";

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

export const QUESTIONNAIRE_ANSWER_TYPES: readonly string[] = [
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

export function questionnaireTargetKey(target: string): string | null {
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
