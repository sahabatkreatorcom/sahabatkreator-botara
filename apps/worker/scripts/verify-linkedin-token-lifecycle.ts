/**
 * Verifikasi lifecycle token LinkedIn (gelombang Semua OAuth) —
 * lifecycle TANDAI-RECONNECT (LinkedIn tidak menerbitkan refresh
 * token untuk program standar):
 *
 *  (a) keputusan murni (linkedinTokenLifecycleDecision): SELALU
 *      "warn" — tidak ada varian refresh; kesehatan expiring vs
 *      expired mengikuti jadwal.
 *  (b) klien OAuth di jahitan fetchImpl: exchange code = POST form
 *      ke /oauth/v2/accessToken (host OAuth terpisah dari host API),
 *      userinfo OIDC terbaca (sub/name/picture), penolakan provider
 *      → LinkedInApiError berisi error_description resmi.
 *  (c) runner end-to-end di atas PGlite: akun mendekati kedaluwarsa
 *      ditandai 'expiring' dan TETAP connected; akun yang sudah
 *      lewat jadwal menjadi status 'error' + linkedin_token_expired
 *      + kesehatan 'expired'; akun yang masih jauh TIDAK tersentuh;
 *      token tersimpan TIDAK berubah di semua kasus (tidak ada
 *      refresh yang berpura-pura).
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:linkedin-token-lifecycle
 */
import assert from "node:assert/strict";
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
  LinkedInApiError,
  LinkedInClient,
} from "@sahabat-kreator/channel-linkedin";
import {
  decryptChannelSecret,
  encryptChannelSecret,
  linkedinTokenLifecycleDecision,
} from "@sahabat-kreator/core";
import { runLinkedInTokenLifecycle } from "../src/linkedin-token-lifecycle";

let passes = 0;
function check(name: string, ok: boolean): void {
  assert.ok(ok, name);
  passes += 1;
  console.log(`PASS  ${name}`);
}

// ---------- (a) Keputusan murni: selalu warn ----------
{
  const now = new Date("2026-11-12T00:00:00Z");
  const soon = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
  const past = new Date(now.getTime() - 3600 * 1000);
  check(
    "mendekati kedaluwarsa → warn/expiring (tidak ada aksi refresh)",
    JSON.stringify(
      linkedinTokenLifecycleDecision({
        tokenType: "linkedin_user_token",
        tokenExpiresAt: soon,
        now,
      }),
    ) === JSON.stringify({ action: "warn", health: "expiring" }),
  );
  check(
    "sudah lewat jadwal → warn/expired",
    JSON.stringify(
      linkedinTokenLifecycleDecision({
        tokenType: "linkedin_user_token",
        tokenExpiresAt: past,
        now,
      }),
    ) === JSON.stringify({ action: "warn", health: "expired" }),
  );
  check(
    "varian token null pun tetap warn (tidak ada jalur refresh)",
    linkedinTokenLifecycleDecision({
      tokenType: null,
      tokenExpiresAt: soon,
      now,
    }).action === "warn",
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
    if (url.includes("/oauth/v2/accessToken")) {
      const form = new URLSearchParams(init?.body ?? "");
      if (form.get("code") === "kode-mati") {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "authorization code tidak berlaku" }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ access_token: "akses-linkedin", expires_in: 5184000 }),
        { status: 200 },
      );
    }
    if (url.includes("/v2/userinfo")) {
      return new Response(
        JSON.stringify({
          sub: "member-1",
          name: "Kreator LinkedIn",
          picture: "https://cdn.test/li.jpg",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ message: "unmocked" }), { status: 404 });
  }) as typeof fetch;

  const client = new LinkedInClient({
    baseUrl: "https://api.linkedin.com",
    oauthBaseUrl: "https://www.linkedin.com",
    fetchImpl,
  });
  const exchanged = await client.exchangeLinkedInCode({
    clientId: "id-uji",
    clientSecret: "secret-uji",
    code: "kode-uji",
    redirectUri: "https://app.test/api/oauth/linkedin/callback",
  });
  check(
    "exchange code → token + expires_in ±60 hari",
    exchanged.accessToken === "akses-linkedin" && exchanged.expiresInSeconds === 5184000,
  );
  const form = new URLSearchParams(calls[0]!.body ?? "");
  check(
    "exchange = POST form authorization_code ke host www /oauth/v2/accessToken",
    calls[0]!.method === "POST" &&
      calls[0]!.url === "https://www.linkedin.com/oauth/v2/accessToken" &&
      form.get("grant_type") === "authorization_code" &&
      form.get("client_id") === "id-uji" &&
      form.get("client_secret") === "secret-uji" &&
      form.get("code") === "kode-uji" &&
      form.get("redirect_uri") === "https://app.test/api/oauth/linkedin/callback",
  );
  const info = await client.getLinkedInUserInfo("akses-linkedin");
  check(
    "userinfo OIDC → sub/name/picture terbaca dari host API + Bearer",
    info.sub === "member-1" &&
      info.name === "Kreator LinkedIn" &&
      info.pictureUrl === "https://cdn.test/li.jpg" &&
      calls[1]!.url === "https://api.linkedin.com/v2/userinfo" &&
      calls[1]!.auth === "Bearer akses-linkedin",
  );
  let caught: unknown = null;
  try {
    await client.exchangeLinkedInCode({
      clientId: "id-uji",
      clientSecret: "secret-uji",
      code: "kode-mati",
      redirectUri: "https://app.test/api/oauth/linkedin/callback",
    });
  } catch (err) {
    caught = err;
  }
  check(
    "penolakan exchange → LinkedInApiError 400 berisi error_description",
    caught instanceof LinkedInApiError &&
      caught.status === 400 &&
      caught.description.includes("tidak berlaku"),
  );
}

// ---------- (c) Runner end-to-end: PGlite ----------
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
     VALUES ($1, 'linkedin', $2, 'Akun Uji', 'connected', $3,
             'linkedin_user_token', $4, 'ok')
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

const TOKEN_WARN = "token-mendekati-mati";
const TOKEN_LEWAT = "token-sudah-lewat";
const TOKEN_AMAN = "token-masih-lama";
const accWarn = await seedAccount("li-warn", TOKEN_WARN, 3 * DAY);
const accLewat = await seedAccount("li-lewat", TOKEN_LEWAT, -1 * DAY);
const accAman = await seedAccount("li-aman", TOKEN_AMAN, 45 * DAY);

const result = await runLinkedInTokenLifecycle({ db });
check("runner: terpindai 2 (yang jauh dari kedaluwarsa tidak ikut)", result.scanned === 2);
check("runner: warned 1", result.warned === 1);
check("runner: authErrored 1", result.authErrored === 1);
check("runner: failed 0", result.failed === 0);

const after = await client.query<{
  id: string;
  status: string;
  error_code: string | null;
  token_health: string | null;
  access_token_encrypted: string;
}>(
  `SELECT id, status, error_code, token_health, access_token_encrypted
     FROM channel_accounts WHERE provider = 'linkedin'`,
);
const byId = new Map(after.rows.map((r) => [r.id, r]));
const warn = byId.get(accWarn)!;
check(
  "akun mendekati: tetap connected + kesehatan expiring + token TIDAK berubah",
  warn.status === "connected" &&
    warn.token_health === "expiring" &&
    decryptChannelSecret(CHANNEL_SECRET, warn.access_token_encrypted) === TOKEN_WARN,
);
const lewat = byId.get(accLewat)!;
check(
  "akun lewat jadwal: status error + linkedin_token_expired + kesehatan expired",
  lewat.status === "error" &&
    lewat.error_code === "linkedin_token_expired" &&
    lewat.token_health === "expired",
);
const aman = byId.get(accAman)!;
check(
  "akun aman: tidak tersentuh sama sekali",
  aman.status === "connected" &&
    aman.token_health === "ok" &&
    decryptChannelSecret(CHANNEL_SECRET, aman.access_token_encrypted) === TOKEN_AMAN,
);

await client.close();
console.log(`verify linkedin-token-lifecycle: SEMUA LULUS (${passes} PASS)`);
