import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  contacts,
  conversations,
  messages,
  segments,
  type Database,
  type Segment,
} from "@sahabat-kreator/db";
import type {
  SegmentCondition,
  SegmentDefinition,
} from "@sahabat-kreator/contracts";
import { withTenantDb, type DbTx } from "./tx";
import { effectiveOptInStatus, type EffectiveOptInStatus } from "./contacts";

/**
 * Segmentasi audiens (Fase 13C).
 *
 * SATU evaluator dipakai tiga konsumen — filter daftar kontak,
 * pratinjau audiens broadcast, dan materialisasi penerima broadcast —
 * agar keanggotaan segmen tidak pernah berbeda antar-permukaan:
 * evaluasi berjalan di atas PROFIL kontak yang dimuat sekali
 * (`loadContactSegmentProfiles`), bukan query SQL per kondisi.
 *
 * Definisi aktivitas untuk `last_active_within_days` (didokumentasikan
 * juga di kontrak): waktu pesan MASUK terakhir kontak di semua
 * percakapan 1:1-nya (semua channel); bila kontak belum pernah
 * mengirim pesan masuk, jatuh ke `updated_at` percakapan 1:1
 * terbarunya; kontak tanpa percakapan 1:1 sama sekali tidak aktif.
 */

export interface ContactSegmentProfile {
  contactId: string;
  tags: string[];
  pipelineStage: string;
  /** Kolom sumber kontak (mis. "growth:promo"); null = tak teratribusi. */
  source: string | null;
  effectiveOptInStatus: EffectiveOptInStatus;
  customFields: Record<string, unknown>;
  createdAt: Date;
  /** Provider yang kontak ini punya percakapan 1:1-nya. */
  channelProviders: ReadonlySet<string>;
  /** Aktivitas terakhir menurut definisi di kepala file; null = tak pernah. */
  lastActiveAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Evaluasi SATU kondisi terhadap profil kontak (murni, tanpa I/O). */
export function evaluateSegmentCondition(
  profile: ContactSegmentProfile,
  condition: SegmentCondition,
  now: Date = new Date(),
): boolean {
  switch (condition.type) {
    case "tag":
      return profile.tags.includes(condition.tag);
    case "stage":
      return profile.pipelineStage === condition.stage;
    case "source_prefix":
      return (
        profile.source !== null && profile.source.startsWith(condition.prefix)
      );
    case "opt_in_status":
      return profile.effectiveOptInStatus === condition.status;
    case "custom_field": {
      const raw = profile.customFields[condition.key];
      if (raw === undefined || raw === null) return false;
      const value = String(raw);
      return condition.op === "eq"
        ? value === condition.value
        : value.toLowerCase().includes(condition.value.toLowerCase());
    }
    case "created_within_days":
      return profile.createdAt.getTime() >= now.getTime() - condition.days * DAY_MS;
    case "last_active_within_days":
      return (
        profile.lastActiveAt !== null &&
        profile.lastActiveAt.getTime() >= now.getTime() - condition.days * DAY_MS
      );
    case "has_channel":
      return profile.channelProviders.has(condition.provider);
    default:
      return false;
  }
}

/** Evaluasi definisi penuh: match "all" = AND, "any" = OR. */
export function evaluateSegmentDefinition(
  profile: ContactSegmentProfile,
  definition: SegmentDefinition,
  now: Date = new Date(),
): boolean {
  if (definition.conditions.length === 0) return false;
  return definition.match === "all"
    ? definition.conditions.every((c) =>
        evaluateSegmentCondition(profile, c, now),
      )
    : definition.conditions.some((c) =>
        evaluateSegmentCondition(profile, c, now),
      );
}

/**
 * Memuat profil segmen untuk kontak tenant (semua, atau himpunan
 * `contactIds` bila diberikan). Berjalan di dalam transaksi tenant
 * pemanggil agar RLS berlaku.
 */
export async function loadContactSegmentProfiles(
  tx: DbTx,
  tenantId: string,
  contactIds?: string[],
): Promise<ContactSegmentProfile[]> {
  const contactRows = await tx
    .select()
    .from(contacts)
    .where(
      contactIds
        ? and(
            eq(contacts.tenantId, tenantId),
            inArray(contacts.id, contactIds),
          )
        : eq(contacts.tenantId, tenantId),
    )
    .orderBy(asc(contacts.createdAt));
  if (contactRows.length === 0) return [];
  const ids = contactRows.map((c) => c.id);

  const convRows = await tx
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      provider: conversations.provider,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.kind, "private"),
        inArray(conversations.contactId, ids),
      ),
    );
  const providersByContact = new Map<string, Set<string>>();
  const convOwner = new Map<string, string>();
  const latestConvUpdatedByContact = new Map<string, Date>();
  for (const conv of convRows) {
    convOwner.set(conv.id, conv.contactId);
    const providers = providersByContact.get(conv.contactId) ?? new Set();
    providers.add(conv.provider);
    providersByContact.set(conv.contactId, providers);
    const prev = latestConvUpdatedByContact.get(conv.contactId);
    if (!prev || conv.updatedAt > prev) {
      latestConvUpdatedByContact.set(conv.contactId, conv.updatedAt);
    }
  }

  const lastInboundByContact = new Map<string, Date>();
  if (convRows.length > 0) {
    const inboundRows = await tx
      .select({
        conversationId: messages.conversationId,
        lastInboundAt: sql<string>`max(${messages.createdAt})`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.direction, "inbound"),
          inArray(
            messages.conversationId,
            convRows.map((c) => c.id),
          ),
        ),
      )
      .groupBy(messages.conversationId);
    for (const row of inboundRows) {
      const contactId = convOwner.get(row.conversationId);
      if (!contactId) continue;
      const at = new Date(row.lastInboundAt);
      const prev = lastInboundByContact.get(contactId);
      if (!prev || at > prev) lastInboundByContact.set(contactId, at);
    }
  }

  return contactRows.map((contact) => ({
    contactId: contact.id,
    tags: contact.tags,
    pipelineStage: contact.pipelineStage,
    source: contact.source,
    effectiveOptInStatus: effectiveOptInStatus(contact),
    customFields: (contact.customFields ?? {}) as Record<string, unknown>,
    createdAt: contact.createdAt,
    channelProviders: providersByContact.get(contact.id) ?? new Set<string>(),
    lastActiveAt:
      lastInboundByContact.get(contact.id) ??
      latestConvUpdatedByContact.get(contact.id) ??
      null,
  }));
}

/** Id kontak anggota segmen tersimpan; null bila segmen tak ditemukan. */
export async function listSegmentMemberIds(
  db: Database,
  tenantId: string,
  segmentId: string,
): Promise<string[] | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const segment = await getSegmentRow(tx, tenantId, segmentId);
    if (!segment) return null;
    const profiles = await loadContactSegmentProfiles(tx, tenantId);
    const definition = segment.definition as unknown as SegmentDefinition;
    return profiles
      .filter((p) => evaluateSegmentDefinition(p, definition))
      .map((p) => p.contactId);
  });
}

/** Hitungan anggota untuk definisi arbitrer (pratinjau pembuat segmen). */
export async function countSegmentMembers(
  db: Database,
  tenantId: string,
  definition: SegmentDefinition,
): Promise<number> {
  return withTenantDb(db, tenantId, async (tx) => {
    const profiles = await loadContactSegmentProfiles(tx, tenantId);
    return profiles.filter((p) => evaluateSegmentDefinition(p, definition))
      .length;
  });
}

// ---------------------------------------------------------------------------
// CRUD segmen (dashboard)
// ---------------------------------------------------------------------------

/** Baris segmen dalam transaksi tenant pemanggil (dipakai broadcasts). */
export async function getSegmentRow(
  tx: DbTx,
  tenantId: string,
  segmentId: string,
): Promise<Segment | null> {
  const [row] = await tx
    .select()
    .from(segments)
    .where(and(eq(segments.tenantId, tenantId), eq(segments.id, segmentId)))
    .limit(1);
  return row ?? null;
}

export async function listSegments(
  db: Database,
  tenantId: string,
): Promise<Segment[]> {
  return withTenantDb(db, tenantId, async (tx) => {
    return tx
      .select()
      .from(segments)
      .where(eq(segments.tenantId, tenantId))
      .orderBy(asc(segments.name));
  });
}

export async function getSegment(
  db: Database,
  tenantId: string,
  segmentId: string,
): Promise<Segment | null> {
  return withTenantDb(db, tenantId, (tx) =>
    getSegmentRow(tx, tenantId, segmentId),
  );
}

export async function createSegment(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    name: string;
    definition: SegmentDefinition;
  },
): Promise<Segment> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(segments)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        definition: input.definition,
        createdByUserId: input.userId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "segment.created",
      meta: { segmentId: row.id, name: input.name },
    });
    return row;
  });
}

export type UpdateSegmentResult =
  | { kind: "updated"; segment: Segment }
  | { kind: "not_found" };

export async function updateSegment(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    segmentId: string;
    patch: { name?: string; definition?: SegmentDefinition };
  },
): Promise<UpdateSegmentResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await getSegmentRow(tx, input.tenantId, input.segmentId);
    if (!existing) return { kind: "not_found" as const };
    const patch: Partial<Segment> = { updatedAt: new Date() };
    if (input.patch.name !== undefined) patch.name = input.patch.name;
    if (input.patch.definition !== undefined) {
      patch.definition = input.patch.definition;
    }
    const [row] = await tx
      .update(segments)
      .set(patch)
      .where(
        and(
          eq(segments.tenantId, input.tenantId),
          eq(segments.id, input.segmentId),
        ),
      )
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "segment.updated",
      meta: { segmentId: input.segmentId },
    });
    return { kind: "updated" as const, segment: row };
  });
}

export type DeleteSegmentResult = { kind: "deleted" } | { kind: "not_found" };

export async function deleteSegment(
  db: Database,
  input: { tenantId: string; userId: string; segmentId: string },
): Promise<DeleteSegmentResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await getSegmentRow(tx, input.tenantId, input.segmentId);
    if (!existing) return { kind: "not_found" as const };
    await tx
      .delete(segments)
      .where(
        and(
          eq(segments.tenantId, input.tenantId),
          eq(segments.id, input.segmentId),
        ),
      );
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "segment.deleted",
      meta: { segmentId: input.segmentId, name: existing.name },
    });
    return { kind: "deleted" as const };
  });
}
