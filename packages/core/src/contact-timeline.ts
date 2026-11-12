import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  automations,
  contacts,
  conversations,
  messages,
  sequenceEnrollments,
  type Database,
} from "@sahabat-kreator/db";
import { withTenantDb } from "./tx";

/**
 * Linimasa aktivitas kontak (Gelombang G8) — umpan kronologis panel
 * detail kontak yang DIRAKIT BACA-SAJA dari data yang sudah tercatat.
 * Modul ini tidak menulis apa pun dan tidak menambah tabel: setiap
 * jenis peristiwa di bawah menunjuk ke sumber yang benar-benar ada.
 *
 * Sumber & cakupan (diaudit 2026-11-12 terhadap kode):
 * - `contacts` (baris kontak itu sendiri) → contact_created.
 * - `messages` ⨝ `conversations` milik kontak → first_message /
 *   last_message (dua query limit-1 terindeks, bukan pindai riwayat).
 * - `audit_logs` meta.contactId → contact.opt_in_changed (perubahan
 *   status opt-in efektif, meta {from,to,source}), contact.merged
 *   (kontak lain dilebur KE kontak ini; sisi korban tidak bisa tampil
 *   karena merge MENGHAPUS kontak korban), agent.handoff (meta
 *   {contactId, conversationId, reason, via}), contact.note_created
 *   (catatan kontak ditambahkan — peristiwa G8 sendiri).
 * - `sequence_enrollments` ⨝ `automations` → sequence_enrolled
 *   (createdAt baris enrollment adalah sumber otoritatifnya), dan
 *   `audit_logs` meta.enrollmentId untuk transisi akhirnya →
 *   sequence.completed / sequence.cancelled_reply /
 *   sequence.cancelled_opt_out. (updatedAt enrollment berubah di
 *   setiap langkah terkirim, jadi BUKAN penanda waktu selesai.)
 * - `audit_logs` meta.conversationId ∈ percakapan kontak →
 *   conversation.note_created sebagai conversation_note_added —
 *   jenis TERPISAH dari contact_note_added agar dua keluarga catatan
 *   tidak tercampur, sama seperti daftarnya.
 *
 * Yang SENGAJA tidak dicakup (sumbernya tidak tercatat — menampilkan
 * nya berarti mengarang): perubahan tahap pipeline & perubahan tag
 * (tidak ada audit/riwayat untuk keduanya; hanya nilai kini di baris
 * kontak), suntingan nama/email/telepon, dan peristiwa korban merge.
 *
 * Kinerja: jumlah query tetap (7) berapa pun besar riwayat kontak;
 * setiap sumber audit dibatasi `limit + 1` baris terbaru agar
 * penanda `truncated` jujur. Penyaringan meta jsonb memakai indeks
 * (tenant_id, created_at) audit_logs untuk urutan + batas; pencocokan
 * meta dilakukan Postgres pada baris-baris tenant itu.
 */

export type ContactTimelineEventKind =
  | "contact_created"
  | "first_message"
  | "last_message"
  | "opt_in_changed"
  | "merged_in"
  | "sequence_enrolled"
  | "sequence_completed"
  | "sequence_cancelled"
  | "handoff"
  | "contact_note_added"
  | "conversation_note_added";

export type ContactTimelineDetail = Record<
  string,
  string | number | boolean | null
>;

export interface ContactTimelineEvent {
  kind: ContactTimelineEventKind;
  occurredAt: Date;
  detail: ContactTimelineDetail;
}

export interface ContactTimeline {
  /** Terurut terbaru → terlama. */
  events: ContactTimelineEvent[];
  /** true bila ada peristiwa yang tertahan batas jumlah. */
  truncated: boolean;
}

export const CONTACT_TIMELINE_DEFAULT_LIMIT = 100;

const META_CONTACT_ACTIONS = [
  "contact.opt_in_changed",
  "contact.merged",
  "agent.handoff",
  "contact.note_created",
] as const;

const META_ENROLLMENT_ACTIONS = [
  "sequence.completed",
  "sequence.cancelled_reply",
  "sequence.cancelled_opt_out",
] as const;

/** Salin kunci meta yang dikenal bila nilainya primitif; abaikan sisanya. */
function pickDetail(
  meta: Record<string, unknown>,
  keys: readonly string[],
): ContactTimelineDetail {
  const detail: ContactTimelineDetail = {};
  for (const key of keys) {
    const value = meta[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      detail[key] = value;
    }
  }
  return detail;
}

function metaText(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" ? value : null;
}

/** Null bila kontak tidak ada di tenant ini. */
export async function getContactTimeline(
  db: Database,
  input: { tenantId: string; contactId: string },
  opts?: { limit?: number },
): Promise<ContactTimeline | null> {
  const limit = Math.max(
    1,
    Math.min(opts?.limit ?? CONTACT_TIMELINE_DEFAULT_LIMIT, 500),
  );
  const fetchCap = limit + 1;
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, input.tenantId),
          eq(contacts.id, input.contactId),
        ),
      )
      .limit(1);
    if (!contact) return null;

    const events: ContactTimelineEvent[] = [];
    let truncated = false;
    const noteOverflow = (count: number) => {
      if (count > limit) truncated = true;
    };

    events.push({
      kind: "contact_created",
      occurredAt: contact.createdAt,
      detail: { source: contact.source },
    });

    // --- Percakapan kontak (id saja; dipakai dua sumber di bawah) ---
    const conversationRows = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.contactId, input.contactId),
        ),
      );
    const conversationIds = conversationRows.map((r) => r.id);

    // --- Pesan pertama & terakhir (masing-masing satu query limit-1) ---
    if (conversationIds.length > 0) {
      const messageCols = {
        id: messages.id,
        createdAt: messages.createdAt,
        direction: messages.direction,
        provider: conversations.provider,
      };
      const messageScope = and(
        eq(messages.tenantId, input.tenantId),
        inArray(messages.conversationId, conversationIds),
      );
      const [first] = await tx
        .select(messageCols)
        .from(messages)
        .innerJoin(
          conversations,
          eq(messages.conversationId, conversations.id),
        )
        .where(messageScope)
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(1);
      if (first) {
        events.push({
          kind: "first_message",
          occurredAt: first.createdAt,
          detail: { direction: first.direction, provider: first.provider },
        });
        const [last] = await tx
          .select(messageCols)
          .from(messages)
          .innerJoin(
            conversations,
            eq(messages.conversationId, conversations.id),
          )
          .where(messageScope)
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(1);
        if (last && last.id !== first.id) {
          events.push({
            kind: "last_message",
            occurredAt: last.createdAt,
            detail: { direction: last.direction, provider: last.provider },
          });
        }
      }
    }

    // --- Audit yang menyebut kontak ini langsung di meta ---
    const contactAudit = await tx
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, input.tenantId),
          inArray(auditLogs.action, [...META_CONTACT_ACTIONS]),
          sql`${auditLogs.meta}->>'contactId' = ${input.contactId}`,
        ),
      )
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(fetchCap);
    noteOverflow(contactAudit.length);
    for (const row of contactAudit) {
      const meta = row.meta as Record<string, unknown>;
      switch (row.action) {
        case "contact.opt_in_changed":
          events.push({
            kind: "opt_in_changed",
            occurredAt: row.createdAt,
            detail: pickDetail(meta, ["from", "to", "source"]),
          });
          break;
        case "contact.merged":
          events.push({
            kind: "merged_in",
            occurredAt: row.createdAt,
            detail: pickDetail(meta, [
              "mergedContactId",
              "mergedContactName",
              "movedConversations",
            ]),
          });
          break;
        case "agent.handoff":
          events.push({
            kind: "handoff",
            occurredAt: row.createdAt,
            detail: pickDetail(meta, ["reason", "via", "conversationId"]),
          });
          break;
        case "contact.note_created":
          events.push({
            kind: "contact_note_added",
            occurredAt: row.createdAt,
            detail: pickDetail(meta, ["noteId"]),
          });
          break;
      }
    }

    // --- Enrollment sequence kontak + transisi akhirnya ---
    const enrollmentRows = await tx
      .select({
        id: sequenceEnrollments.id,
        automationId: sequenceEnrollments.automationId,
        automationName: automations.name,
        status: sequenceEnrollments.status,
        createdAt: sequenceEnrollments.createdAt,
      })
      .from(sequenceEnrollments)
      .innerJoin(
        automations,
        eq(sequenceEnrollments.automationId, automations.id),
      )
      .where(
        and(
          eq(sequenceEnrollments.tenantId, input.tenantId),
          eq(sequenceEnrollments.contactId, input.contactId),
        ),
      )
      .orderBy(desc(sequenceEnrollments.createdAt), desc(sequenceEnrollments.id))
      .limit(fetchCap);
    noteOverflow(enrollmentRows.length);
    const automationNameByEnrollment = new Map<string, string>();
    for (const row of enrollmentRows) {
      automationNameByEnrollment.set(row.id, row.automationName);
      events.push({
        kind: "sequence_enrolled",
        occurredAt: row.createdAt,
        detail: {
          automationId: row.automationId,
          automationName: row.automationName,
          status: row.status,
        },
      });
    }
    if (enrollmentRows.length > 0) {
      const enrollmentIds = enrollmentRows.map((r) => r.id);
      const enrollmentAudit = await tx
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, input.tenantId),
            inArray(auditLogs.action, [...META_ENROLLMENT_ACTIONS]),
            sql`${auditLogs.meta}->>'enrollmentId' IN (${sql.join(
              enrollmentIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(fetchCap);
      noteOverflow(enrollmentAudit.length);
      for (const row of enrollmentAudit) {
        const meta = row.meta as Record<string, unknown>;
        const enrollmentId = metaText(meta, "enrollmentId");
        const automationName =
          (enrollmentId
            ? automationNameByEnrollment.get(enrollmentId)
            : undefined) ?? null;
        const detail: ContactTimelineDetail = {
          automationId: metaText(meta, "automationId"),
          automationName,
        };
        if (row.action === "sequence.completed") {
          events.push({
            kind: "sequence_completed",
            occurredAt: row.createdAt,
            detail,
          });
        } else {
          events.push({
            kind: "sequence_cancelled",
            occurredAt: row.createdAt,
            detail: {
              ...detail,
              reason:
                row.action === "sequence.cancelled_reply"
                  ? "reply"
                  : "opt_out",
            },
          });
        }
      }
    }

    // --- Catatan percakapan yang ditambahkan pada percakapan kontak ---
    if (conversationIds.length > 0) {
      const noteAudit = await tx
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, input.tenantId),
            eq(auditLogs.action, "conversation.note_created"),
            sql`${auditLogs.meta}->>'conversationId' IN (${sql.join(
              conversationIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(fetchCap);
      noteOverflow(noteAudit.length);
      for (const row of noteAudit) {
        const meta = row.meta as Record<string, unknown>;
        events.push({
          kind: "conversation_note_added",
          occurredAt: row.createdAt,
          detail: pickDetail(meta, ["noteId", "conversationId"]),
        });
      }
    }

    events.sort((a, b) => {
      const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
      if (byTime !== 0) return byTime;
      return a.kind.localeCompare(b.kind);
    });
    if (events.length > limit) {
      truncated = true;
      events.length = limit;
    }
    return { events, truncated };
  });
}
