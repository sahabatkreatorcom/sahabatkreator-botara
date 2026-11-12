/**
 * Kartu satu node di kanvas, beserta peta tipe node React Flow.
 */
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { FLOW_BRANCHED_TYPES, FLOW_NODE_LABEL_KEYS, summarizeNodeConfig } from "../../flows/graphModel";
import { NODE_ICON_PATHS, branchColorClass } from "./graph";
import { type FlowRfNode, useBuilderShared } from "./types";

export function FlowNodeCard({ data, selected }: NodeProps<FlowRfNode>) {
  const { t, sequenceName, flowName, productName, serviceName, dealStageName } =
    useBuilderShared();
  const type = data.nodeType;
  const summary = summarizeNodeConfig(
    t,
    { type, config: data.config },
    sequenceName,
    { flowName, productName, serviceName, dealStageName },
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

export const NODE_TYPES = { flowNode: FlowNodeCard };

/**
 * Layout awal deterministik untuk node TANPA position tersimpan
 * (flow 8A yang dibuat via API): kedalaman BFS dari trigger menjadi
 * kolom x, urutan dalam kedalaman menjadi baris y. Node ber-position
 * tidak diganggu.
 */
