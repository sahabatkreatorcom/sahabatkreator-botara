import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FlowResponse,
  FlowStatus,
  FlowTemplateCategory,
  FlowTemplateSummary,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { formatRelativeTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { summarizeTrigger } from "../flows/graphModel";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface FlowsPageProps {
  t: Translate;
  locale: Locale;
  /** Buka builder canvas untuk flow ini (navigasi ke /flows/:flowId). */
  onOpenBuilder: (flowId: string) => void;
}

const STATUS_CHIP: Record<
  FlowStatus,
  { labelKey: TranslationKey; className: string }
> = {
  draft: { labelKey: "flows.statusDraft", className: "bg-elevated text-muted" },
  active: { labelKey: "flows.statusActive", className: "bg-success/15 text-success" },
  archived: { labelKey: "flows.statusArchived", className: "bg-elevated text-muted" },
};

const TPL_CATEGORY_KEYS: Record<FlowTemplateCategory, TranslationKey> = {
  onboarding: "flows.tplCatOnboarding",
  sales: "flows.tplCatSales",
  support: "flows.tplCatSupport",
  event: "flows.tplCatEvent",
  lead: "flows.tplCatLead",
};

const FILTERS: { value: FlowStatus | "all"; labelKey: TranslationKey }[] = [
  { value: "all", labelKey: "flows.filterAll" },
  { value: "draft", labelKey: "flows.filterDraft" },
  { value: "active", labelKey: "flows.filterActive" },
  { value: "archived", labelKey: "flows.filterArchived" },
];

function StatusChip({ t, status }: { t: Translate; status: FlowStatus }) {
  const chip = STATUS_CHIP[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip.className}`}
    >
      {t(chip.labelKey)}
    </span>
  );
}

/**
 * Halaman daftar Flows (Fase 8B): daftar flow workspace dengan chip
 * status, ringkasan pemicu, jumlah run, dan aksi status (aktif/
 * nonaktif/arsip/hapus draf). Builder canvas-nya adalah halaman
 * terpisah (/flows/:flowId — FlowBuilderPage). Mutasi owner/admin
 * (selaras API 8A); member biasa hanya membaca. Konfirmasi hapus
 * mengikuti pola dua langkah sebaris halaman Broadcasts.
 */
export function FlowsPage({ t, locale, onOpenBuilder }: FlowsPageProps) {
  const { status, active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";

  const [filter, setFilter] = useState<FlowStatus | "all">("all");
  const [items, setItems] = useState<FlowResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [templates, setTemplates] = useState<FlowTemplateSummary[] | null>(
    null,
  );
  const [usingSlug, setUsingSlug] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const loadTemplates = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await api.flows.listTemplates(tenantId);
      setTemplates(res.templates);
    } catch (err) {
      setError(translateApiError(t, err));
    }
  }, [tenantId, t]);

  useEffect(() => {
    if (galleryOpen && templates === null) void loadTemplates();
  }, [galleryOpen, templates, loadTemplates]);

  const applyTemplate = async (tpl: FlowTemplateSummary) => {
    if (!tenantId || usingSlug) return;
    setUsingSlug(tpl.slug);
    setError(null);
    try {
      const flow = await api.flows.instantiateTemplate(tenantId, tpl.slug, {
        name: t(tpl.nameKey as TranslationKey),
      });
      setGalleryOpen(false);
      onOpenBuilder(flow.id);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setUsingSlug(null);
    }
  };

  const load = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.flows.list(tenantId, {
        limit: 50,
        ...(filter !== "all" ? { status: filter } : {}),
      });
      if (requestSeq.current !== seq) return;
      setItems(page.flows);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setItems([]);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!tenantId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.flows.list(tenantId, {
        limit: 50,
        cursor: nextCursor,
        ...(filter !== "all" ? { status: filter } : {}),
      });
      setItems((prev) => [...prev, ...page.flows]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoadingMore(false);
    }
  };

  const act = async (
    flow: FlowResponse,
    action: "activate" | "deactivate" | "archive" | "unarchive" | "delete",
  ) => {
    if (!tenantId || busyId) return;
    if (action === "delete" && confirming !== flow.id) {
      setConfirming(flow.id);
      return;
    }
    setConfirming(null);
    setBusyId(flow.id);
    setError(null);
    try {
      if (action === "activate") await api.flows.activate(tenantId, flow.id);
      else if (action === "deactivate")
        await api.flows.deactivate(tenantId, flow.id);
      else if (action === "archive") await api.flows.archive(tenantId, flow.id);
      else if (action === "unarchive")
        await api.flows.unarchive(tenantId, flow.id);
      else await api.flows.remove(tenantId, flow.id);
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    if (!tenantId || creating || !createName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const flow = await api.flows.create(tenantId, {
        name: createName.trim(),
      });
      setCreateOpen(false);
      setCreateName("");
      onOpenBuilder(flow.id);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setCreating(false);
    }
  };

  if (status === "loading") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("flows.title")}</h1>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("flows.title")}</h1>
        <p className="mt-6 text-sm text-danger">{t("workspace.loadError")}</p>
      </section>
    );
  }

  const actionButton =
    "rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-elevated disabled:opacity-50";

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t("flows.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {t("flows.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setGalleryOpen((v) => !v)}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-elevated"
          >
            {t("flows.tplGalleryButton")}
          </button>
          {canManage ? (
            <button
              type="button"
              onClick={() => setCreateOpen((v) => !v)}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {t("flows.createButton")}
            </button>
          ) : null}
        </div>
      </div>

      {galleryOpen ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">
            {t("flows.tplGalleryTitle")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {t("flows.tplGallerySubtitle")}
          </p>
          {templates === null ? (
            <p className="mt-4 text-sm text-muted">{t("workspace.loading")}</p>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {templates.map((tpl) => (
                <li
                  key={tpl.slug}
                  className="flex flex-col rounded-xl border border-line bg-elevated/40 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink">
                      {t(tpl.nameKey as TranslationKey)}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                      {t(TPL_CATEGORY_KEYS[tpl.category])}
                    </span>
                  </div>
                  <p className="mt-2 flex-1 text-sm text-muted">
                    {t(tpl.descriptionKey as TranslationKey)}
                  </p>
                  <p className="mt-2 text-xs text-muted">
                    {t("flows.tplNodeCount", { count: tpl.nodeCount })}
                  </p>
                  {tpl.needs.length > 0 ? (
                    <p className="mt-2">
                      <span className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                        {t("flows.tplNeedsLabel")}{" "}
                        {tpl.needs
                          .map((n) =>
                            n === "product"
                              ? t("flows.tplNeedsProduct")
                              : n === "service"
                                ? t("flows.tplNeedsService")
                                : n,
                          )
                          .join(", ")}
                      </span>
                    </p>
                  ) : null}
                  {canManage ? (
                    <button
                      type="button"
                      disabled={usingSlug !== null}
                      onClick={() => void applyTemplate(tpl)}
                      className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {usingSlug === tpl.slug
                        ? t("flows.tplUsing")
                        : t("flows.tplUseButton")}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {!canManage ? (
        <p className="mt-4 rounded-lg bg-elevated px-3 py-2 text-sm text-muted">
          {t("flows.forbidden")}
        </p>
      ) : null}

      {createOpen ? (
        <form
          className="mt-4 max-w-xl rounded-xl border border-line bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h2 className="text-sm font-semibold text-ink">
            {t("flows.createTitle")}
          </h2>
          <label
            className="mt-3 block text-sm font-medium text-ink"
            htmlFor="flow-name"
          >
            {t("flows.nameLabel")}
          </label>
          <input
            id="flow-name"
            className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder={t("flows.namePlaceholder")}
            maxLength={255}
            autoFocus
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={creating || !createName.trim()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t("flows.createSubmit")}
            </button>
            <button
              type="button"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
              className="rounded-lg px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
            >
              {t("flows.cancel")}
            </button>
          </div>
        </form>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f.value
                ? "bg-accent text-white"
                : "bg-elevated text-muted hover:text-ink"
            }`}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      ) : items.length === 0 ? (
        <div className="mt-8 rounded-xl border border-line bg-surface p-6 text-center">
          <p className="text-sm font-medium text-ink">{t("flows.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("flows.emptyHint")}</p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((flow) => (
            <li
              key={flow.id}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenBuilder(flow.id)}
                  className="text-left text-sm font-semibold text-ink hover:underline"
                >
                  {flow.name}
                </button>
                <StatusChip t={t} status={flow.status} />
              </div>
              <p className="mt-1 text-xs text-muted">
                {summarizeTrigger(t, flow.graph)}
                {" · "}
                {t("flows.runCount", { count: flow.runCount })}
                {" · "}
                {t("flows.updatedLabel", {
                  when: formatRelativeTime(flow.updatedAt, locale),
                })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onOpenBuilder(flow.id)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  {t("flows.openBuilder")}
                </button>
                {canManage && flow.status === "draft" ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === flow.id}
                      onClick={() => void act(flow, "activate")}
                      className={actionButton}
                    >
                      {t("flows.activateAction")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === flow.id}
                      onClick={() => void act(flow, "archive")}
                      className={actionButton}
                    >
                      {t("flows.archiveAction")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === flow.id}
                      onClick={() => void act(flow, "delete")}
                      className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                    >
                      {confirming === flow.id
                        ? t("flows.confirmDelete")
                        : t("flows.deleteAction")}
                    </button>
                  </>
                ) : null}
                {canManage && flow.status === "active" ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === flow.id}
                      onClick={() => void act(flow, "deactivate")}
                      className={actionButton}
                    >
                      {t("flows.deactivateAction")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === flow.id}
                      onClick={() => void act(flow, "archive")}
                      className={actionButton}
                    >
                      {t("flows.archiveAction")}
                    </button>
                  </>
                ) : null}
                {canManage && flow.status === "archived" ? (
                  <button
                    type="button"
                    disabled={busyId === flow.id}
                    onClick={() => void act(flow, "unarchive")}
                    className={actionButton}
                  >
                    {t("flows.unarchiveAction")}
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
            className="rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-elevated disabled:opacity-50"
          >
            {loadingMore ? t("flows.loadingMore") : t("flows.loadMore")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
