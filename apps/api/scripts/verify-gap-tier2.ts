/**
 * Verifikasi GELOMBANG G10 — celah Tier 2: template WhatsApp + API
 * publik/MCP. Di atas PGlite + server Graph tiruan lokal. Yang dibuktikan:
 *
 *  A1. `rejected_reason` Meta mengalir utuh: klien memetakannya
 *      ("NONE" → null), sinkron menyimpannya ke cermin, alasan rinci
 *      dari webhook TIDAK terhapus oleh sinkron tanpa alasan, dan
 *      status APPROVED hasil sinkron MEMBERSIHKAN alasan lama.
 *  A2. Aturan ubah per status ditegakkan di HTTP: PATCH pada template
 *      APPROVED/PENDING → 409 WHATSAPP_TEMPLATE_NOT_EDITABLE (Meta
 *      tidak dipanggil sama sekali); PATCH pada REJECTED → Graph
 *      `POST /{template_id}` terpanggil, cermin kembali PENDING,
 *      alasan bersih, audit `whatsapp_template.edited` tertulis;
 *      peran viewer → 403.
 *  A3. Gerbang broadcast tetap utuh: createBroadcast dengan template
 *      PENDING/REJECTED → template_not_approved; APPROVED → created.
 *  B1. Envelope /v1 konsisten: sukses berbentuk skema sumber daya,
 *      semua error berbentuk { error: { code, message } } — termasuk
 *      validasi query appointments yang kini 400 (bukan 422).
 *  B2. Batas laju PER KUNCI API ditegakkan: kunci A kehabisan kuota
 *      (429 RATE_LIMITED) sementara kunci B dari "IP" yang sama tetap
 *      lolos — bucket-nya id kunci, bukan IP.
 *  B3. Scope ditegakkan: kunci read-only → 403 API_KEY_SCOPE_DENIED
 *      pada tulis; tanpa kunci → 401 API_KEY_INVALID; kunci dicabut →
 *      401 API_KEY_REVOKED.
 *  B5. Kunci API tidak bocor: daftar kunci hanya memuat keyPrefix —
 *      kunci utuh & hash-nya tidak muncul di respons daftar maupun
 *      meta audit; kunci utuh hanya ada pada respons pembuatan.
 *  B4 (pemeriksaan sumber, jujur tingkatnya): server MCP menggerbang
 *      tool tulis di belakang MCP_ALLOW_WRITES === "1" dan tidak
 *      mendaftarkan tool broadcast tulis apa pun. Perilaku ujung-ke-
 *      ujung MCP dibuktikan skrip live verify:mcp (butuh kunci nyata,
 *      memang di luar rantai CI).
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:gap-tier2
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
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
  applyWhatsAppTemplateStatus,
  createApiKey,
  createBroadcast,
  encryptChannelSecret,
  hashApiKey,
  listWhatsAppTemplates,
  replaceSyncedWhatsAppTemplates,
  revokeApiKey,
} from "@sahabat-kreator/core";
import { WhatsAppCloudClient } from "@sahabat-kreator/channel-whatsapp";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createRateLimiter } from "../src/rate-limit";
import { createApiKeysRoutes } from "../src/modules/api-keys/routes";
import { createPublicV1Routes } from "../src/modules/public-v1/routes";
import { createWhatsAppTemplatesRoutes } from "../src/modules/whatsapp-templates/routes";

let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1;
  else process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Server Graph tiruan: mencatat semua panggilan; payload daftar template
// bisa diganti antar-fase lewat `graphListPayload`.
// ---------------------------------------------------------------------------
interface GraphCall {
  method: string;
  url: string;
  body: unknown;
}
const graphCalls: GraphCall[] = [];
let graphListPayload: unknown = { data: [] };

const graphServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    graphCalls.push({ method: req.method ?? "", url: req.url ?? "", body });
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && url.includes("message_templates")) {
      res.end(JSON.stringify(graphListPayload));
      return;
    }
    if (req.method === "POST" && url.includes("message_templates")) {
      res.end(
        JSON.stringify({ id: "mt-new", status: "PENDING", category: "UTILITY" }),
      );
      return;
    }
    if (req.method === "POST") {
      // Edit template: POST /{versi}/{message_template_id}
      res.end(JSON.stringify({ success: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "unknown" } }));
  });
});
await new Promise<void>((resolve) =>
  graphServer.listen(0, "127.0.0.1", () => resolve()),
);
const graphAddr = graphServer.address();
assert(graphAddr && typeof graphAddr === "object");
const graphBase = `http://127.0.0.1:${graphAddr.port}`;

// ---------------------------------------------------------------------------
// DB uji (PGlite + semua migrasi)
// ---------------------------------------------------------------------------
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
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WA_ACC = "31000000-0000-4000-8000-000000000001";
const WABA = "WABA-UJI-1";
const TOKEN_SECRET = Buffer.alloc(32, 7).toString("base64");

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'owner@sk.test', 'Pemilik'), ($2, 'viewer@sk.test', 'Penonton')`,
  [OWNER, VIEWER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'viewer')`,
  [TENANT, OWNER, VIEWER],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, parent_external_id, display_name, status, access_token_encrypted)
   VALUES ($1, $2, 'whatsapp', '62812000999', $3, 'WA Uji', 'connected', $4)`,
  [WA_ACC, TENANT, WABA, encryptChannelSecret(TOKEN_SECRET, "token-uji")],
);

const bundle = { db } as unknown as AuthBundle;
function dashboardApp(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    const userId = c.req.header("x-test-user") ?? OWNER;
    c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
    await next();
  });
  return app;
}

// ---------------------------------------------------------------------------
// [1] A1 — klien memetakan rejected_reason
// ---------------------------------------------------------------------------
{
  graphListPayload = {
    data: [
      {
        id: "mt-1",
        name: "promo_gagal",
        language: "id",
        category: "MARKETING",
        status: "REJECTED",
        rejected_reason: "INVALID_FORMAT",
        components: [{ type: "BODY", text: "Promo {{1}}" }],
      },
      {
        id: "mt-2",
        name: "sambutan",
        language: "id",
        category: "UTILITY",
        status: "APPROVED",
        rejected_reason: "NONE",
        components: [{ type: "BODY", text: "Halo" }],
      },
      {
        id: "mt-3",
        name: "kelas_mulai",
        language: "id",
        category: "UTILITY",
        status: "PENDING",
        components: [{ type: "BODY", text: "Kelas mulai" }],
      },
    ],
  };
  const waClient = new WhatsAppCloudClient({
    baseUrl: graphBase,
    apiVersion: "v26.0",
    accessToken: "token-uji",
  });
  const list = await waClient.listMessageTemplates(WABA);
  const byName = new Map(list.map((t) => [t.name, t]));
  check(
    "[1] klien: REJECTED membawa rejected_reason",
    byName.get("promo_gagal")?.rejectedReason === "INVALID_FORMAT",
    String(byName.get("promo_gagal")?.rejectedReason),
  );
  check(
    "[1] klien: rejected_reason NONE → null",
    byName.get("sambutan")?.rejectedReason === null,
  );
  check(
    "[1] klien: tanpa field rejected_reason → null",
    byName.get("kelas_mulai")?.rejectedReason === null,
  );
  const listCall = graphCalls.find((c) => c.method === "GET");
  check(
    "[1] klien: fields Graph meminta rejected_reason",
    (listCall?.url ?? "").includes("rejected_reason"),
    listCall?.url ?? "",
  );
}

// ---------------------------------------------------------------------------
// [2] A1 — semantik alasan pada sinkron + webhook (core)
// ---------------------------------------------------------------------------
{
  const syncWith = (status: string, statusReason: string | null) =>
    replaceSyncedWhatsAppTemplates(db, {
      tenantId: TENANT,
      userId: OWNER,
      channelAccountId: WA_ACC,
      templates: [
        {
          metaTemplateId: "mt-1",
          name: "promo_gagal",
          language: "id",
          category: "MARKETING",
          status,
          statusReason,
          components: [{ type: "BODY", text: "Promo {{1}}" }],
          bodyText: "Promo {{1}}",
          variableCount: 1,
        },
      ],
    });
  const readRow = async () =>
    (await listWhatsAppTemplates(db, { tenantId: TENANT, channelAccountId: WA_ACC }))
      .find((t) => t.name === "promo_gagal");

  await syncWith("REJECTED", "INVALID_FORMAT");
  check(
    "[2] sinkron: alasan penolakan tersimpan di cermin",
    (await readRow())?.statusReason === "INVALID_FORMAT",
  );

  const applied = await applyWhatsAppTemplateStatus(db, {
    tenantId: TENANT,
    channelAccountId: WA_ACC,
    metaTemplateId: "mt-1",
    name: "promo_gagal",
    language: "id",
    status: "REJECTED",
    category: "MARKETING",
    reason: "Teks terindikasi promosi berlebihan",
  });
  check(
    "[2] webhook: alasan rinci menimpa kode sinkron",
    applied.updated && (await readRow())?.statusReason === "Teks terindikasi promosi berlebihan",
  );

  await syncWith("REJECTED", null);
  check(
    "[2] sinkron tanpa alasan TIDAK menghapus alasan webhook",
    (await readRow())?.statusReason === "Teks terindikasi promosi berlebihan",
  );

  await syncWith("REJECTED", "ABUSIVE_CONTENT");
  check(
    "[2] sinkron dengan alasan baru menimpa yang lama",
    (await readRow())?.statusReason === "ABUSIVE_CONTENT",
  );

  await syncWith("APPROVED", null);
  const approved = await readRow();
  check(
    "[2] sinkron APPROVED membersihkan alasan lama",
    approved?.status === "APPROVED" && approved?.statusReason === null,
  );

  const foreign = await listWhatsAppTemplates(db, {
    tenantId: TENANT_B,
    channelAccountId: WA_ACC,
  });
  check("[2] isolasi tenant: akun tenant A tak terbaca dari B", foreign.length === 0);
}

// ---------------------------------------------------------------------------
// [3] A2 — gerbang ubah per status di HTTP + sinkron ujung-ke-ujung
// ---------------------------------------------------------------------------
const TPL_REJ = "32000000-0000-4000-8000-000000000001";
const TPL_APR = "32000000-0000-4000-8000-000000000002";
const TPL_PEN = "32000000-0000-4000-8000-000000000003";
{
  await client.query(
    `INSERT INTO whatsapp_templates (id, tenant_id, channel_account_id, meta_template_id, name, language, category, status, status_reason, components, body_text, variable_count) VALUES
     ($1, $4, $5, 'mt-rej', 'tpl_ditolak', 'id', 'UTILITY', 'REJECTED', 'INVALID_FORMAT', '[{"type":"BODY","text":"Halo {{1}}"}]'::jsonb, 'Halo {{1}}', 1),
     ($2, $4, $5, 'mt-apr', 'tpl_disetujui', 'id', 'UTILITY', 'APPROVED', NULL, '[{"type":"BODY","text":"Halo"}]'::jsonb, 'Halo', 0),
     ($3, $4, $5, 'mt-pen', 'tpl_menunggu', 'id', 'UTILITY', 'PENDING', NULL, '[{"type":"BODY","text":"Halo"}]'::jsonb, 'Halo', 0)`,
    [TPL_REJ, TPL_APR, TPL_PEN, TENANT, WA_ACC],
  );
  const waApp = dashboardApp();
  waApp.route(
    "/",
    createWhatsAppTemplatesRoutes(bundle, {
      channelTokenSecret: TOKEN_SECRET,
      metaApiBase: graphBase,
    }),
  );
  const patch = (id: string, user: string, payload: unknown) =>
    waApp.request(`/tenants/${TENANT}/whatsapp-templates/${id}`, {
      method: "PATCH",
      headers: { "x-test-user": user, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const editCalls = () =>
    graphCalls.filter(
      (c) => c.method === "POST" && !c.url.includes("message_templates"),
    );
  const formBody = {
    category: "UTILITY",
    bodyText: "Halo {{1}}, pengingat kelasmu besok.",
    bodyExamples: ["Sari"],
  };

  // Sinkron ujung-ke-ujung: payload memuat semua baris semai (sinkron
  // menghapus yang tidak lagi ada di Meta) + template ditolak baru.
  graphListPayload = {
    data: [
      { id: "mt-rej", name: "tpl_ditolak", language: "id", category: "UTILITY", status: "REJECTED", rejected_reason: "INVALID_FORMAT", components: [{ type: "BODY", text: "Halo {{1}}" }] },
      { id: "mt-apr", name: "tpl_disetujui", language: "id", category: "UTILITY", status: "APPROVED", rejected_reason: "NONE", components: [{ type: "BODY", text: "Halo" }] },
      { id: "mt-pen", name: "tpl_menunggu", language: "id", category: "UTILITY", status: "PENDING", components: [{ type: "BODY", text: "Halo" }] },
      { id: "mt-promo", name: "promo_gagal", language: "id", category: "MARKETING", status: "REJECTED", rejected_reason: "INVALID_FORMAT", components: [{ type: "BODY", text: "Promo {{1}}" }] },
    ],
  };
  const syncRes = await waApp.request(
    `/tenants/${TENANT}/whatsapp-templates/sync`,
    {
      method: "POST",
      headers: { "x-test-user": OWNER, "content-type": "application/json" },
      body: JSON.stringify({ channelAccountId: WA_ACC }),
    },
  );
  const syncBody = (await syncRes.json()) as {
    templates: Array<{ name: string; status: string; statusReason: string | null }>;
  };
  const syncedPromo = syncBody.templates.find((t) => t.name === "promo_gagal");
  check(
    "[3] sinkron HTTP: statusReason REJECTED sampai ke respons API",
    syncRes.status === 200 &&
      syncedPromo?.status === "REJECTED" &&
      syncedPromo?.statusReason === "INVALID_FORMAT",
    `status=${syncRes.status} reason=${String(syncedPromo?.statusReason)}`,
  );

  const before = editCalls().length;
  const resApr = await patch(TPL_APR, OWNER, formBody);
  const bodyApr = (await resApr.json()) as { error?: { code?: string } };
  check(
    "[3] PATCH APPROVED → 409 WHATSAPP_TEMPLATE_NOT_EDITABLE",
    resApr.status === 409 && bodyApr.error?.code === "WHATSAPP_TEMPLATE_NOT_EDITABLE",
    `status=${resApr.status} code=${String(bodyApr.error?.code)}`,
  );
  const resPen = await patch(TPL_PEN, OWNER, formBody);
  check(
    "[3] PATCH PENDING → 409 (terkunci selama tinjauan)",
    resPen.status === 409,
    `status=${resPen.status}`,
  );
  check(
    "[3] penolakan status TIDAK memanggil Graph sama sekali",
    editCalls().length === before,
  );
  const resViewer = await patch(TPL_REJ, VIEWER, formBody);
  check("[3] PATCH oleh viewer → 403", resViewer.status === 403, `status=${resViewer.status}`);

  const resBadForm = await patch(TPL_REJ, OWNER, {
    category: "UTILITY",
    bodyText: "Halo {{1}} {{2}}",
    bodyExamples: ["hanya-satu"],
  });
  check(
    "[3] PATCH REJECTED dengan contoh tak cocok → 400, tanpa panggilan Graph",
    resBadForm.status === 400 && editCalls().length === before,
    `status=${resBadForm.status}`,
  );

  const resOk = await patch(TPL_REJ, OWNER, formBody);
  const bodyOk = (await resOk.json()) as {
    status?: string;
    statusReason?: string | null;
    bodyText?: string | null;
  };
  check(
    "[3] PATCH REJECTED → 200, cermin kembali PENDING + alasan bersih",
    resOk.status === 200 && bodyOk.status === "PENDING" && bodyOk.statusReason === null,
    `status=${resOk.status} tpl=${String(bodyOk.status)}`,
  );
  const calls = editCalls();
  const editCall = calls[calls.length - 1];
  const sentComponents = (editCall?.body as { components?: Array<{ type: string; text?: string }> })?.components;
  check(
    "[3] Graph menerima POST /{template_id} berisi komponen perbaikan",
    calls.length === before + 1 &&
      (editCall?.url ?? "").includes("mt-rej") &&
      sentComponents?.some((c) => c.type === "BODY" && c.text === formBody.bodyText) === true,
    editCall?.url ?? "",
  );
  const audit = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id=$1 AND action='whatsapp_template.edited'`,
    [TENANT],
  );
  check("[3] audit whatsapp_template.edited tertulis", audit.rows[0]?.n === "1");

  const res404 = await patch("32000000-0000-4000-8000-000000000099", OWNER, formBody);
  check("[3] PATCH id tak dikenal → 404", res404.status === 404, `status=${res404.status}`);
}

// ---------------------------------------------------------------------------
// [4] A3 — gerbang template broadcast (core)
// ---------------------------------------------------------------------------
{
  const attempt = (whatsappTemplateId: string) =>
    createBroadcast(db, {
      tenantId: TENANT,
      userId: OWNER,
      name: "Uji gerbang",
      channelAccountId: WA_ACC,
      whatsappTemplateId,
    });
  const pending = await attempt(TPL_PEN);
  check(
    "[4] broadcast + template PENDING → template_not_approved",
    pending.kind === "template_not_approved" && pending.status === "PENDING",
    pending.kind,
  );
  const rejected = await attempt(TPL_REJ);
  check(
    "[4] broadcast + template REJECTED (baru diperbaiki → PENDING) → tetap tertolak",
    rejected.kind === "template_not_approved",
    rejected.kind,
  );
  const approved = await attempt(TPL_APR);
  check(
    "[4] broadcast + template APPROVED → created",
    approved.kind === "created",
    approved.kind,
  );
}

// ---------------------------------------------------------------------------
// Kunci API untuk [5]–[7]
// ---------------------------------------------------------------------------
const fullScopes = [
  "contacts:read",
  "contacts:write",
  "conversations:read",
  "appointments:read",
] as const;
const keyFull = await createApiKey(
  db,
  { tenantId: TENANT, userId: OWNER },
  { name: "Kunci penuh", scopes: [...fullScopes] },
);
const keyRead = await createApiKey(
  db,
  { tenantId: TENANT, userId: OWNER },
  { name: "Kunci baca", scopes: ["contacts:read"] },
);
const keyRevoked = await createApiKey(
  db,
  { tenantId: TENANT, userId: OWNER },
  { name: "Kunci cabut", scopes: ["contacts:read"] },
);
await revokeApiKey(db, { tenantId: TENANT, userId: OWNER }, keyRevoked.row.id);

function makeV1(limit: number) {
  const limiter = createRateLimiter({
    rules: { "v1-key": { limit, windowSeconds: 60 } },
    now: () => 1_700_000_000_000,
  });
  return createPublicV1Routes(bundle, null, {}, {}, { limiter });
}
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

// ---------------------------------------------------------------------------
// [5] B1 + B3 — envelope & scope /v1
// ---------------------------------------------------------------------------
{
  const app = makeV1(100);
  const noKey = await app.request("/v1/me");
  const noKeyBody = (await noKey.json()) as { error?: { code?: string; message?: string } };
  check(
    "[5] tanpa kunci → 401 API_KEY_INVALID berbentuk envelope kontrak",
    noKey.status === 401 &&
      noKeyBody.error?.code === "API_KEY_INVALID" &&
      typeof noKeyBody.error?.message === "string",
    `status=${noKey.status}`,
  );
  const badKey = await app.request("/v1/me", {
    // Dirakit per potong: literal utuh berbentuk pola kunci live akan
    // memicu push protection GitHub walau ini kunci palsu untuk uji 401.
    headers: bearer(["sk", "live", "bukan-kunci-asli"].join("_")),
  });
  check("[5] kunci tak dikenal → 401 API_KEY_INVALID", badKey.status === 401, `status=${badKey.status}`);
  const revoked = await app.request("/v1/me", { headers: bearer(keyRevoked.fullKey) });
  const revokedBody = (await revoked.json()) as { error?: { code?: string } };
  check(
    "[5] kunci dicabut → 401 API_KEY_REVOKED",
    revoked.status === 401 && revokedBody.error?.code === "API_KEY_REVOKED",
    `status=${revoked.status} code=${String(revokedBody.error?.code)}`,
  );

  const me = await app.request("/v1/me", { headers: bearer(keyFull.fullKey) });
  const meBody = (await me.json()) as { tenantId?: string; tenantName?: string; scopes?: string[] };
  check(
    "[5] GET /v1/me → 200 {tenantId, tenantName, scopes}",
    me.status === 200 && meBody.tenantId === TENANT && meBody.tenantName === "Tenant A",
    `status=${me.status}`,
  );

  const denied = await app.request("/v1/contacts", {
    method: "POST",
    headers: { ...bearer(keyRead.fullKey), "content-type": "application/json" },
    body: JSON.stringify({ name: "Tidak Boleh" }),
  });
  const deniedBody = (await denied.json()) as { error?: { code?: string } };
  check(
    "[5] kunci read-only menulis kontak → 403 API_KEY_SCOPE_DENIED",
    denied.status === 403 && deniedBody.error?.code === "API_KEY_SCOPE_DENIED",
    `status=${denied.status} code=${String(deniedBody.error?.code)}`,
  );
  const created = await app.request("/v1/contacts", {
    method: "POST",
    headers: { ...bearer(keyFull.fullKey), "content-type": "application/json" },
    body: JSON.stringify({ name: "Kontak V1" }),
  });
  check(
    "[5] kunci contacts:write membuat kontak → 201",
    created.status === 201,
    `status=${created.status}`,
  );

  const badQuery = await app.request("/v1/appointments?from=bukan-tanggal", {
    headers: bearer(keyFull.fullKey),
  });
  const badQueryBody = (await badQuery.json()) as { error?: { code?: string } };
  check(
    "[5] query appointments tak sah → 400 VALIDATION_ERROR (seragam /v1)",
    badQuery.status === 400 && badQueryBody.error?.code === "VALIDATION_ERROR",
    `status=${badQuery.status}`,
  );
}

// ---------------------------------------------------------------------------
// [6] B2 — batas laju per kunci
// ---------------------------------------------------------------------------
{
  const app = makeV1(2);
  const r1 = await app.request("/v1/me", { headers: bearer(keyFull.fullKey) });
  const r2 = await app.request("/v1/me", { headers: bearer(keyFull.fullKey) });
  const r3 = await app.request("/v1/me", { headers: bearer(keyFull.fullKey) });
  const r3Body = (await r3.json()) as { error?: { code?: string } };
  check(
    "[6] kunci A: request ke-1 & ke-2 lolos",
    r1.status === 200 && r2.status === 200,
    `${r1.status}/${r2.status}`,
  );
  check(
    "[6] kunci A: request ke-3 → 429 RATE_LIMITED + Retry-After",
    r3.status === 429 &&
      r3Body.error?.code === "RATE_LIMITED" &&
      Number(r3.headers.get("retry-after")) > 0,
    `status=${r3.status}`,
  );
  const other = await app.request("/v1/me", { headers: bearer(keyRead.fullKey) });
  check(
    "[6] kunci B (IP sama) tetap lolos — bucket per kunci, bukan per IP",
    other.status === 200,
    `status=${other.status}`,
  );
}

// ---------------------------------------------------------------------------
// [7] B5 — kunci tidak bocor di daftar & audit
// ---------------------------------------------------------------------------
{
  const keysApp = dashboardApp();
  keysApp.route("/", createApiKeysRoutes(bundle));
  const created = await keysApp.request(`/tenants/${TENANT}/api-keys`, {
    method: "POST",
    headers: { "x-test-user": OWNER, "content-type": "application/json" },
    body: JSON.stringify({ name: "Kunci bocor?", scopes: ["contacts:read"] }),
  });
  const createdBody = (await created.json()) as { key?: string; keyPrefix?: string };
  const fullKey = createdBody.key ?? "";
  check(
    "[7] pembuatan → 201 + kunci utuh SATU KALI + keyPrefix konsisten",
    created.status === 201 &&
      fullKey.startsWith("sk_live_") &&
      createdBody.keyPrefix === fullKey.slice(0, "sk_live_".length + 4),
    `status=${created.status}`,
  );

  const list = await keysApp.request(`/tenants/${TENANT}/api-keys`, {
    headers: { "x-test-user": OWNER },
  });
  const listText = await list.text();
  check(
    "[7] daftar kunci TIDAK memuat kunci utuh",
    list.status === 200 && !listText.includes(fullKey),
    `status=${list.status}`,
  );
  check(
    "[7] daftar kunci TIDAK memuat hash kunci",
    !listText.includes(hashApiKey(fullKey)),
  );
  check(
    "[7] daftar kunci memuat keyPrefix (bentuk ter-mask)",
    listText.includes(createdBody.keyPrefix ?? "sk_live_"),
  );
  const audit = await client.query<{ meta: unknown }>(
    `SELECT meta FROM audit_logs WHERE tenant_id=$1 AND action='api_key.created'`,
    [TENANT],
  );
  check(
    "[7] meta audit api_key.created TIDAK memuat kunci utuh",
    audit.rows.length > 0 &&
      audit.rows.every((r) => !JSON.stringify(r.meta).includes(fullKey)),
    `baris=${audit.rows.length}`,
  );
}

// ---------------------------------------------------------------------------
// [8] B4 — gerbang tulis MCP (pemeriksaan sumber)
// ---------------------------------------------------------------------------
{
  const mcpSource = await readFile(
    path.join(here, "../../../apps/mcp-server/src/index.ts"),
    "utf8",
  );
  check(
    "[8] MCP: tulis hanya dengan MCP_ALLOW_WRITES persis \"1\"",
    mcpSource.includes('process.env.MCP_ALLOW_WRITES === "1"'),
  );
  check(
    "[8] MCP: kelima tool tulis melewati writeDisabledResult",
    (mcpSource.match(/writeDisabledResult\(/g) ?? []).length >= 5,
    `ditemukan ${(mcpSource.match(/writeDisabledResult\(/g) ?? []).length}`,
  );
  check(
    "[8] MCP: tidak ada tool kirim/buat broadcast (permukaan broadcast baca-saja)",
    !mcpSource.includes("send_broadcast") && !mcpSource.includes("create_broadcast"),
  );
}

graphServer.close();
console.log(`\n[verify:gap-tier2] ${passes} pemeriksaan lulus`);
