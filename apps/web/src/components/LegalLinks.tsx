import type { TranslationKey } from "@sahabat-kreator/i18n";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

export type LegalPageKind = "privacy" | "terms" | "deletion";

export const LEGAL_PATHS: Record<LegalPageKind, string> = {
  privacy: "/privacy",
  terms: "/terms",
  deletion: "/data-deletion",
};

const LEGAL_TITLE_KEYS: Record<LegalPageKind, TranslationKey> = {
  privacy: "legal.privacy.title",
  terms: "legal.terms.title",
  deletion: "legal.deletion.title",
};

interface LegalLinksProps {
  t: Translate;
  /** Navigasi SPA (router path sederhana di App). */
  onNavigate: (path: string) => void;
  /** Halaman legal aktif — dirender sebagai teks biasa, bukan tautan. */
  current?: LegalPageKind;
}

/**
 * Tautan silang tiga halaman legal publik (Fase 7D.1): dipakai sebagai
 * footer di /login & /register dan di kaki setiap halaman legal.
 * Labelnya judul halaman dari resource i18n — tidak ada teks hardcoded.
 */
export function LegalLinks({ t, onNavigate, current }: LegalLinksProps) {
  const kinds: LegalPageKind[] = ["privacy", "terms", "deletion"];
  return (
    <nav
      aria-label="Legal"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted"
    >
      {kinds.map((kind, i) => (
        <span key={kind} className="flex items-center gap-2">
          {i > 0 ? <span aria-hidden={true}>·</span> : null}
          {current === kind ? (
            <span className="font-semibold text-ink" aria-current="page">
              {t(LEGAL_TITLE_KEYS[kind])}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate(LEGAL_PATHS[kind])}
              className="underline-offset-2 hover:text-ink hover:underline"
            >
              {t(LEGAL_TITLE_KEYS[kind])}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
