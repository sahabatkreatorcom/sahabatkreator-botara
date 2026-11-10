import { useCallback, useEffect, useState } from "react";
import type { PlatformAdminListResponse } from "@sahabat-kreator/contracts";
import { api, ApiClientError } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { inputClassName } from "../../components/AuthLayout";
import { formatDateTime } from "../../utils/format";
import {
  dangerButton,
  primaryButton,
  type AdminSectionProps,
} from "./shared";

const REMOVE_REASON_KEYS = {
  env_locked: "adminConsole.adminsRemoveReasonEnv",
  self: "adminConsole.adminsRemoveReasonSelf",
  last_admin: "adminConsole.adminsRemoveReasonLast",
  not_found: "adminConsole.adminsRemoveReasonNotFound",
} as const;

/**
 * Daftar admin platform yang bisa dikelola tanpa deploy.
 *
 * Baris ber-sumber `env` sengaja terkunci: ia adalah pintu darurat kalau
 * tabel panel rusak atau migrasi belum jalan. Mencabutnya dari sini akan
 * membuat pemilik platform bergantung pada sesuatu yang baru saja ia hapus.
 */
export function PlatformAdminsPanel({ t, locale }: AdminSectionProps) {
  const [data, setData] = useState<PlatformAdminListResponse | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.admin.getAdmins());
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

  const add = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.admin.addAdmin(email.trim());
      setNotice(
        result.created
          ? t("adminConsole.adminsAdded", { email: result.email })
          : t("adminConsole.adminsAlready", { email: result.email }),
      );
      setEmail("");
      await load();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("adminConsole.actionError"),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.admin.removeAdmin(target);
      if (result.removed) {
        setNotice(t("adminConsole.adminsRemoved", { email: target }));
      } else {
        const reason = result.reason ?? "not_found";
        setError(t(REMOVE_REASON_KEYS[reason]));
      }
      await load();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? translateApiError(t, err)
          : t("adminConsole.actionError"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-xl border border-line p-4">
      <h2 className="text-base font-semibold text-ink">
        {t("adminConsole.adminsTitle")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("adminConsole.adminsBody")}
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[220px]">
          <span className="text-xs text-muted">
            {t("adminConsole.adminsAddLabel")}
          </span>
          <input
            type="email"
            className={inputClassName}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("adminConsole.adminsAddPlaceholder")}
          />
        </label>
        <button
          type="button"
          className={primaryButton}
          disabled={busy || !email.trim()}
          onClick={() => void add()}
        >
          {busy ? t("adminConsole.working") : t("adminConsole.adminsAddButton")}
        </button>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="mt-3 text-sm text-ink">{notice}</p> : null}
      {loading ? (
        <p className="mt-3 text-xs text-muted">{t("common.loading")}</p>
      ) : null}

      <ul className="mt-4 space-y-2">
        {(data?.rows ?? []).map((row) => (
          <li
            key={row.email}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface p-3"
          >
            <div>
              <div className="text-sm text-ink">{row.email}</div>
              <div className="mt-0.5 text-xs text-muted">
                {row.source === "env"
                  ? t("adminConsole.adminsEnvBadge")
                  : t("adminConsole.adminsPanelBadge")}
                {" · "}
                {row.registered
                  ? t("adminConsole.adminsRegistered")
                  : t("adminConsole.adminsNotRegistered")}
                {row.createdAt
                  ? ` · ${formatDateTime(row.createdAt, locale)}`
                  : ""}
                {row.addedByEmail
                  ? ` · ${t("adminConsole.adminsAddedBy", { email: row.addedByEmail })}`
                  : ""}
              </div>
            </div>
            {row.removable ? (
              <button
                type="button"
                className={dangerButton}
                disabled={busy}
                onClick={() => void remove(row.email)}
              >
                {t("adminConsole.adminsRemove")}
              </button>
            ) : null}
          </li>
        ))}
        {data && data.rows.length === 0 ? (
          <li className="text-sm text-muted">{t("adminConsole.adminsEmpty")}</li>
        ) : null}
      </ul>
    </section>
  );
}
