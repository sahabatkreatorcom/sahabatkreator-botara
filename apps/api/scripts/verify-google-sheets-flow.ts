import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@sahabat-kreator/db";
import type { Database } from "@sahabat-kreator/db";
import {
  activateFlow,
  createFlow,
  executeFlowStep,
  provisionFlowWebhookEndpoint,
  resolveFlowWebhookEndpoint,
  saveGoogleServiceConnection,
  startFlowWebhookRun,
  type FlowGraph,
} from "@sahabat-kreator/core";

/**
 * Verifikasi G17 butir 2 — LANGKAH GOOGLE SHEETS (node append_sheet_row).
 *
 * Bukti yang ditegakkan (fetch diganti stub; tanpa jaringan):
 * A. Layanan 'sheets' adalah layanan per-layanan sendiri: koneksi
 *    disimpan via mesin google_connections layanan sheets, token
 *    diambil dari koneksi ITU (header Authorization = token koneksi
 *    sheets), dan panggilan append membawa baris hasil render templat
 *    mesin ({name} + {{field:}} + {{payload:}} dari run webhook)
 *    persis ke URL Sheets API dengan range tab yang benar.
 * B. Hasil langkah tercatat `appended` + updatedRange dari respons,
 *    dan run berlanjut sampai selesai (pesan penutup terantre).
 * C. Tenant TANPA koneksi sheets: langkah tercatat
 *    `sheet_error`/`sheets_not_connected` dan run TETAP selesai —
 *    kegagalan eksternal tidak membatalkan flow.
 * D. HTTP error dari Google (404 spreadsheet tidak ada): langkah
 *    tercatat `sheet_error`/`sheets_http_404`, run tetap lanjut.
 */

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_B = "44444444-4444-4444-8444-444444444444";
const TOKEN_SECRET = Buffer.alloc(32, 7).toString("base64");
const SHEETS_ACCESS_TOKEN = "token-uji-sheets-rahasia";

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
   VALUES ($1, $2, 'telegram', 'bot-a', 'Bot A', 'connected'),
          ($3, $4, 'telegram', 'bot-b', 'Bot B', 'connected')`,
  [ACCOUNT_A, TENANT_A, ACCOUNT_B, TENANT_B],
);

// Koneksi Sheets tenant A lewat mesin per-layanan (token terenkripsi).
await saveGoogleServiceConnection(db, TENANT_A, "sheets", {
  tokens: {
    accessToken: SHEETS_ACCESS_TOKEN,
    refreshToken: null,
    expiresInSec: 3600,
    scope: "https://www.googleapis.com/auth/spreadsheets",
  },
  accountEmail: "pemilik-a@example.com",
  tokenSecret: TOKEN_SECRET,
});

// Stub fetch global: tangkap semua panggilan; append untuk
// spreadsheet "sheet-bagus" sukses, "sheet-hilang" → 404.
interface CapturedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}
const calls: CapturedCall[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (
  url: unknown,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
) => {
  const u = String(url);
  calls.push({
    url: u,
    method: init?.method ?? "GET",
    authorization: init?.headers?.Authorization ?? init?.headers?.authorization ?? null,
    body: String(init?.body ?? ""),
  });
  if (u.includes("sheet-hilang")) {
    return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      spreadsheetId: "sheet-bagus",
      updates: {
        updatedRange: "Pesanan!A5:C5",
        updatedRows: 1,
        updatedColumns: 3,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

function sheetGraph(spreadsheetId: string): FlowGraph {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        config: { kind: "webhook", channelAccountId: ACCOUNT_A },
      },
      {
        id: "catat",
        type: "append_sheet_row",
        config: {
          spreadsheetId,
          sheetName: "Pesanan",
          columns: [
            { header: "Nama", value: "{name}" },
            { header: "Kode", value: "{{field:order_id}}" },
            { header: "Order", value: "{{payload:order.id}}" },
          ],
        },
      },
      { id: "sapa", type: "send_message", config: { text: "Tercatat, {name}" } },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "catat" },
      { id: "e2", from: "catat", to: "sapa" },
    ],
  };
}

async function startRunViaWebhook(
  tenantId: string,
  userId: string,
  accountId: string,
  spreadsheetId: string,
): Promise<string> {
  const graph = sheetGraph(spreadsheetId);
  // Akun trigger harus milik tenant pemanggil graf.
  (graph.nodes[0].config as Record<string, unknown>).channelAccountId =
    accountId;
  const created = await createFlow(db, {
    tenantId,
    userId,
    name: `Catat ${spreadsheetId}`,
    graph,
  });
  const provisioned = await provisionFlowWebhookEndpoint(
    db,
    tenantId,
    created.flow.id,
    userId,
  );
  assert.ok(provisioned, "endpoint webhook terprovision");
  const act = await activateFlow(db, {
    tenantId,
    flowId: created.flow.id,
    userId,
  });
  assert.equal(act.kind, "activated");
  const endpoint = await resolveFlowWebhookEndpoint(
    db,
    provisioned.endpoint.id,
    provisioned.token,
  );
  assert.ok(endpoint);
  const started = await startFlowWebhookRun(db, endpoint, {
    phone: "0812-0000-1111",
    name: "Sari",
    order: { id: "ORD-9" },
  });
  assert.equal(started.kind, "started");
  return started.kind === "started" ? started.runId : "";
}

async function driveRun(tenantId: string, runId: string): Promise<string> {
  let status = "running";
  for (let i = 0; i < 8; i++) {
    const step = await executeFlowStep(
      db,
      { tenantId, runId, stepSeq: i },
      { google: { platform: {}, tokenSecret: TOKEN_SECRET } },
    );
    status = step.status ?? status;
    if (status !== "running") break;
  }
  return status;
}

async function sheetStepDetail(runId: string): Promise<Record<string, unknown>> {
  const r = await client.query<{ detail: Record<string, unknown> }>(
    `SELECT detail FROM flow_run_steps WHERE run_id = $1 AND node_type = 'append_sheet_row'`,
    [runId],
  );
  assert.equal(r.rows.length, 1, "tepat satu langkah append_sheet_row");
  return r.rows[0].detail;
}

try {
  // ---- A + B: append sukses dengan render penuh ----------------------
  const runA = await startRunViaWebhook(TENANT_A, USER_A, ACCOUNT_A, "sheet-bagus");
  await client.query(
    `UPDATE contacts SET custom_fields = '{"order_id":"ORD-77"}'::jsonb WHERE tenant_id = $1`,
    [TENANT_A],
  );
  const statusA = await driveRun(TENANT_A, runA);
  assert.equal(statusA, "completed");
  const appendCalls = calls.filter((c) => c.url.includes(":append"));
  assert.equal(appendCalls.length, 1, "tepat satu panggilan append");
  const call = appendCalls[0];
  assert.ok(
    call.url.startsWith(
      "https://www.googleapis.com/v4/spreadsheets/sheet-bagus/values/",
    ),
    `URL append benar: ${call.url}`,
  );
  assert.ok(call.url.includes("valueInputOption=USER_ENTERED"));
  assert.equal(
    call.authorization,
    `Bearer ${SHEETS_ACCESS_TOKEN}`,
    "token dari koneksi layanan sheets tenant",
  );
  const sentBody = JSON.parse(call.body) as {
    range: string;
    values: string[][];
  };
  assert.equal(sentBody.range, "'Pesanan'!A1");
  assert.deepEqual(sentBody.values, [["Sari", "ORD-77", "ORD-9"]]);
  const detailA = await sheetStepDetail(runA);
  assert.equal(detailA.outcome, "appended");
  assert.equal(detailA.updatedRange, "Pesanan!A5:C5");
  {
    const msgs = await client.query<{ content_text: string }>(
      `SELECT content_text FROM messages WHERE direction = 'outbound' AND content_text = 'Tercatat, Sari'`,
    );
    assert.equal(msgs.rows.length, 1, "run lanjut ke send_message");
  }

  // ---- C: tanpa koneksi → sheet_error, run tetap selesai --------------
  calls.length = 0;
  const runB = await startRunViaWebhook(TENANT_B, USER_B, ACCOUNT_B, "sheet-bagus");
  const statusB = await driveRun(TENANT_B, runB);
  assert.equal(statusB, "completed", "run tenant B tetap selesai");
  assert.equal(
    calls.filter((c) => c.url.includes(":append")).length,
    0,
    "tanpa koneksi tidak ada panggilan API",
  );
  const detailB = await sheetStepDetail(runB);
  assert.equal(detailB.outcome, "sheet_error");
  assert.equal(detailB.code, "sheets_not_connected");

  // ---- D: HTTP 404 → sheets_http_404, run tetap lanjut -----------------
  calls.length = 0;
  const runD = await startRunViaWebhook(TENANT_A, USER_A, ACCOUNT_A, "sheet-hilang");
  const statusD = await driveRun(TENANT_A, runD);
  assert.equal(statusD, "completed");
  const detailD = await sheetStepDetail(runD);
  assert.equal(detailD.outcome, "sheet_error");
  assert.equal(detailD.code, "sheets_http_404");
} finally {
  globalThis.fetch = realFetch;
}

console.log(
  "verify-google-sheets-flow: SEMUA LULUS — layanan sheets mandiri (token koneksi sheets), baris render {name}/{{field:}}/{{payload:}} terkirim ke URL append yang benar, hasil appended tercatat; tanpa koneksi & HTTP 404 tercatat sheet_error berkode dan run tetap selesai.",
);
