import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AGENT_INSTRUCTION_TEMPLATES,
  extractInstructionPlaceholders,
  resolveAgentTemplateFill,
  type AgentInstructionTemplateDefinition,
  type AgentInstructionTemplateResponse,
  type AgentMode,
  type AgentPlaygroundDraftConfig,
  type AgentResponse,
  type AgentSuggestionResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { TemplateGalleryGrid } from "../components/TemplateGallery";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { usePendingApprovals } from "../agents/PendingApprovalsProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}

/** Nama tool yang diusulkan agent dari `detail.toolCalls` (defensif — detail adalah record bebas). */
function proposedToolNames(suggestion: AgentSuggestionResponse): string[] {
  const calls = suggestion.detail?.toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((c) =>
      c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string"
        ? (c as { name: string }).name
        : null,
    )
    .filter((n): n is string => n !== null);
}

interface AgentsPageProps {
  t: Translate;
  locale: Locale;
}

interface AgentsListSectionProps extends AgentsPageProps {
  /**
   * Uji isi formulir agent saat ini di Playground tanpa menyimpan
   * (gelombang Templat Instruction): hub /agents meneruskannya ke
   * PlaygroundPanel sebagai draf. Opsional — tanpa prop ini tombol
   * "Coba di Playground" tidak dirender di formulir.
   */
  onTryInPlayground?: (draft: AgentPlaygroundDraftConfig) => void;
}

/**
 * Seksi daftar agent untuk hub /agents (Fase 12E): pengelolaan agent
 * workspace aktif lewat API 3A — daftar + sakelar aktif, form buat/edit
 * (prompt, model, mode auto/suggest). Antrean saran kini seksi terpisah
 * (`SuggestionsSection`) di tabnya sendiri; keduanya dirangkai
 * AgentsHubPage. Semua teks lewat i18n; tanggal lewat Intl.
 */
export function AgentsListSection({
  t,
  locale,
  onTryInPlayground,
}: AgentsListSectionProps) {
  const { status, tenants, active, reload } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formTarget, setFormTarget] = useState<"create" | AgentResponse | null>(
    null,
  );
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api.agents.list(tenantId);
      if (requestSeq.current !== seq) return;
      setAgents(list);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setAgents([]);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = async (agent: AgentResponse) => {
    if (!tenantId || togglingId) return;
    const next = !agent.isActive;
    // Optimistis: ubah tampilan dulu, kembalikan bila server menolak.
    setAgents((prev) =>
      prev.map((a) => (a.id === agent.id ? { ...a, isActive: next } : a)),
    );
    setTogglingId(agent.id);
    try {
      const updated = await api.agents.update(tenantId, agent.id, {
        isActive: next,
      });
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err) {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === agent.id ? { ...a, isActive: agent.isActive } : a,
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
        <h1 className="text-2xl font-bold text-ink">{t("agents.title")}</h1>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("agents.title")}</h1>
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
        <h1 className="text-2xl font-bold text-ink">{t("agents.title")}</h1>
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
          <h1 className="text-2xl font-bold text-ink">{t("agents.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("agents.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setFormTarget("create")}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
        >
          {t("agents.addButton")}
        </button>
      </div>

      {/* Catatan jujur staging: provider model belum dikonfigurasi di server,
          balasan agent masih dari penjawab demo yang mengutip KB (Fase 3B). */}
      <div className="mt-4 rounded-xl border border-line bg-elevated p-4">
        <p className="text-xs leading-relaxed text-muted">{t("agents.mockNote")}</p>
      </div>

      <FieldError message={error} />

      {loading ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : agents.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <h2 className="text-base font-semibold text-ink">
            {t("agents.emptyTitle")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            {t("agents.emptyBody")}
          </p>
          <button
            type="button"
            onClick={() => setFormTarget("create")}
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {t("agents.addButton")}
          </button>
        </div>
      ) : (
        <ul className="mt-5 space-y-3">
          {agents.map((agent) => (
            <li
              key={agent.id}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {agent.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {agent.model || t("agents.modelDefault")}
                    {" · "}
                    {t("agents.createdLabel", {
                      date: formatDateTime(agent.createdAt, locale),
                    })}
                  </span>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    agent.mode === "suggest"
                      ? "bg-elevated text-ink"
                      : "bg-accent/10 text-accent"
                  }`}
                >
                  {t(
                    agent.mode === "suggest"
                      ? "agents.modeSuggest"
                      : "agents.modeAuto",
                  )}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    agent.isActive
                      ? "bg-accent/10 text-accent"
                      : "bg-elevated text-muted"
                  }`}
                >
                  {agent.isActive
                    ? t("agents.statusActive")
                    : t("agents.statusInactive")}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={agent.isActive}
                  aria-label={agent.name}
                  disabled={togglingId === agent.id}
                  onClick={() => void handleToggle(agent)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                    agent.isActive ? "bg-accent" : "bg-elevated"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      agent.isActive ? "left-[22px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
              {agent.systemPrompt ? (
                <p className="mt-2 line-clamp-2 text-sm text-muted">
                  {agent.systemPrompt}
                </p>
              ) : null}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setFormTarget(agent)}
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
        <AgentFormModal
          t={t}
          locale={locale}
          tenantId={active.id}
          agent={formTarget === "create" ? null : formTarget}
          onClose={() => setFormTarget(null)}
          onTryInPlayground={
            onTryInPlayground
              ? (draft) => {
                  // Modal ditutup DULU, baru hub berpindah ke tab
                  // playground dengan draf ini (urutan disengaja:
                  // playground tidak boleh terbuka di balik modal).
                  setFormTarget(null);
                  onTryInPlayground(draft);
                }
              : undefined
          }
          onSaved={(saved) => {
            setFormTarget(null);
            setAgents((prev) => {
              const exists = prev.some((a) => a.id === saved.id);
              return exists
                ? prev.map((a) => (a.id === saved.id ? saved : a))
                : [saved, ...prev];
            });
          }}
        />
      ) : null}
    </section>
  );
}

function AgentFormModal({
  t,
  locale,
  tenantId,
  agent,
  onClose,
  onSaved,
  onTryInPlayground,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  agent: AgentResponse | null;
  onClose: () => void;
  onSaved: (agent: AgentResponse) => void;
  onTryInPlayground?: (draft: AgentPlaygroundDraftConfig) => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [mode, setMode] = useState<AgentMode>(agent?.mode ?? "suggest");
  // Bahasa balasan agent (config.language): "" = ikuti bahasa pelanggan.
  const [language, setLanguage] = useState(agent?.config?.language ?? "");
  const [isActive, setIsActive] = useState(agent?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // --- Galeri templat instruction (gelombang Templat Instruction) ---
  // Templat pribadi tenant dimuat saat modal dibuka; katalog bawaan
  // statis dari kontrak. Gagal memuat daftar pribadi TIDAK menggagalkan
  // formulir — galeri bawaan tetap jalan, cukup catatan kecil.
  const [myTemplates, setMyTemplates] = useState<
    AgentInstructionTemplateResponse[]
  >([]);
  const [myTemplatesLoaded, setMyTemplatesLoaded] = useState(false);
  const [myTemplatesError, setMyTemplatesError] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(
    null,
  );

  const loadMyTemplates = useCallback(async () => {
    try {
      const list = await api.agentTemplates.list(tenantId);
      setMyTemplates(list);
      setMyTemplatesError(false);
    } catch {
      setMyTemplatesError(true);
    } finally {
      setMyTemplatesLoaded(true);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadMyTemplates();
  }, [loadMyTemplates]);

  // "Mulai dari kosong" (mode buat): kembalikan formulir ke keadaan awal.
  const applyBlank = () => {
    setName("");
    setSystemPrompt("");
    setModel("");
    setMode("suggest");
    setLanguage("");
    setIsActive(true);
    setError(null);
  };

  // Templat bawaan: isian mengikuti locale UI saat ini. Mode EDIT tidak
  // menimpa nama agent yang sedang diedit (keputusan desain) — nama
  // saran templat hanya dipakai pada mode BUAT.
  const applyBuiltInTemplate = (def: AgentInstructionTemplateDefinition) => {
    const fill = resolveAgentTemplateFill(def, locale);
    if (!agent) setName(fill.name);
    setSystemPrompt(fill.systemPrompt);
    setMode(fill.mode);
    setLanguage(fill.language);
    setError(null);
  };

  // Templat pribadi tenant: isian dari baris tersimpan; aturan nama sama
  // seperti templat bawaan (hanya mode buat yang menerima nama templat).
  const applyMyTemplate = (tpl: AgentInstructionTemplateResponse) => {
    if (!agent) setName(tpl.name);
    setSystemPrompt(tpl.systemPrompt);
    setMode(tpl.mode);
    setLanguage(tpl.language ?? "");
    setError(null);
  };

  const handleDeleteTemplate = async (
    tpl: AgentInstructionTemplateResponse,
  ) => {
    if (deletingTemplateId) return;
    if (
      !window.confirm(
        t("agents.templateDeleteConfirm", { name: tpl.name }),
      )
    ) {
      return;
    }
    setDeletingTemplateId(tpl.id);
    try {
      await api.agentTemplates.remove(tenantId, tpl.id);
      await loadMyTemplates();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setDeletingTemplateId(null);
    }
  };

  // --- Simpan sebagai templat (lipatan sebaris di bawah formulir) ---
  const [saveFoldOpen, setSaveFoldOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);

  const handleSaveAsTemplate = async () => {
    const trimmed = templateName.trim();
    if (!trimmed) return setError(t("agents.templateSaveNameRequired"));
    setSavingTemplate(true);
    try {
      await api.agentTemplates.create(tenantId, {
        name: trimmed,
        systemPrompt,
        mode,
        language: language || null,
      });
      setSaveFoldOpen(false);
      setTemplateSaved(true);
      await loadMyTemplates();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSavingTemplate(false);
    }
  };

  // Penanda [...] yang belum diganti di instruction — peringatan murni
  // tampilan (non-blokir): tidak menyentuh validasi/submit sama sekali.
  const placeholders = extractInstructionPlaceholders(systemPrompt);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return setError(t("agents.nameRequired"));
    setError(null);
    setSubmitting(true);
    try {
      // Config lama dipertahankan; hanya kunci language yang
      // diterapkan (pilihan terisi) atau dihapus (pilihan "").
      const config = { ...(agent?.config ?? {}) };
      if (language) {
        config.language = language;
      } else {
        delete config.language;
      }
      const payload = {
        name: trimmedName,
        systemPrompt: systemPrompt.trim(),
        model: model.trim(),
        mode,
        isActive,
        config,
      };
      const saved = agent
        ? await api.agents.update(tenantId, agent.id, payload)
        : await api.agents.create(tenantId, payload);
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
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">
            {agent ? t("agents.editTitle") : t("agents.addTitle")}
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
          {/* Galeri templat instruction: memilih kartu MENGISI formulir
              (instruction + mode + bahasa, + nama hanya pada mode buat);
              tidak ada yang tersimpan sampai formulir disimpan. */}
          <div>
            <h3 className="text-sm font-semibold text-ink">
              {t("agents.templatesTitle")}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {t("agents.templatesSubtitle")}
            </p>
            <TemplateGalleryGrid
              variant="compact"
              cards={[
                ...(!agent
                  ? [
                      {
                        key: "blank",
                        name: t("agents.templateBlankName"),
                        description: t("agents.templateBlankDesc"),
                        actions: (
                          <button
                            type="button"
                            onClick={applyBlank}
                            className="mt-2 self-start rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                          >
                            {t("agents.templateApplyButton")}
                          </button>
                        ),
                      },
                    ]
                  : []),
                ...AGENT_INSTRUCTION_TEMPLATES.map((def) => ({
                  key: def.slug,
                  name: t(def.nameKey as TranslationKey),
                  badges: (
                    <>
                      <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] font-semibold text-muted">
                        {t("agents.templateBuiltInBadge")}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          def.mode === "suggest"
                            ? "bg-elevated text-ink"
                            : "bg-accent/10 text-accent"
                        }`}
                      >
                        {t(
                          def.mode === "suggest"
                            ? "agents.modeSuggest"
                            : "agents.modeAuto",
                        )}
                      </span>
                    </>
                  ),
                  description: t(def.descriptionKey as TranslationKey),
                  actions: (
                    <button
                      type="button"
                      onClick={() => applyBuiltInTemplate(def)}
                      className="mt-2 self-start rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                    >
                      {t("agents.templateApplyButton")}
                    </button>
                  ),
                })),
                ...myTemplates.map((tpl) => ({
                  key: tpl.id,
                  name: tpl.name,
                  badges: (
                    <>
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                        {t("agents.templateMineBadge")}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          tpl.mode === "suggest"
                            ? "bg-elevated text-ink"
                            : "bg-accent/10 text-accent"
                        }`}
                      >
                        {t(
                          tpl.mode === "suggest"
                            ? "agents.modeSuggest"
                            : "agents.modeAuto",
                        )}
                      </span>
                    </>
                  ),
                  description: tpl.systemPrompt,
                  descriptionClassName:
                    "line-clamp-3 whitespace-pre-wrap",
                  actions: (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => applyMyTemplate(tpl)}
                        className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                      >
                        {t("agents.templateApplyButton")}
                      </button>
                      <button
                        type="button"
                        disabled={deletingTemplateId === tpl.id}
                        onClick={() => void handleDeleteTemplate(tpl)}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-60"
                      >
                        {t("agents.templateDeleteButton")}
                      </button>
                    </div>
                  ),
                })),
              ]}
            />
            {myTemplatesError ? (
              <p className="mt-2 text-xs text-danger">
                {t("agents.templatesLoadError")}
              </p>
            ) : myTemplatesLoaded && myTemplates.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                {t("agents.templatesMineEmpty")}
              </p>
            ) : null}
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("agents.nameLabel")} *
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("agents.namePlaceholder")}
              className={inputClassName}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("agents.promptLabel")}
            </span>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("agents.promptPlaceholder")}
              rows={6}
              className={inputClassName}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {t("agents.promptHint")}
            </span>
          </label>
          {/* Peringatan penanda [...] belum diganti — murni tampilan,
              TIDAK PERNAH menghalangi simpan (keputusan pemilik). */}
          {placeholders.length > 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
              <p className="text-xs font-semibold text-warning">
                {t("agents.templatePlaceholderWarningTitle")}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink">
                {t("agents.templatePlaceholderWarningBody", {
                  placeholders: placeholders
                    .map((p) => `[${p}]`)
                    .join(", "),
                })}
              </p>
            </div>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("agents.modelLabel")}
            </span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("agents.modelPlaceholder")}
              className={inputClassName}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {t("agents.modelHint")}
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("agents.languageLabel")}
            </span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className={inputClassName}
            >
              <option value="">{t("agents.languageFollow")}</option>
              <option value="id">{t("agents.languageId")}</option>
              <option value="en">{t("agents.languageEn")}</option>
            </select>
          </label>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted">
              {t("agents.modeLabel")}
            </legend>
            <div className="space-y-2">
              {(["auto", "suggest"] as const).map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface p-3"
                >
                  <input
                    type="radio"
                    name="agent-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink">
                      {t(value === "auto" ? "agents.modeAuto" : "agents.modeSuggest")}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {t(
                        value === "auto"
                          ? "agents.modeAutoHint"
                          : "agents.modeSuggestHint",
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span className="text-sm text-ink">{t("agents.activeLabel")}</span>
          </label>
          <FieldError message={error} />
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {submitting
                ? agent
                  ? t("agents.saving")
                  : t("agents.creating")
                : agent
                  ? t("agents.saveChanges")
                  : t("agents.createButton")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
            >
              {t("common.cancel")}
            </button>
          </div>
          {/* Aksi sekunder: simpan susunan formulir ini sebagai templat
              pribadi, dan/atau uji persis isi formulir ini di Playground
              sebagai draf (tanpa menyimpan agent). */}
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => {
                setTemplateSaved(false);
                setTemplateName((prev) => prev || name);
                setSaveFoldOpen((v) => !v);
              }}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
            >
              {t("agents.templateSaveButton")}
            </button>
            {onTryInPlayground ? (
              <button
                type="button"
                onClick={() =>
                  onTryInPlayground({
                    name: name.trim() || undefined,
                    systemPrompt,
                    model: model.trim() || undefined,
                    mode,
                    language: language || null,
                  })
                }
                className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
              >
                {t("agents.tryPlaygroundButton")}
              </button>
            ) : null}
          </div>
          {templateSaved ? (
            <p className="rounded-lg bg-success/15 px-3 py-2 text-sm text-success">
              {t("agents.templateSaved")}
            </p>
          ) : null}
          {saveFoldOpen ? (
            <div className="rounded-xl border border-line bg-surface p-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">
                  {t("agents.templateSaveNameLabel")}
                </span>
                <input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder={t("agents.templateSaveNamePlaceholder")}
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
                    ? t("agents.templateSaving")
                    : t("agents.templateSaveConfirmButton")}
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
        </form>
      </div>
    </div>
  );
}

/**
 * Antrean draf balasan mode suggest: daftar pending + approve/reject.
 * Setelah aksi, daftar dimuat ulang DAN badge navigasi disegarkan lewat
 * PendingApprovalsProvider — keduanya membaca API suggestions yang sama.
 */
function SuggestionsQueue({
  t,
  locale,
  tenantId,
  agents,
  hideHeading = false,
}: {
  t: Translate;
  locale: Locale;
  tenantId: string;
  agents: AgentResponse[];
  /** Tab hub (12E) sudah memberi label seksi — judul antrean disembunyikan. */
  hideHeading?: boolean;
}) {
  const { refresh: refreshBadge } = usePendingApprovals();
  const [drafts, setDrafts] = useState<AgentSuggestionResponse[]>([]);
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.suggestions.list(tenantId, { status: "pending" });
      setDrafts(list);
      // Sinkronkan badge navigasi dengan data antrean yang BARU dimuat:
      // provider badge hanya memuat ulang saat workspace berganti atau
      // setelah approve/reject, jadi draf yang tiba saat pemilik berada
      // di halaman lain tidak pernah menaikkan badge (bug QA-1 — antrean
      // terlihat berisi tetapi badge tetap kosong). Pola yang sama
      // dengan InboxPage menyinkronkan badge unread dari daftarnya.
      void refreshBadge();
      // Nama kontak bersifat pelengkap: ambil per kontak unik, abaikan gagal.
      const uniqueContactIds = [
        ...new Set(
          list
            .map((s) => s.contactId)
            .filter((id): id is string => id !== null),
        ),
      ];
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
      setDrafts([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId, t, refreshBadge]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (
    suggestion: AgentSuggestionResponse,
    action: "approve" | "reject",
  ) => {
    if (actingId) return;
    setActingId(suggestion.id);
    setError(null);
    try {
      if (action === "approve") {
        await api.suggestions.approve(tenantId, suggestion.id);
      } else {
        await api.suggestions.reject(tenantId, suggestion.id);
      }
      await load();
      void refreshBadge();
    } catch (err) {
      setError(translateApiError(t, err));
      await load();
      void refreshBadge();
    } finally {
      setActingId(null);
    }
  };

  const agentName = (agentId: string) =>
    agents.find((a) => a.id === agentId)?.name ?? shortId(agentId);

  return (
    <div className={hideHeading ? undefined : "mt-8"}>
      {hideHeading ? null : (
        <>
          <h2 className="text-lg font-bold text-ink">{t("agents.draftsTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("agents.draftsSubtitle")}</p>
        </>
      )}
      <FieldError message={error} />
      {loading ? (
        <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
      ) : drafts.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-line bg-surface p-6">
          <p className="text-sm text-muted">{t("agents.draftsEmpty")}</p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {drafts.map((suggestion) => {
            const tools = proposedToolNames(suggestion);
            return (
              <li
                key={suggestion.id}
                className="rounded-xl border border-line bg-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span>
                    {t("agents.draftAgentLabel")}: {agentName(suggestion.agentId)}
                  </span>
                  <span>
                    {t("agents.draftConversationLabel")}:{" "}
                    {shortId(suggestion.conversationId)}
                  </span>
                  {suggestion.contactId ? (
                    <span>
                      {t("agents.draftContactLabel")}:{" "}
                      {contactNames[suggestion.contactId] ??
                        shortId(suggestion.contactId)}
                    </span>
                  ) : null}
                  <span>{formatDateTime(suggestion.createdAt, locale)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-ink">
                  {suggestion.suggestedText}
                </p>
                {tools.length > 0 ? (
                  <p className="mt-2 text-xs text-muted">
                    {t("agents.draftToolsLabel")}: {tools.join(", ")}
                  </p>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={actingId === suggestion.id}
                    onClick={() => void act(suggestion, "approve")}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                  >
                    {actingId === suggestion.id
                      ? t("agents.processing")
                      : t("agents.approveButton")}
                  </button>
                  <button
                    type="button"
                    disabled={actingId === suggestion.id}
                    onClick={() => void act(suggestion, "reject")}
                    className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-60"
                  >
                    {t("agents.rejectButton")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Seksi Antrean Saran untuk hub /agents (Fase 12E): penjaga status
 * workspace + daftar agent (untuk nama pada kartu draf) lalu antrean
 * itu sendiri. Judul seksi datang dari label tab hub.
 */
export function SuggestionsSection({ t, locale }: AgentsPageProps) {
  const { status, tenants, active, reload } = useWorkspace();
  const tenantId = active?.id ?? null;
  const [agents, setAgents] = useState<AgentResponse[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    // Nama agent hanya pelengkap label kartu draf — gagal memuatnya
    // tidak boleh menggagalkan antrean (fallback ID ringkas di kartu).
    api.agents
      .list(tenantId)
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (status === "loading") {
    return (
      <section>
        <p className="text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <div className="rounded-xl border border-line bg-surface p-6">
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
        <div className="rounded-xl border border-dashed border-line bg-surface p-6">
          <h2 className="text-lg font-semibold text-ink">{t("workspace.emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted">{t("workspace.emptyBody")}</p>
        </div>
      </section>
    );
  }

  return (
    <SuggestionsQueue
      t={t}
      locale={locale}
      tenantId={active.id}
      agents={agents}
      hideHeading
    />
  );
}
