/**
 * Run-once backfill embedding Knowledge Base (Fase 12D): meng-embed
 * semua chunk `kb_chunks` yang embedding-nya masih NULL — baris warisan
 * dari masa sebelum Fase 12D (dokumen baru sudah otomatis lewat job
 * `kb.embed`; skrip ini untuk stok lama & pemulihan).
 *
 * Aturan:
 * - IDEMPOTEN: kandidat hanya chunk ber-embedding NULL; menjalankan
 *   ulang sesudah tuntas memproses 0 chunk (dilaporkan apa adanya).
 * - Mode `--all` (ganti model embedding): embedding semua tenant
 *   di-NULL-kan dulu lalu di-embed ulang dengan model aktif — vektor
 *   dari model berbeda tidak boleh tercampur dalam satu ruang.
 * - Provider di-resolve seperti worker: EMBEDDING_PROVIDER=mock →
 *   mock deterministik; selain itu kunci OpenRouter efektif lewat
 *   resolver Panel Admin (panel terenkripsi → env OPENROUTER_API_KEY).
 *   Tanpa provider tersedia skrip BERHENTI dengan pesan jelas (tidak
 *   mengarang keberhasilan).
 * - Setiap panggilan provider tercatat di usage_ledger oleh core
 *   (refType 'kb_embedding') — termasuk dari skrip ini.
 *
 * Koneksi: daftar tenant tertunda dibaca lintas tenant, jadi jalankan
 * dengan `MIGRATION_DATABASE_URL` (role migrasi; pola backfill 9B).
 * Fungsi per-tenant tetap berjalan dalam konteks RLS tenantnya.
 *
 * Jalankan dari server staging (env dari .env.staging):
 *   set -a; . ./.env.staging; set +a
 *   pnpm --filter @sahabat-kreator/api backfill:kb-embeddings [-- --all]
 */
import { isNotNull } from "drizzle-orm";
import { createDb, kbChunks } from "@sahabat-kreator/db";
import {
  embedPendingKbChunksForTenant,
  listTenantIdsWithPendingKbChunks,
  resetKbEmbeddingsForTenant,
  resolveEmbeddingProvider,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "[backfill:kb-embeddings] MIGRATION_DATABASE_URL (atau DATABASE_URL) wajib diisi",
  );
}
const { db, pool } = createDb(url);

const platformOptions: PlatformSettingsOptions = {
  masterSecret: process.env.PLATFORM_SETTINGS_SECRET,
  env: {
    openrouter_api_key: process.env.OPENROUTER_API_KEY,
    openrouter_model: process.env.OPENROUTER_MODEL,
  },
};

try {
  const provider = await resolveEmbeddingProvider(db, {
    platform: platformOptions,
    providerEnv: process.env.EMBEDDING_PROVIDER,
    modelEnv: process.env.OPENROUTER_EMBEDDING_MODEL,
  });
  if (!provider) {
    console.error(
      "[backfill:kb-embeddings] TIDAK ADA provider embedding tersedia (kunci OpenRouter tidak terisi di panel/env dan EMBEDDING_PROVIDER bukan 'mock') — tidak ada yang diproses.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `[backfill:kb-embeddings] provider=${provider.name} model=${provider.model}`,
    );
    const all = process.argv.includes("--all");
    if (all) {
      // Mode ganti model: NULL-kan dulu semua embedding lintas tenant
      // yang punya chunk ter-embed (daftar tenant diambil dari yang
      // tertunda ∪ yang ter-embed — sederhananya: proses semua tenant
      // yang muncul di daftar tertunda setelah reset per tenant di
      // bawah; tenant tanpa chunk tertunda tetapi punya chunk
      // ter-embed ditemukan lewat kueri reset terpisah ini).
      const embeddedTenants = await listTenantIdsWithEmbeddedChunks(db);
      let resetTotal = 0;
      for (const tenantId of embeddedTenants) {
        resetTotal += await resetKbEmbeddingsForTenant(db, tenantId);
      }
      console.log(
        `[backfill:kb-embeddings] mode --all: ${resetTotal} embedding di-NULL-kan untuk embed ulang`,
      );
    }

    const tenantIds = await listTenantIdsWithPendingKbChunks(db);
    let totalEmbedded = 0;
    let totalTokens = 0;
    let totalRemaining = 0;
    for (const tenantId of tenantIds) {
      const outcome = await embedPendingKbChunksForTenant(db, provider, {
        tenantId,
      });
      totalEmbedded += outcome.embedded;
      totalTokens += outcome.tokensIn;
      totalRemaining += outcome.remaining;
      console.log(
        `[backfill:kb-embeddings] tenant=${tenantId} embedded=${outcome.embedded} tokensIn=${outcome.tokensIn} remaining=${outcome.remaining}`,
      );
    }
    console.log(
      `[backfill:kb-embeddings] selesai: tenant=${tenantIds.length} embedded=${totalEmbedded} tokensIn=${totalTokens} remaining=${totalRemaining}`,
    );
  }
} finally {
  await pool.end();
}

/** Tenant yang punya ≥1 chunk SUDAH ter-embed (untuk mode --all). */
async function listTenantIdsWithEmbeddedChunks(
  database: typeof db,
): Promise<string[]> {
  const rows = await database
    .selectDistinct({ tenantId: kbChunks.tenantId })
    .from(kbChunks)
    .where(isNotNull(kbChunks.embedding));
  return rows.map((r) => r.tenantId);
}
