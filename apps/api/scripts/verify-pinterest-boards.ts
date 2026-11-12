/**
 * Verifikasi pemilih board Pinterest — di atas PGlite + server
 * Pinterest API v5 tiruan (node:http lokal). Dijalankan di CI
 * sebagai bagian `verify:ci`.
 *
 * Membuktikan endpoint board pada modul channels (owner/admin)
 * melawan permukaan resmi API v5 (GET /v5/boards berpaginasi
 * bookmark; POST /v5/boards):
 *   [1] GET daftar → board dari SEMUA halaman + pilihan kosong;
 *   [2] PUT pilihan sah → tersimpan di kolom akun (+ snapshot nama)
 *       dan terbaca kembali — termasuk lewat getPinterestBoardChoice
 *       yang dibaca penerbit;
 *   [3] PUT board asing → 422 PINTEREST_BOARD_NOT_FOUND, pilihan
 *       lama tidak berubah;
 *   [4] PUT null → pilihan dibersihkan (kembali ke board pertama);
 *   [5] POST buat board → badan permintaan persis bentuk API v5
 *       (name + description + privacy PROTECTED), board baru
 *       otomatis menjadi pilihan dan muncul di daftar;
 *   [6] penjaga: peran member → 403; akun provider lain → 404;
 *       akun Pinterest terputus → 422; akun tenant lain → 404;
 *   [7] provider menolak daftar board → 502
 *       PINTEREST_BOARDS_UNAVAILABLE;
 *   [8] board pada OPSI POSTINGAN (gelombang Pilihan Privasi & AI):
 *       route posts memvalidasi board opsi dengan pola yang sama —
 *       board asing pada create/group/update → 422 yang sama; board
 *       milik akun → tersimpan sebagai publishOptions postingan;
 *       buat board dari formulir post memakai endpoint POST boards
 *       Channels di [5] (tidak ada jalur API kedua). Resolusi
 *       penerbit berlapis (postingan → akun → board pertama)
 *       dibuktikan di lapisnya masing-masing: opsi tersimpan di
 *       core (posts.test), jembatan bawaan akun di [2], dan
 *       `resolvePinBoard` di verify:pinterest-post.
 *
 * Token tiruan di skrip ini BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:pinterest-boards
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
  createPinterestChannelAccount,
  encryptChannelSecret,
  getPinterestBoardChoice,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createChannelsRoutes } from "../src/modules/channels/routes";
import { createPostsRoutes } from "../src/modules/posts/routes";

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
const USER_MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A'), ($2, 'm@sk.test', 'Member A'), ($3, 'b@sk.test', 'Pemilik B')`,
  [USER_A, USER_MEMBER, USER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent'), ($4, $5, 'owner')`,
  [TENANT_A, USER_A, USER_MEMBER, TENANT_B, USER_B],
);

// ---------------------------------------------------------------------------
// Pinterest API v5 tiruan: boards berpaginasi + buat board
// ---------------------------------------------------------------------------
const ACCESS = "pin-access-boards-uji";
interface FakeBoard {
  id: string;
  name: string;
}
const fakeBoards: FakeBoard[] = [
  { id: "board-1", name: "Produk" },
  { id: "board-2", name: "Inspirasi" },
  { id: "board-3", name: "Promo" },
];
let boardsDown = false;
let lastCreateBody: Record<string, unknown> | null = null;
let lastBoardsAuth: string | null = null;

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/v5/boards" && req.method === "GET") {
    lastBoardsAuth = req.headers.authorization ?? null;
    if (req.headers.authorization !== `Bearer ${ACCESS}`) {
      json(401, { code: 3, message: "Invalid access token" });
      return;
    }
    if (boardsDown) {
      json(500, { code: 1, message: "Pinterest sedang gangguan" });
      return;
    }
    // Paginasi bookmark tiruan: halaman 1 = 2 board pertama +
    // bookmark; halaman 2 = sisanya.
    if (url.searchParams.get("bookmark")) {
      json(200, { items: fakeBoards.slice(2) });
      return;
    }
    json(200, {
      items: fakeBoards.slice(0, 2),
      ...(fakeBoards.length > 2 ? { bookmark: "hal-2" } : {}),
    });
    return;
  }
  if (url.pathname === "/v5/boards" && req.method === "POST") {
    if (req.headers.authorization !== `Bearer ${ACCESS}`) {
      json(401, { code: 3, message: "Invalid access token" });
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      lastCreateBody = JSON.parse(raw) as Record<string, unknown>;
      const created: FakeBoard = {
        id: "board-baru",
        name: String(lastCreateBody?.name ?? ""),
      };
      fakeBoards.push(created);
      json(201, created);
    });
    return;
  }
  json(404, { code: 404, message: "unmocked" });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake as Server & { address: () => { port: number } }).address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

// ---------------------------------------------------------------------------
// Fixture akun: Pinterest terhubung (tenant A), Pinterest terputus
// (tenant A), Telegram (tenant A — akun provider lain)
// ---------------------------------------------------------------------------
const CHANNEL_SECRET = randomBytes(32).toString("base64");
const account = await createPinterestChannelAccount(
  db,
  { tenantId: TENANT_A, userId: USER_A },
  {
    accountExternalId: "pin-user-boards",
    publicHandle: "kreatorpin",
    encryptedAccessToken: encryptChannelSecret(CHANNEL_SECRET, ACCESS),
    encryptedRefreshToken: encryptChannelSecret(CHANNEL_SECRET, "pin-refresh-boards-uji"),
    tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  },
);
const disconnected = await createPinterestChannelAccount(
  db,
  { tenantId: TENANT_A, userId: USER_A },
  {
    accountExternalId: "pin-user-putus",
    publicHandle: "kreatorputus",
    encryptedAccessToken: encryptChannelSecret(CHANNEL_SECRET, ACCESS),
    encryptedRefreshToken: null,
    tokenExpiresAt: null,
  },
);
await client.query(
  `UPDATE channel_accounts SET status = 'disconnected', access_token_encrypted = NULL WHERE id = $1`,
  [disconnected.id],
);
const telegramInsert = await client.query<{ id: string }>(
  `INSERT INTO channel_accounts (tenant_id, provider, external_id, display_name, status)
   VALUES ($1, 'telegram', '123456', 'Bot Uji', 'connected') RETURNING id`,
  [TENANT_A],
);
const telegramId = telegramInsert.rows[0]!.id;

// ---------------------------------------------------------------------------
// Aplikasi uji: modul channels sungguhan + appUser dari header uji
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? USER_A;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
app.route(
  "/",
  createChannelsRoutes({ db } as unknown as AuthBundle, {
    channelTokenSecret: CHANNEL_SECRET,
    pinterestApiBase: fakeBase,
  }),
);
// Modul posts dipasang sejak awal (Hono menolak route yang ditambah
// sesudah aplikasi melayani request) — dipakai bagian [8] untuk
// validasi board pada opsi postingan, dengan opsi produksi yang sama.
app.route(
  "/",
  createPostsRoutes({ db } as unknown as AuthBundle, {
    channelTokenSecret: CHANNEL_SECRET,
    pinterestApiBase: fakeBase,
  }),
);

const boardsUrl = (tenantId: string, channelId: string) =>
  `/tenants/${tenantId}/channels/${channelId}/pinterest-boards`;
const boardUrl = (tenantId: string, channelId: string) =>
  `/tenants/${tenantId}/channels/${channelId}/pinterest-board`;

interface BoardsBody {
  boards: Array<{ id: string; name: string | null }>;
  selectedBoardId: string | null;
  selectedBoardName: string | null;
  createdBoard?: { id: string; name: string | null };
}
async function callBoards(
  method: string,
  url: string,
  userId: string,
  body?: unknown,
): Promise<{ status: number; body: BoardsBody & { error?: { code: string } } }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": userId,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    body: (await res.json()) as BoardsBody & { error?: { code: string } },
  };
}
async function storedChoice(channelId: string) {
  const rows = await client.query<{
    pinterest_board_id: string | null;
    pinterest_board_name: string | null;
  }>(
    `SELECT pinterest_board_id, pinterest_board_name FROM channel_accounts WHERE id = $1`,
    [channelId],
  );
  return rows.rows[0]!;
}

// ---------- [1] GET daftar: semua halaman + pilihan kosong ----------
{
  const { status, body } = await callBoards(
    "GET",
    boardsUrl(TENANT_A, account.id),
    USER_A,
  );
  assert.equal(status, 200);
  assert.deepEqual(
    body.boards.map((b) => b.id),
    ["board-1", "board-2", "board-3"],
  );
  assert.equal(body.selectedBoardId, null);
  assert.equal(body.selectedBoardName, null);
  assert.equal(lastBoardsAuth, `Bearer ${ACCESS}`);
  console.log("[1] GET daftar → 3 board dari 2 halaman (bookmark diikuti); pilihan kosong: OK");
}

// ---------- [2] PUT pilihan sah → tersimpan + terbaca penerbit ----------
{
  const { status, body } = await callBoards(
    "PUT",
    boardUrl(TENANT_A, account.id),
    USER_A,
    { boardId: "board-2" },
  );
  assert.equal(status, 200);
  assert.equal(body.selectedBoardId, "board-2");
  assert.equal(body.selectedBoardName, "Inspirasi");
  const stored = await storedChoice(account.id);
  assert.equal(stored.pinterest_board_id, "board-2");
  assert.equal(stored.pinterest_board_name, "Inspirasi");
  // Jembatan yang dibaca penerbit worker (getPinterestBoardChoice).
  const choice = await getPinterestBoardChoice(
    db,
    { tenantId: TENANT_A },
    account.id,
  );
  assert.deepEqual(choice, { boardId: "board-2", boardName: "Inspirasi" });
  // Audit tercatat tanpa token.
  const audit = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_logs WHERE action = 'channel.pinterest_board_updated' AND tenant_id = $1`,
    [TENANT_A],
  );
  assert.equal(audit.rows[0]!.count, "1");
  console.log("[2] PUT board-2 → kolom akun + snapshot tersimpan; getPinterestBoardChoice membacanya; audit tercatat: OK");
}

// ---------- [3] PUT board asing → 422, pilihan lama utuh ----------
{
  const { status, body } = await callBoards(
    "PUT",
    boardUrl(TENANT_A, account.id),
    USER_A,
    { boardId: "board-milik-orang" },
  );
  assert.equal(status, 422);
  assert.equal(body.error?.code, "PINTEREST_BOARD_NOT_FOUND");
  const stored = await storedChoice(account.id);
  assert.equal(stored.pinterest_board_id, "board-2");
  console.log("[3] PUT board asing → 422 PINTEREST_BOARD_NOT_FOUND; pilihan lama tidak berubah: OK");
}

// ---------- [4] PUT null → pilihan dibersihkan ----------
{
  const { status, body } = await callBoards(
    "PUT",
    boardUrl(TENANT_A, account.id),
    USER_A,
    { boardId: null },
  );
  assert.equal(status, 200);
  assert.equal(body.selectedBoardId, null);
  const stored = await storedChoice(account.id);
  assert.equal(stored.pinterest_board_id, null);
  assert.equal(stored.pinterest_board_name, null);
  console.log("[4] PUT null → pilihan dibersihkan (kembali ke board pertama): OK");
}

// ---------- [5] POST buat board → bentuk API v5 + jadi pilihan ----------
{
  const { status, body } = await callBoards(
    "POST",
    boardsUrl(TENANT_A, account.id),
    USER_A,
    { name: "Katalog Baru", description: "Produk terbaru", privacy: "PROTECTED" },
  );
  assert.equal(status, 200);
  assert.deepEqual(lastCreateBody, {
    name: "Katalog Baru",
    description: "Produk terbaru",
    privacy: "PROTECTED",
  });
  assert.equal(body.createdBoard?.id, "board-baru");
  assert.equal(body.selectedBoardId, "board-baru");
  assert.ok(body.boards.some((b) => b.id === "board-baru"));
  const stored = await storedChoice(account.id);
  assert.equal(stored.pinterest_board_id, "board-baru");
  console.log("[5] POST buat board → badan persis API v5; board baru otomatis jadi pilihan + masuk daftar: OK");
}

// ---------- [6] Penjaga ----------
{
  const member = await callBoards(
    "GET",
    boardsUrl(TENANT_A, account.id),
    USER_MEMBER,
  );
  assert.equal(member.status, 403);
  assert.equal(member.body.error?.code, "FORBIDDEN");

  const otherProvider = await callBoards(
    "GET",
    boardsUrl(TENANT_A, telegramId),
    USER_A,
  );
  assert.equal(otherProvider.status, 404);

  const putus = await callBoards(
    "GET",
    boardsUrl(TENANT_A, disconnected.id),
    USER_A,
  );
  assert.equal(putus.status, 422);
  assert.equal(putus.body.error?.code, "CHANNEL_NOT_CONNECTED");

  const lintasTenant = await callBoards(
    "GET",
    boardsUrl(TENANT_B, account.id),
    USER_B,
  );
  assert.equal(lintasTenant.status, 404);
  console.log("[6] member → 403; provider lain → 404; akun terputus → 422; lintas tenant → 404: OK");
}

// ---------- [7] Provider gangguan → 502 berkode ----------
{
  boardsDown = true;
  const { status, body } = await callBoards(
    "GET",
    boardsUrl(TENANT_A, account.id),
    USER_A,
  );
  assert.equal(status, 502);
  assert.equal(body.error?.code, "PINTEREST_BOARDS_UNAVAILABLE");
  boardsDown = false;
  console.log("[7] GET /v5/boards 500 → 502 PINTEREST_BOARDS_UNAVAILABLE: OK");
}

// ---------- [8] Board pada opsi postingan (route posts) ----------
interface PostBody {
  id: string;
  publishOptions: { pinterestBoardId?: string } | null;
  error?: { code: string };
}
async function callPosts(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: PostBody }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": USER_A,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as PostBody };
}
{
  // Sasaran Pinterest dimaterialisasi dari akun terhubung.
  const targetsRes = await app.request(`/tenants/${TENANT_A}/posts/targets`, {
    headers: { "x-test-user": USER_A },
  });
  assert.equal(targetsRes.status, 200);
  const targetsBody = (await targetsRes.json()) as {
    items: Array<{
      conversationId: string;
      provider: string;
      channelAccountId: string;
    }>;
  };
  const pinTarget = targetsBody.items.find(
    (item) =>
      item.provider === "pinterest" && item.channelAccountId === account.id,
  );
  assert.ok(pinTarget, "sasaran pinterest harus ada");

  const createUrl = `/tenants/${TENANT_A}/posts`;
  const foreign = await callPosts("POST", createUrl, {
    conversationId: pinTarget.conversationId,
    title: "Pin board asing",
    caption: "Board milik akun lain tidak boleh lolos",
    mediaIds: [],
    publishOptions: { pinterestBoardId: "board-milik-orang" },
  });
  assert.equal(foreign.status, 422);
  assert.equal(foreign.body.error?.code, "PINTEREST_BOARD_NOT_FOUND");

  const own = await callPosts("POST", createUrl, {
    conversationId: pinTarget.conversationId,
    title: "Pin board sendiri",
    caption: "Board milik akun ini sah sebagai opsi postingan",
    mediaIds: [],
    publishOptions: { pinterestBoardId: "board-2" },
  });
  assert.equal(own.status, 201);
  assert.equal(own.body.publishOptions?.pinterestBoardId, "board-2");

  const groupForeign = await callPosts("POST", `${createUrl}/group`, {
    title: "Grup board asing",
    caption: "Satu sasaran asing menggagalkan seluruh pembuatan",
    mediaIds: [],
    targets: [
      {
        conversationId: pinTarget.conversationId,
        publishOptions: { pinterestBoardId: "board-milik-orang" },
      },
    ],
  });
  assert.equal(groupForeign.status, 422);
  assert.equal(groupForeign.body.error?.code, "PINTEREST_BOARD_NOT_FOUND");

  const patchForeign = await callPosts(
    "PATCH",
    `${createUrl}/${own.body.id}`,
    { publishOptions: { pinterestBoardId: "board-milik-orang" } },
  );
  assert.equal(patchForeign.status, 422);
  assert.equal(patchForeign.body.error?.code, "PINTEREST_BOARD_NOT_FOUND");

  const patchOwn = await callPosts("PATCH", `${createUrl}/${own.body.id}`, {
    publishOptions: { pinterestBoardId: "board-3" },
  });
  assert.equal(patchOwn.status, 200);
  assert.equal(patchOwn.body.publishOptions?.pinterestBoardId, "board-3");

  console.log(
    "[8] board opsi postingan: asing → 422 pada create/group/update; milik akun → tersimpan (board-2, lalu board-3 lewat update): OK",
  );
}

fake.closeAllConnections();
fake.close();
await client.close();
console.log("verify pinterest-boards (PGlite + Pinterest API tiruan): SEMUA LULUS");
