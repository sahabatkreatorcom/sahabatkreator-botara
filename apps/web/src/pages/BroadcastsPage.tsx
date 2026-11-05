import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BroadcastAbResultsResponse,
  BroadcastAudienceFilter,
  BroadcastAudiencePreviewResponse,
  BroadcastRecipientResponse,
  BroadcastResponse,
  BroadcastStatus,
  ChannelAccountResponse,
  ChannelProvider,
  CreateWhatsAppTemplateRequest,
  OptInSettingsResponse,
  SegmentResponse,
  WhatsAppTemplateResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { usePolling } from "../hooks/usePolling";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface BroadcastsPageProps {
  t: Translate;
  locale: Locale;
}

/** Nama brand provider = kata benda nama diri, sama di kedua bahasa. */
const PROVIDER_NAMES: Record<ChannelProvider, string> = {
  telegram: "Telegram",
  messenger: "Messenger",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  webchat: "Webchat",
};

const SUPPORTED_PROVIDERS: ReadonlySet<ChannelProvider> = new Set([
  "telegram",
  "messenger",
  "instagram",
  // Fase 10A: WhatsApp didukung lewat template resmi (pemilih template
  // di formulir); webchat tetap satu-satunya yang tidak didukung.
  "whatsapp",
]);

const STATUS_CHIP: Record<
  BroadcastStatus,
  { labelKey: TranslationKey; className: string }
> = {
  draft: {
    labelKey: "broadcasts.statusDraft",
    className: "bg-surface-2 text-muted",
  },
  scheduled: {
    labelKey: "broadcasts.statusScheduled",
    className: "bg-warning-soft text-warning",
  },
  sending: {
    labelKey: "broadcasts.statusSending",
    className: "bg-warning-soft text-warning",
  },
  completed: {
    labelKey: "broadcasts.statusCompleted",
    className: "bg-success-soft text-success",
  },
  partially_failed: {
    labelKey: "broadcasts.statusPartiallyFailed",
    className: "bg-warning-soft text-warning",
  },
  failed: {
    labelKey: "broadcasts.statusFailed",
    className: "bg-danger-soft text-danger",
  },
  cancelled: {
    labelKey: "broadcasts.statusCancelled",
    className: "bg-surface-2 text-muted",
  },
};

const RECIPIENT_STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  queued: "broadcasts.recipientStatusQueued",
  sent: "broadcasts.recipientStatusSent",
  delivered: "broadcasts.recipientStatusDelivered",
  read: "broadcasts.recipientStatusRead",
  failed: "broadcasts.recipientStatusFailed",
  skipped: "broadcasts.recipientStatusSkipped",
  cancelled: "broadcasts.recipientStatusCancelled",
};

const SKIP_REASON_LABEL_KEYS: Record<string, TranslationKey> = {
  opted_out: "broadcasts.skipReasonOptedOut",
  not_opted_in: "broadcasts.skipReasonNotOptedIn",
  outside_24h_window: "broadcasts.skipReasonOutside24h",
  message_deleted: "broadcasts.skipReasonMessageDeleted",
  template_variable_missing: "broadcasts.skipReasonTemplateVariableMissing",
  missing_phone_number: "broadcasts.skipReasonMissingPhone",
};

const DISPATCH_ERROR_LABEL_KEYS: Record<string, TranslationKey> = {
  CHANNEL_DISCONNECTED: "broadcasts.dispatchErrorCHANNEL_DISCONNECTED",
  AUDIENCE_EMPTY: "broadcasts.dispatchErrorAUDIENCE_EMPTY",
  CHANNEL_UNSUPPORTED: "broadcasts.dispatchErrorCHANNEL_UNSUPPORTED",
  BROADCAST_TEMPLATE_REQUIRED: "broadcasts.dispatchErrorBROADCAST_TEMPLATE_REQUIRED",
  BROADCAST_TEMPLATE_NOT_APPROVED:
    "broadcasts.dispatchErrorBROADCAST_TEMPLATE_NOT_APPROVED",
};

/** Chip status persetujuan template Meta (Fase 10A). */
function TemplateStatusChip({
  t,
  status,
}: {
  t: Translate;
  status: string;
}) {
  const known: Record<string, { labelKey: TranslationKey; className: string }> = {
    APPROVED: {
      labelKey: "whatsappTemplates.statusApproved",
      className: "bg-success-soft text-success",
    },
    PENDING: {
      labelKey: "whatsappTemplates.statusPending",
      className: "bg-warning-soft text-warning",
    },
    REJECTED: {
      labelKey: "whatsappTemplates.statusRejected",
      className: "bg-danger-soft text-danger",
    },
  };
  const chip = known[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip?.className ?? "bg-surface-2 text-muted"}`}
    >
      {chip ? t(chip.labelKey) : status}
    </span>
  );
}

function StatusChip({ t, status }: { t: Translate; status: BroadcastStatus }) {
  const chip = STATUS_CHIP[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip.className}`}
    >
      {t(chip.labelKey)}
    </span>
  );
}

function splitCommaList(raw: string): string[] | undefined {
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

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

      <OptInSettingsCard t={t} tenantId={tenantId} canManage={canManage} />

      <WhatsAppTemplatesSection
        t={t}
        tenantId={tenantId}
        canManage={canManage}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * Kartu "Opt-in Broadcast" (Fase 13C) di halaman Broadcasts:
 * pengaturan mesin opt-in per tenant — kata kunci opt-in, teks
 * konfirmasi (opsional), kata opt-out tambahan di atas kata bawaan
 * sistem (ditampilkan hanya-baca agar aturannya transparan).
 */
function OptInSettingsCard({
  t,
  tenantId,
  canManage,
}: {
  t: Translate;
  tenantId: string | null;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState<OptInSettingsResponse | null>(null);
  const [keywordsText, setKeywordsText] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const [extraOptOutText, setExtraOptOutText] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api.broadcasts
      .getOptInSettings(tenantId)
      .then((res) => {
        if (cancelled) return;
        setSettings(res);
        setKeywordsText(res.optInKeywords.join(", "));
        setConfirmationText(res.optInConfirmationText ?? "");
        setExtraOptOutText(res.optOutExtraKeywords.join(", "));
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const save = async () => {
    if (!tenantId || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await api.broadcasts.updateOptInSettings(tenantId, {
        optInKeywords: splitCommaList(keywordsText) ?? [],
        optInConfirmationText: confirmationText.trim()
          ? confirmationText.trim()
          : null,
        optOutExtraKeywords: splitCommaList(extraOptOutText) ?? [],
      });
      setSettings(res);
      setSaved(true);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink";
  const labelClass = "block text-sm font-medium text-ink";

  return (
    <div className="mt-8 rounded-xl border border-border bg-surface p-4">
      <h2 className="text-base font-semibold text-ink">
        {t("broadcasts.optInCard.title")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("broadcasts.optInCard.subtitle")}
      </p>
      {loadError ? (
        <p className="mt-3 text-sm text-danger">
          {t("broadcasts.optInCard.loadError")}
        </p>
      ) : !settings ? (
        <p className="mt-3 text-sm text-muted">{t("workspace.loading")}</p>
      ) : (
        <div className="mt-4 max-w-2xl space-y-4">
          <div>
            <label className={labelClass} htmlFor="optin-keywords">
              {t("broadcasts.optInCard.keywordsLabel")}
            </label>
            <input
              id="optin-keywords"
              className={inputClass}
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              disabled={!canManage}
            />
            <p className="mt-1 text-xs text-muted">
              {t("broadcasts.optInCard.keywordsHint")}
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="optin-confirmation">
              {t("broadcasts.optInCard.confirmationLabel")}
            </label>
            <input
              id="optin-confirmation"
              className={inputClass}
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
              placeholder={t("broadcasts.optInCard.confirmationPlaceholder")}
              maxLength={1000}
              disabled={!canManage}
            />
            <p className="mt-1 text-xs text-muted">
              {t("broadcasts.optInCard.confirmationHint")}
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="optin-extra-optout">
              {t("broadcasts.optInCard.extraOptOutLabel")}
            </label>
            <input
              id="optin-extra-optout"
              className={inputClass}
              value={extraOptOutText}
              onChange={(e) => setExtraOptOutText(e.target.value)}
              disabled={!canManage}
            />
            <p className="mt-1 text-xs text-muted">
              {t("broadcasts.optInCard.extraOptOutHint")}
            </p>
          </div>
          <div>
            <span className={labelClass}>
              {t("broadcasts.optInCard.defaultOptOutLabel")}
            </span>
            <div className="mt-1 flex flex-wrap gap-1">
              {settings.defaultOptOutKeywords.map((word) => (
                <span
                  key={word}
                  className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted"
                >
                  {word}
                </span>
              ))}
            </div>
          </div>
          {error ? (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          {canManage ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {t("broadcasts.optInCard.saveButton")}
              </button>
              {saved ? (
                <span className="text-sm text-muted">
                  {t("broadcasts.optInCard.saved")}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface BroadcastFormProps {
  t: Translate;
  tenantId: string | null;
  target: "create" | BroadcastResponse;
  onDone: () => void;
  onCancel: () => void;
}

function BroadcastForm({ t, tenantId, target, onDone, onCancel }: BroadcastFormProps) {
  const editing = target !== "create" ? target : null;
  const [channels, setChannels] = useState<ChannelAccountResponse[]>([]);
  const [name, setName] = useState(editing?.name ?? "");
  const [channelAccountId, setChannelAccountId] = useState(
    editing?.channelAccountId ?? "",
  );
  const [messageText, setMessageText] = useState(editing?.messageText ?? "");
  // Fase 10A: mode WhatsApp — template terpilih + sumber variabelnya.
  const [whatsappTemplateId, setWhatsappTemplateId] = useState(
    editing?.whatsappTemplateId ?? "",
  );
  const [variableSources, setVariableSources] = useState<string[]>(
    editing?.templateVariableSources ?? [],
  );
  const [waTemplates, setWaTemplates] = useState<WhatsAppTemplateResponse[]>([]);
  const [tagsText, setTagsText] = useState(
    editing?.audienceFilter.tags?.join(", ") ?? "",
  );
  const [stagesText, setStagesText] = useState(
    editing?.audienceFilter.stages?.join(", ") ?? "",
  );
  // Fase 13C: mode audiens (all | tag | segment) + segmen terpilih.
  // Mode awal diturunkan dari filter tersimpan seperti normalizeFilter
  // di core (baris lama tanpa `audience` tetap terbaca benar).
  const [audienceMode, setAudienceMode] = useState<"all" | "tag" | "segment">(
    () =>
      editing?.audienceFilter.audience ??
      (editing?.audienceFilter.segmentId
        ? "segment"
        : editing?.audienceFilter.tags?.length ||
            editing?.audienceFilter.stages?.length
          ? "tag"
          : "all"),
  );
  const [segmentId, setSegmentId] = useState(
    editing?.audienceFilter.segmentId ?? "",
  );
  const [segments, setSegments] = useState<SegmentResponse[]>([]);
  // Fase 13C: gerbang opt-in — null = ikuti bawaan server per provider
  // (WhatsApp menyala, selain itu mati); boolean = pilihan eksplisit.
  const [requireOptIn, setRequireOptIn] = useState<boolean | null>(
    editing ? editing.requireOptIn : null,
  );
  // Fase 13D: uji A/B — keadaan awal draft yang diedit dimuat dari
  // endpoint ab-results (konfigurasi varian SENGAJA tidak ikut di
  // BroadcastResponse agar permukaan v1 tetap bersih).
  const [abEnabled, setAbEnabled] = useState(false);
  const [abPercentB, setAbPercentB] = useState(50);
  const [variantBText, setVariantBText] = useState("");
  const [variantBTemplateId, setVariantBTemplateId] = useState("");
  const [variantBVariableSources, setVariantBVariableSources] = useState<
    string[]
  >([]);
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [scheduledAtLocal, setScheduledAtLocal] = useState("");
  const [preview, setPreview] =
    useState<BroadcastAudiencePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api.channels
      .list(tenantId)
      .then((list) => {
        if (cancelled) return;
        const usable = list;
        setChannels(usable);
        if (!editing) {
          const first = usable.find(
            (ch) =>
              SUPPORTED_PROVIDERS.has(ch.provider) && ch.status === "connected",
          );
          if (first) setChannelAccountId((prev) => prev || first.id);
        }
      })
      .catch(() => {
        if (!cancelled) setChannels([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Daftar segmen tenant untuk pemilih audiens mode segment (13C).
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api.segments
      .list(tenantId)
      .then((res) => {
        if (!cancelled) setSegments(res.segments);
      })
      .catch(() => {
        if (!cancelled) setSegments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const selectedChannel = channels.find((ch) => ch.id === channelAccountId);
  const isMeta =
    selectedChannel?.provider === "messenger" ||
    selectedChannel?.provider === "instagram";
  const isWhatsApp = selectedChannel?.provider === "whatsapp";
  const selectedTemplate = waTemplates.find((tpl) => tpl.id === whatsappTemplateId);
  const selectedTemplateB = waTemplates.find(
    (tpl) => tpl.id === variantBTemplateId,
  );

  // Prefill konfigurasi A/B untuk draft yang diedit (Fase 13D).
  useEffect(() => {
    if (!tenantId || !editing) return;
    let cancelled = false;
    api.broadcasts
      .abResults(tenantId, editing.id)
      .then((res) => {
        if (cancelled || !res.abTest) return;
        setAbEnabled(true);
        setAbPercentB(res.abTest.splitPercentB);
        setVariantBText(res.abTest.variantBMessageText ?? "");
        setVariantBTemplateId(res.abTest.variantBWhatsappTemplateId ?? "");
        setVariantBVariableSources(
          res.abTest.variantBTemplateVariableSources ?? [],
        );
      })
      .catch(() => {
        /* prefill gagal: formulir tetap bisa dipakai tanpa A/B */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, editing?.id]);

  // Muat cermin template setiap kali channel WhatsApp terpilih berubah.
  useEffect(() => {
    if (!tenantId || !isWhatsApp || !channelAccountId) {
      setWaTemplates([]);
      return;
    }
    let cancelled = false;
    api.whatsappTemplates
      .list(tenantId, channelAccountId)
      .then((res) => {
        if (!cancelled) setWaTemplates(res.templates);
      })
      .catch(() => {
        if (!cancelled) setWaTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, isWhatsApp, channelAccountId]);

  // Nilai gerbang opt-in EFEKTIF untuk pratinjau & tampilan checkbox:
  // pilihan eksplisit menang; tanpa pilihan, bawaan per provider
  // (WhatsApp menyala) — sama seperti bawaan server saat buat.
  const effectiveRequireOptIn = requireOptIn ?? isWhatsApp;

  // Pratinjau audiens live (debounce 400ms) mengikuti channel + filter.
  // Dihitung server dengan klasifikasi yang sama seperti dispatch.
  useEffect(() => {
    if (!tenantId || !channelAccountId) {
      setPreview(null);
      return;
    }
    if (audienceMode === "segment" && !segmentId) {
      setPreview(null);
      return;
    }
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      api.broadcasts
        .previewAudience(tenantId, {
          channelAccountId,
          tags:
            audienceMode === "tag"
              ? splitCommaList(tagsText)?.join(",")
              : undefined,
          stages:
            audienceMode === "tag"
              ? splitCommaList(stagesText)?.join(",")
              : undefined,
          segmentId: audienceMode === "segment" ? segmentId : undefined,
          requireOptIn: effectiveRequireOptIn,
          whatsappTemplateId: isWhatsApp
            ? whatsappTemplateId || undefined
            : undefined,
          templateVariableSources: isWhatsApp
            ? variableSources.join(",") || undefined
            : undefined,
        })
        .then((res) => {
          if (previewSeq.current === seq) setPreview(res);
        })
        .catch(() => {
          if (previewSeq.current === seq) setPreview(null);
        })
        .finally(() => {
          if (previewSeq.current === seq) setPreviewLoading(false);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [
    tenantId,
    channelAccountId,
    tagsText,
    stagesText,
    audienceMode,
    segmentId,
    effectiveRequireOptIn,
    isWhatsApp,
    whatsappTemplateId,
    variableSources,
  ]);

  const buildInput = () => {
    const audienceFilter: BroadcastAudienceFilter =
      audienceMode === "segment"
        ? { audience: "segment", segmentId: segmentId || undefined }
        : audienceMode === "tag"
          ? {
              audience: "tag",
              tags: splitCommaList(tagsText),
              stages: splitCommaList(stagesText),
            }
          : { audience: "all" };
    // Fase 13D: bidang A/B hanya dikirim saat menyala (bentuk buat);
    // jalur edit menambahkan null eksplisit saat mati (lihat save).
    const abInput = !abEnabled
      ? {}
      : isWhatsApp
        ? {
            abSplitPercentB: abPercentB,
            variantBWhatsappTemplateId: variantBTemplateId || undefined,
            variantBTemplateVariableSources: (() => {
              const countB = selectedTemplateB?.variableCount ?? 0;
              const sourcesB: string[] = [];
              for (let i = 0; i < countB; i++) {
                sourcesB.push((variantBVariableSources[i] ?? "").trim());
              }
              while (
                sourcesB.length > 0 &&
                sourcesB[sourcesB.length - 1] === ""
              ) {
                sourcesB.pop();
              }
              return sourcesB;
            })(),
          }
        : {
            abSplitPercentB: abPercentB,
            variantBMessageText: variantBText.trim(),
          };
    if (isWhatsApp) {
      // Sumber variabel per posisi; posisi kosong di tengah
      // dipertahankan (makna posisional), ekor kosong dipangkas.
      const count = selectedTemplate?.variableCount ?? 0;
      const sources: string[] = [];
      for (let i = 0; i < count; i++) {
        sources.push((variableSources[i] ?? "").trim());
      }
      while (sources.length > 0 && sources[sources.length - 1] === "") {
        sources.pop();
      }
      return {
        name: name.trim(),
        channelAccountId,
        whatsappTemplateId: whatsappTemplateId || undefined,
        templateVariableSources: sources,
        audienceFilter,
        ...(requireOptIn !== null ? { requireOptIn } : {}),
        ...abInput,
      };
    }
    return {
      name: name.trim(),
      channelAccountId,
      messageText: messageText.trim(),
      audienceFilter,
      ...(requireOptIn !== null ? { requireOptIn } : {}),
      ...abInput,
    };
  };

  const save = async (andSchedule: boolean) => {
    if (!tenantId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const input = buildInput();
      const saved = editing
        ? await api.broadcasts.update(tenantId, editing.id, {
            ...input,
            // Fase 13D: edit dengan A/B mati mengirim null eksplisit
            // agar konfigurasi varian tersimpan dibersihkan server.
            ...(abEnabled ? {} : { abSplitPercentB: null }),
          })
        : await api.broadcasts.create(tenantId, input);
      if (andSchedule) {
        await api.broadcasts.schedule(tenantId, saved.id, {
          scheduledAt:
            when === "schedule" && scheduledAtLocal
              ? new Date(scheduledAtLocal).toISOString()
              : undefined,
        });
      }
      onDone();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink";
  const labelClass = "block text-sm font-medium text-ink";
  // Mode WhatsApp: isi broadcast adalah template (bukan teks bebas).
  // Fase 13D: A/B menyala mewajibkan isi varian B yang lengkap juga.
  const abReady =
    !abEnabled ||
    (isWhatsApp ? !!variantBTemplateId : !!variantBText.trim());
  const contentReady =
    (isWhatsApp ? !!whatsappTemplateId : !!messageText.trim()) && abReady;
  // Mode segment tanpa segmen terpilih belum bisa disimpan (server
  // juga menolaknya sebagai segment_not_found).
  const audienceReady = audienceMode !== "segment" || !!segmentId;

  return (
    <section>
      <button
        type="button"
        onClick={onCancel}
        className="text-sm text-muted hover:text-ink"
      >
        ← {t("broadcasts.backToList")}
      </button>
      <h1 className="mt-2 text-2xl font-bold text-ink">
        {editing ? t("broadcasts.formEditTitle") : t("broadcasts.formCreateTitle")}
      </h1>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-6 max-w-2xl space-y-5">
        <div>
          <label className={labelClass} htmlFor="bc-name">
            {t("broadcasts.nameLabel")}
          </label>
          <input
            id="bc-name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("broadcasts.namePlaceholder")}
            maxLength={200}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="bc-channel">
            {t("broadcasts.channelLabel")}
          </label>
          <select
            id="bc-channel"
            className={inputClass}
            value={channelAccountId}
            onChange={(e) => setChannelAccountId(e.target.value)}
          >
            <option value="">—</option>
            {channels.map((ch) => {
              const supported = SUPPORTED_PROVIDERS.has(ch.provider);
              const disabled = !supported || ch.status !== "connected";
              return (
                <option key={ch.id} value={ch.id} disabled={disabled}>
                  {PROVIDER_NAMES[ch.provider]}
                  {ch.displayName ? ` · ${ch.displayName}` : ""}
                  {!supported
                    ? ` — ${t("broadcasts.channelWebchatUnsupported")}`
                    : ch.status !== "connected"
                      ? ` — ${t("broadcasts.channelDisconnected")}`
                      : ""}
                </option>
              );
            })}
          </select>
          {isWhatsApp ? (
            <p className="mt-1 text-xs text-muted">
              {t("broadcasts.channelWhatsappUnsupported")}
            </p>
          ) : null}
          {selectedChannel?.provider === "webchat" ? (
            <p className="mt-1 text-xs text-muted">
              {t("broadcasts.channelWebchatUnsupported")}
            </p>
          ) : null}
        </div>

        <div>
          <label className={labelClass} htmlFor="bc-audience-mode">
            {t("broadcasts.audienceLabel")}
          </label>
          <select
            id="bc-audience-mode"
            className={inputClass}
            value={audienceMode}
            onChange={(e) =>
              setAudienceMode(e.target.value as "all" | "tag" | "segment")
            }
          >
            <option value="all">{t("broadcasts.audienceModeAll")}</option>
            <option value="tag">{t("broadcasts.audienceModeTag")}</option>
            <option value="segment">{t("broadcasts.audienceModeSegment")}</option>
          </select>
        </div>

        {audienceMode === "tag" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="bc-tags">
                {t("broadcasts.tagsLabel")}
              </label>
              <input
                id="bc-tags"
                className={inputClass}
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder={t("broadcasts.tagsPlaceholder")}
              />
              <p className="mt-1 text-xs text-muted">{t("broadcasts.tagsHint")}</p>
            </div>
            <div>
              <label className={labelClass} htmlFor="bc-stages">
                {t("broadcasts.stagesLabel")}
              </label>
              <input
                id="bc-stages"
                className={inputClass}
                value={stagesText}
                onChange={(e) => setStagesText(e.target.value)}
                placeholder={t("broadcasts.stagesPlaceholder")}
              />
              <p className="mt-1 text-xs text-muted">
                {t("broadcasts.stagesHint")}
              </p>
            </div>
          </div>
        ) : null}

        {audienceMode === "segment" ? (
          <div>
            <label className={labelClass} htmlFor="bc-segment">
              {t("broadcasts.segmentLabel")}
            </label>
            <select
              id="bc-segment"
              className={inputClass}
              value={segmentId}
              onChange={(e) => setSegmentId(e.target.value)}
            >
              <option value="">{t("broadcasts.segmentPlaceholder")}</option>
              {segments.map((seg) => (
                <option key={seg.id} value={seg.id}>
                  {seg.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={effectiveRequireOptIn}
              onChange={(e) => setRequireOptIn(e.target.checked)}
            />
            <span>
              <span className="font-medium">
                {t("broadcasts.requireOptInLabel")}
              </span>
              <span className="mt-0.5 block text-xs font-normal text-muted">
                {t("broadcasts.requireOptInHint")}
              </span>
            </span>
          </label>
        </div>

        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-sm font-medium text-ink">
            {t("broadcasts.previewTitle")}
          </p>
          {previewLoading ? (
            <p className="mt-1 text-sm text-muted">
              {t("broadcasts.previewLoading")}
            </p>
          ) : preview ? (
            <div className="mt-1 space-y-0.5 text-sm text-muted">
              <p>
                {t("broadcasts.previewTotal", {
                  count: preview.totalCandidates,
                })}
              </p>
              <p className="font-medium text-ink">
                {t("broadcasts.previewWillSend", { count: preview.willSend })}
              </p>
              {preview.skippedOptedOut > 0 ? (
                <p>
                  {t("broadcasts.previewSkippedOptedOut", {
                    count: preview.skippedOptedOut,
                  })}
                </p>
              ) : null}
              {preview.skippedNotOptedIn > 0 ? (
                <p>
                  {t("broadcasts.previewSkippedNotOptedIn", {
                    count: preview.skippedNotOptedIn,
                  })}
                </p>
              ) : null}
              {preview.skippedOutside24hWindow > 0 ? (
                <p>
                  {t("broadcasts.previewSkippedOutside24h", {
                    count: preview.skippedOutside24hWindow,
                  })}
                </p>
              ) : null}
              {preview.skippedMissingPhoneNumber > 0 ? (
                <p>
                  {t("broadcasts.previewSkippedMissingPhone", {
                    count: preview.skippedMissingPhoneNumber,
                  })}
                </p>
              ) : null}
              {preview.skippedTemplateVariableMissing > 0 ? (
                <p>
                  {t("broadcasts.previewSkippedTemplateVariable", {
                    count: preview.skippedTemplateVariableMissing,
                  })}
                </p>
              ) : null}
              {isMeta ? (
                <p>{t("broadcasts.estimateWindowNote")}</p>
              ) : null}
              {isWhatsApp ? (
                <p>{t("broadcasts.estimateTemplateNote")}</p>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-sm text-muted">—</p>
          )}
        </div>

        {isWhatsApp ? (
          <div>
            <label className={labelClass} htmlFor="bc-template">
              {t("broadcasts.templateLabel")}
            </label>
            <select
              id="bc-template"
              className={inputClass}
              value={whatsappTemplateId}
              onChange={(e) => setWhatsappTemplateId(e.target.value)}
            >
              <option value="">
                {t("broadcasts.templateSelectPlaceholder")}
              </option>
              {waTemplates.map((tpl) => (
                <option
                  key={tpl.id}
                  value={tpl.id}
                  disabled={tpl.status !== "APPROVED"}
                >
                  {tpl.name} · {tpl.language} · {tpl.category}
                  {tpl.status !== "APPROVED" ? ` — ${tpl.status}` : ""}
                </option>
              ))}
            </select>
            {waTemplates.filter((tpl) => tpl.status === "APPROVED").length ===
            0 ? (
              <p className="mt-1 text-xs text-warning">
                {t("broadcasts.templateNoneApproved")}
              </p>
            ) : null}
            {selectedTemplate ? (
              <div className="mt-3 rounded-lg bg-surface-2 p-3">
                <p className="text-xs font-medium text-muted">
                  {t("broadcasts.templatePreviewLabel")}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                  {selectedTemplate.bodyText ??
                    t("whatsappTemplates.noBody")}
                </p>
              </div>
            ) : null}
            {selectedTemplate && selectedTemplate.variableCount > 0 ? (
              <div className="mt-3 space-y-2">
                <p className="text-sm font-medium text-ink">
                  {t("broadcasts.templateVariablesTitle")}
                </p>
                {Array.from(
                  { length: selectedTemplate.variableCount },
                  (_, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <label
                        className="w-24 shrink-0 text-xs text-muted"
                        htmlFor={`bc-var-${i}`}
                      >
                        {t("broadcasts.templateVariableSourceLabel", {
                          n: i + 1,
                        })}
                      </label>
                      <input
                        id={`bc-var-${i}`}
                        className={inputClass}
                        value={variableSources[i] ?? ""}
                        onChange={(e) => {
                          const next = [...variableSources];
                          next[i] = e.target.value;
                          setVariableSources(next);
                        }}
                        placeholder={t(
                          "broadcasts.templateVariableSourcePlaceholder",
                        )}
                      />
                    </div>
                  ),
                )}
                <p className="text-xs text-muted">
                  {t("broadcasts.templateVariableSourceHint")}
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <div>
            <label className={labelClass} htmlFor="bc-message">
              {t("broadcasts.messageLabel")}
            </label>
            <textarea
              id="bc-message"
              className={inputClass}
              rows={5}
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder={t("broadcasts.messagePlaceholder")}
              maxLength={4096}
            />
            <p className="mt-1 text-xs text-muted">
              {t("broadcasts.messageHint")}
            </p>
          </div>
        )}

        <div className="rounded-xl border border-border bg-surface p-4">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={abEnabled}
              onChange={(e) => setAbEnabled(e.target.checked)}
            />
            <span>
              <span className="font-medium">{t("broadcasts.abToggle")}</span>
              <span className="mt-0.5 block text-xs font-normal text-muted">
                {t("broadcasts.abToggleHint")}
              </span>
            </span>
          </label>
          {abEnabled ? (
            <div className="mt-4 space-y-4">
              <div>
                <label className={labelClass} htmlFor="bc-ab-percent">
                  {t("broadcasts.abSplitLabel")}
                </label>
                <div className="mt-1 flex items-center gap-3">
                  <input
                    id="bc-ab-percent"
                    type="range"
                    min={1}
                    max={99}
                    step={1}
                    className="flex-1"
                    value={abPercentB}
                    onChange={(e) =>
                      setAbPercentB(
                        Math.floor(Number(e.target.value) || 50),
                      )
                    }
                  />
                  <input
                    type="number"
                    min={1}
                    max={99}
                    step={1}
                    className="w-20 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-ink"
                    value={abPercentB}
                    onChange={(e) =>
                      setAbPercentB(
                        Math.min(
                          99,
                          Math.max(
                            1,
                            Math.floor(Number(e.target.value) || 50),
                          ),
                        ),
                      )
                    }
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  B {abPercentB}% · A {100 - abPercentB}% —{" "}
                  {t("broadcasts.abSplitHint")}
                </p>
              </div>
              {isWhatsApp ? (
                <div>
                  <label className={labelClass} htmlFor="bc-template-b">
                    {t("broadcasts.abVariantBTemplateLabel")}
                  </label>
                  <select
                    id="bc-template-b"
                    className={inputClass}
                    value={variantBTemplateId}
                    onChange={(e) => setVariantBTemplateId(e.target.value)}
                  >
                    <option value="">
                      {t("broadcasts.templateSelectPlaceholder")}
                    </option>
                    {waTemplates.map((tpl) => (
                      <option
                        key={tpl.id}
                        value={tpl.id}
                        disabled={tpl.status !== "APPROVED"}
                      >
                        {tpl.name} · {tpl.language} · {tpl.category}
                        {tpl.status !== "APPROVED" ? ` — ${tpl.status}` : ""}
                      </option>
                    ))}
                  </select>
                  {selectedTemplateB ? (
                    <div className="mt-3 rounded-lg bg-surface-2 p-3">
                      <p className="text-xs font-medium text-muted">
                        {t("broadcasts.templatePreviewLabel")}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-ink">
                        {selectedTemplateB.bodyText ??
                          t("whatsappTemplates.noBody")}
                      </p>
                    </div>
                  ) : null}
                  {selectedTemplateB &&
                  selectedTemplateB.variableCount > 0 ? (
                    <div className="mt-3 space-y-2">
                      <p className="text-sm font-medium text-ink">
                        {t("broadcasts.templateVariablesTitle")}
                      </p>
                      {Array.from(
                        { length: selectedTemplateB.variableCount },
                        (_, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <label
                              className="w-24 shrink-0 text-xs text-muted"
                              htmlFor={`bc-var-b-${i}`}
                            >
                              {t("broadcasts.templateVariableSourceLabel", {
                                n: i + 1,
                              })}
                            </label>
                            <input
                              id={`bc-var-b-${i}`}
                              className={inputClass}
                              value={variantBVariableSources[i] ?? ""}
                              onChange={(e) => {
                                const next = [...variantBVariableSources];
                                next[i] = e.target.value;
                                setVariantBVariableSources(next);
                              }}
                              placeholder={t(
                                "broadcasts.templateVariableSourcePlaceholder",
                              )}
                            />
                          </div>
                        ),
                      )}
                      <p className="text-xs text-muted">
                        {t("broadcasts.templateVariableSourceHint")}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div>
                  <label className={labelClass} htmlFor="bc-message-b">
                    {t("broadcasts.abVariantBMessageLabel")}
                  </label>
                  <textarea
                    id="bc-message-b"
                    className={inputClass}
                    rows={5}
                    value={variantBText}
                    onChange={(e) => setVariantBText(e.target.value)}
                    placeholder={t("broadcasts.messagePlaceholder")}
                    maxLength={4096}
                  />
                  <p className="mt-1 text-xs text-muted">
                    {t("broadcasts.messageHint")}
                  </p>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <fieldset>
          <legend className={labelClass}>{t("broadcasts.whenLabel")}</legend>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name="bc-when"
                checked={when === "now"}
                onChange={() => setWhen("now")}
              />
              {t("broadcasts.whenNow")}
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name="bc-when"
                checked={when === "schedule"}
                onChange={() => setWhen("schedule")}
              />
              {t("broadcasts.whenSchedule")}
            </label>
            {when === "schedule" ? (
              <input
                type="datetime-local"
                className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
                value={scheduledAtLocal}
                onChange={(e) => setScheduledAtLocal(e.target.value)}
                aria-label={t("broadcasts.scheduleAtLabel")}
              />
            ) : null}
          </div>
        </fieldset>

        <div className="flex flex-wrap gap-2 pb-8">
          <button
            type="button"
            disabled={saving || !name.trim() || !channelAccountId || !contentReady || !audienceReady}
            onClick={() => void save(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {t("broadcasts.createAndSchedule")}
          </button>
          <button
            type="button"
            disabled={saving || !name.trim() || !channelAccountId || !contentReady || !audienceReady}
            onClick={() => void save(false)}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            {editing ? t("broadcasts.saveChanges") : t("broadcasts.saveDraft")}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
          >
            {t("broadcasts.cancel")}
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

interface BroadcastDetailProps {
  t: Translate;
  locale: Locale;
  tenantId: string | null;
  broadcastId: string;
  onBack: () => void;
}

function BroadcastDetail({ t, locale, tenantId, broadcastId, onBack }: BroadcastDetailProps) {
  const [broadcast, setBroadcast] = useState<BroadcastResponse | null>(null);
  const [abResults, setAbResults] =
    useState<BroadcastAbResultsResponse | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipientResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!tenantId) return;
      if (!silent) setLoading(true);
      try {
        const [detail, page, ab] = await Promise.all([
          api.broadcasts.get(tenantId, broadcastId),
          api.broadcasts.listRecipients(tenantId, broadcastId, { limit: 50 }),
          api.broadcasts
            .abResults(tenantId, broadcastId)
            .catch(() => null),
        ]);
        setBroadcast(detail);
        setAbResults(ab);
        setRecipients(page.recipients);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (!silent) setError(translateApiError(t, err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [tenantId, broadcastId, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(
    () => {
      void load(true);
    },
    5000,
    broadcast?.status === "sending",
  );

  const loadMore = async () => {
    if (!tenantId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.broadcasts.listRecipients(tenantId, broadcastId, {
        limit: 50,
        cursor: nextCursor,
      });
      setRecipients((prev) => [...prev, ...page.recipients]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoadingMore(false);
    }
  };

  const statCells: { key: string; labelKey: TranslationKey; value: number }[] =
    broadcast
      ? [
          { key: "total", labelKey: "broadcasts.statTotal", value: broadcast.stats.total },
          { key: "queued", labelKey: "broadcasts.statQueued", value: broadcast.stats.queued },
          { key: "sent", labelKey: "broadcasts.statSent", value: broadcast.stats.sent },
          { key: "delivered", labelKey: "broadcasts.statDelivered", value: broadcast.stats.delivered },
          { key: "read", labelKey: "broadcasts.statRead", value: broadcast.stats.read },
          { key: "failed", labelKey: "broadcasts.statFailed", value: broadcast.stats.failed },
          { key: "skipped", labelKey: "broadcasts.statSkipped", value: broadcast.stats.skipped },
          { key: "cancelled", labelKey: "broadcasts.statCancelled", value: broadcast.stats.cancelled },
        ]
      : [];

  return (
    <section>
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-muted hover:text-ink"
      >
        ← {t("broadcasts.backToList")}
      </button>

      {loading ? (
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      ) : error || !broadcast ? (
        <p className="mt-6 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error ?? t("errors.NOT_FOUND")}
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-ink">{broadcast.name}</h1>
            <StatusChip t={t} status={broadcast.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {PROVIDER_NAMES[broadcast.provider]}
            {broadcast.channelDisplayName
              ? ` · ${broadcast.channelDisplayName}`
              : ""}
            {" · "}
            {broadcast.scheduledAt
              ? t("broadcasts.scheduledFor", {
                  when: formatDateTime(broadcast.scheduledAt, locale),
                })
              : formatDateTime(broadcast.createdAt, locale)}
          </p>
          <p className="mt-3 max-w-2xl whitespace-pre-wrap rounded-xl border border-border bg-surface p-4 text-sm text-ink">
            {broadcast.messageText}
          </p>
          {broadcast.status === "failed" && broadcast.errorCode ? (
            <p className="mt-2 text-sm text-danger">
              {t("broadcasts.dispatchErrorLabel")}:{" "}
              {DISPATCH_ERROR_LABEL_KEYS[broadcast.errorCode]
                ? t(DISPATCH_ERROR_LABEL_KEYS[broadcast.errorCode])
                : broadcast.errorCode}
            </p>
          ) : null}

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {statCells.map((cell) => (
              <div
                key={cell.key}
                className="rounded-xl border border-border bg-surface p-3 text-center"
              >
                <p className="text-xl font-bold text-ink">{cell.value}</p>
                <p className="text-xs text-muted">{t(cell.labelKey)}</p>
              </div>
            ))}
          </div>

          {abResults?.abTest ? (
            <div className="mt-6">
              <h2 className="text-lg font-semibold text-ink">
                {t("broadcasts.abResultsTitle")}
              </h2>
              <p className="mt-1 max-w-2xl text-xs text-muted">
                {t("broadcasts.abResultsNote")}
              </p>
              <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-surface">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted">
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.abColVariant")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.abColAssigned")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statQueued")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statSent")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statDelivered")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statRead")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statFailed")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statSkipped")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("broadcasts.statCancelled")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {abResults.variants.map((v) => (
                      <tr key={v.variant} className="border-t border-border">
                        <td className="px-3 py-2 font-semibold uppercase text-ink">
                          {v.variant}
                        </td>
                        <td className="px-3 py-2 text-ink">{v.assigned}</td>
                        <td className="px-3 py-2 text-ink">{v.queued}</td>
                        <td className="px-3 py-2 text-ink">{v.sent}</td>
                        <td className="px-3 py-2 text-ink">{v.delivered}</td>
                        <td className="px-3 py-2 text-ink">{v.read}</td>
                        <td className="px-3 py-2 text-ink">{v.failed}</td>
                        <td className="px-3 py-2 text-ink">
                          {v.skipped}
                          {v.skipped > 0 ? (
                            <span className="block text-xs font-normal text-muted">
                              {(
                                Object.entries(v.skippedByReason) as [
                                  string,
                                  number,
                                ][]
                              )
                                .filter(([, n]) => n > 0)
                                .map(([reason, n]) =>
                                  `${
                                    SKIP_REASON_LABEL_KEYS[reason]
                                      ? t(SKIP_REASON_LABEL_KEYS[reason])
                                      : reason
                                  }: ${n}`,
                                )
                                .join(" · ")}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-ink">{v.cancelled}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <h2 className="mt-6 text-lg font-semibold text-ink">
            {t("broadcasts.recipientsTitle")}
          </h2>
          {recipients.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              {t("broadcasts.recipientsEmpty")}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-surface">
              {recipients.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                >
                  <span className="text-sm font-medium text-ink">
                    {r.contactName}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {abResults?.abTest ? (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 font-semibold text-ink">
                        {t(
                          r.variant === "b"
                            ? "broadcasts.abVariantBadgeB"
                            : "broadcasts.abVariantBadgeA",
                        )}
                      </span>
                    ) : null}
                    {r.status === "skipped" && r.skipReason ? (
                      <span>
                        {SKIP_REASON_LABEL_KEYS[r.skipReason]
                          ? t(SKIP_REASON_LABEL_KEYS[r.skipReason])
                          : r.skipReason}
                      </span>
                    ) : null}
                    {r.status === "failed" && r.errorCode ? (
                      <span className="text-danger">
                        {t("broadcasts.errorCodeLabel")}: {r.errorCode}
                      </span>
                    ) : null}
                    <span className="font-medium text-ink">
                      {RECIPIENT_STATUS_LABEL_KEYS[r.status]
                        ? t(RECIPIENT_STATUS_LABEL_KEYS[r.status])
                        : r.status}
                    </span>
                  </span>
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
                {loadingMore
                  ? t("broadcasts.loadingMore")
                  : t("broadcasts.loadMore")}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Seksi Template WhatsApp (Fase 10A) — cermin lokal template resmi Meta
// per akun WhatsApp: sinkron dari Meta, buat baru (formulir sederhana),
// hapus (dua langkah). Sengaja tinggal di halaman Broadcasts karena
// konsumen utamanya adalah broadcast; Channels tetap halaman koneksi.
// ---------------------------------------------------------------------------

interface WhatsAppTemplatesSectionProps {
  t: Translate;
  tenantId: string | null;
  canManage: boolean;
}

interface TemplateButtonDraft {
  type: "URL" | "QUICK_REPLY";
  text: string;
  url: string;
}

function WhatsAppTemplatesSection({
  t,
  tenantId,
  canManage,
}: WhatsAppTemplatesSectionProps) {
  const [channels, setChannels] = useState<ChannelAccountResponse[]>([]);
  const [channelAccountId, setChannelAccountId] = useState("");
  const [templates, setTemplates] = useState<WhatsAppTemplateResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(
    null,
  );
  const [showForm, setShowForm] = useState(false);

  // Keadaan formulir buat template.
  const [tplName, setTplName] = useState("");
  const [tplLanguage, setTplLanguage] = useState("id");
  const [tplCategory, setTplCategory] =
    useState<CreateWhatsAppTemplateRequest["category"]>("UTILITY");
  const [tplHeader, setTplHeader] = useState("");
  const [tplBody, setTplBody] = useState("");
  const [tplExamples, setTplExamples] = useState("");
  const [tplFooter, setTplFooter] = useState("");
  const [tplButtons, setTplButtons] = useState<TemplateButtonDraft[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api.channels
      .list(tenantId)
      .then((list) => {
        if (cancelled) return;
        const wa = list.filter((ch) => ch.provider === "whatsapp");
        setChannels(wa);
        const firstConnected = wa.find((ch) => ch.status === "connected");
        if (firstConnected) {
          setChannelAccountId((prev) => prev || firstConnected.id);
        } else if (wa[0]) {
          setChannelAccountId((prev) => prev || wa[0].id);
        }
      })
      .catch(() => {
        if (!cancelled) setChannels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const loadTemplates = useCallback(
    async (accountId: string) => {
      if (!tenantId || !accountId) return;
      setLoading(true);
      try {
        const res = await api.whatsappTemplates.list(tenantId, accountId);
        setTemplates(res.templates);
      } catch (err) {
        setError(translateApiError(t, err));
        setTemplates([]);
      } finally {
        setLoading(false);
      }
    },
    [tenantId, t],
  );

  useEffect(() => {
    if (channelAccountId) void loadTemplates(channelAccountId);
  }, [channelAccountId, loadTemplates]);

  const selectedChannel = channels.find((ch) => ch.id === channelAccountId);
  const channelConnected = selectedChannel?.status === "connected";

  const sync = async () => {
    if (!tenantId || !channelAccountId || syncing) return;
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.whatsappTemplates.sync(tenantId, channelAccountId);
      setTemplates(res.templates);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSyncing(false);
    }
  };

  const create = async () => {
    if (!tenantId || !channelAccountId || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const examples = tplExamples
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const input: CreateWhatsAppTemplateRequest = {
        channelAccountId,
        name: tplName.trim(),
        language: tplLanguage.trim(),
        category: tplCategory,
        bodyText: tplBody.trim(),
        ...(tplHeader.trim() ? { headerText: tplHeader.trim() } : {}),
        ...(examples.length > 0 ? { bodyExamples: examples } : {}),
        ...(tplFooter.trim() ? { footerText: tplFooter.trim() } : {}),
        ...(tplButtons.length > 0
          ? {
              buttons: tplButtons.map((b) =>
                b.type === "URL"
                  ? { type: "URL" as const, text: b.text.trim(), url: b.url.trim() }
                  : { type: "QUICK_REPLY" as const, text: b.text.trim() },
              ),
            }
          : {}),
      };
      await api.whatsappTemplates.create(tenantId, input);
      setNotice(t("whatsappTemplates.createdNote"));
      setShowForm(false);
      setTplName("");
      setTplHeader("");
      setTplBody("");
      setTplExamples("");
      setTplFooter("");
      setTplButtons([]);
      await loadTemplates(channelAccountId);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tpl: WhatsAppTemplateResponse) => {
    if (!tenantId || busy) return;
    if (confirmingDelete !== tpl.id) {
      setConfirmingDelete(tpl.id);
      return;
    }
    setConfirmingDelete(null);
    setBusy(true);
    setError(null);
    try {
      await api.whatsappTemplates.remove(tenantId, tpl.id);
      await loadTemplates(channelAccountId);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink";
  const labelClass = "block text-sm font-medium text-ink";
  const createValid =
    !!tplName.trim() && !!tplLanguage.trim() && !!tplBody.trim();

  return (
    <div className="mt-12 border-t border-border pt-8">
      <h2 className="text-xl font-bold text-ink">
        {t("whatsappTemplates.title")}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("whatsappTemplates.subtitle")}
      </p>

      {channels.length === 0 ? (
        <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          {t("whatsappTemplates.noChannel")}
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-56">
              <label className={labelClass} htmlFor="wt-channel">
                {t("whatsappTemplates.channelLabel")}
              </label>
              <select
                id="wt-channel"
                className={inputClass}
                value={channelAccountId}
                onChange={(e) => setChannelAccountId(e.target.value)}
              >
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.displayName ?? "WhatsApp"}
                    {ch.status !== "connected"
                      ? ` — ${t("broadcasts.channelDisconnected")}`
                      : ""}
                  </option>
                ))}
              </select>
            </div>
            {canManage && channelConnected ? (
              <>
                <button
                  type="button"
                  disabled={syncing || !channelAccountId}
                  onClick={() => void sync()}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
                >
                  {syncing
                    ? t("whatsappTemplates.syncing")
                    : t("whatsappTemplates.syncAction")}
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm((v) => !v)}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
                >
                  {t("whatsappTemplates.createAction")}
                </button>
              </>
            ) : null}
          </div>

          {error ? (
            <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="mt-4 rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
              {notice}
            </p>
          ) : null}

          {showForm && canManage ? (
            <div className="mt-5 max-w-2xl space-y-4 rounded-xl border border-border bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink">
                {t("whatsappTemplates.formTitle")}
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="wt-name">
                    {t("whatsappTemplates.nameLabel")}
                  </label>
                  <input
                    id="wt-name"
                    className={inputClass}
                    value={tplName}
                    onChange={(e) => setTplName(e.target.value)}
                    placeholder={t("whatsappTemplates.namePlaceholder")}
                  />
                  <p className="mt-1 text-xs text-muted">
                    {t("whatsappTemplates.nameHint")}
                  </p>
                </div>
                <div>
                  <label className={labelClass} htmlFor="wt-language">
                    {t("whatsappTemplates.languageLabel")}
                  </label>
                  <input
                    id="wt-language"
                    className={inputClass}
                    value={tplLanguage}
                    onChange={(e) => setTplLanguage(e.target.value)}
                    placeholder={t("whatsappTemplates.languagePlaceholder")}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass} htmlFor="wt-category">
                  {t("whatsappTemplates.categoryLabel")}
                </label>
                <select
                  id="wt-category"
                  className={inputClass}
                  value={tplCategory}
                  onChange={(e) =>
                    setTplCategory(
                      e.target.value as CreateWhatsAppTemplateRequest["category"],
                    )
                  }
                >
                  <option value="UTILITY">
                    {t("whatsappTemplates.categoryUtility")}
                  </option>
                  <option value="MARKETING">
                    {t("whatsappTemplates.categoryMarketing")}
                  </option>
                  <option value="AUTHENTICATION">
                    {t("whatsappTemplates.categoryAuthentication")}
                  </option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="wt-header">
                  {t("whatsappTemplates.headerLabel")}
                </label>
                <input
                  id="wt-header"
                  className={inputClass}
                  value={tplHeader}
                  onChange={(e) => setTplHeader(e.target.value)}
                  placeholder={t("whatsappTemplates.headerPlaceholder")}
                  maxLength={60}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="wt-body">
                  {t("whatsappTemplates.bodyLabel")}
                </label>
                <textarea
                  id="wt-body"
                  className={inputClass}
                  rows={4}
                  value={tplBody}
                  onChange={(e) => setTplBody(e.target.value)}
                  placeholder={t("whatsappTemplates.bodyPlaceholder")}
                  maxLength={1024}
                />
                <p className="mt-1 text-xs text-muted">
                  {t("whatsappTemplates.bodyHint")}
                </p>
              </div>
              <div>
                <label className={labelClass} htmlFor="wt-examples">
                  {t("whatsappTemplates.examplesLabel")}
                </label>
                <input
                  id="wt-examples"
                  className={inputClass}
                  value={tplExamples}
                  onChange={(e) => setTplExamples(e.target.value)}
                  placeholder={t("whatsappTemplates.examplesPlaceholder")}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="wt-footer">
                  {t("whatsappTemplates.footerLabel")}
                </label>
                <input
                  id="wt-footer"
                  className={inputClass}
                  value={tplFooter}
                  onChange={(e) => setTplFooter(e.target.value)}
                  placeholder={t("whatsappTemplates.footerPlaceholder")}
                  maxLength={60}
                />
              </div>
              <div>
                <p className={labelClass}>{t("whatsappTemplates.buttonsLabel")}</p>
                <div className="mt-2 space-y-2">
                  {tplButtons.map((b, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <select
                        className="rounded-lg border border-border bg-surface px-2 py-2 text-sm text-ink"
                        value={b.type}
                        onChange={(e) => {
                          const next = [...tplButtons];
                          next[i] = {
                            ...b,
                            type: e.target.value as "URL" | "QUICK_REPLY",
                          };
                          setTplButtons(next);
                        }}
                      >
                        <option value="URL">
                          {t("whatsappTemplates.buttonTypeUrl")}
                        </option>
                        <option value="QUICK_REPLY">
                          {t("whatsappTemplates.buttonTypeQuickReply")}
                        </option>
                      </select>
                      <input
                        className="min-w-32 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
                        value={b.text}
                        onChange={(e) => {
                          const next = [...tplButtons];
                          next[i] = { ...b, text: e.target.value };
                          setTplButtons(next);
                        }}
                        placeholder={t("whatsappTemplates.buttonTextPlaceholder")}
                        maxLength={25}
                      />
                      {b.type === "URL" ? (
                        <input
                          className="min-w-40 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
                          value={b.url}
                          onChange={(e) => {
                            const next = [...tplButtons];
                            next[i] = { ...b, url: e.target.value };
                            setTplButtons(next);
                          }}
                          placeholder={t("whatsappTemplates.buttonUrlPlaceholder")}
                        />
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          setTplButtons(tplButtons.filter((_, j) => j !== i))
                        }
                        className="rounded-lg border border-border px-2 py-2 text-xs text-muted hover:text-ink"
                      >
                        {t("whatsappTemplates.removeButton")}
                      </button>
                    </div>
                  ))}
                  {tplButtons.length < 3 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setTplButtons([
                          ...tplButtons,
                          { type: "QUICK_REPLY", text: "", url: "" },
                        ])
                      }
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
                    >
                      {t("whatsappTemplates.addButton")}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !createValid}
                  onClick={() => void create()}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  {t("whatsappTemplates.saveAction")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShowForm(false)}
                  className="rounded-lg px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
                >
                  {t("whatsappTemplates.cancelAction")}
                </button>
              </div>
            </div>
          ) : null}

          {loading ? (
            <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
          ) : templates.length === 0 ? (
            <p className="mt-6 rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted">
              {t("whatsappTemplates.empty")}
            </p>
          ) : (
            <ul className="mt-5 space-y-3">
              {templates.map((tpl) => (
                <li
                  key={tpl.id}
                  className="rounded-xl border border-border bg-surface p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink">
                      {tpl.name}
                    </span>
                    <TemplateStatusChip t={t} status={tpl.status} />
                    <span className="text-xs text-muted">
                      {tpl.language} · {tpl.category}
                      {tpl.variableCount > 0
                        ? ` · ${t("whatsappTemplates.variableCount", {
                            count: tpl.variableCount,
                          })}`
                        : ""}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted">
                    {tpl.bodyText ?? t("whatsappTemplates.noBody")}
                  </p>
                  {canManage && channelConnected ? (
                    <div className="mt-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(tpl)}
                        className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
                      >
                        {confirmingDelete === tpl.id
                          ? t("whatsappTemplates.confirmDelete")
                          : t("whatsappTemplates.deleteAction")}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
