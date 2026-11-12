import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  findAutomationTemplate,
  resolveAutomationSequenceContent,
  type AutomationTemplateLocale,
} from "@sahabat-kreator/contracts";
import {
  auditLogs,
  automationRuns,
  automationSteps,
  automations,
  contacts,
  conversations,
  messages,
  outboxEvents,
  sequenceEnrollments,
  type Automation,
  type AutomationRun,
  type AutomationStep,
  type Database,
  type SequenceEnrollment,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";
import { renderMessageText } from "./render-text";
import {
  previewFlowTriggerClasses,
  startFlowRunsForInboundMessage,
} from "./flows";
import {
  triggerPayloadMatches,
  triggerSignalOf,
  type TriggerClass,
} from "./trigger-priority";
import type { GoogleDeps } from "./google-calendar";
import { setContactConsent } from "./contacts";
import { getOptInSettings, matchConsentKeyword } from "./optin";
import { enrollContactInSequence } from "./sequence-enroll";

/**
 * Service domain automation (Fase 2A, RANCANGAN §5 & §6; Fase 2C sequence).
 * Transport-agnostic; semua query dalam konteks RLS tenant.
 *
 * Tiga sisi:
 * 1. Manajemen (dipakai API dashboard): CRUD automation + riwayat
 *    automation_runs + daftar sequence_enrollments.
 * 2. Evaluasi (dipakai worker lewat job `automation.evaluate`): pesan
 *    inbound dicocokkan ke automation aktif milik tenant per KELAS
 *    PEMICU (urutan prioritasnya: trigger-priority.ts — postback,
 *    quick reply, keyword, welcome; aksi mengikuti kind aturan):
 *      - kind 'keyword'  → balasan outbound `sender_type='system'`
 *        berstatus `queued` + run `completed` + audit `automation.fired`
 *        + event outbox `message.queued` (perilaku Fase 2A).
 *      - kind 'sequence' → kontak didaftarkan ke rangkaian
 *        (sequence_enrollments) + run `completed` + audit
 *        `sequence.enrolled` + event outbox `sequence.step_due` yang oleh
 *        relay worker diterjemahkan menjadi job BullMQ tertunda
 *        `sequence.step`. Pendaftaran ulang saat enrollment masih aktif
 *        diabaikan: run dicatat `skipped` (alasan already_enrolled).
 *        Sejak G2b pendaftaran berjalan lewat service bersama
 *        `enrollContactInSequence` (sequence-enroll.ts) — implementasi
 *        yang sama dengan node flow `enroll_sequence` dan pendaftaran
 *        manual dari dashboard.
 *    Sebelum pencocokan, evaluasi juga MEMBATALKAN enrollment aktif di
 *    percakapan pesan ini (aturan berhenti 2C-a: kontak membalas pesan
 *    apa pun setelah terdaftar → rangkaian berhenti; audit
 *    `sequence.cancelled_reply`). Enrollment yang dibuat oleh pesan yang
 *    sama TIDAK dibatalkan (dijaga lewat trigger_message_id).
 * 3. Eksekusi langkah (dipakai worker lewat job `sequence.step`):
 *    `executeSequenceStep` mengirim satu langkah sebagai pesan `queued`,
 *    memajukan current_step, dan menjadwalkan langkah berikut lewat event
 *    outbox `sequence.step_due` berikutnya (atau menyelesaikan enrollment).
 *    Berhenti juga bila kontak opt-out (audit `sequence.cancelled_opt_out`).
 *    Menonaktifkan automation (is_active=false) TIDAK membatalkan
 *    enrollment yang sedang berjalan — hanya memblokir pemicu baru.
 *
 * Pengiriman sungguhan ke channel BUKAN urusan sini: untuk webchat, poller
 * di proses API mendorong pesan `queued` lewat hub WebSocket (lihat README
 * @sahabat-kreator/queue).
 *
 * Idempotensi: satu (automation, pesan pemicu) maksimal menembak sekali.
 * Penjaga berlapis: jobId BullMQ diturunkan dari event outbox, cek run
 * yang sudah ada, dan index unik parsial di DB sebagai penahan terakhir.
 */

export interface AutomationStepInput {
  delayMinutes: number;
  text: string;
}

export interface CreateAutomationInput {
  name: string;
  keywords: string[];
  match: "exact" | "contains";
  /** Default 'keyword' (kompatibilitas request Fase 2A/2B tanpa field ini). */
  kind?: "keyword" | "sequence" | "comment";
  /**
   * G5 — jenis pemicu pesan: 'keyword' (bawaan warisan), 'postback',
   * 'quick_reply', 'welcome'. Hanya bermakna untuk kind
   * 'keyword'/'sequence'; kind 'comment' selalu triggerType 'comment'.
   * Pemicu dan aksi ortogonal: aturan postback boleh beraksi balasan
   * langsung (kind 'keyword') atau pendaftaran (kind 'sequence').
   */
  triggerType?: "keyword" | "postback" | "quick_reply" | "welcome";
  /** G5 — wajib (≥1) untuk triggerType 'postback'/'quick_reply'. */
  payloads?: string[];
  /** Wajib untuk kind='keyword': isi balasan langsung. */
  text?: string;
  /** Wajib untuk kind='sequence': 1–10 langkah rangkaian. */
  steps?: AutomationStepInput[];
  /**
   * Fase 10B — wajib untuk kind='comment': akun IG/Messenger tempat
   * aturan berlaku (uuid channel_accounts milik tenant; lapisan API
   * memvalidasi kepemilikan + provider sebelum memanggil ini).
   */
  channelAccountId?: string;
  /** Fase 10B (kind='comment'): kirim DM privat; teksnya `text`. */
  sendDm?: boolean;
  /** Fase 10B (kind='comment'): teks balasan publik; null = mati. */
  publicReplyText?: string | null;
  /** Fase 10B (kind='comment'): sembunyikan komentar yang cocok. */
  hideComment?: boolean;
  /**
   * Fase 16B — status awal. Default `true` (perilaku seluruh pemanggil
   * lama tidak berubah). Pembuatan DARI TEMPLATE memakai `false`:
   * teks template memuat placeholder yang wajib disunting pemilik, dan
   * automation aktif langsung membalas pelanggan sungguhan.
   */
  isActive?: boolean;
}

export interface UpdateAutomationInput {
  name?: string;
  keywords?: string[];
  /** G5 — hanya bermakna untuk aturan triggerType postback/quick_reply. */
  payloads?: string[];
  match?: "exact" | "contains";
  text?: string;
  isActive?: boolean;
  /** Fase 10B — hanya bermakna untuk aturan kind='comment'. */
  sendDm?: boolean;
  publicReplyText?: string | null;
  hideComment?: boolean;
}

export type AutomationWithRunCount = Automation & {
  runCount: number;
  /** Langkah rangkaian terurut posisi menaik; kosong untuk kind='keyword'. */
  steps: AutomationStep[];
  stepCount: number;
};

export async function createAutomation(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: CreateAutomationInput,
): Promise<Automation & { steps: AutomationStep[] }> {
  const kind = input.kind ?? "keyword";
  if (kind === "sequence" && (!input.steps || input.steps.length === 0)) {
    throw new Error("Sequence automation requires at least one step");
  }
  if (kind === "comment" && !input.channelAccountId) {
    throw new Error("Comment automation requires a channel account");
  }
  // G5: pemicu sinyal wajib membawa payload — tanpa itu aturan tidak
  // akan pernah bisa cocok dan hanya membingungkan pemiliknya.
  const triggerType =
    kind === "comment" ? "comment" : (input.triggerType ?? "keyword");
  if (
    (triggerType === "postback" || triggerType === "quick_reply") &&
    (!input.payloads || input.payloads.length === 0)
  ) {
    throw new Error("Signal automation requires at least one payload");
  }
  const isSignalTrigger =
    triggerType === "postback" || triggerType === "quick_reply";
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(automations)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        triggerType,
        triggerConfig: {
          // Aturan sinyal/welcome tidak mencocokkan teks: keywords
          // selalu kosong agar tidak ada jalur yang menafsirkannya.
          keywords: isSignalTrigger || triggerType === "welcome"
            ? []
            : input.keywords,
          match: input.match,
          ...(kind === "comment"
            ? { channelAccountId: input.channelAccountId }
            : {}),
          ...(isSignalTrigger ? { payloads: input.payloads } : {}),
        },
        actionType: "send_message",
        actionConfig:
          kind === "comment"
            ? {
                text: input.sendDm ? (input.text ?? "") : "",
                sendDm: input.sendDm ?? false,
                publicReplyText: input.publicReplyText ?? null,
                hideComment: input.hideComment ?? false,
              }
            : { text: kind === "keyword" ? (input.text ?? "") : "" },
        kind,
        isActive: input.isActive ?? true,
      })
      .returning();
    let steps: AutomationStep[] = [];
    if (kind === "sequence" && input.steps) {
      steps = await tx
        .insert(automationSteps)
        .values(
          input.steps.map((step, i) => ({
            tenantId: ctx.tenantId,
            automationId: row.id,
            position: i + 1,
            delayMinutes: step.delayMinutes,
            text: step.text,
          })),
        )
        .returning();
      steps.sort((a, b) => a.position - b.position);
    }
    return { ...row, steps };
  });
}

export type InstantiateAutomationTemplateResult =
  | {
      kind: "created";
      automation: Automation & { steps: AutomationStep[] };
    }
  | { kind: "template_not_found" };

/**
 * Membuat automation dari template katalog (Fase 16B).
 *
 * Selalu NONAKTIF — lihat alasan keselamatan di
 * `packages/contracts/src/automation-templates.ts`: teks template
 * memuat placeholder `[...]` yang wajib disunting pemilik, dan
 * automation aktif langsung membalas pelanggan sungguhan tanpa
 * pratinjau apa pun di antaranya.
 *
 * Pemanggil (rute API) bertanggung jawab atas otorisasi owner/admin —
 * fungsi ini hanya menyentuh data dalam konteks RLS tenant.
 */
export async function instantiateAutomationTemplate(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: { slug: string; name?: string; locale?: AutomationTemplateLocale },
): Promise<InstantiateAutomationTemplateResult> {
  const template = findAutomationTemplate(input.slug);
  if (!template) return { kind: "template_not_found" };

  // Isi sequence dwibahasa (G2): locale menentukan nama bawaan, kata
  // kunci, dan teks langkah yang disalin. Klien web mengirim locale
  // UI pemilik; tanpa locale, isi "id" yang dipakai (perilaku lama).
  // Template keyword satu bahasa — locale tidak berpengaruh.
  if (template.kind === "sequence") {
    const content = resolveAutomationSequenceContent(
      template,
      input.locale ?? "id",
    );
    const automation = await createAutomation(db, ctx, {
      name: input.name?.trim() ? input.name.trim() : content.defaultName,
      keywords: content.keywords,
      match: template.match,
      isActive: false,
      kind: "sequence",
      steps: content.steps,
    });
    return { kind: "created", automation };
  }

  const automation = await createAutomation(db, ctx, {
    name: input.name?.trim() ? input.name.trim() : template.defaultName,
    keywords: template.keywords,
    match: template.match,
    isActive: false,
    kind: "keyword",
    text: template.text,
  });
  return { kind: "created", automation };
}

export async function listAutomations(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<AutomationWithRunCount[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({
        automation: automations,
        runCount: sql<number>`count(${automationRuns.id})::int`,
      })
      .from(automations)
      .leftJoin(
        automationRuns,
        eq(automationRuns.automationId, automations.id),
      )
      .where(eq(automations.tenantId, ctx.tenantId))
      .groupBy(automations.id)
      .orderBy(desc(automations.createdAt));
    const sequenceIds = rows
      .filter((r) => r.automation.kind === "sequence")
      .map((r) => r.automation.id);
    const steps =
      sequenceIds.length > 0
        ? await tx
            .select()
            .from(automationSteps)
            .where(
              and(
                eq(automationSteps.tenantId, ctx.tenantId),
                inArray(automationSteps.automationId, sequenceIds),
              ),
            )
            .orderBy(asc(automationSteps.position))
        : [];
    const stepsByAutomation = new Map<string, AutomationStep[]>();
    for (const step of steps) {
      const list = stepsByAutomation.get(step.automationId) ?? [];
      list.push(step);
      stepsByAutomation.set(step.automationId, list);
    }
    return rows.map((r) => {
      const own = stepsByAutomation.get(r.automation.id) ?? [];
      return {
        ...r.automation,
        runCount: r.runCount,
        steps: own,
        stepCount: own.length,
      };
    });
  });
}

/** Null bila automation tidak ada DI tenant ini. */
export async function getAutomation(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  automationId: string,
): Promise<Automation | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, ctx.tenantId),
          eq(automations.id, automationId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Null bila automation tidak ada DI tenant ini. */
export async function updateAutomation(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  automationId: string,
  input: UpdateAutomationInput,
): Promise<Automation | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, ctx.tenantId),
          eq(automations.id, automationId),
        ),
      )
      .limit(1);
    if (!existing) return null;

    const patch: Partial<Automation> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (
      input.keywords !== undefined ||
      input.match !== undefined ||
      input.payloads !== undefined
    ) {
      patch.triggerConfig = {
        keywords: input.keywords ?? existing.triggerConfig.keywords,
        match: input.match ?? existing.triggerConfig.match,
        // Fase 10B: ikatan akun aturan komentar tidak berubah lewat
        // patch — dipertahankan apa adanya dari baris yang ada.
        ...(existing.triggerConfig.channelAccountId
          ? { channelAccountId: existing.triggerConfig.channelAccountId }
          : {}),
        // G5: payload aturan sinyal bisa disunting; jenis lain
        // mempertahankan payload tersimpan apa adanya (biasanya absen).
        ...(input.payloads !== undefined
          ? { payloads: input.payloads }
          : existing.triggerConfig.payloads !== undefined
            ? { payloads: existing.triggerConfig.payloads }
            : {}),
      };
    }
    if (
      input.text !== undefined ||
      input.sendDm !== undefined ||
      input.publicReplyText !== undefined ||
      input.hideComment !== undefined
    ) {
      patch.actionConfig =
        existing.kind === "comment"
          ? {
              text: input.text ?? existing.actionConfig.text,
              sendDm: input.sendDm ?? existing.actionConfig.sendDm ?? false,
              publicReplyText:
                input.publicReplyText !== undefined
                  ? input.publicReplyText
                  : (existing.actionConfig.publicReplyText ?? null),
              hideComment:
                input.hideComment ??
                existing.actionConfig.hideComment ??
                false,
            }
          : { text: input.text ?? existing.actionConfig.text };
    }

    const [row] = await tx
      .update(automations)
      .set(patch)
      .where(eq(automations.id, automationId))
      .returning();
    return row;
  });
}

/**
 * Riwayat eksekusi satu automation, terbaru dulu.
 * Null bila automation bukan milik tenant ini (API menjawab 404).
 */
export async function listAutomationRuns(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  automationId: string,
  input: { limit: number },
): Promise<AutomationRun[] | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [owner] = await tx
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, ctx.tenantId),
          eq(automations.id, automationId),
        ),
      )
      .limit(1);
    if (!owner) return null;
    return tx
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.tenantId, ctx.tenantId),
          eq(automationRuns.automationId, automationId),
        ),
      )
      .orderBy(desc(automationRuns.createdAt))
      .limit(input.limit);
  });
}

export type SequenceEnrollmentWithTotal = SequenceEnrollment & {
  totalSteps: number;
};

/**
 * Daftar enrollment satu automation sequence, terbaru dulu.
 * Null bila automation bukan milik tenant ini (API menjawab 404).
 */
export async function listSequenceEnrollments(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  automationId: string,
  input: { limit: number },
): Promise<SequenceEnrollmentWithTotal[] | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [owner] = await tx
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, ctx.tenantId),
          eq(automations.id, automationId),
        ),
      )
      .limit(1);
    if (!owner) return null;
    const steps = await tx
      .select({ id: automationSteps.id })
      .from(automationSteps)
      .where(
        and(
          eq(automationSteps.tenantId, ctx.tenantId),
          eq(automationSteps.automationId, automationId),
        ),
      );
    const rows = await tx
      .select()
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.tenantId, ctx.tenantId),
          eq(sequenceEnrollments.automationId, automationId),
        ),
      )
      .orderBy(desc(sequenceEnrollments.createdAt))
      .limit(input.limit);
    return rows.map((r) => ({ ...r, totalSteps: steps.length }));
  });
}

// ---------------------------------------------------------------------------
// Evaluasi keyword (sisi worker)
// ---------------------------------------------------------------------------

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Mencocokkan teks pesan dengan satu keyword.
 * exact    : seluruh teks (trim, case-insensitive) sama dengan keyword.
 * contains : teks mengandung keyword (case-insensitive).
 */
export function keywordMatches(
  messageText: string,
  keyword: string,
  match: "exact" | "contains",
): boolean {
  const text = normalizeText(messageText);
  const kw = normalizeText(keyword);
  if (!kw) return false;
  return match === "exact" ? text === kw : text.includes(kw);
}

export interface AutomationFiredResult {
  automationId: string;
  runId: string;
  /** Pesan balasan langsung kind='keyword'; null untuk kind='sequence'. */
  outboundMessageId: string | null;
  /** Enrollment yang dibuat kind='sequence'; hanya terisi untuk sequence. */
  enrollmentId?: string;
  /**
   * String yang cocok: keyword (aturan keyword), payload (aturan
   * postback/quick_reply, G5), atau "" untuk aturan welcome yang
   * tidak mencocokkan string apa pun.
   */
  matchedKeyword: string;
  /** G5: payload tombol yang cocok untuk aturan sinyal; null selain itu. */
  matchedPayload: string | null;
}

export interface EvaluateInboundResult {
  /**
   * Pesan tidak ditemukan / bukan inbound / percakapan hilang / pesan
   * milik percakapan channel siaran (Fase 6A.2 — channel tidak pernah
   * dievaluasi automation).
   */
  evaluated: boolean;
  fired: AutomationFiredResult[];
  /**
   * Jumlah automation cocok yang TIDAK menembak baru untuk pesan ini:
   * duplikat (run untuk pesan ini sudah ada) atau pendaftaran sequence
   * yang diabaikan karena kontak masih punya enrollment aktif. Keduanya
   * berarti pesan sudah "ditangani automation" — worker tidak meneruskan
   * pesan seperti ini ke agent AI.
   */
  skippedDuplicates: number;
  /** Enrollment aktif yang dibatalkan karena pesan masuk ini (aturan 2C-a). */
  cancelledEnrollments: number;
  /**
   * Fase 8A: run flow yang DIMULAI pesan ini (flow aktif dengan
   * trigger cocok, sesudah pencocokan automation). Run yang dimulai
   * dihitung sebagai pesan tertangani — worker tidak meneruskannya
   * ke agent (urutan keyword → flow → AI).
   */
  flowRunsStarted: number;
  /**
   * Fase 8A: flow cocok yang TIDAK memulai run baru karena run untuk
   * pesan ini sudah ada (evaluasi ulang/replay) — pesan tetap dianggap
   * tertangani flow, worker tidak meneruskannya ke agent.
   */
  flowDuplicateStarts: number;
  /** Fase 8A: run flow `waiting` yang dibatalkan karena kontak opt-out. */
  cancelledFlowRuns: number;
  /**
   * Fase 13C: aksi consent tingkat sistem yang ditangkap pesan ini
   * ("opt_in" / "opt_out" dari kata kunci persetujuan), null bila
   * bukan pesan consent. Pesan consent TERTANGANI SISTEM: evaluasi
   * berhenti di sini (keyword automation & flow dilewati) dan worker
   * TIDAK meneruskannya ke agent — kata persis seperti "ikut" atau
   * "STOP" bukan pertanyaan untuk AI.
   */
  consentAction: "opt_in" | "opt_out" | null;
  /**
   * Fase 12A: run wait_reply parkir yang dilanjutkan pesan ini lewat
   * branch "replied". Dihitung tertangani flow (worker tidak
   * meneruskan ke agent) — pesan itu adalah bagian dari perjalanan
   * flow yang sedang menunggu, dan cabang replied adalah responsnya.
   */
  flowWaitReplyResumed: number;
  /**
   * Fase 13E: run questionnaire parkir yang memproses pesan ini
   * sebagai jawaban. Dihitung tertangani flow seperti wait_reply —
   * worker tidak meneruskannya ke agent.
   */
  flowQuestionnaireResumed: number;
  /**
   * Fase 13F: run show_catalog parkir yang memproses pesan ini
   * sebagai pilihan katalog. Dihitung tertangani flow seperti
   * questionnaire — worker tidak meneruskannya ke agent.
   */
  flowCatalogResumed: number;
  /**
   * Fase 13G: run book_appointment parkir yang memproses pesan ini
   * sebagai pilihan slot. Dihitung tertangani flow seperti katalog —
   * worker tidak meneruskannya ke agent.
   */
  flowAppointmentResumed: number;
  /**
   * G5: jenis sinyal tombol yang dibawa pesan ini ('postback' /
   * 'quick_reply'), null untuk pesan biasa / tidak dievaluasi. Worker
   * memakai ini untuk menutup jalur agent bagi postback: payload
   * mesin yang tidak dikenal bukan percakapan (trigger-priority.ts
   * kelas 1) — pesan tetap `evaluated` tetapi tidak diteruskan.
   */
  triggerSignalKind: "postback" | "quick_reply" | null;
}

/**
 * Mengevaluasi SATU pesan inbound terhadap automation aktif tenant.
 * Dipanggil worker untuk job `automation.evaluate`. Aman dipanggil berulang
 * untuk pesan yang sama (idempoten — lihat catatan di kepala file).
 *
 * Urutan dalam satu evaluasi — SUMBER KEBENARANNYA trigger-priority.ts
 * (jangan ditulis ulang di sini): lapisan keselamatan (aturan berhenti
 * sequence 2C-a + tangkapan consent 13C + resume parkir & gerbang
 * opt-out di fase flow) → postback → quick reply → keyword/sequence →
 * flow per kelas → welcome → (worker) agent. Aturan berhenti 2C-a:
 * enrollment AKTIF di percakapan ini yang dibuat SEBELUM pesan ini
 * (dan bukan oleh pesan ini) dibatalkan — kontak yang membalas
 * dianggap tidak lagi ingin menerima rangkaian; audit
 * `sequence.cancelled_reply` per enrollment.
 */
export async function evaluateInboundMessageForAutomations(
  db: Database,
  input: { tenantId: string; conversationId: string; messageId: string },
  opts?: { googleDeps?: GoogleDeps },
): Promise<EvaluateInboundResult> {
  const { tenantId, conversationId, messageId } = input;

  const context = await withTenantDb(db, tenantId, async (tx) => {
    const [message] = await tx
      .select()
      .from(messages)
      .where(
        and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)),
      )
      .limit(1);
    if (!message || message.direction !== "inbound") return null;
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!conversation) return null;
    // PENJAGA CHANNEL (Fase 6A.2): percakapan `kind='channel'` adalah
    // linimasa siaran satu arah, BUKAN percakapan — TIDAK ada keyword
    // automation, TIDAK ada pendaftaran sequence, TIDAK ada pembatalan
    // enrollment yang boleh berjalan untuk pesannya. Jalur ingest
    // channel memang tidak menulis event outbox, jadi penjaga eksplisit
    // ini adalah lapis kedua: event `message.received` liar yang
    // mengarah ke pesan channel tetap berhenti di sini, sebelum efek
    // samping apa pun (termasuk aturan berhenti sequence di bawah).
    if (conversation.kind === "channel") return "channel" as const;
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.id, conversation.contactId),
        ),
      )
      .limit(1);
    // G5: evaluator memuat SEMUA automation pemicu PESAN aktif
    // (keyword/postback/quick_reply/welcome) — fase-fase di bawah
    // memilahnya per kelas prioritas (trigger-priority.ts). Aturan
    // 'comment' tidak pernah lewat sini (jalur komentar tersendiri).
    const active = await tx
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, tenantId),
          inArray(automations.triggerType, [
            "keyword",
            "postback",
            "quick_reply",
            "welcome",
          ]),
          eq(automations.isActive, true),
        ),
      );

    // G5: "pesan pertama" untuk pemicu welcome = tidak ada pesan
    // MASUK lain di percakapan ini yang lebih dulu (atau sezaman —
    // seri waktu diselesaikan demi keamanan: pesan sezaman lain
    // membuat pesan ini BUKAN yang pertama). Penjaga sekali-per-kontak
    // per aturan tetap riwayat run, bukan cek ini.
    const [earlierInbound] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.conversationId, conversationId),
          eq(messages.direction, "inbound"),
          or(
            lt(messages.createdAt, message.createdAt),
            and(
              eq(messages.createdAt, message.createdAt),
              sql`${messages.id} <> ${message.id}`,
            ),
          ),
        ),
      )
      .limit(1);
    const isFirstInboundMessage = !earlierInbound;

    // --- Aturan berhenti 2C-a: pesan masuk membatalkan enrollment aktif ---
    const activeEnrollments = await tx
      .select()
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.tenantId, tenantId),
          eq(sequenceEnrollments.conversationId, conversationId),
          eq(sequenceEnrollments.status, "active"),
        ),
      );
    let cancelledEnrollments = 0;
    for (const enrollment of activeEnrollments) {
      // Enrollment yang dibuat OLEH pesan ini tidak dibatalkan olehnya;
      // enrollment yang dibuat SETELAH pesan ini juga tidak (urutan waktu).
      if (enrollment.triggerMessageId === messageId) continue;
      if (enrollment.createdAt > message.createdAt) continue;
      const now = new Date();
      await tx
        .update(sequenceEnrollments)
        .set({ status: "cancelled", nextRunAt: null, updatedAt: now })
        .where(
          and(
            eq(sequenceEnrollments.id, enrollment.id),
            eq(sequenceEnrollments.status, "active"),
          ),
        );
      await tx.insert(auditLogs).values({
        tenantId,
        actorType: "system",
        actorId: `sequence:${enrollment.automationId}`,
        action: "sequence.cancelled_reply",
        meta: {
          automationId: enrollment.automationId,
          enrollmentId: enrollment.id,
          cancelledByMessageId: messageId,
          conversationId,
        },
      });
      cancelledEnrollments += 1;
    }

    return {
      message,
      conversation,
      contact,
      active,
      cancelledEnrollments,
      isFirstInboundMessage,
    };
  });

  if (!context)
    return {
      evaluated: false,
      fired: [],
      skippedDuplicates: 0,
      cancelledEnrollments: 0,
      flowRunsStarted: 0,
      flowDuplicateStarts: 0,
      cancelledFlowRuns: 0,
      flowWaitReplyResumed: 0,
      flowQuestionnaireResumed: 0,
      flowCatalogResumed: 0,
      flowAppointmentResumed: 0,
      consentAction: null,
      triggerSignalKind: null,
    };
  // Percakapan channel (Fase 6A.2): dievaluasi = tidak — tidak ada
  // tembakan automation dan (karena `evaluated` false) worker juga tidak
  // meneruskan pesan ini ke agent AI.
  if (context === "channel")
    return {
      evaluated: false,
      fired: [],
      skippedDuplicates: 0,
      cancelledEnrollments: 0,
      flowRunsStarted: 0,
      flowDuplicateStarts: 0,
      cancelledFlowRuns: 0,
      flowWaitReplyResumed: 0,
      flowQuestionnaireResumed: 0,
      flowCatalogResumed: 0,
      flowAppointmentResumed: 0,
      consentAction: null,
      triggerSignalKind: null,
    };
  const text = context.message.contentText ?? "";
  // G5: sinyal tombol pesan ini (dari parser channel lewat
  // messages.trigger_signal) — penentu kelas prioritas fase-fase di
  // bawah (trigger-priority.ts). Teks biasa: null.
  const signal = triggerSignalOf(context.message);

  // --- Fase 13C: penangkapan consent tingkat sistem ----------------
  // Dievaluasi SEBELUM automation keyword & flow (dan, lewat flag
  // consentAction di hasil, sebelum agent): teks yang persis sama
  // dengan kata kunci opt-in/opt-out tenant adalah perintah
  // persetujuan, bukan percakapan. Opt-in mengirim balasan konfirmasi
  // SEKALI per transisi masuk ke opted_in (evaluasi ulang pesan yang
  // sama tidak mengirim ulang karena transisinya sudah lewat);
  // opt-out tanpa balasan. Kegagalan kirim konfirmasi TIDAK
  // menggagalkan perubahan consent-nya.
  if (context.contact) {
    const settings = await getOptInSettings(db, tenantId);
    const consentMatch = matchConsentKeyword(text, settings);
    if (consentMatch) {
      const consent = await setContactConsent(db, {
        tenantId,
        contactId: context.contact.id,
        action: consentMatch,
        source: "keyword",
      });
      if (consent) {
        if (
          consentMatch === "opt_in" &&
          consent.becameOptedIn &&
          settings.optInConfirmationText
        ) {
          try {
            await withTenantDb(db, tenantId, async (tx) => {
              const rendered = renderMessageText(
                settings.optInConfirmationText!,
                { name: context.contact?.name },
              );
              const [outbound] = await tx
                .insert(messages)
                .values({
                  tenantId,
                  conversationId,
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
                .where(eq(conversations.id, conversationId));
              await tx.insert(outboxEvents).values({
                tenantId,
                type: "message.queued",
                payload: {
                  provider: context.conversation.provider,
                  conversationId,
                  messageId: outbound.id,
                  via: "consent",
                },
              });
            });
          } catch {
            // Konfirmasi gagal antre ≠ opt-in gagal: persetujuan sudah
            // tercatat; balasan konfirmasi bersifat sopan-santun.
          }
        }
        return {
          evaluated: true,
          fired: [],
          skippedDuplicates: 0,
          cancelledEnrollments: context.cancelledEnrollments,
          flowRunsStarted: 0,
          flowDuplicateStarts: 0,
          cancelledFlowRuns: 0,
          flowWaitReplyResumed: 0,
          flowQuestionnaireResumed: 0,
      flowCatalogResumed: 0,
      flowAppointmentResumed: 0,
          consentAction: consentMatch,
          triggerSignalKind: signal?.kind ?? null,
        };
      }
    }
  }

  const fired: AutomationFiredResult[] = [];
  let skippedDuplicates = 0;

  // ------------------------------------------------------------------
  // G5: fase-fase kelas pemicu (urutan = trigger-priority.ts, sumber
  // kebenaran tunggalnya): postback → quick reply → keyword → flow →
  // welcome automation → (worker: agent). Lapisan keselamatan (aturan
  // berhenti sequence + tangkapan consent) SUDAH berjalan di atas.
  // Badan tembakan SATU aturan diekstrak ke `fireRule` agar semua
  // kelas memakai jalur idempotensi/audit/outbox yang sama persis;
  // yang berbeda antar kelas hanyalah pencocok & labelnya.
  // ------------------------------------------------------------------
  type RuleMatch = { matchedKeyword: string; matchedPayload: string | null };
  const fireRule = async (automation: Automation, match: RuleMatch) => {
    const matchedKeyword = match.matchedKeyword;
    // Detail run: bentuk warisan { matchedKeyword } untuk aturan
    // teks; aturan sinyal menambahkan matchedPayload-nya.
    const matchDetail: Record<string, unknown> = match.matchedPayload
      ? { matchedKeyword, matchedPayload: match.matchedPayload }
      : { matchedKeyword };

    const outcome = await withTenantDb(db, tenantId, async (tx) => {
      // Penjaga idempotensi: run untuk (automation, pesan pemicu) ini sudah ada?
      const [existingRun] = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.automationId, automation.id),
            eq(automationRuns.triggerMessageId, messageId),
          ),
        )
        .limit(1);
      if (existingRun) return { kind: "duplicate" as const };

      // ---- kind 'sequence': daftarkan kontak ke rangkaian (Fase 2C) ----
      if (automation.kind === "sequence") {
        // Logika pendaftaran hidup di service bersama (sequence-enroll,
        // G2b) — jalur ini hanya menyalurkan konteks kata kuncinya dan
        // memetakan outcome ke bentuk hasil evaluasi. recordNoStepsRun
        // mempertahankan perilaku 2C: sequence tanpa langkah tetap
        // tercatat sebagai run `skipped` beralasan no_steps.
        const result = await enrollContactInSequence(tx, {
          tenantId,
          automationId: automation.id,
          contactId: context.conversation.contactId,
          conversationId,
          triggerMessageId: messageId,
          runDetailExtra: matchDetail,
          auditMetaExtra: matchDetail,
          recordNoStepsRun: true,
        });
        if (result.kind === "enrolled") {
          return {
            kind: "enrolled" as const,
            runId: result.runId,
            enrollmentId: result.enrollmentId,
            matchedKeyword,
          };
        }
        if (result.kind === "sequence_unavailable") {
          // Tidak tercapai: daftar `active` hanya memuat automation
          // aktif dan kind-nya sudah diperiksa tepat di atas. Defensif:
          // perlakukan seperti duplikat (pesan tertangani, tanpa run).
          return { kind: "duplicate" as const };
        }
        // already_enrolled / no_steps: service sudah mencatat run
        // `skipped`-nya — pesan tertangani automation.
        return { kind: "skipped" as const, runId: result.runId! };
      }

      // ---- kind 'keyword': balasan langsung (Fase 2A) ----
      const [run] = await tx
        .insert(automationRuns)
        .values({
          tenantId,
          automationId: automation.id,
          contactId: context.conversation.contactId,
          conversationId,
          triggerMessageId: messageId,
          status: "completed",
          detail: matchDetail,
        })
        .returning();

      const rendered = renderMessageText(automation.actionConfig.text, {
        name: context.contact?.name,
      });
      const [outbound] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId,
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
        .where(eq(conversations.id, conversationId));

      await tx
        .update(automationRuns)
        .set({
          detail: { ...matchDetail, outboundMessageId: outbound.id },
        })
        .where(eq(automationRuns.id, run.id));

      await tx.insert(auditLogs).values({
        tenantId,
        actorType: "system",
        actorId: `automation:${automation.id}`,
        action: "automation.fired",
        meta: {
          automationId: automation.id,
          runId: run.id,
          triggerMessageId: messageId,
          outboundMessageId: outbound.id,
          matchedKeyword,
          ...(match.matchedPayload
            ? { matchedPayload: match.matchedPayload }
            : {}),
          triggerType: automation.triggerType,
          conversationId,
        },
      });

      await tx.insert(outboxEvents).values({
        tenantId,
        type: "message.queued",
        payload: {
          provider: context.conversation.provider,
          conversationId,
          messageId: outbound.id,
          via: "automation",
          automationId: automation.id,
        },
      });

      return {
        kind: "fired" as const,
        runId: run.id,
        outboundMessageId: outbound.id,
        matchedKeyword,
      };
    }).catch((err: unknown) => {
      // Index unik parsial adalah penahan terakhir bila dua evaluasi balapan:
      // perlakukan pelanggaran unik (run ganda, atau enrollment aktif ganda)
      // sebagai duplikat, bukan kegagalan job.
      if (
        err instanceof Error &&
        /automation_runs_automation_trigger_message_unique|sequence_enrollments_active_unique/.test(
          err.message,
        )
      ) {
        return { kind: "duplicate" as const };
      }
      throw err;
    });

    return outcome;
  };

  /** Menyerap outcome fireRule ke akumulasi hasil; true = pesan tertangani aturan ini. */
  const absorbOutcome = (
    automation: Automation,
    match: RuleMatch,
    outcome: Awaited<ReturnType<typeof fireRule>>,
  ): boolean => {
    if (outcome.kind === "duplicate" || outcome.kind === "skipped") {
      skippedDuplicates += 1;
      return true;
    }
    if (outcome.kind === "enrolled") {
      fired.push({
        automationId: automation.id,
        runId: outcome.runId,
        outboundMessageId: null,
        enrollmentId: outcome.enrollmentId,
        matchedKeyword: outcome.matchedKeyword,
        matchedPayload: match.matchedPayload,
      });
      return true;
    }
    fired.push({
      automationId: automation.id,
      runId: outcome.runId,
      outboundMessageId: outcome.outboundMessageId,
      matchedKeyword: outcome.matchedKeyword,
      matchedPayload: match.matchedPayload,
    });
    return true;
  };

  /**
   * Menjalankan SATU fase kelas pemicu: semua aturan jenis itu yang
   * lolos `matcher` ditembakkan (multi-fire seperti perilaku warisan).
   * Mengembalikan jumlah aturan yang tertangani (menembak/duplikat) —
   * bahan keputusan penekanan kelas di bawahnya.
   */
  const runAutomationPhase = async (
    triggerType: Automation["triggerType"],
    matcher: (automation: Automation) => RuleMatch | null,
  ): Promise<number> => {
    let handled = 0;
    for (const automation of context.active) {
      if (automation.triggerType !== triggerType) continue;
      const match = matcher(automation);
      if (!match) continue;
      const outcome = await fireRule(automation, match);
      if (absorbOutcome(automation, match, outcome)) handled += 1;
    }
    return handled;
  };

  const signalMatcher = (automation: Automation): RuleMatch | null =>
    signal &&
    triggerPayloadMatches(automation.triggerConfig.payloads, signal.payload)
      ? { matchedKeyword: signal.payload, matchedPayload: signal.payload }
      : null;

  const buildResult = (
    flowOutcome: Awaited<ReturnType<typeof startFlowRunsForInboundMessage>>,
  ): EvaluateInboundResult => ({
    evaluated: true,
    fired,
    skippedDuplicates,
    cancelledEnrollments: context.cancelledEnrollments,
    flowRunsStarted: flowOutcome.startedRunIds.length,
    flowDuplicateStarts: flowOutcome.duplicateStarts,
    cancelledFlowRuns: flowOutcome.cancelledRunIds.length,
    flowWaitReplyResumed: flowOutcome.resumedRunIds.length,
    flowQuestionnaireResumed: flowOutcome.questionnaireResumedRunIds.length,
    flowCatalogResumed: flowOutcome.catalogResumedRunIds.length,
    flowAppointmentResumed: flowOutcome.appointmentResumedRunIds.length,
    consentAction: null,
    triggerSignalKind: signal?.kind ?? null,
  });

  // --- Kelas 1: POSTBACK — pesan bersinyal postback HANYA dicocokkan
  // ke pemicu postback, lalu evaluasi selesai (kelas teks & agent
  // tidak pernah melihat payload mesin; lihat trigger-priority.ts).
  if (signal?.kind === "postback") {
    await runAutomationPhase("postback", signalMatcher);
    const flowOutcome = await startFlowRunsForInboundMessage(
      db,
      {
        tenantId,
        conversationId,
        messageId,
        messageText: text,
        contact: context.contact ?? null,
        conversation: context.conversation,
        triggerSignal: signal,
        isFirstInboundMessage: context.isFirstInboundMessage,
        suppressKeywordTriggers: true,
        suppressWelcomeTriggers: true,
      },
      { googleDeps: opts?.googleDeps },
    );
    return buildResult(flowOutcome);
  }

  // --- Kelas 2: QUICK REPLY — automation QR lebih dulu; kecocokannya
  // (di automation ATAU flow, lewat pra-pindai) menekan kelas keyword.
  let quickReplyHandled = 0;
  let flowPreviewClasses: TriggerClass[] = [];
  if (signal?.kind === "quick_reply") {
    quickReplyHandled = await runAutomationPhase(
      "quick_reply",
      signalMatcher,
    );
    flowPreviewClasses = await previewFlowTriggerClasses(db, {
      tenantId,
      messageText: text,
      signal,
      isFirstInboundMessage: context.isFirstInboundMessage,
    });
  }
  const quickReplyMatched =
    quickReplyHandled > 0 || flowPreviewClasses.includes("quick_reply");

  // --- Kelas 3: KEYWORD / SEQUENCE automation (multi-fire warisan).
  let keywordHandled = 0;
  if (!quickReplyMatched) {
    keywordHandled = await runAutomationPhase("keyword", (automation) => {
      const matchedKeyword = automation.triggerConfig.keywords.find((kw) =>
        keywordMatches(text, kw, automation.triggerConfig.match),
      );
      return matchedKeyword
        ? { matchedKeyword, matchedPayload: null }
        : null;
    });
  }

  // --- Fase flow (Fase 8A + G5): pemicu flow per kelas — postback/
  // quick reply/keyword/welcome/any_message — dengan penekanan yang
  // dihitung dari fase automation di atas (QR automation menekan
  // keyword flow; keyword/QR menekan welcome flow). Resume run parkir
  // & gerbang opt-out tetap di dalam, selalu berjalan (lapisan
  // keselamatan trigger-priority.ts). Kontak opt-out tidak memulai
  // run dan run `waiting`-nya di percakapan ini dibatalkan di sana.
  const flowOutcome = await startFlowRunsForInboundMessage(
    db,
    {
      tenantId,
      conversationId,
      messageId,
      messageText: text,
      contact: context.contact ?? null,
      conversation: context.conversation,
      triggerSignal: signal,
      isFirstInboundMessage: context.isFirstInboundMessage,
      suppressKeywordTriggers: quickReplyHandled > 0,
      suppressWelcomeTriggers: quickReplyMatched || keywordHandled > 0,
    },
    { googleDeps: opts?.googleDeps },
  );

  // --- Kelas 4: WELCOME automation — hanya pesan pertama percakapan,
  // hanya bila TIDAK ada kelas di atasnya (sinyal/keyword, automation
  // maupun flow) yang menembak untuk pesan ini, dan hanya SEKALI per
  // kontak per aturan: riwayat run/enrollment aturan ini untuk kontak
  // ini adalah penjaganya (kontak yang membuka percakapan BARU tidak
  // disambut dua kali oleh aturan yang sama). Aturan yang sudah
  // pernah menyambut kontak ini dilewati DIAM-DIAM — bukan duplikat:
  // pesan percakapan baru yang sah tetap boleh jatuh ke agent.
  const higherClassFired =
    quickReplyMatched ||
    keywordHandled > 0 ||
    flowOutcome.matchedTriggerClasses.some(
      (cls) =>
        cls === "postback" || cls === "quick_reply" || cls === "keyword",
    );
  if (context.isFirstInboundMessage && !higherClassFired) {
    for (const automation of context.active) {
      if (automation.triggerType !== "welcome") continue;
      const alreadyWelcomed = await withTenantDb(db, tenantId, async (tx) => {
        const [run] = await tx
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.automationId, automation.id),
              eq(automationRuns.contactId, context.conversation.contactId),
            ),
          )
          .limit(1);
        if (run) return true;
        const [enrollment] = await tx
          .select({ id: sequenceEnrollments.id })
          .from(sequenceEnrollments)
          .where(
            and(
              eq(sequenceEnrollments.automationId, automation.id),
              eq(sequenceEnrollments.contactId, context.conversation.contactId),
            ),
          )
          .limit(1);
        return !!enrollment;
      });
      if (alreadyWelcomed) continue;
      const match: RuleMatch = { matchedKeyword: "", matchedPayload: null };
      const outcome = await fireRule(automation, match);
      absorbOutcome(automation, match, outcome);
    }
  }

  return buildResult(flowOutcome);
}

// ---------------------------------------------------------------------------
// Eksekusi langkah sequence (sisi worker, job `sequence.step`)
// ---------------------------------------------------------------------------

export interface ExecuteSequenceStepResult {
  executed: boolean;
  reason?:
    | "enrollment_not_found"
    | "enrollment_not_active"
    | "stale_step"
    | "step_not_found"
    | "contact_opted_out";
  outboundMessageId?: string;
  /** Percakapan tujuan langkah (Fase 6G: untuk nudge realtime worker). */
  conversationId?: string;
  /** Posisi langkah berikutnya yang dijadwalkan; null bila rangkaian selesai. */
  nextStepPosition?: number | null;
}

/**
 * Menjalankan SATU langkah sequence untuk job BullMQ `sequence.step`.
 * Aman dipanggil berulang: job basi (posisi != current_step + 1) dan
 * enrollment yang sudah tidak aktif selesai diam-diam tanpa efek.
 *
 * Yang dilakukan saat langkah dieksekusi (satu transaksi tenant):
 * pesan outbound `sender_type='system'` status `queued` (teks langkah,
 * placeholder {name}) + event `message.queued` (poller API mengirim) →
 * current_step maju → langkah berikut dijadwalkan lewat event outbox
 * `sequence.step_due` (relay → job tertunda), atau enrollment selesai
 * (`completed`, audit `sequence.completed`).
 *
 * Aturan berhenti yang diperiksa di sini:
 * - kontak opt-out (contacts.opt_in_status = 'opted_out') → enrollment
 *   dibatalkan, audit `sequence.cancelled_opt_out`, tidak ada pesan.
 * Pembatalan karena kontak membalas terjadi di jalur evaluasi pesan masuk
 * (`evaluateInboundMessageForAutomations`), bukan di sini. Status aktif
 * automation SENGAJA tidak diperiksa: mematikan automation tidak
 * membatalkan rangkaian yang sedang berjalan (keputusan Fase 2C).
 */
export async function executeSequenceStep(
  db: Database,
  input: { tenantId: string; enrollmentId: string; stepPosition: number },
): Promise<ExecuteSequenceStepResult> {
  const { tenantId, enrollmentId, stepPosition } = input;
  return withTenantDb(db, tenantId, async (tx) => {
    const [enrollment] = await tx
      .select()
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.tenantId, tenantId),
          eq(sequenceEnrollments.id, enrollmentId),
        ),
      )
      .limit(1);
    if (!enrollment) return { executed: false, reason: "enrollment_not_found" };
    if (enrollment.status !== "active") {
      return { executed: false, reason: "enrollment_not_active" };
    }
    if (stepPosition !== enrollment.currentStep + 1) {
      return { executed: false, reason: "stale_step" };
    }

    const [step] = await tx
      .select()
      .from(automationSteps)
      .where(
        and(
          eq(automationSteps.tenantId, tenantId),
          eq(automationSteps.automationId, enrollment.automationId),
          eq(automationSteps.position, stepPosition),
        ),
      )
      .limit(1);
    const now = new Date();
    if (!step) {
      // Defensif: posisi yang diminta tidak ada — tutup rangkaian.
      await tx
        .update(sequenceEnrollments)
        .set({ status: "completed", nextRunAt: null, updatedAt: now })
        .where(eq(sequenceEnrollments.id, enrollmentId));
      await tx.insert(auditLogs).values({
        tenantId,
        actorType: "system",
        actorId: `sequence:${enrollment.automationId}`,
        action: "sequence.completed",
        meta: {
          automationId: enrollment.automationId,
          enrollmentId,
          reason: "step_not_found",
          stepPosition,
        },
      });
      return { executed: false, reason: "step_not_found" };
    }

    const [contact] = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.id, enrollment.contactId),
        ),
      )
      .limit(1);
    if (contact?.optInStatus === "opted_out") {
      await tx
        .update(sequenceEnrollments)
        .set({ status: "cancelled", nextRunAt: null, updatedAt: now })
        .where(eq(sequenceEnrollments.id, enrollmentId));
      await tx.insert(auditLogs).values({
        tenantId,
        actorType: "system",
        actorId: `sequence:${enrollment.automationId}`,
        action: "sequence.cancelled_opt_out",
        meta: {
          automationId: enrollment.automationId,
          enrollmentId,
          stepPosition,
        },
      });
      return { executed: false, reason: "contact_opted_out" };
    }

    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.id, enrollment.conversationId),
        ),
      )
      .limit(1);

    const rendered = renderMessageText(step.text, { name: contact?.name });
    const [outbound] = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: enrollment.conversationId,
        direction: "outbound",
        senderType: "system",
        type: "text",
        contentText: rendered,
        status: "queued",
      })
      .returning();
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, enrollment.conversationId));
    await tx.insert(outboxEvents).values({
      tenantId,
      type: "message.queued",
      payload: {
        provider: conversation?.provider,
        conversationId: enrollment.conversationId,
        messageId: outbound.id,
        via: "sequence",
        automationId: enrollment.automationId,
        enrollmentId,
        stepPosition,
      },
    });
    await tx.insert(auditLogs).values({
      tenantId,
      actorType: "system",
      actorId: `sequence:${enrollment.automationId}`,
      action: "sequence.step_sent",
      meta: {
        automationId: enrollment.automationId,
        enrollmentId,
        stepPosition,
        outboundMessageId: outbound.id,
        conversationId: enrollment.conversationId,
      },
    });

    const [nextStep] = await tx
      .select()
      .from(automationSteps)
      .where(
        and(
          eq(automationSteps.tenantId, tenantId),
          eq(automationSteps.automationId, enrollment.automationId),
          eq(automationSteps.position, stepPosition + 1),
        ),
      )
      .limit(1);
    if (nextStep) {
      const nextRunAt = new Date(now.getTime() + nextStep.delayMinutes * 60_000);
      await tx
        .update(sequenceEnrollments)
        .set({ currentStep: stepPosition, nextRunAt, updatedAt: now })
        .where(eq(sequenceEnrollments.id, enrollmentId));
      await tx.insert(outboxEvents).values({
        tenantId,
        type: "sequence.step_due",
        payload: {
          enrollmentId,
          automationId: enrollment.automationId,
          stepPosition: nextStep.position,
          delayMinutes: nextStep.delayMinutes,
        },
      });
      return {
        executed: true,
        outboundMessageId: outbound.id,
        conversationId: enrollment.conversationId,
        nextStepPosition: nextStep.position,
      };
    }

    await tx
      .update(sequenceEnrollments)
      .set({
        currentStep: stepPosition,
        status: "completed",
        nextRunAt: null,
        updatedAt: now,
      })
      .where(eq(sequenceEnrollments.id, enrollmentId));
    await tx.insert(auditLogs).values({
      tenantId,
      actorType: "system",
      actorId: `sequence:${enrollment.automationId}`,
      action: "sequence.completed",
      meta: {
        automationId: enrollment.automationId,
        enrollmentId,
        totalSteps: stepPosition,
        conversationId: enrollment.conversationId,
      },
    });
    return {
      executed: true,
      outboundMessageId: outbound.id,
      conversationId: enrollment.conversationId,
      nextStepPosition: null,
    };
  });
}
