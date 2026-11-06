import type { ChannelProvider } from "@sahabat-kreator/contracts";

/**
 * Jendela pesan bebas (Fase 16C).
 *
 * MASALAH YANG DITUTUP: kode error `MESSAGING_WINDOW_CLOSED` sudah ada di
 * kontrak sejak awal tetapi TIDAK PERNAH dipakai. Akibatnya membalas
 * kontak WhatsApp yang terakhir menulis tiga hari lalu lolos di UI,
 * pesan diantrekan, lalu ditolak Meta saat pengiriman — pengguna melihat
 * pesan berstatus `failed` beberapa detik kemudian tanpa penjelasan.
 *
 * ATURAN (dari Meta, bukan karangan kita): WhatsApp Cloud API hanya
 * mengizinkan pesan teks/media bebas dalam 24 jam sejak pesan MASUK
 * terakhir dari kontak. Lewat dari itu hanya template yang disetujui yang
 * bisa dikirim.
 *
 * KENAPA HANYA WHATSAPP: Telegram dan webchat tidak punya batas ini, dan
 * jendela Instagram/Messenger punya pengecualian tag manusia yang belum
 * kita pakai — menegakkannya di sana akan MEMBLOKIR balasan yang
 * sebenarnya sah. Menambah provider = menambah satu entri di
 * `WINDOW_ENFORCED_PROVIDERS`.
 */

/** 24 jam, sama dengan `META_24H_WINDOW_MS` di broadcasts.ts. */
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Provider yang jendelanya kita tegakkan di sisi kita. Broadcast sudah
 * menegakkan aturan yang sama untuk WhatsApp; daftar ini menyamakan
 * perilaku untuk balasan manual & API publik.
 */
export const WINDOW_ENFORCED_PROVIDERS: ReadonlySet<ChannelProvider> = new Set<
  ChannelProvider
>(["whatsapp"]);

export interface MessagingWindowState {
  /** Provider ini punya aturan jendela? false = `open` selalu true. */
  enforced: boolean;
  /** Boleh kirim pesan bebas sekarang? */
  open: boolean;
  lastInboundAt: Date | null;
  expiresAt: Date | null;
}

/**
 * Hitung keadaan jendela. `now` bisa diinjeksi untuk test.
 *
 * Percakapan yang belum pernah menerima pesan masuk dianggap TERTUTUP
 * untuk provider berjendela: tidak ada pesan masuk = tidak ada jendela
 * yang terbuka. Ini juga menangkap percakapan yang kita buat sendiri
 * (mis. dari API) sebelum kontak pernah membalas.
 */
export function computeMessagingWindow(
  provider: ChannelProvider,
  lastInboundAt: Date | null,
  now: Date = new Date(),
): MessagingWindowState {
  if (!WINDOW_ENFORCED_PROVIDERS.has(provider)) {
    return { enforced: false, open: true, lastInboundAt, expiresAt: null };
  }
  if (!lastInboundAt) {
    return { enforced: true, open: false, lastInboundAt: null, expiresAt: null };
  }
  const expiresAt = new Date(lastInboundAt.getTime() + MESSAGING_WINDOW_MS);
  return {
    enforced: true,
    open: now.getTime() < expiresAt.getTime(),
    lastInboundAt,
    expiresAt,
  };
}
