import type { ReactNode } from "react";

/**
 * Galeri templat bersama (ekstraksi G1). Sebelumnya markup galeri
 * ditulis terpisah di tiga tempat dengan struktur yang sama: panel
 * galeri AutomationsPage, panel galeri FlowsPage, dan galeri di dalam
 * formulir AgentsPage. Komponen ini memiliki CANGKANGNYA saja —
 * panel, grid, kartu, baris judul, paragraf deskripsi/meta — sedangkan
 * isi khas domain (chip kategori, chip kebutuhan, teks meta langkah,
 * tombol terapkan/hapus) diserahkan pemanggil sebagai ReactNode,
 * supaya hasil render tiap halaman tidak berubah.
 *
 * Dua varian mengikuti dua pemakaian yang memang sudah ada:
 * - "panel": kartu besar di panel halaman (Automations & Flows) —
 *   pakai lewat TemplateGalleryPanel + TemplateGalleryGrid.
 * - "compact": kartu kecil di dalam formulir (Agents) — pakai
 *   TemplateGalleryGrid langsung; judul/subjudul formulir tetap
 *   milik formulirnya.
 *
 * Galeri menggabungkan katalog statis kontrak + baris templat pribadi
 * tenant: pemanggil cukup menggabungkan keduanya menjadi satu daftar
 * `cards` (urutan tampilan tetap keputusan pemanggil).
 */
export interface TemplateGalleryCard {
  key: string;
  /** Nama templat (isi span judul kartu). */
  name: ReactNode;
  /** Chip/lencana yang dirender sejajar sesudah nama pada baris judul. */
  badges?: ReactNode;
  /** Isi paragraf deskripsi (paragraf fleksibel pengisi ruang kartu). */
  description?: ReactNode;
  /**
   * Kelas tambahan paragraf deskripsi, digabung sesudah kelas varian
   * (mis. "line-clamp-3 whitespace-pre-wrap" untuk pratinjau teks
   * mentah templat pribadi di Agents).
   */
  descriptionClassName?: string;
  /** Baris meta kecil di bawah deskripsi (hanya varian "panel"). */
  meta?: ReactNode;
  /**
   * Konten bebas sesudah meta, dirender apa adanya (hanya varian
   * "panel"; mis. chip kebutuhan flow).
   */
  afterMeta?: ReactNode;
  /** Tombol/aksi di kaki kartu — dirender apa adanya. */
  actions?: ReactNode;
}

const GRID_CLASS: Record<"panel" | "compact", string> = {
  panel: "mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3",
  compact: "mt-3 grid gap-2 sm:grid-cols-2",
};

const CARD_CLASS: Record<"panel" | "compact", string> = {
  panel: "flex flex-col rounded-xl border border-line bg-elevated/40 p-4",
  compact: "flex flex-col rounded-xl border border-line bg-surface p-3",
};

const TITLE_ROW_CLASS: Record<"panel" | "compact", string> = {
  panel: "flex flex-wrap items-center gap-2",
  compact: "flex flex-wrap items-center gap-1.5",
};

const DESCRIPTION_CLASS: Record<"panel" | "compact", string> = {
  panel: "mt-2 flex-1 text-sm text-muted",
  compact: "mt-1 flex-1 text-xs leading-relaxed text-muted",
};

/** Grid kartu templat — dipakai ketiga galeri (lihat header berkas). */
export function TemplateGalleryGrid({
  variant,
  cards,
}: {
  variant: "panel" | "compact";
  cards: TemplateGalleryCard[];
}) {
  return (
    <ul className={GRID_CLASS[variant]}>
      {cards.map((card) => (
        <li key={card.key} className={CARD_CLASS[variant]}>
          <div className={TITLE_ROW_CLASS[variant]}>
            <span className="text-sm font-semibold text-ink">{card.name}</span>
            {card.badges}
          </div>
          <p
            className={
              card.descriptionClassName
                ? `${DESCRIPTION_CLASS[variant]} ${card.descriptionClassName}`
                : DESCRIPTION_CLASS[variant]
            }
          >
            {card.description}
          </p>
          {variant === "panel" && card.meta ? (
            <p className="mt-2 text-xs text-muted">{card.meta}</p>
          ) : null}
          {variant === "panel" ? card.afterMeta : null}
          {card.actions}
        </li>
      ))}
    </ul>
  );
}

/**
 * Panel galeri halaman (Automations & Flows): bingkai berjudul dengan
 * keadaan memuat / kosong. `children` (biasanya TemplateGalleryGrid)
 * hanya dirender pada keadaan siap; keadaan kosong hanya dirender
 * bila `empty` true DAN `emptyLabel` diberikan — halaman yang tidak
 * meneruskan keduanya tetap menampilkan grid (walau nol kartu),
 * persis perilaku lamanya.
 */
export function TemplateGalleryPanel({
  title,
  subtitle,
  loading,
  loadingLabel,
  empty,
  emptyLabel,
  children,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  loading: boolean;
  loadingLabel: ReactNode;
  empty?: boolean;
  emptyLabel?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>
      {loading ? (
        <p className="mt-4 text-sm text-muted">{loadingLabel}</p>
      ) : empty && emptyLabel ? (
        <p className="mt-4 text-sm text-muted">{emptyLabel}</p>
      ) : (
        children
      )}
    </div>
  );
}
