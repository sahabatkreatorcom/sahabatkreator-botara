/**
 * Uji integrasi mesin sequence automation (Fase 2C) di atas PGlite.
 *
 * Rantai publik membuktikan pengiriman berjeda lewat WebSocket, tetapi
 * semantik berhenti & idempotensi lebih murah dan lebih tajam dibuktikan
 * langsung terhadap service core di sini:
 *  1. Keyword pemicu → enrollment dibuat + event `sequence.step_due`
 *     langkah 1; TIDAK ada pesan keluar sebelum langkah dieksekusi;
 *     hasil evaluasi menghitung pendaftaran sebagai tembakan (agent
 *     tidak boleh menjawab pesan pemicu sequence).
 *  2. executeSequenceStep menjalankan langkah berurutan: pesan system
 *     `queued` dengan {name} ter-render, current_step maju, event
 *     `sequence.step_due` berikutnya; posisi basi ditolak (stale_step).
 *  3. Aturan berhenti balas: pesan inbound baru di percakapan yang sama
 *     membatalkan enrollment (audit sequence.cancelled_reply) dan job
 *     langkah berikutnya selesai diam-diam (enrollment_not_active).
 *  4. Rangkaian penuh sampai status completed + audit sequence.completed.
 *  5. Opt-out kontak → langkah dibatalkan (contact_opted_out), tanpa pesan.
 *  6. Pendaftaran ulang saat masih aktif (percakapan lain, kontak sama)
 *     → run `skipped` already_enrolled, tidak ada enrollment kedua.
 *  7. Kompatibilitas: automation keyword Fase 2A tetap menembak balasan
 *     langsung seperti sebelumnya.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:sequences
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
  createAutomation,
  evaluateInboundMessageForAutomations,
  executeSequenceStep,
} from "@sahabat-kreator/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../../packages/db/migrations");

// btree_gist wajib didaftarkan (Fase 13G): migrasi 0006 menjalankan
// CREATE EXTENSION btree_gist untuk constraint eksklusi anti-double-booking.
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
const ACCOUNT = "55555555-5555-4555-8555-555555555555";

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant Uji', 'tenant-uji')`,
  [TENANT],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'webchat', 'wc_uji_seq', 'connected')`,
  [ACCOUNT, TENANT],
);

const sequence = await createAutomation(
  db,
  { tenantId: TENANT },
  {
    name: "Follow-up Kelas",
    keywords: ["gabung"],
    match: "exact",
    kind: "sequence",
    steps: [
      { delayMinutes: 0, text: "Halo {name}, terima kasih sudah gabung!" },
      { delayMinutes: 1, text: "Langkah dua untuk {name}." },
      { delayMinutes: 1, text: "Langkah tiga terakhir." },
    ],
  },
);
assert.equal(sequence.kind, "sequence");
assert.equal(sequence.steps.length, 3);
assert.deepEqual(
  sequence.steps.map((s) => s.position),
  [1, 2, 3],
);

const keywordAuto = await createAutomation(
  db,
  { tenantId: TENANT },
  {
    name: "Balas Harga",
    keywords: ["harga"],
    match: "exact",
    text: "Daftar harga untuk {name}.",
  },
);
assert.equal(keywordAuto.kind, "keyword");

async function seedConversation(name: string) {
  const contact = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [TENANT, name],
  );
  const conv = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider)
     VALUES ($1, $2, $3, 'webchat') RETURNING id`,
    [TENANT, ACCOUNT, contact.rows[0].id],
  );
  return { contactId: contact.rows[0].id, conversationId: conv.rows[0].id };
}

async function seedInbound(conversationId: string, text: string) {
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received') RETURNING id`,
    [TENANT, conversationId, text],
  );
  return msg.rows[0].id;
}

async function outboundTexts(conversationId: string): Promise<string[]> {
  const r = await client.query<{ content_text: string; sender_type: string }>(
    `SELECT content_text, sender_type FROM messages
     WHERE tenant_id=$1 AND conversation_id=$2 AND direction='outbound'
     ORDER BY created_at, content_text`,
    [TENANT, conversationId],
  );
  assert.ok(r.rows.every((m) => m.sender_type === "system"));
  return r.rows.map((m) => m.content_text);
}

async function stepDueEvents(enrollmentId: string) {
  const r = await client.query<{ payload: { stepPosition: number } }>(
    `SELECT payload FROM outbox_events
     WHERE tenant_id=$1 AND type='sequence.step_due' AND payload->>'enrollmentId'=$2
     ORDER BY created_at`,
    [TENANT, enrollmentId],
  );
  return r.rows.map((x) => x.payload.stepPosition);
}

async function enrollmentRow(enrollmentId: string) {
  const r = await client.query<{
    status: string;
    current_step: number;
    next_run_at: string | null;
  }>(
    `SELECT status, current_step, next_run_at FROM sequence_enrollments WHERE id=$1`,
    [enrollmentId],
  );
  return r.rows[0];
}

async function auditCount(action: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id=$1 AND action=$2`,
    [TENANT, action],
  );
  return Number(r.rows[0].n);
}

// ---------- 1. Pemicu → enrollment + step_due, tanpa pesan keluar ----------
const a = await seedConversation("Andi Seq");
const triggerA = await seedInbound(a.conversationId, "gabung");
const evalA = await evaluateInboundMessageForAutomations(db, {
  tenantId: TENANT,
  conversationId: a.conversationId,
  messageId: triggerA,
});
assert.equal(evalA.evaluated, true);
assert.equal(evalA.fired.length, 1, "pendaftaran sequence = tembakan");
const enrollmentA = evalA.fired[0].enrollmentId!;
assert.ok(enrollmentA);
assert.equal(evalA.fired[0].outboundMessageId, null);
let rowA = await enrollmentRow(enrollmentA);
assert.equal(rowA.status, "active");
assert.equal(rowA.current_step, 0);
assert.ok(rowA.next_run_at !== null);
assert.deepEqual(await stepDueEvents(enrollmentA), [1]);
assert.deepEqual(await outboundTexts(a.conversationId), []);
assert.equal(await auditCount("sequence.enrolled"), 1);
console.log(
  "[1] pemicu sequence: enrollment aktif + step_due(1) + tanpa pesan keluar + fired=1 (agent terblokir): OK",
);

// ---------- 2. Langkah 1 & 2 dieksekusi; posisi basi ditolak ----------
const step1 = await executeSequenceStep(db, {
  tenantId: TENANT,
  enrollmentId: enrollmentA,
  stepPosition: 1,
});
assert.equal(step1.executed, true);
assert.equal(step1.nextStepPosition, 2);
assert.deepEqual(await outboundTexts(a.conversationId), [
  "Halo Andi Seq, terima kasih sudah gabung!",
]);
rowA = await enrollmentRow(enrollmentA);
assert.equal(rowA.current_step, 1);
assert.deepEqual(await stepDueEvents(enrollmentA), [1, 2]);

const stale = await executeSequenceStep(db, {
  tenantId: TENANT,
  enrollmentId: enrollmentA,
  stepPosition: 1,
});
assert.equal(stale.executed, false);
assert.equal(stale.reason, "stale_step");
assert.equal((await outboundTexts(a.conversationId)).length, 1);

const step2 = await executeSequenceStep(db, {
  tenantId: TENANT,
  enrollmentId: enrollmentA,
  stepPosition: 2,
});
assert.equal(step2.executed, true);
assert.deepEqual(await stepDueEvents(enrollmentA), [1, 2, 3]);
console.log(
  "[2] executeSequenceStep: pesan queued ter-render {name}, current_step maju, step_due berikutnya, posisi basi ditolak: OK",
);

// ---------- 3. Kontak membalas → enrollment batal; langkah 3 tak terkirim ----------
const replyA = await seedInbound(a.conversationId, "oh begitu ya");
const evalReply = await evaluateInboundMessageForAutomations(db, {
  tenantId: TENANT,
  conversationId: a.conversationId,
  messageId: replyA,
});
assert.equal(evalReply.cancelledEnrollments, 1);
rowA = await enrollmentRow(enrollmentA);
assert.equal(rowA.status, "cancelled");
assert.equal(rowA.next_run_at, null);
assert.equal(await auditCount("sequence.cancelled_reply"), 1);
const step3 = await executeSequenceStep(db, {
  tenantId: TENANT,
  enrollmentId: enrollmentA,
  stepPosition: 3,
});
assert.equal(step3.executed, false);
assert.equal(step3.reason, "enrollment_not_active");
assert.equal((await outboundTexts(a.conversationId)).length, 2);
console.log(
  "[3] aturan berhenti balas: enrollment cancelled + audit + langkah berikut tidak terkirim: OK",
);

// ---------- 4. Rangkaian penuh sampai completed ----------
const b = await seedConversation("Bina Seq");
const triggerB = await seedInbound(b.conversationId, "GABUNG");
const evalB = await evaluateInboundMessageForAutomations(db, {
  tenantId: TENANT,
  conversationId: b.conversationId,
  messageId: triggerB,
});
const enrollmentB = evalB.fired[0].enrollmentId!;
for (const pos of [1, 2, 3]) {
  const r = await executeSequenceStep(db, {
    tenantId: TENANT,
    enrollmentId: enrollmentB,
    stepPosition: pos,
  });
  assert.equal(r.executed, true);
}
const rowB = await enrollmentRow(enrollmentB);
assert.equal(rowB.status, "completed");
assert.equal(rowB.current_step, 3);
assert.equal(rowB.next_run_at, null);
assert.equal((await outboundTexts(b.conversationId)).length, 3);
assert.equal(await auditCount("sequence.completed"), 1);
console.log("[4] rangkaian penuh: 3 langkah terkirim → status completed: OK");

// ---------- 5. Opt-out → langkah dibatalkan tanpa pesan ----------
const c = await seedConversation("Cici Seq");
const triggerC = await seedInbound(c.conversationId, "gabung");
const evalC = await evaluateInboundMessageForAutomations(db, {
  tenantId: TENANT,
  conversationId: c.conversationId,
  messageId: triggerC,
});
const enrollmentC = evalC.fired[0].enrollmentId!;
await client.query(
  `UPDATE contacts SET opt_in_status='opted_out' WHERE id=$1`,
  [c.contactId],
);
const optStep = await executeSequenceStep(db, {
  tenantId: TENANT,
  enrollmentId: enrollmentC,
  stepPosition: 1,
});
assert.equal(optStep.executed, false);
assert.equal(optStep.reason, "contact_opted_out");
assert.equal((await enrollmentRow(enrollmentC)).status, "cancelled");
assert.deepEqual(await outboundTexts(c.conversationId), []);
assert.equal(await auditCount("sequence.cancelled_opt_out"), 1);
console.log("[5] opt-out: enrollment dibatalkan saat langkah dieksekusi, tanpa pesan: OK");

// ---------- 6. Pendaftaran ulang saat aktif → skipped already_enrolled ----------
const d = await seedConversation("Dodi Seq");
const triggerD = await seedInbound(d.conversationId, "gabung");
const evalD = await evaluateInboundMessageForAutomations(db, {
  tenantId: TENANT,
  conversationId: d.conversationId,
  messageId: triggerD,
});
assert.equal(evalD.fired.length, 1);
// Kontak yang sama, percakapan LAIN (pembatalan per-percakapan tidak menyentuh
// enrollment aktif di percakapan pertama) mengirim keyword lagi.
const convD2 = await client.query<{ id: string }>(
  `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider)
   VALUES ($1, $2, $3, 'webchat') RETURNING id`,
  [TENANT, ACCOUNT, d.contactId],
);
const triggerD2 = await seedInbound(convD2.rows[0].id, "gabung");
const evalD2 = await evaluateInboundMessageForAutomations(db, {
  tenantId: TENANT,
  conversationId: convD2.rows[0].id,
  messageId: triggerD2,
});
assert.equal(evalD2.fired.length, 0);
assert.equal(evalD2.skippedDuplicates, 1);
const enrollCountD = await client.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM sequence_enrollments
   WHERE tenant_id=$1 AND automation_id=$2 AND contact_id=$3`,
  [TENANT, sequence.id, d.contactId],
);
assert.equal(enrollCountD.rows[0].n, "1");
const skippedRun = await client.query<{ status: string; detail: { reason?: string } }>(
  `SELECT status, detail FROM automation_runs
   WHERE tenant_id=$1 AND automation_id=$2 AND trigger_message_id=$3`,
  [TENANT, sequence.id, triggerD2],
);
assert.equal(skippedRun.rows[0].status, "skipped");
assert.equal(skippedRun.rows[0].detail.reason, "already_enrolled");
console.log(
  "[6] pendaftaran ulang saat aktif: run skipped already_enrolled, enrollment tetap satu: OK",
);

// ---------- 7. Kompatibilitas keyword 2A ----------
const e = await seedConversation("Eka Keyword");
const triggerE = await seedInbound(e.conversationId, "harga");
const evalE = await evaluateInboundMessageForAutomations(db, {
  tenantId: TENANT,
  conversationId: e.conversationId,
  messageId: triggerE,
});
assert.equal(evalE.fired.length, 1);
assert.ok(evalE.fired[0].outboundMessageId);
assert.deepEqual(await outboundTexts(e.conversationId), [
  "Daftar harga untuk Eka Keyword.",
]);
console.log("[7] kompatibilitas: automation keyword lama tetap menembak langsung: OK");

await client.close();
console.log("verify-sequences (PGlite): SEMUA LULUS");
