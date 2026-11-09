import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";

/** Tipe penerjemah yang dipakai seluruh halaman admin (pola halaman lain). */
export type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

export interface AdminSectionProps {
  t: Translate;
  locale: Locale;
}

/** Satu angka besar + label kecil — dipakai di Ringkasan & Sistem. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

/** Baris kunci–nilai untuk panel detail. */
export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-xs text-ink">{value}</dd>
    </div>
  );
}

export const primaryButton =
  "rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButton =
  "rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60";

export const dangerButton =
  "rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-danger disabled:cursor-not-allowed disabled:opacity-60";
