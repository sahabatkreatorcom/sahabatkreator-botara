/**
 * Verifikasi putus koneksi Google PER LAYANAN (Fase Susulan S4)
 * — membuktikan DELETE /tenants/:tenantId/google/:service mencabut
 * SATU layanan tanpa menyentuh empat lainnya, di atas PGlite +
 * server Google tiruan (node:http lokal). Dijalankan di CI sebagai
 * bagian `verify:ci`.
 *
 * Yang dibuktikan:
 *   [1] putus youtube → baris koneksi youtube hilang; empat baris
 *       lain BYTE-IDENTIK; akun channel youtube turun ke
 *       'disconnected'; audit google.service_disconnected +
 *       channel.disconnected (via google_service_disconnect)
 *       tercatat; akun Business tidak tersentuh;
 *   [2] keamanan sasaran sesudah putus youtube: sasaran hilang dari
 *       listPostTargets, pembuatan postingan baru ditolak
 *       POST_TARGET_NOT_CONNECTED, akses publish youtube menjawab
 *       not_connected (adapter worker memetakannya ke
 *       youtube_not_connected — cakupan verify:youtube-post);
 *   [3] kejujuran + gerbang: putus ulang layanan yang sama → 422
 *       GOOGLE_NOT_CONNECTED; layanan asing → 404; member biasa →
 *       403; pengguna tenant lain → 404 TENANT_NOT_FOUND;
 *   [4] putus business → SEMUA akun lokasi google_business turun ke
 *       'disconnected', koneksi lain tetap identik;
 *   [5] putus ads → baris OAuth ads hilang, tetapi konfigurasi
 *       ad_connections (customer ID + aksi konversi) UTUH dan view
 *       melaporkan akun ads tidak terhubung dengan ID tetap terbaca;
 *   [6] putus sheets + calendar menuntaskan kelima layanan; putus
 *       calendar ulang → 422;
 *   [7] isolasi tenant: koneksi tenant B tidak berubah oleh seluruh
 *       putus tenant A;
 *   [8] hubungkan ulang youtube lewat OAuth menghidupkan koneksi DAN
 *       akun channel yang sama kembali 'connected' (sasaran pulih).
 *
 * Token tiruan di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:google-disconnect
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
  createPost,
  getAdConnections,
  getValidGoogleServiceAccess,
  getYouTubePublishAccess,
  listPostTargets,
  saveGoogleServiceConnection,
  type GoogleService,
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
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES
     ($1, 'a@sk.test', 'Pemilik A'),
     ($2, 'member@sk.test', 'Member A'),
     ($3, 'b@sk.test', 'Pemilik B')`,
  [USER_A, USER_MEMBER, USER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
     ($1, $2, 'owner'), ($1, $3, 'agent'), ($4, $5, 'owner')`,
  [TENANT_A, USER_A, USER_MEMBER, TENANT_B, USER_B],
);

// ---------------------------------------------------------------------------
// Google tiruan — token/userinfo/kanal YouTube untuk uji hubung ulang
// ---------------------------------------------------------------------------
const G_ACCESS = "google-access-uji";
const YT_SCOPE =
  "openid email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && url.pathname === "/token") {
    req.on("data", () => undefined);
    req.on("end", () => {
      json(200, {
        access_token: G_ACCESS,
        refresh_token: "google-refresh-uji",
        expires_in: 3600,
        scope: YT_SCOPE,
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
  json(404, { error: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake as Server & { address: () => { port: number } })
  .address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ---------------------------------------------------------------------------
// Aplikasi uji: modul appointments + appUser dari header uji
// ---------------------------------------------------------------------------
const MASTER = randomBytes(32).toString("base64");
const TOKEN_SECRET = randomBytes(32).toString("base64");

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const id = c.req.header("x-test-user") ?? USER_A;
  c.set("appUser", { id } as unknown as AppVariables["appUser"]);
  await next();
});
app.route(
  "/",
  createAppointmentsRoutes({ db } as unknown as AuthBundle, {
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

const GOOGLE_DEPS = {
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
  bases: {
    apiBase: fakeBase,
    tokenBase: fakeBase,
    authBase: fakeBase,
  },
};

// ---------------------------------------------------------------------------
// Semai: LIMA koneksi Google tenant A + dua koneksi tenant B + akun
// channel turunan (youtube 1 kanal, business 2 lokasi) + konfigurasi
// ad_connections tenant A.
// ---------------------------------------------------------------------------
const SERVICE_SCOPES: Record<GoogleService, string> = {
  calendar:
    "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
  youtube: YT_SCOPE,
  business: "openid email https://www.googleapis.com/auth/business.manage",
  ads: "openid email https://www.googleapis.com/auth/adwords",
  sheets: "openid email https://www.googleapis.com/auth/spreadsheets",
};
for (const service of Object.keys(SERVICE_SCOPES) as GoogleService[]) {
  await saveGoogleServiceConnection(db, TENANT_A, service, {
    tokens: {
      accessToken: `akses-${service}-A`,
      refreshToken: `refresh-${service}-A`,
      expiresInSec: 3600,
      scope: SERVICE_SCOPES[service],
    },
    accountEmail: `pemilik-a-${service}@gmail.test`,
    tokenSecret: TOKEN_SECRET,
  });
}
for (const service of ["calendar", "youtube"] as GoogleService[]) {
  await saveGoogleServiceConnection(db, TENANT_B, service, {
    tokens: {
      accessToken: `akses-${service}-B`,
      refreshToken: `refresh-${service}-B`,
      expiresInSec: 3600,
      scope: SERVICE_SCOPES[service],
    },
    accountEmail: `pemilik-b-${service}@gmail.test`,
    tokenSecret: TOKEN_SECRET,
  });
}
await client.query(
  `INSERT INTO channel_accounts (tenant_id, provider, external_id, display_name, public_handle, status)
   VALUES ($1, 'youtube', 'UC-kanal-1', 'Kanal Kreator', '@kanalkreator', 'connected'),
          ($1, 'google_business', 'accounts/123/locations/456', 'Toko Kreator', NULL, 'connected'),
          ($1, 'google_business', 'accounts/123/locations/789', 'Cabang Kreator', NULL, 'connected')`,
  [TENANT_A],
);
await client.query(
  `INSERT INTO ad_connections (tenant_id, google_customer_id, google_conversion_action_id)
   VALUES ($1, '1234567890', '987654')`,
  [TENANT_A],
);

type ConnRow = Record<string, unknown>;
async function connRows(tenantId: string): Promise<ConnRow[]> {
  const rows = await client.query<ConnRow>(
    `SELECT id, tenant_id, service, account_email, calendar_id,
            access_token_encrypted, refresh_token_encrypted,
            token_expires_at, scopes, created_at, updated_at
       FROM google_connections WHERE tenant_id = $1 ORDER BY service`,
    [tenantId],
  );
  return rows.rows;
}
function byService(rows: ConnRow[]): Map<string, ConnRow> {
  return new Map(rows.map((r) => [String(r.service), r]));
}
async function channelStatus(
  tenantId: string,
  provider: string,
): Promise<Array<{ external_id: string; status: string }>> {
  const rows = await client.query<{ external_id: string; status: string }>(
    `SELECT external_id, status FROM channel_accounts
      WHERE tenant_id = $1 AND provider = $2 ORDER BY external_id`,
    [tenantId, provider],
  );
  return rows.rows;
}
async function auditCount(
  tenantId: string,
  action: string,
  metaKey?: string,
  metaValue?: string,
): Promise<number> {
  const rows = await client.query<{ n: number }>(
    metaKey
      ? `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND action = $2 AND meta->>$3 = $4`
      : `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND action = $2`,
    metaKey
      ? [tenantId, action, metaKey, metaValue]
      : [tenantId, action],
  );
  return rows.rows[0]!.n;
}
async function del(
  tenantId: string,
  service: string,
  user: string = USER_A,
): Promise<Response> {
  return app.request(`/tenants/${tenantId}/google/${service}`, {
    method: "DELETE",
    headers: { "x-test-user": user },
  });
}

const snapshotA = byService(await connRows(TENANT_A));
const snapshotB = byService(await connRows(TENANT_B));
assert.equal(snapshotA.size, 5);
assert.equal(snapshotB.size, 2);

// Materialisasi percakapan sasaran (pola malas listPostTargets) dan
// buktikan sasaran youtube + business tampil SEBELUM putus.
const targetsBefore = await listPostTargets(db, { tenantId: TENANT_A });
const youtubeTarget = targetsBefore.find((t) => t.provider === "youtube");
assert.ok(youtubeTarget, "sasaran youtube harus ada sebelum putus");
assert.ok(
  targetsBefore.some((t) => t.provider === "google_business"),
  "sasaran business harus ada sebelum putus",
);

// ---------- [1] Putus youtube: hanya youtube yang berubah ----------
{
  const res = await del(TENANT_A, "youtube");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    service: string;
    connected: boolean;
    accountEmail: string | null;
  };
  assert.deepEqual(body, {
    service: "youtube",
    connected: false,
    accountEmail: null,
    connectedAt: null,
  });

  const after = byService(await connRows(TENANT_A));
  assert.equal(after.has("youtube"), false);
  assert.equal(after.size, 4);
  for (const service of ["calendar", "business", "ads", "sheets"]) {
    assert.deepEqual(
      after.get(service),
      snapshotA.get(service),
      `baris ${service} tidak boleh berubah oleh putus youtube`,
    );
  }
  // Akun channel youtube turun; akun business utuh.
  assert.deepEqual(await channelStatus(TENANT_A, "youtube"), [
    { external_id: "UC-kanal-1", status: "disconnected" },
  ]);
  assert.ok(
    (await channelStatus(TENANT_A, "google_business")).every(
      (r) => r.status === "connected",
    ),
  );
  // Audit: layanan tercatat + pola channel.disconnected terpakai.
  assert.equal(
    await auditCount(TENANT_A, "google.service_disconnected", "service", "youtube"),
    1,
  );
  assert.equal(
    await auditCount(TENANT_A, "channel.disconnected", "via", "google_service_disconnect"),
    1,
  );
  // Status blok Channels ikut mencerminkan.
  const statusRes = await app.request(`/tenants/${TENANT_A}/google/status`);
  const statusBody = (await statusRes.json()) as {
    services: Array<{ service: string; connected: boolean }>;
  };
  assert.deepEqual(
    statusBody.services.map((s) => [s.service, s.connected]),
    [
      ["calendar", true],
      ["youtube", false],
      ["business", true],
      ["sheets", true],
    ],
  );
  console.log("[1] putus youtube → baris youtube hilang, 4 baris lain identik, kanal turun + audit tercatat: OK");
}

// ---------- [2] Sasaran youtube gagal aman sesudah putus ----------
{
  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  assert.equal(
    targets.some((t) => t.provider === "youtube"),
    false,
    "sasaran youtube harus hilang dari daftar sasaran",
  );
  assert.ok(targets.some((t) => t.provider === "google_business"));

  let code: string | null = null;
  try {
    await createPost(db, {
      tenantId: TENANT_A,
      userId: USER_A,
      conversationId: youtubeTarget!.conversationId,
      title: "Uji",
      caption: "halo",
      mediaIds: [],
    });
  } catch (err) {
    code = (err as { code?: string }).code ?? null;
  }
  assert.equal(code, "POST_TARGET_NOT_CONNECTED");

  // Jalur publish membaca keadaan yang sama: tanpa baris koneksi,
  // akses publish youtube menjawab not_connected (adapter worker
  // memetakannya ke kegagalan jujur youtube_not_connected).
  assert.equal(
    await getValidGoogleServiceAccess(db, TENANT_A, "youtube", GOOGLE_DEPS),
    null,
  );
  assert.deepEqual(
    await getYouTubePublishAccess(db, TENANT_A, GOOGLE_DEPS),
    { kind: "not_connected" },
  );
  console.log("[2] sasaran youtube gagal aman: daftar sasaran bersih, createPost POST_TARGET_NOT_CONNECTED, akses publish not_connected: OK");
}

// ---------- [3] Kejujuran putus ulang + gerbang peran/tenant ----------
{
  const again = await del(TENANT_A, "youtube");
  assert.equal(again.status, 422);
  assert.equal(
    ((await again.json()) as { error: { code: string } }).error.code,
    "GOOGLE_NOT_CONNECTED",
  );

  const unknown = await del(TENANT_A, "drive");
  assert.equal(unknown.status, 404);

  const member = await del(TENANT_A, "calendar", USER_MEMBER);
  assert.equal(member.status, 403);
  // Member gagal memutus: koneksi calendar tetap ada.
  assert.ok(byService(await connRows(TENANT_A)).has("calendar"));

  const foreign = await del(TENANT_A, "calendar", USER_B);
  assert.equal(foreign.status, 404);
  assert.equal(
    ((await foreign.json()) as { error: { code: string } }).error.code,
    "TENANT_NOT_FOUND",
  );
  // Gagal-gagal di atas tidak menulis audit putus baru.
  assert.equal(await auditCount(TENANT_A, "google.service_disconnected"), 1);
  console.log("[3] putus ulang 422 GOOGLE_NOT_CONNECTED, layanan asing 404, member 403, tenant asing 404: OK");
}

// ---------- [4] Putus business: semua lokasi turun ----------
{
  const res = await del(TENANT_A, "business");
  assert.equal(res.status, 200);
  assert.deepEqual(await channelStatus(TENANT_A, "google_business"), [
    { external_id: "accounts/123/locations/456", status: "disconnected" },
    { external_id: "accounts/123/locations/789", status: "disconnected" },
  ]);
  const after = byService(await connRows(TENANT_A));
  assert.equal(after.has("business"), false);
  for (const service of ["calendar", "ads", "sheets"]) {
    assert.deepEqual(after.get(service), snapshotA.get(service));
  }
  assert.equal(
    await auditCount(TENANT_A, "google.service_disconnected", "service", "business"),
    1,
  );
  // Dua lokasi = dua audit channel.disconnected tambahan.
  assert.equal(
    await auditCount(TENANT_A, "channel.disconnected", "via", "google_service_disconnect"),
    3,
  );
  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  assert.equal(targets.some((t) => t.provider === "google_business"), false);
  console.log("[4] putus business → 2 lokasi turun ke disconnected, koneksi lain identik: OK");
}

// ---------- [5] Putus ads: OAuth hilang, konfigurasi tenant utuh ----------
{
  const before = await getAdConnections(db, TENANT_A, {
    tokenSecret: TOKEN_SECRET,
    platform: { masterSecret: MASTER, env: {} },
  });
  assert.equal(before.google.adsAccountConnected, true);
  assert.equal(before.google.customerId, "1234567890");

  const res = await del(TENANT_A, "ads");
  assert.equal(res.status, 200);
  assert.equal(byService(await connRows(TENANT_A)).has("ads"), false);

  const after = await getAdConnections(db, TENANT_A, {
    tokenSecret: TOKEN_SECRET,
    platform: { masterSecret: MASTER, env: {} },
  });
  assert.equal(after.google.adsAccountConnected, false);
  assert.equal(after.google.adsAccountEmail, null);
  // ID tenant BUKAN hibah OAuth — tetap tersimpan untuk hubung ulang.
  assert.equal(after.google.customerId, "1234567890");
  assert.equal(after.google.conversionActionId, "987654");
  console.log("[5] putus ads → koneksi OAuth hilang, customer ID + aksi konversi utuh di ad_connections: OK");
}

// ---------- [6] Putus sheets + calendar: kelima layanan tuntas ----------
{
  assert.equal((await del(TENANT_A, "sheets")).status, 200);
  assert.equal((await del(TENANT_A, "calendar")).status, 200);
  assert.equal((await connRows(TENANT_A)).length, 0);
  const again = await del(TENANT_A, "calendar");
  assert.equal(again.status, 422);
  assert.equal(await auditCount(TENANT_A, "google.service_disconnected"), 5);
  console.log("[6] putus sheets + calendar → google_connections tenant A kosong; putus ulang 422; 5 audit layanan: OK");
}

// ---------- [7] Isolasi tenant B ----------
{
  const afterB = byService(await connRows(TENANT_B));
  assert.deepEqual(afterB.get("calendar"), snapshotB.get("calendar"));
  assert.deepEqual(afterB.get("youtube"), snapshotB.get("youtube"));
  assert.equal(await auditCount(TENANT_B, "google.service_disconnected"), 0);
  console.log("[7] isolasi tenant → koneksi tenant B byte-identik sesudah seluruh putus tenant A: OK");
}

// ---------- [8] Hubungkan ulang youtube: koneksi + kanal pulih ----------
{
  const start = await app.request(
    `/tenants/${TENANT_A}/google/youtube/connect`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": USER_A },
    },
  );
  assert.equal(start.status, 200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const callback = await app.request(
    `/oauth/youtube/callback?code=kode-youtube&state=${encodeURIComponent(state)}`,
  );
  assert.equal(callback.status, 302);

  const rows = byService(await connRows(TENANT_A));
  assert.ok(rows.has("youtube"), "koneksi youtube harus kembali");
  assert.deepEqual(await channelStatus(TENANT_A, "youtube"), [
    { external_id: "UC-kanal-1", status: "connected" },
  ]);
  const targets = await listPostTargets(db, { tenantId: TENANT_A });
  assert.ok(targets.some((t) => t.provider === "youtube"));
  console.log("[8] hubungkan ulang youtube → koneksi kembali, kanal yang sama 'connected' lagi, sasaran pulih: OK");
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify google-disconnect per layanan (PGlite + Google tiruan): SEMUA LULUS");
