/**
 * Verifikasi SIMULATOR FLOW (G4, Tier 1 butir 4) di atas PGlite +
 * seluruh migrasi + aplikasi Hono dengan AuthBundle tiruan (pola
 * verify-flow-versions) dan rute flows sungguhan.
 *
 * Yang dibuktikan di sini (kontrak gelombang):
 *  [1] NOL TULISAN — simulasi graf kaya (pesan/kondisi/split
 *      eksperimen/delay acak/AI/HTTP/enroll/field) pada flow AKTIF:
 *      hitungan baris SEMUA tabel terkait (messages, conversations,
 *      contacts, flow_runs, flow_run_steps, flow_versions,
 *      flow_experiment_assignments, sequence_enrollments,
 *      outbox_events, audit_logs, usage_ledger, payment_links, carts,
 *      cart_items, orders, bookings, flows) TIDAK berubah, baris
 *      kontak & flow yang ada tidak tersentuh — sementara respons
 *      membuktikan interpreter berjalan di atas KONTAK MOCK
 *      (tag/field mock berubah di hasil). Berlaku juga untuk jalur
 *      graf kiriman (draf belum tersimpan).
 *  [2] JEJAK BERCABANG BENAR — condition has_tag & message_contains
 *      mengambil cabang yang tepat, teks ter-render {name}.
 *  [3] PARKIR — wait_reply (tanpa balasan berhenti beralasan; dengan
 *      balasan simulasi lanjut cabang replied), questionnaire
 *      (pertanyaan pertama ter-render lalu parkir), show_catalog
 *      (katalog ter-render dari produk tenant lalu parkir),
 *      book_appointment (parkir slot + efek tercatat); delay tercatat
 *      sebagai efek dan traversal LANJUT.
 *  [4] AI TANPA PROVIDER — ai_response menjadi langkah "simulated"
 *      (llm_not_called) + efek tercatat; usage_ledger & messages
 *      tidak berubah.
 *  [5] SUMBER GRAF + ISOLASI — snapshot versi G3 bisa disimulasikan
 *      (isi v1, bukan draf), graf kiriman & graf tersimpan;
 *      graph+version bersamaan → 400; versi tak ada → 404; lintas
 *      tenant & non-anggota → 404.
 *  [6] NODE TERCATAT — http_request URL ter-render substitusi tanpa
 *      panggilan, send_payment_link & goto_flow & checkout menjadi
 *      efek recorded (goto menghentikan run asal seperti aslinya,
 *      nol order/tautan dibuat).
 *  [7] PEMICU & BATAS — trigger tak cocok → trigger_not_matched
 *      tanpa langkah; graf berputar → failed step_cap_exceeded.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:flow-simulator
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createFlowsRoutes } from "../src/modules/flows/routes";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../../packages/db/migrations");

let passed = 0;
let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(
      `  FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`,
    );
  }
}

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
   VALUES ($1, $2, 'webchat', 'wc_uji_simulator', 'connected')`,
  [ACCOUNT_A, TENANT_A],
);

// Kontak, produk & sequence SUNGGUHAN: bukti simulator tidak
// menyentuh data tenant walau graf memuat node yang memakainya.
const contactSeed = await client.query<{ id: string }>(
  `INSERT INTO contacts (tenant_id, name, tags, custom_fields, pipeline_stage, opt_in_status)
   VALUES ($1, 'Kontak Asli', ARRAY['asli'], '{"kota":"Jakarta"}'::jsonb, 'new', 'unknown') RETURNING id`,
  [TENANT_A],
);
const CONTACT_ID = contactSeed.rows[0]!.id;
const productSeed = await client.query<{ id: string }>(
  `INSERT INTO products (tenant_id, name, price_idr, is_active) VALUES ($1, 'Kelas Foto', 150000, true) RETURNING id`,
  [TENANT_A],
);
const PRODUCT_ID = productSeed.rows[0]!.id;
const sequenceSeed = await client.query<{ id: string }>(
  `INSERT INTO automations (tenant_id, name, kind, is_active) VALUES ($1, 'Sequence Uji', 'sequence', true) RETURNING id`,
  [TENANT_A],
);
const SEQUENCE_ID = sequenceSeed.rows[0]!.id;
await client.query(
  `INSERT INTO automation_steps (tenant_id, automation_id, position, delay_minutes, text) VALUES ($1, $2, 1, 0, 'Langkah sequence')`,
  [TENANT_A, SEQUENCE_ID],
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

interface SimBody {
  id?: string;
  status?: string;
  triggerMatched?: boolean;
  parkedNodeId?: string | null;
  parkReason?: string | null;
  failReason?: string | null;
  source?: { kind?: string; version?: number | null };
  steps?: Array<{
    seq: number;
    nodeId: string;
    nodeType: string;
    detail: Record<string, unknown>;
  }>;
  effects?: Array<{
    nodeId: string;
    kind: string;
    fidelity: string;
    data: Record<string, unknown>;
  }>;
  contact?: {
    name: string;
    tags: string[];
    stage: string | null;
    customFields: Record<string, unknown>;
  };
  issues?: Array<{ code: string; severity: string }>;
  error?: { code?: string };
  flow?: { id: string; status: string };
  version?: number;
}

async function call(
  method: string,
  url: string,
  userId: string,
  body?: unknown,
): Promise<{ status: number; body: SimBody }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": userId,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: SimBody = {};
  try {
    parsed = (text ? JSON.parse(text) : {}) as SimBody;
  } catch {
    parsed = { error: { code: `NON_JSON:${text.slice(0, 120)}` } };
  }
  return { status: res.status, body: parsed };
}

/** Graf uji kontrak: node {id,type,position,config} + edge {id,from,to,branch?}. */
function graphOf(
  nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>,
  edges: Array<{ from: string; to: string; branch?: string }>,
): Record<string, unknown> {
  return {
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      position: { x: (i % 4) * 220, y: Math.floor(i / 4) * 140 },
      config: n.config ?? {},
    })),
    edges: edges.map((e, i) => ({
      id: `e${i + 1}`,
      from: e.from,
      to: e.to,
      ...(e.branch ? { branch: e.branch } : {}),
    })),
  };
}

const WATCHED_TABLES = [
  "messages",
  "conversations",
  "contacts",
  "flow_runs",
  "flow_run_steps",
  "flow_versions",
  "flow_experiment_assignments",
  "sequence_enrollments",
  "outbox_events",
  "audit_logs",
  "usage_ledger",
  "payment_links",
  "carts",
  "cart_items",
  "orders",
  "bookings",
  "flows",
] as const;

async function countRows(table: string): Promise<number> {
  const r = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM "${table}"`,
  );
  return r.rows[0]?.c ?? -1;
}

async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of WATCHED_TABLES) out[table] = await countRows(table);
  return out;
}

function sameSnapshot(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  return WATCHED_TABLES.every((t) => a[t] === b[t]);
}

const flowUrl = (flowId: string) => `/tenants/${TENANT_A}/flows/${flowId}`;
const simUrl = (flowId: string) => `${flowUrl(flowId)}/simulate`;

async function createFlowWithGraph(
  name: string,
  graph: Record<string, unknown>,
): Promise<string> {
  const created = await call("POST", `/tenants/${TENANT_A}/flows`, USER_A, { name });
  const id = created.body.id ?? created.body.flow?.id ?? "";
  check(`buat flow "${name}" → 201`, created.status === 201 && id !== "", created.body);
  const patched = await call("PATCH", flowUrl(id), USER_A, { graph });
  check(`patch graf "${name}" → 200`, patched.status === 200, patched.body);
  return id;
}

// =================================================================
console.log("\n[1] Nol tulisan — graf kaya di flow AKTIF");
const richGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "m1", type: "send_message", config: { text: "Halo {name}, penawaran {spesial|khusus} untukmu" } },
    { id: "c1", type: "condition", config: { predicate: "has_tag", tag: "vip" } },
    { id: "tg1", type: "add_tag", config: { tag: "diuji" } },
    { id: "sp", type: "ab_split", config: { percentA: 50, experiment: true } },
    { id: "d1", type: "delay", config: { amount: 1, unit: "minutes", random: { min: 1, max: 5 } } },
    { id: "ai", type: "ai_response", config: { template: "Hai {name}, ada yang bisa dibantu?" } },
    { id: "sf", type: "set_field", config: { field: "custom:kota", value: "Bandung" } },
    { id: "http", type: "http_request", config: { method: "POST", url: "https://contoh.id/hook/{name}", body: "{\"kota\":\"{{field:kota}}\"}" } },
    { id: "en", type: "enroll_sequence", config: { automationId: SEQUENCE_ID } },
    { id: "e", type: "end", config: {} },
  ],
  [
    { from: "t", to: "m1" },
    { from: "m1", to: "c1" },
    { from: "c1", to: "tg1", branch: "yes" },
    { from: "c1", to: "sp", branch: "no" },
    { from: "tg1", to: "sp" },
    { from: "sp", to: "d1", branch: "a" },
    { from: "sp", to: "d1", branch: "b" },
    { from: "d1", to: "ai" },
    { from: "ai", to: "sf" },
    { from: "sf", to: "http" },
    { from: "http", to: "en" },
    { from: "en", to: "e" },
  ],
);
const richId = await createFlowWithGraph("Kaya Nol Tulis", richGraph);
const activated = await call("POST", `${flowUrl(richId)}/activate`, USER_A, {});
check("aktivasi flow kaya → 200 versi 1", activated.status === 200 && activated.body.version === 1, activated.body);

const before = await snapshot();
const contactBefore = await client.query(
  `SELECT id, name, tags, custom_fields, pipeline_stage FROM contacts WHERE id = $1`,
  [CONTACT_ID],
);
const flowBefore = await client.query(
  `SELECT updated_at FROM flows WHERE id = $1`,
  [richId],
);
const simRich = await call("POST", simUrl(richId), USER_MEMBER, {
  triggerText: "halo",
  contact: { name: "Sari", tags: ["vip"], customFields: {} },
});
check("simulasi graf kaya (anggota viewer) → 200 completed", simRich.status === 200 && simRich.body.status === "completed", simRich.body);
const richSteps = simRich.body.steps ?? [];
check(
  "jejak kaya memuat semua node jalur ya",
  ["m1", "c1", "tg1", "sp", "d1", "ai", "sf", "http", "en", "e"].every(
    (id, i) => richSteps[i]?.nodeId === id,
  ),
  richSteps.map((s) => s.nodeId),
);
const richEffects = simRich.body.effects ?? [];
check(
  "efek kaya: ai & http & enroll tercatat (recorded)",
  ["ai_response", "http_request", "enroll_sequence"].every((kind) =>
    richEffects.some((e) => e.kind === kind && e.fidelity === "recorded"),
  ),
  richEffects,
);
check(
  "efek http membawa kota hasil set_field mock (Bandung)",
  richEffects.some(
    (e) => e.kind === "http_request" && JSON.stringify(e.data).includes("Bandung"),
  ),
  richEffects,
);
check(
  "kontak hasil = mock yang berubah (tag diuji + kota Bandung)",
  (simRich.body.contact?.tags ?? []).includes("diuji") &&
    simRich.body.contact?.customFields?.kota === "Bandung",
  simRich.body.contact,
);
const after = await snapshot();
check("NOL TULISAN: semua hitungan tabel terkait tetap", sameSnapshot(before, after), { before, after });
const contactAfter = await client.query(
  `SELECT id, name, tags, custom_fields, pipeline_stage FROM contacts WHERE id = $1`,
  [CONTACT_ID],
);
check(
  "baris kontak asli tidak tersentuh",
  JSON.stringify(contactBefore.rows) === JSON.stringify(contactAfter.rows),
);
const flowAfter = await client.query(
  `SELECT updated_at FROM flows WHERE id = $1`,
  [richId],
);
check(
  "baris flow tidak tersentuh (updated_at sama)",
  JSON.stringify(flowBefore.rows) === JSON.stringify(flowAfter.rows),
);
check(
  "flow_experiment_assignments tetap 0 (split eksperimen tak menulis)",
  after.flow_experiment_assignments === 0,
  after,
);
const simDraft = await call("POST", simUrl(richId), USER_A, {
  graph: richGraph,
  triggerText: "halo",
  contact: { name: "Sari", tags: [], customFields: {} },
});
check("simulasi graf kiriman → 200 (sumber draft)", simDraft.status === 200 && simDraft.body.source?.kind === "draft", simDraft.body);
const afterDraft = await snapshot();
check("NOL TULISAN juga untuk graf kiriman", sameSnapshot(before, afterDraft), { before, afterDraft });

// =================================================================
console.log("\n[2] Jejak bercabang benar");
const condGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "keyword", keywords: ["promo"], match: "exact" } },
    { id: "c", type: "condition", config: { predicate: "has_tag", tag: "vip" } },
    { id: "my", type: "send_message", config: { text: "Halo VIP {name}" } },
    { id: "mn", type: "send_message", config: { text: "Halo {name}" } },
  ],
  [
    { from: "t", to: "c" },
    { from: "c", to: "my", branch: "yes" },
    { from: "c", to: "mn", branch: "no" },
  ],
);
const condId = await createFlowWithGraph("Cabang Kondisi", condGraph);
const simVip = await call("POST", simUrl(condId), USER_A, {
  triggerText: "promo",
  contact: { name: "Sari", tags: ["vip"] },
});
check(
  "has_tag vip → cabang yes + teks ter-render",
  (simVip.body.steps ?? []).map((s) => s.nodeId).join(",") === "c,my" &&
    (simVip.body.effects ?? []).some((e) => e.data.text === "Halo VIP Sari"),
  simVip.body,
);
const simNonVip = await call("POST", simUrl(condId), USER_A, {
  triggerText: "promo",
  contact: { name: "Sari", tags: [] },
});
check(
  "tanpa tag → cabang no",
  (simNonVip.body.steps ?? []).map((s) => s.nodeId).join(",") === "c,mn",
  simNonVip.body,
);
const containsGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "c", type: "condition", config: { predicate: "message_contains", text: "promo" } },
    { id: "my", type: "send_message", config: { text: "Ada promo" } },
    { id: "mn", type: "send_message", config: { text: "Tidak ada" } },
  ],
  [
    { from: "t", to: "c" },
    { from: "c", to: "my", branch: "yes" },
    { from: "c", to: "mn", branch: "no" },
  ],
);
const containsId = await createFlowWithGraph("Cabang Teks", containsGraph);
const simContains = await call("POST", simUrl(containsId), USER_A, {
  triggerText: "info promo dong",
  contact: { name: "Sari" },
});
check(
  "message_contains memakai teks pemicu → yes",
  (simContains.body.steps ?? []).some((s) => s.nodeId === "my"),
  simContains.body,
);

// =================================================================
console.log("\n[3] Parkir & delay tercatat");
const waitGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "w", type: "wait_reply", config: { amount: 24, unit: "hours" } },
    { id: "mr", type: "send_message", config: { text: "Makasih {name}" } },
    { id: "mt", type: "send_message", config: { text: "Sudah lewat" } },
  ],
  [
    { from: "t", to: "w" },
    { from: "w", to: "mr", branch: "replied" },
    { from: "w", to: "mt", branch: "timeout" },
  ],
);
const waitId = await createFlowWithGraph("Parkir Balasan", waitGraph);
const simWait = await call("POST", simUrl(waitId), USER_A, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "wait_reply tanpa balasan → parked waiting_for_reply di node w",
  simWait.body.status === "parked" &&
    simWait.body.parkReason === "waiting_for_reply" &&
    simWait.body.parkedNodeId === "w" &&
    (simWait.body.steps ?? []).length === 1,
  simWait.body,
);
const simReplied = await call("POST", simUrl(waitId), USER_A, {
  triggerText: "halo",
  replyText: "siap",
  contact: { name: "Sari" },
});
check(
  "dengan balasan simulasi → lanjut cabang replied sampai selesai",
  simReplied.body.status === "completed" &&
    (simReplied.body.steps ?? []).map((s) => s.nodeId).join(",") === "w,mr",
  simReplied.body,
);
const questGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "q", type: "questionnaire", config: { amount: 5, unit: "minutes", maxInvalidAttempts: 2, questions: [{ id: "q1", prompt: "Kota asal?", answerType: "text", target: "custom:kota" }] } },
    { id: "e", type: "end", config: {} },
  ],
  [
    { from: "t", to: "q" },
    { from: "q", to: "e", branch: "completed" },
    { from: "q", to: "e", branch: "invalid" },
    { from: "q", to: "e", branch: "timeout" },
  ],
);
const questId = await createFlowWithGraph("Parkir Kuesioner", questGraph);
const simQuest = await call("POST", simUrl(questId), USER_A, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "questionnaire → parkir + pertanyaan pertama ter-render sebagai efek",
  simQuest.body.status === "parked" &&
    simQuest.body.parkReason === "waiting_for_questionnaire_answer" &&
    (simQuest.body.effects ?? []).some(
      (e) => e.kind === "send_message" && String(e.data.text ?? "").includes("Kota asal?"),
    ),
  simQuest.body,
);
const catalogGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "cat", type: "show_catalog", config: { amount: 5, unit: "minutes" } },
    { id: "e", type: "end", config: {} },
  ],
  [
    { from: "t", to: "cat" },
    { from: "cat", to: "e" },
  ],
);
const catalogId = await createFlowWithGraph("Parkir Katalog", catalogGraph);
const simCatalog = await call("POST", simUrl(catalogId), USER_A, {
  triggerText: "katalog",
  contact: { name: "Sari" },
});
check(
  "show_catalog → katalog produk tenant ter-render + parkir pilihan",
  simCatalog.body.status === "parked" &&
    simCatalog.body.parkReason === "waiting_for_catalog_choice" &&
    (simCatalog.body.effects ?? []).some(
      (e) => String(e.data.text ?? "").includes("Kelas Foto"),
    ),
  simCatalog.body,
);
const apptGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "ap", type: "book_appointment", config: { serviceId: "123e4567-e89b-12d3-a456-426614174000" } },
    { id: "e", type: "end", config: {} },
  ],
  [
    { from: "t", to: "ap" },
    { from: "ap", to: "e" },
  ],
);
const apptId = await createFlowWithGraph("Parkir Janji", apptGraph);
const simAppt = await call("POST", simUrl(apptId), USER_A, {
  triggerText: "booking",
  contact: { name: "Sari" },
});
check(
  "book_appointment → parkir slot + efek tawaran tercatat",
  simAppt.body.status === "parked" &&
    simAppt.body.parkReason === "waiting_for_slot_choice" &&
    (simAppt.body.effects ?? []).some(
      (e) => e.kind === "appointment_offer" && e.fidelity === "recorded",
    ),
  simAppt.body,
);
const delayGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "d", type: "delay", config: { mode: "fixed", amount: 2, unit: "hours" } },
    { id: "m", type: "send_message", config: { text: "Sesudah jeda" } },
  ],
  [
    { from: "t", to: "d" },
    { from: "d", to: "m" },
  ],
);
const delayId = await createFlowWithGraph("Delay Tercatat", delayGraph);
const simDelay = await call("POST", simUrl(delayId), USER_A, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "delay 2 jam tercatat sebagai efek (7200000 ms) dan traversal lanjut",
  simDelay.body.status === "completed" &&
    (simDelay.body.effects ?? []).some(
      (e) => e.kind === "delay" && e.data.delayMs === 7200000,
    ) &&
    (simDelay.body.steps ?? []).some((s) => s.nodeId === "m"),
  simDelay.body,
);

// =================================================================
console.log("\n[4] ai_response tanpa provider");
const aiGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "ai", type: "ai_response", config: { template: "Hai {name}" } },
    { id: "e", type: "end", config: {} },
  ],
  [
    { from: "t", to: "ai" },
    { from: "ai", to: "e" },
  ],
);
const aiId = await createFlowWithGraph("AI Tercatat", aiGraph);
const usageBefore = await countRows("usage_ledger");
const messagesBefore = await countRows("messages");
const simAi = await call("POST", simUrl(aiId), USER_A, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
const aiStep = (simAi.body.steps ?? []).find((s) => s.nodeId === "ai");
check(
  "langkah ai_response = simulated / llm_not_called",
  aiStep?.detail.outcome === "simulated" && aiStep?.detail.reason === "llm_not_called",
  aiStep,
);
check(
  "efek ai_response tercatat (recorded)",
  (simAi.body.effects ?? []).some(
    (e) => e.kind === "ai_response" && e.fidelity === "recorded",
  ),
  simAi.body.effects,
);
check(
  "usage_ledger & messages tidak berubah oleh node AI",
  (await countRows("usage_ledger")) === usageBefore &&
    (await countRows("messages")) === messagesBefore,
);

// =================================================================
console.log("\n[5] Sumber versi (G3) + isolasi");
const v1Graph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "m", type: "send_message", config: { text: "Naskah V1 {name}" } },
  ],
  [{ from: "t", to: "m" }],
);
const v2Graph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "m", type: "send_message", config: { text: "Naskah V2 {name}" } },
  ],
  [{ from: "t", to: "m" }],
);
const versionFlowId = await createFlowWithGraph("Sumber Versi", v1Graph);
const actV = await call("POST", `${flowUrl(versionFlowId)}/activate`, USER_A, {});
check("aktivasi sumber versi → versi 1", actV.status === 200 && actV.body.version === 1, actV.body);
await call("POST", `${flowUrl(versionFlowId)}/deactivate`, USER_A, {});
await call("PATCH", flowUrl(versionFlowId), USER_A, { graph: v2Graph });
const simV1 = await call("POST", simUrl(versionFlowId), USER_A, {
  version: 1,
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "simulasi {version:1} memakai snapshot v1 (bukan draf v2)",
  simV1.status === 200 &&
    simV1.body.source?.kind === "version" &&
    simV1.body.source?.version === 1 &&
    (simV1.body.effects ?? []).some((e) => e.data.text === "Naskah V1 Sari"),
  simV1.body,
);
const simStored = await call("POST", simUrl(versionFlowId), USER_A, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "simulasi tanpa sumber → graf tersimpan (v2)",
  simStored.body.source?.kind === "stored" &&
    (simStored.body.effects ?? []).some((e) => e.data.text === "Naskah V2 Sari"),
  simStored.body,
);
const simBoth = await call("POST", simUrl(versionFlowId), USER_A, {
  graph: v2Graph,
  version: 1,
  triggerText: "halo",
  contact: { name: "Sari" },
});
check("graph + version bersamaan → 400", simBoth.status === 400, simBoth.body);
const simV99 = await call("POST", simUrl(versionFlowId), USER_A, {
  version: 99,
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "versi 99 → 404 NOT_FOUND (konvensi rute versi G3)",
  simV99.status === 404 && simV99.body.error?.code === "NOT_FOUND",
  simV99.body,
);
const simCross = await call("POST", simUrl(versionFlowId), USER_B, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
check("pemilik tenant B menyimulasi flow tenant A → 404", simCross.status === 404, simCross.body);
const simOutsider = await call("POST", simUrl(versionFlowId), USER_OUTSIDER, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "non-anggota → 404 TENANT_NOT_FOUND",
  simOutsider.status === 404 && simOutsider.body.error?.code === "TENANT_NOT_FOUND",
  simOutsider.body,
);

// =================================================================
console.log("\n[6] Node tercatat: http/payment/goto/checkout");
const httpGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "h", type: "http_request", config: { method: "GET", url: "https://contoh.id/hook/{name}?kota={{field:kota}}" } },
    { id: "e", type: "end", config: {} },
  ],
  [
    { from: "t", to: "h" },
    { from: "h", to: "e" },
  ],
);
const httpId = await createFlowWithGraph("HTTP Tercatat", httpGraph);
const simHttp = await call("POST", simUrl(httpId), USER_A, {
  triggerText: "halo",
  contact: { name: "Sari", customFields: { kota: "Solo" } },
});
const httpEffect = (simHttp.body.effects ?? []).find((e) => e.kind === "http_request");
check(
  "http_request: URL ter-render {name} + {{field:kota}}, fidelity recorded",
  httpEffect?.fidelity === "recorded" &&
    String(httpEffect?.data.url ?? "").includes("Sari") &&
    String(httpEffect?.data.url ?? "").includes("Solo"),
  httpEffect,
);
const payGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "p", type: "send_payment_link", config: { productId: PRODUCT_ID } },
    { id: "e", type: "end", config: {} },
  ],
  [
    { from: "t", to: "p" },
    { from: "p", to: "e" },
  ],
);
const payId = await createFlowWithGraph("Bayar Tercatat", payGraph);
const linksBefore = await countRows("payment_links");
const simPay = await call("POST", simUrl(payId), USER_A, {
  triggerText: "beli",
  contact: { name: "Sari" },
});
check(
  "send_payment_link → efek payment_link recorded, nol tautan dibuat",
  (simPay.body.effects ?? []).some(
    (e) => e.kind === "payment_link" && e.fidelity === "recorded",
  ) && (await countRows("payment_links")) === linksBefore,
  simPay.body.effects,
);
const gotoGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "g", type: "goto_flow", config: { flowId: condId } },
    { id: "after", type: "send_message", config: { text: "Tidak boleh tampil" } },
  ],
  [
    { from: "t", to: "g" },
    { from: "g", to: "after" },
  ],
);
const gotoId = await createFlowWithGraph("Goto Tercatat", gotoGraph);
const simGoto = await call("POST", simUrl(gotoId), USER_A, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "goto_flow menyelesaikan run asal (node sesudahnya tak dikunjungi)",
  simGoto.body.status === "completed" &&
    !(simGoto.body.steps ?? []).some((s) => s.nodeId === "after") &&
    (simGoto.body.effects ?? []).some(
      (e) => e.kind === "goto_flow" && e.fidelity === "recorded",
    ),
  simGoto.body,
);
const cartGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "co", type: "cart_checkout", config: { emptyMessage: "Keranjang kosong, {name}" } },
    { id: "mh", type: "send_message", config: { text: "Lanjut bayar" } },
    { id: "me", type: "end", config: {} },
  ],
  [
    { from: "t", to: "co" },
    { from: "co", to: "mh", branch: "checked_out" },
    { from: "co", to: "me", branch: "empty_cart" },
  ],
);
const cartId = await createFlowWithGraph("Checkout Mock", cartGraph);
const simCartEmpty = await call("POST", simUrl(cartId), USER_A, {
  triggerText: "checkout",
  contact: { name: "Sari", cartItemCount: 0 },
});
check(
  "keranjang mock kosong → cabang empty + pesan kosong ter-render",
  (simCartEmpty.body.steps ?? []).map((s) => s.nodeId).join(",") === "co,me" &&
    (simCartEmpty.body.effects ?? []).some(
      (e) => e.data.text === "Keranjang kosong, Sari",
    ),
  simCartEmpty.body,
);
const ordersBefore = await countRows("orders");
const simCartFull = await call("POST", simUrl(cartId), USER_A, {
  triggerText: "checkout",
  contact: { name: "Sari", cartItemCount: 2 },
});
check(
  "keranjang mock berisi → cabang has_items + checkout recorded, nol order",
  (simCartFull.body.steps ?? []).map((s) => s.nodeId).join(",") === "co,mh" &&
    (simCartFull.body.effects ?? []).some(
      (e) => e.kind === "checkout" && e.fidelity === "recorded",
    ) &&
    (await countRows("orders")) === ordersBefore,
  simCartFull.body,
);

// =================================================================
console.log("\n[7] Pemicu tak cocok & batas langkah");
const simNoMatch = await call("POST", simUrl(condId), USER_A, {
  triggerText: "salah",
  contact: { name: "Sari" },
});
check(
  "keyword salah → trigger_not_matched tanpa langkah",
  simNoMatch.status === 200 &&
    simNoMatch.body.status === "trigger_not_matched" &&
    simNoMatch.body.triggerMatched === false &&
    (simNoMatch.body.steps ?? []).length === 0,
  simNoMatch.body,
);
const loopGraph = graphOf(
  [
    { id: "t", type: "trigger", config: { kind: "any_message" } },
    { id: "a", type: "send_message", config: { text: "A" } },
    { id: "b", type: "send_message", config: { text: "B" } },
  ],
  [
    { from: "t", to: "a" },
    { from: "a", to: "b" },
    { from: "b", to: "a" },
  ],
);
const loopId = await createFlowWithGraph("Putaran", loopGraph);
const simLoop = await call("POST", simUrl(loopId), USER_A, {
  triggerText: "halo",
  contact: { name: "Sari" },
});
check(
  "graf berputar → failed step_cap_exceeded pada 101 langkah",
  simLoop.body.status === "failed" &&
    simLoop.body.failReason === "step_cap_exceeded" &&
    (simLoop.body.steps ?? []).length === 101,
  { status: simLoop.body.status, steps: (simLoop.body.steps ?? []).length },
);

console.log(`\nverify-flow-simulator: ${passed} PASS, ${failures} FAIL`);
if (failures > 0) process.exit(1);
process.exit(0);
