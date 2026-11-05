import { useState, type InputHTMLAttributes } from "react";
import type { TranslationKey } from "@sahabat-kreator/i18n";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface PasswordInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  t: Translate;
}

/**
 * Input password bersama (Rider Fase 9A — permintaan user): tombol
 * ikon mata di sisi kanan field mengalihkan type password↔text agar
 * pengguna bisa memeriksa teks rahasia yang SEDANG ia ketik sebelum
 * mengirim (token bot, kredensial panel, kata sandi). Semantik
 * keamanan tidak berubah: nilai yang sudah tersimpan di server tidak
 * pernah dikembalikan untuk ditampilkan — toggle hanya berlaku pada
 * teks lokal di field ini.
 *
 * Perilaku: default tersembunyi; state per instance field; tombol
 * type="button" sehingga TIDAK PERNAH men-submit form di sekitarnya;
 * label aria + title dwibahasa (common.showPassword/hidePassword).
 * Ikon mengikuti gaya stroke ikon lain di aplikasi (NavIcon/tema).
 */
export function PasswordInput({ t, className, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? t("common.hidePassword") : t("common.showPassword");
  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? "text" : "password"}
        className={`${className ?? ""} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={label}
        title={label}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-muted hover:text-ink"
      >
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden={true}
        >
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
          {visible ? <path d="M4 4l16 16" /> : null}
        </svg>
      </button>
    </div>
  );
}
