/**
 * Verifikasi webhook Meta & WhatsApp — di atas PGlite (migrasi penuh)
 * + modul meta sungguhan dengan kredensial statis uji. Dijalankan di
 * CI sebagai bagian `verify:ci`.
 *
 * Membuktikan penyeragaman URL webhook (2026-11-12, TANPA alias):
 *   [1] GET /webhooks/meta handshake: verify token benar → 200 +
 *       challenge terpantul; token salah → 403;
 *   [2] GET /webhooks/whatsapp handshake yang sama (path kanonis per
 *       peruntukan — handler yang sama persis);
 *   [3] POST /webhooks/meta bertanda tangan sah → 200 {ok:true};
 *   [4] POST /webhooks/whatsapp bertanda tangan sah → 200 {ok:true};
 *   [5] POST tanda tangan palsu → 401 di kedua path, dan baris log
 *       gerbangnya memakai provider sesuai path ('meta'/'whatsapp');
 *   [6] path lama /meta/webhook → 404 (GET & POST): tidak terdaftar
 *       lagi, tidak ada alias/fallback.
 *
 * Kredensial di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:meta-webhook
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
import { createMetaRoutes } from "../src/modules/meta/routes";

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

const VERIFY_TOKEN = "verify-token-uji";
const APP_SECRET = "app-secret-uji";

const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/",
  createMetaRoutes({ db } as unknown as AuthBundle, null, {
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    graphApiVersion: "v26.0",
  }),
);

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

async function handshake(pathname: string, token: string) {
  return app.request(
    `${pathname}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=tantangan-123`,
  );
}

// ---------- [1] Handshake /webhooks/meta ----------
{
  const ok = await handshake("/webhooks/meta", VERIFY_TOKEN);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "tantangan-123");
  const bad = await handshake("/webhooks/meta", "token-salah");
  assert.equal(bad.status, 403);
  console.log("[1] GET /webhooks/meta: token benar → 200 + challenge; salah → 403: OK");
}

// ---------- [2] Handshake /webhooks/whatsapp ----------
{
  const ok = await handshake("/webhooks/whatsapp", VERIFY_TOKEN);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "tantangan-123");
  const bad = await handshake("/webhooks/whatsapp", "token-salah");
  assert.equal(bad.status, 403);
  console.log("[2] GET /webhooks/whatsapp: handshake sama persis: OK");
}

// ---------- [3] POST /webhooks/meta bertanda tangan sah ----------
{
  const body = JSON.stringify({ object: "page", entry: [] });
  const res = await app.request("/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  console.log("[3] POST /webhooks/meta tanda tangan sah → 200 {ok:true}: OK");
}

// ---------- [4] POST /webhooks/whatsapp bertanda tangan sah ----------
{
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const res = await app.request("/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  console.log("[4] POST /webhooks/whatsapp tanda tangan sah → 200 {ok:true}: OK");
}

// ---------- [5] Tanda tangan palsu → 401 + provider log sesuai path ----------
{
  const body = JSON.stringify({ object: "page", entry: [] });
  for (const pathname of ["/webhooks/meta", "/webhooks/whatsapp"] as const) {
    const res = await app.request(pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body,
    });
    assert.equal(res.status, 401);
  }
  const rows = await client.query<{ provider: string; outcome: string }>(
    `SELECT provider, outcome FROM integration_log WHERE outcome = 'rejected_signature' ORDER BY provider`,
  );
  const providers = rows.rows.map((r) => r.provider);
  assert.ok(providers.includes("meta"), "log gerbang /webhooks/meta berprovider 'meta'");
  assert.ok(providers.includes("whatsapp"), "log gerbang /webhooks/whatsapp berprovider 'whatsapp'");
  console.log("[5] tanda tangan palsu → 401; provider log gerbang sesuai path: OK");
}

// ---------- [6] Path lama tidak terdaftar ----------
{
  const get = await handshake("/meta/webhook", VERIFY_TOKEN);
  assert.equal(get.status, 404);
  const body = JSON.stringify({ object: "page", entry: [] });
  const post = await app.request("/meta/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  });
  assert.equal(post.status, 404);
  console.log("[6] /meta/webhook (GET & POST) → 404 (tanpa alias): OK");
}

await client.close();
console.log("verify meta-webhook (PGlite + modul meta sungguhan): SEMUA LULUS");
