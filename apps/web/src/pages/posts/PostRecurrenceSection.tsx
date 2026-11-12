/**
 * Seksi "Jadwal berulang postingan" pada halaman Posts (S2).
 *
 * Daftar aturan + status + slot berikutnya, aksi jeda/lanjut/batal
 * (konfirmasi dua langkah sebaris, pola yang sama seperti G9),
 * riwayat ledger per aturan, dan formulir buat
 * (PostRecurrenceForm). Postingan anak yang lahir dari aturan
 * tampil di kalender/daftar postingan biasa di atas — seksi ini
 * hanya mengelola ATURANNYA.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  PostRecurrenceOccurrenceResponse,
  PostRecurrenceRuleResponse,
  PostRecurrenceStatus,
} from "@sahabat-kreator/contracts";
import type {
  Locale,
  TranslationKey,
  createTranslator,
} from "@sahabat-kreator/i18n";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { formatDateTime } from "../../utils/format";
import { PostRecurrenceForm } from "./PostRecurrenceForm";

type Translate = ReturnType<typeof createTranslator>;

const RULE_STATUS_CHIP: Record<
  PostRecurrenceStatus,
  { labelKey: TranslationKey; className: string }
> = {
  active: {
    labelKey: "postRecurrence.statusActive",
    className: "bg-success-soft text-success",
  },
  paused: {
    labelKey: "postRecurrence.statusPaused",
    className: "bg-warning-soft text-warning",
  },
  completed: {
    labelKey: "postRecurrence.statusCompleted",
    className: "bg-surface-2 text-muted",
  },
  cancelled: {
    labelKey: "postRecurrence.statusCancelled",
    className: "bg-surface-2 text-muted",
  },
};

const OCCURRENCE_STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  created: "postRecurrence.occurrenceCreated",
  skipped: "postRecurrence.occurrenceSkipped",
  missed: "postRecurrence.occurrenceMissed",
  claimed: "postRecurrence.occurrenceClaimed",
};

const OCCURRENCE_REASON_LABEL_KEYS: Record<string, TranslationKey> = {
  rule_paused: "postRecurrence.reasonRulePaused",
  slot_expired: "postRecurrence.reasonSlotExpired",
  claim_stale: "postRecurrence.reasonClaimStale",
  POST_TARGET_NOT_FOUND: "postRecurrence.reasonTargetNotFound",
  POST_TARGET_NOT_CONNECTED: "postRecurrence.reasonTargetNotConnected",
  POST_MEDIA_NOT_FOUND: "postRecurrence.reasonMediaNotFound",
  POST_MEDIA_TOO_MANY: "postRecurrence.reasonMediaTooMany",
  POST_MEDIA_REQUIRED: "postRecurrence.reasonMediaRequired",
  POST_PUBLISH_OPTIONS_REQUIRED: "postRecurrence.reasonOptionsRequired",
  POST_CONTENT_REQUIRED: "postRecurrence.reasonContentRequired",
};

export interface PostRecurrenceSectionProps {
  t: Translate;
  locale: Locale;
  tenantId: string | null;
  canManage: boolean;
  /** Sakelar persetujuan S1 tenant — untuk catatan perilaku di seksi ini. */
  approvalRequired: boolean;
}

export function PostRecurrenceSection({
  t,
  locale,
  tenantId,
  canManage,
  approvalRequired,
}: PostRecurrenceSectionProps) {
  const [rules, setRules] = useState<PostRecurrenceRuleResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
  const [occurrences, setOccurrences] = useState<
    PostRecurrenceOccurrenceResponse[]
  >([]);
  const [occurrencesCursor, setOccurrencesCursor] = useState<string | null>(
    null,
  );
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const page = await api.postRecurrences.list(tenantId, { limit: 50 });
      setRules(page.rules);
      setError(null);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (
    rule: PostRecurrenceRuleResponse,
    action: "pause" | "resume" | "cancel",
  ) => {
    if (!tenantId || busyId) return;
    if (action === "cancel" && confirming !== `cancel:${rule.id}`) {
      setConfirming(`cancel:${rule.id}`);
      return;
    }
    setConfirming(null);
    setBusyId(rule.id);
    setError(null);
    try {
      if (action === "pause") {
        await api.postRecurrences.pause(tenantId, rule.id);
      } else if (action === "resume") {
        await api.postRecurrences.resume(tenantId, rule.id);
      } else {
        await api.postRecurrences.cancel(tenantId, rule.id);
      }
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleHistory = async (ruleId: string) => {
    if (openHistoryId === ruleId) {
      setOpenHistoryId(null);
      return;
    }
    setOpenHistoryId(ruleId);
    setOccurrences([]);
    setOccurrencesCursor(null);
    if (!tenantId) return;
    setHistoryLoading(true);
    try {
      const page = await api.postRecurrences.listOccurrences(tenantId, ruleId, {
        limit: 20,
      });
      setOccurrences(page.occurrences);
      setOccurrencesCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadMoreOccurrences = async (ruleId: string) => {
    if (!tenantId || !occurrencesCursor) return;
    setHistoryLoading(true);
    try {
      const page = await api.postRecurrences.listOccurrences(tenantId, ruleId, {
        limit: 20,
        cursor: occurrencesCursor,
      });
      setOccurrences((prev) => [...prev, ...page.occurrences]);
      setOccurrencesCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setHistoryLoading(false);
    }
  };

  const patternSummary = (rule: PostRecurrenceRuleResponse): string => {
    const freqKey =
      rule.frequency === "daily"
        ? "postRecurrence.freqDaily"
        : rule.frequency === "weekly"
          ? "postRecurrence.freqWeekly"
          : "postRecurrence.freqMonthly";
    const parts: string[] = [t(freqKey)];
    if (rule.interval > 1) {
      parts.push(t("postRecurrence.everyN", { n: rule.interval }));
    }
    if (rule.frequency === "monthly") {
      parts.push(
        rule.lastDayOfMonth
          ? t("postRecurrence.lastDayOfMonth")
          : t("postRecurrence.dayOfMonth", { day: rule.dayOfMonth ?? "—" }),
      );
    }
    parts.push(rule.timezone);
    return parts.join(" · ");
  };

  const targetSummary = (rule: PostRecurrenceRuleResponse): string =>
    rule.targets
      .map(
        (target) =>
          target.conversationTitle ??
          target.channelDisplayName ??
          target.provider ??
          target.conversationId,
      )
      .join(", ");

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {t("postRecurrence.sectionTitle")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {t("postRecurrence.sectionSubtitle")}
          </p>
          {approvalRequired ? (
            <p className="mt-1 max-w-2xl text-sm text-warning">
              {t("postRecurrence.approvalNote")}
            </p>
          ) : null}
        </div>
        {canManage && !showForm ? (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2"
          >
            {t("postRecurrence.createButton")}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {showForm ? (
        <PostRecurrenceForm
          t={t}
          locale={locale}
          tenantId={tenantId}
          onDone={() => {
            setShowForm(false);
            void load();
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {loading ? (
        <p className="mt-4 text-sm text-muted">{t("workspace.loading")}</p>
      ) : rules.length === 0 ? (
        <div className="mt-4 rounded-xl border border-border bg-surface p-6 text-center">
          <p className="text-sm font-medium text-ink">
            {t("postRecurrence.empty")}
          </p>
          <p className="mt-1 text-sm text-muted">
            {t("postRecurrence.emptyHint")}
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {rules.map((rule) => {
            const chip = RULE_STATUS_CHIP[rule.status];
            return (
              <li
                key={rule.id}
                className="rounded-xl border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">
                    {rule.name}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip.className}`}
                  >
                    {t(chip.labelKey)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {t("postRecurrence.targetsLabel", {
                    targets: targetSummary(rule),
                  })}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {patternSummary(rule)}
                  {" · "}
                  {rule.status === "active" || rule.status === "paused"
                    ? rule.nextRunAt
                      ? t("postRecurrence.nextRun", {
                          when: formatDateTime(rule.nextRunAt, locale),
                        })
                      : t("postRecurrence.noNextRun")
                    : t("postRecurrence.noNextRun")}
                  {" · "}
                  {t("postRecurrence.createdCount", {
                    count: rule.occurrencesCreated,
                  })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void toggleHistory(rule.id)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
                  >
                    {openHistoryId === rule.id
                      ? t("postRecurrence.hideHistoryAction")
                      : t("postRecurrence.historyAction")}
                  </button>
                  {canManage && rule.status === "active" ? (
                    <button
                      type="button"
                      disabled={busyId === rule.id}
                      onClick={() => void act(rule, "pause")}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
                    >
                      {t("postRecurrence.pauseAction")}
                    </button>
                  ) : null}
                  {canManage && rule.status === "paused" ? (
                    <button
                      type="button"
                      disabled={busyId === rule.id}
                      onClick={() => void act(rule, "resume")}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      {t("postRecurrence.resumeAction")}
                    </button>
                  ) : null}
                  {canManage &&
                  (rule.status === "active" || rule.status === "paused") ? (
                    <button
                      type="button"
                      disabled={busyId === rule.id}
                      onClick={() => void act(rule, "cancel")}
                      className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
                    >
                      {confirming === `cancel:${rule.id}`
                        ? t("postRecurrence.confirmCancel")
                        : t("postRecurrence.cancelAction")}
                    </button>
                  ) : null}
                </div>

                {openHistoryId === rule.id ? (
                  <div className="mt-3 border-t border-border pt-3">
                    {historyLoading && occurrences.length === 0 ? (
                      <p className="text-sm text-muted">
                        {t("workspace.loading")}
                      </p>
                    ) : occurrences.length === 0 ? (
                      <p className="text-sm text-muted">
                        {t("postRecurrence.historyEmpty")}
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {occurrences.map((occ) => (
                          <li
                            key={occ.id}
                            className="flex flex-wrap items-center gap-2 text-xs text-muted"
                          >
                            <span className="font-medium text-ink">
                              {formatDateTime(occ.slotAt, locale)}
                            </span>
                            <span>
                              {t(
                                OCCURRENCE_STATUS_LABEL_KEYS[occ.status] ??
                                  "postRecurrence.occurrenceClaimed",
                              )}
                            </span>
                            {occ.reason ? (
                              <span>
                                —{" "}
                                {OCCURRENCE_REASON_LABEL_KEYS[occ.reason]
                                  ? t(OCCURRENCE_REASON_LABEL_KEYS[occ.reason])
                                  : occ.reason}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {occurrencesCursor ? (
                      <button
                        type="button"
                        disabled={historyLoading}
                        onClick={() => void loadMoreOccurrences(rule.id)}
                        className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
                      >
                        {t("postRecurrence.loadMore")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
