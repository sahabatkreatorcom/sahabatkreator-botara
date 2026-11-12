/**
 * Versioning flow (G3 — Tier 1 butir 3 program adopsi; pola snapshot
 * diadopsi dari riset zernflow 00010_flow_versions).
 *
 * Berkas ini memuat helper DATA murni (tanpa audit, tanpa keputusan
 * API) yang dipakai bersama crud / evaluate / execute:
 * - `snapshotFlowVersion` — menulis satu baris `flow_versions` yang
 *   tidak bisa diubah di dalam transaksi aktivasi/pemulihan
 *   pemanggil. Nomor urut per flow; sejarah append-only, tidak
 *   pernah ditulis ulang (pemulihan melahirkan versi BARU lewat
 *   crud.restoreFlowVersion).
 * - `latestFlowVersion` — versi terbaru sebuah flow (untuk pin run
 *   baru + pemeriksaan draft bersih).
 * - `resolveRunGraph` — SATU-SATUNYA pintu baca graf eksekusi sejak
 *   G3: run ter-pin membaca graf dari SNAPSHOT versinya, bukan graf
 *   live, agar suntingan flow tidak mengubah run yang sedang
 *   berjalan/terparkir. Run warisan (pin NULL — lahir sebelum G3,
 *   atau dari flow aktif warisan yang belum pernah diaktifkan ulang)
 *   jatuh kembali ke graf live SECARA JUJUR (`pinned: false`): tidak
 *   ada snapshot retroaktif yang dikarang untuk mereka.
 */
import { and, desc, eq, max } from "drizzle-orm";
import {
  flowVersions,
  flows,
  type Database,
  type Flow,
  type FlowRun,
  type FlowVersion,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "../tx";

import { normalizeFlowGraph, type FlowGraphData } from "./graph";

/** Salinan dalam graf (snapshot tidak boleh berbagi referensi objek). */
export function copyFlowGraph(graph: FlowGraphData): FlowGraphData {
  return JSON.parse(JSON.stringify(graph)) as FlowGraphData;
}

/**
 * Kesetaraan graf (pemeriksaan draft bersih saat pemulihan): kedua
 * graf dinormalisasi lalu dibandingkan sebagai JSON. Bentuk hasil
 * normalizeFlowGraph deterministik (urutan kunci konstruksi tetap),
 * jadi perbedaan string = perbedaan isi.
 */
export function flowGraphsEqual(a: FlowGraphData, b: FlowGraphData): boolean {
  return (
    JSON.stringify(normalizeFlowGraph(a)) ===
    JSON.stringify(normalizeFlowGraph(b))
  );
}

/**
 * Menulis snapshot versi berikutnya untuk flow ini DI DALAM transaksi
 * pemanggil. Pemanggil bertanggung jawab atas transisi statusnya;
 * fungsi ini hanya mengunci penomoran: nomor = max+1, dan index unik
 * (flow_id, version) adalah penjaga terakhir dari balapan.
 */
export async function snapshotFlowVersion(
  tx: DbTx,
  tenantId: string,
  input: {
    flow: Flow;
    graph: FlowGraphData;
    userId: string | null;
    restoredFromVersion?: number | null;
  },
): Promise<FlowVersion> {
  const [agg] = await tx
    .select({ maxVersion: max(flowVersions.version) })
    .from(flowVersions)
    .where(
      and(
        eq(flowVersions.tenantId, tenantId),
        eq(flowVersions.flowId, input.flow.id),
      ),
    );
  const next = (agg?.maxVersion ?? 0) + 1;
  const [row] = await tx
    .insert(flowVersions)
    .values({
      tenantId,
      flowId: input.flow.id,
      version: next,
      name: input.flow.name,
      graph: copyFlowGraph(normalizeFlowGraph(input.graph)),
      restoredFromVersion: input.restoredFromVersion ?? null,
      activatedByUserId: input.userId,
    })
    .returning();
  return row;
}

/** Versi terbaru flow (nomor terbesar) di tenant ini; null bila belum ada. */
export async function latestFlowVersion(
  tx: DbTx,
  tenantId: string,
  flowId: string,
): Promise<FlowVersion | null> {
  const [row] = await tx
    .select()
    .from(flowVersions)
    .where(
      and(eq(flowVersions.tenantId, tenantId), eq(flowVersions.flowId, flowId)),
    )
    .orderBy(desc(flowVersions.version))
    .limit(1);
  return row ?? null;
}

/**
 * Satu baris versi menurut nomornya (baca-saja, ber-scope tenant);
 * null bila flow/versi tidak ada di tenant ini. Dipakai simulator
 * (G4) untuk mensimulasikan graf snapshot tanpa menjalankan apa pun.
 */
export async function getFlowVersion(
  db: Database,
  input: { tenantId: string; flowId: string; version: number },
): Promise<FlowVersion | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
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
    return row ?? null;
  });
}

export interface ResolvedRunGraph {
  graph: FlowGraphData;
  /** True bila graf berasal dari snapshot ter-pin run. */
  pinned: boolean;
  /** Nomor versi ter-pin; null untuk fallback graf live (run warisan). */
  version: number | null;
}

/**
 * Resolusi graf untuk SATU run (dipakai eksekutor worker lewat
 * loadRunContext + mesin parkir jalur evaluasi):
 * - run ter-pin (flow_version_id terisi) → graf SNAPSHOT baris versi
 *   itu. Baris versi hilang → fallback jujur ke graf live (tidak
 *   seharusnya terjadi: versi append-only; hanya cascade hapus flow
 *   yang menghilangkannya, dan itu menghapus run juga).
 * - run tanpa pin (warisan) → graf live flow, `pinned: false`.
 * Flow yang hilang → null (run yatim; pemanggil memperlakukannya
 * seperti run tak ditemukan).
 */
export async function resolveRunGraph(
  tx: DbTx,
  tenantId: string,
  run: FlowRun,
): Promise<ResolvedRunGraph | null> {
  const [flow] = await tx
    .select()
    .from(flows)
    .where(and(eq(flows.tenantId, tenantId), eq(flows.id, run.flowId)))
    .limit(1);
  if (!flow) return null;
  if (run.flowVersionId) {
    const [version] = await tx
      .select()
      .from(flowVersions)
      .where(
        and(
          eq(flowVersions.tenantId, tenantId),
          eq(flowVersions.id, run.flowVersionId),
        ),
      )
      .limit(1);
    if (version) {
      return {
        graph: normalizeFlowGraph(version.graph),
        pinned: true,
        version: version.version,
      };
    }
  }
  return {
    graph: normalizeFlowGraph(flow.graph),
    pinned: false,
    version: null,
  };
}
