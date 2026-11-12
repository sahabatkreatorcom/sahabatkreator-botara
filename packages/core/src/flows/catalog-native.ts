/**
 * Pembangun muatan katalog NATIF kanal untuk node `send_catalog`
 * (G17 butir 3) — fungsi murni, tanpa DB/jaringan.
 *
 * Peta format mengikuti kapabilitas resmi tiap kanal:
 * - WhatsApp → pesan DAFTAR interaktif Cloud API (interactive list):
 *   maks 10 baris per pesan, judul baris maks 24 karakter, deskripsi
 *   baris maks 72 karakter. Id baris = id produk; ketukan pelanggan
 *   kembali sebagai sinyal quick_reply ber-payload id produk
 *   (normalisasi webhook WhatsApp yang sudah ada).
 * - Messenger & Instagram → template GENERIK Send API: maks 10
 *   elemen, judul elemen maks 80 karakter, subtitle maks 80, tombol
 *   postback ber-payload `catalog_add:<productId>`; ketukan kembali
 *   sebagai sinyal postback.
 * - Kanal lain (Telegram, Webchat, …) → TIDAK ada format natif
 *   setara: payload null dan pemanggil mengirim daftar TEKS bernomor
 *   (fallback jujur yang sama seperti show_catalog) — bukan gagal
 *   diam-diam; format yang terpilih selalu tercatat di detail
 *   langkah.
 *
 * Pesan commerce `product_list` WhatsApp SENGAJA tidak dipakai:
 * bentuk itu menuntut katalog Meta Commerce tersinkron (produk
 * dengan retailer_id di Catalog Manager), sedangkan produk Botara
 * hidup di tabel commerce sendiri. Daftar interaktif adalah format
 * katalog natif yang bisa dibangun dari data yang benar-benar ada.
 */
import type { MessageInteractivePayload, Product } from "@sahabat-kreator/db";
import { formatIdrId } from "../commerce";

/** Batas baris daftar interaktif WhatsApp per pesan. */
export const WHATSAPP_LIST_MAX_ROWS = 10;
/** Batas elemen template generik Send API per pesan. */
export const GENERIC_TEMPLATE_MAX_ELEMENTS = 10;
/** Awalan payload postback tombol "tambah" template generik. */
export const CATALOG_ADD_POSTBACK_PREFIX = "catalog_add:";

/** Format pesan katalog yang terpilih untuk satu provider. */
export type CatalogMessageFormat =
  | "whatsapp_list"
  | "generic_template"
  | "text";

export interface BuiltCatalogMessage {
  format: CatalogMessageFormat;
  /** Muatan natif untuk kolom messages.interactive_payload; null = teks. */
  payload: MessageInteractivePayload | null;
  /**
   * Produk yang BENAR-BENAR tampil (yang diparkir sebagai pilihan
   * sah run): pada format natif terpotong ke batas platform; pada
   * teks = semua produk.
   */
  shown: Product[];
  /** True bila katalog tenant lebih panjang dari batas format natif. */
  truncated: boolean;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function priceLine(product: Product): string {
  return formatIdrId(product.priceIdr);
}

/**
 * Bangun muatan katalog untuk provider percakapan. `introText` yang
 * sudah dirender pemanggil menjadi judul section WhatsApp / tidak
 * dipakai template generik (body daftar teks di content_text tetap
 * memuatnya — lihat eksekutor send_catalog).
 */
export function buildCatalogMessage(
  provider: string,
  list: Product[],
  opts?: { sectionTitle?: string | null },
): BuiltCatalogMessage {
  if (provider === "whatsapp") {
    const shown = list.slice(0, WHATSAPP_LIST_MAX_ROWS);
    return {
      format: "whatsapp_list",
      payload: {
        kind: "whatsapp_list",
        buttonText: "Lihat Katalog",
        sections: [
          {
            title: truncate(opts?.sectionTitle?.trim() || "Katalog", 24),
            rows: shown.map((p) => ({
              id: p.id,
              title: truncate(p.name, 24),
              description: truncate(
                p.description
                  ? `${priceLine(p)} — ${p.description}`
                  : priceLine(p),
                72,
              ),
            })),
          },
        ],
      },
      shown,
      truncated: shown.length < list.length,
    };
  }
  if (provider === "messenger" || provider === "instagram") {
    const shown = list.slice(0, GENERIC_TEMPLATE_MAX_ELEMENTS);
    return {
      format: "generic_template",
      payload: {
        kind: "generic_template",
        elements: shown.map((p) => ({
          title: truncate(p.name, 80),
          subtitle: truncate(
            p.description
              ? `${priceLine(p)} — ${p.description}`
              : priceLine(p),
            80,
          ),
          buttons: [
            {
              type: "postback" as const,
              title: "Tambah ke Keranjang",
              payload: `${CATALOG_ADD_POSTBACK_PREFIX}${p.id}`,
            },
          ],
        })),
      },
      shown,
      truncated: shown.length < list.length,
    };
  }
  return { format: "text", payload: null, shown: list, truncated: false };
}

/**
 * Produk yang dipilih dari sinyal tombol (atau null): postback
 * template generik membawa `catalog_add:<productId>`; quick_reply
 * daftar WhatsApp membawa id produk langsung. Hanya id yang ada di
 * daftar parkir run yang sah — payload asing jatuh ke jalur teks.
 */
export function catalogProductIdFromSignal(
  signal: { kind: "postback" | "quick_reply"; payload: string } | null | undefined,
  parkedProductIds: readonly string[],
): string | null {
  if (!signal) return null;
  if (signal.kind === "postback") {
    if (!signal.payload.startsWith(CATALOG_ADD_POSTBACK_PREFIX)) return null;
    const id = signal.payload.slice(CATALOG_ADD_POSTBACK_PREFIX.length);
    return parkedProductIds.includes(id) ? id : null;
  }
  return parkedProductIds.includes(signal.payload) ? signal.payload : null;
}
