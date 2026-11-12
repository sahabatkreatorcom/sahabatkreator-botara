/**
 * Uji integrasi PENGAMAN AI PELENGKAP (Gelombang G6) di atas PGlite:
 * cap balasan AI PER PERCAKAPAN (klaim slot atomik) + ringkasan
 * handoff otomatis gagal-aman. Yang dibuktikan:
 *  1. Di bawah cap perilaku TIDAK berubah: balasan mengalir, jendela
 *     percakapan menghitung klaim, AI tetap aktif.
 *  2. Cap tercapai → reason 'conversation_capped' + audit
 *     agent.conversation_capped + handoff via 'conversation_cap'
 *     (agent_enabled=false) + catatan ringkasan menempel + usage
 *     ringkasan ber-refType 'agent_handoff_summary'; pesan berikutnya
 *     'ai_disabled'.
 *  3. Balapan: 10 panggilan bersamaan pada cap 3 → TEPAT 3 balasan
 *     terkirim dan hitungan jendela berhenti di 3 (klaim atomik).
 *  4. Tool handoff_to_human lewat loop runtime → handoff + ringkasan
 *     (audit agent.handoff_summary 'created', catatan ada).
 *  5. Gagal-aman: provider yang TUMBANG khusus panggilan ringkasan →
 *     handoff TETAP terjadi, audit ringkasan 'unavailable', tanpa
 *     catatan ringkasan, tanpa lemparan.
 *  6. Slot dilepas saat generasi gagal: provider tumbang total →
 *     'provider_error' dan jendela kembali 0; panggilan berikutnya
 *     dengan provider sehat tetap bisa memakai slot itu.
 *  7. Cap nonaktif (config 0): balasan melewati cap bawaan tanpa
 *     pernah 'conversation_capped'.
 *  8. Isolasi tenant: cap & jendela tenant A tidak memengaruhi
 *     tenant B; percakapan tenant A tak terlihat dari tenant B.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:ai-guards
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
import { respondToInboundMessage } from "@sahabat-kreator/core";
import type {
  LlmChatRequest,
  LlmProvider,
  LlmToolCall,
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
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_B = "55555555-5555-4555-8555-555555555556";
const AGENT = "66666666-6666-4666-8666-666666666666";
const AGENT_B = "66666666-6666-4666-8666-666666666667";

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant Uji', 'tenant-uji'), ($2, 'Tenant Lain', 'tenant-lain')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'webchat', 'wc_uji', 'connected'), ($3, $4, 'webchat', 'wc_lain', 'connected')`,
  [ACCOUNT, TENANT, ACCOUNT_B, TENANT_B],
);
await client.query(
  `INSERT INTO agents (id, tenant_id, name, system_prompt, mode, is_active)
   VALUES ($1, $2, 'Agent Uji', 'Kamu CS Toko Uji.', 'auto', true), ($3, $4, 'Agent Lain', 'Kamu CS Toko Lain.', 'auto', true)`,
  [AGENT, TENANT, AGENT_B, TENANT_B],
);

async function setAgentCap(tenantId: string, agentId: string, cap: number | null) {
  const config = cap === null ? {} : { maxConversationReplies: cap };
  await client.query(`UPDATE agents SET config = $1::jsonb WHERE id = $2`, [
    JSON.stringify(config),
    agentId,
  ]);
  void tenantId;
}

async function seedConversation(
  tenantId: string,
  accountId: string,
  suffix: string,
) {
  const contact = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `Kontak ${suffix}`],
  );
  const conv = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider)
     VALUES ($1, $2, $3, 'webchat') RETURNING id`,
    [tenantId, accountId, contact.rows[0].id],
  );
  return { contactId: contact.rows[0].id, conversationId: conv.rows[0].id };
}

async function seedInbound(
  tenantId: string,
  conversationId: string,
  text: string,
) {
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received') RETURNING id`,
    [tenantId, conversationId, text],
  );
  return msg.rows[0].id;
}

/**
 * Provider stub sadar-ringkasan: panggilan ringkasan dikenali dari
 * prompt sistem peringkas ("meringkas satu percakapan") dan dijawab
 * teks RINGKASAN-UJI; panggilan utama menjawab teks biasa + tool call
 * yang diminta skenario. Mode gagal bisa ditujukan ke ringkasan saja
 * atau ke semua panggilan.
 */
function stubProvider(opts?: {
  toolCalls?: LlmToolCall[];
  failSummary?: boolean;
  failAll?: boolean;
}): LlmProvider {
  return {
    name: "stub",
    async chat(request: LlmChatRequest) {
      if (opts?.failAll) throw new Error("provider tumbang total");
      const isSummary = request.system.includes("meringkas satu percakapan");
      if (isSummary) {
        if (opts?.failSummary) {
          throw new Error("provider ringkasan tumbang");
        }
        return {
          text: "RINGKASAN-UJI: pelanggan menanyakan stok dan harga produk; menunggu tindak lanjut tim.",
          toolCalls: [],
          usage: { tokensIn: 50, tokensOut: 20 },
          model: "stub-1",
          provider: "stub",
        };
      }
      return {
        text: "Balasan stub untuk pelanggan.",
        toolCalls: opts?.toolCalls ?? [],
        usage: { tokensIn: 10, tokensOut: 5 },
        model: "stub-1",
        provider: "stub",
      };
    },
  };
}

async function auditCount(
  tenantId: string,
  action: string,
  conversationId?: string,
): Promise<number> {
  const r = conversationId
    ? await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id=$1 AND action=$2 AND meta->>'conversationId'=$3`,
        [tenantId, action, conversationId],
      )
    : await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id=$1 AND action=$2`,
        [tenantId, action],
      );
  return Number(r.rows[0].n);
}

async function auditMeta(
  tenantId: string,
  action: string,
  conversationId: string,
): Promise<Array<Record<string, unknown>>> {
  const r = await client.query<{ meta: Record<string, unknown> }>(
    `SELECT meta FROM audit_logs WHERE tenant_id=$1 AND action=$2 AND meta->>'conversationId'=$3`,
    [tenantId, action, conversationId],
  );
  return r.rows.map((row) => row.meta);
}

async function conversationState(conversationId: string) {
  const r = await client.query<{
    agent_enabled: boolean;
    agent_reply_window_count: number;
  }>(
    `SELECT agent_enabled, agent_reply_window_count FROM conversations WHERE id=$1`,
    [conversationId],
  );
  return r.rows[0];
}

async function outboundAgentMessages(conversationId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE conversation_id=$1 AND direction='outbound' AND sender_type='agent'`,
    [conversationId],
  );
  return Number(r.rows[0].n);
}

async function summaryNotes(conversationId: string): Promise<string[]> {
  const r = await client.query<{ body: string }>(
    `SELECT body FROM conversation_notes WHERE conversation_id=$1 AND body LIKE '%RINGKASAN-UJI%'`,
    [conversationId],
  );
  return r.rows.map((row) => row.body);
}

async function summaryUsageRows(conversationId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM usage_ledger WHERE ref_type='agent_handoff_summary' AND ref_id=$1`,
    [conversationId],
  );
  return Number(r.rows[0].n);
}

// ---------- 1+2. Di bawah cap normal; cap tercapai → handoff + ringkasan ----------
{
  await setAgentCap(TENANT, AGENT, 3);
  const { conversationId } = await seedConversation(TENANT, ACCOUNT, "Cap");
  const provider = stubProvider();

  for (let i = 1; i <= 3; i++) {
    const m = await seedInbound(TENANT, conversationId, `pertanyaan ${i}`);
    const r = await respondToInboundMessage(db, provider, {
      tenantId: TENANT,
      conversationId,
      messageId: m,
    });
    assert.equal(r.responded, true, `balasan ${i} harus terkirim`);
  }
  let state = await conversationState(conversationId);
  assert.equal(state.agent_reply_window_count, 3);
  assert.equal(state.agent_enabled, true);
  assert.equal(await outboundAgentMessages(conversationId), 3);
  console.log("[1] di bawah cap: 3 balasan mengalir, jendela=3, AI aktif: OK");

  const m4 = await seedInbound(TENANT, conversationId, "pertanyaan 4");
  const r4 = await respondToInboundMessage(db, provider, {
    tenantId: TENANT,
    conversationId,
    messageId: m4,
  });
  assert.equal(r4.responded, false);
  assert.equal(r4.reason, "conversation_capped");
  state = await conversationState(conversationId);
  assert.equal(state.agent_enabled, false, "cap tercapai harus menyerahkan ke manusia");
  assert.equal(await outboundAgentMessages(conversationId), 3, "tidak ada balasan ke-4");
  assert.equal(await auditCount(TENANT, "agent.conversation_capped", conversationId), 1);
  const handoffs = await auditMeta(TENANT, "agent.handoff", conversationId);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].via, "conversation_cap");
  const summaries = await auditMeta(TENANT, "agent.handoff_summary", conversationId);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, "created");
  assert.equal((await summaryNotes(conversationId)).length, 1, "catatan ringkasan menempel");
  assert.equal(await summaryUsageRows(conversationId), 1, "usage ringkasan tercatat terpisah");

  const m5 = await seedInbound(TENANT, conversationId, "pertanyaan 5");
  const r5 = await respondToInboundMessage(db, provider, {
    tenantId: TENANT,
    conversationId,
    messageId: m5,
  });
  assert.equal(r5.responded, false);
  assert.equal(r5.reason, "ai_disabled");
  console.log("[2] cap tercapai: 'conversation_capped' + handoff + ringkasan + jejak audit: OK");
}

// ---------- 3. Balapan atomik ----------
{
  await setAgentCap(TENANT, AGENT, 3);
  const { conversationId } = await seedConversation(TENANT, ACCOUNT, "Balapan");
  const provider = stubProvider();
  const messageIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    messageIds.push(
      await seedInbound(TENANT, conversationId, `ledakan ${i}`),
    );
  }
  const results = await Promise.all(
    messageIds.map((messageId) =>
      respondToInboundMessage(db, provider, {
        tenantId: TENANT,
        conversationId,
        messageId,
      }),
    ),
  );
  const responded = results.filter((r) => r.responded).length;
  assert.equal(responded, 3, "tepat cap yang boleh membalas di bawah balapan");
  assert.equal(await outboundAgentMessages(conversationId), 3);
  const state = await conversationState(conversationId);
  assert.equal(state.agent_reply_window_count, 3, "hitungan jendela berhenti tepat di cap");
  console.log("[3] balapan 10 panggilan vs cap 3: tepat 3 balasan, jendela=3: OK");
}

// ---------- 4. Tool handoff + ringkasan ----------
{
  await setAgentCap(TENANT, AGENT, null);
  const { conversationId } = await seedConversation(TENANT, ACCOUNT, "Tool");
  const provider = stubProvider({
    toolCalls: [
      {
        id: "h1",
        name: "handoff_to_human",
        arguments: { reason: "pelanggan minta manusia" },
      },
    ],
  });
  const m = await seedInbound(TENANT, conversationId, "tolong manusia saja");
  const r = await respondToInboundMessage(db, provider, {
    tenantId: TENANT,
    conversationId,
    messageId: m,
  });
  assert.equal(r.responded, true);
  assert.equal(
    r.toolOutcomes?.some((o) => o.name === "handoff_to_human" && o.executed),
    true,
  );
  const state = await conversationState(conversationId);
  assert.equal(state.agent_enabled, false);
  const handoffs = await auditMeta(TENANT, "agent.handoff", conversationId);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].via, "agent_tool");
  const summaries = await auditMeta(TENANT, "agent.handoff_summary", conversationId);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, "created");
  assert.equal((await summaryNotes(conversationId)).length, 1);
  assert.equal(await summaryUsageRows(conversationId), 1);
  console.log("[4] tool handoff: handoff terjadi + ringkasan menempel + usage terpisah: OK");
}

// ---------- 5. Gagal-aman ringkasan ----------
{
  const { conversationId } = await seedConversation(TENANT, ACCOUNT, "GagalRingkasan");
  const provider = stubProvider({
    failSummary: true,
    toolCalls: [
      {
        id: "h2",
        name: "handoff_to_human",
        arguments: { reason: "kasus rumit" },
      },
    ],
  });
  const m = await seedInbound(TENANT, conversationId, "kasus saya rumit");
  const r = await respondToInboundMessage(db, provider, {
    tenantId: TENANT,
    conversationId,
    messageId: m,
  });
  assert.equal(r.responded, true, "loop utama tidak boleh ikut tumbang");
  const state = await conversationState(conversationId);
  assert.equal(state.agent_enabled, false, "handoff TETAP terjadi walau ringkasan gagal");
  const summaries = await auditMeta(TENANT, "agent.handoff_summary", conversationId);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, "unavailable");
  assert.equal((await summaryNotes(conversationId)).length, 0, "tidak ada catatan karangan");
  assert.equal(await summaryUsageRows(conversationId), 0);
  console.log("[5] gagal-aman: LLM ringkasan tumbang → handoff tetap terjadi, jejak 'unavailable': OK");
}

// ---------- 6. Slot dilepas saat generasi gagal ----------
{
  await setAgentCap(TENANT, AGENT, 1);
  const { conversationId } = await seedConversation(TENANT, ACCOUNT, "Lepas");
  const m1 = await seedInbound(TENANT, conversationId, "halo?");
  const r1 = await respondToInboundMessage(db, stubProvider({ failAll: true }), {
    tenantId: TENANT,
    conversationId,
    messageId: m1,
  });
  assert.equal(r1.responded, false);
  assert.equal(r1.reason, "provider_error");
  let state = await conversationState(conversationId);
  assert.equal(state.agent_reply_window_count, 0, "slot kegagalan harus dilepas");

  const m2 = await seedInbound(TENANT, conversationId, "halo lagi?");
  const r2 = await respondToInboundMessage(db, stubProvider(), {
    tenantId: TENANT,
    conversationId,
    messageId: m2,
  });
  assert.equal(r2.responded, true, "slot yang dilepas bisa dipakai balasan berikutnya");
  state = await conversationState(conversationId);
  assert.equal(state.agent_reply_window_count, 1);
  console.log("[6] pelepasan slot: provider tumbang tidak membakar jatah pelanggan: OK");
}

// ---------- 7. Cap nonaktif (config 0) ----------
{
  await setAgentCap(TENANT, AGENT, 0);
  const { conversationId } = await seedConversation(TENANT, ACCOUNT, "Nonaktif");
  const provider = stubProvider();
  for (let i = 0; i < 5; i++) {
    const m = await seedInbound(TENANT, conversationId, `lanjut ${i}`);
    const r = await respondToInboundMessage(db, provider, {
      tenantId: TENANT,
      conversationId,
      messageId: m,
    });
    assert.equal(r.responded, true);
  }
  assert.equal(await auditCount(TENANT, "agent.conversation_capped", conversationId), 0);
  console.log("[7] cap nonaktif (0): 5 balasan lolos tanpa 'conversation_capped': OK");
}

// ---------- 8. Isolasi tenant ----------
{
  await setAgentCap(TENANT_B, AGENT_B, 1);
  const b = await seedConversation(TENANT_B, ACCOUNT_B, "Lain");
  const provider = stubProvider();
  const mb = await seedInbound(TENANT_B, b.conversationId, "halo tenant B");
  const rb = await respondToInboundMessage(db, provider, {
    tenantId: TENANT_B,
    conversationId: b.conversationId,
    messageId: mb,
  });
  assert.equal(rb.responded, true, "tenant B tidak terpengaruh cap tenant A");

  // Percakapan tenant A tidak terlihat dari tenant B: pesan pemicu
  // milik tenant B sendiri, tetapi conversationId menunjuk percakapan
  // tenant A → lookup percakapan tenant-scoped tidak menemukannya.
  const asing = await seedConversation(TENANT, ACCOUNT, "Asing");
  const mb2 = await seedInbound(TENANT_B, b.conversationId, "pemicu B");
  const rx = await respondToInboundMessage(db, provider, {
    tenantId: TENANT_B,
    conversationId: asing.conversationId,
    messageId: mb2,
  });
  assert.equal(rx.responded, false);
  assert.equal(rx.reason, "conversation_not_found");
  console.log("[8] isolasi tenant: jendela per tenant terpisah + percakapan asing tak terlihat: OK");
}

console.log("verify-ai-guards: SEMUA LULUS");
