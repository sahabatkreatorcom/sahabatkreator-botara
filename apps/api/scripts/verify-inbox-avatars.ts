/**
 * Verifikasi perbaikan avatar inbox — di atas PGlite dengan `fetch`
 * global yang dicegat (Bot API Telegram + Graph Meta + CDN tiruan).
 * Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan laporan pemilik "inbox avatar masih placeholder":
 *   [1] resolusi avatar efektif: kontak jangkar akun channel (kontak
 *       akun-dirinya) tanpa foto kontak mewarisi URL FOTO AKUN CHANNEL
 *       — bukan null. Sejak gelombang Perbaikan /contacts, kontak
 *       jangkar TIDAK lagi tampil di daftar utama kontak (saringan
 *       akun-sendiri; cakupannya di verify:contacts), jadi pewarisan
 *       ini dibuktikan lewat endpoint DETAIL kontak, yang memakai
 *       resolusi avatar efektif yang sama. (Daftar inbox sendiri sejak
 *       gelombang saringan Inbox hanya memuat percakapan pesan, jadi
 *       baris kind='channel' TIDAK lagi muncul di sana — yang diuji di
 *       sini untuk daftar inbox adalah ketiadaan baris channel itu,
 *       dan cakupan saringannya sendiri ada di verify:inbox-filter.)
 *   [2] prioritas tidak tertukar: kontak yang JUGA berfoto memakai
 *       foto kontak (di atas foto akunnya); percakapan DM berfoto
 *       kontak memakai foto kontak seperti sebelumnya;
 *   [3] kejujuran: baris channel Telegram (jangkarnya chat channel,
 *       bukan bot) tidak tampil di inbox sama sekali (dulu: tampil
 *       tanpa ditempeli foto bot); percakapan WhatsApp dan kontak
 *       tanpa identitas/foto tetap null (placeholder sah) dan tidak
 *       ada panggilan provider apa pun untuk WhatsApp;
 *   [4] backfill malas foto kontak: kontak Telegram lama tanpa foto
 *       terisi lewat Bot API sesudah daftar kontak dibaca, kontak
 *       Messenger lama terisi lewat Graph sesudah daftar inbox dibaca
 *       — URL berubah dari null menjadi URL foto kontak; kontak Meta
 *       yang Graph-nya tidak memberi foto tetap null dengan aman;
 *   [5] URL yang diserahkan serializer benar-benar menyajikan byte
 *       foto lewat rute avatars (200 + byte identik).
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:inbox-avatars
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
  encryptChannelSecret,
  getProfilePhoto,
  storeProfilePhoto,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createAvatarsRoutes } from "../src/modules/avatars/routes";
import type { ContactPhotoBackfillOptions } from "../src/modules/avatars/contact-photo-backfill";
import { createContactsRoutes } from "../src/modules/contacts/routes";
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
const ACC_IG2 = "21000000-0000-4000-8000-000000000002";
const ACC_TG = "21000000-0000-4000-8000-000000000003";
const ACC_MSG = "21000000-0000-4000-8000-000000000004";
const ACC_WA = "21000000-0000-4000-8000-000000000005";
// Kontak
const C_IG_SELF = "22000000-0000-4000-8000-000000000001";
const C_IG2_SELF = "22000000-0000-4000-8000-000000000002";
const C_TG_DM = "22000000-0000-4000-8000-000000000003";
const C_TG_CH = "22000000-0000-4000-8000-000000000004";
const C_TG_OLD = "22000000-0000-4000-8000-000000000005";
const C_MSG_OLD = "22000000-0000-4000-8000-000000000006";
const C_MSG_NOPIC = "22000000-0000-4000-8000-000000000007";
const C_WA = "22000000-0000-4000-8000-000000000008";
const C_PLAIN = "22000000-0000-4000-8000-000000000009";
// Percakapan
const V_IG = "23000000-0000-4000-8000-000000000001";
const V_IG2 = "23000000-0000-4000-8000-000000000002";
const V_TG_DM = "23000000-0000-4000-8000-000000000003";
const V_TG_CH = "23000000-0000-4000-8000-000000000004";
const V_MSG = "23000000-0000-4000-8000-000000000005";
const V_WA = "23000000-0000-4000-8000-000000000006";

// deriveKey menuntut base64 dari tepat 32 byte (format CHANNEL_TOKEN_SECRET).
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

const enc = (plain: string) => encryptChannelSecret(CHANNEL_SECRET, plain);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted) VALUES
   ($1, $6, 'instagram', 'ig-brand-1', 'IG Brand', 'connected', NULL),
   ($2, $6, 'instagram', 'ig-brand-2', 'IG Brand Dua', 'connected', NULL),
   ($3, $6, 'telegram', '424242', 'Bot Uji', 'connected', $7),
   ($4, $6, 'messenger', 'page-9', 'Page Uji', 'connected', $8),
   ($5, $6, 'whatsapp', '628111000', 'WA Uji', 'connected', NULL)`,
  [ACC_IG, ACC_IG2, ACC_TG, ACC_MSG, ACC_WA, TENANT, enc("TEST_BOT_TOKEN"), enc("TEST_PAGE_TOKEN")],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES
   ($1, $10, 'IG Brand'), ($2, $10, 'IG Brand Dua'), ($3, $10, 'Budi Telegram'),
   ($4, $10, 'Kanal Promo'), ($5, $10, 'Citra Lama'), ($6, $10, 'Messenger user'),
   ($7, $10, 'Tanpa Foto'), ($8, $10, 'Dedi WA'), ($9, $10, 'Kontak Polos')`,
  [C_IG_SELF, C_IG2_SELF, C_TG_DM, C_TG_CH, C_TG_OLD, C_MSG_OLD, C_MSG_NOPIC, C_WA, C_PLAIN, TENANT],
);
await client.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id) VALUES
   ($1, $2, $3, 'instagram', 'ig-brand-1'),
   ($1, $4, $5, 'instagram', 'ig-brand-2'),
   ($1, $6, $7, 'telegram', '777'),
   ($1, $8, $7, 'telegram', '-100123'),
   ($1, $9, $7, 'telegram', '888'),
   ($1, $10, $11, 'messenger', 'psid-1'),
   ($1, $12, $11, 'messenger', 'psid-nopic'),
   ($1, $13, $14, 'whatsapp', '628999')`,
  [TENANT, C_IG_SELF, ACC_IG, C_IG2_SELF, ACC_IG2, C_TG_DM, ACC_TG, C_TG_CH, C_TG_OLD, C_MSG_OLD, ACC_MSG, C_MSG_NOPIC, C_WA, ACC_WA],
);
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind, status) VALUES
   ($1, $7, $8, $9, 'instagram', 'ig-brand-1', 'IG Brand', 'channel', 'open'),
   ($2, $7, $10, $11, 'instagram', 'ig-brand-2', 'IG Brand Dua', 'channel', 'open'),
   ($3, $7, $12, $13, 'telegram', '777', NULL, 'private', 'open'),
   ($4, $7, $12, $14, 'telegram', '-100123', 'Kanal Promo', 'channel', 'open'),
   ($5, $7, $15, $16, 'messenger', 'psid-1', NULL, 'private', 'open'),
   ($6, $7, $17, $18, 'whatsapp', '628999', NULL, 'private', 'open')`,
  [V_IG, V_IG2, V_TG_DM, V_TG_CH, V_MSG, V_WA, TENANT, ACC_IG, C_IG_SELF, ACC_IG2, C_IG2_SELF, ACC_TG, C_TG_DM, C_TG_CH, ACC_MSG, C_MSG_OLD, ACC_WA, C_WA],
);

// Foto tersimpan awal: akun IG (baris channel produksi), akun IG2 +
// kontaknya (uji prioritas), kontak DM Telegram, dan foto bot.
const seedPhoto = (
  ownerType: "channel_account" | "contact",
  ownerId: string,
  bytes: string,
) =>
  storeProfilePhoto(db, { tenantId: TENANT }, {
    ownerType,
    ownerId,
    contentType: "image/jpeg",
    data: Buffer.from(bytes),
  });
await seedPhoto("channel_account", ACC_IG, "ig-account-photo");
await seedPhoto("channel_account", ACC_IG2, "ig2-account-photo");
await seedPhoto("contact", C_IG2_SELF, "ig2-contact-photo");
await seedPhoto("contact", C_TG_DM, "budi-contact-photo");
await seedPhoto("channel_account", ACC_TG, "bot-photo");

// ---------------------------------------------------------------------------
// Fetch tiruan: Bot API Telegram + Graph Meta + CDN
// ---------------------------------------------------------------------------
const fetchCalls: string[] = [];
const TG_CONTACT_BYTES = Buffer.from("citra-contact-photo");
const META_CONTACT_BYTES = Buffer.from("sari-contact-photo");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(raw);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  fetchCalls.push(`${method} ${url.hostname}${url.pathname}`);

  if (url.hostname === "telegram.test") {
    if (url.pathname.endsWith("/getUserProfilePhotos")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        user_id?: number;
      };
      if (body.user_id === 888) {
        return Response.json({
          ok: true,
          result: {
            total_count: 1,
            photos: [[{ file_id: "f888", width: 160, height: 160 }]],
          },
        });
      }
      return Response.json({ ok: true, result: { total_count: 0, photos: [] } });
    }
    if (url.pathname.endsWith("/getFile")) {
      return Response.json({
        ok: true,
        result: { file_path: "photos/f888.jpg" },
      });
    }
    if (url.pathname.includes("/file/bot")) {
      return new Response(new Uint8Array(TG_CONTACT_BYTES), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
  }
  if (url.hostname === "graph.test") {
    if (url.pathname === "/v21.0/psid-1") {
      return Response.json({
        first_name: "Sari",
        last_name: "Wulandari",
        profile_pic: "https://cdn.test/sari.jpg",
      });
    }
    if (url.pathname === "/v21.0/psid-nopic") {
      return Response.json({ first_name: "Tanpa", last_name: "Foto" });
    }
    return new Response("not found", { status: 404 });
  }
  if (url.hostname === "cdn.test" && url.pathname === "/sari.jpg") {
    return new Response(new Uint8Array(META_CONTACT_BYTES), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }
  throw new Error(`fetch tak tertebak di verify: ${method} ${raw}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Aplikasi uji: route inbox + contacts + avatars dengan sesi pemilik
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  c.set("appUser", { id: USER } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createContactsRoutes(bundle, backfillOpts));
app.route("/", createInboxRoutes(bundle, null, backfillOpts));
app.route("/", createAvatarsRoutes(bundle, {}));

const channelUrl = (accountId: string) =>
  `/api/tenants/${TENANT}/avatars/channels/${accountId}`;
const contactUrl = (contactId: string) =>
  `/api/tenants/${TENANT}/avatars/contacts/${contactId}`;

async function listConversations(): Promise<
  Array<{ id: string; contactAvatarUrl: string | null }>
> {
  const res = await app.request(`/tenants/${TENANT}/conversations`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    conversations: Array<{ id: string; contactAvatarUrl: string | null }>;
  };
  return body.conversations;
}
async function listContacts(): Promise<
  Array<{ id: string; avatarUrl: string | null }>
> {
  const res = await app.request(`/tenants/${TENANT}/contacts`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    contacts: Array<{ id: string; avatarUrl: string | null }>;
  };
  return body.contacts;
}
async function getContactDetail(
  contactId: string,
): Promise<{ id: string; avatarUrl: string | null }> {
  const res = await app.request(`/tenants/${TENANT}/contacts/${contactId}`);
  assert.equal(res.status, 200);
  return (await res.json()) as { id: string; avatarUrl: string | null };
}
async function waitForContactPhoto(
  contactId: string,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const photo = await getProfilePhoto(db, { tenantId: TENANT }, "contact", contactId);
    if (photo) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// ---------- [1] fallback foto akun untuk kontak jangkar (baris channel tersaring dari inbox) ----------
{
  const convs = await listConversations();
  assert.equal(
    convs.find((row) => row.id === V_IG),
    undefined,
    "baris channel IG tidak tampil di daftar inbox (saringan percakapan pesan)",
  );
  // Keadaan awal kontak DM lama pada respons yang sama: belum ada foto
  // tersimpan saat peta URL dihitung → null; backfill yang dijadwalkan
  // respons inilah yang mengisinya (dibuktikan di [4]).
  assert.equal(
    convs.find((row) => row.id === V_MSG)?.contactAvatarUrl,
    null,
    "percakapan messenger lama mulai tanpa avatar sebelum backfill berjalan",
  );
  const contacts = await listContacts();
  assert.equal(
    contacts.find((row) => row.id === C_IG_SELF),
    undefined,
    "kontak jangkar akun IG tidak tampil di daftar utama kontak (saringan akun-sendiri)",
  );
  const detail = await getContactDetail(C_IG_SELF);
  assert.equal(
    detail.avatarUrl,
    channelUrl(ACC_IG),
    "kontak jangkar akun IG harus mewarisi foto akun channel-nya (endpoint detail)",
  );
  console.log("[1] fallback foto akun channel untuk kontak jangkar: OK");
}

// ---------- [2] prioritas foto kontak tidak tertukar ----------
{
  const convs = await listConversations();
  assert.equal(
    convs.find((row) => row.id === V_IG2),
    undefined,
    "baris channel IG kedua juga tersaring dari daftar inbox",
  );
  const contacts = await listContacts();
  assert.equal(
    contacts.find((row) => row.id === C_IG2_SELF),
    undefined,
    "kontak jangkar kedua juga tidak tampil di daftar utama kontak",
  );
  const detail2 = await getContactDetail(C_IG2_SELF);
  assert.equal(
    detail2.avatarUrl,
    contactUrl(C_IG2_SELF),
    "kontak jangkar yang berfoto tetap memakai foto kontak, bukan foto akun (endpoint detail)",
  );
  assert.equal(
    convs.find((row) => row.id === V_TG_DM)?.contactAvatarUrl,
    contactUrl(C_TG_DM),
    "percakapan DM berfoto kontak memakai foto kontak",
  );
  console.log("[2] prioritas foto kontak di atas foto akun: OK");
}

// ---------- [3] kejujuran: tanpa salah tempel, tanpa sumber = null ----------
{
  const convs = await listConversations();
  assert.equal(
    convs.find((row) => row.id === V_TG_CH),
    undefined,
    "baris channel Telegram tidak tampil di daftar inbox (tidak ditempeli foto bot)",
  );
  assert.equal(
    convs.find((row) => row.id === V_WA)?.contactAvatarUrl,
    null,
    "percakapan WhatsApp tetap tanpa avatar (platform tidak menyediakan foto profil)",
  );
  const contacts = await listContacts();
  assert.equal(
    contacts.find((row) => row.id === C_PLAIN)?.avatarUrl,
    null,
    "kontak tanpa identitas & foto tetap null",
  );
  assert.ok(
    !fetchCalls.some((call) => call.includes("628999")),
    "tidak boleh ada panggilan provider untuk kontak WhatsApp",
  );
  console.log("[3] tanpa salah tempel & placeholder jujur: OK");
}

// ---------- [4] backfill malas foto kontak (telegram + meta) ----------
// Pemicunya adalah pemuatan daftar di [1]-[3] (daftar kontak untuk
// telegram, daftar inbox untuk meta) — di sini dibuktikan hasil
// akhirnya: foto tersimpan & URL berubah pada pembacaan berikutnya.
{
  assert.ok(
    await waitForContactPhoto(C_TG_OLD),
    "backfill telegram harus menyimpan foto kontak lama",
  );
  const tgPhoto = await getProfilePhoto(db, { tenantId: TENANT }, "contact", C_TG_OLD);
  assert.ok(
    tgPhoto?.data && Buffer.from(tgPhoto.data).equals(TG_CONTACT_BYTES),
    "byte foto hasil backfill telegram harus byte dari Bot API",
  );
  assert.ok(
    fetchCalls.some((call) => call.includes("getUserProfilePhotos")),
    "backfill telegram harus memanggil getUserProfilePhotos",
  );
  const contacts = await listContacts();
  assert.equal(
    contacts.find((row) => row.id === C_TG_OLD)?.avatarUrl,
    contactUrl(C_TG_OLD),
    "sesudah backfill, daftar kontak menyajikan URL foto kontak telegram",
  );

  assert.ok(
    await waitForContactPhoto(C_MSG_OLD),
    "backfill meta harus menyimpan foto kontak messenger lama",
  );
  const metaPhoto = await getProfilePhoto(db, { tenantId: TENANT }, "contact", C_MSG_OLD);
  assert.ok(
    metaPhoto?.data && Buffer.from(metaPhoto.data).equals(META_CONTACT_BYTES),
    "byte foto hasil backfill meta harus byte dari Graph/CDN",
  );
  const convsAfter = await listConversations();
  assert.equal(
    convsAfter.find((row) => row.id === V_MSG)?.contactAvatarUrl,
    contactUrl(C_MSG_OLD),
    "sesudah backfill, inbox menyajikan URL foto kontak messenger",
  );

  assert.equal(
    await getProfilePhoto(db, { tenantId: TENANT }, "contact", C_MSG_NOPIC),
    null,
    "kontak meta tanpa foto di Graph tetap tanpa foto (aman, tanpa paksa)",
  );
  console.log("[4] backfill malas foto kontak telegram + meta: OK");
}

// ---------- [5] URL serializer benar-benar menyajikan byte ----------
{
  const res = await app.request(channelUrl(ACC_IG).replace("/api", ""));
  assert.equal(res.status, 200);
  assert.ok(
    Buffer.from(await res.arrayBuffer()).equals(Buffer.from("ig-account-photo")),
    "endpoint avatar channel harus menyajikan byte foto akun",
  );
  console.log("[5] penyajian byte lewat rute avatars: OK");
}

globalThis.fetch = realFetch;
console.log("verify:inbox-avatars — SEMUA LULUS");
