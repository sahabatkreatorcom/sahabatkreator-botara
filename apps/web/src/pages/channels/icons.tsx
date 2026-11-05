/**
 * Ikon inline halaman Channels (SVG tanpa dependensi).
 *
 * Dipisah karena murni presentasional: tidak menerima props, tidak
 * membaca state, dan tidak menyentuh data — satu-satunya alasan berkas
 * ini ada adalah agar JSX halaman tidak tenggelam oleh path SVG.
 */
export function PowerIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="M12 3v8" />
      <path d="M17.7 6.3a8 8 0 1 1-11.4 0" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function ChevronRightIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0 text-muted"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

/** Pill status kartu: titik + label, warna mengikuti token semantik tema. */
/** Glyph "f" Facebook (jalur terisi sederhana) untuk tombol OAuth Fase 7D. */
export function FacebookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="h-5 w-5 shrink-0"
    >
      <path d="M13.22 21.888v-7.638h2.565l.435-2.99H13.22V9.35c0-.865.24-1.455 1.48-1.455h1.58V5.22c-.274-.036-1.212-.116-2.304-.116-2.28 0-3.84 1.39-3.84 3.945v2.202H7.56v2.99h2.576v7.638a12.05 12.05 0 0 0 3.084 0Z" />
    </svg>
  );
}
