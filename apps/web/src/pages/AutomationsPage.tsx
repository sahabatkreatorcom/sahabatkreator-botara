import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  AutomationKind,
  AutomationMatch,
  AutomationResponse,
  AutomationRunResponse,
  AutomationTemplateCategory,
  AutomationTemplateSummary,
  ChannelAccountResponse,
  CommentResponse,
  SequenceEnrollmentResponse,
} from "@sahabat-kreator/contracts";
import {
  formatNumber,
  type Locale,
  type TranslationKey,
} from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
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
}

/**
 * Halaman Automations (Fase 2B; sequence Fase 2C): pengelolaan automation
 * workspace aktif — daftar + sakelar aktif, form buat/edit untuk dua jenis
 * (balasan keyword & rangkaian pesan/sequence), riwayat eksekusi (runs)
 * untuk keyword, dan daftar pendaftaran (enrollments) untuk sequence.
 * Semua teks lewat i18n; tanggal lewat Intl.
 */
export function AutomationsPage({ t, locale }: AutomationsPageProps) {
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

  const loadTemplates = useCallback(async () => {
    if (!tenantId) return;
    try {
      const res = await api.automations.listTemplates(tenantId);
      setTemplates(res.templates);
    } catch (err) {
      setError(translateApiError(t, err));
      setTemplates([]);
    }
  }, [tenantId, t]);

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
        <div className="mt-4 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">
            {t("automations.tplGalleryTitle")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {t("automations.tplGallerySubtitle")}
          </p>
          {templates === null ? (
            <p className="mt-4 text-sm text-muted">{t("workspace.loading")}</p>
          ) : templates.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              {t("automations.tplGalleryEmpty")}
            </p>
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
                    {tpl.kind === "sequence"
                      ? t("automations.tplSequenceMeta", {
                          count: tpl.stepCount,
                        })
                      : t("automations.tplKeywordMeta", {
                          count: tpl.keywordCount,
                        })}
                  </p>
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
                </li>
              ))}
            </ul>
          )}
        </div>
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
}: {
  t: Translate;
  tenantId: string;
  automation: AutomationResponse | null;
  onClose: () => void;
  onSaved: (automation: AutomationResponse) => void;
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.automations.listEnrollments(
          tenantId,
          automation.id,
        );
        if (cancelled) return;
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
