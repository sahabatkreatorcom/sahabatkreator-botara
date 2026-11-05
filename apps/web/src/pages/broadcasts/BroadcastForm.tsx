/**
 * Formulir buat/ubah draf broadcast, termasuk pemilih audiens dan
 * pemetaan variabel template WhatsApp.
 */
import { useEffect, useRef, useState } from "react";
import type {
  BroadcastAudienceFilter,
  BroadcastAudiencePreviewResponse,
  BroadcastResponse,
  ChannelAccountResponse,
  SegmentResponse,
  WhatsAppTemplateResponse,
} from "@sahabat-kreator/contracts";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { splitCommaList } from "./chips";
import { PROVIDER_NAMES, SUPPORTED_PROVIDERS, type Translate } from "./types";

export interface BroadcastFormProps {
  t: Translate;
  tenantId: string | null;
  target: "create" | BroadcastResponse;
  onDone: () => void;
  onCancel: () => void;
}

export function BroadcastForm({ t, tenantId, target, onDone, onCancel }: BroadcastFormProps) {
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
