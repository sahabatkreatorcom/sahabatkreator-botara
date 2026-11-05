import { useEffect } from "react";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { BrandLogo } from "../components/BrandLogo";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface WebchatDemoPageProps {
  t: Translate;
  locale: Locale;
}

/**
 * Halaman demo publik webchat (Fase 1F) — DI LUAR shell & tanpa login.
 * Memasang widget persis seperti situs tenant: satu <script src="/widget.js"
 * data-site-key="..."> dengan siteKey dari query (?key=wc_...). Pemilik
 * workspace bisa mencoba rantai pengunjung sungguhan dari browser.
 */
export function WebchatDemoPage({ t, locale }: WebchatDemoPageProps) {
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const siteKey = params?.get("key") ?? null;
  // Slug atribusi growth link (Fase 13B): /go/<slug> untuk channel
  // webchat mengarahkan ke halaman ini dengan ?src=<slug>; teruskan ke
  // widget agar sesi yang dibuka teratribusi ke tautan itu.
  const src = params?.get("src") ?? null;

  useEffect(() => {
    if (!siteKey) return;
    const script = document.createElement("script");
    script.src = "/widget.js";
    script.dataset.siteKey = siteKey;
    script.dataset.lang = locale;
    if (src) script.dataset.src = src;
    script.async = true;
    document.body.appendChild(script);
    return () => {
      script.remove();
    };
  }, [siteKey, locale, src]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl bg-bg px-4 py-10 text-ink">
      <div className="flex items-center gap-2">
        <BrandLogo size={28} />
        <span className="text-lg font-bold">{t("app.name")}</span>
      </div>
      <h1 className="mt-6 text-2xl font-bold">{t("channels.demoTitle")}</h1>
      <p className="mt-2 text-sm text-muted">{t("channels.demoBody")}</p>
      {siteKey ? (
        <p className="mt-4 text-sm">
          {t("channels.siteKeyLabel")}:{" "}
          <code className="font-mono">{siteKey}</code>
        </p>
      ) : (
        <p className="mt-4 rounded-lg border border-line bg-surface p-4 text-sm">
          {t("channels.demoMissingKey")}
        </p>
      )}
    </main>
  );
}
