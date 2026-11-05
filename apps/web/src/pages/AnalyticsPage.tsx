import { useCallback, useEffect, useState } from "react";
import type { AiUsageReportResponse } from "@sahabat-kreator/contracts";
import {
  formatNumber,
  type Locale,
  type TranslationKey,
} from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError } from "../components/AuthLayout";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

const DAY_OPTIONS = [7, 30, 90] as const;

function formatCost(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale === "id" ? "id-ID" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

interface AnalyticsPageProps {
  t: Translate;
  locale: Locale;
}

/**
 * Halaman Analitik (Fase 9B) — dasbor pemakaian AI: ringkasan respons &
 * token agent dari GET /tenants/:id/analytics/ai-usage, deret harian,
 * rincian per agent, dan pemakaian cap harian. Biaya yang tampil adalah
 * biaya AKTUAL terlapor provider (dengan catatan cakupannya); respons
 * warisan tanpa rincian ditandai jujur, tidak diestimasi.
 */
export function AnalyticsPage({ t, locale }: AnalyticsPageProps) {
  const { status, tenants, active, reload } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<AiUsageReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const body = await api.analytics.aiUsage(tenantId, days);
      setReport(body);
    } catch (err) {
      setError(translateApiError(t, err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId, days, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("analytics.title")}</h1>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("analytics.title")}</h1>
        <div className="mt-6 rounded-xl border border-line bg-surface p-6">
          <p className="text-sm text-danger">{t("workspace.loadError")}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-3 rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.retry")}
          </button>
        </div>
      </section>
    );
  }
  if (tenants.length === 0 || !active) {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("analytics.title")}</h1>
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-6">
          <h2 className="text-lg font-semibold text-ink">{t("workspace.emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted">{t("workspace.emptyBody")}</p>
        </div>
      </section>
    );
  }

  const num = (v: number) => formatNumber(v, locale);
  const capPct = report
    ? Math.min(100, Math.round((report.cap.usedToday / report.cap.dailyLimit) * 100))
    : 0;

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t("analytics.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t("analytics.subtitle")}</p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label={t("analytics.daysLabel")}>
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                days === d ? "bg-accent text-white" : "bg-elevated text-ink"
              }`}
            >
              {t(`analytics.days${d}` as TranslationKey)}
            </button>
          ))}
        </div>
      </div>

      <FieldError message={error ?? (report === null && !loading ? t("analytics.loadError") : null)} />

      {loading && !report ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : report && report.responses === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <h2 className="text-base font-semibold text-ink">{t("analytics.emptyTitle")}</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">{t("analytics.emptyBody")}</p>
        </div>
      ) : report ? (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-xs font-medium text-muted">{t("analytics.responsesLabel")}</p>
              <p className="mt-1 text-2xl font-bold text-ink">{num(report.responses)}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-xs font-medium text-muted">{t("analytics.tokensInLabel")}</p>
              <p className="mt-1 text-2xl font-bold text-ink">{num(report.tokensIn)}</p>
              <p className="mt-1 text-xs text-muted">
                {t("analytics.tokensTotalLabel")}: {num(report.tokensTotal)}
              </p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-xs font-medium text-muted">{t("analytics.tokensOutLabel")}</p>
              <p className="mt-1 text-2xl font-bold text-ink">{num(report.tokensOut)}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-xs font-medium text-muted">{t("analytics.costLabel")}</p>
              <p className="mt-1 text-2xl font-bold text-ink">
                {report.costUsd !== null ? formatCost(locale, report.costUsd) : t("analytics.costNone")}
              </p>
              <p className="mt-1 text-xs text-muted">
                {t("analytics.costCoverage", {
                  reported: num(report.costReportedResponses),
                  total: num(report.responses),
                })}
              </p>
            </div>
          </div>

          {report.undetailedResponses > 0 ? (
            <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-xs text-muted">
              {t("analytics.undetailedNote", { count: num(report.undetailedResponses) })}
            </p>
          ) : null}

          <div className="mt-3 rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">{t("analytics.capTitle")}</h2>
              <p className="text-xs text-muted">
                {t("analytics.capBody", {
                  used: num(report.cap.usedToday),
                  limit: num(report.cap.dailyLimit),
                  remaining: num(report.cap.remainingToday),
                })}
              </p>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-elevated">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${capPct}%` }}
              />
            </div>
          </div>

          <h2 className="mt-8 text-base font-semibold text-ink">{t("analytics.perAgentTitle")}</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="px-4 py-2 font-medium">{t("analytics.agentName")}</th>
                  <th className="px-4 py-2 font-medium">{t("analytics.agentModels")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("analytics.dailyResponses")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("analytics.dailyTokensIn")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("analytics.dailyTokensOut")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("analytics.dailyCost")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {report.perAgent.map((row, i) => (
                  <tr key={row.agentId ?? `legacy-${i}`}>
                    <td className="px-4 py-2 font-medium text-ink">
                      {row.agentId === null
                        ? t("analytics.agentLegacy")
                        : (row.agentName ?? t("analytics.agentUnknown"))}
                    </td>
                    <td className="px-4 py-2 text-muted">{row.models.join(", ") || "—"}</td>
                    <td className="px-4 py-2 text-right text-ink">{num(row.responses)}</td>
                    <td className="px-4 py-2 text-right text-ink">{num(row.tokensIn)}</td>
                    <td className="px-4 py-2 text-right text-ink">{num(row.tokensOut)}</td>
                    <td className="px-4 py-2 text-right text-ink">
                      {row.costUsd !== null ? formatCost(locale, row.costUsd) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt-8 text-base font-semibold text-ink">{t("analytics.dailyTitle")}</h2>
          <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="px-4 py-2 font-medium">{t("analytics.dailyDate")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("analytics.dailyResponses")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("analytics.dailyTokensIn")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("analytics.dailyTokensOut")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("analytics.dailyCost")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {[...report.daily].reverse().map((row) => (
                  <tr key={row.date} className={row.responses === 0 ? "text-muted" : ""}>
                    <td className="px-4 py-2 font-medium">{row.date}</td>
                    <td className="px-4 py-2 text-right">{num(row.responses)}</td>
                    <td className="px-4 py-2 text-right">{num(row.tokensIn)}</td>
                    <td className="px-4 py-2 text-right">{num(row.tokensOut)}</td>
                    <td className="px-4 py-2 text-right">
                      {row.costUsd !== null ? formatCost(locale, row.costUsd) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
