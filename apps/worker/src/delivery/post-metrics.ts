import type { Database } from "@sahabat-kreator/db";
import {
  decryptChannelSecret,
  getPostForAnalytics,
  getYouTubeAnalyticsAccess,
  recordPostMetricSnapshot,
  scanDuePostAnalyticsTargets,
  type GoogleDeps,
  type PostAnalyticsContext,
  type PostAnalyticsTarget,
} from "@sahabat-kreator/core";
import {
  POST_PROVIDER_METRICS_CAPABILITIES,
  type ChannelProvider,
  type PostMetricValues,
} from "@sahabat-kreator/contracts";
import {
  MetaGraphClient,
  MetaGraphError,
  ThreadsGraphClient,
  ThreadsGraphError,
} from "@sahabat-kreator/channel-messenger";
import {
  BlueskyApiError,
  BlueskyClient,
  DEFAULT_BLUESKY_APPVIEW_BASE,
} from "@sahabat-kreator/channel-bluesky";
import {
  YouTubeApiError,
  YouTubeClient,
  youtubeErrorCode,
} from "@sahabat-kreator/channel-youtube";
import {
  LinkedInClient,
  linkedinErrorCode,
} from "@sahabat-kreator/channel-linkedin";
import {
  PinterestClient,
  pinterestErrorCode,
} from "@sahabat-kreator/channel-pinterest";
import { TikTokClient, tiktokErrorCode } from "@sahabat-kreator/channel-tiktok";

/**
 * MetricsAdapter (Fase Susulan S3) — pasangan BACA dari
 * PublisherAdapter Gelombang 0: satu adapter penarikan per provider,
 * registry yang memilihnya, dan kapabilitas yang dideklarasikan di
 * kontrak (POST_PROVIDER_METRICS_CAPABILITIES). Handler sapuan worker
 * hanya memanggil `processPostAnalytics` di sini.
 *
 * Kontrak adapter: mengambil metrik SATU postingan terbit dari API
 * RESMI platform berdasarkan providerMessageId, memetakan angka ke
 * kunci ternormalisasi kontrak, dan mengembalikan hasil ternormalisasi
 * — adapter TIDAK menulis DB dan TIDAK melempar untuk kegagalan
 * platform: kegagalan adalah DATA (`failed` + kode alasan persis)
 * yang menjadi snapshot, supaya satu target rusak tidak pernah
 * menghalangi target lain. Penulisan snapshot dan matematika jadwal
 * (jendela 30 hari, segar 6 jam, coba-lagi 24 jam, unavailable
 * terminal) hidup di core post-analytics.
 *
 * KEJUJURAN per platform (matriks lengkap di kontrak + OWNER-ACTIONS):
 * - Telegram & Google Business: TIDAK ada adapter — capability
 *   menyatakan tidak tersedia dari platform, orkestrator menulis
 *   snapshot `unavailable` tanpa panggilan jaringan apa pun.
 * - Scope tambahan TIDAK diminta diam-diam oleh gelombang ini:
 *   Instagram (instagram_manage_insights), Threads
 *   (threads_manage_insights), LinkedIn (r_member_postAnalytics),
 *   TikTok (video.list), dan hitungan engagement Page
 *   (pages_read_engagement) adalah kebutuhan pemilik. Sampai
 *   terpenuhi, penarikan tercatat `failed` dengan kode persisnya —
 *   kecuali Instagram, yang punya lapis hitungan dasar resmi
 *   (like_count/comments_count terbaca dengan izin koneksi yang ada)
 *   dan menandainya dengan reason `instagram_insights_scope_missing`.
 * - Token kedaluwarsa mengikuti keadaan koneksi yang ada: token akun
 *   channel dibaca apa adanya (lifecycle worker yang menyegarkan/
 *   menandainya), YouTube menukar refresh token koneksi Google lewat
 *   gerbang core yang sama dengan publikasi.
 */

export interface PostMetricsOptions {
  /** Material kunci enkripsi kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret: string | undefined;
  /** Base URL Meta Graph API (env META_API_BASE; default graph.facebook.com). */
  metaApiBase?: string | undefined;
  /** Versi Graph ter-pin dari config platform. */
  metaGraphApiVersion?: string | undefined;
  /** Base URL Threads API (env THREADS_API_BASE; default graph.threads.net). */
  threadsApiBase?: string | undefined;
  /**
   * Base URL AppView Bluesky untuk getPosts (env
   * BLUESKY_APPVIEW_API_BASE; default publik public.api.bsky.app) —
   * BUKAN entryway PDS sesi: getPosts adalah metode AppView.
   */
  blueskyAppViewBase?: string | undefined;
  /** Dependensi Google — objek yang sama dengan publikasi YouTube. */
  google?: GoogleDeps | undefined;
  /** Base URL LinkedIn API (env LINKEDIN_API_BASE). */
  linkedinApiBase?: string | undefined;
  /** Base URL Pinterest API v5 (env PINTEREST_API_BASE). */
  pinterestApiBase?: string | undefined;
  /** Base URL TikTok API (env TIKTOK_API_BASE). */
  tiktokApiBase?: string | undefined;
  /** fetch tiruan untuk rantai uji; bawaan fetch global klien. */
  fetchImpl?: typeof fetch | undefined;
  /** Jeda antar target dalam satu sapuan (batas laju); bawaan 200 ms. */
  interTargetDelayMs?: number | undefined;
}

export type PostMetricsOutcome =
  | {
      status: "ok";
      metrics: PostMetricValues;
      /** Catatan parsial pada penarikan berhasil (boleh kosong). */
      reason?: string | null;
    }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

export interface PostMetricsAdapter {
  /** Provider pada percakapan/akun (kunci ChannelProvider). */
  readonly provider: string;
  fetchMetrics(
    db: Database,
    input: { tenantId: string; ctx: PostAnalyticsContext },
    opts: PostMetricsOptions,
  ): Promise<PostMetricsOutcome>;
}

type TokenResolution =
  | { kind: "ok"; token: string }
  | { kind: "failed"; reason: string };

/**
 * Dekripsi token akun channel — pola persis adapter penerbit:
 * kredensial hilang / secret env kosong / token tak terdekripsi
 * adalah kegagalan tercatat, bukan lemparan.
 */
function resolveChannelToken(
  ctx: PostAnalyticsContext,
  opts: PostMetricsOptions,
  label: string,
): TokenResolution {
  if (!ctx.encryptedToken) {
    return { kind: "failed", reason: `${label}_missing_credentials` };
  }
  if (!opts.channelTokenSecret) {
    return { kind: "failed", reason: `${label}_token_secret_unset` };
  }
  const token = decryptChannelSecret(
    opts.channelTokenSecret,
    ctx.encryptedToken,
  );
  if (!token) return { kind: "failed", reason: `${label}_token_undecryptable` };
  return { kind: "ok", token };
}

function metaErrorCode(label: string, err: unknown): string {
  if (!(err instanceof MetaGraphError)) return `${label}_fetch_error`;
  if (err.status === 0) return `${label}_network_error`;
  if (err.graphCode !== null) return `${label}_graph_${err.graphCode}`;
  return `${label}_http_${err.status}`;
}

function threadsErrorCode(err: unknown): string {
  if (!(err instanceof ThreadsGraphError)) return "threads_fetch_error";
  if (err.status === 0) return "threads_network_error";
  if (err.graphCode !== null) return `threads_graph_${err.graphCode}`;
  return `threads_http_${err.status}`;
}

function blueskyErrorCode(err: unknown): string {
  if (!(err instanceof BlueskyApiError)) return "bluesky_fetch_error";
  if (err.status === 0) return "bluesky_network_error";
  if (err.xrpcError) return `bluesky_xrpc_${err.xrpcError.toLowerCase()}`;
  return `bluesky_http_${err.status}`;
}

/** Salin hanya kunci yang hadir (undefined dibuang, 0 yang sah dipertahankan). */
function pickMetrics(
  source: Partial<Record<string, number | undefined>>,
  mapping: Record<string, keyof PostMetricValues>,
): PostMetricValues {
  const out: PostMetricValues = {};
  for (const [platformKey, metricKey] of Object.entries(mapping)) {
    const value = source[platformKey];
    if (typeof value === "number") out[metricKey] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Facebook Page (provider percakapan: messenger)
// ---------------------------------------------------------------------------

const facebookPageMetricsAdapter: PostMetricsAdapter = {
  provider: "messenger",
  async fetchMetrics(_db, { ctx }, opts) {
    const resolved = resolveChannelToken(ctx, opts, "facebook");
    if (resolved.kind === "failed") {
      return { status: "failed", reason: resolved.reason };
    }
    const client = new MetaGraphClient({
      baseUrl: opts.metaApiBase,
      apiVersion: opts.metaGraphApiVersion,
      accessToken: resolved.token,
      fetchImpl: opts.fetchImpl,
    });
    try {
      const engagement = await client.getPagePostEngagement(
        ctx.providerMessageId,
      );
      const metrics: PostMetricValues = { ...engagement };
      // Tayangan bersifat best-effort: insights mensyaratkan izin
      // read_insights + peran Page yang tidak selalu ada; kegagalannya
      // TIDAK membatalkan angka engagement yang sudah terbaca, tetapi
      // dicatat sebagai catatan parsial pada snapshot.
      let reason: string | null = null;
      try {
        const views = await client.getPagePostViewCount(ctx.providerMessageId);
        if (views !== null) metrics.views = views;
      } catch {
        reason = "facebook_views_unavailable";
      }
      return { status: "ok", metrics, reason };
    } catch (err) {
      return { status: "failed", reason: metaErrorCode("facebook", err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

const instagramMetricsAdapter: PostMetricsAdapter = {
  provider: "instagram",
  async fetchMetrics(_db, { ctx }, opts) {
    const resolved = resolveChannelToken(ctx, opts, "instagram");
    if (resolved.kind === "failed") {
      return { status: "failed", reason: resolved.reason };
    }
    const client = new MetaGraphClient({
      baseUrl: opts.metaApiBase,
      apiVersion: opts.metaGraphApiVersion,
      accessToken: resolved.token,
      fetchImpl: opts.fetchImpl,
    });
    try {
      const raw = await client.getInstagramMediaInsights(ctx.providerMessageId);
      const metrics = pickMetrics(raw, {
        views: "views",
        reach: "reach",
        likes: "likes",
        comments: "comments",
        shares: "shares",
        saved: "saves",
      });
      if (Object.keys(metrics).length === 0) {
        return { status: "failed", reason: "instagram_insights_empty" };
      }
      return { status: "ok", metrics };
    } catch (err) {
      // Izin insights belum ada (kode Graph 10/200) → lapis resmi
      // kedua: like_count/comments_count terbaca dengan izin dasar
      // koneksi. Snapshot tetap `ok` untuk dua angka itu dan membawa
      // catatan persis kenapa metrik lain belum ada.
      if (
        err instanceof MetaGraphError &&
        (err.graphCode === 10 || err.graphCode === 200)
      ) {
        try {
          const counts = await client.getInstagramMediaCounts(
            ctx.providerMessageId,
          );
          if (
            typeof counts.likes === "number" ||
            typeof counts.comments === "number"
          ) {
            return {
              status: "ok",
              metrics: { ...counts },
              reason: "instagram_insights_scope_missing",
            };
          }
        } catch {
          /* jatuh ke kegagalan insights asli di bawah */
        }
      }
      return { status: "failed", reason: metaErrorCode("instagram", err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const threadsMetricsAdapter: PostMetricsAdapter = {
  provider: "threads",
  async fetchMetrics(_db, { ctx }, opts) {
    const resolved = resolveChannelToken(ctx, opts, "threads");
    if (resolved.kind === "failed") {
      return { status: "failed", reason: resolved.reason };
    }
    const client = new ThreadsGraphClient({
      baseUrl: opts.threadsApiBase,
      accessToken: resolved.token,
      fetchImpl: opts.fetchImpl,
    });
    try {
      const raw = await client.getThreadsMediaInsights(ctx.providerMessageId);
      const metrics = pickMetrics(raw, {
        views: "views",
        likes: "likes",
        replies: "comments",
        reposts: "reposts",
        quotes: "quotes",
        shares: "shares",
      });
      if (Object.keys(metrics).length === 0) {
        return { status: "failed", reason: "threads_insights_empty" };
      }
      return { status: "ok", metrics };
    } catch (err) {
      return { status: "failed", reason: threadsErrorCode(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Bluesky — hitungan publik AppView, tanpa kredensial
// ---------------------------------------------------------------------------

const blueskyMetricsAdapter: PostMetricsAdapter = {
  provider: "bluesky",
  async fetchMetrics(_db, { ctx }, opts) {
    const client = new BlueskyClient({
      baseUrl: opts.blueskyAppViewBase ?? DEFAULT_BLUESKY_APPVIEW_BASE,
      fetchImpl: opts.fetchImpl,
    });
    try {
      const counts = await client.getPostCounts(ctx.providerMessageId);
      if (!counts) {
        return { status: "failed", reason: "bluesky_post_not_found" };
      }
      return { status: "ok", metrics: { ...counts } };
    } catch (err) {
      return { status: "failed", reason: blueskyErrorCode(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// YouTube — token dari koneksi Google tenant (bukan akun channel)
// ---------------------------------------------------------------------------

const youtubeMetricsAdapter: PostMetricsAdapter = {
  provider: "youtube",
  async fetchMetrics(db, { tenantId, ctx }, opts) {
    if (!opts.google) {
      return { status: "failed", reason: "youtube_google_unconfigured" };
    }
    const access = await getYouTubeAnalyticsAccess(db, tenantId, opts.google);
    if (access.kind === "not_connected") {
      return { status: "failed", reason: "youtube_not_connected" };
    }
    if (access.kind === "scope_missing") {
      return { status: "failed", reason: "youtube_scope_missing" };
    }
    const client = new YouTubeClient({
      baseUrl: opts.google.bases?.apiBase,
      fetchImpl: opts.fetchImpl,
    });
    try {
      const stats = await client.getVideoStatistics({
        accessToken: access.accessToken,
        videoId: ctx.providerMessageId,
      });
      if (!stats) {
        return { status: "failed", reason: "youtube_video_not_found" };
      }
      return { status: "ok", metrics: { ...stats } };
    } catch (err) {
      return {
        status: "failed",
        reason:
          err instanceof YouTubeApiError
            ? youtubeErrorCode(err)
            : "youtube_fetch_error",
      };
    }
  },
};

// ---------------------------------------------------------------------------
// LinkedIn — Member Post Statistics (butuh r_member_postAnalytics)
// ---------------------------------------------------------------------------

const linkedinMetricsAdapter: PostMetricsAdapter = {
  provider: "linkedin",
  async fetchMetrics(_db, { ctx }, opts) {
    const resolved = resolveChannelToken(ctx, opts, "linkedin");
    if (resolved.kind === "failed") {
      return { status: "failed", reason: resolved.reason };
    }
    const client = new LinkedInClient({
      baseUrl: opts.linkedinApiBase,
      fetchImpl: opts.fetchImpl,
    });
    try {
      const raw = await client.getMemberPostAnalytics(
        resolved.token,
        ctx.providerMessageId,
      );
      const metrics = pickMetrics(raw, {
        IMPRESSION: "views",
        MEMBERS_REACHED: "reach",
        REACTION: "likes",
        COMMENT: "comments",
        RESHARE: "shares",
      });
      return { status: "ok", metrics };
    } catch (err) {
      return { status: "failed", reason: linkedinErrorCode(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Pinterest — Pin analytics v5 (scope pins:read sudah ada)
// ---------------------------------------------------------------------------

const pinterestMetricsAdapter: PostMetricsAdapter = {
  provider: "pinterest",
  async fetchMetrics(_db, { ctx }, opts) {
    const resolved = resolveChannelToken(ctx, opts, "pinterest");
    if (resolved.kind === "failed") {
      return { status: "failed", reason: resolved.reason };
    }
    const client = new PinterestClient({
      baseUrl: opts.pinterestApiBase,
      fetchImpl: opts.fetchImpl,
    });
    const startDate = ctx.publishedAt.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    try {
      const raw = await client.getPinAnalytics({
        accessToken: resolved.token,
        pinId: ctx.providerMessageId,
        startDate,
        endDate: today >= startDate ? today : startDate,
      });
      const metrics = pickMetrics(raw, {
        IMPRESSION: "views",
        SAVE: "saves",
        PIN_CLICK: "clicks",
        OUTBOUND_CLICK: "outboundClicks",
      });
      return { status: "ok", metrics };
    } catch (err) {
      return { status: "failed", reason: pinterestErrorCode(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// TikTok — Display API video/query (butuh scope video.list)
// ---------------------------------------------------------------------------

const tiktokMetricsAdapter: PostMetricsAdapter = {
  provider: "tiktok",
  async fetchMetrics(_db, { ctx }, opts) {
    const resolved = resolveChannelToken(ctx, opts, "tiktok");
    if (resolved.kind === "failed") {
      return { status: "failed", reason: resolved.reason };
    }
    const client = new TikTokClient({
      baseUrl: opts.tiktokApiBase,
      fetchImpl: opts.fetchImpl,
    });
    try {
      const video = await client.queryVideoMetrics(
        resolved.token,
        ctx.providerMessageId,
      );
      if (!video) {
        // Id tersimpan bukan id video publik (publish_id cadangan
        // atau postingan foto) — endpoint video memang tidak bisa
        // menjawabnya; tercatat jujur sebagai tidak ditemukan.
        return { status: "failed", reason: "tiktok_video_not_found" };
      }
      return { status: "ok", metrics: { ...video } };
    } catch (err) {
      return { status: "failed", reason: tiktokErrorCode(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Registry + orkestrator sapuan
// ---------------------------------------------------------------------------

export const POST_METRICS_ADAPTERS: readonly PostMetricsAdapter[] = [
  facebookPageMetricsAdapter,
  instagramMetricsAdapter,
  threadsMetricsAdapter,
  blueskyMetricsAdapter,
  youtubeMetricsAdapter,
  linkedinMetricsAdapter,
  pinterestMetricsAdapter,
  tiktokMetricsAdapter,
];

export function getPostMetricsAdapter(
  provider: string,
): PostMetricsAdapter | null {
  return POST_METRICS_ADAPTERS.find((a) => a.provider === provider) ?? null;
}

export type PostAnalyticsFetchStatus =
  | "ok"
  | "unavailable"
  | "failed"
  | "skipped";

/**
 * Tarik + catat metrik SATU target jatuh tempo. Mengembalikan status
 * akhir snapshot-nya (`skipped` = postingan berubah keadaan sejak
 * pindaian — tidak ada snapshot yang ditulis). Tidak pernah melempar
 * untuk kegagalan platform; lemparan hanya dari lapisan DB.
 */
export async function fetchAndRecordPostMetrics(
  db: Database,
  target: PostAnalyticsTarget,
  opts: PostMetricsOptions,
  now: Date = new Date(),
): Promise<PostAnalyticsFetchStatus> {
  const ctx = await getPostForAnalytics(db, {
    tenantId: target.tenantId,
    postId: target.postId,
  });
  if (!ctx) return "skipped";
  const capability =
    POST_PROVIDER_METRICS_CAPABILITIES[ctx.provider as ChannelProvider];
  if (!capability) return "skipped";
  if (!capability.metricsSupported) {
    await recordPostMetricSnapshot(db, {
      tenantId: target.tenantId,
      postId: target.postId,
      provider: ctx.provider,
      status: "unavailable",
      reason: "platform_metrics_unsupported",
      fetchedAt: now,
    });
    return "unavailable";
  }
  const adapter = getPostMetricsAdapter(ctx.provider);
  if (!adapter) {
    await recordPostMetricSnapshot(db, {
      tenantId: target.tenantId,
      postId: target.postId,
      provider: ctx.provider,
      status: "unavailable",
      reason: "metrics_adapter_missing",
      fetchedAt: now,
    });
    return "unavailable";
  }
  let outcome: PostMetricsOutcome;
  try {
    outcome = await adapter.fetchMetrics(
      db,
      { tenantId: target.tenantId, ctx },
      opts,
    );
  } catch {
    outcome = { status: "failed", reason: "metrics_fetch_error" };
  }
  await recordPostMetricSnapshot(db, {
    tenantId: target.tenantId,
    postId: target.postId,
    provider: ctx.provider,
    status: outcome.status,
    reason: outcome.status === "ok" ? (outcome.reason ?? null) : outcome.reason,
    metrics: outcome.status === "ok" ? outcome.metrics : null,
    fetchedAt: now,
  });
  return outcome.status;
}

export interface ProcessPostAnalyticsResult {
  scanned: number;
  ok: number;
  unavailable: number;
  failed: number;
  skipped: number;
}

/**
 * Satu sapuan penarikan analitik lintas tenant: pindai target jatuh
 * tempo dari core, proses BERURUTAN dengan jeda antar target (batas
 * laju per platform dihormati — panggilan metrik per postingan kecil
 * dan tokennya per akun), dan isolasi kegagalan per target: satu
 * target yang melempar tidak menghentikan sapuan.
 */
export async function processPostAnalytics(
  db: Database,
  opts: PostMetricsOptions,
  now: Date = new Date(),
): Promise<ProcessPostAnalyticsResult> {
  const targets = await scanDuePostAnalyticsTargets(db, now);
  const result: ProcessPostAnalyticsResult = {
    scanned: targets.length,
    ok: 0,
    unavailable: 0,
    failed: 0,
    skipped: 0,
  };
  const delayMs = opts.interTargetDelayMs ?? 200;
  for (const [index, target] of targets.entries()) {
    if (index > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const status = await fetchAndRecordPostMetrics(db, target, opts, now);
      result[status] += 1;
    } catch (err) {
      result.failed += 1;
      console.error(
        `[post-analytics] target ${target.postId} gagal diproses:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}
