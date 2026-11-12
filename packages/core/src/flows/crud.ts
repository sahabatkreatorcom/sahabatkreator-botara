/**
 * Manajemen flow (sisi API dashboard): audit, CRUD, transisi status.
 *
 * Aturan yang ditegakkan di sini (bukan di lapisan HTTP): edit hanya
 * saat draft, transisi status yang sah, dan aktivasi menolak graf rusak.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { findFlowTemplate } from "@sahabat-kreator/contracts";
import {
  auditLogs,
  flowRuns,
  flowVersions,
  flows,
  type Database,
  type Flow,
  type FlowVersion,
} from "@sahabat-kreator/db";
import {
  withTenantDb,
  type DbTx,
} from "../tx";

import {
  FlowGraphData,
  FlowGraphEdge,
  FlowGraphNode,
  FlowStatus,
  normalizeFlowGraph,
} from "./graph";
import {
  validateFlowGraph,
  type FlowGraphIssue,
} from "./validate";
import {
  copyFlowGraph,
  flowGraphsEqual,
  latestFlowVersion,
  snapshotFlowVersion,
} from "./versions";
import {
  clampLimit,
  cursorCondition,
  decodeCursor,
  encodeCursor,
} from "./pagination";

// ---------------------------------------------------------------------------
// Manajemen flow (sisi API)
// ---------------------------------------------------------------------------

export type FlowWithRunCount = Flow & { runCount: number };

export async function flowAudit(
  tx: DbTx,
  tenantId: string,
  input: {
    actorType: "user" | "system";
    actorId: string;
    action: string;
    flowId: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    meta: { flowId: input.flowId, ...(input.meta ?? {}) },
  });
}

/**
 * Fase 13D: audit nyala/mati mode eksperimen per node ab_split —
 * bandingkan flag `experiment` per id node antara graf lama (null =
 * belum ada) dan graf baru; setiap perubahan arah menulis satu baris
 * `flow.experiment_enabled` / `flow.experiment_disabled`. Perubahan
 * persen/label saja tidak diaudit di sini (tercakup flow.updated).
 */
async function auditExperimentToggles(
  tx: DbTx,
  tenantId: string,
  input: {
    userId: string;
    flowId: string;
    oldGraph: FlowGraphData | null;
    newGraph: FlowGraphData;
  },
): Promise<void> {
  const oldSplits = new Map(
    (input.oldGraph?.nodes ?? [])
      .filter((n) => n.type === "ab_split")
      .map((n) => [n.id, n.config.experiment === true] as const),
  );
  for (const node of input.newGraph.nodes) {
    if (node.type !== "ab_split") continue;
    const was = oldSplits.get(node.id) ?? false;
    const is = node.config.experiment === true;
    if (was === is) continue;
    await flowAudit(tx, tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: is ? "flow.experiment_enabled" : "flow.experiment_disabled",
      flowId: input.flowId,
      meta: {
        nodeId: node.id,
        label:
          typeof node.config.experimentLabel === "string"
            ? node.config.experimentLabel
            : null,
        percentA:
          typeof node.config.percentA === "number"
            ? node.config.percentA
            : null,
      },
    });
  }
}

export async function createFlow(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    name: string;
    graph?: FlowGraphData;
  },
): Promise<{ kind: "created"; flow: FlowWithRunCount }> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(flows)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        status: "draft",
        graph: input.graph ?? { nodes: [], edges: [] },
        createdByUserId: input.userId,
      })
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.created",
      flowId: row.id,
      meta: { name: row.name },
    });
    if (input.graph) {
      await auditExperimentToggles(tx, input.tenantId, {
        userId: input.userId,
        flowId: row.id,
        oldGraph: null,
        newGraph: input.graph,
      });
    }
    return { kind: "created" as const, flow: { ...row, runCount: 0 } };
  });
}

export type InstantiateFlowTemplateResult =
  | { kind: "created"; flow: FlowWithRunCount }
  | { kind: "template_not_found" };

/**
 * Membuat flow DRAFT dari template katalog (Fase 12B — definisi
 * template hidup di kontrak, `FLOW_TEMPLATES`). Graf template disalin
 * DALAM (JSON round-trip: definisi statis tidak boleh berubah karena
 * flow hasil instantiate diedit) dan id setiap node diregenerasi
 * dengan pola id acak core (`n_<base64url>`) agar dua hasil
 * instantiate dari template yang sama tidak pernah berbagi id node —
 * rujukan silang seperti goto_flow selalu menunjuk flow, bukan node,
 * jadi regenerasi aman. Nama bawaan = `input.name` atau
 * `template.defaultName`. Audit: `flow.created` (konsisten buat
 * manual) + `flow.template_instantiated` bermeta slug.
 */
export async function instantiateFlowTemplate(
  db: Database,
  input: { tenantId: string; userId: string; slug: string; name?: string },
): Promise<InstantiateFlowTemplateResult> {
  const template = findFlowTemplate(input.slug);
  if (!template) return { kind: "template_not_found" as const };
  const idMap = new Map<string, string>();
  for (const node of template.graph.nodes) {
    idMap.set(node.id, `n_${randomBytes(9).toString("base64url")}`);
  }
  const copy = JSON.parse(JSON.stringify(template.graph)) as {
    nodes: FlowGraphNode[];
    edges: FlowGraphEdge[];
  };
  const graph: FlowGraphData = {
    nodes: copy.nodes.map((n) => ({
      ...n,
      id: idMap.get(n.id) ?? n.id,
    })),
    edges: copy.edges.map((e) => ({
      ...e,
      from: idMap.get(e.from) ?? e.from,
      to: idMap.get(e.to) ?? e.to,
    })),
  };
  const name = input.name?.trim() ? input.name.trim() : template.defaultName;
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(flows)
      .values({
        tenantId: input.tenantId,
        name,
        status: "draft",
        graph,
        createdByUserId: input.userId,
      })
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.created",
      flowId: row.id,
      meta: { name: row.name },
    });
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.template_instantiated",
      flowId: row.id,
      meta: { templateSlug: template.slug, name: row.name },
    });
    return {
      kind: "created" as const,
      flow: { ...row, runCount: 0 },
    };
  });
}

export async function listFlows(
  db: Database,
  input: {
    tenantId: string;
    status?: FlowStatus;
    cursor?: string;
    limit?: number;
  },
): Promise<{ flows: FlowWithRunCount[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  return withTenantDb(db, input.tenantId, async (tx) => {
    const conditions = [eq(flows.tenantId, input.tenantId)];
    if (input.status) conditions.push(eq(flows.status, input.status));
    const cc = cursorCondition(decodeCursor(input.cursor), flows.createdAt, flows.id);
    if (cc) conditions.push(cc);
    const rows = await tx
      .select({
        flow: flows,
        runCount: sql<number>`count(${flowRuns.id})::int`,
      })
      .from(flows)
      .leftJoin(flowRuns, eq(flowRuns.flowId, flows.id))
      .where(and(...conditions))
      .groupBy(flows.id)
      .orderBy(desc(flows.createdAt), desc(flows.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      flows: page.map((r) => ({ ...r.flow, runCount: r.runCount })),
      nextCursor: hasMore
        ? encodeCursor(page[page.length - 1].flow)
        : null,
    };
  });
}

/** Null bila flow tidak ada DI tenant ini. */
export async function getFlow(
  db: Database,
  input: { tenantId: string; flowId: string },
): Promise<FlowWithRunCount | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        flow: flows,
        runCount: sql<number>`count(${flowRuns.id})::int`,
      })
      .from(flows)
      .leftJoin(flowRuns, eq(flowRuns.flowId, flows.id))
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .groupBy(flows.id)
      .limit(1);
    return row ? { ...row.flow, runCount: row.runCount } : null;
  });
}

export type UpdateFlowResult =
  | { kind: "updated"; flow: Flow }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: FlowStatus };

/** Edit nama/graf — hanya saat draft (graf flow aktif tidak boleh berubah di bawah run hidup). */
export async function updateFlow(
  db: Database,
  input: {
    tenantId: string;
    flowId: string;
    userId: string;
    patch: { name?: string; graph?: FlowGraphData };
  },
): Promise<UpdateFlowResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "draft") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const patch: Partial<Flow> = { updatedAt: new Date() };
    if (input.patch.name !== undefined) patch.name = input.patch.name;
    if (input.patch.graph !== undefined) patch.graph = input.patch.graph;
    const [row] = await tx
      .update(flows)
      .set(patch)
      .where(eq(flows.id, input.flowId))
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.updated",
      flowId: row.id,
      meta: {
        name: input.patch.name !== undefined,
        graph: input.patch.graph !== undefined,
      },
    });
    // Fase 13D: nyala/mati mode eksperimen per node ab_split diaudit
    // tersendiri (mengubah cara kontak ditugaskan) — lihat
    // auditExperimentToggles.
    if (input.patch.graph !== undefined) {
      await auditExperimentToggles(tx, input.tenantId, {
        userId: input.userId,
        flowId: row.id,
        oldGraph: normalizeFlowGraph(existing.graph),
        newGraph: input.patch.graph,
      });
    }
    return { kind: "updated" as const, flow: row };
  });
}

export type ActivateFlowResult =
  | {
      kind: "activated";
      flow: Flow;
      warnings: FlowGraphIssue[];
      /** Nomor versi snapshot yang ditulis aktivasi ini (G3). */
      version: number;
    }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: FlowStatus }
  | { kind: "invalid"; issues: FlowGraphIssue[] };

/**
 * Aktivasi: validasi graf menyeluruh dulu (di luar transaksi tulis).
 * Ada ERROR → ditolak utuh dengan daftar masalah; WARNING diteruskan
 * ke pemanggil bersama hasil sukses.
 *
 * G3: aktivasi yang sukses juga menulis SNAPSHOT versi (baris
 * `flow_versions` yang tidak bisa diubah) di transaksi yang sama —
 * run baru mem-pin versi itu dan menyelesaikannya dari snapshot,
 * bukan dari graf live.
 */
export async function activateFlow(
  db: Database,
  input: { tenantId: string; flowId: string; userId: string },
): Promise<ActivateFlowResult> {
  const existing = await getFlow(db, input);
  if (!existing) return { kind: "not_found" };
  if (existing.status !== "draft") {
    return { kind: "invalid_state", status: existing.status };
  }
  const graph = normalizeFlowGraph(existing.graph);
  const issues = await validateFlowGraph(db, input.tenantId, graph, {
    selfFlowId: input.flowId,
  });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) return { kind: "invalid", issues };
  const warnings = issues.filter((i) => i.severity === "warning");
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .update(flows)
      .set({ status: "active", updatedAt: new Date() })
      .where(
        and(
          eq(flows.id, input.flowId),
          eq(flows.status, "draft"),
        ),
      )
      .returning();
    if (!row) return { kind: "invalid_state" as const, status: existing.status };
    const snapshot = await snapshotFlowVersion(tx, input.tenantId, {
      flow: row,
      graph,
      userId: input.userId,
    });
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.activated",
      flowId: row.id,
      meta: { warnings: warnings.map((w) => w.code), version: snapshot.version },
    });
    return {
      kind: "activated" as const,
      flow: row,
      warnings,
      version: snapshot.version,
    };
  });
}

export type FlowStatusActionResult =
  | { kind: "ok"; flow: Flow }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: FlowStatus };

/** Nonaktifkan: active → draft (pemicu baru berhenti; run hidup tidak dibatalkan). */
export async function deactivateFlow(
  db: Database,
  input: { tenantId: string; flowId: string; userId: string },
): Promise<FlowStatusActionResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "active") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const [row] = await tx
      .update(flows)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(flows.id, input.flowId))
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.deactivated",
      flowId: row.id,
    });
    return { kind: "ok" as const, flow: row };
  });
}

/** Arsip: draft|active → archived. Keluar arsip: archived → draft. */
export async function setFlowArchived(
  db: Database,
  input: { tenantId: string; flowId: string; userId: string; archived: boolean },
): Promise<FlowStatusActionResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (input.archived && existing.status === "archived") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    if (!input.archived && existing.status !== "archived") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    const [row] = await tx
      .update(flows)
      .set({
        status: input.archived ? "archived" : "draft",
        updatedAt: new Date(),
      })
      .where(eq(flows.id, input.flowId))
      .returning();
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.updated",
      flowId: row.id,
      meta: { archived: input.archived },
    });
    return { kind: "ok" as const, flow: row };
  });
}

export type DeleteFlowResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: FlowStatus };

/** Hapus — hanya draft (run & langkah ikut terhapus lewat FK cascade). */
export async function deleteFlow(
  db: Database,
  input: { tenantId: string; flowId: string; userId: string },
): Promise<DeleteFlowResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!existing) return { kind: "not_found" as const };
    if (existing.status !== "draft") {
      return { kind: "invalid_state" as const, status: existing.status };
    }
    await tx.delete(flows).where(eq(flows.id, input.flowId));
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.updated",
      flowId: input.flowId,
      meta: { deleted: true, name: existing.name },
    });
    return { kind: "deleted" as const };
  });
}

// ---------------------------------------------------------------------------
// Riwayat & pemulihan versi (G3)
// ---------------------------------------------------------------------------

export type FlowVersionSummary = {
  version: FlowVersion;
  nodeCount: number;
  edgeCount: number;
  /** Versi terbaru DAN flow sedang aktif (graf live = snapshot ini). */
  isCurrent: boolean;
};

export type ListFlowVersionsResult =
  | { kind: "ok"; versions: FlowVersionSummary[] }
  | { kind: "not_found" };

/**
 * Riwayat versi satu flow, terbaru dulu. Ringkasan saja (graf penuh
 * snapshot tidak keluar): jumlah node/edge diturunkan dari snapshot.
 * Flow tenant lain / tak ada → not_found (isolasi tenant).
 */
export async function listFlowVersions(
  db: Database,
  input: { tenantId: string; flowId: string },
): Promise<ListFlowVersionsResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [flow] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!flow) return { kind: "not_found" as const };
    const rows = await tx
      .select()
      .from(flowVersions)
      .where(
        and(
          eq(flowVersions.tenantId, input.tenantId),
          eq(flowVersions.flowId, input.flowId),
        ),
      )
      .orderBy(desc(flowVersions.version));
    const latest = rows.length > 0 ? rows[0].version : null;
    return {
      kind: "ok" as const,
      versions: rows.map((row) => {
        const graph = normalizeFlowGraph(row.graph);
        return {
          version: row,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          isCurrent: flow.status === "active" && row.version === latest,
        };
      }),
    };
  });
}

export type RestoreFlowVersionResult =
  | { kind: "restored"; flow: Flow; version: FlowVersion }
  | { kind: "not_found" }
  | { kind: "version_not_found" }
  | { kind: "invalid_state"; status: FlowStatus }
  | { kind: "dirty_draft"; latestVersion: number }
  | { kind: "invalid"; issues: FlowGraphIssue[] };

/**
 * Pemulihan versi: mengaktifkan kembali isi snapshot `version`
 * sebagai versi BARU (nomor lanjut, `restored_from_version` =
 * sumber) — sejarah append-only, baris sumber tidak berubah.
 *
 * Semantik draft vs published mengikuti aturan yang ada:
 * - flow `active` → boleh: graf live saat aktif selalu sama dengan
 *   versi terbaru (edit hanya draft), jadi tidak ada kerja yang
 *   hilang;
 * - flow `draft` → hanya bila graf draft PERSIS versi terbaru (baru
 *   dinonaktifkan, belum disunting). Draft yang sudah disunting
 *   ditolak `dirty_draft`: menimpanya diam-diam akan menghapus kerja
 *   yang belum pernah teraktivasi — pengguna mengaktifkan draft itu
 *   dulu (menyimpannya sebagai versi) sebelum memulihkan;
 * - flow `archived` → invalid_state (keluar arsip dulu lewat jalur
 *   yang ada).
 * Graf snapshot divalidasi penuh seperti aktivasi biasa: snapshot
 * yang sejak itu menjadi tidak sah (mis. rujukan sequence terhapus)
 * ditolak `invalid` dengan daftar masalah, bukan dipaksakan aktif.
 * Run yang sudah ter-pin tidak terpengaruh; run baru mem-pin versi
 * hasil pemulihan.
 */
export async function restoreFlowVersion(
  db: Database,
  input: {
    tenantId: string;
    flowId: string;
    version: number;
    userId: string;
  },
): Promise<RestoreFlowVersionResult> {
  const pre = await withTenantDb(db, input.tenantId, async (tx) => {
    const [flow] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!flow) return { kind: "not_found" as const };
    const [source] = await tx
      .select()
      .from(flowVersions)
      .where(
        and(
          eq(flowVersions.tenantId, input.tenantId),
          eq(flowVersions.flowId, input.flowId),
          eq(flowVersions.version, input.version),
        ),
      )
      .limit(1);
    if (!source) return { kind: "version_not_found" as const };
    const latest = await latestFlowVersion(tx, input.tenantId, input.flowId);
    return { kind: "ok" as const, flow, source, latest };
  });
  if (pre.kind !== "ok") return pre;
  const { flow, source, latest } = pre;
  if (flow.status === "archived") {
    return { kind: "invalid_state", status: flow.status };
  }
  if (flow.status === "draft") {
    if (
      !latest ||
      !flowGraphsEqual(
        normalizeFlowGraph(flow.graph),
        normalizeFlowGraph(latest.graph),
      )
    ) {
      return {
        kind: "dirty_draft",
        latestVersion: latest?.version ?? source.version,
      };
    }
  }
  const snapshotGraph = normalizeFlowGraph(source.graph);
  const issues = await validateFlowGraph(db, input.tenantId, snapshotGraph, {
    selfFlowId: input.flowId,
  });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) return { kind: "invalid", issues };

  return withTenantDb(db, input.tenantId, async (tx) => {
    // Periksa ulang di dalam transaksi tulis: keadaan bisa berubah
    // sejak pemeriksaan awal (aktivasi/nonaktif balapan).
    const [fresh] = await tx
      .select()
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!fresh) return { kind: "not_found" as const };
    if (fresh.status === "archived") {
      return { kind: "invalid_state" as const, status: fresh.status };
    }
    if (fresh.status === "draft") {
      const freshLatest = await latestFlowVersion(
        tx,
        input.tenantId,
        input.flowId,
      );
      if (
        !freshLatest ||
        !flowGraphsEqual(
          normalizeFlowGraph(fresh.graph),
          normalizeFlowGraph(freshLatest.graph),
        )
      ) {
        return {
          kind: "dirty_draft" as const,
          latestVersion: freshLatest?.version ?? source.version,
        };
      }
    }
    const [row] = await tx
      .update(flows)
      .set({
        graph: copyFlowGraph(snapshotGraph),
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(flows.id, input.flowId))
      .returning();
    const version = await snapshotFlowVersion(tx, input.tenantId, {
      flow: row,
      graph: snapshotGraph,
      userId: input.userId,
      restoredFromVersion: source.version,
    });
    await flowAudit(tx, input.tenantId, {
      actorType: "user",
      actorId: input.userId,
      action: "flow.version_restored",
      flowId: row.id,
      meta: { fromVersion: source.version, newVersion: version.version },
    });
    return { kind: "restored" as const, flow: row, version };
  });
}
