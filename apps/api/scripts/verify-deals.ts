/**
 * Verifikasi Gelombang G12 — DEALS / PIPELINE KANBAN BERMATA UANG, di
 * atas PGlite. Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan:
 *   [1] pipeline + tahap bawaan tersemai malas pada pembacaan pertama
 *       (nama tahap mengikuti locale tenant; pembacaan kedua tidak
 *       menggandakan).
 *   [2] CRUD pipeline/tahap via HTTP + aturan aman: hapus tahap berisi
 *       deal → 409 STAGE_NOT_EMPTY; dengan tahap tujuan deal berpindah
 *       (riwayat ikut tercatat); hapus pipeline berisi deal → 409
 *       PIPELINE_HAS_DEALS; gerbang peran (viewer tak bisa menulis,
 *       agent tak bisa mengelola pipeline, agent bisa membuat deal).
 *   [3] CRUD deal + validasi rujukan: kontak tak dikenal → 404,
 *       assignee bukan member → 400, percakapan milik kontak lain →
 *       404; bawaan tahap pertama + mata uang bawaan tenant; detail
 *       memuat riwayat tahap (peristiwa pembuatan).
 *   [4] perpindahan tahap mencatat riwayat + status terminal benar:
 *       tahap won → status won + closedAt terisi; kembali ke tahap
 *       terbuka → status open + closedAt kosong; tahap lost → lost;
 *       mengubah JENIS tahap menurunkan ulang status deal di dalamnya.
 *   [5] analitik ringan: total per tahap TERPISAH per mata uang (tidak
 *       dijumlah lintas mata uang) + jumlah per tahap + rata-rata hari
 *       dibuat→won dari data semai berdurasi pasti; tanpa deal menang
 *       rata-rata = null (kosong yang jujur).
 *   [6] isolasi tenant: pipeline/deal tenant lain 404 di bawah tenant
 *       sendiri; non-member 404 TENANT_NOT_FOUND.
 *   [7] aksi otomasi lewat mesin flow yang ada: create_deal membuat
 *       deal (judul dirender {name}, mata uang bawaan tenant, assignee
 *       dari config) lalu move_deal_stage memindahkannya; kontak tanpa
 *       deal open → langkah move tercatat SKIPPED beralasan
 *       `no_open_deal` dan run tetap COMPLETED (bukan gagal).
 *   [8] pengaturan mata uang bawaan tenant: PATCH owner berhasil,
 *       agent 403, format tidak sah 400; deal baru memakai bawaan baru,
 *       deal lama tidak berubah.
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:deals
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
  evaluateInboundMessageForAutomations,
  executeFlowStep,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createDealsRoutes } from "../src/modules/deals/routes";

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

const TENANT = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "11111111-1111-4111-8111-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VIEWER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWNER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ACC_TG = "21000000-0000-4000-8000-0000000000d1";
const ACC_TG_B = "21000000-0000-4000-8000-0000000000d2";
const CUST1 = "22000000-0000-4000-8000-0000000000d1";
const CUST2 = "22000000-0000-4000-8000-0000000000d2";
const CUSTB = "22000000-0000-4000-8000-0000000000d3";
const CONV1 = "23000000-0000-4000-8000-0000000000d1";
const CONV2 = "23000000-0000-4000-8000-0000000000d2";
const UNKNOWN_ID = "22000000-0000-4000-8000-000000000999";

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug, default_locale) VALUES ($1, 'Tenant A', 'tenant-a', 'id'), ($2, 'Tenant B', 'tenant-b', 'en')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES
   ($1, 'owner@sk.test', 'Pemilik A'),
   ($2, 'agent@sk.test', 'Agen A'),
   ($3, 'viewer@sk.test', 'Penonton A'),
   ($4, 'ownerb@sk.test', 'Pemilik B')`,
  [OWNER, AGENT, VIEWER, OWNER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
   ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'viewer'), ($5, $6, 'owner')`,
  [TENANT, OWNER, AGENT, VIEWER, TENANT_B, OWNER_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status) VALUES
   ($1, $3, 'telegram', '424242', 'Bot Uji', 'connected'),
   ($2, $4, 'telegram', '535353', 'Bot Uji B', 'connected')`,
  [ACC_TG, ACC_TG_B, TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name, source) VALUES
   ($1, $4, 'Budi Deal', 'manual'),
   ($2, $4, 'Sari Lain', 'manual'),
   ($3, $5, 'Orang B', 'manual')`,
  [CUST1, CUST2, CUSTB, TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status) VALUES
   ($1, $3, $4, $5, 'telegram', '888', 'private', 'open'),
   ($2, $3, $4, $6, 'telegram', '999', 'private', 'open')`,
  [CONV1, CONV2, TENANT, ACC_TG, CUST1, CUST2],
);

// ---------------------------------------------------------------------------
// Aplikasi uji: rute deals dengan sesi yang bisa ditukar per header
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? OWNER;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createDealsRoutes(bundle));

interface StageJson {
  id: string;
  name: string;
  color: string;
  kind: "open" | "won" | "lost";
  position: number;
}
interface PipelineJson {
  id: string;
  name: string;
  stages: StageJson[];
}
interface DealJson {
  id: string;
  pipelineId: string;
  stageId: string;
  contactId: string;
  contactName: string | null;
  conversationId: string | null;
  title: string;
  value: number;
  currency: string;
  status: "open" | "won" | "lost";
  priority: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
  expectedCloseDate: string | null;
  dueAt: string | null;
  closedAt?: string | null;
  stageHistory?: {
    fromStageName: string | null;
    toStageName: string;
    actorType: string;
  }[];
}
interface AnalyticsJson {
  wonCount: number;
  lostCount: number;
  avgDaysToWon: number | null;
  stages: {
    stageId: string;
    dealCount: number;
    totals: { currency: string; total: number }[];
  }[];
}
interface ErrJson {
  error: { code: string };
}

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
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as never,
  };
}

const pipelinesUrl = (tenant = TENANT) => `/tenants/${tenant}/deal-pipelines`;
const dealsUrl = (tenant = TENANT) => `/tenants/${tenant}/deals`;
const settingsUrl = (tenant = TENANT) => `/tenants/${tenant}/deal-settings`;

async function listPipelines(user = OWNER, tenant = TENANT) {
  const res = await call("GET", pipelinesUrl(tenant), user);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as { pipelines: PipelineJson[] }).pipelines;
}

// ---------------------------------------------------------------------------
// [1] Semai malas pipeline + tahap bawaan (mengikuti locale tenant)
// ---------------------------------------------------------------------------
let defaultPipeline: PipelineJson;
{
  const pipelines = await listPipelines();
  assert.equal(pipelines.length, 1, "satu pipeline bawaan tersemai");
  defaultPipeline = pipelines[0]!;
  assert.equal(defaultPipeline.name, "Pipeline Penjualan");
  assert.deepEqual(
    defaultPipeline.stages.map((s) => s.name),
    [
      "Prospek Baru",
      "Terkualifikasi",
      "Proposal Terkirim",
      "Negosiasi",
      "Menang",
      "Kalah",
    ],
    "nama tahap bawaan Bahasa Indonesia (locale tenant id)",
  );
  assert.deepEqual(
    defaultPipeline.stages.map((s) => s.kind),
    ["open", "open", "open", "open", "won", "lost"],
  );
  assert.deepEqual(
    defaultPipeline.stages.map((s) => s.position),
    [0, 1, 2, 3, 4, 5],
  );

  const again = await listPipelines();
  assert.equal(again.length, 1, "pembacaan kedua tidak menggandakan pipeline");
  assert.deepEqual(
    again[0]!.stages.map((s) => s.id),
    defaultPipeline.stages.map((s) => s.id),
    "id tahap stabil (tidak disemai ulang)",
  );

  const pipelinesB = await listPipelines(OWNER_B, TENANT_B);
  assert.equal(pipelinesB.length, 1);
  assert.equal(pipelinesB[0]!.name, "Sales Pipeline");
  assert.equal(pipelinesB[0]!.stages[0]!.name, "New Lead");
  assert.equal(pipelinesB[0]!.stages[4]!.name, "Won");
  console.log("[1] semai malas pipeline/tahap bawaan per locale OK");
}

// ---------------------------------------------------------------------------
// [2] CRUD pipeline/tahap + aturan aman + gerbang peran
// ---------------------------------------------------------------------------
let stageWithDeal: StageJson;
let stageTarget: StageJson;
{
  // Buat pipeline baru — tahap bawaan ikut tersemai.
  const created = await call("POST", pipelinesUrl(), OWNER, {
    name: "Pipeline Uji CRUD",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const crud = created.body as PipelineJson;
  assert.equal(crud.stages.length, 6, "pipeline baru membawa tahap bawaan");

  // Ganti nama.
  const renamed = await call("PATCH", `${pipelinesUrl()}/${crud.id}`, OWNER, {
    name: "Pipeline CRUD Baru",
  });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as PipelineJson).name, "Pipeline CRUD Baru");

  // Tambah tahap khusus + ubah nama/warna/jenisnya.
  const stageCreated = await call(
    "POST",
    `${pipelinesUrl()}/${crud.id}/stages`,
    OWNER,
    { name: "Tahap Uji", color: "#123456", kind: "open" },
  );
  assert.equal(stageCreated.status, 201, JSON.stringify(stageCreated.body));
  const customStage = stageCreated.body as StageJson;
  assert.equal(customStage.position, 6, "tahap baru di urutan terakhir");
  const stageUpdated = await call(
    "PATCH",
    `${pipelinesUrl()}/${crud.id}/stages/${customStage.id}`,
    OWNER,
    { name: "Tahap Uji 2", color: "#654321", kind: "open" },
  );
  assert.equal(stageUpdated.status, 200);
  assert.equal((stageUpdated.body as StageJson).name, "Tahap Uji 2");
  assert.equal((stageUpdated.body as StageJson).color, "#654321");

  // Susun ulang: tahap khusus ke posisi pertama.
  const current = (await listPipelines()).find((p) => p.id === crud.id)!;
  const ids = current.stages.map((s) => s.id);
  const reorderedIds = [
    customStage.id,
    ...ids.filter((id) => id !== customStage.id),
  ];
  const reordered = await call(
    "POST",
    `${pipelinesUrl()}/${crud.id}/stages/reorder`,
    OWNER,
    { stageIds: reorderedIds },
  );
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(
    (reordered.body as PipelineJson).stages.map((s) => s.id),
    reorderedIds,
    "urutan tahap mengikuti daftar yang dikirim",
  );

  // Aturan aman hapus tahap: isi satu deal dulu.
  stageWithDeal = (reordered.body as PipelineJson).stages[1]!;
  stageTarget = (reordered.body as PipelineJson).stages[0]!;
  const dealRes = await call("POST", dealsUrl(), OWNER, {
    pipelineId: crud.id,
    stageId: stageWithDeal.id,
    contactId: CUST1,
    title: "Deal penghuni tahap",
    value: 1000,
  });
  assert.equal(dealRes.status, 201, JSON.stringify(dealRes.body));
  const occupant = dealRes.body as DealJson;

  const blocked = await call(
    "DELETE",
    `${pipelinesUrl()}/${crud.id}/stages/${stageWithDeal.id}`,
    OWNER,
  );
  assert.equal(blocked.status, 409, "hapus tahap berisi deal tanpa tujuan → 409");
  assert.equal((blocked.body as ErrJson).error.code, "STAGE_NOT_EMPTY");

  const moved = await call(
    "DELETE",
    `${pipelinesUrl()}/${crud.id}/stages/${stageWithDeal.id}`,
    OWNER,
    { moveDealsToStageId: stageTarget.id },
  );
  assert.equal(moved.status, 204, "hapus tahap dengan tujuan → 204");
  const afterMove = await call("GET", `${dealsUrl()}/${occupant.id}`);
  assert.equal(afterMove.status, 200);
  assert.equal(
    (afterMove.body as DealJson).stageId,
    stageTarget.id,
    "deal berpindah ke tahap tujuan",
  );
  assert.equal(
    (afterMove.body as DealJson).stageHistory!.length,
    2,
    "perpindahan akibat hapus tahap tercatat di riwayat",
  );

  // Hapus pipeline berisi deal → 409; pipeline kosong → 204.
  const blockedPipeline = await call(
    "DELETE",
    `${pipelinesUrl()}/${crud.id}`,
    OWNER,
  );
  assert.equal(blockedPipeline.status, 409);
  assert.equal(
    (blockedPipeline.body as ErrJson).error.code,
    "PIPELINE_HAS_DEALS",
  );
  const emptyCreated = await call("POST", pipelinesUrl(), OWNER, {
    name: "Pipeline Kosong",
  });
  const emptyPipeline = emptyCreated.body as PipelineJson;
  const removed = await call(
    "DELETE",
    `${pipelinesUrl()}/${emptyPipeline.id}`,
    OWNER,
  );
  assert.equal(removed.status, 204, "pipeline kosong terhapus");

  // Gerbang peran.
  const viewerCreate = await call("POST", dealsUrl(), VIEWER, {
    contactId: CUST1,
    title: "Deal penonton",
  });
  assert.equal(viewerCreate.status, 403, "viewer membuat deal → 403");
  const viewerRead = await call("GET", pipelinesUrl(), VIEWER);
  assert.equal(viewerRead.status, 200, "viewer boleh membaca");
  const agentPipeline = await call("POST", pipelinesUrl(), AGENT, {
    name: "Pipeline agen",
  });
  assert.equal(agentPipeline.status, 403, "agent mengelola pipeline → 403");
  const agentDeal = await call("POST", dealsUrl(), AGENT, {
    contactId: CUST1,
    title: "Deal dari agen",
  });
  assert.equal(agentDeal.status, 201, "agent boleh membuat deal");
  console.log("[2] CRUD pipeline/tahap + aturan aman + gerbang peran OK");
}

// ---------------------------------------------------------------------------
// [3] CRUD deal + validasi rujukan + bawaan
// ---------------------------------------------------------------------------
let mainDeal: DealJson;
{
  const res = await call("POST", dealsUrl(), OWNER, {
    contactId: CUST1,
    conversationId: CONV1,
    title: "Paket Website Budi",
    value: 1500000.5,
    currency: "USD",
    priority: "high",
    assigneeUserId: AGENT,
    expectedCloseDate: "2026-12-20",
    dueAt: "2026-12-01T09:00:00.000Z",
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  mainDeal = res.body as DealJson;
  assert.equal(mainDeal.contactName, "Budi Deal");
  assert.equal(mainDeal.assigneeName, "Agen A");
  assert.equal(mainDeal.value, 1500000.5);
  assert.equal(mainDeal.currency, "USD");
  assert.equal(mainDeal.status, "open");
  assert.equal(
    mainDeal.stageId,
    defaultPipeline.stages[0]!.id,
    "tanpa stageId → tahap pertama pipeline bawaan",
  );
  assert.equal(mainDeal.pipelineId, defaultPipeline.id);

  // Bawaan mata uang dari pengaturan tenant (IDR sebelum grup [8]).
  const defaultedRes = await call("POST", dealsUrl(), OWNER, {
    contactId: CUST1,
    title: "Deal bawaan mata uang",
  });
  assert.equal(defaultedRes.status, 201);
  const defaulted = defaultedRes.body as DealJson;
  assert.equal(defaulted.currency, "IDR");
  assert.equal(defaulted.value, 0);

  // Detail memuat riwayat: satu peristiwa pembuatan.
  const detailRes = await call("GET", `${dealsUrl()}/${mainDeal.id}`);
  assert.equal(detailRes.status, 200);
  const detail = detailRes.body as DealJson;
  assert.equal(detail.stageHistory!.length, 1);
  assert.equal(detail.stageHistory![0]!.fromStageName, null);
  assert.equal(
    detail.stageHistory![0]!.toStageName,
    defaultPipeline.stages[0]!.name,
  );

  // Validasi rujukan.
  const badContact = await call("POST", dealsUrl(), OWNER, {
    contactId: UNKNOWN_ID,
    title: "Kontak hantu",
  });
  assert.equal(badContact.status, 404);
  assert.equal((badContact.body as ErrJson).error.code, "CONTACT_NOT_FOUND");
  const badAssignee = await call("POST", dealsUrl(), OWNER, {
    contactId: CUST1,
    title: "Assignee asing",
    assigneeUserId: OWNER_B,
  });
  assert.equal(badAssignee.status, 400);
  assert.equal(
    (badAssignee.body as ErrJson).error.code,
    "ASSIGNEE_NOT_MEMBER",
  );
  const badConversation = await call("POST", dealsUrl(), OWNER, {
    contactId: CUST1,
    conversationId: CONV2, // percakapan milik CUST2
    title: "Percakapan orang lain",
  });
  assert.equal(badConversation.status, 404);
  assert.equal(
    (badConversation.body as ErrJson).error.code,
    "CONVERSATION_NOT_FOUND",
  );

  // Ubah field.
  const patched = await call("PATCH", `${dealsUrl()}/${mainDeal.id}`, OWNER, {
    title: "Paket Website Budi (Revisi)",
    priority: "low",
    expectedCloseDate: null,
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal((patched.body as DealJson).title, "Paket Website Budi (Revisi)");
  assert.equal((patched.body as DealJson).priority, "low");
  assert.equal((patched.body as DealJson).expectedCloseDate, null);
  console.log("[3] CRUD deal + validasi rujukan + bawaan OK");
}


// ---------------------------------------------------------------------------
// [4] Perpindahan tahap: riwayat + status terminal won/lost + re-derivasi
// ---------------------------------------------------------------------------
{
  const wonStage = defaultPipeline.stages.find((s) => s.kind === "won")!;
  const lostStage = defaultPipeline.stages.find((s) => s.kind === "lost")!;
  const openStage = defaultPipeline.stages[0]!;

  const moveRes = await call(
    "POST",
    `${dealsUrl()}/${mainDeal.id}/move`,
    OWNER,
    { stageId: wonStage.id },
  );
  assert.equal(moveRes.status, 200, JSON.stringify(moveRes.body));
  const won = moveRes.body as DealJson;
  assert.equal(won.status, "won", "masuk tahap won → status won");
  assert.ok(won.closedAt, "closedAt terisi saat menang");

  const detailRes = await call("GET", `${dealsUrl()}/${mainDeal.id}`);
  const detail = detailRes.body as DealJson;
  assert.equal(detail.stageHistory!.length, 2, "riwayat: buat + pindah");
  assert.equal(
    detail.stageHistory![1]!.fromStageName,
    openStage.name,
  );
  assert.equal(detail.stageHistory![1]!.toStageName, wonStage.name);
  assert.equal(detail.stageHistory![1]!.actorType, "user");

  const backRes = await call(
    "POST",
    `${dealsUrl()}/${mainDeal.id}/move`,
    OWNER,
    { stageId: openStage.id },
  );
  const back = backRes.body as DealJson;
  assert.equal(back.status, "open", "kembali ke tahap terbuka → open lagi");
  assert.equal(back.closedAt, null, "closedAt dikosongkan");

  const lostRes = await call(
    "POST",
    `${dealsUrl()}/${mainDeal.id}/move`,
    OWNER,
    { stageId: lostStage.id },
  );
  const lost = lostRes.body as DealJson;
  assert.equal(lost.status, "lost", "masuk tahap lost → status lost");
  assert.ok(lost.closedAt, "closedAt terisi saat kalah");

  // Pindah ke tahap yang sama = no-op jujur (tidak ada baris riwayat baru).
  const historyBefore = (
    (await call("GET", `${dealsUrl()}/${mainDeal.id}`)).body as DealJson
  ).stageHistory!.length;
  const noopRes = await call(
    "POST",
    `${dealsUrl()}/${mainDeal.id}/move`,
    OWNER,
    { stageId: lostStage.id },
  );
  assert.equal(noopRes.status, 200);
  const historyAfter = (
    (await call("GET", `${dealsUrl()}/${mainDeal.id}`)).body as DealJson
  ).stageHistory!.length;
  assert.equal(historyAfter, historyBefore, "pindah ke tahap sama tidak mencatat riwayat");

  // Mengubah JENIS tahap menurunkan ulang status deal di dalamnya.
  const kindPipelineRes = await call("POST", pipelinesUrl(), OWNER, {
    name: "Pipeline Uji Jenis",
  });
  const kindPipeline = kindPipelineRes.body as PipelineJson;
  const openCustom = await call(
    "POST",
    `${pipelinesUrl()}/${kindPipeline.id}/stages`,
    OWNER,
    { name: "Tahap Fleksibel", kind: "open" },
  );
  const flexStage = openCustom.body as StageJson;
  const flexDealRes = await call("POST", dealsUrl(), OWNER, {
    pipelineId: kindPipeline.id,
    stageId: flexStage.id,
    contactId: CUST1,
    title: "Deal fleksibel",
  });
  const flexDeal = flexDealRes.body as DealJson;
  assert.equal(flexDeal.status, "open");
  await call(
    "PATCH",
    `${pipelinesUrl()}/${kindPipeline.id}/stages/${flexStage.id}`,
    OWNER,
    { kind: "won" },
  );
  const rederived = (
    (await call("GET", `${dealsUrl()}/${flexDeal.id}`)).body as DealJson
  );
  assert.equal(
    rederived.status,
    "won",
    "jenis tahap berubah ke won → deal di dalamnya ikut won",
  );
  assert.ok(rederived.closedAt, "closedAt ikut terisi dari re-derivasi");
  console.log("[4] perpindahan tahap + terminal won/lost + re-derivasi jenis OK");
}

// ---------------------------------------------------------------------------
// [5] Analitik: per tahap, per mata uang, rata-rata hari ke won
// ---------------------------------------------------------------------------
{
  const pipeRes = await call("POST", pipelinesUrl(), OWNER, {
    name: "Pipeline Analitik",
  });
  const pipe = pipeRes.body as PipelineJson;
  const [s1, s2] = pipe.stages as [StageJson, StageJson];
  const wonStage = pipe.stages.find((s) => s.kind === "won")!;
  const lostStage = pipe.stages.find((s) => s.kind === "lost")!;

  const mk = async (input: Record<string, unknown>) => {
    const r = await call("POST", dealsUrl(), OWNER, {
      pipelineId: pipe.id,
      contactId: CUST1,
      ...input,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as DealJson;
  };

  await mk({ title: "A1", stageId: s1.id, value: 1000000, currency: "IDR" });
  await mk({ title: "A2", stageId: s1.id, value: 2500000, currency: "IDR" });
  await mk({ title: "A3", stageId: s1.id, value: 500, currency: "USD" });
  await mk({ title: "B1", stageId: s2.id, value: 750, currency: "USD" });

  // Dua deal menang dengan durasi dibuat→tutup yang PASTI: 10 & 20 hari.
  const w1 = await mk({ title: "W1", value: 100, currency: "IDR" });
  const w2 = await mk({ title: "W2", value: 200, currency: "IDR" });
  for (const [deal, days] of [
    [w1, 10],
    [w2, 20],
  ] as const) {
    const mv = await call("POST", `${dealsUrl()}/${deal.id}/move`, OWNER, {
      stageId: wonStage.id,
    });
    assert.equal(mv.status, 200);
    await client.query(
      `UPDATE deals SET created_at = closed_at - ($2 || ' days')::interval WHERE id = $1`,
      [deal.id, String(days)],
    );
  }
  const l1 = await mk({ title: "L1", value: 50, currency: "IDR" });
  await call("POST", `${dealsUrl()}/${l1.id}/move`, OWNER, {
    stageId: lostStage.id,
  });

  const res = await call("GET", `${pipelinesUrl()}/${pipe.id}/analytics`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const analytics = res.body as AnalyticsJson;
  const byStage = new Map(analytics.stages.map((s) => [s.stageId, s]));
  assert.equal(byStage.get(s1.id)!.dealCount, 3, "tahap 1 berisi 3 deal");
  assert.deepEqual(
    byStage
      .get(s1.id)!
      .totals.slice()
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    [
      { currency: "IDR", total: 3500000 },
      { currency: "USD", total: 500 },
    ],
    "total tahap 1 terpisah per mata uang (IDR tidak menyerap USD)",
  );
  assert.deepEqual(byStage.get(s2.id)!.totals, [
    { currency: "USD", total: 750 },
  ]);
  assert.equal(byStage.get(wonStage.id)!.dealCount, 2);
  assert.equal(analytics.wonCount, 2);
  assert.equal(analytics.lostCount, 1);
  assert.equal(
    analytics.avgDaysToWon,
    15,
    "rata-rata (10+20)/2 = 15 hari dari data semai pasti",
  );

  // Tanpa deal menang → rata-rata null (tenant B: pipeline bawaan kosong).
  const pipelinesB = await listPipelines(OWNER_B, TENANT_B);
  const resB = await call(
    "GET",
    `${pipelinesUrl(TENANT_B)}/${pipelinesB[0]!.id}/analytics`,
    OWNER_B,
  );
  assert.equal(resB.status, 200);
  const analyticsB = resB.body as AnalyticsJson;
  assert.equal(analyticsB.avgDaysToWon, null, "tanpa deal menang → null");
  assert.equal(analyticsB.wonCount, 0);
  console.log("[5] analitik per tahap per mata uang + rata-rata hari won OK");
}

// ---------------------------------------------------------------------------
// [6] Isolasi tenant
// ---------------------------------------------------------------------------
{
  const crossPipeline = await call(
    "GET",
    `${pipelinesUrl(TENANT_B)}/${defaultPipeline.id}/analytics`,
    OWNER_B,
  );
  assert.equal(crossPipeline.status, 404, "analitik pipeline A di bawah B → 404");
  assert.equal(
    (crossPipeline.body as ErrJson).error.code,
    "PIPELINE_NOT_FOUND",
  );
  const crossDeal = await call(
    "GET",
    `${dealsUrl(TENANT_B)}/${mainDeal.id}`,
    OWNER_B,
  );
  assert.equal(crossDeal.status, 404, "deal A di bawah tenant B → 404");
  assert.equal((crossDeal.body as ErrJson).error.code, "DEAL_NOT_FOUND");

  const notMember = await call("GET", pipelinesUrl(TENANT_B), OWNER);
  assert.equal(notMember.status, 404, "bukan member tenant B → 404");
  assert.equal(
    (notMember.body as ErrJson).error.code,
    "TENANT_NOT_FOUND",
  );

  const dealsB = await call("GET", dealsUrl(TENANT_B), OWNER_B);
  assert.equal(dealsB.status, 200);
  assert.equal(
    (dealsB.body as { deals: DealJson[] }).deals.length,
    0,
    "daftar deal tenant B kosong (tidak ada kebocoran dari A)",
  );
  console.log("[6] isolasi tenant deals/pipeline OK");
}

// ---------------------------------------------------------------------------
// [7] Aksi otomasi lewat mesin flow: create_deal + move_deal_stage
// ---------------------------------------------------------------------------
async function seedFlowContact(name: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name, opt_in_status) VALUES ($1, $2, 'unknown') RETURNING id`,
    [TENANT, name],
  );
  return r.rows[0]!.id;
}
async function seedFlowConversation(contactId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
     VALUES ($1, $2, $3, 'telegram', $4, 'private', 'open') RETURNING id`,
    [TENANT, ACC_TG, contactId, `chat-${contactId.slice(0, 8)}`],
  );
  return r.rows[0]!.id;
}
async function seedInbound(conversationId: string, text: string) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received') RETURNING id`,
    [TENANT, conversationId, text],
  );
  return r.rows[0]!.id;
}
async function driveRunToEnd(messageId: string) {
  const runRow = await client.query<{
    id: string;
    next_step_seq: number;
    status: string;
  }>(
    `SELECT id, next_step_seq, status FROM flow_runs WHERE tenant_id=$1 AND trigger_message_id=$2`,
    [TENANT, messageId],
  );
  assert.equal(runRow.rows.length, 1, "satu run lahir dari pesan pemicu");
  const runId = runRow.rows[0]!.id;
  for (let i = 0; i < 12; i++) {
    const cur = await client.query<{
      next_step_seq: number;
      status: string;
    }>(`SELECT next_step_seq, status FROM flow_runs WHERE id=$1`, [runId]);
    const status = cur.rows[0]!.status;
    if (status === "completed" || status === "failed") break;
    await executeFlowStep(db, {
      tenantId: TENANT,
      runId,
      stepSeq: cur.rows[0]!.next_step_seq,
    });
  }
  const finalRow = await client.query<{ status: string }>(
    `SELECT status FROM flow_runs WHERE id=$1`,
    [runId],
  );
  const steps = await client.query<{
    node_type: string;
    detail: Record<string, unknown>;
    error: string | null;
  }>(
    `SELECT node_type, detail, error FROM flow_run_steps WHERE run_id=$1 ORDER BY seq`,
    [runId],
  );
  return { runId, status: finalRow.rows[0]!.status, steps: steps.rows };
}

{
  const stageQualified = defaultPipeline.stages[1]!;
  const stageNegotiation = defaultPipeline.stages[3]!;

  // Flow 1: keyword → create_deal → move_deal_stage → end.
  const graph1 = {
    nodes: [
      {
        id: "t",
        type: "trigger",
        config: { kind: "keyword", keywords: ["DEALBARU"], match: "exact" },
      },
      {
        id: "cd",
        type: "create_deal",
        config: {
          title: "Order dari {name}",
          value: 75000,
          dealStageId: stageQualified.id,
          assigneeUserId: AGENT,
        },
      },
      {
        id: "mv",
        type: "move_deal_stage",
        config: { dealStageId: stageNegotiation.id },
      },
      { id: "e", type: "end", config: {} },
    ],
    edges: [
      { from: "t", to: "cd" },
      { from: "cd", to: "mv" },
      { from: "mv", to: "e" },
    ],
  };
  const created1 = await createFlow(db, {
    tenantId: TENANT,
    userId: OWNER,
    name: "Flow buat deal",
    graph: graph1 as never,
  });
  assert.equal(created1.kind, "created", JSON.stringify(created1));
  if (created1.kind !== "created") throw new Error("flow 1 tidak terbuat");
  const act1 = await activateFlow(db, {
    tenantId: TENANT,
    userId: OWNER,
    flowId: created1.flow.id,
  });
  assert.equal(act1.kind, "activated", JSON.stringify(act1));

  const sari = await seedFlowContact("Sari Flow");
  const sariConv = await seedFlowConversation(sari);
  const sariMsg = await seedInbound(sariConv, "DEALBARU");
  const ev1 = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT,
    conversationId: sariConv,
    messageId: sariMsg,
  });
  assert.equal(ev1.flowRunsStarted, 1, "flow DEALBARU menyala");
  const run1 = await driveRunToEnd(sariMsg);
  assert.equal(run1.status, "completed", JSON.stringify(run1.steps));
  const createStep = run1.steps.find((s) => s.node_type === "create_deal");
  assert.ok(createStep, "langkah create_deal tercatat");
  assert.equal(createStep.detail.outcome, "created");
  const flowDealId = createStep.detail.dealId as string;
  const moveStep = run1.steps.find((s) => s.node_type === "move_deal_stage");
  assert.ok(moveStep, "langkah move_deal_stage tercatat");
  assert.equal(moveStep.detail.outcome, "moved");
  assert.equal(moveStep.detail.dealId, flowDealId);
  assert.equal(moveStep.detail.toStageId, stageNegotiation.id);

  const flowDealRes = await call("GET", `${dealsUrl()}/${flowDealId}`);
  assert.equal(flowDealRes.status, 200);
  const flowDeal = flowDealRes.body as DealJson;
  assert.equal(flowDeal.title, "Order dari Sari Flow", "judul dirender {name}");
  assert.equal(flowDeal.value, 75000);
  assert.equal(
    flowDeal.currency,
    "IDR",
    "mata uang deal otomasi = bawaan tenant saat itu",
  );
  assert.equal(flowDeal.assigneeUserId, AGENT);
  assert.equal(flowDeal.stageId, stageNegotiation.id);
  assert.equal(flowDeal.conversationId, sariConv);
  assert.ok(
    flowDeal.stageHistory!.some((h) => h.actorType === "flow"),
    "riwayat tahap mencatat aktor flow",
  );

  // Flow 2: move_deal_stage untuk kontak TANPA deal open → skip jujur.
  const graph2 = {
    nodes: [
      {
        id: "t",
        type: "trigger",
        config: { kind: "keyword", keywords: ["PINDAHDEAL"], match: "exact" },
      },
      {
        id: "mv",
        type: "move_deal_stage",
        config: { dealStageId: stageNegotiation.id },
      },
      { id: "e", type: "end", config: {} },
    ],
    edges: [
      { from: "t", to: "mv" },
      { from: "mv", to: "e" },
    ],
  };
  const created2 = await createFlow(db, {
    tenantId: TENANT,
    userId: OWNER,
    name: "Flow pindah deal",
    graph: graph2 as never,
  });
  assert.equal(created2.kind, "created", JSON.stringify(created2));
  if (created2.kind !== "created") throw new Error("flow 2 tidak terbuat");
  const act2 = await activateFlow(db, {
    tenantId: TENANT,
    userId: OWNER,
    flowId: created2.flow.id,
  });
  assert.equal(act2.kind, "activated", JSON.stringify(act2));

  const polos = await seedFlowContact("Polos Tanpa Deal");
  const polosConv = await seedFlowConversation(polos);
  const polosMsg = await seedInbound(polosConv, "PINDAHDEAL");
  const ev2 = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT,
    conversationId: polosConv,
    messageId: polosMsg,
  });
  assert.equal(ev2.flowRunsStarted, 1);
  const run2 = await driveRunToEnd(polosMsg);
  assert.equal(
    run2.status,
    "completed",
    "run kontak tanpa deal open tetap selesai (bukan gagal)",
  );
  const skipStep = run2.steps.find((s) => s.node_type === "move_deal_stage");
  assert.ok(skipStep, "langkah move tercatat");
  assert.equal(skipStep.error, null, "langkah skip bukan error");
  assert.equal(skipStep.detail.outcome, "skipped");
  assert.equal(
    skipStep.detail.reason,
    "no_open_deal",
    "alasan lewatan jujur tercatat di run",
  );
  console.log("[7] aksi otomasi create_deal/move_deal_stage + lewatan jujur OK");
}

// ---------------------------------------------------------------------------
// [8] Pengaturan mata uang bawaan tenant
// ---------------------------------------------------------------------------
{
  const before = await call("GET", settingsUrl());
  assert.equal(before.status, 200);
  assert.equal(
    (before.body as { defaultCurrency: string }).defaultCurrency,
    "IDR",
    "bawaan awal IDR",
  );

  const agentPatch = await call("PATCH", settingsUrl(), AGENT, {
    defaultCurrency: "USD",
  });
  assert.equal(agentPatch.status, 403, "agent mengubah pengaturan → 403");

  const invalid = await call("PATCH", settingsUrl(), OWNER, {
    defaultCurrency: "usd",
  });
  assert.equal(invalid.status, 400, "kode huruf kecil → 400");
  const tooShort = await call("PATCH", settingsUrl(), OWNER, {
    defaultCurrency: "US",
  });
  assert.equal(tooShort.status, 400, "kode 2 huruf → 400");

  const patched = await call("PATCH", settingsUrl(), OWNER, {
    defaultCurrency: "USD",
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(
    (patched.body as { defaultCurrency: string }).defaultCurrency,
    "USD",
  );

  const newDealRes = await call("POST", dealsUrl(), OWNER, {
    contactId: CUST1,
    title: "Deal sesudah ganti bawaan",
  });
  assert.equal(newDealRes.status, 201);
  assert.equal(
    (newDealRes.body as DealJson).currency,
    "USD",
    "deal baru memakai mata uang bawaan baru",
  );
  const oldDeal = (
    (await call("GET", `${dealsUrl()}/${mainDeal.id}`)).body as DealJson
  );
  assert.equal(
    oldDeal.currency,
    "USD",
    "deal lama menyimpan mata uangnya sendiri (USD sejak pembuatan)",
  );
  const idrDeal = await client.query<{ currency: string }>(
    `SELECT currency FROM deals WHERE tenant_id=$1 AND title='Deal bawaan mata uang'`,
    [TENANT],
  );
  assert.equal(
    idrDeal.rows[0]!.currency,
    "IDR",
    "deal lama ber-IDR tetap IDR sesudah bawaan berubah",
  );
  console.log("[8] pengaturan mata uang bawaan tenant OK");
}

console.log("verify-deals: SEMUA LULUS");
