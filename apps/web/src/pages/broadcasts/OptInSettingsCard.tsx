/**
 * Kartu "Opt-in Broadcast" (Fase 13C) di halaman Broadcasts:
 * pengaturan mesin opt-in per tenant — kata kunci opt-in, teks
 * konfirmasi (opsional), kata opt-out tambahan di atas kata bawaan
 * sistem (ditampilkan hanya-baca agar aturannya transparan).
 */
import { useEffect, useState } from "react";
import type { OptInSettingsResponse } from "@sahabat-kreator/contracts";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { splitCommaList } from "./chips";
import type { Translate } from "./types";

export function OptInSettingsCard({
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
