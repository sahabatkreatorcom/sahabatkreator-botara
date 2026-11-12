/**
 * Uji integrasi JADWAL BERULANG POSTINGAN + ANTREAN RUTIN (Fase
 * Susulan S2) di atas PGlite. Yang dibuktikan:
 *  1. Matematika slot (fungsi bersama dengan G9): harian, mingguan,
 *     bulanan dengan jepit akhir bulan (31 Jan → 28 Feb → 31 Mar),
 *     jam dinding tetap melintasi DST (New York), dan pola slot
 *     antrean (queueSlotPattern + patternTimeOfDay).
 *  2. Materialisasi aturan: slot jatuh tempo melahirkan postingan
 *     terjadwal NYATA lewat jalur posts yang ada (tunggal + grup
 *     multi-target + salinan dari postingan sumber), ledger
 *     'created' membawa id anak, anak lahir approval 'draft'.
 *  3. Idempotensi: sapuan ganda — bahkan penunjuk yang dipaksa
 *     mundur ke slot yang sama — tidak melahirkan postingan kedua.
 *  4. Slot basi >1 jam dicatat missed 'slot_expired' (tidak
 *     ditembakkan); klaim basi diambil alih missed 'claim_stale'.
 *  5. Aturan jeda: slot skipped 'rule_paused'; sesudah lanjut, slot
 *     berikutnya lahir.
 *  6. Kondisi berhenti: maxOccurrences=1 menutup aturan; endsAt
 *     inklusif mengizinkan slot terakhir lalu menutup.
 *  7. Kejujuran kegagalan: akun terputus → skipped
 *     POST_TARGET_NOT_CONNECTED tanpa anak; gerbang penjadwalan
 *     grup (opsi TikTok wajib) → seluruh unit dibatalkan (tidak ada
 *     draft yatim), ledger skipped dengan kode gerbangnya.
 *  8. Interaksi S1: tenant mewajibkan persetujuan → postingan hasil
 *     materialisasi DITAHAN gerbang penerbitan
 *     (blockUnapprovedPostPublish, errorCode post_approval_required);
 *     sakelar mati → tidak ditahan.
 *  9. Antrean: urutan terjaga + geser naik; slot menarik TEPAT SATU
 *     item teratas; item keluar tertaut ke postingan hasil; antrean
 *     kosong tercatat 'empty'; slot jeda skipped 'slot_paused';
 *     kegagalan materialisasi TIDAK mengonsumsi item (reservasi
 *     lepas, item tetap teratas); klaim tembakan basi diambil alih
 *     dan reservasi dilepas.
 * 10. Isolasi tenant: bacaan core tenant B tidak melihat aturan/
 *     antrean/slot tenant A.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:post-recurrence
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
  addPostQueueItem,
  blockUnapprovedPostPublish,
  createPost,
  createPostQueueSlot,
  createPostRecurrenceRule,
  getPostRecurrenceRule,
  listPostQueueItems,
  listPostQueueSlotFirings,
  listPostRecurrenceOccurrences,
  listPostRecurrenceRules,
  movePostQueueItem,
  pausePostRecurrenceRule,
  patternTimeOfDay,
  previewRecurrenceSlots,
  processPostQueueSlots,
  processPostRecurrences,
  queueSlotPattern,
  resumePostRecurrenceRule,
  type RecurrencePattern,
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
const TG_ACCOUNT = "55555555-5555-4555-8555-555555555551";
const TT_ACCOUNT = "55555555-5555-4555-8555-555555555552";
const TG_ACCOUNT_B = "55555555-5555-4555-8555-555555555553";
const CONV_A1 = "66666666-6666-4666-8666-666666666661";
const CONV_A2 = "66666666-6666-4666-8666-666666666662";
const CONV_TT = "66666666-6666-4666-8666-666666666663";
const CONV_B = "66666666-6666-4666-8666-666666666664";
const CONTACT_A = "77777777-7777-4777-8777-777777777771";
const CONTACT_B = "77777777-7777-4777-8777-777777777772";
const MEDIA_PHOTO = "88888888-8888-4888-8888-888888888881";

await client.query(
  `INSERT INTO tenants (id, name, slug, timezone) VALUES ($1, 'Tenant Uji', 'tenant-uji', 'Asia/Jakarta'), ($2, 'Tenant Lain', 'tenant-lain', 'Asia/Jakarta')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@example.com', 'User A')`,
  [USER_A],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted)
   VALUES ($1, $2, 'telegram', 'tg_uji', 'Bot Uji', 'connected', 'v1:token'),
          ($3, $2, 'tiktok', 'tt_uji', 'TikTok Uji', 'connected', 'v1:token'),
          ($4, $5, 'telegram', 'tg_lain', 'Bot Lain', 'connected', 'v1:token')`,
  [TG_ACCOUNT, TENANT, TT_ACCOUNT, TG_ACCOUNT_B, TENANT_B],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Kanal A'), ($3, $4, 'Kanal B')`,
  [CONTACT_A, TENANT, CONTACT_B, TENANT_B],
);
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind)
   VALUES ($1, $2, $3, $4, 'telegram', '-100111', 'Kanal Satu', 'channel'),
          ($5, $2, $3, $4, 'telegram', '-100222', 'Kanal Dua', 'channel'),
          ($7, $2, $6, $4, 'tiktok', 'tt-user', 'TikTok Uji', 'channel'),
          ($11, $8, $9, $10, 'telegram', '-100333', 'Kanal B', 'channel')`,
  [
    CONV_A1, TENANT, TG_ACCOUNT, CONTACT_A,
    CONV_A2, TT_ACCOUNT, CONV_TT,
    TENANT_B, TG_ACCOUNT_B, CONTACT_B, CONV_B,
  ],
);
await client.query(
  `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes)
   VALUES ($1, $2, 't/photo.jpg', 'photo.jpg', 'image/jpeg', 2048)`,
  [MEDIA_PHOTO, TENANT],
);

function floorMinute(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  return out;
}
const NOW = floorMinute(new Date());
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const DAY_MS = 24 * 60 * 60 * 1000;

async function countRows(sqlText: string, params: unknown[] = []): Promise<number> {
  const res = await client.query<{ n: string }>(sqlText, params);
  return Number(res.rows[0].n);
}
const postCount = (tenantId: string) =>
  countRows(`SELECT COUNT(*)::text AS n FROM posts WHERE tenant_id = $1`, [tenantId]);

// ===========================================================================
// 1. Matematika jadwal bersama
// ===========================================================================
{
  const monthly: RecurrencePattern = {
    frequency: "monthly",
    interval: 1,
    daysOfWeek: [],
    dayOfMonth: 31,
    lastDayOfMonth: false,
    timezone: "Asia/Jakarta",
    startsAt: new Date("2026-01-31T02:00:00.000Z"), // 09:00 WIB
    endsAt: null,
  };
  const slots = previewRecurrenceSlots(monthly, {
    count: 3,
    from: new Date("2026-01-01T00:00:00.000Z"),
  }).map((d) => d.toISOString());
  assert.deepEqual(slots, [
    "2026-01-31T02:00:00.000Z",
    "2026-02-28T02:00:00.000Z", // dijepit ke akhir Februari
    "2026-03-31T02:00:00.000Z", // kembali ke tanggal 31 (bukan bergeser permanen)
  ]);

  const dst: RecurrencePattern = {
    frequency: "daily",
    interval: 1,
    daysOfWeek: [],
    dayOfMonth: null,
    lastDayOfMonth: false,
    timezone: "America/New_York",
    startsAt: new Date("2026-03-06T14:00:00.000Z"), // 09:00 EST
    endsAt: null,
  };
  const dstSlots = previewRecurrenceSlots(dst, {
    count: 4,
    from: new Date("2026-03-01T00:00:00.000Z"),
  }).map((d) => d.toISOString());
  assert.deepEqual(dstSlots, [
    "2026-03-06T14:00:00.000Z",
    "2026-03-07T14:00:00.000Z",
    "2026-03-08T13:00:00.000Z", // spring forward: 09:00 EDT
    "2026-03-09T13:00:00.000Z",
  ]);

  const weekly: RecurrencePattern = {
    frequency: "weekly",
    interval: 1,
    daysOfWeek: [1, 3], // Senin + Rabu
    dayOfMonth: null,
    lastDayOfMonth: false,
    timezone: "Asia/Jakarta",
    startsAt: new Date("2026-01-05T02:00:00.000Z"), // Senin 09:00 WIB
    endsAt: null,
  };
  const weeklySlots = previewRecurrenceSlots(weekly, {
    count: 3,
    from: new Date("2026-01-01T00:00:00.000Z"),
  }).map((d) => d.toISOString());
  assert.deepEqual(weeklySlots, [
    "2026-01-05T02:00:00.000Z",
    "2026-01-07T02:00:00.000Z",
    "2026-01-12T02:00:00.000Z",
  ]);

  // Pola slot antrean: Rabu 09:30 WIB dari Senin → tembakan Rabu ini.
  const slotPattern = queueSlotPattern({
    daysOfWeek: [3],
    timeOfDay: "09:30",
    timezone: "Asia/Jakarta",
    fromMs: new Date("2026-01-05T00:00:00.000Z").getTime(),
  });
  assert.ok(slotPattern);
  assert.equal(slotPattern.startsAt.toISOString(), "2026-01-07T02:30:00.000Z");
  assert.equal(patternTimeOfDay(slotPattern), "09:30");
  assert.equal(
    queueSlotPattern({
      daysOfWeek: [],
      timeOfDay: "09:30",
      timezone: "Asia/Jakarta",
      fromMs: 0,
    }),
    null,
  );
  console.log("[1] matematika jadwal (clamp bulanan, DST, mingguan, pola slot): OK");
}

// ===========================================================================
// 2. Materialisasi aturan (tunggal, grup, dari sumber) + idempotensi
// ===========================================================================
async function makeDailyRule(input: {
  name: string;
  startsAt: Date;
  targets: Array<{ conversationId: string }>;
  caption?: string;
  mediaIds?: string[];
  maxOccurrences?: number | null;
  endsAt?: Date | null;
  sourcePostId?: string;
}) {
  const result = await createPostRecurrenceRule(db, {
    tenantId: TENANT,
    userId: USER_A,
    sourcePostId: input.sourcePostId,
    name: input.name,
    template: {
      ...(input.sourcePostId
        ? {}
        : { title: input.name, caption: input.caption ?? "Caption rutin" }),
      mediaIds: input.mediaIds,
      targets: input.targets,
    },
    pattern: {
      frequency: "daily",
      startsAt: input.startsAt,
      maxOccurrences: input.maxOccurrences ?? null,
      endsAt: input.endsAt ?? null,
    },
  });
  assert.equal(result.kind, "created", JSON.stringify(result));
  return result.kind === "created" ? result.rule : null!;
}

{
  const slotAt = minutesAgo(10);
  const rule = await makeDailyRule({
    name: "Promo Harian",
    startsAt: slotAt,
    targets: [{ conversationId: CONV_A1 }],
    mediaIds: [MEDIA_PHOTO],
  });
  assert.equal(rule.nextRunAt?.toISOString(), slotAt.toISOString());

  const before = await postCount(TENANT);
  const sweep = await processPostRecurrences(db);
  assert.equal(sweep.created, 1);
  assert.equal((await postCount(TENANT)) - before, 1);

  const child = await client.query<{
    status: string;
    approval_status: string;
    scheduled_at: Date;
    caption: string;
  }>(
    `SELECT status, approval_status, scheduled_at, caption FROM posts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [TENANT],
  );
  assert.equal(child.rows[0].status, "scheduled");
  // Lahir sebagai draf persetujuan — S1 berlaku apa adanya.
  assert.equal(child.rows[0].approval_status, "draft");
  assert.equal(child.rows[0].caption, "Caption rutin");
  assert.ok(new Date(child.rows[0].scheduled_at).getTime() >= slotAt.getTime());
  assert.equal(
    await countRows(
      `SELECT COUNT(*)::text AS n FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE p.tenant_id = $1`,
      [TENANT],
    ),
    1,
  );

  const occurrences = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: rule.id,
  });
  assert.equal(occurrences.kind, "ok");
  if (occurrences.kind === "ok") {
    assert.equal(occurrences.occurrences.length, 1);
    assert.equal(occurrences.occurrences[0].status, "created");
    assert.equal(occurrences.occurrences[0].postIds.length, 1);
  }
  const refreshed = await getPostRecurrenceRule(db, {
    tenantId: TENANT,
    ruleId: rule.id,
  });
  assert.equal(refreshed?.occurrencesCreated, 1);
  assert.equal(
    refreshed?.nextRunAt?.getTime(),
    slotAt.getTime() + DAY_MS,
  );

  // Idempotensi: sapuan kedua tidak melahirkan apa pun; penunjuk
  // dipaksa mundur ke slot yang sama pun tidak (ledger final).
  const sweep2 = await processPostRecurrences(db);
  assert.equal(sweep2.created, 0);
  await client.query(
    `UPDATE post_recurrence_rules SET next_run_at = $2 WHERE id = $1`,
    [rule.id, slotAt],
  );
  const sweep3 = await processPostRecurrences(db);
  assert.equal(sweep3.created, 0);
  assert.equal(await postCount(TENANT), before + 1);
  console.log("[2] materialisasi tunggal + media + idempotensi sapuan ganda: OK");
}

{
  // Grup multi-target: satu kejadian → dua postingan satu grup.
  const rule = await makeDailyRule({
    name: "Grup Rutin",
    startsAt: minutesAgo(5),
    targets: [{ conversationId: CONV_A1 }, { conversationId: CONV_A2 }],
  });
  const before = await postCount(TENANT);
  await processPostRecurrences(db);
  assert.equal((await postCount(TENANT)) - before, 2);
  const groups = await client.query<{ group_id: string }>(
    `SELECT DISTINCT group_id FROM posts WHERE tenant_id = $1 AND group_id IS NOT NULL`,
    [TENANT],
  );
  assert.equal(groups.rows.length, 1);
  const occurrences = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: rule.id,
  });
  assert.equal(occurrences.kind, "ok");
  if (occurrences.kind === "ok") {
    assert.equal(occurrences.occurrences[0].postIds.length, 2);
    assert.equal(
      occurrences.occurrences[0].postGroupId,
      groups.rows[0].group_id,
    );
  }
  console.log("[3] materialisasi grup multi-target: OK");
}

{
  // Dari postingan sumber: templat disalin (judul/caption/media/sasaran).
  const source = await createPost(db, {
    tenantId: TENANT,
    userId: USER_A,
    conversationId: CONV_A2,
    title: "Sumber Rutin",
    caption: "Caption dari sumber",
    mediaIds: [MEDIA_PHOTO],
  });
  const rule = await makeDailyRule({
    name: "Dari Sumber",
    startsAt: minutesAgo(5),
    targets: [{ conversationId: CONV_A2 }],
    sourcePostId: source.id,
  });
  assert.equal(rule.title, "Sumber Rutin");
  assert.equal(rule.caption, "Caption dari sumber");
  assert.deepEqual(rule.mediaIds, [MEDIA_PHOTO]);
  const before = await postCount(TENANT);
  await processPostRecurrences(db);
  assert.equal((await postCount(TENANT)) - before, 1);
  const child = await client.query<{ caption: string; title: string }>(
    `SELECT caption, title FROM posts WHERE tenant_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 1`,
    [TENANT, source.id],
  );
  assert.equal(child.rows[0].title, "Sumber Rutin");
  assert.equal(child.rows[0].caption, "Caption dari sumber");
  console.log("[4] aturan dari postingan sumber (snapshot templat): OK");
}

// ===========================================================================
// 3. Missed, klaim basi, jeda, kondisi berhenti
// ===========================================================================
{
  const stale = await makeDailyRule({
    name: "Sudah Basi",
    startsAt: minutesAgo(130),
    targets: [{ conversationId: CONV_A1 }],
  });
  const before = await postCount(TENANT);
  const sweep = await processPostRecurrences(db);
  assert.equal(sweep.missed, 1);
  assert.equal(await postCount(TENANT), before);
  const occurrences = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: stale.id,
  });
  assert.equal(occurrences.kind, "ok");
  if (occurrences.kind === "ok") {
    assert.equal(occurrences.occurrences[0].status, "missed");
    assert.equal(occurrences.occurrences[0].reason, "slot_expired");
  }
  console.log("[5] slot basi >1 jam tercatat missed slot_expired: OK");
}

{
  // Klaim basi: baris ledger 'claimed' berumur 11 menit pada slot
  // yang ditunjuk next_run_at → diambil alih missed claim_stale.
  const rule = await makeDailyRule({
    name: "Klaim Basi",
    startsAt: minutesAgo(5),
    targets: [{ conversationId: CONV_A1 }],
  });
  await client.query(
    `INSERT INTO post_recurrence_occurrences (tenant_id, rule_id, slot_at, status, updated_at)
     VALUES ($1, $2, $3, 'claimed', NOW() - INTERVAL '11 minutes')`,
    [TENANT, rule.id, minutesAgo(5)],
  );
  const before = await postCount(TENANT);
  const sweep = await processPostRecurrences(db);
  assert.equal(sweep.missed, 1);
  assert.equal(await postCount(TENANT), before);
  const occurrences = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: rule.id,
  });
  assert.equal(occurrences.kind, "ok");
  if (occurrences.kind === "ok") {
    assert.equal(occurrences.occurrences[0].reason, "claim_stale");
  }
  console.log("[6] klaim materialisasi basi diambil alih missed claim_stale: OK");
}

{
  const rule = await makeDailyRule({
    name: "Jeda Dulu",
    startsAt: minutesAgo(5),
    targets: [{ conversationId: CONV_A1 }],
  });
  await pausePostRecurrenceRule(db, {
    tenantId: TENANT,
    ruleId: rule.id,
    userId: USER_A,
  });
  const before = await postCount(TENANT);
  const sweep = await processPostRecurrences(db);
  assert.equal(sweep.skipped, 1);
  assert.equal(await postCount(TENANT), before);
  const occurrences = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: rule.id,
  });
  assert.equal(occurrences.kind, "ok");
  if (occurrences.kind === "ok") {
    assert.equal(occurrences.occurrences[0].status, "skipped");
    assert.equal(occurrences.occurrences[0].reason, "rule_paused");
  }
  await resumePostRecurrenceRule(db, {
    tenantId: TENANT,
    ruleId: rule.id,
    userId: USER_A,
  });
  // Slot berikutnya jatuh tempo → lahir.
  await client.query(
    `UPDATE post_recurrence_rules SET next_run_at = $2 WHERE id = $1`,
    [rule.id, minutesAgo(2)],
  );
  const sweep2 = await processPostRecurrences(db);
  assert.equal(sweep2.created, 1);
  console.log("[7] aturan jeda skipped rule_paused, lanjut lalu lahir: OK");
}

{
  const once = await makeDailyRule({
    name: "Sekali Saja",
    startsAt: minutesAgo(5),
    targets: [{ conversationId: CONV_A1 }],
    maxOccurrences: 1,
  });
  await processPostRecurrences(db);
  const after = await getPostRecurrenceRule(db, {
    tenantId: TENANT,
    ruleId: once.id,
  });
  assert.equal(after?.status, "completed");
  assert.equal(after?.nextRunAt, null);

  const bounded = await makeDailyRule({
    name: "Berakhir Inklusif",
    startsAt: minutesAgo(5),
    targets: [{ conversationId: CONV_A1 }],
    endsAt: minutesAgo(5),
  });
  const sweep = await processPostRecurrences(db);
  assert.equal(sweep.created, 1); // slot tepat di endsAt tetap lahir
  const boundedAfter = await getPostRecurrenceRule(db, {
    tenantId: TENANT,
    ruleId: bounded.id,
  });
  assert.equal(boundedAfter?.status, "completed");
  console.log("[8] kondisi berhenti maxOccurrences + endsAt inklusif: OK");
}

// ===========================================================================
// 4. Kejujuran kegagalan materialisasi
// ===========================================================================
{
  // Grup [Telegram OK, TikTok berfoto tanpa opsi wajib]:
  // createPostGroup lolos (draft boleh belum lengkap), schedulePost
  // anggota TikTok menolak di gerbang opsi → SELURUH unit
  // dibatalkan, tidak ada draft yatim.
  const rule = await makeDailyRule({
    name: "Grup Gagal Gerbang",
    startsAt: minutesAgo(5),
    targets: [{ conversationId: CONV_A1 }, { conversationId: CONV_TT }],
    mediaIds: [MEDIA_PHOTO],
  });
  const before = await postCount(TENANT);
  const sweep = await processPostRecurrences(db);
  assert.equal(sweep.skipped, 1);
  assert.equal(await postCount(TENANT), before); // nol anak lahir
  const occurrences = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: rule.id,
  });
  assert.equal(occurrences.kind, "ok");
  if (occurrences.kind === "ok") {
    assert.equal(occurrences.occurrences[0].status, "skipped");
    assert.equal(
      occurrences.occurrences[0].reason,
      "POST_PUBLISH_OPTIONS_REQUIRED",
    );
  }
  console.log("[9] gerbang penjadwalan grup gagal → unit batal total, ledger jujur: OK");
}

{
  // Sasaran terputus di antara pembuatan aturan dan slotnya:
  // aturan menunjuk percakapan TikTok (akun sendiri), lalu akun
  // diputus → pemeriksaan awal mencatat skipped tanpa anak.
  const rule = await makeDailyRule({
    name: "TikTok Putus",
    startsAt: minutesAgo(5),
    targets: [
      {
        conversationId: CONV_TT,
      },
    ],
  });
  // Beri opsi TikTok lengkap agar aturan sah; putus akunnya sesudah itu.
  await client.query(
    `UPDATE channel_accounts SET status = 'disconnected' WHERE id = $1`,
    [TT_ACCOUNT],
  );
  const before = await postCount(TENANT);
  const sweep = await processPostRecurrences(db);
  assert.equal(sweep.skipped, 1);
  assert.equal(await postCount(TENANT), before);
  const occurrences = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: rule.id,
  });
  assert.equal(occurrences.kind, "ok");
  if (occurrences.kind === "ok") {
    assert.equal(occurrences.occurrences[0].reason, "POST_TARGET_NOT_CONNECTED");
  }
  await client.query(
    `UPDATE channel_accounts SET status = 'connected' WHERE id = $1`,
    [TT_ACCOUNT],
  );
  console.log("[10] sasaran terputus → skipped POST_TARGET_NOT_CONNECTED: OK");
}

// ===========================================================================
// 5. Interaksi persetujuan S1
// ===========================================================================
{
  await client.query(
    `UPDATE tenants SET post_approval_required = true WHERE id = $1`,
    [TENANT],
  );
  const rule = await makeDailyRule({
    name: "Perlu Persetujuan",
    startsAt: minutesAgo(5),
    targets: [{ conversationId: CONV_A1 }],
  });
  await processPostRecurrences(db);
  const occurrences = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: rule.id,
  });
  assert.equal(occurrences.kind, "ok");
  const postId = occurrences.kind === "ok" ? occurrences.occurrences[0].postIds[0] : "";
  assert.ok(postId);
  const post = await client.query<{ scheduled_at: Date; approval_status: string }>(
    `SELECT scheduled_at, approval_status FROM posts WHERE id = $1`,
    [postId],
  );
  assert.equal(post.rows[0].approval_status, "draft");
  const blocked = await blockUnapprovedPostPublish(db, {
    tenantId: TENANT,
    postId,
    expectedScheduledAt: new Date(post.rows[0].scheduled_at),
  });
  assert.equal(blocked.blocked, true);
  const afterBlock = await client.query<{ status: string; error_code: string }>(
    `SELECT status, error_code FROM posts WHERE id = $1`,
    [postId],
  );
  assert.equal(afterBlock.rows[0].status, "failed");
  assert.equal(afterBlock.rows[0].error_code, "post_approval_required");

  // Sakelar mati → postingan hasil materialisasi tidak ditahan.
  await client.query(
    `UPDATE tenants SET post_approval_required = false WHERE id = $1`,
    [TENANT],
  );
  const rule2 = await makeDailyRule({
    name: "Tanpa Persetujuan",
    startsAt: minutesAgo(4),
    targets: [{ conversationId: CONV_A1 }],
  });
  await processPostRecurrences(db);
  const occ2 = await listPostRecurrenceOccurrences(db, {
    tenantId: TENANT,
    ruleId: rule2.id,
  });
  const postId2 = occ2.kind === "ok" ? occ2.occurrences[0].postIds[0] : "";
  const post2 = await client.query<{ scheduled_at: Date }>(
    `SELECT scheduled_at FROM posts WHERE id = $1`,
    [postId2],
  );
  const blocked2 = await blockUnapprovedPostPublish(db, {
    tenantId: TENANT,
    postId: postId2,
    expectedScheduledAt: new Date(post2.rows[0].scheduled_at),
  });
  assert.equal(blocked2.blocked, false);
  console.log("[11] interaksi S1: wajib-persetujuan menahan hasil materialisasi; mati = bebas: OK");
}

// ===========================================================================
// 6. Antrean rutin
// ===========================================================================
function jakartaParts(d: Date): { hhmm: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    hhmm: `${get("hour")}:${get("minute")}`,
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

{
  const a = await addPostQueueItem(db, {
    tenantId: TENANT,
    userId: USER_A,
    item: { title: "Konten A", caption: "A" },
  });
  const b = await addPostQueueItem(db, {
    tenantId: TENANT,
    userId: USER_A,
    item: { title: "Konten B", caption: "B" },
  });
  const cItem = await addPostQueueItem(db, {
    tenantId: TENANT,
    userId: USER_A,
    item: { title: "Konten C", caption: "C", mediaIds: [MEDIA_PHOTO] },
  });
  assert.equal(a.kind, "added");
  assert.equal(b.kind, "added");
  assert.equal(cItem.kind, "added");
  const itemC = cItem.kind === "added" ? cItem.item : null!;
  // Geser C naik dua kali → urutan tarik [C, A, B].
  await movePostQueueItem(db, {
    tenantId: TENANT,
    itemId: itemC.id,
    userId: USER_A,
    direction: "up",
  });
  await movePostQueueItem(db, {
    tenantId: TENANT,
    itemId: itemC.id,
    userId: USER_A,
    direction: "up",
  });
  const queue = await listPostQueueItems(db, { tenantId: TENANT });
  assert.deepEqual(
    queue.items.map((i) => i.title),
    ["Konten C", "Konten A", "Konten B"],
  );

  // Slot: semua hari, jam = 10 menit lalu (WIB), jangkar 30 menit lalu.
  const { hhmm } = jakartaParts(minutesAgo(10));
  const slotResult = await createPostQueueSlot(db, {
    tenantId: TENANT,
    userId: USER_A,
    name: "Slot Pagi",
    targets: [{ conversationId: CONV_A1 }],
    pattern: {
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeOfDay: hhmm,
      timezone: "Asia/Jakarta",
      startsAt: minutesAgo(30),
    },
  });
  assert.equal(slotResult.kind, "created", JSON.stringify(slotResult));
  const slot = slotResult.kind === "created" ? slotResult.slot : null!;
  assert.equal(slot.timeOfDay, hhmm);
  assert.ok(slot.nextRunAt && slot.nextRunAt.getTime() <= Date.now());

  const before = await postCount(TENANT);
  const sweep = await processPostQueueSlots(db);
  assert.equal(sweep.pulled, 1);
  assert.equal((await postCount(TENANT)) - before, 1);

  const pulledList = await listPostQueueItems(db, {
    tenantId: TENANT,
    status: "pulled",
  });
  assert.equal(pulledList.items.length, 1);
  assert.equal(pulledList.items[0].title, "Konten C");
  assert.equal(pulledList.items[0].pulledPostIds.length, 1);
  const firings = await listPostQueueSlotFirings(db, {
    tenantId: TENANT,
    slotId: slot.id,
  });
  assert.equal(firings.kind, "ok");
  if (firings.kind === "ok") {
    assert.equal(firings.firings[0].status, "pulled");
    assert.equal(firings.firings[0].queueItemId, pulledList.items[0].id);
  }
  // Sapuan ulang pada slot yang sama tidak menarik lagi.
  const sweepAgain = await processPostQueueSlots(db);
  assert.equal(sweepAgain.pulled, 0);

  // Tembakan berikutnya (paksa jatuh tempo) menarik A (teratas kini).
  await client.query(
    `UPDATE post_queue_slots SET next_run_at = $2 WHERE id = $1`,
    [slot.id, minutesAgo(3)],
  );
  const sweep2 = await processPostQueueSlots(db);
  assert.equal(sweep2.pulled, 1);
  const pulled2 = await listPostQueueItems(db, {
    tenantId: TENANT,
    status: "pulled",
  });
  assert.deepEqual(
    pulled2.items.map((i) => i.title).sort(),
    ["Konten A", "Konten C"],
  );
  const remaining = await listPostQueueItems(db, { tenantId: TENANT });
  assert.deepEqual(
    remaining.items.map((i) => i.title),
    ["Konten B"],
  );
  console.log("[12] antrean: urutan + geser + tarik tepat satu teratas + tautan riwayat: OK");

  // Habiskan B, lalu tembakan pada antrean kosong tercatat empty.
  await client.query(
    `UPDATE post_queue_slots SET next_run_at = $2 WHERE id = $1`,
    [slot.id, minutesAgo(2)],
  );
  await processPostQueueSlots(db);
  await client.query(
    `UPDATE post_queue_slots SET next_run_at = $2 WHERE id = $1`,
    [slot.id, minutesAgo(1)],
  );
  const beforeEmpty = await postCount(TENANT);
  const sweepEmpty = await processPostQueueSlots(db);
  assert.equal(sweepEmpty.empty, 1);
  assert.equal(await postCount(TENANT), beforeEmpty);
  const firings2 = await listPostQueueSlotFirings(db, {
    tenantId: TENANT,
    slotId: slot.id,
  });
  assert.equal(firings2.kind, "ok");
  if (firings2.kind === "ok") {
    assert.equal(firings2.firings[0].status, "empty");
    assert.equal(firings2.firings[0].reason, "queue_empty");
  }
  console.log("[13] antrean kosong tercatat empty queue_empty, tanpa postingan karangan: OK");

  // Slot jeda → tembakan skipped slot_paused. (Instan 30 detik lalu:
  // berbeda dari tembakan empty semenit lalu di ledger yang sama.)
  await client.query(
    `UPDATE post_queue_slots SET status = 'paused', next_run_at = $2 WHERE id = $1`,
    [slot.id, new Date(NOW.getTime() - 30_000)],
  );
  const sweepPaused = await processPostQueueSlots(db);
  assert.equal(sweepPaused.skipped, 1);
  const firings3 = await listPostQueueSlotFirings(db, {
    tenantId: TENANT,
    slotId: slot.id,
  });
  assert.equal(firings3.kind, "ok");
  if (firings3.kind === "ok") {
    assert.equal(firings3.firings[0].reason, "slot_paused");
  }
  await client.query(
    `UPDATE post_queue_slots SET status = 'active' WHERE id = $1`,
    [slot.id],
  );
  console.log("[14] slot jeda tercatat skipped slot_paused: OK");
}

{
  // Kegagalan materialisasi TIDAK mengonsumsi item: slot menunjuk
  // TikTok (akun diputus sesudah slot dibuat) → tembakan skipped,
  // item tetap queued paling atas tanpa reservasi.
  const item = await addPostQueueItem(db, {
    tenantId: TENANT,
    userId: USER_A,
    item: { title: "Konten Gagal Tarik", caption: "tetap di antrean" },
  });
  assert.equal(item.kind, "added");
  const { hhmm } = jakartaParts(minutesAgo(10));
  const slotResult = await createPostQueueSlot(db, {
    tenantId: TENANT,
    userId: USER_A,
    name: "Slot TikTok",
    targets: [{ conversationId: CONV_TT }],
    pattern: {
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeOfDay: hhmm,
      timezone: "Asia/Jakarta",
      startsAt: minutesAgo(30),
    },
  });
  assert.equal(slotResult.kind, "created");
  const slot = slotResult.kind === "created" ? slotResult.slot : null!;
  await client.query(
    `UPDATE channel_accounts SET status = 'disconnected' WHERE id = $1`,
    [TT_ACCOUNT],
  );
  const sweep = await processPostQueueSlots(db);
  assert.equal(sweep.skipped, 1);
  const itemRow = await client.query<{
    status: string;
    reserved_firing_id: string | null;
  }>(
    `SELECT status, reserved_firing_id FROM post_queue_items WHERE tenant_id = $1 AND title = 'Konten Gagal Tarik'`,
    [TENANT],
  );
  assert.equal(itemRow.rows[0].status, "queued");
  assert.equal(itemRow.rows[0].reserved_firing_id, null);
  const firings = await listPostQueueSlotFirings(db, {
    tenantId: TENANT,
    slotId: slot.id,
  });
  assert.equal(firings.kind, "ok");
  if (firings.kind === "ok") {
    assert.equal(firings.firings[0].status, "skipped");
    assert.equal(firings.firings[0].reason, "POST_TARGET_NOT_CONNECTED");
  }
  await client.query(
    `UPDATE channel_accounts SET status = 'connected' WHERE id = $1`,
    [TT_ACCOUNT],
  );
  console.log("[15] kegagalan tarik tidak mengonsumsi item (reservasi lepas): OK");
}

{
  // Klaim tembakan basi: firing 'claimed' 11 menit + item tereservasi
  // olehnya → missed claim_stale dan reservasi dilepas.
  const slotRows = await client.query<{ id: string }>(
    `SELECT id FROM post_queue_slots WHERE tenant_id = $1 AND name = 'Slot TikTok'`,
    [TENANT],
  );
  const slotId = slotRows.rows[0].id;
  // Paksa slot jatuh tempo pada slot yang diklaim basi ini.
  const slotAt = minutesAgo(5);
  await client.query(
    `UPDATE post_queue_slots SET next_run_at = $2 WHERE id = $1`,
    [slotId, slotAt],
  );
  const itemRows = await client.query<{ id: string }>(
    `SELECT id FROM post_queue_items WHERE tenant_id = $1 AND title = 'Konten Gagal Tarik'`,
    [TENANT],
  );
  const firing = await client.query<{ id: string }>(
    `INSERT INTO post_queue_slot_firings (tenant_id, slot_id, slot_at, status, queue_item_id, updated_at)
     VALUES ($1, $2, $3, 'claimed', $4, NOW() - INTERVAL '11 minutes') RETURNING id`,
    [TENANT, slotId, slotAt, itemRows.rows[0].id],
  );
  await client.query(
    `UPDATE post_queue_items SET reserved_firing_id = $2, reserved_at = NOW() - INTERVAL '11 minutes' WHERE id = $1`,
    [itemRows.rows[0].id, firing.rows[0].id],
  );
  const sweep = await processPostQueueSlots(db);
  assert.equal(sweep.missed, 1);
  const itemAfter = await client.query<{ reserved_firing_id: string | null; status: string }>(
    `SELECT reserved_firing_id, status FROM post_queue_items WHERE id = $1`,
    [itemRows.rows[0].id],
  );
  assert.equal(itemAfter.rows[0].reserved_firing_id, null);
  assert.equal(itemAfter.rows[0].status, "queued");
  console.log("[16] klaim tembakan basi diambil alih missed claim_stale + reservasi lepas: OK");
}

// ===========================================================================
// 7. Isolasi tenant
// ===========================================================================
{
  const rulesB = await listPostRecurrenceRules(db, { tenantId: TENANT_B });
  assert.equal(rulesB.rules.length, 0);
  const itemsB = await listPostQueueItems(db, { tenantId: TENANT_B });
  assert.equal(itemsB.items.length, 0);
  const rulesA = await listPostRecurrenceRules(db, { tenantId: TENANT });
  assert.ok(rulesA.rules.length > 0);
  console.log("[17] isolasi tenant pada bacaan aturan + antrean: OK");
}

console.log("verify-post-recurrence: SEMUA LULUS");
await client.close();
