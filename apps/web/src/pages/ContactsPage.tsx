import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  ContactBulkRequest,
  ContactConversation,
  ContactDuplicatesResponse,
  ContactFieldDefinitionResponse,
  ContactFieldType,
  ContactImportResponse,
  ContactScanCandidateResponse,
  ContactScanRunResponse,
  ContactNoteResponse,
  ContactPointsResponse,
  LeaderboardEntry,
  LoyaltyLevel,
  ContactResponse,
  ContactTimelineEvent,
  EffectiveOptInStatus,
  OptInStatus,
  SegmentCondition,
  SegmentDefinition,
  SegmentResponse,
} from "@sahabat-kreator/contracts";
import {
  formatNumber,
  type Locale,
  type TranslationKey,
} from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { Avatar } from "../components/Avatar";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

const PAGE_SIZE = 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KNOWN_STAGES = ["new", "contacted", "qualified", "customer", "lost"] as const;
const OPT_IN_VALUES: OptInStatus[] = ["unknown", "opted_in", "opted_out"];

function stageLabel(t: Translate, stage: string): string {
  return (KNOWN_STAGES as readonly string[]).includes(stage)
    ? t(`contacts.stages.${stage}` as TranslationKey)
    : stage;
}

function optInLabel(t: Translate, status: OptInStatus): string {
  return t(`contacts.optIn.${status}` as TranslationKey);
}

function effectiveOptInLabel(
  t: Translate,
  status: EffectiveOptInStatus,
): string {
  return t(`contacts.optInEffective.${status}` as TranslationKey);
}

const TIMELINE_KIND_KEYS: Record<ContactTimelineEvent["kind"], TranslationKey> =
  {
    contact_created: "contacts.timeline.kindContactCreated",
    first_message: "contacts.timeline.kindFirstMessage",
    last_message: "contacts.timeline.kindLastMessage",
    opt_in_changed: "contacts.timeline.kindOptInChanged",
    merged_in: "contacts.timeline.kindMergedIn",
    sequence_enrolled: "contacts.timeline.kindSequenceEnrolled",
    sequence_completed: "contacts.timeline.kindSequenceCompleted",
    sequence_cancelled: "contacts.timeline.kindSequenceCancelled",
    handoff: "contacts.timeline.kindHandoff",
    contact_note_added: "contacts.timeline.kindContactNoteAdded",
    conversation_note_added: "contacts.timeline.kindConversationNoteAdded",
  };

function asEffectiveStatus(value: unknown): EffectiveOptInStatus | null {
  return value === "opted_in" || value === "none" || value === "opted_out"
    ? value
    : null;
}

/**
 * Baris detail satu peristiwa linimasa (di bawah label jenisnya):
 * merender hanya detail yang dikenal per jenis; detail lain diabaikan.
 */
function timelineEventDetail(
  t: Translate,
  event: ContactTimelineEvent,
): string | null {
  const d = event.detail;
  switch (event.kind) {
    case "contact_created":
      return typeof d.source === "string" && d.source
        ? `${t("contacts.timeline.sourcePrefix")}: ${d.source}`
        : null;
    case "first_message":
    case "last_message": {
      const parts: string[] = [];
      if (typeof d.provider === "string" && d.provider) {
        parts.push(t(`inbox.providers.${d.provider}` as TranslationKey));
      }
      if (d.direction === "inbound" || d.direction === "outbound") {
        parts.push(
          t(
            d.direction === "inbound"
              ? "contacts.timeline.directionInbound"
              : "contacts.timeline.directionOutbound",
          ),
        );
      }
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "opt_in_changed": {
      const from = asEffectiveStatus(d.from);
      const to = asEffectiveStatus(d.to);
      const parts: string[] = [];
      if (from && to) {
        parts.push(
          `${effectiveOptInLabel(t, from)} → ${effectiveOptInLabel(t, to)}`,
        );
      }
      if (d.source === "keyword") parts.push(t("contacts.optInSourceKeyword"));
      else if (d.source === "manual") parts.push(t("contacts.optInSourceManual"));
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "merged_in":
      return typeof d.mergedContactName === "string" && d.mergedContactName
        ? t("contacts.timeline.mergedFrom", { name: d.mergedContactName })
        : null;
    case "sequence_enrolled":
    case "sequence_completed":
      return typeof d.automationName === "string" ? d.automationName : null;
    case "sequence_cancelled": {
      const parts: string[] = [];
      if (typeof d.automationName === "string") parts.push(d.automationName);
      if (d.reason === "reply") {
        parts.push(t("contacts.timeline.cancelledReasonReply"));
      } else if (d.reason === "opt_out") {
        parts.push(t("contacts.timeline.cancelledReasonOptOut"));
      }
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "handoff":
      return typeof d.reason === "string" && d.reason ? d.reason : null;
    case "contact_note_added":
    case "conversation_note_added":
      return null;
  }
}

const PROVIDER_VALUES = [
  "whatsapp",
  "telegram",
  "messenger",
  "instagram",
  "webchat",
] as const;

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Badge platform kontak — penanda dari mana saja kontak ini pernah
 * menulis. Diturunkan server dari `conversations.provider` (bukan dari
 * data tersimpan di kontak), jadi kontak tanpa percakapan tidak
 * menampilkan badge apa pun. Urutan sudah stabil dari server
 * (WhatsApp → Instagram → Messenger → Telegram → Webchat), sehingga
 * badge tidak "melompat" antar pemuatan.
 */
function PlatformBadges({
  t,
  platforms,
  className = "",
  showEmpty = false,
}: {
  t: Translate;
  platforms: ContactResponse["platforms"];
  className?: string;
  showEmpty?: boolean;
}) {
  if (platforms.length === 0) {
    if (!showEmpty) return null;
    return (
      <span className={`text-[11px] text-muted ${className}`}>
        {t("contacts.platformsNone")}
      </span>
    );
  }
  return (
    <span className={`flex flex-wrap items-center gap-1 ${className}`}>
      {platforms.map((provider) => (
        <span
          key={provider}
          className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink"
        >
          {t(`inbox.providers.${provider}` as TranslationKey)}
        </span>
      ))}
    </span>
  );
}

interface ContactsPageProps {
  t: Translate;
  locale: Locale;
  /** Navigasi shell — dipakai tautan "Buka di Inbox" pada panel detail. */
  onNavigateTo?: (path: string) => void;
}

/**
 * Halaman Kontak (Fase 1E): daftar kontak workspace aktif dari API 1D —
 * pencarian server-side (?search=), pagination offset ("Muat lebih banyak"),
 * tambah kontak, dan detail/edit (nama, tags, pipeline stage, opt-in) via PATCH.
 */
export function ContactsPage({ t, locale, onNavigateTo }: ContactsPageProps) {
  const { status, tenants, active, reload } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [items, setItems] = useState<ContactResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  // Segmen (Fase 13C): daftar untuk filter + pengelola; filter aktif.
  const [segments, setSegments] = useState<SegmentResponse[]>([]);
  const [segmentFilter, setSegmentFilter] = useState("");
  // Filter tahap pipeline (daftar utama + ekspor berbagi filter ini).
  const [stageFilter, setStageFilter] = useState("");
  const canManageSegments =
    active?.role === "owner" || active?.role === "admin";

  // Pilihan massal: id kontak yang dicentang dari daftar yang tampil.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [bulkTag, setBulkTag] = useState("");
  const [bulkStage, setBulkStage] = useState<string>(KNOWN_STAGES[0]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  // Impor CSV: input berkas tersembunyi + laporan hasil terakhir.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] =
    useState<ContactImportResponse | null>(null);
  const [exporting, setExporting] = useState(false);

  const loadSegments = useCallback(async () => {
    if (!tenantId) return;
    try {
      const body = await api.segments.list(tenantId);
      setSegments(body.segments);
    } catch {
      // Kegagalan memuat segmen tidak boleh menghalangi daftar kontak.
      setSegments([]);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadSegments();
  }, [loadSegments]);

  // Definisi field kustom bertipe (G18 butir 1): dimuat non-blokir
  // seperti segmen — kegagalan memuatnya hanya berarti editor tampil
  // sebagai pasangan kunci–nilai bebas seperti sebelumnya.
  const [fieldDefinitions, setFieldDefinitions] = useState<
    ContactFieldDefinitionResponse[]
  >([]);
  const [showFieldManager, setShowFieldManager] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const loadFieldDefinitions = useCallback(async () => {
    if (!tenantId) return;
    try {
      setFieldDefinitions(await api.contacts.listFieldDefinitions(tenantId));
    } catch {
      setFieldDefinitions([]);
    }
  }, [tenantId]);
  useEffect(() => {
    void loadFieldDefinitions();
  }, [loadFieldDefinitions]);

  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<ContactResponse | null>(null);
  const requestSeq = useRef(0);

  // Kandidat duplikat (Fase 9B): dimuat terpisah dari daftar utama;
  // seksinya hanya tampil bila ada kandidat.
  const [dupGroups, setDupGroups] = useState<
    ContactDuplicatesResponse["groups"]
  >([]);
  const [dupError, setDupError] = useState<string | null>(null);
  const [mergePair, setMergePair] = useState<{
    survivor: ContactResponse;
    merged: ContactResponse;
  } | null>(null);
  const [merging, setMerging] = useState(false);
  const canMerge = active?.role === "owner" || active?.role === "admin";

  const loadDuplicates = useCallback(async () => {
    if (!tenantId) return;
    try {
      const body = await api.contacts.duplicates(tenantId);
      setDupGroups(body.groups);
      setDupError(null);
    } catch {
      // Kegagalan memuat kandidat tidak boleh menghalangi daftar utama.
      setDupError(t("contacts.duplicates.loadError"));
    }
  }, [tenantId, t]);

  useEffect(() => {
    void loadDuplicates();
  }, [loadDuplicates]);

  const confirmMerge = async () => {
    if (!tenantId || !mergePair) return;
    setMerging(true);
    try {
      await api.contacts.merge(tenantId, mergePair.survivor.id, mergePair.merged.id);
      setMergePair(null);
      await Promise.all([loadFirst(), loadDuplicates()]);
    } catch (err) {
      setError(translateApiError(t, err));
      setMergePair(null);
    } finally {
      setMerging(false);
    }
  };

  // Debounce kolom pencarian → query `search` API.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const loadFirst = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const body = await api.contacts.list(tenantId, {
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: 0,
        segmentId: segmentFilter || undefined,
        stage: stageFilter || undefined,
      });
      if (requestSeq.current !== seq) return;
      setItems(body.contacts);
      setTotal(body.total);
      // Muat ulang dari halaman pertama = konteks daftar baru;
      // pilihan massal dari daftar lama tidak diteruskan.
      setSelectedIds(new Set());
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setItems([]);
      setTotal(0);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, search, segmentFilter, stageFilter, t]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = async () => {
    if (!tenantId || loadingMore || items.length >= total) return;
    setLoadingMore(true);
    try {
      const body = await api.contacts.list(tenantId, {
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: items.length,
        segmentId: segmentFilter || undefined,
        stage: stageFilter || undefined,
      });
      setItems((prev) => [...prev, ...body.contacts]);
      setTotal(body.total);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoadingMore(false);
    }
  };

  // --- Aksi massal -------------------------------------------------
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulk = async (
    build: (ids: string[]) => ContactBulkRequest | null,
  ) => {
    if (!tenantId) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const request = build(ids);
    if (!request) return;
    setBulkBusy(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      const result = await api.contacts.bulk(tenantId, request);
      setBulkResult(
        t("contacts.bulk.result", {
          succeeded: formatNumber(result.succeeded, locale),
          failed: formatNumber(result.failed.length, locale),
        }) +
          (result.failed.length > 0
            ? ` (${t("contacts.bulk.notFoundSuffix")})`
            : ""),
      );
      setConfirmBulkDelete(false);
      await Promise.all([loadFirst(), loadDuplicates()]);
    } catch (err) {
      setBulkError(translateApiError(t, err));
      setConfirmBulkDelete(false);
    } finally {
      setBulkBusy(false);
    }
  };

  const runTagBulk = (action: "add_tag" | "remove_tag") => {
    const tag = bulkTag.trim();
    if (!tag) {
      setBulkError(t("contacts.bulk.tagRequired"));
      return;
    }
    void runBulk((ids) => ({ action, ids, tag }));
  };

  // --- Impor / ekspor CSV -------------------------------------------
  const handleImportFile = async (file: File) => {
    if (!tenantId) return;
    setImporting(true);
    setBulkError(null);
    try {
      const text = await file.text();
      const report = await api.contacts.importCsv(tenantId, text);
      setImportReport(report);
      await Promise.all([loadFirst(), loadDuplicates()]);
    } catch (err) {
      setBulkError(translateApiError(t, err));
    } finally {
      setImporting(false);
    }
  };

  const handleExport = async () => {
    if (!tenantId) return;
    setExporting(true);
    setBulkError(null);
    try {
      await api.contacts.downloadExport(tenantId, {
        search: search || undefined,
        segmentId: segmentFilter || undefined,
        stage: stageFilter || undefined,
      });
    } catch (err) {
      setBulkError(translateApiError(t, err));
    } finally {
      setExporting(false);
    }
  };

  const importReasonLabel = (reason: string): string => {
    // Alasan majemuk G18 (invalid_custom_field:<kunci>:<sebab>) —
    // label dasar dari segmen pertama + rincian server apa adanya.
    const base = reason.split(":")[0]!;
    const key = `contacts.importReasons.${base}` as TranslationKey;
    const label = t(key);
    // Kunci tak dikenal (alasan baru dari server) tampil apa adanya —
    // lebih baik daripada menyembunyikan alasan barisnya.
    if (label === key) return reason;
    return reason.includes(":")
      ? `${label} (${reason.split(":").slice(1).join(":")})`
      : label;
  };

  if (status === "loading") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("contacts.title")}</h1>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("contacts.title")}</h1>
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
        <h1 className="text-2xl font-bold text-ink">{t("contacts.title")}</h1>
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
          <h1 className="text-2xl font-bold text-ink">{t("contacts.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("contacts.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleImportFile(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
          >
            {importing ? t("contacts.importing") : t("contacts.importButton")}
          </button>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
          >
            {t("contacts.exportButton")}
          </button>
          <button
            type="button"
            onClick={() => setShowFieldManager(true)}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("contacts.fields.manageButton")}
          </button>
          <button
            type="button"
            onClick={() => setShowScan(true)}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("contacts.scan.openButton")}
          </button>
          <button
            type="button"
            onClick={() => setShowLeaderboard(true)}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("contacts.leaderboard.openButton")}
          </button>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {t("contacts.addButton")}
          </button>
        </div>
      </div>

      {importReport ? (
        <div className="mt-5 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">
            {t("contacts.importReportTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {t("contacts.importReportImported", {
              count: formatNumber(importReport.imported, locale),
            })}
          </p>
          {importReport.duplicates.length > 0 ? (
            <>
              <p className="mt-2 text-xs font-medium text-muted">
                {t("contacts.importReportDuplicates", {
                  count: formatNumber(importReport.duplicates.length, locale),
                })}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {importReport.duplicates.map((issue) => (
                  <li key={`dup-${issue.row}`}>
                    {t("contacts.importRowLabel", { row: issue.row })} —{" "}
                    {importReasonLabel(issue.reason)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {importReport.invalid.length > 0 ? (
            <>
              <p className="mt-2 text-xs font-medium text-muted">
                {t("contacts.importReportInvalid", {
                  count: formatNumber(importReport.invalid.length, locale),
                })}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {importReport.invalid.map((issue) => (
                  <li key={`inv-${issue.row}`}>
                    {t("contacts.importRowLabel", { row: issue.row })} —{" "}
                    {importReasonLabel(issue.reason)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {showForm ? (
        <CreateContactForm
          t={t}
          tenantId={active.id}
          onCancel={() => setShowForm(false)}
          onCreated={(contact) => {
            setShowForm(false);
            setItems((prev) => [contact, ...prev]);
            setTotal((prev) => prev + 1);
            void loadDuplicates();
          }}
        />
      ) : null}

      {dupError ? (
        <p className="mt-4 text-xs text-danger">{dupError}</p>
      ) : null}

      {dupGroups.length > 0 ? (
        <div className="mt-5 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">
            {t("contacts.duplicates.title")}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {t("contacts.duplicates.subtitle")}
          </p>
          {!canMerge ? (
            <p className="mt-2 text-xs text-muted">
              {t("contacts.duplicates.forbiddenNote")}
            </p>
          ) : null}
          <div className="mt-3 space-y-3">
            {dupGroups.map((group, gi) => {
              const [survivor] = group.contacts;
              if (!survivor) return null;
              return (
                <div
                  key={gi}
                  className="rounded-lg border border-line bg-elevated/40 p-3"
                >
                  <div className="flex flex-wrap gap-1">
                    {group.reasons.map((reason, ri) => (
                      <span
                        key={ri}
                        className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent"
                      >
                        {reason.type === "phone"
                          ? t("contacts.duplicates.reasonPhone")
                          : reason.type === "email"
                            ? t("contacts.duplicates.reasonEmail")
                            : t("contacts.duplicates.reasonIdentity", {
                                provider:
                                  reason.value.split(":")[0] ?? reason.value,
                              })}
                        {reason.type !== "channel_identity"
                          ? `: ${reason.value}`
                          : ""}
                      </span>
                    ))}
                  </div>
                  <ul className="mt-2 space-y-2">
                    {group.contacts.map((contact) => {
                      const isSurvivor = contact.id === survivor.id;
                      return (
                        <li
                          key={contact.id}
                          className="flex flex-wrap items-center gap-2 text-sm"
                        >
                          <Avatar
                            name={contact.name}
                            imageUrl={contact.avatarUrl}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-ink">
                              {contact.name}
                            </span>
                            <span className="block truncate text-xs text-muted">
                              {[contact.phone, contact.email]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                            </span>
                          </span>
                          {isSurvivor ? (
                            <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
                              {t("contacts.duplicates.keptLabel")}
                            </span>
                          ) : canMerge ? (
                            <button
                              type="button"
                              onClick={() =>
                                setMergePair({ survivor, merged: contact })
                              }
                              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-semibold text-ink"
                            >
                              {t("contacts.duplicates.mergeButton")}
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <SegmentsManager
        t={t}
        tenantId={active.id}
        segments={segments}
        canManage={canManageSegments}
        onChanged={() => void loadSegments()}
      />

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <div className="min-w-52 flex-1">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("contacts.searchPlaceholder")}
            aria-label={t("common.search")}
            className={inputClassName}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span>{t("contacts.segmentFilterLabel")}</span>
          <select
            value={segmentFilter}
            onChange={(e) => setSegmentFilter(e.target.value)}
            className="rounded-lg border border-line bg-surface px-2 py-2 text-sm text-ink"
          >
            <option value="">{t("contacts.segmentFilterAll")}</option>
            {segments.map((seg) => (
              <option key={seg.id} value={seg.id}>
                {seg.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span>{t("contacts.stageFilterLabel")}</span>
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="rounded-lg border border-line bg-surface px-2 py-2 text-sm text-ink"
          >
            <option value="">{t("contacts.stageFilterAll")}</option>
            {KNOWN_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {stageLabel(t, stage)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm text-muted">
          {t("contacts.totalLabel", { count: formatNumber(total, locale) })}
        </span>
        <button
          type="button"
          onClick={() => void loadFirst()}
          className="rounded-lg bg-elevated px-3 py-2 text-sm font-medium text-ink"
        >
          {t("common.reload")}
        </button>
      </div>

      <FieldError message={error} />
      <FieldError message={bulkError} />
      {bulkResult ? (
        <p className="mt-2 text-sm text-muted">{bulkResult}</p>
      ) : null}

      {selectedIds.size > 0 ? (
        <div className="mt-4 rounded-xl border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">
              {t("contacts.bulk.selectedLabel", {
                count: formatNumber(selectedIds.size, locale),
              })}
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
            >
              {t("contacts.bulk.clearSelection")}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              placeholder={t("contacts.bulk.tagPlaceholder")}
              aria-label={t("contacts.bulk.tagPlaceholder")}
              className="w-40 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
            />
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => runTagBulk("add_tag")}
              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-60"
            >
              {t("contacts.bulk.addTag")}
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => runTagBulk("remove_tag")}
              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-60"
            >
              {t("contacts.bulk.removeTag")}
            </button>
            <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
            <select
              value={bulkStage}
              onChange={(e) => setBulkStage(e.target.value)}
              aria-label={t("contacts.stageLabel")}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
            >
              {KNOWN_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {stageLabel(t, stage)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk((ids) => ({ action: "set_stage", ids, stage: bulkStage }))
              }
              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-60"
            >
              {t("contacts.bulk.stageApply")}
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulk((ids) => ({ action: "opt_out", ids }))}
              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-60"
            >
              {t("contacts.bulk.optOut")}
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setConfirmBulkDelete(true)}
              className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
            >
              {t("contacts.bulk.delete")}
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <h2 className="text-base font-semibold text-ink">
            {search || segmentFilter || stageFilter
              ? t("contacts.emptySearchTitle")
              : t("contacts.emptyTitle")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            {search || segmentFilter || stageFilter
              ? t("contacts.emptySearchBody")
              : t("contacts.emptyBody")}
          </p>
        </div>
      ) : (
        <>
          <label className="mt-5 flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={
                items.length > 0 &&
                items.every((contact) => selectedIds.has(contact.id))
              }
              onChange={(e) => {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  for (const contact of items) {
                    if (e.target.checked) next.add(contact.id);
                    else next.delete(contact.id);
                  }
                  return next;
                });
              }}
              className="h-4 w-4"
            />
            <span>{t("contacts.bulk.selectAllLoaded")}</span>
          </label>
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {items.map((contact) => (
              <li
                key={contact.id}
                className="flex items-center gap-2 px-4 py-3 hover:bg-elevated"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(contact.id)}
                  onChange={() => toggleSelected(contact.id)}
                  aria-label={contact.name}
                  className="h-4 w-4 shrink-0"
                />
                <button
                  type="button"
                  onClick={() => setSelected(contact)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <Avatar name={contact.name} imageUrl={contact.avatarUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">
                      {contact.name}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {[contact.phone, contact.email]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </span>
                    <PlatformBadges
                      t={t}
                      platforms={contact.platforms}
                      className="mt-1"
                    />
                    {contact.tags.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {contact.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink"
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
                    {stageLabel(t, contact.pipelineStage)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {items.length < total ? (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
              >
                {loadingMore ? t("common.loading") : t("common.loadMore")}
              </button>
            </div>
          ) : null}
        </>
      )}

      {showFieldManager ? (
        <FieldDefinitionsModal
          t={t}
          tenantId={active.id}
          definitions={fieldDefinitions}
          onClose={() => setShowFieldManager(false)}
          onChanged={() => void loadFieldDefinitions()}
        />
      ) : null}

      {showScan ? (
        <ContactScanModal
          t={t}
          locale={locale}
          tenantId={active.id}
          onClose={() => setShowScan(false)}
          onImported={() => void loadFirst()}
        />
      ) : null}

      {showLeaderboard ? (
        <LeaderboardModal
          t={t}
          tenantId={active.id}
          onClose={() => setShowLeaderboard(false)}
        />
      ) : null}

      {selected ? (
        <ContactDetailModal
          t={t}
          tenantId={active.id}
          contact={selected}
          fieldDefinitions={fieldDefinitions}
          onClose={() => setSelected(null)}
          onOpenConversation={(conversationId) => {
            const path = `/inbox/${encodeURIComponent(conversationId)}`;
            if (onNavigateTo) onNavigateTo(path);
            else window.location.href = path;
          }}
          onUpdated={(updated) => {
            setItems((prev) =>
              prev.map((c) => (c.id === updated.id ? updated : c)),
            );
            setSelected(updated);
          }}
        />
      ) : null}

      {confirmBulkDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5">
            <h2 className="text-base font-semibold text-ink">
              {t("contacts.bulk.confirmDeleteTitle")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t("contacts.bulk.confirmDeleteBody", {
                count: formatNumber(selectedIds.size, locale),
              })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmBulkDelete(false)}
                disabled={bulkBusy}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void runBulk((ids) => ({ action: "delete", ids }))}
                disabled={bulkBusy}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {bulkBusy
                  ? t("contacts.bulk.deleting")
                  : t("contacts.bulk.confirmDeleteButton")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {mergePair ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5">
            <h2 className="text-base font-semibold text-ink">
              {t("contacts.duplicates.confirmTitle")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t("contacts.duplicates.confirmBody", {
                merged: mergePair.merged.name,
                survivor: mergePair.survivor.name,
              })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMergePair(null)}
                disabled={merging}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmMerge()}
                disabled={merging}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {merging
                  ? t("contacts.duplicates.merging")
                  : t("contacts.duplicates.confirmButton")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CreateContactForm({
  t,
  tenantId,
  onCancel,
  onCreated,
}: {
  t: Translate;
  tenantId: string;
  onCancel: () => void;
  onCreated: (contact: ContactResponse) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return setError(t("contacts.nameRequired"));
    const trimmedEmail = email.trim();
    if (trimmedEmail && !EMAIL_PATTERN.test(trimmedEmail))
      return setError(t("auth.emailInvalid"));
    setError(null);
    setSubmitting(true);
    try {
      const parsedTags = parseTags(tags);
      const contact = await api.contacts.create(tenantId, {
        name: trimmedName,
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
        ...(parsedTags.length ? { tags: parsedTags } : {}),
      });
      onCreated(contact);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-5 rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="text-base font-semibold text-ink">{t("contacts.addTitle")}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("contacts.nameLabel")} *
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("contacts.namePlaceholder")}
            className={inputClassName}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("contacts.phoneLabel")}
          </span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("contacts.phonePlaceholder")}
            className={inputClassName}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("contacts.emailLabel")}
          </span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("contacts.emailPlaceholder")}
            className={inputClassName}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            {t("contacts.tagsLabel")}
          </span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("contacts.tagsPlaceholder")}
            className={inputClassName}
          />
          <span className="mt-1 block text-[11px] text-muted">
            {t("contacts.tagsHint")}
          </span>
        </label>
      </div>
      <FieldError message={error} />
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {submitting ? t("contacts.creating") : t("contacts.createButton")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
        >
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

function ContactDetailModal({
  t,
  tenantId,
  contact,
  fieldDefinitions,
  onClose,
  onUpdated,
  onOpenConversation,
}: {
  t: Translate;
  tenantId: string;
  contact: ContactResponse;
  fieldDefinitions: ContactFieldDefinitionResponse[];
  onClose: () => void;
  onUpdated: (contact: ContactResponse) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [name, setName] = useState(contact.name);
  const [tags, setTags] = useState(contact.tags.join(", "));
  const [stage, setStage] = useState(contact.pipelineStage);
  const [optIn, setOptIn] = useState<OptInStatus>(contact.optInStatus);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Percakapan milik kontak (dimuat sekali saat panel dibuka).
  const [conversations, setConversations] = useState<
    ContactConversation[] | null
  >(null);
  const [conversationsError, setConversationsError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await api.contacts.conversations(tenantId, contact.id);
        if (!cancelled) setConversations(body.conversations);
      } catch {
        if (!cancelled) setConversationsError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, contact.id]);

  // Catatan LEVEL KONTAK (G8) — keluarga terpisah dari catatan
  // percakapan di Inbox; dimuat sekali saat panel dibuka, ditambah &
  // dihapus di tempat (aturan hapus ditegakkan server).
  const [contactNotes, setContactNotes] = useState<
    ContactNoteResponse[] | null
  >(null);
  const [contactNotesError, setContactNotesError] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.contacts.listNotes(tenantId, contact.id);
        if (!cancelled) setContactNotes(rows);
      } catch {
        if (!cancelled) setContactNotesError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, contact.id]);

  const handleAddNote = async (e: FormEvent) => {
    e.preventDefault();
    const body = noteDraft.trim();
    if (!body) return;
    setNoteError(null);
    setNoteSaving(true);
    try {
      const created = await api.contacts.createNote(tenantId, contact.id, {
        body,
      });
      setContactNotes((prev) => [...(prev ?? []), created]);
      setNoteDraft("");
    } catch (err) {
      setNoteError(translateApiError(t, err));
    } finally {
      setNoteSaving(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    setNoteError(null);
    try {
      await api.contacts.deleteNote(tenantId, contact.id, noteId);
      setContactNotes((prev) =>
        (prev ?? []).filter((note) => note.id !== noteId),
      );
    } catch (err) {
      setNoteError(translateApiError(t, err));
    }
  };

  // Poin loyalitas (G18): saldo + level + buku besar terakhir dari
  // server; penyesuaian manual digerbang server (owner/admin) dan
  // diaudit — error peran tampil apa adanya.
  const [pointsView, setPointsView] = useState<ContactPointsResponse | null>(
    null,
  );
  const [pointsError, setPointsError] = useState(false);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustSaving, setAdjustSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await api.contacts.getContactPoints(tenantId, contact.id);
        if (!cancelled) setPointsView(body);
      } catch {
        if (!cancelled) setPointsError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, contact.id]);

  const handleAdjustPoints = async (e: FormEvent) => {
    e.preventDefault();
    const delta = Math.trunc(Number(adjustDelta));
    if (!Number.isFinite(delta) || delta === 0) return;
    setAdjustError(null);
    setAdjustSaving(true);
    try {
      const body = await api.contacts.adjustContactPoints(tenantId, contact.id, {
        points: delta,
        ...(adjustNote.trim() ? { note: adjustNote.trim() } : {}),
      });
      setPointsView(body);
      setAdjustDelta("");
      setAdjustNote("");
    } catch (err) {
      setAdjustError(translateApiError(t, err));
    } finally {
      setAdjustSaving(false);
    }
  };

  // Linimasa aktivitas (G8): perakitan baca-saja server; dimuat
  // sekali saat panel dibuka.
  const [timeline, setTimeline] = useState<{
    events: ContactTimelineEvent[];
    truncated: boolean;
  } | null>(null);
  const [timelineError, setTimelineError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await api.contacts.timeline(tenantId, contact.id);
        if (!cancelled) setTimeline(body);
      } catch {
        if (!cancelled) setTimelineError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, contact.id]);

  // Editor field kustom: pasangan kunci–nilai dari peta tersimpan.
  // Kunci asli diingat agar yang dihapus dari formulir bisa dikirim
  // sebagai penghapusan eksplisit (gabung API tidak bisa menghapus).
  const [cfRows, setCfRows] = useState<Array<{ key: string; value: string }>>(
    () =>
      Object.entries(contact.customFields).map(([key, value]) => ({
        key,
        value: String(value),
      })),
  );
  const originalCfKeys = useRef(Object.keys(contact.customFields));

  const stageOptions = (KNOWN_STAGES as readonly string[]).includes(stage)
    ? [...KNOWN_STAGES]
    : [stage, ...KNOWN_STAGES];

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return setError(t("contacts.nameRequired"));
    setError(null);
    setSaving(true);
    try {
      const customFields: Record<string, string> = {};
      for (const row of cfRows) {
        const key = row.key.trim();
        if (!key) continue;
        customFields[key] = row.value;
      }
      const customFieldsDelete = originalCfKeys.current.filter(
        (key) => !(key in customFields),
      );
      const updated = await api.contacts.update(tenantId, contact.id, {
        name: trimmedName,
        tags: parseTags(tags),
        pipelineStage: stage,
        optInStatus: optIn,
        customFields,
        ...(customFieldsDelete.length > 0 ? { customFieldsDelete } : {}),
      });
      onUpdated(updated);
      onClose();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
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
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={contact.name} imageUrl={contact.avatarUrl} />
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-ink">{t("contacts.detailTitle")}</h2>
              <p className="mt-0.5 text-sm text-muted">
                {[contact.phone, contact.email].filter(Boolean).join(" · ") || "—"}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                <span className="font-medium text-ink">
                  {t("contacts.platformsLabel")}:
                </span>
                <PlatformBadges
                  t={t}
                  platforms={contact.platforms}
                  showEmpty
                />
              </p>
              {contact.lastContactedAt ? (
                <p className="mt-1 text-[11px] text-muted">
                  <span className="font-medium text-ink">
                    {t("contacts.detail.lastContactedLabel")}:
                  </span>{" "}
                  {new Date(contact.lastContactedAt).toLocaleString()}
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        <form onSubmit={handleSave} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("contacts.nameLabel")} *
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClassName}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("contacts.tagsLabel")}
            </span>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t("contacts.tagsPlaceholder")}
              className={inputClassName}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {t("contacts.tagsHint")}
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("contacts.stageLabel")}
              </span>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                className={inputClassName}
              >
                {stageOptions.map((s) => (
                  <option key={s} value={s}>
                    {stageLabel(t, s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("contacts.optInLabel")}
              </span>
              <select
                value={optIn}
                onChange={(e) => setOptIn(e.target.value as OptInStatus)}
                className={inputClassName}
              >
                {OPT_IN_VALUES.map((s) => (
                  <option key={s} value={s}>
                    {optInLabel(t, s)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* Fase 13C: status EFEKTIF + jejak persetujuan — status
              inilah yang dipakai gerbang broadcast require_opt_in. */}
          <div className="rounded-lg bg-elevated/60 px-3 py-2 text-xs text-muted">
            <p>
              <span className="font-medium text-ink">
                {t("contacts.optInEffectiveLabel")}:
              </span>{" "}
              {effectiveOptInLabel(t, contact.optInEffectiveStatus)}
            </p>
            {contact.optInSource ? (
              <p className="mt-0.5">
                <span className="font-medium text-ink">
                  {t("contacts.optInSourceLabel")}:
                </span>{" "}
                {contact.optInSource === "keyword"
                  ? t("contacts.optInSourceKeyword")
                  : t("contacts.optInSourceManual")}
                {contact.optInAt
                  ? ` · ${t("contacts.optInAtLabel")}: ${new Date(contact.optInAt).toLocaleString()}`
                  : ""}
              </p>
            ) : null}
          </div>
          {/* Editor field kustom: pasangan kunci–nilai sederhana.
              Nilai tampil apa adanya; menghapus baris menghapus
              kuncinya saat disimpan (customFieldsDelete). */}
          <div>
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("contacts.detail.customFieldsTitle")}
            </span>
            {cfRows.length === 0 ? (
              <p className="text-xs text-muted">
                {t("contacts.detail.customFieldsEmpty")}
              </p>
            ) : (
              <div className="space-y-2">
                {cfRows.map((row, idx) => {
                  // G18: baris yang kuncinya punya definisi bertipe
                  // dirender dengan kontrol sesuai tipenya + label
                  // definisi; kunci bebas tetap pasangan teks biasa.
                  const def = fieldDefinitions.find(
                    (d) => d.key === row.key.trim(),
                  );
                  const setValue = (value: string) =>
                    setCfRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, value } : r)),
                    );
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        value={row.key}
                        onChange={(e) =>
                          setCfRows((prev) =>
                            prev.map((r, i) =>
                              i === idx ? { ...r, key: e.target.value } : r,
                            ),
                          )
                        }
                        placeholder={t("contacts.detail.customFieldKeyPlaceholder")}
                        aria-label={t("contacts.detail.customFieldKeyPlaceholder")}
                        className={`${inputClassName} min-w-0 flex-1`}
                      />
                      {def?.type === "select" ? (
                        <select
                          value={row.value}
                          onChange={(e) => setValue(e.target.value)}
                          aria-label={def.label}
                          className={`${inputClassName} min-w-0 flex-1`}
                        >
                          <option value="">—</option>
                          {def.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : def?.type === "boolean" ? (
                        <select
                          value={row.value}
                          onChange={(e) => setValue(e.target.value)}
                          aria-label={def.label}
                          className={`${inputClassName} min-w-0 flex-1`}
                        >
                          <option value="">—</option>
                          <option value="true">
                            {t("contacts.fields.booleanTrue")}
                          </option>
                          <option value="false">
                            {t("contacts.fields.booleanFalse")}
                          </option>
                        </select>
                      ) : (
                        <input
                          type={
                            def?.type === "date"
                              ? "date"
                              : def?.type === "number"
                                ? "number"
                                : "text"
                          }
                          value={row.value}
                          onChange={(e) => setValue(e.target.value)}
                          placeholder={t("contacts.detail.customFieldValuePlaceholder")}
                          aria-label={
                            def?.label ??
                            t("contacts.detail.customFieldValuePlaceholder")
                          }
                          className={`${inputClassName} min-w-0 flex-1`}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setCfRows((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="shrink-0 rounded-lg bg-elevated px-2 py-1.5 text-xs font-medium text-ink"
                      >
                        {t("contacts.detail.customFieldRemove")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Field terdefinisi yang belum ada di kontak ini bisa
                ditambahkan satu klik (kunci terisi dari definisi). */}
            {fieldDefinitions.filter(
              (d) => !cfRows.some((r) => r.key.trim() === d.key),
            ).length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {fieldDefinitions
                  .filter((d) => !cfRows.some((r) => r.key.trim() === d.key))
                  .map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() =>
                        setCfRows((prev) => [...prev, { key: d.key, value: "" }])
                      }
                      className="rounded-full bg-elevated px-2 py-1 text-[11px] font-medium text-ink"
                    >
                      + {d.label}
                      {d.required ? " *" : ""}
                    </button>
                  ))}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() =>
                setCfRows((prev) => [...prev, { key: "", value: "" }])
              }
              className="mt-2 text-xs font-medium text-accent"
            >
              + {t("contacts.detail.customFieldAdd")}
            </button>
          </div>
          <FieldError message={error} />
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {saving ? t("contacts.saving") : t("contacts.saveChanges")}
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

        {/* Poin loyalitas (G18): saldo dari buku besar + level +
            penyesuaian manual (gerbang peran di server). */}
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink">
            {t("contacts.points.title")}
          </h3>
          {pointsError ? (
            <p className="mt-2 text-xs text-danger">
              {t("contacts.points.loadError")}
            </p>
          ) : pointsView === null ? (
            <p className="mt-2 text-xs text-muted">{t("common.loading")}</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink">
                <span className="text-lg font-bold">
                  {pointsView.balance}
                </span>{" "}
                {t("contacts.points.balanceLabel")}
                {pointsView.levelName ? (
                  <span className="ml-2 rounded bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                    {pointsView.levelName}
                  </span>
                ) : null}
              </p>
              {pointsView.nextLevel ? (
                <p className="mt-1 text-xs text-muted">
                  {t("contacts.points.nextLevel", {
                    name: pointsView.nextLevel.name,
                    needed: pointsView.nextLevel.pointsNeeded,
                  })}
                </p>
              ) : null}
              {pointsView.entries.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-muted">
                  {pointsView.entries.slice(0, 5).map((entry) => (
                    <li key={entry.id} className="flex justify-between gap-2">
                      <span className="truncate">
                        {entry.note ??
                          t(
                            entry.source === "manual"
                              ? "contacts.points.sourceManual"
                              : "contacts.points.sourceFlow",
                          )}{" "}
                        · {new Date(entry.createdAt).toLocaleDateString()}
                      </span>
                      <span
                        className={
                          entry.points > 0
                            ? "font-medium text-success"
                            : "font-medium text-danger"
                        }
                      >
                        {entry.points > 0 ? `+${entry.points}` : entry.points}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-muted">
                  {t("contacts.points.empty")}
                </p>
              )}
              <form
                onSubmit={handleAdjustPoints}
                className="mt-3 flex flex-wrap items-center gap-2"
              >
                <input
                  type="number"
                  className="w-24 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
                  placeholder={t("contacts.points.adjustPlaceholder")}
                  value={adjustDelta}
                  onChange={(e) => setAdjustDelta(e.target.value)}
                />
                <input
                  type="text"
                  maxLength={500}
                  className="min-w-40 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
                  placeholder={t("contacts.points.adjustNotePlaceholder")}
                  value={adjustNote}
                  onChange={(e) => setAdjustNote(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={adjustSaving || !adjustDelta}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                >
                  {t("contacts.points.adjustButton")}
                </button>
              </form>
              {adjustError ? (
                <p className="mt-1 text-xs text-danger">{adjustError}</p>
              ) : null}
            </>
          )}
        </div>

        {/* Percakapan milik kontak. Hanya percakapan PESAN
            (private/group) yang diberi tautan Inbox — baris channel
            adalah linimasa postingan dan Inbox menyaringnya keluar,
            jadi menautkannya akan menyesatkan. */}
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink">
            {t("contacts.detail.conversationsTitle")}
          </h3>
          {conversationsError ? (
            <p className="mt-2 text-xs text-danger">
              {t("contacts.detail.conversationsLoadError")}
            </p>
          ) : conversations === null ? (
            <p className="mt-2 text-xs text-muted">{t("common.loading")}</p>
          ) : conversations.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              {t("contacts.detail.conversationsEmpty")}
            </p>
          ) : (
            <>
              <ul className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line">
                {conversations.map((conv) => (
                  <li
                    key={conv.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">
                        {conv.title ?? contact.name}
                      </span>
                      <span className="block text-xs text-muted">
                        {t(`inbox.providers.${conv.provider}` as TranslationKey)}
                        {" · "}
                        {conv.kind === "private"
                          ? t("contacts.detail.kindPrivate")
                          : conv.kind === "group"
                            ? t("contacts.detail.kindGroup")
                            : t("contacts.detail.kindChannel")}
                        {conv.lastMessageAt
                          ? ` · ${new Date(conv.lastMessageAt).toLocaleString()}`
                          : ""}
                      </span>
                    </span>
                    {conv.kind !== "channel" ? (
                      <button
                        type="button"
                        onClick={() => onOpenConversation(conv.id)}
                        className="shrink-0 rounded-lg bg-elevated px-2 py-1.5 text-xs font-semibold text-ink"
                      >
                        {t("contacts.detail.openInInbox")}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {conversations.some((conv) => conv.kind === "channel") ? (
                <p className="mt-2 text-[11px] text-muted">
                  {t("contacts.detail.channelNote")}
                </p>
              ) : null}
            </>
          )}
        </div>

        {/* Catatan LEVEL KONTAK (G8): ingatan tim tentang kontak ini
            sebagai orang — terpisah dari catatan percakapan di Inbox
            (yang menempel pada satu utas), dan daftarnya tidak pernah
            dicampur dengan daftar itu. */}
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink">
            {t("contacts.notes.title")}
          </h3>
          <p className="mt-1 text-[11px] text-muted">
            {t("contacts.notes.hint")}
          </p>
          {contactNotesError ? (
            <p className="mt-2 text-xs text-danger">
              {t("contacts.notes.loadError")}
            </p>
          ) : contactNotes === null ? (
            <p className="mt-2 text-xs text-muted">{t("common.loading")}</p>
          ) : contactNotes.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              {t("contacts.notes.empty")}
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {contactNotes.map((note) => (
                <li
                  key={note.id}
                  className="rounded-lg border border-line px-3 py-2"
                >
                  <p className="whitespace-pre-wrap text-sm text-ink">
                    {note.body}
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                    <span>
                      {note.authorName ?? t("contacts.notes.formerMember")}
                      {" · "}
                      {new Date(note.createdAt).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleDeleteNote(note.id)}
                      className="font-medium text-danger"
                    >
                      {t("contacts.notes.deleteButton")}
                    </button>
                  </p>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={handleAddNote} className="mt-3">
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={t("contacts.notes.placeholder")}
              rows={2}
              className={`${inputClassName} w-full`}
            />
            <FieldError message={noteError} />
            <button
              type="submit"
              disabled={noteSaving || !noteDraft.trim()}
              className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
            >
              {noteSaving
                ? t("contacts.notes.adding")
                : t("contacts.notes.addButton")}
            </button>
          </form>
        </div>

        {/* Linimasa aktivitas (G8): peristiwa yang DIRAKIT server dari
            data yang sudah tercatat — bukan log baru. Jenis yang
            sumbernya tidak tercatat (mis. perubahan tahap/tag) memang
            tidak tampil, bukan dikarang. */}
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink">
            {t("contacts.timeline.title")}
          </h3>
          {timelineError ? (
            <p className="mt-2 text-xs text-danger">
              {t("contacts.timeline.loadError")}
            </p>
          ) : timeline === null ? (
            <p className="mt-2 text-xs text-muted">{t("common.loading")}</p>
          ) : timeline.events.length <= 1 ? (
            <p className="mt-2 text-xs text-muted">
              {t("contacts.timeline.empty")}
            </p>
          ) : (
            <>
              <ul className="mt-2 space-y-2">
                {timeline.events.map((event, idx) => {
                  const detail = timelineEventDetail(t, event);
                  return (
                    <li
                      key={`${event.kind}-${event.occurredAt}-${idx}`}
                      className="flex gap-3 text-sm"
                    >
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">
                          {t(TIMELINE_KIND_KEYS[event.kind])}
                        </span>
                        {detail ? (
                          <span className="block truncate text-xs text-muted">
                            {detail}
                          </span>
                        ) : null}
                        <span className="block text-[11px] text-muted">
                          {new Date(event.occurredAt).toLocaleString()}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {timeline.truncated ? (
                <p className="mt-2 text-[11px] text-muted">
                  {t("contacts.timeline.truncatedNote", {
                    count: timeline.events.length,
                  })}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pengelola segmen (Fase 13C): daftar segmen + pembuat kondisi sederhana.
// Keanggotaan tidak pernah disimpan — pratinjau hitungan memanggil
// evaluator server yang sama seperti filter daftar & broadcast.
// ---------------------------------------------------------------------------

const CONDITION_TYPES: SegmentCondition["type"][] = [
  "tag",
  "stage",
  "source_prefix",
  "opt_in_status",
  "custom_field",
  "created_within_days",
  "last_active_within_days",
  "has_channel",
];

function conditionTypeLabel(
  t: Translate,
  type: SegmentCondition["type"],
): string {
  const keys: Record<SegmentCondition["type"], TranslationKey> = {
    tag: "contacts.segments.conditionTag",
    stage: "contacts.segments.conditionStage",
    source_prefix: "contacts.segments.conditionSourcePrefix",
    opt_in_status: "contacts.segments.conditionOptInStatus",
    custom_field: "contacts.segments.conditionCustomField",
    created_within_days: "contacts.segments.conditionCreatedWithin",
    last_active_within_days: "contacts.segments.conditionLastActiveWithin",
    has_channel: "contacts.segments.conditionHasChannel",
  };
  return t(keys[type]);
}

function defaultCondition(
  type: SegmentCondition["type"],
): SegmentCondition {
  switch (type) {
    case "tag":
      return { type, tag: "" };
    case "stage":
      return { type, stage: "new" };
    case "source_prefix":
      return { type, prefix: "growth:" };
    case "opt_in_status":
      return { type, status: "opted_in" };
    case "custom_field":
      return { type, key: "", op: "eq", value: "" };
    case "created_within_days":
      return { type, days: 30 };
    case "last_active_within_days":
      return { type, days: 30 };
    case "has_channel":
      return { type, provider: "whatsapp" };
  }
}

function conditionValid(condition: SegmentCondition): boolean {
  switch (condition.type) {
    case "tag":
      return condition.tag.trim().length > 0;
    case "stage":
      return condition.stage.trim().length > 0;
    case "source_prefix":
      return condition.prefix.trim().length > 0;
    case "opt_in_status":
      return true;
    case "custom_field":
      return condition.key.trim().length > 0;
    case "created_within_days":
    case "last_active_within_days":
      return (
        Number.isInteger(condition.days) &&
        condition.days >= 1 &&
        condition.days <= 3650
      );
    case "has_channel":
      return true;
  }
}

interface SegmentDraft {
  id: string | null;
  name: string;
  match: "all" | "any";
  conditions: SegmentCondition[];
}

function SegmentsManager({
  t,
  tenantId,
  segments,
  canManage,
  onChanged,
}: {
  t: Translate;
  tenantId: string;
  segments: SegmentResponse[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<SegmentDraft | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const previewSeq = useRef(0);

  const draftValid =
    draft !== null &&
    draft.name.trim().length > 0 &&
    draft.conditions.length > 0 &&
    draft.conditions.every(conditionValid);

  // Pratinjau hitungan langsung (debounce) untuk definisi draf.
  useEffect(() => {
    if (!draft || !draftValid) {
      setPreviewCount(null);
      return;
    }
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      api.segments
        .preview(tenantId, {
          match: draft.match,
          conditions: draft.conditions,
        } satisfies SegmentDefinition)
        .then((res) => {
          if (previewSeq.current === seq) setPreviewCount(res.count);
        })
        .catch(() => {
          if (previewSeq.current === seq) setPreviewCount(null);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, draftValid, tenantId]);

  const openCreate = () =>
    setDraft({
      id: null,
      name: "",
      match: "all",
      conditions: [defaultCondition("tag")],
    });

  const openEdit = (segment: SegmentResponse) =>
    setDraft({
      id: segment.id,
      name: segment.name,
      match: segment.definition.match,
      conditions: segment.definition.conditions.map((c) => ({ ...c })),
    });

  const save = async () => {
    if (!draft || !draftValid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const definition: SegmentDefinition = {
        match: draft.match,
        conditions: draft.conditions,
      };
      if (draft.id) {
        await api.segments.update(tenantId, draft.id, {
          name: draft.name.trim(),
          definition,
        });
      } else {
        await api.segments.create(tenantId, {
          name: draft.name.trim(),
          definition,
        });
      }
      setDraft(null);
      onChanged();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (segment: SegmentResponse) => {
    if (confirmDeleteId !== segment.id) {
      setConfirmDeleteId(segment.id);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await api.segments.remove(tenantId, segment.id);
      onChanged();
    } catch (err) {
      setError(translateApiError(t, err));
    }
  };

  const patchCondition = (index: number, next: SegmentCondition) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            conditions: prev.conditions.map((c, i) =>
              i === index ? next : c,
            ),
          }
        : prev,
    );
  };

  return (
    <div className="mt-5 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {t("contacts.segments.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted">
            {t("contacts.segments.subtitle")}
          </p>
        </div>
        {canManage && !draft ? (
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white"
          >
            {t("contacts.segments.addButton")}
          </button>
        ) : null}
      </div>

      {segments.length === 0 && !draft ? (
        <p className="mt-3 text-sm text-muted">{t("contacts.segments.empty")}</p>
      ) : null}

      {segments.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {segments.map((segment) => (
            <li
              key={segment.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-elevated/40 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">
                  {segment.name}
                </span>
                <span className="block text-xs text-muted">
                  {segment.definition.match === "all"
                    ? t("contacts.segments.matchAll")
                    : t("contacts.segments.matchAny")}
                  {" · "}
                  {segment.definition.conditions
                    .map((c) => conditionTypeLabel(t, c.type))
                    .join(", ")}
                </span>
              </span>
              {canManage ? (
                <>
                  <button
                    type="button"
                    onClick={() => openEdit(segment)}
                    className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-semibold text-ink"
                  >
                    {t("contacts.segments.editButton")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(segment)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                      confirmDeleteId === segment.id
                        ? "bg-danger text-white"
                        : "bg-elevated text-ink"
                    }`}
                  >
                    {confirmDeleteId === segment.id
                      ? t("contacts.segments.confirmDelete")
                      : t("contacts.segments.deleteButton")}
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {draft ? (
        <div className="mt-4 rounded-lg border border-line p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("contacts.segments.nameLabel")}
              </span>
              <input
                value={draft.name}
                onChange={(e) =>
                  setDraft({ ...draft, name: e.target.value })
                }
                placeholder={t("contacts.segments.namePlaceholder")}
                className={inputClassName}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("contacts.segments.matchLabel")}
              </span>
              <select
                value={draft.match}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    match: e.target.value as "all" | "any",
                  })
                }
                className={inputClassName}
              >
                <option value="all">{t("contacts.segments.matchAll")}</option>
                <option value="any">{t("contacts.segments.matchAny")}</option>
              </select>
            </label>
          </div>

          <div className="mt-3 space-y-2">
            {draft.conditions.map((condition, index) => (
              <div
                key={index}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-elevated/50 p-2"
              >
                <select
                  value={condition.type}
                  onChange={(e) =>
                    patchCondition(
                      index,
                      defaultCondition(
                        e.target.value as SegmentCondition["type"],
                      ),
                    )
                  }
                  className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                >
                  {CONDITION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {conditionTypeLabel(t, type)}
                    </option>
                  ))}
                </select>
                <SegmentConditionValueInputs
                  t={t}
                  condition={condition}
                  onChange={(next) => patchCondition(index, next)}
                />
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      conditions: draft.conditions.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                  className="rounded-lg bg-surface px-2 py-1.5 text-xs font-medium text-ink"
                >
                  {t("contacts.segments.removeCondition")}
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  conditions: [
                    ...draft.conditions,
                    defaultCondition("tag"),
                  ],
                })
              }
              className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-semibold text-ink"
            >
              {t("contacts.segments.addCondition")}
            </button>
            <span className="text-xs text-muted">
              {previewCount !== null
                ? t("contacts.segments.memberCount", { count: previewCount })
                : ""}
            </span>
          </div>

          <FieldError message={error} />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!draftValid || saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {t("contacts.segments.saveButton")}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SegmentConditionValueInputs({
  t,
  condition,
  onChange,
}: {
  t: Translate;
  condition: SegmentCondition;
  onChange: (next: SegmentCondition) => void;
}) {
  const smallInput =
    "rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink";
  switch (condition.type) {
    case "tag":
      return (
        <input
          value={condition.tag}
          onChange={(e) => onChange({ ...condition, tag: e.target.value })}
          placeholder={t("contacts.segments.valuePlaceholder")}
          className={smallInput}
        />
      );
    case "stage": {
      const options = (KNOWN_STAGES as readonly string[]).includes(
        condition.stage,
      )
        ? [...KNOWN_STAGES]
        : [condition.stage, ...KNOWN_STAGES];
      return (
        <select
          value={condition.stage}
          onChange={(e) => onChange({ ...condition, stage: e.target.value })}
          className={smallInput}
        >
          {options.map((stage) => (
            <option key={stage} value={stage}>
              {stageLabel(t, stage)}
            </option>
          ))}
        </select>
      );
    }
    case "source_prefix":
      return (
        <input
          value={condition.prefix}
          onChange={(e) => onChange({ ...condition, prefix: e.target.value })}
          placeholder={t("contacts.segments.valuePlaceholder")}
          className={smallInput}
        />
      );
    case "opt_in_status":
      return (
        <select
          value={condition.status}
          onChange={(e) =>
            onChange({
              ...condition,
              status: e.target.value as EffectiveOptInStatus,
            })
          }
          className={smallInput}
        >
          {(["opted_in", "none", "opted_out"] as EffectiveOptInStatus[]).map(
            (status) => (
              <option key={status} value={status}>
                {effectiveOptInLabel(t, status)}
              </option>
            ),
          )}
        </select>
      );
    case "custom_field":
      return (
        <>
          <input
            value={condition.key}
            onChange={(e) => onChange({ ...condition, key: e.target.value })}
            placeholder={t("contacts.segments.keyPlaceholder")}
            className={smallInput}
          />
          <select
            value={condition.op}
            onChange={(e) =>
              onChange({
                ...condition,
                op: e.target.value as "eq" | "contains",
              })
            }
            className={smallInput}
          >
            <option value="eq">{t("contacts.segments.opEq")}</option>
            <option value="contains">
              {t("contacts.segments.opContains")}
            </option>
          </select>
          <input
            value={condition.value}
            onChange={(e) =>
              onChange({ ...condition, value: e.target.value })
            }
            placeholder={t("contacts.segments.valuePlaceholder")}
            className={smallInput}
          />
        </>
      );
    case "created_within_days":
    case "last_active_within_days":
      return (
        <input
          type="number"
          min={1}
          max={3650}
          value={condition.days}
          onChange={(e) =>
            onChange({
              ...condition,
              days: Number.parseInt(e.target.value, 10) || 0,
            })
          }
          placeholder={t("contacts.segments.daysPlaceholder")}
          className={`${smallInput} w-24`}
        />
      );
    case "has_channel":
      return (
        <select
          value={condition.provider}
          onChange={(e) =>
            onChange({
              ...condition,
              provider: e.target.value as (typeof PROVIDER_VALUES)[number],
            })
          }
          className={smallInput}
        >
          {PROVIDER_VALUES.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
      );
  }
}

/**
 * Pengelola definisi field kustom bertipe (G18 butir 1). Definisi
 * mengatur validasi penulisan nilai kontak (API + impor CSV) dan
 * kontrol editor; menghapus definisi TIDAK menghapus nilai yang
 * sudah tersimpan di kontak — nilai itu menjadi field bebas lagi.
 * Kunci tidak bisa diubah sesudah dibuat (ia identitas field di
 * peta nilai semua kontak).
 */
function FieldDefinitionsModal({
  t,
  tenantId,
  definitions,
  onClose,
  onChanged,
}: {
  t: Translate;
  tenantId: string;
  definitions: ContactFieldDefinitionResponse[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<ContactFieldType>("text");
  const [optionsText, setOptionsText] = useState("");
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setKey("");
    setLabel("");
    setType("text");
    setOptionsText("");
    setRequired(false);
    setError(null);
  };

  const startEdit = (def: ContactFieldDefinitionResponse) => {
    setEditingId(def.id);
    setKey(def.key);
    setLabel(def.label);
    setType(def.type);
    setOptionsText(def.options.join("\n"));
    setRequired(def.required);
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const options = optionsText
      .split("\n")
      .map((o) => o.trim())
      .filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await api.contacts.updateFieldDefinition(tenantId, editingId, {
          label: label.trim(),
          type,
          ...(type === "select" ? { options } : {}),
          required,
        });
      } else {
        await api.contacts.createFieldDefinition(tenantId, {
          key: key.trim(),
          label: label.trim(),
          type,
          ...(type === "select" ? { options } : {}),
          required,
        });
      }
      resetForm();
      onChanged();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (definitionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.contacts.deleteFieldDefinition(tenantId, definitionId);
      setConfirmDeleteId(null);
      if (editingId === definitionId) resetForm();
      onChanged();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const typeLabel = (value: ContactFieldType): string =>
    t(`contacts.fields.types.${value}` as TranslationKey);

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
              {t("contacts.fields.title")}
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              {t("contacts.fields.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>

        {definitions.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t("contacts.fields.empty")}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {definitions.map((def) => (
              <li
                key={def.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-elevated/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {def.label}{" "}
                    <span className="text-xs text-muted">({def.key})</span>
                  </p>
                  <p className="text-xs text-muted">
                    {typeLabel(def.type)}
                    {def.type === "select"
                      ? ` · ${def.options.join(", ")}`
                      : ""}
                    {def.required ? ` · ${t("contacts.fields.requiredBadge")}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(def)}
                    className="rounded-lg bg-surface px-2 py-1 text-xs font-medium text-ink"
                  >
                    {t("common.edit")}
                  </button>
                  {confirmDeleteId === def.id ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleDelete(def.id)}
                      className="rounded-lg bg-danger px-2 py-1 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      {t("contacts.fields.confirmDelete")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(def.id)}
                      className="rounded-lg bg-surface px-2 py-1 text-xs font-medium text-danger"
                    >
                      {t("common.delete")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-3 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink">
            {editingId
              ? t("contacts.fields.editTitle")
              : t("contacts.fields.createTitle")}
          </h3>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("contacts.fields.keyLabel")}
            </span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={editingId !== null}
              required
              maxLength={64}
              className={`${inputClassName} w-full disabled:opacity-60`}
            />
            {editingId ? (
              <span className="mt-1 block text-[11px] text-muted">
                {t("contacts.fields.keyImmutableHint")}
              </span>
            ) : null}
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("contacts.fields.labelLabel")}
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              maxLength={100}
              className={`${inputClassName} w-full`}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("contacts.fields.typeLabel")}
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as ContactFieldType)}
              className={`${inputClassName} w-full`}
            >
              {(["text", "number", "date", "select", "boolean"] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {typeLabel(value)}
                  </option>
                ),
              )}
            </select>
          </label>
          {type === "select" ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                {t("contacts.fields.optionsLabel")}
              </span>
              <textarea
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                required
                rows={4}
                className={`${inputClassName} w-full`}
              />
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            {t("contacts.fields.requiredLabel")}
          </label>
          <FieldError message={error} />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {editingId
                ? t("contacts.saveChanges")
                : t("contacts.fields.createButton")}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={resetForm}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
              >
                {t("common.cancel")}
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Pindai Pelanggan Otomatis (G18 butir 2). Pindai berjalan di latar
 * (worker): modal ini meminta pindai, memantau statusnya, lalu
 * menyajikan kandidat untuk DITINJAU — impor hanya terjadi atas
 * pilihan eksplisit di sini dan hanya untuk kandidat "pending".
 * Kandidat yang sudah menjadi kontak / akun kanal sendiri tampil
 * dengan statusnya dan tidak bisa dipilih.
 */
function ContactScanModal({
  t,
  locale,
  tenantId,
  onClose,
  onImported,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [scans, setScans] = useState<ContactScanRunResponse[]>([]);
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ContactScanCandidateResponse[]>(
    [],
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);

  const selectedScan =
    scans.find((s) => s.id === selectedScanId) ?? scans[0] ?? null;

  const loadScans = useCallback(async () => {
    try {
      const rows = await api.contacts.listScans(tenantId);
      setScans(rows);
      return rows;
    } catch {
      setScans([]);
      return [];
    }
  }, [tenantId]);

  const loadDetail = useCallback(
    async (scanId: string) => {
      try {
        const detail = await api.contacts.getScan(tenantId, scanId);
        setCandidates(detail.candidates);
        setScans((prev) =>
          prev.map((s) => (s.id === scanId ? detail.scan : s)),
        );
        return detail.scan;
      } catch {
        return null;
      }
    },
    [tenantId],
  );

  useEffect(() => {
    void (async () => {
      const rows = await loadScans();
      if (rows[0]) {
        setSelectedScanId(rows[0].id);
        await loadDetail(rows[0].id);
      }
    })();
  }, [loadScans, loadDetail]);

  // Pantau pindai yang sedang berjalan sampai selesai/gagal.
  useEffect(() => {
    if (!selectedScan) return;
    if (selectedScan.status !== "queued" && selectedScan.status !== "running") {
      return;
    }
    const timer = setInterval(() => {
      void (async () => {
        const scan = await loadDetail(selectedScan.id);
        if (scan && scan.status !== "queued" && scan.status !== "running") {
          await loadScans();
        }
      })();
    }, 2500);
    return () => clearInterval(timer);
  }, [selectedScan, loadDetail, loadScans]);

  const startScan = async () => {
    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const run = await api.contacts.createScan(tenantId);
      setSelectedScanId(run.id);
      setCandidates([]);
      setChecked(new Set());
      await loadScans();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const selectScan = (scanId: string) => {
    setSelectedScanId(scanId);
    setChecked(new Set());
    setImportResult(null);
    void loadDetail(scanId);
  };

  const runImport = async (candidateIds?: string[]) => {
    if (!selectedScan) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.contacts.importScan(
        tenantId,
        selectedScan.id,
        candidateIds,
      );
      setImportResult(
        t("contacts.scan.importResult", {
          imported: formatNumber(result.imported, locale),
          skipped: formatNumber(result.skippedExisting, locale),
        }),
      );
      setChecked(new Set());
      await loadDetail(selectedScan.id);
      if (result.imported > 0) onImported();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const pendingCount = candidates.filter((k) => k.status === "pending").length;
  const statusLabel = (status: ContactScanCandidateResponse["status"]) =>
    t(`contacts.scan.candidateStatus.${status}` as TranslationKey);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-ink">
              {t("contacts.scan.title")}
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              {t("contacts.scan.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void startScan()}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {t("contacts.scan.startButton")}
          </button>
          {scans.length > 0 ? (
            <select
              value={selectedScan?.id ?? ""}
              onChange={(e) => selectScan(e.target.value)}
              className={`${inputClassName} w-auto`}
              aria-label={t("contacts.scan.historyLabel")}
            >
              {scans.map((scan) => (
                <option key={scan.id} value={scan.id}>
                  {new Date(scan.createdAt).toLocaleString()} —{" "}
                  {t(`contacts.scan.runStatus.${scan.status}` as TranslationKey)}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {selectedScan ? (
          <p className="mt-3 text-sm text-muted">
            {selectedScan.status === "completed"
              ? t("contacts.scan.statsLine", {
                  comments: formatNumber(selectedScan.stats.commentsSeen, locale),
                  pending: formatNumber(selectedScan.stats.pending, locale),
                  already: formatNumber(selectedScan.stats.alreadyContact, locale),
                  self: formatNumber(selectedScan.stats.selfAccount, locale),
                })
              : selectedScan.status === "failed"
                ? t("contacts.scan.failedLine")
                : t("contacts.scan.runningLine")}
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted">{t("contacts.scan.empty")}</p>
        )}

        {candidates.length > 0 ? (
          <>
            <ul className="mt-3 space-y-2">
              {candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  className="flex items-start gap-2 rounded-lg bg-elevated/60 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    disabled={candidate.status !== "pending"}
                    checked={checked.has(candidate.id)}
                    onChange={(e) =>
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(candidate.id);
                        else next.delete(candidate.id);
                        return next;
                      })
                    }
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {candidate.displayName ?? candidate.externalUserId}{" "}
                      <span className="text-xs text-muted">
                        · {candidate.provider} ·{" "}
                        {t("contacts.scan.commentCount", {
                          count: formatNumber(candidate.commentCount, locale),
                        })}
                      </span>
                    </p>
                    {candidate.sampleText ? (
                      <p className="truncate text-xs text-muted">
                        “{candidate.sampleText}”
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-ink">
                    {statusLabel(candidate.status)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || checked.size === 0}
                onClick={() => void runImport([...checked])}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {t("contacts.scan.importSelected", { count: checked.size })}
              </button>
              <button
                type="button"
                disabled={busy || pendingCount === 0}
                onClick={() => void runImport(undefined)}
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
              >
                {t("contacts.scan.importAll", { count: pendingCount })}
              </button>
            </div>
          </>
        ) : null}

        {importResult ? (
          <p className="mt-3 text-sm text-ink">{importResult}</p>
        ) : null}
        <FieldError message={error} />
      </div>
    </div>
  );
}

/**
 * Papan peringkat poin + pengelolaan level loyalitas (G18 butir 4).
 * Peringkat dihitung server dari buku besar poin; level diatur
 * tenant (tulis digerbang server owner/admin — error tampil apa
 * adanya).
 */
function LeaderboardModal({
  t,
  tenantId,
  onClose,
}: {
  t: Translate;
  tenantId: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [levels, setLevels] = useState<LoyaltyLevel[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [levelName, setLevelName] = useState("");
  const [levelMin, setLevelMin] = useState("");
  const [levelError, setLevelError] = useState<string | null>(null);
  const [levelSaving, setLevelSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [board, lv] = await Promise.all([
        api.contacts.leaderboard(tenantId),
        api.contacts.listLoyaltyLevels(tenantId),
      ]);
      setEntries(board);
      setLevels(lv);
    } catch {
      setLoadError(true);
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleAddLevel = async (e: FormEvent) => {
    e.preventDefault();
    const min = Math.trunc(Number(levelMin));
    if (!levelName.trim() || !Number.isFinite(min) || min < 0) return;
    setLevelError(null);
    setLevelSaving(true);
    try {
      await api.contacts.createLoyaltyLevel(tenantId, {
        name: levelName.trim(),
        minPoints: min,
      });
      setLevelName("");
      setLevelMin("");
      await reload();
    } catch (err) {
      setLevelError(translateApiError(t, err));
    } finally {
      setLevelSaving(false);
    }
  };

  const handleDeleteLevel = async (levelId: string) => {
    setLevelError(null);
    try {
      await api.contacts.deleteLoyaltyLevel(tenantId, levelId);
      await reload();
    } catch (err) {
      setLevelError(translateApiError(t, err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="w-full max-w-xl rounded-2xl bg-surface p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-ink">
              {t("contacts.leaderboard.title")}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {t("contacts.leaderboard.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink"
          >
            {t("common.close")}
          </button>
        </div>

        {loadError ? (
          <p className="mt-4 text-sm text-danger">
            {t("contacts.leaderboard.loadError")}
          </p>
        ) : entries === null ? (
          <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
        ) : entries.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            {t("contacts.leaderboard.empty")}
          </p>
        ) : (
          <ol className="mt-4 divide-y divide-line overflow-hidden rounded-lg border border-line">
            {entries.map((entry, i) => (
              <li
                key={entry.contactId}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <span className="w-6 text-center font-bold text-muted">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {entry.contactName}
                </span>
                {entry.levelName ? (
                  <span className="rounded bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                    {entry.levelName}
                  </span>
                ) : null}
                <span className="font-bold text-ink">{entry.balance}</span>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink">
            {t("contacts.leaderboard.levelsTitle")}
          </h3>
          {levels === null ? (
            <p className="mt-2 text-xs text-muted">{t("common.loading")}</p>
          ) : levels.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              {t("contacts.leaderboard.levelsEmpty")}
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {levels.map((level) => (
                <li
                  key={level.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-ink">
                    {level.name}{" "}
                    <span className="text-xs text-muted">
                      {t("contacts.leaderboard.levelMin", {
                        points: level.minPoints,
                      })}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="text-xs text-danger"
                    onClick={() => void handleDeleteLevel(level.id)}
                  >
                    {t("contacts.leaderboard.levelDelete")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            onSubmit={handleAddLevel}
            className="mt-3 flex flex-wrap items-center gap-2"
          >
            <input
              type="text"
              maxLength={64}
              className="min-w-32 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
              placeholder={t("contacts.leaderboard.levelNamePlaceholder")}
              value={levelName}
              onChange={(e) => setLevelName(e.target.value)}
            />
            <input
              type="number"
              min={0}
              className="w-28 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
              placeholder={t("contacts.leaderboard.levelMinPlaceholder")}
              value={levelMin}
              onChange={(e) => setLevelMin(e.target.value)}
            />
            <button
              type="submit"
              disabled={levelSaving || !levelName.trim() || !levelMin}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {t("contacts.leaderboard.levelAdd")}
            </button>
          </form>
          {levelError ? (
            <p className="mt-1 text-xs text-danger">{levelError}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
