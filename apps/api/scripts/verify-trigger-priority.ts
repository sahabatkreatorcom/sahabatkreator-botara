/**
 * Verifikasi Gelombang G5 — PEMICU POSTBACK/QUICK-REPLY/WELCOME +
 * PRIORITAS TRIGGER EKSPLISIT — di atas PGlite + seluruh migrasi +
 * aplikasi Hono dengan AuthBundle tiruan (pola verify-flow-versions)
 * + service core sungguhan untuk evaluasi pesan masuk.
 *
 * Membuktikan urutan prioritas trigger-priority.ts (sumber kebenaran
 * tunggal di core) lewat skenario BERTABRAKAN:
 *   [1] CRUD automation pemicu baru via API: postback (payloads
 *       tersimpan & terbaca), quick_reply kind sequence, welcome;
 *       postback tanpa payloads → 400; PATCH payloads bekerja.
 *   [2] POSTBACK mengalahkan KEYWORD: pesan bersinyal postback yang
 *       teks tampilnya PERSIS cocok keyword hanya menembakkan aturan
 *       postback (automation + flow); kontrol teks biasa sebaliknya.
 *   [3] QUICK REPLY mengalahkan KEYWORD: ketukan QR berpayload dikenal
 *       hanya menembak aturan QR; teks sama tanpa sinyal → keyword;
 *       QR berpayload TAK dikenal turun kelas → keyword menembak.
 *   [4] KEYWORD mengalahkan WELCOME: pesan pertama yang cocok keyword
 *       tidak memicu sambutan; pesan pertama netral menyambut
 *       (automation + flow); pesan kedua tidak.
 *   [5] LAPISAN KESELAMATAN tetap paling depan: run wait_reply parkir
 *       ter-resume oleh pesan yang juga menembak keyword (resume tidak
 *       menekan pemicu lain — keputusan desain terdokumentasi); kata
 *       opt-out persis ditangkap consent dan automation contains yang
 *       cocok TIDAK menembak.
 *   [6] WELCOME hanya sekali per kontak per aturan: percakapan BARU
 *       kontak yang sama tidak disambut ulang (automation + flow).
 *   [7] Postback tak dikenal: tercatat, triggerSignalKind='postback',
 *       tidak ada yang menembak — bahan gerbang worker agar payload
 *       mesin tidak pernah diteruskan ke agent AI.
 *   [8] Isolasi tenant: aturan postback tenant A tidak terlihat &
 *       tidak menembak untuk pesan tenant B.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:trigger-priority
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  activateFlow,
  createFlow,
  deactivateFlow,
  evaluateInboundMessageForAutomations,
  executeFlowStep,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createAutomationsRoutes } from "../src/modules/automations/routes";
import { createFlowsRoutes } from "../src/modules/flows/routes";

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
console.log(`[setup] migrasi teraplikasi: ${files.length} file`);
const db = drizzle(client, { schema }) as unknown as Database;

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_B = "66666666-6666-4666-8666-666666666666";
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A'), ($2, 'b@sk.test', 'Pemilik B')`,
  [USER_A, USER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
  [TENANT_A, USER_A, TENANT_B, USER_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'webchat', 'wc_uji_pemicu', 'connected'), ($3, $4, 'webchat', 'wc_uji_pemicu_b', 'connected')`,
  [ACCOUNT_A, TENANT_A, ACCOUNT_B, TENANT_B],
);

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? USER_A;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
app.route("/", createAutomationsRoutes({ db } as unknown as AuthBundle));
app.route("/", createFlowsRoutes({ db } as unknown as AuthBundle));

interface AnyBody {
  id?: string;
  triggerType?: string;
  kind?: string;
  payloads?: string[];
  keywords?: string[];
  automations?: { id: string; triggerType: string }[];
  error?: { code: string };
}

async function call(
  method: string,
  url: string,
  userId: string,
  body?: unknown,
): Promise<{ status: number; body: AnyBody }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": userId,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as AnyBody,
  };
}

const autoUrl = (tenantId: string) => `/tenants/${tenantId}/automations`;

// ---------------------------------------------------------------------------
// Pembantu seed & baca langsung (pola verify-flow-versions).
// ---------------------------------------------------------------------------
async function seedContact(
  name: string,
  tenantId: string = TENANT_A,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name, opt_in_status) VALUES ($1, $2, 'unknown') RETURNING id`,
    [tenantId, name],
  );
  return r.rows[0].id;
}

async function seedConversation(
  contactId: string,
  tenantId: string = TENANT_A,
): Promise<string> {
  const accountId = tenantId === TENANT_A ? ACCOUNT_A : ACCOUNT_B;
  const r = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, kind, title)
     VALUES ($1, $2, $3, 'webchat', 'private', NULL) RETURNING id`,
    [tenantId, accountId, contactId],
  );
  return r.rows[0].id;
}

interface SignalSeed {
  kind: "postback" | "quick_reply";
  payload: string;
  title: string | null;
}

async function seedInbound(
  conversationId: string,
  text: string,
  signal?: SignalSeed,
  tenantId: string = TENANT_A,
): Promise<string> {
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status, trigger_signal)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received', $4) RETURNING id`,
    [
      tenantId,
      conversationId,
      text,
      signal ? JSON.stringify(signal) : null,
    ],
  );
  return msg.rows[0].id;
}

async function outboundTexts(
  conversationId: string,
  tenantId: string = TENANT_A,
): Promise<string[]> {
  const r = await client.query<{ content_text: string }>(
    `SELECT content_text FROM messages
     WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'
     ORDER BY created_at, id`,
    [tenantId, conversationId],
  );
  return r.rows.map((x) => x.content_text);
}

async function flowNamesForMessage(
  messageId: string,
  tenantId: string = TENANT_A,
): Promise<string[]> {
  const r = await client.query<{ name: string }>(
    `SELECT f.name FROM flow_runs fr JOIN flows f ON f.id = fr.flow_id
     WHERE fr.tenant_id=$1 AND fr.trigger_message_id=$2 ORDER BY f.created_at`,
    [tenantId, messageId],
  );
  return r.rows.map((x) => x.name);
}

async function evaluate(
  tenantId: string,
  conversationId: string,
  messageId: string,
) {
  return evaluateInboundMessageForAutomations(db, {
    tenantId,
    conversationId,
    messageId,
  });
}

async function setAutomationActive(
  id: string,
  isActive: boolean,
  tenantId: string = TENANT_A,
  userId: string = USER_A,
): Promise<void> {
  const res = await call(
    "PATCH",
    `${autoUrl(tenantId)}/${id}`,
    userId,
    { isActive },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

/** Graf lurus: trigger → satu pesan. */
function simpleGraph(
  triggerConfig: Record<string, unknown>,
  text: string,
) {
  return {
    nodes: [
      { id: "t", type: "trigger", config: triggerConfig },
      { id: "s", type: "send_message", config: { text } },
    ],
    edges: [{ from: "t", to: "s" }],
  };
}

async function makeFlow(
  name: string,
  triggerConfig: Record<string, unknown>,
  text: string,
): Promise<string> {
  const created = await createFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    name,
    graph: simpleGraph(triggerConfig, text) as never,
  });
  assert.equal(created.kind, "created", JSON.stringify(created));
  const act = await activateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId: created.flow.id,
  });
  assert.equal(act.kind, "activated", JSON.stringify(act));
  return created.flow.id;
}

async function stopFlow(flowId: string): Promise<void> {
  await deactivateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId,
  });
}

// ---------- [1] CRUD automation pemicu baru via API ----------
{
  const pb = await call("POST", autoUrl(TENANT_A), USER_A, {
    triggerType: "postback",
    kind: "keyword",
    name: "Menu tombol",
    payloads: ["MENU", "ORDER"],
    text: "Ini menu kami.",
  });
  assert.equal(pb.status, 201, JSON.stringify(pb.body));
  assert.equal(pb.body.triggerType, "postback");
  assert.deepEqual(pb.body.payloads, ["MENU", "ORDER"]);
  assert.deepEqual(pb.body.keywords, []);

  const patched = await call(
    "PATCH",
    `${autoUrl(TENANT_A)}/${pb.body.id}`,
    USER_A,
    { payloads: ["MENU", "ORDER", "PROMO"] },
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.payloads, ["MENU", "ORDER", "PROMO"]);

  const qr = await call("POST", autoUrl(TENANT_A), USER_A, {
    triggerType: "quick_reply",
    kind: "sequence",
    name: "Onboarding tombol",
    payloads: ["MULAI"],
    steps: [{ delayMinutes: 0, text: "Langkah satu" }],
  });
  assert.equal(qr.status, 201, JSON.stringify(qr.body));
  assert.equal(qr.body.triggerType, "quick_reply");
  assert.equal(qr.body.kind, "sequence");

  const wl = await call("POST", autoUrl(TENANT_A), USER_A, {
    triggerType: "welcome",
    kind: "keyword",
    name: "Sambutan uji CRUD",
    text: "Halo, selamat datang!",
  });
  assert.equal(wl.status, 201, JSON.stringify(wl.body));
  assert.equal(wl.body.triggerType, "welcome");
  assert.deepEqual(wl.body.payloads, []);

  const noPayload = await call("POST", autoUrl(TENANT_A), USER_A, {
    triggerType: "postback",
    kind: "keyword",
    name: "Tanpa payload",
    text: "tidak boleh lahir",
  });
  assert.equal(noPayload.status, 400, JSON.stringify(noPayload.body));

  // Validasi aktivasi flow: pemicu postback tanpa payloads ditolak
  // dengan kode khusus TRIGGER_PAYLOADS_REQUIRED.
  const badFlow = await createFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    name: "Flow postback kosong",
    graph: simpleGraph({ kind: "postback", payloads: [] }, "x") as never,
  });
  assert.equal(badFlow.kind, "created");
  const badAct = await activateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId: badFlow.flow.id,
  });
  assert.equal(badAct.kind, "invalid");
  if (badAct.kind === "invalid") {
    assert.ok(
      badAct.issues.some((i) => i.code === "TRIGGER_PAYLOADS_REQUIRED"),
      JSON.stringify(badAct.issues),
    );
  }

  // Bersihkan: aturan-aturan ini tidak boleh ikut campur seksi berikut.
  await setAutomationActive(pb.body.id!, false);
  await setAutomationActive(qr.body.id!, false);
  await setAutomationActive(wl.body.id!, false);
  console.log(
    "[1] CRUD automation postback/quick_reply/welcome via API + validasi payloads: OK",
  );
}

// ---------- [2] POSTBACK mengalahkan KEYWORD ----------
{
  const kwAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    kind: "keyword",
    name: "Keyword MENU",
    keywords: ["MENU"],
    match: "exact",
    text: "BALAS KEYWORD MENU",
  });
  assert.equal(kwAuto.status, 201);
  const pbAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    triggerType: "postback",
    kind: "keyword",
    name: "Postback MENU",
    payloads: ["MENU"],
    text: "BALAS POSTBACK MENU",
  });
  assert.equal(pbAuto.status, 201);
  const kwFlowId = await makeFlow(
    "Flow keyword MENU",
    { kind: "keyword", keywords: ["MENU"], match: "exact" },
    "FLOW KEYWORD MENU",
  );
  const pbFlowId = await makeFlow(
    "Flow postback MENU",
    { kind: "postback", payloads: ["MENU"] },
    "FLOW POSTBACK MENU",
  );

  // Ketukan tombol: teks tampil "MENU" PERSIS cocok keyword — tetapi
  // sinyal postback menutup seluruh kelas teks.
  const contactId = await seedContact("Pengetuk Menu");
  const convId = await seedConversation(contactId);
  const msgId = await seedInbound(convId, "MENU", {
    kind: "postback",
    payload: "MENU",
    title: "MENU",
  });
  const result = await evaluate(TENANT_A, convId, msgId);
  assert.equal(result.triggerSignalKind, "postback");
  assert.equal(result.fired.length, 1, JSON.stringify(result.fired));
  assert.equal(result.fired[0].automationId, pbAuto.body.id);
  assert.equal(result.fired[0].matchedPayload, "MENU");
  assert.deepEqual(await outboundTexts(convId), ["BALAS POSTBACK MENU"]);
  assert.deepEqual(await flowNamesForMessage(msgId), ["Flow postback MENU"]);
  assert.equal(result.flowRunsStarted, 1);

  // Kontrol: teks "MENU" yang sama TANPA sinyal adalah pesan keyword.
  const contact2 = await seedContact("Pengetik Menu");
  const conv2 = await seedConversation(contact2);
  const msg2 = await seedInbound(conv2, "MENU");
  const control = await evaluate(TENANT_A, conv2, msg2);
  assert.equal(control.triggerSignalKind, null);
  assert.equal(control.fired.length, 1);
  assert.equal(control.fired[0].automationId, kwAuto.body.id);
  assert.deepEqual(await flowNamesForMessage(msg2), ["Flow keyword MENU"]);

  await setAutomationActive(kwAuto.body.id!, false);
  await setAutomationActive(pbAuto.body.id!, false);
  await stopFlow(kwFlowId);
  await stopFlow(pbFlowId);
  console.log(
    "[2] postback mengalahkan keyword (automation + flow); teks biasa tetap keyword: OK",
  );
}

// ---------- [3] QUICK REPLY mengalahkan KEYWORD ----------
{
  const kwAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    kind: "keyword",
    name: "Keyword Ya",
    keywords: ["Ya"],
    match: "exact",
    text: "BALAS KEYWORD YA",
  });
  assert.equal(kwAuto.status, 201);
  const qrAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    triggerType: "quick_reply",
    kind: "keyword",
    name: "QR CONFIRM_YES",
    payloads: ["CONFIRM_YES"],
    text: "BALAS QR YA",
  });
  assert.equal(qrAuto.status, 201);
  const kwFlowId = await makeFlow(
    "Flow keyword Ya",
    { kind: "keyword", keywords: ["Ya"], match: "exact" },
    "FLOW KEYWORD YA",
  );
  const qrFlowId = await makeFlow(
    "Flow QR CONFIRM_YES",
    { kind: "quick_reply", payloads: ["CONFIRM_YES"] },
    "FLOW QR YA",
  );

  // Ketukan QR dikenal: hanya kelas QR yang menembak (dua mesin).
  const c1 = await seedContact("Pengetuk QR");
  const v1 = await seedConversation(c1);
  const m1 = await seedInbound(v1, "Ya", {
    kind: "quick_reply",
    payload: "CONFIRM_YES",
    title: "Ya",
  });
  const r1 = await evaluate(TENANT_A, v1, m1);
  assert.equal(r1.triggerSignalKind, "quick_reply");
  assert.equal(r1.fired.length, 1, JSON.stringify(r1.fired));
  assert.equal(r1.fired[0].automationId, qrAuto.body.id);
  assert.deepEqual(await outboundTexts(v1), ["BALAS QR YA"]);
  assert.deepEqual(await flowNamesForMessage(m1), ["Flow QR CONFIRM_YES"]);

  // Teks "Ya" tanpa sinyal TIDAK naik kelas: keyword yang menembak.
  const c2 = await seedContact("Pengetik Ya");
  const v2 = await seedConversation(c2);
  const m2 = await seedInbound(v2, "Ya");
  const r2 = await evaluate(TENANT_A, v2, m2);
  assert.equal(r2.fired.length, 1);
  assert.equal(r2.fired[0].automationId, kwAuto.body.id);
  assert.deepEqual(await flowNamesForMessage(m2), ["Flow keyword Ya"]);

  // QR berpayload TAK dikenal turun kelas menjadi teks biasa.
  const c3 = await seedContact("Pengetuk Asing");
  const v3 = await seedConversation(c3);
  const m3 = await seedInbound(v3, "Ya", {
    kind: "quick_reply",
    payload: "TIDAK_DIKENAL",
    title: "Ya",
  });
  const r3 = await evaluate(TENANT_A, v3, m3);
  assert.equal(r3.fired.length, 1, JSON.stringify(r3.fired));
  assert.equal(r3.fired[0].automationId, kwAuto.body.id);
  assert.deepEqual(await flowNamesForMessage(m3), ["Flow keyword Ya"]);

  await setAutomationActive(kwAuto.body.id!, false);
  await setAutomationActive(qrAuto.body.id!, false);
  await stopFlow(kwFlowId);
  await stopFlow(qrFlowId);
  console.log(
    "[3] quick reply mengalahkan keyword; tanpa sinyal tetap teks; payload asing turun kelas: OK",
  );
}

// ---------- [4] KEYWORD mengalahkan WELCOME + [6] welcome hanya sekali ----------
{
  const wlAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    triggerType: "welcome",
    kind: "keyword",
    name: "Sambutan utama",
    text: "SELAMAT DATANG",
  });
  assert.equal(wlAuto.status, 201);
  const kwAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    kind: "keyword",
    name: "Keyword PROMO",
    keywords: ["PROMO"],
    match: "exact",
    text: "INFO PROMO",
  });
  assert.equal(kwAuto.status, 201);
  const wlFlowId = await makeFlow(
    "Flow sambutan",
    { kind: "welcome" },
    "FLOW SAMBUTAN",
  );
  const kwFlowId = await makeFlow(
    "Flow keyword PROMO",
    { kind: "keyword", keywords: ["PROMO"], match: "exact" },
    "FLOW PROMO",
  );

  // Pesan pertama yang cocok keyword: sambutan (dua mesin) ditekan.
  const c1 = await seedContact("Pemburu Promo");
  const v1 = await seedConversation(c1);
  const m1 = await seedInbound(v1, "PROMO");
  const r1 = await evaluate(TENANT_A, v1, m1);
  assert.equal(r1.fired.length, 1);
  assert.equal(r1.fired[0].automationId, kwAuto.body.id);
  assert.deepEqual(await outboundTexts(v1), ["INFO PROMO"]);
  assert.deepEqual(await flowNamesForMessage(m1), ["Flow keyword PROMO"]);

  // Pesan pertama netral: sambutan menyala (automation + flow).
  const c2 = await seedContact("Kontak Baru");
  const v2 = await seedConversation(c2);
  const m2 = await seedInbound(v2, "halo kak");
  const r2 = await evaluate(TENANT_A, v2, m2);
  assert.equal(r2.fired.length, 1, JSON.stringify(r2.fired));
  assert.equal(r2.fired[0].automationId, wlAuto.body.id);
  assert.deepEqual(await outboundTexts(v2), ["SELAMAT DATANG"]);
  assert.deepEqual(await flowNamesForMessage(m2), ["Flow sambutan"]);

  // Pesan kedua di percakapan yang sama: bukan pesan pertama lagi.
  const m2b = await seedInbound(v2, "halo lagi");
  const r2b = await evaluate(TENANT_A, v2, m2b);
  assert.equal(r2b.fired.length, 0);
  assert.equal(r2b.flowRunsStarted, 0);

  // [6] Percakapan BARU kontak yang sama: pesan pertama percakapan
  // ini, tetapi sambutan per aturan sudah pernah menyala → tidak lagi.
  const v3 = await seedConversation(c2);
  const m3 = await seedInbound(v3, "pagi");
  const r3 = await evaluate(TENANT_A, v3, m3);
  assert.equal(r3.fired.length, 0, JSON.stringify(r3.fired));
  assert.equal(r3.flowRunsStarted, 0);
  assert.deepEqual(await outboundTexts(v3), []);
  assert.deepEqual(await flowNamesForMessage(m3), []);

  await setAutomationActive(wlAuto.body.id!, false);
  await setAutomationActive(kwAuto.body.id!, false);
  await stopFlow(wlFlowId);
  await stopFlow(kwFlowId);
  console.log(
    "[4] keyword mengalahkan welcome; pesan pertama netral menyambut: OK",
  );
  console.log(
    "[6] welcome hanya sekali per kontak per aturan (percakapan baru tidak mengulang): OK",
  );
}

// ---------- [5] Lapisan keselamatan: resume parkir + consent ----------
{
  const waitGraph = {
    nodes: [
      {
        id: "t",
        type: "trigger",
        config: { kind: "keyword", keywords: ["tanya"], match: "exact" },
      },
      { id: "q", type: "send_message", config: { text: "PERTANYAAN" } },
      { id: "w", type: "wait_reply", config: { amount: 30, unit: "minutes" } },
      { id: "s", type: "send_message", config: { text: "LANJUT" } },
      { id: "e", type: "end", config: {} },
    ],
    edges: [
      { from: "t", to: "q" },
      { from: "q", to: "w" },
      { from: "w", to: "s", branch: "replied" },
      { from: "w", to: "e", branch: "timeout" },
    ],
  };
  const created = await createFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    name: "Flow parkir prioritas",
    graph: waitGraph as never,
  });
  assert.equal(created.kind, "created");
  const parkFlowId = created.flow.id;
  const act = await activateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId: parkFlowId,
  });
  assert.equal(act.kind, "activated");

  const contactId = await seedContact("Penanya Parkir");
  const convId = await seedConversation(contactId);
  const triggerId = await seedInbound(convId, "tanya");
  const ev1 = await evaluate(TENANT_A, convId, triggerId);
  assert.equal(ev1.flowRunsStarted, 1);
  const runRow = await client.query<{ id: string; next_step_seq: number }>(
    `SELECT id, next_step_seq FROM flow_runs
     WHERE tenant_id=$1 AND trigger_message_id=$2`,
    [TENANT_A, triggerId],
  );
  const runId = runRow.rows[0].id;
  const step1 = await executeFlowStep(db, {
    tenantId: TENANT_A,
    runId,
    stepSeq: runRow.rows[0].next_step_seq,
  });
  assert.equal(step1.executed, true, JSON.stringify(step1));
  const parked = await client.query<{ status: string }>(
    `SELECT status FROM flow_runs WHERE id=$1`,
    [runId],
  );
  assert.equal(parked.rows[0].status, "waiting");

  // Balasan yang melanjutkan parkir SEKALIGUS cocok keyword automation:
  // resume berjalan (lapisan keselamatan) DAN keyword tetap menembak
  // (keputusan desain terdokumentasi: resume tidak menekan pemicu).
  const kwAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    kind: "keyword",
    name: "Keyword jawaban",
    keywords: ["jawaban"],
    match: "exact",
    text: "BALAS KEYWORD JAWABAN",
  });
  assert.equal(kwAuto.status, 201);
  const replyId = await seedInbound(convId, "jawaban");
  const ev2 = await evaluate(TENANT_A, convId, replyId);
  assert.ok(
    ev2.flowWaitReplyResumed >= 1,
    `parkir harus ter-resume: ${JSON.stringify(ev2)}`,
  );
  assert.equal(ev2.fired.length, 1);
  assert.equal(ev2.fired[0].automationId, kwAuto.body.id);
  await setAutomationActive(kwAuto.body.id!, false);
  await stopFlow(parkFlowId);

  // Consent: kata opt-out PERSIS yang juga cocok automation contains
  // → consent menang; automation tidak menembak; kontak opted_out.
  const stopAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    kind: "keyword",
    name: "Keyword stop contains",
    keywords: ["stop"],
    match: "contains",
    text: "JANGAN TERKIRIM",
  });
  assert.equal(stopAuto.status, 201);
  const cStop = await seedContact("Minta Berhenti");
  const vStop = await seedConversation(cStop);
  const mStop = await seedInbound(vStop, "stop");
  const rStop = await evaluate(TENANT_A, vStop, mStop);
  assert.equal(rStop.consentAction, "opt_out");
  assert.equal(rStop.fired.length, 0);
  assert.deepEqual(await outboundTexts(vStop), []);
  const contactRow = await client.query<{ opt_in_status: string }>(
    `SELECT opt_in_status FROM contacts WHERE id=$1`,
    [cStop],
  );
  assert.equal(contactRow.rows[0].opt_in_status, "opted_out");
  await setAutomationActive(stopAuto.body.id!, false);
  console.log(
    "[5] resume parkir tetap berjalan di atas keyword; consent mengalahkan automation: OK",
  );
}

// ---------- [7] Postback tak dikenal tidak jatuh ke agent ----------
{
  const contactId = await seedContact("Pengetuk Asing");
  const convId = await seedConversation(contactId);
  const msgId = await seedInbound(convId, "TOMBOL_ASING", {
    kind: "postback",
    payload: "TOMBOL_ASING",
    title: "Tombol Asing",
  });
  const result = await evaluate(TENANT_A, convId, msgId);
  assert.equal(result.evaluated, true);
  // Inilah bukti di level core untuk gerbang worker: pesan postback
  // selalu membawa triggerSignalKind='postback', dan worker menahan
  // agent.respond untuk nilai itu tanpa syarat lain.
  assert.equal(result.triggerSignalKind, "postback");
  assert.equal(result.fired.length, 0);
  assert.equal(result.flowRunsStarted, 0);
  console.log(
    "[7] postback tak dikenal: tercatat, triggerSignalKind='postback', tak ada tembakan: OK",
  );
}

// ---------- [8] Isolasi tenant ----------
{
  const aAuto = await call("POST", autoUrl(TENANT_A), USER_A, {
    triggerType: "postback",
    kind: "keyword",
    name: "Postback isolasi A",
    payloads: ["ISOLE"],
    text: "BALAS A",
  });
  assert.equal(aAuto.status, 201);

  // Pesan tenant B dengan payload yang sama: aturan A tak terlihat.
  const cB = await seedContact("Kontak B", TENANT_B);
  const vB = await seedConversation(cB, TENANT_B);
  const mB = await seedInbound(
    vB,
    "ISOLE",
    { kind: "postback", payload: "ISOLE", title: "ISOLE" },
    TENANT_B,
  );
  const rB = await evaluate(TENANT_B, vB, mB);
  assert.equal(rB.fired.length, 0, JSON.stringify(rB.fired));
  assert.deepEqual(await outboundTexts(vB, TENANT_B), []);

  // Daftar tenant B tidak memuat aturan A.
  const listB = await call("GET", autoUrl(TENANT_B), USER_B);
  assert.equal(listB.status, 200);
  assert.ok(
    !(listB.body.automations ?? []).some((a) => a.id === aAuto.body.id),
  );

  // Sanity: pesan yang sama di tenant A menembak aturan A.
  const cA = await seedContact("Kontak A", TENANT_A);
  const vA = await seedConversation(cA, TENANT_A);
  const mA = await seedInbound(vA, "ISOLE", {
    kind: "postback",
    payload: "ISOLE",
    title: "ISOLE",
  });
  const rA = await evaluate(TENANT_A, vA, mA);
  assert.equal(rA.fired.length, 1);
  assert.equal(rA.fired[0].automationId, aAuto.body.id);
  await setAutomationActive(aAuto.body.id!, false);
  console.log("[8] isolasi tenant untuk pemicu postback: OK");
}

console.log("verify:trigger-priority: SEMUA LULUS");
