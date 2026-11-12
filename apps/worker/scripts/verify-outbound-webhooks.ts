/**
 * Uji integrasi WEBHOOK KELUAR TENANT (Gelombang G11) di atas PGlite:
 * endpoint HTTPS tenant menerima peristiwa outbox Botara secara
 * real-time, tertandatangani HMAC-SHA256, dengan pengiriman andal.
 * Yang dibuktikan:
 *  1. Pembuatan endpoint: rahasia dihasilkan server, tampil SATU KALI
 *     di hasil pembuatan, tersimpan TERENKRIPSI (baris DB tidak
 *     memuat nilai terang), dan tampilan daftar TIDAK membawa kolom
 *     rahasia sama sekali.
 *  2. Anti-SSRF saat simpan: http:// ditolak, IP loopback/link-local
 *     (metadata cloud) ditolak, resolusi campuran privat ditolak,
 *     localhost ditolak, resolusi gagal ditolak.
 *  3. Fan-out message.received: tepat endpoint berlangganan yang
 *     menerima; badan envelope benar; header tanda tangan
 *     terverifikasi ulang dari BODY MENTAH dengan rahasia terang;
 *     peristiwa yang tidak dilanggan tidak dikirim.
 *  4. Idempotensi: fan-out event yang sama dua kali → tetap satu
 *     baris pengiriman.
 *  5. Percobaan ulang: 5xx → pending + next_attempt_at backoff;
 *     penyapu pada jam yang dimajukan mengirim ulang dan berhasil;
 *     log tercatat (attempts, status HTTP).
 *  6. 4xx = gagal final seketika + penghitung gagal endpoint +1.
 *  7. Nonaktif otomatis: 5 pengiriman gagal final beruntun →
 *     endpoint disabled 'consecutive_failures' + audit; fan-out
 *     berikutnya tidak menembak; aktifkan manual meng-nol-kan
 *     penghitung.
 *  8. Produsen message.status_updated: markOutboundMessageSent
 *     menulis event outbox; resi WhatsApp delivered juga; keduanya
 *     mengalir ke endpoint berlangganan.
 *  9. Peristiwa uji `ping`: terkirim dan tercatat; juga menembak
 *     endpoint yang sedang disabled (alat diagnostik).
 * 10. Isolasi tenant: endpoint/pengiriman tenant A tidak terlihat
 *     dan tidak terkirim dari konteks tenant B.
 *
 * Fetch + resolusi DNS disuntikkan (tiruan terkendali): yang diuji
 * adalah logika core sungguhan — serialisasi badan, tanda tangan,
 * klasifikasi respons, backoff, dan pencatatan — bukan jaringan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:outbound-webhooks
 */
import assert from "node:assert/strict";
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
  applyWhatsAppMessageStatus,
  createOutboundWebhookEndpoint,
  deleteOutboundWebhookEndpoint,
  dispatchOutboundWebhookEvent,
  getOutboundWebhookEndpoint,
  listOutboundWebhookDeliveries,
  listOutboundWebhookEndpoints,
  markOutboundMessageSent,
  processDueOutboundWebhookRetries,
  sendOutboundWebhookTestEvent,
  setOutboundWebhookEndpointEnabled,
  verifyOutboundWebhookSignature,
  type OutboundWebhookDeliveryDeps,
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
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "33333333-3333-4333-8333-333333333334";
const ACCOUNT = "55555555-5555-4555-8555-555555555555";
const WA_ACCOUNT = "55555555-5555-4555-8555-555555555557";
const CONTACT = "66666666-6666-4666-8666-666666666666";
const CONVERSATION = "77777777-7777-4777-8777-777777777777";
const MESSAGE_IN = "88888888-8888-4888-8888-888888888888";
const MESSAGE_OUT = "88888888-8888-4888-8888-888888888889";
const MESSAGE_WA = "88888888-8888-4888-8888-88888888888a";

const ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString("base64");

// Jam yang bisa dimajukan manual — backoff diuji tanpa menunggu.
let clock = new Date("2026-11-12T10:00:00.000Z");
const advanceClock = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

// Resolver DNS tiruan: semua host publik kecuali yang dipetakan khusus.
const dnsTable = new Map<string, string[] | Error>([
  ["hooks.example.com", ["93.184.216.34"]],
  ["mixed.example.com", ["93.184.216.34", "10.0.0.9"]],
  ["dead.example.com", new Error("ENOTFOUND")],
]);
const resolveHost = async (hostname: string): Promise<string[]> => {
  const entry = dnsTable.get(hostname);
  if (entry instanceof Error) throw entry;
  if (entry) return entry;
  return ["93.184.216.34"];
};

// Fetch tiruan: mencatat panggilan, respons diatur skenario.
interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}
const fetchCalls: FetchCall[] = [];
let fetchResponder: (call: FetchCall) => { status: number } | "throw" = () => ({
  status: 200,
});
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
  if (outcome === "throw") throw new Error("ECONNRESET: socket hang up");
  return {
    status: outcome.status,
    text: async () => "",
  } as Response;
}) as unknown as typeof fetch;

const deps: OutboundWebhookDeliveryDeps = {
  encryptionSecret: ENCRYPTION_SECRET,
  fetchFn,
  resolveHost,
  now: () => clock,
};

await client.query(
  `INSERT INTO tenants (id, name, slug, timezone) VALUES ($1, 'Tenant Uji', 'tenant-uji', 'Asia/Jakarta'), ($2, 'Tenant Lain', 'tenant-lain', 'Asia/Jakarta')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@example.com', 'User A'), ($2, 'b@example.com', 'User B')`,
  [USER_A, USER_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'telegram', 'tg_uji', 'connected'), ($3, $2, 'whatsapp', '6281234567890', 'connected')`,
  [ACCOUNT, TENANT, WA_ACCOUNT],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Pelanggan Uji')`,
  [CONTACT, TENANT],
);
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
   VALUES ($1, $2, $3, $4, 'telegram', 'chat-1', 'private', 'open')`,
  [CONVERSATION, TENANT, ACCOUNT, CONTACT],
);
await client.query(
  `INSERT INTO messages (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status)
   VALUES ($1, $2, $3, 'inbound', 'contact', 'text', 'Halo, mau tanya stok', 'received'),
          ($4, $2, $3, 'outbound', 'user', 'text', 'Stok tersedia kak', 'queued'),
          ($5, $2, $3, 'outbound', 'user', 'text', 'Promo minggu ini', 'sent')`,
  [MESSAGE_IN, TENANT, CONVERSATION, MESSAGE_OUT, MESSAGE_WA],
);
await client.query(
  `UPDATE messages SET provider_message_id = 'meta:6281234567890:wamid.uji.1' WHERE id = $1`,
  [MESSAGE_WA],
);

async function deliveriesOf(endpointId: string, tenantId = TENANT) {
  return listOutboundWebhookDeliveries(db, tenantId, endpointId, 100);
}

// ---------------------------------------------------------------------------
// [1] Pembuatan endpoint + rahasia satu kali + terenkripsi
// ---------------------------------------------------------------------------
const created = await createOutboundWebhookEndpoint(
  db,
  { tenantId: TENANT, userId: USER_A },
  { encryptionSecret: ENCRYPTION_SECRET, resolveHost },
  {
    name: "CRM utama",
    url: "https://hooks.example.com/botara",
    events: ["message.received"],
  },
);
assert.equal(created.ok, true, JSON.stringify(created));
if (!created.ok) throw new Error("endpoint harus terbuat");
const endpoint = created.endpoint;
const signingSecret = created.signingSecret;
assert.ok(signingSecret.startsWith("whsec_"), "rahasia berawalan whsec_");
assert.equal("secretEncrypted" in endpoint, false, "tampilan tidak membawa kolom rahasia");
const rawRow = await client.query<{ secret_encrypted: string }>(
  `SELECT secret_encrypted FROM outbound_webhook_endpoints WHERE id = $1`,
  [endpoint.id],
);
assert.ok(
  !rawRow.rows[0].secret_encrypted.includes(signingSecret),
  "baris DB TIDAK memuat rahasia terang",
);
assert.ok(rawRow.rows[0].secret_encrypted.startsWith("v1:"), "tersimpan sebagai envelope v1");
const listed = await listOutboundWebhookEndpoints(db, TENANT);
assert.equal(listed.length, 1);
assert.equal(JSON.stringify(listed).includes(signingSecret), false, "daftar tidak membocorkan rahasia");
console.log("[1] pembuatan endpoint + rahasia satu kali terenkripsi: OK");

// ---------------------------------------------------------------------------
// [2] Anti-SSRF saat simpan
// ---------------------------------------------------------------------------
const ctxA = { tenantId: TENANT, userId: USER_A };
const createDeps = { encryptionSecret: ENCRYPTION_SECRET, resolveHost };
const rejected: Array<[string, string]> = [
  ["http://hooks.example.com/x", "WEBHOOK_URL_NOT_HTTPS"],
  ["https://127.0.0.1:8443/x", "WEBHOOK_URL_UNSAFE_HOST"],
  ["https://169.254.169.254/latest/meta-data", "WEBHOOK_URL_UNSAFE_HOST"],
  ["https://[::1]/x", "WEBHOOK_URL_UNSAFE_HOST"],
  ["https://localhost:8443/x", "WEBHOOK_URL_UNSAFE_HOST"],
  ["https://mixed.example.com/x", "WEBHOOK_URL_UNSAFE_HOST"],
  ["https://dead.example.com/x", "WEBHOOK_URL_UNSAFE_HOST"],
  ["bukan url", "WEBHOOK_URL_INVALID"],
  ["https://user:pass@hooks.example.com/x", "WEBHOOK_URL_INVALID"],
];
for (const [url, code] of rejected) {
  const res = await createOutboundWebhookEndpoint(db, ctxA, createDeps, {
    name: "tolak",
    url,
    events: ["message.received"],
  });
  assert.equal(res.ok, false, `${url} harus ditolak`);
  if (!res.ok) assert.equal(res.code, code, `${url} → ${code}`);
}
const badEvent = await createOutboundWebhookEndpoint(db, ctxA, createDeps, {
  name: "tolak",
  url: "https://hooks.example.com/x",
  events: ["conversation.created"],
});
assert.equal(badEvent.ok, false);
if (!badEvent.ok) assert.equal(badEvent.code, "WEBHOOK_EVENT_UNKNOWN");
assert.equal((await listOutboundWebhookEndpoints(db, TENANT)).length, 1, "yang tertolak tidak tersimpan");
console.log("[2] anti-SSRF saat simpan (http/privat/loopback/link-local/localhost/campuran/gagal-resolusi): OK");

// ---------------------------------------------------------------------------
// [3] Fan-out message.received + verifikasi tanda tangan dari body mentah
// ---------------------------------------------------------------------------
const statusOnly = await createOutboundWebhookEndpoint(db, ctxA, createDeps, {
  name: "Hanya status",
  url: "https://hooks.example.com/status",
  events: ["message.status_updated"],
});
assert.equal(statusOnly.ok, true);

fetchCalls.length = 0;
const fanout1 = await dispatchOutboundWebhookEvent(
  db,
  {
    tenantId: TENANT,
    eventType: "message.received",
    sourceEventId: "99999999-9999-4999-8999-999999999991",
    sourcePayload: {
      provider: "telegram",
      channelAccountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: MESSAGE_IN,
    },
  },
  deps,
);
assert.equal(fanout1.matched, 1, "hanya endpoint berlangganan message.received yang cocok");
assert.equal(fanout1.created, 1);
assert.equal(fetchCalls.length, 1, "tepat satu POST keluar");
const call1 = fetchCalls[0];
assert.equal(call1.url, "https://hooks.example.com/botara");
assert.equal(call1.headers["x-botara-event"], "message.received");
const signatureHeader = call1.headers["x-botara-signature"];
assert.ok(signatureHeader, "header tanda tangan ada");
assert.equal(
  verifyOutboundWebhookSignature(signingSecret, call1.body, signatureHeader),
  true,
  "tanda tangan terverifikasi ulang dari body mentah",
);
const envelope = JSON.parse(call1.body) as {
  id: string;
  type: string;
  tenant_id: string;
  data: { message: { text: string } | null; conversation_id: string };
};
assert.equal(envelope.type, "message.received");
assert.equal(envelope.tenant_id, TENANT);
assert.equal(envelope.data.message?.text, "Halo, mau tanya stok");
assert.equal(envelope.data.conversation_id, CONVERSATION);
let rows = await deliveriesOf(endpoint.id);
assert.equal(rows.length, 1);
assert.equal(rows[0].status, "delivered");
assert.equal(rows[0].attempts, 1);
assert.equal(rows[0].lastStatusCode, 200);
assert.equal(rows[0].id, envelope.id, "id envelope = id baris pengiriman");
assert.equal((await deliveriesOf(statusOnly.ok ? statusOnly.endpoint.id : "")).length, 0, "endpoint tak berlangganan tidak menerima");
console.log("[3] fan-out message.received + tanda tangan terverifikasi dari body mentah: OK");

// ---------------------------------------------------------------------------
// [4] Idempotensi fan-out
// ---------------------------------------------------------------------------
const fanout2 = await dispatchOutboundWebhookEvent(
  db,
  {
    tenantId: TENANT,
    eventType: "message.received",
    sourceEventId: "99999999-9999-4999-8999-999999999991",
    sourcePayload: {
      provider: "telegram",
      channelAccountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: MESSAGE_IN,
    },
  },
  deps,
);
assert.equal(fanout2.created, 0, "event yang sama tidak melahirkan pengiriman kedua");
assert.equal((await deliveriesOf(endpoint.id)).length, 1);
assert.equal(fetchCalls.length, 1, "tidak ada POST tambahan");
console.log("[4] idempotensi fan-out per (endpoint, event): OK");

// ---------------------------------------------------------------------------
// [5] Percobaan ulang backoff via penyapu
// ---------------------------------------------------------------------------
fetchResponder = () => ({ status: 500 });
fetchCalls.length = 0;
const fanoutRetry = await dispatchOutboundWebhookEvent(
  db,
  {
    tenantId: TENANT,
    eventType: "message.received",
    sourceEventId: "99999999-9999-4999-8999-999999999992",
    sourcePayload: {
      provider: "telegram",
      channelAccountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: MESSAGE_IN,
    },
  },
  deps,
);
assert.equal(fanoutRetry.created, 1);
rows = await deliveriesOf(endpoint.id);
const retryRow = rows.find((r) => r.sourceEventId?.endsWith("9992"));
assert.ok(retryRow);
assert.equal(retryRow.status, "pending", "5xx → tetap pending");
assert.equal(retryRow.attempts, 1);
assert.equal(retryRow.lastStatusCode, 500);
assert.ok(retryRow.nextAttemptAt, "ada jadwal percobaan ulang");
const firstDelay = retryRow.nextAttemptAt.getTime() - clock.getTime();
assert.ok(firstDelay >= 29_000 && firstDelay <= 31_000, `backoff pertama ±30 dtk (aktual ${firstDelay})`);

// Penyapu sebelum jatuh tempo: tidak menyentuh.
let sweep = await processDueOutboundWebhookRetries(db, deps, { now: clock });
assert.equal(sweep.scanned, 0);

// Majukan jam melewati backoff, server pulih → terkirim pada percobaan ke-2.
advanceClock(31_000);
fetchResponder = () => ({ status: 200 });
sweep = await processDueOutboundWebhookRetries(db, deps, { now: clock });
assert.equal(sweep.scanned, 1);
assert.equal(sweep.delivered, 1);
rows = await deliveriesOf(endpoint.id);
const retriedRow = rows.find((r) => r.id === retryRow.id);
assert.equal(retriedRow?.status, "delivered");
assert.equal(retriedRow?.attempts, 2);
assert.equal(retriedRow?.nextAttemptAt, null);
console.log("[5] percobaan ulang backoff + penyapu + log tercatat: OK");

// ---------------------------------------------------------------------------
// [6] 4xx gagal final seketika
// ---------------------------------------------------------------------------
fetchResponder = () => ({ status: 400 });
await dispatchOutboundWebhookEvent(
  db,
  {
    tenantId: TENANT,
    eventType: "message.received",
    sourceEventId: "99999999-9999-4999-8999-999999999993",
    sourcePayload: {
      provider: "telegram",
      channelAccountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: MESSAGE_IN,
    },
  },
  deps,
);
rows = await deliveriesOf(endpoint.id);
const badRow = rows.find((r) => r.sourceEventId?.endsWith("9993"));
assert.equal(badRow?.status, "failed", "4xx → gagal final tanpa percobaan ulang");
assert.equal(badRow?.attempts, 1);
assert.equal(badRow?.lastError, "http_400");
const endpointAfter4xx = await getOutboundWebhookEndpoint(db, TENANT, endpoint.id);
assert.equal(endpointAfter4xx?.consecutiveFailures, 1, "penghitung gagal endpoint +1");
assert.equal(endpointAfter4xx?.status, "active");
console.log("[6] 4xx gagal final + penghitung endpoint: OK");

// ---------------------------------------------------------------------------
// [7] Nonaktif otomatis sesudah 5 gagal final beruntun
// ---------------------------------------------------------------------------
const fragile = await createOutboundWebhookEndpoint(db, ctxA, createDeps, {
  name: "Rapuh",
  url: "https://hooks.example.com/rapuh",
  events: ["message.received"],
});
assert.equal(fragile.ok, true);
if (!fragile.ok) throw new Error("endpoint rapuh harus terbuat");
const fragileId = fragile.endpoint.id;

fetchResponder = () => ({ status: 404 }); // 4xx: final pada percobaan pertama
for (let i = 0; i < 5; i += 1) {
  await dispatchOutboundWebhookEvent(
    db,
    {
      tenantId: TENANT,
      eventType: "message.received",
      sourceEventId: `99999999-9999-4999-8999-9999999999${10 + i}`,
      sourcePayload: {
        provider: "telegram",
        channelAccountId: ACCOUNT,
        conversationId: CONVERSATION,
        messageId: MESSAGE_IN,
      },
    },
    deps,
  );
}
const fragileAfter = await getOutboundWebhookEndpoint(db, TENANT, fragileId);
assert.equal(fragileAfter?.consecutiveFailures, 5);
assert.equal(fragileAfter?.status, "disabled", "ambang tercapai → nonaktif otomatis");
assert.equal(fragileAfter?.disabledReason, "consecutive_failures");
const autoAudit = await client.query<{ count: string }>(
  `SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action = 'outbound_webhook.auto_disabled' AND meta->>'endpointId' = $2`,
  [TENANT, fragileId],
);
assert.equal(Number(autoAudit.rows[0].count), 1, "audit nonaktif otomatis tercatat");

// Fan-out berikutnya tidak menembak endpoint yang nonaktif. (Endpoint
// CRM utama ikut nonaktif di loop ini — ia menerima 404 yang sama;
// yang dibuktikan di sini: TIDAK ADA tembakan sama sekali.)
fetchCalls.length = 0;
const fanoutDisabled = await dispatchOutboundWebhookEvent(
  db,
  {
    tenantId: TENANT,
    eventType: "message.received",
    sourceEventId: "99999999-9999-4999-8999-999999999920",
    sourcePayload: {
      provider: "telegram",
      channelAccountId: ACCOUNT,
      conversationId: CONVERSATION,
      messageId: MESSAGE_IN,
    },
  },
  deps,
);
assert.equal(fanoutDisabled.matched, 0, "tidak ada endpoint aktif berlangganan yang tersisa");
assert.equal(fetchCalls.length, 0, "endpoint nonaktif tidak ditembak");

// Aktifkan manual → penghitung nol, status aktif.
const reenabled = await setOutboundWebhookEndpointEnabled(
  db,
  ctxA,
  fragileId,
  true,
);
assert.equal(reenabled?.status, "active");
assert.equal(reenabled?.consecutiveFailures, 0);
assert.equal(reenabled?.disabledReason, null);
console.log("[7] nonaktif otomatis pada ambang 5 + audit + aktifkan manual: OK");

// ---------------------------------------------------------------------------
// [8] Produsen message.status_updated (penanda pusat + resi WhatsApp)
// ---------------------------------------------------------------------------
await markOutboundMessageSent(db, { tenantId: TENANT }, MESSAGE_OUT, "verify");
const statusEvents = await client.query<{ id: string; payload: Record<string, unknown> }>(
  `SELECT id, payload FROM outbox_events WHERE tenant_id = $1 AND type = 'message.status_updated' ORDER BY created_at`,
  [TENANT],
);
assert.equal(statusEvents.rows.length, 1, "markOutboundMessageSent menulis event status");
assert.equal(statusEvents.rows[0].payload.from, "queued");
assert.equal(statusEvents.rows[0].payload.to, "sent");

fetchResponder = () => ({ status: 200 });
fetchCalls.length = 0;
const statusFanout = await dispatchOutboundWebhookEvent(
  db,
  {
    tenantId: TENANT,
    eventType: "message.status_updated",
    sourceEventId: statusEvents.rows[0].id,
    sourcePayload: statusEvents.rows[0].payload,
  },
  deps,
);
assert.equal(statusFanout.matched, 1, "endpoint berlangganan status menerima");
if (!statusOnly.ok) throw new Error("endpoint status harus ada");
rows = await deliveriesOf(statusOnly.endpoint.id);
assert.equal(rows.length, 1);
assert.equal(rows[0].status, "delivered");
const statusEnvelope = JSON.parse(fetchCalls[0].body) as {
  data: { status: string; previous_status: string };
};
assert.equal(statusEnvelope.data.status, "sent");
assert.equal(statusEnvelope.data.previous_status, "queued");

// Resi WhatsApp: sent → delivered juga menulis event status.
const waResult = await applyWhatsAppMessageStatus(
  db,
  { id: WA_ACCOUNT, tenantId: TENANT, externalId: "6281234567890" },
  { providerMessageId: "wamid.uji.1", status: "delivered" },
);
assert.equal(waResult?.applied, true);
const waEvents = await client.query<{ payload: Record<string, unknown> }>(
  `SELECT payload FROM outbox_events WHERE tenant_id = $1 AND type = 'message.status_updated' AND payload->>'messageId' = $2`,
  [TENANT, MESSAGE_WA],
);
assert.equal(waEvents.rows.length, 1, "resi WhatsApp menulis event status");
assert.equal(waEvents.rows[0].payload.to, "delivered");
// Status basi (sent sesudah delivered) TIDAK menulis event baru.
const stale = await applyWhatsAppMessageStatus(
  db,
  { id: WA_ACCOUNT, tenantId: TENANT, externalId: "6281234567890" },
  { providerMessageId: "wamid.uji.1", status: "sent" },
);
assert.equal(stale?.applied, false);
const waEventsAfter = await client.query<{ count: string }>(
  `SELECT count(*) FROM outbox_events WHERE tenant_id = $1 AND type = 'message.status_updated' AND payload->>'messageId' = $2`,
  [TENANT, MESSAGE_WA],
);
assert.equal(Number(waEventsAfter.rows[0].count), 1, "status basi tidak melahirkan event");
console.log("[8] produsen message.status_updated (penanda pusat + resi WA, basi ditolak): OK");

// ---------------------------------------------------------------------------
// [9] Peristiwa uji ping — termasuk ke endpoint disabled
// ---------------------------------------------------------------------------
await setOutboundWebhookEndpointEnabled(db, ctxA, fragileId, false);
fetchResponder = () => ({ status: 200 });
fetchCalls.length = 0;
const ping = await sendOutboundWebhookTestEvent(db, ctxA, deps, fragileId);
assert.ok(ping, "ping menghasilkan baris pengiriman");
assert.equal(ping.eventType, "ping");
assert.equal(ping.status, "delivered", "ping tetap ditembak walau endpoint disabled");
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].headers["x-botara-event"], "ping");
const pingEnvelope = JSON.parse(fetchCalls[0].body) as { data: { test: boolean } };
assert.equal(pingEnvelope.data.test, true, "payload ping bertanda uji");
console.log("[9] peristiwa uji ping (bertanda, menembak endpoint disabled): OK");

// ---------------------------------------------------------------------------
// [10] Isolasi tenant
// ---------------------------------------------------------------------------
const ctxB = { tenantId: TENANT_B, userId: USER_B };
assert.equal((await listOutboundWebhookEndpoints(db, TENANT_B)).length, 0);
assert.equal(await getOutboundWebhookEndpoint(db, TENANT_B, endpoint.id), null);
assert.equal(
  await setOutboundWebhookEndpointEnabled(db, ctxB, endpoint.id, false),
  null,
  "tenant B tidak bisa mengubah endpoint tenant A",
);
assert.equal(
  await deleteOutboundWebhookEndpoint(db, ctxB, endpoint.id),
  false,
  "tenant B tidak bisa menghapus endpoint tenant A",
);
assert.equal((await deliveriesOf(endpoint.id, TENANT_B)).length, 0);
// Fan-out di tenant B tidak menyentuh endpoint tenant A.
fetchCalls.length = 0;
const fanoutB = await dispatchOutboundWebhookEvent(
  db,
  {
    tenantId: TENANT_B,
    eventType: "message.received",
    sourceEventId: "99999999-9999-4999-8999-999999999930",
    sourcePayload: { conversationId: CONVERSATION, messageId: MESSAGE_IN },
  },
  deps,
);
assert.equal(fanoutB.matched, 0);
assert.equal(fetchCalls.length, 0);
console.log("[10] isolasi tenant: OK");

console.log("verify:outbound-webhooks — SEMUA KELOMPOK LULUS");
