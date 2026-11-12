import { and, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import {
  media,
  messages,
  postMedia,
  postQueueItems,
  postRecurrenceRules,
  type Database,
} from "@sahabat-kreator/db";
import type { MediaObjectStore } from "./media-storage";
import { withTenantDb } from "./tx";

/**
 * Pembersihan media (Fase 19).
 *
 * Fase 18 membuat media bisa MASUK dan KELUAR. Tidak ada satu pun kode
 * yang menghapusnya. Empat kebocoran, semuanya senyap:
 *
 *   1. BERKAS YATIM — objek di penyimpanan tanpa baris `media`. Lahir
 *      dari kompensasi yang gagal, proses mati di antara `put` dan
 *      insert, atau DB yang dipulihkan lebih lama dari disk. Tidak
 *      terlihat di mana pun: tidak ada baris, tidak ada error, hanya
 *      disk yang penuh.
 *   2. BARIS TANPA BERKAS — `media` menunjuk objek yang tidak ada
 *      (volume tidak ter-mount, DB dipulihkan tanpa disk). Sampai
 *      sekarang hanya muncul sebagai 404 saat agen membuka percakapan,
 *      SELAMANYA.
 *   3. BARIS TAK DIRUJUK — lampiran diunggah lalu batal dikirim, atau
 *      pesannya sudah dihapus. Baris dan berkasnya tetap ada.
 *   4. RETENSI — media yang sudah melewati masa simpan (opt-in; default
 *      MATI karena menghapus foto pelanggan mengubah riwayat
 *      percakapan).
 *
 * Prinsip yang dipegang di seluruh modul ini:
 * - PEMBACAAN boleh lintas tenant (lengan `system_media_gc_scan`),
 *   PENGHAPUSAN selalu di konteks tenant masing-masing. Bug di jalur
 *   tulis tidak bisa menghapus baris tenant lain.
 * - Baris dihapus DULU, objek SESUDAH. Urutan sebaliknya meninggalkan
 *   baris yang menunjuk berkas hilang — persis kebocoran #2, dan agen
 *   melihat lampiran rusak sampai sapuan berikutnya.
 * - Ada MASA TENGGANG di setiap jalur. Objek yang baru ditulis belum
 *   tentu yatim: barisnya bisa sedang dalam perjalanan ke database.
 * - Semua penghapusan berjalan BERURUTAN, bukan `Promise.all`. Ini
 *   disengaja: tiap item membuka transaksi DB sendiri, dan menjalankan
 *   ratusan transaksi bersamaan akan menghabiskan connection pool lalu
 *   mengunci ratusan baris sekaligus. Ini pekerjaan latar per jam,
 *   bukan jalur request — serialisasi adalah syarat, bukan kelalaian.
 */

/**
 * Umur minimum berkas sebelum boleh dianggap yatim.
 *
 * `ingestMessageMedia` menulis objek lebih dulu, lalu barisnya. Jendela
 * di antaranya hanya milidetik, tetapi proses yang mati tepat di situ
 * meninggalkan berkas yang baru beberapa detik. Tanpa tenggang, sapuan
 * yang kebetulan berjalan di saat yang sama bisa menghapus objek yang
 * barisnya baru masuk sedetik kemudian — dan media pelanggan hilang.
 */
export const MEDIA_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Umur minimum baris tak dirujuk sebelum dihapus.
 *
 * Lebih panjang dari tenggang berkas karena sebabnya berbeda: agen bisa
 * mengunggah lampiran lalu menutup tab sebelum menekan kirim, atau
 * mengunggah untuk template lalu berganti pikiran. Seminggu cukup untuk
 * tidak menghapus sesuatu yang masih "sedang dipakai".
 */
export const MEDIA_UNREFERENCED_GRACE_DAYS = 7;

/** Baris yang diperiksa per putaran — menjaga transaksi tetap pendek. */
export const MEDIA_GC_BATCH_SIZE = 500;

/**
 * Penjaga rasio untuk penghapusan baris tanpa berkas.
 *
 * Kalau `MEDIA_STORAGE_ROOT` salah arah atau volumenya tidak ter-mount,
 * SEMUA baris akan tampak tanpa berkas. Tanpa penjaga, satu kali salah
 * konfigurasi menghapus seluruh riwayat media tenant. Karena itu: bila
 * baris yang hilang lebih dari 20% (dan lebih dari 10 baris), GC
 * MENOLAK menghapus apa pun dan melaporkan `aborted_ratio` — angka itu
 * bukan pola kerusakan normal, melainkan ciri penyimpanan yang tidak
 * terpasang.
 */
export const MEDIA_MISSING_ABORT_RATIO = 0.2;
export const MEDIA_MISSING_ABORT_MIN = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MediaRowRef {
  id: string;
  tenantId: string;
  r2Key: string;
}

/**
 * Baca baris `media` lintas tenant lewat lengan `system_media_gc_scan`
 * (migrasi 0007). SELECT saja — lihat catatan di migrasi itu.
 */
async function scanMediaRows(
  db: Database,
  predicate: SQL | undefined,
  limit: number,
): Promise<MediaRowRef[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_media_gc', 'on', true)`);
    const query = tx
      .select({ id: media.id, tenantId: media.tenantId, r2Key: media.r2Key })
      .from(media);
    const filtered = predicate ? query.where(predicate) : query;
    return filtered.orderBy(media.createdAt).limit(limit);
  });
}

/** Jumlah seluruh baris media — pembagi penjaga rasio. */
async function countMediaRows(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_media_gc', 'on', true)`);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(media);
    return row?.n ?? 0;
  });
}

/** Hapus baris media milik SATU tenant; mengembalikan jumlah terhapus. */
async function deleteRowsForTenant(
  db: Database,
  tenantId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  return withTenantDb(db, tenantId, async (tx) => {
    const rows = await tx
      .delete(media)
      .where(and(eq(media.tenantId, tenantId), inArray(media.id, ids)))
      .returning({ id: media.id });
    return rows.length;
  });
}

/** Kelompokkan baris menurut tenant — penghapusan selalu per tenant. */
function groupByTenant(rows: MediaRowRef[]): Map<string, MediaRowRef[]> {
  const grouped = new Map<string, MediaRowRef[]>();
  for (const row of rows) {
    const list = grouped.get(row.tenantId);
    if (list) list.push(row);
    else grouped.set(row.tenantId, [row]);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// 1. Berkas yatim
// ---------------------------------------------------------------------------

export interface OrphanSweepResult {
  /** Berkas di bawah `tenants/` yang diperiksa. */
  objectsScanned: number;
  /** Tenant yang punya berkas di penyimpanan. */
  tenantsScanned: number;
  deleted: number;
  /** Berkas tanpa baris, tetapi belum melewati masa tenggang. */
  skippedRecent: number;
  /** Berkas di luar tata letak yang dikenal — sengaja TIDAK disentuh. */
  skippedUnknown: number;
}

/**
 * Hapus objek yang tidak dirujuk baris `media` mana pun.
 *
 * Tenant diturunkan dari key (`tenants/{tenantId}/...`), bukan dari
 * daftar tenant di DB: tenant yang barisnya sudah dihapus (cascade) tidak
 * lagi punya baris apa pun, tetapi berkasnya tetap ada — justru itu yang
 * harus dibersihkan.
 */
export async function sweepOrphanMediaObjects(
  db: Database,
  store: MediaObjectStore,
  opts: { graceMs?: number; now?: Date } = {},
): Promise<OrphanSweepResult> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.graceMs ?? MEDIA_ORPHAN_GRACE_MS);

  const entries = await store.list("tenants/");
  const byTenant = new Map<string, typeof entries>();
  let skippedUnknown = 0;
  for (const entry of entries) {
    const parts = entry.key.split("/");
    const tenantSegment = parts[1] ?? "";
    // Tata letak yang dikenal: tenants/{uuid}/{...}. Apa pun selain itu
    // tidak dipahami modul ini — membiarkannya lebih aman daripada
    // menghapus berkas yang mungkin milik fitur lain di kemudian hari.
    if (
      parts.length < 3 ||
      parts[0] !== "tenants" ||
      !UUID_RE.test(tenantSegment)
    ) {
      skippedUnknown += 1;
      continue;
    }
    const list = byTenant.get(tenantSegment);
    if (list) list.push(entry);
    else byTenant.set(tenantSegment, [entry]);
  }

  let deleted = 0;
  let skippedRecent = 0;
  for (const [tenantId, tenantEntries] of byTenant) {
    // Key yang dirujuk baris tenant ini. Dibaca di konteks tenant —
    // RLS memastikan tidak ada kebocoran lintas tenant di sini.
    const referenced = new Set(
      await withTenantDb(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ r2Key: media.r2Key })
          .from(media)
          .where(eq(media.tenantId, tenantId));
        return rows.map((row) => row.r2Key);
      }),
    );

    for (const entry of tenantEntries) {
      if (referenced.has(entry.key)) continue;
      if (entry.lastModified.getTime() > cutoff) {
        skippedRecent += 1;
        continue;
      }
      try {
        await store.delete(entry.key);
        deleted += 1;
      } catch {
        // Satu berkas gagal dihapus tidak boleh menghentikan sisanya;
        // putaran berikutnya akan mencobanya lagi.
      }
    }
  }

  return {
    objectsScanned: entries.length,
    tenantsScanned: byTenant.size,
    deleted,
    skippedRecent,
    skippedUnknown,
  };
}

// ---------------------------------------------------------------------------
// 2. Baris tanpa berkas
// ---------------------------------------------------------------------------

export type MissingPruneResult =
  | {
      kind: "pruned";
      checked: number;
      total: number;
      missing: number;
      deleted: number;
    }
  | {
      kind: "aborted_ratio";
      checked: number;
      total: number;
      missing: number;
      deleted: 0;
    };

/**
 * Hapus baris `media` yang objeknya tidak ada.
 *
 * Baris seperti ini tidak bisa diperbaiki: URL unduhan Meta sudah
 * kedaluwarsa (±5 menit), jadi berkasnya tidak bisa diambil ulang.
 * Membiarkannya hanya membuat agen menekan lampiran dan menerima 404
 * tanpa penjelasan, selamanya.
 */
export async function pruneMediaWithMissingObjects(
  db: Database,
  store: MediaObjectStore,
  opts: { limit?: number } = {},
): Promise<MissingPruneResult> {
  const limit = opts.limit ?? MEDIA_GC_BATCH_SIZE;
  const rows = await scanMediaRows(db, undefined, limit);
  const total = await countMediaRows(db);

  const missing: MediaRowRef[] = [];
  for (const row of rows) {
    if (!(await store.exists(row.r2Key))) missing.push(row);
  }

  // Penjaga penyimpanan tidak terpasang — lihat catatan konstanta.
  if (
    missing.length > MEDIA_MISSING_ABORT_MIN &&
    total > 0 &&
    missing.length / total > MEDIA_MISSING_ABORT_RATIO
  ) {
    return {
      kind: "aborted_ratio",
      checked: rows.length,
      total,
      missing: missing.length,
      deleted: 0,
    };
  }

  let deleted = 0;
  for (const [tenantId, tenantRows] of groupByTenant(missing)) {
    deleted += await deleteRowsForTenant(
      db,
      tenantId,
      tenantRows.map((row) => row.id),
    );
  }
  return {
    kind: "pruned",
    checked: rows.length,
    total,
    missing: missing.length,
    deleted,
  };
}

// ---------------------------------------------------------------------------
// 3. Baris tak dirujuk pesan
// ---------------------------------------------------------------------------

export interface UnreferencedPruneResult {
  scanned: number;
  /** Baris tanpa pesan yang merujuk DAN sudah lewat masa tenggang. */
  candidates: number;
  deleted: number;
  objectsDeleted: number;
}

/**
 * Hapus media yang tidak dirujuk pesan mana pun setelah masa tenggang.
 *
 * "Tidak dirujuk" diperiksa di dalam konteks tenant dengan NOT EXISTS
 * pada `messages`: media yang pesannya sudah dihapus (purge percakapan)
 * ikut tersapu, dan media yang masih menunggu antrean TIDAK tersentuh
 * karena pesannya ada — berapa pun statusnya.
 */
export async function pruneUnreferencedMedia(
  db: Database,
  store: MediaObjectStore,
  opts: { graceDays?: number; limit?: number; now?: Date } = {},
): Promise<UnreferencedPruneResult> {
  const now = opts.now ?? new Date();
  const graceDays = opts.graceDays ?? MEDIA_UNREFERENCED_GRACE_DAYS;
  const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);

  const rows = await scanMediaRows(
    db,
    lt(media.createdAt, cutoff),
    opts.limit ?? MEDIA_GC_BATCH_SIZE,
  );

  let deleted = 0;
  let objectsDeleted = 0;
  let candidates = 0;
  for (const [tenantId, tenantRows] of groupByTenant(rows)) {
    const orphaned = await withTenantDb(db, tenantId, async (tx) => {
      return tx
        .select({ id: media.id, r2Key: media.r2Key })
        .from(media)
        .where(
          and(
            eq(media.tenantId, tenantId),
            inArray(
              media.id,
              tenantRows.map((row) => row.id),
            ),
            // Fase 23: media yang dirujuk postingan terjadwal BUKAN sampah.
            // Tanpa lengan ini, aset sebuah post yang dijadwalkan dua
            // minggu ke depan dihapus lebih dulu (masa tenggang 7 hari),
            // dan kegagalannya baru terlihat saat jam tayang. FK
            // `post_media.media_id` yang RESTRICT adalah jaring kedua bila
            // penghitungan di sini suatu saat salah.
            // Fase Susulan S2: rujukan yang sama kini juga datang dari
            // SNAPSHOT templat aturan postingan berulang yang belum
            // terminal (media_ids jsonb) dan item antrean rutin yang
            // masih `queued` — keduanya belum punya baris post_media
            // sampai slotnya materialisasi, jadi tanpa dua lengan ini
            // aset templat/antrean terhapus sebelum jam tayangnya.
            sql`NOT EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.mediaId} = ${media.id})
                AND NOT EXISTS (SELECT 1 FROM ${postMedia} WHERE ${postMedia.mediaId} = ${media.id})
                AND NOT EXISTS (SELECT 1 FROM ${postRecurrenceRules} WHERE ${postRecurrenceRules.tenantId} = ${media.tenantId} AND ${postRecurrenceRules.status} IN ('active', 'paused') AND ${postRecurrenceRules.mediaIds} @> jsonb_build_array(${media.id}::text))
                AND NOT EXISTS (SELECT 1 FROM ${postQueueItems} WHERE ${postQueueItems.tenantId} = ${media.tenantId} AND ${postQueueItems.status} = 'queued' AND ${postQueueItems.mediaIds} @> jsonb_build_array(${media.id}::text))`,
          ),
        );
    });
    if (orphaned.length === 0) continue;
    candidates += orphaned.length;

    const removed = await deleteRowsForTenant(
      db,
      tenantId,
      orphaned.map((row) => row.id),
    );
    deleted += removed;
    // Baris sudah hilang; sisa berkas yang gagal dihapus akan disapu
    // jalur berkas yatim pada putaran berikutnya.
    for (const row of orphaned) {
      try {
        await store.delete(row.r2Key);
        objectsDeleted += 1;
      } catch {
        /* dicoba lagi oleh sapuan berkas yatim */
      }
    }
  }

  return { scanned: rows.length, candidates, deleted, objectsDeleted };
}

// ---------------------------------------------------------------------------
// 4. Retensi (opt-in)
// ---------------------------------------------------------------------------

export type RetentionPruneResult =
  | { kind: "disabled"; deleted: 0; objectsDeleted: 0 }
  | {
      kind: "pruned";
      retentionDays: number;
      scanned: number;
      deleted: number;
      objectsDeleted: number;
      /** Baris tua yang DIPERTAHANKAN karena masih menunggu dikirim. */
      keptQueued: number;
    };

/**
 * Hapus media yang lebih tua dari `retentionDays`.
 *
 * Default MATI (`0`): menghapus foto yang dikirim pelanggan mengubah
 * riwayat percakapan mereka, dan itu keputusan produk — bukan efek
 * samping yang boleh terjadi tanpa diminta. Saat dinyalakan, pesannya
 * TETAP ada (`messages.media_id` menjadi NULL lewat FK) dan caption
 * tetap terbaca; yang hilang hanya berkasnya.
 *
 * Satu pengecualian penting: media milik pesan berstatus `queued` TIDAK
 * dihapus. Antrean bisa tertahan berjam-jam (token bermasalah, worker
 * mati), dan menghapus lampirannya berarti pesan yang tadinya akan
 * terkirim berubah menjadi gagal permanen.
 */
export async function pruneExpiredMedia(
  db: Database,
  store: MediaObjectStore,
  opts: { retentionDays: number; limit?: number; now?: Date },
): Promise<RetentionPruneResult> {
  if (!Number.isFinite(opts.retentionDays) || opts.retentionDays <= 0) {
    return { kind: "disabled", deleted: 0, objectsDeleted: 0 };
  }
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000);

  const rows = await scanMediaRows(
    db,
    lt(media.createdAt, cutoff),
    opts.limit ?? MEDIA_GC_BATCH_SIZE,
  );

  let deleted = 0;
  let objectsDeleted = 0;
  let keptQueued = 0;
  for (const [tenantId, tenantRows] of groupByTenant(rows)) {
    const expired = await withTenantDb(db, tenantId, async (tx) => {
      return tx
        .select({ id: media.id, r2Key: media.r2Key })
        .from(media)
        .where(
          and(
            eq(media.tenantId, tenantId),
            inArray(
              media.id,
              tenantRows.map((row) => row.id),
            ),
            sql`NOT EXISTS (
                  SELECT 1 FROM ${messages}
                   WHERE ${messages.mediaId} = ${media.id}
                     AND ${messages.status} = 'queued'
                )`,
          ),
        );
    });
    keptQueued += tenantRows.length - expired.length;
    if (expired.length === 0) continue;

    const removed = await deleteRowsForTenant(
      db,
      tenantId,
      expired.map((row) => row.id),
    );
    deleted += removed;
    for (const row of expired) {
      try {
        await store.delete(row.r2Key);
        objectsDeleted += 1;
      } catch {
        /* dicoba lagi oleh sapuan berkas yatim */
      }
    }
  }

  return {
    kind: "pruned",
    retentionDays: opts.retentionDays,
    scanned: rows.length,
    deleted,
    objectsDeleted,
    keptQueued,
  };
}

// ---------------------------------------------------------------------------
// Orkestrasi
// ---------------------------------------------------------------------------

export interface MediaGcSummary {
  missing: MissingPruneResult;
  unreferenced: UnreferencedPruneResult;
  retention: RetentionPruneResult;
  orphans: OrphanSweepResult;
}

/**
 * Satu putaran pembersihan, urutan yang disengaja:
 *
 *   1. baris tanpa berkas  → membersihkan rujukan yang sudah rusak;
 *   2. baris tak dirujuk   → menghapus baris + berkasnya;
 *   3. retensi (opt-in)    → menghapus baris + berkasnya;
 *   4. berkas yatim        → menangkap sisa yang tidak punya baris lagi.
 *
 * Berkas yatim DIAKHIRI supaya ia juga menyapu kegagalan hapus objek dari
 * langkah 2 dan 3 — tetapi tetap tunduk pada masa tenggang, jadi berkas
 * yang baru ditulis tidak ikut terhapus.
 */
export async function runMediaGcCycle(
  db: Database,
  store: MediaObjectStore,
  opts: { retentionDays?: number; now?: Date; limit?: number } = {},
): Promise<MediaGcSummary> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? MEDIA_GC_BATCH_SIZE;
  const missing = await pruneMediaWithMissingObjects(db, store, { limit });
  const unreferenced = await pruneUnreferencedMedia(db, store, { limit, now });
  const retention = await pruneExpiredMedia(db, store, {
    retentionDays: opts.retentionDays ?? 0,
    limit,
    now,
  });
  const orphans = await sweepOrphanMediaObjects(db, store, { now });
  return { missing, unreferenced, retention, orphans };
}
