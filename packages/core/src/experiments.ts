import { and, eq, inArray, sql } from "drizzle-orm";
import {
  broadcastRecipients,
  broadcasts,
  flowExperimentAssignments,
  flowRunSteps,
  flowRuns,
  flows,
  type Database,
} from "@sahabat-kreator/db";
import { withTenantDb } from "./tx";

/**
 * Lapisan eksperimen A/B (Fase 13D) — penugasan varian DETERMINISTIK
 * + statistik hasil yang JUJUR.
 *
 * PENUGASAN: hash FNV-1a 32-bit atas kunci lengket (flow+node+kontak
 * untuk flow; broadcast+kontak untuk broadcast) dimodulo 10.000
 * menjadi bucket 0..9999; bucket dibandingkan terhadap persen
 * terkonfigurasi × 100. Fungsi murni — hasil yang sama untuk input
 * yang sama, selamanya, tanpa keadaan tersimpan. Untuk flow, hasil
 * pertama juga DIPERSISTENKAN (flow_experiment_assignments, unik per
 * flow+node+kontak): snapshot itu yang menang bila operator mengubah
 * persen di tengah eksperimen.
 *
 * KEJUJURAN STATISTIK (semangat aturan biaya 9B — jangan pernah
 * mengarang angka): laporan hanya menampilkan hitungan + tingkat;
 * petunjuk pemenang mensyaratkan (1) uji dua-proporsi z-test pooled
 * dua sisi yang BENAR-BENAR dihitung di sini (bukan placeholder), dan
 * (2) pagar sampel minimum EXPERIMENT_MIN_RUNS_PER_VARIANT run per
 * varian. Di bawah pagar itu putusannya "not_enough_data" dan nilai
 * z/p tidak dihitung sama sekali (null), agar UI tidak bisa
 * menampilkan signifikansi yang belum ada.
 */

/** Sampel minimum (run per varian) sebelum putusan statistik dihitung. */
export const EXPERIMENT_MIN_RUNS_PER_VARIANT = 30;

/** Ambang signifikansi putusan pemenang (dua sisi). */
export const EXPERIMENT_SIGNIFICANCE_LEVEL = 0.05;

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Bucket deterministik 0..9999 untuk kunci penugasan apa pun. */
export function experimentBucket(key: string): number {
  return fnv1a32(key) % 10_000;
}

/** Kunci lengket penugasan flow: satu kontak = satu bucket per split. */
export function flowExperimentKey(
  flowId: string,
  nodeId: string,
  contactId: string,
): string {
  return `flow-ab:${flowId}:${nodeId}:${contactId}`;
}

/** Kunci lengket penugasan broadcast: satu kontak = satu bucket per broadcast. */
export function broadcastExperimentKey(
  broadcastId: string,
  contactId: string,
): string {
  return `broadcast-ab:${broadcastId}:${contactId}`;
}

/** Cabang flow dari bucket: bucket < percentA×100 → "a", selain itu "b". */
export function flowBranchForBucket(
  bucket: number,
  percentA: number,
): "a" | "b" {
  return bucket < percentA * 100 ? "a" : "b";
}

/** Varian broadcast dari bucket: bucket < percentB×100 → "b", selain itu "a". */
export function broadcastVariantForBucket(
  bucket: number,
  percentB: number,
): "a" | "b" {
  return bucket < percentB * 100 ? "b" : "a";
}

// ---------------------------------------------------------------------------
// Uji dua-proporsi (z-test pooled, dua sisi)
// ---------------------------------------------------------------------------

/** erf(x) — aproksimasi Abramowitz & Stegun 7.1.26 (|ε| ≤ 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** CDF normal standar Φ(z). */
function standardNormalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export interface TwoProportionZTestResult {
  z: number;
  /** Nilai p dua sisi. */
  pValue: number;
}

/**
 * Uji dua-proporsi klasik: H0 p1 = p2, varians pooled di bawah H0.
 * Kasus degenerat (kedua proporsi sama-sama 0 atau sama-sama 1 →
 * SE = 0) menghasilkan z = 0, p = 1: tidak ada perbedaan yang bisa
 * diklaim. Prasyarat pemanggil: n1, n2 > 0.
 */
export function twoProportionZTest(
  successes1: number,
  n1: number,
  successes2: number,
  n2: number,
): TwoProportionZTestResult {
  const p1 = successes1 / n1;
  const p2 = successes2 / n2;
  const pooled = (successes1 + successes2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0 || p1 === p2) return { z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { z, pValue: Math.min(1, Math.max(0, pValue)) };
}

// ---------------------------------------------------------------------------
// Hasil eksperimen flow
// ---------------------------------------------------------------------------

export interface FlowExperimentVariantStats {
  branch: "a" | "b";
  assignedContacts: number;
  runs: number;
  completedRuns: number;
  conversions: number;
  conversionRate: number | null;
}

export interface FlowExperimentVerdict {
  status: "not_enough_data" | "no_significant_difference" | "winner";
  winnerBranch: "a" | "b" | null;
  z: number | null;
  pValue: number | null;
  minSamplePerVariant: number;
}

export interface FlowExperimentResult {
  nodeId: string;
  label: string | null;
  percentA: number;
  conversionNodeId: string | null;
  variants: FlowExperimentVariantStats[];
  verdict: FlowExperimentVerdict;
}

export interface FlowExperimentsResult {
  flowId: string;
  experiments: FlowExperimentResult[];
}

interface ExperimentSplitConfig {
  nodeId: string;
  percentA: number;
  label: string | null;
  conversionNodeId: string | null;
}

/** Node ab_split mode eksperimen dari graf tersimpan (parse defensif). */
function experimentSplitsOf(graph: unknown): ExperimentSplitConfig[] {
  const nodes =
    typeof graph === "object" && graph !== null
      ? (graph as { nodes?: unknown }).nodes
      : undefined;
  if (!Array.isArray(nodes)) return [];
  const splits: ExperimentSplitConfig[] = [];
  for (const raw of nodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const node = raw as {
      id?: unknown;
      type?: unknown;
      config?: Record<string, unknown>;
    };
    if (node.type !== "ab_split" || typeof node.id !== "string") continue;
    const c = node.config ?? {};
    if (c.experiment !== true) continue;
    const percentA =
      typeof c.percentA === "number" && Number.isInteger(c.percentA)
        ? Math.min(99, Math.max(1, c.percentA))
        : 50;
    splits.push({
      nodeId: node.id,
      percentA,
      label:
        typeof c.experimentLabel === "string" && c.experimentLabel
          ? c.experimentLabel
          : null,
      conversionNodeId:
        typeof c.conversionNodeId === "string" && c.conversionNodeId
          ? c.conversionNodeId
          : null,
    });
  }
  return splits;
}

function verdictFor(
  a: FlowExperimentVariantStats,
  b: FlowExperimentVariantStats,
  hasConversionPoint: boolean,
): FlowExperimentVerdict {
  const base: FlowExperimentVerdict = {
    status: "not_enough_data",
    winnerBranch: null,
    z: null,
    pValue: null,
    minSamplePerVariant: EXPERIMENT_MIN_RUNS_PER_VARIANT,
  };
  if (!hasConversionPoint) return base;
  if (
    a.runs < EXPERIMENT_MIN_RUNS_PER_VARIANT ||
    b.runs < EXPERIMENT_MIN_RUNS_PER_VARIANT
  ) {
    return base;
  }
  const { z, pValue } = twoProportionZTest(
    a.conversions,
    a.runs,
    b.conversions,
    b.runs,
  );
  if (pValue >= EXPERIMENT_SIGNIFICANCE_LEVEL) {
    return { ...base, status: "no_significant_difference", z, pValue };
  }
  const winnerBranch =
    (a.conversionRate ?? 0) >= (b.conversionRate ?? 0) ? "a" : "b";
  return { ...base, status: "winner", winnerBranch, z, pValue };
}

/**
 * Hasil semua eksperimen pada satu flow (null bila flow tidak ada di
 * tenant ini). Sumber angka:
 * - assignedContacts: baris flow_experiment_assignments per branch.
 * - runs/completedRuns: run yang langkah split PERTAMANYA (seq
 *   terkecil) adalah langkah eksperimen branch itu — satu run satu
 *   varian, konsisten dengan kelengketan per kontak.
 * - conversions: run di atas yang punya langkah SUKSES (error null)
 *   pada node konversi dengan seq LEBIH BESAR dari langkah split-nya
 *   — "melewati titik konversi sesudah dipecah". Langkah konversi
 *   sebelum split (graf melingkar) TIDAK dihitung.
 */
export async function getFlowExperimentResults(
  db: Database,
  input: { tenantId: string; flowId: string },
): Promise<FlowExperimentsResult | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [flow] = await tx
      .select({ id: flows.id, graph: flows.graph })
      .from(flows)
      .where(
        and(eq(flows.tenantId, input.tenantId), eq(flows.id, input.flowId)),
      )
      .limit(1);
    if (!flow) return null;
    const splits = experimentSplitsOf(flow.graph);
    const experiments: FlowExperimentResult[] = [];
    for (const split of splits) {
      const assignmentRows = await tx
        .select({
          branch: flowExperimentAssignments.branch,
          n: sql<string>`count(*)`,
        })
        .from(flowExperimentAssignments)
        .where(
          and(
            eq(flowExperimentAssignments.tenantId, input.tenantId),
            eq(flowExperimentAssignments.flowId, input.flowId),
            eq(flowExperimentAssignments.nodeId, split.nodeId),
          ),
        )
        .groupBy(flowExperimentAssignments.branch);
      const assigned = new Map<string, number>([
        ["a", 0],
        ["b", 0],
      ]);
      for (const row of assignmentRows) {
        if (row.branch === "a" || row.branch === "b") {
          assigned.set(row.branch, Number(row.n));
        }
      }

      // Langkah split eksperimen untuk flow ini (branch dari detail).
      const splitSteps = await tx
        .select({
          runId: flowRunSteps.runId,
          seq: flowRunSteps.seq,
          detail: flowRunSteps.detail,
        })
        .from(flowRunSteps)
        .innerJoin(flowRuns, eq(flowRunSteps.runId, flowRuns.id))
        .where(
          and(
            eq(flowRunSteps.tenantId, input.tenantId),
            eq(flowRuns.flowId, input.flowId),
            eq(flowRunSteps.nodeId, split.nodeId),
            eq(flowRunSteps.nodeType, "ab_split"),
          ),
        )
        .orderBy(flowRunSteps.runId, flowRunSteps.seq);
      /** runId → { branch, seq } dari langkah split pertamanya. */
      const runBranch = new Map<
        string,
        { branch: "a" | "b"; seq: number }
      >();
      for (const step of splitSteps) {
        if (runBranch.has(step.runId)) continue;
        const detail = (step.detail ?? {}) as Record<string, unknown>;
        if (detail.experiment !== true) continue;
        if (detail.branch !== "a" && detail.branch !== "b") continue;
        runBranch.set(step.runId, { branch: detail.branch, seq: step.seq });
      }

      const runIds = [...runBranch.keys()];
      const statusByRun = new Map<string, string>();
      if (runIds.length > 0) {
        const runRows = await tx
          .select({ id: flowRuns.id, status: flowRuns.status })
          .from(flowRuns)
          .where(
            and(
              eq(flowRuns.tenantId, input.tenantId),
              eq(flowRuns.flowId, input.flowId),
              inArray(flowRuns.id, runIds),
            ),
          );
        for (const row of runRows) statusByRun.set(row.id, row.status);
      }

      const convertedRuns = new Set<string>();
      if (split.conversionNodeId && runIds.length > 0) {
        const convSteps = await tx
          .select({
            runId: flowRunSteps.runId,
            seq: flowRunSteps.seq,
          })
          .from(flowRunSteps)
          .where(
            and(
              eq(flowRunSteps.tenantId, input.tenantId),
              eq(flowRunSteps.nodeId, split.conversionNodeId),
              sql`${flowRunSteps.error} IS NULL`,
              inArray(flowRunSteps.runId, runIds),
            ),
          );
        for (const step of convSteps) {
          const splitStep = runBranch.get(step.runId);
          if (splitStep && step.seq > splitStep.seq) {
            convertedRuns.add(step.runId);
          }
        }
      }

      const empty = (branch: "a" | "b"): FlowExperimentVariantStats => ({
        branch,
        assignedContacts: assigned.get(branch) ?? 0,
        runs: 0,
        completedRuns: 0,
        conversions: 0,
        conversionRate: null,
      });
      const variants: FlowExperimentVariantStats[] = [empty("a"), empty("b")];
      for (const [runId, info] of runBranch) {
        const v = variants[info.branch === "a" ? 0 : 1];
        v.runs += 1;
        if (statusByRun.get(runId) === "completed") v.completedRuns += 1;
        if (convertedRuns.has(runId)) v.conversions += 1;
      }
      for (const v of variants) {
        v.conversionRate =
          split.conversionNodeId && v.runs > 0
            ? v.conversions / v.runs
            : null;
      }
      experiments.push({
        nodeId: split.nodeId,
        label: split.label,
        percentA: split.percentA,
        conversionNodeId: split.conversionNodeId,
        variants,
        verdict: verdictFor(variants[0], variants[1], !!split.conversionNodeId),
      });
    }
    return { flowId: flow.id, experiments };
  });
}

// ---------------------------------------------------------------------------
// Hasil A/B broadcast
// ---------------------------------------------------------------------------

export interface BroadcastVariantSkipReasons {
  opted_out: number;
  not_opted_in: number;
  outside_24h_window: number;
  template_variable_missing: number;
  missing_phone_number: number;
  message_deleted: number;
  template_component_unsupported: number;
}

export interface BroadcastVariantStats {
  variant: "a" | "b";
  assigned: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  cancelled: number;
  skippedByReason: BroadcastVariantSkipReasons;
}

export interface BroadcastAbResults {
  broadcastId: string;
  abTest: {
    splitPercentB: number;
    variantBMessageText: string | null;
    variantBWhatsappTemplateId: string | null;
    variantBTemplateVariableSources: string[];
  } | null;
  variants: BroadcastVariantStats[];
}

const emptySkipReasons = (): BroadcastVariantSkipReasons => ({
  opted_out: 0,
  not_opted_in: 0,
  outside_24h_window: 0,
  template_variable_missing: 0,
  missing_phone_number: 0,
  message_deleted: 0,
  template_component_unsupported: 0,
});

const emptyVariantStats = (variant: "a" | "b"): BroadcastVariantStats => ({
  variant,
  assigned: 0,
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
  skippedByReason: emptySkipReasons(),
});

/**
 * Rincian per varian satu broadcast (null bila broadcast tidak ada di
 * tenant ini). Dihitung dari broadcast_recipients — sumber kebenaran
 * yang sama seperti statistik broadcast keseluruhan (13C).
 *
 * ATRIBUSI BALASAN SENGAJA TIDAK TERMASUK: tidak ada tautan tersimpan
 * dari pesan masuk ke (broadcast, varian) — percakapan 1:1 dipakai
 * bersama broadcast lain, flow, dan agent, jadi menghitung "balasan
 * sesudah pesan broadcast" akan mengarang atribusi. Angka yang
 * ditampilkan hanya yang bisa diturunkan persis dari baris penerima.
 */
export async function getBroadcastAbResults(
  db: Database,
  input: { tenantId: string; broadcastId: string },
): Promise<BroadcastAbResults | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [broadcast] = await tx
      .select({
        id: broadcasts.id,
        abSplitPercentB: broadcasts.abSplitPercentB,
        variantBMessageText: broadcasts.variantBMessageText,
        variantBWhatsappTemplateId: broadcasts.variantBWhatsappTemplateId,
        variantBTemplateVariableSources:
          broadcasts.variantBTemplateVariableSources,
      })
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.tenantId, input.tenantId),
          eq(broadcasts.id, input.broadcastId),
        ),
      )
      .limit(1);
    if (!broadcast) return null;

    const statusRows = await tx
      .select({
        variant: broadcastRecipients.variant,
        status: broadcastRecipients.status,
        n: sql<string>`count(*)`,
      })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.tenantId, input.tenantId),
          eq(broadcastRecipients.broadcastId, input.broadcastId),
        ),
      )
      .groupBy(broadcastRecipients.variant, broadcastRecipients.status);
    const reasonRows = await tx
      .select({
        variant: broadcastRecipients.variant,
        skipReason: broadcastRecipients.skipReason,
        n: sql<string>`count(*)`,
      })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.tenantId, input.tenantId),
          eq(broadcastRecipients.broadcastId, input.broadcastId),
          eq(broadcastRecipients.status, "skipped"),
        ),
      )
      .groupBy(broadcastRecipients.variant, broadcastRecipients.skipReason);

    const byVariant = new Map<string, BroadcastVariantStats>([
      ["a", emptyVariantStats("a")],
      ["b", emptyVariantStats("b")],
    ]);
    for (const row of statusRows) {
      const stats = byVariant.get(row.variant);
      if (!stats) continue;
      const n = Number(row.n);
      stats.assigned += n;
      if (
        row.status === "queued" ||
        row.status === "sent" ||
        row.status === "delivered" ||
        row.status === "read" ||
        row.status === "failed" ||
        row.status === "skipped" ||
        row.status === "cancelled"
      ) {
        stats[row.status] += n;
      }
    }
    for (const row of reasonRows) {
      const stats = byVariant.get(row.variant);
      if (!stats || !row.skipReason) continue;
      if (row.skipReason in stats.skippedByReason) {
        stats.skippedByReason[
          row.skipReason as keyof BroadcastVariantSkipReasons
        ] += Number(row.n);
      }
    }

    const abTest =
      broadcast.abSplitPercentB !== null &&
      broadcast.abSplitPercentB !== undefined
        ? {
            splitPercentB: broadcast.abSplitPercentB,
            variantBMessageText: broadcast.variantBMessageText,
            variantBWhatsappTemplateId: broadcast.variantBWhatsappTemplateId,
            variantBTemplateVariableSources:
              (broadcast.variantBTemplateVariableSources as string[] | null) ??
              [],
          }
        : null;
    return {
      broadcastId: broadcast.id,
      abTest,
      variants: abTest
        ? [byVariant.get("a")!, byVariant.get("b")!]
        : [byVariant.get("a")!],
    };
  });
}
