/**
 * Verifikasi G7 — comment-to-DM THREADS melawan modul SUNGGUHAN +
 * PGlite bermigrasi penuh. Membuktikan:
 *   [0] parser `parseThreadsReplyEvents`: bentuk datar resmi
 *       (values objek / array), bentuk entry/changes defensif, field
 *       selain 'replies' tidak menghasilkan event;
 *   [1] INGEST: POST webhook balasan bertanda tangan sah → baris
 *       `comments` provider 'threads' (media akar + induk + username
 *       sebagai identitas penulis) + SATU event outbox
 *       `comment.received`; pengiriman ulang payload yang sama →
 *       dedup (baris tetap 1, outbox tetap 1, log 'duplicate');
 *   [2] jalur jujur ingest: pemilik tak dikenal → log
 *       'unresolved_account'; payload tanpa root_post (cakupan
 *       threads_read_replies belum ada) → log
 *       'threads_reply_owner_missing'; akun disconnected →
 *       'ignored_disconnected'; topik mentions → hanya log agregat;
 *   [3] aturan komentar bisa dibuat lewat API untuk akun Threads
 *       (201) — termasuk sendDm=true (API menerima; evaluator yang
 *       mencatat ketidakmungkinannya);
 *   [4] EVALUATOR YANG SAMA menembak aturan yang cocok: balasan
 *       publik lewat klien Threads SUNGGUHAN (container reply_to_id →
 *       FINISHED → publish; fetch tiruan mencatat bentuk request),
 *       sembunyikan lewat manage_reply {hide:true}, dan DM dicatat
 *       `skipped` reason `threads_dm_not_supported` TANPA baris
 *       pesan/percakapan apa pun; evaluasi ulang → no-op idempoten;
 *   [5] MISS tercatat: balasan tanpa kata kunci terevaluasi tanpa
 *       aturan cocok (matched null + evaluatedAt) dan tanpa panggilan
 *       Graph; komentar akun sendiri → skipped own_comment;
 *   [6] kegagalan Graph tercatat jujur per aksi
 *       (publicReply failed `threads_graph_190`), DM tetap skipped;
 *   [7] ISOLASI TENANT: balasan tenant B hanya menembak aturan B;
 *       evaluasi komentar tenant A dengan konteks tenant B → tidak
 *       dievaluasi;
 *   [8] moderasi manual dashboard (performCommentModeration) untuk
 *       komentar Threads memanggil manage_reply di server HTTP
 *       tiruan dan memperbarui status lokal.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:threads-comment-dm
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
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
  encryptChannelSecret,
  evaluateCommentForAutomations,
  type CommentGraphActions,
} from "@sahabat-kreator/core";
import {
  ThreadsGraphClient,
  parseThreadsReplyEvents,
} from "@sahabat-kreator/channel-messenger";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createThreadsWebhookRoutes } from "../src/modules/threads-webhook/routes";
import { createAutomationsRoutes } from "../src/modules/automations/routes";
import { performCommentModeration } from "../src/modules/comments/routes";

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
const bundle = { db } as unknown as AuthBundle;

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC_A = "55555555-5555-4555-8555-555555555551";
const ACC_B = "55555555-5555-4555-8555-555555555552";
const ACC_DISC = "55555555-5555-4555-8555-555555555553";
const OWNER_A = "17841400008460056";
const OWNER_B = "17841400008460057";
const OWNER_DISC = "17841400008460058";

const TOKEN_SECRET = randomBytes(32).toString("base64");
const VERIFY_TOKEN = "uji-token-threads";
const APP_SECRET = "uji-secret-threads";

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A'), ($2, 'b@sk.test', 'Pemilik B')`,
  [USER_A, USER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
  [TENANT_A, USER_A, TENANT_B, USER_B],
);
const encA = encryptChannelSecret(TOKEN_SECRET, "threads-token-a");
const encB = encryptChannelSecret(TOKEN_SECRET, "threads-token-b");
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, public_handle, status, access_token_encrypted, token_type, graph_api_version)
   VALUES ($1, $2, 'threads', $3, 'Brand A', 'brand.a', 'connected', $4, 'threads_user_token', 'v1.0'),
          ($5, $6, 'threads', $7, 'Brand B', 'brand.b', 'connected', $8, 'threads_user_token', 'v1.0'),
          ($9, $2, 'threads', $10, 'Brand Putus', 'brand.putus', 'disconnected', NULL, 'threads_user_token', 'v1.0')`,
  [ACC_A, TENANT_A, OWNER_A, encA, ACC_B, TENANT_B, OWNER_B, encB, ACC_DISC, OWNER_DISC],
);

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? USER_A;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
app.route(
  "/",
  createThreadsWebhookRoutes(bundle, {
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
  }),
);
app.route("/", createAutomationsRoutes(bundle));

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

async function postWebhook(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request("/webhooks/threads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
    },
    body,
  });
}

function replyPayload(input: {
  id: string;
  text: string;
  username: string;
  ownerId?: string;
  rootId?: string;
  repliedToId?: string;
}): Record<string, unknown> {
  return {
    app_id: "1234567890",
    topic: "moderate",
    target_id: input.id,
    time: 1762000000,
    subscription_id: "sub-1",
    values: {
      field: "replies",
      value: {
        id: input.id,
        text: input.text,
        username: input.username,
        timestamp: "2026-11-12T10:15:30+07:00",
        media_product_type: "THREADS",
        media_type: "TEXT_POST",
        ...(input.ownerId
          ? {
              root_post: { id: input.rootId ?? "post-akar-1", owner_id: input.ownerId },
              replied_to: { id: input.repliedToId ?? input.rootId ?? "post-akar-1" },
              is_reply: true,
              has_replies: false,
            }
          : {}),
      },
    },
  };
}

async function commentRow(providerCommentId: string) {
  const rows = await client.query<{
    id: string;
    tenant_id: string;
    provider: string;
    media_id: string | null;
    parent_id: string | null;
    author_external_id: string;
    author_username: string | null;
    text: string;
    matched_automation_id: string | null;
    moderation_status: string;
    actions: Record<string, unknown>;
  }>(
    `SELECT id, tenant_id, provider, media_id, parent_id, author_external_id, author_username, text, matched_automation_id, moderation_status, actions FROM comments WHERE provider_comment_id = $1`,
    [providerCommentId],
  );
  return rows.rows[0] ?? null;
}

async function logOutcomes(): Promise<Array<{ outcome: string; error_code: string | null }>> {
  const rows = await client.query<{ outcome: string; error_code: string | null }>(
    `SELECT outcome, error_code FROM integration_log WHERE provider = 'threads' ORDER BY created_at, outcome`,
  );
  return rows.rows;
}

// ---------- [0] Parser ----------
{
  const flat = parseThreadsReplyEvents(
    replyPayload({ id: "p1", text: "halo", username: "sari", ownerId: OWNER_A }),
  );
  assert.equal(flat.length, 1);
  assert.equal(flat[0]!.ownerExternalId, OWNER_A);
  assert.equal(flat[0]!.mediaId, "post-akar-1");
  assert.equal(flat[0]!.parentId, "post-akar-1");
  assert.equal(flat[0]!.authorUsername, "sari");
  assert.ok(flat[0]!.providerCreatedAt instanceof Date);

  const asArray = parseThreadsReplyEvents({
    values: [
      {
        field: "replies",
        value: { id: "p2", text: "x", username: "rina", root_post: { id: "r", owner_id: OWNER_B } },
      },
    ],
  });
  assert.equal(asArray.length, 1);
  assert.equal(asArray[0]!.ownerExternalId, OWNER_B);

  const entryShape = parseThreadsReplyEvents({
    object: "threads",
    entry: [
      {
        id: OWNER_A,
        changes: [
          { field: "replies", value: { id: "p3", text: "y", username: "dodi" } },
        ],
      },
    ],
  });
  assert.equal(entryShape.length, 1);
  assert.equal(entryShape[0]!.ownerExternalId, OWNER_A); // entry.id cadangan

  const mentions = parseThreadsReplyEvents({
    values: { field: "mentions", value: { id: "p4", text: "z", username: "eka" } },
  });
  assert.equal(mentions.length, 0);
  console.log("[0] parser: bentuk datar/array/entry + field non-replies: OK");
}

// ---------- [1] Ingest + dedup ----------
const payload1 = replyPayload({
  id: "reply-1",
  text: "halo kak, mau info harga dong",
  username: "pelanggan.satu",
  ownerId: OWNER_A,
});
{
  const res = await postWebhook(payload1);
  assert.equal(res.status, 200);
  const row = await commentRow("reply-1");
  assert.ok(row, "baris komentar reply-1 harus ada");
  assert.equal(row.provider, "threads");
  assert.equal(row.tenant_id, TENANT_A);
  assert.equal(row.media_id, "post-akar-1");
  assert.equal(row.parent_id, "post-akar-1");
  assert.equal(row.author_external_id, "pelanggan.satu");
  assert.equal(row.author_username, "pelanggan.satu");
  const outbox = await client.query(
    `SELECT id FROM outbox_events WHERE type = 'comment.received' AND payload->>'commentId' = $1`,
    [row.id],
  );
  assert.equal(outbox.rows.length, 1);

  // Pengiriman ulang payload yang sama → dedup total.
  const res2 = await postWebhook(payload1);
  assert.equal(res2.status, 200);
  const all = await client.query(
    `SELECT id FROM comments WHERE provider_comment_id = 'reply-1'`,
  );
  assert.equal(all.rows.length, 1);
  const outbox2 = await client.query(
    `SELECT id FROM outbox_events WHERE type = 'comment.received'`,
  );
  assert.equal(outbox2.rows.length, 1);
  const outcomes = await logOutcomes();
  assert.ok(outcomes.some((o) => o.outcome === "duplicate"));
  console.log("[1] ingest masuk tabel + outbox; kirim ulang → dedup: OK");
}

// ---------- [2] Jalur jujur ingest ----------
{
  await postWebhook(
    replyPayload({ id: "reply-x", text: "harga?", username: "asing", ownerId: "999999999" }),
  );
  assert.equal(await commentRow("reply-x"), null);

  await postWebhook(
    replyPayload({ id: "reply-y", text: "harga?", username: "tanpa.pemilik" }),
  );
  assert.equal(await commentRow("reply-y"), null);

  await postWebhook(
    replyPayload({ id: "reply-z", text: "harga?", username: "ke.putus", ownerId: OWNER_DISC }),
  );
  assert.equal(await commentRow("reply-z"), null);

  const mentionRes = await postWebhook({
    object: "threads",
    entry: [{ id: OWNER_A, changes: [{ field: "mentions", value: { text: "halo" } }] }],
  });
  assert.equal(mentionRes.status, 200);

  const outcomes = await logOutcomes();
  assert.ok(outcomes.some((o) => o.outcome === "unresolved_account"));
  assert.ok(
    outcomes.some((o) => o.error_code === "threads_reply_owner_missing"),
  );
  assert.ok(outcomes.some((o) => o.outcome === "ignored_disconnected"));
  assert.ok(
    outcomes.some((o) => o.outcome === "recorded"),
    "mentions tetap tercatat sebagai log agregat",
  );
  const total = await client.query(`SELECT id FROM comments`);
  assert.equal(total.rows.length, 1); // hanya reply-1
  console.log("[2] pemilik asing/hilang, akun putus, mentions: tercatat jujur, tanpa baris palsu: OK");
}

// ---------- [3] Aturan komentar untuk akun Threads lewat API ----------
async function createCommentRule(
  tenantId: string,
  userId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; id?: string }> {
  const res = await app.request(`/tenants/${tenantId}/automations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return { status: res.status, id: json.id };
}
const ruleABody = {
  kind: "comment",
  name: "Harga Threads A",
  keywords: ["harga"],
  match: "contains",
  channelAccountId: ACC_A,
  sendDm: true,
  dmText: "Hai {name}, detail harga kami kirim di sini ya.",
  publicReplyText: "Hai {name}, terima kasih! Cek balasannya ya.",
  hideComment: true,
};
const ruleA = await createCommentRule(TENANT_A, USER_A, ruleABody);
assert.equal(ruleA.status, 201, `aturan Threads A harus lahir (dapat ${ruleA.status})`);
assert.ok(ruleA.id);
const ruleB = await createCommentRule(TENANT_B, USER_B, {
  ...ruleABody,
  name: "Harga Threads B",
  channelAccountId: ACC_B,
  publicReplyText: "Hai {name} dari B!",
  hideComment: false,
});
assert.equal(ruleB.status, 201);
assert.ok(ruleB.id);
console.log("[3] API menerima aturan komentar akun Threads (201): OK");

// ---------- Klien Threads sungguhan di atas fetch tiruan ----------
interface CapturedCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
function makeThreadsFetch(
  captured: CapturedCall[],
  opts?: { failWithGraph190?: boolean },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    captured.push({ method, url, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (opts?.failWithGraph190) {
      return json(400, {
        error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 },
      });
    }
    if (method === "POST" && url.endsWith("/threads")) {
      return json(200, { id: "container-1" });
    }
    if (method === "GET" && url.includes("container-1")) {
      return json(200, { status: "FINISHED" });
    }
    if (method === "POST" && url.endsWith("/threads_publish")) {
      return json(200, { id: "balasan-publik-1" });
    }
    if (method === "POST" && url.endsWith("/manage_reply")) {
      return json(200, { success: true });
    }
    return json(404, { error: { message: "unknown", code: 100 } });
  }) as typeof fetch;
}

/**
 * CommentGraphActions tiruan yang meniru persis pengkabelan worker:
 * provider threads → ThreadsGraphClient (container reply_to_id →
 * tunggu FINISHED → publish; manageThreadsReply untuk sembunyikan).
 */
function makeGraphActions(
  captured: CapturedCall[],
  fetchImpl: typeof fetch,
  calls: { reply: number; hide: number },
): CommentGraphActions {
  return {
    async replyToComment(input) {
      calls.reply += 1;
      assert.equal(input.provider, "threads");
      assert.equal(input.accountExternalId, OWNER_A);
      const threadsClient = new ThreadsGraphClient({
        baseUrl: "https://graph.threads.net",
        accessToken: input.accessToken,
        fetchImpl,
      });
      const container = await threadsClient.createThreadsContainer({
        threadsUserId: input.accountExternalId,
        mediaType: "TEXT",
        text: input.text,
        replyToId: input.commentId,
      });
      const status = await threadsClient.getThreadsContainerStatus(
        container.containerId,
      );
      assert.equal(status, "FINISHED");
      const published = await threadsClient.publishThreadsContainer({
        threadsUserId: input.accountExternalId,
        containerId: container.containerId,
      });
      return { replyId: published.providerPostId };
    },
    async setCommentHidden(input) {
      calls.hide += 1;
      assert.equal(input.provider, "threads");
      const threadsClient = new ThreadsGraphClient({
        baseUrl: "https://graph.threads.net",
        accessToken: input.accessToken,
        fetchImpl,
      });
      await threadsClient.manageThreadsReply({
        replyId: input.commentId,
        hide: input.hidden,
      });
    },
  };
}

// ---------- [4] Evaluator menembak: reply + hide jalan, DM skipped ----------
{
  const row = await commentRow("reply-1");
  assert.ok(row);
  const captured: CapturedCall[] = [];
  const calls = { reply: 0, hide: 0 };
  const result = await evaluateCommentForAutomations(
    db,
    { tenantId: TENANT_A, commentId: row.id },
    {
      channelTokenSecret: TOKEN_SECRET,
      graph: makeGraphActions(captured, makeThreadsFetch(captured), calls),
    },
  );
  assert.equal(result.evaluated, true);
  assert.equal(result.matchedAutomationId, ruleA.id);
  assert.equal(result.actions?.dm?.status, "skipped");
  assert.equal(result.actions?.dm?.reason, "threads_dm_not_supported");
  assert.equal(result.actions?.publicReply?.status, "sent");
  assert.equal(result.actions?.publicReply?.replyId, "balasan-publik-1");
  assert.equal(result.actions?.hide?.status, "hidden");
  assert.equal(calls.reply, 1);
  assert.equal(calls.hide, 1);

  // Bentuk request ke API Threads sungguhan (dari log fetch tiruan).
  const containerCall = captured.find((c) => c.url.endsWith("/threads"));
  assert.ok(containerCall);
  assert.equal(containerCall.body?.reply_to_id, "reply-1");
  assert.equal(containerCall.body?.media_type, "TEXT");
  const manageCall = captured.find((c) => c.url.endsWith("/manage_reply"));
  assert.ok(manageCall);
  assert.ok(manageCall.url.includes("reply-1"));
  assert.equal(manageCall.body?.hide, true);

  // DM tidak pernah menjadi pesan: tidak ada baris messages/conversations.
  const msgs = await client.query(`SELECT id FROM messages`);
  assert.equal(msgs.rows.length, 0);
  const convs = await client.query(`SELECT id FROM conversations`);
  assert.equal(convs.rows.length, 0);

  const after = await commentRow("reply-1");
  assert.equal(after?.matched_automation_id, ruleA.id);
  assert.equal(after?.moderation_status, "hidden");
  assert.ok(after?.actions?.evaluatedAt);

  // Idempoten: evaluasi ulang tidak menembak lagi.
  const again = await evaluateCommentForAutomations(
    db,
    { tenantId: TENANT_A, commentId: row.id },
    {
      channelTokenSecret: TOKEN_SECRET,
      graph: makeGraphActions(captured, makeThreadsFetch(captured), calls),
    },
  );
  assert.equal(again.evaluated, false);
  assert.equal(calls.reply, 1);
  assert.equal(calls.hide, 1);
  console.log("[4] evaluator: reply_to_id + publish + manage_reply jalan; DM skipped tanpa pesan; idempoten: OK");
}

// ---------- [5] Miss + komentar sendiri ----------
{
  await postWebhook(
    replyPayload({
      id: "reply-2",
      text: "selamat pagi, toko buka jam berapa?",
      username: "pelanggan.dua",
      ownerId: OWNER_A,
    }),
  );
  const miss = await commentRow("reply-2");
  assert.ok(miss);
  const captured: CapturedCall[] = [];
  const calls = { reply: 0, hide: 0 };
  const missResult = await evaluateCommentForAutomations(
    db,
    { tenantId: TENANT_A, commentId: miss.id },
    {
      channelTokenSecret: TOKEN_SECRET,
      graph: makeGraphActions(captured, makeThreadsFetch(captured), calls),
    },
  );
  assert.equal(missResult.evaluated, true);
  assert.equal(missResult.matchedAutomationId, null);
  assert.equal(calls.reply + calls.hide, 0);
  const missAfter = await commentRow("reply-2");
  assert.ok(missAfter?.actions?.evaluatedAt, "miss tetap tercatat terevaluasi");
  assert.equal(missAfter?.matched_automation_id, null);

  await postWebhook(
    replyPayload({
      id: "reply-3",
      text: "harga spesial hari ini!",
      username: "brand.a", // = publicHandle akun A → komentar sendiri
      ownerId: OWNER_A,
    }),
  );
  const own = await commentRow("reply-3");
  assert.ok(own);
  const ownResult = await evaluateCommentForAutomations(
    db,
    { tenantId: TENANT_A, commentId: own.id },
    {
      channelTokenSecret: TOKEN_SECRET,
      graph: makeGraphActions(captured, makeThreadsFetch(captured), calls),
    },
  );
  assert.equal(ownResult.evaluated, true);
  assert.equal(ownResult.skippedOwnComment, true);
  assert.equal(calls.reply + calls.hide, 0);
  console.log("[5] miss tercatat tanpa aksi; komentar sendiri dilewati: OK");
}

// ---------- [6] Kegagalan Graph tercatat jujur ----------
{
  await postWebhook(
    replyPayload({
      id: "reply-4",
      text: "harga untuk reseller berapa?",
      username: "pelanggan.empat",
      ownerId: OWNER_A,
    }),
  );
  const row = await commentRow("reply-4");
  assert.ok(row);
  const captured: CapturedCall[] = [];
  const calls = { reply: 0, hide: 0 };
  const result = await evaluateCommentForAutomations(
    db,
    { tenantId: TENANT_A, commentId: row.id },
    {
      channelTokenSecret: TOKEN_SECRET,
      graph: makeGraphActions(
        captured,
        makeThreadsFetch(captured, { failWithGraph190: true }),
        calls,
      ),
    },
  );
  assert.equal(result.matchedAutomationId, ruleA.id);
  assert.equal(result.actions?.dm?.status, "skipped");
  assert.equal(result.actions?.publicReply?.status, "failed");
  assert.equal(result.actions?.publicReply?.errorCode, "threads_graph_190");
  assert.equal(result.actions?.hide?.status, "failed");
  assert.equal(result.actions?.hide?.errorCode, "threads_graph_190");
  console.log("[6] Graph menolak → aksi failed tercatat threads_graph_190, DM tetap skipped: OK");
}

// ---------- [7] Isolasi tenant ----------
{
  await postWebhook(
    replyPayload({
      id: "reply-b1",
      text: "harga di B berapa?",
      username: "pelanggan.b",
      ownerId: OWNER_B,
      rootId: "post-akar-b",
    }),
  );
  const rowB = await commentRow("reply-b1");
  assert.ok(rowB);
  assert.equal(rowB.tenant_id, TENANT_B);

  // Konteks tenant yang salah tidak mengevaluasi komentar tenant lain.
  const wrong = await evaluateCommentForAutomations(
    db,
    { tenantId: TENANT_A, commentId: rowB.id },
    {
      channelTokenSecret: TOKEN_SECRET,
      graph: makeGraphActions([], makeThreadsFetch([]), { reply: 0, hide: 0 }),
    },
  );
  assert.equal(wrong.evaluated, false);

  const calls = { reply: 0, hide: 0 };
  const graphB: CommentGraphActions = {
    async replyToComment(input) {
      calls.reply += 1;
      assert.equal(input.accountExternalId, OWNER_B);
      return { replyId: "balasan-b-1" };
    },
    async setCommentHidden() {
      calls.hide += 1;
    },
  };
  const resultB = await evaluateCommentForAutomations(
    db,
    { tenantId: TENANT_B, commentId: rowB.id },
    { channelTokenSecret: TOKEN_SECRET, graph: graphB },
  );
  assert.equal(resultB.matchedAutomationId, ruleB.id);
  assert.equal(resultB.actions?.dm?.reason, "threads_dm_not_supported");
  assert.equal(calls.hide, 0); // aturan B tanpa hideComment
  const rowBAfter = await commentRow("reply-b1");
  assert.equal(rowBAfter?.matched_automation_id, ruleB.id);
  console.log("[7] isolasi tenant: aturan B untuk balasan B; lintas tenant tidak dievaluasi: OK");
}

// ---------- [8] Moderasi manual Threads (manage_reply via HTTP tiruan) ----------
{
  const manageCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      manageCalls.push({
        url: req.url ?? "",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const target = await commentRow("reply-2");
    assert.ok(target);
    const outcome = await performCommentModeration(
      bundle,
      { channelTokenSecret: TOKEN_SECRET, threadsApiBase: baseUrl },
      {
        tenantId: TENANT_A,
        actorId: USER_A,
        commentId: target.id,
        hidden: true,
      },
    );
    assert.equal(outcome.kind, "ok");
    assert.equal(manageCalls.length, 1);
    assert.ok(manageCalls[0]!.url.includes("/v1.0/reply-2/manage_reply"));
    assert.equal(manageCalls[0]!.body.hide, true);
    const after = await commentRow("reply-2");
    assert.equal(after?.moderation_status, "hidden");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("[8] moderasi manual Threads → manage_reply + status lokal hidden: OK");
}

console.log("verify threads-comment-dm (PGlite + modul sungguhan): SEMUA LULUS");
await client.close();
