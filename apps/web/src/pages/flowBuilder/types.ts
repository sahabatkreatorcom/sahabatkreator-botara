/**
 * Tipe dan konteks bersama kanvas flow.
 *
 * Dipisah dari halaman karena dipakai oleh hampir semua bagian: kartu
 * node, panel konfigurasi, dan panel run. Menaruhnya di modul sendiri
 * membuat ketergantungan antar bagian terbaca sebagai impor, bukan
 * sebagai "kebetulan ada di file yang sama".
 */
import { type FlowEdgeBranch, type FlowNodeType } from "@sahabat-kreator/contracts";
import { type TranslationKey } from "@sahabat-kreator/i18n";
import { type Edge, type Node } from "@xyflow/react";
import { createContext, useContext } from "react";

export type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

// ---------------------------------------------------------------------------
// Model kanvas: node/edge React Flow adalah representasi kerja dari graf
// kontrak. Konversi dua arah di sini adalah SATU-SATUNYA tempat pemetaan
// itu tinggal — yang disimpan ke server selalu FlowGraph kontrak persis
// (termasuk `position` per node).
// ---------------------------------------------------------------------------

export interface FlowNodeData extends Record<string, unknown> {
  nodeType: FlowNodeType;
  config: Record<string, unknown>;
  issueSeverity: "error" | "warning" | null;
}

export type FlowRfNode = Node<FlowNodeData, "flowNode">;
export type FlowRfEdge = Edge<{ branch?: FlowEdgeBranch }>;

export interface BuilderShared {
  t: Translate;
  readOnly: boolean;
  sequenceName: (automationId: string) => string | undefined;
  flowName: (flowId: string) => string | undefined;
  productName: (productId: string) => string | undefined;
  /** Fase 13G: nama layanan janji temu untuk ringkasan book_appointment. */
  serviceName: (serviceId: string) => string | undefined;
  /** G12: nama tahap deal untuk ringkasan create_deal/move_deal_stage. */
  dealStageName: (stageId: string) => string | undefined;
}

export const BuilderCtx = createContext<BuilderShared | null>(null);

export function useBuilderShared(): BuilderShared {
  const ctx = useContext(BuilderCtx);
  if (!ctx) throw new Error("FlowNodeCard di luar BuilderCtx");
  return ctx;
}
