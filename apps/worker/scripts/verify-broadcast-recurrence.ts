/**
 * Uji integrasi BROADCAST BERULANG (Gelombang G9) di atas PGlite:
 * lapisan penjadwal di atas mesin broadcast Fase 7C. Yang dibuktikan:
 *  1. Matematika slot berikutnya benar: harian, mingguan (hari
 *     aktif), bulanan (tanggal + hari terakhir bulan), dan jam
 *     dinding tetap dalam zona aturan (Asia/Jakarta vs New York DST).
 *  2. Materialisasi: slot jatuh tempo melahirkan TEPAT SATU broadcast
 *     anak lewat jalur buat+jadwalkan yang ada (status scheduled,
 *     event outbox dispatch_due tertulis), ledger 'created' membawa
 *     id anak, occurrencesCreated=1, nextRunAt maju satu hari.
 *  3. Idempotensi: penyapu berjalan dua kali — dan bahkan penunjuk
 *     yang dipaksa mundur ke slot yang sama — tidak melahirkan
 *     broadcast kedua (unik (rule_id, slot_at) + jalur advance).
 *  4. Broadcast anak adalah broadcast SUNGGUHAN: dispatchBroadcast
 *     mematerialisasi penerima + pesan queued dari audiens yang ada.
 *  5. Slot basi (>1 jam) dicatat missed 'slot_expired', BUKAN
 *     ditembakkan; aturan tetap aktif untuk slot berikutnya.
 *  6. Aturan jeda tidak melahirkan: slot dicatat skipped
 *     'rule_paused'; sesudah dilanjutkan, slot berikutnya berjalan.
 *  7. Kondisi berhenti dihormati: maxOccurrences=1 menutup aturan
 *     (completed, nextRunAt null) sesudah satu anak; endsAt inklusif
 *     mengizinkan slot terakhir lalu menutup aturan.
 *  8. Ledger memuat alasan jujur: channel diputus di antara pembuatan
 *     aturan dan slotnya → skipped 'channel_disconnected', tanpa anak.
 *  9. Isolasi tenant: aturan/ledger tenant A tidak terlihat dari
 *     tenant B lewat fungsi baca core, dan anak lahir di tenant yang
 *     benar.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:broadcast-recurrence
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
  createBroadcastRecurrenceRule,
  dispatchBroadcast,
  firstRecurrenceSlotAtOrAfter,
  getBroadcastRecurrenceRule,
  listBroadcastRecurrenceOccurrences,
  pauseBroadcastRecurrenceRule,
  previewRecurrenceSlots,
  processBroadcastRecurrences,
  resumeBroadcastRecurrenceRule,
  type BroadcastRecurrencePattern,
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
const ACCOUNT_B = "55555555-5555-4555-8555-555555555556";

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
   VALUES ($1, $2, 'telegram', 'tg_uji', 'connected'), ($3, $4, 'telegram', 'tg_lain', 'connected')`,
  [ACCOUNT, TENANT, ACCOUNT_B, TENANT_B],
);
// Satu kontak beridentitas per tenant (audiens broadcast anak).
for (const [tenant, account, suffix] of [
  [TENANT, ACCOUNT, "A"],
  [TENANT_B, ACCOUNT_B, "B"],
] as const) {
  const contact = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenant, `Kontak ${suffix}`],
  );
  await client.query(
    `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id)
     VALUES ($1, $2, $3, 'telegram', $4)`,
    [tenant, contact.rows[0].id, account, `chat-${suffix}`],
  );
}

/** Lantai menit (slot menormalkan detik ke :00; selaraskan ekspektasi). */
function floorMinute(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  return out;
}
const NOW = floorMinute(new Date());
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeRule(input: {
  tenantId: string;
  userId: string;
  accountId: string;
  name: string;
  startsAt: Date;
  frequency?: "daily" | "weekly" | "monthly";
  maxOccurrences?: number | null;
  endsAt?: Date | null;
}) {
  const result = await createBroadcastRecurrenceRule(db, {
    tenantId: input.tenantId,
    userId: input.userId,
    definition: {
      name: input.name,
      channelAccountId: input.accountId,
      messageText: "Halo {name}, ini siaran uji.",
    },
    pattern: {
      frequency: input.frequency ?? "daily",
      interval: 1,
      timezone: "Asia/Jakarta",
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      maxOccurrences: input.maxOccurrences ?? null,
    },
  });
  assert.equal(result.kind, "created", `aturan harus terbuat: ${JSON.stringify(result)}`);
  return result.kind === "created" ? result.rule : null!;
}

async function occurrencesOf(ruleId: string) {
  const r = await client.query<{
    slot_at: Date;
    status: string;
    reason: string | null;
    broadcast_id: string | null;
  }>(
    `SELECT slot_at, status, reason, broadcast_id FROM broadcast_recurrence_occurrences WHERE rule_id=$1 ORDER BY slot_at`,
    [ruleId],
  );
  return r.rows;
}

async function childBroadcastsOf(tenantId: string) {
  const r = await client.query<{ id: string; status: string; name: string }>(
    `SELECT id, status, name FROM broadcasts WHERE tenant_id=$1 ORDER BY created_at`,
    [tenantId],
  );
  return r.rows;
}

// ---------- 1. Matematika slot ----------
{
  const base: BroadcastRecurrencePattern = {
    frequency: "daily",
    interval: 1,
    daysOfWeek: [],
    dayOfMonth: null,
    lastDayOfMonth: false,
    timezone: "Asia/Jakarta",
    startsAt: new Date("2026-11-13T02:00:00.000Z"), // Jumat 09:00 Jakarta
    endsAt: null,
  };
  const daily = previewRecurrenceSlots(base, {
    count: 3,
    from: new Date("2026-11-01T00:00:00.000Z"),
  }).map((d) => d.toISOString());
  assert.deepEqual(daily, [
    "2026-11-13T02:00:00.000Z",
    "2026-11-14T02:00:00.000Z",
    "2026-11-15T02:00:00.000Z",
  ]);
  const weekly = previewRecurrenceSlots(
    { ...base, frequency: "weekly", daysOfWeek: [5, 1], startsAt: new Date("2026-11-09T02:00:00.000Z") },
    { count: 4, from: new Date("2026-11-01T00:00:00.000Z") },
  ).map((d) => d.toISOString());
  assert.deepEqual(weekly, [
    "2026-11-09T02:00:00.000Z", // Senin
    "2026-11-13T02:00:00.000Z", // Jumat
    "2026-11-16T02:00:00.000Z", // Senin
    "2026-11-20T02:00:00.000Z", // Jumat
  ]);
  const monthlyClamp = previewRecurrenceSlots(
    { ...base, frequency: "monthly", dayOfMonth: 31, startsAt: new Date("2027-01-31T02:00:00.000Z") },
    { count: 3, from: new Date("2027-01-01T00:00:00.000Z") },
  ).map((d) => d.toISOString());
  assert.deepEqual(monthlyClamp, [
    "2027-01-31T02:00:00.000Z",
    "2027-02-28T02:00:00.000Z", // dijepit ke hari terakhir Februari
    "2027-03-31T02:00:00.000Z",
  ]);
  const monthlyLast = previewRecurrenceSlots(
    { ...base, frequency: "monthly", lastDayOfMonth: true, startsAt: new Date("2027-01-15T02:00:00.000Z") },
    { count: 2, from: new Date("2027-01-01T00:00:00.000Z") },
  ).map((d) => d.toISOString());
  assert.deepEqual(monthlyLast, [
    "2027-01-31T02:00:00.000Z",
    "2027-02-28T02:00:00.000Z",
  ]);
  // Zona lain: 09:00 New York melintasi DST — instan UTC bergeser, jam dinding tidak.
  const ny = previewRecurrenceSlots(
    { ...base, timezone: "America/New_York", startsAt: new Date("2026-03-06T14:00:00.000Z") },
    { count: 3, from: new Date("2026-03-01T00:00:00.000Z") },
  ).map((d) => d.toISOString());
  assert.deepEqual(ny, [
    "2026-03-06T14:00:00.000Z",
    "2026-03-07T14:00:00.000Z",
    "2026-03-08T13:00:00.000Z", // EDT mulai — tetap 09:00 dinding
  ]);
  assert.equal(
    firstRecurrenceSlotAtOrAfter(base, new Date("2026-11-14T03:00:00.000Z").getTime())?.toISOString(),
    "2026-11-15T02:00:00.000Z",
  );
  console.log("[1] matematika slot: harian/mingguan/bulanan/hari-terakhir/DST benar: OK");
}

// ---------- 2+3. Materialisasi + idempotensi ----------
let ruleAId = "";
let childId = "";
{
  const startsAt = minutesAgo(10);
  const rule = await makeRule({
    tenantId: TENANT,
    userId: USER_A,
    accountId: ACCOUNT,
    name: "Promo Harian",
    startsAt,
  });
  ruleAId = rule.id;
  assert.equal(rule.status, "active");
  assert.equal(rule.nextRunAt?.toISOString(), startsAt.toISOString());

  const sweep = await processBroadcastRecurrences(db, NOW);
  assert.equal(sweep.created, 1);
  const occ = await occurrencesOf(rule.id);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].status, "created");
  assert.equal(occ[0].reason, null);
  assert.ok(occ[0].broadcast_id, "ledger created wajib membawa id broadcast anak");
  childId = occ[0].broadcast_id!;
  const children = await childBroadcastsOf(TENANT);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, childId);
  assert.equal(children[0].status, "scheduled", "anak langsung terjadwal lewat jalur scheduleBroadcast");
  const outbox = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox_events WHERE tenant_id=$1 AND type='broadcast.dispatch_due' AND payload->>'broadcastId'=$2`,
    [TENANT, childId],
  );
  assert.equal(Number(outbox.rows[0].n), 1, "event dispatch_due untuk relay worker tertulis");
  const after = await getBroadcastRecurrenceRule(db, { tenantId: TENANT, ruleId: rule.id });
  assert.equal(after?.occurrencesCreated, 1);
  assert.equal(
    after?.nextRunAt?.toISOString(),
    new Date(startsAt.getTime() + DAY_MS).toISOString(),
    "nextRunAt maju tepat satu hari (Jakarta tanpa DST)",
  );
  console.log("[2] materialisasi: satu anak scheduled + ledger created + nextRunAt maju: OK");

  // Sapuan kedua pada jam yang sama: tidak ada yang jatuh tempo lagi.
  const sweep2 = await processBroadcastRecurrences(db, NOW);
  assert.equal(sweep2.created, 0);
  // Penunjuk dipaksa mundur ke slot yang sama (mensimulasikan sapuan
  // ganda/crash di antara finalisasi dan penyimpanan penunjuk):
  // slot yang sudah final TIDAK melahirkan anak kedua.
  await client.query(
    `UPDATE broadcast_recurrence_rules SET next_run_at=$1 WHERE id=$2`,
    [startsAt, rule.id],
  );
  const sweep3 = await processBroadcastRecurrences(db, new Date(NOW.getTime() + 30 * 60_000));
  assert.equal(sweep3.created, 0);
  assert.equal((await occurrencesOf(rule.id)).length, 1, "tetap satu baris ledger");
  assert.equal((await childBroadcastsOf(TENANT)).length, 1, "tetap satu broadcast anak");
  console.log("[3] idempotensi: sapuan berulang + penunjuk mundur tidak menggandakan: OK");
}

// ---------- 4. Anak adalah broadcast sungguhan (dispatch oleh mesin yang ada) ----------
{
  const result = await dispatchBroadcast(db, { tenantId: TENANT, broadcastId: childId });
  assert.equal(result.dispatched, true);
  assert.equal(result.materialized, 1);
  assert.equal(result.queued, 1);
  const recipients = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM broadcast_recipients WHERE broadcast_id=$1 AND status='queued'`,
    [childId],
  );
  assert.equal(Number(recipients.rows[0].n), 1);
  console.log("[4] dispatch anak: penerima + pesan queued termaterialisasi oleh mesin 7C: OK");
}

// ---------- 5. Slot basi → missed ----------
{
  const startsAt = minutesAgo(180); // 3 jam lalu — melewati ambang 1 jam
  const rule = await makeRule({
    tenantId: TENANT,
    userId: USER_A,
    accountId: ACCOUNT,
    name: "Terlambat",
    startsAt,
  });
  const sweep = await processBroadcastRecurrences(db, NOW);
  assert.equal(sweep.missed, 1);
  assert.equal(sweep.created, 0);
  const occ = await occurrencesOf(rule.id);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].status, "missed");
  assert.equal(occ[0].reason, "slot_expired");
  assert.equal(occ[0].broadcast_id, null);
  const after = await getBroadcastRecurrenceRule(db, { tenantId: TENANT, ruleId: rule.id });
  assert.equal(after?.status, "active", "aturan tetap hidup untuk slot berikutnya");
  assert.equal(
    after?.nextRunAt?.toISOString(),
    new Date(startsAt.getTime() + DAY_MS).toISOString(),
  );
  console.log("[5] slot basi: missed 'slot_expired', tanpa anak, aturan tetap aktif: OK");
}

// ---------- 6. Aturan jeda ----------
{
  const startsAt = minutesAgo(10);
  const rule = await makeRule({
    tenantId: TENANT,
    userId: USER_A,
    accountId: ACCOUNT,
    name: "Dijeda",
    startsAt,
  });
  const paused = await pauseBroadcastRecurrenceRule(db, {
    tenantId: TENANT,
    ruleId: rule.id,
    userId: USER_A,
  });
  assert.equal(paused.kind, "changed");
  const before = (await childBroadcastsOf(TENANT)).length;
  const sweep = await processBroadcastRecurrences(db, NOW);
  assert.equal(sweep.created, 0);
  assert.equal(sweep.skipped, 1);
  const occ = await occurrencesOf(rule.id);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].status, "skipped");
  assert.equal(occ[0].reason, "rule_paused");
  assert.equal((await childBroadcastsOf(TENANT)).length, before, "aturan jeda tidak melahirkan");
  const resumed = await resumeBroadcastRecurrenceRule(db, {
    tenantId: TENANT,
    ruleId: rule.id,
    userId: USER_A,
  });
  assert.equal(resumed.kind, "changed");
  // Slot berikutnya (besok) belum jatuh tempo — tidak ada kejadian baru.
  const sweep2 = await processBroadcastRecurrences(db, NOW);
  assert.equal(sweep2.created + sweep2.skipped + sweep2.missed, 0);
  console.log("[6] jeda: skipped 'rule_paused' tercatat, lanjut bersih: OK");
}

// ---------- 7. Kondisi berhenti ----------
{
  const oneShot = await makeRule({
    tenantId: TENANT,
    userId: USER_A,
    accountId: ACCOUNT,
    name: "Sekali Saja",
    startsAt: minutesAgo(10),
    maxOccurrences: 1,
  });
  await processBroadcastRecurrences(db, NOW);
  const afterOne = await getBroadcastRecurrenceRule(db, { tenantId: TENANT, ruleId: oneShot.id });
  assert.equal(afterOne?.occurrencesCreated, 1);
  assert.equal(afterOne?.status, "completed", "maxOccurrences=1 menutup aturan sesudah satu anak");
  assert.equal(afterOne?.nextRunAt, null);

  const startsAt = minutesAgo(10);
  const bounded = await makeRule({
    tenantId: TENANT,
    userId: USER_A,
    accountId: ACCOUNT,
    name: "Berbatas Tanggal",
    startsAt,
    endsAt: startsAt, // hanya slot pertama yang diizinkan (inklusif)
  });
  await processBroadcastRecurrences(db, NOW);
  const afterBounded = await getBroadcastRecurrenceRule(db, { tenantId: TENANT, ruleId: bounded.id });
  assert.equal(afterBounded?.occurrencesCreated, 1, "slot tepat pada endsAt tetap lahir");
  assert.equal(afterBounded?.status, "completed", "slot berikutnya melewati endsAt → aturan selesai");
  console.log("[7] kondisi berhenti: maxOccurrences + endsAt inklusif dihormati: OK");
}

// ---------- 8. Alasan ledger: channel terputus ----------
{
  const rule = await makeRule({
    tenantId: TENANT_B,
    userId: USER_B,
    accountId: ACCOUNT_B,
    name: "Channel Putus",
    startsAt: minutesAgo(10),
  });
  await client.query(
    `UPDATE channel_accounts SET status='disconnected' WHERE id=$1`,
    [ACCOUNT_B],
  );
  const sweep = await processBroadcastRecurrences(db, NOW);
  assert.equal(sweep.skipped, 1);
  assert.equal(sweep.created, 0);
  const occ = await occurrencesOf(rule.id);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].status, "skipped");
  assert.equal(occ[0].reason, "channel_disconnected");
  assert.equal((await childBroadcastsOf(TENANT_B)).length, 0, "tidak ada anak yatim");
  console.log("[8] ledger jujur: channel terputus → skipped 'channel_disconnected': OK");
}

// ---------- 9. Isolasi tenant ----------
{
  // Aturan tenant A tidak terbaca dari tenant B (dan sebaliknya).
  assert.equal(
    await getBroadcastRecurrenceRule(db, { tenantId: TENANT_B, ruleId: ruleAId }),
    null,
  );
  const foreign = await listBroadcastRecurrenceOccurrences(db, {
    tenantId: TENANT_B,
    ruleId: ruleAId,
  });
  assert.equal(foreign.kind, "not_found");
  const own = await listBroadcastRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: ruleAId,
  });
  assert.equal(own.kind, "ok");
  if (own.kind === "ok") assert.equal(own.occurrences.length, 1);
  // Semua anak tenant A bertenant A (tidak ada kebocoran lintas tenant).
  const stray = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM broadcasts b JOIN broadcast_recurrence_occurrences o ON o.broadcast_id=b.id WHERE b.tenant_id <> o.tenant_id`,
  );
  assert.equal(Number(stray.rows[0].n), 0);
  console.log("[9] isolasi tenant: baca lintas tenant tertutup, anak bertenant benar: OK");
}

console.log("verify-broadcast-recurrence: SEMUA LULUS");
