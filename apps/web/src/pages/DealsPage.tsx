import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  ContactConversation,
  ContactResponse,
  DealDetailResponse,
  DealPipelineAnalyticsResponse,
  DealPipelineResponse,
  DealPriority,
  DealResponse,
  DealStageKind,
  DealStageResponse,
  TeamMemberResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { formatDate, formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface DealsPageProps {
  t: Translate;
  locale: Locale;
}

/** Kode mata uang yang ditawarkan pemilih (nilai lain tetap tampil bila sudah terpakai deal). */
const CURRENCY_OPTIONS = [
  "IDR",
  "USD",
  "SGD",
  "MYR",
  "THB",
  "PHP",
  "VND",
  "EUR",
  "GBP",
  "JPY",
  "AUD",
  "HKD",
  "CNY",
  "INR",
  "AED",
] as const;

const PRIORITIES: DealPriority[] = ["low", "medium", "high"];
const STAGE_KINDS: DealStageKind[] = ["open", "won", "lost"];

const PRIORITY_KEYS: Record<DealPriority, TranslationKey> = {
  low: "deals.priorityLow",
  medium: "deals.priorityMedium",
  high: "deals.priorityHigh",
};

const STATUS_KEYS: Record<DealResponse["status"], TranslationKey> = {
  open: "deals.statusOpen",
  won: "deals.statusWon",
  lost: "deals.statusLost",
};

const STAGE_KIND_KEYS: Record<DealStageKind, TranslationKey> = {
  open: "deals.stageKindOpen",
  won: "deals.stageKindWon",
  lost: "deals.stageKindLost",
};

/** Format nilai uang menurut mata uang deal itu sendiri (Intl; jatuh ke "KODE angka" bila kode tak dikenal Intl). */
export function formatMoney(
  value: number,
  currency: string,
  locale: Locale,
): string {
  try {
    return new Intl.NumberFormat(locale === "id" ? "id-ID" : "en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString(locale === "id" ? "id-ID" : "en-US")}`;
  }
}

/** ISO datetime → nilai input datetime-local (waktu lokal peramban). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Nilai input datetime-local → ISO; string kosong → null. */
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Halaman Deals (G12) — papan Kanban pipeline penjualan: kolom =
 * tahap pipeline, kartu = deal (judul, kontak, nilai + mata uang
 * terformat, tenggat, penanggung jawab). Pindah tahap bisa diseret
 * (pola seret HTML5 yang sama dengan kalender Postingan) atau dipilih
 * dari panel detail — keduanya memanggil endpoint move yang sama,
 * jadi riwayat tahap + status terminal won/lost selalu tercatat.
 * Analitik ringan (total per tahap per mata uang, deal menang/kalah,
 * rata-rata hari ke menang) tampil di halaman ini, bukan halaman
 * analitik terpisah.
 */
export function DealsPage({ t, locale }: DealsPageProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";
  const canOperate = active?.role !== "viewer" && active?.role !== undefined;

  const [pipelines, setPipelines] = useState<DealPipelineResponse[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [deals, setDeals] = useState<DealResponse[]>([]);
  const [analytics, setAnalytics] =
    useState<DealPipelineAnalyticsResponse | null>(null);
  const [defaultCurrency, setDefaultCurrency] = useState("IDR");
  const [currencyDraft, setCurrencyDraft] = useState("IDR");
  const [members, setMembers] = useState<TeamMemberResponse[]>([]);
  const [contacts, setContacts] = useState<ContactResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pipelineFormOpen, setPipelineFormOpen] = useState(false);
  const [pipelineName, setPipelineName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deletePipelineOpen, setDeletePipelineOpen] = useState(false);
  const [stagesOpen, setStagesOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<DealDetailResponse | null>(null);
  const [dragOverStageId, setDragOverStageId] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const pipeline = useMemo(
    () => pipelines.find((p) => p.id === pipelineId) ?? pipelines[0] ?? null,
    [pipelines, pipelineId],
  );

  const loadBoard = useCallback(
    async (forPipelineId: string) => {
      if (!tenantId) return;
      const [dealList, analyticsRes] = await Promise.all([
        api.deals.list(tenantId, { pipelineId: forPipelineId, limit: 1000 }),
        api.deals.analytics(tenantId, forPipelineId).catch(() => null),
      ]);
      setDeals(dealList);
      setAnalytics(analyticsRes);
    },
    [tenantId],
  );

  const load = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [pipelineList, settings, memberList, contactList] =
        await Promise.all([
          api.deals.listPipelines(tenantId),
          api.deals.getSettings(tenantId).catch(() => null),
          api.team.listMembers(tenantId).catch(() => [] as TeamMemberResponse[]),
          api.contacts
            .list(tenantId, { limit: 200 })
            .catch(() => ({ contacts: [] as ContactResponse[] })),
        ]);
      if (requestSeq.current !== seq) return;
      setPipelines(pipelineList);
      if (settings) {
        setDefaultCurrency(settings.defaultCurrency);
        setCurrencyDraft(settings.defaultCurrency);
      }
      setMembers(memberList);
      setContacts(contactList.contacts);
      const selected =
        pipelineList.find((p) => p.id === pipelineId) ?? pipelineList[0];
      if (selected) {
        setPipelineId(selected.id);
        await loadBoard(selected.id);
      } else {
        setDeals([]);
        setAnalytics(null);
      }
    } catch (err) {
      if (requestSeq.current === seq) setError(translateApiError(t, err));
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
    // pipelineId sengaja tidak menjadi dependensi: pemilihan pipeline
    // ditangani handleSelectPipeline agar tidak memuat ulang daftar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, t, loadBoard]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSelectPipeline = async (id: string) => {
    setPipelineId(id);
    setDetail(null);
    try {
      await loadBoard(id);
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const refreshAll = useCallback(async () => {
    if (!tenantId) return;
    const pipelineList = await api.deals.listPipelines(tenantId);
    setPipelines(pipelineList);
    const selected =
      pipelineList.find((p) => p.id === (pipeline?.id ?? pipelineId)) ??
      pipelineList[0];
    if (selected) {
      setPipelineId(selected.id);
      await loadBoard(selected.id);
    }
  }, [tenantId, loadBoard, pipeline, pipelineId]);

  const moveDeal = async (deal: DealResponse, stageId: string) => {
    if (!tenantId || deal.stageId === stageId) return;
    try {
      await api.deals.move(tenantId, deal.id, { stageId });
      if (pipeline) await loadBoard(pipeline.id);
      if (detail?.id === deal.id) {
        setDetail(await api.deals.get(tenantId, deal.id));
      }
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const saveDefaultCurrency = async () => {
    if (!tenantId || currencyDraft === defaultCurrency) return;
    try {
      const saved = await api.deals.updateSettings(tenantId, {
        defaultCurrency: currencyDraft,
      });
      setDefaultCurrency(saved.defaultCurrency);
      setCurrencyDraft(saved.defaultCurrency);
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const submitPipeline = async (e: FormEvent) => {
    e.preventDefault();
    if (!tenantId || !pipelineName.trim()) return;
    try {
      const created = await api.deals.createPipeline(tenantId, {
        name: pipelineName.trim(),
      });
      setPipelineName("");
      setPipelineFormOpen(false);
      await refreshAll();
      setPipelineId(created.id);
      await loadBoard(created.id);
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!tenantId || !pipeline || !renameValue.trim()) return;
    try {
      await api.deals.updatePipeline(tenantId, pipeline.id, {
        name: renameValue.trim(),
      });
      setRenameOpen(false);
      await refreshAll();
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const confirmDeletePipeline = async () => {
    if (!tenantId || !pipeline) return;
    try {
      await api.deals.removePipeline(tenantId, pipeline.id);
      setDeletePipelineOpen(false);
      setPipelineId(null);
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
      setDeletePipelineOpen(false);
    }
  };

  const analyticsByStage = useMemo(() => {
    const map = new Map(
      (analytics?.stages ?? []).map((s) => [s.stageId, s] as const),
    );
    return map;
  }, [analytics]);

  const dealsByStage = useMemo(() => {
    const map = new Map<string, DealResponse[]>();
    for (const stage of pipeline?.stages ?? []) map.set(stage.id, []);
    for (const deal of deals) {
      const bucket = map.get(deal.stageId);
      if (bucket) bucket.push(deal);
    }
    return map;
  }, [deals, pipeline]);

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">{t("deals.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {t("deals.subtitle")}
          </p>
        </div>
        {canOperate ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            + {t("deals.newDeal")}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* Bar pipeline: pemilih + kelola + mata uang bawaan */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="deal-pipeline-select">
            Pipeline
          </label>
          <select
            id="deal-pipeline-select"
            className={`${inputClassName} mt-1 min-w-52`}
            value={pipeline?.id ?? ""}
            onChange={(e) => void handleSelectPipeline(e.target.value)}
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-elevated"
              onClick={() => {
                setPipelineFormOpen((v) => !v);
                setRenameOpen(false);
              }}
            >
              {t("deals.newPipeline")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-elevated"
              onClick={() => {
                setRenameValue(pipeline?.name ?? "");
                setRenameOpen((v) => !v);
                setPipelineFormOpen(false);
              }}
            >
              {t("deals.renamePipeline")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-elevated"
              onClick={() => setStagesOpen((v) => !v)}
            >
              {t("deals.manageStages")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-danger/50 px-3 py-2 text-sm text-danger hover:bg-danger/10"
              onClick={() => setDeletePipelineOpen(true)}
            >
              {t("deals.deletePipeline")}
            </button>
          </div>
        ) : null}
        <div className="ml-auto flex items-end gap-2">
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-default-currency">
              {t("deals.defaultCurrencyLabel")}
            </label>
            <select
              id="deal-default-currency"
              className={`${inputClassName} mt-1`}
              value={currencyDraft}
              disabled={!canManage}
              onChange={(e) => setCurrencyDraft(e.target.value)}
            >
              {[...new Set([currencyDraft, ...CURRENCY_OPTIONS])].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          {canManage && currencyDraft !== defaultCurrency ? (
            <button
              type="button"
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              onClick={() => void saveDefaultCurrency()}
            >
              {t("common.save")}
            </button>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">{t("deals.defaultCurrencyHint")}</p>

      {pipelineFormOpen ? (
        <form
          onSubmit={submitPipeline}
          className="mt-3 flex max-w-md flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3"
        >
          <div className="min-w-56 flex-1">
            <label className="block text-xs font-medium text-muted" htmlFor="deal-pipeline-name">
              {t("deals.pipelineNameLabel")}
            </label>
            <input
              id="deal-pipeline-name"
              className={`${inputClassName} mt-1`}
              value={pipelineName}
              placeholder={t("deals.pipelineNamePlaceholder")}
              onChange={(e) => setPipelineName(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {t("deals.createPipeline")}
          </button>
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
            onClick={() => setPipelineFormOpen(false)}
          >
            {t("common.cancel")}
          </button>
        </form>
      ) : null}

      {renameOpen ? (
        <form
          onSubmit={submitRename}
          className="mt-3 flex max-w-md flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3"
        >
          <div className="min-w-56 flex-1">
            <label className="block text-xs font-medium text-muted" htmlFor="deal-pipeline-rename">
              {t("deals.pipelineNameLabel")}
            </label>
            <input
              id="deal-pipeline-rename"
              className={`${inputClassName} mt-1`}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {t("common.save")}
          </button>
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
            onClick={() => setRenameOpen(false)}
          >
            {t("common.cancel")}
          </button>
        </form>
      ) : null}

      {/* Analitik ringan */}
      {analytics ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-xs text-muted">{t("deals.analyticsWon")}</p>
            <p className="mt-0.5 text-lg font-semibold text-ink">
              {analytics.wonCount}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-xs text-muted">{t("deals.analyticsLost")}</p>
            <p className="mt-0.5 text-lg font-semibold text-ink">
              {analytics.lostCount}
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-xs text-muted">{t("deals.analyticsAvgDaysToWon")}</p>
            <p className="mt-0.5 text-lg font-semibold text-ink">
              {analytics.avgDaysToWon !== null
                ? `${analytics.avgDaysToWon} ${t("deals.analyticsDaysUnit")}`
                : t("deals.analyticsNoWon")}
            </p>
          </div>
        </div>
      ) : null}

      {stagesOpen && pipeline ? (
        <StageManager
          t={t}
          tenantId={tenantId!}
          pipeline={pipeline}
          dealCounts={analyticsByStage}
          canManage={canManage}
          onChanged={refreshAll}
          onError={(msg) => setError(msg)}
        />
      ) : null}

      {/* Papan Kanban */}
      {loading && pipelines.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : !pipeline || pipeline.stages.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          {t("deals.boardEmpty")}
        </p>
      ) : (
        <div className="mt-5 flex gap-3 overflow-x-auto pb-4">
          {pipeline.stages.map((stage) => {
            const stageDeals = dealsByStage.get(stage.id) ?? [];
            const stageAnalytics = analyticsByStage.get(stage.id);
            return (
              <div
                key={stage.id}
                className={`flex w-72 shrink-0 flex-col rounded-xl border bg-surface/50 ${
                  dragOverStageId === stage.id
                    ? "border-accent"
                    : "border-line"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverStageId(stage.id);
                }}
                onDragLeave={() => setDragOverStageId(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverStageId(null);
                  const dealId = e.dataTransfer.getData("text/deal-id");
                  const deal = deals.find((d) => d.id === dealId);
                  if (deal) void moveDeal(deal, stage.id);
                }}
              >
                <div className="border-b border-line px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: stage.color }}
                    />
                    <h2 className="truncate text-sm font-semibold text-ink">
                      {stage.name}
                    </h2>
                    <span className="ml-auto text-xs text-muted">
                      {t("deals.columnTotal", { count: stageDeals.length })}
                    </span>
                  </div>
                  {stageAnalytics && stageAnalytics.totals.length > 0 ? (
                    <p className="mt-1 text-xs text-muted">
                      {stageAnalytics.totals
                        .map((total) =>
                          formatMoney(total.total, total.currency, locale),
                        )
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>
                <div className="flex min-h-24 flex-col gap-2 p-2.5">
                  {stageDeals.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted">
                      {t("deals.columnEmpty")}
                    </p>
                  ) : (
                    stageDeals.map((deal) => (
                      <DealCard
                        key={deal.id}
                        t={t}
                        locale={locale}
                        deal={deal}
                        draggable={canOperate}
                        onOpen={() => {
                          if (!tenantId) return;
                          api.deals
                            .get(tenantId, deal.id)
                            .then(setDetail)
                            .catch((err: unknown) =>
                              setError(translateApiError(t, err)),
                            );
                        }}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {createOpen && pipeline ? (
        <DealCreateModal
          t={t}
          locale={locale}
          tenantId={tenantId!}
          pipeline={pipeline}
          contacts={contacts}
          members={members}
          defaultCurrency={defaultCurrency}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            if (pipeline) await loadBoard(pipeline.id);
          }}
          onError={(msg) => setError(msg)}
        />
      ) : null}

      {detail ? (
        <DealDetailDrawer
          t={t}
          locale={locale}
          tenantId={tenantId!}
          detail={detail}
          pipeline={pipeline}
          contacts={contacts}
          members={members}
          canOperate={canOperate}
          canManage={canManage}
          onClose={() => setDetail(null)}
          onChanged={async () => {
            if (pipeline) await loadBoard(pipeline.id);
            setDetail(await api.deals.get(tenantId!, detail.id));
          }}
          onDeleted={async () => {
            setDetail(null);
            if (pipeline) await loadBoard(pipeline.id);
          }}
          onMove={(stageId) => {
            const deal = deals.find((d) => d.id === detail.id) ?? detail;
            void moveDeal(deal as DealResponse, stageId);
          }}
          onError={(msg) => setError(msg)}
        />
      ) : null}

      {deletePipelineOpen && pipeline ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl">
            <p className="text-sm text-ink">
              {t("deals.deletePipelineConfirm", { name: pipeline.name })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
                onClick={() => setDeletePipelineOpen(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                onClick={() => void confirmDeletePipeline()}
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}


/** Kartu deal di papan. Tenggat lampau pada deal terbuka ditandai merah. */
function DealCard({
  t,
  locale,
  deal,
  draggable,
  onOpen,
}: {
  t: Translate;
  locale: Locale;
  deal: DealResponse;
  draggable: boolean;
  onOpen: () => void;
}) {
  const overdue =
    deal.status === "open" &&
    deal.dueAt !== null &&
    new Date(deal.dueAt).getTime() < Date.now();
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/deal-id", deal.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      className="w-full rounded-lg border border-line bg-surface p-3 text-left shadow-sm transition hover:border-accent/60"
    >
      <p className="text-sm font-medium text-ink">{deal.title}</p>
      <p className="mt-0.5 truncate text-xs text-muted">{deal.contactName}</p>
      <p className="mt-1.5 text-sm font-semibold text-ink">
        {formatMoney(deal.value, deal.currency, locale)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            deal.priority === "high"
              ? "bg-danger/10 text-danger"
              : deal.priority === "medium"
                ? "bg-amber-500/10 text-amber-600"
                : "bg-elevated text-muted"
          }`}
        >
          {t(PRIORITY_KEYS[deal.priority])}
        </span>
        {deal.status !== "open" ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              deal.status === "won"
                ? "bg-emerald-500/10 text-emerald-600"
                : "bg-elevated text-muted"
            }`}
          >
            {t(STATUS_KEYS[deal.status])}
          </span>
        ) : null}
        {deal.dueAt ? (
          <span
            className={`text-[11px] ${overdue ? "font-semibold text-danger" : "text-muted"}`}
          >
            {overdue
              ? `${t("deals.overdue")} · ${formatDate(deal.dueAt, locale)}`
              : `${t("deals.dueAtLabel")}: ${formatDate(deal.dueAt, locale)}`}
          </span>
        ) : deal.expectedCloseDate ? (
          <span className="text-[11px] text-muted">
            {t("deals.expectedCloseLabel")}:{" "}
            {formatDate(deal.expectedCloseDate, locale)}
          </span>
        ) : null}
      </div>
      {deal.assigneeName ? (
        <p className="mt-1.5 text-[11px] text-muted">
          {t("deals.assigneeLabel")}: {deal.assigneeName}
        </p>
      ) : null}
    </button>
  );
}

/** Panel kelola tahap: ubah nama/warna/jenis, susun ulang (↑/↓), tambah, hapus aman. */
function StageManager({
  t,
  tenantId,
  pipeline,
  dealCounts,
  canManage,
  onChanged,
  onError,
}: {
  t: Translate;
  tenantId: string;
  pipeline: DealPipelineResponse;
  dealCounts: Map<string, { dealCount: number }>;
  canManage: boolean;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Partial<DealStageResponse>>>({});
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<DealStageKind>("open");
  const [newColor, setNewColor] = useState("#64748b");
  const [deleteStage, setDeleteStage] = useState<DealStageResponse | null>(null);
  const [moveTarget, setMoveTarget] = useState("");

  const stages = pipeline.stages;

  const patchStage = async (stage: DealStageResponse) => {
    const draft = drafts[stage.id];
    if (!draft) return;
    try {
      await api.deals.updateStage(tenantId, pipeline.id, stage.id, {
        name: draft.name ?? stage.name,
        color: draft.color ?? stage.color,
        kind: draft.kind ?? stage.kind,
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[stage.id];
        return next;
      });
      await onChanged();
    } catch (err) {
      onError(translateApiError(t, err));
    }
  };

  const reorder = async (orderedIds: string[]) => {
    try {
      await api.deals.reorderStages(tenantId, pipeline.id, {
        stageIds: orderedIds,
      });
      await onChanged();
    } catch (err) {
      onError(translateApiError(t, err));
    }
  };

  const move = (index: number, delta: number) => {
    const ids = stages.map((s) => s.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void reorder(ids);
  };

  const addStage = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.deals.createStage(tenantId, pipeline.id, {
        name: newName.trim(),
        color: newColor,
        kind: newKind,
      });
      setNewName("");
      await onChanged();
    } catch (err) {
      onError(translateApiError(t, err));
    }
  };

  const confirmDeleteStage = async () => {
    if (!deleteStage) return;
    const count = dealCounts.get(deleteStage.id)?.dealCount ?? 0;
    try {
      await api.deals.removeStage(tenantId, pipeline.id, deleteStage.id, {
        moveDealsToStageId: count > 0 ? moveTarget || undefined : undefined,
      });
      setDeleteStage(null);
      setMoveTarget("");
      await onChanged();
    } catch (err) {
      onError(translateApiError(t, err));
    }
  };

  return (
    <div className="mt-5 rounded-xl border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">{t("deals.stagesTitle")}</h2>
      <p className="mt-0.5 text-xs text-muted">{t("deals.stagesHint")}</p>
      <ul className="mt-3 space-y-2">
        {stages.map((stage, index) => {
          const draft = drafts[stage.id] ?? {};
          const dirty =
            draft.name !== undefined ||
            draft.color !== undefined ||
            draft.kind !== undefined;
          const count = dealCounts.get(stage.id)?.dealCount ?? 0;
          return (
            <li
              key={stage.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
            >
              <input
                type="color"
                aria-label={t("deals.stageColorLabel")}
                className="h-8 w-10 cursor-pointer rounded border border-line bg-transparent"
                value={draft.color ?? stage.color}
                disabled={!canManage}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [stage.id]: { ...prev[stage.id], color: e.target.value },
                  }))
                }
              />
              <input
                className={`${inputClassName} min-w-40 flex-1`}
                value={draft.name ?? stage.name}
                disabled={!canManage}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [stage.id]: { ...prev[stage.id], name: e.target.value },
                  }))
                }
              />
              <select
                className={inputClassName}
                value={draft.kind ?? stage.kind}
                disabled={!canManage}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [stage.id]: {
                      ...prev[stage.id],
                      kind: e.target.value as DealStageKind,
                    },
                  }))
                }
              >
                {STAGE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(STAGE_KIND_KEYS[kind])}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">
                {t("deals.columnTotal", { count })}
              </span>
              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  aria-label={t("deals.moveUp")}
                  className="rounded-md border border-line px-2 py-1 text-sm text-ink disabled:opacity-40"
                  disabled={!canManage || index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={t("deals.moveDown")}
                  className="rounded-md border border-line px-2 py-1 text-sm text-ink disabled:opacity-40"
                  disabled={!canManage || index === stages.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                {dirty && canManage ? (
                  <button
                    type="button"
                    className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-white"
                    onClick={() => void patchStage(stage)}
                  >
                    {t("common.save")}
                  </button>
                ) : null}
                {canManage ? (
                  <button
                    type="button"
                    className="rounded-md border border-danger/50 px-2.5 py-1 text-sm text-danger hover:bg-danger/10"
                    onClick={() => {
                      setDeleteStage(stage);
                      setMoveTarget(
                        stages.find((s) => s.id !== stage.id)?.id ?? "",
                      );
                    }}
                  >
                    {t("common.delete")}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {canManage ? (
        <form onSubmit={addStage} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label className="block text-xs font-medium text-muted" htmlFor="deal-stage-new-name">
              {t("deals.addStage")}
            </label>
            <input
              id="deal-stage-new-name"
              className={`${inputClassName} mt-1`}
              value={newName}
              placeholder={t("deals.stageNameLabel")}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <input
            type="color"
            aria-label={t("deals.stageColorLabel")}
            className="h-10 w-12 cursor-pointer rounded border border-line bg-transparent"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
          />
          <select
            className={inputClassName}
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as DealStageKind)}
          >
            {STAGE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(STAGE_KIND_KEYS[kind])}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {t("deals.addStage")}
          </button>
        </form>
      ) : null}

      {deleteStage ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl">
            <p className="text-sm font-semibold text-ink">
              {t("deals.deleteStageConfirm", { name: deleteStage.name })}
            </p>
            {(dealCounts.get(deleteStage.id)?.dealCount ?? 0) > 0 ? (
              <>
                <label className="mt-3 block text-xs font-medium text-muted" htmlFor="deal-stage-move-target">
                  {t("deals.deleteStageMoveLabel", {
                    count: dealCounts.get(deleteStage.id)?.dealCount ?? 0,
                  })}
                </label>
                <select
                  id="deal-stage-move-target"
                  className={`${inputClassName} mt-1`}
                  value={moveTarget}
                  onChange={(e) => setMoveTarget(e.target.value)}
                >
                  {stages
                    .filter((s) => s.id !== deleteStage.id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
                onClick={() => setDeleteStage(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                onClick={() => void confirmDeleteStage()}
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


/** Modal buat deal manual. Mata uang awal = bawaan tenant; percakapan opsional dimuat dari kontak terpilih. */
function DealCreateModal({
  t,
  locale,
  tenantId,
  pipeline,
  contacts,
  members,
  defaultCurrency,
  onClose,
  onCreated,
  onError,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  pipeline: DealPipelineResponse;
  contacts: ContactResponse[];
  members: TeamMemberResponse[];
  defaultCurrency: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [contactId, setContactId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [conversations, setConversations] = useState<ContactConversation[]>([]);
  const [title, setTitle] = useState("");
  const [stageId, setStageId] = useState(pipeline.stages[0]?.id ?? "");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [priority, setPriority] = useState<DealPriority>("medium");
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setConversationId("");
    if (!contactId) {
      setConversations([]);
      return;
    }
    let cancelled = false;
    api.contacts
      .conversations(tenantId, contactId)
      .then((res) => {
        if (!cancelled) setConversations(res.conversations);
      })
      .catch(() => {
        if (!cancelled) setConversations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, contactId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsedValue = value.trim() === "" ? 0 : Number(value);
    if (!contactId) {
      setFormError(t("deals.contactRequired"));
      return;
    }
    if (!title.trim()) {
      setFormError(t("deals.titleRequired"));
      return;
    }
    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
      setFormError(t("deals.valueInvalid"));
      return;
    }
    setSaving(true);
    try {
      await api.deals.create(tenantId, {
        pipelineId: pipeline.id,
        stageId: stageId || undefined,
        contactId,
        conversationId: conversationId || null,
        title: title.trim(),
        value: parsedValue,
        currency,
        priority,
        assigneeUserId: assigneeUserId || null,
        expectedCloseDate: expectedCloseDate || null,
        dueAt: fromLocalInput(dueAt),
      });
      await onCreated();
    } catch (err) {
      setFormError(translateApiError(t, err));
      onError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-surface p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold text-ink">{t("deals.newDeal")}</h2>
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-create-contact">
              {t("deals.contactLabel")} *
            </label>
            <select
              id="deal-create-contact"
              className={`${inputClassName} mt-1`}
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">{t("deals.contactPlaceholder")}</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-create-title">
              {t("deals.dealTitleLabel")} *
            </label>
            <input
              id="deal-create-title"
              className={`${inputClassName} mt-1`}
              value={title}
              placeholder={t("deals.dealTitlePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-create-stage">
                {t("deals.stageLabel")}
              </label>
              <select
                id="deal-create-stage"
                className={`${inputClassName} mt-1`}
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
              >
                {pipeline.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-create-priority">
                {t("deals.priorityLabel")}
              </label>
              <select
                id="deal-create-priority"
                className={`${inputClassName} mt-1`}
                value={priority}
                onChange={(e) => setPriority(e.target.value as DealPriority)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(PRIORITY_KEYS[p])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted" htmlFor="deal-create-value">
                {t("deals.valueLabel")}
              </label>
              <input
                id="deal-create-value"
                className={`${inputClassName} mt-1`}
                type="number"
                min={0}
                step="any"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-create-currency">
                {t("deals.currencyLabel")}
              </label>
              <select
                id="deal-create-currency"
                className={`${inputClassName} mt-1`}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {[...new Set([currency, ...CURRENCY_OPTIONS])].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-create-assignee">
              {t("deals.assigneeLabel")}
            </label>
            <select
              id="deal-create-assignee"
              className={`${inputClassName} mt-1`}
              value={assigneeUserId}
              onChange={(e) => setAssigneeUserId(e.target.value)}
            >
              <option value="">{t("deals.assigneeUnassigned")}</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-create-conversation">
              {t("deals.conversationLabel")}
            </label>
            <select
              id="deal-create-conversation"
              className={`${inputClassName} mt-1`}
              value={conversationId}
              disabled={!contactId}
              onChange={(e) => setConversationId(e.target.value)}
            >
              <option value="">{t("deals.conversationNone")}</option>
              {conversations.map((cv) => (
                <option key={cv.id} value={cv.id}>
                  {cv.title ?? `${cv.provider} · ${formatDate(cv.createdAt, locale)}`}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-create-close">
                {t("deals.expectedCloseLabel")}
              </label>
              <input
                id="deal-create-close"
                className={`${inputClassName} mt-1`}
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-create-due">
                {t("deals.dueAtLabel")}
              </label>
              <input
                id="deal-create-due"
                className={`${inputClassName} mt-1`}
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>
        </div>
        <FieldError message={formError} />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {t("deals.createDeal")}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Drawer detail deal: ubah semua field, pemilih tahap (jalur aksesibel selain seret), riwayat tahap, hapus. */
function DealDetailDrawer({
  t,
  locale,
  tenantId,
  detail,
  pipeline,
  contacts,
  members,
  canOperate,
  canManage,
  onClose,
  onChanged,
  onDeleted,
  onMove,
  onError,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  detail: DealDetailResponse;
  pipeline: DealPipelineResponse | null;
  contacts: ContactResponse[];
  members: TeamMemberResponse[];
  canOperate: boolean;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onMove: (stageId: string) => void;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState(detail.title);
  const [value, setValue] = useState(String(detail.value));
  const [currency, setCurrency] = useState(detail.currency);
  const [priority, setPriority] = useState<DealPriority>(detail.priority);
  const [contactId, setContactId] = useState(detail.contactId);
  const [conversationId, setConversationId] = useState(
    detail.conversationId ?? "",
  );
  const [conversations, setConversations] = useState<ContactConversation[]>([]);
  const [assigneeUserId, setAssigneeUserId] = useState(
    detail.assigneeUserId ?? "",
  );
  const [expectedCloseDate, setExpectedCloseDate] = useState(
    detail.expectedCloseDate ?? "",
  );
  const [dueAt, setDueAt] = useState(toLocalInput(detail.dueAt));
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Sinkronkan formulir bila deal yang dibuka berganti.
  useEffect(() => {
    setTitle(detail.title);
    setValue(String(detail.value));
    setCurrency(detail.currency);
    setPriority(detail.priority);
    setContactId(detail.contactId);
    setConversationId(detail.conversationId ?? "");
    setAssigneeUserId(detail.assigneeUserId ?? "");
    setExpectedCloseDate(detail.expectedCloseDate ?? "");
    setDueAt(toLocalInput(detail.dueAt));
    setFormError(null);
    setConfirmDelete(false);
  }, [detail]);

  useEffect(() => {
    let cancelled = false;
    api.contacts
      .conversations(tenantId, contactId)
      .then((res) => {
        if (!cancelled) setConversations(res.conversations);
      })
      .catch(() => {
        if (!cancelled) setConversations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, contactId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsedValue = value.trim() === "" ? Number.NaN : Number(value);
    if (!title.trim()) {
      setFormError(t("deals.titleRequired"));
      return;
    }
    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
      setFormError(t("deals.valueInvalid"));
      return;
    }
    try {
      await api.deals.update(tenantId, detail.id, {
        title: title.trim(),
        value: parsedValue,
        currency,
        priority,
        contactId,
        conversationId: conversationId || null,
        assigneeUserId: assigneeUserId || null,
        expectedCloseDate: expectedCloseDate || null,
        dueAt: fromLocalInput(dueAt),
      });
      await onChanged();
    } catch (err) {
      const msg = translateApiError(t, err);
      setFormError(msg);
      onError(msg);
    }
  };

  const remove = async () => {
    try {
      await api.deals.remove(tenantId, detail.id);
      await onDeleted();
    } catch (err) {
      onError(translateApiError(t, err));
    }
  };

  const stageOptions = pipeline?.stages ?? [];

  return (
    <div className="fixed inset-0 z-50 flex">
      <button
        type="button"
        aria-label={t("common.close")}
        className="flex-1 bg-black/50"
        onClick={onClose}
      />
      <div className="flex w-full max-w-[440px] flex-col overflow-y-auto bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">
            {t("deals.detailTitle")}
          </h2>
          <button
            type="button"
            className="rounded-lg border border-line px-2.5 py-1 text-sm text-ink"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </div>
        <form onSubmit={save} className="space-y-3 px-5 py-4">
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-stage">
              {t("deals.stageLabel")}
            </label>
            <select
              id="deal-detail-stage"
              className={`${inputClassName} mt-1`}
              value={detail.stageId}
              disabled={!canOperate}
              onChange={(e) => onMove(e.target.value)}
            >
              {stageOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">
              {t(STATUS_KEYS[detail.status])}
              {detail.closedAt
                ? ` · ${t("deals.closedAtLabel")}: ${formatDateTime(detail.closedAt, locale)}`
                : ""}
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-title">
              {t("deals.dealTitleLabel")}
            </label>
            <input
              id="deal-detail-title"
              className={`${inputClassName} mt-1`}
              value={title}
              disabled={!canOperate}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-value">
                {t("deals.valueLabel")}
              </label>
              <input
                id="deal-detail-value"
                className={`${inputClassName} mt-1`}
                type="number"
                min={0}
                step="any"
                value={value}
                disabled={!canOperate}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-currency">
                {t("deals.currencyLabel")}
              </label>
              <select
                id="deal-detail-currency"
                className={`${inputClassName} mt-1`}
                value={currency}
                disabled={!canOperate}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {[...new Set([currency, ...CURRENCY_OPTIONS])].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-contact">
              {t("deals.contactLabel")}
            </label>
            <select
              id="deal-detail-contact"
              className={`${inputClassName} mt-1`}
              value={contactId}
              disabled={!canOperate}
              onChange={(e) => {
                setContactId(e.target.value);
                setConversationId("");
              }}
            >
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              {!contacts.some((c) => c.id === contactId) ? (
                <option value={contactId}>{detail.contactName}</option>
              ) : null}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-conversation">
              {t("deals.conversationLabel")}
            </label>
            <select
              id="deal-detail-conversation"
              className={`${inputClassName} mt-1`}
              value={conversationId}
              disabled={!canOperate}
              onChange={(e) => setConversationId(e.target.value)}
            >
              <option value="">{t("deals.conversationNone")}</option>
              {conversations.map((cv) => (
                <option key={cv.id} value={cv.id}>
                  {cv.title ?? `${cv.provider} · ${formatDate(cv.createdAt, locale)}`}
                </option>
              ))}
              {conversationId &&
              !conversations.some((cv) => cv.id === conversationId) ? (
                <option value={conversationId}>{conversationId}</option>
              ) : null}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-priority">
                {t("deals.priorityLabel")}
              </label>
              <select
                id="deal-detail-priority"
                className={`${inputClassName} mt-1`}
                value={priority}
                disabled={!canOperate}
                onChange={(e) => setPriority(e.target.value as DealPriority)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(PRIORITY_KEYS[p])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-assignee">
                {t("deals.assigneeLabel")}
              </label>
              <select
                id="deal-detail-assignee"
                className={`${inputClassName} mt-1`}
                value={assigneeUserId}
                disabled={!canOperate}
                onChange={(e) => setAssigneeUserId(e.target.value)}
              >
                <option value="">{t("deals.assigneeUnassigned")}</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name ?? m.email}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-close">
                {t("deals.expectedCloseLabel")}
              </label>
              <input
                id="deal-detail-close"
                className={`${inputClassName} mt-1`}
                type="date"
                value={expectedCloseDate}
                disabled={!canOperate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted" htmlFor="deal-detail-due">
                {t("deals.dueAtLabel")}
              </label>
              <input
                id="deal-detail-due"
                className={`${inputClassName} mt-1`}
                type="datetime-local"
                value={dueAt}
                disabled={!canOperate}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>
          <FieldError message={formError} />
          {canOperate ? (
            <div className="flex items-center gap-2 pt-1">
              <button
                type="submit"
                className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                {t("common.save")}
              </button>
              {canManage ? (
                confirmDelete ? (
                  <>
                    <span className="text-xs text-danger">
                      {t("deals.deleteDealConfirm", { title: detail.title })}
                    </span>
                    <button
                      type="button"
                      className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white"
                      onClick={() => void remove()}
                    >
                      {t("common.delete")}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
                      onClick={() => setConfirmDelete(false)}
                    >
                      {t("common.cancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="rounded-lg border border-danger/50 px-3 py-2 text-sm text-danger hover:bg-danger/10"
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t("deals.deleteDeal")}
                  </button>
                )
              ) : null}
            </div>
          ) : null}
        </form>

        <div className="border-t border-line px-5 py-4">
          <h3 className="text-sm font-semibold text-ink">
            {t("deals.historyTitle")}
          </h3>
          {detail.stageHistory.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t("deals.historyEmpty")}</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {detail.stageHistory.map((event) => (
                <li key={event.id} className="text-sm text-ink">
                  {event.fromStageName === null
                    ? t("deals.historyCreated", {
                        stage: event.toStageName ?? "—",
                      })
                    : t("deals.historyMoved", {
                        from: event.fromStageName ?? "—",
                        to: event.toStageName ?? "—",
                      })}
                  <span className="block text-xs text-muted">
                    {formatDateTime(event.createdAt, locale)}
                    {" · "}
                    {event.actorType === "user"
                      ? (() => {
                          const member = members.find(
                            (m) => m.userId === event.actorId,
                          );
                          return member
                            ? t("deals.historyActorUser", {
                                name: member.name ?? member.email,
                              })
                            : "";
                        })()
                      : event.actorType === "flow"
                        ? t("deals.historyActorFlow")
                        : t("deals.historyActorSystem")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
