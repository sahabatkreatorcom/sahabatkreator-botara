/**
 * Verifikasi lifecycle token Pinterest (gelombang Semua OAuth):
 *
 *  (a) keputusan murni (pinterestTokenLifecycleDecision): varian
 *      pinterest_user_token + refresh token + konfigurasi lengkap →
 *      "refresh"; tanpa refresh token / tanpa konfigurasi → "warn";
 *      kesehatan expired vs expiring mengikuti jadwal.
 *  (b) klien OAuth di jahitan fetchImpl: exchange & refresh memakai
 *      POST form ke /v5/oauth/token dengan Basic auth
 *      base64(appId:secret); user_account membaca profile_image;
 *      penolakan 401 → PinterestApiError status 401.
 *  (c) runner end-to-end di atas PGlite + server Pinterest tiruan:
 *      akun mendekati kedaluwarsa di-refresh — access token berputar
 *      DAN refresh token berputar bila grant menerbitkan yang baru;
 *      grant TANPA refresh baru → refresh lama DIPERTAHANKAN;
 *      refresh mati (401) → status 'error' + pinterest_unauthorized
 *      + kesehatan expired; akun tanpa refresh token hanya ditandai
 *      expiring; akun yang jauh dari kedaluwarsa TIDAK tersentuh.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:pinterest-token-lifecycle
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
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  PinterestApiError,
  PinterestClient,
} from "@sahabat-kreator/channel-pinterest";
import {
  decryptChannelSecret,
  encryptChannelSecret,
  pinterestTokenLifecycleDecision,
} from "@sahabat-kreator/core";
import { runPinterestTokenLifecycle } from "../src/pinterest-token-lifecycle";

let passes = 0;
function check(name: string, ok: boolean): void {
  assert.ok(ok, name);
  passes += 1;
  console.log(`PASS  ${name}`);
}

// ---------- (a) Keputusan murni ----------
{
  const now = new Date("2026-11-12T00:00:00Z");
  const soon = new Date(now.getTime() + 5 * 24 * 3600 * 1000);
  const past = new Date(now.getTime() - 3600 * 1000);
  check(
    "pinterest_user_token + refresh token + konfigurasi lengkap → refresh/expiring",
    JSON.stringify(
      pinterestTokenLifecycleDecision({
        tokenType: "pinterest_user_token",
        tokenExpiresAt: soon,
        now,
        canRefresh: true,
        hasRefreshToken: true,
      }),
    ) === JSON.stringify({ action: "refresh", health: "expiring" }),
  );
  check(
    "tanpa refresh token tersimpan → warn",
    pinterestTokenLifecycleDecision({
      tokenType: "pinterest_user_token",
      tokenExpiresAt: soon,
      now,
      canRefresh: true,
      hasRefreshToken: false,
    }).action === "warn",
  );
  check(
    "tanpa konfigurasi aplikasi → warn",
    pinterestTokenLifecycleDecision({
      tokenType: "pinterest_user_token",
      tokenExpiresAt: soon,
      now,
      canRefresh: false,
      hasRefreshToken: true,
    }).action === "warn",
  );
  check(
    "sudah lewat jadwal → health expired",
    pinterestTokenLifecycleDecision({
      tokenType: "pinterest_user_token",
      tokenExpiresAt: past,
      now,
      canRefresh: true,
      hasRefreshToken: true,
    }).health === "expired",
  );
}

// ---------- (b) Bentuk panggilan klien di jahitan fetchImpl ----------
{
  const calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = [];
  const fetchImpl = (async (
    input: string | URL,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<Response> => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ?? null,
      auth: init?.headers?.Authorization ?? null,
    });
    if (url.includes("/v5/oauth/token")) {
      const form = new URLSearchParams(init?.body ?? "");
      if (form.get("refresh_token") === "refresh-mati") {
        return new Response(
          JSON.stringify({ code: 3, message: "Invalid refresh token" }),
          { status: 401 },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "pin-akses-baru",
          refresh_token: "pin-refresh-baru",
          expires_in: 2592000,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/v5/user_account")) {
      return new Response(
        JSON.stringify({
          id: "pin-user-1",
          username: "kreatorpin",
          profile_image: "https://cdn.test/pin.jpg",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ message: "unmocked" }), { status: 404 });
  }) as typeof fetch;

  const client = new PinterestClient({ baseUrl: "https://api.pinterest.com", fetchImpl });
  const expectedBasic = `Basic ${Buffer.from("app-uji:secret-uji").toString("base64")}`;
  const exchanged = await client.exchangePinterestCode({
    appId: "app-uji",
    appSecret: "secret-uji",
    code: "kode-uji",
    redirectUri: "https://app.test/api/oauth/pinterest/callback",
  });
  check(
    "exchange code → token + refresh + expires_in 30 hari",
    exchanged.accessToken === "pin-akses-baru" &&
      exchanged.refreshToken === "pin-refresh-baru" &&
      exchanged.expiresInSeconds === 2592000,
  );
  const form = new URLSearchParams(calls[0]!.body ?? "");
  check(
    "exchange = POST form authorization_code + Basic auth (secret TIDAK di badan)",
    calls[0]!.method === "POST" &&
      calls[0]!.url.endsWith("/v5/oauth/token") &&
      calls[0]!.auth === expectedBasic &&
      form.get("grant_type") === "authorization_code" &&
      form.get("code") === "kode-uji" &&
      form.get("redirect_uri") === "https://app.test/api/oauth/pinterest/callback" &&
      form.get("client_secret") === null,
  );
  const refreshed = await client.refreshPinterestAccessToken({
    appId: "app-uji",
    appSecret: "secret-uji",
    refreshToken: "pin-refresh-lama",
  });
  const refreshForm = new URLSearchParams(calls[1]!.body ?? "");
  check(
    "refresh memakai grant refresh_token + Basic auth yang sama",
    refreshForm.get("grant_type") === "refresh_token" &&
      refreshForm.get("refresh_token") === "pin-refresh-lama" &&
      calls[1]!.auth === expectedBasic &&
      refreshed.accessToken === "pin-akses-baru",
  );
  const account = await client.getPinterestUserAccount("pin-akses-baru");
  check(
    "user_account → id/username/profile_image terbaca",
    account.id === "pin-user-1" &&
      account.username === "kreatorpin" &&
      account.profileImageUrl === "https://cdn.test/pin.jpg",
  );
  let caught: unknown = null;
  try {
    await client.refreshPinterestAccessToken({
      appId: "app-uji",
      appSecret: "secret-uji",
      refreshToken: "refresh-mati",
    });
  } catch (err) {
    caught = err;
  }
  check(
    "penolakan refresh 401 → PinterestApiError status 401",
    caught instanceof PinterestApiError && caught.status === 401,
  );
}

// ---------- (c) Runner end-to-end: PGlite + server tiruan ----------
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
const db = drizzle(client, { schema }) as unknown as Database;

const TENANT = "11111111-1111-4111-8111-111111111111";
const CHANNEL_SECRET = randomBytes(32).toString("base64");
const MASTER = randomBytes(32).toString("base64");
const DAY = 24 * 3600 * 1000;
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant Uji', 'tenant-uji')`,
  [TENANT],
);

async function seedAccount(
  externalId: string,
  accessToken: string,
  refreshToken: string | null,
  expiresInMs: number,
): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `INSERT INTO channel_accounts
       (tenant_id, provider, external_id, display_name, status,
        access_token_encrypted, refresh_token_encrypted, token_type,
        token_expires_at, token_health)
     VALUES ($1, 'pinterest', $2, 'kreatorpin', 'connected', $3, $4,
             'pinterest_user_token', $5, 'ok')
     RETURNING id`,
    [
      TENANT,
      externalId,
      encryptChannelSecret(CHANNEL_SECRET, accessToken),
      refreshToken ? encryptChannelSecret(CHANNEL_SECRET, refreshToken) : null,
      new Date(Date.now() + expiresInMs),
    ],
  );
  return rows.rows[0]!.id;
}

const ACCESS_OK = "pin-akses-akan-direfresh";
const REFRESH_OK = "pin-refresh-akan-dipakai";
const ACCESS_OK_BARU = "pin-akses-hasil-refresh";
const REFRESH_OK_BARU = "pin-refresh-hasil-rotasi";
const ACCESS_TETAP = "pin-akses-rotaseless-lama";
const REFRESH_TETAP = "pin-refresh-tanpa-rotasi";
const ACCESS_TETAP_BARU = "pin-akses-rotaseless-baru";
const ACCESS_MATI = "pin-akses-refresh-mati";
const REFRESH_MATI = "pin-refresh-sudah-mati";
const ACCESS_TANPA_REFRESH = "pin-akses-tanpa-refresh";
const ACCESS_AMAN = "pin-akses-masih-lama";
const REFRESH_AMAN = "pin-refresh-masih-lama";
const accOk = await seedAccount("pin-ok", ACCESS_OK, REFRESH_OK, 5 * DAY);
const accTetap = await seedAccount("pin-tetap", ACCESS_TETAP, REFRESH_TETAP, 5 * DAY);
const accMati = await seedAccount("pin-mati", ACCESS_MATI, REFRESH_MATI, 2 * DAY);
const accWarn = await seedAccount("pin-warn", ACCESS_TANPA_REFRESH, null, 5 * DAY);
const accAman = await seedAccount("pin-aman", ACCESS_AMAN, REFRESH_AMAN, 60 * DAY);

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && url.pathname === "/v5/oauth/token") {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") !== "refresh_token") {
        json(400, { code: 2, message: "grant salah" });
        return;
      }
      if (form.get("refresh_token") === REFRESH_OK) {
        json(200, {
          access_token: ACCESS_OK_BARU,
          refresh_token: REFRESH_OK_BARU,
          expires_in: 2592000,
        });
        return;
      }
      if (form.get("refresh_token") === REFRESH_TETAP) {
        // Grant TANPA refresh token baru — yang lama harus dipertahankan.
        json(200, { access_token: ACCESS_TETAP_BARU, expires_in: 2592000 });
        return;
      }
      json(401, { code: 3, message: "Invalid refresh token" });
    });
    return;
  }
  json(404, { code: 404, message: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeBase = `http://127.0.0.1:${(fake as Server & { address: () => { port: number } }).address().port}`;

const result = await runPinterestTokenLifecycle({
  db,
  platform: {
    masterSecret: MASTER,
    env: { pinterest_app_id: "app-uji", pinterest_app_secret: "secret-uji" },
  },
  channelTokenSecret: CHANNEL_SECRET,
  pinterestApiBase: fakeBase,
});
check("runner: terpindai 4 (yang jauh dari kedaluwarsa tidak ikut)", result.scanned === 4);
check("runner: refreshed 2", result.refreshed === 2);
check("runner: authErrored 1", result.authErrored === 1);
check("runner: warned 1 (tanpa refresh token)", result.warned === 1);
check("runner: failed 0", result.failed === 0);

const after = await client.query<{
  id: string;
  status: string;
  error_code: string | null;
  token_health: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_refreshed_at: Date | null;
  token_expires_at: Date;
}>(
  `SELECT id, status, error_code, token_health, access_token_encrypted,
          refresh_token_encrypted, token_refreshed_at, token_expires_at
     FROM channel_accounts WHERE provider = 'pinterest'`,
);
const byId = new Map(after.rows.map((r) => [r.id, r]));
const ok = byId.get(accOk)!;
check(
  "akun ok: access token berputar (terenkripsi)",
  decryptChannelSecret(CHANNEL_SECRET, ok.access_token_encrypted) === ACCESS_OK_BARU &&
    !ok.access_token_encrypted.includes(ACCESS_OK_BARU),
);
check(
  "akun ok: refresh token ikut berputar; kesehatan ok; expiry mundur ±30 hari",
  ok.refresh_token_encrypted !== null &&
    decryptChannelSecret(CHANNEL_SECRET, ok.refresh_token_encrypted) === REFRESH_OK_BARU &&
    ok.token_health === "ok" &&
    new Date(ok.token_expires_at).getTime() > Date.now() + 25 * DAY,
);
const tetap = byId.get(accTetap)!;
check(
  "akun tanpa rotasi: access berputar, refresh lama DIPERTAHANKAN",
  decryptChannelSecret(CHANNEL_SECRET, tetap.access_token_encrypted) === ACCESS_TETAP_BARU &&
    tetap.refresh_token_encrypted !== null &&
    decryptChannelSecret(CHANNEL_SECRET, tetap.refresh_token_encrypted) === REFRESH_TETAP,
);
const mati = byId.get(accMati)!;
check(
  "akun mati: status error + pinterest_unauthorized + kesehatan expired",
  mati.status === "error" &&
    mati.error_code === "pinterest_unauthorized" &&
    mati.token_health === "expired",
);
const warn = byId.get(accWarn)!;
check(
  "akun tanpa refresh token: tetap connected, kesehatan expiring (warn)",
  warn.status === "connected" && warn.token_health === "expiring",
);
const aman = byId.get(accAman)!;
check(
  "akun aman: tidak tersentuh sama sekali",
  aman.status === "connected" &&
    decryptChannelSecret(CHANNEL_SECRET, aman.access_token_encrypted) === ACCESS_AMAN &&
    aman.token_refreshed_at === null,
);

fake.closeAllConnections();
fake.close();
await client.close();
console.log(`verify pinterest-token-lifecycle: SEMUA LULUS (${passes} PASS)`);
