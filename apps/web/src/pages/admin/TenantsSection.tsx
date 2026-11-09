import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PlatformTenantDetailResponse,
  PlatformTenantListResponse,
  TenantStatus,
} from "@sahabat-kreator/contracts";
import { api, ApiClientError } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { inputClassName } from "../../components/AuthLayout";
import { formatDateTime } from "../../utils/format";
import {
  KeyValue,
  dangerButton,
  primaryButton,
  secondaryButton,
  type AdminSectionProps,
} from "./shared";

/**
 * Tenant — daftar workspace + detail + penangguhan.
 *
 * Detail dibuka di panel yang sama (bukan route sendiri) karena alurnya
 * selalu "pindai daftar → periksa satu → kembali"; memindahkan ke halaman
 * terpisah memaksa tombol kembali dan kehilangan posisi gulir.
 */
export function TenantsSection({ t, locale }: AdminSectionProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TenantStatus | "all">("all");
  const [list, setList] = useState<PlatformTenantListResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlatformTenantDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const body = await api.admin.listTenants({
        q: query.trim() || undefined,
        status: status === "all" ? undefined : status,
        limit: 50,
      });
      if (mine === seq.current) setList(body);
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
  }, [query, status, t]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const openDetail = useCallback(
    async (tenantId: string) => {
      setSelected(tenantId);
      setDetail(null);
      setDetailLoading(true);
      setError(null);
      setNotice(null);
      setReason("");
      try {
        setDetail(await api.admin.getTenant(tenantId));
      } catch (err) {
        setError(
          err instanceof ApiClientError
            ? translateApiError(t, err)
            : t("adminConsole.loadError"),
        );
      } finally {
        setDetailLoading(false);
      }
    },
    [t],
  );

  const changeStatus = async (next: TenantStatus) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.admin.setTenantStatus(selected, {
        status: next,
        ...(next === "suspended" && reason.trim()
          ? { reason: reason.trim() }
          : {}),
      });
      setNotice(
        result.changed
          ? next === "suspended"
            ? t("adminConsole.suspendDone")
            : t("adminConsole.reactivateDone")
          : t("adminConsole.statusUnchanged"),
      );
      setReason("");
      await Promise.all([load(), openDetail(selected)]);
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
    <section className="mt-6">
      <p className="max-w-2xl text-sm text-muted">{t("adminConsole.tenantsBody")}</p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[220px]">
          <span className="text-xs text-muted">{t("adminConsole.searchLabel")}</span>
          <input
            className={inputClassName}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("adminConsole.tenantSearchPlaceholder")}
          />
        </label>
        <label>
          <span className="text-xs text-muted">{t("adminConsole.statusLabel")}</span>
          <select
            className={inputClassName}
            value={status}
            onChange={(e) => setStatus(e.target.value as TenantStatus | "all")}
          >
            <option value="all">{t("adminConsole.statusAll")}</option>
            <option value="active">{t("adminConsole.statusActive")}</option>
            <option value="suspended">{t("adminConsole.statusSuspended")}</option>
          </select>
        </label>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="mt-4 text-sm text-ink">{notice}</p> : null}

      <div className="mt-4 overflow-x-auto rounded-xl bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">{t("adminConsole.colTenant")}</th>
              <th className="px-3 py-2 font-normal">{t("adminConsole.colStatus")}</th>
              <th className="px-3 py-2 font-normal">{t("adminConsole.colMembers")}</th>
              <th className="px-3 py-2 font-normal">{t("adminConsole.colChannels")}</th>
              <th className="px-3 py-2 font-normal">{t("adminConsole.colMessages7d")}</th>
              <th className="px-3 py-2 font-normal">{t("adminConsole.colPlan")}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(list?.rows ?? []).map((row) => (
              <tr key={row.id} className="border-t border-line">
                <td className="px-3 py-2">
                  <div className="font-medium text-ink">{row.name}</div>
                  <div className="font-mono text-xs text-muted">{row.slug}</div>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      row.status === "suspended" ? "text-danger" : "text-ink"
                    }
                  >
                    {row.status === "suspended"
                      ? t("adminConsole.statusSuspended")
                      : t("adminConsole.statusActive")}
                  </span>
                </td>
                <td className="px-3 py-2 text-ink">{row.members}</td>
                <td className="px-3 py-2 text-ink">
                  {row.channelsConnected}/{row.channels}
                </td>
                <td className="px-3 py-2 text-ink">{row.messages7d}</td>
                <td className="px-3 py-2 text-muted">{row.planCode ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => void openDetail(row.id)}
                  >
                    {t("adminConsole.openDetail")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list && list.rows.length === 0 && !loading ? (
          <p className="px-3 py-6 text-center text-sm text-muted">
            {t("adminConsole.tenantsEmpty")}
          </p>
        ) : null}
        {loading ? (
          <p className="px-3 py-3 text-xs text-muted">{t("common.loading")}</p>
        ) : null}
      </div>

      {selected ? (
        <div className="mt-6 rounded-xl border border-line p-4">
          {detailLoading ? (
            <p className="text-sm text-muted">{t("common.loading")}</p>
          ) : detail ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-ink">
                    {detail.tenant.name}
                  </h3>
                  <p className="font-mono text-xs text-muted">
                    {detail.tenant.id}
                  </p>
                </div>
                <div className="flex gap-2">
                  {detail.tenant.status === "suspended" ? (
                    <button
                      type="button"
                      className={primaryButton}
                      disabled={busy}
                      onClick={() => void changeStatus("active")}
                    >
                      {busy
                        ? t("adminConsole.working")
                        : t("adminConsole.reactivate")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={dangerButton}
                      disabled={busy}
                      onClick={() => void changeStatus("suspended")}
                    >
                      {busy ? t("adminConsole.working") : t("adminConsole.suspend")}
                    </button>
                  )}
                </div>
              </div>

              {detail.tenant.status === "suspended" ? (
                <p className="mt-3 rounded-lg bg-surface p-3 text-sm text-danger">
                  {t("adminConsole.suspendedNote")}
                  {detail.tenant.statusReason
                    ? ` — ${detail.tenant.statusReason}`
                    : ""}
                </p>
              ) : (
                <label className="mt-3 block">
                  <span className="text-xs text-muted">
                    {t("adminConsole.reasonLabel")}
                  </span>
                  <input
                    className={inputClassName}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t("adminConsole.reasonPlaceholder")}
                    maxLength={500}
                  />
                </label>
              )}

              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <KeyValue
                  label={t("adminConsole.contactsLabel")}
                  value={String(detail.counts.contacts)}
                />
                <KeyValue
                  label={t("adminConsole.conversationsLabel")}
                  value={String(detail.counts.conversations)}
                />
                <KeyValue
                  label={t("adminConsole.messagesLabel")}
                  value={String(detail.counts.messages)}
                />
                <KeyValue
                  label={t("adminConsole.createdLabel")}
                  value={formatDateTime(detail.tenant.createdAt, locale)}
                />
              </dl>

              <h4 className="mt-5 text-sm font-semibold text-ink">
                {t("adminConsole.membersTitle")}
              </h4>
              <ul className="mt-2 space-y-1 text-sm">
                {detail.members.map((m) => (
                  <li key={m.userId} className="flex flex-wrap gap-2">
                    <span className="text-ink">{m.email}</span>
                    <span className="text-muted">· {m.role}</span>
                  </li>
                ))}
                {detail.members.length === 0 ? (
                  <li className="text-muted">{t("adminConsole.emptyValue")}</li>
                ) : null}
              </ul>

              <h4 className="mt-5 text-sm font-semibold text-ink">
                {t("adminConsole.channelsTitle")}
              </h4>
              <ul className="mt-2 space-y-1 text-sm">
                {detail.channels.map((ch) => (
                  <li key={ch.id} className="flex flex-wrap gap-2">
                    <span className="text-ink">{ch.provider}</span>
                    <span className="text-muted">
                      · {ch.displayName ?? "—"} · {ch.status}
                    </span>
                  </li>
                ))}
                {detail.channels.length === 0 ? (
                  <li className="text-muted">{t("adminConsole.emptyValue")}</li>
                ) : null}
              </ul>

              <h4 className="mt-5 text-sm font-semibold text-ink">
                {t("adminConsole.recentAuditTitle")}
              </h4>
              <ul className="mt-2 space-y-1 text-xs">
                {detail.recentAudit.map((a) => (
                  <li key={a.id} className="flex flex-wrap gap-2">
                    <span className="font-mono text-ink">{a.action}</span>
                    <span className="text-muted">
                      {formatDateTime(a.createdAt, locale)}
                    </span>
                  </li>
                ))}
                {detail.recentAudit.length === 0 ? (
                  <li className="text-muted">{t("adminConsole.emptyValue")}</li>
                ) : null}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
