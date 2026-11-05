import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChannelAccountResponse,
  GrowthLinkAttributedContact,
  GrowthLinkResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface GrowthPageProps {
  t: Translate;
  locale: Locale;
}

type Provider = ChannelAccountResponse["provider"];

function providerLabel(t: Translate, provider: Provider): string {
  return t(`inbox.providers.${provider}` as TranslationKey);
}

function channelOptionLabel(channel: ChannelAccountResponse): string {
  const handle =
    channel.provider === "telegram"
      ? channel.botUsername
      : channel.publicHandle;
  return `${channel.displayName ?? handle ?? channel.externalId}${handle ? ` (@${handle.replace(/^@/, "")})` : ""}`;
}

function linkChannelLabel(t: Translate, link: GrowthLinkResponse): string {
  if (link.kind === "picker") {
    return link.pickerChannels
      .map((ch) => providerLabel(t, ch.provider))
      .join(" · ");
  }
  if (!link.channel) return "—";
  return `${providerLabel(t, link.channel.provider)} — ${link.channel.displayName ?? link.channel.publicHandle ?? link.channel.botUsername ?? ""}`;
}

interface FormState {
  label: string;
  slug: string;
  kind: "single" | "picker";
  channelAccountId: string;
  pickerChannelIds: string[];
  autoTag: string;
  prefillText: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  label: "",
  slug: "",
  kind: "single",
  channelAccountId: "",
  pickerChannelIds: [],
  autoTag: "",
  prefillText: "",
  isActive: true,
};

/**
 * Halaman Growth Tools (Fase 13B): tautan publik per channel
 * (/go/:slug) + landing pemilih channel + analitik per tautan.
 * Daftar menampilkan statistik turunan event (klik / tampilan picker /
 * konversi); kontak teratribusi terakhir dimuat per tautan saat
 * panelnya dibuka. Mutasi owner/admin (selaras API); member membaca.
 * QR digenerate DI KLIEN dengan library `qrcode` yang di-import malas
 * hanya saat modal QR dibuka (pola code-splitting 13A) — tidak ada
 * panggilan layanan QR pihak ketiga dan URL publik tidak meninggalkan
 * browser.
 *
 * Catatan kejujuran produk yang tampil apa adanya di halaman ini:
 * tautan WhatsApp hanya mencatat klik — wa.me tidak punya payload
 * kedatangan, jadi atribusi kontak tidak dijanjikan untuk WA.
 */
export function GrowthPage({ t, locale }: GrowthPageProps) {
  const { status, active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";

  const [links, setLinks] = useState<GrowthLinkResponse[]>([]);
  const [channels, setChannels] = useState<ChannelAccountResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [qrLink, setQrLink] = useState<GrowthLinkResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const [contactsLinkId, setContactsLinkId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<GrowthLinkAttributedContact[]>([]);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [contactsLoading, setContactsLoading] = useState(false);

  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const [linkRes, channelList] = await Promise.all([
        api.growthLinks.list(tenantId),
        api.channels.list(tenantId),
      ]);
      if (seq !== requestSeq.current) return;
      setLinks(linkRes.links);
      setChannels(channelList.filter((ch) => ch.status === "connected"));
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(translateApiError(t, err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const publicUrl = (link: GrowthLinkResponse): string =>
    `${typeof window !== "undefined" ? window.location.origin : ""}${link.publicPath}`;

  const copyUrl = async (link: GrowthLinkResponse) => {
    try {
      await navigator.clipboard.writeText(publicUrl(link));
      setCopiedSlug(link.slug);
      setTimeout(() => setCopiedSlug((cur) => (cur === link.slug ? null : cur)), 2000);
    } catch {
      /* clipboard tidak tersedia — URL tetap terlihat untuk disalin manual */
    }
  };

  const openQr = async (link: GrowthLinkResponse) => {
    setQrLink(link);
    setQrDataUrl(null);
    try {
      const QRCode = (await import("qrcode")).default;
      const url = await QRCode.toDataURL(publicUrl(link), {
        width: 320,
        margin: 2,
      });
      setQrDataUrl(url);
    } catch {
      setQrDataUrl(null);
    }
  };

  const toggleContacts = async (link: GrowthLinkResponse) => {
    if (contactsLinkId === link.id) {
      setContactsLinkId(null);
      return;
    }
    if (!tenantId) return;
    setContactsLinkId(link.id);
    setContacts([]);
    setContactsError(null);
    setContactsLoading(true);
    try {
      const res = await api.growthLinks.attributedContacts(tenantId, link.id);
      setContacts(res.contacts);
    } catch (err) {
      setContactsError(translateApiError(t, err));
    } finally {
      setContactsLoading(false);
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      channelAccountId: channels[0]?.id ?? "",
    });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (link: GrowthLinkResponse) => {
    setEditingId(link.id);
    setForm({
      label: link.label,
      slug: link.slug,
      kind: link.kind,
      channelAccountId: link.channelAccountId ?? "",
      pickerChannelIds: link.pickerChannelIds,
      autoTag: link.autoTag ?? "",
      prefillText: link.prefillText ?? "",
      isActive: link.isActive,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const submitForm = async () => {
    if (!tenantId || saving) return;
    const label = form.label.trim();
    const channelOk =
      form.kind === "single"
        ? form.channelAccountId !== ""
        : form.pickerChannelIds.length >= 2;
    if (!label || !channelOk) {
      setFormError(t("growth.fieldRequired"));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        await api.growthLinks.update(tenantId, editingId, {
          label,
          ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
          ...(form.kind === "single"
            ? { channelAccountId: form.channelAccountId }
            : { pickerChannelIds: form.pickerChannelIds }),
          autoTag: form.autoTag.trim() ? form.autoTag.trim() : null,
          prefillText: form.prefillText.trim() ? form.prefillText.trim() : null,
          isActive: form.isActive,
        });
      } else {
        await api.growthLinks.create(tenantId, {
          kind: form.kind,
          label,
          ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
          ...(form.kind === "single"
            ? { channelAccountId: form.channelAccountId }
            : { pickerChannelIds: form.pickerChannelIds }),
          autoTag: form.autoTag.trim() ? form.autoTag.trim() : null,
          prefillText: form.prefillText.trim() ? form.prefillText.trim() : null,
        });
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (link: GrowthLinkResponse) => {
    if (!tenantId || busyId) return;
    setBusyId(link.id);
    try {
      await api.growthLinks.update(tenantId, link.id, { isActive: !link.isActive });
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusyId(null);
    }
  };

  const removeLink = async (link: GrowthLinkResponse) => {
    if (!tenantId || busyId) return;
    setBusyId(link.id);
    try {
      await api.growthLinks.remove(tenantId, link.id);
      setConfirmingDelete(null);
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusyId(null);
    }
  };

  if (status === "loading") {
    return <p className="text-sm text-muted">{t("common.loading")}</p>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("growth.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t("growth.subtitle")}</p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {t("growth.createButton")}
          </button>
        ) : null}
      </div>

      <p className="mt-4 rounded-lg border border-line bg-surface p-3 text-xs text-muted">
        {t("growth.whatsappNote")}
      </p>

      {error ? (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {loading && links.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : links.length === 0 ? (
        <div className="mt-6 rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-semibold">{t("growth.emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">{t("growth.emptyBody")}</p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {links.map((link) => (
            <li key={link.id} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{link.label}</span>
                    <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 text-xs font-medium text-muted">
                      {link.kind === "picker" ? t("growth.kindPicker") : t("growth.kindSingle")}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${link.isActive ? "bg-success/15 text-success" : "bg-elevated text-muted"}`}
                    >
                      {link.isActive ? t("growth.statusActive") : t("growth.statusInactive")}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted">{linkChannelLabel(t, link)}</p>
                  <p className="mt-1 break-all font-mono text-sm text-accent">{publicUrl(link)}</p>
                </div>
                <div className="flex gap-4 text-center">
                  <div>
                    <div className="text-lg font-bold">{link.stats.clicks}</div>
                    <div className="text-xs text-muted">{t("growth.statsClicks")}</div>
                  </div>
                  {link.kind === "picker" ? (
                    <div>
                      <div className="text-lg font-bold">{link.stats.pickerViews}</div>
                      <div className="text-xs text-muted">{t("growth.statsPickerViews")}</div>
                    </div>
                  ) : null}
                  <div>
                    <div className="text-lg font-bold">{link.stats.conversions}</div>
                    <div className="text-xs text-muted">{t("growth.statsConversions")}</div>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copyUrl(link)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  {copiedSlug === link.slug ? t("growth.copiedLabel") : t("growth.copyButton")}
                </button>
                <button
                  type="button"
                  onClick={() => void openQr(link)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  {t("growth.qrButton")}
                </button>
                <a
                  href={link.publicPath}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  {link.kind === "picker" ? t("growth.previewButton") : t("growth.openButton")}
                </a>
                <button
                  type="button"
                  onClick={() => void toggleContacts(link)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  {t("growth.contactsTitle")}
                </button>
                {canManage ? (
                  <>
                    <button
                      type="button"
                      onClick={() => openEdit(link)}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm"
                    >
                      {t("growth.editButton")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === link.id}
                      onClick={() => void toggleActive(link)}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      {link.isActive ? t("growth.deactivateButton") : t("growth.activateButton")}
                    </button>
                    {confirmingDelete === link.id ? (
                      <>
                        <span className="self-center text-sm text-danger">
                          {t("growth.deleteBody", { label: link.label })}
                        </span>
                        <button
                          type="button"
                          disabled={busyId === link.id}
                          onClick={() => void removeLink(link)}
                          className="rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          {busyId === link.id ? t("growth.deleting") : t("growth.deleteButton")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(null)}
                          className="rounded-lg border border-line px-3 py-1.5 text-sm"
                        >
                          {t("common.cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(link.id)}
                        className="rounded-lg border border-line px-3 py-1.5 text-sm text-danger"
                      >
                        {t("growth.deleteButton")}
                      </button>
                    )}
                  </>
                ) : null}
              </div>

              {contactsLinkId === link.id ? (
                <div className="mt-3 rounded-lg bg-elevated/60 p-3">
                  <p className="text-sm font-semibold">{t("growth.contactsTitle")}</p>
                  {contactsLoading ? (
                    <p className="mt-1 text-sm text-muted">{t("common.loading")}</p>
                  ) : contactsError ? (
                    <p className="mt-1 text-sm text-danger">{contactsError}</p>
                  ) : contacts.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">{t("growth.contactsEmpty")}</p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {contacts.map((contact) => (
                        <li key={contact.contactId} className="flex flex-wrap justify-between gap-2 text-sm">
                          <span>{contact.name}</span>
                          <span className="text-muted">
                            {contact.source ?? ""} · {formatDateTime(contact.convertedAt, locale)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {formOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
          <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 sm:rounded-2xl">
            <h2 className="text-lg font-bold">
              {editingId ? t("growth.formEditTitle") : t("growth.formCreateTitle")}
            </h2>
            {channels.length === 0 ? (
              <p className="mt-3 rounded-lg border border-line bg-elevated/60 p-3 text-sm text-muted">
                {t("growth.noChannels")}
              </p>
            ) : null}
            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="text-sm font-medium">{t("growth.labelLabel")}</span>
                <input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder={t("growth.labelPlaceholder")}
                  className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium">{t("growth.slugLabel")}</span>
                <div className="mt-1 flex items-center gap-1">
                  <span className="text-sm text-muted">/go/</span>
                  <input
                    value={form.slug}
                    onChange={(e) => setForm({ ...form, slug: e.target.value })}
                    placeholder={t("growth.slugPlaceholder")}
                    className="w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm"
                  />
                </div>
                <span className="mt-1 block text-xs text-muted">{t("growth.slugHint")}</span>
              </label>
              {!editingId ? (
                <fieldset>
                  <legend className="text-sm font-medium">{t("growth.kindLabel")}</legend>
                  <div className="mt-1 flex gap-2">
                    {(["single", "picker"] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => setForm({ ...form, kind })}
                        className={`rounded-lg border px-3 py-1.5 text-sm ${form.kind === kind ? "border-accent bg-accent/10 text-accent" : "border-line"}`}
                      >
                        {kind === "single" ? t("growth.kindSingle") : t("growth.kindPicker")}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {form.kind === "single" ? (
                <label className="block">
                  <span className="text-sm font-medium">{t("growth.channelLabel")}</span>
                  <select
                    value={form.channelAccountId}
                    onChange={(e) => setForm({ ...form, channelAccountId: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
                  >
                    <option value="">—</option>
                    {channels.map((ch) => (
                      <option key={ch.id} value={ch.id}>
                        {providerLabel(t, ch.provider)} — {channelOptionLabel(ch)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <fieldset>
                  <legend className="text-sm font-medium">{t("growth.pickerChannelsLabel")}</legend>
                  <div className="mt-1 space-y-1">
                    {channels.map((ch) => (
                      <label key={ch.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={form.pickerChannelIds.includes(ch.id)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              pickerChannelIds: e.target.checked
                                ? [...form.pickerChannelIds, ch.id]
                                : form.pickerChannelIds.filter((id) => id !== ch.id),
                            })
                          }
                        />
                        {providerLabel(t, ch.provider)} — {channelOptionLabel(ch)}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <label className="block">
                <span className="text-sm font-medium">{t("growth.autoTagLabel")}</span>
                <input
                  value={form.autoTag}
                  onChange={(e) => setForm({ ...form, autoTag: e.target.value })}
                  placeholder={t("growth.autoTagPlaceholder")}
                  className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-xs text-muted">{t("growth.autoTagHint")}</span>
              </label>
              <label className="block">
                <span className="text-sm font-medium">{t("growth.prefillLabel")}</span>
                <input
                  value={form.prefillText}
                  onChange={(e) => setForm({ ...form, prefillText: e.target.value })}
                  placeholder={t("growth.prefillPlaceholder")}
                  className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-xs text-muted">{t("growth.prefillHint")}</span>
              </label>
              {editingId ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  />
                  {t("growth.isActiveLabel")}
                </label>
              ) : null}
              {formError ? <p className="text-sm text-danger">{formError}</p> : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="rounded-lg border border-line px-4 py-2 text-sm"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={saving || channels.length === 0}
                  onClick={() => void submitForm()}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {saving ? t("growth.saving") : editingId ? t("growth.saveButton") : t("growth.createSubmit")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {qrLink ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 text-center">
            <h2 className="text-lg font-bold">{t("growth.qrTitle")}</h2>
            <p className="mt-1 break-all font-mono text-xs text-muted">{publicUrl(qrLink)}</p>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt={t("growth.qrTitle")} className="mx-auto mt-4 h-64 w-64" />
            ) : (
              <p className="mt-4 text-sm text-muted">{t("common.loading")}</p>
            )}
            <p className="mt-3 text-xs text-muted">{t("growth.qrHint")}</p>
            <button
              type="button"
              onClick={() => setQrLink(null)}
              className="mt-4 rounded-lg border border-line px-4 py-2 text-sm"
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
