/**
 * Uji integrasi PLAYGROUND agent (Fase 12E) di atas PGlite.
 *
 * Yang dibuktikan terhadap service core `runAgentPlayground`:
 *  1. Jalur yang sama seperti runtime: retrieval HIBRIDA (chunk
 *     kata-kunci + parafrase via vektor, provider embedding mock) dan
 *     balasan dari provider stub.
 *  2. Tool call model dipetakan menjadi NIAT persis (tag ternormalisasi,
 *     stage, handoff, tautan bayar dengan produk hasil pencocokan
 *     baca-saja, tool asing → unknown) — TANPA eksekusi.
 *  3. NOL penulisan data: kontak/percakapan/pesan/tautan bayar/saran
 *     tidak berubah sama sekali sesudah lari playground.
 *  4. Metering jujur & terpisah: tepat satu baris usage refType
 *     `agent_playground` (meta.playground=true); `agent_response` tetap
 *     0 → cap harian tak bergerak dan laporan analytics 9B melaporkan
 *     0 respons walau playground sudah berjalan.
 *  5. Agent mode suggest ikut bisa diuji (tanpa membuat saran).
 *  6. Isolasi tenant: agent tenant lain → agent_not_found dua arah.
 *  7. Provider melempar → provider_error, tanpa baris usage playground.
 *  8. Tanpa provider embedding → retrieval 'fts' murni seperti v1.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:agent-playground
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
  embedKbDocumentChunks,
  getAiUsageReport,
  runAgentPlayground,
} from "@sahabat-kreator/core";
import {
  MockEmbeddingProvider,
  MockProvider,
  type LlmChatResult,
  type LlmProvider,
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
const AGENT_AUTO = "66666666-6666-4666-8666-666666666666";
const AGENT_SUGGEST = "77777777-7777-4777-8777-777777777777";
const AGENT_B = "88888888-8888-4888-8888-888888888888";

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
  `INSERT INTO agents (id, tenant_id, name, system_prompt, mode, is_active)
   VALUES ($1, $2, 'Agent Auto', 'Kamu CS Toko Uji.', 'auto', true),
          ($3, $2, 'Agent Suggest', 'Kamu CS Toko Uji.', 'suggest', false),
          ($4, $5, 'Agent B', 'Kamu CS Tenant B.', 'auto', true)`,
  [AGENT_AUTO, TENANT_A, AGENT_SUGGEST, AGENT_B, TENANT_B],
);
const product = await client.query<{ id: string }>(
  `INSERT INTO products (tenant_id, name, price_idr, created_at)
   VALUES ($1, 'Kelas Rekaman Kilat', 349000, '2026-01-01T00:00:00Z') RETURNING id`,
  [TENANT_A],
);
const PRODUCT_ID = product.rows[0].id;

// Kontak + percakapan umpan: playground TIDAK boleh menyentuhnya.
const contact = await client.query<{ id: string }>(
  `INSERT INTO contacts (tenant_id, name, tags, pipeline_stage)
   VALUES ($1, 'Kontak Umpan', ARRAY['awal'], 'new') RETURNING id`,
  [TENANT_A],
);
const CONTACT_ID = contact.rows[0].id;
await client.query(
  `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider)
   VALUES ($1, $2, $3, 'webchat')`,
  [TENANT_A, ACCOUNT, CONTACT_ID],
);

// KB: dokumen kata-kunci + parafrase, di-embed mock (deterministik).
const ctxA = { tenantId: TENANT_A };
const mockEmbed = new MockEmbeddingProvider();
const docKw = await createKbDocument(db, ctxA, {
  title: "Harga Kelas",
  content: KW_TEXT,
});
const docPara = await createKbDocument(db, ctxA, {
  title: "Cicilan",
  content: PARA_TEXT,
});
await embedKbDocumentChunks(db, mockEmbed, {
  tenantId: TENANT_A,
  documentId: docKw.id,
});
await embedKbDocumentChunks(db, mockEmbed, {
  tenantId: TENANT_A,
  documentId: docPara.id,
});

function stubProvider(result: Partial<LlmChatResult>): LlmProvider {
  return {
    name: "stub",
    async chat() {
      return {
        text: "Siap, harganya Rp349 ribu.",
        toolCalls: [],
        usage: { tokensIn: 10, tokensOut: 5 },
        model: "stub-1",
        provider: "stub",
        ...result,
      };
    },
  };
}

async function countRows(sqlText: string, params: unknown[]): Promise<number> {
  const r = await client.query<{ n: string }>(sqlText, params);
  return Number(r.rows[0].n);
}

async function snapshot(): Promise<Record<string, number>> {
  return {
    contacts: await countRows(
      `SELECT count(*)::text AS n FROM contacts WHERE tenant_id = $1`,
      [TENANT_A],
    ),
    conversations: await countRows(
      `SELECT count(*)::text AS n FROM conversations WHERE tenant_id = $1`,
      [TENANT_A],
    ),
    messages: await countRows(
      `SELECT count(*)::text AS n FROM messages WHERE tenant_id = $1`,
      [TENANT_A],
    ),
    paymentLinks: await countRows(
      `SELECT count(*)::text AS n FROM payment_links WHERE tenant_id = $1`,
      [TENANT_A],
    ),
    suggestions: await countRows(
      `SELECT count(*)::text AS n FROM agent_suggestions WHERE tenant_id = $1`,
      [TENANT_A],
    ),
  };
}

const before = await snapshot();

// ---------- 1+2. Lari utama: hybrid + niat persis ----------
const fullStub = stubProvider({
  toolCalls: [
    { id: "c1", name: "tag_contact", arguments: { tag: "Minat Kelas!" } },
    { id: "c2", name: "move_pipeline_stage", arguments: { stage: "qualified" } },
    { id: "c3", name: "handoff_to_human", arguments: { reason: "minta manusia" } },
    {
      id: "c4",
      name: "send_payment_link",
      arguments: { productName: "saya mau beli kelas rekaman kilat" },
    },
    { id: "c5", name: "fly_to_moon", arguments: {} },
  ],
});
const outcome = await runAgentPlayground(db, fullStub, {
  tenantId: TENANT_A,
  agentId: AGENT_AUTO,
  message: QUERY,
  embeddingProvider: mockEmbed,
});
assert.equal(outcome.kind, "ok");
if (outcome.kind !== "ok") throw new Error("unreachable");
assert.equal(outcome.mode, "auto");
assert.equal(outcome.replyText, "Siap, harganya Rp349 ribu.");
assert.equal(outcome.retrieval, "hybrid");
assert.equal(outcome.kbHits.length, 2);
assert.ok(
  outcome.kbHits[0].content.includes("Rp349 ribu"),
  "chunk kata-kunci tetap peringkat pertama (RRF)",
);
const paraHit = outcome.kbHits.find((h) => h.content.includes("dicicil"));
assert.ok(paraHit, "parafrase ikut terambil di mode hybrid");
assert.ok(paraHit.sources.includes("vector"));
assert.deepEqual(outcome.intents, [
  { kind: "add_tag", tag: "minat-kelas" },
  { kind: "set_stage", stage: "qualified" },
  { kind: "handoff", reason: "minta manusia" },
  {
    kind: "create_payment_link",
    productId: PRODUCT_ID,
    productName: "Kelas Rekaman Kilat",
    query: "saya mau beli kelas rekaman kilat",
  },
  { kind: "unknown", toolName: "fly_to_moon" },
]);
assert.equal(outcome.usage.provider, "stub");
assert.equal(outcome.usage.tokensIn, 10);
assert.equal(outcome.usage.tokensOut, 5);
console.log("[1] playground hybrid: balasan + 2 chunk (parafrase via vektor): OK");
console.log("[2] niat tool persis (tag ternormalisasi, stage, handoff, produk baca-saja, unknown): OK");

// ---------- 3. Nol penulisan ----------
const after = await snapshot();
assert.deepEqual(after, before);
const contactRow = await client.query<{ tags: string[]; pipeline_stage: string }>(
  `SELECT tags, pipeline_stage FROM contacts WHERE id = $1`,
  [CONTACT_ID],
);
assert.deepEqual(contactRow.rows[0].tags, ["awal"]);
assert.equal(contactRow.rows[0].pipeline_stage, "new");
console.log("[3] nol penulisan: kontak/percakapan/pesan/tautan/saran identik, tag & stage umpan utuh: OK");

// ---------- 4. Metering terpisah; cap & analytics tak bergerak ----------
const playgroundRows = await client.query<{ meta: Record<string, unknown> }>(
  `SELECT meta FROM usage_ledger WHERE tenant_id = $1 AND ref_type = 'agent_playground'`,
  [TENANT_A],
);
assert.equal(playgroundRows.rows.length, 1);
assert.equal(playgroundRows.rows[0].meta.playground, true);
assert.equal(playgroundRows.rows[0].meta.agentId, AGENT_AUTO);
const responseRows = await countRows(
  `SELECT count(*)::text AS n FROM usage_ledger WHERE tenant_id = $1 AND ref_type = 'agent_response'`,
  [TENANT_A],
);
assert.equal(responseRows, 0);
const report = await getAiUsageReport(db, ctxA, { days: 1 });
assert.equal(report.responses, 0);
assert.equal(report.cap.usedToday, 0);
console.log("[4] usage agent_playground tercatat (playground=true); agent_response=0; analytics & cap tetap 0: OK");

// ---------- 5. Agent suggest bisa diuji, tanpa saran ----------
const suggestOutcome = await runAgentPlayground(db, new MockProvider(), {
  tenantId: TENANT_A,
  agentId: AGENT_SUGGEST,
  message: QUERY,
});
assert.equal(suggestOutcome.kind, "ok");
if (suggestOutcome.kind === "ok") {
  assert.equal(suggestOutcome.mode, "suggest");
  assert.ok(suggestOutcome.replyText.includes("Rp349 ribu"));
  assert.deepEqual(suggestOutcome.intents, [
    { kind: "add_tag", tag: "ai-lead" },
  ]);
}
assert.equal((await snapshot()).suggestions, 0);
console.log("[5] agent mode suggest: balasan + niat mock (ai-lead) tampil, saran tetap 0: OK");

// ---------- 6. Isolasi tenant ----------
const cross1 = await runAgentPlayground(db, new MockProvider(), {
  tenantId: TENANT_A,
  agentId: AGENT_B,
  message: "halo",
});
assert.equal(cross1.kind, "agent_not_found");
const cross2 = await runAgentPlayground(
  db,
  new MockProvider(),
  { tenantId: TENANT_B, agentId: AGENT_AUTO, message: "halo" },
);
assert.equal(cross2.kind, "agent_not_found");
console.log("[6] isolasi tenant: agent lintas tenant → agent_not_found dua arah: OK");

// ---------- 7. Provider melempar → provider_error, tanpa usage ----------
const playgroundCountBeforeError = await countRows(
  `SELECT count(*)::text AS n FROM usage_ledger WHERE tenant_id = $1 AND ref_type = 'agent_playground'`,
  [TENANT_A],
);
const failing: LlmProvider = {
  name: "failing",
  async chat() {
    throw new Error("provider tumbang");
  },
};
const errOutcome = await runAgentPlayground(db, failing, {
  tenantId: TENANT_A,
  agentId: AGENT_AUTO,
  message: "halo",
});
assert.equal(errOutcome.kind, "provider_error");
const playgroundCountAfterError = await countRows(
  `SELECT count(*)::text AS n FROM usage_ledger WHERE tenant_id = $1 AND ref_type = 'agent_playground'`,
  [TENANT_A],
);
assert.equal(playgroundCountAfterError, playgroundCountBeforeError);
console.log("[7] provider melempar → provider_error; tidak ada baris usage baru: OK");

// ---------- 8. Tanpa embedding → FTS murni ----------
const ftsOutcome = await runAgentPlayground(db, new MockProvider(), {
  tenantId: TENANT_A,
  agentId: AGENT_AUTO,
  message: QUERY,
});
assert.equal(ftsOutcome.kind, "ok");
if (ftsOutcome.kind === "ok") {
  assert.equal(ftsOutcome.retrieval, "fts");
  assert.equal(ftsOutcome.kbHits.length, 1);
  assert.deepEqual(ftsOutcome.kbHits[0].sources, ["fts"]);
}
console.log("[8] tanpa provider embedding: retrieval 'fts', parafrase terlewat seperti v1: OK");

console.log("SEMUA LULUS — verify:agent-playground");
