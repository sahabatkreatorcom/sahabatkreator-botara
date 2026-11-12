/**
 * Verifikasi lifecycle token TikTok (gelombang Semua OAuth):
 *
 *  (a) keputusan murni (tiktokTokenLifecycleDecision): varian
 *      tiktok_user_token + refresh token + konfigurasi lengkap →
 *      "refresh"; tanpa refresh token / tanpa konfigurasi → "warn";
 *      kesehatan expired vs expiring mengikuti jadwal.
 *  (b) klien OAuth di jahitan fetchImpl: exchange code dan refresh
 *      memakai POST form ke /v2/oauth/token/ dengan field resmi;
 *      user info membaca envelope data.user (avatar_url ikut);
 *      penolakan refresh_token_invalid → TikTokApiError providerCode.
 *  (c) runner end-to-end di atas PGlite + server TikTok tiruan:
 *      akun yang mendekati kedaluwarsa di-refresh — access token
 *      berputar DAN refresh token berputar (rotasi penuh, atomik);
 *      akun yang refresh token-nya mati menjadi status 'error' +
 *      tiktok_refresh_token_invalid + kesehatan expired; akun tanpa
 *      refresh token hanya ditandai expiring (warn); akun yang masih
 *      jauh dari kedaluwarsa TIDAK tersentuh.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:tiktok-token-lifecycle
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
import { TikTokApiError, TikTokClient } from "@sahabat-kreator/channel-tiktok";
import {
  decryptChannelSecret,
  encryptChannelSecret,
  tiktokTokenLifecycleDecision,
} from "@sahabat-kreator/core";
import { runTikTokTokenLifecycle } from "../src/tiktok-token-lifecycle";

let passes = 0;
function check(name: string, ok: boolean): void {
  assert.ok(ok, name);
  passes += 1;
  console.log(`PASS  ${name}`);
}

// ---------- (a) Keputusan murni ----------
{
  const now = new Date("2026-11-12T00:00:00Z");
  const soon = new Date(now.getTime() + 12 * 3600 * 1000);
  const past = new Date(now.getTime() - 3600 * 1000);
  check(
    "tiktok_user_token + refresh token + konfigurasi lengkap → refresh/expiring",
    JSON.stringify(
      tiktokTokenLifecycleDecision({
        tokenType: "tiktok_user_token",
        tokenExpiresAt: soon,
        now,
        canRefresh: true,
        hasRefreshToken: true,
      }),
    ) === JSON.stringify({ action: "refresh", health: "expiring" }),
  );
  check(
    "tanpa refresh token tersimpan → warn",
    tiktokTokenLifecycleDecision({
      tokenType: "tiktok_user_token",
      tokenExpiresAt: soon,
      now,
      canRefresh: true,
      hasRefreshToken: false,
    }).action === "warn",
  );
  check(
    "tanpa konfigurasi aplikasi → warn",
    tiktokTokenLifecycleDecision({
      tokenType: "tiktok_user_token",
      tokenExpiresAt: soon,
      now,
      canRefresh: false,
      hasRefreshToken: true,
    }).action === "warn",
  );
  check(
    "sudah lewat jadwal → health expired",
    tiktokTokenLifecycleDecision({
      tokenType: "tiktok_user_token",
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
    if (url.includes("/v2/oauth/token/")) {
      const form = new URLSearchParams(init?.body ?? "");
      if (form.get("refresh_token") === "refresh-mati") {
        return new Response(
          JSON.stringify({ error: "refresh_token_invalid", error_description: "refresh token tidak berlaku" }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "akses-baru",
          refresh_token: "refresh-baru",
          open_id: "open-1",
          expires_in: 86400,
          refresh_expires_in: 31536000,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/v2/user/info/")) {
      return new Response(
        JSON.stringify({
          data: {
            user: {
              open_id: "open-1",
              username: "kreator",
              display_name: "Kreator",
              avatar_url: "https://cdn.test/avatar.jpg",
            },
          },
          error: { code: "ok", message: "", request_id: "r1" },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "unmocked" }), { status: 404 });
  }) as typeof fetch;

  const client = new TikTokClient({ baseUrl: "https://open.tiktokapis.com", fetchImpl });
  const exchanged = await client.exchangeTikTokCode({
    clientKey: "key-uji",
    clientSecret: "secret-uji",
    code: "kode-uji",
    redirectUri: "https://app.test/api/oauth/tiktok/callback",
  });
  check(
    "exchange code → token + refresh + open_id terpetakan",
    exchanged.accessToken === "akses-baru" &&
      exchanged.refreshToken === "refresh-baru" &&
      exchanged.openId === "open-1" &&
      exchanged.expiresInSeconds === 86400,
  );
  const form = new URLSearchParams(calls[0]!.body ?? "");
  check(
    "exchange = POST form authorization_code lengkap ke /v2/oauth/token/",
    calls[0]!.method === "POST" &&
      calls[0]!.url.endsWith("/v2/oauth/token/") &&
      form.get("grant_type") === "authorization_code" &&
      form.get("client_key") === "key-uji" &&
      form.get("client_secret") === "secret-uji" &&
      form.get("code") === "kode-uji" &&
      form.get("redirect_uri") === "https://app.test/api/oauth/tiktok/callback",
  );
  const refreshed = await client.refreshTikTokAccessToken({
    clientKey: "key-uji",
    clientSecret: "secret-uji",
    refreshToken: "refresh-lama",
  });
  const refreshForm = new URLSearchParams(calls[1]!.body ?? "");
  check(
    "refresh memakai grant refresh_token dengan field resmi",
    refreshForm.get("grant_type") === "refresh_token" &&
      refreshForm.get("refresh_token") === "refresh-lama" &&
      refreshed.accessToken === "akses-baru" &&
      refreshed.refreshToken === "refresh-baru",
  );
  const info = await client.getTikTokUserInfo("akses-baru");
  check(
    "user info → envelope data.user terbaca + avatar_url + Bearer",
    info.openId === "open-1" &&
      info.username === "kreator" &&
      info.avatarUrl === "https://cdn.test/avatar.jpg" &&
      calls[2]!.auth === "Bearer akses-baru" &&
      calls[2]!.url.includes("fields=open_id,username,display_name,avatar_url"),
  );
  let caught: unknown = null;
  try {
    await client.refreshTikTokAccessToken({
      clientKey: "key-uji",
      clientSecret: "secret-uji",
      refreshToken: "refresh-mati",
    });
  } catch (err) {
    caught = err;
  }
  check(
    "penolakan refresh → TikTokApiError providerCode refresh_token_invalid",
    caught instanceof TikTokApiError && caught.providerCode === "refresh_token_invalid",
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
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
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
     VALUES ($1, 'tiktok', $2, 'Akun Uji', 'connected', $3, $4,
             'tiktok_user_token', $5, 'ok')
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

const ACCESS_OK = "akses-akan-direfresh";
const REFRESH_OK = "refresh-akan-dipakai";
const ACCESS_OK_BARU = "akses-hasil-refresh";
const REFRESH_OK_BARU = "refresh-hasil-rotasi";
const ACCESS_MATI = "akses-pemilik-refresh-mati";
const REFRESH_MATI = "refresh-sudah-mati";
const ACCESS_TANPA_REFRESH = "akses-tanpa-refresh";
const ACCESS_AMAN = "akses-masih-lama";
const REFRESH_AMAN = "refresh-masih-lama";
const accOk = await seedAccount("tt-ok", ACCESS_OK, REFRESH_OK, 12 * HOUR);
const accMati = await seedAccount("tt-mati", ACCESS_MATI, REFRESH_MATI, 6 * HOUR);
const accWarn = await seedAccount("tt-warn", ACCESS_TANPA_REFRESH, null, 12 * HOUR);
const accAman = await seedAccount("tt-aman", ACCESS_AMAN, REFRESH_AMAN, 30 * DAY);

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && url.pathname === "/v2/oauth/token/") {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") !== "refresh_token") {
        json(400, { error: "invalid_request", error_description: "grant salah" });
        return;
      }
      if (form.get("refresh_token") === REFRESH_OK) {
        json(200, {
          access_token: ACCESS_OK_BARU,
          refresh_token: REFRESH_OK_BARU,
          open_id: "tt-ok",
          expires_in: 86400,
          refresh_expires_in: 31536000,
        });
        return;
      }
      json(400, { error: "refresh_token_invalid", error_description: "refresh token tidak berlaku" });
    });
    return;
  }
  json(404, { error: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeBase = `http://127.0.0.1:${(fake as Server & { address: () => { port: number } }).address().port}`;

const result = await runTikTokTokenLifecycle({
  db,
  platform: {
    masterSecret: MASTER,
    env: {
      tiktok_client_key: "key-uji",
      tiktok_client_secret: "secret-uji",
    },
  },
  channelTokenSecret: CHANNEL_SECRET,
  tiktokApiBase: fakeBase,
});
check("runner: terpindai 3 (yang jauh dari kedaluwarsa tidak ikut)", result.scanned === 3);
check("runner: refreshed 1", result.refreshed === 1);
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
     FROM channel_accounts WHERE provider = 'tiktok'`,
);
const byId = new Map(after.rows.map((r) => [r.id, r]));
const ok = byId.get(accOk)!;
check(
  "akun ok: access token berputar (terenkripsi)",
  decryptChannelSecret(CHANNEL_SECRET, ok.access_token_encrypted) === ACCESS_OK_BARU &&
    !ok.access_token_encrypted.includes(ACCESS_OK_BARU),
);
check(
  "akun ok: refresh token ikut BERPUTAR (rotasi penuh atomik)",
  ok.refresh_token_encrypted !== null &&
    decryptChannelSecret(CHANNEL_SECRET, ok.refresh_token_encrypted) === REFRESH_OK_BARU,
);
check(
  "akun ok: refreshed_at terisi, kesehatan ok, expiry mundur ±24 jam",
  ok.token_refreshed_at !== null &&
    ok.token_health === "ok" &&
    new Date(ok.token_expires_at).getTime() > Date.now() + 20 * HOUR,
);
const mati = byId.get(accMati)!;
check(
  "akun mati: status error + tiktok_refresh_token_invalid + kesehatan expired",
  mati.status === "error" &&
    mati.error_code === "tiktok_refresh_token_invalid" &&
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
console.log(`verify tiktok-token-lifecycle: SEMUA LULUS (${passes} PASS)`);
