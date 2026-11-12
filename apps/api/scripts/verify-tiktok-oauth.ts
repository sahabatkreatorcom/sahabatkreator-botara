/**
 * Verifikasi integrasi TikTok Connect (Login Kit) — di atas PGlite +
 * server TikTok API tiruan (node:http lokal). Dijalankan di CI
 * sebagai bagian `verify:ci`.
 *
 * Membuktikan alur penuh modul tiktok-oauth melawan permukaan resmi
 * Login Kit (authorize tiktok.com/v2/auth/authorize → callback →
 * POST /v2/oauth/token/ grant authorization_code → GET
 * /v2/user/info/):
 *   [1] belum ada kredensial aplikasi → info jujur belum
 *       terkonfigurasi (available=false) & start 503 berkode;
 *   [2] kredensial dari PANEL → info available + dialog authorize
 *       ber-scope user.info.basic,video.publish;
 *   [3] state rusak → redirect TIKTOK_OAUTH_STATE_INVALID;
 *   [4] callback sukses → akun channel tiktok tersimpan (external_id
 *       = open_id, display_name & handle dari user info, KEDUA token
 *       HANYA envelope terenkripsi, token_type tiktok_user_token,
 *       expires ±24 jam dari expires_in), avatar dari avatar_url
 *       tersimpan (profile_photos), sasaran TikTok muncul di
 *       listPostTargets;
 *   [5] state yang sama diputar ulang → ditolak (nonce sekali pakai);
 *   [6] callback ?error → TIKTOK_OAUTH_CANCELLED;
 *   [7] exchange ditolak provider → TIKTOK_OAUTH_EXCHANGE_FAILED
 *       tanpa akun baru;
 *   [8] akun yang sama dari workspace lain → TIKTOK_ACCOUNT_ALREADY_CONNECTED;
 *   [9] akun sendiri terputus lalu connect lagi → revive baris yang
 *       sama (bukan duplikat) dengan refresh token baru;
 *  [10] fallback env untuk kredensial aplikasi (tanpa panel);
 *  [11] avatar yang GAGAL diunduh TIDAK menggagalkan connect
 *       (fail-soft — akun tetap connected, foto kosong);
 *  [12] user info ditolak KHUSUS scope (`scope_not_authorized` —
 *       izin user.info.basic belum disetujui aplikasi) DAN cadangan
 *       creator_info juga gagal → akun TETAP terhubung fail-soft,
 *       tetapi kepulangan membawa penanda peringatan
 *       `connected_profile_incomplete` (bukan sukses polos) dan akun
 *       tersimpan tanpa nama/handle/foto;
 *  [13] hubungkan ulang akun [12] sesudah scope diberikan → profil
 *       dilengkapi pada baris yang sama (nama + handle terisi,
 *       avatar tersimpan) dan kepulangan kembali sukses polos;
 *  [14] user info gagal karena alasan LAIN (token ditolak) →
 *       tetap sukses polos TANPA penanda peringatan;
 *  [15] user info ditolak scope TETAPI creator_info berhasil →
 *       akun terhubung DENGAN nama/handle/avatar dari info kreator
 *       posting dan kepulangan sukses polos (banner hanya untuk
 *       profil yang benar-benar tetap kosong).
 *
 * Token tiruan di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:tiktok-oauth
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
import { createTikTokOAuthRoutes } from "../src/modules/tiktok-oauth/routes";

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
// TikTok API tiruan
// ---------------------------------------------------------------------------
const ACCESS_1 = "tiktok-access-uji-1";
const REFRESH_1 = "tiktok-refresh-uji-1";
const ACCESS_1B = "tiktok-access-uji-1b";
const REFRESH_1B = "tiktok-refresh-uji-1b";
const ACCESS_2 = "tiktok-access-uji-2";
const REFRESH_2 = "tiktok-refresh-uji-2";
const ACCESS_3 = "tiktok-access-uji-3";
const REFRESH_3 = "tiktok-refresh-uji-3";
const ACCESS_3B = "tiktok-access-uji-3b";
const REFRESH_3B = "tiktok-refresh-uji-3b";
const ACCESS_4 = "tiktok-access-uji-4";
const REFRESH_4 = "tiktok-refresh-uji-4";
const ACCESS_5 = "tiktok-access-uji-5";
const REFRESH_5 = "tiktok-refresh-uji-5";
const OPEN_ID = "open-id-kreator-1";
const OPEN_ID_2 = "open-id-kreator-2";
const OPEN_ID_3 = "open-id-kreator-3";
const OPEN_ID_4 = "open-id-kreator-4";
const OPEN_ID_5 = "open-id-kreator-5";
const AVATAR_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
let lastTokenForm: URLSearchParams | null = null;
// Kode "kode-uji" pertama menghasilkan token set 1; sesudah revive
// (pemanggilan kedua) menghasilkan set 1b — meniru rotasi token.
let exchangeCount = 0;

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fakeBaseHere = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  if (req.method === "GET" && url.pathname === "/cdn/tiktok-avatar.jpg") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(AVATAR_BYTES);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cdn/broken.jpg") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("cdn rusak");
    return;
  }
  if (req.method === "POST" && url.pathname === "/v2/oauth/token/") {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      lastTokenForm = new URLSearchParams(raw);
      const code = lastTokenForm.get("code");
      if (lastTokenForm.get("grant_type") !== "authorization_code") {
        json(400, { error: "invalid_request", error_description: "grant salah" });
        return;
      }
      if (code === "kode-buruk") {
        json(400, { error: "invalid_grant", error_description: "code tidak berlaku" });
        return;
      }
      if (code === "kode-kedua") {
        json(200, {
          access_token: ACCESS_2,
          refresh_token: REFRESH_2,
          open_id: OPEN_ID_2,
          expires_in: 86400,
          refresh_expires_in: 31536000,
          scope: "user.info.basic,video.publish",
          token_type: "Bearer",
        });
        return;
      }
      if (code === "kode-scope") {
        // Token SAH, tetapi consent TIDAK menyertakan scope
        // user.info.basic (belum disetujui untuk aplikasi) — user
        // info-nya yang akan ditolak scope_not_authorized.
        json(200, {
          access_token: ACCESS_3,
          refresh_token: REFRESH_3,
          open_id: OPEN_ID_3,
          expires_in: 86400,
          refresh_expires_in: 31536000,
          scope: "video.publish",
          token_type: "Bearer",
        });
        return;
      }
      if (code === "kode-scope-ok") {
        // Connect ulang akun yang sama SESUDAH scope profil
        // diberikan: token baru + user info lengkap.
        json(200, {
          access_token: ACCESS_3B,
          refresh_token: REFRESH_3B,
          open_id: OPEN_ID_3,
          expires_in: 86400,
          refresh_expires_in: 31536000,
          scope: "user.info.basic,video.publish",
          token_type: "Bearer",
        });
        return;
      }
      if (code === "kode-info-tolak") {
        // Token diterbitkan, tetapi user info menolaknya karena
        // alasan BUKAN scope (access_token_invalid di handler info).
        json(200, {
          access_token: ACCESS_4,
          refresh_token: REFRESH_4,
          open_id: OPEN_ID_4,
          expires_in: 86400,
          refresh_expires_in: 31536000,
          scope: "user.info.basic,video.publish",
          token_type: "Bearer",
        });
        return;
      }
      if (code === "kode-scope-cadangan") {
        // Consent hanya memberi scope penerbitan: user info akan
        // ditolak scope, tetapi creator_info posting berhasil.
        json(200, {
          access_token: ACCESS_5,
          refresh_token: REFRESH_5,
          open_id: OPEN_ID_5,
          expires_in: 86400,
          refresh_expires_in: 31536000,
          scope: "video.publish",
          token_type: "Bearer",
        });
        return;
      }
      exchangeCount += 1;
      const setB = exchangeCount > 1;
      json(200, {
        access_token: setB ? ACCESS_1B : ACCESS_1,
        refresh_token: setB ? REFRESH_1B : REFRESH_1,
        open_id: OPEN_ID,
        expires_in: 86400,
        refresh_expires_in: 31536000,
        scope: "user.info.basic,video.publish",
        token_type: "Bearer",
      });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v2/user/info/") {
    const auth = req.headers.authorization;
    const ok = (user: Record<string, unknown>) =>
      json(200, {
        data: { user },
        error: { code: "ok", message: "", request_id: "req-uji" },
      });
    if (auth === `Bearer ${ACCESS_1}` || auth === `Bearer ${ACCESS_1B}`) {
      ok({
        open_id: OPEN_ID,
        username: "kreator.tiktok",
        display_name: "Kreator TikTok",
        avatar_url: `${fakeBaseHere}/cdn/tiktok-avatar.jpg`,
      });
      return;
    }
    if (auth === `Bearer ${ACCESS_2}`) {
      ok({
        open_id: OPEN_ID_2,
        username: "kreator.rusak",
        display_name: "Kreator Rusak",
        avatar_url: `${fakeBaseHere}/cdn/broken.jpg`,
      });
      return;
    }
    if (auth === `Bearer ${ACCESS_3}` || auth === `Bearer ${ACCESS_5}`) {
      // Bentuk resmi penolakan scope TikTok: HTTP 401 + envelope
      // error.code scope_not_authorized.
      json(401, {
        data: {},
        error: {
          code: "scope_not_authorized",
          message:
            "The user did not authorize the scope required for completing this request. ",
          request_id: "req-uji",
        },
      });
      return;
    }
    if (auth === `Bearer ${ACCESS_3B}`) {
      ok({
        open_id: OPEN_ID_3,
        username: "kreator.pulih",
        display_name: "Kreator Pulih",
        avatar_url: `${fakeBaseHere}/cdn/tiktok-avatar.jpg`,
      });
      return;
    }
    json(401, {
      data: {},
      error: { code: "access_token_invalid", message: "token salah", request_id: "req-uji" },
    });
    return;
  }
  if (
    req.method === "POST" &&
    url.pathname === "/v2/post/publish/creator_info/query/"
  ) {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${ACCESS_5}`) {
      json(200, {
        data: {
          creator_username: "kreator.cadangan",
          creator_nickname: "Kreator Cadangan",
          creator_avatar_url: `${fakeBaseHere}/cdn/tiktok-avatar.jpg`,
          privacy_level_options: ["SELF_ONLY"],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: 600,
        },
        error: { code: "ok", message: "", request_id: "req-uji" },
      });
      return;
    }
    // ACCESS_3/ACCESS_4 dan token lain: cadangan juga gagal agar
    // grup peringatan/profil-kosong membuktikan kegagalan dua sumber.
    json(401, {
      data: {},
      error: {
        code: "access_token_invalid",
        message: "token salah",
        request_id: "req-uji",
      },
    });
    return;
  }
  json(404, { error: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake as Server & { address: () => { port: number } }).address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ---------------------------------------------------------------------------
// Aplikasi uji: modul tiktok-oauth + appUser dari header uji
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
    createTikTokOAuthRoutes({ db } as unknown as AuthBundle, {
      platform,
      channelTokenSecret: CHANNEL_SECRET,
      tiktokApiBase: fakeBase,
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
  const res = await theApp.request(`/tenants/${tenantId}/tiktok-oauth/start`, {
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
  const info = await app.request(`/tenants/${TENANT_A}/channels/tiktok-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  assert.equal(info.status, 200);
  const body = (await info.json()) as {
    oauthRedirectUri: string;
    clientKey: string | null;
    clientKeyConfigured: boolean;
    clientSecretConfigured: boolean;
    available: boolean;
  };
  assert.equal(body.available, false);
  assert.equal(body.clientKeyConfigured, false);
  assert.equal(body.clientSecretConfigured, false);
  assert.equal(body.clientKey, null);
  assert.equal(body.oauthRedirectUri, "https://app.test/api/oauth/tiktok/callback");

  const start = await app.request(`/tenants/${TENANT_A}/tiktok-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify({}),
  });
  assert.equal(start.status, 503);
  assert.equal(((await start.json()) as { error: { code: string } }).error.code, "TIKTOK_OAUTH_NOT_CONFIGURED");
  console.log("[1] tanpa kredensial aplikasi → info available=false; start 503 TIKTOK_OAUTH_NOT_CONFIGURED: OK");
}

// ---------- [2] Kredensial panel → dialog authorize benar ----------
await setPlatformSetting(
  db,
  { key: "tiktok_client_key", value: "tiktok-key-panel", updatedByUserId: USER_A },
  platformOpts,
);
await setPlatformSetting(
  db,
  { key: "tiktok_client_secret", value: "tiktok-secret-panel", updatedByUserId: USER_A },
  platformOpts,
);
let happyState = "";
{
  const info = await app.request(`/tenants/${TENANT_A}/channels/tiktok-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  const body = (await info.json()) as { clientKey: string | null; available: boolean };
  assert.equal(body.available, true);
  assert.equal(body.clientKey, "tiktok-key-panel");

  const res = await app.request(`/tenants/${TENANT_A}/tiktok-oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const started = (await res.json()) as { dialogUrl: string; expiresAt: string };
  const dialog = new URL(started.dialogUrl);
  assert.equal(`${dialog.origin}${dialog.pathname}`, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(dialog.searchParams.get("client_key"), "tiktok-key-panel");
  assert.equal(dialog.searchParams.get("scope"), "user.info.basic,video.publish");
  assert.equal(dialog.searchParams.get("response_type"), "code");
  assert.equal(
    dialog.searchParams.get("redirect_uri"),
    "https://app.test/api/oauth/tiktok/callback",
  );
  happyState = dialog.searchParams.get("state")!;
  assert.ok(happyState.length > 10);
  console.log("[2] panel terisi → info available; dialog authorize tiktok.com + scope benar: OK");
}

// ---------- [3] State rusak ditolak ----------
{
  const res = await app.request(
    `/oauth/tiktok/callback?code=apapun&state=${happyState}x`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("tiktok_oauth_error=TIKTOK_OAUTH_STATE_INVALID"),
  );
  console.log("[3] state rusak → TIKTOK_OAUTH_STATE_INVALID: OK");
}

// ---------- [4] Callback sukses → akun tersimpan + avatar + sasaran /posts ----------
{
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-uji&state=${encodeURIComponent(happyState)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?tiktok_oauth=connected",
  );
  assert.equal(lastTokenForm?.get("grant_type"), "authorization_code");
  assert.equal(lastTokenForm?.get("client_key"), "tiktok-key-panel");
  assert.equal(lastTokenForm?.get("client_secret"), "tiktok-secret-panel");
  assert.equal(lastTokenForm?.get("code"), "kode-uji");
  assert.equal(
    lastTokenForm?.get("redirect_uri"),
    "https://app.test/api/oauth/tiktok/callback",
  );

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
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'tiktok'`,
    [TENANT_A],
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0]!;
  assert.equal(row.external_id, OPEN_ID);
  assert.equal(row.display_name, "Kreator TikTok");
  assert.equal(row.public_handle, "kreator.tiktok");
  assert.equal(row.status, "connected");
  assert.equal(row.token_type, "tiktok_user_token");
  assert.ok(row.access_token_encrypted.startsWith("v1:"));
  assert.ok(!row.access_token_encrypted.includes(ACCESS_1));
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.access_token_encrypted), ACCESS_1);
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.refresh_token_encrypted), REFRESH_1);
  const expectedExpiry = Date.now() + 86400 * 1000;
  assert.ok(Math.abs(new Date(row.token_expires_at).getTime() - expectedExpiry) < 120_000);

  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    row.id,
  );
  assert.ok(photo, "avatar TikTok harus tersimpan saat connect");
  assert.ok(Buffer.from(photo.data).equals(AVATAR_BYTES));

  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  const target = targets.find((t) => t.provider === "tiktok");
  assert.ok(target);
  assert.equal(target.providerChatId, OPEN_ID);
  assert.equal(target.channelAccountId, row.id);
  console.log("[4] callback → akun + kedua token terenkripsi + expiry ±24 jam; avatar tersimpan; sasaran /posts muncul: OK");

  // ---------- [5] Replay state yang sama ditolak ----------
  const replay = await app.request(
    `/oauth/tiktok/callback?code=kode-uji&state=${encodeURIComponent(happyState)}`,
  );
  assert.equal(replay.status, 302);
  assert.ok(
    (replay.headers.get("location") ?? "").includes(
      "tiktok_oauth_error=TIKTOK_OAUTH_STATE_INVALID",
    ),
  );
  console.log("[5] replay state → ditolak (nonce sekali pakai): OK");
}

// ---------- [6] User membatalkan di dialog ----------
{
  const res = await app.request(
    `/oauth/tiktok/callback?error=access_denied&error_description=dibatalkan`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("tiktok_oauth_error=TIKTOK_OAUTH_CANCELLED"),
  );
  console.log("[6] ?error dari dialog → TIKTOK_OAUTH_CANCELLED: OK");
}

// ---------- [7] Exchange ditolak provider ----------
{
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-buruk&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes(
      "tiktok_oauth_error=TIKTOK_OAUTH_EXCHANGE_FAILED",
    ),
  );
  const count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM channel_accounts WHERE provider = 'tiktok'`,
  );
  assert.equal(count.rows[0].count, "1");
  console.log("[7] exchange gagal → TIKTOK_OAUTH_EXCHANGE_FAILED; tidak ada akun baru: OK");
}

// ---------- [8] Akun yang sama dari workspace lain ditolak ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-uji&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes(
      "tiktok_oauth_error=TIKTOK_ACCOUNT_ALREADY_CONNECTED",
    ),
  );
  console.log("[8] akun aktif di workspace lain → TIKTOK_ACCOUNT_ALREADY_CONNECTED: OK");
}

// ---------- [9] Revive akun sendiri yang terputus ----------
{
  const before = await client.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE tenant_id = $1 AND provider = 'tiktok'`,
    [TENANT_A],
  );
  await client.query(
    `UPDATE channel_accounts SET status = 'disconnected', access_token_encrypted = NULL, refresh_token_encrypted = NULL WHERE tenant_id = $1 AND provider = 'tiktok'`,
    [TENANT_A],
  );
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-uji&state=${encodeURIComponent(state)}`,
  );
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?tiktok_oauth=connected",
  );
  const after = await client.query<{
    id: string;
    status: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string;
  }>(
    `SELECT id, status, access_token_encrypted, refresh_token_encrypted FROM channel_accounts WHERE tenant_id = $1 AND provider = 'tiktok'`,
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
  console.log("[9] connect ulang akun terputus → revive baris yang sama dengan token hasil rotasi: OK");
}

// ---------- [11] Avatar rusak → connect tetap berhasil (fail-soft) ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-kedua&state=${encodeURIComponent(state)}`,
  );
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?tiktok_oauth=connected",
  );
  const rows = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM channel_accounts WHERE tenant_id = $1 AND provider = 'tiktok'`,
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

// ---------- [12] User info ditolak scope + creator_info gagal → terhubung + penanda ----------
let scopeRowId = "";
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-scope&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?tiktok_oauth=connected_profile_incomplete",
  );
  const rows = await client.query<{
    id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string;
  }>(
    `SELECT id, display_name, public_handle, status, access_token_encrypted, refresh_token_encrypted
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'tiktok' AND external_id = $2`,
    [TENANT_B, OPEN_ID_3],
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0]!;
  scopeRowId = row.id;
  assert.equal(row.status, "connected");
  assert.equal(row.display_name, null);
  assert.equal(row.public_handle, null);
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.access_token_encrypted), ACCESS_3);
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.refresh_token_encrypted), REFRESH_3);
  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_B },
    "channel_account",
    row.id,
  );
  assert.equal(photo, null);
  console.log("[12] user info scope_not_authorized + creator_info gagal → akun connected tanpa profil + penanda connected_profile_incomplete: OK");
}

// ---------- [13] Hubungkan ulang sesudah scope diberikan → profil dilengkapi ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-scope-ok&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?tiktok_oauth=connected",
  );
  const rows = await client.query<{
    id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
  }>(
    `SELECT id, display_name, public_handle, status
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'tiktok' AND external_id = $2`,
    [TENANT_B, OPEN_ID_3],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]!.id, scopeRowId);
  assert.equal(rows.rows[0]!.status, "connected");
  assert.equal(rows.rows[0]!.display_name, "Kreator Pulih");
  assert.equal(rows.rows[0]!.public_handle, "kreator.pulih");
  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_B },
    "channel_account",
    scopeRowId,
  );
  assert.ok(photo, "avatar harus terisi pada hubungkan ulang");
  assert.ok(Buffer.from(photo.data).equals(AVATAR_BYTES));
  console.log("[13] hubungkan ulang akun yang sama → nama/handle/avatar terisi di baris yang sama, sukses polos: OK");
}

// ---------- [14] User info gagal BUKAN scope → tetap sukses polos ----------
{
  const state = await startAndGetState(app, TENANT_A, USER_A);
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-info-tolak&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?tiktok_oauth=connected",
  );
  const rows = await client.query<{
    display_name: string | null;
    status: string;
  }>(
    `SELECT display_name, status FROM channel_accounts
      WHERE tenant_id = $1 AND provider = 'tiktok' AND external_id = $2`,
    [TENANT_A, OPEN_ID_4],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]!.status, "connected");
  assert.equal(rows.rows[0]!.display_name, null);
  console.log("[14] user info gagal access_token_invalid (bukan scope) → akun connected, sukses polos tanpa penanda: OK");
}

// ---------- [15] User info ditolak scope → profil dari creator_info ----------
{
  const state = await startAndGetState(app, TENANT_B, USER_B);
  const res = await app.request(
    `/oauth/tiktok/callback?code=kode-scope-cadangan&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?tiktok_oauth=connected",
  );
  const rows = await client.query<{
    id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string;
  }>(
    `SELECT id, display_name, public_handle, status, access_token_encrypted, refresh_token_encrypted
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'tiktok' AND external_id = $2`,
    [TENANT_B, OPEN_ID_5],
  );
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0]!;
  assert.equal(row.status, "connected");
  assert.equal(row.display_name, "Kreator Cadangan");
  assert.equal(row.public_handle, "kreator.cadangan");
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.access_token_encrypted), ACCESS_5);
  assert.equal(decryptChannelSecret(CHANNEL_SECRET, row.refresh_token_encrypted), REFRESH_5);
  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_B },
    "channel_account",
    row.id,
  );
  assert.ok(photo, "avatar creator_info harus tersimpan saat connect");
  assert.ok(Buffer.from(photo.data).equals(AVATAR_BYTES));
  console.log("[15] user info scope_not_authorized + creator_info sukses → profil kreator posting terisi, sukses polos: OK");
}

// ---------- [10] Fallback env kredensial aplikasi ----------
{
  await clearPlatformSetting(db, { key: "tiktok_client_key", updatedByUserId: USER_A });
  await clearPlatformSetting(db, { key: "tiktok_client_secret", updatedByUserId: USER_A });
  const envApp = buildApp({
    masterSecret: MASTER,
    env: { tiktok_client_key: "tiktok-key-env", tiktok_client_secret: "tiktok-secret-env" },
  });
  const info = await envApp.request(`/tenants/${TENANT_A}/channels/tiktok-oauth-info`, {
    headers: { "x-test-user": USER_A },
  });
  const body = (await info.json()) as { clientKey: string | null; available: boolean };
  assert.equal(body.available, true);
  assert.equal(body.clientKey, "tiktok-key-env");
  console.log("[10] tanpa panel → env fallback membuat connect tersedia: OK");
}

// ---------- [16] Path callback lama TIDAK terdaftar lagi (pemotongan bersih) ----------
// Aturan pemilik 2026-11-12: penyeragaman URL TANPA alias — callback
// kanonis adalah /oauth/tiktok/callback; path lama
// /tiktok/oauth/callback harus menjawab 404.
{
  const res = await app.request(`/tiktok/oauth/callback?code=apapun&state=apapun`);
  assert.equal(res.status, 404);
  console.log("[16] path callback lama /tiktok/oauth/callback → 404 (tanpa alias): OK");
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify tiktok-oauth (PGlite + TikTok API tiruan): SEMUA LULUS");
