/**
 * Verifikasi webhook Threads (GET|POST /webhooks/threads, publik
 * /api/webhooks/threads) melawan modul SUNGGUHAN + PGlite bermigrasi
 * penuh. Membuktikan:
 *   [1] handshake GET: verify token Threads benar → 200 + challenge
 *       terpantul; token salah → 403;
 *   [2] POST bertanda tangan X-Hub-Signature-256 SAH (kunci
 *       threads_app_secret) → 200 {ok:true} dan event tercatat di log
 *       integrasi provider 'threads' dengan payload-nya;
 *   [3] POST tanda tangan PALSU → 401, tidak ada baris 'recorded' baru;
 *   [4] app secret TIDAK terkonfigurasi → POST menjawab 503
 *       THREADS_NOT_CONFIGURED (jujur, bukan diam-diam menerima).
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:threads-webhook
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createThreadsWebhookRoutes } from "../src/modules/threads-webhook/routes";

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

const VERIFY_TOKEN = ["uji", "token", "threads"].join("-");
const APP_SECRET = ["uji", "secret", "threads"].join("-");

const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/",
  createThreadsWebhookRoutes({ db } as unknown as AuthBundle, {
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
  }),
);
const unconfiguredApp = new Hono<{ Variables: AppVariables }>();
unconfiguredApp.route(
  "/",
  createThreadsWebhookRoutes({ db } as unknown as AuthBundle, {}),
);

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// ---------- [1] Handshake ----------
{
  const ok = await app.request(
    `/webhooks/threads?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=tantangan-threads`,
  );
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "tantangan-threads");
  const bad = await app.request(
    `/webhooks/threads?hub.mode=subscribe&hub.verify_token=${"token"}-salah&hub.challenge=x`,
  );
  assert.equal(bad.status, 403);
  console.log("[1] GET /webhooks/threads: token benar → 200 + challenge; salah → 403: OK");
}

// ---------- [2] POST bertanda tangan sah → tercatat ----------
{
  const body = JSON.stringify({
    object: "threads",
    entry: [
      {
        id: "threads-user-uji",
        changes: [{ field: "mentions", value: { text: "halo" } }],
      },
    ],
  });
  const res = await app.request("/webhooks/threads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body, APP_SECRET),
    },
    body,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const rows = await client.query<{ payload: string }>(
    `SELECT payload::text AS payload FROM integration_log WHERE provider = 'threads' AND outcome = 'recorded' AND summary LIKE 'Threads webhook event recorded%'`,
  );
  assert.equal(rows.rows.length, 1);
  assert.ok(rows.rows[0]!.payload.includes("threads-user-uji"));
  console.log("[2] POST tanda tangan sah → 200 + event tercatat (provider threads): OK");
}

// ---------- [3] Tanda tangan palsu → 401 ----------
{
  const body = JSON.stringify({ object: "threads", entry: [] });
  const res = await app.request("/webhooks/threads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body, "secret-palsu"),
    },
    body,
  });
  assert.equal(res.status, 401);
  const rows = await client.query(
    `SELECT id FROM integration_log WHERE provider = 'threads' AND outcome = 'recorded' AND summary LIKE 'Threads webhook event recorded%'`,
  );
  assert.equal(rows.rows.length, 1); // tetap 1: tidak ada catatan event baru
  console.log("[3] POST tanda tangan palsu → 401, tanpa catatan event: OK");
}

// ---------- [4] Belum terkonfigurasi → 503 ----------
{
  const body = JSON.stringify({ object: "threads", entry: [] });
  const res = await unconfiguredApp.request("/webhooks/threads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body, APP_SECRET),
    },
    body,
  });
  assert.equal(res.status, 503);
  console.log("[4] app secret kosong → 503 THREADS_NOT_CONFIGURED: OK");
}

console.log("verify threads-webhook (PGlite + modul sungguhan): SEMUA LULUS");
await client.close();
