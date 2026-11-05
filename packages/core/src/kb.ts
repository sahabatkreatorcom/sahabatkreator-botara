import { and, desc, eq, sql } from "drizzle-orm";
import {
  kbChunks,
  kbDocuments,
  kbSourceDocuments,
  outboxEvents,
  type Database,
  type KbDocument,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service domain Knowledge Base (Fase 3A, RANCANGAN §5.1 langkah 6 & §6).
 * Transport-agnostic; semua query dalam konteks RLS tenant.
 *
 * Dokumen disimpan utuh di `kb_documents`; saat dibuat, isinya dipecah
 * menjadi chunk ±800 karakter di `kb_chunks` untuk retrieval. Chunk adalah
 * turunan murni dari dokumen — tidak ada endpoint yang mengubah chunk
 * langsung; mengubah dokumen = buat ulang (di fase ini API hanya
 * create/list/get/delete, belum ada update dokumen).
 *
 * Retrieval v1 = full-text Postgres pada kolom `search_vector`
 * (konfigurasi 'simple', ter-generate dari content — lihat schema/agents.ts
 * soal alasan 'simple' untuk korpus campuran id/en).
 *
 * Retrieval v2 (Fase 12D) = HIBRIDA bila pemanggil menyerahkan vektor
 * embedding kueri: kandidat full-text dan kandidat vektor (cosine
 * pgvector atas chunk ber-embedding) digabungkan dengan Reciprocal
 * Rank Fusion dan dipotong ke top-N yang sama. Tanpa vektor, fungsi
 * pencarian berperilaku PERSIS seperti v1. Pembangkitan embedding-nya
 * sendiri hidup di kb-embeddings.ts (job worker `kb.embed` yang dipicu
 * event outbox `kb.embed_requested` dari modul ini & kb-files.ts).
 */

export const KB_CHUNK_SIZE = 800;
export const KB_CHUNK_OVERLAP = 120;

/**
 * Memecah teks menjadi chunk ≤ `size` karakter dengan overlap antar chunk.
 * Memotong pada batas kata/kalimat terdekat bila memungkinkan. Fungsi murni
 * & deterministik (dipakai service dan mudah diuji).
 */
export function chunkText(
  content: string,
  size: number = KB_CHUNK_SIZE,
  overlap: number = KB_CHUNK_OVERLAP,
): string[] {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const breakAt = Math.max(
        slice.lastIndexOf("\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf(" "),
      );
      // Hanya mundur ke batas kata bila tidak terlalu jauh (≥50% ukuran).
      if (breakAt > size * 0.5) end = start + breakAt + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    // Mundur sejauh overlap untuk konteks sambung, tetapi start WAJIB maju.
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export type KbDocumentWithChunkCount = KbDocument & { chunkCount: number };

export async function createKbDocument(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: { title: string; content: string },
): Promise<KbDocumentWithChunkCount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [doc] = await tx
      .insert(kbDocuments)
      .values({
        tenantId: ctx.tenantId,
        title: input.title,
        content: input.content,
      })
      .returning();
    const chunks = chunkText(input.content);
    if (chunks.length > 0) {
      await tx.insert(kbChunks).values(
        chunks.map((content, i) => ({
          tenantId: ctx.tenantId,
          documentId: doc.id,
          chunkIndex: i,
          content,
        })),
      );
      // Fase 12D: minta pembangkitan embedding untuk chunk baru ini —
      // event outbox dalam transaksi yang sama (relay worker → job
      // `kb.embed`). Tanpa provider embedding aktif, job selesai tanpa
      // efek dan chunk tetap bisa dicari full-text.
      await tx.insert(outboxEvents).values({
        tenantId: ctx.tenantId,
        type: "kb.embed_requested",
        payload: { documentId: doc.id },
      });
    }
    return { ...doc, chunkCount: chunks.length };
  });
}

export async function listKbDocuments(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<KbDocumentWithChunkCount[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({
        document: kbDocuments,
        chunkCount: sql<number>`count(${kbChunks.id})::int`,
      })
      .from(kbDocuments)
      .leftJoin(kbChunks, eq(kbChunks.documentId, kbDocuments.id))
      .where(eq(kbDocuments.tenantId, ctx.tenantId))
      .groupBy(kbDocuments.id)
      .orderBy(desc(kbDocuments.createdAt));
    return rows.map((r) => ({ ...r.document, chunkCount: r.chunkCount }));
  });
}

/** Null bila dokumen tidak ada DI tenant ini. */
export async function getKbDocument(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  documentId: string,
): Promise<KbDocumentWithChunkCount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        document: kbDocuments,
        chunkCount: sql<number>`count(${kbChunks.id})::int`,
      })
      .from(kbDocuments)
      .leftJoin(kbChunks, eq(kbChunks.documentId, kbDocuments.id))
      .where(
        and(
          eq(kbDocuments.tenantId, ctx.tenantId),
          eq(kbDocuments.id, documentId),
        ),
      )
      .groupBy(kbDocuments.id)
      .limit(1);
    return row ? { ...row.document, chunkCount: row.chunkCount } : null;
  });
}

/** True bila dokumen milik tenant ini terhapus (chunk ikut cascade). */
export async function deleteKbDocument(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  documentId: string,
): Promise<boolean> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [doc] = await tx
      .select({
        id: kbDocuments.id,
        sourceDocumentId: kbDocuments.sourceDocumentId,
      })
      .from(kbDocuments)
      .where(
        and(
          eq(kbDocuments.tenantId, ctx.tenantId),
          eq(kbDocuments.id, documentId),
        ),
      )
      .limit(1);
    if (!doc) return false;
    await tx
      .delete(kbDocuments)
      .where(
        and(
          eq(kbDocuments.tenantId, ctx.tenantId),
          eq(kbDocuments.id, documentId),
        ),
      );
    // Fase 12C: entri hasil impor berkas — berkas asal ikut dibersihkan
    // agar daftar dokumen tidak menyisakan baris yatim. (Arah sebaliknya
    // — hapus berkas menghapus entri — ditangani cascade FK.)
    if (doc.sourceDocumentId) {
      await tx
        .delete(kbSourceDocuments)
        .where(
          and(
            eq(kbSourceDocuments.tenantId, ctx.tenantId),
            eq(kbSourceDocuments.id, doc.sourceDocumentId),
          ),
        );
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface KbSearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  /**
   * Skor peringkat: mode full-text = ts_rank mentah; mode hibrida =
   * skor Reciprocal Rank Fusion (lihat searchKbChunks). Hanya bermakna
   * sebagai urutan relatif dalam satu hasil pencarian.
   */
  rank: number;
  /** Jalur yang menemukan chunk ini: full-text, vektor, atau keduanya. */
  sources: Array<"fts" | "vector">;
}

/**
 * Mengubah pertanyaan bebas menjadi daftar token OR untuk to_tsquery.
 *
 * Kenapa BUKAN plainto_tsquery: plainto meng-AND-kan semua kata, sehingga
 * pertanyaan alami seperti "berapa harga kelas rekaman kilat?" TIDAK akan
 * cocok dengan dokumen "Harga kelas Rekaman Kilat adalah Rp349 ribu…"
 * hanya karena kata "berapa" tidak ada di dokumen (terbukti di
 * packages/db/scripts/verify.ts). Karena itu token disaring
 * (alfanumerik, ≥3 huruf, maks 12 token unik) lalu digabung OR; urutan
 * hasil ditentukan ts_rank — chunk yang memuat lebih banyak kata tanya
 * naik ke atas. Token disanitasi ketat (hanya huruf/angka) sehingga aman
 * dari sintaks tsquery.
 */
export function buildFtsOrQuery(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const unique = [...new Set(tokens)].slice(0, 12);
  return unique.length > 0 ? unique.join(" | ") : null;
}

/** Konstanta Reciprocal Rank Fusion (Fase 12D) — nilai baku literatur (60). */
export const KB_RRF_K = 60;

/**
 * Lantai kemiripan kosinus untuk kandidat VEKTOR (Fase 12D): chunk
 * yang vektornya nyaris tegak lurus dengan kueri (kosinus di bawah
 * nilai ini) adalah derau, bukan parafrase — tanpa lantai, daftar
 * "tetangga terdekat" selalu penuh walau tidak ada yang relevan dan
 * RRF akan tetap memasukkan derau itu ke konteks agent. 0,05 sengaja
 * konservatif (model asli memberi parafrase relevan jauh di atas ini);
 * ini penyaring derau, BUKAN jaminan relevansi.
 */
export const KB_VECTOR_MIN_SIMILARITY = 0.05;

export interface KbSearchOptions {
  /**
   * Vektor embedding kueri (1536 dimensi, dari provider embedding).
   * Bila terisi & valid, pencarian menjadi HIBRIDA; bila kosong/null
   * (provider nonaktif/gagal), pencarian full-text murni seperti v1.
   * Vektor berdimensi salah diabaikan secara defensif (jatuh ke FTS).
   */
  queryEmbedding?: number[] | null;
}

interface KbCandidateRow {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  rank: number;
}

/**
 * Top-N chunk paling relevan untuk sebuah pertanyaan, HANYA dari KB
 * tenant ini (RLS + filter tenant eksplisit). Kosong bila tidak ada yang
 * cocok — agent menjawab tanpa konteks KB, bukan mengarang.
 *
 * Mode HIBRIDA (Fase 12D, bila `options.queryEmbedding` valid): dua
 * daftar kandidat diambil — full-text (seperti v1) dan tetangga vektor
 * terdekat (cosine pgvector, hanya chunk tenant ini yang embedding-nya
 * sudah terisi) — masing-masing sebanyak `max(2×limit, 10)`, lalu
 * digabungkan dengan Reciprocal Rank Fusion:
 *   skor(chunk) = Σ_daftar 1 / (KB_RRF_K + peringkat_dalam_daftar)
 * RRF dipilih karena ia hanya memakai PERINGKAT, bukan skor mentah —
 * ts_rank dan jarak kosinus tidak sebanding skalanya, jadi normalisasi
 * skor berbobot akan mengarang bobot; RRF adalah gabungan yang jujur
 * untuk dua sinyal yang tidak terkalibrasi. Hasil akhir tetap `limit`.
 */
export async function searchKbChunks(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  query: string,
  limit = 5,
  options?: KbSearchOptions,
): Promise<KbSearchHit[]> {
  const queryEmbedding =
    options?.queryEmbedding && options.queryEmbedding.length === 1536
      ? options.queryEmbedding
      : null;
  const orQuery = buildFtsOrQuery(query);
  // Tanpa token FTS yang sah DAN tanpa vektor, tidak ada sinyal apa pun.
  if (!orQuery && !queryEmbedding) return [];
  const candidateLimit = Math.max(limit * 2, 10);
  const vectorLiteral = queryEmbedding
    ? `[${queryEmbedding.join(",")}]`
    : null;

  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const ftsRows: KbCandidateRow[] = orQuery
      ? await tx
          .select({
            chunkId: kbChunks.id,
            documentId: kbChunks.documentId,
            documentTitle: kbDocuments.title,
            chunkIndex: kbChunks.chunkIndex,
            content: kbChunks.content,
            rank: sql<number>`ts_rank(${kbChunks.searchVector}, to_tsquery('simple', ${orQuery}))`,
          })
          .from(kbChunks)
          .innerJoin(kbDocuments, eq(kbChunks.documentId, kbDocuments.id))
          .where(
            and(
              eq(kbChunks.tenantId, ctx.tenantId),
              sql`${kbChunks.searchVector} @@ to_tsquery('simple', ${orQuery})`,
            ),
          )
          .orderBy(
            desc(sql`ts_rank(${kbChunks.searchVector}, to_tsquery('simple', ${orQuery}))`),
          )
          .limit(queryEmbedding ? candidateLimit : limit)
      : [];

    if (!queryEmbedding || !vectorLiteral) {
      // Mode v1 murni — perilaku & urutan persis seperti sebelum 12D.
      return ftsRows.map((r) => ({ ...r, sources: ["fts" as const] }));
    }

    const distance = sql`${kbChunks.embedding} <=> ${vectorLiteral}::vector`;
    const vectorRows: KbCandidateRow[] = await tx
      .select({
        chunkId: kbChunks.id,
        documentId: kbChunks.documentId,
        documentTitle: kbDocuments.title,
        chunkIndex: kbChunks.chunkIndex,
        content: kbChunks.content,
        rank: sql<number>`1 - (${distance})`,
      })
      .from(kbChunks)
      .innerJoin(kbDocuments, eq(kbChunks.documentId, kbDocuments.id))
      .where(
        and(
          eq(kbChunks.tenantId, ctx.tenantId),
          sql`${kbChunks.embedding} IS NOT NULL`,
          sql`1 - (${distance}) >= ${KB_VECTOR_MIN_SIMILARITY}`,
        ),
      )
      .orderBy(distance)
      .limit(candidateLimit);

    // Reciprocal Rank Fusion atas kedua daftar kandidat.
    const fused = new Map<
      string,
      { row: KbCandidateRow; score: number; sources: Array<"fts" | "vector"> }
    >();
    const addList = (rows: KbCandidateRow[], source: "fts" | "vector") => {
      rows.forEach((row, i) => {
        const contribution = 1 / (KB_RRF_K + i + 1);
        const existing = fused.get(row.chunkId);
        if (existing) {
          existing.score += contribution;
          if (!existing.sources.includes(source)) existing.sources.push(source);
        } else {
          fused.set(row.chunkId, {
            row,
            score: contribution,
            sources: [source],
          });
        }
      });
    };
    addList(ftsRows, "fts");
    addList(vectorRows, "vector");

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score, sources }) => ({ ...row, rank: score, sources }));
  });
}
