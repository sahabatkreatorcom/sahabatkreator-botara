import { and, arrayContains, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  automationRuns,
  automationSteps,
  automations,
  contacts,
  conversations,
  outboxEvents,
  sequenceEnrollments,
  type Conversation,
  type Database,
  type SequenceEnrollment,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Service pendaftaran (enrollment) sequence BERSAMA (gelombang G2b).
 *
 * Sebelum gelombang ini, logika "daftarkan kontak ke rangkaian" hidup
 * inline dan terduplikasi di dua tempat — evaluasi kata kunci
 * (`automations.ts`) dan node flow `enroll_sequence`
 * (`flows/execute.ts`) — sehingga entry point ketiga (pendaftaran
 * MANUAL dari dashboard) tidak punya rumah. Modul ini mengekstraknya
 * menjadi satu implementasi:
 *
 *   - `enrollContactInSequence(tx, …)` — operasi inti di dalam
 *     transaksi pemanggil: cek sequence tersedia (ada, kind
 *     'sequence', aktif) → cek langkah → cek enrollment aktif → tulis
 *     enrollment + run + audit `sequence.enrolled` + event outbox
 *     `sequence.step_due`. Perbedaan antar-jalur (detail run & meta
 *     audit) disalurkan lewat `runDetailExtra` / `auditMetaExtra`,
 *     BUKAN dengan menyalin logikanya.
 *   - `listContactMessagingConversations` — kandidat percakapan
 *     jangkar milik satu kontak.
 *   - `enrollContactInSequenceManually` / `enrollContactsInSequenceByTag`
 *     — entry point manual (API dashboard).
 *
 * Semantik jangkar pendaftaran manual (keputusan parent, G2b):
 * enrollment SELALU berjangkar ke satu percakapan PESAN (kind
 * 'private'/'group') milik kontak — kolom `conversation_id` memang
 * NOT NULL. Pemanggil boleh memilih percakapannya; bawaan = yang
 * terbaru. Kontak tanpa percakapan pesan TIDAK bisa didaftarkan:
 * hasilnya penolakan beralasan (`no_conversation`), bukan enrollment
 * mengambang. `trigger_message_id` manual = null (skema memang
 * menyiapkannya untuk pemicu non-pesan).
 *
 * Aturan berhenti TIDAK berubah dan berlaku sama untuk enrollment
 * manual, karena keduanya bekerja pada baris enrollment yang sama:
 * kontak membalas di percakapan jangkar → evaluasi inbound membatalkan
 * (audit `sequence.cancelled_reply`); kontak opt-out → langkah berikut
 * dibatalkan saat eksekusi (audit `sequence.cancelled_opt_out`).
 * Status per kontak tetap dibaca dari `sequence_enrollments` — tidak
 * ada model status kedua.
 */

/** Jenis percakapan yang sah menjadi jangkar enrollment. */
export const MESSAGING_CONVERSATION_KINDS = ["private", "group"] as const;

export interface EnrollContactInSequenceInput {
  tenantId: string;
  automationId: string;
  contactId: string;
  conversationId: string;
  /** Pesan pemicu; null untuk pendaftaran manual / per tag. */
  triggerMessageId: string | null;
  /**
   * Pelaku audit `sequence.enrolled`. Bawaan mengikuti perilaku jalur
   * lama: sistem atas nama automation (`automation:<id>`). Jalur
   * manual meneruskan user pelaku supaya jejak auditnya jujur.
   */
  actor?: { type: "system" | "user"; id: string };
  /**
   * Field ekstra yang digabung ke `detail` run (completed maupun
   * skipped) — konteks milik jalur pemanggil: kata kunci
   * `{ matchedKeyword }`, flow `{ via: "flow", flowId, flowRunId }`,
   * manual `{ via: "manual" }`.
   */
  runDetailExtra?: Record<string, unknown>;
  /**
   * Field ekstra yang digabung ke meta audit `sequence.enrolled` —
   * konteks milik jalur pemanggil. Hati-hati penamaan: kunci meta
   * menentukan target audit (lihat `deriveAuditTarget`); jalur flow
   * sengaja memakai `viaFlowId`/`viaFlowRunId` agar target tetap
   * `sequence_enrollment`.
   */
  auditMetaExtra?: Record<string, unknown>;
  /**
   * Bila true, sequence tanpa langkah tetap dicatat sebagai run
   * `skipped` beralasan `no_steps` (perilaku jalur kata kunci Fase
   * 2C). Jalur flow & manual: false — outcome-nya cukup dilaporkan ke
   * pemanggil (detail langkah flow / error API), tanpa run hantu.
   */
  recordNoStepsRun?: boolean;
}

export type EnrollContactInSequenceResult =
  | {
      kind: "enrolled";
      enrollmentId: string;
      runId: string;
      nextRunAt: Date;
      firstStepPosition: number;
    }
  | { kind: "already_enrolled"; enrollmentId: string; runId: string | null }
  | { kind: "no_steps"; runId: string | null }
  | { kind: "sequence_unavailable" };

/**
 * Daftarkan kontak ke satu sequence DI DALAM transaksi pemanggil.
 *
 * Urutan cek (sama untuk semua jalur):
 * 1. Sequence harus ada di tenant, kind 'sequence', dan aktif —
 *    selain itu `sequence_unavailable` tanpa tulisan apa pun.
 * 2. Sequence tanpa langkah → `no_steps` (run `skipped` hanya bila
 *    `recordNoStepsRun`).
 * 3. Enrollment aktif untuk (automation, kontak) sudah ada → run
 *    `skipped` beralasan `already_enrolled`; TIDAK ada enrollment
 *    kedua (index unik parsial `sequence_enrollments_active_unique`
 *    adalah penahan terakhir saat balapan — errornya dibiarkan
 *    merambat ke pemanggil seperti perilaku jalur lama).
 * 4. Selain itu: enrollment aktif baru (current_step 0, next_run_at =
 *    sekarang + jeda langkah pertama) + run `completed` + audit
 *    `sequence.enrolled` + event outbox `sequence.step_due` untuk
 *    langkah pertama (relay worker menerjemahkannya menjadi job
 *    BullMQ tertunda `sequence.step`).
 */
export async function enrollContactInSequence(
  tx: DbTx,
  input: EnrollContactInSequenceInput,
): Promise<EnrollContactInSequenceResult> {
  const { tenantId, automationId, contactId, conversationId } = input;

  const [automation] = await tx
    .select()
    .from(automations)
    .where(
      and(eq(automations.tenantId, tenantId), eq(automations.id, automationId)),
    )
    .limit(1);
  if (!automation || automation.kind !== "sequence" || !automation.isActive) {
    return { kind: "sequence_unavailable" };
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
    let runId: string | null = null;
    if (input.recordNoStepsRun) {
      const [run] = await tx
        .insert(automationRuns)
        .values({
          tenantId,
          automationId,
          contactId,
          conversationId,
          triggerMessageId: input.triggerMessageId,
          status: "skipped",
          detail: { ...(input.runDetailExtra ?? {}), reason: "no_steps" },
        })
        .returning();
      runId = run.id;
    }
    return { kind: "no_steps", runId };
  }

  const [activeEnrollment] = await tx
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.automationId, automationId),
        eq(sequenceEnrollments.contactId, contactId),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .limit(1);
  if (activeEnrollment) {
    // Pendaftaran ulang saat rangkaian masih berjalan: diabaikan,
    // tetapi percobaannya tetap tercatat sebagai run `skipped`.
    const [run] = await tx
      .insert(automationRuns)
      .values({
        tenantId,
        automationId,
        contactId,
        conversationId,
        triggerMessageId: input.triggerMessageId,
        status: "skipped",
        detail: {
          ...(input.runDetailExtra ?? {}),
          reason: "already_enrolled",
          enrollmentId: activeEnrollment.id,
        },
      })
      .returning();
    return {
      kind: "already_enrolled",
      enrollmentId: activeEnrollment.id,
      runId: run.id,
    };
  }

  const now = new Date();
  const nextRunAt = new Date(now.getTime() + firstStep.delayMinutes * 60_000);
  const [enrollment] = await tx
    .insert(sequenceEnrollments)
    .values({
      tenantId,
      automationId,
      contactId,
      conversationId,
      triggerMessageId: input.triggerMessageId,
      currentStep: 0,
      status: "active",
      nextRunAt,
    })
    .returning();
  const [run] = await tx
    .insert(automationRuns)
    .values({
      tenantId,
      automationId,
      contactId,
      conversationId,
      triggerMessageId: input.triggerMessageId,
      status: "completed",
      detail: {
        kind: "sequence",
        enrollmentId: enrollment.id,
        ...(input.runDetailExtra ?? {}),
      },
    })
    .returning();
  const actor = input.actor ?? {
    type: "system" as const,
    id: `automation:${automationId}`,
  };
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: actor.type,
    actorId: actor.id,
    action: "sequence.enrolled",
    meta: {
      automationId,
      runId: run.id,
      enrollmentId: enrollment.id,
      triggerMessageId: input.triggerMessageId,
      conversationId,
      firstStepPosition: firstStep.position,
      nextRunAt: nextRunAt.toISOString(),
      ...(input.auditMetaExtra ?? {}),
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
      automationId,
      stepPosition: firstStep.position,
      delayMinutes: firstStep.delayMinutes,
    },
  });
  return {
    kind: "enrolled",
    enrollmentId: enrollment.id,
    runId: run.id,
    nextRunAt,
    firstStepPosition: firstStep.position,
  };
}

// ---------------------------------------------------------------------------
// Entry point manual (API dashboard)
// ---------------------------------------------------------------------------

/**
 * Percakapan pesan (kind 'private'/'group') milik satu kontak, terbaru
 * dulu: `last_message_at` menurun (NULL terakhir), seri dipecah oleh
 * `created_at` menurun. Null bila kontak bukan milik tenant ini (API
 * menjawab 404). Percakapan 'channel' TIDAK pernah masuk daftar —
 * linimasa siaran bukan percakapan dan tidak bisa menjadi jangkar.
 */
export async function listContactMessagingConversations(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  contactId: string,
): Promise<Conversation[] | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, ctx.tenantId), eq(contacts.id, contactId)),
      )
      .limit(1);
    if (!contact) return null;
    return tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.contactId, contactId),
          inArray(conversations.kind, [...MESSAGING_CONVERSATION_KINDS]),
        ),
      )
      .orderBy(
        sql`${conversations.lastMessageAt} DESC NULLS LAST`,
        desc(conversations.createdAt),
      );
  });
}

export type EnrollContactManuallyResult =
  | {
      kind: "enrolled" | "already_enrolled";
      enrollment: SequenceEnrollment;
      totalSteps: number;
    }
  | { kind: "contact_not_found" }
  | { kind: "sequence_unavailable" }
  | { kind: "no_steps" }
  | { kind: "no_conversation" }
  /** conversationId diberikan tetapi bukan percakapan pesan kontak ini. */
  | { kind: "conversation_not_messaging" }
  | { kind: "contact_opted_out" };

/**
 * Daftarkan SATU kontak ke sequence secara manual (pelaku: user
 * dashboard). Jangkar = `input.conversationId` bila diberikan
 * (divalidasi: percakapan pesan milik kontak ini), selain itu
 * percakapan pesan terbaru kontak. Kontak yang sudah opt-out ditolak
 * beralasan — mendaftarkannya hanya akan melahirkan enrollment yang
 * batal di langkah pertama.
 */
export async function enrollContactInSequenceManually(
  db: Database,
  ctx: Pick<TenantContext, "tenantId"> & { userId: string },
  input: { automationId: string; contactId: string; conversationId?: string },
): Promise<EnrollContactManuallyResult> {
  const attempt = () =>
    withTenantDb(db, ctx.tenantId, async (tx) => {
      const [contact] = await tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, ctx.tenantId),
            eq(contacts.id, input.contactId),
          ),
        )
        .limit(1);
      if (!contact) return { kind: "contact_not_found" } as const;

      const messaging = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, ctx.tenantId),
            eq(conversations.contactId, contact.id),
            inArray(conversations.kind, [...MESSAGING_CONVERSATION_KINDS]),
          ),
        )
        .orderBy(
          sql`${conversations.lastMessageAt} DESC NULLS LAST`,
          desc(conversations.createdAt),
        );
      let anchor: Conversation | undefined;
      if (input.conversationId) {
        anchor = messaging.find((c) => c.id === input.conversationId);
        if (!anchor) return { kind: "conversation_not_messaging" } as const;
      } else {
        anchor = messaging[0];
        if (!anchor) return { kind: "no_conversation" } as const;
      }

      if (contact.optInStatus === "opted_out") {
        return { kind: "contact_opted_out" } as const;
      }

      const result = await enrollContactInSequence(tx, {
        tenantId: ctx.tenantId,
        automationId: input.automationId,
        contactId: contact.id,
        conversationId: anchor.id,
        triggerMessageId: null,
        actor: { type: "user", id: ctx.userId },
        runDetailExtra: { via: "manual" },
        auditMetaExtra: { via: "manual", viaUserId: ctx.userId },
      });
      if (result.kind === "sequence_unavailable") {
        return { kind: "sequence_unavailable" } as const;
      }
      if (result.kind === "no_steps") return { kind: "no_steps" } as const;

      const [enrollment] = await tx
        .select()
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, result.enrollmentId))
        .limit(1);
      const steps = await tx
        .select({ id: automationSteps.id })
        .from(automationSteps)
        .where(
          and(
            eq(automationSteps.tenantId, ctx.tenantId),
            eq(automationSteps.automationId, input.automationId),
          ),
        );
      return {
        kind: result.kind,
        enrollment,
        totalSteps: steps.length,
      } as const;
    });

  try {
    return await attempt();
  } catch (err) {
    // Balapan dua permintaan manual untuk kontak yang sama: index
    // unik parsial menolak enrollment kedua dan membatalkan transaksi
    // ini — baca enrollment aktif yang menang dan laporkan sebagai
    // already_enrolled, bukan 500.
    if (
      err instanceof Error &&
      /sequence_enrollments_active_unique/.test(err.message)
    ) {
      const winner = await withTenantDb(db, ctx.tenantId, async (tx) => {
        const [enrollment] = await tx
          .select()
          .from(sequenceEnrollments)
          .where(
            and(
              eq(sequenceEnrollments.tenantId, ctx.tenantId),
              eq(sequenceEnrollments.automationId, input.automationId),
              eq(sequenceEnrollments.contactId, input.contactId),
              eq(sequenceEnrollments.status, "active"),
            ),
          )
          .limit(1);
        if (!enrollment) return null;
        const steps = await tx
          .select({ id: automationSteps.id })
          .from(automationSteps)
          .where(
            and(
              eq(automationSteps.tenantId, ctx.tenantId),
              eq(automationSteps.automationId, input.automationId),
            ),
          );
        return { enrollment, totalSteps: steps.length };
      });
      if (winner) {
        return {
          kind: "already_enrolled",
          enrollment: winner.enrollment,
          totalSteps: winner.totalSteps,
        };
      }
    }
    throw err;
  }
}

/** Batas kontak yang diproses dalam satu panggilan pendaftaran per tag. */
export const ENROLL_BY_TAG_MAX_CONTACTS = 500;

export interface EnrollContactsByTagReport {
  tag: string;
  /** Total kontak tenant yang memuat tag ini. */
  matched: number;
  enrolled: number;
  alreadyEnrolled: number;
  skippedTotal: number;
  skippedByReason: {
    noConversation: number;
    contactOptedOut: number;
  };
  /** true bila matched melebihi batas pemrosesan per panggilan. */
  capped: boolean;
}

export type EnrollContactsByTagResult =
  | { kind: "ok"; report: EnrollContactsByTagReport }
  | { kind: "sequence_unavailable" }
  | { kind: "no_steps" };

/**
 * Daftarkan SEMUA kontak bertag ke sequence secara manual. Setiap
 * kontak diproses dalam transaksinya sendiri lewat jalur manual yang
 * sama (jangkar = percakapan pesan terbarunya) — satu kontak bermasalah
 * tidak menggagalkan yang lain; yang tidak bisa didaftarkan dilewati
 * dan DIHITUNG per alasan di laporan. Sequence yang tidak tersedia /
 * tanpa langkah ditolak di muka (bukan dilewati per kontak) karena
 * sebabnya berlaku untuk semuanya.
 */
export async function enrollContactsInSequenceByTag(
  db: Database,
  ctx: Pick<TenantContext, "tenantId"> & { userId: string },
  input: { automationId: string; tag: string },
): Promise<EnrollContactsByTagResult> {
  const gate = await withTenantDb(db, ctx.tenantId, async (tx) => {
    const [automation] = await tx
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.tenantId, ctx.tenantId),
          eq(automations.id, input.automationId),
        ),
      )
      .limit(1);
    if (!automation || automation.kind !== "sequence" || !automation.isActive) {
      return "sequence_unavailable" as const;
    }
    const steps = await tx
      .select({ id: automationSteps.id })
      .from(automationSteps)
      .where(
        and(
          eq(automationSteps.tenantId, ctx.tenantId),
          eq(automationSteps.automationId, input.automationId),
        ),
      )
      .limit(1);
    if (steps.length === 0) return "no_steps" as const;
    return "ok" as const;
  });
  if (gate !== "ok") return { kind: gate };

  const contactIds = await withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, ctx.tenantId),
          arrayContains(contacts.tags, [input.tag]),
        ),
      )
      .orderBy(asc(contacts.createdAt));
    return rows.map((r) => r.id);
  });

  const report: EnrollContactsByTagReport = {
    tag: input.tag,
    matched: contactIds.length,
    enrolled: 0,
    alreadyEnrolled: 0,
    skippedTotal: 0,
    skippedByReason: { noConversation: 0, contactOptedOut: 0 },
    capped: contactIds.length > ENROLL_BY_TAG_MAX_CONTACTS,
  };

  for (const contactId of contactIds.slice(0, ENROLL_BY_TAG_MAX_CONTACTS)) {
    const result = await enrollContactInSequenceManually(db, ctx, {
      automationId: input.automationId,
      contactId,
    });
    switch (result.kind) {
      case "enrolled":
        report.enrolled += 1;
        break;
      case "already_enrolled":
        report.alreadyEnrolled += 1;
        break;
      case "no_conversation":
        report.skippedTotal += 1;
        report.skippedByReason.noConversation += 1;
        break;
      case "contact_opted_out":
        report.skippedTotal += 1;
        report.skippedByReason.contactOptedOut += 1;
        break;
      default:
        // contact_not_found tidak mungkin (id baru dibaca dari tenant
        // ini); sequence_unavailable / no_steps sudah ditolak di muka.
        // Keduanya dihitung sebagai dilewati tanpa alasan agregat agar
        // angka laporan selalu konsisten (matched = enrolled +
        // alreadyEnrolled + skippedTotal + sisa di atas batas).
        report.skippedTotal += 1;
        break;
    }
  }
  return { kind: "ok", report };
}
