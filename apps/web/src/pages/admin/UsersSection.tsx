import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformUserListResponse } from "@sahabat-kreator/contracts";
import { api, ApiClientError } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { inputClassName } from "../../components/AuthLayout";
import { formatDateTime } from "../../utils/format";
import { dangerButton, type AdminSectionProps } from "./shared";
import { PlatformAdminsPanel } from "./PlatformAdminsPanel";

/**
 * Pengguna & akses — pencarian lintas tenant + paksa logout.
 *
 * Pencarian baru dijalankan pada 2 karakter. Membuka daftar SELURUH pengguna
 * dengan satu klik bukan kebutuhan operasional, dan query tanpa filter pada
 * tabel users adalah pemindaian penuh yang tidak ada gunanya dijalankan.
 */
export function UsersSection({ t, locale }: AdminSectionProps) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<PlatformUserListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const search = useCallback(
    async (value: string) => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const body = await api.admin.searchUsers(value);
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
    },
    [t],
  );

  useEffect(() => {
    if (query.trim().length < 2) {
      setData(null);
      return;
    }
    const timer = setTimeout(() => void search(query), 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  const revoke = async (userId: string) => {
    setBusy(userId);
    setError(null);
    setNotice(null);
    try {
      const result = await api.admin.revokeSessions(userId);
      setNotice(t("adminConsole.revokedDone", { n: result.revoked }));
      setConfirming(null);
      if (query.trim().length >= 2) await search(query);
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
      <PlatformAdminsPanel t={t} locale={locale} />

      <p className="mt-8 max-w-2xl text-sm text-muted">
        {t("adminConsole.usersBody")}
      </p>

      <label className="mt-4 block max-w-md">
        <span className="text-xs text-muted">{t("adminConsole.searchLabel")}</span>
        <input
          className={inputClassName}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("adminConsole.userSearchPlaceholder")}
        />
      </label>

      {error ? (
        <p className="mt-4 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="mt-4 text-sm text-ink">{notice}</p> : null}

      {query.trim().length < 2 ? (
        <p className="mt-4 text-sm text-muted">{t("adminConsole.userSearchHint")}</p>
      ) : null}

      {loading ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : null}

      {data && data.rows.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {data.rows.map((user) => (
            <li key={user.id} className="rounded-xl bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-ink">{user.email}</div>
                  <div className="text-xs text-muted">
                    {user.name ?? "—"} ·{" "}
                    {t("adminConsole.sessionsLabel", {
                      n: user.activeSessions,
                    })}{" "}
                    · {formatDateTime(user.createdAt, locale)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {confirming === user.id ? (
                    <>
                      <button
                        type="button"
                        className={dangerButton}
                        disabled={busy === user.id}
                        onClick={() => void revoke(user.id)}
                      >
                        {busy === user.id
                          ? t("adminConsole.working")
                          : t("adminConsole.revokeConfirm")}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-muted underline"
                        onClick={() => setConfirming(null)}
                      >
                        {t("adminConsole.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={dangerButton}
                      disabled={user.activeSessions === 0}
                      onClick={() => setConfirming(user.id)}
                    >
                      {t("adminConsole.revokeSessions")}
                    </button>
                  )}
                </div>
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {user.memberships.map((m) => (
                  <li key={m.tenantId}>
                    {m.tenantName} · {m.role}
                  </li>
                ))}
                {user.memberships.length === 0 ? (
                  <li>{t("adminConsole.noMemberships")}</li>
                ) : null}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}

      {data && data.rows.length === 0 && !loading && !data.tooShort ? (
        <p className="mt-4 text-sm text-muted">{t("adminConsole.usersEmpty")}</p>
      ) : null}
    </section>
  );
}
