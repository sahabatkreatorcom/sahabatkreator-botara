import type { TranslationKey } from "@sahabat-kreator/i18n";
import { desktopItems, type NavItem } from "../navigation/registry";
import { NavIcon } from "./NavIcon";
import { BrandLogo } from "./BrandLogo";

interface SidebarProps {
  t: (key: TranslationKey) => string;
  activeId: string;
  onNavigate: (item: NavItem) => void;
  badges: Partial<Record<NonNullable<NavItem["badge"]>, number>>;
  controls: React.ReactNode;
  /** Pemilih workspace aktif (di bawah brand). */
  workspace: React.ReactNode;
  /** Blok profil user login + logout (di atas kontrol bahasa/tema). */
  profile: React.ReactNode;
  /** Daftar item yang sudah disaring menurut hak sesi (Fase 6C); default = registry penuh. */
  items?: NavItem[];
}

/** Sidebar DESKTOP — me-render registry navigasi yang sama dengan mobile (§10.1). */
export function Sidebar({ t, activeId, onNavigate, badges, controls, workspace, profile, items = desktopItems }: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-4">
        <BrandLogo size={36} />
        <div className="min-w-0">
          <div className="truncate text-base font-bold leading-tight text-ink">
            {t("app.name")}
          </div>
          <div className="truncate text-xs text-muted">{t("app.tagline")}</div>
        </div>
      </div>
      <div className="border-b border-line px-4 py-3">{workspace}</div>
      <nav className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-1">
          {items.map((item) => {
            const active = item.id === activeId;
            const badge = item.badge ? badges[item.badge] : undefined;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(item)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                    active
                      ? "bg-accent/10 font-semibold text-accent"
                      : "text-ink hover:bg-elevated"
                  }`}
                >
                  <NavIcon name={item.icon} />
                  <span className="flex-1 text-left">{t(item.labelKey)}</span>
                  {badge ? (
                    <span className="rounded-full bg-danger px-2 py-0.5 text-xs font-semibold text-white">
                      {badge}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-line p-4">{profile}</div>
      <div className="border-t border-line p-4">{controls}</div>
    </aside>
  );
}
