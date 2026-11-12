/**
 * Uji integrasi KONVERSI IKLAN DARI FLOW (Gelombang G16) di atas
 * PGlite — node flow `send_ad_conversion` mengirim peristiwa
 * konversi ke Meta Conversions API + Google Ads milik tenant.
 * Yang dibuktikan:
 *  1. Koneksi tenant: token Meta tersimpan TERENKRIPSI (baris DB
 *     tidak memuat nilai terang), view TIDAK pernah membawa token,
 *     customer ID Google dinormalisasi ke digit, audit tanpa nilai.
 *  2. Payload Meta murni: hash pengenal benar (email trim+lowercase,
 *     telepon digit kode negara, external_id = id kontak), custom
 *     value/currency, test_event_code terpasang, event_id
 *     deterministik dari (run, node).
 *  3. Executor: run flow mencapai node → langkah `queued`, baris
 *     ledger + SATU event outbox lahir; nilai dari konteks NYATA
 *     (deal terbaru mengalahkan order lunas yang lebih lama;
 *     order lebih segar mengalahkan deal; statis; tanpa nilai).
 *     Antre ulang (run, node) yang sama → already_queued, tanpa
 *     baris/outbox kedua (dedup).
 *  4. Pengiriman Meta sukses: URL + token benar, badan sesuai
 *     payload, baris sent + log integrasi meta_capi; kirim ulang →
 *     already_sent tanpa panggilan jaringan kedua.
 *  5. Kegagalan Meta (HTTP 400) tercatat failed + pesan provider di
 *     baris; run flow yang sudah completed TIDAK berubah.
 *  6. Google tanpa pengenal (tanpa email/telepon, tanpa gclid) →
 *     skipped `google_no_identifier`, jaringan TIDAK dipanggil.
 *  7. Google sukses: uploadClickConversions enhanced — header
 *     developer-token platform + Bearer token OAuth layanan 'ads',
 *     conversionAction resource name, orderId = event_id, hash
 *     email + telepon E.164 benar.
 *  8. Google tanpa developer token platform → failed
 *     `google_developer_token_missing`; tenant tanpa koneksi OAuth
 *     ads → failed `google_ads_not_connected`; Meta tenant tanpa
 *     koneksi → failed `meta_not_configured`.
 *  9. Isolasi tenant: ledger & koneksi tenant A tidak terlihat dari
 *     konteks tenant B.
 * 10. Validasi aktivasi node (AD_*) + simulator mencatat efek
 *     `ad_conversion` tanpa panggilan jaringan apa pun.
 *
 * Semua panggilan platform memakai fetch TIRUAN yang mencatat —
 * tidak ada API iklan sungguhan yang ditembak.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:ad-conversions
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  activateFlow,
  adConversionEventId,
  buildAdConversionUserData,
  buildMetaCapiPayload,
  clearPlatformSetting,
  clearPlatformSettingsCache,
  createFlow,
  deliverAdConversion,
  encryptChannelSecret,
  executeFlowStep,
  getAdConnections,
  listAdConversionEvents,
  queueAdConversionTx,
  resolveAdConversionValueTx,
  setPlatformSetting,
  simulateFlowRun,
  updateAdConnections,
  validateFlowNodeConfig,
  withTenantDb,
  type AdConversionDeps,
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
console.log(`[setup] migrasi teraplikasi: ${files.length} file`);

const db = drizzle(client, { schema }) as unknown as Database;

const TENANT = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "55555555-5555-4555-8555-555555555555";
const CONTACT = "66666666-6666-4666-8666-666666666666";
const CONTACT_NO_ID = "66666666-6666-4666-8666-666666666667";
const CONTACT_B = "66666666-6666-4666-8666-666666666668";
const CONVERSATION = "77777777-7777-4777-8777-777777777777";
const PIPELINE = "99999999-9999-4999-8999-999999999991";
const STAGE = "99999999-9999-4999-8999-999999999992";

const ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString("base64");
const MASTER_SECRET = Buffer.alloc(32, 9).toString("base64");
const META_TOKEN = "<redacted>";
const GOOGLE_ACCESS = "ya29.token-oauth-ads-uji";
const DEV_TOKEN = "<redacted>";

const sha256 = (v: string) =>
  createHash("sha256").update(v, "utf8").digest("hex");

// Fetch tiruan: mencatat panggilan; respons diatur per skenario.
interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}
const fetchCalls: FetchCall[] = [];
let fetchResponder: (call: FetchCall) => { status: number; body?: unknown } =
  () => ({ status: 200, body: { events_received: 1 } });
const fetchFn = (async (
  url: unknown,
  init?: { headers?: Record<string, string>; body?: string },
) => {
  const call: FetchCall = {
    url: String(url),
    headers: init?.headers ?? {},
    body: init?.body ?? "",
  };
  fetchCalls.push(call);
  const outcome = fetchResponder(call);
  return {
    status: outcome.status,
    json: async () => outcome.body ?? {},
  } as Response;
}) as unknown as typeof fetch;

const platformOpts = { masterSecret: MASTER_SECRET, env: {} };
const deps: AdConversionDeps = {
  tokenSecret: ENCRYPTION_SECRET,
  platform: platformOpts,
  metaApiBase: "https://graph.example.test",
  googleBases: {
    adsBase: "https://ads.example.test",
    apiBase: "https://google.example.test",
    tokenBase: "https://token.example.test",
  },
  fetchImpl: fetchFn,
};

await client.query(
  `INSERT INTO tenants (id, name, slug, timezone) VALUES ($1, 'Tenant Uji', 'tenant-uji', 'Asia/Jakarta'), ($2, 'Tenant Lain', 'tenant-lain', 'Asia/Jakarta')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'owner@example.com', 'Owner Uji')`,
  [OWNER],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'telegram', 'tg_uji', 'connected')`,
  [ACCOUNT, TENANT],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name, email, phone) VALUES
     ($1, $3, 'Sari Uji', '  Sari@Example.COM ', '0812-3456-7890'),
     ($2, $3, 'Polos Uji', NULL, NULL)`,
  [CONTACT, CONTACT_NO_ID, TENANT],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name, email) VALUES ($1, $2, 'Bima Lain', 'bima@example.com')`,
  [CONTACT_B, TENANT_B],
);
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
   VALUES ($1, $2, $3, $4, 'telegram', 'chat-1', 'private', 'open')`,
  [CONVERSATION, TENANT, ACCOUNT, CONTACT],
);
// Deal untuk konteks nilai: deal terbaru (updated_at kini) vs order
// lunas yang lebih lama → deal harus menang.
await client.query(
  `INSERT INTO deal_pipelines (id, tenant_id, name) VALUES ($1, $2, 'Sales')`,
  [PIPELINE, TENANT],
);
await client.query(
  `INSERT INTO deal_stages (id, tenant_id, pipeline_id, name, kind, position) VALUES ($1, $2, $3, 'Baru', 'open', 0)`,
  [STAGE, TENANT, PIPELINE],
);
await client.query(
  `INSERT INTO deals (id, tenant_id, pipeline_id, stage_id, contact_id, title, value, currency, status, updated_at)
   VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Deal Sari', 75000, 'IDR', 'open', now())`,
  [TENANT, PIPELINE, STAGE, CONTACT],
);
await client.query(
  `INSERT INTO orders (id, tenant_id, contact_id, status, total_idr, paid_at)
   VALUES (gen_random_uuid(), $1, $2, 'paid', 50000, now() - interval '2 days')`,
  [TENANT, CONTACT],
);

// ---------------------------------------------------------------------------
// [1] Koneksi tenant: terenkripsi + view tanpa token + normalisasi
// ---------------------------------------------------------------------------
const upd = await updateAdConnections(
  db,
  TENANT,
  {
    metaDatasetId: "1234567890",
    metaAccessToken: META_TOKEN,
    metaTestEventCode: "TEST999",
    googleCustomerId: "123-456-7890",
    googleConversionActionId: "987654321",
  },
  { actorType: "user", actorId: OWNER },
  deps,
);
assert.equal(upd.kind, "ok", JSON.stringify(upd));
if (upd.kind !== "ok") throw new Error("update koneksi gagal");
assert.equal(upd.view.meta.datasetId, "1234567890");
assert.equal(upd.view.meta.accessTokenConfigured, true);
assert.equal(upd.view.meta.ready, true);
assert.equal(upd.view.google.customerId, "1234567890", "strip customer ID dibuang");
assert.equal(upd.view.google.conversionActionId, "987654321");
assert.equal(
  JSON.stringify(upd.view).includes(META_TOKEN),
  false,
  "view TIDAK memuat token",
);
const rawConn = await client.query<{ meta_access_token_encrypted: string }>(
  `SELECT meta_access_token_encrypted FROM ad_connections WHERE tenant_id = $1`,
  [TENANT],
);
assert.ok(rawConn.rows[0].meta_access_token_encrypted.startsWith("v1:"));
assert.equal(
  rawConn.rows[0].meta_access_token_encrypted.includes(META_TOKEN),
  false,
  "baris DB TIDAK memuat token terang",
);
const audit = await client.query<{ meta: { changedFields?: string[] } }>(
  `SELECT meta FROM audit_logs WHERE tenant_id = $1 AND action = 'ad_connections.updated'`,
  [TENANT],
);
assert.equal(audit.rows.length, 1);
assert.equal(
  JSON.stringify(audit.rows[0].meta).includes(META_TOKEN),
  false,
  "audit TIDAK memuat token",
);
console.log("[1] koneksi tenant terenkripsi + view/audit tanpa token: OK");

// ---------------------------------------------------------------------------
// [2] Payload Meta murni + event_id deterministik
// ---------------------------------------------------------------------------
const userData = buildAdConversionUserData({
  id: CONTACT,
  email: "  Sari@Example.COM ",
  phone: "0812-3456-7890",
});
assert.equal(userData.emailHash, sha256("sari@example.com"));
assert.equal(userData.phoneHash, sha256("6281234567890"));
assert.equal(userData.phoneE164Hash, sha256("+6281234567890"));
assert.equal(userData.externalIdHash, sha256(CONTACT));
const payload = buildMetaCapiPayload({
  eventName: "Lead",
  eventId: "evt_uji",
  occurredAt: new Date("2026-11-13T02:00:00.000Z"),
  userData,
  value: 75000,
  currency: "IDR",
  testEventCode: "TEST999",
});
assert.equal(payload.data[0].event_name, "Lead");
assert.equal(payload.data[0].event_time, 1794535200);
assert.equal(payload.data[0].action_source, "system_generated");
assert.deepEqual(payload.data[0].user_data.em, [sha256("sari@example.com")]);
assert.deepEqual(payload.data[0].user_data.ph, [sha256("6281234567890")]);
assert.deepEqual(payload.data[0].custom_data, { value: 75000, currency: "IDR" });
assert.equal(payload.test_event_code, "TEST999");
const RUN_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
assert.equal(
  adConversionEventId(RUN_X, "conv"),
  adConversionEventId(RUN_X, "conv"),
  "event_id stabil untuk (run, node) yang sama",
);
assert.notEqual(
  adConversionEventId(RUN_X, "conv"),
  adConversionEventId(RUN_X, "conv2"),
  "node berbeda → event_id berbeda",
);
console.log("[2] payload Meta + hash pengenal + event_id deterministik: OK");

// ---------------------------------------------------------------------------
// [3] Executor: node mengantrrekan ledger + outbox; nilai konteks nyata
// ---------------------------------------------------------------------------
const graph = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      config: { kind: "keyword", keywords: ["IKLAN"], match: "exact" },
    },
    {
      id: "conv",
      type: "send_ad_conversion",
      config: { platform: "meta", eventName: "Lead" },
    },
    { id: "e", type: "end", config: {} },
  ],
  edges: [
    { from: "t", to: "conv" },
    { from: "conv", to: "e" },
  ],
};
const created = await createFlow(db, {
  tenantId: TENANT,
  userId: OWNER,
  name: "Flow konversi",
  graph: graph as never,
});
assert.equal(created.kind, "created", JSON.stringify(created));
if (created.kind !== "created") throw new Error("flow tidak terbuat");
const act = await activateFlow(db, {
  tenantId: TENANT,
  userId: OWNER,
  flowId: created.flow.id,
});
assert.equal(act.kind, "activated", JSON.stringify(act));
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
await client.query(
  `INSERT INTO flow_runs (id, tenant_id, flow_id, conversation_id, contact_id, current_node_id, context)
   VALUES ($1, $2, $3, $4, $5, 't', '{"triggerText":"IKLAN"}'::jsonb)`,
  [RUN, TENANT, created.flow.id, CONVERSATION, CONTACT],
);
for (let i = 0; i < 8; i++) {
  const cur = await client.query<{ next_step_seq: number; status: string }>(
    `SELECT next_step_seq, status FROM flow_runs WHERE id = $1`,
    [RUN],
  );
  if (cur.rows[0].status === "completed" || cur.rows[0].status === "failed") {
    break;
  }
  await executeFlowStep(db, {
    tenantId: TENANT,
    runId: RUN,
    stepSeq: cur.rows[0].next_step_seq,
  });
}
const runRow = await client.query<{ status: string }>(
  `SELECT status FROM flow_runs WHERE id = $1`,
  [RUN],
);
assert.equal(runRow.rows[0].status, "completed");
const stepRow = await client.query<{ detail: Record<string, unknown> }>(
  `SELECT detail FROM flow_run_steps WHERE run_id = $1 AND node_type = 'send_ad_conversion'`,
  [RUN],
);
assert.equal(stepRow.rows.length, 1);
assert.equal(stepRow.rows[0].detail.outcome, "queued");
assert.equal(stepRow.rows[0].detail.value, 75000, "deal terbaru mengalahkan order lama");
assert.equal(stepRow.rows[0].detail.valueSource, "deal");
const expectedEventId = adConversionEventId(RUN, "conv");
assert.equal(stepRow.rows[0].detail.eventId, expectedEventId);
const ledger = await client.query<{
  id: string;
  status: string;
  event_id: string;
  user_data: Record<string, string>;
}>(
  `SELECT id, status, event_id, user_data FROM ad_conversion_events WHERE tenant_id = $1`,
  [TENANT],
);
assert.equal(ledger.rows.length, 1);
assert.equal(ledger.rows[0].status, "queued");
assert.equal(ledger.rows[0].event_id, expectedEventId);
assert.equal(ledger.rows[0].user_data.emailHash, sha256("sari@example.com"));
const outbox = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM outbox_events WHERE tenant_id = $1 AND type = 'ad_conversion.requested'`,
  [TENANT],
);
assert.equal(outbox.rows[0].n, "1", "tepat satu event outbox");
// Dedup: antrekan (run, node) yang sama sekali lagi di transaksi baru.
const again = await withTenantDb(db, TENANT, (tx) =>
  queueAdConversionTx(tx, {
    tenantId: TENANT,
    platform: "meta",
    eventName: "Lead",
    flowId: created.flow.id,
    runId: RUN,
    nodeId: "conv",
    contactId: CONTACT,
    userData,
    value: { value: 75000, currency: "IDR", source: "deal" },
    occurredAt: new Date(),
  }),
);
assert.equal(again.kind, "already_queued");
const ledgerAfter = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM ad_conversion_events WHERE tenant_id = $1`,
  [TENANT],
);
assert.equal(ledgerAfter.rows[0].n, "1", "dedup: tetap satu baris ledger");
const outboxAfter = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM outbox_events WHERE tenant_id = $1 AND type = 'ad_conversion.requested'`,
  [TENANT],
);
assert.equal(outboxAfter.rows[0].n, "1", "dedup: tetap satu event outbox");
// Resolusi nilai: order lebih segar dari deal → order (IDR) menang;
// kontak tanpa konteks + statis → statis; tanpa apa pun → null.
await client.query(
  `UPDATE deals SET updated_at = now() - interval '3 days' WHERE tenant_id = $1`,
  [TENANT],
);
const orderWins = await withTenantDb(db, TENANT, (tx) =>
  resolveAdConversionValueTx(tx, { tenantId: TENANT, contactId: CONTACT }),
);
assert.deepEqual(orderWins, { value: 50000, currency: "IDR", source: "order" });
const staticVal = await withTenantDb(db, TENANT, (tx) =>
  resolveAdConversionValueTx(tx, {
    tenantId: TENANT,
    contactId: CONTACT_NO_ID,
    staticValue: 99000,
  }),
);
assert.deepEqual(staticVal, {
  value: 99000,
  currency: "IDR",
  source: "static",
});
const noVal = await withTenantDb(db, TENANT, (tx) =>
  resolveAdConversionValueTx(tx, {
    tenantId: TENANT,
    contactId: CONTACT_NO_ID,
  }),
);
assert.deepEqual(noVal, { value: null, currency: null, source: null });
console.log("[3] executor + ledger/outbox + dedup + resolusi nilai nyata: OK");

// ---------------------------------------------------------------------------
// [4] Pengiriman Meta sukses + mode uji + idempoten
// ---------------------------------------------------------------------------
const metaRowId = ledger.rows[0].id;
fetchCalls.length = 0;
fetchResponder = () => ({ status: 200, body: { events_received: 1 } });
const sent = await deliverAdConversion(
  db,
  { tenantId: TENANT, eventRowId: metaRowId },
  deps,
);
assert.equal(sent.kind, "sent", JSON.stringify(sent));
assert.equal(fetchCalls.length, 1);
const metaCall = fetchCalls[0];
assert.ok(
  metaCall.url.startsWith(
    "https://graph.example.test/v26.0/1234567890/events?access_token=",
  ),
  metaCall.url,
);
assert.ok(metaCall.url.includes(encodeURIComponent(META_TOKEN)));
const sentBody = JSON.parse(metaCall.body) as {
  data: Array<Record<string, unknown>>;
  test_event_code?: string;
};
assert.equal(sentBody.data[0].event_id, expectedEventId);
assert.equal(sentBody.data[0].event_name, "Lead");
assert.equal(sentBody.test_event_code, "TEST999", "mode uji terpasang");
const metaRowAfter = await client.query<{
  status: string;
  sent_at: Date | null;
  payload: { data: Array<{ user_data: Record<string, string[]> }> };
}>(
  `SELECT status, sent_at, payload FROM ad_conversion_events WHERE id = $1`,
  [metaRowId],
);
assert.equal(metaRowAfter.rows[0].status, "sent");
assert.ok(metaRowAfter.rows[0].sent_at);
assert.deepEqual(
  metaRowAfter.rows[0].payload.data[0].user_data.em,
  [sha256("sari@example.com")],
  "snapshot payload menyimpan hash, sama seperti terkirim",
);
assert.equal(
  JSON.stringify(metaRowAfter.rows[0].payload).includes(META_TOKEN),
  false,
  "snapshot payload TIDAK memuat token",
);
const ilog = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM integration_log WHERE tenant_id = $1 AND provider = 'meta_capi' AND outcome = 'sent'`,
  [TENANT],
);
assert.equal(ilog.rows[0].n, "1", "log integrasi meta_capi sent tertulis");
const resent = await deliverAdConversion(
  db,
  { tenantId: TENANT, eventRowId: metaRowId },
  deps,
);
assert.equal(resent.kind, "already_sent");
assert.equal(fetchCalls.length, 1, "kirim ulang TIDAK memanggil jaringan lagi");
console.log("[4] pengiriman Meta sukses + test_event_code + idempoten: OK");

// ---------------------------------------------------------------------------
// [5] Kegagalan Meta tercatat; run yang completed tidak berubah
// ---------------------------------------------------------------------------
const RUN_FAIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const failQueued = await withTenantDb(db, TENANT, (tx) =>
  queueAdConversionTx(tx, {
    tenantId: TENANT,
    platform: "meta",
    eventName: "Purchase",
    flowId: created.flow.id,
    runId: RUN_FAIL,
    nodeId: "conv",
    contactId: CONTACT,
    userData,
    value: { value: 50000, currency: "IDR", source: "order" },
    occurredAt: new Date(),
  }),
);
assert.equal(failQueued.kind, "queued");
fetchResponder = () => ({
  status: 400,
  body: { error: { message: "Invalid OAuth access token", code: 190 } },
});
const failed = await deliverAdConversion(
  db,
  { tenantId: TENANT, eventRowId: failQueued.rowId },
  deps,
);
assert.equal(failed.kind, "failed");
if (failed.kind === "failed") assert.equal(failed.errorCode, "meta_http_400");
const failRow = await client.query<{
  status: string;
  error_code: string;
  error_message: string;
}>(
  `SELECT status, error_code, error_message FROM ad_conversion_events WHERE id = $1`,
  [failQueued.rowId],
);
assert.equal(failRow.rows[0].status, "failed");
assert.equal(failRow.rows[0].error_code, "meta_http_400");
assert.ok(failRow.rows[0].error_message.includes("Invalid OAuth"));
const runStill = await client.query<{ status: string }>(
  `SELECT status FROM flow_runs WHERE id = $1`,
  [RUN],
);
assert.equal(
  runStill.rows[0].status,
  "completed",
  "kegagalan iklan tidak membatalkan run",
);
console.log("[5] kegagalan Meta tercatat di baris; run tetap completed: OK");

// ---------------------------------------------------------------------------
// [6] Google tanpa pengenal → skipped jujur, tanpa jaringan
// ---------------------------------------------------------------------------
const RUN_G1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const gSkip = await withTenantDb(db, TENANT, (tx) =>
  queueAdConversionTx(tx, {
    tenantId: TENANT,
    platform: "google",
    eventName: "Lead",
    flowId: created.flow.id,
    runId: RUN_G1,
    nodeId: "conv",
    contactId: CONTACT_NO_ID,
    userData: buildAdConversionUserData({
      id: CONTACT_NO_ID,
      email: null,
      phone: null,
    }),
    value: { value: null, currency: null, source: null },
    occurredAt: new Date(),
  }),
);
fetchCalls.length = 0;
fetchResponder = () => ({ status: 200, body: {} });
const skipped = await deliverAdConversion(
  db,
  { tenantId: TENANT, eventRowId: gSkip.rowId },
  deps,
);
assert.equal(skipped.kind, "skipped");
if (skipped.kind === "skipped") {
  assert.equal(skipped.errorCode, "google_no_identifier");
}
assert.equal(fetchCalls.length, 0, "tanpa pengenal → jaringan TIDAK dipanggil");
console.log("[6] Google tanpa pengenal → skipped google_no_identifier: OK");

// ---------------------------------------------------------------------------
// [7] Google sukses: enhanced conversions via Ads API
// ---------------------------------------------------------------------------
// Koneksi OAuth layanan 'ads' tenant (token envelope, pola produksi).
await client.query(
  `INSERT INTO google_connections (tenant_id, service, account_email, access_token_encrypted, token_expires_at, scopes)
   VALUES ($1, 'ads', 'ads-owner@example.com', $2, now() + interval '1 hour', 'openid email https://www.googleapis.com/auth/adwords')`,
  [TENANT, encryptChannelSecret(ENCRYPTION_SECRET, GOOGLE_ACCESS)],
);
await setPlatformSetting(
  db,
  {
    key: "google_ads_developer_token",
    value: DEV_TOKEN,
    updatedByUserId: OWNER,
  },
  platformOpts,
);
clearPlatformSettingsCache();
const viewG = await getAdConnections(db, TENANT, deps);
assert.equal(viewG.google.ready, true, JSON.stringify(viewG.google));
assert.equal(viewG.google.adsAccountEmail, "ads-owner@example.com");
const RUN_G2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
const gOk = await withTenantDb(db, TENANT, (tx) =>
  queueAdConversionTx(tx, {
    tenantId: TENANT,
    platform: "google",
    eventName: "Purchase",
    flowId: created.flow.id,
    runId: RUN_G2,
    nodeId: "conv",
    contactId: CONTACT,
    userData,
    value: { value: 50000, currency: "IDR", source: "order" },
    occurredAt: new Date("2026-11-13T02:30:00.000Z"),
  }),
);
fetchCalls.length = 0;
fetchResponder = () => ({ status: 200, body: { results: [{}] } });
const gSent = await deliverAdConversion(
  db,
  { tenantId: TENANT, eventRowId: gOk.rowId },
  deps,
);
assert.equal(gSent.kind, "sent", JSON.stringify(gSent));
assert.equal(fetchCalls.length, 1);
const gCall = fetchCalls[0];
assert.equal(
  gCall.url,
  "https://ads.example.test/v18/customers/1234567890:uploadClickConversions",
);
assert.equal(gCall.headers["developer-token"], DEV_TOKEN);
assert.equal(gCall.headers.authorization, `Bearer ${GOOGLE_ACCESS}`);
const gBody = JSON.parse(gCall.body) as {
  conversions: Array<Record<string, unknown>>;
  partialFailure: boolean;
};
assert.equal(gBody.partialFailure, true);
const conv0 = gBody.conversions[0];
assert.equal(
  conv0.conversionAction,
  "customers/1234567890/conversionActions/987654321",
);
assert.equal(conv0.orderId, adConversionEventId(RUN_G2, "conv"));
assert.equal(conv0.conversionDateTime, "2026-11-13 02:30:00+00:00");
assert.equal(conv0.conversionValue, 50000);
assert.equal(conv0.currencyCode, "IDR");
assert.deepEqual(conv0.userIdentifiers, [
  { hashedEmail: sha256("sari@example.com") },
  { hashedPhoneNumber: sha256("+6281234567890") },
]);
console.log("[7] Google enhanced conversions terkirim dengan benar: OK");

// ---------------------------------------------------------------------------
// [8] Kegagalan konfigurasi Google/Meta tercatat dengan kode persis
// ---------------------------------------------------------------------------
// (a) developer token platform dicabut → google_developer_token_missing.
await clearPlatformSetting(db, {
  key: "google_ads_developer_token",
  updatedByUserId: OWNER,
});
clearPlatformSettingsCache();
const RUN_G3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
const gNoDev = await withTenantDb(db, TENANT, (tx) =>
  queueAdConversionTx(tx, {
    tenantId: TENANT,
    platform: "google",
    eventName: "Lead",
    flowId: created.flow.id,
    runId: RUN_G3,
    nodeId: "conv",
    contactId: CONTACT,
    userData,
    value: { value: null, currency: null, source: null },
    occurredAt: new Date(),
  }),
);
fetchCalls.length = 0;
const noDev = await deliverAdConversion(
  db,
  { tenantId: TENANT, eventRowId: gNoDev.rowId },
  deps,
);
assert.equal(noDev.kind, "failed");
if (noDev.kind === "failed") {
  assert.equal(noDev.errorCode, "google_developer_token_missing");
}
assert.equal(fetchCalls.length, 0);
// Pulihkan developer token untuk skenario berikutnya.
await setPlatformSetting(
  db,
  { key: "google_ads_developer_token", value: DEV_TOKEN, updatedByUserId: OWNER },
  platformOpts,
);
clearPlatformSettingsCache();
// (b) tenant B: koneksi Ads terisi tapi OAuth 'ads' belum terhubung.
await updateAdConnections(
  db,
  TENANT_B,
  { googleCustomerId: "9998887776", googleConversionActionId: "111222333" },
  { actorType: "user", actorId: OWNER },
  deps,
);
const RUN_GB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6";
const gB = await withTenantDb(db, TENANT_B, (tx) =>
  queueAdConversionTx(tx, {
    tenantId: TENANT_B,
    platform: "google",
    eventName: "Lead",
    flowId: created.flow.id,
    runId: RUN_GB,
    nodeId: "conv",
    contactId: CONTACT_B,
    userData: buildAdConversionUserData({
      id: CONTACT_B,
      email: "bima@example.com",
      phone: null,
    }),
    value: { value: null, currency: null, source: null },
    occurredAt: new Date(),
  }),
);
const notConn = await deliverAdConversion(
  db,
  { tenantId: TENANT_B, eventRowId: gB.rowId },
  deps,
);
assert.equal(notConn.kind, "failed");
if (notConn.kind === "failed") {
  assert.equal(notConn.errorCode, "google_ads_not_connected");
}
// (c) tenant B: Meta tanpa koneksi sama sekali → meta_not_configured.
const RUN_MB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7";
const mB = await withTenantDb(db, TENANT_B, (tx) =>
  queueAdConversionTx(tx, {
    tenantId: TENANT_B,
    platform: "meta",
    eventName: "Lead",
    flowId: created.flow.id,
    runId: RUN_MB,
    nodeId: "conv",
    contactId: CONTACT_B,
    userData: buildAdConversionUserData({
      id: CONTACT_B,
      email: "bima@example.com",
      phone: null,
    }),
    value: { value: null, currency: null, source: null },
    occurredAt: new Date(),
  }),
);
const notConf = await deliverAdConversion(
  db,
  { tenantId: TENANT_B, eventRowId: mB.rowId },
  deps,
);
assert.equal(notConf.kind, "failed");
if (notConf.kind === "failed") {
  assert.equal(notConf.errorCode, "meta_not_configured");
}
console.log("[8] kode kegagalan konfigurasi persis (dev token/OAuth/Meta): OK");

// ---------------------------------------------------------------------------
// [9] Isolasi tenant
// ---------------------------------------------------------------------------
const eventsB = await listAdConversionEvents(db, TENANT_B);
assert.equal(eventsB.length, 2, "tenant B hanya melihat barisnya sendiri");
assert.ok(eventsB.every((e) => e.tenantId === TENANT_B));
const eventsA = await listAdConversionEvents(db, TENANT);
assert.ok(eventsA.length >= 5);
assert.ok(eventsA.every((e) => e.tenantId === TENANT));
const viewB = await getAdConnections(db, TENANT_B, deps);
assert.equal(viewB.meta.datasetId, null, "koneksi Meta tenant A tidak bocor ke B");
assert.equal(viewB.google.customerId, "9998887776");
console.log("[9] isolasi tenant ledger + koneksi: OK");

// ---------------------------------------------------------------------------
// [10] Validasi node + simulator tanpa jaringan
// ---------------------------------------------------------------------------
const badIssues = validateFlowNodeConfig({
  id: "x",
  type: "send_ad_conversion",
  config: { platform: "tiktok", eventName: "", value: -5, currency: "idr" },
} as never);
const badCodes = badIssues.map((i) => i.code);
assert.ok(badCodes.includes("AD_PLATFORM_INVALID"), badCodes.join(","));
assert.ok(badCodes.includes("AD_EVENT_NAME_REQUIRED"));
assert.ok(badCodes.includes("AD_VALUE_INVALID"));
assert.ok(badCodes.includes("AD_CURRENCY_INVALID"));
const okIssues = validateFlowNodeConfig({
  id: "x",
  type: "send_ad_conversion",
  config: { platform: "meta", eventName: "Lead" },
} as never);
assert.equal(okIssues.length, 0, JSON.stringify(okIssues));
fetchCalls.length = 0;
const sim = simulateFlowRun(graph as never, {
  flowId: created.flow.id,
  triggerText: "IKLAN",
  contact: { name: "Sari", email: "sari@example.com" },
});
assert.equal(sim.status, "completed", JSON.stringify(sim.steps));
const adEffect = sim.effects.find((e) => e.kind === "ad_conversion");
assert.ok(adEffect, "efek ad_conversion tercatat di simulator");
assert.equal(adEffect.fidelity, "recorded");
assert.equal(adEffect.data.platform, "meta");
assert.equal(fetchCalls.length, 0, "simulator TIDAK memanggil jaringan");
console.log("[10] validasi AD_* + simulator mencatat tanpa jaringan: OK");

console.log("verify:ad-conversions — SEMUA LULUS");
await client.close();
