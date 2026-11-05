import { useState } from "react";
import type { TranslationKey } from "@sahabat-kreator/i18n";
import type { SessionUser } from "../api/client";

interface ProfileBlockProps {
  t: (key: TranslationKey) => string;
  user: SessionUser;
  onSignOut: () => Promise<void>;
}

/** Area profil: identitas user login + tombol keluar (sidebar & MoreSheet). */
export function ProfileBlock({ t, user, onSignOut }: ProfileBlockProps) {
  const [signingOut, setSigningOut] = useState(false);
  const initial = (user.name?.trim() || user.email).charAt(0).toUpperCase();

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <div
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-white"
      >
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-ink">{user.name}</div>
        <div className="truncate text-xs text-muted">{user.email}</div>
      </div>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="shrink-0 rounded-md bg-elevated px-3 py-1.5 text-sm text-ink disabled:opacity-60"
      >
        {t("auth.signOut")}
      </button>
    </div>
  );
}
