/**
 * Verifikasi integrasi Threads (connect/OAuth) — di atas PGlite +
 * server Threads API tiruan (node:http lokal). Dijalankan di CI
 * sebagai bagian `verify:ci`.
 *
 * Membuktikan alur penuh modul threads-oauth melawan permukaan resmi
 * Threads (authorize threads.net → callback → POST /oauth/access_token
 * → GET /access_token grant th_exchange_token → GET /v1.0/me):
 *   [1] belum ada kredensial aplikasi → info jujur belum
 *       terkonfigurasi (available=false) & start 503 berkode;
 *   [2] kredensial dari PANEL → info available + dialog authorize
 *       ber-scope threads_basic,threads_content_publish;
 *   [3] state rusak → redirect THREADS_OAUTH_STATE_INVALID;
 *   [4] callback sukses → akun channel threads tersimpan (external_id
 *       = Threads user ID, display_name & handle dari profil, token
 *       HANYA envelope terenkripsi berisi token berumur panjang,
 *       token_type threads_user_token, expires dari expires_in) dan
 *       sasaran Threads muncul di listPostTargets;
 *   [5] state yang sama diputar ulang → ditolak (nonce sekali pakai);
 *   [6] callback ?error → THREADS_OAUTH_CANCELLED;
 *   [7] exchange ditolak provider → THREADS_OAUTH_EXCHANGE_FAILED
 *       tanpa akun baru;
 *   [8] akun yang sama dari workspace lain → THREADS_ACCOUNT_ALREADY_CONNECTED;
 *   [9] akun sendiri terputus lalu connect lagi → revive baris yang
 *       sama (bukan duplikat);
 *  [10] fallback env untuk kredensial aplikasi (tanpa panel).
 *
 * Token tiruan di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:threads-oauth
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
  listPostTargets,
  setPlatformSetting,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createThreadsOAuthRoutes } from "../src/modules/threads-oauth/routes";

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
// Threads API tiruan
// ---------------------------------------------------------------------------
const SHORT_TOKEN = "threads-short-token-uji";
const LONG_TOKEN = "threads-long-token-uji";
const THREADS_USER_ID = "123456789";
let exchangeShouldFail = false;
let lastExchangeForm: URLSearchParams | null = null;
let lastExchangeGrant: string | null = null;

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && url.pathname === "/oauth/access_token") {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      lastExchangeForm = new URLSearchParams(raw);
      if (exchangeShouldFail) {
        json(400, {
          error: { message: "Invalid verification code", type: "OAuthException", code: 100 },
        });
        return;
      }
      json(200, { access_token: SHORT_TOKEN, user_id: Number(THREADS_USER_ID) });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/access_token") {
    lastExchangeGrant = url.searchParams.get("grant_type");
    if (
      url.searchParams.get("grant_type") !== "th_exchange_token" ||
      url.searchParams.get("access_token") !== SHORT_TOKEN
    ) {
      json(400, { error: { message: "bad exchange", type: "OAuthException", code: 100 } });
      return;
    }
    json(200, { access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5_184_000 });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1.0/me") {
    if (req.headers.authorization !== `Bearer ${LONG_TOKEN}`) {
      json(400, { error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } });
      return;
    }
    json(200, { id: THREADS_USER_ID, username: "kreator.threads", name: "Kreator Threads" });
    return;
  }
  json(404, { error: { message: "unmocked", type: "OAuthException", code: 803 } });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake as Server & { address: () => { port: number } }).address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ---------------------------------------------------------------------------
// Aplikasi uji: modul threads-oauth + appUser dari header uji
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
    createThreadsOAuthRoutes({ db } as unknown as AuthBundle, {
      platform,
      channelTokenSecret: CHANNEL_SECRET,
      threadsApiBase: fakeBase,
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
  const res = await theApp.request(`/tenants/${tenantId}/threads-oauth/start`, {
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
  const info = await app.request(`/tenants/${TENANT_A}/channels/threads-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  assert.equal(info.status, 200);
  const body = (await info.json()) as {
    oauthRedirectUri: string;
    appId: string | null;
    appIdConfigured: boolean;
    appSecretConfigured: boolean;
    available: boolean;
  };
  assert.equal(body.available, false);
  assert.equal(body.appIdConfigured, false);
  assert.equal(body.appSecretConfigured, false);
  assert.equal(body.appId, null);
  assert.equal(body.oauthRedirectUri, "https://app.test/api/threads/oauth/callback");

  const start = await app.request(`/tenants/${TENANT_A}/threads-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify({}),
  });
  assert.equal(start.status, 503);
  assert.equal(((await start.json()) as { error: { code: string } }).error.code, "THREADS_OAUTH_NOT_CONFIGURED");
  console.log("[1] tanpa kredensial aplikasi → info available=false; start 503 THREADS_OAUTH_NOT_CONFIGURED: OK");
}

// ---------- [2] Kredensial panel → dialog authorize benar ----------
await setPlatformSetting(
  db,
  { key: "threads_app_id", value: "threads-app-panel", updatedByUserId: USER_A },
  platformOpts,
);
await setPlatformSetting(
  db,
  { key: "threads_app_secret", value: "threads-secret-panel", updatedByUserId: USER_A },
  platformOpts,
);
let happyState = "";
{
  const info = await app.request(`/tenants/${TENANT_A}/channels/threads-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  const body = (await info.json()) as { appId: string | null; available: boolean };
  assert.equal(body.available, true);
  assert.equal(body.appId, "threads-app-panel");

  const res = await app.request(`/tenants/${TENANT_A}/threads-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const started = (await res.json()) as { dialogUrl: string; expiresAt: string };
  const dialog = new URL(started.dialogUrl);
  assert.equal(`${dialog.origin}${dialog.pathname}`, "https://threads.net/oauth/authorize");
  assert.equal(dialog.searchParams.get("client_id"), "threads-app-panel");
  assert.equal(dialog.searchParams.get("scope"), "threads_basic,threads_content_publish");
  assert.equal(dialog.searchParams.get("response_type"), "code");
  assert.equal(
    dialog.searchParams.get("redirect_uri"),
    "https://app.test/api/threads/oauth/callback",
  );
  happyState = dialog.searchParams.get("state")!;
  assert.ok(happyState.length > 10);
  console.log("[2] panel terisi → info available; dialog authorize threads.net + scope benar: OK");
}

// ---------- [3] State rusak ditolak ----------
{
  const res = await app.request(
    `/threads/oauth/callback?code=apapun&state=${happyState}x`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("threads_oauth_error=THREADS_OAUTH_STATE_INVALID"),
  );
  console.log("[3] state rusak → THREADS_OAUTH_STATE_INVALID: OK");
}

// ---------- [4] Callback sukses → akun tersimpan + sasaran /posts ----------
{
  const res = await app.request(
    `/threads/oauth/callback?code=kode-uji&state=${encodeURIComponent(happyState)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?threads_oauth=connected",
  );
  // Bentuk exchange yang sampai ke provider tiruan persis API resmi.
  assert.equal(lastExchangeForm?.get("grant_type"), "authorization_code");
  assert.equal(lastExchangeForm?.get("client_id"), "threads-app-panel");
  assert.equal(lastExchangeForm?.get("client_secret"), "threads-secret-panel");
  assert.equal(lastExchangeForm?.get("code"), "kode-uji");
  assert.equal(lastExchangeGrant, "th_exchange_token");

  const rows = await client.query<{
    id: string;
    external_id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
    token_type: string | null;
    access_token_encrypted: string;
    token_expires_at: Date;
  }>(
    `SELECT id, external_id, display_name, public_handle, status, token_type,
            access_token_encrypted, token_expires_at
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'threads'`,
    [TENANT_A],
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0]!;
  assert.equal(row.external_id, THREADS_USER_ID);
  assert.equal(row.display_name, "Kreator Threads");
  assert.equal(row.public_handle, "kreator.threads");
  assert.equal(row.status, "connected");
  assert.equal(row.token_type, "threads_user_token");
  assert.ok(row.access_token_encrypted.startsWith("v1:"));
  assert.ok(!row.access_token_encrypted.includes(LONG_TOKEN));
  assert.equal(
    decryptChannelSecret(CHANNEL_SECRET, row.access_token_encrypted),
    LONG_TOKEN,
  );
  const expectedExpiry = Date.now() + 5_184_000 * 1000;
  assert.ok(
    Math.abs(new Date(row.token_expires_at).getTime() - expectedExpiry) < 120_000,
  );

  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  const threadsTarget = targets.find((t) => t.provider === "threads");
  assert.ok(threadsTarget);
  assert.equal(threadsTarget.providerChatId, THREADS_USER_ID);
  assert.equal(threadsTarget.channelAccountId, row.id);
  console.log("[4] callback → akun terenkripsi token panjang + token_type + expiry; sasaran /posts muncul: OK");

  // ---------- [5] Replay state yang sama ditolak ----------
  const replay = await app.request(
    `/threads/oauth/callback?code=kode-uji&state=${encodeURIComponent(happyState)}`,
  );
  assert.equal(replay.status, 302);
  assert.ok(
    (replay.headers.get("location") ?? "").includes(
      "threads_oauth_error=THREADS_OAUTH_STATE_INVALID",
    ),
  );
  console.log("[5] replay state → ditolak (nonce sekali pakai): OK");
}

// ---------- [6] User membatalkan di dialog ----------
{
  const res = await app.request(
    `/threads/oauth/callback?error=access_denied&error_description=dibatalkan`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("threads_oauth_error=THREADS_OAUTH_CANCELLED"),
  );
  console.log("[6] ?error dari dialog → THREADS_OAUTH_CANCELLED: OK");
}

// ---------- [7] Exchange ditolak provider ----------
{
  exchangeShouldFail = true;
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/threads/oauth/callback?code=kode-buruk&state=${encodeURIComponent(state)}`,
  );
  exchangeShouldFail = false;
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes(
      "threads_oauth_error=THREADS_OAUTH_EXCHANGE_FAILED",
    ),
  );
  const count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM channel_accounts WHERE provider = 'threads'`,
  );
  assert.equal(count.rows[0].count, "1");
  console.log("[7] exchange gagal → THREADS_OAUTH_EXCHANGE_FAILED; tidak ada akun baru: OK");
}

// ---------- [8] Akun yang sama dari workspace lain ditolak ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/threads/oauth/callback?code=kode-uji&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes(
      "threads_oauth_error=THREADS_ACCOUNT_ALREADY_CONNECTED",
    ),
  );
  console.log("[8] akun aktif di workspace lain → THREADS_ACCOUNT_ALREADY_CONNECTED: OK");
}

// ---------- [9] Revive akun sendiri yang terputus ----------
{
  const before = await client.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE tenant_id = $1 AND provider = 'threads'`,
    [TENANT_A],
  );
  await client.query(
    `UPDATE channel_accounts SET status = 'disconnected', access_token_encrypted = NULL WHERE tenant_id = $1 AND provider = 'threads'`,
    [TENANT_A],
  );
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/threads/oauth/callback?code=kode-uji&state=${encodeURIComponent(state)}`,
  );
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?threads_oauth=connected",
  );
  const after = await client.query<{ id: string; status: string; access_token_encrypted: string }>(
    `SELECT id, status, access_token_encrypted FROM channel_accounts WHERE tenant_id = $1 AND provider = 'threads'`,
    [TENANT_A],
  );
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0]!.id, before.rows[0]!.id);
  assert.equal(after.rows[0]!.status, "connected");
  assert.equal(
    decryptChannelSecret(CHANNEL_SECRET, after.rows[0]!.access_token_encrypted),
    LONG_TOKEN,
  );
  console.log("[9] connect ulang akun terputus → revive baris yang sama: OK");
}

// ---------- [10] Fallback env kredensial aplikasi ----------
{
  await clearPlatformSetting(db, { key: "threads_app_id", updatedByUserId: USER_A });
  await clearPlatformSetting(db, { key: "threads_app_secret", updatedByUserId: USER_A });
  const envApp = buildApp({
    masterSecret: MASTER,
    env: { threads_app_id: "threads-app-env", threads_app_secret: "threads-secret-env" },
  });
  const info = await envApp.request(`/tenants/${TENANT_A}/channels/threads-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  const body = (await info.json()) as { appId: string | null; available: boolean };
  assert.equal(body.available, true);
  assert.equal(body.appId, "threads-app-env");
  console.log("[10] tanpa panel → env fallback membuat connect tersedia: OK");
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify threads-oauth (PGlite + Threads API tiruan): SEMUA LULUS");
