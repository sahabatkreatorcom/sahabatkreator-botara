import { useCallback, useEffect, useState } from "react";
import type { PlatformSystemResponse } from "@sahabat-kreator/contracts";
import { api, ApiClientError } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { KeyValue, Stat, secondaryButton, type AdminSectionProps } from "./shared";
import { BackupPanel } from "./BackupPanel";

/** Ubah detik menjadi "3h 12m" — lebih mudah dibaca daripada 11520. */
function humanUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Sistem — versi, uptime, ukuran database, dan status backup.
 *
 * Status backup kini bersumber dari tabel `backup_runs` (migrasi 0011)
 * yang ditulis skrip cron setiap kali backup harian atau drill berjalan.
 * Tanpa baris, panel berkata "belum ada catatan" — bukan "backup aman".
 */
export function SystemSection({ t, locale }: AdminSectionProps) {
  const [data, setData] = useState<PlatformSystemResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.admin.getSystem());
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("adminConsole.loadError"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t("adminConsole.systemBody")}</p>
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

      {data ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={t("adminConsole.appVersionLabel")}
              value={data.app.version}
              hint={data.app.buildSha ?? t("adminConsole.noBuildSha")}
            />
            <Stat
              label={t("adminConsole.uptimeLabel")}
              value={humanUptime(data.app.uptimeSeconds)}
              hint={data.app.nodeVersion}
            />
            <Stat
              label={t("adminConsole.dbSizeLabel")}
              value={data.database.size}
              hint={data.database.serverVersion}
            />
            <Stat
              label={t("adminConsole.envLabel")}
              value={data.app.environment}
            />
          </div>

          <h3 className="mt-6 text-sm font-semibold text-ink">
            {t("adminConsole.tablesTitle")}
          </h3>
          <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <KeyValue
              label={t("adminConsole.tenantsLabel")}
              value={String(data.tables.tenants)}
            />
            <KeyValue
              label={t("adminConsole.usersLabel")}
              value={String(data.tables.users)}
            />
            <KeyValue
              label={t("adminConsole.contactsLabel")}
              value={String(data.tables.contacts)}
            />
            <KeyValue
              label={t("adminConsole.conversationsLabel")}
              value={String(data.tables.conversations)}
            />
            <KeyValue
              label={t("adminConsole.messagesLabel")}
              value={String(data.tables.messages)}
            />
          </dl>

          <p className="mt-4 text-xs text-muted">
            {t("adminConsole.dbTimeLabel", { time: data.database.serverTime })}
          </p>
        </>
      ) : null}

      <BackupPanel t={t} locale={locale} />
    </section>
  );
}
