/**
 * Panel riwayat run: daftar run dan langkah-langkahnya.
 */
import { type FlowGraph, type FlowRunResponse, type FlowRunStepResponse } from "@sahabat-kreator/contracts";
import { type Locale, type TranslationKey } from "@sahabat-kreator/i18n";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { FLOW_NODE_LABEL_KEYS, branchLabelKey } from "../../flows/graphModel";
import { usePolling } from "../../hooks/usePolling";
import { formatDateTime } from "../../utils/format";
import { stageLabel } from "./graph";
import { type Translate } from "./types";

export const RUN_STATUS_CHIP: Record<FlowRunResponse["status"], string> = {
  running: "bg-warning/15 text-warning",
  waiting: "bg-warning/15 text-warning",
  completed: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-elevated text-muted",
};

export const RUN_STATUS_LABEL_KEYS: Record<FlowRunResponse["status"], TranslationKey> = {
  running: "flows.runStatusRunning",
  waiting: "flows.runStatusWaiting",
  completed: "flows.runStatusCompleted",
  failed: "flows.runStatusFailed",
  cancelled: "flows.runStatusCancelled",
};

export const STEP_OUTCOME_LABEL_KEYS: Record<string, TranslationKey> = {
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


export interface FlowRunsPanelProps {
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
export function FlowRunsPanel({ t, locale, tenantId, flowId, graph }: FlowRunsPanelProps) {
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
