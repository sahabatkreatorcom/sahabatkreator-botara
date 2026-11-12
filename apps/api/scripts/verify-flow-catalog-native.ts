import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@sahabat-kreator/db";
import type { Database, MessageInteractivePayload } from "@sahabat-kreator/db";
import {
  activateFlow,
  createFlow,
  executeFlowStep,
  startFlowRunsForInboundMessage,
  type FlowGraph,
} from "@sahabat-kreator/core";

/**
 * Verifikasi G17 butir 3 — KATALOG NATIF + RANGKUMAN KERANJANG.
 *
 * Bukti yang ditegakkan (tanpa jaringan; pengiriman provider diuji
 * pada lapisan muatannya):
 * A. WhatsApp: node send_catalog mengantre pesan dengan
 *    interactive_payload daftar interaktif (maks 10 baris dari 12
 *    produk — pemotongan tercatat di detail langkah), content_text
 *    tetap daftar terbaca manusia. Ketukan daftar (sinyal
 *    quick_reply ber-payload id produk) memilih produk itu:
 *    keranjang kontak bertambah, run keluar cabang "added".
 * B. Messenger: muatan template generik (elemen + tombol postback
 *    catalog_add:<id>); postback memilih produk, cabang "added",
 *    selectionSource tercatat signal_postback.
 * C. Telegram (tanpa format natif setara): payload NULL, format
 *    tercatat "text", balasan nomor teks tetap bekerja.
 * D. cart_summary: sesudah "added", rangkuman keranjang terkirim
 *    dan cabang "has_items" diambil; pada kontak berkeranjang
 *    kosong cabang "empty" + emptyMessage terkirim.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_WA = "33333333-3333-4333-8333-333333333331";
const ACC_MSG = "33333333-3333-4333-8333-333333333332";
const ACC_TG = "33333333-3333-4333-8333-333333333333";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../packages/db/migrations");

const client = new PGlite({ extensions: { vector, btree_gist } });
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sql = await readFile(path.join(migrationsDir, file), "utf8");
  await client.exec(sql.replaceAll("--> statement-breakpoint", ""));
}
const db = drizzle(client, { schema }) as unknown as Database;

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a')`,
  [TENANT],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@example.com', 'Pemilik A')`,
  [USER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [TENANT, USER],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status)
   VALUES ($1, $2, 'whatsapp', '628110000000', 'WA Toko', 'connected'),
          ($3, $2, 'messenger', 'page-1', 'Page Toko', 'connected'),
          ($4, $2, 'telegram', 'bot-toko', 'Bot Toko', 'connected')`,
  [ACC_WA, TENANT, ACC_MSG, ACC_TG],
);

// 12 produk aktif — dua lebih banyak dari batas format natif (10).
const productIds: string[] = [];
for (let i = 1; i <= 12; i++) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO products (tenant_id, name, description, price_idr, is_active, created_at)
     VALUES ($1, $2, $3, $4, true, now() + ($5 || ' seconds')::interval) RETURNING id`,
    [TENANT, `Produk ${i}`, `Deskripsi produk ${i}`, 10_000 * i, String(i)],
  );
  productIds.push(r.rows[0].id);
}

async function seedConversation(
  accountId: string,
  provider: string,
  name: string,
): Promise<{ contactId: string; conversationId: string }> {
  const c = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name, opt_in_status) VALUES ($1, $2, 'unknown') RETURNING id`,
    [TENANT, name],
  );
  const conv = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
     VALUES ($1, $2, $3, $4, $5, 'private', 'open') RETURNING id`,
    [TENANT, accountId, c.rows[0].id, provider, `chat-${provider}`],
  );
  return { contactId: c.rows[0].id, conversationId: conv.rows[0].id };
}

const catalogGraph: FlowGraph = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      config: { kind: "keyword", keywords: ["MULAI"], match: "exact" },
    },
    {
      id: "katalog",
      type: "send_catalog",
      config: {
        introText: "Pilih produk favoritmu",
        amount: 1,
        unit: "hours",
        maxInvalidAttempts: 2,
      },
    },
    { id: "ringkas", type: "cart_summary", config: {} },
    { id: "selesai", type: "send_message", config: { text: "Selesai" } },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "katalog" },
    { id: "e2", from: "katalog", to: "ringkas", branch: "added" },
    { id: "e3", from: "katalog", to: "end", branch: "invalid" },
    { id: "e4", from: "katalog", to: "end", branch: "timeout" },
    { id: "e5", from: "ringkas", to: "selesai", branch: "has_items" },
    { id: "e6", from: "ringkas", to: "end", branch: "empty" },
  ],
};
const flowMain = await createFlow(db, {
  tenantId: TENANT,
  userId: USER,
  name: "Belanja natif",
  graph: catalogGraph,
});
assert.equal(
  (await activateFlow(db, { tenantId: TENANT, flowId: flowMain.flow.id, userId: USER })).kind,
  "activated",
);

const emptyGraph: FlowGraph = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      config: { kind: "keyword", keywords: ["CEK"], match: "exact" },
    },
    {
      id: "ringkas",
      type: "cart_summary",
      config: { emptyMessage: "Keranjangmu masih kosong" },
    },
    { id: "ajak", type: "send_message", config: { text: "Mulai belanja yuk" } },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "ringkas" },
    { id: "e2", from: "ringkas", to: "ajak", branch: "empty" },
    { id: "e3", from: "ringkas", to: "end", branch: "has_items" },
  ],
};
const flowEmpty = await createFlow(db, {
  tenantId: TENANT,
  userId: USER,
  name: "Cek keranjang",
  graph: emptyGraph,
});
assert.equal(
  (await activateFlow(db, { tenantId: TENANT, flowId: flowEmpty.flow.id, userId: USER })).kind,
  "activated",
);

async function inbound(
  conversationId: string,
  text: string,
  signal?: { kind: "postback" | "quick_reply"; payload: string; title: string | null },
): Promise<void> {
  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId));
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, conversation.contactId));
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status, trigger_signal)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received', $4) RETURNING id`,
    [TENANT, conversationId, text, signal ? JSON.stringify(signal) : null],
  );
  await startFlowRunsForInboundMessage(db, {
    tenantId: TENANT,
    conversationId,
    messageId: msg.rows[0].id,
    messageText: text,
    contact,
    conversation,
    triggerSignal: signal ?? null,
  });
}

async function drive(runId: string): Promise<string> {
  let status = "running";
  for (let i = 0; i < 12; i++) {
    const [run] = await db
      .select()
      .from(schema.flowRuns)
      .where(eq(schema.flowRuns.id, runId));
    if (!run || run.status !== "running") {
      status = run?.status ?? "missing";
      break;
    }
    const step = await executeFlowStep(db, {
      tenantId: TENANT,
      runId,
      stepSeq: run.nextStepSeq,
    });
    status = step.status ?? status;
    if (status !== "running") break;
  }
  return status;
}

async function latestRunId(conversationId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM flow_runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  return r.rows[0].id;
}

async function catalogMessage(conversationId: string): Promise<{
  content_text: string;
  interactive_payload: MessageInteractivePayload | null;
}> {
  const r = await client.query<{
    content_text: string;
    interactive_payload: MessageInteractivePayload | null;
  }>(
    `SELECT content_text, interactive_payload FROM messages
      WHERE conversation_id = $1 AND direction = 'outbound'
      ORDER BY created_at ASC LIMIT 1`,
    [conversationId],
  );
  return r.rows[0];
}

async function stepDetail(
  runId: string,
  nodeType: string,
): Promise<Record<string, unknown>> {
  const r = await client.query<{ detail: Record<string, unknown> }>(
    `SELECT detail FROM flow_run_steps WHERE run_id = $1 AND node_type = $2 ORDER BY seq DESC LIMIT 1`,
    [runId, nodeType],
  );
  assert.ok(r.rows.length > 0, `langkah ${nodeType} ada`);
  return r.rows[0].detail;
}

async function cartProductIds(contactId: string): Promise<string[]> {
  const r = await client.query<{ product_id: string }>(
    `SELECT ci.product_id FROM cart_items ci
       JOIN carts c ON c.id = ci.cart_id
      WHERE c.contact_id = $1 AND c.status = 'open'`,
    [contactId],
  );
  return r.rows.map((x) => x.product_id);
}

// ---- A: WhatsApp ------------------------------------------------------
{
  const { contactId, conversationId } = await seedConversation(ACC_WA, "whatsapp", "Pembeli WA");
  await inbound(conversationId, "MULAI");
  const runId = await latestRunId(conversationId);
  const parked = await drive(runId);
  assert.equal(parked, "waiting", "run parkir menunggu pilihan katalog");

  const msg = await catalogMessage(conversationId);
  assert.ok(msg.content_text.includes("1. Produk 1"), "content_text daftar manusia");
  assert.equal(msg.interactive_payload?.kind, "whatsapp_list");
  if (msg.interactive_payload?.kind === "whatsapp_list") {
    const rows = msg.interactive_payload.sections[0].rows;
    assert.equal(rows.length, 10, "daftar WA terpotong ke 10 baris");
    assert.equal(rows[2].id, productIds[2]);
    assert.ok(rows[0].title.includes("Produk 1"));
  }
  const shown = await stepDetail(runId, "send_catalog");
  assert.equal(shown.format, "whatsapp_list");
  assert.equal(shown.truncated, true);
  assert.equal(shown.totalProducts, 12);

  // Ketukan daftar: sinyal quick_reply ber-payload id produk ke-3.
  await inbound(conversationId, "Produk 3", {
    kind: "quick_reply",
    payload: productIds[2],
    title: "Produk 3",
  });
  const done = await drive(runId);
  assert.equal(done, "completed");
  assert.deepEqual(await cartProductIds(contactId), [productIds[2]]);
  const summary = await stepDetail(runId, "cart_summary");
  assert.equal(summary.outcome, "summary_sent");
  const texts = await client.query<{ content_text: string }>(
    `SELECT content_text FROM messages WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY created_at`,
    [conversationId],
  );
  assert.ok(
    texts.rows.some((r) => r.content_text.includes("Produk 3") && r.content_text.includes("Total:")),
    "pesan rangkuman keranjang terkirim",
  );
  assert.ok(texts.rows.some((r) => r.content_text === "Selesai"));
}

// ---- B: Messenger -------------------------------------------------------
{
  const { contactId, conversationId } = await seedConversation(ACC_MSG, "messenger", "Pembeli MSG");
  await inbound(conversationId, "MULAI");
  const runId = await latestRunId(conversationId);
  assert.equal(await drive(runId), "waiting");

  const msg = await catalogMessage(conversationId);
  assert.equal(msg.interactive_payload?.kind, "generic_template");
  if (msg.interactive_payload?.kind === "generic_template") {
    const elements = msg.interactive_payload.elements;
    assert.equal(elements.length, 10);
    assert.equal(
      elements[1].buttons[0].payload,
      `catalog_add:${productIds[1]}`,
    );
    assert.equal(elements[1].buttons[0].type, "postback");
  }
  const shown = await stepDetail(runId, "send_catalog");
  assert.equal(shown.format, "generic_template");

  await inbound(conversationId, "Tambah ke Keranjang", {
    kind: "postback",
    payload: `catalog_add:${productIds[1]}`,
    title: "Tambah ke Keranjang",
  });
  assert.equal(await drive(runId), "completed");
  assert.deepEqual(await cartProductIds(contactId), [productIds[1]]);
  const closing = await client.query<{ detail: Record<string, unknown> }>(
    `SELECT detail FROM flow_run_steps WHERE run_id = $1 AND node_type = 'send_catalog' ORDER BY seq DESC LIMIT 1`,
    [runId],
  );
  assert.equal(closing.rows[0].detail.selectionSource, "signal_postback");
}

// ---- C: Telegram (fallback teks) ---------------------------------------
{
  const { contactId, conversationId } = await seedConversation(ACC_TG, "telegram", "Pembeli TG");
  await inbound(conversationId, "MULAI");
  const runId = await latestRunId(conversationId);
  assert.equal(await drive(runId), "waiting");

  const msg = await catalogMessage(conversationId);
  assert.equal(msg.interactive_payload, null, "telegram tanpa muatan natif");
  assert.ok(msg.content_text.includes("12. Produk 12"), "teks memuat semua produk");
  const shown = await stepDetail(runId, "send_catalog");
  assert.equal(shown.format, "text");
  assert.equal(shown.truncated, false);

  await inbound(conversationId, "2");
  assert.equal(await drive(runId), "completed");
  assert.deepEqual(await cartProductIds(contactId), [productIds[1]]);
}

// ---- D: cart_summary keranjang kosong ------------------------------------
{
  const { conversationId } = await seedConversation(ACC_TG, "telegram", "Pengintip");
  await inbound(conversationId, "CEK");
  const runId = await latestRunId(conversationId);
  assert.equal(await drive(runId), "completed");
  const detail = await stepDetail(runId, "cart_summary");
  assert.equal(detail.outcome, "cart_empty");
  const texts = await client.query<{ content_text: string }>(
    `SELECT content_text FROM messages WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY created_at`,
    [conversationId],
  );
  assert.deepEqual(
    texts.rows.map((r) => r.content_text),
    ["Keranjangmu masih kosong", "Mulai belanja yuk"],
  );
}

console.log(
  "verify-flow-catalog-native: SEMUA LULUS — daftar interaktif WA (10/12, terpotong tercatat) + ketukan memilih produk; template generik Messenger + postback catalog_add memilih; Telegram fallback teks jujur + balasan nomor; cart_summary has_items/empty dari keranjang commerce yang sama.",
);
