/**
 * Gamifikasi / loyalitas (G18 butir 4) — buku besar poin kontak.
 *
 * Prinsip:
 * - SALDO = SUM(points) atas `contact_point_ledger` kontak itu.
 *   Tidak ada kolom saldo: riwayat adalah kebenaran tunggal, dan
 *   papan peringkat dihitung dari buku besar yang sama.
 * - Pemberian dari flow IDEMPOTEN per run+node: event_id
 *   deterministik `evt_<sha256(runId:nodeId)[0:48]>` (pola G16) +
 *   unique parsial (tenant_id, event_id) + ON CONFLICT DO NOTHING.
 *   Eksekusi ulang langkah yang sama tidak menggandakan poin.
 * - Penyesuaian manual boleh negatif (koreksi) dan selalu membawa
 *   user pelaku; lapisan API menulis auditnya.
 * - Level diturunkan saat baca: level tertinggi yang ambang
 *   `min_points`-nya <= saldo; tenant tanpa level → null jujur.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  contactPointLedger,
  contacts,
  loyaltyLevels,
  type Database,
  type LoyaltyLevel,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";

/** Id peristiwa deterministik pemberian poin flow (idempotensi). */
export function flowAwardEventId(runId: string, nodeId: string): string {
  const digest = createHash("sha256").update(`${runId}:${nodeId}`).digest("hex");
  return `evt_${digest.slice(0, 48)}`;
}

export type AwardFlowPointsResult =
  | { kind: "awarded"; balance: number }
  | { kind: "already_awarded"; balance: number };

/** Saldo poin satu kontak di dalam transaksi tenant. */
export async function contactPointsBalanceTx(
  tx: DbTx,
  tenantId: string,
  contactId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      balance: sql<number>`coalesce(sum(${contactPointLedger.points}), 0)::int`,
    })
    .from(contactPointLedger)
    .where(
      and(
        eq(contactPointLedger.tenantId, tenantId),
        eq(contactPointLedger.contactId, contactId),
      ),
    );
  return row?.balance ?? 0;
}

/**
 * Beri poin dari langkah flow (dipanggil eksekutor di dalam
 * transaksi langkah). Idempoten per run+node.
 */
export async function awardFlowPointsTx(
  tx: DbTx,
  input: {
    tenantId: string;
    contactId: string;
    runId: string;
    nodeId: string;
    points: number;
    note?: string | null;
  },
): Promise<AwardFlowPointsResult> {
  const inserted = await tx
    .insert(contactPointLedger)
    .values({
      tenantId: input.tenantId,
      contactId: input.contactId,
      points: input.points,
      source: "flow_award",
      eventId: flowAwardEventId(input.runId, input.nodeId),
      runId: input.runId,
      nodeId: input.nodeId,
      note: input.note ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: contactPointLedger.id });
  const balance = await contactPointsBalanceTx(
    tx,
    input.tenantId,
    input.contactId,
  );
  return inserted.length > 0
    ? { kind: "awarded", balance }
    : { kind: "already_awarded", balance };
}

/** Penyesuaian manual oleh tim (delta ±, bukan nol). */
export async function adjustContactPoints(
  db: Database,
  ctx: TenantContext,
  input: {
    contactId: string;
    points: number;
    note?: string | null;
    userId: string;
  },
): Promise<{ balance: number } | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.tenantId, ctx.tenantId), eq(contacts.id, input.contactId)),
      )
      .limit(1);
    if (!contact) return null;
    await tx.insert(contactPointLedger).values({
      tenantId: ctx.tenantId,
      contactId: input.contactId,
      points: input.points,
      source: "manual",
      note: input.note ?? null,
      createdByUserId: input.userId,
    });
    const balance = await contactPointsBalanceTx(
      tx,
      ctx.tenantId,
      input.contactId,
    );
    // Penyesuaian manual mengubah nilai pelanggan — selalu diaudit.
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "contact.points_adjusted",
      meta: { contactId: input.contactId, points: input.points, balance },
    });
    return { balance };
  });
}

export interface ContactPointsView {
  balance: number;
  levelName: string | null;
  nextLevel: { name: string; pointsNeeded: number } | null;
  entries: Array<{
    id: string;
    points: number;
    source: "flow_award" | "manual";
    note: string | null;
    createdByUserId: string | null;
    createdAt: Date;
  }>;
}

/** Turunkan level dari saldo: ambang tertinggi yang terpenuhi. */
export function levelForBalance(
  levels: Array<Pick<LoyaltyLevel, "name" | "minPoints">>,
  balance: number,
): { current: string | null; next: { name: string; pointsNeeded: number } | null } {
  const sorted = [...levels].sort((a, b) => a.minPoints - b.minPoints);
  let current: string | null = null;
  let next: { name: string; pointsNeeded: number } | null = null;
  for (const level of sorted) {
    if (balance >= level.minPoints) {
      current = level.name;
    } else {
      next = { name: level.name, pointsNeeded: level.minPoints - balance };
      break;
    }
  }
  return { current, next };
}

export async function getContactPoints(
  db: Database,
  ctx: TenantContext,
  contactId: string,
  entryLimit = 20,
): Promise<ContactPointsView | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenantId), eq(contacts.id, contactId)))
      .limit(1);
    if (!contact) return null;
    const balance = await contactPointsBalanceTx(tx, ctx.tenantId, contactId);
    const levels = await tx
      .select()
      .from(loyaltyLevels)
      .where(eq(loyaltyLevels.tenantId, ctx.tenantId))
      .orderBy(asc(loyaltyLevels.minPoints));
    const { current, next } = levelForBalance(levels, balance);
    const rows = await tx
      .select()
      .from(contactPointLedger)
      .where(
        and(
          eq(contactPointLedger.tenantId, ctx.tenantId),
          eq(contactPointLedger.contactId, contactId),
        ),
      )
      .orderBy(desc(contactPointLedger.createdAt))
      .limit(entryLimit);
    return {
      balance,
      levelName: current,
      nextLevel: next,
      entries: rows.map((r) => ({
        id: r.id,
        points: r.points,
        source: r.source === "manual" ? ("manual" as const) : ("flow_award" as const),
        note: r.note,
        createdByUserId: r.createdByUserId,
        createdAt: r.createdAt,
      })),
    };
  });
}

export interface LeaderboardRow {
  contactId: string;
  contactName: string;
  balance: number;
  levelName: string | null;
}

/**
 * Papan peringkat: saldo dari buku besar, tertinggi dulu. Hanya
 * kontak dengan saldo > 0 yang tampil (kontak tanpa poin bukan
 * peserta peringkat).
 */
export async function listLeaderboard(
  db: Database,
  ctx: TenantContext,
  limit = 50,
): Promise<LeaderboardRow[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const levels = await tx
      .select()
      .from(loyaltyLevels)
      .where(eq(loyaltyLevels.tenantId, ctx.tenantId))
      .orderBy(asc(loyaltyLevels.minPoints));
    const rows = await tx
      .select({
        contactId: contacts.id,
        contactName: contacts.name,
        balance: sql<number>`sum(${contactPointLedger.points})::int`,
      })
      .from(contactPointLedger)
      .innerJoin(contacts, eq(contactPointLedger.contactId, contacts.id))
      .where(eq(contactPointLedger.tenantId, ctx.tenantId))
      .groupBy(contacts.id, contacts.name)
      .having(sql`sum(${contactPointLedger.points}) > 0`)
      .orderBy(desc(sql`sum(${contactPointLedger.points})`), asc(contacts.name))
      .limit(limit);
    return rows.map((r) => ({
      contactId: r.contactId,
      contactName: r.contactName,
      balance: r.balance,
      levelName: levelForBalance(levels, r.balance).current,
    }));
  });
}

// ---------------------------------------------------------------------------
// Level loyalitas (diatur tenant)
// ---------------------------------------------------------------------------

export async function listLoyaltyLevels(
  db: Database,
  ctx: TenantContext,
): Promise<LoyaltyLevel[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) =>
    tx
      .select()
      .from(loyaltyLevels)
      .where(eq(loyaltyLevels.tenantId, ctx.tenantId))
      .orderBy(asc(loyaltyLevels.minPoints)),
  );
}

export type LoyaltyLevelWriteResult =
  | { kind: "ok"; level: LoyaltyLevel }
  | { kind: "duplicate_min_points" }
  | { kind: "not_found" };

function isUniqueViolation(err: unknown): boolean {
  // Drizzle membungkus error PG di `cause` (DrizzleQueryError) —
  // telusuri rantainya sampai kode SQLSTATE ketemu.
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function createLoyaltyLevel(
  db: Database,
  ctx: TenantContext,
  input: { name: string; minPoints: number },
): Promise<LoyaltyLevelWriteResult> {
  try {
    const level = await withTenantDb(db, ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(loyaltyLevels)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          minPoints: input.minPoints,
        })
        .returning();
      return row!;
    });
    return { kind: "ok", level };
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: "duplicate_min_points" };
    throw err;
  }
}

export async function updateLoyaltyLevel(
  db: Database,
  ctx: TenantContext,
  levelId: string,
  input: { name?: string; minPoints?: number },
): Promise<LoyaltyLevelWriteResult> {
  try {
    const level = await withTenantDb(db, ctx.tenantId, async (tx) => {
      const [row] = await tx
        .update(loyaltyLevels)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.minPoints !== undefined
            ? { minPoints: input.minPoints }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(loyaltyLevels.tenantId, ctx.tenantId),
            eq(loyaltyLevels.id, levelId),
          ),
        )
        .returning();
      return row ?? null;
    });
    if (!level) return { kind: "not_found" };
    return { kind: "ok", level };
  } catch (err) {
    if (isUniqueViolation(err)) return { kind: "duplicate_min_points" };
    throw err;
  }
}

export async function deleteLoyaltyLevel(
  db: Database,
  ctx: TenantContext,
  levelId: string,
): Promise<boolean> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .delete(loyaltyLevels)
      .where(
        and(
          eq(loyaltyLevels.tenantId, ctx.tenantId),
          eq(loyaltyLevels.id, levelId),
        ),
      )
      .returning({ id: loyaltyLevels.id });
    return rows.length > 0;
  });
}
