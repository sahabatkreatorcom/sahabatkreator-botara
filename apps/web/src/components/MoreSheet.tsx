import type { TranslationKey } from "@sahabat-kreator/i18n";
import { groupNavItems, moreItems, type NavItem } from "../navigation/registry";
import { NavIcon } from "./NavIcon";

interface MoreSheetProps {
  t: (key: TranslationKey) => string;
  open: boolean;
  activeId: string;
  onClose: () => void;
  onNavigate: (item: NavItem) => void;
  controls: React.ReactNode;
  /** Pemilih workspace aktif (di bawah profil). */
  workspace: React.ReactNode;
  /** Blok profil user login + logout (bagian atas sheet). */
  profile: React.ReactNode;
  /** Daftar item yang sudah disaring menurut hak sesi (Fase 6C); default = registry penuh. */
  items?: NavItem[];
}

/** Sheet "More": profil + workspace, sisa item registry (order.more), kontrol tema & bahasa (§10.1). */
export function MoreSheet({ t, open, activeId, onClose, onNavigate, controls, workspace, profile, items = moreItems }: MoreSheetProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
      <button type="button" aria-label="close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-surface p-4">
        <div className="mb-3 text-base font-semibold text-ink">{t("nav.more")}</div>
        <div className="mb-4">{profile}</div>
        <div className="mb-4 border-t border-line pt-4">{workspace}</div>
        <div className="space-y-4">
          {groupNavItems(items).map(({ group, items: groupItems }, groupIdx) => (
            <section
              key={group.id}
              className={groupIdx > 0 ? "border-t border-line pt-4" : undefined}
            >
              <h2 className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {t(group.labelKey)}
              </h2>
              <ul className="space-y-1">
                {groupItems.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onNavigate(item)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${
                        item.id === activeId
                          ? "bg-accent/10 font-semibold text-accent"
                          : "text-ink hover:bg-elevated"
                      }`}
                    >
                      <NavIcon name={item.icon} />
                      <span>{t(item.labelKey)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="mt-4 border-t border-line pt-4">{controls}</div>
      </div>
    </div>
  );
}
