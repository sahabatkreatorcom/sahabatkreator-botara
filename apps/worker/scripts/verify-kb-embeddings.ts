/**
 * Uji integrasi retrieval semantik KB (Fase 12D) di atas PGlite.
 *
 * Membuktikan di level service core (tanpa jaringan, provider mock
 * deterministik dari @sahabat-kreator/ai):
 *  1. Buat dokumen menulis event outbox `kb.embed_requested`.
 *  2. Pencarian full-text MURNI melewatkan chunk parafrase yang tidak
 *     berbagi satu token pun dengan kueri (keterbatasan v1 yang nyata).
 *  3. `embedKbDocumentChunks` mengisi vektor 1536 untuk kedua dokumen,
 *     idempoten pada lari kedua, dan mencatat usage `kb_embedding`.
 *  4. Pencarian HIBRIDA (RRF) menemukan parafrase itu lewat jalur
 *     vektor, sementara chunk kata-kunci tetap peringkat pertama
 *     (ditemukan kedua jalur).
 *  5. Backfill per tenant meng-embed sisa NULL dan idempoten.
 *  6. Isolasi tenant pada pencarian vektor (chunk tenant lain yang
 *     teksnya mirip tidak pernah muncul).
 *  7. Jalur agent penuh: respondToInboundMessage dengan provider
 *     embedding → audit retrieval='hybrid' + kbChunkIds memuat
 *     parafrase; usage kueri tercatat sebagai kb_embedding dan TIDAK
 *     menambah hitungan cap agent_response. Tanpa provider embedding
 *     → retrieval='fts' persis seperti sebelum 12D.
 *  8. Ganti dokumen (hapus + buat ulang — satu-satunya jalur "update"
 *     di API saat ini) menghasilkan chunk baru yang ikut ter-embed.
 *  9. Provider yang melempar → embedKbDocumentChunks melempar juga
 *     (semantik retry job) dan chunk tetap NULL.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:kb-embeddings
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  createKbDocument,
  deleteKbDocument,
  embedKbDocumentChunks,
  embedPendingKbChunksForTenant,
  getKbEmbeddingStats,
  respondToInboundMessage,
  searchKbChunks,
} from "@sahabat-kreator/core";
import {
  MockEmbeddingProvider,
  MockProvider,
  type EmbeddingProvider,
} from "@sahabat-kreator/ai";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../../packages/db/migrations");

// btree_gist wajib didaftarkan (Fase 13G): migrasi 0006 menjalankan
// CREATE EXTENSION btree_gist untuk constraint eksklusi anti-double-booking.
const client = new PGlite({ extensions: { vector, btree_gist } });
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
  await client.exec(sqlText.replaceAll("--> statement-breakpoint", ""));
}
console.log(`[setup] migrasi teraplikasi: ${files.length} file`);

const db = drizzle(client, { schema }) as unknown as Database;

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "55555555-5555-4555-8555-555555555555";

const KW_TEXT =
  "Harga kelas Rekaman Kilat adalah Rp349 ribu, dibayar sekali di muka.";
const PARA_TEXT =
  "Biaya kursus dapat dicicil dua kali tanpa bunga untuk peserta yang mendaftar bulan ini.";
const QUERY = "berapa harga kelas rekaman kilat?";

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'webchat', 'wc_uji', 'connected')`,
  [ACCOUNT, TENANT_A],
);
await client.query(
  `INSERT INTO agents (tenant_id, name, system_prompt, mode, is_active)
   VALUES ($1, 'Agent Uji', 'Kamu CS Toko Uji.', 'auto', true)`,
  [TENANT_A],
);

const mockEmbed = new MockEmbeddingProvider();
const ctxA = { tenantId: TENANT_A };
const ctxB = { tenantId: TENANT_B };

// ---------- 1. Buat dokumen → event outbox ----------
const docKw = await createKbDocument(db, ctxA, {
  title: "Harga Kelas",
  content: KW_TEXT,
});
const docPara = await createKbDocument(db, ctxA, {
  title: "Cicilan",
  content: PARA_TEXT,
});
assert.equal(docKw.chunkCount, 1);
assert.equal(docPara.chunkCount, 1);
const outbox = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM outbox_events WHERE type = 'kb.embed_requested' AND tenant_id = $1`,
  [TENANT_A],
);
assert.equal(outbox.rows[0].n, "2");
console.log("[1] buat dokumen menulis event outbox kb.embed_requested (2 event): OK");

// ---------- 2. FTS murni melewatkan parafrase ----------
const ftsHits = await searchKbChunks(db, ctxA, QUERY, 5);
assert.equal(ftsHits.length, 1);
assert.ok(ftsHits[0].content.includes("Rp349 ribu"));
assert.deepEqual(ftsHits[0].sources, ["fts"]);
console.log("[2] FTS murni: hanya chunk kata-kunci; parafrase (nol token bersama) terlewat: OK");

// ---------- 3. Embed per dokumen + idempotensi + usage ----------
const e1 = await embedKbDocumentChunks(db, mockEmbed, {
  tenantId: TENANT_A,
  documentId: docKw.id,
});
const e2 = await embedKbDocumentChunks(db, mockEmbed, {
  tenantId: TENANT_A,
  documentId: docPara.id,
});
assert.equal(e1.embedded, 1);
assert.equal(e2.embedded, 1);
const dims = await client.query<{ d: number }>(
  `SELECT vector_dims(embedding) AS d FROM kb_chunks WHERE document_id = $1`,
  [docKw.id],
);
assert.equal(dims.rows[0].d, 1536);
const usageBefore = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM usage_ledger WHERE tenant_id = $1 AND ref_type = 'kb_embedding'`,
  [TENANT_A],
);
assert.equal(usageBefore.rows[0].n, "2");
const eAgain = await embedKbDocumentChunks(db, mockEmbed, {
  tenantId: TENANT_A,
  documentId: docKw.id,
});
assert.equal(eAgain.embedded, 0);
const usageAfter = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM usage_ledger WHERE tenant_id = $1 AND ref_type = 'kb_embedding'`,
  [TENANT_A],
);
assert.equal(usageAfter.rows[0].n, "2");
console.log("[3] embed per dokumen: vektor 1536 terisi, usage kb_embedding tercatat, lari ulang = 0 tanpa usage baru: OK");

// ---------- 4. Hibrida menemukan parafrase, kata-kunci tetap #1 ----------
const queryVector = (await mockEmbed.embed([QUERY])).vectors[0];
const hybridHits = await searchKbChunks(db, ctxA, QUERY, 5, {
  queryEmbedding: queryVector,
});
assert.equal(hybridHits.length, 2);
assert.ok(hybridHits[0].content.includes("Rp349 ribu"));
assert.deepEqual(hybridHits[0].sources, ["fts", "vector"]);
assert.ok(hybridHits[1].content.includes("dicicil"));
assert.deepEqual(hybridHits[1].sources, ["vector"]);
console.log("[4] hibrida RRF: parafrase ditemukan via vektor di top-5; chunk kata-kunci tetap peringkat 1 (fts+vector): OK");

// ---------- 5. Backfill per tenant + idempoten ----------
await client.query(
  `INSERT INTO kb_documents (id, tenant_id, title, content)
   VALUES ('33333333-3333-4333-8333-333333333333', $1, 'Warisan', 'Dokumen lama tanpa embedding sama sekali.')`,
  [TENANT_A],
);
await client.query(
  `INSERT INTO kb_chunks (tenant_id, document_id, chunk_index, content)
   VALUES ($1, '33333333-3333-4333-8333-333333333333', 0, 'Dokumen lama tanpa embedding sama sekali.')`,
  [TENANT_A],
);
const bf1 = await embedPendingKbChunksForTenant(db, mockEmbed, {
  tenantId: TENANT_A,
});
assert.equal(bf1.embedded, 1);
assert.equal(bf1.remaining, 0);
const bf2 = await embedPendingKbChunksForTenant(db, mockEmbed, {
  tenantId: TENANT_A,
});
assert.equal(bf2.embedded, 0);
assert.equal(bf2.remaining, 0);
console.log("[5] backfill: chunk warisan NULL ter-embed; lari kedua 0 perubahan (idempoten): OK");

// ---------- 6. Isolasi tenant pada jalur vektor ----------
const docB = await createKbDocument(db, ctxB, {
  title: "Cicilan B",
  content: PARA_TEXT,
});
await embedKbDocumentChunks(db, mockEmbed, {
  tenantId: TENANT_B,
  documentId: docB.id,
});
const hybridA2 = await searchKbChunks(db, ctxA, QUERY, 5, {
  queryEmbedding: queryVector,
});
assert.ok(hybridA2.every((h) => h.documentId !== docB.id));
const hybridB = await searchKbChunks(db, ctxB, QUERY, 5, {
  queryEmbedding: queryVector,
});
assert.equal(hybridB.length, 1);
assert.equal(hybridB[0].documentId, docB.id);
console.log("[6] isolasi: pencarian vektor tenant A tidak pernah memuat chunk tenant B (dan sebaliknya bekerja): OK");

// ---------- 7. Jalur agent penuh: hibrida vs fts + cap utuh ----------
async function seedConversation(suffix: string) {
  const contact = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [TENANT_A, `Kontak ${suffix}`],
  );
  const conv = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider)
     VALUES ($1, $2, $3, 'webchat') RETURNING id`,
    [TENANT_A, ACCOUNT, contact.rows[0].id],
  );
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received') RETURNING id`,
    [TENANT_A, conv.rows[0].id, QUERY],
  );
  return { conversationId: conv.rows[0].id, messageId: msg.rows[0].id };
}
async function lastRespondedMeta() {
  const r = await client.query<{ meta: Record<string, unknown> }>(
    `SELECT meta FROM audit_logs WHERE tenant_id = $1 AND action = 'agent.responded'
     ORDER BY created_at DESC LIMIT 1`,
    [TENANT_A],
  );
  return r.rows[0].meta;
}

{
  const { conversationId, messageId } = await seedConversation("Hibrida");
  const res = await respondToInboundMessage(db, new MockProvider(), {
    tenantId: TENANT_A,
    conversationId,
    messageId,
    embeddingProvider: mockEmbed,
  });
  assert.equal(res.responded, true);
  const out = await client.query<{ content_text: string }>(
    `SELECT content_text FROM messages WHERE id = $1`,
    [res.outboundMessageId!],
  );
  assert.ok(out.rows[0].content_text.includes("Rp349 ribu"));
  const meta = await lastRespondedMeta();
  assert.equal(meta.retrieval, "hybrid");
  const ids = meta.kbChunkIds as string[];
  assert.equal(ids.length, 2);
  const queryUsage = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM usage_ledger
      WHERE tenant_id = $1 AND ref_type = 'kb_embedding' AND ref_id = $2 AND meta->>'kind' = 'query'`,
    [TENANT_A, messageId],
  );
  assert.equal(queryUsage.rows[0].n, "1");
  console.log("[7a] agent + embedding: retrieval='hybrid', kbChunkIds memuat parafrase, balasan mengutip chunk kata-kunci, usage kueri tercatat sebagai kb_embedding: OK");
}
{
  const { conversationId, messageId } = await seedConversation("Fts");
  const res = await respondToInboundMessage(db, new MockProvider(), {
    tenantId: TENANT_A,
    conversationId,
    messageId,
    embeddingProvider: null,
  });
  assert.equal(res.responded, true);
  const meta = await lastRespondedMeta();
  assert.equal(meta.retrieval, "fts");
  assert.equal((meta.kbChunkIds as string[]).length, 1);
  // Cap: tepat 2 baris agent_response dari dua respond di atas —
  // baris kb_embedding (chunk + query) TIDAK ikut terhitung.
  const capRows = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM usage_ledger
      WHERE tenant_id = $1 AND type = 'ai_token' AND ref_type = 'agent_response'`,
    [TENANT_A],
  );
  assert.equal(capRows.rows[0].n, "2");
  console.log("[7b] agent tanpa embedding: retrieval='fts' persis perilaku lama; cap agent_response tidak tersentuh baris embedding: OK");
}

// ---------- 8. Ganti dokumen → chunk baru ikut ter-embed ----------
{
  const statsBefore = await getKbEmbeddingStats(db, ctxA);
  await deleteKbDocument(db, ctxA, docKw.id);
  const docKw2 = await createKbDocument(db, ctxA, {
    title: "Harga Kelas",
    content:
      "Harga kelas Rekaman Kilat naik menjadi Rp399 ribu mulai bulan depan.",
  });
  const pending = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM kb_chunks WHERE document_id = $1 AND embedding IS NULL`,
    [docKw2.id],
  );
  assert.equal(pending.rows[0].n, "1");
  const e = await embedKbDocumentChunks(db, mockEmbed, {
    tenantId: TENANT_A,
    documentId: docKw2.id,
  });
  assert.equal(e.embedded, 1);
  const hits = await searchKbChunks(db, ctxA, QUERY, 5, {
    queryEmbedding: queryVector,
  });
  assert.ok(hits[0].content.includes("Rp399 ribu"));
  const statsAfter = await getKbEmbeddingStats(db, ctxA);
  assert.equal(statsAfter.totalChunks, statsBefore.totalChunks);
  assert.equal(statsAfter.embeddedChunks, statsAfter.totalChunks);
  console.log("[8] ganti dokumen (hapus+buat): chunk baru ber-embedding NULL lalu ter-embed; pencarian memuat harga baru; statistik konsisten: OK");
}

// ---------- 9. Provider gagal → lempar, chunk tetap NULL ----------
{
  const failing: EmbeddingProvider = {
    name: "failing",
    model: "failing-1",
    async embed() {
      throw new Error("provider tumbang (uji)");
    },
  };
  const docFail = await createKbDocument(db, ctxA, {
    title: "Dokumen Gagal",
    content: "Isi dokumen yang provider-nya sedang tumbang.",
  });
  await assert.rejects(() =>
    embedKbDocumentChunks(db, failing, {
      tenantId: TENANT_A,
      documentId: docFail.id,
    }),
  );
  const stillNull = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM kb_chunks WHERE document_id = $1 AND embedding IS NULL`,
    [docFail.id],
  );
  assert.equal(stillNull.rows[0].n, "1");
  console.log("[9] provider gagal: embed melempar (job retry), chunk tetap NULL & dokumen tetap tersimpan: OK");
}

await client.close();
console.log("verify-kb-embeddings (PGlite): SEMUA LULUS");
