import { useState } from "react";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { AdminPage } from "../AdminPage";
import { OperationsSection } from "./OperationsSection";
import { OverviewSection } from "./OverviewSection";
import { SystemSection } from "./SystemSection";
import { TenantsSection } from "./TenantsSection";
import { UsersSection } from "./UsersSection";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface AdminConsolePageProps {
  t: Translate;
  locale: Locale;
}

type TabId =
  | "overview"
  | "tenants"
  | "users"
  | "integrations"
  | "operations"
  | "system";

const TABS: Array<{ id: TabId; labelKey: TranslationKey }> = [
  { id: "overview", labelKey: "adminConsole.tabOverview" },
  { id: "tenants", labelKey: "adminConsole.tabTenants" },
  { id: "users", labelKey: "adminConsole.tabUsers" },
  { id: "integrations", labelKey: "adminConsole.tabIntegrations" },
  { id: "operations", labelKey: "adminConsole.tabOperations" },
  { id: "system", labelKey: "adminConsole.tabSystem" },
];

/**
 * Konsol Admin Platform — enam bagian di bawah SATU entri navigasi.
 *
 * Kenapa tab, bukan enam item sidebar: registry navigasi dipakai bersama
 * sidebar workspace tenant. Enam item platform di sana akan mendorong menu
 * yang dipakai sehari-hari (Inbox, Agen, Broadcast) ke bawah, padahal
 * konsol ini dibuka sesekali. Pola tab sudah dipakai hub Agen
 * (/agents?tab=…), jadi pengguna tidak perlu mempelajari apa pun baru.
 *
 * Halaman Kredensial (Integrasi) TIDAK ditulis ulang — ia tetap
 * `AdminPage` yang sudah teruji, hanya dipanggil dari tab.
 */
export function AdminConsolePage({ t, locale }: AdminConsolePageProps) {
  const [tab, setTab] = useState<TabId>("overview");

  return (
    <div>
      <header>
        <h1 className="text-lg font-semibold text-ink">
          {t("adminConsole.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("adminConsole.subtitle")}
        </p>
      </header>

      <nav
        className="mt-4 flex flex-wrap gap-2 border-b border-line pb-2"
        aria-label={t("adminConsole.title")}
      >
        {TABS.map((item) => {
          const active = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white"
                  : "rounded-lg px-3 py-1.5 text-xs font-semibold text-muted hover:text-ink"
              }
            >
              {t(item.labelKey)}
            </button>
          );
        })}
      </nav>

      {tab === "overview" ? <OverviewSection t={t} locale={locale} /> : null}
      {tab === "tenants" ? <TenantsSection t={t} locale={locale} /> : null}
      {tab === "users" ? <UsersSection t={t} locale={locale} /> : null}
      {tab === "integrations" ? <AdminPage t={t} locale={locale} /> : null}
      {tab === "operations" ? <OperationsSection t={t} locale={locale} /> : null}
      {tab === "system" ? <SystemSection t={t} locale={locale} /> : null}
    </div>
  );
}
