/**
 * Verifikasi integrasi LinkedIn Connect — di atas PGlite + server
 * LinkedIn tiruan (node:http lokal). Dijalankan di CI sebagai
 * bagian `verify:ci`.
 *
 * Membuktikan alur penuh modul linkedin-oauth melawan permukaan
 * resmi LinkedIn (authorize linkedin.com/oauth/v2/authorization →
 * callback → POST /oauth/v2/accessToken di host www → profil OIDC
 * GET /v2/userinfo):
 *   [1] belum ada kredensial aplikasi → info jujur belum
 *       terkonfigurasi (available=false) & start 503 berkode;
 *   [2] kredensial dari PANEL → info available + dialog authorize
 *       ber-scope "openid profile w_member_social";
 *   [3] state rusak → redirect LINKEDIN_OAUTH_STATE_INVALID;
 *   [4] callback sukses → akun channel linkedin tersimpan
 *       (external_id = klaim sub OIDC, display_name dari profil,
 *       token HANYA envelope terenkripsi, token_type
 *       linkedin_user_token, refresh_token_encrypted NULL — LinkedIn
 *       memang tidak menerbitkan refresh token, expires ±60 hari),
 *       avatar dari klaim picture tersimpan, sasaran LinkedIn
 *       muncul di listPostTargets;
 *   [5] state yang sama diputar ulang → ditolak (nonce sekali pakai);
 *   [6] callback ?error → LINKEDIN_OAUTH_CANCELLED;
 *   [7] exchange ditolak provider → LINKEDIN_OAUTH_EXCHANGE_FAILED
 *       tanpa akun baru;
 *   [8] akun yang sama dari workspace lain → LINKEDIN_ACCOUNT_ALREADY_CONNECTED;
 *   [9] akun sendiri terputus lalu connect lagi → revive baris yang
 *       sama (bukan duplikat);
 *  [10] fallback env untuk kredensial aplikasi (tanpa panel);
 *  [11] avatar yang GAGAL diunduh TIDAK menggagalkan connect
 *       (fail-soft — akun tetap connected, foto kosong).
 *
 * Token tiruan di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:linkedin-oauth
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
import { createLinkedInOAuthRoutes } from "../src/modules/linkedin-oauth/routes";

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
// LinkedIn tiruan (satu server untuk host www OAuth + host API)
// ---------------------------------------------------------------------------
const ACCESS_1 = "linkedin-access-uji-1";
const ACCESS_1B = "linkedin-access-uji-1b";
const ACCESS_2 = "linkedin-access-uji-2";
const MEMBER_ID = "member-sub-123";
const MEMBER_ID_2 = "member-sub-456";
const AVATAR_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
let lastTokenForm: URLSearchParams | null = null;
let exchangeCount = 0;

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fakeBaseHere = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  if (req.method === "GET" && url.pathname === "/cdn/linkedin-avatar.jpg") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(AVATAR_BYTES);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cdn/broken.jpg") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("cdn rusak");
    return;
  }
  if (req.method === "POST" && url.pathname === "/oauth/v2/accessToken") {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      lastTokenForm = new URLSearchParams(raw);
      const code = lastTokenForm.get("code");
      if (code === "kode-buruk") {
        json(400, { error: "invalid_grant", error_description: "code tidak berlaku" });
        return;
      }
      if (code === "kode-kedua") {
        json(200, { access_token: ACCESS_2, expires_in: 5184000, scope: "openid,profile,w_member_social" });
        return;
      }
      exchangeCount += 1;
      json(200, {
        access_token: exchangeCount > 1 ? ACCESS_1B : ACCESS_1,
        expires_in: 5184000,
        scope: "openid,profile,w_member_social",
      });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v2/userinfo") {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${ACCESS_1}` || auth === `Bearer ${ACCESS_1B}`) {
      json(200, {
        sub: MEMBER_ID,
        name: "Kreator LinkedIn",
        picture: `${fakeBaseHere}/cdn/linkedin-avatar.jpg`,
      });
      return;
    }
    if (auth === `Bearer ${ACCESS_2}`) {
      json(200, {
        sub: MEMBER_ID_2,
        name: "Kreator Rusak",
        picture: `${fakeBaseHere}/cdn/broken.jpg`,
      });
      return;
    }
    json(401, { message: "Invalid access token" });
    return;
  }
  json(404, { message: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake as Server & { address: () => { port: number } }).address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ---------------------------------------------------------------------------
// Aplikasi uji: modul linkedin-oauth + appUser dari header uji
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
    createLinkedInOAuthRoutes({ db } as unknown as AuthBundle, {
      platform,
      channelTokenSecret: CHANNEL_SECRET,
      linkedinApiBase: fakeBase,
      linkedinOAuthBase: fakeBase,
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
  const res = await theApp.request(`/tenants/${tenantId}/linkedin-oauth/start`, {
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
  const info = await app.request(`/tenants/${TENANT_A}/channels/linkedin-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  assert.equal(info.status, 200);
  const body = (await info.json()) as {
    oauthRedirectUri: string;
    clientId: string | null;
    clientIdConfigured: boolean;
    clientSecretConfigured: boolean;
    available: boolean;
  };
  assert.equal(body.available, false);
  assert.equal(body.clientId, null);
  assert.equal(body.oauthRedirectUri, "https://app.test/api/oauth/linkedin/callback");

  const start = await app.request(`/tenants/${TENANT_A}/linkedin-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify({}),
  });
  assert.equal(start.status, 503);
  assert.equal(((await start.json()) as { error: { code: string } }).error.code, "LINKEDIN_OAUTH_NOT_CONFIGURED");
  console.log("[1] tanpa kredensial aplikasi → info available=false; start 503 LINKEDIN_OAUTH_NOT_CONFIGURED: OK");
}

// ---------- [2] Kredensial panel → dialog authorize benar ----------
await setPlatformSetting(
  db,
  { key: "linkedin_client_id", value: "linkedin-id-panel", updatedByUserId: USER_A },
  platformOpts,
);
await setPlatformSetting(
  db,
  { key: "linkedin_client_secret", value: "linkedin-secret-panel", updatedByUserId: USER_A },
  platformOpts,
);
let happyState = "";
{
  const info = await app.request(`/tenants/${TENANT_A}/channels/linkedin-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  const body = (await info.json()) as { clientId: string | null; available: boolean };
  assert.equal(body.available, true);
  assert.equal(body.clientId, "linkedin-id-panel");

  const res = await app.request(`/tenants/${TENANT_A}/linkedin-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const started = (await res.json()) as { dialogUrl: string; expiresAt: string };
  const dialog = new URL(started.dialogUrl);
  assert.equal(`${dialog.origin}${dialog.pathname}`, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(dialog.searchParams.get("client_id"), "linkedin-id-panel");
  assert.equal(dialog.searchParams.get("scope"), "openid profile w_member_social");
  assert.equal(dialog.searchParams.get("response_type"), "code");
  assert.equal(
    dialog.searchParams.get("redirect_uri"),
    "https://app.test/api/oauth/linkedin/callback",
  );
  happyState = dialog.searchParams.get("state")!;
  assert.ok(happyState.length > 10);
  console.log("[2] panel terisi → info available; dialog authorize linkedin.com + scope benar: OK");
}

// ---------- [3] State rusak ditolak ----------
{
  const res = await app.request(
    `/oauth/linkedin/callback?code=apapun&state=${happyState}x`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("linkedin_oauth_error=LINKEDIN_OAUTH_STATE_INVALID"),
  );
  console.log("[3] state rusak → LINKEDIN_OAUTH_STATE_INVALID: OK");
}

// ---------- [4] Callback sukses → akun tersimpan + avatar + sasaran /posts ----------
{
  const res = await app.request(
    `/oauth/linkedin/callback?code=kode-uji&state=${encodeURIComponent(happyState)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?linkedin_oauth=connected",
  );
  assert.equal(lastTokenForm?.get("grant_type"), "authorization_code");
  assert.equal(lastTokenForm?.get("client_id"), "linkedin-id-panel");
  assert.equal(lastTokenForm?.get("client_secret"), "linkedin-secret-panel");
  assert.equal(lastTokenForm?.get("code"), "kode-uji");
  assert.equal(
    lastTokenForm?.get("redirect_uri"),
    "https://app.test/api/oauth/linkedin/callback",
  );

  const rows = await client.query<{
    id: string;
    external_id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
    token_type: string | null;
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
    token_expires_at: Date;
  }>(
    `SELECT id, external_id, display_name, public_handle, status, token_type,
            access_token_encrypted, refresh_token_encrypted, token_expires_at
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'linkedin'`,
    [TENANT_A],
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0]!;
  assert.equal(row.external_id, MEMBER_ID);
  assert.equal(row.display_name, "Kreator LinkedIn");
  assert.equal(row.public_handle, null);
  assert.equal(row.status, "connected");
  assert.equal(row.token_type, "linkedin_user_token");
  assert.ok(row.access_token_encrypted.startsWith("v1:"));
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.access_token_encrypted), ACCESS_1);
  // Kejujuran lifecycle: LinkedIn tidak memberi refresh token.
  assert.equal(row.refresh_token_encrypted, null);
  const expectedExpiry = Date.now() + 5184000 * 1000;
  assert.ok(Math.abs(new Date(row.token_expires_at).getTime() - expectedExpiry) < 120_000);

  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    row.id,
  );
  assert.ok(photo, "avatar LinkedIn harus tersimpan saat connect");
  assert.ok(Buffer.from(photo.data).equals(AVATAR_BYTES));

  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  const target = targets.find((t) => t.provider === "linkedin");
  assert.ok(target);
  assert.equal(target.providerChatId, MEMBER_ID);
  console.log("[4] callback → akun terenkripsi + expiry ±60 hari + refresh NULL (jujur); avatar tersimpan; sasaran /posts muncul: OK");

  // ---------- [5] Replay state yang sama ditolak ----------
  const replay = await app.request(
    `/oauth/linkedin/callback?code=kode-uji&state=${encodeURIComponent(happyState)}`,
  );
  assert.equal(replay.status, 302);
  assert.ok(
    (replay.headers.get("location") ?? "").includes(
      "linkedin_oauth_error=LINKEDIN_OAUTH_STATE_INVALID",
    ),
  );
  console.log("[5] replay state → ditolak (nonce sekali pakai): OK");
}

// ---------- [6] User membatalkan di dialog ----------
{
  const res = await app.request(
    `/oauth/linkedin/callback?error=user_cancelled_login&error_description=dibatalkan`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("linkedin_oauth_error=LINKEDIN_OAUTH_CANCELLED"),
  );
  console.log("[6] ?error dari dialog → LINKEDIN_OAUTH_CANCELLED: OK");
}

// ---------- [7] Exchange ditolak provider ----------
{
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/oauth/linkedin/callback?code=kode-buruk&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes(
      "linkedin_oauth_error=LINKEDIN_OAUTH_EXCHANGE_FAILED",
    ),
  );
  const count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM channel_accounts WHERE provider = 'linkedin'`,
  );
  assert.equal(count.rows[0].count, "1");
  console.log("[7] exchange gagal → LINKEDIN_OAUTH_EXCHANGE_FAILED; tidak ada akun baru: OK");
}

// ---------- [8] Akun yang sama dari workspace lain ditolak ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/linkedin/callback?code=kode-uji&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes(
      "linkedin_oauth_error=LINKEDIN_ACCOUNT_ALREADY_CONNECTED",
    ),
  );
  console.log("[8] akun aktif di workspace lain → LINKEDIN_ACCOUNT_ALREADY_CONNECTED: OK");
}

// ---------- [9] Revive akun sendiri yang terputus ----------
{
  const before = await client.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE tenant_id = $1 AND provider = 'linkedin'`,
    [TENANT_A],
  );
  await client.query(
    `UPDATE channel_accounts SET status = 'disconnected', access_token_encrypted = NULL WHERE tenant_id = $1 AND provider = 'linkedin'`,
    [TENANT_A],
  );
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/oauth/linkedin/callback?code=kode-uji&state=${encodeURIComponent(state)}`,
  );
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?linkedin_oauth=connected",
  );
  const after = await client.query<{ id: string; status: string; access_token_encrypted: string }>(
    `SELECT id, status, access_token_encrypted FROM channel_accounts WHERE tenant_id = $1 AND provider = 'linkedin'`,
    [TENANT_A],
  );
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0]!.id, before.rows[0]!.id);
  assert.equal(after.rows[0]!.status, "connected");
  assert.equal(
    decryptChannelSecret(CHANNEL_SECRET, after.rows[0]!.access_token_encrypted),
    ACCESS_1B,
  );
  console.log("[9] connect ulang akun terputus → revive baris yang sama: OK");
}

// ---------- [11] Avatar rusak → connect tetap berhasil (fail-soft) ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/linkedin/callback?code=kode-kedua&state=${encodeURIComponent(state)}`,
  );
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?linkedin_oauth=connected",
  );
  const rows = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM channel_accounts WHERE tenant_id = $1 AND provider = 'linkedin'`,
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
  await clearPlatformSetting(db, { key: "linkedin_client_id", updatedByUserId: USER_A });
  await clearPlatformSetting(db, { key: "linkedin_client_secret", updatedByUserId: USER_A });
  const envApp = buildApp({
    masterSecret: MASTER,
    env: { linkedin_client_id: "linkedin-id-env", linkedin_client_secret: "linkedin-secret-env" },
  });
  const info = await envApp.request(`/tenants/${TENANT_A}/channels/linkedin-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  const body = (await info.json()) as { clientId: string | null; available: boolean };
  assert.equal(body.available, true);
  assert.equal(body.clientId, "linkedin-id-env");
  console.log("[10] tanpa panel → env fallback membuat connect tersedia: OK");
}

// ---------- [12] Path callback lama TIDAK terdaftar lagi (pemotongan bersih) ----------
// Aturan pemilik 2026-11-12: penyeragaman URL TANPA alias — callback
// kanonis adalah /oauth/linkedin/callback; path lama
// /linkedin/oauth/callback harus menjawab 404.
{
  const res = await app.request(`/linkedin/oauth/callback?code=apapun&state=apapun`);
  assert.equal(res.status, 404);
  console.log("[12] path callback lama /linkedin/oauth/callback → 404 (tanpa alias): OK");
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify linkedin-oauth (PGlite + LinkedIn tiruan): SEMUA LULUS");
