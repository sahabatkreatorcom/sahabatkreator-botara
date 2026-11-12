/**
 * Verifikasi Gelombang G18 butir 4 — GAMIFIKASI (poin + level +
 * papan peringkat), di atas PGlite. Dijalankan di CI sebagai
 * bagian `verify:ci`.
 *
 * Membuktikan:
 *   [1] Level loyalitas: CRUD via API (owner), ambang ganda → 409,
 *       peran member → 403.
 *   [2] Node flow award_points memberi poin ke buku besar; saldo
 *       kontak = SUM buku besar; level terhitung dari ambang.
 *   [3] Idempotensi: pemberian dengan run+node yang sama TIDAK
 *       menggandakan (already_awarded); node berbeda memberi lagi.
 *   [4] Penyesuaian manual ± oleh owner bekerja + TERAUDIT
 *       (contact.points_adjusted); saldo bisa dikoreksi negatif
 *       dan level turun jujur.
 *   [5] Papan peringkat dihitung dari buku besar: urutan saldo,
 *       level menempel, saldo <= 0 tidak tampil.
 *   [6] Isolasi tenant: peringkat & level tenant lain kosong.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:gamification
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  activateFlow,
  awardFlowPointsTx,
  createFlow,
  executeFlowStep,
  startFlowRunsForInboundMessage,
  type FlowGraph,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createContactsRoutes } from "../src/modules/contacts/routes";

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
const TENANT_B = "11111111-1111-4111-8111-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ACCOUNT = "33000000-0000-4000-8000-0000000000a1";
const CONTACT_A = "22000000-0000-4000-8000-0000000000a1";
const CONTACT_B = "22000000-0000-4000-8000-0000000000b1";

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug, default_locale) VALUES ($1, 'Tenant A', 'tenant-a', 'id'), ($2, 'Tenant B', 'tenant-b', 'en')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'owner@sk.test', 'Pemilik'), ($2, 'member@sk.test', 'Anggota'), ($3, 'ownerb@sk.test', 'Pemilik B')`,
  [OWNER, MEMBER, OWNER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'agent'), ($5, $6, 'owner')`,
  [TENANT, OWNER, TENANT, MEMBER, TENANT_B, OWNER_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status) VALUES ($1, $2, 'telegram', 'bot-1', 'Bot', 'connected')`,
  [ACCOUNT, TENANT],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Sari'), ($3, $2, 'Budi')`,
  [CONTACT_A, TENANT, CONTACT_B],
);
const convA = await client.query<{ id: string }>(
  `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
   VALUES ($1, $2, $3, 'telegram', 'chat-a', 'private', 'open') RETURNING id`,
  [TENANT, ACCOUNT, CONTACT_A],
);
const CONV_A = convA.rows[0]!.id;

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? OWNER;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createContactsRoutes(bundle));

async function call(
  method: string,
  url: string,
  user = OWNER,
  body?: unknown,
): Promise<{ status: number; body: never }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": user,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as never };
}

const base = `/tenants/${TENANT}/contacts`;
interface PointsView {
  balance: number;
  levelName: string | null;
  nextLevel: { name: string; pointsNeeded: number } | null;
}

// --- [1] level ----------------------------------------------------------------
for (const [name, minPoints] of [
  ["Bronze", 0],
  ["Silver", 100],
  ["Gold", 500],
] as const) {
  const res = await call("POST", `${base}/loyalty-levels`, OWNER, {
    name,
    minPoints,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}
{
  const dup = await call("POST", `${base}/loyalty-levels`, OWNER, {
    name: "Platinum",
    minPoints: 100,
  });
  assert.equal(dup.status, 409);
  const forbidden = await call("POST", `${base}/loyalty-levels`, MEMBER, {
    name: "Platinum",
    minPoints: 1000,
  });
  assert.equal(forbidden.status, 403);
  const list = await call("GET", `${base}/loyalty-levels`, MEMBER);
  assert.equal(
    (list.body as unknown as { levels: unknown[] }).levels.length,
    3,
  );
}
console.log("[1] level loyalitas: CRUD + ambang ganda 409 + peran 403: OK");

// --- [2] pemberian dari flow ------------------------------------------------------
const graph: FlowGraph = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      config: { kind: "keyword", keywords: ["POIN"], match: "exact" },
    },
    {
      id: "beri",
      type: "award_points",
      config: { points: 120, label: "Bonus selamat datang" },
    },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "beri" },
    { id: "e2", from: "beri", to: "end" },
  ],
};
const flow = await createFlow(db, {
  tenantId: TENANT,
  userId: OWNER,
  name: "Beri poin",
  graph,
});
assert.equal(
  (await activateFlow(db, { tenantId: TENANT, flowId: flow.flow.id, userId: OWNER })).kind,
  "activated",
);
const runInfo = await (async () => {
  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, CONV_A));
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, CONTACT_A));
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', 'POIN', 'received') RETURNING id`,
    [TENANT, CONV_A],
  );
  await startFlowRunsForInboundMessage(db, {
    tenantId: TENANT,
    conversationId: CONV_A,
    messageId: msg.rows[0]!.id,
    messageText: "POIN",
    contact: contact!,
    conversation: conversation!,
    triggerSignal: null,
  });
  const r = await client.query<{ id: string }>(
    `SELECT id FROM flow_runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [CONV_A],
  );
  const runId = r.rows[0]!.id;
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
  return { runId };
})();
{
  const view = await call("GET", `${base}/${CONTACT_A}/points`);
  const v = view.body as unknown as PointsView;
  assert.equal(v.balance, 120);
  assert.equal(v.levelName, "Silver");
  assert.deepEqual(v.nextLevel, { name: "Gold", pointsNeeded: 380 });
}
console.log("[2] node award_points: saldo 120 dari buku besar, level Silver: OK");

// --- [3] idempotensi ------------------------------------------------------------------
{
  const again = await db.transaction(async (tx) =>
    awardFlowPointsTx(tx as never, {
      tenantId: TENANT,
      contactId: CONTACT_A,
      runId: runInfo.runId,
      nodeId: "beri",
      points: 120,
    }),
  );
  assert.equal(again.kind, "already_awarded");
  assert.equal(again.balance, 120);
  const otherNode = await db.transaction(async (tx) =>
    awardFlowPointsTx(tx as never, {
      tenantId: TENANT,
      contactId: CONTACT_A,
      runId: runInfo.runId,
      nodeId: "beri-lain",
      points: 30,
    }),
  );
  assert.equal(otherNode.kind, "awarded");
  assert.equal(otherNode.balance, 150);
  const ledger = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM contact_point_ledger WHERE contact_id = $1`,
    [CONTACT_A],
  );
  assert.equal(ledger.rows[0]!.n, "2");
}
console.log("[3] idempotensi per run+node: tidak berlipat, node lain sah: OK");

// --- [4] penyesuaian manual + audit -------------------------------------------------------
{
  const plus = await call("POST", `${base}/${CONTACT_B}/points/adjust`, OWNER, {
    points: 600,
    note: "Kompensasi manual",
  });
  assert.equal(plus.status, 200, JSON.stringify(plus.body));
  assert.equal((plus.body as unknown as PointsView).balance, 600);
  assert.equal((plus.body as unknown as PointsView).levelName, "Gold");

  const memberAdjust = await call(
    "POST",
    `${base}/${CONTACT_B}/points/adjust`,
    MEMBER,
    { points: 5 },
  );
  assert.equal(memberAdjust.status, 403);

  const minus = await call("POST", `${base}/${CONTACT_A}/points/adjust`, OWNER, {
    points: -200,
  });
  assert.equal((minus.body as unknown as PointsView).balance, -50);
  assert.equal((minus.body as unknown as PointsView).levelName, null);
  assert.deepEqual((minus.body as unknown as PointsView).nextLevel, {
    name: "Bronze",
    pointsNeeded: 50,
  });

  const audits = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'contact.points_adjusted'`,
    [TENANT],
  );
  assert.equal(audits.rows[0]!.n, "2");
}
console.log("[4] penyesuaian manual ± + gerbang peran + audit: OK");

// --- [5] papan peringkat ---------------------------------------------------------------------
{
  const board = await call("GET", `${base}/leaderboard`);
  const entries = (
    board.body as unknown as {
      entries: Array<{ contactId: string; balance: number; levelName: string | null }>;
    }
  ).entries;
  assert.deepEqual(entries, [
    { contactId: CONTACT_B, contactName: "Budi", balance: 600, levelName: "Gold" },
  ]);
}
console.log("[5] papan peringkat dari buku besar (saldo <= 0 tersembunyi): OK");

// --- [6] isolasi tenant -------------------------------------------------------------------------
{
  const boardB = await call(
    "GET",
    `/tenants/${TENANT_B}/contacts/leaderboard`,
    OWNER_B,
  );
  assert.deepEqual(
    (boardB.body as unknown as { entries: unknown[] }).entries,
    [],
  );
  const levelsB = await call(
    "GET",
    `/tenants/${TENANT_B}/contacts/loyalty-levels`,
    OWNER_B,
  );
  assert.deepEqual(
    (levelsB.body as unknown as { levels: unknown[] }).levels,
    [],
  );
}
console.log("[6] isolasi tenant peringkat & level: OK");

console.log("verify-gamification: SEMUA LULUS");
process.exit(0);
