import { useState, type FormEvent, type ReactNode } from "react";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { useAuth } from "../auth/AuthProvider";
import { takeReturnTo } from "../navigation/returnTo";
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

interface LoginPageProps {
  t: Translate;
  locale: Locale;
  controls: ReactNode;
  /** Navigasi antar-halaman auth & masuk shell (router path sederhana di App). */
  onNavigate: (path: string) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Halaman /login (Fase 1C) — di luar shell, tanpa sidebar/bottom bar. */
export function LoginPage({ t, controls, onNavigate }: LoginPageProps) {
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return setError(t("auth.emailRequired"));
    if (!EMAIL_PATTERN.test(trimmedEmail)) return setError(t("auth.emailInvalid"));
    if (!password) return setError(t("auth.passwordRequired"));
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.signIn(trimmedEmail, password);
      await refresh();
      // Deep-link yang dibuka sebelum login (Fase 6E) membawa penggunanya
      // kembali ke tujuan awal; tanpa tujuan tersimpan → Dashboard.
      onNavigate(takeReturnTo() ?? "/");
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      t={t}
      title={t("auth.signInTitle")}
      subtitle={t("auth.signInSubtitle")}
      controls={controls}
      footer={<LegalLinks t={t} onNavigate={onNavigate} />}
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="login-email" className="mb-1 block text-sm font-medium text-ink">
            {t("auth.emailLabel")}
          </label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("auth.emailPlaceholder")}
            className={inputClassName}
            autoComplete="email"
          />
        </div>
        <div>
          <label htmlFor="login-password" className="mb-1 block text-sm font-medium text-ink">
            {t("auth.passwordLabel")}
          </label>
          <PasswordInput
            t={t}
            id="login-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("auth.passwordPlaceholder")}
            className={inputClassName}
            autoComplete="current-password"
          />
        </div>
        <FieldError message={error} />
        <button type="submit" disabled={submitting} className={primaryButtonClassName}>
          {submitting ? t("auth.signingIn") : t("auth.signInButton")}
        </button>
        <p className="text-center text-sm">
          <button
            type="button"
            onClick={() => onNavigate("/forgot-password")}
            className="font-medium text-accent"
          >
            {t("auth.forgotPassword")}
          </button>
        </p>
      </form>
      <p className="mt-5 text-center text-sm text-muted">
        {t("auth.noAccount")}{" "}
        <button
          type="button"
          onClick={() => onNavigate("/register")}
          className="font-semibold text-accent"
        >
          {t("auth.toRegister")}
        </button>
      </p>
    </AuthLayout>
  );
}
