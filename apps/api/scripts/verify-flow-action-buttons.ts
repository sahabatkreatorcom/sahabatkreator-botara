/**
 * Verifikasi Gelombang G18 butir 3 — TOMBOL COPY TEXT & CALL
 * (node flow `send_action_buttons`), di atas PGlite.
 *
 * Membuktikan:
 *   [1] Telegram: kedua tombol NATIF — muatan pesan keluar adalah
 *       keyboard inline (copy_text + URL tel: ternormalisasi),
 *       badan pesan bersih tanpa baris fallback; mode tercatat
 *       native/native di detail langkah.
 *   [2] Messenger: telepon NATIF (template tombol phone_number),
 *       salin teks turun sebagai baris teks terbaca di badan pesan;
 *       mode tercatat call=native, copy_text=text_fallback.
 *   [3] WhatsApp: tanpa bentuk natif untuk node ini — payload NULL
 *       dan kedua nilai tampil sebagai baris teks; mode tercatat
 *       text_fallback/text_fallback (tidak gagal diam-diam).
 *   [4] Murni: nomor tidak sah di Telegram turun ke fallback teks
 *       (bukan tombol rusak); label template Messenger terpotong
 *       ke 20; provider tak dikenal → semua fallback.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:flow-action-buttons
 */
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
  buildActionButtonsDelivery,
  createFlow,
  executeFlowStep,
  startFlowRunsForInboundMessage,
  type FlowGraph,
} from "@sahabat-kreator/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../../packages/db/migrations");

const client = new PGlite({ extensions: { vector, btree_gist } });
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
  await client.exec(sqlText.replaceAll("--> statement-breakpoint", ""));
}
const db = drizzle(client, { schema }) as unknown as Database;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_TG = "33333333-3333-4333-8333-333333333331";
const ACC_MSG = "33333333-3333-4333-8333-333333333332";
const ACC_WA = "33333333-3333-4333-8333-333333333333";

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
   VALUES ($1, $2, 'telegram', 'bot-toko', 'Bot Toko', 'connected'),
          ($3, $2, 'messenger', 'page-1', 'Page Toko', 'connected'),
          ($4, $2, 'whatsapp', '628110000000', 'WA Toko', 'connected')`,
  [ACC_TG, TENANT, ACC_MSG, ACC_WA],
);

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

const graph: FlowGraph = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      config: { kind: "keyword", keywords: ["TOMBOL"], match: "exact" },
    },
    {
      id: "aksi",
      type: "send_action_buttons",
      config: {
        text: "Halo {name}, ini kode voucher kamu:",
        buttons: [
          { kind: "copy_text", label: "Salin kode", value: "HEMAT50" },
          {
            kind: "call",
            label: "Hubungi admin toko sekarang",
            value: "+62 812-3456-7890",
          },
        ],
      },
    },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "aksi" },
    { id: "e2", from: "aksi", to: "end" },
  ],
};
const flow = await createFlow(db, {
  tenantId: TENANT,
  userId: USER,
  name: "Tombol aksi",
  graph,
});
assert.equal(
  (await activateFlow(db, { tenantId: TENANT, flowId: flow.flow.id, userId: USER })).kind,
  "activated",
);

async function driveToEnd(conversationId: string): Promise<void> {
  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId));
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, conversation!.contactId));
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', 'TOMBOL', 'received') RETURNING id`,
    [TENANT, conversationId],
  );
  await startFlowRunsForInboundMessage(db, {
    tenantId: TENANT,
    conversationId,
    messageId: msg.rows[0]!.id,
    messageText: "TOMBOL",
    contact: contact!,
    conversation: conversation!,
    triggerSignal: null,
  });
  const runRow = await client.query<{ id: string; next_step_seq: number }>(
    `SELECT id, next_step_seq FROM flow_runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  const runId = runRow.rows[0]!.id;
  for (let i = 0; i < 8; i++) {
    const [run] = await db
      .select()
      .from(schema.flowRuns)
      .where(eq(schema.flowRuns.id, runId));
    if (!run || run.status !== "running") break;
    await executeFlowStep(db, {
      tenantId: TENANT,
      runId,
      stepSeq: run.nextStepSeq,
    });
  }
}

interface OutboundRow {
  content_text: string;
  interactive_payload: MessageInteractivePayload | null;
}
async function outboundOf(conversationId: string): Promise<OutboundRow> {
  const r = await client.query<OutboundRow>(
    `SELECT content_text, interactive_payload FROM messages
      WHERE conversation_id = $1 AND direction = 'outbound'
      ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  assert.ok(r.rows[0], "pesan keluar harus ada");
  return r.rows[0]!;
}
async function stepDetail(conversationId: string): Promise<{
  format?: string;
  buttons?: Array<{ kind: string; mode: string }>;
}> {
  const r = await client.query<{ detail: { format?: string; buttons?: Array<{ kind: string; mode: string }> } }>(
    `SELECT detail FROM flow_run_steps WHERE run_id = (
       SELECT id FROM flow_runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1
     ) AND node_type = 'send_action_buttons' LIMIT 1`,
    [conversationId],
  );
  assert.ok(r.rows[0], "langkah send_action_buttons harus tercatat");
  return r.rows[0]!.detail;
}

// --- [1] Telegram -----------------------------------------------------------------
{
  const { conversationId } = await seedConversation(ACC_TG, "telegram", "Sari");
  await driveToEnd(conversationId);
  const out = await outboundOf(conversationId);
  assert.equal(out.content_text, "Halo Sari, ini kode voucher kamu:");
  assert.deepEqual(out.interactive_payload, {
    kind: "telegram_inline_buttons",
    buttons: [
      { label: "Salin kode", copyText: "HEMAT50" },
      { label: "Hubungi admin toko sekarang", url: "tel:+6281234567890" },
    ],
  });
  const detail = await stepDetail(conversationId);
  assert.equal(detail.format, "telegram_inline_buttons");
  assert.deepEqual(detail.buttons, [
    { kind: "copy_text", mode: "native" },
    { kind: "call", mode: "native" },
  ]);
  console.log("[1] Telegram: keyboard inline natif (copy_text + tel:): OK");
}

// --- [2] Messenger ------------------------------------------------------------------
{
  const { conversationId } = await seedConversation(ACC_MSG, "messenger", "Budi");
  await driveToEnd(conversationId);
  const out = await outboundOf(conversationId);
  assert.equal(
    out.content_text,
    "Halo Budi, ini kode voucher kamu:\nSalin kode: HEMAT50",
  );
  assert.deepEqual(out.interactive_payload, {
    kind: "messenger_button_template",
    buttons: [
      {
        type: "phone_number",
        // Label terpotong ke batas Send API (20).
        title: "Hubungi admin toko s",
        payload: "+6281234567890",
      },
    ],
  });
  const detail = await stepDetail(conversationId);
  assert.equal(detail.format, "messenger_button_template");
  assert.deepEqual(detail.buttons, [
    { kind: "copy_text", mode: "text_fallback" },
    { kind: "call", mode: "native" },
  ]);
  console.log("[2] Messenger: telepon natif + salin teks fallback tercatat: OK");
}

// --- [3] WhatsApp ---------------------------------------------------------------------
{
  const { conversationId } = await seedConversation(ACC_WA, "whatsapp", "Rani");
  await driveToEnd(conversationId);
  const out = await outboundOf(conversationId);
  assert.equal(out.interactive_payload, null);
  assert.equal(
    out.content_text,
    "Halo Rani, ini kode voucher kamu:\nSalin kode: HEMAT50\nHubungi admin toko sekarang: +62 812-3456-7890",
  );
  const detail = await stepDetail(conversationId);
  assert.equal(detail.format, "text");
  assert.deepEqual(detail.buttons, [
    { kind: "copy_text", mode: "text_fallback" },
    { kind: "call", mode: "text_fallback" },
  ]);
  console.log("[3] WhatsApp: fallback teks penuh, tercatat jujur: OK");
}

// --- [4] Kasus tepi murni ---------------------------------------------------------------
{
  const bad = buildActionButtonsDelivery({
    provider: "telegram",
    text: "Halo",
    buttons: [{ kind: "call", label: "Telepon", value: "bukan nomor" }],
  });
  assert.equal(bad.interactivePayload, null);
  assert.equal(bad.contentText, "Halo\nTelepon: bukan nomor");
  assert.deepEqual(bad.modes, [{ kind: "call", mode: "text_fallback" }]);

  const unknown = buildActionButtonsDelivery({
    provider: "bluesky",
    text: "Halo",
    buttons: [{ kind: "copy_text", label: "Salin", value: "X1" }],
  });
  assert.equal(unknown.interactivePayload, null);
  assert.equal(unknown.contentText, "Halo\nSalin: X1");
  console.log("[4] nomor tidak sah + provider tak dikenal → fallback teks: OK");
}

console.log("verify-flow-action-buttons: SEMUA LULUS");
process.exit(0);
