/**
 * Panel simulator flow (G4) — panel uji kering di Flow Builder.
 */
import {
  type FlowGraph,
  type FlowSimulateEffect,
  type FlowSimulateRequest,
  type FlowSimulateResponse,
  type FlowSimulateStep,
  type FlowVersionResponse,
} from "@sahabat-kreator/contracts";
import { type TranslationKey } from "@sahabat-kreator/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import {
  FLOW_NODE_LABEL_KEYS,
  splitIssues,
  translateFlowIssue,
} from "../../flows/graphModel";
import { type Translate } from "./types";

export interface FlowSimulatorPanelProps {
  t: Translate;
  tenantId: string;
  flowId: string;
  /** Graf kanvas saat ini (termasuk suntingan yang belum disimpan). */
  graph: FlowGraph;
}

/** Label hasil langkah — kunci yang sama dengan panel run, ditambah "simulated" milik simulator. */
const STEP_OUTCOME_LABEL_KEYS: Record<string, string> = {
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
  payment_link_sent: "flows.stepOutcomePaymentLinkSent",
  replied: "flows.stepOutcomeReplied",
  timeout: "flows.stepOutcomeTimeout",
  question_asked: "flows.stepOutcomeQuestionAsked",
  completed: "flows.stepOutcomeCompleted",
  catalog_shown: "flows.stepOutcomeCatalogShown",
  empty_cart: "flows.stepOutcomeEmptyCart",
  checked_out: "flows.stepOutcomeCheckedOut",
  simulated: "flows.simOutcomeSimulated",
};

const PARK_REASON_KEYS: Record<string, string> = {
  waiting_for_reply: "flows.simParkWaitingForReply",
  waiting_for_questionnaire_answer: "flows.simParkQuestionnaire",
  waiting_for_catalog_choice: "flows.simParkCatalog",
  waiting_for_slot_choice: "flows.simParkAppointment",
};

const EFFECT_KIND_KEYS: Record<string, string> = {
  send_message: "flows.simEffectSendMessage",
  delay: "flows.simEffectDelay",
  add_tag: "flows.simEffectAddTag",
  remove_tag: "flows.simEffectRemoveTag",
  set_stage: "flows.simEffectSetStage",
  set_field: "flows.simEffectSetField",
  enroll_sequence: "flows.simEffectEnrollSequence",
  create_deal: "flows.simEffectCreateDeal",
  move_deal_stage: "flows.simEffectMoveDealStage",
  goto_flow: "flows.simEffectGotoFlow",
  handoff: "flows.simEffectHandoff",
  ai_response: "flows.simEffectAiResponse",
  http_request: "flows.simEffectHttpRequest",
  payment_link: "flows.simEffectPaymentLink",
  catalog_message: "flows.simEffectCatalogMessage",
  checkout: "flows.simEffectCheckout",
  appointment_offer: "flows.simEffectAppointmentOffer",
  ad_conversion: "flows.simEffectAdConversion",
  park: "flows.simEffectPark",
};

const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-muted/60";
const labelClass = "block text-xs font-medium text-muted";

/**
 * Panel uji kering (G4): menjalankan interpreter simulator di server
 * atas graf kanvas saat ini (termasuk suntingan belum tersimpan) atau
 * snapshot versi tersimpan, dengan kontak mock yang bisa diatur.
 * Hasilnya jejak langkah + efek sebagai data — server tidak menulis
 * apa pun dan tidak mengirim apa pun; node yang tidak bisa
 * disimulasikan setia tampil ber-lencana "hanya dicatat".
 */
export function FlowSimulatorPanel({
  t,
  tenantId,
  flowId,
  graph,
}: FlowSimulatorPanelProps) {
  const [versions, setVersions] = useState<FlowVersionResponse[]>([]);
  const [source, setSource] = useState<"current" | number>("current");
  const [triggerText, setTriggerText] = useState("");
  const [name, setName] = useState("Sari Uji");
  const [tagsText, setTagsText] = useState("");
  const [stage, setStage] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [customText, setCustomText] = useState("");
  const [cartItems, setCartItems] = useState("0");
  const [replyText, setReplyText] = useState("");
  const [splitChoices, setSplitChoices] = useState<
    Record<string, "a" | "b">
  >({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FlowSimulateResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.flows.listVersions(tenantId, flowId);
        if (!cancelled) setVersions(res.versions);
      } catch {
        // Versi hanya opsi sumber tambahan — kegagalan memuatnya
        // tidak boleh mematikan panel (sumber kanvas tetap jalan).
        if (!cancelled) setVersions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, flowId]);

  const splitNodes = useMemo(
    () => graph.nodes.filter((n) => n.type === "ab_split"),
    [graph],
  );

  const nodeLabel = useCallback(
    (nodeId: string, nodeType: string): string => {
      const node = graph.nodes.find((n) => n.id === nodeId);
      const type = node?.type ?? nodeType;
      const key = FLOW_NODE_LABEL_KEYS[type as keyof typeof FLOW_NODE_LABEL_KEYS];
      return key ? t(key) : type;
    },
    [graph, t],
  );

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const tags = tagsText
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
      const customFields: Record<string, unknown> = {};
      for (const line of customText.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (key) customFields[key] = line.slice(eq + 1).trim();
      }
      const cartItemCount = Number.parseInt(cartItems, 10);
      const choices: Record<string, "a" | "b"> = {};
      if (source === "current") {
        for (const [nodeId, choice] of Object.entries(splitChoices)) {
          choices[nodeId] = choice;
        }
      }
      const body: FlowSimulateRequest = {
        ...(source === "current" ? { graph } : { version: source }),
        triggerText,
        contact: {
          name,
          tags,
          stage: stage.trim() ? stage.trim() : null,
          phone: phone.trim() ? phone.trim() : null,
          email: email.trim() ? email.trim() : null,
          customFields,
          cartItemCount:
            Number.isFinite(cartItemCount) && cartItemCount > 0
              ? Math.floor(cartItemCount)
              : 0,
        },
        ...(replyText.trim() ? { replyText } : {}),
        ...(Object.keys(choices).length > 0
          ? { splitChoices: choices }
          : {}),
      };
      const res = await api.flows.simulate(tenantId, flowId, body);
      setResult(res);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setRunning(false);
    }
  };

  const stepLine = (step: FlowSimulateStep): string => {
    const d = step.detail ?? {};
    const outcome = typeof d.outcome === "string" ? d.outcome : "";
    const key = STEP_OUTCOME_LABEL_KEYS[outcome];
    const parts: string[] = [
      key ? t(key as TranslationKey) : outcome || step.nodeType,
    ];
    if (outcome === "evaluated") {
      parts.push(
        d.result === true ? t("flows.stepResultYes") : t("flows.stepResultNo"),
      );
    }
    if (outcome === "split" && typeof d.branch === "string") {
      parts.push(`→ ${d.branch.toUpperCase()}`);
    }
    if (typeof d.error === "string" && d.error) parts.push(`— ${d.error}`);
    return parts.join(" ");
  };

  const effectSummary = (effect: FlowSimulateEffect): string => {
    const d = effect.data ?? {};
    switch (effect.kind) {
      case "delay":
        return `${String(d.amount ?? "")} ${String(d.unit ?? "")}`.trim();
      case "add_tag":
      case "remove_tag":
        return String(d.tag ?? "");
      case "set_stage":
        return String(d.stage ?? "");
      case "set_field":
        return `${String(d.field ?? "")} = ${String(d.value ?? "")}`;
      case "enroll_sequence":
        return String(d.automationId ?? "");
      case "create_deal":
        return String(d.title ?? "");
      case "move_deal_stage":
        return String(d.dealStageId ?? "");
      case "ad_conversion":
        return `${String(d.platform ?? "")} · ${String(d.eventName ?? "")}`.trim();
      case "goto_flow":
        return String(d.targetFlowId ?? "");
      case "http_request":
        return `${String(d.method ?? "")} ${String(d.url ?? "")}`.trim();
      case "payment_link":
        return String(d.productId ?? "");
      case "checkout":
        return `${String(d.itemCount ?? "")} item`;
      case "appointment_offer":
        return String(d.serviceId ?? "");
      case "park": {
        const reason = typeof d.reason === "string" ? d.reason : "";
        const key = PARK_REASON_KEYS[reason];
        return key ? t(key as TranslationKey) : reason;
      }
      default:
        return "";
    }
  };

  const effectText = (effect: FlowSimulateEffect): string | null => {
    if (
      (effect.kind === "send_message" || effect.kind === "catalog_message") &&
      typeof effect.data.text === "string"
    ) {
      return effect.data.text;
    }
    return null;
  };

  const statusBanner = result
    ? result.status === "completed"
      ? { cls: "bg-success/10 text-success", text: t("flows.simStatusCompleted") }
      : result.status === "parked"
        ? { cls: "bg-warning/10 text-warning", text: t("flows.simStatusParked") }
        : result.status === "failed"
          ? { cls: "bg-danger/10 text-danger", text: t("flows.simStatusFailed") }
          : {
              cls: "bg-warning/10 text-warning",
              text: t("flows.simStatusNotMatched"),
            }
    : null;

  const resultIssues = result ? splitIssues(result.issues) : null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">{t("flows.simTitle")}</h3>
      <p className="mt-1 max-w-2xl text-xs text-muted">{t("flows.simHint")}</p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className={labelClass} htmlFor="sim-source">
              {t("flows.simSourceLabel")}
            </label>
            <select
              id="sim-source"
              value={source === "current" ? "current" : String(source)}
              onChange={(e) =>
                setSource(
                  e.target.value === "current"
                    ? "current"
                    : Number.parseInt(e.target.value, 10),
                )
              }
              className={inputClass}
            >
              <option value="current">{t("flows.simSourceCurrent")}</option>
              {versions.map((v) => (
                <option key={v.id} value={String(v.version)}>
                  {t("flows.simSourceVersion", { version: v.version })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="sim-trigger">
              {t("flows.simTriggerLabel")}
            </label>
            <input
              id="sim-trigger"
              value={triggerText}
              onChange={(e) => setTriggerText(e.target.value)}
              placeholder={t("flows.simTriggerPlaceholder")}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="sim-reply">
              {t("flows.simReplyLabel")}
            </label>
            <input
              id="sim-reply"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={t("flows.simReplyPlaceholder")}
              className={inputClass}
            />
          </div>
          {source === "current" && splitNodes.length > 0 ? (
            <fieldset>
              <legend className={labelClass}>{t("flows.simSplitLegend")}</legend>
              <div className="mt-1 space-y-2">
                {splitNodes.map((n) => (
                  <div key={n.id} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm text-ink">
                      {nodeLabel(n.id, n.type)}
                    </span>
                    <select
                      value={splitChoices[n.id] ?? "auto"}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSplitChoices((prev) => {
                          const next = { ...prev };
                          if (v === "a" || v === "b") next[n.id] = v;
                          else delete next[n.id];
                          return next;
                        });
                      }}
                      className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink"
                    >
                      <option value="auto">{t("flows.simSplitAuto")}</option>
                      <option value="a">A</option>
                      <option value="b">B</option>
                    </select>
                  </div>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>

        <fieldset className="space-y-3">
          <legend className={labelClass}>{t("flows.simContactLegend")}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="sim-name">
                {t("flows.simNameLabel")}
              </label>
              <input
                id="sim-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="sim-stage">
                {t("flows.simStageLabel")}
              </label>
              <input
                id="sim-stage"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="sim-phone">
                {t("flows.simPhoneLabel")}
              </label>
              <input
                id="sim-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="sim-email">
                {t("flows.simEmailLabel")}
              </label>
              <input
                id="sim-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="sim-tags">
              {t("flows.simTagsLabel")}
            </label>
            <input
              id="sim-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="sim-custom">
              {t("flows.simCustomLabel")}
            </label>
            <textarea
              id="sim-custom"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="sim-cart">
              {t("flows.simCartLabel")}
            </label>
            <input
              id="sim-cart"
              type="number"
              min={0}
              value={cartItems}
              onChange={(e) => setCartItems(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted">{t("flows.simCartHint")}</p>
          </div>
        </fieldset>
      </div>

      <div className="mt-4">
        <button
          type="button"
          disabled={running}
          onClick={() => void run()}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {running ? t("flows.simRunning") : t("flows.simRunButton")}
        </button>
      </div>

      {error ? (
        <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {result && statusBanner ? (
        <div className="mt-4 space-y-4">
          <p
            className={`rounded-lg px-3 py-2 text-sm font-medium ${statusBanner.cls}`}
          >
            {statusBanner.text}
            {result.status === "parked" && result.parkReason ? (
              <span className="block text-xs font-normal">
                {(() => {
                  const key = PARK_REASON_KEYS[result.parkReason];
                  return key ? t(key as TranslationKey) : result.parkReason;
                })()}
                {result.parkedNodeId
                  ? ` · ${t("flows.simParkNodeLabel")}: ${nodeLabel(result.parkedNodeId, "")}`
                  : ""}
              </span>
            ) : null}
            {result.status === "failed" && result.failReason ? (
              <span className="block text-xs font-normal">
                {t("flows.simFailReasonLabel")}: {result.failReason}
              </span>
            ) : null}
          </p>

          {resultIssues &&
          (resultIssues.errors.length > 0 || resultIssues.warnings.length > 0) ? (
            <div className="rounded-lg bg-warning/5 px-3 py-2">
              <p className="text-sm font-semibold text-warning">
                {t("flows.simIssuesTitle")}
              </p>
              <ul className="mt-1 space-y-1">
                {[...resultIssues.errors, ...resultIssues.warnings].map(
                  (issue, i) => (
                    <li
                      key={`${issue.code}-${issue.nodeId ?? ""}-${i}`}
                      className="text-xs text-muted"
                    >
                      <span
                        className={
                          issue.severity === "error"
                            ? "font-medium text-danger"
                            : "font-medium text-warning"
                        }
                      >
                        {issue.code}
                      </span>{" "}
                      {translateFlowIssue(t, issue)}
                      {issue.nodeId
                        ? ` · ${nodeLabel(issue.nodeId, "")}`
                        : ""}
                    </li>
                  ),
                )}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold text-ink">
                {t("flows.simStepsTitle")}
              </h4>
              {result.steps.length === 0 ? (
                <p className="mt-2 text-sm text-muted">—</p>
              ) : (
                <ol className="mt-2 space-y-1.5">
                  {result.steps.map((step) => (
                    <li
                      key={step.seq}
                      className="rounded-lg border border-line px-3 py-2"
                    >
                      <span className="text-xs text-muted">#{step.seq}</span>{" "}
                      <span className="text-sm font-medium text-ink">
                        {nodeLabel(step.nodeId, step.nodeType)}
                      </span>
                      <span className="block text-xs text-muted">
                        {stepLine(step)}
                      </span>
                      {typeof step.detail.text === "string" ? (
                        <span className="mt-1 block whitespace-pre-wrap rounded bg-elevated px-2 py-1 text-xs text-ink">
                          {step.detail.text}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div>
              <h4 className="text-sm font-semibold text-ink">
                {t("flows.simEffectsTitle")}
              </h4>
              {result.effects.length === 0 ? (
                <p className="mt-2 text-sm text-muted">
                  {t("flows.simEffectsEmpty")}
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {result.effects.map((effect, i) => {
                    const kindKey = EFFECT_KIND_KEYS[effect.kind];
                    const text = effectText(effect);
                    const summary = effectSummary(effect);
                    return (
                      <li
                        key={`${effect.nodeId}-${effect.kind}-${i}`}
                        className="rounded-lg border border-line px-3 py-2"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-ink">
                            {kindKey
                              ? t(kindKey as TranslationKey)
                              : effect.kind}
                          </span>
                          {effect.fidelity === "recorded" ? (
                            <span className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                              {t("flows.simRecordedBadge")}
                            </span>
                          ) : null}
                          <span className="text-xs text-muted">
                            {nodeLabel(effect.nodeId, "")}
                          </span>
                        </span>
                        {summary ? (
                          <span className="block truncate text-xs text-muted">
                            {summary}
                          </span>
                        ) : null}
                        {text ? (
                          <span className="mt-1 block whitespace-pre-wrap rounded bg-elevated px-2 py-1 text-xs text-ink">
                            {text}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              <h4 className="mt-4 text-sm font-semibold text-ink">
                {t("flows.simFinalContactTitle")}
              </h4>
              <div className="mt-2 rounded-lg border border-line px-3 py-2 text-xs text-muted">
                <p>
                  {t("flows.simNameLabel")}:{" "}
                  <span className="text-ink">{result.contact.name || "—"}</span>
                </p>
                <p>
                  {t("flows.simTagsLabel")}:{" "}
                  <span className="text-ink">
                    {result.contact.tags.length > 0
                      ? result.contact.tags.join(", ")
                      : t("flows.simNoTags")}
                  </span>
                </p>
                <p>
                  {t("flows.simStageLabel")}:{" "}
                  <span className="text-ink">{result.contact.stage ?? "—"}</span>
                </p>
                {Object.keys(result.contact.customFields).length > 0 ? (
                  <p className="whitespace-pre-wrap">
                    {JSON.stringify(result.contact.customFields, null, 1)}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
