/**
 * Verifikasi Bluesky Connect (BUKAN OAuth — formulir handle + App
 * Password) — di atas PGlite + server XRPC tiruan (node:http lokal).
 * Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan alur penuh modul bluesky-connect melawan permukaan
 * AT Protocol (POST /xrpc/com.atproto.server.createSession →
 * GET /xrpc/app.bsky.actor.getProfile):
 *   [1] kredensial valid → 201; akun channel bluesky tersimpan
 *       (external_id = DID dari sesi, handle dari sesi, app password
 *       HANYA envelope terenkripsi pada kolom token — format yang
 *       dibaca adapter Gelombang 1.5; token_type & expiry NULL
 *       karena app password tidak berkedaluwarsa), avatar dari
 *       profil tersimpan, sasaran Bluesky muncul di listPostTargets;
 *   [2] app password salah → 422 BLUESKY_CREDENTIALS_INVALID dan
 *       TIDAK ada akun yang dibuat;
 *   [3] DID yang sama dari workspace lain → 409
 *       BLUESKY_ACCOUNT_ALREADY_CONNECTED;
 *   [4] connect ulang akun sendiri dengan app password BARU → baris
 *       yang sama, kredensial tersimpan berputar (jalur rotasi);
 *   [5] avatar yang GAGAL diunduh TIDAK menggagalkan connect
 *       (fail-soft — akun tetap connected, foto kosong);
 *   [6] server Bluesky tak terjangkau → 502 BLUESKY_UNREACHABLE;
 *   [7] peran agent (bukan owner/admin) → 403.
 *
 * App password tiruan di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:bluesky-connect
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
  decryptChannelSecret,
  getProfilePhoto,
  listPostTargets,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createBlueskyConnectRoutes } from "../src/modules/bluesky-connect/routes";

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
const USER_MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A'), ($2, 'b@sk.test', 'Pemilik B'), ($3, 'm@sk.test', 'Member A')`,
  [USER_A, USER_B, USER_MEMBER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'agent')`,
  [TENANT_A, USER_A, TENANT_B, USER_B, USER_MEMBER],
);

// ---------------------------------------------------------------------------
// XRPC tiruan
// ---------------------------------------------------------------------------
const APP_PASS = "app-pass-benar-uji";
const APP_PASS_BARU = "app-pass-baru-uji";
const APP_PASS_RUSAK = "app-pass-rusak-uji";
const DID = "did:plc:kreator123";
const DID_RUSAK = "did:plc:rusak456";
const AVATAR_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fakeBaseHere = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  if (req.method === "GET" && url.pathname === "/cdn/bsky-avatar.jpg") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(AVATAR_BYTES);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cdn/broken.jpg") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("cdn rusak");
    return;
  }
  if (req.method === "POST" && url.pathname === "/xrpc/com.atproto.server.createSession") {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      const body = JSON.parse(raw) as { identifier?: string; password?: string };
      const okKreator =
        (body.identifier === "kreator.bsky.social" || body.identifier === DID) &&
        (body.password === APP_PASS || body.password === APP_PASS_BARU);
      if (okKreator) {
        json(200, {
          did: DID,
          handle: "kreator.bsky.social",
          accessJwt: "jwt-akses-uji",
          refreshJwt: "jwt-refresh-uji",
        });
        return;
      }
      if (body.identifier === "rusak.bsky.social" && body.password === APP_PASS_RUSAK) {
        json(200, {
          did: DID_RUSAK,
          handle: "rusak.bsky.social",
          accessJwt: "jwt-rusak-uji",
          refreshJwt: "jwt-refresh-rusak",
        });
        return;
      }
      json(401, {
        error: "AuthenticationRequired",
        message: "Invalid identifier or password",
      });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/xrpc/app.bsky.actor.getProfile") {
    const auth = req.headers.authorization;
    if (auth === "Bearer jwt-akses-uji") {
      json(200, {
        did: DID,
        handle: "kreator.bsky.social",
        avatar: `${fakeBaseHere}/cdn/bsky-avatar.jpg`,
      });
      return;
    }
    if (auth === "Bearer jwt-rusak-uji") {
      json(200, {
        did: DID_RUSAK,
        handle: "rusak.bsky.social",
        avatar: `${fakeBaseHere}/cdn/broken.jpg`,
      });
      return;
    }
    json(401, { error: "AuthenticationRequired", message: "Invalid token" });
    return;
  }
  json(404, { error: "NotFound", message: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake as Server & { address: () => { port: number } }).address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ---------------------------------------------------------------------------
// Aplikasi uji: modul bluesky-connect + appUser dari header uji
// ---------------------------------------------------------------------------
const CHANNEL_SECRET = randomBytes(32).toString("base64");

function buildApp(blueskyApiBase: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    const userId = c.req.header("x-test-user") ?? USER_A;
    c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
    await next();
  });
  app.route(
    "/",
    createBlueskyConnectRoutes({ db } as unknown as AuthBundle, {
      channelTokenSecret: CHANNEL_SECRET,
      blueskyApiBase,
    }),
  );
  return app;
}
const app = buildApp(fakeBase);

async function connect(
  theApp: typeof app,
  tenantId: string,
  userId: string,
  handle: string,
  appPassword: string,
) {
  return theApp.request(`/tenants/${tenantId}/bluesky-connect`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: JSON.stringify({ handle, appPassword }),
  });
}

// ---------- [1] Connect valid → akun + avatar + sasaran /posts ----------
{
  const res = await connect(app, TENANT_A, USER_A, "@kreator.bsky.social", APP_PASS);
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    channelAccountId: string;
    did: string;
    handle: string;
    status: string;
  };
  assert.equal(body.did, DID);
  assert.equal(body.handle, "kreator.bsky.social");
  assert.equal(body.status, "connected");
  assert.ok(!JSON.stringify(body).includes(APP_PASS));

  const rows = await client.query<{
    id: string;
    external_id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
    token_type: string | null;
    token_expires_at: Date | null;
    access_token_encrypted: string;
  }>(
    `SELECT id, external_id, display_name, public_handle, status, token_type,
            token_expires_at, access_token_encrypted
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'bluesky'`,
    [TENANT_A],
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0]!;
  assert.equal(row.id, body.channelAccountId);
  assert.equal(row.external_id, DID);
  assert.equal(row.public_handle, "kreator.bsky.social");
  assert.equal(row.display_name, "kreator.bsky.social");
  assert.equal(row.status, "connected");
  assert.equal(row.token_type, null);
  assert.equal(row.token_expires_at, null);
  assert.ok(row.access_token_encrypted.startsWith("v1:"));
  assert.ok(!row.access_token_encrypted.includes(APP_PASS));
  // Nilai tersimpan terdekripsi PERSIS ke app password — format yang
  // di-createSession-kan adapter penerbit Gelombang 1.5.
  assert.equal(
    decryptChannelSecret(CHANNEL_SECRET, row.access_token_encrypted),
    APP_PASS,
  );

  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    row.id,
  );
  assert.ok(photo, "avatar Bluesky harus tersimpan saat connect");
  assert.ok(Buffer.from(photo.data).equals(AVATAR_BYTES));

  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  const target = targets.find((t) => t.provider === "bluesky");
  assert.ok(target);
  assert.equal(target.providerChatId, DID);
  console.log("[1] connect valid → akun DID + app password terenkripsi (format adapter) + avatar; sasaran /posts muncul: OK");
}

// ---------- [2] App password salah → 422, tanpa akun baru ----------
{
  const res = await connect(app, TENANT_B, USER_B, "kreator.bsky.social", "app-pass-salah");
  assert.equal(res.status, 422);
  assert.equal(
    ((await res.json()) as { error: { code: string } }).error.code,
    "BLUESKY_CREDENTIALS_INVALID",
  );
  const count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM channel_accounts WHERE tenant_id = $1 AND provider = 'bluesky'`,
    [TENANT_B],
  );
  assert.equal(count.rows[0].count, "0");
  console.log("[2] kredensial ditolak → 422 BLUESKY_CREDENTIALS_INVALID; tidak ada akun: OK");
}

// ---------- [3] DID yang sama dari workspace lain → 409 ----------
{
  const res = await connect(app, TENANT_B, USER_B, "kreator.bsky.social", APP_PASS);
  assert.equal(res.status, 409);
  assert.equal(
    ((await res.json()) as { error: { code: string } }).error.code,
    "BLUESKY_ACCOUNT_ALREADY_CONNECTED",
  );
  console.log("[3] akun aktif di workspace lain → 409 BLUESKY_ACCOUNT_ALREADY_CONNECTED: OK");
}

// ---------- [4] Connect ulang akun sendiri → kredensial berputar ----------
{
  const before = await client.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE tenant_id = $1 AND provider = 'bluesky'`,
    [TENANT_A],
  );
  const res = await connect(app, TENANT_A, USER_A, "kreator.bsky.social", APP_PASS_BARU);
  assert.equal(res.status, 200);
  const after = await client.query<{ id: string; access_token_encrypted: string }>(
    `SELECT id, access_token_encrypted FROM channel_accounts WHERE tenant_id = $1 AND provider = 'bluesky'`,
    [TENANT_A],
  );
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0]!.id, before.rows[0]!.id);
  assert.equal(
    decryptChannelSecret(CHANNEL_SECRET, after.rows[0]!.access_token_encrypted),
    APP_PASS_BARU,
  );
  console.log("[4] connect ulang akun sendiri → baris sama, app password berputar: OK");
}

// ---------- [5] Avatar rusak → connect tetap berhasil (fail-soft) ----------
{
  const res = await connect(app, TENANT_B, USER_B, "rusak.bsky.social", APP_PASS_RUSAK);
  assert.equal(res.status, 201);
  const rows = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM channel_accounts WHERE tenant_id = $1 AND provider = 'bluesky'`,
    [TENANT_B],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]!.status, "connected");
  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_B },
    "channel_account",
    rows.rows[0]!.id,
  );
  assert.equal(photo, null);
  console.log("[5] unduhan avatar gagal (CDN 500) → akun tetap connected tanpa foto (fail-soft): OK");
}

// ---------- [6] Server Bluesky tak terjangkau → 502 ----------
{
  const deadApp = buildApp("http://127.0.0.1:1");
  const res = await connect(deadApp, TENANT_A, USER_A, "siapa.bsky.social", "apapun-uji");
  assert.equal(res.status, 502);
  assert.equal(
    ((await res.json()) as { error: { code: string } }).error.code,
    "BLUESKY_UNREACHABLE",
  );
  console.log("[6] PDS tak terjangkau → 502 BLUESKY_UNREACHABLE: OK");
}

// ---------- [7] Peran non-owner/admin (agent) ditolak ----------
{
  const res = await connect(app, TENANT_A, USER_MEMBER, "kreator.bsky.social", APP_PASS);
  assert.equal(res.status, 403);
  console.log("[7] peran agent (bukan owner/admin) → 403: OK");
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify bluesky-connect (PGlite + XRPC tiruan): SEMUA LULUS");
