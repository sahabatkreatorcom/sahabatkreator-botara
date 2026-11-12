/**
 * Seksi Template WhatsApp (Fase 10A) — cermin lokal template resmi Meta
 * per akun WhatsApp: sinkron dari Meta, buat baru (formulir sederhana),
 * perbaiki template REJECTED (G10, formulir yang sama terisi awal),
 * hapus (dua langkah). Sengaja tinggal di halaman Broadcasts karena
 * konsumen utamanya adalah broadcast; Channels tetap halaman koneksi.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  ChannelAccountResponse,
  CreateWhatsAppTemplateRequest,
  UpdateWhatsAppTemplateRequest,
  WhatsAppTemplateResponse,
} from "@sahabat-kreator/contracts";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { TemplateStatusChip } from "./chips";
import type { Translate } from "./types";

export interface WhatsAppTemplatesSectionProps {
  t: Translate;
  tenantId: string | null;
  canManage: boolean;
}

export interface TemplateButtonDraft {
  type: "URL" | "QUICK_REPLY";
  text: string;
  url: string;
}

type RawComponent = Record<string, unknown>;

function componentText(comp: RawComponent | undefined): string {
  return typeof comp?.text === "string" ? comp.text : "";
}

/**
 * Apakah template bisa diwakili formulir sederhana ini (G10)? Hanya
 * bila komponennya HEADER teks polos (tanpa variabel), BODY, FOOTER,
 * dan tombol URL/QUICK_REPLY (maks 3). Template dengan header media
 * atau tombol jenis lain tidak ditawari tombol Perbaiki — memaksanya
 * lewat formulir ini akan membuang komponen yang tidak terbaca.
 */
export function isFormEditableTemplate(tpl: WhatsAppTemplateResponse): boolean {
  const comps = tpl.components as RawComponent[];
  let hasBody = false;
  for (const comp of comps) {
    if (comp.type === "BODY") {
      hasBody = true;
    } else if (comp.type === "HEADER") {
      if (comp.format !== undefined && comp.format !== "TEXT") return false;
      if (/\{\{\d+\}\}/.test(componentText(comp))) return false;
    } else if (comp.type === "FOOTER") {
      // teks polos — selalu terwakili
    } else if (comp.type === "BUTTONS") {
      const buttons = Array.isArray(comp.buttons)
        ? (comp.buttons as RawComponent[])
        : null;
      if (!buttons || buttons.length > 3) return false;
      if (buttons.some((b) => b.type !== "URL" && b.type !== "QUICK_REPLY")) {
        return false;
      }
    } else {
      return false;
    }
  }
  return hasBody;
}

/** Isi awal formulir perbaiki dari komponen Meta apa adanya. */
function prefillFromTemplate(tpl: WhatsAppTemplateResponse): {
  header: string;
  body: string;
  examples: string;
  footer: string;
  buttons: TemplateButtonDraft[];
} {
  const comps = tpl.components as RawComponent[];
  const header = comps.find((c) => c.type === "HEADER");
  const body = comps.find((c) => c.type === "BODY");
  const footer = comps.find((c) => c.type === "FOOTER");
  const buttonsComp = comps.find((c) => c.type === "BUTTONS");
  const example = (body?.example ?? null) as {
    body_text?: string[][];
  } | null;
  const exampleRow = example?.body_text?.[0];
  const buttons = (
    Array.isArray(buttonsComp?.buttons)
      ? (buttonsComp.buttons as RawComponent[])
      : []
  ).map((b) => ({
    type: (b.type === "URL" ? "URL" : "QUICK_REPLY") as "URL" | "QUICK_REPLY",
    text: typeof b.text === "string" ? b.text : "",
    url: typeof b.url === "string" ? b.url : "",
  }));
  return {
    header: componentText(header),
    body: componentText(body),
    examples: Array.isArray(exampleRow) ? exampleRow.join(", ") : "",
    footer: componentText(footer),
    buttons,
  };
}

export function WhatsAppTemplatesSection({
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
  /** Id template REJECTED yang sedang diperbaiki (null = mode buat). */
  const [editingId, setEditingId] = useState<string | null>(null);

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

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setTplName("");
    setTplHeader("");
    setTplBody("");
    setTplExamples("");
    setTplFooter("");
    setTplButtons([]);
  };

  /** Buka formulir dalam mode perbaiki untuk satu template REJECTED. */
  const startEdit = (tpl: WhatsAppTemplateResponse) => {
    const prefill = prefillFromTemplate(tpl);
    setTplName(tpl.name);
    setTplLanguage(tpl.language);
    setTplCategory(
      tpl.category === "MARKETING" || tpl.category === "AUTHENTICATION"
        ? tpl.category
        : "UTILITY",
    );
    setTplHeader(prefill.header);
    setTplBody(prefill.body);
    setTplExamples(prefill.examples);
    setTplFooter(prefill.footer);
    setTplButtons(prefill.buttons);
    setEditingId(tpl.id);
    setConfirmingDelete(null);
    setError(null);
    setNotice(null);
    setShowForm(true);
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
      const formFields = {
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
      if (editingId) {
        // Mode perbaiki: nama & bahasa tidak dikirim (tidak bisa diubah
        // di Meta); server menegakkan status harus REJECTED.
        const input: UpdateWhatsAppTemplateRequest = formFields;
        await api.whatsappTemplates.update(tenantId, editingId, input);
        setNotice(t("whatsappTemplates.updatedNote"));
      } else {
        const input: CreateWhatsAppTemplateRequest = {
          channelAccountId,
          name: tplName.trim(),
          language: tplLanguage.trim(),
          ...formFields,
        };
        await api.whatsappTemplates.create(tenantId, input);
        setNotice(t("whatsappTemplates.createdNote"));
      }
      resetForm();
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
                  onClick={() => {
                    if (showForm) resetForm();
                    else setShowForm(true);
                  }}
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
                {editingId
                  ? t("whatsappTemplates.editFormTitle")
                  : t("whatsappTemplates.formTitle")}
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
                    disabled={!!editingId}
                    onChange={(e) => setTplName(e.target.value)}
                    placeholder={t("whatsappTemplates.namePlaceholder")}
                  />
                  <p className="mt-1 text-xs text-muted">
                    {editingId
                      ? t("whatsappTemplates.nameLockedHint")
                      : t("whatsappTemplates.nameHint")}
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
                    disabled={!!editingId}
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
                  {editingId
                    ? t("whatsappTemplates.saveEditAction")
                    : t("whatsappTemplates.saveAction")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => resetForm()}
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
                  {/* Alasan dari Meta (mis. kenapa ditolak) — tanpa ini
                      chip "Ditolak" tidak memberi tahu apa yang harus
                      diperbaiki. */}
                  {tpl.statusReason ? (
                    <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                      <span className="font-medium text-ink">
                        {t("whatsappTemplates.statusReasonLabel")}:
                      </span>{" "}
                      {tpl.statusReason}
                    </p>
                  ) : null}
                  {canManage && channelConnected ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {tpl.status === "REJECTED" &&
                      isFormEditableTemplate(tpl) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => startEdit(tpl)}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
                        >
                          {t("whatsappTemplates.editAction")}
                        </button>
                      ) : null}
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
