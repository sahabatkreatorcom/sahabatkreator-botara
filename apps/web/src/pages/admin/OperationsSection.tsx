import { useCallback, useEffect, useRef, useState } from "react";
import type { DeadLetterOutboxListResponse } from "@sahabat-kreator/contracts";
import { api, ApiClientError } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { formatDateTime } from "../../utils/format";
import { primaryButton, secondaryButton, type AdminSectionProps } from "./shared";

/**
 * Operasional — event outbox yang menyerah setelah semua percobaan.
 *
 * Ini satu-satunya daftar di seluruh aplikasi yang isinya "pekerjaan yang
 * seharusnya terjadi tetapi tidak". Membiarkannya hanya terbaca lewat SQL
 * manual berarti kegagalan yang paling perlu ditindaklanjuti justru yang
 * paling tidak terlihat.
 */
export function OperationsSection({ t, locale }: AdminSectionProps) {
  const [data, setData] = useState<DeadLetterOutboxListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const body = await api.admin.listDeadLetter();
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

  const retry = async (id: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.admin.retryOutbox(id);
      setNotice(
        result.retried
          ? t("adminConsole.retryDone")
          : t("adminConsole.retryNotPossible"),
      );
      await load();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("adminConsole.actionError"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          {t("adminConsole.deadLetterBody")}
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
      {notice ? <p className="mt-4 text-sm text-ink">{notice}</p> : null}

      {data && data.rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t("adminConsole.noDeadLetter")}</p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {(data?.rows ?? []).map((row) => (
          <li key={row.id} className="rounded-xl bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-mono text-sm text-ink">{row.type}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {row.tenantName ?? t("adminConsole.noTenant")} ·{" "}
                  {t("adminConsole.attemptsLabel", { n: row.attempts })} ·{" "}
                  {formatDateTime(row.deadLetteredAt, locale)}
                </div>
              </div>
              <button
                type="button"
                className={primaryButton}
                disabled={busy === row.id}
                onClick={() => void retry(row.id)}
              >
                {busy === row.id
                  ? t("adminConsole.retrying")
                  : t("adminConsole.retry")}
              </button>
            </div>
            {row.lastError ? (
              <p className="mt-2 break-words rounded-lg border border-line p-2 font-mono text-xs text-danger">
                {row.lastError}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
