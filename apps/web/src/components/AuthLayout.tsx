import type { ReactNode } from "react";
import type { TranslationKey } from "@sahabat-kreator/i18n";
import { BrandLogo } from "./BrandLogo";

interface AuthLayoutProps {
  t: (key: TranslationKey) => string;
  title: string;
  subtitle: string;
  children: ReactNode;
  controls: ReactNode;
  /** Baris kaki tambahan di bawah kontrol (Fase 7D.1: tautan legal). */
  footer?: ReactNode;
}

/**
 * Kerangka halaman auth (Fase 1C): berdiri sendiri TANPA sidebar/bottom bar.
 * Kartu terpusat di atas token permukaan yang sama dengan shell.
 */
export function AuthLayout({ t, title, subtitle, children, controls, footer }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10 text-ink">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandLogo size={72} className="mb-3" />
          <div className="text-2xl font-bold">{t("app.name")}</div>
          <div className="mt-1 text-sm text-muted">{t("app.tagline")}</div>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <div className="mt-6 flex justify-center">{controls}</div>
        {footer ? <div className="mt-5">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Kelas input bersama halaman auth & form workspace (token semantik saja). */
export const inputClassName =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent";

export const primaryButtonClassName =
  "w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";

export function FieldError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}
