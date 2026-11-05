interface BrandLogoProps {
  /** Sisi gambar dalam px (persegi). */
  size?: number;
  className?: string;
}

/**
 * Logo aplikasi (glossy SK chat bubble). Aset: `public/brand/logo.png`
 * (transparan, sudah di-crop). Dekoratif — nama app tetap dibaca dari teks,
 * jadi `alt` sengaja kosong.
 */
export function BrandLogo({ size = 32, className = "" }: BrandLogoProps) {
  return (
    <img
      src="/brand/logo.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
