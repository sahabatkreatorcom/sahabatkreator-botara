import type { ReactNode } from "react";
import type { TranslationKey } from "@sahabat-kreator/i18n";
import { LegalLinks, type LegalPageKind } from "../components/LegalLinks";
import { BrandLogo } from "../components/BrandLogo";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Email kontak yang DITERBITKAN di halaman legal (Fase 7D.1).
 * CATATAN: alamat ini pilihan awal yang HARUS dikonfirmasi user —
 * lihat catatan Fase 7D.1 di docs/DEPLOY-STAGING.md.
 */
export const LEGAL_CONTACT_EMAIL = "support@botara.my.id";

interface LegalSectionSpec {
  title: TranslationKey;
  paragraphs: TranslationKey[];
  bullets?: TranslationKey[];
}

interface LegalDocSpec {
  title: TranslationKey;
  intro: TranslationKey;
  sections: LegalSectionSpec[];
}

/**
 * Manifest struktur dokumen legal: komponen hanya merakit kunci i18n —
 * SELURUH teks (judul seksi, paragraf, butir daftar) hidup di resource
 * en/id (`legal.*`), tidak ada string hardcoded di sini.
 */
const LEGAL_DOCS: Record<LegalPageKind, LegalDocSpec> = {
  privacy: {
    title: "legal.privacy.title",
    intro: "legal.privacy.intro",
    sections: [
      { title: "legal.privacy.s1Title", paragraphs: ["legal.privacy.s1Body"] },
      {
        title: "legal.privacy.s2Title",
        paragraphs: ["legal.privacy.s2Intro"],
        bullets: [
          "legal.privacy.s2Item1",
          "legal.privacy.s2Item2",
          "legal.privacy.s2Item3",
          "legal.privacy.s2Item4",
        ],
      },
      { title: "legal.privacy.s3Title", paragraphs: ["legal.privacy.s3Body"] },
      { title: "legal.privacy.s4Title", paragraphs: ["legal.privacy.s4Body"] },
      { title: "legal.privacy.s5Title", paragraphs: ["legal.privacy.s5Body"] },
      { title: "legal.privacy.s6Title", paragraphs: ["legal.privacy.s6Body"] },
      { title: "legal.privacy.s7Title", paragraphs: ["legal.privacy.s7Body"] },
      { title: "legal.privacy.s8Title", paragraphs: ["legal.privacy.s8Body"] },
      { title: "legal.privacy.s9Title", paragraphs: ["legal.privacy.s9Body"] },
      { title: "legal.privacy.s10Title", paragraphs: ["legal.privacy.s10Body"] },
      { title: "legal.privacy.s11Title", paragraphs: ["legal.privacy.s11Body"] },
      { title: "legal.privacy.s12Title", paragraphs: ["legal.privacy.s12Body"] },
    ],
  },
  terms: {
    title: "legal.terms.title",
    intro: "legal.terms.intro",
    sections: [
      { title: "legal.terms.s1Title", paragraphs: ["legal.terms.s1Body"] },
      { title: "legal.terms.s2Title", paragraphs: ["legal.terms.s2Body"] },
      {
        title: "legal.terms.s3Title",
        paragraphs: ["legal.terms.s3Intro"],
        bullets: [
          "legal.terms.s3Item1",
          "legal.terms.s3Item2",
          "legal.terms.s3Item3",
          "legal.terms.s3Item4",
        ],
      },
      { title: "legal.terms.s4Title", paragraphs: ["legal.terms.s4Body"] },
      { title: "legal.terms.s5Title", paragraphs: ["legal.terms.s5Body"] },
      { title: "legal.terms.s6Title", paragraphs: ["legal.terms.s6Body"] },
      { title: "legal.terms.s7Title", paragraphs: ["legal.terms.s7Body"] },
      { title: "legal.terms.s8Title", paragraphs: ["legal.terms.s8Body"] },
      { title: "legal.terms.s9Title", paragraphs: ["legal.terms.s9Body"] },
      { title: "legal.terms.s10Title", paragraphs: ["legal.terms.s10Body"] },
      { title: "legal.terms.s11Title", paragraphs: ["legal.terms.s11Body"] },
    ],
  },
  deletion: {
    title: "legal.deletion.title",
    intro: "legal.deletion.intro",
    sections: [
      { title: "legal.deletion.s1Title", paragraphs: ["legal.deletion.s1Body"] },
      { title: "legal.deletion.s2Title", paragraphs: ["legal.deletion.s2Body"] },
      { title: "legal.deletion.s3Title", paragraphs: ["legal.deletion.s3Body"] },
      { title: "legal.deletion.s4Title", paragraphs: ["legal.deletion.s4Body"] },
      { title: "legal.deletion.s5Title", paragraphs: ["legal.deletion.s5Body"] },
      { title: "legal.deletion.s6Title", paragraphs: ["legal.deletion.s6Body"] },
      { title: "legal.deletion.s7Title", paragraphs: ["legal.deletion.s7Body"] },
    ],
  },
};

interface LegalPageProps {
  t: Translate;
  kind: LegalPageKind;
  /** Kontrol bahasa + tema yang sama dengan permukaan standalone lain. */
  controls: ReactNode;
  onNavigate: (path: string) => void;
}

/**
 * Halaman legal publik (Fase 7D.1) — /privacy, /terms, /data-deletion.
 * Berdiri sendiri di luar shell & tanpa sesi (untuk dibaca siapa pun dan
 * didaftarkan ke pengaturan aplikasi Meta). Header ringkas: nama produk
 * + kontrol bahasa/tema + tautan kembali; kaki: tautan silang legal.
 */
export function LegalPage({ t, kind, controls, onNavigate }: LegalPageProps) {
  const doc = LEGAL_DOCS[kind];
  const params = { email: LEGAL_CONTACT_EMAIL };
  // Kode konfirmasi dari callback penghapusan data Meta: API menjawab
  // permintaan Meta dengan URL halaman ini + `?code=<kode>`; bila ada,
  // tampilkan status penerimaan permintaannya di atas dokumen.
  const deletionCode =
    kind === "deletion" && typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("code")
      : null;
  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:py-12">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <BrandLogo size={36} />
            <div>
              <div className="text-lg font-bold leading-tight">{t("app.name")}</div>
              <div className="mt-0.5 text-xs text-muted">{t("app.tagline")}</div>
            </div>
          </div>
          {controls}
        </header>
        <button
          type="button"
          onClick={() => onNavigate("/")}
          className="mt-6 text-sm font-medium text-accent"
        >
          ← {t("common.back")}
        </button>

        <main className="mt-4 rounded-2xl border border-line bg-surface p-6 shadow-sm md:p-8">
          <h1 className="text-2xl font-bold">{t(doc.title)}</h1>
          <p className="mt-2 text-sm text-muted">{t("legal.effectiveDate")}</p>
          <p className="mt-4 text-sm leading-relaxed text-ink">
            {t(doc.intro, params)}
          </p>
          {deletionCode ? (
            <div className="mt-5 rounded-xl border border-line bg-elevated p-4">
              <h2 className="text-sm font-semibold text-ink">
                {t("legal.deletion.statusTitle")}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-ink">
                {t("legal.deletion.statusBody", { ...params, code: deletionCode })}
              </p>
            </div>
          ) : null}
          {doc.sections.map((section) => (
            <section key={section.title} className="mt-7">
              <h2 className="text-base font-semibold text-ink">
                {t(section.title)}
              </h2>
              {section.paragraphs.map((paragraph) => (
                <p
                  key={paragraph}
                  className="mt-2 text-sm leading-relaxed text-ink"
                >
                  {t(paragraph, params)}
                </p>
              ))}
              {section.bullets ? (
                <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink">
                  {section.bullets.map((item) => (
                    <li key={item}>{t(item, params)}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </main>

        <footer className="mt-8">
          <LegalLinks t={t} onNavigate={onNavigate} current={kind} />
        </footer>
      </div>
    </div>
  );
}
