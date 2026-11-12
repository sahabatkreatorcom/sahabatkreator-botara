/**
 * Verifikasi webhook TikTok (POST /webhooks/tiktok, publik
 * /api/webhooks/tiktok) melawan modul SUNGGUHAN + PGlite bermigrasi
 * penuh. Membuktikan:
 *   [1] `authorization.removed` bertanda tangan SAH → 200 dan akun
 *       TikTok (dicocokkan via user_openid) menjadi 'disconnected'
 *       + error_code 'tiktok_authorization_removed', tercatat di log
 *       integrasi dengan channel_account_id yang benar;
 *   [2] pengiriman ULANG event yang sama → 200, tetap disconnected
 *       (idempoten terhadap retry at-least-once TikTok);
 *   [3] `video.publish.completed` → 200, state akun TIDAK berubah,
 *       event tercatat (polling publisher tetap sumber kebenaran);
 *   [4] event tak dikenal → 200 + tercatat sebagai diabaikan;
 *   [5] tanda tangan PALSU untuk authorization.removed akun lain →
 *       401 dan akun itu TIDAK terputus;
 *   [6] cap waktu basi (>5 menit) walau HMAC benar → 401;
 *   [7] header TikTok-Signature hilang → 401.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:tiktok-webhook
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
import { createTikTokWebhookRoutes } from "../src/modules/tiktok-webhook/routes";

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

const CLIENT_SECRET = "tiktok-secret-uji";
const TENANT = "11111111-1111-4111-8111-111111111111";
const OPEN_ID_A = "open-id-uji-a";
const OPEN_ID_B = "open-id-uji-b";

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant Uji', 'tenant-uji')`,
  [TENANT],
);
async function seedAccount(openId: string): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, provider, external_id, display_name, status)
     VALUES ($1, 'tiktok', $2, 'Akun Uji', 'connected') RETURNING id`,
    [TENANT, openId],
  );
  return rows.rows[0]!.id;
}
const accountA = await seedAccount(OPEN_ID_A);
const accountB = await seedAccount(OPEN_ID_B);

const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/",
  createTikTokWebhookRoutes({ db } as unknown as AuthBundle, {
    clientSecret: CLIENT_SECRET,
  }),
);

function signatureHeader(body: string, secret: string, ts: number): string {
  const signature = createHmac("sha256", secret)
    .update(`${ts}.${body}`, "utf8")
    .digest("hex");
  return `t=${ts},s=${signature}`;
}

async function postWebhook(
  body: string,
  header: string | undefined,
): Promise<Response> {
  return app.request("/webhooks/tiktok", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(header ? { "tiktok-signature": header } : {}),
    },
    body,
  });
}

function eventBody(event: string, openId: string): string {
  return JSON.stringify({
    event,
    client_key: "client-key-uji",
    create_time: Math.floor(Date.now() / 1000),
    user_openid: openId,
    content: JSON.stringify({ reason: 0 }),
  });
}

async function accountState(id: string) {
  const rows = await client.query<{ status: string; error_code: string | null }>(
    `SELECT status, error_code FROM channel_accounts WHERE id = $1`,
    [id],
  );
  return rows.rows[0]!;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------- [1] authorization.removed sah → akun terputus ----------
{
  const body = eventBody("authorization.removed", OPEN_ID_A);
  const res = await postWebhook(body, signatureHeader(body, CLIENT_SECRET, nowSeconds()));
  assert.equal(res.status, 200);
  const state = await accountState(accountA);
  assert.equal(state.status, "disconnected");
  assert.equal(state.error_code, "tiktok_authorization_removed");
  const logs = await client.query(
    `SELECT id FROM integration_log WHERE channel_account_id = $1 AND outcome = 'recorded'`,
    [accountA],
  );
  assert.equal(logs.rows.length, 1);
  console.log("[1] authorization.removed sah → 200 + akun disconnected + tercatat: OK");
}

// ---------- [2] Pengiriman ulang idempoten ----------
{
  const body = eventBody("authorization.removed", OPEN_ID_A);
  const res = await postWebhook(body, signatureHeader(body, CLIENT_SECRET, nowSeconds()));
  assert.equal(res.status, 200);
  const state = await accountState(accountA);
  assert.equal(state.status, "disconnected");
  console.log("[2] authorization.removed diulang → 200, tetap disconnected: OK");
}

// ---------- [3] video.publish.completed: catat saja ----------
{
  const body = eventBody("video.publish.completed", OPEN_ID_B);
  const res = await postWebhook(body, signatureHeader(body, CLIENT_SECRET, nowSeconds()));
  assert.equal(res.status, 200);
  const state = await accountState(accountB);
  assert.equal(state.status, "connected");
  const logs = await client.query(
    `SELECT id FROM integration_log WHERE summary LIKE 'TikTok webhook event recorded%'`,
  );
  assert.equal(logs.rows.length, 1);
  console.log("[3] video.publish.completed → 200, state utuh, tercatat: OK");
}

// ---------- [4] Event tak dikenal diterima + dicatat ----------
{
  const body = eventBody("some.future.event", OPEN_ID_B);
  const res = await postWebhook(body, signatureHeader(body, CLIENT_SECRET, nowSeconds()));
  assert.equal(res.status, 200);
  const logs = await client.query(
    `SELECT id FROM integration_log WHERE summary LIKE 'TikTok webhook event received and ignored%'`,
  );
  assert.equal(logs.rows.length, 1);
  console.log("[4] event tak dikenal → 200 + dicatat diabaikan: OK");
}

// ---------- [5] Tanda tangan palsu → 401, tanpa efek ----------
{
  const body = eventBody("authorization.removed", OPEN_ID_B);
  const res = await postWebhook(body, signatureHeader(body, "secret-palsu", nowSeconds()));
  assert.equal(res.status, 401);
  const state = await accountState(accountB);
  assert.equal(state.status, "connected");
  console.log("[5] tanda tangan palsu → 401, akun lain tidak terputus: OK");
}

// ---------- [6] Cap waktu basi → 401 ----------
{
  const body = eventBody("authorization.removed", OPEN_ID_B);
  const res = await postWebhook(
    body,
    signatureHeader(body, CLIENT_SECRET, nowSeconds() - 3600),
  );
  assert.equal(res.status, 401);
  const state = await accountState(accountB);
  assert.equal(state.status, "connected");
  const logs = await client.query(
    `SELECT id FROM integration_log WHERE error_code = 'stale_timestamp'`,
  );
  assert.equal(logs.rows.length, 1);
  console.log("[6] cap waktu basi → 401 (stale_timestamp): OK");
}

// ---------- [7] Header hilang → 401 ----------
{
  const body = eventBody("authorization.removed", OPEN_ID_B);
  const res = await postWebhook(body, undefined);
  assert.equal(res.status, 401);
  console.log("[7] tanpa header TikTok-Signature → 401: OK");
}

console.log("verify tiktok-webhook (PGlite + modul sungguhan): SEMUA LULUS");
await client.close();
