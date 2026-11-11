import { useEffect, useState, type ReactNode } from "react";

/**
 * Avatar channel + badge provider (Fase 6H — kartu Channels mengikuti
 * referensi UI user). Slot avatar SIAP-GAMBAR: bila `imageUrl` tersedia
 * (foto channel/bot tiba di Fase 6D) ia dirender sebagai <img>; selama
 * belum ada, slot menampilkan inisial nama di atas tint warna provider.
 * Badge kecil di pojok kanan-bawah avatar selalu glyph provider di atas
 * warna merek provider — sama seperti badge Instagram pada referensi.
 *
 * Warna merek di sini BUKAN token tema: ini identitas provider pihak
 * ketiga (seperti logo), jadi hex merek memang disengaja dan konsisten
 * di tema terang maupun gelap.
 */
export interface ProviderMeta {
  /** Warna merek provider (badge + tint avatar). */
  color: string;
  /** Glyph provider (SVG 24x24, digambar dengan stroke currentColor). */
  glyph: ReactNode;
  /**
   * True = glyph adalah path MEREK terisi (Fase 7A: WhatsApp & Messenger
   * memakai path logo autentik yang hanya terbaca sebagai bentuk padat):
   * dirender dengan fill currentColor tanpa stroke, bukan gaya garis
   * seperti glyph provider lain.
   */
  filled?: boolean;
}

const GLYPH_PROPS = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const PROVIDER_META: Record<string, ProviderMeta> = {
  telegram: {
    color: "#229ED9",
    glyph: (
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    ),
  },
  webchat: {
    color: "#2563EB",
    glyph: (
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    ),
  },
  whatsapp: {
    color: "#25D366",
    // Fase 7A (permintaan user): path logo WhatsApp autentik (gelembung
    // bicara + gagang telepon khas di dalamnya) — sebelumnya ikon gagang
    // telepon generik gaya Feather yang tidak terbaca sebagai WhatsApp.
    filled: true,
    glyph: (
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.028 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    ),
  },
  instagram: {
    color: "#E4405F",
    glyph: (
      <>
        <rect x="2.5" y="2.5" width="19" height="19" rx="5" />
        <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
        <path d="M17.5 6.5h.01" />
      </>
    ),
  },
  threads: {
    // Threads bermerek monokrom (hitam-putih); abu netral dipilih agar
    // glyph terbaca di tema terang maupun gelap.
    color: "#6B7280",
    glyph: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M16 8.5v5.2a2.6 2.6 0 0 0 5.2 0V12a9.2 9.2 0 1 0-3.4 7.1" />
      </>
    ),
  },
  tiktok: {
    // Aksen merah muda TikTok — terbaca di tema terang maupun gelap
    // (hitam mereknya tidak), pola keputusan yang sama seperti Threads.
    color: "#FE2C55",
    glyph: (
      <>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </>
    ),
  },
  linkedin: {
    color: "#0A66C2",
    filled: true,
    glyph: (
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124zM7.119 20.452H3.554V9h3.565v11.452z" />
    ),
  },
  pinterest: {
    color: "#E60023",
    glyph: (
      <>
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 7.5a4.7 4.7 0 1 0 1.8 9.1c.6.1 1.1-.1 1.4-.5" />
        <path d="M10.2 21.2l2.2-8.2" />
      </>
    ),
  },
  bluesky: {
    color: "#0085FF",
    glyph: (
      <path d="M12 10.2C10.2 6.9 7.3 5 4.3 5c0 3.9 1.4 6.8 4.3 7.9-2.3 1-3.3 3.4-3.3 6.1 2.4 0 4.8-1.9 6.7-4.8 1.9 2.9 4.3 4.8 6.7 4.8 0-2.7-1-5.1-3.3-6.1 2.9-1.1 4.3-4 4.3-7.9-3 0-5.9 1.9-7.7 5.2z" />
    ),
  },
  youtube: {
    color: "#FF0000",
    glyph: (
      <>
        <rect x="2" y="5.5" width="20" height="13" rx="4" />
        <path d="M10.2 9.7v4.6L14.4 12z" />
      </>
    ),
  },
  google_business: {
    color: "#34A853",
    glyph: (
      <>
        <path d="M12 21.2S5.2 15.6 5.2 10a6.8 6.8 0 0 1 13.6 0c0 5.6-6.8 11.2-6.8 11.2z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
  },
  google: {
    color: "#4285F4",
    filled: true,
    glyph: (
      <path d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81z" />
    ),
  },
  messenger: {
    color: "#0084FF",
    // Fase 7A (permintaan user): path logo Messenger autentik (gelembung
    // dengan ekor kiri-bawah + petir khas di dalamnya, bentuk padat) —
    // sebelumnya gelembung generik yang digambar ulang dengan stroke.
    filled: true,
    glyph: (
      <path d="M12 0C5.373 0 0 4.974 0 11.111c0 3.499 1.745 6.616 4.472 8.652V24l4.086-2.242c1.09.301 2.246.464 3.442.464 6.627 0 12-4.974 12-11.111C24 4.974 18.627 0 12 0zm1.191 14.372-2.896-3.092-5.648 3.092 6.212-6.612 2.896 3.092 5.571-3.092-6.135 6.612z" />
    ),
  },
};

const FALLBACK_META: ProviderMeta = PROVIDER_META.webchat;

export function providerMeta(provider: string): ProviderMeta {
  return PROVIDER_META[provider] ?? FALLBACK_META;
}

/** Glyph provider berdiri sendiri (dipakai badge & kartu provider "segera"). */
export function ProviderGlyph({
  provider,
  className = "h-5 w-5",
  strokeWidth = 1.8,
}: {
  provider: string;
  className?: string;
  strokeWidth?: number;
}) {
  const meta = providerMeta(provider);
  // Fase 7A: glyph merek terisi (WhatsApp/Messenger) dirender padat —
  // fill currentColor, tanpa stroke; glyph lain tetap gaya garis.
  if (meta.filled) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden={true}
      >
        {meta.glyph}
      </svg>
    );
  }
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
      aria-hidden={true}
      {...GLYPH_PROPS}
    >
      {meta.glyph}
    </svg>
  );
}

interface ChannelAvatarProps {
  provider: string;
  /** Nama untuk inisial fallback (displayName / username / label provider). */
  name: string;
  /** URL foto channel — diisi Fase 6D; selama undefined tampil inisial. */
  imageUrl?: string;
}

/**
 * Slot avatar persegi membulat + badge provider di pojok kanan-bawah.
 */
export function ChannelAvatar({ provider, name, imageUrl }: ChannelAvatarProps) {
  const meta = providerMeta(provider);
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  // Fase 6D: foto yang gagal dimuat jatuh kembali ke inisial provider —
  // tidak ada ikon gambar rusak di kartu.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [imageUrl]);
  return (
    <div className="relative shrink-0">
      {imageUrl && !imgFailed ? (
        <img
          src={imageUrl}
          alt=""
          onError={() => setImgFailed(true)}
          className="h-12 w-12 rounded-xl border border-line object-cover"
        />
      ) : (
        <div
          className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold"
          style={{ backgroundColor: `${meta.color}1f`, color: meta.color }}
          aria-hidden={true}
        >
          {initial}
        </div>
      )}
      <span
        className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full text-white ring-2 ring-surface"
        style={{ backgroundColor: meta.color }}
        aria-hidden={true}
      >
        <ProviderGlyph provider={provider} className="h-3 w-3" strokeWidth={2.4} />
      </span>
    </div>
  );
}
