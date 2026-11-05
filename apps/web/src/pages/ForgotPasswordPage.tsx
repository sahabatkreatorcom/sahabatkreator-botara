import { useState, type FormEvent, type ReactNode } from "react";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import {
  AuthLayout,
  FieldError,
  inputClassName,
  primaryButtonClassName,
} from "../components/AuthLayout";
import { LegalLinks } from "../components/LegalLinks";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface ForgotPasswordPageProps {
  t: Translate;
  locale: Locale;
  controls: ReactNode;
  onNavigate: (path: string) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Halaman /forgot-password (Fase 14C) — di luar shell, pola LoginPage.
 * Mengirim permintaan reset ke Better Auth; server menjawab sukses
 * untuk alamat apa pun (anti-enumerasi) dan email hanya benar-benar
 * terkirim bila akunnya ada + Resend terkonfigurasi — jadi keadaan
 * "terkirim" di sini selalu berbunyi kondisional, tidak membedakan
 * akun ada/tidak.
 */
export function ForgotPasswordPage({ t, controls, onNavigate }: ForgotPasswordPageProps) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return setError(t("auth.emailRequired"));
    if (!EMAIL_PATTERN.test(trimmedEmail)) return setError(t("auth.emailInvalid"));
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.requestPasswordReset(
        trimmedEmail,
        `${window.location.origin}/reset-password`,
      );
      setSent(true);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout
        t={t}
        title={t("auth.forgotSentTitle")}
        subtitle={t("auth.forgotSentBody")}
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
      title={t("auth.forgotTitle")}
      subtitle={t("auth.forgotSubtitle")}
      controls={controls}
      footer={<LegalLinks t={t} onNavigate={onNavigate} />}
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="forgot-email" className="mb-1 block text-sm font-medium text-ink">
            {t("auth.emailLabel")}
          </label>
          <input
            id="forgot-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("auth.emailPlaceholder")}
            className={inputClassName}
            autoComplete="email"
          />
        </div>
        <FieldError message={error} />
        <button type="submit" disabled={submitting} className={primaryButtonClassName}>
          {submitting ? t("auth.forgotSending") : t("auth.forgotSubmit")}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-muted">
        <button
          type="button"
          onClick={() => onNavigate("/login")}
          className="font-semibold text-accent"
        >
          {t("auth.backToSignIn")}
        </button>
      </p>
    </AuthLayout>
  );
}
