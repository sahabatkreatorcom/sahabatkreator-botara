import { useCallback, useEffect, useState } from "react";
import type { PlatformBackupResponse } from "@sahabat-kreator/contracts";
import { api, ApiClientError } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { formatDateTime } from "../../utils/format";
import { type AdminSectionProps } from "./shared";

/**
 * Status backup yang SUMBERNYA benar-benar dari eksekusi cron.
 *
 * Sebelumnya panel tidak menampilkan apa pun soal backup karena skripnya
 * menulis ke berkas log di host, bukan ke database. Sekarang skrip backup
 * dan drill mencatat satu baris ke tabel `backup_runs`; kalau tidak ada
 * baris, panel berkata "belum ada catatan" — bukan "backup aman".
 */
export function BackupPanel({ t, locale }: AdminSectionProps) {
  const [data, setData] = useState<PlatformBackupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.admin.getBackups());
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("adminConsole.loadError"),
      );
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-6">
      <h2 className="text-base font-semibold text-ink">
        {t("adminConsole.backupsTitle")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("adminConsole.backupsBody")}
      </p>

      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-surface p-4">
              <div className="text-xs text-muted">
                {t("adminConsole.backupsLastDaily")}
              </div>
              <div className="mt-1 text-sm text-ink">
                {data.lastDaily
                  ? formatDateTime(data.lastDaily, locale)
                  : t("adminConsole.backupsNever")}
              </div>
            </div>
            <div className="rounded-xl bg-surface p-4">
              <div className="text-xs text-muted">
                {t("adminConsole.backupsLastDrill")}
              </div>
              <div className="mt-1 text-sm text-ink">
                {data.lastDrill
                  ? formatDateTime(data.lastDrill, locale)
                  : t("adminConsole.backupsNever")}
              </div>
            </div>
          </div>

          <h3 className="mt-5 text-sm font-semibold text-ink">
            {t("adminConsole.backupsHistory")}
          </h3>
          <ul className="mt-2 space-y-1">
            {data.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap gap-2 text-xs">
                <span className="font-mono text-ink">
                  {row.kind === "daily"
                    ? t("adminConsole.backupsKindDaily")
                    : row.kind === "drill"
                      ? t("adminConsole.backupsKindDrill")
                      : row.kind}
                </span>
                <span
                  className={
                    row.status === "ok" ? "text-ink" : "text-danger"
                  }
                >
                  {row.status === "ok"
                    ? t("adminConsole.backupsStatusOk")
                    : t("adminConsole.backupsStatusFailed")}
                </span>
                <span className="text-muted">
                  {formatDateTime(row.createdAt, locale)}
                  {row.sizeBytes !== null
                    ? ` · ${t("adminConsole.backupsSize", {
                        n: Math.round(row.sizeBytes / 1024),
                      })}`
                    : ""}
                  {row.detail ? ` · ${row.detail}` : ""}
                </span>
              </li>
            ))}
            {data.rows.length === 0 ? (
              <li className="text-sm text-muted">
                {t("adminConsole.backupsEmpty")}
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
    </section>
  );
}
