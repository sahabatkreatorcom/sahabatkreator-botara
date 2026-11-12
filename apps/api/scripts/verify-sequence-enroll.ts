/**
 * Verifikasi Gelombang G2b — pendaftaran sequence MANUAL & per tag —
 * di atas PGlite + seluruh migrasi + aplikasi Hono dengan AuthBundle
 * tiruan (pola verify-sequence-templates) + service core sungguhan
 * untuk bukti kesetaraan jalur lama dan aturan berhenti.
 *
 * Membuktikan:
 *   [1] EKSTRAKSI jalur kata kunci TIDAK berubah: kata kunci sequence
 *       → enrollment berjangkar percakapan pemicu, run completed
 *       ber-detail matchedKeyword, audit sequence.enrolled, event
 *       step_due langkah 1 (service bersama dipakai jalur ini);
 *   [2] EKSTRAKSI jalur flow TIDAK berubah: node enroll_sequence →
 *       enrollment yang sama dengan run ber-detail via='flow' +
 *       flowId/flowRunId dan meta audit viaFlowId/viaFlowRunId;
 *   [3] enroll manual TANPA conversationId berjangkar ke percakapan
 *       pesan TERBARU kontak (percakapan channel yang lebih baru
 *       diabaikan); daftar enroll-conversations hanya memuat
 *       private/group terurut terbaru-dulu; audit via='manual' oleh
 *       user pelaku; step_due terjadwal;
 *   [4] enroll manual DENGAN conversationId eksplisit berjangkar ke
 *       pilihan itu; pengulangan → 200 already_enrolled (enrollment
 *       tetap satu); conversationId = percakapan channel / milik
 *       kontak lain → 422 ENROLL_CONVERSATION_INVALID;
 *   [5] kontak TANPA percakapan pesan → 422 ENROLL_NO_CONVERSATION
 *       (penolakan jujur beralasan, tanpa enrollment yang lahir);
 *       daftar kandidat jangkarnya kosong;
 *   [6] kontak opt-out → 422 ENROLL_CONTACT_OPTED_OUT;
 *   [7] sequence nonaktif / automation bukan sequence →
 *       422 SEQUENCE_UNAVAILABLE;
 *   [8] enroll per tag: laporan agregat benar (terdaftar baru / sudah
 *       terdaftar / dilewati per alasan: tanpa percakapan + opt-out);
 *       tag tanpa kontak → laporan serba nol;
 *   [9] isolasi: kontak tenant B lewat rute tenant A → 404 NOT_FOUND;
 *       user non-member → 404 TENANT_NOT_FOUND;
 *  [10] aturan berhenti berlaku untuk enrollment MANUAL: kontak
 *       membalas di percakapan jangkar → enrollment cancelled (audit
 *       sequence.cancelled_reply); kontak opt-out sesudah terdaftar →
 *       langkah berikutnya batal tanpa pesan (sequence.cancelled_opt_out).
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:sequence-enroll
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
  executeSequenceStep,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createAutomationsRoutes } from "../src/modules/automations/routes";

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
const USER_OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ACCOUNT_A = "55555555-5555-4555-8555-555555555555";
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A'), ($2, 'b@sk.test', 'Pemilik B'), ($3, 'luar@sk.test', 'Orang Luar')`,
  [USER_A, USER_B, USER_OUTSIDER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
  [TENANT_A, USER_A, TENANT_B, USER_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'webchat', 'wc_uji_enroll', 'connected')`,
  [ACCOUNT_A, TENANT_A],
);

// ---------------------------------------------------------------------------
// Aplikasi uji: modul automations sungguhan + appUser dari header uji.
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? USER_A;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
app.route("/", createAutomationsRoutes({ db } as unknown as AuthBundle));

interface EnrollmentBody {
  id: string;
  automationId: string;
  contactId: string;
  conversationId: string;
  triggerMessageId: string | null;
  status: string;
  currentStep: number;
  totalSteps: number;
}
interface AnyBody {
  id: string;
  kind: string;
  isActive: boolean;
  outcome?: string;
  enrollment?: EnrollmentBody;
  conversations?: {
    id: string;
    kind: string;
    provider: string;
    title: string | null;
    lastMessageAt: string | null;
  }[];
  tag?: string;
  matched?: number;
  enrolled?: number;
  alreadyEnrolled?: number;
  skippedTotal?: number;
  skippedByReason?: { noConversation: number; contactOptedOut: number };
  capped?: boolean;
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
  return { status: res.status, body: (await res.json()) as AnyBody };
}

const autoUrl = (tenantId: string) => `/tenants/${tenantId}/automations`;

// ---------------------------------------------------------------------------
// Pembantu seed & baca langsung (pola verify-sequences).
// ---------------------------------------------------------------------------
async function seedContact(
  name: string,
  opts: { tags?: string[]; optInStatus?: string } = {},
): Promise<string> {
  const tagsLiteral =
    opts.tags && opts.tags.length > 0
      ? `ARRAY[${opts.tags.map((t) => `'${t}'`).join(",")}]::text[]`
      : `ARRAY[]::text[]`;
  const r = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name, tags, opt_in_status)
     VALUES ($1, $2, ${tagsLiteral}, $3) RETURNING id`,
    [TENANT_A, name, opts.optInStatus ?? "unknown"],
  );
  return r.rows[0].id;
}

async function seedConversation(
  contactId: string,
  opts: { kind?: string; lastMessageAt?: string; title?: string } = {},
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, kind, title, last_message_at)
     VALUES ($1, $2, $3, 'webchat', $4, $5, $6) RETURNING id`,
    [
      TENANT_A,
      ACCOUNT_A,
      contactId,
      opts.kind ?? "private",
      opts.title ?? null,
      opts.lastMessageAt ?? null,
    ],
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

async function enrollmentRows(automationId: string, contactId: string) {
  const r = await client.query<{
    id: string;
    conversation_id: string;
    trigger_message_id: string | null;
    status: string;
  }>(
    `SELECT id, conversation_id, trigger_message_id, status FROM sequence_enrollments
     WHERE tenant_id=$1 AND automation_id=$2 AND contact_id=$3 ORDER BY created_at`,
    [TENANT_A, automationId, contactId],
  );
  return r.rows;
}

async function auditRows(action: string, enrollmentId: string) {
  const r = await client.query<{
    actor_type: string;
    actor_id: string;
    meta: Record<string, unknown>;
  }>(
    `SELECT actor_type, actor_id, meta FROM audit_logs
     WHERE tenant_id=$1 AND action=$2 AND meta->>'enrollmentId'=$3`,
    [TENANT_A, action, enrollmentId],
  );
  return r.rows;
}

async function stepDueCount(enrollmentId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox_events
     WHERE tenant_id=$1 AND type='sequence.step_due' AND payload->>'enrollmentId'=$2`,
    [TENANT_A, enrollmentId],
  );
  return Number(r.rows[0].n);
}

// ---------------------------------------------------------------------------
// Sequence utama lewat API (aktif, 2 langkah) + automation keyword biasa.
// ---------------------------------------------------------------------------
const seqRes = await call("POST", autoUrl(TENANT_A), USER_A, {
  kind: "sequence",
  name: "Rangkaian Sambutan",
  keywords: ["gabung"],
  match: "exact",
  steps: [
    { delayMinutes: 0, text: "Halo {name}, selamat datang!" },
    { delayMinutes: 5, text: "Lanjutan untuk {name}." },
  ],
});
assert.equal(seqRes.status, 201);
assert.equal(seqRes.body.kind, "sequence");
assert.equal(seqRes.body.isActive, true);
const SEQ = seqRes.body.id;

const kwRes = await call("POST", autoUrl(TENANT_A), USER_A, {
  name: "Balas Harga",
  keywords: ["harga"],
  match: "exact",
  text: "Daftar harga untuk {name}.",
});
assert.equal(kwRes.status, 201);
assert.equal(kwRes.body.kind, "keyword");
const KW = kwRes.body.id;

// ---------- [1] Jalur kata kunci: perilaku persis seperti sebelum ekstraksi ----------
{
  const contactId = await seedContact("Kiki Keyword");
  const convId = await seedConversation(contactId, {
    lastMessageAt: "2026-11-10T10:00:00.000Z",
  });
  const triggerId = await seedInbound(convId, "gabung");
  const result = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT_A,
    conversationId: convId,
    messageId: triggerId,
  });
  assert.equal(result.fired.length, 1);
  const enrollmentId = result.fired[0].enrollmentId!;
  const rows = await enrollmentRows(SEQ, contactId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, enrollmentId);
  assert.equal(rows[0].conversation_id, convId);
  assert.equal(rows[0].trigger_message_id, triggerId);
  assert.equal(rows[0].status, "active");
  const runRow = await client.query<{ detail: Record<string, unknown> }>(
    `SELECT detail FROM automation_runs WHERE tenant_id=$1 AND automation_id=$2 AND trigger_message_id=$3`,
    [TENANT_A, SEQ, triggerId],
  );
  assert.equal(runRow.rows[0].detail.kind, "sequence");
  assert.equal(runRow.rows[0].detail.matchedKeyword, "gabung");
  assert.equal(runRow.rows[0].detail.enrollmentId, enrollmentId);
  const audits = await auditRows("sequence.enrolled", enrollmentId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_type, "system");
  assert.equal(audits[0].actor_id, `automation:${SEQ}`);
  assert.equal(audits[0].meta.matchedKeyword, "gabung");
  assert.equal(await stepDueCount(enrollmentId), 1);
  console.log(
    "[1] jalur kata kunci: enrollment + run ber-matchedKeyword + audit sistem + step_due — tak berubah sesudah ekstraksi: OK",
  );
}

// ---------- [2] Jalur flow: node enroll_sequence berperilaku sama ----------
{
  const contactId = await seedContact("Fajar Flow");
  const convId = await seedConversation(contactId, {
    lastMessageAt: "2026-11-10T11:00:00.000Z",
  });
  const created = await createFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    name: "Flow Daftar Sequence",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: { kind: "keyword", keywords: ["ikutflow"], match: "exact" },
          position: { x: 0, y: 0 },
        },
        {
          id: "daftar",
          type: "enroll_sequence",
          config: { automationId: SEQ },
          position: { x: 290, y: 0 },
        },
        { id: "end", type: "end", config: {}, position: { x: 580, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "daftar" },
        { from: "daftar", to: "end" },
      ],
    } as never,
  });
  assert.equal(created.kind, "created");
  const flowId = created.flow.id;
  const activated = await activateFlow(db, {
    tenantId: TENANT_A,
    userId: USER_A,
    flowId,
  });
  assert.equal(activated.kind, "activated", JSON.stringify(activated));

  const triggerId = await seedInbound(convId, "ikutflow");
  const evaluated = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT_A,
    conversationId: convId,
    messageId: triggerId,
  });
  assert.equal(evaluated.flowRunsStarted, 1);
  const runRow = await client.query<{ id: string; next_step_seq: number }>(
    `SELECT id, next_step_seq FROM flow_runs WHERE tenant_id=$1 AND trigger_message_id=$2`,
    [TENANT_A, triggerId],
  );
  const flowRunId = runRow.rows[0].id;
  const stepped = await executeFlowStep(db, {
    tenantId: TENANT_A,
    runId: flowRunId,
    stepSeq: runRow.rows[0].next_step_seq,
  });
  assert.equal(stepped.executed, true, JSON.stringify(stepped));

  const rows = await enrollmentRows(SEQ, contactId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversation_id, convId);
  assert.equal(rows[0].trigger_message_id, triggerId);
  const autoRun = await client.query<{ detail: Record<string, unknown> }>(
    `SELECT detail FROM automation_runs WHERE tenant_id=$1 AND automation_id=$2 AND trigger_message_id=$3`,
    [TENANT_A, SEQ, triggerId],
  );
  assert.equal(autoRun.rows[0].detail.kind, "sequence");
  assert.equal(autoRun.rows[0].detail.via, "flow");
  assert.equal(autoRun.rows[0].detail.flowId, flowId);
  assert.equal(autoRun.rows[0].detail.flowRunId, flowRunId);
  const audits = await auditRows("sequence.enrolled", rows[0].id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].meta.viaFlowId, flowId);
  assert.equal(audits[0].meta.viaFlowRunId, flowRunId);
  assert.equal(await stepDueCount(rows[0].id), 1);
  console.log(
    "[2] jalur flow: node enroll_sequence → enrollment + run via='flow' + meta viaFlowId/viaFlowRunId — tak berubah: OK",
  );
}

// ---------- [3] Enroll manual: jangkar bawaan = percakapan pesan terbaru ----------
let manualContactId = "";
let manualNewestConv = "";
let manualOlderConv = "";
{
  manualContactId = await seedContact("Mira Manual");
  manualOlderConv = await seedConversation(manualContactId, {
    kind: "private",
    lastMessageAt: "2026-11-01T09:00:00.000Z",
  });
  manualNewestConv = await seedConversation(manualContactId, {
    kind: "group",
    title: "Grup Mira",
    lastMessageAt: "2026-11-11T09:00:00.000Z",
  });
  // Percakapan channel PALING baru sekalipun bukan kandidat jangkar.
  await seedConversation(manualContactId, {
    kind: "channel",
    title: "Kanal Mira",
    lastMessageAt: "2026-11-12T09:00:00.000Z",
  });

  const list = await call(
    "GET",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll-conversations?contactId=${manualContactId}`,
    USER_A,
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.conversations?.length, 2);
  assert.equal(list.body.conversations?.[0].id, manualNewestConv);
  assert.equal(list.body.conversations?.[0].kind, "group");
  assert.equal(list.body.conversations?.[1].id, manualOlderConv);
  assert.equal(list.body.conversations?.[1].kind, "private");

  const res = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll`,
    USER_A,
    { contactId: manualContactId },
  );
  assert.equal(res.status, 201);
  assert.equal(res.body.outcome, "enrolled");
  assert.equal(res.body.enrollment?.conversationId, manualNewestConv);
  assert.equal(res.body.enrollment?.triggerMessageId, null);
  assert.equal(res.body.enrollment?.status, "active");
  assert.equal(res.body.enrollment?.totalSteps, 2);
  const audits = await auditRows(
    "sequence.enrolled",
    res.body.enrollment!.id,
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_type, "user");
  assert.equal(audits[0].actor_id, USER_A);
  assert.equal(audits[0].meta.via, "manual");
  assert.equal(await stepDueCount(res.body.enrollment!.id), 1);
  console.log(
    "[3] enroll manual: daftar kandidat hanya private/group terbaru-dulu; bawaan berjangkar ke yang terbaru; audit user via='manual'; step_due terjadwal: OK",
  );
}

// ---------- [4] Enroll manual eksplisit + already_enrolled + jangkar tak sah ----------
{
  const contactId = await seedContact("Eko Eksplisit");
  const older = await seedConversation(contactId, {
    lastMessageAt: "2026-11-02T09:00:00.000Z",
  });
  await seedConversation(contactId, {
    lastMessageAt: "2026-11-09T09:00:00.000Z",
  });
  const channelConv = await seedConversation(contactId, {
    kind: "channel",
    lastMessageAt: "2026-11-10T09:00:00.000Z",
  });

  const res = await call("POST", `${autoUrl(TENANT_A)}/${SEQ}/enroll`, USER_A, {
    contactId,
    conversationId: older,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.enrollment?.conversationId, older);

  const again = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll`,
    USER_A,
    { contactId },
  );
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, "already_enrolled");
  assert.equal(again.body.enrollment?.id, res.body.enrollment?.id);
  assert.equal((await enrollmentRows(SEQ, contactId)).length, 1);

  const badChannel = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll`,
    USER_A,
    { contactId, conversationId: channelConv },
  );
  assert.equal(badChannel.status, 422);
  assert.equal(badChannel.body.error?.code, "ENROLL_CONVERSATION_INVALID");

  const badForeign = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll`,
    USER_A,
    { contactId, conversationId: manualNewestConv },
  );
  assert.equal(badForeign.status, 422);
  assert.equal(badForeign.body.error?.code, "ENROLL_CONVERSATION_INVALID");
  console.log(
    "[4] jangkar eksplisit dihormati; ulangan → 200 already_enrolled (satu enrollment); jangkar channel/milik kontak lain → 422 ENROLL_CONVERSATION_INVALID: OK",
  );
}

// ---------- [5] Kontak tanpa percakapan pesan → ditolak jujur ----------
{
  const contactId = await seedContact("Nina Sepi");
  await seedConversation(contactId, {
    kind: "channel",
    lastMessageAt: "2026-11-10T09:00:00.000Z",
  });
  const list = await call(
    "GET",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll-conversations?contactId=${contactId}`,
    USER_A,
  );
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.conversations, []);

  const res = await call("POST", `${autoUrl(TENANT_A)}/${SEQ}/enroll`, USER_A, {
    contactId,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, "ENROLL_NO_CONVERSATION");
  assert.equal((await enrollmentRows(SEQ, contactId)).length, 0);
  console.log(
    "[5] kontak hanya punya percakapan channel → 422 ENROLL_NO_CONVERSATION, nol enrollment lahir: OK",
  );
}

// ---------- [6] Kontak opt-out → ditolak ----------
{
  const contactId = await seedContact("Omar Optout", {
    optInStatus: "opted_out",
  });
  await seedConversation(contactId, {
    lastMessageAt: "2026-11-10T09:00:00.000Z",
  });
  const res = await call("POST", `${autoUrl(TENANT_A)}/${SEQ}/enroll`, USER_A, {
    contactId,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, "ENROLL_CONTACT_OPTED_OUT");
  assert.equal((await enrollmentRows(SEQ, contactId)).length, 0);
  console.log("[6] kontak opt-out → 422 ENROLL_CONTACT_OPTED_OUT: OK");
}

// ---------- [7] Sequence nonaktif / bukan sequence → SEQUENCE_UNAVAILABLE ----------
{
  const contactId = await seedContact("Sari Salah");
  await seedConversation(contactId, {
    lastMessageAt: "2026-11-10T09:00:00.000Z",
  });
  const notSequence = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${KW}/enroll`,
    USER_A,
    { contactId },
  );
  assert.equal(notSequence.status, 422);
  assert.equal(notSequence.body.error?.code, "SEQUENCE_UNAVAILABLE");

  const offRes = await call("POST", autoUrl(TENANT_A), USER_A, {
    kind: "sequence",
    name: "Rangkaian Mati",
    keywords: ["mati"],
    match: "exact",
    steps: [{ delayMinutes: 0, text: "Tidak terkirim." }],
  });
  assert.equal(offRes.status, 201);
  const offSeq = offRes.body.id;
  const patched = await call(
    "PATCH",
    `${autoUrl(TENANT_A)}/${offSeq}`,
    USER_A,
    { isActive: false },
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.isActive, false);
  const inactive = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${offSeq}/enroll`,
    USER_A,
    { contactId },
  );
  assert.equal(inactive.status, 422);
  assert.equal(inactive.body.error?.code, "SEQUENCE_UNAVAILABLE");
  console.log(
    "[7] automation keyword & sequence nonaktif → 422 SEQUENCE_UNAVAILABLE: OK",
  );
}

// ---------- [8] Enroll per tag: laporan agregat ----------
{
  const t1 = await seedContact("Tito Tag", { tags: ["vip"] });
  await seedConversation(t1, { lastMessageAt: "2026-11-10T09:00:00.000Z" });
  const t2 = await seedContact("Tania Tag", { tags: ["vip"] });
  await seedConversation(t2, { lastMessageAt: "2026-11-10T09:00:00.000Z" });
  // T2 sudah terdaftar lebih dulu secara manual → alreadyEnrolled.
  const pre = await call("POST", `${autoUrl(TENANT_A)}/${SEQ}/enroll`, USER_A, {
    contactId: t2,
  });
  assert.equal(pre.status, 201);
  const t3 = await seedContact("Tegar Tag", { tags: ["vip"] });
  // T3 tanpa percakapan pesan sama sekali → noConversation.
  const t4 = await seedContact("Tuti Tag", {
    tags: ["vip"],
    optInStatus: "opted_out",
  });
  await seedConversation(t4, { lastMessageAt: "2026-11-10T09:00:00.000Z" });

  const res = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll-by-tag`,
    USER_A,
    { tag: "vip" },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.tag, "vip");
  assert.equal(res.body.matched, 4);
  assert.equal(res.body.enrolled, 1);
  assert.equal(res.body.alreadyEnrolled, 1);
  assert.equal(res.body.skippedTotal, 2);
  assert.equal(res.body.skippedByReason?.noConversation, 1);
  assert.equal(res.body.skippedByReason?.contactOptedOut, 1);
  assert.equal(res.body.capped, false);
  assert.equal((await enrollmentRows(SEQ, t1)).length, 1);
  assert.equal((await enrollmentRows(SEQ, t3)).length, 0);

  const empty = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll-by-tag`,
    USER_A,
    { tag: "tidak-ada" },
  );
  assert.equal(empty.status, 200);
  assert.equal(empty.body.matched, 0);
  assert.equal(empty.body.enrolled, 0);
  assert.equal(empty.body.skippedTotal, 0);
  console.log(
    "[8] enroll per tag: matched=4, enrolled=1, already=1, dilewati=2 (1 tanpa percakapan + 1 opt-out); tag kosong → serba nol: OK",
  );
}

// ---------- [9] Isolasi tenant & membership ----------
{
  const contactB = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name) VALUES ($1, 'Kontak B') RETURNING id`,
    [TENANT_B],
  );
  const cross = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll`,
    USER_A,
    { contactId: contactB.rows[0].id },
  );
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error?.code, "NOT_FOUND");

  const outsider = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll`,
    USER_OUTSIDER,
    { contactId: manualContactId },
  );
  assert.equal(outsider.status, 404);
  assert.equal(outsider.body.error?.code, "TENANT_NOT_FOUND");
  console.log(
    "[9] kontak tenant lain → 404 NOT_FOUND; non-member → 404 TENANT_NOT_FOUND: OK",
  );
}

// ---------- [10] Aturan berhenti berlaku untuk enrollment manual ----------
{
  // (a) Kontak membalas di percakapan jangkar → enrollment batal.
  const contactId = await seedContact("Rina Balas");
  const convId = await seedConversation(contactId, {
    lastMessageAt: "2026-11-10T09:00:00.000Z",
  });
  const enrolled = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll`,
    USER_A,
    { contactId },
  );
  assert.equal(enrolled.status, 201);
  const enrollmentId = enrolled.body.enrollment!.id;
  const replyId = await seedInbound(convId, "halo, mau tanya dulu");
  const evaluated = await evaluateInboundMessageForAutomations(db, {
    tenantId: TENANT_A,
    conversationId: convId,
    messageId: replyId,
  });
  assert.equal(evaluated.cancelledEnrollments, 1);
  const rows = await enrollmentRows(SEQ, contactId);
  assert.equal(rows[0].status, "cancelled");
  assert.equal(
    (await auditRows("sequence.cancelled_reply", enrollmentId)).length,
    1,
  );

  // (b) Kontak opt-out sesudah terdaftar → langkah batal tanpa pesan.
  const contact2 = await seedContact("Bimo Berhenti");
  const conv2 = await seedConversation(contact2, {
    lastMessageAt: "2026-11-10T09:00:00.000Z",
  });
  const enrolled2 = await call(
    "POST",
    `${autoUrl(TENANT_A)}/${SEQ}/enroll`,
    USER_A,
    { contactId: contact2 },
  );
  assert.equal(enrolled2.status, 201);
  const enrollment2 = enrolled2.body.enrollment!.id;
  await client.query(`UPDATE contacts SET opt_in_status='opted_out' WHERE id=$1`, [
    contact2,
  ]);
  const stepped = await executeSequenceStep(db, {
    tenantId: TENANT_A,
    enrollmentId: enrollment2,
    stepPosition: 1,
  });
  assert.equal(stepped.executed, false);
  assert.equal(stepped.reason, "contact_opted_out");
  const outCount = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'`,
    [TENANT_A, conv2],
  );
  assert.equal(outCount.rows[0].n, "0");
  assert.equal(
    (await auditRows("sequence.cancelled_opt_out", enrollment2)).length,
    1,
  );
  console.log(
    "[10] enrollment manual tunduk pada aturan berhenti yang sama: balasan membatalkan + opt-out membatalkan langkah tanpa pesan: OK",
  );
}

await client.close();
console.log("verify-sequence-enroll (PGlite): SEMUA LULUS");
