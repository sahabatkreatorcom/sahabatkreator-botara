import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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
import { startFlowRunsForInboundMessage } from "./flows";
import type { GoogleDeps } from "./google-calendar";
import { setContactConsent } from "./contacts";
import { getOptInSettings, matchConsentKeyword } from "./optin";

/**
 * Service domain automation (Fase 2A, RANCANGAN §5 & §6; Fase 2C sequence).
 * Transport-agnostic; semua query dalam konteks RLS tenant.
 *
 * Tiga sisi:
 * 1. Manajemen (dipakai API dashboard): CRUD automation + riwayat
 *    automation_runs + daftar sequence_enrollments.
 * 2. Evaluasi (dipakai worker lewat job `automation.evaluate`): pesan
 *    inbound dicocokkan ke automation aktif milik tenant (pemicu tetap
 *    keyword untuk semua jenis):
 *      - kind 'keyword'  → balasan outbound `sender_type='system'`
 *        berstatus `queued` + run `completed` + audit `automation.fired`
 *        + event outbox `message.queued` (perilaku Fase 2A).
 *      - kind 'sequence' → kontak didaftarkan ke rangkaian
 *        (sequence_enrollments) + run `completed` + audit
 *        `sequence.enrolled` + event outbox `sequence.step_due` yang oleh
 *        relay worker diterjemahkan menjadi job BullMQ tertunda
 *        `sequence.step`. Pendaftaran ulang saat enrollment masih aktif
 *        diabaikan: run dicatat `skipped` (alasan already_enrolled).
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
}

export interface UpdateAutomationInput {
  name?: string;
  keywords?: string[];
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
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(automations)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        triggerType: kind === "comment" ? "comment" : "keyword",
        triggerConfig: {
          keywords: input.keywords,
          match: input.match,
          ...(kind === "comment"
            ? { channelAccountId: input.channelAccountId }
            : {}),
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
        isActive: true,
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
    if (input.keywords !== undefined || input.match !== undefined) {
      patch.triggerConfig = {
        keywords: input.keywords ?? existing.triggerConfig.keywords,
        match: input.match ?? existing.triggerConfig.match,
        // Fase 10B: ikatan akun aturan komentar tidak berubah lewat
        // patch — dipertahankan apa adanya dari baris yang ada.
        ...(existing.triggerConfig.channelAccountId
          ? { channelAccountId: existing.triggerConfig.channelAccountId }
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
  matchedKeyword: string;
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
}

/**
 * Mengevaluasi SATU pesan inbound terhadap automation aktif tenant.
 * Dipanggil worker untuk job `automation.evaluate`. Aman dipanggil berulang
 * untuk pesan yang sama (idempoten — lihat catatan di kepala file).
 *
 * Urutan dalam satu evaluasi:
 * 1. Pembatalan sequence (aturan berhenti 2C-a): enrollment AKTIF di
 *    percakapan ini yang dibuat SEBELUM pesan ini (dan bukan oleh pesan
 *    ini) dibatalkan — kontak yang membalas dianggap tidak lagi ingin
 *    menerima rangkaian. Audit `sequence.cancelled_reply` per enrollment.
 * 2. Pencocokan keyword ke semua automation aktif; kind 'keyword'
 *    menembakkan balasan langsung, kind 'sequence' mendaftarkan kontak.
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
    const active = await tx
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, tenantId),
          eq(automations.triggerType, "keyword"),
          eq(automations.isActive, true),
        ),
      );
    const steps =
      active.some((a) => a.kind === "sequence")
        ? await tx
            .select()
            .from(automationSteps)
            .where(eq(automationSteps.tenantId, tenantId))
            .orderBy(asc(automationSteps.position))
        : [];
    const stepsByAutomation = new Map<string, AutomationStep[]>();
    for (const step of steps) {
      const list = stepsByAutomation.get(step.automationId) ?? [];
      list.push(step);
      stepsByAutomation.set(step.automationId, list);
    }

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

    return { message, conversation, contact, active, stepsByAutomation, cancelledEnrollments };
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
    };
  const text = context.message.contentText ?? "";

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
        };
      }
    }
  }

  const fired: AutomationFiredResult[] = [];
  let skippedDuplicates = 0;

  for (const automation of context.active) {
    const matchedKeyword = automation.triggerConfig.keywords.find((kw) =>
      keywordMatches(text, kw, automation.triggerConfig.match),
    );
    if (!matchedKeyword) continue;

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
        const steps = context.stepsByAutomation.get(automation.id) ?? [];
        const firstStep = steps[0];
        if (!firstStep) {
          // Sequence tanpa langkah tidak bisa dibuat lewat API; catat
          // skipped secara defensif dan anggap pesan tertangani.
          const [run] = await tx
            .insert(automationRuns)
            .values({
              tenantId,
              automationId: automation.id,
              contactId: context.conversation.contactId,
              conversationId,
              triggerMessageId: messageId,
              status: "skipped",
              detail: { matchedKeyword, reason: "no_steps" },
            })
            .returning();
          return { kind: "skipped" as const, runId: run.id };
        }
        const [activeEnrollment] = await tx
          .select({ id: sequenceEnrollments.id })
          .from(sequenceEnrollments)
          .where(
            and(
              eq(sequenceEnrollments.automationId, automation.id),
              eq(sequenceEnrollments.contactId, context.conversation.contactId),
              eq(sequenceEnrollments.status, "active"),
            ),
          )
          .limit(1);
        if (activeEnrollment) {
          // Pendaftaran ulang saat rangkaian masih berjalan: diabaikan.
          const [run] = await tx
            .insert(automationRuns)
            .values({
              tenantId,
              automationId: automation.id,
              contactId: context.conversation.contactId,
              conversationId,
              triggerMessageId: messageId,
              status: "skipped",
              detail: {
                matchedKeyword,
                reason: "already_enrolled",
                enrollmentId: activeEnrollment.id,
              },
            })
            .returning();
          return { kind: "skipped" as const, runId: run.id };
        }

        const now = new Date();
        const nextRunAt = new Date(
          now.getTime() + firstStep.delayMinutes * 60_000,
        );
        const [enrollment] = await tx
          .insert(sequenceEnrollments)
          .values({
            tenantId,
            automationId: automation.id,
            contactId: context.conversation.contactId,
            conversationId,
            triggerMessageId: messageId,
            currentStep: 0,
            status: "active",
            nextRunAt,
          })
          .returning();
        const [run] = await tx
          .insert(automationRuns)
          .values({
            tenantId,
            automationId: automation.id,
            contactId: context.conversation.contactId,
            conversationId,
            triggerMessageId: messageId,
            status: "completed",
            detail: {
              matchedKeyword,
              kind: "sequence",
              enrollmentId: enrollment.id,
            },
          })
          .returning();
        await tx.insert(auditLogs).values({
          tenantId,
          actorType: "system",
          actorId: `automation:${automation.id}`,
          action: "sequence.enrolled",
          meta: {
            automationId: automation.id,
            runId: run.id,
            enrollmentId: enrollment.id,
            triggerMessageId: messageId,
            conversationId,
            matchedKeyword,
            firstStepPosition: firstStep.position,
            nextRunAt: nextRunAt.toISOString(),
          },
        });
        // Jadwal langkah pertama: event outbox diterjemahkan relay worker
        // menjadi job BullMQ tertunda `sequence.step` (jobId deterministik
        // seq-<enrollmentId>-<position> — lihat @sahabat-kreator/queue).
        await tx.insert(outboxEvents).values({
          tenantId,
          type: "sequence.step_due",
          payload: {
            enrollmentId: enrollment.id,
            automationId: automation.id,
            stepPosition: firstStep.position,
            delayMinutes: firstStep.delayMinutes,
          },
        });
        return {
          kind: "enrolled" as const,
          runId: run.id,
          enrollmentId: enrollment.id,
          matchedKeyword,
        };
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
          detail: { matchedKeyword },
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
          detail: { matchedKeyword, outboundMessageId: outbound.id },
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

    if (outcome.kind === "duplicate" || outcome.kind === "skipped") {
      skippedDuplicates += 1;
    } else if (outcome.kind === "enrolled") {
      fired.push({
        automationId: automation.id,
        runId: outcome.runId,
        outboundMessageId: null,
        enrollmentId: outcome.enrollmentId,
        matchedKeyword: outcome.matchedKeyword,
      });
    } else {
      fired.push({
        automationId: automation.id,
        runId: outcome.runId,
        outboundMessageId: outcome.outboundMessageId,
        matchedKeyword: outcome.matchedKeyword,
      });
    }
  }

  // --- Fase 8A: flow engine — dievaluasi SETELAH automation keyword/
  // sequence (urutan keyword → flow → agent). Flow aktif yang
  // trigger-nya cocok memulai run; kontak opt-out tidak memulai run
  // dan run `waiting`-nya di percakapan ini dibatalkan di sana.
  const flowOutcome = await startFlowRunsForInboundMessage(
    db,
    {
      tenantId,
      conversationId,
      messageId,
      messageText: text,
      contact: context.contact ?? null,
      conversation: context.conversation,
    },
    { googleDeps: opts?.googleDeps },
  );

  return {
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
  };
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
