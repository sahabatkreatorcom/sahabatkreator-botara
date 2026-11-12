/**
 * Panel riwayat versi sebuah flow (G3).
 */
import {
  type FlowResponse,
  type FlowVersionResponse,
} from "@sahabat-kreator/contracts";
import { type Locale } from "@sahabat-kreator/i18n";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { formatDateTime } from "../../utils/format";
import { type Translate } from "./types";

export interface FlowVersionsPanelProps {
  t: Translate;
  locale: Locale;
  tenantId: string;
  flowId: string;
  /** Hanya owner/admin yang boleh memulihkan (selaras gerbang API). */
  canManage: boolean;
  /** Dipanggil sesudah pemulihan sukses dengan flow hasil terbaru. */
  onRestored: (flow: FlowResponse) => void;
}

/**
 * Riwayat versi flow (G3): satu baris per aktivasi (snapshot graf
 * yang tidak bisa diubah, ditulis server di transaksi aktivasi).
 * Pemulihan mengaktifkan isi snapshot lama sebagai versi BARU —
 * sejarah append-only. Konfirmasi pemulihan dua langkah sebaris
 * (pola halaman Flows/Broadcasts). Panel ini hanya menampilkan +
 * memicu; seluruh semantik (draft kotor, validasi snapshot) ditegakkan
 * server dan kesalahannya diterjemahkan lewat translateApiError.
 */
export function FlowVersionsPanel({
  t,
  locale,
  tenantId,
  flowId,
  canManage,
  onRestored,
}: FlowVersionsPanelProps) {
  const [versions, setVersions] = useState<FlowVersionResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.flows.listVersions(tenantId, flowId);
      setVersions(res.versions);
      setError(null);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoaded(true);
    }
  }, [tenantId, flowId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (version: number) => {
    setRestoring(version);
    setError(null);
    setNotice(null);
    try {
      const res = await api.flows.restoreVersion(tenantId, flowId, version);
      setConfirming(null);
      setNotice(
        t("flows.restoredOk", {
          from: version,
          to: res.version.version,
        }),
      );
      onRestored(res.flow);
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">
        {t("flows.versionsTitle")}
      </h3>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        {t("flows.versionsHint")}
      </p>
      {error ? (
        <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          {notice}
        </p>
      ) : null}
      {!loaded ? null : versions.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("flows.versionsEmpty")}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {versions.map((v) => (
            <li
              key={v.id}
              className="rounded-xl border border-line bg-surface px-3 py-2.5"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink">
                  {t("flows.versionLabel", { version: v.version })}
                </span>
                <span className="text-sm text-ink">{v.name}</span>
                {v.isCurrent ? (
                  <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                    {t("flows.versionCurrent")}
                  </span>
                ) : null}
                {v.restoredFromVersion !== null ? (
                  <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 text-xs font-medium text-muted">
                    {t("flows.versionRestoredFrom", {
                      version: v.restoredFromVersion,
                    })}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-xs text-muted">
                {formatDateTime(v.createdAt, locale)}
                {" · "}
                {t("flows.versionMeta", {
                  nodes: v.nodeCount,
                  edges: v.edgeCount,
                })}
                {" · "}
                {v.activatedByUserId
                  ? t("flows.versionActivatedBy", {
                      user: v.activatedByUserId.slice(0, 8),
                    })
                  : t("flows.versionActivatedBySystem")}
              </span>
              {canManage && !v.isCurrent ? (
                <span className="mt-2 block">
                  {confirming === v.version ? (
                    <>
                      <button
                        type="button"
                        disabled={restoring !== null}
                        onClick={() => void restore(v.version)}
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {restoring === v.version
                          ? t("flows.restoring")
                          : t("flows.restoreConfirm")}
                      </button>
                      <button
                        type="button"
                        disabled={restoring !== null}
                        onClick={() => setConfirming(null)}
                        className="ml-2 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-elevated disabled:opacity-50"
                      >
                        {t("common.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirming(v.version)}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-elevated"
                    >
                      {t("flows.restoreButton")}
                    </button>
                  )}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
