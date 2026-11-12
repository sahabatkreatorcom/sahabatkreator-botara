/**
 * Verifikasi Google per layanan (pemisahan Google OAuth, 2026-11-12)
 * — membuktikan tiga koneksi Google MANDIRI (Calendar / YouTube /
 * Google Business) di atas PGlite + server Google tiruan
 * (node:http lokal). Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Yang dibuktikan:
 *   [1] connect per layanan tanpa klien OAuth terkonfigurasi → 422
 *       GOOGLE_NOT_CONFIGURED (jujur, tanpa URL mati);
 *   [2] dialog per layanan meminta scope SEMPIT layanannya SAJA dan
 *       memakai client_id LAYANAN itu (pasangan per-layanan menang
 *       atas pasangan bersama); calendar tanpa pasangan khusus
 *       jatuh ke pasangan bersama;
 *   [3] callback CALENDAR hanya menyimpan koneksi calendar — tidak
 *       ada sinkron kanal/lokasi dari consent kalender;
 *   [4] callback YOUTUBE (asal Channels) menukar kode dengan klien
 *       youtube, menyimpan koneksi youtube, dan menyinkronkan akun
 *       channel youtube DENGAN @handle + foto kanal (byte
 *       profile_photos) — token tidak disalin ke akun channel;
 *   [5] callback BUSINESS menukar kode dengan klien business dan
 *       menyinkronkan lokasi google_business dari koneksi business;
 *   [6] GET /google/status melaporkan tiga layanan secara mandiri;
 *   [7] lapisan PANEL mengalahkan env dalam rantai kredensial;
 *   [8] refresh token memakai klien layanan penerbit (youtube);
 *   [9] migrasi 0023 menyemai koneksi gabungan lama: scope lengkap
 *       → tiga baris google_connections; calendar-saja → satu baris;
 *  [10] callback ber-state rusak → redirect error, tanpa koneksi.
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
import {
  getYouTubePublishAccess,
  listPostTargets,
  setPlatformSetting,
} from "@sahabat-kreator/core";
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
// Google tiruan — satu server untuk token/userinfo/YouTube/GBP/thumbnail
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
      items: [
        {
          id: "UC-kanal-1",
          snippet: {
            title: "Kanal Kreator",
            customUrl: "@kanalkreator",
            thumbnails: {
              high: { url: `http://${req.headers.host}/thumb.jpg` },
            },
          },
        },
      ],
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/thumb.jpg") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(Buffer.from("byte-foto-kanal-tiruan"));
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
  google_oauth_client_id: "google-client-bersama",
  google_oauth_client_secret: "google-secret-bersama",
  google_youtube_client_id: "google-client-youtube",
  google_youtube_client_secret: "google-secret-youtube",
  google_business_client_id: "google-client-bisnis",
  google_business_client_secret: "google-secret-bisnis",
});

async function startConnect(
  appInstance: ReturnType<typeof buildApp>,
  urlPath: string,
): Promise<URL> {
  const res = await appInstance.request(urlPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200, `connect ${urlPath} harus 200`);
  const body = (await res.json()) as { url: string };
  return new URL(body.url);
}

function scopeSet(dialog: URL): Set<string> {
  return new Set((dialog.searchParams.get("scope") ?? "").split(" "));
}

async function serviceConnections(): Promise<
  Array<{ service: string; account_email: string }>
> {
  const rows = await client.query<{ service: string; account_email: string }>(
    `SELECT service, account_email FROM google_connections
      WHERE tenant_id = $1 ORDER BY service`,
    [TENANT_A],
  );
  return rows.rows;
}

// ---------- [1] Tanpa klien OAuth → 422 jujur (semua jalur) ----------
{
  for (const urlPath of [
    `/tenants/${TENANT_A}/appointments/google/connect`,
    `/tenants/${TENANT_A}/google/youtube/connect`,
    `/tenants/${TENANT_A}/google/business/connect`,
  ]) {
    const res = await unconfiguredApp.request(urlPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 422, `${urlPath} harus 422`);
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      "GOOGLE_NOT_CONFIGURED",
    );
  }
  // Layanan tak dikenal → 404.
  const res = await app.request(`/tenants/${TENANT_A}/google/drive/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 404);
  console.log("[1] tanpa klien OAuth → 422 GOOGLE_NOT_CONFIGURED di semua jalur connect; layanan asing 404: OK");
}

// ---------- [2] Dialog per layanan: scope sempit + client_id layanan ----------
let stateCalendar = "";
let stateYoutube = "";
let stateBusiness = "";
{
  const cal = await startConnect(
    app,
    `/tenants/${TENANT_A}/appointments/google/connect`,
  );
  assert.equal(cal.pathname, "/o/oauth2/v2/auth");
  // Calendar TANPA pasangan khusus → pasangan bersama (fallback).
  assert.equal(cal.searchParams.get("client_id"), "google-client-bersama");
  assert.equal(
    cal.searchParams.get("redirect_uri"),
    "https://app.test/api/google/oauth/callback",
  );
  assert.deepEqual(
    scopeSet(cal),
    new Set([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]),
  );
  stateCalendar = cal.searchParams.get("state")!;

  const yt = await startConnect(
    app,
    `/tenants/${TENANT_A}/google/youtube/connect`,
  );
  // Pasangan per-layanan MENANG atas pasangan bersama.
  assert.equal(yt.searchParams.get("client_id"), "google-client-youtube");
  assert.deepEqual(
    scopeSet(yt),
    new Set([
      "openid",
      "email",
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ]),
  );
  stateYoutube = yt.searchParams.get("state")!;

  const biz = await startConnect(
    app,
    `/tenants/${TENANT_A}/google/business/connect`,
  );
  assert.equal(biz.searchParams.get("client_id"), "google-client-bisnis");
  assert.deepEqual(
    scopeSet(biz),
    new Set([
      "openid",
      "email",
      "https://www.googleapis.com/auth/business.manage",
    ]),
  );
  stateBusiness = biz.searchParams.get("state")!;
  console.log("[2] dialog per layanan → scope sempit tepat + client_id layanan (per-layanan > bersama): OK");
}

// ---------- [3] Callback calendar: hanya koneksi calendar ----------
{
  const res = await app.request(
    `/google/oauth/callback?code=kode-kalender&state=${encodeURIComponent(stateCalendar)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/appointments?google=connected",
  );
  assert.equal(lastTokenForm?.get("client_id"), "google-client-bersama");
  assert.deepEqual(
    (await serviceConnections()).map((r) => r.service),
    ["calendar"],
  );
  // Consent kalender TIDAK menyinkronkan apa pun.
  const accounts = await client.query(
    `SELECT count(*)::int AS n FROM channel_accounts WHERE tenant_id = $1`,
    [TENANT_A],
  );
  assert.equal(accounts.rows[0]!.n, 0);
  console.log("[3] callback calendar → hanya koneksi calendar tersimpan, tanpa sinkron kanal/lokasi: OK");
}

// ---------- [4] Callback youtube: koneksi youtube + kanal + handle + foto ----------
{
  const res = await app.request(
    `/google/oauth/callback?code=kode-youtube&state=${encodeURIComponent(stateYoutube)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?google_oauth=connected&google_service=youtube",
  );
  // Kode ditukar dengan KLIEN YOUTUBE, bukan klien bersama.
  assert.equal(lastTokenForm?.get("client_id"), "google-client-youtube");
  assert.deepEqual(
    (await serviceConnections()).map((r) => r.service),
    ["calendar", "youtube"],
  );
  const channels = await client.query<{
    id: string;
    external_id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
    access_token_encrypted: string | null;
  }>(
    `SELECT id, external_id, display_name, public_handle, status, access_token_encrypted
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'youtube'`,
    [TENANT_A],
  );
  assert.equal(channels.rows.length, 1);
  const youtube = channels.rows[0]!;
  assert.equal(youtube.external_id, "UC-kanal-1");
  assert.equal(youtube.display_name, "Kanal Kreator");
  assert.equal(youtube.public_handle, "@kanalkreator");
  assert.equal(youtube.status, "connected");
  assert.equal(youtube.access_token_encrypted, null);
  // Foto kanal tersimpan sebagai byte profile_photos.
  const photos = await client.query(
    `SELECT count(*)::int AS n FROM profile_photos
      WHERE tenant_id = $1 AND owner_type = 'channel_account' AND owner_id = $2`,
    [TENANT_A, youtube.id],
  );
  assert.equal(photos.rows[0]!.n, 1);
  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  assert.ok(targets.some((t) => t.provider === "youtube"));
  console.log("[4] callback youtube → koneksi youtube + kanal tersinkron dengan @handle + foto: OK");
}

// ---------- [5] Callback business: koneksi business + lokasi ----------
{
  const res = await app.request(
    `/google/oauth/callback?code=kode-bisnis&state=${encodeURIComponent(stateBusiness)}`,
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://app.test/channels?google_oauth=connected&google_service=business",
  );
  assert.equal(lastTokenForm?.get("client_id"), "google-client-bisnis");
  assert.deepEqual(
    (await serviceConnections()).map((r) => r.service),
    ["calendar", "youtube", "business"],
  );
  const gbp = await client.query<{
    external_id: string;
    display_name: string | null;
    status: string;
    access_token_encrypted: string | null;
  }>(
    `SELECT external_id, display_name, status, access_token_encrypted
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'google_business'`,
    [TENANT_A],
  );
  assert.equal(gbp.rows.length, 1);
  assert.equal(gbp.rows[0]!.external_id, "accounts/123/locations/456");
  assert.equal(gbp.rows[0]!.display_name, "Toko Kreator");
  assert.equal(gbp.rows[0]!.access_token_encrypted, null);
  console.log("[5] callback business → koneksi business + lokasi tersinkron dari koneksi itu: OK");
}

// ---------- [6] Status tiga layanan untuk blok Channels ----------
{
  const res = await app.request(`/tenants/${TENANT_A}/google/status`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    services: Array<{
      service: string;
      connected: boolean;
      accountEmail: string | null;
    }>;
  };
  assert.deepEqual(
    body.services.map((s) => [s.service, s.connected, s.accountEmail]),
    [
      ["calendar", true, "kreator@gmail.test"],
      ["youtube", true, "kreator@gmail.test"],
      ["business", true, "kreator@gmail.test"],
    ],
  );
  // Status janji temu (calendar) tetap membaca koneksi calendar.
  const calRes = await app.request(
    `/tenants/${TENANT_A}/appointments/google`,
  );
  const calBody = (await calRes.json()) as {
    connected: boolean;
    accountEmail: string | null;
  };
  assert.equal(calBody.connected, true);
  assert.equal(calBody.accountEmail, "kreator@gmail.test");
  console.log("[6] /google/status → tiga layanan mandiri (calendar/youtube/business connected + email): OK");
}

// ---------- [7] Lapisan panel mengalahkan env ----------
{
  await setPlatformSetting(
    db,
    { key: "google_youtube_client_id", value: "google-client-youtube-panel", updatedByUserId: USER_A },
    { masterSecret: MASTER, env: {} },
  );
  const yt = await startConnect(
    app,
    `/tenants/${TENANT_A}/google/youtube/connect`,
  );
  assert.equal(yt.searchParams.get("client_id"), "google-client-youtube-panel");
  console.log("[7] rantai kredensial: isian Panel Admin mengalahkan env per-layanan: OK");
}

// ---------- [8] Refresh memakai klien layanan youtube ----------
{
  // Kedaluwarsakan access token koneksi youtube → jalur publish
  // harus me-refresh dengan refresh token koneksi youtube.
  await client.query(
    `UPDATE google_connections SET token_expires_at = now() - interval '1 hour'
      WHERE tenant_id = $1 AND service = 'youtube'`,
    [TENANT_A],
  );
  lastTokenForm = null;
  const access = await getYouTubePublishAccess(db, TENANT_A, {
    platform: {
      masterSecret: MASTER,
      env: {
        google_oauth_client_id: "google-client-bersama",
        google_oauth_client_secret: "google-secret-bersama",
        google_youtube_client_id: "google-client-youtube",
        google_youtube_client_secret: "google-secret-youtube",
      },
    },
    tokenSecret: TOKEN_SECRET,
    bases: { apiBase: fakeBase, tokenBase: fakeBase, authBase: fakeBase },
  });
  assert.deepEqual(access, { kind: "ok", accessToken: G_ACCESS });
  assert.equal(lastTokenForm?.get("grant_type"), "refresh_token");
  // Panel (dari [7]) bahkan mengalahkan env saat refresh: client_id
  // yang terkirim adalah isian panel youtube.
  assert.equal(lastTokenForm?.get("client_id"), "google-client-youtube-panel");
  console.log("[8] refresh token youtube memakai klien layanan youtube (panel): OK");
}

// ---------- [9] Migrasi 0023 menyemai koneksi gabungan lama ----------
{
  const seedClient = new PGlite({ extensions: { vector, btree_gist } });
  const before = files.filter((f) => !f.startsWith("0023"));
  for (const file of before) {
    const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
    await seedClient.exec(sqlText.replaceAll("--> statement-breakpoint", ""));
  }
  const TENANT_FULL = "22222222-2222-4222-8222-222222222222";
  const TENANT_CAL = "33333333-3333-4333-8333-333333333333";
  await seedClient.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant Full', 'tenant-full'), ($2, 'Tenant Cal', 'tenant-cal')`,
    [TENANT_FULL, TENANT_CAL],
  );
  await seedClient.query(
    `INSERT INTO google_calendar_connections
       (tenant_id, account_email, access_token_encrypted, refresh_token_encrypted, scopes, token_expires_at)
     VALUES ($1, 'full@sk.test', 'v1:akses-full', 'v1:refresh-full', $3, now() + interval '1 hour'),
            ($2, 'cal@sk.test', 'v1:akses-cal', 'v1:refresh-cal', $4, now() + interval '1 hour')`,
    [
      TENANT_FULL,
      TENANT_CAL,
      FULL_SCOPE,
      "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
    ],
  );
  const migration0023 = files.find((f) => f.startsWith("0023"))!;
  const sql0023 = await readFile(path.join(migrationsDir, migration0023), "utf8");
  await seedClient.exec(sql0023.replaceAll("--> statement-breakpoint", ""));

  const seeded = await seedClient.query<{ tenant_id: string; service: string; refresh: string }>(
    `SELECT tenant_id, service, refresh_token_encrypted AS refresh
       FROM google_connections ORDER BY tenant_id, service`,
  );
  assert.deepEqual(
    seeded.rows.map((r) => [r.tenant_id, r.service]),
    [
      [TENANT_FULL, "calendar"],
      [TENANT_FULL, "youtube"],
      [TENANT_FULL, "business"],
      [TENANT_CAL, "calendar"],
    ],
  );
  // Refresh token bersama tersalin apa adanya (tidak dirotasi Google).
  assert.ok(seeded.rows.every((r) => r.refresh.startsWith("v1:refresh-")));
  // Tabel lama dibiarkan sebagai arsip (tidak di-drop).
  const legacy = await seedClient.query(
    `SELECT count(*)::int AS n FROM google_calendar_connections`,
  );
  assert.equal(legacy.rows[0]!.n, 2);
  await seedClient.close();
  console.log("[9] migrasi 0023 → scope lengkap tersemai 3 baris, calendar-saja 1 baris, arsip lama utuh: OK");
}

// ---------- [10] State rusak → error tanpa koneksi baru ----------
{
  const before10 = (await serviceConnections()).length;
  const fresh = await startConnect(
    app,
    `/tenants/${TENANT_A}/google/youtube/connect`,
  );
  const res = await app.request(
    `/google/oauth/callback?code=kode-youtube&state=${fresh.searchParams.get("state")}x`,
  );
  assert.equal(res.status, 302);
  assert.ok((res.headers.get("location") ?? "").includes("google=error"));
  assert.equal((await serviceConnections()).length, before10);
  console.log("[10] state rusak → redirect error, jumlah koneksi tidak berubah: OK");
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify google-channels per layanan (PGlite + Google tiruan): SEMUA LULUS");
