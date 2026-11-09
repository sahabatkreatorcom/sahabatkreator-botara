import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformOverviewResponse } from "@sahabat-kreator/contracts";
import { api, ApiClientError } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { Stat, secondaryButton, type AdminSectionProps } from "./shared";

/**
 * Ringkasan — satu layar yang menjawab "apakah platform sehat, dan sebesar
 * apa". Sebelum ini jawabannya hanya ada di terminal (`docker logs`, `psql`),
 * sehingga pemilik platform bergantung pada orang lain untuk tahu keadaannya.
 */
export function OverviewSection({ t }: AdminSectionProps) {
  const [data, setData] = useState<PlatformOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const body = await api.admin.getOverview();
      if (mine === seq.current) setData(body);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("adminConsole.loadError"),
      );
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-6">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          {t("adminConsole.overviewBody")}
        </p>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? t("adminConsole.refreshing") : t("adminConsole.refresh")}
        </button>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {!data && loading ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : null}

      {data ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={t("adminConsole.tenantsLabel")}
              value={data.tenants.total}
              hint={t("adminConsole.tenantsHint", {
                active: data.tenants.active,
                suspended: data.tenants.suspended,
              })}
            />
            <Stat
              label={t("adminConsole.usersLabel")}
              value={data.users.total}
              hint={t("adminConsole.newLast7d", { n: data.users.newLast7d })}
            />
            <Stat
              label={t("adminConsole.messages24hLabel")}
              value={data.messages.last24h}
              hint={t("adminConsole.messagesHint", {
                out: data.messages.outbound24h,
                week: data.messages.last7d,
              })}
            />
            <Stat
              label={t("adminConsole.channelsLabel")}
              value={data.channels.connected}
              hint={t("adminConsole.channelsHint", {
                total: data.channels.total,
              })}
            />
            <Stat
              label={t("adminConsole.openConversationsLabel")}
              value={data.conversations.open}
            />
            <Stat
              label={t("adminConsole.outboxPendingLabel")}
              value={data.outbox.pending}
            />
            <Stat
              label={t("adminConsole.deadLetterLabel")}
              value={data.outbox.deadLettered}
              hint={
                data.outbox.deadLettered > 0
                  ? t("adminConsole.deadLetterNeedsAttention")
                  : undefined
              }
            />
            <Stat
              label={t("adminConsole.audit24hLabel")}
              value={data.audit.last24h}
            />
          </div>

          {data.outbox.deadLettered > 0 ? (
            <p className="mt-4 rounded-lg border border-line bg-surface p-3 text-sm text-danger">
              {t("adminConsole.deadLetterBanner", {
                n: data.outbox.deadLettered,
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
