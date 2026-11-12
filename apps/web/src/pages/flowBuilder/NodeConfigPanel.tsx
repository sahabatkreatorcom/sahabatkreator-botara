/**
 * Panel konfigurasi per tipe node — bentuknya persis kontrak 8A.
 *
 * Berkas ini sengaja tetap satu komponen: setiap cabang `type === ...`
 * membaca dan menulis potongan `config` yang sama lewat `set()`, dan
 * memecahnya per tipe akan menyebarkan satu kontrak ke belasan berkas
 * tanpa memisahkan tanggung jawab apa pun.
 */
import { META_STANDARD_EVENT_NAMES, type AppointmentServiceResponse, type AutomationResponse, type ChannelAccountResponse, type FlowResponse, type FlowWebhookTriggerResponse, type ProductResponse, type TeamMemberResponse } from "@sahabat-kreator/contracts";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { FLOW_NODE_LABEL_KEYS } from "../../flows/graphModel";
import { CUSTOM_FIELD_OPTION_LABEL, KNOWN_STAGES, stageLabel } from "./graph";
import { type FlowRfNode, type Translate } from "./types";

/** Satu tahap deal untuk pemilih node deals (G12) — nama pipeline ikut agar tahap dari pipeline berbeda bisa dibedakan. */
export interface DealStageOption {
  id: string;
  name: string;
  pipelineName: string;
  kind: "open" | "won" | "lost";
}

export interface TenantMeta {
  tags: string[];
  stages: string[];
  sequences: AutomationResponse[];
  /** Tahap deal semua pipeline tenant (pemilih create_deal/move_deal_stage, G12). */
  dealStages: DealStageOption[];
  /** Member tenant (pemilih assignee create_deal, G12). */
  members: TeamMemberResponse[];
  /** Flow AKTIF tenant (pemilih goto_flow); flow yang diedit ditambah terpisah. */
  flows: FlowResponse[];
  /** Flow yang sedang diedit (boleh jadi tujuan goto dirinya sendiri). */
  selfFlow: { id: string; name: string } | null;
  /** Produk aktif tenant (pemilih send_payment_link). */
  products: ProductResponse[];
  /** Akun channel tenant (pemilih akun penampung run pemicu webhook, G17). */
  channelAccounts: ChannelAccountResponse[];
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

export interface NodeConfigPanelProps {
  t: Translate;
  node: FlowRfNode;
  /** Semua node di kanvas — untuk pemilih titik konversi eksperimen. */
  allNodes: FlowRfNode[];
  meta: TenantMeta;
  readOnly: boolean;
  /** Konteks flow untuk panel yang bicara ke API per-flow (webhook G17). */
  tenantId: string;
  flowId: string;
  onChange: (nodeId: string, config: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
}

export const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink disabled:opacity-60";
export const labelClass = "block text-sm font-medium text-ink";

/** Panel konfigurasi per tipe node — bentuknya persis kontrak 8A. */
export function NodeConfigPanel({
  t,
  node,
  allNodes,
  meta,
  readOnly,
  tenantId,
  flowId,
  onChange,
  onDelete,
}: NodeConfigPanelProps) {
  const type = node.data.nodeType;
  const config = node.data.config;
  const set = (patch: Record<string, unknown>) =>
    onChange(node.id, { ...config, ...patch });
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // G18: daftar tombol aksi node send_action_buttons (bentuk config
  // kanonis contracts; dibaca defensif seperti config lain).
  const actionButtonsOf = (
    cfg: Record<string, unknown>,
  ): Array<{ kind: "copy_text" | "call"; label: string; value: string }> => {
    if (!Array.isArray(cfg.buttons)) return [];
    return cfg.buttons
      .filter(
        (b): b is Record<string, unknown> =>
          !!b && typeof b === "object",
      )
      .map((b) => ({
        kind: b.kind === "call" ? ("call" as const) : ("copy_text" as const),
        label: typeof b.label === "string" ? b.label : "",
        value: typeof b.value === "string" ? b.value : "",
      }));
  };
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
                  ["postback", "flows.triggerKindPostback"],
                  ["quick_reply", "flows.triggerKindQuickReply"],
                  ["welcome", "flows.triggerKindWelcome"],
                  ["webhook", "flows.triggerKindWebhook"],
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
                          : kind === "postback" || kind === "quick_reply"
                            ? {
                                kind,
                                payloads: Array.isArray(config.payloads)
                                  ? config.payloads
                                  : [],
                              }
                            : kind === "webhook"
                              ? {
                                  kind,
                                  channelAccountId:
                                    typeof config.channelAccountId === "string"
                                      ? config.channelAccountId
                                      : "",
                                }
                              : { kind },
                      )
                    }
                  />
                  {t(key)}
                </label>
              ))}
            </div>
          </div>
          {config.kind === "postback" || config.kind === "quick_reply" ? (
            <div>
              <label className={labelClass} htmlFor="cfg-payloads">
                {t("flows.triggerPayloadsLabel")}
              </label>
              <textarea
                id="cfg-payloads"
                className={inputClass}
                rows={3}
                disabled={readOnly}
                value={
                  Array.isArray(config.payloads)
                    ? config.payloads
                        .filter((k): k is string => typeof k === "string")
                        .join("\n")
                    : ""
                }
                onChange={(e) =>
                  set({
                    payloads: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
              <p className="mt-1 text-xs text-muted">
                {t("flows.triggerPayloadsHint")}
              </p>
            </div>
          ) : null}
          {config.kind === "welcome" ? (
            <p className="text-xs text-muted">
              {t("flows.triggerWelcomeHint")}
            </p>
          ) : null}
          {config.kind === "webhook" ? (
            <>
              <div>
                <label className={labelClass} htmlFor="cfg-webhook-account">
                  {t("flows.triggerWebhookAccountLabel")}
                </label>
                <select
                  id="cfg-webhook-account"
                  className={inputClass}
                  disabled={readOnly}
                  value={str(config.channelAccountId)}
                  onChange={(e) => set({ channelAccountId: e.target.value })}
                >
                  <option value="">—</option>
                  {meta.channelAccounts
                    .filter((a) =>
                      ["whatsapp", "messenger", "instagram", "telegram", "webchat"].includes(
                        a.provider,
                      ),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName} ({a.provider})
                      </option>
                    ))}
                </select>
                <p className="mt-1 text-xs text-muted">
                  {t("flows.triggerWebhookAccountHint")}
                </p>
              </div>
              <p className="text-xs text-muted">
                {t("flows.triggerWebhookPayloadHint")}
              </p>
              <WebhookTriggerPanel
                t={t}
                tenantId={tenantId}
                flowId={flowId}
                readOnly={readOnly}
              />
            </>
          ) : null}
          {config.kind === undefined || config.kind === "keyword" ? (
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

      {type === "create_deal" || type === "move_deal_stage" ? (
        <div>
          <label className={labelClass} htmlFor="cfg-deal-stage">
            {t("flows.dealStageLabel")}
          </label>
          {meta.dealStages.length === 0 ? (
            <p className="text-sm text-muted">{t("flows.dealStageNone")}</p>
          ) : (
            <select
              id="cfg-deal-stage"
              className={inputClass}
              disabled={readOnly}
              value={str(config.dealStageId)}
              onChange={(e) => set({ dealStageId: e.target.value })}
            >
              <option value="">{t("flows.dealStagePlaceholder")}</option>
              {meta.dealStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.pipelineName} · {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      {type === "create_deal" ? (
        <>
          <div>
            <label className={labelClass} htmlFor="cfg-deal-title">
              {t("flows.dealTitleLabel")}
            </label>
            <input
              id="cfg-deal-title"
              className={inputClass}
              disabled={readOnly}
              placeholder={t("flows.dealTitlePlaceholder")}
              value={str(config.title)}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-deal-value">
              {t("flows.dealValueLabel")}
            </label>
            <input
              id="cfg-deal-value"
              className={inputClass}
              disabled={readOnly}
              type="number"
              min={0}
              step="any"
              value={
                typeof config.value === "number" ? String(config.value) : ""
              }
              onChange={(e) => {
                const raw = e.target.value.trim();
                const parsed = raw === "" ? undefined : Number(raw);
                set({
                  value:
                    parsed !== undefined && Number.isFinite(parsed) && parsed >= 0
                      ? parsed
                      : undefined,
                });
              }}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-deal-assignee">
              {t("flows.dealAssigneeLabel")}
            </label>
            <select
              id="cfg-deal-assignee"
              className={inputClass}
              disabled={readOnly}
              value={str(config.assigneeUserId)}
              onChange={(e) =>
                set({
                  assigneeUserId: e.target.value
                    ? e.target.value
                    : undefined,
                })
              }
            >
              <option value="">{t("flows.dealAssigneeUnassigned")}</option>
              {meta.members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : null}

      {type === "send_ad_conversion" ? (
        <>
          <p className="text-xs text-muted">{t("flows.adConversionNote")}</p>
          <div>
            <label className={labelClass} htmlFor="cfg-ad-platform">
              {t("flows.adPlatformLabel")}
            </label>
            <select
              id="cfg-ad-platform"
              className={inputClass}
              disabled={readOnly}
              value={str(config.platform) || "meta"}
              onChange={(e) => set({ platform: e.target.value })}
            >
              <option value="meta">{t("flows.adPlatformMeta")}</option>
              <option value="google">{t("flows.adPlatformGoogle")}</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-ad-event">
              {str(config.platform) === "google"
                ? t("flows.adEventNameLabelGoogle")
                : t("flows.adEventNameLabel")}
            </label>
            <input
              id="cfg-ad-event"
              className={inputClass}
              disabled={readOnly}
              placeholder={t("flows.adEventNamePlaceholder")}
              value={str(config.eventName)}
              onChange={(e) => set({ eventName: e.target.value })}
              list={
                str(config.platform) === "google"
                  ? undefined
                  : "cfg-ad-event-suggestions"
              }
            />
            {str(config.platform) === "google" ? null : (
              <datalist id="cfg-ad-event-suggestions">
                {META_STANDARD_EVENT_NAMES.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            )}
            <p className="mt-1 text-xs text-muted">
              {str(config.platform) === "google"
                ? t("flows.adEventNameHintGoogle")
                : t("flows.adEventNameHint")}
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-ad-value">
              {t("flows.adValueLabel")}
            </label>
            <input
              id="cfg-ad-value"
              className={inputClass}
              disabled={readOnly}
              type="number"
              min={0}
              step="any"
              value={
                typeof config.value === "number" ? String(config.value) : ""
              }
              onChange={(e) => {
                const raw = e.target.value.trim();
                const parsed = raw === "" ? undefined : Number(raw);
                set({
                  value:
                    parsed !== undefined &&
                    Number.isFinite(parsed) &&
                    parsed >= 0
                      ? parsed
                      : undefined,
                });
              }}
            />
            <p className="mt-1 text-xs text-muted">
              {t("flows.adValueHint")}
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-ad-currency">
              {t("flows.adCurrencyLabel")}
            </label>
            <input
              id="cfg-ad-currency"
              className={inputClass}
              disabled={readOnly}
              placeholder="IDR"
              maxLength={3}
              value={str(config.currency)}
              onChange={(e) =>
                set({
                  currency: e.target.value
                    ? e.target.value.toUpperCase()
                    : undefined,
                })
              }
            />
          </div>
        </>
      ) : null}

      {type === "send_dynamic_image" ? (
        <>
          <p className="text-xs text-muted">{t("flows.dynamicImageNote")}</p>
          <div>
            <label className={labelClass} htmlFor="cfg-dynimg-title">
              {t("flows.dynamicImageTitleLabel")}
            </label>
            <input
              id="cfg-dynimg-title"
              className={inputClass}
              maxLength={200}
              disabled={readOnly}
              placeholder={t("flows.dynamicImageTitlePlaceholder")}
              value={str(config.titleTemplate)}
              onChange={(e) => set({ titleTemplate: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-dynimg-body">
              {t("flows.dynamicImageBodyLabel")}
            </label>
            <textarea
              id="cfg-dynimg-body"
              className={inputClass}
              rows={3}
              maxLength={1000}
              disabled={readOnly}
              placeholder={t("flows.dynamicImageBodyPlaceholder")}
              value={str(config.bodyTemplate)}
              onChange={(e) =>
                set({
                  bodyTemplate: e.target.value ? e.target.value : undefined,
                })
              }
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-dynimg-caption">
              {t("flows.dynamicImageCaptionLabel")}
            </label>
            <textarea
              id="cfg-dynimg-caption"
              className={inputClass}
              rows={2}
              maxLength={1000}
              disabled={readOnly}
              value={str(config.captionTemplate)}
              onChange={(e) =>
                set({
                  captionTemplate: e.target.value
                    ? e.target.value
                    : undefined,
                })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="cfg-dynimg-bg">
                {t("flows.dynamicImageBgLabel")}
              </label>
              <input
                id="cfg-dynimg-bg"
                className={inputClass}
                maxLength={7}
                disabled={readOnly}
                placeholder="#261E42"
                value={str(config.backgroundColor)}
                onChange={(e) =>
                  set({
                    backgroundColor: e.target.value
                      ? e.target.value
                      : undefined,
                  })
                }
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="cfg-dynimg-accent">
                {t("flows.dynamicImageAccentLabel")}
              </label>
              <input
                id="cfg-dynimg-accent"
                className={inputClass}
                maxLength={7}
                disabled={readOnly}
                placeholder="#F5C542"
                value={str(config.accentColor)}
                onChange={(e) =>
                  set({
                    accentColor: e.target.value ? e.target.value : undefined,
                  })
                }
              />
            </div>
          </div>
          <p className="text-xs text-muted">{t("flows.dynamicImageLimits")}</p>
        </>
      ) : null}

      {type === "send_action_buttons" ? (
        <>
          <p className="text-xs text-muted">{t("flows.actionButtonsNote")}</p>
          <div>
            <label className={labelClass} htmlFor="cfg-ab-text">
              {t("flows.actionButtonsTextLabel")}
            </label>
            <textarea
              id="cfg-ab-text"
              className={inputClass}
              rows={3}
              maxLength={2000}
              disabled={readOnly}
              placeholder={t("flows.actionButtonsTextPlaceholder")}
              value={str(config.text)}
              onChange={(e) => set({ text: e.target.value })}
            />
          </div>
          {actionButtonsOf(config).map((button, index) => (
            <div
              key={index}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted">
                  {t("flows.actionButtonsButtonLabel", { index: index + 1 })}
                </span>
                {actionButtonsOf(config).length > 1 ? (
                  <button
                    type="button"
                    className="text-xs text-danger"
                    disabled={readOnly}
                    onClick={() =>
                      set({
                        buttons: actionButtonsOf(config).filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    {t("flows.actionButtonsRemove")}
                  </button>
                ) : null}
              </div>
              <select
                className={inputClass}
                disabled={readOnly}
                value={button.kind}
                onChange={(e) =>
                  set({
                    buttons: actionButtonsOf(config).map((b, i) =>
                      i === index
                        ? { ...b, kind: e.target.value as "copy_text" | "call" }
                        : b,
                    ),
                  })
                }
              >
                <option value="copy_text">
                  {t("flows.actionButtonsKindCopy")}
                </option>
                <option value="call">{t("flows.actionButtonsKindCall")}</option>
              </select>
              <input
                className={inputClass}
                maxLength={64}
                disabled={readOnly}
                placeholder={t("flows.actionButtonsLabelPlaceholder")}
                value={button.label}
                onChange={(e) =>
                  set({
                    buttons: actionButtonsOf(config).map((b, i) =>
                      i === index ? { ...b, label: e.target.value } : b,
                    ),
                  })
                }
              />
              <input
                className={inputClass}
                maxLength={320}
                disabled={readOnly}
                placeholder={
                  button.kind === "call"
                    ? t("flows.actionButtonsValueCallPlaceholder")
                    : t("flows.actionButtonsValueCopyPlaceholder")
                }
                value={button.value}
                onChange={(e) =>
                  set({
                    buttons: actionButtonsOf(config).map((b, i) =>
                      i === index ? { ...b, value: e.target.value } : b,
                    ),
                  })
                }
              />
            </div>
          ))}
          {actionButtonsOf(config).length < 3 ? (
            <button
              type="button"
              className="text-xs font-medium text-accent"
              disabled={readOnly}
              onClick={() =>
                set({
                  buttons: [
                    ...actionButtonsOf(config),
                    { kind: "call" as const, label: "", value: "" },
                  ],
                })
              }
            >
              {t("flows.actionButtonsAdd")}
            </button>
          ) : null}
          <p className="text-xs text-muted">{t("flows.actionButtonsLimits")}</p>
        </>
      ) : null}

      {type === "append_sheet_row" ? (
        <>
          <p className="text-xs text-muted">{t("flows.sheetNote")}</p>
          <div>
            <label className={labelClass} htmlFor="cfg-sheet-id">
              {t("flows.sheetIdLabel")}
            </label>
            <input
              id="cfg-sheet-id"
              className={inputClass}
              disabled={readOnly}
              value={str(config.spreadsheetId)}
              onChange={(e) => set({ spreadsheetId: e.target.value })}
            />
            <p className="mt-1 text-xs text-muted">
              {t("flows.sheetIdHint")}
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-sheet-name">
              {t("flows.sheetNameLabel")}
            </label>
            <input
              id="cfg-sheet-name"
              className={inputClass}
              disabled={readOnly}
              value={str(config.sheetName)}
              onChange={(e) =>
                set({
                  sheetName: e.target.value ? e.target.value : undefined,
                })
              }
            />
          </div>
          <div>
            <span className={labelClass}>{t("flows.sheetColumnsLabel")}</span>
            <div className="mt-2 space-y-2">
              {(Array.isArray(config.columns)
                ? (config.columns as { header?: unknown; value?: unknown }[])
                : []
              ).map((col, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <input
                    className={inputClass}
                    disabled={readOnly}
                    placeholder={t("flows.sheetColumnHeaderPlaceholder")}
                    value={typeof col.header === "string" ? col.header : ""}
                    onChange={(e) => {
                      const cols = [
                        ...(config.columns as Record<string, unknown>[]),
                      ];
                      cols[idx] = { ...cols[idx], header: e.target.value };
                      set({ columns: cols });
                    }}
                  />
                  <input
                    className={inputClass}
                    disabled={readOnly}
                    placeholder={t("flows.sheetColumnValuePlaceholder")}
                    value={typeof col.value === "string" ? col.value : ""}
                    onChange={(e) => {
                      const cols = [
                        ...(config.columns as Record<string, unknown>[]),
                      ];
                      cols[idx] = { ...cols[idx], value: e.target.value };
                      set({ columns: cols });
                    }}
                  />
                  {!readOnly ? (
                    <button
                      type="button"
                      className="rounded-lg border border-danger px-2 py-2 text-xs text-danger hover:bg-danger/10"
                      onClick={() => {
                        const cols = (
                          config.columns as Record<string, unknown>[]
                        ).filter((_, i) => i !== idx);
                        set({ columns: cols });
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {!readOnly ? (
              <button
                type="button"
                className="mt-2 rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface"
                onClick={() => {
                  const cols = Array.isArray(config.columns)
                    ? [...(config.columns as Record<string, unknown>[])]
                    : [];
                  cols.push({ header: "", value: "" });
                  set({ columns: cols });
                }}
              >
                {t("flows.sheetAddColumn")}
              </button>
            ) : null}
            <p className="mt-1 text-xs text-muted">
              {t("flows.sheetColumnsHint")}
            </p>
          </div>
        </>
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

      {type === "show_catalog" || type === "send_catalog" ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {t(
              type === "send_catalog"
                ? "flows.sendCatalogHint"
                : "flows.catalogHint",
            )}
          </p>
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

      {type === "cart_summary" ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">{t("flows.cartSummaryHint")}</p>
          <div>
            <label className={labelClass} htmlFor="cfg-cartsummary-empty">
              {t("flows.checkoutEmptyMessageLabel")}
            </label>
            <textarea
              id="cfg-cartsummary-empty"
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
          <div>
            <label className={labelClass} htmlFor="cfg-checkout-dcode">
              {t("flows.checkoutDiscountCodeLabel")}
            </label>
            <input
              id="cfg-checkout-dcode"
              className={inputClass}
              maxLength={64}
              disabled={readOnly}
              placeholder={t("flows.checkoutDiscountCodePlaceholder")}
              value={str(config.discountCode)}
              onChange={(e) => set({ discountCode: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-checkout-dfield">
              {t("flows.checkoutDiscountFieldLabel")}
            </label>
            <input
              id="cfg-checkout-dfield"
              className={inputClass}
              maxLength={80}
              disabled={readOnly}
              placeholder={t("flows.checkoutDiscountFieldPlaceholder")}
              value={str(config.discountCodeField)}
              onChange={(e) => set({ discountCodeField: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cfg-checkout-dinvalid">
              {t("flows.checkoutDiscountInvalidLabel")}
            </label>
            <textarea
              id="cfg-checkout-dinvalid"
              className={inputClass}
              rows={2}
              maxLength={1000}
              disabled={readOnly}
              placeholder={t("flows.checkoutDiscountInvalidPlaceholder")}
              value={str(config.discountInvalidMessage)}
              onChange={(e) =>
                set({ discountInvalidMessage: e.target.value })
              }
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

/**
 * Panel endpoint webhook pemicu (G17): menampilkan URL panggilan +
 * keadaan token, dan aksi provision/rotasi/hapus. Token terang hanya
 * tampil SEKALI di sini tepat sesudah rotasi (respons API adalah
 * satu-satunya tempat token keluar; server menyimpan hash saja).
 * Aksi token dibatasi peran oleh server (owner/admin); panel
 * menyembunyikan tombol saat readOnly.
 */
function WebhookTriggerPanel({
  t,
  tenantId,
  flowId,
  readOnly,
}: {
  t: Translate;
  tenantId: string;
  flowId: string;
  readOnly: boolean;
}) {
  const [state, setState] = useState<FlowWebhookTriggerResponse | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .flows.getWebhookTrigger(tenantId, flowId)
      .then((res) => {
        if (!cancelled) setState(res);
      })
      .catch((err) => {
        if (!cancelled) setError(translateApiError(t, err));
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, flowId, t]);

  const url =
    state?.endpointId && typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/flow/${state.endpointId}`
      : null;

  const rotate = async () => {
    if (state?.configured && !window.confirm(t("flows.triggerWebhookRotateConfirm"))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.flows.rotateWebhookTrigger(tenantId, flowId);
      setState(res);
      setFreshToken(res.token);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t("flows.triggerWebhookDeleteConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.flows.deleteWebhookTrigger(tenantId, flowId);
      setState(res);
      setFreshToken(null);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-3">
      <h4 className="text-sm font-semibold text-ink">
        {t("flows.triggerWebhookPanelTitle")}
      </h4>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {state && !state.configured ? (
        <p className="text-xs text-muted">
          {t("flows.triggerWebhookNotConfigured")}
        </p>
      ) : null}
      {url ? (
        <div>
          <span className={labelClass}>{t("flows.triggerWebhookUrlLabel")}</span>
          <input className={inputClass} readOnly value={url} />
        </div>
      ) : null}
      {state?.configured ? (
        <p className="text-xs text-muted">
          {t("flows.triggerWebhookPrefixLabel")}:{" "}
          <span className="font-mono">{state.tokenPrefix}…</span> ·{" "}
          {t("flows.triggerWebhookLastLabel")}:{" "}
          {state.lastTriggeredAt
            ? new Date(state.lastTriggeredAt).toLocaleString()
            : t("flows.triggerWebhookNever")}
        </p>
      ) : null}
      {freshToken ? (
        <div>
          <label className={labelClass} htmlFor="cfg-webhook-token">
            {t("flows.triggerWebhookTokenLabel")}
          </label>
          <input
            id="cfg-webhook-token"
            className={inputClass}
            readOnly
            value={freshToken}
            onFocus={(e) => e.target.select()}
          />
          <p className="mt-1 text-xs text-muted">
            {t("flows.triggerWebhookTokenHint")}
          </p>
        </div>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !state}
            onClick={() => void rotate()}
            className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface"
          >
            {state?.configured
              ? t("flows.triggerWebhookRotate")
              : t("flows.triggerWebhookCreate")}
          </button>
          {state?.configured ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="rounded-lg border border-danger px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10"
            >
              {t("flows.triggerWebhookDelete")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
