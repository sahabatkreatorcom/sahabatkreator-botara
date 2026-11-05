import { useState, type FormEvent, type ReactNode } from "react";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { useAuth } from "../auth/AuthProvider";
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

interface RegisterPageProps {
  t: Translate;
  locale: Locale;
  controls: ReactNode;
  onNavigate: (path: string) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Halaman /register (Fase 1C) — sign-up Better Auth langsung membuat sesi. */
export function RegisterPage({ t, controls, onNavigate }: RegisterPageProps) {
  const { refresh } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) return setError(t("auth.nameRequired"));
    if (!trimmedEmail) return setError(t("auth.emailRequired"));
    if (!EMAIL_PATTERN.test(trimmedEmail)) return setError(t("auth.emailInvalid"));
    if (!password) return setError(t("auth.passwordRequired"));
    if (password.length < 8) return setError(t("errors.passwordTooShort"));
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.signUp(trimmedName, trimmedEmail, password);
      await refresh();
      onNavigate("/");
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      t={t}
      title={t("auth.signUpTitle")}
      subtitle={t("auth.signUpSubtitle")}
      controls={controls}
      footer={<LegalLinks t={t} onNavigate={onNavigate} />}
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="register-name" className="mb-1 block text-sm font-medium text-ink">
            {t("auth.nameLabel")}
          </label>
          <input
            id="register-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("auth.namePlaceholder")}
            className={inputClassName}
            autoComplete="name"
          />
        </div>
        <div>
          <label htmlFor="register-email" className="mb-1 block text-sm font-medium text-ink">
            {t("auth.emailLabel")}
          </label>
          <input
            id="register-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("auth.emailPlaceholder")}
            className={inputClassName}
            autoComplete="email"
          />
        </div>
        <div>
          <label htmlFor="register-password" className="mb-1 block text-sm font-medium text-ink">
            {t("auth.passwordLabel")}
          </label>
          <PasswordInput
            t={t}
            id="register-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("auth.passwordPlaceholder")}
            className={inputClassName}
            autoComplete="new-password"
          />
        </div>
        <FieldError message={error} />
        <button type="submit" disabled={submitting} className={primaryButtonClassName}>
          {submitting ? t("auth.creatingAccount") : t("auth.signUpButton")}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-muted">
        {t("auth.haveAccount")}{" "}
        <button
          type="button"
          onClick={() => onNavigate("/login")}
          className="font-semibold text-accent"
        >
          {t("auth.toLogin")}
        </button>
      </p>
    </AuthLayout>
  );
}
