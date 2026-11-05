import { useCallback, useEffect, useRef, useState } from "react";
import type { FailedMessageResponse } from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api, ApiClientError } from "../api/client";
import { translateApiError } from "../api/errorText";
import { inputClassName } from "../components/AuthLayout";
import { usePolling } from "../hooks/usePolling";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface FailedMessagesPanelProps {
  t: Translate;
  locale: Locale;
}

const FAILED_PROVIDER_VALUES = [
  "telegram",
  "whatsapp",
  "instagram",
  "messenger",
] as const;

/**
 * Pusat pesan keluar gagal (Fase 7B.2) — tab kedua halaman Logs: semua
 * pesan outbound berstatus `failed` milik workspace (yang ditandai
 * poller telegram/meta; webchat tidak pernah menghasilkan status ini),
 * dengan filter provider, paginasi kursor, dan aksi kirim ulang.
 * Kirim ulang hanya mengantrekan kembali (`failed` → `queued`) —
 * panel TIDAK pernah mengklaim pesan terkirim; status sesudahnya
 * dibuktikan percobaan poller berikutnya dan terlihat saat daftar
 * menyegar (pesan hilang dari daftar = sudah tidak `failed` lagi).
 * Endpoint-nya owner/admin saja, sama seperti log integrasi.
 */
export function FailedMessagesPanel({ t, locale }: FailedMessagesPanelProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [provider, setProvider] = useState("");
  const [messages, setMessages] = useState<FailedMessageResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<FailedMessageResponse | null>(
    null,
  );
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const loadedMoreRef = useRef(false);

  const fetchPage = useCallback(
    async (cursor?: string) => {
      if (!tenantId) return { messages: [], nextCursor: null };
      return api.failures.list(tenantId, {
        provider: provider || undefined,
        cursor,
        limit: 50,
      });
    },
    [tenantId, provider],
  );

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    loadedMoreRef.current = false;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const page = await fetchPage();
      if (requestSeq.current !== seq) return;
      setMessages(page.messages);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      if (err instanceof ApiClientError && err.status === 403) {
        setForbidden(true);
        setMessages([]);
      } else {
        setError(translateApiError(t, err));
      }
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [fetchPage, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Penyegaran senyap: berbeda dari log (append-only), status pesan
   *  BERUBAH — pesan yang sudah terkirim sesudah retry harus HILANG
   *  dari daftar. Bila hanya halaman pertama yang dimuat, daftar
   *  diganti utuh dengan hasil segar; bila pengguna sudah memuat
   *  lebih banyak, gabungkan seperti LogsPage (halaman dalam bisa
   *  sesaat basi sampai dimuat ulang penuh). */
  const refresh = useCallback(async () => {
    if (forbidden) return;
    try {
      const page = await fetchPage();
      if (!loadedMoreRef.current) {
        setMessages(page.messages);
        setNextCursor(page.nextCursor);
        return;
      }
      setMessages((prev) => {
        const freshIds = new Set(page.messages.map((m) => m.id));
        const rest = prev.filter((m) => !freshIds.has(m.id));
        const merged = [...page.messages, ...rest];
        merged.sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        );
        return merged;
      });
    } catch {
      // Penyegaran latar gagal diam — siklus berikut mencoba lagi.
    }
  }, [fetchPage, forbidden]);
  usePolling(refresh);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      loadedMoreRef.current = true;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...page.messages.filter((m) => !seen.has(m.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoadingMore(false);
    }
  };

  const confirmRetry = async () => {
    if (!retryTarget || !tenantId || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await api.failures.retry(tenantId, retryTarget.id);
      setRetryTarget(null);
      setNotice(t("logs.retryDone"));
      await load();
    } catch (err) {
      setRetryError(translateApiError(t, err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div>
      <h2 className="text-base font-semibold text-ink">
        {t("logs.failedTitle")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("logs.failedSubtitle")}
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("logs.filterProvider")}
          </span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className={`${inputClassName} sm:w-auto`}
          >
            <option value="">{t("logs.filterAll")}</option>
            {FAILED_PROVIDER_VALUES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      {forbidden ? (
        <p className="mt-4 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("logs.failedForbidden")}
        </p>
      ) : error ? (
        <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="mt-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          {notice}
        </p>
      ) : null}

      {loading && messages.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : null}

      {!loading && !forbidden && messages.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{t("logs.failedEmpty")}</p>
      ) : null}

      <div className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {messages.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-3 px-3 py-2.5"
          >
            <span className="w-32 shrink-0 text-xs text-muted">
              {formatDateTime(m.createdAt, locale)}
            </span>
            <span className="w-28 shrink-0 truncate text-sm font-medium text-ink">
              {m.channelDisplayName ?? m.provider}
            </span>
            <span className="w-32 shrink-0 truncate text-sm text-muted">
              {m.contactName ?? t("logs.contactUnknown")}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-muted">
              {m.contentPreview ?? ""}
            </span>
            {m.errorCode ? (
              <span className="inline-flex shrink-0 items-center rounded-full bg-danger/10 px-2 py-0.5 font-mono text-xs font-medium text-danger">
                {m.errorCode}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setRetryError(null);
                setNotice(null);
                setRetryTarget(m);
              }}
              className="shrink-0 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-elevated"
            >
              {t("logs.retryButton")}
            </button>
          </div>
        ))}
      </div>

      {nextCursor ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
          >
            {loadingMore ? t("logs.loadingMore") : t("logs.loadMore")}
          </button>
        </div>
      ) : null}

      {retryTarget ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-bold text-ink">
                {t("logs.retryTitle")}
              </h2>
              <button
                type="button"
                onClick={() => setRetryTarget(null)}
                className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
              >
                {t("common.close")}
              </button>
            </div>
            <p className="mt-3 text-sm text-muted">{t("logs.retryBody")}</p>
            {retryTarget.errorCode ? (
              <p className="mt-3 text-sm text-muted">
                {t("logs.errorCodeLabel")}:{" "}
                <span className="font-mono text-danger">
                  {retryTarget.errorCode}
                </span>
              </p>
            ) : null}
            {retryError ? (
              <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                {retryError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRetryTarget(null)}
                className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmRetry()}
                disabled={retrying}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {retrying ? t("logs.retrying") : t("logs.retryConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
