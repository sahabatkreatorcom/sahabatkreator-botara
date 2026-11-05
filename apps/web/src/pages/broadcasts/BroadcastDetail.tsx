/**
 * Panel detail satu broadcast: statistik, hasil A/B, dan daftar penerima.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  BroadcastAbResultsResponse,
  BroadcastRecipientResponse,
  BroadcastResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { usePolling } from "../../hooks/usePolling";
import { formatDateTime } from "../../utils/format";
import { StatusChip } from "./chips";
import {
  DISPATCH_ERROR_LABEL_KEYS,
  PROVIDER_NAMES,
  RECIPIENT_STATUS_LABEL_KEYS,
  SKIP_REASON_LABEL_KEYS,
  type Translate,
} from "./types";

export interface BroadcastDetailProps {
  t: Translate;
  locale: Locale;
  tenantId: string | null;
  broadcastId: string;
  onBack: () => void;
}

export function BroadcastDetail({ t, locale, tenantId, broadcastId, onBack }: BroadcastDetailProps) {
  const [broadcast, setBroadcast] = useState<BroadcastResponse | null>(null);
  const [abResults, setAbResults] =
    useState<BroadcastAbResultsResponse | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipientResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!tenantId) return;
      if (!silent) setLoading(true);
      try {
        const [detail, page, ab] = await Promise.all([
          api.broadcasts.get(tenantId, broadcastId),
          api.broadcasts.listRecipients(tenantId, broadcastId, { limit: 50 }),
          api.broadcasts
            .abResults(tenantId, broadcastId)
            .catch(() => null),
        ]);
        setBroadcast(detail);
        setAbResults(ab);
        setRecipients(page.recipients);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (!silent) setError(translateApiError(t, err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [tenantId, broadcastId, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(
    () => {
      void load(true);
    },
    5000,
    broadcast?.status === "sending",
  );

  const loadMore = async () => {
    if (!tenantId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.broadcasts.listRecipients(tenantId, broadcastId, {
        limit: 50,
        cursor: nextCursor,
      });
      setRecipients((prev) => [...prev, ...page.recipients]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoadingMore(false);
    }
  };

  const statCells: { key: string; labelKey: TranslationKey; value: number }[] =
    broadcast
      ? [
          { key: "total", labelKey: "broadcasts.statTotal", value: broadcast.stats.total },
          { key: "queued", labelKey: "broadcasts.statQueued", value: broadcast.stats.queued },
          { key: "sent", labelKey: "broadcasts.statSent", value: broadcast.stats.sent },
          { key: "delivered", labelKey: "broadcasts.statDelivered", value: broadcast.stats.delivered },
          { key: "read", labelKey: "broadcasts.statRead", value: broadcast.stats.read },
          { key: "failed", labelKey: "broadcasts.statFailed", value: broadcast.stats.failed },
          { key: "skipped", labelKey: "broadcasts.statSkipped", value: broadcast.stats.skipped },
          { key: "cancelled", labelKey: "broadcasts.statCancelled", value: broadcast.stats.cancelled },
        ]
      : [];

  return (
    <section>
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-muted hover:text-ink"
      >
        ← {t("broadcasts.backToList")}
      </button>

      {loading ? (
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      ) : error || !broadcast ? (
        <p className="mt-6 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error ?? t("errors.NOT_FOUND")}
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-ink">{broadcast.name}</h1>
            <StatusChip t={t} status={broadcast.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {PROVIDER_NAMES[broadcast.provider]}
            {broadcast.channelDisplayName
              ? ` · ${broadcast.channelDisplayName}`
              : ""}
            {" · "}
            {broadcast.scheduledAt
              ? t("broadcasts.scheduledFor", {
                  when: formatDateTime(broadcast.scheduledAt, locale),
                })
              : formatDateTime(broadcast.createdAt, locale)}
          </p>
          <p className="mt-3 max-w-2xl whitespace-pre-wrap rounded-xl border border-border bg-surface p-4 text-sm text-ink">
            {broadcast.messageText}
          </p>
          {broadcast.status === "failed" && broadcast.errorCode ? (
            <p className="mt-2 text-sm text-danger">
              {t("broadcasts.dispatchErrorLabel")}:{" "}
              {DISPATCH_ERROR_LABEL_KEYS[broadcast.errorCode]
                ? t(DISPATCH_ERROR_LABEL_KEYS[broadcast.errorCode])
                : broadcast.errorCode}
            </p>
          ) : null}

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {statCells.map((cell) => (
              <div
                key={cell.key}
                className="rounded-xl border border-border bg-surface p-3 text-center"
              >
                <p className="text-xl font-bold text-ink">{cell.value}</p>
                <p className="text-xs text-muted">{t(cell.labelKey)}</p>
              </div>
            ))}
          </div>

          {abResults?.abTest ? (
            <div className="mt-6">
              <h2 className="text-lg font-semibold text-ink">
                {t("broadcasts.abResultsTitle")}
              </h2>
              <p className="mt-1 max-w-2xl text-xs text-muted">
                {t("broadcasts.abResultsNote")}
              </p>
              <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-surface">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted">
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.abColVariant")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.abColAssigned")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statQueued")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statSent")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statDelivered")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statRead")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statFailed")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statSkipped")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statCancelled")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {abResults.variants.map((v) => (
                      <tr key={v.variant} className="border-t border-border">
                        <td className="px-3 py-2 font-semibold uppercase text-ink">
                          {v.variant}
                        </td>
                        <td className="px-3 py-2 text-ink">{v.assigned}</td>
                        <td className="px-3 py-2 text-ink">{v.queued}</td>
                        <td className="px-3 py-2 text-ink">{v.sent}</td>
                        <td className="px-3 py-2 text-ink">{v.delivered}</td>
                        <td className="px-3 py-2 text-ink">{v.read}</td>
                        <td className="px-3 py-2 text-ink">{v.failed}</td>
                        <td className="px-3 py-2 text-ink">
                          {v.skipped}
                          {v.skipped > 0 ? (
                            <span className="block text-xs font-normal text-muted">
                              {(
                                Object.entries(v.skippedByReason) as [
                                  string,
                                  number,
                                ][]
                              )
                                .filter(([, n]) => n > 0)
                                .map(([reason, n]) =>
                                  `${
                                    SKIP_REASON_LABEL_KEYS[reason]
                                      ? t(SKIP_REASON_LABEL_KEYS[reason])
                                      : reason
                                  }: ${n}`,
                                )
                                .join(" · ")}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-ink">{v.cancelled}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <h2 className="mt-6 text-lg font-semibold text-ink">
            {t("broadcasts.recipientsTitle")}
          </h2>
          {recipients.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              {t("broadcasts.recipientsEmpty")}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-surface">
              {recipients.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                >
                  <span className="text-sm font-medium text-ink">
                    {r.contactName}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {abResults?.abTest ? (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 font-semibold text-ink">
                        {t(
                          r.variant === "b"
                            ? "broadcasts.abVariantBadgeB"
                            : "broadcasts.abVariantBadgeA",
                        )}
                      </span>
                    ) : null}
                    {r.status === "skipped" && r.skipReason ? (
                      <span>
                        {SKIP_REASON_LABEL_KEYS[r.skipReason]
                          ? t(SKIP_REASON_LABEL_KEYS[r.skipReason])
                          : r.skipReason}
                      </span>
                    ) : null}
                    {r.status === "failed" && r.errorCode ? (
                      <span className="text-danger">
                        {t("broadcasts.errorCodeLabel")}: {r.errorCode}
                      </span>
                    ) : null}
                    <span className="font-medium text-ink">
                      {RECIPIENT_STATUS_LABEL_KEYS[r.status]
                        ? t(RECIPIENT_STATUS_LABEL_KEYS[r.status])
                        : r.status}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {nextCursor ? (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-lg border border-border px-4 py-2 text-sm text-ink hover:bg-surface-2 disabled:opacity-50"
              >
                {loadingMore
                  ? t("broadcasts.loadingMore")
                  : t("broadcasts.loadMore")}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
