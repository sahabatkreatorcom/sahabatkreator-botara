/**
 * Uji integrasi runtime agent + executor tool (Fase 3A) di atas PGlite.
 *
 * Kenapa di sini: MockProvider (provider default staging) secara desain
 * TIDAK pernah memanggil `handoff_to_human` / `move_pipeline_stage`, jadi
 * jalur tool itu tidak bisa dibuktikan lewat rantai webchat publik.
 * Skrip ini membuktikannya langsung terhadap service core dengan provider
 * stub yang deterministik:
 *  1. handoff_to_human → conversations.agent_enabled=false + audit
 *     agent.handoff; pesan berikutnya ditolak dengan reason 'ai_disabled'.
 *  2. Loop penuh dengan MockProvider → tag 'ai-lead' terpasang (tool
 *     dieksekusi di mode auto) + pesan outbound sender_type='agent'.
 *  3. tag_contact + move_pipeline_stage (valid & tidak valid) lewat stub.
 *  4. Mode suggest → saran 'pending' tersimpan, tool TIDAK dieksekusi,
 *     tidak ada pesan keluar; approve → 'sent' + pesan agent; reject →
 *     'rejected'.
 *  5. Caps: 200 respons/hari terlampaui → reason 'capped' + audit
 *     agent.capped.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:agent-tools
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
  approveSuggestion,
  evaluateInboundMessageForAutomations,
  executeAgentToolCall,
  listSuggestions,
  rejectSuggestion,
  respondToInboundMessage,
} from "@sahabat-kreator/core";
import {
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

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "55555555-5555-4555-8555-555555555555";
const AGENT = "66666666-6666-4666-8666-666666666666";

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant Uji', 'tenant-uji')`,
  [TENANT],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'webchat', 'wc_uji', 'connected')`,
  [ACCOUNT, TENANT],
);
await client.query(
  `INSERT INTO agents (id, tenant_id, name, system_prompt, mode, is_active)
   VALUES ($1, $2, 'Agent Uji', 'Kamu CS Toko Uji.', 'auto', true)`,
  [AGENT, TENANT],
);

async function seedConversation(suffix: string) {
  const contact = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [TENANT, `Kontak ${suffix}`],
  );
  const conv = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider)
     VALUES ($1, $2, $3, 'webchat') RETURNING id`,
    [TENANT, ACCOUNT, contact.rows[0].id],
  );
  return { contactId: contact.rows[0].id, conversationId: conv.rows[0].id };
}

async function seedInbound(conversationId: string, text: string) {
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received') RETURNING id`,
    [TENANT, conversationId, text],
  );
  return msg.rows[0].id;
}

function stubProvider(result: Partial<LlmChatResult>): LlmProvider {
  return {
    name: "stub",
    async chat() {
      return {
        text: "",
        toolCalls: [],
        usage: { tokensIn: 10, tokensOut: 5 },
        model: "stub-1",
        provider: "stub",
        ...result,
      };
    },
  };
}

async function auditActions(action: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id=$1 AND action=$2`,
    [TENANT, action],
  );
  return Number(r.rows[0].n);
}

// ---------- 1. Handoff ----------
{
  const { contactId, conversationId } = await seedConversation("Handoff");
  const messageId = await seedInbound(conversationId, "saya mau bicara manusia");
  const res = await respondToInboundMessage(
    db,
    stubProvider({
      text: "Baik, saya teruskan ke tim kami ya.",
      toolCalls: [
        { id: "c1", name: "handoff_to_human", arguments: { reason: "kontak meminta manusia" } },
      ],
    }),
    { tenantId: TENANT, conversationId, messageId },
  );
  assert.equal(res.responded, true);
  assert.equal(res.toolOutcomes?.[0]?.note, "handoff_done");
  const conv = await client.query<{ agent_enabled: boolean }>(
    `SELECT agent_enabled FROM conversations WHERE id=$1`,
    [conversationId],
  );
  assert.equal(conv.rows[0].agent_enabled, false);
  assert.ok((await auditActions("agent.handoff")) >= 1);
  assert.ok((await auditActions("agent.responded")) >= 1);

  const messageId2 = await seedInbound(conversationId, "halo lagi");
  const res2 = await respondToInboundMessage(db, new MockProvider(), {
    tenantId: TENANT,
    conversationId,
    messageId: messageId2,
  });
  assert.equal(res2.responded, false);
  assert.equal(res2.reason, "ai_disabled");
  console.log("[1] handoff: agent_enabled=false + audit agent.handoff; pesan berikut ditolak ai_disabled: OK");
  void contactId;
}

// ---------- 2 & 3. Mode auto: mock tag + stub stage ----------
{
  const { contactId, conversationId } = await seedConversation("Auto");
  const m1 = await seedInbound(conversationId, "halo, ada info?");
  const r1 = await respondToInboundMessage(db, new MockProvider(), {
    tenantId: TENANT,
    conversationId,
    messageId: m1,
  });
  assert.equal(r1.responded, true);
  assert.equal(r1.mode, "auto");
  const out = await client.query<{ sender_type: string; status: string }>(
    `SELECT sender_type, status FROM messages WHERE id=$1`,
    [r1.outboundMessageId!],
  );
  assert.equal(out.rows[0].sender_type, "agent");
  assert.equal(out.rows[0].status, "queued");
  let contact = await client.query<{ tags: string[]; pipeline_stage: string }>(
    `SELECT tags, pipeline_stage FROM contacts WHERE id=$1`,
    [contactId],
  );
  assert.ok(contact.rows[0].tags.includes("ai-lead"));

  const m2 = await seedInbound(conversationId, "saya serius mau beli");
  const r2 = await respondToInboundMessage(
    db,
    stubProvider({
      text: "Siap, kami bantu prosesnya.",
      toolCalls: [
        { id: "c1", name: "tag_contact", arguments: { tag: "vip" } },
        { id: "c2", name: "move_pipeline_stage", arguments: { stage: "qualified" } },
        { id: "c3", name: "move_pipeline_stage", arguments: { stage: "ngawur" } },
        { id: "c4", name: "tool_ngawur", arguments: {} },
      ],
    }),
    { tenantId: TENANT, conversationId, messageId: m2 },
  );
  assert.equal(r2.responded, true);
  assert.deepEqual(
    r2.toolOutcomes?.map((o) => o.note),
    ["tagged", "stage_moved", "invalid_stage", "unknown_tool"],
  );
  contact = await client.query<{ tags: string[]; pipeline_stage: string }>(
    `SELECT tags, pipeline_stage FROM contacts WHERE id=$1`,
    [contactId],
  );
  assert.ok(contact.rows[0].tags.includes("vip"));
  assert.equal(contact.rows[0].pipeline_stage, "qualified");
  console.log("[2/3] mode auto: mock men-tag 'ai-lead' + pesan agent queued; stub: tag/stage dieksekusi, stage invalid & tool asing ditolak halus: OK");
}

// ---------- 4. Mode suggest + approve/reject ----------
{
  await client.query(`UPDATE agents SET is_active=false WHERE id=$1`, [AGENT]);
  const agent2 = await client.query<{ id: string }>(
    `INSERT INTO agents (tenant_id, name, system_prompt, mode, is_active)
     VALUES ($1, 'Agent Suggest', 'Kamu CS Toko Uji.', 'suggest', true) RETURNING id`,
    [TENANT],
  );
  const { contactId, conversationId } = await seedConversation("Suggest");
  const m1 = await seedInbound(conversationId, "info dong");
  const r1 = await respondToInboundMessage(db, new MockProvider(), {
    tenantId: TENANT,
    conversationId,
    messageId: m1,
  });
  assert.equal(r1.responded, true);
  assert.equal(r1.mode, "suggest");
  assert.ok(r1.suggestionId);
  const outCount = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE conversation_id=$1 AND direction='outbound'`,
    [conversationId],
  );
  assert.equal(Number(outCount.rows[0].n), 0);
  const contact = await client.query<{ tags: string[] }>(
    `SELECT tags FROM contacts WHERE id=$1`,
    [contactId],
  );
  assert.deepEqual(contact.rows[0].tags, []);

  const pending = await listSuggestions(db, { tenantId: TENANT }, { status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  const approved = await approveSuggestion(
    db,
    { tenantId: TENANT },
    pending[0].id,
  );
  assert.equal(approved.kind, "sent");
  const afterApprove = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE conversation_id=$1 AND direction='outbound' AND sender_type='agent'`,
    [conversationId],
  );
  assert.equal(Number(afterApprove.rows[0].n), 1);

  const m2 = await seedInbound(conversationId, "tanya lagi");
  const r2 = await respondToInboundMessage(db, new MockProvider(), {
    tenantId: TENANT,
    conversationId,
    messageId: m2,
  });
  assert.equal(r2.mode, "suggest");
  const rejected = await rejectSuggestion(db, { tenantId: TENANT }, r2.suggestionId!);
  assert.equal(rejected.kind, "rejected");
  const again = await rejectSuggestion(db, { tenantId: TENANT }, r2.suggestionId!);
  assert.equal(again.kind, "not_pending");
  console.log("[4] mode suggest: draf pending tanpa pesan keluar & tanpa eksekusi tool; approve→sent+pesan agent; reject→rejected; reject ulang→not_pending: OK");
  void agent2;
}

// ---------- 5. Caps ----------
{
  await client.query(
    `INSERT INTO usage_ledger (tenant_id, type, qty, ref_type, ref_id)
     SELECT $1, 'ai_token', 1, 'agent_response', 'seed-' || g FROM generate_series(1, 200) AS g`,
    [TENANT],
  );
  const { conversationId } = await seedConversation("Caps");
  const m1 = await seedInbound(conversationId, "masih bisa?");
  const before = await auditActions("agent.capped");
  const r = await respondToInboundMessage(db, new MockProvider(), {
    tenantId: TENANT,
    conversationId,
    messageId: m1,
  });
  assert.equal(r.responded, false);
  assert.equal(r.reason, "capped");
  assert.equal((await auditActions("agent.capped")) - before, 1);
  console.log("[5] caps: >200 respons/hari → ditolak 'capped' + audit agent.capped: OK");
}

// Executor langsung (tanpa loop): handoff pada percakapan telanjang.
{
  const { contactId, conversationId } = await seedConversation("Direct");
  const outcome = await executeAgentToolCall(
    db,
    { tenantId: TENANT },
    { agentId: AGENT, contactId, conversationId },
    { id: "x", name: "handoff_to_human", arguments: { reason: "uji langsung" } },
  );
  assert.equal(outcome.executed, true);
  assert.equal(outcome.note, "handoff_done");
  console.log("[6] executeAgentToolCall langsung: handoff dieksekusi & tercatat: OK");
}

// ---------- 7. Fase 4A: tool send_payment_link ----------
{
  const p1 = await client.query<{ id: string }>(
    `INSERT INTO products (tenant_id, name, price_idr, created_at)
     VALUES ($1, 'Kelas Rekaman Kilat', 349000, '2026-01-01T00:00:00Z') RETURNING id`,
    [TENANT],
  );
  const p2 = await client.query<{ id: string }>(
    `INSERT INTO products (tenant_id, name, price_idr, created_at)
     VALUES ($1, 'Ebook Uji', 50000, '2026-01-02T00:00:00Z') RETURNING id`,
    [TENANT],
  );
  void p2;
  const { contactId, conversationId } = await seedConversation("Beli");

  // Nama cocok di dalam kalimat permintaan → produk itu yang dipilih.
  const outcome = await executeAgentToolCall(
    db,
    { tenantId: TENANT },
    { agentId: AGENT, contactId, conversationId },
    {
      id: "y",
      name: "send_payment_link",
      arguments: { productName: "saya mau beli kelas rekaman kilat" },
    },
    { publicBaseUrl: "https://uji.example" },
  );
  assert.equal(outcome.executed, true);
  assert.equal(outcome.note, "payment_link_sent");
  const link = await client.query<{
    product_id: string;
    amount_idr: string;
    code: string;
    status: string;
    provider: string;
  }>(
    `SELECT product_id, amount_idr::text, code, status, provider FROM payment_links
     WHERE tenant_id=$1 AND conversation_id=$2`,
    [TENANT, conversationId],
  );
  assert.equal(link.rows.length, 1);
  assert.equal(link.rows[0].product_id, p1.rows[0].id);
  assert.equal(link.rows[0].amount_idr, "349000");
  assert.equal(link.rows[0].status, "pending");
  assert.equal(link.rows[0].provider, "simulation");
  assert.ok(link.rows[0].code.startsWith("pay_"));
  const payMsg = await client.query<{ content_text: string }>(
    `SELECT content_text FROM messages WHERE conversation_id=$1 AND direction='outbound'
     AND content_text LIKE '%/pay/%'`,
    [conversationId],
  );
  assert.equal(payMsg.rows.length, 1);
  assert.ok(
    payMsg.rows[0].content_text.includes(
      `https://uji.example/pay/${link.rows[0].code}`,
    ),
  );
  assert.equal(await auditActions("payment_link.created"), 1);
  assert.equal(await auditActions("agent.payment_link"), 1);

  // Nama tidak cocok sama sekali → fallback produk aktif tertua + tercatat.
  const outcome2 = await executeAgentToolCall(
    db,
    { tenantId: TENANT },
    { agentId: AGENT, contactId, conversationId },
    {
      id: "z",
      name: "send_payment_link",
      arguments: { productName: "sesuatu yang tidak dijual xyz" },
    },
    { publicBaseUrl: "https://uji.example" },
  );
  assert.equal(outcome2.executed, true);
  assert.equal(outcome2.note, "payment_link_sent_fallback_product");
  const link2 = await client.query<{ product_id: string }>(
    `SELECT product_id FROM payment_links WHERE tenant_id=$1 AND conversation_id=$2
     ORDER BY created_at DESC LIMIT 1`,
    [TENANT, conversationId],
  );
  assert.equal(link2.rows[0].product_id, p1.rows[0].id);
  console.log(
    "[7] Fase 4A send_payment_link: tautan snapshot harga + pesan URL terkirim + audit; nama tak cocok → fallback produk aktif tertua tercatat: OK",
  );
}

// ---------- 8. Fase 6A.2: penjaga channel di jalur evaluasi ----------
// Postingan channel (kind='channel') TIDAK boleh memicu automation
// maupun agent walau teksnya cocok dengan keyword automation aktif —
// dibuktikan langsung pada dua fungsi core jalur evaluasi.
{
  const { conversationId } = await seedConversation("Kanal");
  await client.query(
    `UPDATE conversations SET kind = 'channel' WHERE id = $1`,
    [conversationId],
  );
  const auto = await client.query<{ id: string }>(
    `INSERT INTO automations (tenant_id, name, trigger_type, trigger_config, action_config, kind, is_active)
     VALUES ($1, 'Promo Kanal', 'keyword', '{"keywords":["promo"],"match":"contains"}', '{"text":"Balasan promo {name}"}', 'keyword', true)
     RETURNING id`,
    [TENANT],
  );
  const msgId = await seedInbound(conversationId, "promo perdana di channel");
  const ev = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT,
    conversationId,
    messageId: msgId,
  });
  assert.equal(ev.evaluated, false);
  assert.equal(ev.fired.length, 0);
  const runs = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM automation_runs WHERE automation_id = $1`,
    [auto.rows[0].id],
  );
  assert.equal(runs.rows[0].n, "0");
  const res = await respondToInboundMessage(db, new MockProvider(), {
    tenantId: TENANT,
    conversationId,
    messageId: msgId,
  });
  assert.equal(res.responded, false);
  assert.equal(res.reason, "channel_conversation");
  console.log(
    "[8] Fase 6A.2 penjaga channel: automation tidak dievaluasi (evaluated=false, 0 runs) & agent menolak dengan 'channel_conversation' untuk postingan channel berkunci kata cocok: OK",
  );
}

await client.close();
console.log("verify-agent-tools (PGlite): SEMUA LULUS");
