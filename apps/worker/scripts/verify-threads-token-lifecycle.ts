/**
 * Verifikasi lifecycle token Threads (integrasi Threads):
 *
 *  (a) keputusan murni (threadsTokenLifecycleDecision): varian
 *      threads_user_token + konfigurasi lengkap → "refresh"; tanpa
 *      konfigurasi / varian lain → "warn"; kesehatan expired vs
 *      expiring mengikuti jadwal.
 *  (b) klien refresh `th_refresh_token` di jahitan fetchImpl: URL
 *      grant + token sebagai query (bentuk resmi Threads), hasil
 *      token + expires_in terpetakan, penolakan Graph 190 →
 *      ThreadsGraphError code 190; exchange code (POST form) dan
 *      exchange long-lived (th_exchange_token) juga diperiksa
 *      bentuknya.
 *  (c) runner end-to-end di atas PGlite + server Threads tiruan:
 *      akun yang mendekati kedaluwarsa di-refresh (token tersimpan
 *      berputar, refreshed_at terisi, kesehatan ok, expiry mundur);
 *      akun yang refresh-nya ditolak 190 menjadi status 'error' +
 *      threads_graph_190 + kesehatan expired; akun yang masih jauh
 *      dari kedaluwarsa TIDAK tersentuh.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:threads-token-lifecycle
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
  ThreadsGraphClient,
  ThreadsGraphError,
} from "@sahabat-kreator/channel-messenger";
import {
  decryptChannelSecret,
  encryptChannelSecret,
  threadsTokenLifecycleDecision,
} from "@sahabat-kreator/core";
import { runThreadsTokenLifecycle } from "../src/threads-token-lifecycle";

let passes = 0;
function check(name: string, ok: boolean): void {
  assert.ok(ok, name);
  passes += 1;
  console.log(`PASS  ${name}`);
}

// ---------- (a) Keputusan murni ----------
{
  const now = new Date("2026-11-12T00:00:00Z");
  const soon = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
  const past = new Date(now.getTime() - 3600 * 1000);
  check(
    "threads_user_token + konfigurasi lengkap → refresh/expiring",
    JSON.stringify(
      threadsTokenLifecycleDecision({
        tokenType: "threads_user_token",
        tokenExpiresAt: soon,
        now,
        canRefresh: true,
      }),
    ) === JSON.stringify({ action: "refresh", health: "expiring" }),
  );
  check(
    "tanpa konfigurasi → warn",
    threadsTokenLifecycleDecision({
      tokenType: "threads_user_token",
      tokenExpiresAt: soon,
      now,
      canRefresh: false,
    }).action === "warn",
  );
  check(
    "varian null (warisan) → warn walau konfigurasi lengkap",
    threadsTokenLifecycleDecision({
      tokenType: null,
      tokenExpiresAt: soon,
      now,
      canRefresh: true,
    }).action === "warn",
  );
  check(
    "sudah lewat jadwal → health expired",
    threadsTokenLifecycleDecision({
      tokenType: "threads_user_token",
      tokenExpiresAt: past,
      now,
      canRefresh: true,
    }).health === "expired",
  );
}

// ---------- (b) Bentuk panggilan klien di jahitan fetchImpl ----------
{
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = (async (
    input: string | URL,
    init?: { method?: string; body?: string },
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ?? null });
    if (url.includes("/refresh_access_token")) {
      return new Response(
        JSON.stringify({ access_token: "token-hasil-refresh", expires_in: 5_184_000 }),
        { status: 200 },
      );
    }
    if (url.includes("/oauth/access_token")) {
      return new Response(
        JSON.stringify({ access_token: "token-pendek", user_id: 777 }),
        { status: 200 },
      );
    }
    if (url.includes("/access_token?")) {
      return new Response(
        JSON.stringify({ access_token: "token-panjang", expires_in: 5_184_000 }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }),
      { status: 400 },
    );
  }) as typeof fetch;

  const client = new ThreadsGraphClient({
    baseUrl: "https://graph.threads.net",
    accessToken: "token-lama",
    fetchImpl,
  });
  const refreshed = await client.refreshThreadsToken();
  check("refresh → token baru + expires_in", refreshed.accessToken === "token-hasil-refresh" && refreshed.expiresInSeconds === 5_184_000);
  const refreshUrl = new URL(calls[0]!.url);
  check(
    "refresh memakai grant th_refresh_token + token sebagai query di /refresh_access_token",
    refreshUrl.pathname === "/refresh_access_token" &&
      refreshUrl.searchParams.get("grant_type") === "th_refresh_token" &&
      refreshUrl.searchParams.get("access_token") === "token-lama",
  );

  const anon = new ThreadsGraphClient({ baseUrl: "https://graph.threads.net", fetchImpl });
  const short = await anon.exchangeThreadsCode({
    clientId: "app-uji",
    clientSecret: "secret-uji",
    code: "kode-uji",
    redirectUri: "https://app.test/api/threads/oauth/callback",
  });
  check("exchange code → token pendek + user_id terkonversi string", short.accessToken === "token-pendek" && short.userId === "777");
  const form = new URLSearchParams(calls[1]!.body ?? "");
  check(
    "exchange code = POST form authorization_code lengkap",
    calls[1]!.method === "POST" &&
      form.get("grant_type") === "authorization_code" &&
      form.get("client_id") === "app-uji" &&
      form.get("client_secret") === "secret-uji" &&
      form.get("code") === "kode-uji" &&
      form.get("redirect_uri") === "https://app.test/api/threads/oauth/callback",
  );
  const long = await anon.exchangeThreadsLongLivedToken({
    clientSecret: "secret-uji",
    shortLivedToken: "token-pendek",
  });
  check("exchange long-lived → token panjang", long.accessToken === "token-panjang");
  const exchangeUrl = new URL(calls[2]!.url);
  check(
    "exchange long-lived memakai grant th_exchange_token",
    exchangeUrl.pathname === "/access_token" &&
      exchangeUrl.searchParams.get("grant_type") === "th_exchange_token" &&
      exchangeUrl.searchParams.get("access_token") === "token-pendek",
  );

  const dead = new ThreadsGraphClient({
    baseUrl: "https://graph.threads.net",
    accessToken: "token-mati",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ error: { message: "Session has expired", code: 190 } }),
        { status: 400 },
      )) as typeof fetch,
  });
  let caught: unknown = null;
  try {
    await dead.refreshThreadsToken();
  } catch (err) {
    caught = err;
  }
  check(
    "penolakan 190 → ThreadsGraphError graphCode 190",
    caught instanceof ThreadsGraphError && caught.graphCode === 190,
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
const DAY = 24 * 3600 * 1000;
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant Uji', 'tenant-uji')`,
  [TENANT],
);

async function seedAccount(
  externalId: string,
  token: string,
  expiresInMs: number,
): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `INSERT INTO channel_accounts
       (tenant_id, provider, external_id, display_name, status,
        access_token_encrypted, token_type, token_expires_at, token_health)
     VALUES ($1, 'threads', $2, 'Akun Uji', 'connected', $3,
             'threads_user_token', $4, 'ok')
     RETURNING id`,
    [
      TENANT,
      externalId,
      encryptChannelSecret(CHANNEL_SECRET, token),
      new Date(Date.now() + expiresInMs),
    ],
  );
  return rows.rows[0]!.id;
}

const TOKEN_OK = "token-akan-direfresh";
const TOKEN_OK_BARU = "token-hasil-refresh-server";
const TOKEN_MATI = "token-sudah-mati";
const TOKEN_AMAN = "token-masih-lama";
const accOk = await seedAccount("th-ok", TOKEN_OK, 2 * DAY);
const accMati = await seedAccount("th-mati", TOKEN_MATI, 1 * DAY);
const accAman = await seedAccount("th-aman", TOKEN_AMAN, 30 * DAY);

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/refresh_access_token") {
    const token = url.searchParams.get("access_token");
    if (url.searchParams.get("grant_type") !== "th_refresh_token") {
      json(400, { error: { message: "bad grant", code: 100 } });
      return;
    }
    if (token === TOKEN_OK) {
      json(200, { access_token: TOKEN_OK_BARU, token_type: "bearer", expires_in: 5_184_000 });
      return;
    }
    json(400, { error: { message: "Session has expired", type: "OAuthException", code: 190 } });
    return;
  }
  json(404, { error: { message: "unmocked", code: 803 } });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeBase = `http://127.0.0.1:${(fake as Server & { address: () => { port: number } }).address().port}`;

const result = await runThreadsTokenLifecycle({
  db,
  channelTokenSecret: CHANNEL_SECRET,
  threadsApiBase: fakeBase,
});
check(
  "runner: terpindai 2 (yang jauh dari kedaluwarsa tidak ikut)",
  result.scanned === 2,
);
check("runner: refreshed 1", result.refreshed === 1);
check("runner: authErrored 1", result.authErrored === 1);
check("runner: failed 0", result.failed === 0);

const after = await client.query<{
  id: string;
  status: string;
  error_code: string | null;
  token_health: string | null;
  access_token_encrypted: string;
  token_refreshed_at: Date | null;
  token_expires_at: Date;
}>(
  `SELECT id, status, error_code, token_health, access_token_encrypted,
          token_refreshed_at, token_expires_at
     FROM channel_accounts WHERE provider = 'threads' ORDER BY external_id`,
);
const byId = new Map(after.rows.map((r) => [r.id, r]));
const ok = byId.get(accOk)!;
check(
  "akun ok: token tersimpan berputar ke token baru (terenkripsi)",
  decryptChannelSecret(CHANNEL_SECRET, ok.access_token_encrypted) === TOKEN_OK_BARU &&
    !ok.access_token_encrypted.includes(TOKEN_OK_BARU),
);
check(
  "akun ok: refreshed_at terisi, kesehatan ok, expiry mundur ±60 hari",
  ok.token_refreshed_at !== null &&
    ok.token_health === "ok" &&
    new Date(ok.token_expires_at).getTime() > Date.now() + 50 * DAY,
);
const mati = byId.get(accMati)!;
check(
  "akun mati: status error + threads_graph_190 + kesehatan expired",
  mati.status === "error" &&
    mati.error_code === "threads_graph_190" &&
    mati.token_health === "expired",
);
const aman = byId.get(accAman)!;
check(
  "akun aman: tidak tersentuh sama sekali",
  aman.status === "connected" &&
    decryptChannelSecret(CHANNEL_SECRET, aman.access_token_encrypted) === TOKEN_AMAN &&
    aman.token_refreshed_at === null,
);

fake.closeAllConnections();
fake.close();
await client.close();
console.log(`verify threads-token-lifecycle: SEMUA LULUS (${passes} PASS)`);
