/**
 * Baca run flow & langkahnya (dipakai dashboard untuk 8B/debugging).
 */
import {
  and,
  asc,
  desc,
  eq,
  sql,
} from "drizzle-orm";
import {
  contacts,
  flowRunSteps,
  flowRuns,
  flows,
  type Database,
  type FlowRun,
  type FlowRunStep,
} from "@sahabat-kreator/db";
import { withTenantDb } from "../tx";

import {
  FlowRunStatus,
} from "./graph";
import {
  clampLimit,
  cursorCondition,
  decodeCursor,
  encodeCursor,
} from "./pagination";

// ---------------------------------------------------------------------------
// Baca run & langkah (untuk 8B / debugging)
// ---------------------------------------------------------------------------

export type FlowRunWithContact = FlowRun & { contactName: string };

export async function listFlowRuns(
  db: Database,
  input: {
    tenantId: string;
    flowId: string;
    status?: FlowRunStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<
  | { kind: "ok"; runs: FlowRunWithContact[]; nextCursor: string | null }
  | { kind: "not_found" }
> {
  const limit = clampLimit(input.limit);
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [owner] = await tx
      .select({ id: flows.id })
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!owner) return { kind: "not_found" as const };
    const conditions = [
      eq(flowRuns.tenantId, input.tenantId),
      eq(flowRuns.flowId, input.flowId),
    ];
    if (input.status) conditions.push(eq(flowRuns.status, input.status));
    const cc = cursorCondition(
      decodeCursor(input.cursor),
      flowRuns.createdAt,
      flowRuns.id,
    );
    if (cc) conditions.push(cc);
    const rows = await tx
      .select({ run: flowRuns, contactName: contacts.name })
      .from(flowRuns)
      .innerJoin(contacts, eq(flowRuns.contactId, contacts.id))
      .where(and(...conditions))
      .orderBy(desc(flowRuns.createdAt), desc(flowRuns.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      kind: "ok" as const,
      runs: page.map((r) => ({ ...r.run, contactName: r.contactName })),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1].run) : null,
    };
  });
}

export async function listFlowRunSteps(
  db: Database,
  input: {
    tenantId: string;
    runId: string;
    cursor?: string;
    limit?: number;
  },
): Promise<
  | { kind: "ok"; steps: FlowRunStep[]; nextCursor: string | null }
  | { kind: "not_found" }
> {
  const limit = clampLimit(input.limit, 100, 200);
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [run] = await tx
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(
        and(
          eq(flowRuns.tenantId, input.tenantId),
          eq(flowRuns.id, input.runId),
        ),
      )
      .limit(1);
    if (!run) return { kind: "not_found" as const };
    // Paginasi langkah memakai seq menaik (kursor = seq terakhir).
    let afterSeq = 0;
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const parsed = Number.parseInt(cursor.id, 10);
      if (!Number.isNaN(parsed)) afterSeq = parsed;
    }
    const rows = await tx
      .select()
      .from(flowRunSteps)
      .where(
        and(
          eq(flowRunSteps.tenantId, input.tenantId),
          eq(flowRunSteps.runId, input.runId),
          sql`${flowRunSteps.seq} > ${afterSeq}`,
        ),
      )
      .orderBy(asc(flowRunSteps.seq))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      kind: "ok" as const,
      steps: page,
      nextCursor: hasMore
        ? Buffer.from(
            JSON.stringify({
              createdAt: page[page.length - 1].createdAt.toISOString(),
              id: String(page[page.length - 1].seq),
            }),
            "utf8",
          ).toString("base64url")
        : null,
    };
  });
}
