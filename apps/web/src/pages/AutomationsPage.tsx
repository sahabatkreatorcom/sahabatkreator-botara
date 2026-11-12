import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  extractInstructionPlaceholders,
  type AutomationKind,
  type AutomationMatch,
  type AutomationResponse,
  type AutomationRunResponse,
  type AutomationTemplateCategory,
  type AutomationTemplateSummary,
  type ChannelAccountResponse,
  type CommentResponse,
  type ContactResponse,
  type EnrollConversationResponse,
  type EnrollSequenceByTagResponse,
  type SequenceEnrollmentResponse,
  type SequenceTemplateResponse,
} from "@sahabat-kreator/contracts";
import {
  formatNumber,
  type Locale,
  type TranslationKey,
} from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import {
  TemplateGalleryGrid,
  TemplateGalleryPanel,
  type TemplateGalleryCard,
} from "../components/TemplateGallery";
import { SequenceTimelinePreview } from "./automations/SequenceTimelinePreview";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

function parseKeywords(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}

const TPL_CATEGORY_KEYS: Record<AutomationTemplateCategory, TranslationKey> = {
  faq: "automations.tplCatFaq",
  sales: "automations.tplCatSales",
  support: "automations.tplCatSupport",
  followup: "automations.tplCatFollowup",
};

interface AutomationsPageProps {
  t: Translate;
  locale: Locale;
  /** Arahkan ke manajemen template WA (halaman Siaran) — dari penanda risiko jendela di pratinjau linimasa. */
  onOpenWaTemplates?: () => void;
}

/**
 * Halaman Automations (Fase 2B; sequence Fase 2C): pengelolaan automation
 * workspace aktif — daftar + sakelar aktif, form buat/edit untuk dua jenis
 * (balasan keyword & rangkaian pesan/sequence), riwayat eksekusi (runs)
 * untuk keyword, dan daftar pendaftaran (enrollments) untuk sequence.
 * Semua teks lewat i18n; tanggal lewat Intl.
 */
export function AutomationsPage({ t, locale, onOpenWaTemplates }: AutomationsPageProps) {
  const { status, tenants, active, reload } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [items, setItems] = useState<AutomationResponse[]>([]);
  const [channels, setChannels] = useState<ChannelAccountResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fase 10B: saringan panel komentar — id aturan komentar yang dipilih
  // dari kartunya (null = semua komentar akun yang terhubung).
  const [commentRuleFilter, setCommentRuleFilter] = useState<string | null>(
    null,
  );
  const [formTarget, setFormTarget] = useState<
    "create" | AutomationResponse | null
  >(null);
  const [runsTarget, setRunsTarget] = useState<AutomationResponse | null>(
    null,
  );
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Fase 16B — galeri template. `templates === null` = belum dimuat;
  // pemuatan malas (baru saat panel dibuka) supaya halaman daftar tidak
  // menunggu katalog yang mungkin tidak dipakai.
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [templates, setTemplates] = useState<
    AutomationTemplateSummary[] | null
  >(null);
  const [usingSlug, setUsingSlug] = useState<string | null>(null);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  // G2 — templat sequence pribadi tenant (galeri yang sama, sumber
  // berbeda). `null` = belum dimuat; kegagalan muatnya TIDAK
  // menggagalkan katalog (baris kesalahan sendiri di bawah grid,
  // pola galeri agent).
  const [myTemplates, setMyTemplates] = useState<
    SequenceTemplateResponse[] | null
  >(null);
  const [myTemplatesError, setMyTemplatesError] = useState(false);
  // Kunci kartu yang pratinjau linimasanya sedang terbuka
  // (`tpl:<slug>` katalog / `mine:<id>` pribadi); null = semua tutup.
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [usingSeqId, setUsingSeqId] = useState<string | null>(null);
  const [deletingSeqId, setDeletingSeqId] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api.automations.list(tenantId);
      if (requestSeq.current !== seq) return;
      setItems(list);
      // Pelengkap tampilan (nama akun untuk kartu aturan komentar +
      // panel komentar): kegagalan daftar channel tidak menggagalkan
      // halaman automation.
      try {
        const channelList = await api.channels.list(tenantId);
        if (requestSeq.current === seq) setChannels(channelList);
      } catch {
        // biarkan peta akun kosong
      }
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setItems([]);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMyTemplates = useCallback(async () => {
    if (!tenantId) return;
    try {
      const rows = await api.sequenceTemplates.list(tenantId);
      setMyTemplates(rows);
      setMyTemplatesError(false);
    } catch {
      // Galeri katalog tetap tampil; templat pribadi menyusul.
      setMyTemplates([]);
      setMyTemplatesError(true);
    }
  }, [tenantId]);

  const loadTemplates = useCallback(async () => {
    if (!tenantId) return;
    try {
      // G2: katalog diminta pada locale UI pemilik — teks langkah
      // pratinjau + instantiate mengikuti bahasa itu.
      const res = await api.automations.listTemplates(tenantId, locale);
      setTemplates(res.templates);
    } catch (err) {
      setError(translateApiError(t, err));
      setTemplates([]);
    }
    void loadMyTemplates();
  }, [tenantId, t, locale, loadMyTemplates]);

  useEffect(() => {
    if (galleryOpen && templates === null) void loadTemplates();
  }, [galleryOpen, templates, loadTemplates]);

  /**
   * "Pakai template" membuat automation NYATA tetapi NONAKTIF (keputusan
   * server, lihat kontrak automation-templates). Karena itu tidak ada
   * konfirmasi tambahan di sini — yang lahir belum bisa mengirim apa pun.
   * Sesudahnya daftar dimuat ulang dan pemilik diarahkan menyunting
   * placeholder + mengaktifkan sendiri.
   */
  const applyTemplate = async (tpl: AutomationTemplateSummary) => {
    if (!tenantId || usingSlug) return;
    setUsingSlug(tpl.slug);
    setError(null);
    setTemplateNotice(null);
    try {
      const created = await api.automations.instantiateTemplate(
        tenantId,
        tpl.slug,
        { locale },
      );
      setTemplateNotice(
        t("automations.tplCreatedNotice", { name: created.name }),
      );
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setUsingSlug(null);
    }
  };

  /** Pakai templat pribadi — jalur yang sama: automation BARU nonaktif. */
  const applyMyTemplate = async (tpl: SequenceTemplateResponse) => {
    if (!tenantId || usingSeqId) return;
    setUsingSeqId(tpl.id);
    setError(null);
    setTemplateNotice(null);
    try {
      const created = await api.sequenceTemplates.instantiate(
        tenantId,
        tpl.id,
      );
      setTemplateNotice(
        t("automations.tplCreatedNotice", { name: created.name }),
      );
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setUsingSeqId(null);
    }
  };

  const deleteMyTemplate = async (tpl: SequenceTemplateResponse) => {
    if (!tenantId || deletingSeqId) return;
    setDeletingSeqId(tpl.id);
    setError(null);
    try {
      await api.sequenceTemplates.remove(tenantId, tpl.id);
      await loadMyTemplates();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setDeletingSeqId(null);
    }
  };

  const handleToggle = async (automation: AutomationResponse) => {
    if (!tenantId || togglingId) return;
    const next = !automation.isActive;
    // Optimistis: ubah tampilan dulu, kembalikan bila server menolak.
    setItems((prev) =>
      prev.map((a) => (a.id === automation.id ? { ...a, isActive: next } : a)),
    );
    setTogglingId(automation.id);
    try {
      const updated = await api.automations.update(tenantId, automation.id, {
        isActive: next,
      });
      setItems((prev) =>
        prev.map((a) => (a.id === updated.id ? updated : a)),
      );
    } catch (err) {
      setItems((prev) =>
        prev.map((a) =>
          a.id === automation.id ? { ...a, isActive: automation.isActive } : a,
        ),
      );
      setError(translateApiError(t, err));
      void load();
    } finally {
      setTogglingId(null);
    }
  };

  /**
   * Kartu galeri G2: katalog bawaan + templat sequence pribadi tenant
   * dalam SATU daftar `cards` komponen TemplateGallery bersama (pola
   * galeri agent) — dibedakan lencana sumbernya. Kartu sequence (dari
   * sumber mana pun) membawa pratinjau linimasa yang bisa dibuka di
   * `afterMeta`; kartu keyword tidak (tidak ada linimasa untuk
   * balasan langsung).
   */
  const sequencePreviewBlock = (
    key: string,
    steps: { delayMinutes: number; text: string }[],
  ) => (
    <div>
      <button
        type="button"
        onClick={() => setPreviewKey(previewKey === key ? null : key)}
        className="mt-3 text-xs font-semibold text-accent hover:underline"
      >
        {previewKey === key
          ? t("automations.tplPreviewCloseButton")
          : t("automations.tplPreviewButton")}
      </button>
      {previewKey === key ? (
        <SequenceTimelinePreview
          t={t}
          steps={steps}
          onOpenWaTemplates={onOpenWaTemplates}
        />
      ) : null}
    </div>
  );

  const galleryCards: TemplateGalleryCard[] = [
    ...(templates ?? []).map((tpl) => ({
      key: tpl.slug,
      name: t(tpl.nameKey as TranslationKey),
      badges: (
        <span className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
          {t(TPL_CATEGORY_KEYS[tpl.category])}
        </span>
      ),
      description: t(tpl.descriptionKey as TranslationKey),
      meta:
        tpl.kind === "sequence"
          ? t("automations.tplSequenceMeta", {
              count: tpl.stepCount,
            })
          : t("automations.tplKeywordMeta", {
              count: tpl.keywordCount,
            }),
      afterMeta:
        tpl.kind === "sequence"
          ? sequencePreviewBlock(`tpl:${tpl.slug}`, tpl.steps)
          : undefined,
      actions: (
        <button
          type="button"
          disabled={usingSlug !== null}
          onClick={() => void applyTemplate(tpl)}
          className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {usingSlug === tpl.slug
            ? t("automations.tplUsing")
            : t("automations.tplUseButton")}
        </button>
      ),
    })),
    ...(myTemplates ?? []).map((tpl) => ({
      key: `mine:${tpl.id}`,
      name: tpl.name,
      badges: (
        <span className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
          {t("automations.tplMineBadge")}
        </span>
      ),
      description: tpl.steps[0]?.text ?? "",
      descriptionClassName: "line-clamp-3 whitespace-pre-wrap",
      meta: t("automations.tplSequenceMeta", { count: tpl.steps.length }),
      afterMeta: sequencePreviewBlock(`mine:${tpl.id}`, tpl.steps),
      actions: (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={usingSeqId !== null}
            onClick={() => void applyMyTemplate(tpl)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {usingSeqId === tpl.id
              ? t("automations.tplUsing")
              : t("automations.tplUseButton")}
          </button>
          <button
            type="button"
            disabled={deletingSeqId === tpl.id}
            onClick={() => void deleteMyTemplate(tpl)}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-60"
          >
            {t("automations.tplDeleteButton")}
          </button>
        </div>
      ),
    })),
  ];

  if (status === "loading") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("automations.title")}</h1>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("automations.title")}</h1>
        <div className="mt-6 rounded-xl border border-line bg-surface p-6">
          <p className="text-sm text-danger">{t("workspace.loadError")}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-3 rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.retry")}
          </button>
        </div>
      </section>
    );
  }
  if (tenants.length === 0 || !active) {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("automations.title")}</h1>
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-6">
          <h2 className="text-lg font-semibold text-ink">{t("workspace.emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted">{t("workspace.emptyBody")}</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t("automations.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("automations.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setGalleryOpen((v) => !v)}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-elevated"
          >
            {t("automations.tplGalleryButton")}
          </button>
          <button
            type="button"
            onClick={() => setFormTarget("create")}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {t("automations.addButton")}
          </button>
        </div>
      </div>

      {galleryOpen ? (
        <TemplateGalleryPanel
          title={t("automations.tplGalleryTitle")}
          subtitle={t("automations.tplGallerySubtitle")}
          loading={templates === null}
          loadingLabel={t("workspace.loading")}
          empty={
            (templates ?? []).length === 0 && (myTemplates ?? []).length === 0
          }
          emptyLabel={t("automations.tplGalleryEmpty")}
        >
          <TemplateGalleryGrid
            variant="panel"
            cards={galleryCards}
          />
          {myTemplatesError ? (
            <p className="mt-3 text-xs text-danger">
              {t("automations.tplMineLoadError")}
            </p>
          ) : null}
        </TemplateGalleryPanel>
      ) : null}

      {templateNotice ? (
        <p className="mt-4 rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
          {templateNotice}
        </p>
      ) : null}

      <FieldError message={error} />

      {loading ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <h2 className="text-base font-semibold text-ink">
            {t("automations.emptyTitle")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            {t("automations.emptyBody")}
          </p>
          <button
            type="button"
            onClick={() => setFormTarget("create")}
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {t("automations.addButton")}
          </button>
        </div>
      ) : (
        <ul className="mt-5 space-y-3">
          {items.map((automation) => (
            <li
              key={automation.id}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-start gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (automation.kind === "comment") {
                      setCommentRuleFilter(automation.id);
                      document
                        .getElementById("comments-panel")
                        ?.scrollIntoView({ behavior: "smooth" });
                    } else {
                      setRunsTarget(automation);
                    }
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-semibold text-ink">
                    {automation.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {t(
                      automation.match === "exact"
                        ? "automations.matchExact"
                        : "automations.matchContains",
                    )}
                    {" · "}
                    {automation.kind === "comment"
                      ? t("automations.commentOnAccount", {
                          account:
                            channels.find(
                              (ch) => ch.id === automation.channelAccountId,
                            )?.displayName ?? "—",
                        })
                      : t("automations.runsLabel", {
                          count: formatNumber(automation.runCount, locale),
                        })}
                    {" · "}
                    {t("automations.createdLabel", {
                      date: formatDateTime(automation.createdAt, locale),
                    })}
                  </span>
                </button>
                <span className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-xs font-semibold text-ink">
                  {t(
                    automation.kind === "sequence"
                      ? "automations.kindChipSequence"
                      : automation.kind === "comment"
                        ? "automations.kindChipComment"
                        : "automations.kindChipKeyword",
                  )}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    automation.isActive
                      ? "bg-accent/10 text-accent"
                      : "bg-elevated text-muted"
                  }`}
                >
                  {automation.isActive
                    ? t("automations.statusActive")
                    : t("automations.statusInactive")}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={automation.isActive}
                  aria-label={automation.name}
                  disabled={togglingId === automation.id}
                  onClick={() => void handleToggle(automation)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                    automation.isActive ? "bg-accent" : "bg-elevated"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      automation.isActive ? "left-[22px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
              {automation.keywords.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {automation.keywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              ) : null}
              {automation.kind === "sequence" ? (
                <p className="mt-2 text-sm text-muted">
                  {t("automations.stepsCountLabel", {
                    count: formatNumber(automation.stepCount, locale),
                  })}
                  {automation.steps.length > 0
                    ? ` · ${automation.steps
                        .map((s) => `+${s.delayMinutes}m`)
                        .join(" → ")}`
                    : ""}
                </p>
              ) : automation.kind === "comment" ? (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {automation.sendDm ? (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                      {t("automations.commentSummaryDm")}
                    </span>
                  ) : null}
                  {automation.publicReplyText ? (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                      {t("automations.commentSummaryPublicReply")}
                    </span>
                  ) : null}
                  {automation.hideComment ? (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                      {t("automations.commentSummaryHide")}
                    </span>
                  ) : null}
                  {automation.sendDm ? (
                    <span className="line-clamp-1 text-xs text-muted">
                      {automation.text}
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 line-clamp-2 text-sm text-muted">
                  {automation.text}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                {automation.kind === "comment" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setCommentRuleFilter(automation.id);
                      document
                        .getElementById("comments-panel")
                        ?.scrollIntoView({ behavior: "smooth" });
                    }}
                    className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                  >
                    {t("automations.commentsButton")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRunsTarget(automation)}
                    className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                  >
                    {t(
                      automation.kind === "sequence"
                        ? "automations.enrollmentsButton"
                        : "automations.historyButton",
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFormTarget(automation)}
                  className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                >
                  {t("common.edit")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {formTarget ? (
        <AutomationFormModal
          t={t}
          tenantId={active.id}
          automation={formTarget === "create" ? null : formTarget}
          onTemplateSaved={() => void loadMyTemplates()}
          onClose={() => setFormTarget(null)}
          onSaved={(saved) => {
            setFormTarget(null);
            setItems((prev) => {
              const exists = prev.some((a) => a.id === saved.id);
              return exists
                ? prev.map((a) => (a.id === saved.id ? saved : a))
                : [saved, ...prev];
            });
          }}
        />
      ) : null}

      {runsTarget ? (
        runsTarget.kind === "sequence" ? (
          <EnrollmentsModal
            t={t}
            locale={locale}
            tenantId={active.id}
            automation={runsTarget}
            onClose={() => setRunsTarget(null)}
          />
        ) : (
          <RunsModal
            t={t}
            locale={locale}
            tenantId={active.id}
            automation={runsTarget}
            onClose={() => setRunsTarget(null)}
          />
        )
      ) : null}

      <CommentsPanel
        t={t}
        locale={locale}
        tenantId={active.id}
        channels={channels}
        automations={items}
        ruleFilter={commentRuleFilter}
        onClearRuleFilter={() => setCommentRuleFilter(null)}
      />
    </section>
  );
}

/**
 * Panel komentar terbaru (Fase 10B): daftar komentar IG/Messenger yang
 * tercatat dari webhook, dengan akun + penulis + aturan yang cocok +
 * jejak aksi (DM/balasan publik/sembunyikan) dan moderasi manual
 * sembunyikan/tampilkan. Saringan: per akun (select) dan per aturan
 * (diatur dari tombol "Komentar" pada kartu aturan).
 */
function CommentsPanel({
  t,
  locale,
  tenantId,
  channels,
  automations,
  ruleFilter,
  onClearRuleFilter,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  channels: ChannelAccountResponse[];
  automations: AutomationResponse[];
  ruleFilter: string | null;
  onClearRuleFilter: () => void;
}) {
  const [comments, setComments] = useState<CommentResponse[]>([]);
  const [accountFilter, setAccountFilter] = useState<string>("");
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [moderatingId, setModeratingId] = useState<string | null>(null);
  const seq = useRef(0);

  const metaChannels = channels.filter(
    (ch) => ch.provider === "instagram" || ch.provider === "messenger",
  );

  const loadComments = useCallback(async () => {
    const mySeq = ++seq.current;
    setLoadingComments(true);
    setCommentsError(null);
    try {
      const list = await api.comments.list(tenantId, {
        ...(accountFilter ? { channelAccountId: accountFilter } : {}),
        ...(ruleFilter ? { automationId: ruleFilter } : {}),
        limit: 50,
      });
      if (seq.current !== mySeq) return;
      setComments(list);
    } catch (err) {
      if (seq.current !== mySeq) return;
      setCommentsError(translateApiError(t, err));
      setComments([]);
    } finally {
      if (seq.current === mySeq) setLoadingComments(false);
    }
  }, [tenantId, accountFilter, ruleFilter, t]);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  const handleModerate = async (comment: CommentResponse) => {
    if (moderatingId) return;
    setModeratingId(comment.id);
    setCommentsError(null);
    try {
      const updated =
        comment.moderationStatus === "hidden"
          ? await api.comments.unhide(tenantId, comment.id)
          : await api.comments.hide(tenantId, comment.id);
      setComments((prev) =>
        prev.map((cm) => (cm.id === updated.id ? updated : cm)),
      );
    } catch (err) {
      setCommentsError(translateApiError(t, err));
    } finally {
      setModeratingId(null);
    }
  };

  const ruleName = (id: string | null): string | null =>
    id ? (automations.find((a) => a.id === id)?.name ?? null) : null;

  return (
    <div id="comments-panel" className="mt-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">{t("comments.title")}</h2>
          <p className="mt-0.5 text-sm text-muted">{t("comments.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            aria-label={t("comments.filterAllAccounts")}
          >
            <option value="">{t("comments.filterAllAccounts")}</option>
            {metaChannels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void loadComments()}
            className="rounded-lg bg-elevated px-3 py-2 text-sm font-medium text-ink"
          >
            {t("comments.refreshButton")}
          </button>
        </div>
      </div>

      {ruleFilter ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink">
          <span>
            {t("comments.ruleLabel")}:{" "}
            <strong>{ruleName(ruleFilter) ?? shortId(ruleFilter)}</strong>
          </span>
          <button
            type="button"
            onClick={onClearRuleFilter}
            className="ml-auto rounded-md bg-elevated px-2 py-1 text-xs font-medium text-ink"
          >
            {t("comments.clearFilterButton")}
          </button>
        </div>
      ) : null}

      <FieldError message={commentsError} />

      {loadingComments ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : comments.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-line bg-surface p-6 text-center">
          <p className="text-sm text-muted">
            {accountFilter || ruleFilter
              ? t("comments.filteredEmpty")
              : t("comments.empty")}
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {comment.authorUsername ??
                      shortId(comment.authorExternalId)}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {comment.channelDisplayName}
                    {" · "}
                    {comment.provider === "instagram"
                      ? "Instagram"
                      : "Messenger"}
                    {" · "}
                    {formatDateTime(
                      comment.providerCreatedAt ?? comment.createdAt,
                      locale,
                    )}
                  </span>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    comment.moderationStatus === "hidden"
                      ? "bg-danger/10 text-danger"
                      : "bg-elevated text-muted"
                  }`}
                >
                  {comment.moderationStatus === "hidden"
                    ? t("comments.statusHidden")
                    : t("comments.statusVisible")}
                </span>
                <button
                  type="button"
                  disabled={moderatingId === comment.id}
                  onClick={() => void handleModerate(comment)}
                  className="shrink-0 rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-60"
                >
                  {comment.moderationStatus === "hidden"
                    ? t("comments.unhideButton")
                    : t("comments.hideButton")}
                </button>
              </div>
              <p className="mt-2 text-sm text-ink">{comment.text}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-muted">
                  {t("comments.ruleLabel")}:{" "}
                  {ruleName(comment.matchedAutomationId) ??
                    t("comments.ruleNone")}
                </span>
                {comment.actions.skipped === "own_comment" ? (
                  <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted">
                    {t("comments.actionSkippedOwn")}
                  </span>
                ) : null}
                {comment.actions.dm ? (
                  <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink">
                    {comment.actions.dm.status === "queued"
                      ? t("comments.actionDmQueued")
                      : comment.actions.dm.status === "skipped"
                        ? t("comments.actionDmSkipped")
                        : t("comments.actionDmFailed")}
                  </span>
                ) : null}
                {comment.actions.publicReply ? (
                  <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink">
                    {comment.actions.publicReply.status === "sent"
                      ? t("comments.actionPublicReplySent")
                      : t("comments.actionPublicReplyFailed")}
                  </span>
                ) : null}
                {comment.actions.hide ? (
                  <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink">
                    {comment.actions.hide.status === "hidden"
                      ? t("comments.actionHideDone")
                      : t("comments.actionHideFailed")}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AutomationFormModal({
  t,
  tenantId,
  automation,
  onClose,
  onSaved,
  onTemplateSaved,
}: {
  t: Translate;
  tenantId: string;
  automation: AutomationResponse | null;
  onClose: () => void;
  onSaved: (automation: AutomationResponse) => void;
  /** Dipanggil sesudah "simpan sebagai templat" berhasil (G2) agar galeri memuat ulang templat pribadi. */
  onTemplateSaved?: () => void;
}) {
  const [name, setName] = useState(automation?.name ?? "");
  const [keywords, setKeywords] = useState(
    automation ? automation.keywords.join(", ") : "",
  );
  const [match, setMatch] = useState<AutomationMatch>(
    automation?.match ?? "exact",
  );
  // Jenis hanya bisa dipilih saat MEMBUAT; saat edit mengikuti yang tersimpan.
  const [kind, setKind] = useState<AutomationKind>(
    automation?.kind ?? "keyword",
  );
  const [text, setText] = useState(automation?.text ?? "");
  const [stepRows, setStepRows] = useState<
    { delay: string; text: string }[]
  >([{ delay: "0", text: "" }]);
  // Fase 10B — field aturan komentar: akun terikat + kombinasi aksi.
  // Teks DM memakai state `text` yang sama (actionConfig.text di API).
  const [commentChannels, setCommentChannels] = useState<
    ChannelAccountResponse[]
  >([]);
  const [channelAccountId, setChannelAccountId] = useState(
    automation?.channelAccountId ?? "",
  );
  const [sendDm, setSendDm] = useState(automation?.sendDm ?? true);
  const [publicReplyEnabled, setPublicReplyEnabled] = useState(
    Boolean(automation?.publicReplyText),
  );
  const [publicReplyText, setPublicReplyText] = useState(
    automation?.publicReplyText ?? "",
  );
  const [hideComment, setHideComment] = useState(
    automation?.hideComment ?? false,
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // --- G2: simpan sebagai templat sequence pribadi --------------------
  // Keadaan langkah formulir saat ini, dinormalkan seperti yang akan
  // dikirim saat membuat automation: mode buat dari baris editor;
  // mode edit dari langkah tersimpan (langkah sequence memang tidak
  // bisa diubah lewat formulir ini).
  const isSequenceForm =
    automation?.kind === "sequence" || (!automation && kind === "sequence");
  const currentSteps: { delayMinutes: number; text: string }[] =
    automation?.kind === "sequence"
      ? automation.steps.map((s) => ({
          delayMinutes: s.delayMinutes,
          text: s.text,
        }))
      : kind === "sequence"
        ? stepRows.map((row) => ({
            delayMinutes: Number(row.delay),
            text: row.text.trim(),
          }))
        : [];
  // Penanda [...] yang belum diganti di teks langkah — peringatan
  // murni tampilan (non-blokir), pola formulir agent.
  const seqPlaceholders = isSequenceForm
    ? extractInstructionPlaceholders(
        currentSteps.map((s) => s.text).join("\n"),
      )
    : [];
  const [saveFoldOpen, setSaveFoldOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSavedName, setTemplateSavedName] = useState<string | null>(
    null,
  );

  const handleSaveAsTemplate = async () => {
    const trimmed = templateName.trim();
    if (!trimmed) return setError(t("automations.tplSaveNameRequired"));
    const parsedKeywords = parseKeywords(keywords);
    if (parsedKeywords.length === 0)
      return setError(t("automations.keywordsRequired"));
    if (parsedKeywords.length > 10)
      return setError(t("automations.keywordsTooMany"));
    // Validasi langkah yang sama dengan pembuatan sequence.
    if (currentSteps.length === 0)
      return setError(t("automations.stepsRequired"));
    if (currentSteps.length > 10)
      return setError(t("automations.stepsTooMany"));
    if (
      currentSteps.some(
        (s) =>
          !Number.isInteger(s.delayMinutes) ||
          s.delayMinutes < 0 ||
          s.delayMinutes > 43200,
      )
    )
      return setError(t("automations.stepDelayInvalid"));
    if (currentSteps.some((s) => !s.text))
      return setError(t("automations.stepTextRequired"));
    setSavingTemplate(true);
    setError(null);
    try {
      await api.sequenceTemplates.create(tenantId, {
        name: trimmed,
        keywords: parsedKeywords,
        match,
        steps: currentSteps,
      });
      setSaveFoldOpen(false);
      setTemplateSavedName(trimmed);
      onTemplateSaved?.();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSavingTemplate(false);
    }
  };

  const isCommentForm = automation?.kind === "comment" || kind === "comment";
  useEffect(() => {
    if (!isCommentForm) return;
    let cancelled = false;
    void api.channels
      .list(tenantId)
      .then((list) => {
        if (cancelled) return;
        const eligible = list.filter(
          (ch) =>
            (ch.provider === "instagram" || ch.provider === "messenger") &&
            ch.status === "connected",
        );
        setCommentChannels(eligible);
        if (!automation && !channelAccountId && eligible.length > 0) {
          setChannelAccountId(eligible[0].id);
        }
      })
      .catch(() => {
        if (!cancelled) setCommentChannels([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCommentForm, tenantId]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return setError(t("automations.nameRequired"));
    const parsedKeywords = parseKeywords(keywords);
    if (parsedKeywords.length === 0)
      return setError(t("automations.keywordsRequired"));
    if (parsedKeywords.length > 10)
      return setError(t("automations.keywordsTooMany"));
    setError(null);
    setSubmitting(true);
    try {
      if (automation) {
        if (automation.kind === "comment") {
          // Edit aturan komentar: akun terikat tidak berubah; yang
          // diubah nama/keyword/match + kombinasi aksinya.
          const replyText = publicReplyEnabled ? publicReplyText.trim() : "";
          if (!sendDm && !replyText && !hideComment)
            return setError(t("automations.commentActionsRequired"));
          if (sendDm && !text.trim())
            return setError(t("automations.commentDmTextRequired"));
          const saved = await api.automations.update(tenantId, automation.id, {
            name: trimmedName,
            keywords: parsedKeywords,
            match,
            sendDm,
            publicReplyText: replyText ? replyText : null,
            hideComment,
            ...(sendDm ? { text: text.trim() } : {}),
          });
          onSaved(saved);
          return;
        }
        if (automation.kind === "keyword" && !text.trim())
          return setError(t("automations.textRequired"));
        // Edit: nama/keywords/match untuk kedua jenis; teks hanya keyword.
        // Langkah sequence tidak bisa diubah (catatan di formulir).
        const saved = await api.automations.update(tenantId, automation.id, {
          name: trimmedName,
          keywords: parsedKeywords,
          match,
          ...(automation.kind === "keyword" ? { text: text.trim() } : {}),
        });
        onSaved(saved);
        return;
      }
      if (kind === "comment") {
        if (!channelAccountId)
          return setError(t("automations.commentAccountNone"));
        const replyText = publicReplyEnabled ? publicReplyText.trim() : "";
        if (!sendDm && !replyText && !hideComment)
          return setError(t("automations.commentActionsRequired"));
        if (sendDm && !text.trim())
          return setError(t("automations.commentDmTextRequired"));
        const saved = await api.automations.create(tenantId, {
          kind: "comment",
          name: trimmedName,
          keywords: parsedKeywords,
          match,
          channelAccountId,
          sendDm,
          ...(sendDm ? { dmText: text.trim() } : {}),
          publicReplyText: replyText ? replyText : null,
          hideComment,
        });
        onSaved(saved);
        return;
      }
      if (kind === "sequence") {
        if (stepRows.length === 0)
          return setError(t("automations.stepsRequired"));
        if (stepRows.length > 10)
          return setError(t("automations.stepsTooMany"));
        const steps = stepRows.map((row) => ({
          delayMinutes: Number(row.delay),
          text: row.text.trim(),
        }));
        if (
          steps.some(
            (s) =>
              !Number.isInteger(s.delayMinutes) ||
              s.delayMinutes < 0 ||
              s.delayMinutes > 43200,
          )
        )
          return setError(t("automations.stepDelayInvalid"));
        if (steps.some((s) => !s.text))
          return setError(t("automations.stepTextRequired"));
        const saved = await api.automations.create(tenantId, {
          kind: "sequence",
          name: trimmedName,
          keywords: parsedKeywords,
          match,
          steps,
        });
        onSaved(saved);
        return;
      }
      if (!text.trim()) return setError(t("automations.textRequired"));
      const saved = await api.automations.create(tenantId, {
        kind: "keyword",
        name: trimmedName,
        keywords: parsedKeywords,
        match,
        text: text.trim(),
      });
      onSaved(saved);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">
            {automation
              ? t("automations.editTitle")
              : t("automations.addTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("automations.nameLabel")} *
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("automations.namePlaceholder")}
              className={inputClassName}
            />
          </label>
          {!automation ? (
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-muted">
                {t("automations.kindLabel")}
              </legend>
              <div className="space-y-2">
                {(["keyword", "sequence", "comment"] as const).map((value) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface p-3"
                  >
                    <input
                      type="radio"
                      name="automation-kind"
                      value={value}
                      checked={kind === value}
                      onChange={() => setKind(value)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block text-sm font-medium text-ink">
                        {t(
                          value === "keyword"
                            ? "automations.kindKeyword"
                            : value === "sequence"
                              ? "automations.kindSequence"
                              : "automations.kindComment",
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {t(
                          value === "keyword"
                            ? "automations.kindKeywordHint"
                            : value === "sequence"
                              ? "automations.kindSequenceHint"
                              : "automations.kindCommentHint",
                        )}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("automations.keywordsLabel")} *
            </span>
            <input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder={t("automations.keywordsPlaceholder")}
              className={inputClassName}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {t("automations.keywordsHint")}
            </span>
          </label>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted">
              {t("automations.matchLabel")}
            </legend>
            <div className="space-y-2">
              {(["exact", "contains"] as const).map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface p-3"
                >
                  <input
                    type="radio"
                    name="automation-match"
                    value={value}
                    checked={match === value}
                    onChange={() => setMatch(value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink">
                      {t(
                        value === "exact"
                          ? "automations.matchExact"
                          : "automations.matchContains",
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {t(
                        value === "exact"
                          ? "automations.matchExactHint"
                          : "automations.matchContainsHint",
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {automation?.kind === "comment" ||
          (!automation && kind === "comment") ? (
            <div className="space-y-3">
              {automation ? (
                <div>
                  <span className="mb-1 block text-xs font-medium text-muted">
                    {t("automations.commentAccountLabel")}
                  </span>
                  <p className="rounded-lg border border-line bg-surface p-3 text-sm text-ink">
                    {commentChannels.find(
                      (ch) => ch.id === automation.channelAccountId,
                    )?.displayName ??
                      automation.channelAccountId ??
                      "—"}
                  </p>
                  <span className="mt-1 block text-[11px] text-muted">
                    {t("automations.commentAccountLockedNote")}
                  </span>
                </div>
              ) : (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">
                    {t("automations.commentAccountLabel")} *
                  </span>
                  <select
                    value={channelAccountId}
                    onChange={(e) => setChannelAccountId(e.target.value)}
                    className={inputClassName}
                  >
                    {commentChannels.length === 0 ? (
                      <option value="">
                        {t("automations.commentAccountNone")}
                      </option>
                    ) : (
                      commentChannels.map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          {ch.displayName}
                          {ch.publicHandle ? ` (${ch.publicHandle})` : ""}
                        </option>
                      ))
                    )}
                  </select>
                  <span className="mt-1 block text-[11px] text-muted">
                    {t("automations.commentAccountHint")}
                  </span>
                </label>
              )}
              <fieldset>
                <legend className="mb-1 text-xs font-medium text-muted">
                  {t("automations.commentActionsLabel")}
                </legend>
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface p-3">
                    <input
                      type="checkbox"
                      checked={sendDm}
                      onChange={(e) => setSendDm(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="block flex-1 text-sm font-medium text-ink">
                      {t("automations.commentSendDm")}
                    </span>
                  </label>
                  {sendDm ? (
                    <label className="block pl-6">
                      <span className="mb-1 block text-xs font-medium text-muted">
                        {t("automations.commentDmTextLabel")} *
                      </span>
                      <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={t("automations.commentDmTextPlaceholder")}
                        rows={3}
                        className={inputClassName}
                      />
                      <span className="mt-1 block text-[11px] text-muted">
                        {t("automations.textHint")}
                      </span>
                    </label>
                  ) : null}
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface p-3">
                    <input
                      type="checkbox"
                      checked={publicReplyEnabled}
                      onChange={(e) => setPublicReplyEnabled(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="block flex-1 text-sm font-medium text-ink">
                      {t("automations.commentPublicReply")}
                    </span>
                  </label>
                  {publicReplyEnabled ? (
                    <label className="block pl-6">
                      <span className="mb-1 block text-xs font-medium text-muted">
                        {t("automations.commentPublicReplyTextLabel")} *
                      </span>
                      <textarea
                        value={publicReplyText}
                        onChange={(e) => setPublicReplyText(e.target.value)}
                        placeholder={t(
                          "automations.commentPublicReplyTextPlaceholder",
                        )}
                        rows={2}
                        className={inputClassName}
                      />
                      <span className="mt-1 block text-[11px] text-muted">
                        {t("automations.textHint")}
                      </span>
                    </label>
                  ) : null}
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface p-3">
                    <input
                      type="checkbox"
                      checked={hideComment}
                      onChange={(e) => setHideComment(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-ink">
                        {t("automations.commentHide")}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {t("automations.commentHideHint")}
                      </span>
                    </span>
                  </label>
                </div>
              </fieldset>
            </div>
          ) : automation?.kind === "sequence" ? (
            <div>
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("automations.stepsLabel")}
              </span>
              <ul className="space-y-2">
                {automation.steps.map((step) => (
                  <li
                    key={step.position}
                    className="rounded-lg border border-line bg-surface p-3 text-sm"
                  >
                    <span className="font-medium text-ink">
                      {step.position}. +{step.delayMinutes}{" "}
                      {t("automations.stepDelayLabel")}
                    </span>
                    <span className="mt-0.5 block text-muted">{step.text}</span>
                  </li>
                ))}
              </ul>
              <span className="mt-1 block text-[11px] text-muted">
                {t("automations.stepsLockedNote")}
              </span>
            </div>
          ) : kind === "sequence" ? (
            <div>
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("automations.stepsLabel")} *
              </span>
              <div className="space-y-2">
                {stepRows.map((row, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-line bg-surface p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink">
                        {i + 1}.
                      </span>
                      <label className="flex items-center gap-1 text-xs text-muted">
                        {t("automations.stepDelayLabel")}
                        <input
                          type="number"
                          min={0}
                          max={43200}
                          step={1}
                          value={row.delay}
                          onChange={(e) =>
                            setStepRows((prev) =>
                              prev.map((r, j) =>
                                j === i ? { ...r, delay: e.target.value } : r,
                              ),
                            )
                          }
                          className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
                        />
                      </label>
                      {stepRows.length > 1 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setStepRows((prev) =>
                              prev.filter((_, j) => j !== i),
                            )
                          }
                          className="ml-auto rounded-md bg-elevated px-2 py-1 text-xs font-medium text-ink"
                        >
                          {t("automations.removeStepButton")}
                        </button>
                      ) : null}
                    </div>
                    <textarea
                      value={row.text}
                      onChange={(e) =>
                        setStepRows((prev) =>
                          prev.map((r, j) =>
                            j === i ? { ...r, text: e.target.value } : r,
                          ),
                        )
                      }
                      placeholder={t("automations.stepTextPlaceholder")}
                      rows={2}
                      className={`${inputClassName} mt-2`}
                    />
                  </div>
                ))}
              </div>
              {stepRows.length < 10 ? (
                <button
                  type="button"
                  onClick={() =>
                    setStepRows((prev) => [...prev, { delay: "60", text: "" }])
                  }
                  className="mt-2 rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                >
                  {t("automations.addStepButton")}
                </button>
              ) : null}
              <span className="mt-1 block text-[11px] text-muted">
                {t("automations.stepsHint")} {t("automations.textHint")}
              </span>
            </div>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("automations.textLabel")} *
              </span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("automations.textPlaceholder")}
                rows={4}
                className={inputClassName}
              />
              <span className="mt-1 block text-[11px] text-muted">
                {t("automations.textHint")}
              </span>
            </label>
          )}
          {/* Peringatan penanda [...] belum diganti pada teks langkah
              sequence — murni tampilan, TIDAK PERNAH menghalangi simpan
              (pola formulir agent, keputusan pemilik). */}
          {isSequenceForm && seqPlaceholders.length > 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
              <p className="text-xs font-semibold text-warning">
                {t("automations.tplPlaceholderWarningTitle")}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink">
                {t("automations.tplPlaceholderWarningBody", {
                  placeholders: seqPlaceholders
                    .map((p) => `[${p}]`)
                    .join(", "),
                })}
              </p>
            </div>
          ) : null}
          <FieldError message={error} />
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {submitting
                ? automation
                  ? t("automations.saving")
                  : t("automations.creating")
                : automation
                  ? t("automations.saveChanges")
                  : t("automations.createButton")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
            >
              {t("common.cancel")}
            </button>
          </div>
          {/* Aksi sekunder (G2, pola formulir agent): simpan susunan
              sequence formulir ini sebagai templat pribadi untuk
              dipakai ulang dari galeri — salinan, bukan rujukan. */}
          {isSequenceForm ? (
            <>
              <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setTemplateSavedName(null);
                    setTemplateName((prev) => prev || name);
                    setSaveFoldOpen((v) => !v);
                  }}
                  className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
                >
                  {t("automations.tplSaveAsButton")}
                </button>
              </div>
              {templateSavedName ? (
                <p className="rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
                  {t("automations.tplSaveSavedNotice", {
                    name: templateSavedName,
                  })}
                </p>
              ) : null}
              {saveFoldOpen ? (
                <div className="rounded-xl border border-line bg-surface p-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-muted">
                      {t("automations.nameLabel")}
                    </span>
                    <input
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      placeholder={t("automations.tplSaveNamePlaceholder")}
                      className={inputClassName}
                    />
                  </label>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={savingTemplate}
                      onClick={() => void handleSaveAsTemplate()}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {savingTemplate
                        ? t("automations.tplSaveSavingButton")
                        : t("automations.tplSaveConfirmButton")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSaveFoldOpen(false)}
                      className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function RunsModal({
  t,
  locale,
  tenantId,
  automation,
  onClose,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  automation: AutomationResponse;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<AutomationRunResponse[]>([]);
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.automations.listRuns(tenantId, automation.id);
        if (cancelled) return;
        setRuns(list);
        // Nama kontak bersifat pelengkap: ambil per kontak unik, abaikan gagal.
        const uniqueContactIds = [...new Set(list.map((r) => r.contactId))];
        const names: Record<string, string> = {};
        await Promise.all(
          uniqueContactIds.map(async (contactId) => {
            try {
              const contact = await api.contacts.get(tenantId, contactId);
              names[contactId] = contact.name;
            } catch {
              // biarkan fallback ke ID ringkas
            }
          }),
        );
        if (!cancelled) setContactNames(names);
      } catch (err) {
        if (!cancelled) setError(translateApiError(t, err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, automation.id, t]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-ink">
              {t("automations.runsTitle")}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{automation.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        {loading ? (
          <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
        ) : error ? (
          <p className="mt-4 text-sm text-danger">
            {t("automations.runsLoadError")} {error}
          </p>
        ) : runs.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t("automations.runsEmpty")}</p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {runs.map((run) => (
              <li key={run.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      run.status === "completed"
                        ? "bg-accent/10 text-accent"
                        : run.status === "failed"
                          ? "bg-elevated text-danger"
                          : "bg-elevated text-muted"
                    }`}
                  >
                    {t(
                      `automations.runStatus.${run.status}` as TranslationKey,
                    )}
                  </span>
                  <span className="text-xs text-muted">
                    {formatDateTime(run.createdAt, locale)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink">
                  {t("automations.runContactLabel")}:{" "}
                  {contactNames[run.contactId] ?? shortId(run.contactId)}
                </p>
                <p className="text-xs text-muted">
                  {t("automations.runConversationLabel")}:{" "}
                  {shortId(run.conversationId)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EnrollmentsModal({
  t,
  locale,
  tenantId,
  automation,
  onClose,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  automation: AutomationResponse;
  onClose: () => void;
}) {
  const [enrollments, setEnrollments] = useState<SequenceEnrollmentResponse[]>(
    [],
  );
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEnrollments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.automations.listEnrollments(
        tenantId,
        automation.id,
      );
      setEnrollments(list);
      // Nama kontak bersifat pelengkap: ambil per kontak unik, abaikan gagal.
      const uniqueContactIds = [...new Set(list.map((e) => e.contactId))];
      const names: Record<string, string> = {};
      await Promise.all(
        uniqueContactIds.map(async (contactId) => {
          try {
            const contact = await api.contacts.get(tenantId, contactId);
            names[contactId] = contact.name;
          } catch {
            // biarkan fallback ke ID ringkas
          }
        }),
      );
      setContactNames(names);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, automation.id, t]);

  useEffect(() => {
    void loadEnrollments();
  }, [loadEnrollments]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-ink">
              {t("automations.enrollmentsTitle")}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{automation.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        <ManualEnrollSection
          t={t}
          locale={locale}
          tenantId={tenantId}
          automation={automation}
          onEnrolled={() => void loadEnrollments()}
        />
        {loading ? (
          <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
        ) : error ? (
          <p className="mt-4 text-sm text-danger">
            {t("automations.enrollmentsLoadError")} {error}
          </p>
        ) : enrollments.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            {t("automations.enrollmentsEmpty")}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {enrollments.map((enrollment) => (
              <li key={enrollment.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      enrollment.status === "active"
                        ? "bg-accent/10 text-accent"
                        : "bg-elevated text-muted"
                    }`}
                  >
                    {t(
                      `automations.enrollmentStatus.${enrollment.status}` as TranslationKey,
                    )}
                  </span>
                  <span className="text-xs text-muted">
                    {formatDateTime(enrollment.createdAt, locale)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink">
                  {t("automations.enrollmentContactLabel")}:{" "}
                  {contactNames[enrollment.contactId] ??
                    shortId(enrollment.contactId)}
                </p>
                <p className="text-xs text-muted">
                  {t("automations.enrollmentProgressLabel", {
                    current: formatNumber(enrollment.currentStep, locale),
                    total: formatNumber(enrollment.totalSteps, locale),
                  })}
                  {enrollment.status === "active" && enrollment.nextRunAt
                    ? ` · ${t("automations.enrollmentNextLabel", {
                        date: formatDateTime(enrollment.nextRunAt, locale),
                      })}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Pendaftaran sequence MANUAL (G2b) di dalam modal pendaftaran:
 * daftarkan satu kontak (dengan pemilih percakapan pesan sebagai
 * jangkar) atau semua kontak bertag. Penolakan dari API selalu
 * berkode dan diterjemahkan di sini (kontak tanpa percakapan pesan,
 * opt-out, sequence nonaktif) — pengguna membaca SEBABNYA, bukan
 * pesan generik. Sesudah berhasil, daftar pendaftaran dimuat ulang
 * oleh modal induk lewat `onEnrolled`.
 */
function ManualEnrollSection({
  t,
  locale,
  tenantId,
  automation,
  onEnrolled,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  automation: AutomationResponse;
  onEnrolled: () => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ContactResponse[]>([]);
  const [searched, setSearched] = useState(false);
  const [selectedContact, setSelectedContact] =
    useState<ContactResponse | null>(null);
  const [conversations, setConversations] = useState<
    EnrollConversationResponse[] | null
  >(null);
  const [conversationId, setConversationId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const [tag, setTag] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [tagReport, setTagReport] =
    useState<EnrollSequenceByTagResponse | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);

  const runSearch = async (value: string) => {
    setSearch(value);
    setNotice(null);
    setActionError(null);
    const seq = ++searchSeq.current;
    if (value.trim().length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    try {
      const page = await api.contacts.list(tenantId, {
        search: value.trim(),
        limit: 8,
      });
      if (searchSeq.current !== seq) return;
      setResults(page.contacts);
      setSearched(true);
    } catch {
      if (searchSeq.current !== seq) return;
      setResults([]);
      setSearched(true);
    }
  };

  const pickContact = async (contact: ContactResponse) => {
    setSelectedContact(contact);
    setResults([]);
    setSearched(false);
    setSearch(contact.name);
    setNotice(null);
    setActionError(null);
    setConversations(null);
    setConversationId("");
    try {
      const list = await api.automations.listEnrollConversations(
        tenantId,
        automation.id,
        contact.id,
      );
      setConversations(list);
      // Bawaan semantik jangkar: percakapan pesan terbaru (urutan
      // pertama dari server).
      setConversationId(list[0]?.id ?? "");
    } catch (err) {
      setActionError(translateApiError(t, err));
      setConversations([]);
    }
  };

  const enrollOne = async () => {
    if (!selectedContact || !conversationId) return;
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      const result = await api.automations.enrollContact(
        tenantId,
        automation.id,
        { contactId: selectedContact.id, conversationId },
      );
      setNotice(
        result.outcome === "enrolled"
          ? t("automations.enrollSuccess")
          : t("automations.enrollAlready"),
      );
      onEnrolled();
    } catch (err) {
      setActionError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const enrollTag = async () => {
    const value = tag.trim();
    if (!value) return;
    setTagBusy(true);
    setTagError(null);
    setTagReport(null);
    try {
      const report = await api.automations.enrollByTag(
        tenantId,
        automation.id,
        { tag: value },
      );
      setTagReport(report);
      onEnrolled();
    } catch (err) {
      setTagError(translateApiError(t, err));
    } finally {
      setTagBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-line bg-elevated/40 p-4">
      <h3 className="text-sm font-semibold text-ink">
        {t("automations.enrollManualTitle")}
      </h3>
      <p className="mt-1 text-sm text-muted">
        {t("automations.enrollManualHint")}
      </p>
      <input
        type="text"
        value={search}
        onChange={(e) => void runSearch(e.target.value)}
        placeholder={t("automations.enrollSearchPlaceholder")}
        className={`${inputClassName} mt-3`}
      />
      {results.length > 0 ? (
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
          {results.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                onClick={() => void pickContact(contact)}
                className="w-full px-3 py-2 text-left"
              >
                <span className="block text-sm font-medium text-ink">
                  {contact.name}
                </span>
                <span className="block text-xs text-muted">
                  {[contact.phone, contact.email]
                    .filter(Boolean)
                    .join(" · ") || shortId(contact.id)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : searched && !selectedContact ? (
        <p className="mt-2 text-sm text-muted">
          {t("automations.enrollNoResults")}
        </p>
      ) : null}
      {selectedContact ? (
        <div className="mt-3">
          {conversations === null ? (
            <p className="text-sm text-muted">{t("common.loading")}</p>
          ) : conversations.length === 0 ? (
            <p className="text-sm text-warning">
              {t("automations.enrollConversationNone")}
            </p>
          ) : (
            <>
              <label className="block text-xs font-medium text-muted">
                {t("automations.enrollConversationLabel")}
                <select
                  value={conversationId}
                  onChange={(e) => setConversationId(e.target.value)}
                  className={`${inputClassName} mt-1`}
                >
                  {conversations.map((conv, i) => (
                    <option key={conv.id} value={conv.id}>
                      {(conv.title ?? selectedContact.name) +
                        ` · ${t(
                          conv.kind === "group"
                            ? "automations.enrollKindGroup"
                            : "automations.enrollKindPrivate",
                        )} · ${conv.provider}` +
                        (conv.lastMessageAt
                          ? ` · ${formatDateTime(conv.lastMessageAt, locale)}`
                          : "") +
                        (i === 0
                          ? ` (${t("automations.enrollConversationLatest")})`
                          : "")}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void enrollOne()}
                disabled={busy || !conversationId}
                className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {t("automations.enrollButton")}
              </button>
            </>
          )}
        </div>
      ) : null}
      {notice ? (
        <p className="mt-3 text-sm text-accent">{notice}</p>
      ) : null}
      {actionError ? (
        <p className="mt-3 text-sm text-danger">{actionError}</p>
      ) : null}
      <div className="mt-4 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-ink">
          {t("automations.enrollByTagTitle")}
        </h3>
        <p className="mt-1 text-sm text-muted">
          {t("automations.enrollByTagHint")}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder={t("automations.enrollTagPlaceholder")}
            className={inputClassName}
          />
          <button
            type="button"
            onClick={() => void enrollTag()}
            disabled={tagBusy || !tag.trim()}
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {t("automations.enrollByTagButton")}
          </button>
        </div>
        {tagError ? (
          <p className="mt-3 text-sm text-danger">{tagError}</p>
        ) : null}
        {tagReport ? (
          <div className="mt-3 text-sm text-ink">
            <p>
              {t("automations.enrollReport", {
                tag: tagReport.tag,
                matched: formatNumber(tagReport.matched, locale),
                enrolled: formatNumber(tagReport.enrolled, locale),
                already: formatNumber(tagReport.alreadyEnrolled, locale),
                skipped: formatNumber(tagReport.skippedTotal, locale),
                noConversation: formatNumber(
                  tagReport.skippedByReason.noConversation,
                  locale,
                ),
                optedOut: formatNumber(
                  tagReport.skippedByReason.contactOptedOut,
                  locale,
                ),
              })}
            </p>
            {tagReport.capped ? (
              <p className="mt-1 text-muted">
                {t("automations.enrollReportCapped")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
