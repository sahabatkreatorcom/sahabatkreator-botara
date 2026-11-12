/**
 * Verifikasi saringan Inbox "hanya akun pesan" — di atas PGlite.
 * Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Keputusan pemilik: Inbox hanya untuk akun pesan. Membuktikan:
 *   [1] daftar Inbox (HTTP) hanya memuat percakapan PESAN — DM
 *       `private` + grup `group`. Baris kind='channel' tersaring,
 *       termasuk kasus akun CAMPURAN Instagram: baris channel IG
 *       hilang, DM IG tetap tampil; baris channel Telegram & YouTube
 *       juga hilang.
 *   [2] lencana belum-dibaca navigasi konsisten: UnreadBadgeProvider
 *       menjumlah `unreadCount` dari endpoint daftar yang sama, jadi
 *       totalnya adalah jumlah daftar tersaring — unread kolom baris
 *       channel (dipaksa 7 di fixture) tidak bocor ke lencana.
 *   [3] perilaku BERSAMA tidak berubah: core `listConversations`
 *       TANPA opsi `kinds` tetap mengembalikan semua kind (inilah
 *       yang mengalir ke API publik v1, yang meneruskan query tanpa
 *       kinds); opsi kinds sendiri bersifat umum (['channel'] →
 *       hanya channel).
 *   [4] sasaran /posts tidak berubah: `listPostTargets` tetap memuat
 *       baris kind='channel' sebagai sasaran linimasa.
 *   [5] pencarian Inbox ikut tersaring: kata yang hanya cocok dengan
 *       judul baris channel menghasilkan daftar kosong.
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:inbox-filter
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
  listConversations,
  listPostTargets,
  MESSAGE_CONVERSATION_KINDS,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import type { ContactPhotoBackfillOptions } from "../src/modules/avatars/contact-photo-backfill";
import { createInboxRoutes } from "../src/modules/inbox/routes";

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
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Akun channel
const ACC_IG = "21000000-0000-4000-8000-000000000001";
const ACC_TG = "21000000-0000-4000-8000-000000000002";
const ACC_YT = "21000000-0000-4000-8000-000000000003";
// Kontak
const C_IG_SELF = "22000000-0000-4000-8000-000000000001";
const C_IG_DM = "22000000-0000-4000-8000-000000000002";
const C_TG_DM = "22000000-0000-4000-8000-000000000003";
const C_TG_GRP = "22000000-0000-4000-8000-000000000004";
const C_TG_CH = "22000000-0000-4000-8000-000000000005";
const C_YT = "22000000-0000-4000-8000-000000000006";
// Percakapan
const V_IG_CH = "23000000-0000-4000-8000-000000000001";
const V_IG_DM = "23000000-0000-4000-8000-000000000002";
const V_TG_DM = "23000000-0000-4000-8000-000000000003";
const V_TG_GRP = "23000000-0000-4000-8000-000000000004";
const V_TG_CH = "23000000-0000-4000-8000-000000000005";
const V_YT_CH = "23000000-0000-4000-8000-000000000006";

const CHANNEL_SECRET = randomBytes(32).toString("base64");
const backfillOpts: ContactPhotoBackfillOptions = {
  channelTokenSecret: CHANNEL_SECRET,
  telegramApiBase: "https://telegram.test",
  metaApiBase: "https://graph.test",
  graphApiVersion: "v21.0",
};

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a')`,
  [TENANT],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A')`,
  [USER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [TENANT, USER],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status) VALUES
   ($1, $4, 'instagram', 'ig-brand', 'IG Brand', 'connected'),
   ($2, $4, 'telegram', '424242', 'Bot Uji', 'connected'),
   ($3, $4, 'youtube', 'yt-chan', 'Kanal Video', 'connected')`,
  [ACC_IG, ACC_TG, ACC_YT, TENANT],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES
   ($1, $7, 'IG Brand'), ($2, $7, 'Penggemar IG'), ($3, $7, 'Budi Telegram'),
   ($4, $7, 'Grup Diskusi'), ($5, $7, 'Kanal Promo'), ($6, $7, 'Kanal Video')`,
  [C_IG_SELF, C_IG_DM, C_TG_DM, C_TG_GRP, C_TG_CH, C_YT, TENANT],
);
// Baris channel YouTube sengaja diberi unread_count kolom 7: nilai itu
// tidak boleh bocor ke daftar Inbox maupun total lencana.
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind, status, unread_count) VALUES
   ($1, $7, $8, $9, 'instagram', 'ig-brand', 'IG Brand', 'channel', 'open', 0),
   ($2, $7, $8, $10, 'instagram', 'dm-1', NULL, 'private', 'open', 2),
   ($3, $7, $11, $12, 'telegram', '777', NULL, 'private', 'open', 3),
   ($4, $7, $11, $13, 'telegram', '-100999', 'Grup Diskusi', 'group', 'open', 1),
   ($5, $7, $11, $14, 'telegram', '-100123', 'Kanal Promo', 'channel', 'open', 0),
   ($6, $7, $15, $16, 'youtube', 'yt-chan', 'Kanal Video', 'channel', 'open', 7)`,
  [
    V_IG_CH, V_IG_DM, V_TG_DM, V_TG_GRP, V_TG_CH, V_YT_CH, TENANT,
    ACC_IG, C_IG_SELF, C_IG_DM, ACC_TG, C_TG_DM, C_TG_GRP,
    C_TG_CH, ACC_YT, C_YT,
  ],
);

// ---------------------------------------------------------------------------
// Aplikasi uji: rute inbox dengan sesi pemilik
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  c.set("appUser", { id: USER } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createInboxRoutes(bundle, null, backfillOpts));

interface ConvRow {
  id: string;
  isChannel: boolean;
  isGroup: boolean;
  unreadCount: number;
}
async function listInbox(query = ""): Promise<ConvRow[]> {
  const res = await app.request(`/tenants/${TENANT}/conversations${query}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { conversations: ConvRow[] };
  return body.conversations;
}
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

// ---------- [1] daftar Inbox hanya percakapan pesan ----------
{
  const rows = await listInbox();
  assert.deepEqual(
    ids(rows),
    ids([{ id: V_IG_DM }, { id: V_TG_DM }, { id: V_TG_GRP }]),
    "daftar inbox harus tepat berisi DM IG, DM Telegram, dan grup Telegram",
  );
  for (const channelId of [V_IG_CH, V_TG_CH, V_YT_CH]) {
    assert.equal(
      rows.find((r) => r.id === channelId),
      undefined,
      `baris channel ${channelId} tidak boleh tampil di inbox`,
    );
  }
  assert.ok(
    rows.every((r) => !r.isChannel),
    "tidak ada baris isChannel pada daftar inbox tersaring",
  );
  assert.equal(
    rows.find((r) => r.id === V_TG_GRP)?.isGroup,
    true,
    "grup tetap tampil dan tetap tertanda isGroup",
  );
  console.log("[1] daftar inbox hanya DM + grup; kasus campuran Instagram benar: OK");
}

// ---------- [2] total lencana konsisten dengan daftar tersaring ----------
{
  const rows = await listInbox();
  // Cara UnreadBadgeProvider menghitung: jumlah unreadCount daftar ini.
  const total = rows.reduce((sum, r) => sum + (r.unreadCount || 0), 0);
  assert.equal(
    total,
    2 + 3 + 1,
    "total unread lencana = jumlah DM/grup saja; unread kolom channel (7) tidak bocor",
  );
  console.log("[2] total unread lencana konsisten dengan daftar tersaring: OK");
}

// ---------- [3] perilaku bersama listConversations tidak berubah ----------
{
  const all = await listConversations(db, { tenantId: TENANT }, {});
  assert.equal(
    all.length,
    6,
    "tanpa opsi kinds, listConversations tetap mengembalikan semua kind (jalur publik v1)",
  );
  assert.equal(
    all.filter((r) => r.isChannel).length,
    3,
    "baris channel tetap ada untuk pemanggil non-Inbox",
  );
  const messagesOnly = await listConversations(db, { tenantId: TENANT }, {
    kinds: MESSAGE_CONVERSATION_KINDS,
  });
  assert.deepEqual(
    ids(messagesOnly),
    ids([{ id: V_IG_DM }, { id: V_TG_DM }, { id: V_TG_GRP }]),
    "kinds MESSAGE_CONVERSATION_KINDS menghasilkan himpunan yang sama dengan HTTP inbox",
  );
  const channelsOnly = await listConversations(db, { tenantId: TENANT }, {
    kinds: ["channel"],
  });
  assert.equal(
    channelsOnly.length,
    3,
    "opsi kinds bersifat umum: ['channel'] mengembalikan hanya baris channel",
  );
  console.log("[3] tanpa kinds = perilaku lama; kinds umum bekerja: OK");
}

// ---------- [4] sasaran /posts tetap menerima baris channel ----------
{
  const targets = await listPostTargets(db, { tenantId: TENANT });
  const targetIds = targets.map((t) => t.conversationId);
  for (const channelId of [V_IG_CH, V_TG_CH, V_YT_CH]) {
    assert.ok(
      targetIds.includes(channelId),
      `sasaran postingan harus tetap memuat baris channel ${channelId}`,
    );
  }
  console.log("[4] listPostTargets tetap memuat baris channel: OK");
}

// ---------- [5] pencarian Inbox ikut tersaring ----------
{
  const byChannelTitle = await listInbox("?q=Kanal%20Promo");
  assert.equal(
    byChannelTitle.length,
    0,
    "pencarian yang hanya cocok dengan judul baris channel harus kosong",
  );
  const byGroupTitle = await listInbox("?q=Grup");
  assert.deepEqual(
    ids(byGroupTitle),
    [V_TG_GRP],
    "pencarian judul grup tetap menemukan grupnya",
  );
  console.log("[5] pencarian inbox ikut tersaring: OK");
}

console.log("verify:inbox-filter — SEMUA LULUS");
