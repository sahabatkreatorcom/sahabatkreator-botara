/**
 * Konversi dua arah antara graf kontrak dan kanvas React Flow.
 *
 * Ini SATU-SATUNYA tempat pemetaan itu tinggal: yang disimpan ke server
 * selalu `FlowGraph` kontrak persis, termasuk `position` per node. Semua
 * fungsi di sini murni — tidak menyentuh state maupun jaringan — sehingga
 * dapat diuji tanpa merender apa pun.
 */
import { type FlowEdgeBranch, type FlowGraph, type FlowNodeType } from "@sahabat-kreator/contracts";
import { type TranslationKey } from "@sahabat-kreator/i18n";
import { branchLabelKey } from "../../flows/graphModel";
import { type FlowRfEdge, type FlowRfNode, type Translate } from "./types";

export const NODE_ICON_PATHS: Record<FlowNodeType, string> = {
  trigger: "M13 2.5 4.5 14H11l-1 7.5L18.5 10H12l1-7.5z",
  send_message: "M21 3 10.5 13.5M21 3l-6.8 18-3.7-8.3L2.2 9 21 3z",
  condition: "M12 3.5 20 12l-8 8.5L4 12l8-8.5z",
  delay: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.2 2",
  add_tag: "M3.5 3.5H12L20.5 12 12 20.5 3.5 12V3.5zM7.5 7.5h.01",
  remove_tag: "M3.5 3.5H12L20.5 12 12 20.5 3.5 12V3.5zM7.5 7.5h.01M15.5 15.5h4",
  set_stage: "M5.5 21.5v-17M5.5 4.8h10.8l-2.2 3.6 2.2 3.6H5.5",
  enroll_sequence:
    "M8.5 6h12M8.5 12h12M8.5 18h12M3.8 6h.01M3.8 12h.01M3.8 18h.01",
  ai_response:
    "M12 3v2.5M5.5 11a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7zM9.3 13.5h.01M14.7 13.5h.01M9.5 16.8h5",
  handoff:
    "M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 19.5c.7-3.1 3.1-4.8 6-4.8s5.3 1.7 6 4.8",
  end: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.2 9.2h5.6v5.6H9.2z",
  set_field:
    "M4.5 19.5h4L19 9a2.12 2.12 0 0 0-3-3L5.5 16.5v3zM13.8 6.7l3 3M3.5 21h17",
  http_request:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.3 9.3h17.4M3.3 14.7h17.4M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z",
  goto_flow:
    "M9 5.2H5.5A1.5 1.5 0 0 0 4 6.7v10.6A1.5 1.5 0 0 0 5.5 18.8H9M14.5 8.2 18 11.7l-3.5 3.5M18 11.7H9.5",
  ab_split:
    "M6.5 3.5v5.2a4 4 0 0 0 4 4H17M17 12.7l-2.7-2.7M17 12.7 14.3 15.4M6.5 12.7a4 4 0 0 0 4 4H17",
  send_payment_link:
    "M10.5 13.5a4.24 4.24 0 0 0 6 0l3-3a4.24 4.24 0 1 0-6-6L11.8 6.2M13.5 10.5a4.24 4.24 0 0 0-6 0l-3 3a4.24 4.24 0 1 0 6 6l1.7-1.7",
  wait_reply:
    "M20.5 11.5a8.5 8.5 0 0 1-12.3 7.5L3.5 20.5l1.5-4.7A8.5 8.5 0 1 1 20.5 11.5zM12 7.8V12l2.8 1.8",
  questionnaire:
    "M9.5 6.5H20M9.5 12H20M9.5 17.5H20M3.8 6.5l1.1 1.1L6.8 5.4M3.8 12l1.1 1.1 1.9-2.2M3.8 17.5l1.1 1.1 1.9-2.2",
  show_catalog:
    "M4 5.5h16l-1.2 5H5.2L4 5.5zM5.2 10.5 6 18a1.5 1.5 0 0 0 1.5 1.2h9A1.5 1.5 0 0 0 18 18l.8-7.5M9 14.5h6",
  cart_checkout:
    "M3.5 4.5h2.4l2.3 11.2a1.8 1.8 0 0 0 1.8 1.4h7.6a1.8 1.8 0 0 0 1.8-1.4L20.8 8H6.2M10 20.8h.01M17.5 20.8h.01",
  book_appointment:
    "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-12zM4 10h16M8 3v4M16 3v4M8 14.5h3",
  create_deal:
    "M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5v-9zM3.5 10h17M7 15h4",
  move_deal_stage:
    "M3.5 5A1.5 1.5 0 0 1 5 3.5h1.5A1.5 1.5 0 0 1 8 5v14.5A1.5 1.5 0 0 1 6.5 21H5A1.5 1.5 0 0 1 3.5 19.5V5zM13.5 8.5 17 12l-3.5 3.5M17 12H9.5",
  send_ad_conversion:
    "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 16.8a4.8 4.8 0 1 0 0-9.6 4.8 4.8 0 0 0 0 9.6zM12 13.4a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z",
  append_sheet_row:
    "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13zM4 9.5h16M4 14.5h16M9.5 4v16M15 4v16",
  send_catalog:
    "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11zM8 9.5h8M8 13h5M17.2 16.8 19 18.6M18.4 14.6a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z",
  cart_summary:
    "M3.5 5h2l2.3 11.2a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6M9.8 20.5a.9.9 0 1 0 0 .01M17 20.5a.9.9 0 1 0 0 .01",
};

/** Warna label chip cabang: positif hijau, timeout kuning (bila ada cabang ketiga), selainnya merah. */
export function branchColorClass(branch: string, count: number): string {
  if (branch === "slot_taken") return "text-warning";
  if (branch === "timeout") return count > 2 ? "text-warning" : "text-danger";
  if (branch === "empty_cart") return "text-muted";
  if (branch === "invalid" || branch === "no" || branch === "b") {
    return "text-danger";
  }
  return "text-success";
}

/** Node kustom kanvas: label tipe dwibahasa + ringkasan config satu baris. */

export function autoLayout(graph: FlowGraph): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const depth = new Map<string, number>();
  if (trigger) {
    depth.set(trigger.id, 0);
    const queue = [trigger.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const e of graph.edges.filter((x) => x.from === current)) {
        if (!depth.has(e.to)) {
          depth.set(e.to, (depth.get(current) ?? 0) + 1);
          queue.push(e.to);
        }
      }
    }
  }
  const perDepth = new Map<number, number>();
  for (const node of graph.nodes) {
    const d = depth.get(node.id) ?? (graph.nodes.indexOf(node) + 1);
    const row = perDepth.get(d) ?? 0;
    perDepth.set(d, row + 1);
    result.set(node.id, { x: d * 290, y: row * 180 });
  }
  return result;
}

export function graphToRf(graph: FlowGraph): { nodes: FlowRfNode[]; edges: FlowRfEdge[] } {
  const layout = autoLayout(graph);
  const nodes: FlowRfNode[] = graph.nodes.map((node) => ({
    id: node.id,
    type: "flowNode",
    position: node.position ?? layout.get(node.id) ?? { x: 0, y: 0 },
    data: {
      nodeType: node.type,
      config: node.config ?? {},
      issueSeverity: null,
    },
    draggable: true,
    deletable: node.type !== "trigger",
  }));
  const edges: FlowRfEdge[] = graph.edges.map((edge, i) => ({
    id: `e-${edge.from}-${edge.branch ?? "next"}-${edge.to}-${i}`,
    source: edge.from,
    target: edge.to,
    ...(edge.branch ? { sourceHandle: edge.branch } : {}),
    data: edge.branch ? { branch: edge.branch } : {},
  }));
  return { nodes, edges };
}

/** Props label chip untuk edge bercabang (muat awal & koneksi baru). */
export function branchEdgeLabelProps(t: Translate, branch: FlowEdgeBranch) {
  const key = branchLabelKey(branch);
  return {
    label: key ? t(key) : branch,
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 6,
    labelBgStyle: { fill: "rgb(var(--color-surface))" },
    labelStyle: {
      fill: "rgb(var(--color-text-muted))",
      fontSize: 11,
      fontWeight: 600,
    },
  };
}

export function rfToGraph(nodes: FlowRfNode[], edges: FlowRfEdge[]): FlowGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.nodeType,
      config: node.data.config,
      position: {
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
      },
    })),
    edges: edges.map((edge) => ({
      from: edge.source,
      to: edge.target,
      ...(edge.data?.branch ? { branch: edge.data.branch } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------

/**
 * Label opsi sumber variabel "custom:*" pada node condition/field.
 *
 * BUKAN teks UI: yang ditampilkan adalah sintaks yang harus diketik
 * pengguna ("custom:<kunci>"). Menerjemahkannya justru menyesatkan,
 * jadi ia sengaja tidak lewat t() — tetapi tetap diberi nama supaya
 * alasannya terbaca, bukan sekadar literal di tengah JSX.
 */
export const CUSTOM_FIELD_OPTION_LABEL = "custom:*";

export const KNOWN_STAGES = ["new", "contacted", "qualified", "customer", "lost"];

export function stageLabel(t: Translate, stage: string): string {
  return KNOWN_STAGES.includes(stage)
    ? t(`contacts.stages.${stage}` as TranslationKey)
    : stage;
}
