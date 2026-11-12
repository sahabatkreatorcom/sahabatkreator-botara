/**
 * Halaman Broadcasts.
 *
 * Berkas ini menyimpan yang memang hanya milik halaman: state tampilan,
 * pemuatan daftar, dan penyusunan tata letak. Bagian yang dapat berdiri
 * sendiri sudah dipindah ke `./broadcasts/` — kartu opt-in, formulir,
 * panel detail, dan seksi template WhatsApp.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BroadcastResponse } from "@sahabat-kreator/contracts";

import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { usePolling } from "../hooks/usePolling";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { BroadcastDetail } from "./broadcasts/BroadcastDetail";
import { BroadcastForm } from "./broadcasts/BroadcastForm";
import { OptInSettingsCard } from "./broadcasts/OptInSettingsCard";
import { RecurrenceSection } from "./broadcasts/RecurrenceSection";
import { WhatsAppTemplatesSection } from "./broadcasts/WhatsAppTemplatesSection";
import { StatusChip } from "./broadcasts/chips";
import {
  DISPATCH_ERROR_LABEL_KEYS,
  PROVIDER_NAMES,
  type BroadcastsPageProps,
} from "./broadcasts/types";

type View =
  | { kind: "list" }
  | { kind: "form"; target: "create" | BroadcastResponse }
  | { kind: "detail"; id: string };

/**
 * Halaman Broadcasts (Fase 7C): daftar kampanye siaran + formulir buat/
 * edit draf + panel detail berisi statistik & daftar penerima.
 *
 * Keputusan v1 yang terlihat di UI (jujur, dwibahasa): webchat tampil
 * NONAKTIF beralasan di pemilih channel (tanpa semantik push);
 * WhatsApp (Fase 10A) mengirim TEMPLATE resmi yang disetujui —
 * formulirnya menukar kotak teks bebas dengan pemilih template +
 * pemetaan variabel per posisi; penerima Meta di luar jendela 24 jam
 * tampil sebagai `skipped` beralasan, bukan gagal. Seksi Template
 * WhatsApp di bawah daftar mengelola cermin template per akun
 * (sinkron/buat/hapus ke Meta). Mutasi hanya untuk owner/admin
 * (selaras API); member biasa membaca. Konfirmasi batal/hapus memakai
 * pola dua langkah sebaris (klik → tombol berubah menjadi konfirmasi),
 * konsisten tanpa modal global.
 */
export function BroadcastsPage({ t, locale }: BroadcastsPageProps) {
  const { status, active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";

  const [view, setView] = useState<View>({ kind: "list" });
  const [items, setItems] = useState<BroadcastResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // G9: benih formulir jadwal berulang dari tombol "Jadikan berulang".
  const [recurrenceSeed, setRecurrenceSeed] = useState<{
    sourceId: string;
    nonce: number;
  } | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!tenantId) return;
      const seq = ++requestSeq.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const page = await api.broadcasts.list(tenantId, { limit: 50 });
        if (requestSeq.current !== seq) return;
        setItems(page.broadcasts);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (requestSeq.current !== seq) return;
        if (!silent) {
          setError(translateApiError(t, err));
          setItems([]);
        }
      } finally {
        if (requestSeq.current === seq && !silent) setLoading(false);
      }
    },
    [tenantId, t],
  );

  useEffect(() => {
    if (view.kind === "list") void load();
  }, [load, view.kind]);

  const anySending = items.some((b) => b.status === "sending");
  usePolling(
    () => {
      void load(true);
    },
    5000,
    view.kind === "list" && anySending,
  );

  const loadMore = async () => {
    if (!tenantId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.broadcasts.list(tenantId, {
        limit: 50,
        cursor: nextCursor,
      });
      setItems((prev) => [...prev, ...page.broadcasts]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoadingMore(false);
    }
  };

  const act = async (
    broadcast: BroadcastResponse,
    action: "send-now" | "cancel" | "delete",
  ) => {
    if (!tenantId || busyId) return;
    if (confirming !== `${action}:${broadcast.id}`) {
      if (action !== "send-now") {
        setConfirming(`${action}:${broadcast.id}`);
        return;
      }
    }
    setConfirming(null);
    setBusyId(broadcast.id);
    setError(null);
    try {
      if (action === "send-now") {
        await api.broadcasts.schedule(tenantId, broadcast.id, {});
      } else if (action === "cancel") {
        await api.broadcasts.cancel(tenantId, broadcast.id);
      } else {
        await api.broadcasts.remove(tenantId, broadcast.id);
      }
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusyId(null);
    }
  };

  if (status === "loading") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("broadcasts.title")}</h1>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("broadcasts.title")}</h1>
        <p className="mt-6 text-sm text-danger">{t("workspace.loadError")}</p>
      </section>
    );
  }

  if (view.kind === "form") {
    return (
      <BroadcastForm
        t={t}
        tenantId={tenantId}
        target={view.target}
        onDone={() => setView({ kind: "list" })}
        onCancel={() => setView({ kind: "list" })}
      />
    );
  }

  if (view.kind === "detail") {
    return (
      <BroadcastDetail
        t={t}
        locale={locale}
        tenantId={tenantId}
        broadcastId={view.id}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t("broadcasts.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {t("broadcasts.subtitle")}
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setView({ kind: "form", target: "create" })}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            {t("broadcasts.createButton")}
          </button>
        ) : null}
      </div>

      {!canManage ? (
        <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          {t("broadcasts.forbidden")}
        </p>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      ) : items.length === 0 ? (
        <div className="mt-8 rounded-xl border border-border bg-surface p-6 text-center">
          <p className="text-sm font-medium text-ink">{t("broadcasts.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("broadcasts.emptyHint")}</p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((b) => (
            <li
              key={b.id}
              className="rounded-xl border border-border bg-surface p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setView({ kind: "detail", id: b.id })}
                  className="text-left text-sm font-semibold text-ink hover:underline"
                >
                  {b.name}
                </button>
                <StatusChip t={t} status={b.status} />
                <span className="text-xs text-muted">
                  {PROVIDER_NAMES[b.provider]}
                  {b.channelDisplayName ? ` · ${b.channelDisplayName}` : ""}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {b.status === "scheduled" && b.scheduledAt
                  ? t("broadcasts.scheduledFor", {
                      when: formatDateTime(b.scheduledAt, locale),
                    })
                  : b.completedAt
                    ? t("broadcasts.sentAt", {
                        when: formatDateTime(b.completedAt, locale),
                      })
                    : b.startedAt
                      ? t("broadcasts.startedAt", {
                          when: formatDateTime(b.startedAt, locale),
                        })
                      : formatDateTime(b.createdAt, locale)}
                {b.stats.total > 0
                  ? ` · ${t("broadcasts.statsSummary", {
                      sent: b.stats.sent + b.stats.delivered + b.stats.read,
                      failed: b.stats.failed,
                      skipped: b.stats.skipped,
                      total: b.stats.total,
                    })}`
                  : ""}
              </p>
              {b.status === "failed" && b.errorCode ? (
                <p className="mt-1 text-xs text-danger">
                  {t("broadcasts.dispatchErrorLabel")}:{" "}
                  {DISPATCH_ERROR_LABEL_KEYS[b.errorCode]
                    ? t(DISPATCH_ERROR_LABEL_KEYS[b.errorCode])
                    : b.errorCode}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setView({ kind: "detail", id: b.id })}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
                >
                  {t("broadcasts.viewRecipients")}
                </button>
                {canManage ? (
                  <button
                    type="button"
                    onClick={() =>
                      setRecurrenceSeed({
                        sourceId: b.id,
                        nonce: Date.now(),
                      })
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
                  >
                    {t("broadcastRecurrence.makeRecurringAction")}
                  </button>
                ) : null}
                {canManage && b.status === "draft" ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === b.id}
                      onClick={() =>
                        setView({ kind: "form", target: b })
                      }
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
                    >
                      {t("broadcasts.editAction")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === b.id}
                      onClick={() => void act(b, "send-now")}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      {t("broadcasts.sendNowAction")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === b.id}
                      onClick={() => void act(b, "delete")}
                      className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
                    >
                      {confirming === `delete:${b.id}`
                        ? t("broadcasts.confirmDelete")
                        : t("broadcasts.deleteAction")}
                    </button>
                  </>
                ) : null}
                {canManage &&
                (b.status === "scheduled" || b.status === "sending") ? (
                  <button
                    type="button"
                    disabled={busyId === b.id}
                    onClick={() => void act(b, "cancel")}
                    className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
                  >
                    {confirming === `cancel:${b.id}`
                      ? t("broadcasts.confirmCancel")
                      : t("broadcasts.cancelBroadcastAction")}
                  </button>
                ) : null}
              </div>
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
            {loadingMore ? t("broadcasts.loadingMore") : t("broadcasts.loadMore")}
          </button>
        </div>
      ) : null}

      <RecurrenceSection
        t={t}
        locale={locale}
        tenantId={tenantId}
        canManage={canManage}
        seed={recurrenceSeed}
        onOpenBroadcast={(id) => setView({ kind: "detail", id })}
      />

      <OptInSettingsCard t={t} tenantId={tenantId} canManage={canManage} />

      <WhatsAppTemplatesSection
        t={t}
        tenantId={tenantId}
        canManage={canManage}
      />
    </section>
  );
}
