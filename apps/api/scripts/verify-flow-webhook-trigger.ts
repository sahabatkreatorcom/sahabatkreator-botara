import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@sahabat-kreator/db";
import type { Database } from "@sahabat-kreator/db";
import {
  activateFlow,
  createFlow,
  deactivateFlow,
  executeFlowStep,
  getFlowWebhookEndpoint,
  type FlowGraph,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createFlowsRoutes } from "../src/modules/flows/routes";
import { createFlowWebhooksRoutes } from "../src/modules/flow-webhooks/routes";

/**
 * Verifikasi G17 butir 1 — PEMICU WEBHOOK MASUK.
 *
 * Bukti yang ditegakkan (tanpa jaringan):
 * A. Token disimpan HASH-ONLY: baris endpoint tidak memuat token
 *    terang; awalan tampil cocok; token salah/tidak ada/endpoint tak
 *    dikenal SEMUA 404 identik (keberadaan flow tidak bocor).
 * B. Payload sah memulai run: kontak diresolusi/dibuat dari phone,
 *    percakapan di akun trigger, payload utuh di konteks run, dan
 *    langkah http_request membuktikan {{payload:...}} dirender dari
 *    payload (fetch tiruan menangkap URL + body final); langkah
 *    send_message mengantre pesan "Halo {name}" untuk kontak itu.
 * C. Payload gagal validasi dasar (bukan objek / terlalu besar /
 *    tanpa pengenal kontak) → 400/422 dan TIDAK ada run baru.
 * D. Kontak opt-out → 200 ignored, tanpa run.
 * E. Rotasi: token lama 404 seketika, token baru bekerja; kontak yang
 *    sama dipakai ulang (bukan kontak ganda).
 * F. Flow tidak aktif → 409; endpoint tenant lain tidak terlihat.
 */

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "33333333-3333-4333-8333-333333333333";

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

// Seed tenant + pemilik + akun channel telegram tenant A.
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@example.com', 'Pemilik A'), ($2, 'b@example.com', 'Pemilik B')`,
  [USER_A, USER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
  [TENANT_A, USER_A, TENANT_B, USER_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status)
   VALUES ($1, $2, 'telegram', 'bot-a', 'Bot A', 'connected')`,
  [ACCOUNT_A, TENANT_A],
);

// Aplikasi: rute terautentikasi (dengan middleware uji) + rute publik.
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user");
  if (userId) {
    c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  }
  await next();
});
app.route("/", createFlowsRoutes({ db } as unknown as AuthBundle));
app.route("/", createFlowWebhooksRoutes({ db } as unknown as AuthBundle));

async function callJson(
  method: string,
  url: string,
  opts: { userId?: string; body?: unknown; rawBody?: string; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.userId) headers["x-test-user"] = opts.userId;
  if (opts.token) headers["x-flow-webhook-token"] = opts.token;
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers["content-type"] = "application/json";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const res = await app.request(url, { method, headers, body });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

async function runCount(flowId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM flow_runs WHERE flow_id = $1`,
    [flowId],
  );
  return Number(r.rows[0].n);
}

// Flow: trigger webhook → http_request (memakai {{payload:...}}) →
// send_message {name}. Endpoint diprovision SEBELUM aktivasi
// (aktivasi menolak webhook tanpa endpoint — kontrak G17).
const graph: FlowGraph = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      config: { kind: "webhook", channelAccountId: ACCOUNT_A },
    },
    {
      id: "hook",
      type: "http_request",
      config: {
        url: "https://contoh.invalid/hook/{{payload:order.id}}",
        method: "POST",
        headers: {},
        body: '{"total":{{payload:order.total}},"nama":"{{payload:name}}"}',
      },
    },
    { id: "sapa", type: "send_message", config: { text: "Halo {name}" } },
  ],
  edges: [
    { id: "e1", from: "trigger", to: "hook" },
    { id: "e2", from: "hook", to: "sapa" },
  ],
};
const created = await createFlow(db, {
  tenantId: TENANT_A,
  userId: USER_A,
  name: "Order masuk",
  graph,
});
const flowId = created.flow.id;

const rotate1 = await callJson(
  "POST",
  `/tenants/${TENANT_A}/flows/${flowId}/webhook-trigger/rotate`,
  { userId: USER_A },
);
assert.equal(rotate1.status, 200);
const token1 = rotate1.body.token as string;
const endpointId = rotate1.body.endpointId as string;
assert.ok(token1.startsWith("fwh_"), "token berawalan fwh_");
assert.equal(rotate1.body.tokenPrefix, token1.slice(0, 12));

// A. Hash-only: baris DB tidak memuat token terang di kolom mana pun.
{
  const rows = await client.query<Record<string, unknown>>(
    `SELECT * FROM flow_webhook_endpoints WHERE id = $1`,
    [endpointId],
  );
  assert.equal(rows.rows.length, 1);
  assert.ok(
    !JSON.stringify(rows.rows[0]).includes(token1),
    "token terang tidak boleh tersimpan di baris endpoint",
  );
  assert.match(String(rows.rows[0].token_hash), /^[0-9a-f]{64}$/);
}

// Aktivasi sekarang sah (endpoint ada).
const activated = await activateFlow(db, {
  tenantId: TENANT_A,
  flowId,
  userId: USER_A,
});
assert.equal(activated.kind, "activated");

const webhookUrl = `/webhooks/flow/${endpointId}`;

// A2. Penolakan seragam 404.
for (const attempt of [
  { token: "fwh_token-salah-total" },
  { token: undefined },
  {},
]) {
  const res = await callJson("POST", webhookUrl, {
    ...attempt,
    body: { phone: "0812000000" },
  });
  assert.equal(res.status, 404, `percobaan ${JSON.stringify(attempt)} → 404`);
  assert.equal(
    (res.body.error as { code?: string } | undefined)?.code,
    "NOT_FOUND",
  );
}
{
  const res = await callJson(
    "POST",
    "/webhooks/flow/99999999-9999-4999-8999-999999999999",
    { token: token1, body: { phone: "0812000000" } },
  );
  assert.equal(res.status, 404, "endpoint tak dikenal → 404 yang sama");
}
assert.equal(await runCount(flowId), 0, "penolakan tidak melahirkan run");

// C. Validasi dasar payload → 400/422 tanpa run.
{
  const arr = await callJson("POST", webhookUrl, {
    token: token1,
    rawBody: "[1,2,3]",
  });
  assert.equal(arr.status, 400, "payload array → 400");
  const big = await callJson("POST", webhookUrl, {
    token: token1,
    body: { phone: "0812000001", blob: "x".repeat(20_000) },
  });
  assert.equal(big.status, 400, "payload > 16KB → 400");
  const noId = await callJson("POST", webhookUrl, {
    token: token1,
    body: { order: { id: "X" } },
  });
  assert.equal(noId.status, 422, "tanpa pengenal kontak → 422");
  assert.equal(await runCount(flowId), 0, "payload gagal → tetap tanpa run");
}

// B. Payload sah → run + variabel payload terbukti di langkah HTTP.
const started = await callJson("POST", webhookUrl, {
  token: token1,
  body: {
    phone: "0812-3456-7890",
    name: "Budi",
    order: { id: "ORD-9", total: 75000 },
  },
});
assert.equal(started.status, 202);
const runId = started.body.runId as string;
assert.ok(runId);
{
  const run = await client.query<{
    contact_phone: string;
    contact_name: string;
    account_id: string;
    ctx: { webhook?: { payload: { order: { id: string } } } };
  }>(
    `SELECT c.phone AS contact_phone, c.name AS contact_name,
            cv.channel_account_id AS account_id, fr.context AS ctx
       FROM flow_runs fr
       JOIN contacts c ON c.id = fr.contact_id
       JOIN conversations cv ON cv.id = fr.conversation_id
      WHERE fr.id = $1`,
    [runId],
  );
  // Telepon tersimpan apa adanya seperti jalur buat-kontak lain di
  // repo (pencocokanlah yang menormalisasi, bukan penyimpanan).
  assert.equal(run.rows[0].contact_phone, "0812-3456-7890");
  assert.equal(run.rows[0].contact_name, "Budi");
  assert.equal(run.rows[0].account_id, ACCOUNT_A);
  assert.equal(run.rows[0].ctx.webhook?.payload.order.id, "ORD-9");
}

const fetched: { url: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
  fetched.push({ url: String(url), body: String(init?.body ?? "") });
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;
try {
  for (let i = 0; i < 8; i++) {
    const step = await executeFlowStep(db, { tenantId: TENANT_A, runId, stepSeq: i });
    if (step.status !== "running") break;
  }
} finally {
  globalThis.fetch = realFetch;
}
assert.equal(fetched.length, 1, "langkah HTTP menembak fetch tepat sekali");
assert.equal(fetched[0].url, "https://contoh.invalid/hook/ORD-9");
assert.ok(
  fetched[0].body.includes('"total":75000'),
  `body final memuat total payload: ${fetched[0].body}`,
);
assert.ok(fetched[0].body.includes('"nama":"Budi"'));
{
  const msgs = await client.query<{ content_text: string; status: string }>(
    `SELECT content_text, status FROM messages
      WHERE conversation_id = (SELECT conversation_id FROM flow_runs WHERE id = $1)
        AND direction = 'outbound'`,
    [runId],
  );
  assert.equal(msgs.rows.length, 1);
  assert.equal(msgs.rows[0].content_text, "Halo Budi");
  assert.equal(msgs.rows[0].status, "queued");
}

// D. Opt-out → 200 ignored tanpa run baru.
await client.query(
  `UPDATE contacts SET opt_in_status = 'opted_out' WHERE phone = '0812-3456-7890'`,
);
{
  const res = await callJson("POST", webhookUrl, {
    token: token1,
    body: { phone: "0812-3456-7890" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ignored");
  assert.equal(await runCount(flowId), 1, "opt-out tidak melahirkan run");
}
await client.query(
  `UPDATE contacts SET opt_in_status = 'unknown' WHERE phone = '0812-3456-7890'`,
);

// E. Rotasi: token lama mati seketika; token baru bekerja; kontak sama.
const rotate2 = await callJson(
  "POST",
  `/tenants/${TENANT_A}/flows/${flowId}/webhook-trigger/rotate`,
  { userId: USER_A },
);
const token2 = rotate2.body.token as string;
assert.notEqual(token2, token1);
{
  const old = await callJson("POST", webhookUrl, {
    token: token1,
    body: { phone: "0812-3456-7890" },
  });
  assert.equal(old.status, 404, "token lama ditolak sesudah rotasi");
  const fresh = await callJson("POST", webhookUrl, {
    token: token2,
    body: { phone: "+62 812 3456 7890" },
  });
  assert.equal(fresh.status, 202);
  const contacts = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM contacts WHERE tenant_id = $1 AND regexp_replace(phone, '\\D', '', 'g') IN ('6281234567890', '081234567890')`,
    [TENANT_A],
  );
  assert.equal(contacts.rows[0].n, "1", "kontak dipakai ulang, bukan ganda");
}

// F. Flow nonaktif → 409; isolasi tenant pada keadaan endpoint.
await deactivateFlow(db, { tenantId: TENANT_A, flowId, userId: USER_A });
{
  const res = await callJson("POST", webhookUrl, {
    token: token2,
    body: { phone: "0812-3456-7890" },
  });
  assert.equal(res.status, 409);
  assert.equal(
    (res.body.error as { code?: string } | undefined)?.code,
    "FLOW_NOT_ACTIVE",
  );
  const other = await getFlowWebhookEndpoint(db, TENANT_B, flowId);
  assert.equal(other, null, "endpoint tenant A tak terlihat dari tenant B");
}

console.log(
  "verify-flow-webhook-trigger: SEMUA LULUS — hash-only + 404 seragam, payload→run+{{payload:}} terbukti, validasi 400/422 tanpa run, opt-out 200, rotasi seketika, 409 nonaktif, isolasi tenant.",
);
