import { useState, type FormEvent } from "react";
import type { TranslationKey } from "@sahabat-kreator/i18n";
import { translateApiError } from "../api/errorText";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { FieldError, inputClassName } from "./AuthLayout";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface CreateWorkspaceFormProps {
  t: Translate;
  /** Dipanggil setelah workspace berhasil dibuat (mis. menutup form lipat). */
  onCreated?: () => void;
  /**
   * Bila diisi, tombol Batal dirender di samping tombol Buat dan
   * menekannya menutup form TANPA membuat apa pun. Hanya untuk
   * pemakaian form lipat (pemilih sidebar); pemakaian konten utama
   * (keadaan kosong Dashboard) tidak mengisinya.
   */
  onCancel?: () => void;
}

/** Form buat workspace — dipakai keadaan kosong Dashboard & pemilih sidebar. */
export function CreateWorkspaceForm({ t, onCreated, onCancel }: CreateWorkspaceFormProps) {
  const { create } = useWorkspace();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("workspace.nameRequired"));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await create(trimmed);
      setName("");
      onCreated?.();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="workspace-name" className="mb-1 block text-sm font-medium text-ink">
          {t("workspace.nameLabel")}
        </label>
        <input
          id="workspace-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("workspace.namePlaceholder")}
          className={inputClassName}
          autoComplete="off"
        />
      </div>
      <FieldError message={error} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? t("workspace.creating") : t("workspace.createButton")}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t("common.cancel")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Pemilih workspace di sidebar desktop & MoreSheet mobile. */
export function WorkspaceSwitcher({ t }: { t: Translate }) {
  const { status, tenants, active, select } = useWorkspace();
  const [formOpen, setFormOpen] = useState(false);

  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
        {t("workspace.label")}
      </div>
      {status === "loading" ? (
        <p className="text-sm text-muted">{t("workspace.loading")}</p>
      ) : tenants.length === 0 ? (
        <p className="text-sm text-muted">{t("workspace.none")}</p>
      ) : (
        <select
          aria-label={t("workspace.label")}
          value={active?.id ?? ""}
          onChange={(e) => select(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink"
        >
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.name}
            </option>
          ))}
        </select>
      )}
      {formOpen ? (
        <div className="mt-3">
          <CreateWorkspaceForm
            t={t}
            onCreated={() => setFormOpen(false)}
            onCancel={() => setFormOpen(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="mt-2 text-sm font-medium text-accent"
        >
          + {t("workspace.createMore")}
        </button>
      )}
    </div>
  );
}
