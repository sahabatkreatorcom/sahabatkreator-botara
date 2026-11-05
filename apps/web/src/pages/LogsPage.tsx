import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChannelAccountResponse,
  IntegrationLogDetailResponse,
  IntegrationLogResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api, ApiClientError } from "../api/client";
import { translateApiError } from "../api/errorText";
import { inputClassName } from "../components/AuthLayout";
import { ChannelAvatar } from "../components/ChannelAvatar";
import { FailedMessagesPanel } from "./FailedMessagesPanel";
import { usePolling } from "../hooks/usePolling";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface LogsPageProps {
  t: Translate;
  locale: Locale;
  /** Sesi platform admin → toggle event unresolved (tenant NULL) tampil. */
  isPlatformAdmin: boolean;
}

const PROVIDER_VALUES = [
  "telegram",
  "whatsapp",
  "instagram",
  "messenger",
  "meta",
  "webchat",
] as const;

const OUTCOME_VALUES = [
  "recorded",
  "duplicate",
  "ignored_disconnected",
  "ignored_echo",
  "ignored_status_only",
  "rejected_signature",
  "rejected_unconfigured",
  "unresolved_account",
  "error",
  "sent",
  "failed",
] as const;

type OutcomeValue = (typeof OUTCOME_VALUES)[number];

const OUTCOME_LABEL_KEYS: Record<OutcomeValue, TranslationKey> = {
  recorded: "logs.outcomeRecorded",
  duplicate: "logs.outcomeDuplicate",
  ignored_disconnected: "logs.outcomeIgnoredDisconnected",
  ignored_echo: "logs.outcomeIgnoredEcho",
  ignored_status_only: "logs.outcomeIgnoredStatusOnly",
  rejected_signature: "logs.outcomeRejectedSignature",
  rejected_unconfigured: "logs.outcomeRejectedUnconfigured",
  unresolved_account: "logs.outcomeUnresolvedAccount",
  error: "logs.outcomeError",
  sent: "logs.outcomeSent",
  failed: "logs.outcomeFailed",
};

/**
 * Kelayakan replay di sisi UI (cermin aturan server Fase 7B.2 — server
 * tetap penegak akhirnya): arah masuk, tanda tangan valid saat intake,
 * payload tersimpan, dan outcome yang belum final (`error` /
 * `ignored_disconnected`). Payload yang terpotong lolos saringan ini
 * tetapi ditolak server dengan LOG_PAYLOAD_TRUNCATED — pesan errornya
 * tampil di dialog konfirmasi.
 */
function isReplayEligible(row: IntegrationLogResponse): boolean {
  return (
    row.direction === "in" &&
    row.signatureValid === true &&
    row.hasPayload &&
    (row.outcome === "error" || row.outcome === "ignored_disconnected")
  );
}

/** Warna chip outcome mengikuti token semantik (pola StatusPill Channels). */
function outcomeChipClass(outcome: string): string {
  switch (outcome) {
    case "recorded":
    case "sent":
      return "bg-success/10 text-success";
    case "failed":
    case "error":
    case "rejected_signature":
    case "rejected_unconfigured":
      return "bg-danger/10 text-danger";
    case "unresolved_account":
      return "bg-warning/10 text-warning";
    default:
      return "bg-elevated text-muted";
  }
}

function DirectionIcon({ direction }: { direction: "in" | "out" }) {
  return (
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
      {direction === "in" ? (
        <path d="M12 4v13m0 0l-5-5m5 5l5-5M5 21h14" />
      ) : (
        <path d="M12 17V4m0 0L7 9m5-5l5 5M5 21h14" />
      )}
    </svg>
  );
}

/**
 * Halaman Log Integrasi (Fase 7B.1) — jejak webhook & pengiriman per
 * workspace dari tabel `integration_log`: setiap hit webhook (termasuk
 * yang ditolak/diabaikan) dan setiap percobaan kirim poller, dengan
 * filter provider/arah/outcome/channel + paginasi kursor. Baris bisa
 * diperluas untuk payload tersimpan + meta (validitas tanda tangan,
 * kode error). Endpoint-nya owner/admin saja — anggota biasa melihat
 * penjelasan 403 di sini. Toggle "unresolved" (hanya sesi platform
 * admin) beralih ke baris platform tenant-NULL di luar workspace mana
 * pun. Penyegaran otomatis memakai pola polling shell (fallback 6G).
 */
export function LogsPage({ t, locale, isPlatformAdmin }: LogsPageProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [showUnresolved, setShowUnresolved] = useState(false);
  const [provider, setProvider] = useState("");
  const [direction, setDirection] = useState("");
  const [outcome, setOutcome] = useState("");
  const [channelAccountId, setChannelAccountId] = useState("");
  const [channels, setChannels] = useState<ChannelAccountResponse[]>([]);

  const [logs, setLogs] = useState<IntegrationLogResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [tab, setTab] = useState<"logs" | "failed">("logs");
  const [replayTarget, setReplayTarget] =
    useState<IntegrationLogResponse | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayNotice, setReplayNotice] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<
    Record<string, IntegrationLogDetailResponse>
  >({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const loadedMoreRef = useRef(false);

  const unresolvedMode = isPlatformAdmin && showUnresolved;

  const buildQuery = useCallback(
    (cursor?: string) => ({
      provider: provider || undefined,
      direction: direction || undefined,
      outcome: outcome || undefined,
      channelAccountId:
        !unresolvedMode && channelAccountId ? channelAccountId : undefined,
      cursor,
      limit: 50,
    }),
    [provider, direction, outcome, channelAccountId, unresolvedMode],
  );

  const fetchPage = useCallback(
    async (cursor?: string) => {
      if (unresolvedMode) return api.logs.listUnresolved(buildQuery(cursor));
      if (!tenantId) return { logs: [], nextCursor: null };
      return api.logs.list(tenantId, buildQuery(cursor));
    },
    [unresolvedMode, tenantId, buildQuery],
  );

  /** Muat ulang dari halaman pertama (reset penuh — filter/mode berubah). */
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    loadedMoreRef.current = false;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const page = await fetchPage();
      if (requestSeq.current !== seq) return;
      setLogs(page.logs);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      if (err instanceof ApiClientError && err.status === 403) {
        setForbidden(true);
        setLogs([]);
      } else {
        setError(translateApiError(t, err));
      }
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [fetchPage, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Daftar channel untuk filter + label nama pada baris (best-effort:
  // kegagalan memuatnya tidak menyembunyikan log — label jatuh ke id).
  useEffect(() => {
    if (!tenantId) {
      setChannels([]);
      return;
    }
    let cancelled = false;
    api
      .channels.list(tenantId)
      .then((rows) => {
        if (!cancelled) setChannels(rows);
      })
      .catch(() => {
        if (!cancelled) setChannels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  /** Penyegaran senyap halaman pertama (pola polling shell): gabung
   *  berdasarkan id agar baris hasil "muat lagi" tidak hilang. */
  const refresh = useCallback(async () => {
    if (forbidden) return;
    try {
      const page = await fetchPage();
      setLogs((prev) => {
        const freshIds = new Set(page.logs.map((l) => l.id));
        const rest = prev.filter((l) => !freshIds.has(l.id));
        const merged = [...page.logs, ...rest];
        merged.sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        );
        return merged;
      });
      if (!loadedMoreRef.current) setNextCursor(page.nextCursor);
    } catch {
      // Penyegaran latar gagal diam — siklus berikut mencoba lagi.
    }
  }, [fetchPage, forbidden]);
  usePolling(refresh);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      loadedMoreRef.current = true;
      setLogs((prev) => {
        const seen = new Set(prev.map((l) => l.id));
        return [...prev, ...page.logs.filter((l) => !seen.has(l.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleExpand = async (row: IntegrationLogResponse) => {
    if (expandedId === row.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(row.id);
    if (details[row.id] || !row.hasPayload) return;
    setDetailLoadingId(row.id);
    try {
      const detail = unresolvedMode
        ? await api.logs.getUnresolved(row.id)
        : tenantId
          ? await api.logs.get(tenantId, row.id)
          : null;
      if (detail) {
        setDetails((prev) => ({ ...prev, [row.id]: detail }));
      }
    } catch {
      // Detail gagal dimuat — panel tetap menampilkan meta baris.
    } finally {
      setDetailLoadingId((cur) => (cur === row.id ? null : cur));
    }
  };

  const channelById = (id: string | null) =>
    id ? (channels.find((ch) => ch.id === id) ?? null) : null;

  /** Fase 7B.2: jalankan replay baris target, laporkan outcome baris
   *  baru yang dihasilkannya, lalu muat ulang daftar dari awal. */
  const confirmReplay = async () => {
    if (!replayTarget || !tenantId || replaying) return;
    setReplaying(true);
    setReplayError(null);
    try {
      const result = await api.logs.replay(tenantId, replayTarget.id);
      const outcomes = result.outcomes
        .map(
          (o) => t(OUTCOME_LABEL_KEYS[o as OutcomeValue] ?? "logs.outcomeError"),
        )
        .join(", ");
      setReplayTarget(null);
      setReplayNotice(t("logs.replayDone", { outcomes }));
      setDetails({});
      await load();
    } catch (err) {
      setReplayError(translateApiError(t, err));
    } finally {
      setReplaying(false);
    }
  };

  const selectClass = `${inputClassName} sm:w-auto`;

  return (
    <div>
      <h1 className="text-xl font-bold text-ink">{t("logs.title")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("logs.subtitle")}</p>

      <div className="mt-5 flex gap-2">
        {(
          [
            { value: "logs", label: t("logs.tabLogs") },
            { value: "failed", label: t("logs.tabFailed") },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setTab(option.value)}
            className={
              tab === option.value
                ? "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
                : "rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-elevated"
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      {tab === "failed" ? (
        <div className="mt-6">
          <FailedMessagesPanel t={t} locale={locale} />
        </div>
      ) : (
        <>
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("logs.filterProvider")}
          </span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className={selectClass}
          >
            <option value="">{t("logs.filterAll")}</option>
            {PROVIDER_VALUES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("logs.filterDirection")}
          </span>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            className={selectClass}
          >
            <option value="">{t("logs.filterAll")}</option>
            <option value="in">{t("logs.directionIn")}</option>
            <option value="out">{t("logs.directionOut")}</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("logs.filterOutcome")}
          </span>
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            className={selectClass}
          >
            <option value="">{t("logs.filterAll")}</option>
            {OUTCOME_VALUES.map((o) => (
              <option key={o} value={o}>
                {t(OUTCOME_LABEL_KEYS[o])}
              </option>
            ))}
          </select>
        </label>
        {!unresolvedMode ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("logs.filterChannel")}
            </span>
            <select
              value={channelAccountId}
              onChange={(e) => setChannelAccountId(e.target.value)}
              className={selectClass}
            >
              <option value="">{t("logs.filterAll")}</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.displayName ?? ch.botUsername ?? ch.externalId}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {isPlatformAdmin ? (
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={showUnresolved}
              onChange={(e) => setShowUnresolved(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            {t("logs.unresolvedToggle")}
          </label>
        ) : null}
      </div>

      {unresolvedMode ? (
        <p className="mt-3 max-w-2xl rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
          {t("logs.unresolvedHint")}
        </p>
      ) : null}

      {replayNotice ? (
        <p className="mt-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          {replayNotice}
        </p>
      ) : null}

      {forbidden ? (
        <p className="mt-4 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("logs.forbidden")}
        </p>
      ) : error ? (
        <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {loading && logs.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : null}

      {!loading && !forbidden && logs.length === 0 ? (
        <p className="mt-6 text-sm text-muted">
          {unresolvedMode ? t("logs.unresolvedEmpty") : t("logs.empty")}
        </p>
      ) : null}

      <div className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {logs.map((row) => {
          const channel = channelById(row.channelAccountId);
          const expanded = expandedId === row.id;
          const detail = details[row.id];
          return (
            <div key={row.id}>
              <button
                type="button"
                onClick={() => void toggleExpand(row)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-elevated"
              >
                <DirectionIcon direction={row.direction} />
                <span className="w-32 shrink-0 text-xs text-muted">
                  {formatDateTime(row.createdAt, locale)}
                </span>
                {channel ? (
                  <ChannelAvatar
                    provider={channel.provider}
                    name={channel.displayName ?? channel.externalId}
                    imageUrl={channel.avatarUrl ?? undefined}
                  />
                ) : null}
                <span className="w-24 shrink-0 truncate text-sm font-medium text-ink">
                  {channel?.displayName ?? row.provider}
                </span>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${outcomeChipClass(row.outcome)}`}
                >
                  {t(
                    OUTCOME_LABEL_KEYS[row.outcome as OutcomeValue] ??
                      "logs.outcomeError",
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted">
                  {row.summary ?? ""}
                </span>
              </button>
              {expanded ? (
                <div className="border-t border-line bg-elevated/50 px-3 py-3">
                  <dl className="grid gap-1 text-xs text-muted sm:grid-cols-2">
                    <div>
                      <dt className="inline font-medium text-ink">
                        {t("logs.signatureLabel")}:{" "}
                      </dt>
                      <dd className="inline">
                        {row.signatureValid === null
                          ? t("logs.signatureNa")
                          : row.signatureValid
                            ? t("logs.signatureValid")
                            : t("logs.signatureInvalid")}
                      </dd>
                    </div>
                    {row.errorCode ? (
                      <div>
                        <dt className="inline font-medium text-ink">
                          {t("logs.errorCodeLabel")}:{" "}
                        </dt>
                        <dd className="inline font-mono">{row.errorCode}</dd>
                      </div>
                    ) : null}
                    {row.channelAccountId ? (
                      <div>
                        <dt className="inline font-medium text-ink">
                          {t("logs.channelLabel")}:{" "}
                        </dt>
                        <dd className="inline font-mono">
                          {row.channelAccountId}
                        </dd>
                      </div>
                    ) : null}
                    {row.messageId ? (
                      <div>
                        <dt className="inline font-medium text-ink">
                          {t("logs.messageLabel")}:{" "}
                        </dt>
                        <dd className="inline font-mono">{row.messageId}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <div className="mt-3">
                    <div className="text-xs font-medium text-ink">
                      {t("logs.payloadLabel")}
                    </div>
                    {!row.hasPayload ? (
                      <p className="mt-1 text-xs text-muted">
                        {t("logs.noPayload")}
                      </p>
                    ) : detailLoadingId === row.id ? (
                      <p className="mt-1 text-xs text-muted">
                        {t("common.loading")}
                      </p>
                    ) : detail ? (
                      <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-surface p-3 text-xs text-ink">
                        {JSON.stringify(detail.payload, null, 2)}
                      </pre>
                    ) : (
                      <p className="mt-1 text-xs text-muted">
                        {t("logs.noPayload")}
                      </p>
                    )}
                  </div>
                  {!unresolvedMode && isReplayEligible(row) ? (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => {
                          setReplayError(null);
                          setReplayNotice(null);
                          setReplayTarget(row);
                        }}
                        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-elevated"
                      >
                        {t("logs.replayButton")}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {nextCursor ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
          >
            {loadingMore ? t("logs.loadingMore") : t("logs.loadMore")}
          </button>
        </div>
      ) : null}
        </>
      )}

      {replayTarget ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-bold text-ink">
                {t("logs.replayTitle")}
              </h2>
              <button
                type="button"
                onClick={() => setReplayTarget(null)}
                className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
              >
                {t("common.close")}
              </button>
            </div>
            <p className="mt-3 text-sm text-muted">{t("logs.replayBody")}</p>
            <p className="mt-3 text-sm text-muted">
              {formatDateTime(replayTarget.createdAt, locale)} ·{" "}
              {replayTarget.provider} ·{" "}
              {t(
                OUTCOME_LABEL_KEYS[replayTarget.outcome as OutcomeValue] ??
                  "logs.outcomeError",
              )}
            </p>
            {replayError ? (
              <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {replayError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReplayTarget(null)}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmReplay()}
                disabled={replaying}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {replaying ? t("logs.replaying") : t("logs.replayConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
