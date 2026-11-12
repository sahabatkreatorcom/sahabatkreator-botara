/**
 * Verifikasi Gelombang G15 — JAM KERJA TIM + SLA MANUSIA, di atas
 * PGlite. Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Definisi yang dibuktikan (lihat contracts/sla.ts):
 *   jendela menunggu dibuka pesan masuk pertama sesudah balasan
 *   manusia terakhir, pada interval tanggung jawab manusia (handoff /
 *   AI nonaktif / ditugaskan — direplay dari audit log), dan ditutup
 *   HANYA oleh pesan keluar sender_type='user'. Menit yang terbakar
 *   dihitung dari jadwal penanggung jawab (pribadi → bawaan tenant →
 *   tidak ada = TIDAK TERUKUR, bukan patuh).
 *
 * Membuktikan:
 *   [1] matematika menit jam-kerja murni: lintas akhir pekan, hari
 *       libur penuh, rentang ganda (jeda makan siang), DST spring-
 *       forward (rentang dinding 3 jam = 2 jam nyata).
 *   [2] deriveWindows: balasan AI & sistem TIDAK menutup jendela;
 *       hanya balasan manusia yang menutup; pesan masuk sesudah
 *       penutupan membuka jendela baru.
 *   [3] keadaan Inbox (getConversationSlaStates) atas data semai:
 *       terlewat lintas akhir pekan (jadwal pribadi), dalam target,
 *       jendela yang "dibalas" AI/sistem tetap terbuka, jendela
 *       tertutup manusia tidak muncul, fallback jadwal tenant,
 *       tanggung jawab yang sudah berakhir tidak muncul, tanggung
 *       jawab dari audit handoff membakar sejak handoff (bukan sejak
 *       pesan masuk), percakapan yang masih ditangani AI tidak muncul.
 *   [4] anggota tanpa jadwal di tenant tanpa jadwal bawaan →
 *       measured=false (tidak terukur); target NULL → tidak ada
 *       keadaan sama sekali; isolasi tenant.
 *   [5] laporan Analitik (getSlaReport): hitungan jendela dibuka/
 *       tertutup tepat waktu/terbuka terlewat + median menit
 *       jam-kerja jendela tertutup (30) jauh di bawah latensi
 *       jam-dindingnya. Jendela yang dibuka SEBELUM tanggung jawab
 *       mulai tidak dihitung laporan (dibuka saat AI menangani).
 *   [6] HTTP: PUT jadwal diri sendiri 200, agent menulis jadwal orang
 *       lain 403, owner menulis jadwal agent 200, jadwal tidak sah
 *       400, sasaran bukan member 404 MEMBER_NOT_FOUND, DELETE 204,
 *       PATCH pengaturan oleh agent 403 / oleh owner 200, analitik
 *       SLA 200 berbentuk benar.
 *
 * Semua tanggal semai UTC; tenant memakai zona UTC agar angka
 * ekspektasinya eksak. 2026-01-02 Jumat, 2026-01-03 Sabtu,
 * 2026-01-05 Senin. "Sekarang" untuk keadaan = Senin 12:00Z.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:sla-working-hours
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
import type { Database, WorkSchedule } from "@sahabat-kreator/db";
import {
  addWorkingMinutes,
  deriveWindows,
  getConversationSlaStates,
  getSlaReport,
  getTenantSlaSettings,
  responsibilityIntervals,
  updateTenantSlaSettings,
  upsertMemberWorkSchedule,
  workingMinutesBetween,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createSlaRoutes } from "../src/modules/sla/routes";
import { createAnalyticsRoutes } from "../src/modules/analytics/routes";

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
const AGENT2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWNER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NON_MEMBER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CHAN = "33000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-01-05T12:00:00.000Z");

const MON_FRI_9_17: WorkSchedule = {
  days: {
    "1": [{ start: "09:00", end: "17:00" }],
    "2": [{ start: "09:00", end: "17:00" }],
    "3": [{ start: "09:00", end: "17:00" }],
    "4": [{ start: "09:00", end: "17:00" }],
    "5": [{ start: "09:00", end: "17:00" }],
  },
};

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug, default_locale, timezone, sla_target_minutes, default_work_schedule) VALUES
   ($1, 'Tenant A', 'tenant-a', 'id', 'UTC', 60, $3::jsonb),
   ($2, 'Tenant B', 'tenant-b', 'en', 'UTC', 60, NULL)`,
  [TENANT, TENANT_B, JSON.stringify(MON_FRI_9_17)],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES
   ($1, 'owner@sk.test', 'Pemilik A'),
   ($2, 'agent@sk.test', 'Agen A'),
   ($3, 'agent2@sk.test', 'Agen Dua'),
   ($4, 'ownerb@sk.test', 'Pemilik B'),
   ($5, 'luar@sk.test', 'Bukan Member')`,
  [OWNER, AGENT, AGENT2, OWNER_B, NON_MEMBER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
   ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($5, $6, 'owner')`,
  [TENANT, OWNER, AGENT, AGENT2, TENANT_B, OWNER_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status) VALUES ($1, $2, 'telegram', 'bot-a', 'connected')`,
  [CHAN, TENANT],
);

// --- [1] matematika murni ---------------------------------------------------
{
  // Jumat 16:00 → Senin 10:00 = 60 (Jumat) + 60 (Senin); akhir pekan 0.
  assert.equal(
    workingMinutesBetween(
      MON_FRI_9_17,
      "UTC",
      new Date("2026-01-02T16:00:00Z"),
      new Date("2026-01-05T10:00:00Z"),
    ),
    120,
  );
  // Sabtu → Minggu: tidak ada menit kerja sama sekali.
  assert.equal(
    workingMinutesBetween(
      MON_FRI_9_17,
      "UTC",
      new Date("2026-01-03T10:00:00Z"),
      new Date("2026-01-04T12:00:00Z"),
    ),
    0,
  );
  // Rentang ganda (jeda makan siang): Senin 09–12 + 13–17 = 420.
  const split: WorkSchedule = {
    days: {
      "1": [
        { start: "09:00", end: "12:00" },
        { start: "13:00", end: "17:00" },
      ],
    },
  };
  assert.equal(
    workingMinutesBetween(
      split,
      "UTC",
      new Date("2026-01-05T08:00:00Z"),
      new Date("2026-01-05T18:00:00Z"),
    ),
    420,
  );
  // DST spring-forward New York, Minggu 2026-03-08: dinding 01:00–04:00
  // hanya 2 jam nyata (02:00 tidak pernah ada).
  const sunday: WorkSchedule = {
    days: { "0": [{ start: "01:00", end: "04:00" }] },
  };
  assert.equal(
    workingMinutesBetween(
      sunday,
      "America/New_York",
      new Date("2026-03-08T00:00:00Z"),
      new Date("2026-03-09T00:00:00Z"),
    ),
    120,
  );
  // Tenggat: Jumat 16:30 + 60 menit kerja → Senin 09:30.
  assert.equal(
    addWorkingMinutes(
      MON_FRI_9_17,
      "UTC",
      new Date("2026-01-02T16:30:00Z"),
      60,
    )?.toISOString(),
    "2026-01-05T09:30:00.000Z",
  );
  console.log("[1] matematika menit jam-kerja: OK");
}

// --- [2] deriveWindows ------------------------------------------------------
{
  const t = (iso: string) => new Date(iso);
  const windows = deriveWindows([
    { direction: "inbound", senderType: "contact", createdAt: t("2026-01-05T09:00:00Z") },
    { direction: "outbound", senderType: "agent", createdAt: t("2026-01-05T09:10:00Z") },
    { direction: "outbound", senderType: "system", createdAt: t("2026-01-05T09:20:00Z") },
    { direction: "inbound", senderType: "contact", createdAt: t("2026-01-05T09:30:00Z") },
    { direction: "outbound", senderType: "user", createdAt: t("2026-01-05T09:40:00Z") },
    { direction: "inbound", senderType: "contact", createdAt: t("2026-01-05T10:00:00Z") },
  ]);
  assert.equal(windows.length, 2, "AI/sistem tidak menutup; hanya manusia");
  assert.equal(windows[0]!.openedAt.toISOString(), "2026-01-05T09:00:00.000Z");
  assert.equal(windows[0]!.closedAt?.toISOString(), "2026-01-05T09:40:00.000Z");
  assert.equal(windows[1]!.closedAt, null);

  // Tanpa peristiwa audit + keadaan kini bertanggung jawab (warisan)
  // → interval sejak percakapan dibuat.
  const legacy = responsibilityIntervals([], {
    createdAt: t("2026-01-05T08:00:00Z"),
    updatedAt: t("2026-01-05T08:00:00Z"),
    current: { aiOff: true, assigned: false },
  });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0]!.start.toISOString(), "2026-01-05T08:00:00.000Z");
  assert.equal(legacy[0]!.end, null);
  console.log("[2] deriveWindows + interval warisan: OK");
}

// --- semai percakapan ---------------------------------------------------------
const CONV = {
  breachedMember: "44000000-0000-4000-8000-0000000000c1",
  withinMember: "44000000-0000-4000-8000-0000000000c2",
  aiAnswered: "44000000-0000-4000-8000-0000000000c3",
  closedByHuman: "44000000-0000-4000-8000-0000000000c4",
  fallbackTenant: "44000000-0000-4000-8000-0000000000c6",
  aiHandled: "44000000-0000-4000-8000-0000000000c7",
  responsibilityEnded: "44000000-0000-4000-8000-0000000000c8",
  handoffAudit: "44000000-0000-4000-8000-0000000000c9",
  unmeasuredB: "44000000-0000-4000-8000-0000000000d1",
};

async function seedConversation(
  id: string,
  tenantId: string,
  opts: {
    createdAt: string;
    updatedAt?: string;
    agentEnabled: boolean;
    assigneeUserId?: string | null;
  },
): Promise<void> {
  const contactId = crypto.randomUUID();
  await client.query(
    `INSERT INTO contacts (id, tenant_id, name, source) VALUES ($1, $2, $3, 'manual')`,
    [contactId, tenantId, `Kontak ${id.slice(-2)}`],
  );
  await client.query(
    `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, kind, status, agent_enabled, assignee_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'telegram', 'private', 'open', $5, $6, $7, $8)`,
    [
      id,
      tenantId,
      CHAN,
      contactId,
      opts.agentEnabled,
      opts.assigneeUserId ?? null,
      opts.createdAt,
      opts.updatedAt ?? opts.createdAt,
    ],
  );
}

async function seedMessage(
  tenantId: string,
  conversationId: string,
  direction: "inbound" | "outbound",
  senderType: string,
  createdAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, conversationId, direction, senderType, createdAt],
  );
}

async function seedAudit(
  tenantId: string,
  conversationId: string,
  action: string,
  createdAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, meta, created_at) VALUES ($1, 'user', $2, $3, $4::jsonb, $5)`,
    [tenantId, OWNER, action, JSON.stringify({ conversationId }), createdAt],
  );
}

// Jadwal pribadi AGENT lewat core (juga membuktikan jalur tulis core).
{
  const res = await upsertMemberWorkSchedule(
    db,
    { tenantId: TENANT, userId: OWNER },
    { targetUserId: AGENT, timezone: null, schedule: MON_FRI_9_17 },
  );
  assert.equal(res.kind, "updated");
  const forbidden = await upsertMemberWorkSchedule(
    db,
    { tenantId: TENANT, userId: AGENT },
    { targetUserId: OWNER, timezone: null, schedule: MON_FRI_9_17 },
  );
  assert.equal(forbidden.kind, "forbidden");
}

// C1 terlewat: masuk Sabtu, jadwal pribadi AGENT; Senin 12:00 sudah
// terbakar 180 menit kerja (Senin 09:00–12:00) dari target 60.
await seedConversation(CONV.breachedMember, TENANT, {
  createdAt: "2026-01-03T10:00:00Z",
  agentEnabled: false,
  assigneeUserId: AGENT,
});
await seedMessage(TENANT, CONV.breachedMember, "inbound", "contact", "2026-01-03T10:05:00Z");

// C2 dalam target: masuk Senin 11:30, terbakar 30 menit.
await seedConversation(CONV.withinMember, TENANT, {
  createdAt: "2026-01-05T11:00:00Z",
  agentEnabled: false,
  assigneeUserId: AGENT,
});
await seedMessage(TENANT, CONV.withinMember, "inbound", "contact", "2026-01-05T11:30:00Z");

// C3 "dibalas" AI + sistem: jendela TETAP terbuka sejak pesan masuk
// pertama sesudah balasan manusia terakhir (09:30, bukan 08:30).
await seedConversation(CONV.aiAnswered, TENANT, {
  createdAt: "2026-01-05T08:00:00Z",
  agentEnabled: false,
  assigneeUserId: AGENT,
});
await seedMessage(TENANT, CONV.aiAnswered, "inbound", "contact", "2026-01-05T08:30:00Z");
await seedMessage(TENANT, CONV.aiAnswered, "outbound", "user", "2026-01-05T09:00:00Z");
await seedMessage(TENANT, CONV.aiAnswered, "inbound", "contact", "2026-01-05T09:30:00Z");
await seedMessage(TENANT, CONV.aiAnswered, "outbound", "agent", "2026-01-05T09:45:00Z");
await seedMessage(TENANT, CONV.aiAnswered, "outbound", "system", "2026-01-05T09:50:00Z");

// C4 ditutup manusia → tidak ada keadaan.
await seedConversation(CONV.closedByHuman, TENANT, {
  createdAt: "2026-01-05T08:00:00Z",
  agentEnabled: false,
  assigneeUserId: AGENT,
});
await seedMessage(TENANT, CONV.closedByHuman, "inbound", "contact", "2026-01-05T09:15:00Z");
await seedMessage(TENANT, CONV.closedByHuman, "outbound", "user", "2026-01-05T09:45:00Z");

// C6 fallback jadwal tenant (AGENT2 tanpa jadwal pribadi): masuk
// Jumat 16:30 → terbakar 30 (Jumat) + 180 (Senin) = 210 → terlewat.
await seedConversation(CONV.fallbackTenant, TENANT, {
  createdAt: "2026-01-02T16:00:00Z",
  agentEnabled: false,
  assigneeUserId: AGENT2,
});
await seedMessage(TENANT, CONV.fallbackTenant, "inbound", "contact", "2026-01-02T16:30:00Z");

// C7 masih ditangani AI (agent_enabled, tak ditugaskan) → bukan SLA.
await seedConversation(CONV.aiHandled, TENANT, {
  createdAt: "2026-01-05T08:00:00Z",
  agentEnabled: true,
});
await seedMessage(TENANT, CONV.aiHandled, "inbound", "contact", "2026-01-05T10:30:00Z");

// C8 tanggung jawab BERAKHIR (assign 09:00 → unassign 10:00): jendela
// pernah ada tetapi sekarang tidak ada penanggung jawab → tak tampil.
await seedConversation(CONV.responsibilityEnded, TENANT, {
  createdAt: "2026-01-05T08:00:00Z",
  updatedAt: "2026-01-05T10:00:00Z",
  agentEnabled: true,
});
await seedAudit(TENANT, CONV.responsibilityEnded, "conversation.assigned", "2026-01-05T09:00:00Z");
await seedAudit(TENANT, CONV.responsibilityEnded, "conversation.unassigned", "2026-01-05T10:00:00Z");
await seedMessage(TENANT, CONV.responsibilityEnded, "inbound", "contact", "2026-01-05T09:15:00Z");

// C9 handoff via audit 10:00: pesan masuk 09:00 (saat AI menangani),
// menit terbakar dihitung sejak TANGGUNG JAWAB mulai (10:00) → 120.
await seedConversation(CONV.handoffAudit, TENANT, {
  createdAt: "2026-01-05T08:00:00Z",
  updatedAt: "2026-01-05T10:00:00Z",
  agentEnabled: false,
});
await seedAudit(TENANT, CONV.handoffAudit, "agent.handoff", "2026-01-05T10:00:00Z");
await seedMessage(TENANT, CONV.handoffAudit, "inbound", "contact", "2026-01-05T09:00:00Z");

// --- [3] keadaan inbox --------------------------------------------------------
{
  const states = await getConversationSlaStates(
    db,
    { tenantId: TENANT },
    Object.values(CONV),
    NOW,
  );
  const c1 = states.get(CONV.breachedMember);
  assert.ok(c1, "C1 harus punya keadaan");
  assert.equal(c1.scheduleSource, "member");
  assert.equal(c1.measured, true);
  assert.equal(c1.elapsedWorkingMinutes, 180);
  assert.equal(c1.remainingWorkingMinutes, -120);
  assert.equal(c1.breached, true);
  assert.equal(c1.deadlineAt?.toISOString(), "2026-01-05T10:00:00.000Z");

  const c2 = states.get(CONV.withinMember);
  assert.ok(c2);
  assert.equal(c2.elapsedWorkingMinutes, 30);
  assert.equal(c2.remainingWorkingMinutes, 30);
  assert.equal(c2.breached, false);
  assert.equal(c2.deadlineAt?.toISOString(), "2026-01-05T12:30:00.000Z");

  const c3 = states.get(CONV.aiAnswered);
  assert.ok(c3, "balasan AI/sistem tidak menutup jendela");
  assert.equal(c3.openedAt.toISOString(), "2026-01-05T09:30:00.000Z");
  assert.equal(c3.elapsedWorkingMinutes, 150);
  assert.equal(c3.breached, true);

  assert.equal(states.has(CONV.closedByHuman), false, "tertutup manusia → tak ada keadaan");
  assert.equal(states.has(CONV.aiHandled), false, "masih ditangani AI → bukan SLA");
  assert.equal(states.has(CONV.responsibilityEnded), false, "tanggung jawab berakhir → tak tampil");

  const c6 = states.get(CONV.fallbackTenant);
  assert.ok(c6);
  assert.equal(c6.scheduleSource, "tenant");
  assert.equal(c6.elapsedWorkingMinutes, 210);
  assert.equal(c6.breached, true);

  const c9 = states.get(CONV.handoffAudit);
  assert.ok(c9);
  assert.equal(c9.openedAt.toISOString(), "2026-01-05T09:00:00.000Z");
  assert.equal(c9.elapsedWorkingMinutes, 120, "terbakar sejak handoff, bukan sejak pesan");
  assert.equal(c9.scheduleSource, "tenant");
  assert.equal(c9.breached, true);
  console.log("[3] keadaan SLA inbox: OK");
}

// --- [4] tidak terukur + target mati + isolasi --------------------------------
{
  await seedConversation(CONV.unmeasuredB, TENANT_B, {
    createdAt: "2026-01-05T08:00:00Z",
    agentEnabled: false,
    assigneeUserId: AGENT2,
  });
  // channel_account_id merujuk akun tenant A (FK saja) — keadaan tetap
  // dibaca per tenant percakapan; tenant B tanpa jadwal apa pun.
  await client.query(
    `UPDATE conversations SET channel_account_id = $1 WHERE id = $2`,
    [CHAN, CONV.unmeasuredB],
  );
  await seedMessage(TENANT_B, CONV.unmeasuredB, "inbound", "contact", "2026-01-05T09:00:00Z");

  const statesB = await getConversationSlaStates(
    db,
    { tenantId: TENANT_B },
    [CONV.unmeasuredB],
    NOW,
  );
  const b1 = statesB.get(CONV.unmeasuredB);
  assert.ok(b1, "jendela tetap ditampilkan walau tak terukur");
  assert.equal(b1.measured, false);
  assert.equal(b1.scheduleSource, "none");
  assert.equal(b1.remainingWorkingMinutes, null);
  assert.equal(b1.breached, false, "tidak terukur TIDAK PERNAH ditandai terlewat/patuh");

  // Isolasi: percakapan tenant B tak terbaca dari konteks tenant A.
  const cross = await getConversationSlaStates(
    db,
    { tenantId: TENANT },
    [CONV.unmeasuredB],
    NOW,
  );
  assert.equal(cross.size, 0);

  // Target NULL → SLA mati: tidak ada keadaan sama sekali.
  const off = await updateTenantSlaSettings(db, {
    tenantId: TENANT_B,
    userId: OWNER_B,
    targetMinutes: null,
    defaultSchedule: null,
  });
  assert.equal(off?.targetMinutes, null);
  const statesOff = await getConversationSlaStates(
    db,
    { tenantId: TENANT_B },
    [CONV.unmeasuredB],
    NOW,
  );
  assert.equal(statesOff.size, 0);
  const settingsB = await getTenantSlaSettings(db, { tenantId: TENANT_B });
  assert.equal(settingsB.targetMinutes, null);
  console.log("[4] tidak terukur + target mati + isolasi tenant: OK");
}

// --- [5] laporan analitik -------------------------------------------------------
{
  const report = await getSlaReport(db, { tenantId: TENANT }, { days: 7, now: NOW });
  assert.equal(report.targetMinutes, 60);
  // Dibuka pada periode & saat bertanggung jawab: C1, C2, dua jendela
  // C3 (08:30→09:00 tertutup manusia; 09:30 masih terbuka), C4, C6,
  // C8 (C9 dibuka sebelum handoff → tidak dihitung; C7 bukan tanggung
  // jawab manusia).
  assert.equal(report.windowsOpened, 7);
  assert.equal(report.closedOnTime, 2, "C3 jendela pertama + C4: 30 menit kerja ≤ 60");
  assert.equal(report.closedBreached, 0);
  assert.equal(report.openWithinTarget, 1, "C2");
  assert.equal(report.openBreached, 4, "C1, C3 jendela kedua, C6, C8");
  assert.equal(report.unmeasured, 0);
  assert.equal(report.closedMeasuredSamples, 2);
  // Sampel tertutup: C4 = 30 menit kerja (09:15→09:45); jendela
  // pertama C3 = 0 menit kerja — dibuka 08:30 (sebelum jam kerja) dan
  // ditutup tepat 09:00, jadi TIDAK ADA menit jam-kerja yang terbakar
  // walau latensi dindingnya 30 menit. Median = (0 + 30) / 2 = 15.
  assert.equal(
    report.medianWorkingResponseMinutes,
    15,
    "median JAM KERJA: sampel C3 pra-jam-kerja = 0 menit, C4 = 30 menit",
  );
  console.log("[5] laporan SLA analitik: OK");
}

// --- [6] HTTP -------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? OWNER;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createSlaRoutes(bundle));
app.route("/", createAnalyticsRoutes(bundle));

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

{
  const schedUrl = (uid: string) =>
    `/tenants/${TENANT}/team/members/${uid}/work-schedule`;
  const payload = { timezone: "Asia/Jakarta", schedule: MON_FRI_9_17 };

  // Agent menulis jadwalnya sendiri → 200.
  let r = await call("PUT", schedUrl(AGENT), AGENT, payload);
  assert.equal(r.status, 200);
  assert.equal((r.body as { timezone: string }).timezone, "Asia/Jakarta");

  // Agent menulis jadwal orang lain → 403.
  r = await call("PUT", schedUrl(OWNER), AGENT, payload);
  assert.equal(r.status, 403);
  assert.equal((r.body as { error: { code: string } }).error.code, "FORBIDDEN");

  // Owner menulis jadwal agent → 200; terbaca kembali.
  r = await call("PUT", schedUrl(AGENT), OWNER, payload);
  assert.equal(r.status, 200);
  r = await call("GET", schedUrl(AGENT), AGENT2);
  assert.equal(r.status, 200);
  assert.equal(
    (r.body as { schedule: WorkSchedule }).schedule.days["1"]?.[0]?.start,
    "09:00",
  );

  // Jadwal tidak sah (selesai ≤ mulai) → 400.
  r = await call("PUT", schedUrl(AGENT), AGENT, {
    timezone: null,
    schedule: { days: { "1": [{ start: "17:00", end: "09:00" }] } },
  });
  assert.equal(r.status, 400);

  // Zona waktu tidak sah → 400.
  r = await call("PUT", schedUrl(AGENT), AGENT, {
    timezone: "Mars/Olympus",
    schedule: MON_FRI_9_17,
  });
  assert.equal(r.status, 400);

  // Sasaran bukan member → 404 MEMBER_NOT_FOUND.
  r = await call("PUT", schedUrl(NON_MEMBER), OWNER, payload);
  assert.equal(r.status, 404);
  assert.equal(
    (r.body as { error: { code: string } }).error.code,
    "MEMBER_NOT_FOUND",
  );
  r = await call("GET", schedUrl(NON_MEMBER), OWNER);
  assert.equal(r.status, 404);

  // DELETE jadwal sendiri → 204; sesudahnya jadwal null (fallback).
  r = await call("DELETE", schedUrl(AGENT), AGENT);
  assert.equal(r.status, 204);
  r = await call("GET", schedUrl(AGENT), OWNER);
  assert.equal((r.body as { schedule: unknown }).schedule, null);

  // Pengaturan tenant: agent 403, owner 200, terbaca konsisten.
  const settingsUrl = `/tenants/${TENANT}/sla/settings`;
  r = await call("PATCH", settingsUrl, AGENT, {
    targetMinutes: 45,
    defaultSchedule: MON_FRI_9_17,
  });
  assert.equal(r.status, 403);
  r = await call("PATCH", settingsUrl, OWNER, {
    targetMinutes: 60,
    defaultSchedule: MON_FRI_9_17,
  });
  assert.equal(r.status, 200);
  r = await call("GET", settingsUrl, AGENT2);
  assert.equal(r.status, 200);
  assert.equal((r.body as { targetMinutes: number }).targetMinutes, 60);

  // Analitik SLA lewat HTTP berbentuk benar.
  r = await call("GET", `/tenants/${TENANT}/analytics/sla?days=7`, OWNER);
  assert.equal(r.status, 200);
  assert.equal((r.body as { targetMinutes: number }).targetMinutes, 60);
  assert.equal(typeof (r.body as { windowsOpened: number }).windowsOpened, "number");
  console.log("[6] HTTP jadwal/pengaturan/analitik: OK");
}

console.log("verify-sla-working-hours: SEMUA LULUS");
