import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { ApiClientError } from "../api/client";
import { translateApiError } from "../api/errorText";
import {
  AuthLayout,
  FieldError,
  inputClassName,
  primaryButtonClassName,
} from "../components/AuthLayout";
import { LegalLinks } from "../components/LegalLinks";
import { PasswordInput } from "../components/PasswordInput";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface ResetPasswordPageProps {
  t: Translate;
  locale: Locale;
  controls: ReactNode;
  onNavigate: (path: string) => void;
}

/**
 * Halaman /reset-password (Fase 14C) — tujuan tautan email reset.
 * Server auth memverifikasi token dari tautan email lalu me-redirect ke
 * sini dengan `?token=`; token buruk/kedaluwarsa tiba sebagai
 * `?error=INVALID_TOKEN` (atau ditolak endpoint penukar dengan kode
 * yang sama) dan ditampilkan sebagai keadaan tidak-valid dengan jalan
 * meminta tautan baru — tidak ada tebakan status di sisi klien.
 *
 * Token dibaca SEKALI saat mount lalu segera dibuang dari address bar
 * (`history.replaceState`). Alasannya konkret: token reset yang masih
 * terpampang di URL ikut terkirim sebagai `Referer` ke setiap sumber
 * luar yang halaman ini muat, tersimpan di riwayat peramban, dan
 * terlihat siapa pun yang melihat layar. Nilainya tetap hidup di state
 * React sampai formulir dikirim, jadi tidak ada yang hilang.
 */
export function ResetPasswordPage({ t, controls, onNavigate }: ResetPasswordPageProps) {
  const [token] = useState(
    () => new URLSearchParams(window.location.search).get("token") ?? "",
  );
  const [invalid, setInvalid] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("error") === "INVALID_TOKEN" || !params.get("token");
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return setError(t("auth.passwordRequired"));
    if (password.length < 8) return setError(t("errors.passwordTooShort"));
    if (password !== confirm) return setError(t("auth.passwordMismatch"));
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "INVALID_TOKEN") {
        setInvalid(true);
      } else {
        setError(translateApiError(t, err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (invalid) {
    return (
      <AuthLayout
        t={t}
        title={t("auth.resetInvalidTitle")}
        subtitle={t("auth.resetInvalidBody")}
        controls={controls}
        footer={<LegalLinks t={t} onNavigate={onNavigate} />}
      >
        <button
          type="button"
          onClick={() => onNavigate("/forgot-password")}
          className={primaryButtonClassName}
        >
          {t("auth.resetRequestNew")}
        </button>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout
        t={t}
        title={t("auth.resetSuccessTitle")}
        subtitle={t("auth.resetSuccessBody")}
        controls={controls}
        footer={<LegalLinks t={t} onNavigate={onNavigate} />}
      >
        <button
          type="button"
          onClick={() => onNavigate("/login")}
          className={primaryButtonClassName}
        >
          {t("auth.backToSignIn")}
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      t={t}
      title={t("auth.resetTitle")}
      subtitle={t("auth.resetSubtitle")}
      controls={controls}
      footer={<LegalLinks t={t} onNavigate={onNavigate} />}
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="reset-password" className="mb-1 block text-sm font-medium text-ink">
            {t("auth.newPasswordLabel")}
          </label>
          <PasswordInput
            t={t}
            id="reset-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("auth.passwordPlaceholder")}
            className={inputClassName}
            autoComplete="new-password"
          />
        </div>
        <div>
          <label htmlFor="reset-password-confirm" className="mb-1 block text-sm font-medium text-ink">
            {t("auth.confirmPasswordLabel")}
          </label>
          <PasswordInput
            t={t}
            id="reset-password-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={t("auth.passwordPlaceholder")}
            className={inputClassName}
            autoComplete="new-password"
          />
        </div>
        <FieldError message={error} />
        <button type="submit" disabled={submitting} className={primaryButtonClassName}>
          {submitting ? t("auth.resetSaving") : t("auth.resetSubmit")}
        </button>
      </form>
    </AuthLayout>
  );
}
