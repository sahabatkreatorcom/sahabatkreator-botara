import { inArray, lt } from "drizzle-orm";
import { authSession, type Database } from "@sahabat-kreator/db";

/**
 * Pembersihan sesi login kedaluwarsa (Fase 22, audit A5).
 *
 * Better Auth menyimpan sesi di `auth_session` dan memeriksa `expires_at`
 * pada setiap permintaan — jadi sesi yang kedaluwarsa SUDAH tidak bisa
 * dipakai. Yang tidak pernah terjadi adalah menghapus barisnya: sesi hanya
 * hilang saat pengguna menekan logout. Sesi yang ditinggalkan (menutup
 * browser tanpa logout) tersimpan selamanya.
 *
 * Dampaknya kecil — barisnya sempit, tanpa payload besar — tetapi sifatnya
 * sama dengan kebocoran lain yang sudah ditutup: tumbuh tanpa batas dan
 * tidak ada yang memberi tahu. Tabel ini juga menyimpan `ip_address` dan
 * `user_agent`, jadi menyimpannya selamanya bukan pilihan netral.
 *
 * TIDAK perlu lengan RLS: `auth_session` adalah tabel global (tanpa
 * `tenant_id`), di luar isolasi tenant.
 */

/**
 * Sesi dipertahankan beberapa hari SETELAH kedaluwarsa.
 *
 * Bukan untuk keamanan (sesi kedaluwarsa sudah ditolak), melainkan untuk
 * menjawab pertanyaan "kenapa saya tiba-tiba diminta login lagi": dengan
 * jeda ini, barisnya masih ada saat pengguna melapor, dan `expires_at`
 * memberi jawaban yang pasti.
 */
export const AUTH_SESSION_GRACE_DAYS = 7;

/** Baris per transaksi — menjaga transaksi pendek. */
const AUTH_SESSION_PRUNE_BATCH = 5000;

export interface AuthSessionPruneResult {
  deleted: number;
}

/**
 * Hapus sesi yang sudah kedaluwarsa melewati masa tenggang.
 *
 * Sengaja TIDAK memakai index pada `expires_at`: begitu sapuan ini rutin
 * berjalan, isi tabel hanya sesi aktif + sisa masa tenggang — jumlahnya
 * kecil, dan index tambahan akan membebani setiap login (setiap sesi baru
 * harus menulis index itu). Berbeda dengan `outbox_events`, di mana baris
 * yang dicari (dead-letter) jarang berada di dalam tabel yang besar.
 */
export async function pruneExpiredAuthSessions(
  db: Database,
  opts: { graceDays?: number; now?: Date; batchSize?: number } = {},
): Promise<AuthSessionPruneResult> {
  const now = opts.now ?? new Date();
  const graceDays = opts.graceDays ?? AUTH_SESSION_GRACE_DAYS;
  const batchSize = opts.batchSize ?? AUTH_SESSION_PRUNE_BATCH;
  const cutoff = new Date(now.getTime() - graceDays * 86_400_000);

  let deleted = 0;
  for (;;) {
    const doomed = db
      .select({ id: authSession.id })
      .from(authSession)
      .where(lt(authSession.expiresAt, cutoff))
      .limit(batchSize);
    const rows = await db
      .delete(authSession)
      .where(inArray(authSession.id, doomed))
      .returning({ id: authSession.id });
    deleted += rows.length;
    // Batch penuh berarti mungkin masih ada sisa; batch kurang dari penuh
    // berarti sudah habis.
    if (rows.length < batchSize) break;
  }

  return { deleted };
}
