import { and, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  kbChunks,
  kbDocuments,
  kbSourceDocuments,
  outboxEvents,
  type Database,
} from "@sahabat-kreator/db";
import { extractText, getDocumentProxy } from "unpdf";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";
import { chunkText } from "./kb";

/**
 * Lampiran berkas Knowledge Base (Fase 12C) — unggah PDF/TXT/MD menjadi
 * pengetahuan agent tanpa mengubah jalur retrieval:
 *
 * - Byte asli disimpan di `kb_source_documents` (bytea di DB, pola
 *   profile_photos 6D — belum ada konsumen R2; berkas dibatasi ≤5MB).
 * - Teks hasil ekstraksi menjadi SATU entri `kb_documents` biasa dengan
 *   `source_document_id` terisi (judul = nama berkas) dan dipecah ke
 *   `kb_chunks` — retrieval full-text agent (kb.ts) menemukan chunk ini
 *   tanpa perubahan apa pun.
 * - Menghapus berkas men-cascade (FK) ke entri + chunk turunannya;
 *   menghapus entri dari daftar dokumen juga membersihkan berkas
 *   asalnya (lihat deleteKbDocument di kb.ts), jadi kedua daftar tidak
 *   pernah yatim sebelah. Entri tulis tangan (source NULL) tak tersentuh.
 *
 * Ekstraksi PDF memakai `unpdf` (pdf.js versi serverless — murni JS,
 * tanpa layanan eksternal, jalan di Node & Bun). PDF hasil pindaian
 * (gambar tanpa lapisan teks) menghasilkan teks kosong dan DITOLAK
 * lapisan API dengan KB_DOCUMENT_NO_TEXT — OCR tidak termasuk v1.
 * Unduh berkas asli juga tidak dibuat di v1: byte hanya disimpan.
 */

export const KB_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** Ukuran maksimum satu chunk impor berkas (rentang brief ±800–1200). */
export const KB_FILE_CHUNK_MAX = 1200;
/** Tumpang tindih antar chunk impor berkas (±100 karakter). */
export const KB_FILE_CHUNK_OVERLAP = 100;

export type KbFileKind = "pdf" | "text" | "markdown";

export interface ResolvedKbFileKind {
  kind: KbFileKind;
  /** MIME kanonis yang disimpan (ekstensi menang atas klaim browser). */
  mimeType: string;
}

/**
 * Menentukan jenis berkas yang diterima. Ekstensi didahulukan karena
 * MIME dari browser/OS tidak konsisten (mis. .md sering terkirim
 * sebagai text/plain atau octet-stream); MIME hanya penolong bila
 * ekstensi tidak dikenal. Di luar PDF/TXT/MD → null (API menjawab 422
 * KB_DOCUMENT_TYPE_UNSUPPORTED).
 */
export function resolveKbFileKind(
  fileName: string,
  mimeType: string | null | undefined,
): ResolvedKbFileKind | null {
  const name = fileName.toLowerCase();
  const mime = (mimeType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (name.endsWith(".pdf")) return { kind: "pdf", mimeType: "application/pdf" };
  if (name.endsWith(".md") || name.endsWith(".markdown")) {
    return { kind: "markdown", mimeType: "text/markdown" };
  }
  if (name.endsWith(".txt")) return { kind: "text", mimeType: "text/plain" };
  if (mime === "application/pdf") {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  if (mime === "text/markdown" || mime === "text/x-markdown") {
    return { kind: "markdown", mimeType: "text/markdown" };
  }
  if (mime === "text/plain") return { kind: "text", mimeType: "text/plain" };
  return null;
}

/**
 * Ekstrak teks polos dari byte berkas. Melempar bila berkas tidak bisa
 * dibaca (PDF rusak dsb.) — lapisan API memetakan lemparan maupun teks
 * kosong ke 422 KB_DOCUMENT_NO_TEXT dan berkas TIDAK disimpan.
 */
export async function extractKbFileText(
  kind: KbFileKind,
  data: Buffer,
): Promise<string> {
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return typeof text === "string" ? text : "";
  }
  // TXT/MD dibaca sebagai UTF-8; BOM dibuang agar chunk pertama bersih.
  return data.toString("utf8").replace(/^\uFEFF/, "");
}

/**
 * Memecah teks dokumen menjadi chunk sadar-paragraf: paragraf (blok
 * yang dipisahkan baris kosong) dikemas utuh sampai ±1200 karakter;
 * paragraf yang lebih panjang dipecah dengan pemecah batas kata/kalimat
 * yang sama seperti chunk entri manual. Antar chunk ada tumpang tindih
 * ±100 karakter (ekor chunk sebelumnya menjadi pembuka chunk berikut,
 * dipotong pada batas kata) agar konteks perbatasan tidak hilang.
 * Fungsi murni & deterministik.
 */
export function chunkKbDocumentText(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return [];
  if (text.length <= KB_FILE_CHUNK_MAX) return [text];

  const units: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= KB_FILE_CHUNK_MAX) units.push(p);
    else units.push(...chunkText(p, KB_FILE_CHUNK_MAX, KB_FILE_CHUNK_OVERLAP));
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    if ((current + "\n\n" + unit).length <= KB_FILE_CHUNK_MAX) {
      current += "\n\n" + unit;
      continue;
    }
    chunks.push(current);
    let tail = current.slice(-KB_FILE_CHUNK_OVERLAP);
    const spaceAt = tail.indexOf(" ");
    if (spaceAt > 0) tail = tail.slice(spaceAt + 1);
    current =
      tail && (tail + "\n\n" + unit).length <= KB_FILE_CHUNK_MAX
        ? tail + "\n\n" + unit
        : unit;
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface KbFileWithEntry {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  chunkCount: number;
  /** Id entri `kb_documents` turunan berkas ini. */
  documentId: string;
  createdAt: Date;
}

/**
 * Menyimpan berkas + entri turunan + chunk-nya dalam satu transaksi,
 * plus audit `kb_document.uploaded`. `text` adalah teks ekstraksi yang
 * SUDAH divalidasi tidak kosong oleh pemanggil.
 */
export async function importKbFile(
  db: Database,
  ctx: Pick<TenantContext, "tenantId"> & { userId: string },
  input: { fileName: string; mimeType: string; data: Buffer; text: string },
): Promise<KbFileWithEntry> {
  const chunks = chunkKbDocumentText(input.text);
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [file] = await tx
      .insert(kbSourceDocuments)
      .values({
        tenantId: ctx.tenantId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: input.data.byteLength,
        data: input.data,
        chunkCount: chunks.length,
        createdBy: ctx.userId,
      })
      .returning();
    const [doc] = await tx
      .insert(kbDocuments)
      .values({
        tenantId: ctx.tenantId,
        title: input.fileName,
        content: input.text,
        sourceDocumentId: file.id,
      })
      .returning();
    if (chunks.length > 0) {
      await tx.insert(kbChunks).values(
        chunks.map((content, i) => ({
          tenantId: ctx.tenantId,
          documentId: doc.id,
          chunkIndex: i,
          content,
        })),
      );
      // Fase 12D: chunk impor ikut antre embedding (event yang sama
      // seperti entri tulis tangan — relay worker → job `kb.embed`).
      await tx.insert(outboxEvents).values({
        tenantId: ctx.tenantId,
        type: "kb.embed_requested",
        payload: { documentId: doc.id },
      });
    }
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "kb_document.uploaded",
      meta: {
        sourceDocumentId: file.id,
        documentId: doc.id,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: input.data.byteLength,
        chunkCount: chunks.length,
      },
    });
    return {
      id: file.id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      byteSize: file.byteSize,
      chunkCount: chunks.length,
      documentId: doc.id,
      createdAt: file.createdAt,
    };
  });
}

/** Daftar berkas tenant (TANPA byte — byte tidak pernah keluar API v1). */
export async function listKbFiles(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<KbFileWithEntry[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: kbSourceDocuments.id,
        fileName: kbSourceDocuments.fileName,
        mimeType: kbSourceDocuments.mimeType,
        byteSize: kbSourceDocuments.byteSize,
        chunkCount: kbSourceDocuments.chunkCount,
        createdAt: kbSourceDocuments.createdAt,
        documentId: kbDocuments.id,
      })
      .from(kbSourceDocuments)
      .innerJoin(
        kbDocuments,
        eq(kbDocuments.sourceDocumentId, kbSourceDocuments.id),
      )
      .where(eq(kbSourceDocuments.tenantId, ctx.tenantId))
      .orderBy(desc(kbSourceDocuments.createdAt));
    return rows;
  });
}

/**
 * Hapus berkas: baris sumber terhapus → entri + chunk ikut cascade.
 * Audit `kb_document.deleted`. False bila bukan milik tenant ini.
 */
export async function deleteKbFile(
  db: Database,
  ctx: Pick<TenantContext, "tenantId"> & { userId: string },
  fileId: string,
): Promise<boolean> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: kbSourceDocuments.id,
        fileName: kbSourceDocuments.fileName,
        chunkCount: kbSourceDocuments.chunkCount,
      })
      .from(kbSourceDocuments)
      .where(
        and(
          eq(kbSourceDocuments.tenantId, ctx.tenantId),
          eq(kbSourceDocuments.id, fileId),
        ),
      )
      .limit(1);
    if (!row) return false;
    await tx
      .delete(kbSourceDocuments)
      .where(
        and(
          eq(kbSourceDocuments.tenantId, ctx.tenantId),
          eq(kbSourceDocuments.id, fileId),
        ),
      );
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "kb_document.deleted",
      meta: {
        sourceDocumentId: row.id,
        fileName: row.fileName,
        chunkCount: row.chunkCount,
      },
    });
    return true;
  });
}
