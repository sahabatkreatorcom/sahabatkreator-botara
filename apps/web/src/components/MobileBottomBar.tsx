import type { TranslationKey } from "@sahabat-kreator/i18n";
import { mobileTabItems, type NavItem } from "../navigation/registry";
import { NavIcon } from "./NavIcon";

interface MobileBottomBarProps {
  t: (key: TranslationKey) => string;
  activeId: string;
  moreActive: boolean;
  onNavigate: (item: NavItem) => void;
  onMore: () => void;
  badges: Partial<Record<NonNullable<NavItem["badge"]>, number>>;
}

/** Bottom bar MOBILE — tepat 4 tab (slot 1–4 dari registry) + tombol More (§10.1). */
export function MobileBottomBar({ t, activeId, moreActive, onNavigate, onMore, badges }: MobileBottomBarProps) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface md:hidden">
      <ul className="grid grid-cols-5">
        {mobileTabItems.map((item) => {
          const active = item.id === activeId;
          const badge = item.badge ? badges[item.badge] : undefined;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onNavigate(item)}
                className={`relative flex w-full flex-col items-center gap-0.5 py-2 text-[11px] ${
                  active ? "font-semibold text-accent" : "text-muted"
                }`}
              >
                <NavIcon name={item.icon} />
                <span>{t(item.labelKey)}</span>
                {badge ? (
                  <span className="absolute right-1/2 top-1 translate-x-3 rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white">
                    {badge}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={onMore}
            className={`flex w-full flex-col items-center gap-0.5 py-2 text-[11px] ${
              moreActive ? "font-semibold text-accent" : "text-muted"
            }`}
          >
            <NavIcon name="more" />
            <span>{t("nav.more")}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
