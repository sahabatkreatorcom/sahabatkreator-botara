import { z } from "zod";

import { PaymentLinkStatusSchema } from "./commerce";

// ---------------------------------------------------------------------------
// Fase 13F — Katalog + keranjang commerce: ORDER.
//
// Order lahir dari checkout keranjang (node flow `cart_checkout`):
// snapshot item (nama + harga satuan + qty) yang TIDAK berubah oleh
// perubahan produk sesudahnya, total yang dihitung server dari
// snapshot keranjang, dan SATU tautan bayar (mesin tautan yang sama,
// provider 'simulation' berlabel sampai pembayaran asli Fase 14A).
// Permukaan v1 untuk order BACA saja (orders:read). KERANJANG
// SENGAJA tidak punya skema publik di sini: keranjang adalah keadaan
// sesi ephemeral per kontak yang hanya hidup di dalam percakapan
// (diisi node show_catalog, dikonsumsi cart_checkout) — bukan sumber
// daya integrasi; mengeksposnya akan membekukan bentuk sesi internal
// menjadi kontrak publik (lihat docs/COVERAGE-MATRIX.md).
// ---------------------------------------------------------------------------

/** Status order — cermin status tautan bayarnya (hook penyelesaian). */
export const OrderStatusSchema = z.enum([
  "pending",
  "paid",
  "expired",
  "cancelled",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** Satu baris snapshot item order (harga & nama saat checkout). */
export const OrderItemResponseSchema = z.object({
  /** Produk asal; null bila produk sudah dihapus sesudah checkout. */
  productId: z.string().uuid().nullable(),
  productName: z.string(),
  qty: z.number().int().positive(),
  unitPriceIdr: z.number().int().nonnegative(),
  lineTotalIdr: z.number().int().nonnegative(),
});
export type OrderItemResponse = z.infer<typeof OrderItemResponseSchema>;

export const OrderResponseSchema = z.object({
  id: z.string().uuid(),
  contactId: z.string().uuid(),
  /** Nama kontak pembeli; null bila kontak sudah terhapus. */
  contactName: z.string().nullable(),
  /** Percakapan asal checkout; null bila lahir di luar percakapan. */
  conversationId: z.string().uuid().nullable(),
  status: OrderStatusSchema,
  items: z.array(OrderItemResponseSchema),
  /** Total server dari snapshot item (Rupiah penuh). */
  totalIdr: z.number().int().nonnegative(),
  /** Tautan bayar tunggal order; null hanya untuk order warisan tanpa tautan. */
  paymentLinkId: z.string().uuid().nullable(),
  paymentCode: z.string().nullable(),
  /** URL publik halaman bayar: {base}/pay/{code} (relatif bila base tak dikenal). */
  paymentUrl: z.string().nullable(),
  paymentStatus: PaymentLinkStatusSchema.nullable(),
  /** Provider pembayaran order = provider tautan bayarnya (sumber
   * kebenaran tunggal di payment_links): 'simulation' untuk order
   * warisan tanpa tautan; sejak Fase 14A bisa 'midtrans'/'xendit'. */
  provider: z.string(),
  paidAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

export const OrderListResponseSchema = z.object({
  orders: z.array(OrderResponseSchema),
});
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;
