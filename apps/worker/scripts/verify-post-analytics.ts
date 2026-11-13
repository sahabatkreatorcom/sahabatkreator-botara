/**
 * Verifikasi ANALITIK PER PLATFORM UNTUK POSTINGAN (Fase Susulan S3)
 * di atas PGlite dengan fetch tiruan per platform. Yang dibuktikan:
 *  1. Matriks kapabilitas konsisten: setiap provider yang bisa
 *     menerbitkan punya entri kapabilitas metrik di kontrak, dan
 *     registry adapter worker == himpunan provider yang kapabilitasnya
 *     menyatakan metrik didukung (8 platform). Telegram & Google
 *     Business: metricsSupported=false dan TANPA adapter.
 *  2. Penarikan tiruan per platform menghasilkan snapshot yang benar:
 *     Facebook (engagement + views), Instagram (insights penuh +
 *     lapis hitungan dasar saat scope insights ditolak), Threads,
 *     Bluesky (publik, tanpa token), YouTube (statistik via koneksi
 *     Google), LinkedIn, Pinterest, TikTok — angka persis dari
 *     respons tiruan, terpetakan ke kunci ternormalisasi.
 *  3. Platform tanpa metrik tercatat `unavailable` TANPA angka dan
 *     TANPA satu pun panggilan jaringan untuk platform itu.
 *  4. Kegagalan satu target terisolasi: post Facebook yang endpoint-nya
 *     500 dan post LinkedIn yang 403 (scope belum ada) tercatat
 *     `failed` dengan kode persis; target lain tetap `ok`; sapuan
 *     tidak melempar.
 *  5. Snapshot BERTAMBAH bukan menimpa: sapuan ulang sesudah jeda
 *     segar menambah baris kedua dengan angka baru; snapshot terbaru
 *     yang dibaca permukaan adalah yang baru. Sapuan segera (belum
 *     jatuh tempo) tidak menulis apa pun.
 *  6. Jendela konservatif: postingan berumur 31 hari dan postingan
 *     draf tidak pernah ditarik.
 *  7. Isolasi tenant: sapuan memproses dua tenant pada konteksnya
 *     masing-masing; bacaan terbaru + agregat tenant B tidak pernah
 *     memuat angka tenant A.
 *  8. Agregat per platform: total = snapshot ok TERAKHIR per
 *     postingan (bukan jumlah riwayat), tren harian carry-forward.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:post-analytics
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  POST_PROVIDER_CAPABILITIES,
  POST_PROVIDER_METRICS_CAPABILITIES,
  type ChannelProvider,
} from "@sahabat-kreator/contracts";
import {
  encryptChannelSecret,
  getPostPlatformAnalytics,
  listLatestPostAnalytics,
  listPostAnalyticsHistory,
  saveGoogleServiceConnection,
  type GoogleDeps,
} from "@sahabat-kreator/core";
import {
  POST_METRICS_ADAPTERS,
  getPostMetricsAdapter,
  processPostAnalytics,
  type PostMetricsOptions,
} from "../src/delivery/post-metrics";

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

// Base64 dari tepat 32 byte ("0123456789abcdef" ×2) — format yang
// diwajibkan deriveKey channel-secrets.
const TOKEN_SECRET = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const NOW = new Date("2026-11-13T12:00:00.000Z");
const PUBLISHED_RECENT = "2026-11-11T12:00:00.000Z";
const PUBLISHED_OLD = "2026-10-13T12:00:00.000Z";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const CONTACT = "77777777-7777-4777-8777-777777777771";

// ---------------------------------------------------------------------------
// [1] Matriks kapabilitas kontrak ↔ registry adapter
// ---------------------------------------------------------------------------
{
  const publishable = Object.entries(POST_PROVIDER_CAPABILITIES)
    .filter(([, cap]) => cap.publishSupported)
    .map(([provider]) => provider);
  for (const provider of publishable) {
    assert.ok(
      POST_PROVIDER_METRICS_CAPABILITIES[provider as ChannelProvider],
      `provider penerbit ${provider} wajib punya kapabilitas metrik`,
    );
  }
  const supported = Object.entries(POST_PROVIDER_METRICS_CAPABILITIES)
    .filter(([, cap]) => cap.metricsSupported)
    .map(([provider]) => provider)
    .sort();
  const adapterProviders = POST_METRICS_ADAPTERS.map((a) => a.provider).sort();
  assert.deepEqual(
    adapterProviders,
    supported,
    "registry adapter == provider bermetrik menurut kontrak",
  );
  assert.deepEqual(supported, [
    "bluesky",
    "instagram",
    "linkedin",
    "messenger",
    "pinterest",
    "threads",
    "tiktok",
    "youtube",
  ]);
  assert.equal(
    POST_PROVIDER_METRICS_CAPABILITIES.telegram.metricsSupported,
    false,
  );
  assert.equal(
    POST_PROVIDER_METRICS_CAPABILITIES.google_business.metricsSupported,
    false,
  );
  assert.equal(getPostMetricsAdapter("telegram"), null);
  assert.equal(getPostMetricsAdapter("google_business"), null);
  console.log("[1] matriks kapabilitas kontrak ↔ adapter konsisten");
}

// ---------------------------------------------------------------------------
// Seed: dua tenant, akun channel per platform, postingan terbit
// ---------------------------------------------------------------------------
const enc = (plain: string) => encryptChannelSecret(TOKEN_SECRET, plain);

const ACCOUNTS: Record<string, { id: string; provider: string }> = {
  messenger: { id: "55555555-5555-4555-8555-555555555501", provider: "messenger" },
  instagram: { id: "55555555-5555-4555-8555-555555555502", provider: "instagram" },
  threads: { id: "55555555-5555-4555-8555-555555555503", provider: "threads" },
  bluesky: { id: "55555555-5555-4555-8555-555555555504", provider: "bluesky" },
  youtube: { id: "55555555-5555-4555-8555-555555555505", provider: "youtube" },
  linkedin: { id: "55555555-5555-4555-8555-555555555506", provider: "linkedin" },
  pinterest: { id: "55555555-5555-4555-8555-555555555507", provider: "pinterest" },
  tiktok: { id: "55555555-5555-4555-8555-555555555508", provider: "tiktok" },
  telegram: { id: "55555555-5555-4555-8555-555555555509", provider: "telegram" },
  google_business: {
    id: "55555555-5555-4555-8555-555555555510",
    provider: "google_business",
  },
};
const ACCOUNT_B_BLUESKY = "55555555-5555-4555-8555-555555555511";
const ACCOUNT_B_LINKEDIN = "55555555-5555-4555-8555-555555555512";

await client.query(
  `INSERT INTO tenants (id, name, slug, timezone) VALUES ($1, 'Tenant Uji', 'tenant-uji', 'Asia/Jakarta'), ($2, 'Tenant Lain', 'tenant-lain', 'Asia/Jakarta')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Kanal Uji')`,
  [CONTACT, TENANT],
);

let convSeq = 0;
async function seedConversation(
  tenantId: string,
  accountId: string,
  provider: string,
): Promise<string> {
  convSeq += 1;
  const id = `66666666-6666-4666-8666-${String(convSeq).padStart(12, "0")}`;
  await client.query(
    `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'channel')`,
    [id, tenantId, accountId, CONTACT, provider, `chat-${provider}`, `Kanal ${provider}`],
  );
  return id;
}

let postSeq = 0;
async function seedPost(input: {
  tenantId: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string | null;
  status?: string;
  publishedAt?: string | null;
}): Promise<string> {
  postSeq += 1;
  const id = `44444444-4444-4444-8444-${String(postSeq).padStart(12, "0")}`;
  await client.query(
    `INSERT INTO posts (id, tenant_id, channel_account_id, conversation_id, title, caption, status, published_at, provider_message_id)
     VALUES ($1, $2, $3, $4, 'Postingan uji', 'caption uji', $5, $6, $7)`,
    [
      id,
      input.tenantId,
      input.accountId,
      input.conversationId,
      input.status ?? "published",
      input.publishedAt === undefined ? PUBLISHED_RECENT : input.publishedAt,
      input.providerMessageId,
    ],
  );
  return id;
}

for (const account of Object.values(ACCOUNTS)) {
  const tokenless =
    account.provider === "youtube" || account.provider === "google_business";
  await client.query(
    `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted)
     VALUES ($1, $2, $3, $4, $5, 'connected', $6)`,
    [
      account.id,
      TENANT,
      account.provider,
      `ext-${account.provider}`,
      `Akun ${account.provider}`,
      tokenless ? null : enc(`token-${account.provider}`),
    ],
  );
}
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted)
   VALUES ($1, $2, 'bluesky', 'ext-bsky-b', 'Bluesky B', 'connected', $3),
          ($4, $2, 'linkedin', 'ext-li-b', 'LinkedIn B', 'connected', $5)`,
  [
    ACCOUNT_B_BLUESKY,
    TENANT_B,
    enc("token-bluesky-b"),
    ACCOUNT_B_LINKEDIN,
    enc("token-linkedin-b"),
  ],
);

// Koneksi Google tenant A untuk YouTube (token akses segar — jalur
// penukaran refresh tidak terpicu; scope readonly + upload tertera).
await saveGoogleServiceConnection(db, TENANT, "youtube", {
  tokens: {
    accessToken: "akses-google-uji",
    refreshToken: "refresh-google-uji",
    expiresInSec: 3600,
    scope:
      "openid email https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload",
  },
  accountEmail: "pemilik@example.com",
  tokenSecret: TOKEN_SECRET,
});

const conv: Record<string, string> = {};
for (const [key, account] of Object.entries(ACCOUNTS)) {
  conv[key] = await seedConversation(TENANT, account.id, account.provider);
}
const convBBluesky = await seedConversation(TENANT_B, ACCOUNT_B_BLUESKY, "bluesky");
const convBLinkedin = await seedConversation(TENANT_B, ACCOUNT_B_LINKEDIN, "linkedin");

const POST = {
  fbOk: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.messenger.id, conversationId: conv.messenger, providerMessageId: "111_222" }),
  fbFail: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.messenger.id, conversationId: conv.messenger, providerMessageId: "999_500" }),
  igOk: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.instagram.id, conversationId: conv.instagram, providerMessageId: "ig-media-1" }),
  igFallback: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.instagram.id, conversationId: conv.instagram, providerMessageId: "ig-media-fallback" }),
  threadsOk: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.threads.id, conversationId: conv.threads, providerMessageId: "th-media-1" }),
  blueskyOk: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.bluesky.id, conversationId: conv.bluesky, providerMessageId: "at://did:plc:uji/app.bsky.feed.post/abc" }),
  youtubeOk: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.youtube.id, conversationId: conv.youtube, providerMessageId: "vid-1" }),
  linkedinOk: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.linkedin.id, conversationId: conv.linkedin, providerMessageId: "urn:li:share:111" }),
  pinterestOk: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.pinterest.id, conversationId: conv.pinterest, providerMessageId: "pin-1" }),
  tiktokOk: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.tiktok.id, conversationId: conv.tiktok, providerMessageId: "7350000000000000001" }),
  telegramPost: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.telegram.id, conversationId: conv.telegram, providerMessageId: "4242" }),
  gbpPost: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.google_business.id, conversationId: conv.google_business, providerMessageId: "accounts/1/locations/2/localPosts/3" }),
  oldPost: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.messenger.id, conversationId: conv.messenger, providerMessageId: "111_333", publishedAt: PUBLISHED_OLD }),
  draftPost: await seedPost({ tenantId: TENANT, accountId: ACCOUNTS.messenger.id, conversationId: conv.messenger, providerMessageId: "111_444", status: "draft", publishedAt: null }),
  bBluesky: await seedPost({ tenantId: TENANT_B, accountId: ACCOUNT_B_BLUESKY, conversationId: convBBluesky, providerMessageId: "at://did:plc:lain/app.bsky.feed.post/xyz" }),
  bLinkedin: await seedPost({ tenantId: TENANT_B, accountId: ACCOUNT_B_LINKEDIN, conversationId: convBLinkedin, providerMessageId: "urn:li:share:999" }),
};
console.log("[setup] seed selesai");

// ---------------------------------------------------------------------------
// Fetch tiruan per platform (router URL) — angka bisa diubah antar sapuan
// ---------------------------------------------------------------------------
const fetchedUrls: string[] = [];
const fbState = { likes: 41, comments: 7, shares: 3, views: 1234 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function graphError(status: number, code: number, message: string): Response {
  return jsonResponse(
    { error: { message, type: "OAuthException", code, fbtrace_id: "trace-uji" } },
    status,
  );
}

const fakeFetch: typeof fetch = (async (
  input: string | URL | Request,
  _init?: RequestInit,
) => {
  const url = String(input);
  fetchedUrls.push(url);

  // ---- Meta Graph (facebook + instagram) @ graph.fake ----
  if (url.startsWith("https://graph.fake/")) {
    if (url.includes("/999_500")) {
      return graphError(500, 1, "kegagalan tiruan");
    }
    if (url.includes("/111_222/insights")) {
      return jsonResponse({ data: [{ name: "post_media_view", values: [{ value: fbState.views }] }] });
    }
    if (url.includes("/111_222")) {
      return jsonResponse({
        reactions: { summary: { total_count: fbState.likes } },
        comments: { summary: { total_count: fbState.comments } },
        shares: { count: fbState.shares },
      });
    }
    if (url.includes("/ig-media-fallback/insights")) {
      return graphError(400, 10, "izin insights belum ada");
    }
    if (url.includes("/ig-media-fallback")) {
      return jsonResponse({ like_count: 21, comments_count: 5 });
    }
    if (url.includes("/ig-media-1/insights")) {
      const values: Record<string, number> = {
        views: 900, reach: 700, likes: 55, comments: 9, shares: 4, saved: 12,
      };
      return jsonResponse({
        data: Object.entries(values).map(([name, value]) => ({
          name,
          values: [{ value }],
        })),
      });
    }
    throw new Error(`URL Meta tak terduga: ${url}`);
  }

  // ---- Threads @ threads.fake ----
  if (url.startsWith("https://threads.fake/")) {
    if (url.includes("/th-media-1/insights")) {
      const values: Record<string, number> = {
        views: 300, likes: 18, replies: 6, reposts: 2, quotes: 1, shares: 3,
      };
      return jsonResponse({
        data: Object.entries(values).map(([name, value]) => ({
          name,
          total_value: { value },
        })),
      });
    }
    throw new Error(`URL Threads tak terduga: ${url}`);
  }

  // ---- Bluesky AppView @ bsky.fake ----
  if (url.startsWith("https://bsky.fake/")) {
    if (url.includes("did%3Aplc%3Alain")) {
      return jsonResponse({
        posts: [{ likeCount: 99, replyCount: 1, repostCount: 0, quoteCount: 0 }],
      });
    }
    return jsonResponse({
      posts: [{ likeCount: 12, replyCount: 3, repostCount: 2, quoteCount: 1 }],
    });
  }

  // ---- YouTube @ google.fake ----
  if (url.startsWith("https://google.fake/")) {
    if (url.includes("/youtube/v3/videos")) {
      return jsonResponse({
        items: [
          { statistics: { viewCount: "1000", likeCount: "90", commentCount: "11" } },
        ],
      });
    }
    throw new Error(`URL Google tak terduga: ${url}`);
  }

  // ---- LinkedIn @ linkedin.fake ----
  if (url.startsWith("https://linkedin.fake/")) {
    if (url.includes("share%3A999") || url.includes("share:999")) {
      return jsonResponse({ message: "izin tidak cukup" }, 403);
    }
    const queryType = new URL(url).searchParams.get("queryType") ?? "";
    const counts: Record<string, number> = {
      IMPRESSION: 800, MEMBERS_REACHED: 650, REACTION: 30, COMMENT: 4, RESHARE: 2,
    };
    return jsonResponse({ elements: [{ count: counts[queryType] ?? 0 }] });
  }

  // ---- Pinterest @ pinterest.fake ----
  if (url.startsWith("https://pinterest.fake/")) {
    return jsonResponse({
      all_time: {
        metrics: { IMPRESSION: 5000, SAVE: 44, PIN_CLICK: 60, OUTBOUND_CLICK: 9 },
      },
    });
  }

  // ---- TikTok @ tiktok.fake ----
  if (url.startsWith("https://tiktok.fake/")) {
    return jsonResponse({
      data: {
        videos: [
          {
            id: "7350000000000000001",
            view_count: 777, like_count: 66, comment_count: 8, share_count: 5,
          },
        ],
      },
      error: { code: "ok", message: "", log_id: "log-uji" },
    });
  }

  throw new Error(`fetch tak terduga di verify post-analytics: ${url}`);
}) as typeof fetch;

const googleDeps: GoogleDeps = {
  platform: { env: {} },
  tokenSecret: TOKEN_SECRET,
  bases: {
    apiBase: "https://google.fake",
    tokenBase: "https://token.fake",
    authBase: "https://auth.fake",
  },
};
const metricsOpts: PostMetricsOptions = {
  channelTokenSecret: TOKEN_SECRET,
  metaApiBase: "https://graph.fake",
  threadsApiBase: "https://threads.fake",
  blueskyAppViewBase: "https://bsky.fake",
  google: googleDeps,
  linkedinApiBase: "https://linkedin.fake",
  pinterestApiBase: "https://pinterest.fake",
  tiktokApiBase: "https://tiktok.fake",
  fetchImpl: fakeFetch,
  interTargetDelayMs: 0,
};

async function snapshotCount(postId?: string): Promise<number> {
  const res = postId
    ? await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM post_metric_snapshots WHERE post_id = $1`,
        [postId],
      )
    : await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM post_metric_snapshots`,
      );
  return Number(res.rows[0].count);
}

// ---------------------------------------------------------------------------
// [2–4,6] Sapuan pertama: per platform benar, unavailable tanpa jaringan,
// kegagalan terisolasi, jendela 30 hari ditegakkan
// ---------------------------------------------------------------------------
{
  const result = await processPostAnalytics(db, metricsOpts, NOW);
  assert.equal(result.scanned, 14, `target jatuh tempo: ${JSON.stringify(result)}`);
  assert.equal(result.ok, 10);
  assert.equal(result.unavailable, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.skipped, 0);

  const latest = await listLatestPostAnalytics(db, {
    tenantId: TENANT,
    postIds: Object.values(POST).slice(0, 12),
  });
  const byPost = new Map(latest.map((item) => [item.postId, item]));

  const fb = byPost.get(POST.fbOk)!;
  assert.equal(fb.status, "ok");
  assert.deepEqual(fb.metrics, { likes: 41, comments: 7, shares: 3, views: 1234 });

  const fbFail = byPost.get(POST.fbFail)!;
  assert.equal(fbFail.status, "failed");
  assert.equal(fbFail.reason, "facebook_graph_1");
  assert.equal(fbFail.metrics, null);

  const ig = byPost.get(POST.igOk)!;
  assert.equal(ig.status, "ok");
  assert.deepEqual(ig.metrics, {
    views: 900, reach: 700, likes: 55, comments: 9, shares: 4, saves: 12,
  });

  const igFallback = byPost.get(POST.igFallback)!;
  assert.equal(igFallback.status, "ok");
  assert.deepEqual(igFallback.metrics, { likes: 21, comments: 5 });
  assert.equal(igFallback.reason, "instagram_insights_scope_missing");

  const threads = byPost.get(POST.threadsOk)!;
  assert.deepEqual(threads.metrics, {
    views: 300, likes: 18, comments: 6, reposts: 2, quotes: 1, shares: 3,
  });

  const bluesky = byPost.get(POST.blueskyOk)!;
  assert.deepEqual(bluesky.metrics, { likes: 12, comments: 3, shares: 2, quotes: 1 });

  const youtube = byPost.get(POST.youtubeOk)!;
  assert.deepEqual(youtube.metrics, { views: 1000, likes: 90, comments: 11 });

  const linkedin = byPost.get(POST.linkedinOk)!;
  assert.deepEqual(linkedin.metrics, {
    views: 800, reach: 650, likes: 30, comments: 4, shares: 2,
  });

  const pinterest = byPost.get(POST.pinterestOk)!;
  assert.deepEqual(pinterest.metrics, {
    views: 5000, saves: 44, clicks: 60, outboundClicks: 9,
  });

  const tiktok = byPost.get(POST.tiktokOk)!;
  assert.deepEqual(tiktok.metrics, { views: 777, likes: 66, comments: 8, shares: 5 });

  // Kunci metrik snapshot tidak pernah keluar dari kapabilitas kontrak.
  for (const item of latest) {
    if (item.status !== "ok" || !item.metrics) continue;
    const allowed =
      POST_PROVIDER_METRICS_CAPABILITIES[item.provider as ChannelProvider]
        .metricKeys;
    for (const key of Object.keys(item.metrics)) {
      assert.ok(
        (allowed as string[]).includes(key),
        `metrik ${key} di luar kapabilitas ${item.provider}`,
      );
    }
  }

  const telegram = byPost.get(POST.telegramPost)!;
  assert.equal(telegram.status, "unavailable");
  assert.equal(telegram.reason, "platform_metrics_unsupported");
  assert.equal(telegram.metrics, null);
  const gbp = byPost.get(POST.gbpPost)!;
  assert.equal(gbp.status, "unavailable");
  assert.equal(gbp.metrics, null);
  assert.ok(
    !fetchedUrls.some((url) => url.includes("telegram")),
    "tidak ada panggilan jaringan untuk Telegram",
  );

  // Jendela: postingan 31 hari + draf tidak ditarik sama sekali.
  assert.equal(await snapshotCount(POST.oldPost), 0);
  assert.equal(await snapshotCount(POST.draftPost), 0);
  console.log("[2-4,6] sapuan pertama: 10 ok, 2 unavailable, 2 failed terisolasi");
}

// ---------------------------------------------------------------------------
// [7] Isolasi tenant pada sapuan yang sama
// ---------------------------------------------------------------------------
{
  const latestB = await listLatestPostAnalytics(db, {
    tenantId: TENANT_B,
    postIds: [POST.bBluesky, POST.bLinkedin],
  });
  const byPost = new Map(latestB.map((item) => [item.postId, item]));
  assert.deepEqual(byPost.get(POST.bBluesky)!.metrics, {
    likes: 99, comments: 1, shares: 0, quotes: 0,
  });
  const liB = byPost.get(POST.bLinkedin)!;
  assert.equal(liB.status, "failed");
  assert.equal(liB.reason, "linkedin_forbidden");

  // Tenant B meminta postingan tenant A → kosong.
  const leaked = await listLatestPostAnalytics(db, {
    tenantId: TENANT_B,
    postIds: [POST.fbOk],
  });
  assert.equal(leaked.length, 0);
  console.log("[7] isolasi tenant pada bacaan + sapuan terbukti");
}

// ---------------------------------------------------------------------------
// [5] Sapuan segera tidak menulis; sapuan sesudah jeda MENAMBAH snapshot
// ---------------------------------------------------------------------------
{
  const before = await snapshotCount();
  const immediate = await processPostAnalytics(db, metricsOpts, NOW);
  assert.equal(immediate.scanned, 0);
  assert.equal(await snapshotCount(), before);

  // Paksa snapshot FB basi 7 jam + ubah angka tiruan → sapuan berikut
  // hanya memproses FB itu dan MENAMBAH baris kedua.
  await client.query(
    `UPDATE post_metric_snapshots SET fetched_at = $1 WHERE post_id = $2`,
    [new Date(NOW.getTime() - 7 * 60 * 60 * 1000).toISOString(), POST.fbOk],
  );
  fbState.likes = 50;
  fbState.views = 1500;
  const second = await processPostAnalytics(db, metricsOpts, NOW);
  assert.equal(second.scanned, 1);
  assert.equal(second.ok, 1);
  assert.equal(await snapshotCount(POST.fbOk), 2);
  assert.equal(await snapshotCount(), before + 1);

  const history = await listPostAnalyticsHistory(db, {
    tenantId: TENANT,
    postId: POST.fbOk,
  });
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].metrics?.likes, 50);
  assert.equal(history.items[0].metrics?.views, 1500);
  assert.equal(history.items[1].metrics?.likes, 41);
  console.log("[5] snapshot bertambah (append), bukan menimpa");
}

// ---------------------------------------------------------------------------
// [8] Agregat per platform: total snapshot ok terakhir + tren carry-forward
// ---------------------------------------------------------------------------
{
  const report = await getPostPlatformAnalytics(db, {
    tenantId: TENANT,
    days: 30,
    now: NOW,
  });
  const byProvider = new Map(report.platforms.map((p) => [p.provider, p]));

  const fb = byProvider.get("messenger")!;
  assert.equal(fb.postsWithSnapshots, 2);
  assert.equal(fb.postsWithMetrics, 1);
  // Total memakai snapshot TERAKHIR (50/1500), bukan jumlah riwayat.
  assert.equal(fb.totals.likes, 50);
  assert.equal(fb.totals.views, 1500);
  assert.equal(fb.daily.length, 30);
  const lastDay = fb.daily[fb.daily.length - 1];
  assert.equal(lastDay.date, "2026-11-13");
  assert.equal(lastDay.metrics.views, 1500);
  // Hari sebelum penarikan pertama (jendela mulai 2026-10-15,
  // postingan terbit 2026-11-11) tidak punya angka — kosong, bukan 0.
  assert.deepEqual(fb.daily[0].metrics, {});

  const telegram = byProvider.get("telegram")!;
  assert.equal(telegram.metricsSupported, false);
  assert.equal(telegram.postsWithMetrics, 0);
  assert.deepEqual(telegram.totals, {});

  const reportB = await getPostPlatformAnalytics(db, {
    tenantId: TENANT_B,
    days: 30,
    now: NOW,
  });
  const byProviderB = new Map(reportB.platforms.map((p) => [p.provider, p]));
  assert.equal(byProviderB.get("bluesky")!.totals.likes, 99);
  assert.equal(byProviderB.has("messenger"), false);
  console.log("[8] agregat per platform + tren carry-forward terbukti");
}

console.log("verify:post-analytics — SEMUA LULUS");
