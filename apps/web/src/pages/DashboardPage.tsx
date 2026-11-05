import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSummaryResponse } from "@sahabat-kreator/contracts";
import {
  formatNumber,
  type Locale,
  type TranslationKey,
} from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { LIVE_REFRESH_INTERVAL_MS, usePolling } from "../hooks/usePolling";
import { useNudgeSubscription } from "../hooks/useRealtime";
import { CreateWorkspaceForm } from "../components/WorkspaceSwitcher";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface DashboardPageProps {
  t: Translate;
  locale: Locale;
}

const ROLE_KEYS: Record<string, TranslationKey> = {
  owner: "workspace.roles.owner",
  admin: "workspace.roles.admin",
  agent: "workspace.roles.agent",
  viewer: "workspace.roles.viewer",
};

/** Nama provider memakai kunci inbox yang sama dengan halaman lain. */
function providerLabel(t: Translate, provider: string): string {
  return t(`inbox.providers.${provider}` as TranslationKey);
}

/** Label hari pendek — titik deret kontrak berbasis hari UTC penuh. */
function weekdayLabel(iso: string, locale: Locale): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(d);
}

/** Satu kartu angka ringkas (label + nilai + warna semantik opsional). */
function StatCard({
  label,
  value,
  tone = "ink",
  locale,
}: {
  label: string;
  value: number;
  tone?: "ink" | "accent" | "warning" | "danger" | "muted";
  locale: Locale;
}) {
  const toneClass = {
    ink: "text-ink",
    accent: "text-accent",
    warning: "text-warning",
    danger: "text-danger",
    muted: "text-muted",
  }[tone];
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className={`text-2xl font-bold ${toneClass}`}>
        {formatNumber(value, locale)}
      </div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}

/** Bar chart pasang (masuk/keluar) per hari — CSS murni, tanpa pustaka. */
function ActivityChart({
  summary,
  locale,
  legendIn,
  legendOut,
}: {
  summary: DashboardSummaryResponse;
  locale: Locale;
  legendIn: string;
  legendOut: string;
}) {
  const daily = summary.activity.daily;
  const max = Math.max(1, ...daily.map((p) => Math.max(p.inbound, p.outbound)));
  return (
    <div>
      <div className="flex items-end gap-3">
        {daily.map((point) => {
          const title = `${point.date} — ${legendIn} ${formatNumber(
            point.inbound,
            locale,
          )} · ${legendOut} ${formatNumber(point.outbound, locale)}`;
          return (
            <div
              key={point.date}
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
            >
              <div
                className="flex h-28 w-full items-end justify-center gap-1"
                title={title}
              >
                <div
                  className="w-2.5 rounded-t bg-accent"
                  style={{
                    height: `${(point.inbound / max) * 100}%`,
                    minHeight: point.inbound > 0 ? 3 : 0,
                  }}
                />
                <div
                  className="w-2.5 rounded-t bg-elevated"
                  style={{
                    height: `${(point.outbound / max) * 100}%`,
                    minHeight: point.outbound > 0 ? 3 : 0,
                  }}
                />
              </div>
              <span className="text-[10px] text-muted">
                {weekdayLabel(point.date, locale)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-center gap-4 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" />
          {legendIn}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-elevated" />
          {legendOut}
        </span>
      </div>
    </div>
  );
}

/**
 * Dashboard (Fase 16A): ringkasan LIVE workspace aktif dari API.
 * - Belum punya workspace → keadaan kosong + form buat workspace di tempat.
 * - Sudah ada → angka nyata: kartu "butuh perhatian" (belum dibaca /
 *   terbuka >24 jam / pesan gagal), kesehatan channel per provider, dan
 *   denyut aktivitas 7 hari (pesan masuk/keluar, balasan agent vs manusia,
 *   kontak baru). Segar otomatis via polling + nudge realtime.
 */
export function DashboardPage({ t, locale }: DashboardPageProps) {
  const { status, tenants, active, reload } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [summary, setSummary] = useState<DashboardSummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const tenantRef = useRef<string | null>(tenantId);
  tenantRef.current = tenantId;

  const refresh = useCallback(async () => {
    const tid = tenantRef.current;
    if (!tid) {
      setSummary(null);
      setSummaryError(false);
      return;
    }
    try {
      const body = await api.dashboard.summary(tid);
      // Abaikan hasil basi bila workspace berganti saat fetch berjalan.
      if (tenantRef.current !== tid) return;
      setSummary(body);
      setSummaryError(false);
    } catch {
      if (tenantRef.current !== tid) return;
      setSummaryError(true);
    }
  }, []);

  useEffect(() => {
    setSummary(null);
    setSummaryError(false);
    void refresh();
  }, [tenantId, refresh]);

  // Segar berkala + nudge realtime (pola provider badge — Hotfix Realtime).
  usePolling(refresh, LIVE_REFRESH_INTERVAL_MS, tenantId !== null);
  useNudgeSubscription(() => {
    void refresh();
  });

  return (
    <section>
      <h1 className="text-2xl font-bold text-ink">{t("dashboard.title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("dashboard.subtitle")}</p>

      {status === "loading" ? (
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      ) : status === "error" ? (
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
      ) : tenants.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-6">
          <h2 className="text-lg font-semibold text-ink">{t("workspace.emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted">{t("workspace.emptyBody")}</p>
          <div className="mt-4 max-w-md">
            <CreateWorkspaceForm t={t} />
          </div>
        </div>
      ) : active ? (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3">
            <span className="text-sm font-semibold text-ink">
              {t("workspace.dashboardContext", { name: active.name })}
            </span>
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
              {t("workspace.yourRole", {
                role: t(ROLE_KEYS[active.role] ?? "workspace.roles.viewer"),
              })}
            </span>
          </div>

          {summaryError ? (
            <div className="mt-6 rounded-xl border border-line bg-surface p-6">
              <p className="text-sm text-danger">{t("dashboard.loadError")}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="mt-3 rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
              >
                {t("common.retry")}
              </button>
            </div>
          ) : summary === null ? (
            <p className="mt-6 text-sm text-muted">{t("dashboard.loadingSummary")}</p>
          ) : (
            <>
              {/* ---- Butuh perhatian ------------------------------------ */}
              <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">
                {t("dashboard.attentionTitle")}
              </h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatCard
                  label={t("dashboard.attentionUnread")}
                  value={summary.attention.unreadConversations}
                  tone={summary.attention.unreadConversations > 0 ? "accent" : "muted"}
                  locale={locale}
                />
                <StatCard
                  label={t("dashboard.attentionIdle")}
                  value={summary.attention.idleOpenConversations}
                  tone={summary.attention.idleOpenConversations > 0 ? "warning" : "muted"}
                  locale={locale}
                />
                <StatCard
                  label={t("dashboard.attentionFailed")}
                  value={summary.attention.failedMessages}
                  tone={summary.attention.failedMessages > 0 ? "danger" : "muted"}
                  locale={locale}
                />
              </div>
              <p className="mt-2 text-xs text-muted">{t("dashboard.attentionHint")}</p>

              {/* ---- Aktivitas 7 hari ----------------------------------- */}
              <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">
                {t("dashboard.activityTitle")}
              </h2>
              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
                <StatCard
                  label={t("dashboard.activityMessagesIn")}
                  value={summary.activity.messagesIn}
                  locale={locale}
                />
                <StatCard
                  label={t("dashboard.activityMessagesOut")}
                  value={summary.activity.messagesOut}
                  locale={locale}
                />
                <StatCard
                  label={t("dashboard.activityAgentReplies")}
                  value={summary.activity.agentReplies}
                  locale={locale}
                />
                <StatCard
                  label={t("dashboard.activityManualReplies")}
                  value={summary.activity.manualReplies}
                  locale={locale}
                />
                <StatCard
                  label={t("dashboard.activityNewContacts")}
                  value={summary.activity.newContacts}
                  locale={locale}
                />
              </div>
              <div className="mt-3 rounded-xl border border-line bg-surface p-4">
                <ActivityChart
                  summary={summary}
                  locale={locale}
                  legendIn={t("dashboard.chartLegendIn")}
                  legendOut={t("dashboard.chartLegendOut")}
                />
              </div>

              {/* ---- Kesehatan channel ---------------------------------- */}
              <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">
                {t("dashboard.channelsTitle")}
              </h2>
              {summary.channels.length === 0 ? (
                <p className="mt-3 rounded-xl border border-dashed border-line bg-surface p-4 text-sm text-muted">
                  {t("dashboard.channelsEmpty")}
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {summary.channels.map((channel) => (
                    <div
                      key={channel.provider}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3"
                    >
                      <span className="text-sm font-medium text-ink">
                        {providerLabel(t, channel.provider)}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 text-xs">
                        <span
                          className={
                            channel.connected > 0
                              ? "font-semibold text-success"
                              : "text-muted"
                          }
                        >
                          {t("dashboard.channelsConnected", {
                            n: channel.connected,
                          })}
                        </span>
                        {channel.disconnected > 0 ? (
                          <span className="text-warning">
                            {t("dashboard.channelsDisconnected", {
                              n: channel.disconnected,
                            })}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
