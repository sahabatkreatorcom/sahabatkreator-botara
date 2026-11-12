import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  contacts,
  conversations,
  dealPipelines,
  dealStageEvents,
  dealStages,
  deals,
  tenantMembers,
  tenants,
  users,
  type Database,
  type Deal,
  type DealPipeline,
  type DealStage,
  type DealStageEvent,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Deals / pipeline penjualan (Gelombang G12) — pola repo riset wacrm
 * `src/lib/pipelines` (MIT) diadopsi sebagai POLA: pipeline → tahap
 * berurutan → deal bernilai + mata uang per deal + status
 * open/won/lost di baris deal + mata uang bawaan akun.
 *
 * Keputusan desain gelombang ini:
 * - Deal TERPISAH dari `contacts.pipeline_stage` (tahap kontak tidak
 *   disentuh): satu kontak boleh punya banyak deal.
 * - Status deal DITURUNKAN dari `kind` tahap tujuan setiap kali deal
 *   BERPINDAH: tahap kind 'won' → status won + closed_at terisi;
 *   'lost' → lost + closed_at; 'open' → open + closed_at NULL (deal
 *   yang keluar dari tahap terminal terbuka lagi). Mengubah `kind`
 *   sebuah tahap menurunkan ulang status deal yang SEDANG berada di
 *   tahap itu (tanpa peristiwa perpindahan — mereka tidak berpindah),
 *   agar papan & analitik tidak pernah saling bertentangan.
 * - Perpindahan tahap selalu menulis `deal_stage_events` (riwayat
 *   dengan nama tahap snapshot) + audit `deal.stage_moved`.
 * - Pipeline bawaan disemai MALAS (ensureDefaultDealPipeline) saat
 *   permukaan deals pertama dipakai tenant: nama tahap mengikuti
 *   `tenants.default_locale` ('id' → Bahasa Indonesia, selain itu
 *   Inggris), warna mengikuti spesifikasi tahap wacrm.
 * - Dua helper bertanda tangan tx — `createDealForContact` dan
 *   `moveLatestOpenDealStage` — adalah jalur OTOMASI (node flow
 *   create_deal/move_deal_stage): kegagalan lunak (tahap hilang,
 *   kontak hilang, tak ada deal open) dikembalikan sebagai
 *   `skipped` beralasan, BUKAN error — meniru pola
 *   `enrollContactInSequence` (G2b) agar run flow tidak mati karena
 *   rujukan yang membusuk sesudah aktivasi.
 */

export type DealStageKind = "open" | "won" | "lost";
export type DealStatus = "open" | "won" | "lost";
export type DealPriority = "low" | "medium" | "high";

/** Pelaku perpindahan/penulisan: user dashboard, node flow, atau sistem. */
export interface DealActor {
  type: "user" | "flow" | "system";
  /** Id user bila type 'user'; selain itu diabaikan (label komponen di audit). */
  id?: string | null;
}

export interface DealView extends Deal {
  contactName: string | null;
  assigneeName: string | null;
}

export interface DealPipelineWithStages extends DealPipeline {
  stages: DealStage[];
}

// ---------------------------------------------------------------------------
// Semai bawaan
// ---------------------------------------------------------------------------

interface DefaultDealStageSeed {
  name: string;
  color: string;
  kind: DealStageKind;
}

/**
 * Tahap bawaan (nama dwibahasa + warna spesifikasi wacrm): lima tahap
 * kerja/terminal menang, ditambah tahap terminal Kalah — wacrm
 * menandai kalah lewat status; di sini kalah adalah tahap terminal
 * yang terlihat di papan agar seret-Kanban bisa menutup deal kalah
 * tanpa dialog terpisah.
 */
export function defaultDealStagesForLocale(
  locale: string,
): DefaultDealStageSeed[] {
  if (locale === "id") {
    return [
      { name: "Prospek Baru", color: "#3b82f6", kind: "open" },
      { name: "Terkualifikasi", color: "#eab308", kind: "open" },
      { name: "Proposal Terkirim", color: "#f97316", kind: "open" },
      { name: "Negosiasi", color: "#8b5cf6", kind: "open" },
      { name: "Menang", color: "#22c55e", kind: "won" },
      { name: "Kalah", color: "#ef4444", kind: "lost" },
    ];
  }
  return [
    { name: "New Lead", color: "#3b82f6", kind: "open" },
    { name: "Qualified", color: "#eab308", kind: "open" },
    { name: "Proposal Sent", color: "#f97316", kind: "open" },
    { name: "Negotiation", color: "#8b5cf6", kind: "open" },
    { name: "Won", color: "#22c55e", kind: "won" },
    { name: "Lost", color: "#ef4444", kind: "lost" },
  ];
}

export function defaultDealPipelineName(locale: string): string {
  return locale === "id" ? "Pipeline Penjualan" : "Sales Pipeline";
}

// ---------------------------------------------------------------------------
// Helper internal
// ---------------------------------------------------------------------------

async function writeDealAudit(
  tx: DbTx,
  input: {
    tenantId: string;
    actor: DealActor;
    action: string;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId: input.tenantId,
    actorType: input.actor.type === "user" ? "user" : "system",
    actorId:
      input.actor.type === "user"
        ? (input.actor.id ?? null)
        : input.actor.type === "flow"
          ? "flow-engine"
          : "deals",
    action: input.action,
    meta: input.meta,
  });
}

function statusForStageKind(kind: DealStageKind): DealStatus {
  return kind === "won" ? "won" : kind === "lost" ? "lost" : "open";
}

async function getStageById(
  tx: DbTx,
  tenantId: string,
  stageId: string,
): Promise<DealStage | null> {
  const [row] = await tx
    .select()
    .from(dealStages)
    .where(and(eq(dealStages.tenantId, tenantId), eq(dealStages.id, stageId)))
    .limit(1);
  return row ?? null;
}

async function getPipelineById(
  tx: DbTx,
  tenantId: string,
  pipelineId: string,
): Promise<DealPipeline | null> {
  const [row] = await tx
    .select()
    .from(dealPipelines)
    .where(
      and(eq(dealPipelines.tenantId, tenantId), eq(dealPipelines.id, pipelineId)),
    )
    .limit(1);
  return row ?? null;
}

async function listStagesOfPipeline(
  tx: DbTx,
  tenantId: string,
  pipelineId: string,
): Promise<DealStage[]> {
  return tx
    .select()
    .from(dealStages)
    .where(
      and(
        eq(dealStages.tenantId, tenantId),
        eq(dealStages.pipelineId, pipelineId),
      ),
    )
    .orderBy(asc(dealStages.position), asc(dealStages.id));
}

async function isTenantMember(
  tx: DbTx,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: tenantMembers.id })
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, tenantId),
        eq(tenantMembers.userId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Semai tahap bawaan ke pipeline yang baru lahir (dipakai buat & semai malas). */
async function seedDefaultStages(
  tx: DbTx,
  tenantId: string,
  pipelineId: string,
  locale: string,
): Promise<DealStage[]> {
  const seeds = defaultDealStagesForLocale(locale);
  const rows = await tx
    .insert(dealStages)
    .values(
      seeds.map((s, i) => ({
        tenantId,
        pipelineId,
        name: s.name,
        position: i,
        color: s.color,
        kind: s.kind,
      })),
    )
    .returning();
  return rows.sort((a, b) => a.position - b.position);
}

async function getTenantDealContext(
  tx: DbTx,
  tenantId: string,
): Promise<{ defaultCurrency: string; defaultLocale: string }> {
  const [row] = await tx
    .select({
      defaultCurrency: tenants.defaultCurrency,
      defaultLocale: tenants.defaultLocale,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return {
    defaultCurrency: row?.defaultCurrency ?? "IDR",
    defaultLocale: row?.defaultLocale ?? "en",
  };
}

/**
 * Pipeline bawaan tenant: pipeline PERTAMA tenant; bila tenant belum
 * punya pipeline sama sekali, buat + semai tahap bawaan sekarang
 * (di dalam transaksi pemanggil) dan catat audit sistem. Inilah
 * "tahap bawaan tersemai" gelombang ini — malas agar menghormati
 * locale tenant dan tidak mengubah jalur pembuatan workspace.
 */
export async function ensureDefaultDealPipeline(
  tx: DbTx,
  tenantId: string,
): Promise<DealPipeline> {
  const [existing] = await tx
    .select()
    .from(dealPipelines)
    .where(eq(dealPipelines.tenantId, tenantId))
    .orderBy(asc(dealPipelines.createdAt), asc(dealPipelines.id))
    .limit(1);
  if (existing) return existing;
  const { defaultLocale } = await getTenantDealContext(tx, tenantId);
  const [pipeline] = await tx
    .insert(dealPipelines)
    .values({ tenantId, name: defaultDealPipelineName(defaultLocale) })
    .returning();
  await seedDefaultStages(tx, tenantId, pipeline!.id, defaultLocale);
  await writeDealAudit(tx, {
    tenantId,
    actor: { type: "system" },
    action: "deal.pipeline_created",
    meta: { pipelineId: pipeline!.id, seededDefault: true },
  });
  return pipeline!;
}

// ---------------------------------------------------------------------------
// Mekanika inti (dipakai jalur API & otomasi)
// ---------------------------------------------------------------------------

export interface InsertDealInput {
  tenantId: string;
  contactId: string;
  stage: DealStage;
  conversationId?: string | null;
  title: string;
  value?: number | undefined;
  currency: string;
  expectedCloseDate?: string | null;
  dueAt?: Date | null;
  priority?: DealPriority | undefined;
  assigneeUserId?: string | null;
  actor: DealActor;
  auditMetaExtra?: Record<string, unknown> | undefined;
}

/**
 * Tulis baris deal + peristiwa pembuatan + audit, di transaksi
 * pemanggil. Validasi rujukan (kontak/tahap/assignee/percakapan)
 * adalah tanggung jawab pemanggil — fungsi ini menerima tahap yang
 * sudah terverifikasi milik tenant.
 */
async function insertDealRow(
  tx: DbTx,
  input: InsertDealInput,
): Promise<Deal> {
  const [deal] = await tx
    .insert(deals)
    .values({
      tenantId: input.tenantId,
      pipelineId: input.stage.pipelineId,
      stageId: input.stage.id,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      title: input.title,
      value: (input.value ?? 0).toFixed(2),
      currency: input.currency,
      expectedCloseDate: input.expectedCloseDate ?? null,
      dueAt: input.dueAt ?? null,
      status: statusForStageKind(input.stage.kind),
      priority: input.priority ?? "medium",
      assigneeUserId: input.assigneeUserId ?? null,
      closedAt:
        input.stage.kind === "open" ? null : new Date(),
    })
    .returning();
  const row = deal!;
  await tx.insert(dealStageEvents).values({
    tenantId: input.tenantId,
    dealId: row.id,
    fromStageId: null,
    toStageId: input.stage.id,
    fromStageName: null,
    toStageName: input.stage.name,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
  });
  await writeDealAudit(tx, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: "deal.created",
    meta: {
      dealId: row.id,
      contactId: input.contactId,
      pipelineId: row.pipelineId,
      stageId: row.stageId,
      ...(input.auditMetaExtra ?? {}),
    },
  });
  return row;
}

/**
 * Terapkan perpindahan tahap pada deal: stage + pipeline mengikuti
 * tahap tujuan, status/closed_at diturunkan dari kind tujuan,
 * peristiwa riwayat + audit ditulis. Mengembalikan deal terbaru;
 * `changed=false` bila deal sudah berada di tahap tujuan (tanpa
 * tulisan apa pun — perpindahan ke tahap yang sama bukan peristiwa).
 */
export async function applyDealStageMove(
  tx: DbTx,
  input: {
    tenantId: string;
    deal: Deal;
    toStage: DealStage;
    actor: DealActor;
    auditMetaExtra?: Record<string, unknown> | undefined;
  },
): Promise<{ deal: Deal; changed: boolean }> {
  const { deal, toStage } = input;
  if (deal.stageId === toStage.id) return { deal, changed: false };
  const [fromStage] = await tx
    .select()
    .from(dealStages)
    .where(eq(dealStages.id, deal.stageId))
    .limit(1);
  const status = statusForStageKind(toStage.kind);
  const [updated] = await tx
    .update(deals)
    .set({
      stageId: toStage.id,
      pipelineId: toStage.pipelineId,
      status,
      closedAt: status === "open" ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(deals.tenantId, input.tenantId), eq(deals.id, deal.id)))
    .returning();
  const row = updated!;
  await tx.insert(dealStageEvents).values({
    tenantId: input.tenantId,
    dealId: deal.id,
    fromStageId: deal.stageId,
    toStageId: toStage.id,
    fromStageName: fromStage?.name ?? null,
    toStageName: toStage.name,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
  });
  await writeDealAudit(tx, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: "deal.stage_moved",
    meta: {
      dealId: deal.id,
      contactId: deal.contactId,
      fromStageId: deal.stageId,
      toStageId: toStage.id,
      status,
      ...(input.auditMetaExtra ?? {}),
    },
  });
  return { deal: row, changed: true };
}

async function dealViewById(
  tx: DbTx,
  tenantId: string,
  dealId: string,
): Promise<DealView | null> {
  const [row] = await tx
    .select({
      deal: deals,
      contactName: contacts.name,
      assigneeName: users.name,
      assigneeEmail: users.email,
    })
    .from(deals)
    .innerJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(users, eq(deals.assigneeUserId, users.id))
    .where(and(eq(deals.tenantId, tenantId), eq(deals.id, dealId)))
    .limit(1);
  if (!row) return null;
  return {
    ...row.deal,
    contactName: row.contactName,
    assigneeName:
      row.deal.assigneeUserId !== null
        ? (row.assigneeName ?? row.assigneeEmail)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Pipeline (jalur API)
// ---------------------------------------------------------------------------

export async function listDealPipelines(
  db: Database,
  tenantId: string,
): Promise<DealPipelineWithStages[]> {
  return withTenantDb(db, tenantId, async (tx) => {
    await ensureDefaultDealPipeline(tx, tenantId);
    const pipelines = await tx
      .select()
      .from(dealPipelines)
      .where(eq(dealPipelines.tenantId, tenantId))
      .orderBy(asc(dealPipelines.createdAt), asc(dealPipelines.id));
    const stages = await tx
      .select()
      .from(dealStages)
      .where(eq(dealStages.tenantId, tenantId))
      .orderBy(asc(dealStages.position), asc(dealStages.id));
    return pipelines.map((p) => ({
      ...p,
      stages: stages.filter((s) => s.pipelineId === p.id),
    }));
  });
}

export async function createDealPipeline(
  db: Database,
  input: { tenantId: string; userId: string; name: string },
): Promise<DealPipelineWithStages> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const { defaultLocale } = await getTenantDealContext(tx, input.tenantId);
    const [pipeline] = await tx
      .insert(dealPipelines)
      .values({ tenantId: input.tenantId, name: input.name })
      .returning();
    const stages = await seedDefaultStages(
      tx,
      input.tenantId,
      pipeline!.id,
      defaultLocale,
    );
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.pipeline_created",
      meta: { pipelineId: pipeline!.id, seededDefault: true },
    });
    return { ...pipeline!, stages };
  });
}

export type UpdateDealPipelineResult =
  | { kind: "updated"; pipeline: DealPipeline }
  | { kind: "not_found" };

export async function updateDealPipeline(
  db: Database,
  input: { tenantId: string; userId: string; pipelineId: string; name: string },
): Promise<UpdateDealPipelineResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await getPipelineById(tx, input.tenantId, input.pipelineId);
    if (!existing) return { kind: "not_found" };
    const [updated] = await tx
      .update(dealPipelines)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(dealPipelines.id, input.pipelineId))
      .returning();
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.pipeline_updated",
      meta: { pipelineId: input.pipelineId },
    });
    return { kind: "updated", pipeline: updated! };
  });
}

export type DeleteDealPipelineResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "has_deals"; dealCount: number };

export async function deleteDealPipeline(
  db: Database,
  input: { tenantId: string; userId: string; pipelineId: string },
): Promise<DeleteDealPipelineResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const existing = await getPipelineById(tx, input.tenantId, input.pipelineId);
    if (!existing) return { kind: "not_found" };
    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, input.tenantId),
          eq(deals.pipelineId, input.pipelineId),
        ),
      );
    const dealCount = countRow?.count ?? 0;
    if (dealCount > 0) return { kind: "has_deals", dealCount };
    await tx
      .delete(dealPipelines)
      .where(eq(dealPipelines.id, input.pipelineId));
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.pipeline_deleted",
      meta: { pipelineId: input.pipelineId },
    });
    return { kind: "deleted" };
  });
}

// ---------------------------------------------------------------------------
// Tahap (jalur API)
// ---------------------------------------------------------------------------

export type CreateDealStageResult =
  | { kind: "created"; stage: DealStage }
  | { kind: "pipeline_not_found" };

export async function createDealStage(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    pipelineId: string;
    name: string;
    color?: string | undefined;
    kind?: DealStageKind | undefined;
  },
): Promise<CreateDealStageResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const pipeline = await getPipelineById(tx, input.tenantId, input.pipelineId);
    if (!pipeline) return { kind: "pipeline_not_found" };
    const siblings = await listStagesOfPipeline(
      tx,
      input.tenantId,
      input.pipelineId,
    );
    const [stage] = await tx
      .insert(dealStages)
      .values({
        tenantId: input.tenantId,
        pipelineId: input.pipelineId,
        name: input.name,
        position: siblings.length,
        color: input.color ?? "#64748b",
        kind: input.kind ?? "open",
      })
      .returning();
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.stage_created",
      meta: { pipelineId: input.pipelineId, stageId: stage!.id },
    });
    return { kind: "created", stage: stage! };
  });
}

export type UpdateDealStageResult =
  | { kind: "updated"; stage: DealStage }
  | { kind: "not_found" };

export async function updateDealStage(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    pipelineId: string;
    stageId: string;
    name?: string | undefined;
    color?: string | undefined;
    kind?: DealStageKind | undefined;
  },
): Promise<UpdateDealStageResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const stage = await getStageById(tx, input.tenantId, input.stageId);
    if (!stage || stage.pipelineId !== input.pipelineId) {
      return { kind: "not_found" };
    }
    const patch: Partial<DealStage> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.color !== undefined) patch.color = input.color;
    if (input.kind !== undefined) patch.kind = input.kind;
    const [updated] = await tx
      .update(dealStages)
      .set(patch)
      .where(eq(dealStages.id, input.stageId))
      .returning();
    let statusRecomputed = 0;
    if (input.kind !== undefined && input.kind !== stage.kind) {
      // Kind berubah: turunkan ulang status deal yang SEDANG di tahap
      // ini (tanpa peristiwa perpindahan — mereka tidak berpindah).
      const status = statusForStageKind(input.kind);
      const now = new Date();
      const sitting = await tx
        .select()
        .from(deals)
        .where(
          and(eq(deals.tenantId, input.tenantId), eq(deals.stageId, stage.id)),
        );
      for (const deal of sitting) {
        if (deal.status === status) continue;
        await tx
          .update(deals)
          .set({
            status,
            closedAt:
              status === "open" ? null : (deal.closedAt ?? now),
            updatedAt: now,
          })
          .where(eq(deals.id, deal.id));
        statusRecomputed++;
      }
    }
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.stage_updated",
      meta: {
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        ...(statusRecomputed > 0 ? { statusRecomputed } : {}),
      },
    });
    return { kind: "updated", stage: updated! };
  });
}

export type ReorderDealStagesResult =
  | { kind: "reordered"; stages: DealStage[] }
  | { kind: "pipeline_not_found" }
  | { kind: "invalid_stage_set" };

export async function reorderDealStages(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    pipelineId: string;
    stageIds: string[];
  },
): Promise<ReorderDealStagesResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const pipeline = await getPipelineById(tx, input.tenantId, input.pipelineId);
    if (!pipeline) return { kind: "pipeline_not_found" };
    const existing = await listStagesOfPipeline(
      tx,
      input.tenantId,
      input.pipelineId,
    );
    const existingIds = new Set(existing.map((s) => s.id));
    const given = new Set(input.stageIds);
    if (
      given.size !== existingIds.size ||
      ![...given].every((id) => existingIds.has(id))
    ) {
      return { kind: "invalid_stage_set" };
    }
    for (const [i, stageId] of input.stageIds.entries()) {
      await tx
        .update(dealStages)
        .set({ position: i, updatedAt: new Date() })
        .where(eq(dealStages.id, stageId));
    }
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.stages_reordered",
      meta: { pipelineId: input.pipelineId },
    });
    return {
      kind: "reordered",
      stages: await listStagesOfPipeline(tx, input.tenantId, input.pipelineId),
    };
  });
}

export type DeleteDealStageResult =
  | { kind: "deleted"; movedDeals: number }
  | { kind: "not_found" }
  | { kind: "stage_not_empty"; dealCount: number }
  | { kind: "invalid_move_target" };

export async function deleteDealStage(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    pipelineId: string;
    stageId: string;
    moveDealsToStageId?: string | undefined;
  },
): Promise<DeleteDealStageResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const stage = await getStageById(tx, input.tenantId, input.stageId);
    if (!stage || stage.pipelineId !== input.pipelineId) {
      return { kind: "not_found" };
    }
    const sitting = await tx
      .select()
      .from(deals)
      .where(
        and(eq(deals.tenantId, input.tenantId), eq(deals.stageId, stage.id)),
      );
    let movedDeals = 0;
    if (sitting.length > 0) {
      if (!input.moveDealsToStageId) {
        return { kind: "stage_not_empty", dealCount: sitting.length };
      }
      const target = await getStageById(
        tx,
        input.tenantId,
        input.moveDealsToStageId,
      );
      if (
        !target ||
        target.pipelineId !== input.pipelineId ||
        target.id === stage.id
      ) {
        return { kind: "invalid_move_target" };
      }
      for (const deal of sitting) {
        await applyDealStageMove(tx, {
          tenantId: input.tenantId,
          deal,
          toStage: target,
          actor: { type: "user", id: input.userId },
        });
        movedDeals++;
      }
    }
    await tx.delete(dealStages).where(eq(dealStages.id, stage.id));
    // Rapatkan posisi tahap yang tersisa agar urutan tetap 0..n-1.
    const remaining = await listStagesOfPipeline(
      tx,
      input.tenantId,
      input.pipelineId,
    );
    for (const [i, s] of remaining.entries()) {
      if (s.position !== i) {
        await tx
          .update(dealStages)
          .set({ position: i })
          .where(eq(dealStages.id, s.id));
      }
    }
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.stage_deleted",
      meta: { pipelineId: input.pipelineId, stageId: stage.id, movedDeals },
    });
    return { kind: "deleted", movedDeals };
  });
}

// ---------------------------------------------------------------------------
// Deal (jalur API)
// ---------------------------------------------------------------------------

export interface CreateDealInput {
  tenantId: string;
  userId: string;
  title: string;
  contactId: string;
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  conversationId?: string | null | undefined;
  value?: number | undefined;
  currency?: string | undefined;
  expectedCloseDate?: string | null | undefined;
  dueAt?: string | null | undefined;
  priority?: DealPriority | undefined;
  assigneeUserId?: string | null | undefined;
}

export type CreateDealResult =
  | { kind: "created"; deal: DealView }
  | { kind: "contact_not_found" }
  | { kind: "pipeline_not_found" }
  | { kind: "pipeline_has_no_stages" }
  | { kind: "stage_not_found" }
  | { kind: "assignee_not_member" }
  | { kind: "conversation_not_found" };

export async function createDeal(
  db: Database,
  input: CreateDealInput,
): Promise<CreateDealResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, input.tenantId), eq(contacts.id, input.contactId)),
      )
      .limit(1);
    if (!contact) return { kind: "contact_not_found" };

    // Tentukan tahap awal: stageId eksplisit menang; selain itu tahap
    // pertama pipeline terpilih (pipelineId atau pipeline bawaan).
    let stage: DealStage | null = null;
    if (input.stageId) {
      stage = await getStageById(tx, input.tenantId, input.stageId);
      if (!stage) return { kind: "stage_not_found" };
      if (input.pipelineId && stage.pipelineId !== input.pipelineId) {
        return { kind: "stage_not_found" };
      }
    } else {
      let pipeline: DealPipeline | null = null;
      if (input.pipelineId) {
        pipeline = await getPipelineById(tx, input.tenantId, input.pipelineId);
        if (!pipeline) return { kind: "pipeline_not_found" };
      } else {
        pipeline = await ensureDefaultDealPipeline(tx, input.tenantId);
      }
      const stages = await listStagesOfPipeline(
        tx,
        input.tenantId,
        pipeline.id,
      );
      stage = stages[0] ?? null;
      if (!stage) return { kind: "pipeline_has_no_stages" };
    }

    if (
      input.assigneeUserId &&
      !(await isTenantMember(tx, input.tenantId, input.assigneeUserId))
    ) {
      return { kind: "assignee_not_member" };
    }
    if (input.conversationId) {
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, input.tenantId),
            eq(conversations.id, input.conversationId),
            eq(conversations.contactId, input.contactId),
          ),
        )
        .limit(1);
      if (!conv) return { kind: "conversation_not_found" };
    }

    const { defaultCurrency } = await getTenantDealContext(tx, input.tenantId);
    const deal = await insertDealRow(tx, {
      tenantId: input.tenantId,
      contactId: input.contactId,
      stage,
      conversationId: input.conversationId ?? null,
      title: input.title,
      value: input.value,
      currency: input.currency ?? defaultCurrency,
      expectedCloseDate: input.expectedCloseDate ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      priority: input.priority,
      assigneeUserId: input.assigneeUserId ?? null,
      actor: { type: "user", id: input.userId },
    });
    const view = await dealViewById(tx, input.tenantId, deal.id);
    return { kind: "created", deal: view! };
  });
}

export interface ListDealsFilter {
  pipelineId?: string | undefined;
  stageId?: string | undefined;
  status?: DealStatus | undefined;
  contactId?: string | undefined;
  limit?: number | undefined;
}

export async function listDeals(
  db: Database,
  tenantId: string,
  filter: ListDealsFilter = {},
): Promise<DealView[]> {
  return withTenantDb(db, tenantId, async (tx) => {
    const conditions = [eq(deals.tenantId, tenantId)];
    if (filter.pipelineId) conditions.push(eq(deals.pipelineId, filter.pipelineId));
    if (filter.stageId) conditions.push(eq(deals.stageId, filter.stageId));
    if (filter.status) conditions.push(eq(deals.status, filter.status));
    if (filter.contactId) conditions.push(eq(deals.contactId, filter.contactId));
    const rows = await tx
      .select({
        deal: deals,
        contactName: contacts.name,
        assigneeName: users.name,
        assigneeEmail: users.email,
      })
      .from(deals)
      .innerJoin(contacts, eq(deals.contactId, contacts.id))
      .leftJoin(users, eq(deals.assigneeUserId, users.id))
      .where(and(...conditions))
      .orderBy(desc(deals.createdAt), desc(deals.id))
      .limit(Math.min(Math.max(filter.limit ?? 500, 1), 1000));
    return rows.map((r) => ({
      ...r.deal,
      contactName: r.contactName,
      assigneeName:
        r.deal.assigneeUserId !== null
          ? (r.assigneeName ?? r.assigneeEmail)
          : null,
    }));
  });
}

export interface DealDetail {
  deal: DealView;
  stageHistory: DealStageEvent[];
}

export async function getDealDetail(
  db: Database,
  input: { tenantId: string; dealId: string },
): Promise<DealDetail | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const deal = await dealViewById(tx, input.tenantId, input.dealId);
    if (!deal) return null;
    const stageHistory = await tx
      .select()
      .from(dealStageEvents)
      .where(
        and(
          eq(dealStageEvents.tenantId, input.tenantId),
          eq(dealStageEvents.dealId, input.dealId),
        ),
      )
      .orderBy(asc(dealStageEvents.createdAt), asc(dealStageEvents.id));
    return { deal, stageHistory };
  });
}

export interface UpdateDealInput {
  tenantId: string;
  userId: string;
  dealId: string;
  title?: string | undefined;
  value?: number | undefined;
  currency?: string | undefined;
  expectedCloseDate?: string | null | undefined;
  dueAt?: string | null | undefined;
  priority?: DealPriority | undefined;
  assigneeUserId?: string | null | undefined;
  conversationId?: string | null | undefined;
  contactId?: string | undefined;
}

export type UpdateDealResult =
  | { kind: "updated"; deal: DealView }
  | { kind: "not_found" }
  | { kind: "contact_not_found" }
  | { kind: "assignee_not_member" }
  | { kind: "conversation_not_found" };

export async function updateDeal(
  db: Database,
  input: UpdateDealInput,
): Promise<UpdateDealResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(deals)
      .where(and(eq(deals.tenantId, input.tenantId), eq(deals.id, input.dealId)))
      .limit(1);
    if (!existing) return { kind: "not_found" };
    const contactId = input.contactId ?? existing.contactId;
    if (input.contactId && input.contactId !== existing.contactId) {
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, input.tenantId),
            eq(contacts.id, input.contactId),
          ),
        )
        .limit(1);
      if (!contact) return { kind: "contact_not_found" };
    }
    if (
      input.assigneeUserId &&
      !(await isTenantMember(tx, input.tenantId, input.assigneeUserId))
    ) {
      return { kind: "assignee_not_member" };
    }
    if (input.conversationId) {
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, input.tenantId),
            eq(conversations.id, input.conversationId),
            eq(conversations.contactId, contactId),
          ),
        )
        .limit(1);
      if (!conv) return { kind: "conversation_not_found" };
    }
    const patch: Partial<Deal> = { updatedAt: new Date() };
    const changed: string[] = [];
    if (input.title !== undefined) { patch.title = input.title; changed.push("title"); }
    if (input.value !== undefined) { patch.value = input.value.toFixed(2); changed.push("value"); }
    if (input.currency !== undefined) { patch.currency = input.currency; changed.push("currency"); }
    if (input.expectedCloseDate !== undefined) { patch.expectedCloseDate = input.expectedCloseDate; changed.push("expectedCloseDate"); }
    if (input.dueAt !== undefined) { patch.dueAt = input.dueAt ? new Date(input.dueAt) : null; changed.push("dueAt"); }
    if (input.priority !== undefined) { patch.priority = input.priority; changed.push("priority"); }
    if (input.assigneeUserId !== undefined) { patch.assigneeUserId = input.assigneeUserId; changed.push("assigneeUserId"); }
    if (input.conversationId !== undefined) { patch.conversationId = input.conversationId; changed.push("conversationId"); }
    if (input.contactId !== undefined) { patch.contactId = input.contactId; changed.push("contactId"); }
    await tx
      .update(deals)
      .set(patch)
      .where(eq(deals.id, input.dealId));
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.updated",
      meta: { dealId: input.dealId, contactId, changed },
    });
    const view = await dealViewById(tx, input.tenantId, input.dealId);
    return { kind: "updated", deal: view! };
  });
}

export type MoveDealStageResult =
  | { kind: "moved"; deal: DealView; changed: boolean }
  | { kind: "not_found" }
  | { kind: "stage_not_found" };

export async function moveDealStage(
  db: Database,
  input: { tenantId: string; userId: string; dealId: string; stageId: string },
): Promise<MoveDealStageResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(deals)
      .where(and(eq(deals.tenantId, input.tenantId), eq(deals.id, input.dealId)))
      .limit(1);
    if (!existing) return { kind: "not_found" };
    const stage = await getStageById(tx, input.tenantId, input.stageId);
    if (!stage) return { kind: "stage_not_found" };
    const { changed } = await applyDealStageMove(tx, {
      tenantId: input.tenantId,
      deal: existing,
      toStage: stage,
      actor: { type: "user", id: input.userId },
    });
    const view = await dealViewById(tx, input.tenantId, input.dealId);
    return { kind: "moved", deal: view!, changed };
  });
}

export type DeleteDealResult = { kind: "deleted" } | { kind: "not_found" };

export async function deleteDeal(
  db: Database,
  input: { tenantId: string; userId: string; dealId: string },
): Promise<DeleteDealResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: deals.id, contactId: deals.contactId })
      .from(deals)
      .where(and(eq(deals.tenantId, input.tenantId), eq(deals.id, input.dealId)))
      .limit(1);
    if (!existing) return { kind: "not_found" };
    await tx.delete(deals).where(eq(deals.id, input.dealId));
    await writeDealAudit(tx, {
      tenantId: input.tenantId,
      actor: { type: "user", id: input.userId },
      action: "deal.deleted",
      meta: { dealId: input.dealId, contactId: existing.contactId },
    });
    return { kind: "deleted" };
  });
}

// ---------------------------------------------------------------------------
// Analitik ringan (halaman pipeline)
// ---------------------------------------------------------------------------

export interface DealStageAnalytics {
  stageId: string;
  dealCount: number;
  totals: Array<{ currency: string; total: number }>;
}

export interface DealPipelineAnalytics {
  pipelineId: string;
  stages: DealStageAnalytics[];
  wonCount: number;
  lostCount: number;
  avgDaysToWon: number | null;
}

export type GetDealPipelineAnalyticsResult =
  | { kind: "ok"; analytics: DealPipelineAnalytics }
  | { kind: "pipeline_not_found" };

export async function getDealPipelineAnalytics(
  db: Database,
  input: { tenantId: string; pipelineId: string },
): Promise<GetDealPipelineAnalyticsResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const pipeline = await getPipelineById(tx, input.tenantId, input.pipelineId);
    if (!pipeline) return { kind: "pipeline_not_found" };
    const stages = await listStagesOfPipeline(
      tx,
      input.tenantId,
      input.pipelineId,
    );
    // Hitungan + total per (tahap, mata uang) — pengelompokan di SQL;
    // mata uang TIDAK pernah dijumlahkan satu sama lain.
    const grouped = await tx
      .select({
        stageId: deals.stageId,
        currency: deals.currency,
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${deals.value}), 0)`,
      })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, input.tenantId),
          eq(deals.pipelineId, input.pipelineId),
        ),
      )
      .groupBy(deals.stageId, deals.currency);
    const byStage = new Map<string, DealStageAnalytics>();
    for (const s of stages) {
      byStage.set(s.id, { stageId: s.id, dealCount: 0, totals: [] });
    }
    for (const row of grouped) {
      const entry = byStage.get(row.stageId);
      if (!entry) continue;
      entry.dealCount += row.count;
      entry.totals.push({
        currency: row.currency,
        total: Number.parseFloat(row.total),
      });
    }
    for (const entry of byStage.values()) {
      entry.totals.sort((a, b) => a.currency.localeCompare(b.currency));
    }
    const statusCounts = await tx
      .select({
        status: deals.status,
        count: sql<number>`count(*)::int`,
      })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, input.tenantId),
          eq(deals.pipelineId, input.pipelineId),
        ),
      )
      .groupBy(deals.status);
    let wonCount = 0;
    let lostCount = 0;
    for (const row of statusCounts) {
      if (row.status === "won") wonCount = row.count;
      if (row.status === "lost") lostCount = row.count;
    }
    // Rata-rata hari dibuat → won: hanya deal won yang closed_at-nya
    // terisi (semua deal won hasil perpindahan/penurunan status punya
    // closed_at; baris tanpa closed_at dikecualikan, bukan ditebak).
    const [avgRow] = await tx
      .select({
        avgDays: sql<string | null>`avg(extract(epoch from (${deals.closedAt} - ${deals.createdAt})) / 86400.0)`,
      })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, input.tenantId),
          eq(deals.pipelineId, input.pipelineId),
          eq(deals.status, "won"),
          sql`${deals.closedAt} is not null`,
        ),
      );
    const avgDaysToWon =
      avgRow?.avgDays != null
        ? Math.round(Number.parseFloat(avgRow.avgDays) * 100) / 100
        : null;
    return {
      kind: "ok",
      analytics: {
        pipelineId: input.pipelineId,
        stages: stages.map((s) => byStage.get(s.id)!),
        wonCount,
        lostCount,
        avgDaysToWon,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Jalur OTOMASI (node flow create_deal / move_deal_stage) — berjalan di
// transaksi pemanggil; kegagalan lunak = `skipped` beralasan.
// ---------------------------------------------------------------------------

export type CreateDealForContactResult =
  | { kind: "created"; dealId: string }
  | {
      kind: "skipped";
      reason: "stage_unavailable" | "contact_not_found" | "assignee_not_member";
    };

export async function createDealForContact(
  tx: DbTx,
  input: {
    tenantId: string;
    contactId: string;
    conversationId?: string | null;
    title: string;
    value?: number | undefined;
    stageId: string;
    assigneeUserId?: string | null;
    actor: DealActor;
    auditMetaExtra?: Record<string, unknown> | undefined;
  },
): Promise<CreateDealForContactResult> {
  const [contact] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(eq(contacts.tenantId, input.tenantId), eq(contacts.id, input.contactId)),
    )
    .limit(1);
  if (!contact) return { kind: "skipped", reason: "contact_not_found" };
  const stage = await getStageById(tx, input.tenantId, input.stageId);
  if (!stage) return { kind: "skipped", reason: "stage_unavailable" };
  if (
    input.assigneeUserId &&
    !(await isTenantMember(tx, input.tenantId, input.assigneeUserId))
  ) {
    return { kind: "skipped", reason: "assignee_not_member" };
  }
  const { defaultCurrency } = await getTenantDealContext(tx, input.tenantId);
  const deal = await insertDealRow(tx, {
    tenantId: input.tenantId,
    contactId: input.contactId,
    stage,
    // Percakapan run diteruskan apa adanya bila pemanggil memberikannya
    // (konteks run sudah terverifikasi milik kontak ini oleh mesin flow).
    conversationId: input.conversationId ?? null,
    title: input.title,
    value: input.value,
    currency: defaultCurrency,
    actor: input.actor,
    auditMetaExtra: input.auditMetaExtra,
  });
  return { kind: "created", dealId: deal.id };
}

export type MoveLatestOpenDealStageResult =
  | {
      kind: "moved";
      dealId: string;
      fromStageId: string;
      toStageId: string;
      changed: boolean;
    }
  | { kind: "skipped"; reason: "no_open_deal" | "stage_unavailable" };

/**
 * Pindahkan deal OPEN TERBARU kontak (created_at paling baru) ke tahap
 * tujuan. Kontak tanpa deal open → `skipped/no_open_deal` — keadaan
 * yang sah untuk otomasi (bukan kegagalan), pemanggil mencatatnya di
 * detail langkah run.
 */
export async function moveLatestOpenDealStage(
  tx: DbTx,
  input: {
    tenantId: string;
    contactId: string;
    stageId: string;
    actor: DealActor;
    auditMetaExtra?: Record<string, unknown> | undefined;
  },
): Promise<MoveLatestOpenDealStageResult> {
  const stage = await getStageById(tx, input.tenantId, input.stageId);
  if (!stage) return { kind: "skipped", reason: "stage_unavailable" };
  const [deal] = await tx
    .select()
    .from(deals)
    .where(
      and(
        eq(deals.tenantId, input.tenantId),
        eq(deals.contactId, input.contactId),
        eq(deals.status, "open"),
      ),
    )
    .orderBy(desc(deals.createdAt), desc(deals.id))
    .limit(1);
  if (!deal) return { kind: "skipped", reason: "no_open_deal" };
  const fromStageId = deal.stageId;
  const { changed } = await applyDealStageMove(tx, {
    tenantId: input.tenantId,
    deal,
    toStage: stage,
    actor: input.actor,
    auditMetaExtra: input.auditMetaExtra,
  });
  return {
    kind: "moved",
    dealId: deal.id,
    fromStageId,
    toStageId: stage.id,
    changed,
  };
}
