/**
 * Verifikasi Google di Channels (gelombang Semua OAuth) — BUKAN
 * OAuth baru: membuktikan jembatan UI Channels memakai alur OAuth
 * Google yang SUDAH ada (modul appointments) dengan benar. Di atas
 * PGlite + server Google tiruan (node:http lokal). Dijalankan di CI
 * sebagai bagian `verify:ci`.
 *
 * Yang dibuktikan:
 *   [1] connect tanpa klien OAuth terkonfigurasi → 422
 *       GOOGLE_NOT_CONFIGURED (jujur, tanpa URL mati);
 *   [2] URL dialog dari connect meminta SCOPE LENGKAP sekali
 *       consent: openid + email + calendar.events +
 *       calendar.readonly + youtube.upload + youtube.readonly +
 *       business.manage — jadi jalur yang dipakai blok Channels
 *       BUKAN jalur sempit kalender-saja;
 *   [3] callback sukses → koneksi Google tersimpan DAN akun
 *       channel `youtube` (kanal dari Data API) + `google_business`
 *       (lokasi dari GBP) TERSINKRON sebagai channel_accounts —
 *       token TIDAK disalin ke akun channel (tetap hanya di
 *       koneksi Google) — serta keduanya muncul di listPostTargets;
 *   [4] endpoint status yang dibaca blok Channels melaporkan
 *       connected + email akun;
 *   [5] callback ber-state rusak → redirect error, tanpa koneksi.
 *
 * Token tiruan di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:google-channels
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
import { listPostTargets } from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createAppointmentsRoutes } from "../src/modules/appointments/routes";

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
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a')`,
  [TENANT_A],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A')`,
  [USER_A],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [TENANT_A, USER_A],
);

// ---------------------------------------------------------------------------
// Google tiruan — satu server untuk token/userinfo/YouTube/GBP
// ---------------------------------------------------------------------------
const G_ACCESS = "google-access-uji";
const FULL_SCOPE =
  "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/business.manage";
let lastTokenForm: URLSearchParams | null = null;

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && url.pathname === "/token") {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      lastTokenForm = new URLSearchParams(raw);
      json(200, {
        access_token: G_ACCESS,
        refresh_token: "google-refresh-uji",
        expires_in: 3600,
        scope: FULL_SCOPE,
        token_type: "Bearer",
      });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/oauth2/v2/userinfo") {
    if (req.headers.authorization !== `Bearer ${G_ACCESS}`) {
      json(401, { error: "invalid_token" });
      return;
    }
    json(200, { email: "kreator@gmail.test", name: "Kreator Google" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/youtube/v3/channels") {
    json(200, {
      items: [{ id: "UC-kanal-1", snippet: { title: "Kanal Kreator" } }],
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/accounts") {
    json(200, { accounts: [{ name: "accounts/123", accountName: "Bisnis Kreator" }] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/accounts/123/locations") {
    json(200, {
      locations: [{ name: "accounts/123/locations/456", title: "Toko Kreator" }],
    });
    return;
  }
  json(404, { error: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake as Server & { address: () => { port: number } }).address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ---------------------------------------------------------------------------
// Aplikasi uji: modul appointments + appUser dari header uji
// ---------------------------------------------------------------------------
const MASTER = randomBytes(32).toString("base64");
const TOKEN_SECRET = randomBytes(32).toString("base64");

function buildApp(platformEnv: Record<string, string | undefined>) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("appUser", { id: USER_A } as unknown as AppVariables["appUser"]);
    await next();
  });
  app.route(
    "/",
    createAppointmentsRoutes({ db } as unknown as AuthBundle, {
      platform: { masterSecret: MASTER, env: platformEnv },
      tokenSecret: TOKEN_SECRET,
      googleBases: {
        apiBase: fakeBase,
        tokenBase: fakeBase,
        authBase: fakeBase,
        businessBase: fakeBase,
        accountManagementBase: fakeBase,
      },
      publicBaseUrl: "https://app.test",
      stateSecret: "state-secret-uji",
    }),
  );
  return app;
}
const unconfiguredApp = buildApp({});
const app = buildApp({
  google_oauth_client_id: "google-client-panel",
  google_oauth_client_secret: "google-secret-panel",
});

// ---------- [1] Tanpa klien OAuth → 422 jujur ----------
{
  const res = await unconfiguredApp.request(
    `/tenants/${TENANT_A}/appointments/google/connect`,
    { method: "POST", headers: { "content-type": "application/json" } },
  );
  assert.equal(res.status, 422);
  assert.equal(
    ((await res.json()) as { error: { code: string } }).error.code,
    "GOOGLE_NOT_CONFIGURED",
  );
  console.log("[1] klien OAuth belum diatur → 422 GOOGLE_NOT_CONFIGURED: OK");
}

// ---------- [2] Dialog connect meminta scope LENGKAP ----------
let state = "";
{
  const res = await app.request(`/tenants/${TENANT_A}/appointments/google/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { url: string };
  const dialog = new URL(body.url);
  assert.equal(dialog.pathname, "/o/oauth2/v2/auth");
  assert.equal(dialog.searchParams.get("client_id"), "google-client-panel");
  assert.equal(
    dialog.searchParams.get("redirect_uri"),
    "https://app.test/api/google/oauth/callback",
  );
  assert.equal(dialog.searchParams.get("access_type"), "offline");
  const scope = dialog.searchParams.get("scope") ?? "";
  for (const needed of [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/business.manage",
  ]) {
    assert.ok(scope.split(" ").includes(needed), `scope harus memuat ${needed}`);
  }
  state = dialog.searchParams.get("state")!;
  assert.ok(state.length > 10);
  console.log("[2] dialog connect → scope lengkap (calendar + youtube + business.manage): OK");
}

// ---------- [3] Callback → koneksi + youtube + google_business tersinkron ----------
{
  const res = await app.request(
    `/google/oauth/callback?code=kode-google&state=${encodeURIComponent(state)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/appointments?google=connected",
  );
  assert.equal(lastTokenForm?.get("grant_type"), "authorization_code");
  assert.equal(lastTokenForm?.get("client_id"), "google-client-panel");
  assert.equal(lastTokenForm?.get("code"), "kode-google");

  const channels = await client.query<{
    provider: string;
    external_id: string;
    display_name: string | null;
    status: string;
    access_token_encrypted: string | null;
  }>(
    `SELECT provider, external_id, display_name, status, access_token_encrypted
       FROM channel_accounts WHERE tenant_id = $1 ORDER BY provider`,
    [TENANT_A],
  );
  const youtube = channels.rows.find((r) => r.provider === "youtube");
  assert.ok(youtube, "akun channel youtube harus tersinkron");
  assert.equal(youtube.external_id, "UC-kanal-1");
  assert.equal(youtube.display_name, "Kanal Kreator");
  assert.equal(youtube.status, "connected");
  // Token Google TIDAK disalin ke akun channel — tetap di koneksi.
  assert.equal(youtube.access_token_encrypted, null);

  const gbp = channels.rows.find((r) => r.provider === "google_business");
  assert.ok(gbp, "akun channel google_business harus tersinkron");
  assert.equal(gbp.external_id, "accounts/123/locations/456");
  assert.equal(gbp.display_name, "Toko Kreator");
  assert.equal(gbp.status, "connected");
  assert.equal(gbp.access_token_encrypted, null);

  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  assert.ok(targets.some((t) => t.provider === "youtube"));
  assert.ok(targets.some((t) => t.provider === "google_business"));
  console.log("[3] callback → youtube + google_business tersinkron sebagai akun channel + sasaran /posts: OK");
}

// ---------- [4] Status yang dibaca blok Channels ----------
{
  const res = await app.request(`/tenants/${TENANT_A}/appointments/google`, {
    headers: { "x-test-user": USER_A },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    connected: boolean;
    accountEmail: string | null;
  };
  assert.equal(body.connected, true);
  assert.equal(body.accountEmail, "kreator@gmail.test");
  console.log("[4] status Google → connected + email akun (dasar blok Channels): OK");
}

// ---------- [5] State rusak → error tanpa koneksi baru ----------
{
  const res = await app.request(
    `/google/oauth/callback?code=kode-google&state=${state}x`,
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") ?? "").includes("google=error"),
  );
  console.log("[5] state rusak → redirect google=error: OK");
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify google-channels (PGlite + Google tiruan): SEMUA LULUS");
