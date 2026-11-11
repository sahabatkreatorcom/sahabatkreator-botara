import { and, eq, isNull, sql } from "drizzle-orm";
import {
  kbChunks,
  usageLedger,
  type Database,
} from "@sahabat-kreator/db";
import {
  EMBEDDING_DIMENSIONS,
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "@sahabat-kreator/ai";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";
import {
  getProviderSecret,
  resolveOpenRouterConfig,
  type PlatformSettingsOptions,
} from "./platform-settings";

/**
 * Pembangkitan embedding Knowledge Base (Fase 12D) — sisi TULIS dari
 * retrieval semantik (sisi bacanya: `searchKbChunks` di kb.ts).
 *
 * Alur: entri KB dibuat/diimpor → event outbox `kb.embed_requested`
 * (ditulis kb.ts/kb-files.ts dalam transaksi yang sama) → relay worker
 * → job BullMQ `kb.embed` → `embedKbDocumentChunks` di sini. Provider
 * di-resolve per job oleh pemanggil lewat `resolveEmbeddingProvider`
 * (Panel Admin → env untuk kunci OpenRouter; env EMBEDDING_PROVIDER=
 * mock memaksa mock deterministik untuk rantai uji). Tanpa provider,
 * job selesai tanpa efek: chunk tetap NULL dan retrieval full-text
 * tetap bekerja — embedding adalah peningkatan, bukan syarat.
 *
 * Predikat "menunggu embedding" = `embedding IS NULL`, dan itu LENGKAP:
 * konten chunk tidak pernah berubah di tempat pada seluruh permukaan
 * API saat ini (dokumen hanya dibuat & dihapus; mengganti dokumen =
 * hapus + buat baru = chunk baru ber-embedding NULL). Penggantian model
 * embedding secara menyeluruh ditangani skrip backfill mode `--all`
 * (NULL-kan semua, embed ulang) — bukan tebakan per baris.
 *
 * Metering (aturan kejujuran Fase 9B): setiap panggilan provider
 * dicatat sebagai baris usage_ledger type 'ai_token' dengan refType
 * `kb_embedding` — TERPISAH dari refType `agent_response`, jadi
 * embedding TIDAK PERNAH mengonsumsi cap 200 respons agent/hari (cap
 * itu menghitung baris agent_response saja, lihat agent-runtime.ts).
 * Biaya hanya dicatat bila provider melaporkannya (costUsd).
 */

export const KB_EMBEDDING_REF_TYPE = "kb_embedding";
/** Jumlah teks maksimum per panggilan provider (batch per dokumen). */
export const KB_EMBED_BATCH_SIZE = 32;

// ---------------------------------------------------------------------------
// Resolusi provider (dipakai worker & API untuk status, per proses)
// ---------------------------------------------------------------------------

export interface EmbeddingResolutionOptions {
  /** Opsi resolver Panel Admin proses ini (kunci OpenRouter panel→env). */
  platform: PlatformSettingsOptions;
  /** Nilai env EMBEDDING_PROVIDER proses ini: 'mock' | 'openrouter' | undefined. */
  providerEnv?: string;
  /** Nilai env OPENROUTER_EMBEDDING_MODEL proses ini. */
  modelEnv?: string;
}

/**
 * Provider embedding efektif proses ini, atau null bila nonaktif:
 * - EMBEDDING_PROVIDER=mock → mock deterministik (rantai uji; menang
 *   atas kunci agar rantai tidak pernah menyentuh jaringan/provider);
 * - selain itu, kunci OpenRouter efektif (panel → env) → OpenRouter;
 * - tanpa kunci di mana pun → null (nonaktif dengan anggun).
 */
export async function resolveEmbeddingProvider(
  db: Database,
  opts: EmbeddingResolutionOptions,
): Promise<EmbeddingProvider | null> {
  if (opts.providerEnv === "mock") {
    return createEmbeddingProvider({ provider: "mock" });
  }
  const orConfig = await resolveOpenRouterConfig(db, opts.platform);
  if (!orConfig) return null;
  // Model embedding efektif: Panel Admin `openrouter_embedding_model`
  // → env OPENROUTER_EMBEDDING_MODEL → default provider (instruksi
  // pemilik 2026-11-12; pola yang sama seperti model chat). `modelEnv`
  // tetap diterima untuk pemanggil lama dan menjadi fallback-nya.
  const panelModel = await getProviderSecret(
    db,
    "openrouter_embedding_model",
    opts.platform,
  );
  return createEmbeddingProvider({
    provider: "openrouter",
    openrouterApiKey: orConfig.apiKey,
    openrouterEmbeddingModel: panelModel ?? opts.modelEnv,
  });
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

async function recordEmbeddingUsage(
  tx: DbTx,
  tenantId: string,
  input: {
    kind: "chunk" | "query";
    refId: string | null;
    result: EmbeddingResult;
    chunkCount?: number;
  },
): Promise<void> {
  const meta: Record<string, unknown> = {
    kind: input.kind,
    provider: input.result.provider,
    model: input.result.model,
    tokensIn: input.result.usage.tokensIn,
    tokensOut: 0,
  };
  if (input.chunkCount !== undefined) meta.chunks = input.chunkCount;
  if (input.result.usage.costUsd !== undefined) {
    meta.costUsd = input.result.usage.costUsd;
    meta.costCurrency = "USD";
  }
  await tx.insert(usageLedger).values({
    tenantId,
    type: "ai_token",
    qty: String(input.result.usage.tokensIn),
    costModel: "0",
    costProvider: "0",
    currency: "IDR",
    refType: KB_EMBEDDING_REF_TYPE,
    refId: input.refId,
    meta,
  });
}

function assertEmbeddingShape(
  result: EmbeddingResult,
  expectedCount: number,
): void {
  if (result.vectors.length !== expectedCount) {
    throw new Error(
      `embedding provider ${result.provider}: ${result.vectors.length} vektor untuk ${expectedCount} teks`,
    );
  }
  for (const vector of result.vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedding provider ${result.provider}: dimensi ${vector.length}, diharapkan ${EMBEDDING_DIMENSIONS}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pembangkitan per dokumen (jalur job `kb.embed`)
// ---------------------------------------------------------------------------

export interface KbEmbedOutcome {
  /** Chunk yang berhasil di-embed pada panggilan ini. */
  embedded: number;
  /** Token input total yang dilaporkan provider pada panggilan ini. */
  tokensIn: number;
}

/**
 * Meng-embed semua chunk dokumen ini yang embedding-nya masih NULL.
 * Idempoten: dokumen yang sudah ter-embed penuh menghasilkan
 * { embedded: 0 } TANPA panggilan provider. Panggilan provider terjadi
 * DI LUAR transaksi DB (jaringan tidak menahan transaksi); penulisan
 * vektor + baris usage per batch dalam satu transaksi tenant.
 * Error provider DILEMPAR keluar — job BullMQ yang retry (percobaan
 * wajar), penyimpanan dokumen sendiri tidak pernah digagalkan di sini
 * karena jalur ini asinkron sejak awal (event outbox).
 */
export async function embedKbDocumentChunks(
  db: Database,
  provider: EmbeddingProvider,
  input: { tenantId: string; documentId: string },
): Promise<KbEmbedOutcome> {
  const pending = await withTenantDb(db, input.tenantId, async (tx) => {
    return tx
      .select({ id: kbChunks.id, content: kbChunks.content })
      .from(kbChunks)
      .where(
        and(
          eq(kbChunks.tenantId, input.tenantId),
          eq(kbChunks.documentId, input.documentId),
          isNull(kbChunks.embedding),
        ),
      )
      .orderBy(kbChunks.chunkIndex);
  });

  let embedded = 0;
  let tokensIn = 0;
  for (let i = 0; i < pending.length; i += KB_EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + KB_EMBED_BATCH_SIZE);
    const result = await provider.embed(batch.map((c) => c.content));
    assertEmbeddingShape(result, batch.length);
    tokensIn += result.usage.tokensIn;
    await withTenantDb(db, input.tenantId, async (tx) => {
      for (const [j, chunk] of batch.entries()) {
        await tx
          .update(kbChunks)
          .set({ embedding: result.vectors[j] })
          .where(
            and(
              eq(kbChunks.tenantId, input.tenantId),
              eq(kbChunks.id, chunk.id),
              // Penjaga balapan: jangan timpa vektor yang sudah terisi
              // oleh job duplikat yang berjalan bersamaan.
              isNull(kbChunks.embedding),
            ),
          );
      }
      await recordEmbeddingUsage(tx, input.tenantId, {
        kind: "chunk",
        refId: input.documentId,
        result,
        chunkCount: batch.length,
      });
    });
    embedded += batch.length;
  }
  return { embedded, tokensIn };
}

// ---------------------------------------------------------------------------
// Backfill (skrip run-once; juga jembatan uji rantai)
// ---------------------------------------------------------------------------

/**
 * Meng-embed chunk tertunda SATU tenant lintas dokumen, sampai habis
 * atau `maxChunks` tercapai. Mengembalikan sisa tertunda agar pemanggil
 * (skrip backfill) bisa melaporkan dengan jujur.
 */
export async function embedPendingKbChunksForTenant(
  db: Database,
  provider: EmbeddingProvider,
  input: { tenantId: string; maxChunks?: number },
): Promise<KbEmbedOutcome & { remaining: number }> {
  const maxChunks = input.maxChunks ?? 1_000;
  let embedded = 0;
  let tokensIn = 0;
  while (embedded < maxChunks) {
    const [next] = await withTenantDb(db, input.tenantId, async (tx) => {
      return tx
        .select({ documentId: kbChunks.documentId })
        .from(kbChunks)
        .where(
          and(
            eq(kbChunks.tenantId, input.tenantId),
            isNull(kbChunks.embedding),
          ),
        )
        .limit(1);
    });
    if (!next) break;
    const outcome = await embedKbDocumentChunks(db, provider, {
      tenantId: input.tenantId,
      documentId: next.documentId,
    });
    if (outcome.embedded === 0) break; // penjaga anti-putaran tak berujung
    embedded += outcome.embedded;
    tokensIn += outcome.tokensIn;
  }
  const remaining = await countPendingKbChunks(db, input.tenantId);
  return { embedded, tokensIn, remaining };
}

/** Jumlah chunk tenant ini yang embedding-nya masih NULL. */
export async function countPendingKbChunks(
  db: Database,
  tenantId: string,
): Promise<number> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(kbChunks)
      .where(and(eq(kbChunks.tenantId, tenantId), isNull(kbChunks.embedding)));
    return row?.n ?? 0;
  });
}

/**
 * Daftar tenant yang punya chunk tertunda — pembacaan LINTAS tenant
 * untuk skrip backfill (pola yang sama seperti backfill 9B: skrip
 * berjalan dengan koneksi role migrasi; fungsi per-tenant di atas
 * tetap berjalan dalam konteks RLS tenant masing-masing).
 */
export async function listTenantIdsWithPendingKbChunks(
  db: Database,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tenantId: kbChunks.tenantId })
    .from(kbChunks)
    .where(isNull(kbChunks.embedding));
  return rows.map((r) => r.tenantId);
}

/**
 * Mode `--all` skrip backfill (penggantian model): NULL-kan semua
 * embedding tenant ini agar di-embed ulang dengan model aktif.
 */
export async function resetKbEmbeddingsForTenant(
  db: Database,
  tenantId: string,
): Promise<number> {
  return withTenantDb(db, tenantId, async (tx) => {
    const updated = await tx
      .update(kbChunks)
      .set({ embedding: null })
      .where(
        and(eq(kbChunks.tenantId, tenantId), sql`${kbChunks.embedding} IS NOT NULL`),
      )
      .returning({ id: kbChunks.id });
    return updated.length;
  });
}

// ---------------------------------------------------------------------------
// Embedding kueri (jalur agent) + statistik UI
// ---------------------------------------------------------------------------

/**
 * Meng-embed SATU teks kueri untuk retrieval hibrida dan mencatat
 * usage-nya (kind 'query', refId = id pesan pemicu). Error provider
 * DILEMPAR — pemanggil (agent-runtime) menangkapnya dan jatuh ke
 * retrieval full-text murni; pencarian tidak boleh menggagalkan
 * jawaban agent.
 */
export async function embedKbQueryText(
  db: Database,
  provider: EmbeddingProvider,
  input: { tenantId: string; text: string; refId?: string | null },
): Promise<number[]> {
  const result = await provider.embed([input.text]);
  assertEmbeddingShape(result, 1);
  await withTenantDb(db, input.tenantId, async (tx) => {
    await recordEmbeddingUsage(tx, input.tenantId, {
      kind: "query",
      refId: input.refId ?? null,
      result,
    });
  });
  return result.vectors[0];
}

export interface KbEmbeddingStats {
  totalChunks: number;
  embeddedChunks: number;
}

/** Statistik cakupan embedding KB tenant ini (indikator UI Knowledge). */
export async function getKbEmbeddingStats(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<KbEmbeddingStats> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        embedded: sql<number>`count(${kbChunks.embedding})::int`,
      })
      .from(kbChunks)
      .where(eq(kbChunks.tenantId, ctx.tenantId));
    return {
      totalChunks: row?.total ?? 0,
      embeddedChunks: row?.embedded ?? 0,
    };
  });
}
