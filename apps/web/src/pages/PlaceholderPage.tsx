import type { TranslationKey } from "@sahabat-kreator/i18n";

interface PlaceholderPageProps {
  t: (key: TranslationKey) => string;
  titleKey: TranslationKey;
}

/** Halaman placeholder generik untuk menu yang fiturnya datang di fase berikutnya. */
export function PlaceholderPage({ t, titleKey }: PlaceholderPageProps) {
  return (
    <section>
      <h1 className="text-2xl font-bold text-ink">{t(titleKey)}</h1>
      <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
        <div className="text-sm font-semibold uppercase tracking-wide text-accent">
          {t("common.comingSoon")}
        </div>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">{t("common.placeholderBody")}</p>
      </div>
    </section>
  );
}
