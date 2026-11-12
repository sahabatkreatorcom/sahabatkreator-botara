/**
 * Verifikasi integrasi Pinterest Connect — di atas PGlite + server
 * Pinterest API v5 tiruan (node:http lokal). Dijalankan di CI
 * sebagai bagian `verify:ci`.
 *
 * Membuktikan alur penuh modul pinterest-oauth melawan permukaan
 * resmi API v5 (authorize pinterest.com/oauth/ → callback → POST
 * /v5/oauth/token dengan Basic auth app_id:secret → GET
 * /v5/user_account):
 *   [1] belum ada kredensial aplikasi → info jujur belum
 *       terkonfigurasi (available=false) & start 503 berkode;
 *   [2] kredensial dari PANEL → info available + dialog authorize
 *       ber-scope boards/pins + user_accounts:read;
 *   [3] state rusak → redirect PINTEREST_OAUTH_STATE_INVALID;
 *   [4] callback sukses → akun channel pinterest tersimpan
 *       (external_id = id akun, display_name & handle = username,
 *       KEDUA token HANYA envelope terenkripsi, token_type
 *       pinterest_user_token, expires ±30 hari), avatar dari
 *       profile_image tersimpan, sasaran Pinterest muncul di
 *       listPostTargets, dan token endpoint menerima Basic auth;
 *   [5] state yang sama diputar ulang → ditolak (nonce sekali pakai);
 *   [6] callback ?error → PINTEREST_OAUTH_CANCELLED;
 *   [7] exchange ditolak provider → PINTEREST_OAUTH_EXCHANGE_FAILED
 *       tanpa akun baru;
 *   [8] akun yang sama dari workspace lain → PINTEREST_ACCOUNT_ALREADY_CONNECTED;
 *   [9] akun sendiri terputus lalu connect lagi → revive baris yang
 *       sama (bukan duplikat);
 *  [10] fallback env untuk kredensial aplikasi (tanpa panel);
 *  [11] avatar yang GAGAL diunduh TIDAK menggagalkan connect
 *       (fail-soft — akun tetap connected, foto kosong).
 *
 * Token tiruan di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:pinterest-oauth
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
  clearPlatformSetting,
  decryptChannelSecret,
  getProfilePhoto,
  listPostTargets,
  setPlatformSetting,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createPinterestOAuthRoutes } from "../src/modules/pinterest-oauth/routes";

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
await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A'), ($2, 'b@sk.test', 'Pemilik B')`,
  [USER_A, USER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
  [TENANT_A, USER_A, TENANT_B, USER_B],
);

// ---------------------------------------------------------------------------
// Pinterest API v5 tiruan
// ---------------------------------------------------------------------------
const ACCESS_1 = "pin-access-uji-1";
const REFRESH_1 = "pin-refresh-uji-1";
const ACCESS_1B = "pin-access-uji-1b";
const REFRESH_1B = "pin-refresh-uji-1b";
const ACCESS_2 = "pin-access-uji-2";
const REFRESH_2 = "pin-refresh-uji-2";
const ACCOUNT_ID = "pin-user-1";
const ACCOUNT_ID_2 = "pin-user-2";
const AVATAR_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
let lastTokenForm: URLSearchParams | null = null;
let lastBasicAuth: string | null = null;
let exchangeCount = 0;

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fakeBaseHere = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  if (req.method === "GET" && url.pathname === "/cdn/pin-avatar.jpg") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(AVATAR_BYTES);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cdn/broken.jpg") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("cdn rusak");
    return;
  }
  if (req.method === "POST" && url.pathname === "/v5/oauth/token") {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      lastTokenForm = new URLSearchParams(raw);
      lastBasicAuth = req.headers.authorization ?? null;
      const code = lastTokenForm.get("code");
      if (code === "kode-buruk") {
        json(401, { code: 2, message: "Invalid authorization code" });
        return;
      }
      if (code === "kode-kedua") {
        json(200, {
          access_token: ACCESS_2,
          refresh_token: REFRESH_2,
          expires_in: 2592000,
          response_type: "code",
          scope: "boards:read,boards:write,pins:read,pins:write,user_accounts:read",
        });
        return;
      }
      exchangeCount += 1;
      const setB = exchangeCount > 1;
      json(200, {
        access_token: setB ? ACCESS_1B : ACCESS_1,
        refresh_token: setB ? REFRESH_1B : REFRESH_1,
        expires_in: 2592000,
        response_type: "code",
        scope: "boards:read,boards:write,pins:read,pins:write,user_accounts:read",
      });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v5/user_account") {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${ACCESS_1}` || auth === `Bearer ${ACCESS_1B}`) {
      json(200, {
        id: ACCOUNT_ID,
        username: "kreatorpin",
        account_type: "BUSINESS",
        profile_image: `${fakeBaseHere}/cdn/pin-avatar.jpg`,
      });
      return;
    }
    if (auth === `Bearer ${ACCESS_2}`) {
      json(200, {
        id: ACCOUNT_ID_2,
        username: "kreatorrusak",
        account_type: "BUSINESS",
        profile_image: `${fakeBaseHere}/cdn/broken.jpg`,
      });
      return;
    }
    json(401, { code: 3, message: "Invalid access token" });
    return;
  }
  json(404, { code: 404, message: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake as Server & { address: () => { port: number } }).address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ---------------------------------------------------------------------------
// Aplikasi uji: modul pinterest-oauth + appUser dari header uji
// ---------------------------------------------------------------------------
const MASTER = randomBytes(32).toString("base64");
const CHANNEL_SECRET = randomBytes(32).toString("base64");
const platformOpts = { masterSecret: MASTER, env: {} };

function buildApp(platform: typeof platformOpts) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    const userId = c.req.header("x-test-user") ?? USER_A;
    c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
    await next();
  });
  app.route(
    "/",
    createPinterestOAuthRoutes({ db } as unknown as AuthBundle, {
      platform,
      channelTokenSecret: CHANNEL_SECRET,
      pinterestApiBase: fakeBase,
      publicBaseUrl: "https://app.test",
      stateSecret: "state-secret-uji",
    }),
  );
  return app;
}
const app = buildApp(platformOpts);

async function startAndGetState(
  theApp: typeof app,
  tenantId: string,
  userId: string,
): Promise<string> {
  const res = await theApp.request(`/tenants/${tenantId}/pinterest-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { dialogUrl: string };
  return new URL(body.dialogUrl).searchParams.get("state")!;
}

// ---------- [1] Belum terkonfigurasi ----------
{
  const info = await app.request(`/tenants/${TENANT_A}/channels/pinterest-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  assert.equal(info.status, 200);
  const body = (await info.json()) as {
    oauthRedirectUri: string;
    appId: string | null;
    available: boolean;
  };
  assert.equal(body.available, false);
  assert.equal(body.appId, null);
  assert.equal(body.oauthRedirectUri, "https://app.test/api/oauth/pinterest/callback");

  const start = await app.request(`/tenants/${TENANT_A}/pinterest-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify({}),
  });
  assert.equal(start.status, 503);
  assert.equal(((await start.json()) as { error: { code: string } }).error.code, "PINTEREST_OAUTH_NOT_CONFIGURED");
  console.log("[1] tanpa kredensial aplikasi → info available=false; start 503 PINTEREST_OAUTH_NOT_CONFIGURED: OK");
}

// ---------- [2] Kredensial panel → dialog authorize benar ----------
await setPlatformSetting(
  db,
  { key: "pinterest_app_id", value: "pin-app-panel", updatedByUserId: USER_A },
  platformOpts,
);
await setPlatformSetting(
  db,
  { key: "pinterest_app_secret", value: "pin-secret-panel", updatedByUserId: USER_A },
  platformOpts,
);
let happyState = "";
{
  const info = await app.request(`/tenants/${TENANT_A}/channels/pinterest-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  const body = (await info.json()) as { appId: string | null; available: boolean };
  assert.equal(body.available, true);
  assert.equal(body.appId, "pin-app-panel");

  const res = await app.request(`/tenants/${TENANT_A}/pinterest-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const started = (await res.json()) as { dialogUrl: string; expiresAt: string };
  const dialog = new URL(started.dialogUrl);
  assert.equal(`${dialog.origin}${dialog.pathname}`, "https://www.pinterest.com/oauth/");
  assert.equal(dialog.searchParams.get("client_id"), "pin-app-panel");
  assert.equal(
    dialog.searchParams.get("scope"),
    "boards:read,boards:write,pins:read,pins:write,user_accounts:read",
  );
  assert.equal(dialog.searchParams.get("response_type"), "code");
  assert.equal(
    dialog.searchParams.get("redirect_uri"),
    "https://app.test/api/oauth/pinterest/callback",
  );
  happyState = dialog.searchParams.get("state")!;
  assert.ok(happyState.length > 10);
  console.log("[2] panel terisi → info available; dialog authorize pinterest.com + scope benar: OK");
}

// ---------- [3] State rusak ditolak ----------
{
  const res = await app.request(
    `/oauth/pinterest/callback?code=apapun&state=${happyState}x`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("pinterest_oauth_error=PINTEREST_OAUTH_STATE_INVALID"),
  );
  console.log("[3] state rusak → PINTEREST_OAUTH_STATE_INVALID: OK");
}

// ---------- [4] Callback sukses → akun tersimpan + avatar + sasaran /posts ----------
{
  const res = await app.request(
    `/oauth/pinterest/callback?code=kode-uji&state=${encodeURIComponent(happyState)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?pinterest_oauth=connected",
  );
  assert.equal(lastTokenForm?.get("grant_type"), "authorization_code");
  assert.equal(lastTokenForm?.get("code"), "kode-uji");
  assert.equal(
    lastTokenForm?.get("redirect_uri"),
    "https://app.test/api/oauth/pinterest/callback",
  );
  // Kredensial aplikasi pergi sebagai Basic auth, BUKAN di badan form.
  const expectedBasic = `Basic ${Buffer.from("pin-app-panel:pin-secret-panel").toString("base64")}`;
  assert.equal(lastBasicAuth, expectedBasic);
  assert.equal(lastTokenForm?.get("client_secret"), null);

  const rows = await client.query<{
    id: string;
    external_id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
    token_type: string | null;
    access_token_encrypted: string;
    refresh_token_encrypted: string;
    token_expires_at: Date;
  }>(
    `SELECT id, external_id, display_name, public_handle, status, token_type,
            access_token_encrypted, refresh_token_encrypted, token_expires_at
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'pinterest'`,
    [TENANT_A],
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0]!;
  assert.equal(row.external_id, ACCOUNT_ID);
  assert.equal(row.display_name, "kreatorpin");
  assert.equal(row.public_handle, "kreatorpin");
  assert.equal(row.status, "connected");
  assert.equal(row.token_type, "pinterest_user_token");
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.access_token_encrypted), ACCESS_1);
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.refresh_token_encrypted), REFRESH_1);
  const expectedExpiry = Date.now() + 2592000 * 1000;
  assert.ok(Math.abs(new Date(row.token_expires_at).getTime() - expectedExpiry) < 120_000);

  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    row.id,
  );
  assert.ok(photo, "avatar Pinterest harus tersimpan saat connect");
  assert.ok(Buffer.from(photo.data).equals(AVATAR_BYTES));

  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  const target = targets.find((t) => t.provider === "pinterest");
  assert.ok(target);
  assert.equal(target.providerChatId, ACCOUNT_ID);
  console.log("[4] callback → akun + kedua token terenkripsi + expiry ±30 hari; Basic auth benar; avatar tersimpan; sasaran /posts muncul: OK");

  // ---------- [5] Replay state yang sama ditolak ----------
  const replay = await app.request(
    `/oauth/pinterest/callback?code=kode-uji&state=${encodeURIComponent(happyState)}`,
  );
  assert.equal(replay.status, 302);
  assert.ok(
    (replay.headers.get("location") ?? "").includes(
      "pinterest_oauth_error=PINTEREST_OAUTH_STATE_INVALID",
    ),
  );
  console.log("[5] replay state → ditolak (nonce sekali pakai): OK");
}

// ---------- [6] User membatalkan di dialog ----------
{
  const res = await app.request(
    `/oauth/pinterest/callback?error=access_denied&error_description=dibatalkan`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("pinterest_oauth_error=PINTEREST_OAUTH_CANCELLED"),
  );
  console.log("[6] ?error dari dialog → PINTEREST_OAUTH_CANCELLED: OK");
}

// ---------- [7] Exchange ditolak provider ----------
{
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/oauth/pinterest/callback?code=kode-buruk&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes(
      "pinterest_oauth_error=PINTEREST_OAUTH_EXCHANGE_FAILED",
    ),
  );
  const count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM channel_accounts WHERE provider = 'pinterest'`,
  );
  assert.equal(count.rows[0].count, "1");
  console.log("[7] exchange gagal → PINTEREST_OAUTH_EXCHANGE_FAILED; tidak ada akun baru: OK");
}

// ---------- [8] Akun yang sama dari workspace lain ditolak ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/pinterest/callback?code=kode-uji&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes(
      "pinterest_oauth_error=PINTEREST_ACCOUNT_ALREADY_CONNECTED",
    ),
  );
  console.log("[8] akun aktif di workspace lain → PINTEREST_ACCOUNT_ALREADY_CONNECTED: OK");
}

// ---------- [9] Revive akun sendiri yang terputus ----------
{
  const before = await client.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE tenant_id = $1 AND provider = 'pinterest'`,
    [TENANT_A],
  );
  await client.query(
    `UPDATE channel_accounts SET status = 'disconnected', access_token_encrypted = NULL, refresh_token_encrypted = NULL WHERE tenant_id = $1 AND provider = 'pinterest'`,
    [TENANT_A],
  );
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/oauth/pinterest/callback?code=kode-uji&state=${encodeURIComponent(state)}`,
  );
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?pinterest_oauth=connected",
  );
  const after = await client.query<{
    id: string;
    status: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string;
  }>(
    `SELECT id, status, access_token_encrypted, refresh_token_encrypted FROM channel_accounts WHERE tenant_id = $1 AND provider = 'pinterest'`,
    [TENANT_A],
  );
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0]!.id, before.rows[0]!.id);
  assert.equal(after.rows[0]!.status, "connected");
  assert.equal(
    decryptChannelSecret(CHANNEL_SECRET, after.rows[0]!.access_token_encrypted),
    ACCESS_1B,
  );
  assert.equal(
    decryptChannelSecret(CHANNEL_SECRET, after.rows[0]!.refresh_token_encrypted),
    REFRESH_1B,
  );
  console.log("[9] connect ulang akun terputus → revive baris yang sama: OK");
}

// ---------- [11] Avatar rusak → connect tetap berhasil (fail-soft) ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/pinterest/callback?code=kode-kedua&state=${encodeURIComponent(state)}`,
  );
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?pinterest_oauth=connected",
  );
  const rows = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM channel_accounts WHERE tenant_id = $1 AND provider = 'pinterest'`,
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
  console.log("[11] unduhan avatar gagal (CDN 500) → akun tetap connected tanpa foto (fail-soft): OK");
}

// ---------- [10] Fallback env kredensial aplikasi ----------
{
  await clearPlatformSetting(db, { key: "pinterest_app_id", updatedByUserId: USER_A });
  await clearPlatformSetting(db, { key: "pinterest_app_secret", updatedByUserId: USER_A });
  const envApp = buildApp({
    masterSecret: MASTER,
    env: { pinterest_app_id: "pin-app-env", pinterest_app_secret: "pin-secret-env" },
  });
  const info = await envApp.request(`/tenants/${TENANT_A}/channels/pinterest-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  const body = (await info.json()) as { appId: string | null; available: boolean };
  assert.equal(body.available, true);
  assert.equal(body.appId, "pin-app-env");
  console.log("[10] tanpa panel → env fallback membuat connect tersedia: OK");
}

// ---------- [12] Path callback lama TIDAK terdaftar lagi (pemotongan bersih) ----------
// Aturan pemilik 2026-11-12: penyeragaman URL TANPA alias — callback
// kanonis adalah /oauth/pinterest/callback; path lama
// /pinterest/oauth/callback harus menjawab 404.
{
  const res = await app.request(`/pinterest/oauth/callback?code=apapun&state=apapun`);
  assert.equal(res.status, 404);
  console.log("[12] path callback lama /pinterest/oauth/callback → 404 (tanpa alias): OK");
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify pinterest-oauth (PGlite + Pinterest API tiruan): SEMUA LULUS");
