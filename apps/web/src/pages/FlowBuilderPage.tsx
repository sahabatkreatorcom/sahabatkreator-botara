import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  AppointmentServiceResponse,
  AutomationResponse,
  FlowEdgeBranch,
  FlowGraph,
  FlowGraphIssue,
  FlowExperimentsResponse,
  FlowNodeType,
  FlowResponse,
  FlowRunResponse,
  FlowRunStepResponse,
  ProductResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api, ApiClientError } from "../api/client";
import { translateApiError } from "../api/errorText";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { usePolling } from "../hooks/usePolling";
import {
  ADDABLE_NODE_TYPES,
  FLOW_BRANCHED_TYPES,
  FLOW_NODE_LABEL_KEYS,
  branchLabelKey,
  defaultNodeConfig,
  issuesFromError,
  splitIssues,
  summarizeNodeConfig,
  translateFlowIssue,
} from "../flows/graphModel";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

// ---------------------------------------------------------------------------
// Model kanvas: node/edge React Flow adalah representasi kerja dari graf
// kontrak. Konversi dua arah di sini adalah SATU-SATUNYA tempat pemetaan
// itu tinggal — yang disimpan ke server selalu FlowGraph kontrak persis
// (termasuk `position` per node).
// ---------------------------------------------------------------------------

interface FlowNodeData extends Record<string, unknown> {
  nodeType: FlowNodeType;
  config: Record<string, unknown>;
  issueSeverity: "error" | "warning" | null;
}

type FlowRfNode = Node<FlowNodeData, "flowNode">;
type FlowRfEdge = Edge<{ branch?: FlowEdgeBranch }>;

interface BuilderShared {
  t: Translate;
  readOnly: boolean;
  sequenceName: (automationId: string) => string | undefined;
  flowName: (flowId: string) => string | undefined;
  productName: (productId: string) => string | undefined;
  /** Fase 13G: nama layanan janji temu untuk ringkasan book_appointment. */
  serviceName: (serviceId: string) => string | undefined;
}

const BuilderCtx = createContext<BuilderShared | null>(null);

function useBuilderShared(): BuilderShared {
  const ctx = useContext(BuilderCtx);
  if (!ctx) throw new Error("FlowNodeCard di luar BuilderCtx");
  return ctx;
}

const NODE_ICON_PATHS: Record<FlowNodeType, string> = {
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
};

/** Warna label chip cabang: positif hijau, timeout kuning (bila ada cabang ketiga), selainnya merah. */
function branchColorClass(branch: string, count: number): string {
  if (branch === "slot_taken") return "text-warning";
  if (branch === "timeout") return count > 2 ? "text-warning" : "text-danger";
  if (branch === "empty_cart") return "text-muted";
  if (branch === "invalid" || branch === "no" || branch === "b") {
    return "text-danger";
  }
  return "text-success";
}

/** Node kustom kanvas: label tipe dwibahasa + ringkasan config satu baris. */
function FlowNodeCard({ data, selected }: NodeProps<FlowRfNode>) {
  const { t, sequenceName, flowName, productName, serviceName } =
    useBuilderShared();
  const type = data.nodeType;
  const summary = summarizeNodeConfig(
    t,
    { type, config: data.config },
    sequenceName,
    { flowName, productName, serviceName },
  );
  const branches = FLOW_BRANCHED_TYPES[type];
  const borderClass =
    data.issueSeverity === "error"
      ? "border-danger"
      : data.issueSeverity === "warning"
        ? "border-warning"
        : selected
          ? "border-accent"
          : "border-line";
  return (
    <div
      className={`w-[228px] rounded-xl border-2 bg-surface shadow-sm ${borderClass}`}
    >
      {type !== "trigger" ? (
        <Handle type="target" position={Position.Top} />
      ) : null}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            type === "trigger"
              ? "bg-accent text-white"
              : type === "condition"
                ? "bg-warning/15 text-warning"
                : branches
                  ? "bg-accent/15 text-accent"
                  : "bg-elevated text-muted"
          }`}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden={true}
          >
            <path d={NODE_ICON_PATHS[type]} />
          </svg>
        </span>
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-ink">
          {t(FLOW_NODE_LABEL_KEYS[type])}
        </span>
      </div>
      {summary ? (
        <p className="px-3 pb-2.5 pt-1 text-xs leading-snug text-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
          {summary}
        </p>
      ) : (
        <div className="pb-2.5" />
      )}
      {branches ? (
        <>
          <div
            className={`flex items-center justify-between pb-1 text-[10px] font-semibold ${
              branches.length > 2 ? "px-2" : "px-8"
            }`}
          >
            {branches.map((b) => (
              <span
                key={b.branch}
                className={branchColorClass(b.branch, branches.length)}
              >
                {t(b.labelKey)}
              </span>
            ))}
          </div>
          {branches.map((b, i) => (
            <Handle
              key={b.branch}
              id={b.branch}
              type="source"
              position={Position.Bottom}
              style={{
                left: `${(((i + 0.5) / branches.length) * 100).toFixed(1)}%`,
              }}
            />
          ))}
        </>
      ) : type !== "end" ? (
        <Handle type="source" position={Position.Bottom} />
      ) : null}
    </div>
  );
}

const NODE_TYPES = { flowNode: FlowNodeCard };

/**
 * Layout awal deterministik untuk node TANPA position tersimpan
 * (flow 8A yang dibuat via API): kedalaman BFS dari trigger menjadi
 * kolom x, urutan dalam kedalaman menjadi baris y. Node ber-position
 * tidak diganggu.
 */
function autoLayout(graph: FlowGraph): Map<string, { x: number; y: number }> {
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

function graphToRf(graph: FlowGraph): { nodes: FlowRfNode[]; edges: FlowRfEdge[] } {
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
function branchEdgeLabelProps(t: Translate, branch: FlowEdgeBranch) {
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

function rfToGraph(nodes: FlowRfNode[], edges: FlowRfEdge[]): FlowGraph {
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
const CUSTOM_FIELD_OPTION_LABEL = "custom:*";

const KNOWN_STAGES = ["new", "contacted", "qualified", "customer", "lost"];

function stageLabel(t: Translate, stage: string): string {
  return KNOWN_STAGES.includes(stage)
    ? t(`contacts.stages.${stage}` as TranslationKey)
    : stage;
}

interface TenantMeta {
  tags: string[];
  stages: string[];
  sequences: AutomationResponse[];
  /** Flow AKTIF tenant (pemilih goto_flow); flow yang diedit ditambah terpisah. */
  flows: FlowResponse[];
  /** Flow yang sedang diedit (boleh jadi tujuan goto dirinya sendiri). */
  selfFlow: { id: string; name: string } | null;
  /** Produk aktif tenant (pemilih send_payment_link). */
  products: ProductResponse[];
  /** Layanan janji temu AKTIF tenant (pemilih book_appointment, Fase 13G). */
  appointmentServices: AppointmentServiceResponse[];
  /**
   * Kunci field custom yang dikenal tenant (dari custom_fields kontak
   * yang dimuat — pola yang sama seperti tags/stages di atas);
   * pemilih target questionnaire. Pemeriksaan otoritatifnya adalah
   * validasi aktivasi di server atas SELURUH kontak.
   */
  customFieldKeys: string[];
}

interface NodeConfigPanelProps {
  t: Translate;
  node: FlowRfNode;
  /** Semua node di kanvas — untuk pemilih titik konversi eksperimen. */
  allNodes: FlowRfNode[];
  meta: TenantMeta;
  readOnly: boolean;
  onChange: (nodeId: string, config: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
}

const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink disabled:opacity-60";
const labelClass = "block text-sm font-medium text-ink";

/** Panel konfigurasi per tipe node — bentuknya persis kontrak 8A. */
function NodeConfigPanel({
  t,
  node,
  allNodes,
  meta,
  readOnly,
  onChange,
  onDelete,
}: NodeConfigPanelProps) {
  const type = node.data.nodeType;
  const config = node.data.config;
  const set = (patch: Record<string, unknown>) =>
    onChange(node.id, { ...config, ...patch });
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const numVal = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const stageOptions = useMemo(() => {
    const set = new Set<string>([...KNOWN_STAGES, ...meta.stages]);
    return [...set];
  }, [meta.stages]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">
          {t(FLOW_NODE_LABEL_KEYS[type])}
        </h3>
        {type !== "trigger" && !readOnly ? (
          <button
            type="button"
            onClick={() => onDelete(node.id)}
            className="rounded-lg border border-danger px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10"
          >
            {t("flows.deleteNode")}
          </button>
        ) : null}
      </div>

      {type === "trigger" ? (
        <>
          <p className="text-xs text-muted">{t("flows.triggerLockedNote")}</p>
          <div>
            <span className={labelClass}>{t("flows.triggerKindLabel")}</span>
            <div className="mt-2 space-y-1.5">
              {(
                [
                  ["keyword", "flows.triggerKindKeyword"],
                  ["any_message", "flows.triggerKindAny"],
                ] as const
              ).map(([kind, key]) => (
                <label
                  key={kind}
                  className="flex items-center gap-2 text-sm text-ink"
                >
                  <input
                    type="radio"
                    name="trigger-kind"
                    disabled={readOnly}
                    checked={
                      (config.kind as string | undefined) === kind ||
                      (kind === "keyword" && config.kind === undefined)
                    }
                    onChange={() =>
                      set(
                        kind === "keyword"
                          ? {
                              kind: "keyword",
                              keywords: Array.isArray(config.keywords)
                                ? config.keywords
                                : [],
                              match:
                                config.match === "contains"
                                  ? "contains"
                                  : "exact",
                            }
                          : { kind: "any_message" },
                      )
                    }
                  />
                  {t(key)}
                </label>
              ))}
            </div>
          </div>
          {config.kind !== "any_message" ? (
            <>
              <div>
                <label className={labelClass} htmlFor="cfg-keywords">
                  {t("flows.triggerKeywordsLabel")}
                </label>
                <textarea
                  id="cfg-keywords"
                  className={inputClass}
                  rows={3}
                  disabled={readOnly}
                  value={
                    Array.isArray(config.keywords)
                      ? config.keywords
                          .filter((k): k is string => typeof k === "string")
                          .join("\n")
                      : ""
                  }
                  onChange={(e) =>
                    set({
                      keywords: e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <p className="mt-1 text-xs text-muted">
                  {t("flows.triggerKeywordsHint")}
                </p>
              </div>
              <div>
                <label className={labelClass} htmlFor="cfg-match">
                  {t("flows.triggerMatchLabel")}
                </label>
                <select
                  id="cfg-match"
                  className={inputClass}
                  disabled={readOnly}
                  value={config.match === "contains" ? "contains" : "exact"}
                  onChange={(e) => set({ match: e.target.value })}
                >
                  <option value="exact">{t("flows.matchExact")}</option>
                  <option value="contains">{t("flows.matchContains")}</option>
                </select>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {type === "send_message" ? (
        <div>
          <label className={labelClass} htmlFor="cfg-text">
            {t("flows.sendTextLabel")}
          </label>
          <textarea
            id="cfg-text"
            className={inputClass}
            rows={4}
            maxLength={4096}
            disabled={readOnly}
            value={str(config.text)}
            onChange={(e) => set({ text: e.target.value })}
          />
          <p className="mt-1 text-xs text-muted">{t("flows.sendTextHint")}</p>
        </div>
      ) : null}

      {type === "condition" ? (
        <>
          <div>
            <label className={labelClass} htmlFor="cfg-predicate">
              {t("flows.conditionPredicateLabel")}
            </label>
            <select
              id="cfg-predicate"
              className={inputClass}
              disabled={readOnly}
              value={str(config.predicate) || "has_tag"}
              onChange={(e) => {
                const predicate = e.target.value;
                if (predicate === "has_tag")
                  onChange(node.id, { predicate, tag: str(config.tag) });
                else if (predicate === "stage_equals")
                  onChange(node.id, {
                    predicate,
                    stage: str(config.stage) || stageOptions[0]!,
                  });
                else if (predicate === "field_equals")
                  onChange(node.id, {
                    predicate,
                    field: str(config.field) || "name",
                    value: str(config.value),
                  });
                else
                  onChange(node.id, {
                    predicate,
                    text: str(config.text),
                  });
              }}
            >
              <option value="has_tag">{t("flows.predicateHasTag")}</option>
              <option value="stage_equals">
                {t("flows.predicateStageEquals")}
              </option>
              <option value="field_equals">
                {t("flows.predicateFieldEquals")}
              </option>
              <option value="message_contains">
                {t("flows.predicateMessageContains")}
              </option>
            </select>
          </div>
          {config.predicate === "stage_equals" ? (
            <div>
              <label className={labelClass} htmlFor="cfg-cond-stage">
                {t("flows.conditionStageLabel")}
              </label>
              <select
                id="cfg-cond-stage"
                className={inputClass}
                disabled={readOnly}
                value={str(config.stage)}
                onChange={(e) => set({ stage: e.target.value })}
              >
                {stageOptions.map((s) => (
                  <option key={s} value={s}>
                    {stageLabel(t, s)}
                  </option>
                ))}
              </select>
            </div>
          ) : config.predicate === "field_equals" ? (
            <>
              <div>
                <label className={labelClass} htmlFor="cfg-cond-field">
                  {t("flows.conditionFieldLabel")}
                </label>
                <select
                  id="cfg-cond-field"
                  className={inputClass}
                  disabled={readOnly}
                  value={str(config.field) || "name"}
                  onChange={(e) => set({ field: e.target.value })}
                >
                  <option value="name">{t("flows.fieldName")}</option>
                  <option value="phone">{t("flows.fieldPhone")}</option>
                  <option value="email">{t("flows.fieldEmail")}</option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="cfg-cond-value">
                  {t("flows.conditionValueLabel")}
                </label>
                <input
                  id="cfg-cond-value"
                  className={inputClass}
                  disabled={readOnly}
                  value={str(config.value)}
                  onChange={(e) => set({ value: e.target.value })}
                />
              </div>
            </>
          ) : config.predicate === "message_contains" ? (
            <div>
              <label className={labelClass} htmlFor="cfg-cond-text">
                {t("flows.conditionTextLabel")}
              </label>
              <input
                id="cfg-cond-text"
                className={inputClass}
                disabled={readOnly}
                value={str(config.text)}
                onChange={(e) => set({ text: e.target.value })}
              />
            </div>
          ) : (
            <div>
              <label className={labelClass} htmlFor="cfg-cond-tag">
                {t("flows.conditionTagLabel")}
              </label>
              <input
                id="cfg-cond-tag"
                className={inputClass}
                disabled={readOnly}
                list="flow-tag-options"
                value={str(config.tag)}
                onChange={(e) => set({ tag: e.target.value })}
              />
            </div>
          )}
        </>
      ) : null}

      {type === "delay" ? (
        <div className="space-y-3">
          <div>
            <span className={labelClass}>{t("flows.delayModeLabel")}</span>
            <div className="mt-2 space-y-1.5">
              {(
                [
                  ["fixed", "flows.delayModeFixed"],
                  ["random", "flows.delayModeRandom"],
                ] as const
              ).map(([mode, key]) => {
                const randomCfg = config.random as
                  | { min?: unknown; max?: unknown }
                  | undefined;
                const isRandom =
                  typeof randomCfg === "object" && randomCfg !== null;
                return (
                  <label
                    key={mode}
                    className="flex items-center gap-2 text-sm text-ink"
                  >
                    <input
                      type="radio"
                      name="delay-mode"
                      disabled={readOnly}
                      checked={mode === "random" ? isRandom : !isRandom}
                      onChange={() => {
                        if (mode === "random") {
                          const base =
                            typeof config.amount === "number" &&
                            config.amount >= 1
                              ? Math.floor(config.amount)
                              : 1;
                          set({ random: { min: base, max: base + 5 } });
                        } else {
                          // Kembali ke mode tetap: kunci random DIHAPUS
                          // dari config (bukan dinonaktifkan) agar graf
                          // yang tersimpan persis yang dieksekusi.
                          const { random: _drop, ...rest } = config;
                          onChange(node.id, rest);
                        }
                      }}
                    />
                    {t(key)}
                  </label>
                );
              })}
            </div>
          </div>
          {(() => {
            const randomCfg = config.random as
              | { min?: unknown; max?: unknown }
              | undefined;
            const isRandom =
              typeof randomCfg === "object" && randomCfg !== null;
            const num = (v: unknown, fallback: number) =>
              typeof v === "number" && Number.isFinite(v) ? v : fallback;
            return isRandom ? (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelClass} htmlFor="cfg-delay-min">
                    {t("flows.delayMinLabel")}
                  </label>
                  <input
                    id="cfg-delay-min"
                    type="number"
                    min={1}
                    step={1}
                    className={inputClass}
                    disabled={readOnly}
                    value={num(randomCfg?.min, 1)}
                    onChange={(e) =>
                      set({
                        random: {
                          min: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                          max: num(randomCfg?.max, 1),
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="cfg-delay-max">
                    {t("flows.delayMaxLabel")}
                  </label>
                  <input
                    id="cfg-delay-max"
                    type="number"
                    min={1}
                    step={1}
                    className={inputClass}
                    disabled={readOnly}
                    value={num(randomCfg?.max, 1)}
                    onChange={(e) =>
                      set({
                        random: {
                          min: num(randomCfg?.min, 1),
                          max: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="cfg-delay-unit">
                    {t("flows.delayUnitLabel")}
                  </label>
                  <select
                    id="cfg-delay-unit"
                    className={inputClass}
                    disabled={readOnly}
                    value={str(config.unit) || "minutes"}
                    onChange={(e) => set({ unit: e.target.value })}
                  >
                    <option value="seconds">{t("flows.unitSeconds")}</option>
                    <option value="minutes">{t("flows.unitMinutes")}</option>
                    <option value="hours">{t("flows.unitHours")}</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass} htmlFor="cfg-delay-amount">
                    {t("flows.delayAmountLabel")}
                  </label>
                  <input
                    id="cfg-delay-amount"
                    type="number"
                    min={0}
                    step={1}
                    className={inputClass}
                    disabled={readOnly}
                    value={
                      typeof config.amount === "number" ? config.amount : 0
                    }
                    onChange={(e) =>
                      set({ amount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                    }
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="cfg-delay-unit">
                    {t("flows.delayUnitLabel")}
                  </label>
                  <select
                    id="cfg-delay-unit"
                    className={inputClass}
                    disabled={readOnly}
                    value={str(config.unit) || "minutes"}
                    onChange={(e) => set({ unit: e.target.value })}
                  >
                    <option value="seconds">{t("flows.unitSeconds")}</option>
                    <option value="minutes">{t("flows.unitMinutes")}</option>
                    <option value="hours">{t("flows.unitHours")}</option>
                  </select>
                </div>
              </div>
            );
          })()}
        </div>
      ) : null}

      {type === "add_tag" || type === "remove_tag" ? (
        <div>
          <label className={labelClass} htmlFor="cfg-tag">
            {t("flows.tagLabel")}
          </label>
          <input
            id="cfg-tag"
            className={inputClass}
            disabled={readOnly}
            list="flow-tag-options"
            placeholder={t("flows.tagPlaceholder")}
            value={str(config.tag)}
            onChange={(e) => set({ tag: e.target.value })}
          />
        </div>
      ) : null}

      {type === "set_stage" ? (
        <div>
          <label className={labelClass} htmlFor="cfg-stage">
            {t("flows.stageLabel")}
          </label>
          <select
            id="cfg-stage"
            className={inputClass}
            disabled={readOnly}
            value={str(config.stage)}
            onChange={(e) => set({ stage: e.target.value })}
          >
            {[...new Set([...stageOptions, str(config.stage)].filter(Boolean))].map(
              (s) => (
                <option key={s} value={s}>
                  {stageLabel(t, s)}
                </option>
              ),
            )}
          </select>
        </div>
      ) : null}

      {type === "enroll_sequence" ? (
        <div>
          <label className={labelClass} htmlFor="cfg-sequence">
            {t("flows.sequenceLabel")}
          </label>
          {meta.sequences.length === 0 ? (
            <p className="text-sm text-muted">{t("flows.sequenceNone")}</p>
          ) : (
            <select
              id="cfg-sequence"
              className={inputClass}
              disabled={readOnly}
              value={str(config.automationId)}
              onChange={(e) => set({ automationId: e.target.value })}
            >
              <option value="">{t("flows.sequencePlaceholder")}</option>
              {meta.sequences.map((seq) => (
                <option key={seq.id} value={seq.id}>
                  {seq.name}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      {type === "set_field" ? (
        <>
          <div>
            <label className={labelClass} htmlFor="cfg-setfield-field">
              {t("flows.setFieldFieldLabel")}
            </label>
            <select
              id="cfg-setfield-field"
              className={inputClass}
              disabled={readOnly}
              value={
                str(config.field).startsWith("custom:")
                  ? "custom"
                  : str(config.field) || "name"
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === "custom") {
                  const prev = str(config.field);
                  set({
                    field: prev.startsWith("custom:")
                      ? prev
                      : "custom:field_baru",
                  });
                } else {
                  set({ field: v });
                }
              }}
            >
              <option value="name">{t("flows.fieldName")}</option>
              <option value="phone">{t("flows.fieldPhone")}</option>
              <option value="email">{t("flows.fieldEmail")}</option>
              <option value="custom">{CUSTOM_FIELD_OPTION_LABEL}</option>
            </select>
          </div>
          {str(config.field).startsWith("custom:") ? (
            <div>
              <label className={labelClass} htmlFor="cfg-setfield-key">
                {t("flows.setFieldCustomKeyLabel")}
              </label>
              <input
                id="cfg-setfield-key"
                className={inputClass}
                disabled={readOnly}
                placeholder={t("flows.setFieldCustomKeyPlaceholder")}
                value={str(config.field).slice("custom:".length)}
                onChange={(e) =>
                  set({ field: `custom:${e.target.value}` })
                }
              />
            </div>
          ) : null}
          <div>
            <label className={labelClass} htmlFor="cfg-setfield-value">
              {t("flows.setFieldValueLabel")}
            </label>
            <input
              id="cfg-setfield-value"
              className={inputClass}
              disabled={readOnly}
              value={str(config.value)}
              onChange={(e) => set({ value: e.target.value })}
            />
            <p className="mt-1 text-xs text-muted">
              {t("flows.setFieldValueHint")}
            </p>
          </div>
        </>
      ) : null}

      {type === "http_request" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
            <div>
              <label className={labelClass} htmlFor="cfg-http-method">
                {t("flows.httpMethodLabel")}
              </label>
              <select
                id="cfg-http-method"
                className={inputClass}
                disabled={readOnly}
                value={str(config.method) || "POST"}
                onChange={(e) => set({ method: e.target.value })}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="cfg-http-url">
                {t("flows.httpUrlLabel")}
              </label>
              <input
                id="cfg-http-url"
                className={inputClass}
                disabled={readOnly}
                placeholder={t("flows.httpUrlPlaceholder")}
                value={str(config.url)}
                onChange={(e) => set({ url: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-http-headers">
              {t("flows.httpHeadersLabel")}
            </label>
            <textarea
              id="cfg-http-headers"
              className={inputClass}
              rows={2}
              disabled={readOnly}
              placeholder={t("flows.httpHeadersPlaceholder")}
              value={
                typeof config.headers === "object" &&
                config.headers !== null &&
                !Array.isArray(config.headers)
                  ? Object.entries(
                      config.headers as Record<string, unknown>,
                    )
                      .filter(([, v]) => typeof v === "string")
                      .map(([k, v]) => `${k}: ${v as string}`)
                      .join("\n")
                  : ""
              }
              onChange={(e) => {
                const headers: Record<string, string> = {};
                for (const line of e.target.value.split("\n")) {
                  const idx = line.indexOf(":");
                  if (idx <= 0) continue;
                  const name = line.slice(0, idx).trim();
                  if (name) headers[name] = line.slice(idx + 1).trim();
                }
                set({ headers });
              }}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-http-body">
              {t("flows.httpBodyLabel")}
            </label>
            <textarea
              id="cfg-http-body"
              className={inputClass}
              rows={4}
              disabled={readOnly}
              value={str(config.body)}
              onChange={(e) => set({ body: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-http-save">
              {t("flows.httpSaveToFieldLabel")}
            </label>
            <input
              id="cfg-http-save"
              className={inputClass}
              disabled={readOnly}
              placeholder={t("flows.httpSaveToFieldPlaceholder")}
              value={
                str(config.saveToField).startsWith("custom:")
                  ? str(config.saveToField).slice("custom:".length)
                  : str(config.saveToField)
              }
              onChange={(e) => {
                const key = e.target.value.trim();
                set({ saveToField: key ? `custom:${key}` : "" });
              }}
            />
          </div>
          <p className="text-xs text-muted">{t("flows.httpHint")}</p>
        </div>
      ) : null}

      {type === "goto_flow" ? (
        <div>
          <label className={labelClass} htmlFor="cfg-goto-flow">
            {t("flows.gotoFlowLabel")}
          </label>
          {meta.flows.length === 0 && !meta.selfFlow ? (
            <p className="text-sm text-muted">{t("flows.gotoNone")}</p>
          ) : (
            <select
              id="cfg-goto-flow"
              className={inputClass}
              disabled={readOnly}
              value={str(config.flowId)}
              onChange={(e) => set({ flowId: e.target.value })}
            >
              <option value="">{t("flows.gotoFlowPlaceholder")}</option>
              {meta.selfFlow &&
              !meta.flows.some((f) => f.id === meta.selfFlow!.id) ? (
                <option value={meta.selfFlow.id}>
                  {meta.selfFlow.name} ({t("flows.gotoSelfNote")})
                </option>
              ) : null}
              {meta.flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {meta.selfFlow && f.id === meta.selfFlow.id
                    ? ` (${t("flows.gotoSelfNote")})`
                    : ""}
                </option>
              ))}
            </select>
          )}
          <p className="mt-1 text-xs text-muted">{t("flows.gotoHint")}</p>
        </div>
      ) : null}

      {type === "ab_split" ? (
        <div>
          <label className={labelClass} htmlFor="cfg-ab-percent">
            {t("flows.abPercentLabel")}
          </label>
          <div className="mt-1 flex items-center gap-3">
            <input
              id="cfg-ab-percent"
              type="range"
              min={1}
              max={99}
              step={1}
              className="flex-1"
              disabled={readOnly}
              value={numVal(config.percentA, 50)}
              onChange={(e) =>
                set({ percentA: Math.floor(Number(e.target.value) || 50) })
              }
            />
            <input
              type="number"
              min={1}
              max={99}
              step={1}
              className="w-20 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink disabled:opacity-60"
              disabled={readOnly}
              value={numVal(config.percentA, 50)}
              onChange={(e) =>
                set({
                  percentA: Math.min(
                    99,
                    Math.max(1, Math.floor(Number(e.target.value) || 50)),
                  ),
                })
              }
            />
          </div>
          <p className="mt-1 text-xs text-muted">
            A {numVal(config.percentA, 50)}% · B{" "}
            {100 - numVal(config.percentA, 50)}% — {t("flows.abPercentHint")}
          </p>
          <div className="mt-4 border-t border-line pt-3">
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={readOnly}
                checked={config.experiment === true}
                onChange={(e) =>
                  set(
                    e.target.checked
                      ? { experiment: true }
                      : {
                          experiment: false,
                          experimentLabel: undefined,
                          conversionNodeId: undefined,
                        },
                  )
                }
              />
              <span>
                <span className="font-medium">
                  {t("flows.abExperimentToggle")}
                </span>
                <span className="mt-0.5 block text-xs font-normal text-muted">
                  {t("flows.abExperimentHint")}
                </span>
              </span>
            </label>
            {config.experiment === true ? (
              <div className="mt-3 space-y-3">
                <div>
                  <label
                    className={labelClass}
                    htmlFor="cfg-ab-exp-label"
                  >
                    {t("flows.abExperimentLabelLabel")}
                  </label>
                  <input
                    id="cfg-ab-exp-label"
                    className={inputClass}
                    disabled={readOnly}
                    maxLength={128}
                    value={str(config.experimentLabel)}
                    onChange={(e) =>
                      set({
                        experimentLabel: e.target.value || undefined,
                      })
                    }
                    placeholder={t("flows.abExperimentLabelPlaceholder")}
                  />
                </div>
                <div>
                  <label
                    className={labelClass}
                    htmlFor="cfg-ab-conversion"
                  >
                    {t("flows.abConversionLabel")}
                  </label>
                  <select
                    id="cfg-ab-conversion"
                    className={inputClass}
                    disabled={readOnly}
                    value={str(config.conversionNodeId)}
                    onChange={(e) =>
                      set({
                        conversionNodeId: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">{t("flows.abConversionNone")}</option>
                    {allNodes
                      .filter(
                        (n) => n.id !== node.id && n.data.nodeType !== "trigger",
                      )
                      .map((n) => {
                        const snippet =
                          typeof n.data.config.text === "string"
                            ? ` — ${(n.data.config.text as string).slice(0, 24)}`
                            : typeof n.data.config.tag === "string"
                              ? ` — ${n.data.config.tag as string}`
                              : "";
                        return (
                          <option key={n.id} value={n.id}>
                            {t(FLOW_NODE_LABEL_KEYS[n.data.nodeType])}
                            {snippet}
                          </option>
                        );
                      })}
                  </select>
                  <p className="mt-1 text-xs text-muted">
                    {t("flows.abConversionHint")}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {type === "send_payment_link" ? (
        <div>
          <label className={labelClass} htmlFor="cfg-pay-product">
            {t("flows.paymentProductLabel")}
          </label>
          {meta.products.length === 0 ? (
            <p className="text-sm text-muted">{t("flows.paymentNone")}</p>
          ) : (
            <select
              id="cfg-pay-product"
              className={inputClass}
              disabled={readOnly}
              value={str(config.productId)}
              onChange={(e) => set({ productId: e.target.value })}
            >
              <option value="">{t("flows.paymentProductPlaceholder")}</option>
              {meta.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <p className="mt-1 text-xs text-muted">{t("flows.paymentHint")}</p>
        </div>
      ) : null}

      {type === "wait_reply" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="cfg-wait-amount">
                {t("flows.waitReplyAmountLabel")}
              </label>
              <input
                id="cfg-wait-amount"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                disabled={readOnly}
                value={numVal(config.amount, 1)}
                onChange={(e) =>
                  set({
                    amount: Math.max(
                      0,
                      Math.floor(Number(e.target.value) || 0),
                    ),
                  })
                }
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="cfg-wait-unit">
                {t("flows.delayUnitLabel")}
              </label>
              <select
                id="cfg-wait-unit"
                className={inputClass}
                disabled={readOnly}
                value={str(config.unit) || "hours"}
                onChange={(e) => set({ unit: e.target.value })}
              >
                <option value="seconds">{t("flows.unitSeconds")}</option>
                <option value="minutes">{t("flows.unitMinutes")}</option>
                <option value="hours">{t("flows.unitHours")}</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-muted">{t("flows.waitReplyHint")}</p>
        </div>
      ) : null}

      {type === "show_catalog" ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">{t("flows.catalogHint")}</p>
          <div>
            <label className={labelClass} htmlFor="cfg-catalog-intro">
              {t("flows.catalogIntroLabel")}
            </label>
            <textarea
              id="cfg-catalog-intro"
              className={inputClass}
              rows={2}
              maxLength={1000}
              disabled={readOnly}
              placeholder={t("flows.catalogIntroPlaceholder")}
              value={str(config.introText)}
              onChange={(e) => set({ introText: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={config.showDescription === true}
              onChange={(e) => set({ showDescription: e.target.checked })}
            />
            {t("flows.catalogShowDescriptionLabel")}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="cfg-catalog-amount">
                {t("flows.waitReplyAmountLabel")}
              </label>
              <input
                id="cfg-catalog-amount"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                disabled={readOnly}
                value={numVal(config.amount, 24)}
                onChange={(e) =>
                  set({
                    amount: Math.max(
                      0,
                      Math.floor(Number(e.target.value) || 0),
                    ),
                  })
                }
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="cfg-catalog-unit">
                {t("flows.delayUnitLabel")}
              </label>
              <select
                id="cfg-catalog-unit"
                className={inputClass}
                disabled={readOnly}
                value={str(config.unit) || "hours"}
                onChange={(e) => set({ unit: e.target.value })}
              >
                <option value="seconds">{t("flows.unitSeconds")}</option>
                <option value="minutes">{t("flows.unitMinutes")}</option>
                <option value="hours">{t("flows.unitHours")}</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-catalog-attempts">
              {t("flows.questionnaireAttemptsLabel")}
            </label>
            <input
              id="cfg-catalog-attempts"
              type="number"
              min={1}
              max={5}
              step={1}
              className={inputClass}
              disabled={readOnly}
              value={numVal(config.maxInvalidAttempts, 2)}
              onChange={(e) =>
                set({
                  maxInvalidAttempts: Math.min(
                    5,
                    Math.max(1, Math.floor(Number(e.target.value) || 1)),
                  ),
                })
              }
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-catalog-invalid">
              {t("flows.catalogInvalidPromptLabel")}
            </label>
            <textarea
              id="cfg-catalog-invalid"
              className={inputClass}
              rows={2}
              maxLength={1000}
              disabled={readOnly}
              placeholder={t("flows.catalogInvalidPromptPlaceholder")}
              value={str(config.invalidPrompt)}
              onChange={(e) => set({ invalidPrompt: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-catalog-added">
              {t("flows.catalogAddedMessageLabel")}
            </label>
            <textarea
              id="cfg-catalog-added"
              className={inputClass}
              rows={2}
              maxLength={1000}
              disabled={readOnly}
              placeholder={t("flows.catalogAddedMessagePlaceholder")}
              value={str(config.addedMessage)}
              onChange={(e) => set({ addedMessage: e.target.value })}
            />
          </div>
        </div>
      ) : null}

      {type === "book_appointment" ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">{t("flows.appointmentHint")}</p>
          <div>
            <label className={labelClass} htmlFor="cfg-appt-service">
              {t("flows.appointmentServiceLabel")}
            </label>
            {meta.appointmentServices.length === 0 ? (
              <p className="text-sm text-muted">{t("flows.appointmentNone")}</p>
            ) : (
              <select
                id="cfg-appt-service"
                className={inputClass}
                disabled={readOnly}
                value={str(config.serviceId)}
                onChange={(e) => set({ serviceId: e.target.value })}
              >
                <option value="">
                  {t("flows.appointmentServicePlaceholder")}
                </option>
                {meta.appointmentServices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="cfg-appt-days">
                {t("flows.appointmentDaysAheadLabel")}
              </label>
              <input
                id="cfg-appt-days"
                type="number"
                min={1}
                max={30}
                step={1}
                className={inputClass}
                disabled={readOnly}
                value={numVal(config.daysAhead, 7)}
                onChange={(e) =>
                  set({
                    daysAhead: Math.min(
                      30,
                      Math.max(1, Math.floor(Number(e.target.value) || 1)),
                    ),
                  })
                }
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="cfg-appt-per-message">
                {t("flows.appointmentSlotsPerMessageLabel")}
              </label>
              <input
                id="cfg-appt-per-message"
                type="number"
                min={1}
                max={10}
                step={1}
                className={inputClass}
                disabled={readOnly}
                value={numVal(config.slotsPerMessage, 5)}
                onChange={(e) =>
                  set({
                    slotsPerMessage: Math.min(
                      10,
                      Math.max(1, Math.floor(Number(e.target.value) || 1)),
                    ),
                  })
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="cfg-appt-amount">
                {t("flows.waitReplyAmountLabel")}
              </label>
              <input
                id="cfg-appt-amount"
                type="number"
                min={0}
                step={1}
                className={inputClass}
                disabled={readOnly}
                value={numVal(config.amount, 24)}
                onChange={(e) =>
                  set({
                    amount: Math.max(
                      0,
                      Math.floor(Number(e.target.value) || 0),
                    ),
                  })
                }
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="cfg-appt-unit">
                {t("flows.delayUnitLabel")}
              </label>
              <select
                id="cfg-appt-unit"
                className={inputClass}
                disabled={readOnly}
                value={str(config.unit) || "hours"}
                onChange={(e) => set({ unit: e.target.value })}
              >
                <option value="seconds">{t("flows.unitSeconds")}</option>
                <option value="minutes">{t("flows.unitMinutes")}</option>
                <option value="hours">{t("flows.unitHours")}</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-appt-attempts">
              {t("flows.questionnaireAttemptsLabel")}
            </label>
            <input
              id="cfg-appt-attempts"
              type="number"
              min={1}
              max={5}
              step={1}
              className={inputClass}
              disabled={readOnly}
              value={numVal(config.maxInvalidAttempts, 2)}
              onChange={(e) =>
                set({
                  maxInvalidAttempts: Math.min(
                    5,
                    Math.max(1, Math.floor(Number(e.target.value) || 1)),
                  ),
                })
              }
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-appt-invalid">
              {t("flows.appointmentInvalidPromptLabel")}
            </label>
            <textarea
              id="cfg-appt-invalid"
              className={inputClass}
              rows={2}
              maxLength={1000}
              disabled={readOnly}
              placeholder={t("flows.appointmentInvalidPromptPlaceholder")}
              value={str(config.invalidPrompt)}
              onChange={(e) => set({ invalidPrompt: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-appt-booked">
              {t("flows.appointmentBookedMessageLabel")}
            </label>
            <textarea
              id="cfg-appt-booked"
              className={inputClass}
              rows={2}
              maxLength={1000}
              disabled={readOnly}
              placeholder={t("flows.appointmentBookedMessagePlaceholder")}
              value={str(config.bookedMessage)}
              onChange={(e) => set({ bookedMessage: e.target.value })}
            />
          </div>
        </div>
      ) : null}

      {type === "cart_checkout" ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">{t("flows.checkoutHint")}</p>
          <div>
            <label className={labelClass} htmlFor="cfg-checkout-empty">
              {t("flows.checkoutEmptyMessageLabel")}
            </label>
            <textarea
              id="cfg-checkout-empty"
              className={inputClass}
              rows={2}
              maxLength={1000}
              disabled={readOnly}
              placeholder={t("flows.checkoutEmptyMessagePlaceholder")}
              value={str(config.emptyMessage)}
              onChange={(e) => set({ emptyMessage: e.target.value })}
            />
          </div>
        </div>
      ) : null}

      {type === "questionnaire"
        ? (() => {
            interface QDraft {
              id: string;
              prompt: string;
              answerType: string;
              target: string;
              required: boolean;
              options: string[];
            }
            const rawQuestions = Array.isArray(config.questions)
              ? config.questions
              : [];
            const questions: QDraft[] = rawQuestions
              .filter(
                (q): q is Record<string, unknown> =>
                  typeof q === "object" && q !== null,
              )
              .map((q) => ({
                id: str(q.id),
                prompt: str(q.prompt),
                answerType: str(q.answerType) || "text",
                target: str(q.target) || "name",
                required: q.required !== false,
                options: Array.isArray(q.options)
                  ? q.options.filter(
                      (o): o is string => typeof o === "string",
                    )
                  : [],
              }));
            const setQuestions = (next: QDraft[]) =>
              set({ questions: next });
            const patchQuestion = (idx: number, patch: Partial<QDraft>) =>
              setQuestions(
                questions.map((q, i) => (i === idx ? { ...q, ...patch } : q)),
              );
            const newQuestionId = () => {
              let n = questions.length + 1;
              while (questions.some((q) => q.id === `q${n}`)) n += 1;
              return `q${n}`;
            };
            return (
              <div className="space-y-4">
                <p className="text-xs text-muted">
                  {t("flows.questionnaireHint")}
                </p>
                <div>
                  <span className={labelClass}>
                    {t("flows.questionnaireQuestionsLabel")}
                  </span>
                  <div className="mt-2 space-y-3">
                    {questions.map((q, idx) => (
                      <div
                        key={`${idx}-${q.id}`}
                        className="space-y-3 rounded-lg border border-line p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-ink">
                            {t("flows.questionnaireQuestionLabel", {
                              number: idx + 1,
                            })}
                          </span>
                          <span className="flex gap-1">
                            <button
                              type="button"
                              className="rounded border border-line px-1.5 py-0.5 text-xs text-muted disabled:opacity-40"
                              disabled={readOnly || idx === 0}
                              onClick={() => {
                                const next = [...questions];
                                [next[idx - 1], next[idx]] = [
                                  next[idx],
                                  next[idx - 1],
                                ];
                                setQuestions(next);
                              }}
                            >
                              ↑ {t("flows.questionnaireMoveUp")}
                            </button>
                            <button
                              type="button"
                              className="rounded border border-line px-1.5 py-0.5 text-xs text-muted disabled:opacity-40"
                              disabled={
                                readOnly || idx === questions.length - 1
                              }
                              onClick={() => {
                                const next = [...questions];
                                [next[idx], next[idx + 1]] = [
                                  next[idx + 1],
                                  next[idx],
                                ];
                                setQuestions(next);
                              }}
                            >
                              ↓ {t("flows.questionnaireMoveDown")}
                            </button>
                            <button
                              type="button"
                              className="rounded border border-line px-1.5 py-0.5 text-xs text-danger disabled:opacity-40"
                              disabled={readOnly || questions.length <= 1}
                              onClick={() =>
                                setQuestions(
                                  questions.filter((_, i) => i !== idx),
                                )
                              }
                            >
                              {t("flows.questionnaireRemoveQuestion")}
                            </button>
                          </span>
                        </div>
                        <div>
                          <label
                            className={labelClass}
                            htmlFor={`cfg-qq-${idx}-prompt`}
                          >
                            {t("flows.questionPromptLabel")}
                          </label>
                          <input
                            id={`cfg-qq-${idx}-prompt`}
                            className={inputClass}
                            disabled={readOnly}
                            maxLength={1000}
                            placeholder={t("flows.questionPromptPlaceholder")}
                            value={q.prompt}
                            onChange={(e) =>
                              patchQuestion(idx, { prompt: e.target.value })
                            }
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label
                              className={labelClass}
                              htmlFor={`cfg-qq-${idx}-type`}
                            >
                              {t("flows.questionTypeLabel")}
                            </label>
                            <select
                              id={`cfg-qq-${idx}-type`}
                              className={inputClass}
                              disabled={readOnly}
                              value={q.answerType}
                              onChange={(e) =>
                                patchQuestion(idx, {
                                  answerType: e.target.value,
                                })
                              }
                            >
                              <option value="text">
                                {t("flows.questionTypeText")}
                              </option>
                              <option value="number">
                                {t("flows.questionTypeNumber")}
                              </option>
                              <option value="email">
                                {t("flows.questionTypeEmail")}
                              </option>
                              <option value="phone">
                                {t("flows.questionTypePhone")}
                              </option>
                              <option value="choice">
                                {t("flows.questionTypeChoice")}
                              </option>
                            </select>
                          </div>
                          <div>
                            <label
                              className={labelClass}
                              htmlFor={`cfg-qq-${idx}-target`}
                            >
                              {t("flows.questionTargetLabel")}
                            </label>
                            <select
                              id={`cfg-qq-${idx}-target`}
                              className={inputClass}
                              disabled={readOnly}
                              value={
                                q.target.startsWith("custom:")
                                  ? "custom"
                                  : q.target
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "custom") {
                                  patchQuestion(idx, {
                                    target: q.target.startsWith("custom:")
                                      ? q.target
                                      : "custom:",
                                  });
                                } else {
                                  patchQuestion(idx, { target: v });
                                }
                              }}
                            >
                              <option value="name">
                                {t("flows.fieldName")}
                              </option>
                              <option value="phone">
                                {t("flows.fieldPhone")}
                              </option>
                              <option value="email">
                                {t("flows.fieldEmail")}
                              </option>
                              <option value="custom">{CUSTOM_FIELD_OPTION_LABEL}</option>
                            </select>
                          </div>
                        </div>
                        {q.target.startsWith("custom:") ? (
                          <div>
                            <label
                              className={labelClass}
                              htmlFor={`cfg-qq-${idx}-key`}
                            >
                              {t("flows.questionTargetCustomKeyLabel")}
                            </label>
                            <input
                              id={`cfg-qq-${idx}-key`}
                              className={inputClass}
                              disabled={readOnly}
                              list="flow-custom-field-keys"
                              placeholder={t(
                                "flows.questionTargetCustomKeyPlaceholder",
                              )}
                              value={q.target.slice("custom:".length)}
                              onChange={(e) =>
                                patchQuestion(idx, {
                                  target: `custom:${e.target.value}`,
                                })
                              }
                            />
                            <p className="mt-1 text-xs text-muted">
                              {meta.customFieldKeys.length > 0
                                ? t("flows.questionnaireKnownKeysHint", {
                                    keys: meta.customFieldKeys.join(", "),
                                  })
                                : t("flows.questionnaireNoKnownKeys")}
                            </p>
                          </div>
                        ) : null}
                        {q.answerType === "choice" ? (
                          <div>
                            <label
                              className={labelClass}
                              htmlFor={`cfg-qq-${idx}-options`}
                            >
                              {t("flows.questionOptionsLabel")}
                            </label>
                            <textarea
                              id={`cfg-qq-${idx}-options`}
                              className={inputClass}
                              rows={3}
                              disabled={readOnly}
                              placeholder={t("flows.questionOptionsPlaceholder")}
                              value={q.options.join("\n")}
                              onChange={(e) =>
                                patchQuestion(idx, {
                                  options: e.target.value
                                    .split("\n")
                                    .map((line) => line.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                            <p className="mt-1 text-xs text-muted">
                              {t("flows.questionnaireChoiceHint")}
                            </p>
                          </div>
                        ) : null}
                        <label className="flex items-start gap-2 text-sm text-ink">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            disabled={readOnly}
                            checked={q.required}
                            onChange={(e) =>
                              patchQuestion(idx, {
                                required: e.target.checked,
                              })
                            }
                          />
                          <span>{t("flows.questionRequiredLabel")}</span>
                        </label>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="mt-2 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-elevated disabled:opacity-40"
                    disabled={readOnly || questions.length >= 20}
                    onClick={() =>
                      setQuestions([
                        ...questions,
                        {
                          id: newQuestionId(),
                          prompt: "",
                          answerType: "text",
                          target: "name",
                          required: true,
                          options: [],
                        },
                      ])
                    }
                  >
                    + {t("flows.questionnaireAddQuestion")}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass} htmlFor="cfg-qq-amount">
                      {t("flows.questionnaireAmountLabel")}
                    </label>
                    <input
                      id="cfg-qq-amount"
                      type="number"
                      min={0}
                      step={1}
                      className={inputClass}
                      disabled={readOnly}
                      value={numVal(config.amount, 24)}
                      onChange={(e) =>
                        set({
                          amount: Math.max(
                            0,
                            Math.floor(Number(e.target.value) || 0),
                          ),
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="cfg-qq-unit">
                      {t("flows.delayUnitLabel")}
                    </label>
                    <select
                      id="cfg-qq-unit"
                      className={inputClass}
                      disabled={readOnly}
                      value={str(config.unit) || "hours"}
                      onChange={(e) => set({ unit: e.target.value })}
                    >
                      <option value="seconds">{t("flows.unitSeconds")}</option>
                      <option value="minutes">{t("flows.unitMinutes")}</option>
                      <option value="hours">{t("flows.unitHours")}</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className={labelClass} htmlFor="cfg-qq-attempts">
                    {t("flows.questionnaireAttemptsLabel")}
                  </label>
                  <input
                    id="cfg-qq-attempts"
                    type="number"
                    min={1}
                    max={5}
                    step={1}
                    className={inputClass}
                    disabled={readOnly}
                    value={numVal(config.maxInvalidAttempts, 2)}
                    onChange={(e) =>
                      set({
                        maxInvalidAttempts: Math.min(
                          5,
                          Math.max(
                            1,
                            Math.floor(Number(e.target.value) || 2),
                          ),
                        ),
                      })
                    }
                  />
                  <p className="mt-1 text-xs text-muted">
                    {t("flows.questionnaireAttemptsHint")}
                  </p>
                </div>
                <div>
                  <label className={labelClass} htmlFor="cfg-qq-invalid-prompt">
                    {t("flows.questionnaireInvalidPromptLabel")}
                  </label>
                  <input
                    id="cfg-qq-invalid-prompt"
                    className={inputClass}
                    disabled={readOnly}
                    maxLength={1000}
                    placeholder={t("flows.questionnaireInvalidPromptDefault")}
                    value={str(config.invalidPrompt)}
                    onChange={(e) =>
                      set({ invalidPrompt: e.target.value || undefined })
                    }
                  />
                  <p className="mt-1 text-xs text-muted">
                    {t("flows.questionnaireInvalidPromptHint")}
                  </p>
                </div>
                <div>
                  <label className={labelClass} htmlFor="cfg-qq-completion-tag">
                    {t("flows.questionnaireCompletionTagLabel")}
                  </label>
                  <input
                    id="cfg-qq-completion-tag"
                    className={inputClass}
                    disabled={readOnly}
                    list="flow-tag-options"
                    maxLength={64}
                    placeholder={t("flows.questionnaireCompletionTagPlaceholder")}
                    value={str(config.completionTag)}
                    onChange={(e) =>
                      set({ completionTag: e.target.value || undefined })
                    }
                  />
                </div>
              </div>
            );
          })()
        : null}

      {type === "ai_response" ? (
        <p className="text-sm text-muted">{t("flows.staticAiResponse")}</p>
      ) : null}
      {type === "handoff" ? (
        <p className="text-sm text-muted">{t("flows.staticHandoff")}</p>
      ) : null}
      {type === "end" ? (
        <p className="text-sm text-muted">{t("flows.staticEnd")}</p>
      ) : null}

      <datalist id="flow-tag-options">
        {meta.tags.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
      <datalist id="flow-custom-field-keys">
        {meta.customFieldKeys.map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>
    </div>
  );
}

// ---------------------------------------------------------------------------

const RUN_STATUS_CHIP: Record<FlowRunResponse["status"], string> = {
  running: "bg-warning/15 text-warning",
  waiting: "bg-warning/15 text-warning",
  completed: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-elevated text-muted",
};

const RUN_STATUS_LABEL_KEYS: Record<FlowRunResponse["status"], TranslationKey> = {
  running: "flows.runStatusRunning",
  waiting: "flows.runStatusWaiting",
  completed: "flows.runStatusCompleted",
  failed: "flows.runStatusFailed",
  cancelled: "flows.runStatusCancelled",
};

const STEP_OUTCOME_LABEL_KEYS: Record<string, TranslationKey> = {
  passed: "flows.stepOutcomePassed",
  queued: "flows.stepOutcomeQueued",
  evaluated: "flows.stepOutcomeEvaluated",
  waiting: "flows.stepOutcomeWaiting",
  tag_added: "flows.stepOutcomeTagAdded",
  tag_removed: "flows.stepOutcomeTagRemoved",
  stage_set: "flows.stepOutcomeStageSet",
  skipped: "flows.stepOutcomeSkipped",
  enrolled: "flows.stepOutcomeEnrolled",
  handed_off: "flows.stepOutcomeHandedOff",
  ended: "flows.stepOutcomeEnded",
  responded: "flows.stepOutcomeResponded",
  failed: "flows.stepOutcomeFailed",
  cap_exceeded: "flows.stepOutcomeCapExceeded",
  field_set: "flows.stepOutcomeFieldSet",
  split: "flows.stepOutcomeSplit",
  goto: "flows.stepOutcomeGoto",
  http_response: "flows.stepOutcomeHttpResponse",
  http_error: "flows.stepOutcomeHttpError",
  payment_link_sent: "flows.stepOutcomePaymentLinkSent",
  replied: "flows.stepOutcomeReplied",
  timeout: "flows.stepOutcomeTimeout",
  question_asked: "flows.stepOutcomeQuestionAsked",
  answer_recorded: "flows.stepOutcomeAnswerRecorded",
  answer_invalid: "flows.stepOutcomeAnswerInvalid",
  attempts_exhausted: "flows.stepOutcomeAttemptsExhausted",
  target_missing: "flows.stepOutcomeTargetMissing",
  completed: "flows.stepOutcomeCompleted",
  state_missing: "flows.stepOutcomeStateMissing",
};

interface FlowExperimentsPanelProps {
  t: Translate;
  tenantId: string;
  flowId: string;
}

/**
 * Panel hasil eksperimen A/B (Fase 13D) — membaca endpoint dashboard
 * `flows/:id/experiments`. Semua angka + putusan dihitung SERVER
 * (uji z dua-proporsi + pagar sampel minimum di core); panel ini
 * hanya menampilkan: pemenang hanya disebut bila server menyatakan
 * status "winner" beserta nilai z/p-nya.
 */
function FlowExperimentsPanel({ t, tenantId, flowId }: FlowExperimentsPanelProps) {
  const [data, setData] = useState<FlowExperimentsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.flows.experiments(tenantId, flowId);
      setData(res);
    } catch {
      setData(null);
    } finally {
      setLoaded(true);
    }
  }, [tenantId, flowId]);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(() => void load(), 10000, true);

  if (!loaded) return null;
  const experiments = data?.experiments ?? [];
  return (
    <div className="mb-4 border-b border-line pb-4">
      <h3 className="text-sm font-semibold text-ink">
        {t("flows.experimentsTitle")}
      </h3>
      <p className="mt-1 text-xs text-muted">{t("flows.experimentsHint")}</p>
      {experiments.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          {t("flows.experimentsEmpty")}
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {experiments.map((exp) => (
            <div
              key={exp.nodeId}
              className="rounded-lg border border-line bg-elevated/40 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  {exp.label ?? exp.nodeId}
                </p>
                <p className="text-xs text-muted">
                  {t("flows.expSplitNote", {
                    percentA: exp.percentA,
                    percentB: 100 - exp.percentA,
                  })}
                </p>
              </div>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColBranch")}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColAssigned")}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColRuns")}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColCompleted")}
                    </th>
                    <th className="py-1 pr-2 font-medium">
                      {t("flows.expColConversions")}
                    </th>
                    <th className="py-1 font-medium">
                      {t("flows.expColRate")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {exp.variants.map((v) => (
                    <tr key={v.branch} className="border-t border-line">
                      <td className="py-1.5 pr-2 font-semibold uppercase text-ink">
                        {v.branch}
                      </td>
                      <td className="py-1.5 pr-2 text-ink">
                        {v.assignedContacts}
                      </td>
                      <td className="py-1.5 pr-2 text-ink">{v.runs}</td>
                      <td className="py-1.5 pr-2 text-ink">
                        {v.completedRuns}
                      </td>
                      <td className="py-1.5 pr-2 text-ink">{v.conversions}</td>
                      <td className="py-1.5 text-ink">
                        {v.conversionRate === null
                          ? "—"
                          : `${(v.conversionRate * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                {!exp.conversionNodeId
                  ? t("flows.expNoConversionPoint")
                  : exp.verdict.status === "winner"
                    ? t("flows.expWinner", {
                        branch: (exp.verdict.winnerBranch ?? "").toUpperCase(),
                        z: exp.verdict.z?.toFixed(2) ?? "—",
                        p: exp.verdict.pValue?.toFixed(4) ?? "—",
                      })
                    : exp.verdict.status === "no_significant_difference"
                      ? t("flows.expNoDifference", {
                          z: exp.verdict.z?.toFixed(2) ?? "—",
                          p: exp.verdict.pValue?.toFixed(4) ?? "—",
                        })
                      : t("flows.expNotEnoughData", {
                          min: exp.verdict.minSamplePerVariant,
                        })}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface FlowRunsPanelProps {
  t: Translate;
  locale: Locale;
  tenantId: string;
  flowId: string;
  graph: FlowGraph;
}

/**
 * Penampil run flow (permukaan debugging 8A): daftar run + timeline
 * langkah run terpilih, dari endpoint runs/steps yang sama yang
 * dipakai rantai uji. Polling 5 dtk selama panel terbuka dan ada run
 * non-terminal (pola usePolling dashboard).
 */
function FlowRunsPanel({ t, locale, tenantId, flowId, graph }: FlowRunsPanelProps) {
  const [runs, setRuns] = useState<FlowRunResponse[]>([]);
  const [runsCursor, setRunsCursor] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<FlowRunStepResponse[]>([]);
  const [stepsCursor, setStepsCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const nodeLabel = useCallback(
    (nodeId: string): string => {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node) return nodeId;
      const key = FLOW_NODE_LABEL_KEYS[node.type];
      return key ? t(key) : node.type;
    },
    [graph, t],
  );

  const loadRuns = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const page = await api.flows.listRuns(tenantId, flowId, { limit: 50 });
        setRuns(page.runs);
        setRunsCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (!silent) setError(translateApiError(t, err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [tenantId, flowId, t],
  );

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const anyLive = runs.some(
    (r) => r.status === "running" || r.status === "waiting",
  );
  usePolling(() => void loadRuns(true), 5000, anyLive);

  const loadSteps = useCallback(
    async (runId: string) => {
      try {
        const page = await api.flows.listRunSteps(tenantId, runId, {
          limit: 200,
        });
        setSteps(page.steps);
        setStepsCursor(page.nextCursor);
      } catch (err) {
        setError(translateApiError(t, err));
        setSteps([]);
      }
    },
    [tenantId, t],
  );

  useEffect(() => {
    if (selectedRunId) void loadSteps(selectedRunId);
    else setSteps([]);
  }, [selectedRunId, loadSteps]);

  usePolling(
    () => {
      if (selectedRunId) void loadSteps(selectedRunId);
    },
    5000,
    Boolean(selectedRunId) && anyLive,
  );

  const loadMoreRuns = async () => {
    if (!runsCursor) return;
    try {
      const page = await api.flows.listRuns(tenantId, flowId, {
        limit: 50,
        cursor: runsCursor,
      });
      setRuns((prev) => [...prev, ...page.runs]);
      setRunsCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const loadMoreSteps = async () => {
    if (!stepsCursor || !selectedRunId) return;
    try {
      const page = await api.flows.listRunSteps(tenantId, selectedRunId, {
        limit: 200,
        cursor: stepsCursor,
      });
      setSteps((prev) => [...prev, ...page.steps]);
      setStepsCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const stepDetailLine = (step: FlowRunStepResponse): string => {
    const d = step.detail ?? {};
    const outcome = typeof d.outcome === "string" ? d.outcome : "";
    const parts: string[] = [];
    const outcomeKey = STEP_OUTCOME_LABEL_KEYS[outcome];
    if (outcomeKey) parts.push(t(outcomeKey));
    else if (outcome) parts.push(outcome);
    if (outcome === "evaluated") {
      parts.push(
        d.result === true ? t("flows.stepResultYes") : t("flows.stepResultNo"),
      );
    }
    if (outcome === "split") {
      parts.push(
        d.branch === "a" ? t("flows.stepResultA") : t("flows.stepResultB"),
      );
    }
    if (outcome === "replied") parts.push(t("flows.stepResultReplied"));
    if (outcome === "timeout") parts.push(t("flows.stepResultTimeout"));
    if (
      (outcome === "http_response" || outcome === "http_error") &&
      typeof d.status === "number"
    ) {
      parts.push(`HTTP ${d.status}`);
    }
    if (outcome === "field_set" && typeof d.field === "string" && d.field) {
      parts.push(d.field);
    }
    // Fase 13E: langkah questionnaire — tampilkan nilai tersimpan,
    // alasan tidak-valid, dan cabang keluar langkah penutupnya.
    if (
      outcome === "answer_recorded" &&
      (typeof d.storedValue === "string" || typeof d.storedValue === "number")
    ) {
      parts.push(String(d.storedValue));
    }
    if (
      (outcome === "answer_invalid" ||
        outcome === "attempts_exhausted" ||
        outcome === "target_missing") &&
      typeof d.reason === "string" &&
      d.reason
    ) {
      parts.push(t("flows.stepReason", { reason: d.reason }));
    }
    if (
      (outcome === "completed" ||
        outcome === "attempts_exhausted" ||
        outcome === "target_missing" ||
        outcome === "state_missing") &&
      typeof d.branch === "string" &&
      d.branch
    ) {
      const branchKey = branchLabelKey(d.branch);
      if (branchKey) parts.push(t(branchKey));
    }
    if (typeof d.tag === "string" && d.tag) parts.push(d.tag);
    if (typeof d.stage === "string" && d.stage)
      parts.push(stageLabel(t, d.stage));
    if (outcome === "skipped" && typeof d.reason === "string" && d.reason) {
      parts.push(t("flows.stepReason", { reason: d.reason }));
    }
    if (typeof d.delayMs === "number") {
      parts.push(`${Math.round(d.delayMs / 100) / 10}s`);
    }
    return parts.join(" · ");
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">
            {t("flows.runsTitle")}
          </h3>
          <button
            type="button"
            onClick={() => void loadRuns()}
            className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-elevated"
          >
            {t("flows.runsRefresh")}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">{t("flows.runsHint")}</p>
        {error ? (
          <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="mt-4 text-sm text-muted">{t("workspace.loading")}</p>
        ) : runs.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t("flows.runsEmpty")}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left ${
                    selectedRunId === run.id
                      ? "border-accent bg-surface"
                      : "border-line bg-surface hover:bg-elevated"
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">
                      {run.contactName}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_CHIP[run.status]}`}
                    >
                      {t(RUN_STATUS_LABEL_KEYS[run.status])}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {formatDateTime(run.startedAt, locale)}
                    {" · "}
                    {t("flows.runStepsCount", { count: run.stepCount })}
                    {run.errorCode
                      ? ` · ${t("flows.runErrorLabel")}: ${run.errorCode}`
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {runsCursor ? (
          <div className="mt-3 text-center">
            <button
              type="button"
              onClick={() => void loadMoreRuns()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-elevated"
            >
              {t("flows.loadMore")}
            </button>
          </div>
        ) : null}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-ink">
          {t("flows.stepsTitle")}
        </h3>
        {!selectedRunId ? (
          <p className="mt-3 text-sm text-muted">{t("flows.stepsEmpty")}</p>
        ) : steps.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t("workspace.loading")}</p>
        ) : (
          <ol className="mt-3 space-y-0">
            {steps.map((step, idx) => (
              <li key={step.id} className="relative flex gap-3 pb-4">
                {idx < steps.length - 1 ? (
                  <span className="absolute left-[11px] top-6 h-[calc(100%-16px)] w-px bg-line" />
                ) : null}
                <span
                  className={`z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    step.error
                      ? "bg-danger/15 text-danger"
                      : "bg-elevated text-muted"
                  }`}
                >
                  {step.seq}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {nodeLabel(step.nodeId)}
                    <span className="ml-2 text-xs font-normal text-muted">
                      {formatDateTime(step.createdAt, locale)}
                    </span>
                  </p>
                  <p className="text-xs text-muted">{stepDetailLine(step)}</p>
                  {step.error ? (
                    <p className="text-xs text-danger">{step.error}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        {selectedRunId && stepsCursor ? (
          <div className="mt-1 text-center">
            <button
              type="button"
              onClick={() => void loadMoreSteps()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-elevated"
            >
              {t("flows.loadMore")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BuilderInnerProps {
  t: Translate;
  locale: Locale;
  tenantId: string;
  flow: FlowResponse;
  canManage: boolean;
  meta: TenantMeta;
  onFlowChange: (flow: FlowResponse) => void;
  onBack: () => void;
}

function BuilderInner({
  t,
  locale,
  tenantId,
  flow,
  canManage,
  meta,
  onFlowChange,
  onBack,
}: BuilderInnerProps) {
  const readOnly = flow.status !== "draft" || !canManage;
  const [name, setName] = useState(flow.name);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowRfNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowRfEdge>([]);
  const [tab, setTab] = useState<"canvas" | "runs">("canvas");
  const [issues, setIssues] = useState<FlowGraphIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const snapshotRef = useRef<string>("");
  const counterRef = useRef(0);
  const reactFlow = useReactFlow();
  const initializedForRef = useRef<string | null>(null);

  // Muat graf ke kanvas sekali per flow (atau saat status kembali ke
  // draft lewat nonaktifkan — graf server adalah sumber kebenaran).
  useEffect(() => {
    if (initializedForRef.current === flow.id) return;
    initializedForRef.current = flow.id;
    const { nodes: rfNodes, edges: rfEdges } = graphToRf(flow.graph);
    const labeledEdges = rfEdges.map((e) =>
      e.data?.branch
        ? { ...e, ...branchEdgeLabelProps(t, e.data.branch) }
        : e,
    );
    setNodes(rfNodes);
    setEdges(labeledEdges);
    setName(flow.name);
    snapshotRef.current = JSON.stringify({
      name: flow.name,
      graph: rfToGraph(rfNodes, rfEdges),
    });
    setIssues([]);
    setNotice(null);
    setError(null);
  }, [flow, setNodes, setEdges, t]);

  // Label cabang pada edge mengikuti bahasa aktif. Dipisah dari efek
  // pemuatan graf di atas dengan sengaja: efek itu dijaga
  // `initializedForRef` supaya kanvas tidak dimuat ulang (dan perubahan
  // yang belum disimpan tidak hilang), sehingga pergantian bahasa tidak
  // akan pernah memperbarui label bila pelabelan menumpang di sana.
  useEffect(() => {
    setEdges((eds) =>
      eds.map((e) =>
        e.data?.branch ? { ...e, ...branchEdgeLabelProps(t, e.data.branch) } : e,
      ),
    );
  }, [t, setEdges]);

  const currentGraph = useMemo(
    () => rfToGraph(nodes, edges),
    [nodes, edges],
  );
  const dirty =
    snapshotRef.current !== "" &&
    JSON.stringify({ name, graph: currentGraph }) !== snapshotRef.current;

  const selectedNode = nodes.find((n) => n.selected) ?? null;

  const sequenceName = useCallback(
    (automationId: string) =>
      meta.sequences.find((s) => s.id === automationId)?.name,
    [meta.sequences],
  );

  const flowName = useCallback(
    (flowId: string) =>
      flowId === flow.id
        ? flow.name
        : meta.flows.find((f) => f.id === flowId)?.name,
    [meta.flows, flow.id, flow.name],
  );

  const productName = useCallback(
    (productId: string) =>
      meta.products.find((p) => p.id === productId)?.name,
    [meta.products],
  );

  const serviceName = useCallback(
    (serviceId: string) =>
      meta.appointmentServices.find((s) => s.id === serviceId)?.name,
    [meta.appointmentServices],
  );

  // Tandai node yang disebut issue (klik issue juga memilih node itu).
  useEffect(() => {
    const severityByNode = new Map<string, "error" | "warning">();
    for (const issue of issues) {
      if (!issue.nodeId) continue;
      const prev = severityByNode.get(issue.nodeId);
      if (prev !== "error") severityByNode.set(issue.nodeId, issue.severity);
    }
    setNodes((prev) =>
      prev.map((n) => {
        const sev = severityByNode.get(n.id) ?? null;
        return n.data.issueSeverity === sev
          ? n
          : { ...n, data: { ...n.data, issueSeverity: sev } };
      }),
    );
  }, [issues, setNodes]);

  const focusNode = useCallback(
    (nodeId: string) => {
      setTab("canvas");
      setNodes((prev) =>
        prev.map((n) => ({ ...n, selected: n.id === nodeId })),
      );
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        void reactFlow.setCenter(
          node.position.x + 114,
          node.position.y + 40,
          { zoom: 1.1, duration: 400 },
        );
      }
    },
    [nodes, reactFlow, setNodes],
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      // Trigger tidak pernah terhapus (deletable=false + saring di sini
      // untuk jalur keyboard sekalipun).
      const safeChanges = changes.filter(
        (c) =>
          !(
            c.type === "remove" &&
            nodes.find((n) => n.id === c.id)?.data.nodeType === "trigger"
          ),
      );
      const removedIds = safeChanges
        .filter((c) => c.type === "remove")
        .map((c) => c.id);
      onNodesChange(safeChanges);
      if (removedIds.length > 0) {
        setEdges((prev) =>
          prev.filter(
            (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target),
          ),
        );
      }
    },
    [nodes, onNodesChange, setEdges],
  );

  // Mode hanya-baca: perubahan posisi/koneksi dimatikan, tetapi seleksi
  // tetap diteruskan agar panel konfigurasi bisa dipakai untuk MEMBACA.
  const handleNodesChangeReadOnly = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes.filter((c) => c.type === "select"));
    },
    [onNodesChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return;
      if (targetNode.data.nodeType === "trigger") return;
      // Node bercabang: branch berasal dari handle sumber yang
      // dipakai; koneksi tanpa handle spesifik jatuh ke cabang
      // pertama tipe itu (perilaku condition 8B digeneralisasi).
      const branched = FLOW_BRANCHED_TYPES[sourceNode.data.nodeType];
      const branch: FlowEdgeBranch | undefined = branched
        ? (branched.find((b) => b.branch === connection.sourceHandle)
            ?.branch ?? branched[0].branch)
        : undefined;
      counterRef.current += 1;
      const newEdge: FlowRfEdge = {
        id: `e-${connection.source}-${branch ?? "next"}-${connection.target}-${Date.now()}-${counterRef.current}`,
        source: connection.source,
        target: connection.target,
        ...(branch ? { sourceHandle: branch } : {}),
        ...(branch ? branchEdgeLabelProps(t, branch) : {}),
        data: branch ? { branch } : {},
      };
      setEdges((prev) => {
        // Satu edge keluar per (node, cabang): koneksi baru menggantikan
        // yang lama — selaras semantik eksekutor (edge pertama yang
        // dipakai untuk node non-condition).
        const kept = prev.filter(
          (e) =>
            !(
              e.source === connection.source &&
              (e.data?.branch ?? undefined) === branch
            ),
        );
        return addEdge(newEdge, kept);
      });
    },
    [nodes, setEdges, t],
  );

  const isValidConnection = useCallback(
    (connection: Connection | FlowRfEdge) => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!targetNode || targetNode.data.nodeType === "trigger") return false;
      return true;
    },
    [nodes],
  );

  const addNode = useCallback(
    (type: FlowNodeType, position?: { x: number; y: number }) => {
      counterRef.current += 1;
      const id = `n_${type}_${Date.now().toString(36)}_${counterRef.current}`;
      const maxY = nodes.reduce((acc, n) => Math.max(acc, n.position.y), 0);
      const newNode: FlowRfNode = {
        id,
        type: "flowNode",
        position: position ?? { x: 290, y: maxY + 180 },
        data: {
          nodeType: type,
          config: defaultNodeConfig(type),
          issueSeverity: null,
        },
        deletable: type !== "trigger",
        selected: true,
      };
      setNodes((prev) => [
        ...prev.map((n) => ({ ...n, selected: false })),
        newNode,
      ]);
    },
    [nodes, setNodes],
  );

  const onDragStartPalette = (
    event: React.DragEvent,
    type: FlowNodeType,
  ) => {
    event.dataTransfer.setData("application/sk-flow-node", type);
    event.dataTransfer.effectAllowed = "move";
  };

  const onCanvasDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(
        "application/sk-flow-node",
      ) as FlowNodeType;
      if (!type || !ADDABLE_NODE_TYPES.includes(type)) return;
      const position = reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(type, { x: position.x - 114, y: position.y - 30 });
    },
    [addNode, reactFlow],
  );

  const updateNodeConfig = useCallback(
    (nodeId: string, config: Record<string, unknown>) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, config } } : n,
        ),
      );
    },
    [setNodes],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setEdges((prev) =>
        prev.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
    },
    [setNodes, setEdges],
  );

  const saveDraft = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.flows.update(tenantId, flow.id, {
        name: name.trim() || flow.name,
        graph: currentGraph,
      });
      snapshotRef.current = JSON.stringify({
        name: saved.name,
        graph: rfToGraph(nodes, edges),
      });
      onFlowChange(saved);
      return true;
    } catch (err) {
      setError(translateApiError(t, err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [tenantId, flow.id, flow.name, name, currentGraph, nodes, edges, onFlowChange, t]);

  const runValidate = async () => {
    setValidating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.flows.validate(tenantId, flow.id, currentGraph);
      setIssues(result.issues);
      const { errors, warnings } = splitIssues(result.issues);
      if (errors.length === 0) {
        setNotice(
          warnings.length > 0
            ? t("flows.validWithWarnings", { count: warnings.length })
            : t("flows.validOk"),
        );
      }
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setValidating(false);
    }
  };

  const runActivate = async () => {
    setActivating(true);
    setError(null);
    setNotice(null);
    try {
      if (dirty) {
        const ok = await saveDraft();
        if (!ok) return;
      }
      const result = await api.flows.activate(tenantId, flow.id);
      onFlowChange(result.flow);
      setIssues(result.warnings);
      setNotice(
        result.warnings.length > 0
          ? t("flows.activatedWithWarnings", {
              count: result.warnings.length,
            })
          : t("flows.activatedOk"),
      );
    } catch (err) {
      const parsed = issuesFromError(err);
      if (err instanceof ApiClientError && err.code === "FLOW_GRAPH_INVALID" && parsed) {
        setIssues(parsed);
      } else {
        setError(translateApiError(t, err));
      }
    } finally {
      setActivating(false);
    }
  };

  const changeStatus = async (action: "deactivate" | "unarchive") => {
    setStatusBusy(true);
    setError(null);
    try {
      const updated =
        action === "deactivate"
          ? await api.flows.deactivate(tenantId, flow.id)
          : await api.flows.unarchive(tenantId, flow.id);
      // Status kembali draft → muat ulang graf dari server ke kanvas.
      initializedForRef.current = null;
      onFlowChange(updated);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setStatusBusy(false);
    }
  };

  const { errors: issueErrors, warnings: issueWarnings } = splitIssues(issues);

  const renderIssueList = (list: FlowGraphIssue[], danger: boolean) => (
    <ul className="space-y-1">
      {list.map((issue, i) => {
        const node = issue.nodeId
          ? nodes.find((n) => n.id === issue.nodeId)
          : undefined;
        return (
          <li key={`${issue.code}-${issue.nodeId ?? "graph"}-${i}`}>
            <button
              type="button"
              disabled={!node}
              onClick={() => issue.nodeId && focusNode(issue.nodeId)}
              className={`text-left text-sm ${
                danger ? "text-danger" : "text-warning"
              } ${node ? "hover:underline" : "cursor-default"}`}
            >
              {translateFlowIssue(t, issue)}
              <span className="text-muted">
                {" — "}
                {node
                  ? t("flows.issueOnNode", {
                      node: t(FLOW_NODE_LABEL_KEYS[node.data.nodeType]),
                    })
                  : t("flows.issueGraphWide")}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const shared: BuilderShared = {
    t,
    readOnly,
    sequenceName,
    flowName,
    productName,
    serviceName,
  };

  return (
    <section>
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-muted hover:text-ink"
      >
        ← {t("flows.backToList")}
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          className="min-w-52 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-lg font-bold text-ink disabled:opacity-70 sm:flex-none sm:text-xl"
          value={name}
          disabled={readOnly}
          maxLength={255}
          onChange={(e) => setName(e.target.value)}
          aria-label={t("flows.nameLabel")}
        />
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            flow.status === "active"
              ? "bg-success/15 text-success"
              : "bg-elevated text-muted"
          }`}
        >
          {t(
            flow.status === "active"
              ? "flows.statusActive"
              : flow.status === "archived"
                ? "flows.statusArchived"
                : "flows.statusDraft",
          )}
        </span>
        <span className="text-xs text-muted">
          {t("flows.runCount", { count: flow.runCount })}
        </span>
      </div>

      {flow.status !== "draft" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-ink">
          <span>
            {flow.status === "active"
              ? t("flows.readonlyActive")
              : t("flows.readonlyArchived")}
          </span>
          {canManage ? (
            <button
              type="button"
              disabled={statusBusy}
              onClick={() =>
                void changeStatus(
                  flow.status === "active" ? "deactivate" : "unarchive",
                )
              }
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-elevated disabled:opacity-50"
            >
              {flow.status === "active"
                ? t("flows.deactivateToEdit")
                : t("flows.unarchiveToEdit")}
            </button>
          ) : null}
        </div>
      ) : null}
      {!canManage ? (
        <p className="mt-4 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("flows.forbidden")}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-line">
          {(
            [
              ["canvas", "flows.tabCanvas"],
              ["runs", "flows.tabRuns"],
            ] as const
          ).map(([value, key]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`px-3 py-1.5 text-sm font-medium ${
                tab === value
                  ? "bg-accent text-white"
                  : "bg-surface text-muted hover:text-ink"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
        {tab === "canvas" && !readOnly ? (
          <>
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void saveDraft().then((ok) => {
                  if (ok) setNotice(t("flows.savedOk"));
                })
              }
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? t("flows.saving") : t("flows.saveDraft")}
            </button>
            <button
              type="button"
              disabled={validating}
              onClick={() => void runValidate()}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-elevated disabled:opacity-50"
            >
              {t("flows.validateButton")}
            </button>
            <button
              type="button"
              disabled={activating}
              onClick={() => void runActivate()}
              className="rounded-lg border border-success px-3 py-1.5 text-sm font-medium text-success hover:bg-success/10 disabled:opacity-50"
            >
              {activating ? t("flows.activating") : t("flows.activateButton")}
            </button>
            {dirty ? (
              <span className="text-xs text-warning">
                {t("flows.unsavedChanges")}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          {notice}
        </p>
      ) : null}
      {issueErrors.length > 0 ? (
        <div className="mt-3 rounded-lg bg-danger/5 px-3 py-2">
          <p className="text-sm font-semibold text-danger">
            {t("flows.issuesErrorsTitle")}
          </p>
          <div className="mt-1">{renderIssueList(issueErrors, true)}</div>
        </div>
      ) : null}
      {issueWarnings.length > 0 ? (
        <div className="mt-3 rounded-lg bg-warning/5 px-3 py-2">
          <p className="text-sm font-semibold text-warning">
            {t("flows.issuesWarningsTitle")}
          </p>
          <div className="mt-1">{renderIssueList(issueWarnings, false)}</div>
        </div>
      ) : null}

      {tab === "runs" ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          {tenantId ? (
            <FlowExperimentsPanel
              t={t}
              tenantId={tenantId}
              flowId={flow.id}
            />
          ) : null}
          <FlowRunsPanel
            t={t}
            locale={locale}
            tenantId={tenantId}
            flowId={flow.id}
            graph={currentGraph}
          />
        </div>
      ) : (
        <div
          className={`mt-4 grid gap-4 ${
            readOnly
              ? "xl:grid-cols-[minmax(0,1fr)_300px]"
              : "xl:grid-cols-[220px_minmax(0,1fr)_300px]"
          }`}
        >
          {!readOnly ? (
            <aside className="order-2 rounded-xl border border-line bg-surface p-3 xl:order-1">
              <h3 className="text-sm font-semibold text-ink">
                {t("flows.paletteTitle")}
              </h3>
              <p className="mt-1 text-xs text-muted">
                {t("flows.paletteHint")}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-1">
                {ADDABLE_NODE_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    draggable
                    onDragStart={(e) => onDragStartPalette(e, type)}
                    onClick={() => addNode(type)}
                    className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-left text-xs font-medium text-ink hover:bg-elevated"
                  >
                    <svg
                      className="h-4 w-4 shrink-0 text-muted"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.7}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden={true}
                    >
                      <path d={NODE_ICON_PATHS[type]} />
                    </svg>
                    {t(FLOW_NODE_LABEL_KEYS[type])}
                  </button>
                ))}
              </div>
            </aside>
          ) : null}

          <div
            className="sk-flow order-1 h-[560px] overflow-hidden rounded-xl border border-line xl:order-2"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={readOnly ? undefined : onCanvasDrop}
          >
            <BuilderCtx.Provider value={shared}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                onNodesChange={
                  readOnly ? handleNodesChangeReadOnly : handleNodesChange
                }
                onEdgesChange={readOnly ? undefined : onEdgesChange}
                onConnect={readOnly ? undefined : handleConnect}
                isValidConnection={isValidConnection}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                elementsSelectable
                deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
                fitView
                fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
                minZoom={0.2}
                maxZoom={1.75}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={22}
                  size={1.6}
                />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable />
              </ReactFlow>
            </BuilderCtx.Provider>
          </div>

          <aside className="order-3 rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">
              {t("flows.configTitle")}
            </h3>
            <div className="mt-3">
              {selectedNode ? (
                <NodeConfigPanel
                  t={t}
                  node={selectedNode}
                  allNodes={nodes}
                  meta={meta}
                  readOnly={readOnly}
                  onChange={updateNodeConfig}
                  onDelete={deleteNode}
                />
              ) : (
                <p className="text-sm text-muted">{t("flows.configEmpty")}</p>
              )}
            </div>
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              {t("flows.canvasHint")}
            </p>
          </aside>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

interface FlowBuilderPageProps {
  t: Translate;
  locale: Locale;
  flowId: string;
  onBack: () => void;
}

/**
 * Halaman Flow Builder (Fase 8B) di /flows/:flowId: memuat flow +
 * metadata tenant (tag/stage dari kontak, sequence aktif), lalu
 * menyerahkan kanvas ke BuilderInner di dalam ReactFlowProvider.
 */
export function FlowBuilderPage({
  t,
  locale,
  flowId,
  onBack,
}: FlowBuilderPageProps) {
  const { status, active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";
  const [flow, setFlow] = useState<FlowResponse | null>(null);
  const [meta, setMeta] = useState<TenantMeta>({
    tags: [],
    stages: [],
    sequences: [],
    flows: [],
    selfFlow: null,
    products: [],
    appointmentServices: [],
    customFieldKeys: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [
          flowRes,
          automations,
          contacts,
          flowsRes,
          products,
          appointmentServices,
        ] = await Promise.all([
          api.flows.get(tenantId, flowId),
          api.automations.list(tenantId).catch(() => []),
          api.contacts.list(tenantId, { limit: 200 }).catch(() => null),
          api.flows
            .list(tenantId, { status: "active", limit: 100 })
            .catch(() => null),
          api.products.list(tenantId).catch(() => [] as ProductResponse[]),
          api.appointments
            .listServices(tenantId)
            .catch(() => [] as AppointmentServiceResponse[]),
        ]);
        if (cancelled) return;
        setFlow(flowRes);
        const tags = new Set<string>();
        const stages = new Set<string>();
        const customFieldKeys = new Set<string>();
        for (const contact of contacts?.contacts ?? []) {
          for (const tag of contact.tags) tags.add(tag);
          if (contact.pipelineStage) stages.add(contact.pipelineStage);
          for (const key of Object.keys(contact.customFields ?? {})) {
            customFieldKeys.add(key);
          }
        }
        setMeta({
          tags: [...tags].sort(),
          stages: [...stages].sort(),
          sequences: automations.filter(
            (a) => a.kind === "sequence" && a.isActive,
          ),
          flows: flowsRes?.flows ?? [],
          selfFlow: { id: flowRes.id, name: flowRes.name },
          products: products.filter((p) => p.isActive),
          appointmentServices: appointmentServices.filter((s) => s.isActive),
          customFieldKeys: [...customFieldKeys].sort(),
        });
      } catch (err) {
        if (!cancelled) setError(translateApiError(t, err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, flowId, t]);

  if (status === "loading" || loading) {
    return (
      <section>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error" || error || !flow || !tenantId) {
    return (
      <section>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-muted hover:text-ink"
        >
          ← {t("flows.backToList")}
        </button>
        <p className="mt-6 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error ?? t("errors.NOT_FOUND")}
        </p>
      </section>
    );
  }

  return (
    <ReactFlowProvider>
      <BuilderInner
        t={t}
        locale={locale}
        tenantId={tenantId}
        flow={flow}
        canManage={canManage}
        meta={meta}
        onFlowChange={setFlow}
        onBack={onBack}
      />
    </ReactFlowProvider>
  );
}
