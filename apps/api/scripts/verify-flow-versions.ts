/**
 * Verifikasi Gelombang G3 — VERSIONING FLOW — di atas PGlite +
 * seluruh migrasi + aplikasi Hono dengan AuthBundle tiruan (pola
 * verify-sequence-enroll) + service core sungguhan untuk eksekusi run.
 *
 * Membuktikan:
 *   [1] aktivasi menulis snapshot bernomor: POST activate → version 1;
 *       GET versions memuat v1 (isCurrent, ringkasan node/edge);
 *       nonaktifkan → edit → aktifkan → version 2; baris v1 di DB
 *       TIDAK berubah (snapshot immutable);
 *   [2] run mem-pin versi & kebal suntingan live: run dimulai di v1,
 *       parkir di node delay; flow diganti ke v2; resume run mengirim
 *       teks V1 (dari snapshot), bukan teks live v2;
 *   [3] run terparkir wait_reply melanjutkan snapshot-nya lewat jalur
 *       resume evaluasi: balasan kontak sesudah flow berganti ke v2
 *       tetap menjalankan cabang v1;
 *   [4] restore melahirkan versi BARU: pulihkan v1 → v3
 *       (restoredFromVersion=1), flow aktif bergraf v1, baris v1/v2
 *       utuh (append-only), audit flow.version_restored tercatat;
 *   [5] restore menolak draft kotor (409 FLOW_RESTORE_DIRTY_DRAFT),
 *       menolak flow arsip (409 FLOW_INVALID_STATE), versi tak ada
 *       → 404; draft bersih (baru dinonaktifkan) boleh restore;
 *   [6] isolasi tenant: flow tenant A tak terlihat dari tenant B
 *       (404), non-member → 404 TENANT_NOT_FOUND, member biasa
 *       (bukan owner/admin) restore → 403;
 *   [7] run warisan tanpa pin membaca graf LIVE secara jujur: flow
 *       aktif tanpa baris versi (dibuat langsung di DB) memulai run
 *       ber-pin NULL, dan run warisan yang disuntik manual mengikuti
 *       graf live yang berubah — bukan snapshot karangan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:flow-versions
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
  updateFlow,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
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
const USER_MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ACCOUNT_A = "55555555-5555-4555-8555-555555555555";
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A'), ($2, 'b@sk.test', 'Pemilik B'), ($3, 'member@sk.test', 'Member A'), ($4, 'luar@sk.test', 'Orang Luar')`,
  [USER_A, USER_B, USER_MEMBER, USER_OUTSIDER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'viewer')`,
  [TENANT_A, USER_A, TENANT_B, USER_B, USER_MEMBER],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'webchat', 'wc_uji_versi', 'connected')`,
  [ACCOUNT_A, TENANT_A],
);

// ---------------------------------------------------------------------------
// Aplikasi uji: modul flows sungguhan + appUser dari header uji.
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? USER_A;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
app.route("/", createFlowsRoutes({ db } as unknown as AuthBundle));

interface GraphShape {
  nodes: { id: string; type: string; config: Record<string, unknown> }[];
  edges: { from: string; to: string; branch?: string }[];
}
interface VersionBody {
  id: string;
  version: number;
  name: string;
  nodeCount: number;
  edgeCount: number;
  restoredFromVersion: number | null;
  activatedByUserId: string | null;
  isCurrent: boolean;
  createdAt: string;
}
interface AnyBody {
  id?: string;
  status?: string;
  graph?: GraphShape;
  version?: number;
  versions?: VersionBody[];
  flow?: { id: string; status: string; graph: GraphShape };
  warnings?: unknown[];
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

const flowUrl = (tenantId: string) => `/tenants/${tenantId}/flows`;

// ---------------------------------------------------------------------------
// Pembantu seed & baca langsung (pola verify-sequence-enroll).
// ---------------------------------------------------------------------------
async function seedContact(name: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name, opt_in_status) VALUES ($1, $2, 'unknown') RETURNING id`,
    [TENANT_A, name],
  );
  return r.rows[0].id;
}

async function seedConversation(contactId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, kind, title)
     VALUES ($1, $2, $3, 'webchat', 'private', NULL) RETURNING id`,
    [TENANT_A, ACCOUNT_A, contactId],
  );
  return r.rows[0].id;
}

async function seedInbound(conversationId: string, text: string) {
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received') RETURNING id`,
    [TENANT_A, conversationId, text],
  );
  return msg.rows[0].id;
}

async function outboundTexts(conversationId: string): Promise<string[]> {
  const r = await client.query<{ content_text: string }>(
    `SELECT content_text FROM messages
     WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'
     ORDER BY created_at, id`,
    [TENANT_A, conversationId],
  );
  return r.rows.map((x) => x.content_text);
}

async function versionRows(flowId: string) {
  const r = await client.query<{
    version: number;
    graph: GraphShape;
    restored_from_version: number | null;
  }>(
    `SELECT version, graph, restored_from_version FROM flow_versions
     WHERE tenant_id=$1 AND flow_id=$2 ORDER BY version`,
    [TENANT_A, flowId],
  );
  return r.rows;
}

function sendTexts(graph: GraphShape): string[] {
  return graph.nodes
    .filter((n) => n.type === "send_message")
    .map((n) => String(n.config.text ?? ""));
}

/** Graf lurus: trigger keyword → pesan A → delay → pesan B. */
function delayGraph(keyword: string, textA: string, textB: string) {
  return {
    nodes: [
      {
        id: "t",
        type: "trigger",
        config: { kind: "keyword", keywords: [keyword], match: "exact" },
      },
      { id: "a", type: "send_message", config: { text: textA } },
      { id: "d", type: "delay", config: { amount: 5, unit: "minutes" } },
      { id: "b", type: "send_message", config: { text: textB } },
    ],
    edges: [
      { from: "t", to: "a" },
      { from: "a", to: "d" },
      { from: "d", to: "b" },
    ],
  };
}

// ---------- [1] Aktivasi menulis snapshot bernomor; snapshot immutable ----------
let flowId = "";
{
  const graph1 = delayGraph("halo", "A versi satu", "B versi satu");
  const created = await call("POST", flowUrl(TENANT_A), USER_A, {
    name: "Flow Versi",
    graph: graph1,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  flowId = created.body.id!;
  assert.equal(created.body.status, "draft");

  const empty = await call(
    "GET",
    `${flowUrl(TENANT_A)}/${flowId}/versions`,
    USER_A,
  );
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.versions, []);

  const act1 = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/activate`,
    USER_A,
    {},
  );
  assert.equal(act1.status, 200, JSON.stringify(act1.body));
  assert.equal(act1.body.version, 1);

  const list1 = await call(
    "GET",
    `${flowUrl(TENANT_A)}/${flowId}/versions`,
    USER_A,
  );
  assert.equal(list1.body.versions!.length, 1);
  assert.equal(list1.body.versions![0].version, 1);
  assert.equal(list1.body.versions![0].isCurrent, true);
  assert.equal(list1.body.versions![0].nodeCount, 4);
  assert.equal(list1.body.versions![0].edgeCount, 3);
  assert.equal(list1.body.versions![0].restoredFromVersion, null);
  assert.equal(list1.body.versions![0].activatedByUserId, USER_A);

  // Nonaktifkan → edit teks → aktifkan: lahir v2, v1 utuh.
  const deact = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/deactivate`,
    USER_A,
    {},
  );
  assert.equal(deact.status, 200);
  const graph2 = delayGraph("halo", "A versi dua", "B versi dua");
  const patched = await call(
    "PATCH",
    `${flowUrl(TENANT_A)}/${flowId}`,
    USER_A,
    { graph: graph2 },
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const act2 = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/activate`,
    USER_A,
    {},
  );
  assert.equal(act2.status, 200);
  assert.equal(act2.body.version, 2);

  const rows = await versionRows(flowId);
  assert.equal(rows.length, 2);
  assert.deepEqual(sendTexts(rows[0].graph), ["A versi satu", "B versi satu"]);
  assert.deepEqual(sendTexts(rows[1].graph), ["A versi dua", "B versi dua"]);
  const list2 = await call(
    "GET",
    `${flowUrl(TENANT_A)}/${flowId}/versions`,
    USER_A,
  );
  assert.equal(list2.body.versions![0].version, 2);
  assert.equal(list2.body.versions![0].isCurrent, true);
  assert.equal(list2.body.versions![1].isCurrent, false);
  console.log(
    "[1] aktivasi → snapshot v1 lalu v2 bernomor; baris v1 tidak berubah: OK",
  );
}

// ---------- [2] Run mem-pin versi & kebal suntingan live ----------
{
  const created = await createFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    name: "Flow Pin",
    graph: delayGraph("mulai", "PIN-A v1", "PIN-B v1") as never,
  });
  assert.equal(created.kind, "created");
  const pinFlowId = created.flow.id;
  const act = await activateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId: pinFlowId,
  });
  assert.equal(act.kind, "activated");
  if (act.kind === "activated") assert.equal(act.version, 1);

  const contactId = await seedContact("Pina Pin");
  const convId = await seedConversation(contactId);
  const triggerId = await seedInbound(convId, "mulai");
  const evaluated = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT_A,
    conversationId: convId,
    messageId: triggerId,
  });
  assert.equal(evaluated.flowRunsStarted, 1);
  const runRow = await client.query<{
    id: string;
    flow_version: number | null;
    flow_version_id: string | null;
    next_step_seq: number;
    status: string;
  }>(
    `SELECT id, flow_version, flow_version_id, next_step_seq, status FROM flow_runs
     WHERE tenant_id=$1 AND trigger_message_id=$2`,
    [TENANT_A, triggerId],
  );
  const run = runRow.rows[0];
  assert.equal(run.flow_version, 1);
  assert.ok(run.flow_version_id, "run harus ter-pin ke baris versi");

  // Eksekusi sampai parkir di delay.
  const step1 = await executeFlowStep(db, {
    tenantId: TENANT_A,
    runId: run.id,
    stepSeq: run.next_step_seq,
  });
  assert.equal(step1.executed, true, JSON.stringify(step1));
  const parked = await client.query<{
    status: string;
    next_step_seq: number;
  }>(
    `SELECT status, next_step_seq FROM flow_runs WHERE id=$1`,
    [run.id],
  );
  assert.equal(parked.rows[0].status, "waiting");
  assert.deepEqual(await outboundTexts(convId), ["PIN-A v1"]);

  // Flow diganti total ke v2 SELAGI run parkir.
  const deact = await deactivateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId: pinFlowId,
  });
  assert.equal(deact.kind, "ok");
  const upd = await updateFlow(db, {
    tenantId: TENANT_A,
    flowId: pinFlowId,
    userId: USER_A,
    patch: { graph: delayGraph("mulai", "PIN-A v2", "PIN-B v2") as never },
  });
  assert.equal(upd.kind, "updated");
  const act2 = await activateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId: pinFlowId,
  });
  assert.equal(act2.kind, "activated");
  if (act2.kind === "activated") assert.equal(act2.version, 2);

  // Resume run (job delay jatuh tempo): harus mengirim teks V1.
  const step2 = await executeFlowStep(db, {
    tenantId: TENANT_A,
    runId: run.id,
    stepSeq: parked.rows[0].next_step_seq,
  });
  assert.equal(step2.executed, true, JSON.stringify(step2));
  assert.equal(step2.status, "completed");
  assert.deepEqual(await outboundTexts(convId), ["PIN-A v1", "PIN-B v1"]);
  console.log(
    "[2] run ter-pin v1: sesudah flow jadi v2, resume tetap mengirim teks v1: OK",
  );
}

// ---------- [3] Run terparkir wait_reply melanjutkan snapshot-nya ----------
{
  const waitGraph = (label: string) => ({
    nodes: [
      {
        id: "t",
        type: "trigger",
        config: { kind: "keyword", keywords: ["tanya"], match: "exact" },
      },
      { id: "q", type: "send_message", config: { text: `PERTANYAAN ${label}` } },
      { id: "w", type: "wait_reply", config: { amount: 30, unit: "minutes" } },
      { id: "s", type: "send_message", config: { text: `LANJUT ${label}` } },
      { id: "e", type: "end", config: {} },
    ],
    edges: [
      { from: "t", to: "q" },
      { from: "q", to: "w" },
      { from: "w", to: "s", branch: "replied" },
      { from: "w", to: "e", branch: "timeout" },
    ],
  });
  const created = await createFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    name: "Flow Parkir",
    graph: waitGraph("v1") as never,
  });
  assert.equal(created.kind, "created");
  const parkFlowId = created.flow.id;
  const act = await activateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId: parkFlowId,
  });
  assert.equal(act.kind, "activated");

  const contactId = await seedContact("Parker Parkir");
  const convId = await seedConversation(contactId);
  const triggerId = await seedInbound(convId, "tanya");
  const evaluated = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT_A,
    conversationId: convId,
    messageId: triggerId,
  });
  assert.equal(evaluated.flowRunsStarted, 1);
  const runRow = await client.query<{
    id: string;
    next_step_seq: number;
    flow_version: number | null;
  }>(
    `SELECT id, next_step_seq, flow_version FROM flow_runs
     WHERE tenant_id=$1 AND trigger_message_id=$2`,
    [TENANT_A, triggerId],
  );
  const runId = runRow.rows[0].id;
  assert.equal(runRow.rows[0].flow_version, 1);
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
  assert.deepEqual(await outboundTexts(convId), ["PERTANYAAN v1"]);

  // Flow berganti ke v2 selama run parkir menunggu balasan.
  await deactivateFlow(db, { tenantId: TENANT_A, userId: USER_A, flowId: parkFlowId });
  await updateFlow(db, {
    tenantId: TENANT_A,
    flowId: parkFlowId,
    userId: USER_A,
    patch: { graph: waitGraph("v2") as never },
  });
  const act2 = await activateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId: parkFlowId,
  });
  assert.equal(act2.kind, "activated");

  // Balasan kontak tiba → jalur resume evaluasi memproses parkir.
  const replyId = await seedInbound(convId, "jawaban saya");
  const evaluated2 = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT_A,
    conversationId: convId,
    messageId: replyId,
  });
  assert.ok(
    evaluated2.flowWaitReplyResumed >= 1,
    `parkir harus ter-resume: ${JSON.stringify(evaluated2)}`,
  );
  const resumed = await client.query<{
    status: string;
    next_step_seq: number;
  }>(`SELECT status, next_step_seq FROM flow_runs WHERE id=$1`, [runId]);
  assert.equal(resumed.rows[0].status, "running");
  const step2 = await executeFlowStep(db, {
    tenantId: TENANT_A,
    runId,
    stepSeq: resumed.rows[0].next_step_seq,
  });
  assert.equal(step2.executed, true, JSON.stringify(step2));
  assert.equal(step2.status, "completed");
  assert.deepEqual(await outboundTexts(convId), [
    "PERTANYAAN v1",
    "LANJUT v1",
  ]);
  console.log(
    "[3] run parkir wait_reply: balasan sesudah flow jadi v2 tetap menjalankan cabang v1: OK",
  );
}

// ---------- [4] Restore melahirkan versi BARU (append-only) ----------
{
  const res = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/versions/1/restore`,
    USER_A,
    {},
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.version!.version, 3);
  assert.equal(res.body.version!.restoredFromVersion, 1);
  assert.equal(res.body.version!.isCurrent, true);
  assert.equal(res.body.flow!.status, "active");
  assert.deepEqual(sendTexts(res.body.flow!.graph), [
    "A versi satu",
    "B versi satu",
  ]);

  const rows = await versionRows(flowId);
  assert.equal(rows.length, 3);
  assert.deepEqual(sendTexts(rows[0].graph), ["A versi satu", "B versi satu"]);
  assert.deepEqual(sendTexts(rows[1].graph), ["A versi dua", "B versi dua"]);
  assert.deepEqual(sendTexts(rows[2].graph), ["A versi satu", "B versi satu"]);
  assert.equal(rows[2].restored_from_version, 1);

  const audit = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs
     WHERE tenant_id=$1 AND action='flow.version_restored' AND meta->>'flowId'=$2`,
    [TENANT_A, flowId],
  );
  assert.equal(Number(audit.rows[0].n), 1);

  // Restore versi yang sama lagi → versi lanjut baru (bukan menimpa).
  const res2 = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/versions/1/restore`,
    USER_A,
    {},
  );
  assert.equal(res2.status, 200);
  assert.equal(res2.body.version!.version, 4);
  console.log(
    "[4] restore v1 → v3 (lalu v4), graf live = isi v1, sejarah v1/v2 utuh: OK",
  );
}

// ---------- [5] Restore menolak draft kotor & flow arsip; draft bersih boleh ----------
{
  // Draft bersih: nonaktifkan (graf == versi terbaru) → restore sah.
  const deact = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/deactivate`,
    USER_A,
    {},
  );
  assert.equal(deact.status, 200);
  const clean = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/versions/2/restore`,
    USER_A,
    {},
  );
  assert.equal(clean.status, 200, JSON.stringify(clean.body));
  assert.equal(clean.body.version!.version, 5);
  assert.equal(clean.body.version!.restoredFromVersion, 2);

  // Draft kotor: nonaktifkan → sunting → restore ditolak 409.
  await call("POST", `${flowUrl(TENANT_A)}/${flowId}/deactivate`, USER_A, {});
  const dirtyGraph = delayGraph("halo", "A suntingan", "B suntingan");
  const patched = await call(
    "PATCH",
    `${flowUrl(TENANT_A)}/${flowId}`,
    USER_A,
    { graph: dirtyGraph },
  );
  assert.equal(patched.status, 200);
  const dirty = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/versions/1/restore`,
    USER_A,
    {},
  );
  assert.equal(dirty.status, 409, JSON.stringify(dirty.body));
  assert.equal(dirty.body.error!.code, "FLOW_RESTORE_DIRTY_DRAFT");
  // Draft kotor TIDAK tertimpa: graf tersimpan masih suntingan.
  const detail = await call("GET", `${flowUrl(TENANT_A)}/${flowId}`, USER_A);
  assert.deepEqual(sendTexts(detail.body.graph!), [
    "A suntingan",
    "B suntingan",
  ]);

  // Aktifkan draft (tersimpan sebagai versi) → restore bekerja lagi.
  const act = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/activate`,
    USER_A,
    {},
  );
  assert.equal(act.status, 200);
  assert.equal(act.body.version, 6);
  const ok = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/versions/1/restore`,
    USER_A,
    {},
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version!.version, 7);

  // Versi tak ada → 404. Flow arsip → 409 FLOW_INVALID_STATE.
  const missing = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/versions/999/restore`,
    USER_A,
    {},
  );
  assert.equal(missing.status, 404);
  const arch = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/archive`,
    USER_A,
    {},
  );
  assert.equal(arch.status, 200);
  const archived = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/versions/1/restore`,
    USER_A,
    {},
  );
  assert.equal(archived.status, 409);
  assert.equal(archived.body.error!.code, "FLOW_INVALID_STATE");
  await call("POST", `${flowUrl(TENANT_A)}/${flowId}/unarchive`, USER_A, {});
  console.log(
    "[5] draft kotor → 409 tanpa menimpa; draft bersih boleh; arsip → 409; versi tak ada → 404: OK",
  );
}

// ---------- [6] Isolasi tenant ----------
{
  const asB = await call(
    "GET",
    `${flowUrl(TENANT_B)}/${flowId}/versions`,
    USER_B,
  );
  assert.equal(asB.status, 404);
  const restoreAsB = await call(
    "POST",
    `${flowUrl(TENANT_B)}/${flowId}/versions/1/restore`,
    USER_B,
    {},
  );
  assert.equal(restoreAsB.status, 404);
  const outsider = await call(
    "GET",
    `${flowUrl(TENANT_A)}/${flowId}/versions`,
    USER_OUTSIDER,
  );
  assert.equal(outsider.status, 404);
  assert.equal(outsider.body.error!.code, "TENANT_NOT_FOUND");
  const member = await call(
    "POST",
    `${flowUrl(TENANT_A)}/${flowId}/versions/1/restore`,
    USER_MEMBER,
    {},
  );
  assert.equal(member.status, 403);
  // Member biasa tetap BOLEH membaca riwayat.
  const memberRead = await call(
    "GET",
    `${flowUrl(TENANT_A)}/${flowId}/versions`,
    USER_MEMBER,
  );
  assert.equal(memberRead.status, 200);
  assert.equal(memberRead.body.versions!.length, 7);
  console.log(
    "[6] isolasi tenant: lintas tenant 404, non-member 404, member restore 403 tapi baca 200: OK",
  );
}

// ---------- [7] Run warisan tanpa pin membaca graf live ----------
{
  // Flow aktif dibuat langsung di DB (meniru keadaan pra-G3): tanpa
  // baris versi sama sekali.
  const legacyGraph = delayGraph("warisan", "WARISAN-A live", "WARISAN-B live");
  const flowRow = await client.query<{ id: string }>(
    `INSERT INTO flows (tenant_id, name, status, graph, created_by_user_id)
     VALUES ($1, 'Flow Warisan', 'active', $2, $3) RETURNING id`,
    [TENANT_A, JSON.stringify(legacyGraph), USER_A],
  );
  const legacyFlowId = flowRow.rows[0].id;
  assert.equal((await versionRows(legacyFlowId)).length, 0);

  const contactId = await seedContact("Waris Warisan");
  const convId = await seedConversation(contactId);
  const triggerId = await seedInbound(convId, "warisan");
  const evaluated = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT_A,
    conversationId: convId,
    messageId: triggerId,
  });
  assert.equal(evaluated.flowRunsStarted, 1);
  const runRow = await client.query<{
    id: string;
    flow_version: number | null;
    flow_version_id: string | null;
    next_step_seq: number;
  }>(
    `SELECT id, flow_version, flow_version_id, next_step_seq FROM flow_runs
     WHERE tenant_id=$1 AND trigger_message_id=$2`,
    [TENANT_A, triggerId],
  );
  // Pin tetap NULL secara jujur — tidak ada snapshot yang dikarang.
  assert.equal(runRow.rows[0].flow_version, null);
  assert.equal(runRow.rows[0].flow_version_id, null);

  const step1 = await executeFlowStep(db, {
    tenantId: TENANT_A,
    runId: runRow.rows[0].id,
    stepSeq: runRow.rows[0].next_step_seq,
  });
  assert.equal(step1.executed, true, JSON.stringify(step1));
  assert.deepEqual(await outboundTexts(convId), ["WARISAN-A live"]);

  // Graf live berubah di tengah jalan (suntingan langsung di DB,
  // meniru risiko pra-G3): run warisan MENGIKUTI graf live — inilah
  // fallback yang terdokumentasi, berbeda dari run ter-pin di [2].
  const parked = await client.query<{ next_step_seq: number }>(
    `SELECT next_step_seq FROM flow_runs WHERE id=$1`,
    [runRow.rows[0].id],
  );
  const changedGraph = delayGraph("warisan", "WARISAN-A live", "WARISAN-B LIVE BARU");
  await client.query(`UPDATE flows SET graph=$2 WHERE id=$1`, [
    legacyFlowId,
    JSON.stringify(changedGraph),
  ]);
  const step2 = await executeFlowStep(db, {
    tenantId: TENANT_A,
    runId: runRow.rows[0].id,
    stepSeq: parked.rows[0].next_step_seq,
  });
  assert.equal(step2.executed, true, JSON.stringify(step2));
  assert.deepEqual(await outboundTexts(convId), [
    "WARISAN-A live",
    "WARISAN-B LIVE BARU",
  ]);
  console.log(
    "[7] run warisan: pin NULL, eksekusi mengikuti graf live (fallback jujur): OK",
  );
}

console.log("verify:flow-versions — SEMUA LULUS");
