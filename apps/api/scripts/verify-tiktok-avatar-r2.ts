/**
 * Verifikasi avatar TikTok di Cloudflare R2 — di atas PGlite dengan
 * `fetch` global yang dicegat (S3/R2 tiruan dalam memori + CDN
 * TikTok tiruan). Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan keputusan pemilik 2026-11-12 (avatar TikTok disimpan
 * di R2, channel lain tetap bytea):
 *   [1] kredensial R2 BELUM terisi (keadaan produksi saat fitur ini
 *       lahir) → avatar TikTok jatuh ke bytea persis seperti channel
 *       lain, dan TIDAK ada satu pun request ke R2;
 *   [2] kredensial R2 terisi di Panel Admin → byte ditulis sebagai
 *       objek R2 (PUT bertanda tangan SigV4, kunci deterministik
 *       `avatars/tiktok/<akun>.webp`), baris profile_photos berbentuk
 *       'r2' (data NULL, object_key terisi, etag = SHA-256 byte), dan
 *       penyajian mengembalikan byte yang identik — lewat helper core
 *       DAN lewat rute HTTP avatars (200 + content-type + ETag,
 *       If-None-Match → 304 tanpa menyentuh R2 lagi);
 *   [3] PUT R2 ditolak (500) → fallback bytea: foto tetap tersimpan,
 *       connect tidak pernah tahu bedanya;
 *   [4] pemanggil non-TikTok (tanpa opsi r2) saat R2 terkonfigurasi →
 *       tetap bytea, nol request R2 baru — channel lain tidak
 *       terpengaruh sama sekali;
 *   [5] pengambilan ulang akun yang sama MENIMPA objek yang sama
 *       (kunci stabil) dan etag mengikuti byte terbaru.
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:tiktok-avatar-r2
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
import {
  R2_DEFAULT_ACCOUNT_ID,
  R2_DEFAULT_BUCKET,
  TIKTOK_AVATAR_R2_KEY_PREFIX,
  fetchAndStoreProfilePhotoFromUrl,
  fetchProfilePhotoBytes,
  getProfilePhoto,
  setPlatformSetting,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createAvatarsRoutes } from "../src/modules/avatars/routes";

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
const ACCOUNT_FALLBACK = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_R2 = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_PUT_FAIL = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_NON_TIKTOK = "66666666-6666-4666-8666-666666666666";
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
// Fetch tiruan: CDN TikTok + S3/R2 dalam memori
// ---------------------------------------------------------------------------

const R2_HOST = `${R2_DEFAULT_ACCOUNT_ID}.r2.cloudflarestorage.com`;
let avatarBytes = Buffer.from("webp-byte-uji-avatar-tiktok-v1");
const AVATAR_CONTENT_TYPE = "image/webp";

interface R2Request {
  method: string;
  path: string;
  authorization: string | null;
  payloadHash: string | null;
}
const r2Requests: R2Request[] = [];
const r2Objects = new Map<string, { data: Buffer; contentType: string | null }>();
let r2PutFails = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(raw);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );

  if (url.hostname === "cdn.tiktok.test") {
    return new Response(new Uint8Array(avatarBytes), {
      status: 200,
      headers: { "content-type": AVATAR_CONTENT_TYPE },
    });
  }

  if (url.hostname === R2_HOST) {
    const body =
      init?.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : Buffer.alloc(0);
    r2Requests.push({
      method,
      path: url.pathname,
      authorization: headers.get("authorization"),
      payloadHash: headers.get("x-amz-content-sha256"),
    });
    const key = decodeURIComponent(
      url.pathname.replace(`/${R2_DEFAULT_BUCKET}/`, ""),
    );
    if (method === "PUT") {
      if (r2PutFails) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>uji</Message></Error>`,
          { status: 500, headers: { "content-type": "application/xml" } },
        );
      }
      r2Objects.set(key, {
        data: body,
        contentType: headers.get("content-type"),
      });
      return new Response(null, { status: 200 });
    }
    if (method === "GET") {
      const object = r2Objects.get(key);
      if (!object) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>uji</Message></Error>`,
          { status: 404, headers: { "content-type": "application/xml" } },
        );
      }
      return new Response(new Uint8Array(object.data), {
        status: 200,
        headers: {
          "content-type": object.contentType ?? "application/octet-stream",
        },
      });
    }
    return new Response(null, { status: 405 });
  }

  throw new Error(`fetch tak tertebak di verify: ${method} ${raw}`);
}) as typeof fetch;

const MASTER = randomBytes(32).toString("base64");
const platformOpts: PlatformSettingsOptions = { masterSecret: MASTER, env: {} };
const R2_OPTION = {
  platformOptions: platformOpts,
  keyPrefix: TIKTOK_AVATAR_R2_KEY_PREFIX,
};
const PICTURE_URL = "https://cdn.tiktok.test/avatar.webp";
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

// ---------- [1] R2 belum terkonfigurasi → bytea, nol request R2 ----------
{
  const stored = await fetchAndStoreProfilePhotoFromUrl(db, {
    tenantId: TENANT_A,
    channelAccountId: ACCOUNT_FALLBACK,
    pictureUrl: PICTURE_URL,
    r2: R2_OPTION,
  });
  assert.equal(stored, true);
  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    ACCOUNT_FALLBACK,
  );
  assert.ok(photo);
  assert.equal(photo.storage, "db");
  assert.equal(photo.objectKey, null);
  assert.ok(photo.data && Buffer.from(photo.data).equals(avatarBytes));
  assert.equal(r2Requests.length, 0);
  console.log("[1] R2 belum terkonfigurasi → fallback bytea, nol request R2: LULUS");
}

// Kredensial R2 diisi lewat Panel Admin (pola produksi mengaktifkannya).
await setPlatformSetting(
  db,
  { key: "r2_access_key_id", value: "uji-access-key", updatedByUserId: USER_A },
  platformOpts,
);
await setPlatformSetting(
  db,
  { key: "r2_secret_access_key", value: "uji-secret-key", updatedByUserId: USER_A },
  platformOpts,
);

// ---------- [2] R2 terkonfigurasi → objek R2 + penyajian transparan ----------
{
  const stored = await fetchAndStoreProfilePhotoFromUrl(db, {
    tenantId: TENANT_A,
    channelAccountId: ACCOUNT_R2,
    pictureUrl: PICTURE_URL,
    r2: R2_OPTION,
  });
  assert.equal(stored, true);

  const expectedKey = `avatars/tiktok/${ACCOUNT_R2}.webp`;
  assert.equal(r2Requests.length, 1);
  const put = r2Requests[0]!;
  assert.equal(put.method, "PUT");
  assert.equal(put.path, `/${R2_DEFAULT_BUCKET}/${expectedKey}`);
  assert.ok(
    put.authorization?.startsWith(
      "AWS4-HMAC-SHA256 Credential=uji-access-key/",
    ),
    "PUT harus bertanda tangan SigV4 dengan kredensial panel",
  );
  assert.equal(put.payloadHash, sha256(avatarBytes));
  assert.ok(r2Objects.get(expectedKey)?.data.equals(avatarBytes));

  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    ACCOUNT_R2,
  );
  assert.ok(photo);
  assert.equal(photo.storage, "r2");
  assert.equal(photo.data, null);
  assert.equal(photo.objectKey, expectedKey);
  assert.equal(photo.contentType, AVATAR_CONTENT_TYPE);
  assert.equal(photo.etag, sha256(avatarBytes));

  const served = await fetchProfilePhotoBytes(db, photo, platformOpts);
  assert.ok(served && served.equals(avatarBytes));

  // Rute HTTP: byte + content-type + ETag sama; 304 tanpa GET R2 baru.
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("appUser", { id: USER_A } as unknown as AppVariables["appUser"]);
    await next();
  });
  app.route(
    "/",
    createAvatarsRoutes({ db } as unknown as AuthBundle, {
      platform: platformOpts,
    }),
  );
  const res = await app.request(
    `/tenants/${TENANT_A}/avatars/channels/${ACCOUNT_R2}`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), AVATAR_CONTENT_TYPE);
  assert.equal(res.headers.get("etag"), `"${sha256(avatarBytes)}"`);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(avatarBytes));

  const getsBefore = r2Requests.filter((r) => r.method === "GET").length;
  const res304 = await app.request(
    `/tenants/${TENANT_A}/avatars/channels/${ACCOUNT_R2}`,
    { headers: { "if-none-match": `"${sha256(avatarBytes)}"` } },
  );
  assert.equal(res304.status, 304);
  assert.equal(
    r2Requests.filter((r) => r.method === "GET").length,
    getsBefore,
    "If-None-Match yang cocok tidak boleh menyentuh R2",
  );

  // Akun bytea [1] tersaji sama transparannya lewat rute yang sama.
  const resDb = await app.request(
    `/tenants/${TENANT_A}/avatars/channels/${ACCOUNT_FALLBACK}`,
  );
  assert.equal(resDb.status, 200);
  assert.ok(Buffer.from(await resDb.arrayBuffer()).equals(avatarBytes));
  console.log("[2] R2 terkonfigurasi → objek R2 + penyajian transparan (helper & HTTP): LULUS");
}

// ---------- [3] PUT R2 gagal → fallback bytea ----------
{
  r2PutFails = true;
  const stored = await fetchAndStoreProfilePhotoFromUrl(db, {
    tenantId: TENANT_A,
    channelAccountId: ACCOUNT_PUT_FAIL,
    pictureUrl: PICTURE_URL,
    r2: R2_OPTION,
  });
  r2PutFails = false;
  assert.equal(stored, true);
  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    ACCOUNT_PUT_FAIL,
  );
  assert.ok(photo);
  assert.equal(photo.storage, "db");
  assert.ok(photo.data && Buffer.from(photo.data).equals(avatarBytes));
  console.log("[3] PUT R2 gagal → fallback bytea, foto tetap tersimpan: LULUS");
}

// ---------- [4] Tanpa opsi r2 (non-TikTok) → bytea, nol request R2 ----------
{
  const before = r2Requests.length;
  const stored = await fetchAndStoreProfilePhotoFromUrl(db, {
    tenantId: TENANT_A,
    channelAccountId: ACCOUNT_NON_TIKTOK,
    pictureUrl: PICTURE_URL,
  });
  assert.equal(stored, true);
  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    ACCOUNT_NON_TIKTOK,
  );
  assert.ok(photo);
  assert.equal(photo.storage, "db");
  assert.equal(r2Requests.length, before);
  console.log("[4] pemanggil non-TikTok tidak terpengaruh R2: LULUS");
}

// ---------- [5] Ambil ulang → objek sama ditimpa, etag mengikuti byte ----------
{
  avatarBytes = Buffer.from("webp-byte-uji-avatar-tiktok-v2-berubah");
  const putsBefore = r2Requests.filter((r) => r.method === "PUT").length;
  const stored = await fetchAndStoreProfilePhotoFromUrl(db, {
    tenantId: TENANT_A,
    channelAccountId: ACCOUNT_R2,
    pictureUrl: PICTURE_URL,
    r2: R2_OPTION,
  });
  assert.equal(stored, true);
  const expectedKey = `avatars/tiktok/${ACCOUNT_R2}.webp`;
  assert.equal(r2Requests.filter((r) => r.method === "PUT").length, putsBefore + 1);
  assert.ok(r2Objects.get(expectedKey)?.data.equals(avatarBytes));
  const photo = await getProfilePhoto(
    db,
    { tenantId: TENANT_A },
    "channel_account",
    ACCOUNT_R2,
  );
  assert.ok(photo);
  assert.equal(photo.objectKey, expectedKey);
  assert.equal(photo.etag, sha256(avatarBytes));
  const served = await fetchProfilePhotoBytes(db, photo, platformOpts);
  assert.ok(served && served.equals(avatarBytes));
  console.log("[5] ambil ulang menimpa objek yang sama, etag terbaru: LULUS");
}

globalThis.fetch = realFetch;
console.log("verify tiktok-avatar-r2: SEMUA LULUS");
