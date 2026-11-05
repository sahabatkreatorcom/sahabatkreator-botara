import { sql } from "drizzle-orm";

/**
 * Klaim pengiriman outbound (Hotfix analisis 2026-11-03).
 *
 * MASALAH: poller pengiriman (Telegram & Meta) memindai antrean lintas
 * tenant lalu mengirim. Penjaga `running` hanya berlaku per proses — bila
 * API dijalankan lebih dari satu replica, dua replica bisa memindai baris
 * `queued` yang sama dan mengirim pesan DUPLIKAT ke pelanggan.
 *
 * SOLUSI: sebelum mengirim, poller mengklaim baris lewat UPDATE atomik
 * (`claimOutboundMessage`). Klaim yang menang adalah satu-satunya yang
 * mengirim; yang kalah mendapat 0 baris dan melewati pesan itu.
 *
 * Kolom `messages.claimed_at` (bukan status enum baru) dipilih sengaja:
 * - status tetap `queued` selama pengiriman berlangsung, sehingga
 *   `reconcileBroadcasts` (cast status pesan → status penerima), UI inbox,
 *   dan pembatalan broadcast tidak perlu tahu apa pun;
 * - kegagalan proses di tengah jalan pulih otomatis: klaim yang lebih tua
 *   dari ambang di bawah boleh diambil alih poller lain (tanpa sweeper).
 */
export const OUTBOUND_CLAIM_STALE_MS = 120_000;

/**
 * Fragmen SQL "klaim sudah basi" — dipakai bersama oleh claim dan kedua
 * query pindai agar ambangnya tidak pernah menyimpang antar tempat.
 */
export const outboundClaimStale = sql`now() - (${OUTBOUND_CLAIM_STALE_MS} * interval '1 millisecond')`;
