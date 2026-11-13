import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  channelAccounts,
  conversations,
  postMetricSnapshots,
  posts,
  type Database,
} from "@sahabat-kreator/db";
import {
  POST_METRIC_KEYS,
  POST_PROVIDER_METRICS_CAPABILITIES,
  type ChannelProvider,
  type PostMetricValues,
} from "@sahabat-kreator/contracts";
import { withTenantDb } from "./tx";

/**
 * Analitik per platform untuk postingan (Fase Susulan S3) — sisi STATE
 * dari penarikan metrik. Pembagian tugas meniru publikasi:
 * - core (di sini): kepemilikan data snapshot (tulis/baca), matematika
 *   jadwal penarikan (siapa jatuh tempo kapan), dan agregasi untuk
 *   permukaan baca. TIDAK ada panggilan HTTP platform di sini.
 * - worker: adapter penarikan per platform memanggil API resmi,
 *   memetakan angka ke kunci ternormalisasi kontrak, dan menyerahkan
 *   hasilnya ke `recordPostMetricSnapshot`.
 *
 * Aturan kejujuran yang ditegakkan lapisan ini:
 * - Snapshot APPEND-ONLY: penarikan baru selalu baris baru; tidak ada
 *   jalur menimpa. Angka platform adalah penghitung kumulatif, jadi
 *   "nilai saat ini" selalu snapshot `ok` terakhir, dan riwayatnya
 *   yang membentuk tren.
 * - Nilai metrik disaring ke POST_METRIC_KEYS dengan nilai bilangan
 *   bulat ≥ 0; kunci yang tidak dilaporkan platform tidak pernah
 *   diisi 0 karangan — ia absen dari objek yang disimpan.
 * - Jendela penarikan KONSERVATIF: postingan hanya ditarik selama
 *   30 hari sejak terbit (sesudah itu angka organik praktis beku dan
 *   kuota platform tidak dibakar), snapshot `ok` disegarkan paling
 *   cepat tiap 6 jam, kegagalan dicoba lagi paling cepat sesudah
 *   24 jam (kegagalan izin tidak berubah per jam), dan `unavailable`
 *   bersifat terminal — tidak pernah ditarik ulang.
 */

export const POST_ANALYTICS_WINDOW_DAYS = 30;
export const POST_ANALYTICS_REFRESH_OK_MS = 6 * 60 * 60 * 1000;
export const POST_ANALYTICS_RETRY_FAILED_MS = 24 * 60 * 60 * 1000;
/** Kandidat yang diperiksa satu sapuan (sebelum saringan jatuh tempo). */
export const POST_ANALYTICS_SCAN_LIMIT = 200;
/** Target yang benar-benar diproses satu sapuan (batas laju). */
export const POST_ANALYTICS_BATCH_LIMIT = 40;

export type PostMetricSnapshotStatus = "ok" | "unavailable" | "failed";

/** Satu target jatuh tempo hasil pindaian lintas tenant penyapu. */
export interface PostAnalyticsTarget {
  postId: string;
  tenantId: string;
  publishedAt: Date;
}

/** Konteks penarikan satu postingan, dimuat di dalam konteks tenant. */
export interface PostAnalyticsContext {
  postId: string;
  /** Provider sasaran dari percakapan channel (satu-satunya sumber). */
  provider: string;
  providerMessageId: string;
  publishedAt: Date;
  channelAccountId: string;
  /**
   * Token akun channel terenkripsi (pola getPostForPublish); null
   * untuk provider berbasis koneksi Google (YouTube/GBP) yang memang
   * tidak menyimpan token di akun channel.
   */
  encryptedToken: string | null;
}

/** Bentuk baca satu snapshot (cermin PostAnalyticsSnapshot kontrak). */
export interface PostAnalyticsSnapshotView {
  postId: string;
  provider: string;
  status: PostMetricSnapshotStatus;
  reason: string | null;
  metrics: PostMetricValues | null;
  fetchedAt: Date;
}

const KNOWN_PROVIDERS = new Set(Object.keys(POST_PROVIDER_METRICS_CAPABILITIES));

/**
 * Saring nilai metrik mentah ke himpunan kunci ternormalisasi:
 * kunci di luar POST_METRIC_KEYS dibuang, nilai bukan bilangan bulat
 * ≥ 0 dibuang. Mengembalikan null bila tidak ada satu pun nilai sah
 * (pemanggil `ok` tetap boleh menyimpan objek kosong — lihat
 * recordPostMetricSnapshot).
 */
export function sanitizePostMetricValues(
  input: Record<string, unknown> | null | undefined,
): PostMetricValues | null {
  if (!input) return null;
  const out: PostMetricValues = {};
  for (const key of POST_METRIC_KEYS) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = Math.floor(value);
    }
  }
  return out;
}

function toSnapshotView(row: {
  postId: string;
  provider: string;
  status: string;
  reason: string | null;
  metrics: Record<string, number> | null;
  fetchedAt: Date;
}): PostAnalyticsSnapshotView {
  return {
    postId: row.postId,
    provider: row.provider,
    status: row.status as PostMetricSnapshotStatus,
    reason: row.reason,
    metrics:
      row.status === "ok" ? sanitizePostMetricValues(row.metrics) : null,
    fetchedAt: row.fetchedAt,
  };
}

/**
 * Konteks penarikan SATU postingan untuk adapter worker. Null bila
 * postingan tidak ada, belum/sudah tidak `published`, atau tidak
 * punya providerMessageId (tidak ada yang bisa ditanyakan ke
 * platform). Sengaja TIDAK memeriksa jendela umur — itu keputusan
 * penjadwalan penyapu, bukan gerbang konteks.
 */
export async function getPostForAnalytics(
  db: Database,
  input: { tenantId: string; postId: string },
): Promise<PostAnalyticsContext | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        status: posts.status,
        providerMessageId: posts.providerMessageId,
        publishedAt: posts.publishedAt,
        channelAccountId: posts.channelAccountId,
        provider: conversations.provider,
        encryptedToken: channelAccounts.accessTokenEncrypted,
      })
      .from(posts)
      .innerJoin(conversations, eq(conversations.id, posts.conversationId))
      .innerJoin(
        channelAccounts,
        eq(channelAccounts.id, posts.channelAccountId),
      )
      .where(and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)))
      .limit(1);
    if (
      !row ||
      row.status !== "published" ||
      !row.providerMessageId ||
      !row.publishedAt
    ) {
      return null;
    }
    return {
      postId: input.postId,
      provider: row.provider,
      providerMessageId: row.providerMessageId,
      publishedAt: row.publishedAt,
      channelAccountId: row.channelAccountId,
      encryptedToken: row.encryptedToken,
    };
  });
}

/**
 * Pindai target jatuh tempo LINTAS tenant untuk satu sapuan worker:
 * membaca kandidat lewat lengan `system_post_analytics_scan`
 * (flag app.post_analytics='scan' — migrasi 0048) pada `posts` +
 * `post_metric_snapshots`, lalu menerapkan aturan jadwal di sini:
 * - hanya postingan `published` ber-providerMessageId yang terbit
 *   dalam jendela 30 hari;
 * - belum pernah ditarik → jatuh tempo;
 * - snapshot terakhir `ok` → jatuh tempo sesudah 6 jam;
 * - snapshot terakhir `failed` → jatuh tempo sesudah 24 jam;
 * - snapshot terakhir `unavailable` → tidak pernah jatuh tempo.
 * Urutan: terbit terbaru dulu (postingan segar mendapat angka
 * pertamanya paling cepat), dipotong ke POST_ANALYTICS_BATCH_LIMIT.
 */
export async function scanDuePostAnalyticsTargets(
  db: Database,
  now: Date = new Date(),
  limit: number = POST_ANALYTICS_BATCH_LIMIT,
): Promise<PostAnalyticsTarget[]> {
  const windowStart = new Date(
    now.getTime() - POST_ANALYTICS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const { candidates, latest } = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.post_analytics', 'scan', true)`,
    );
    const candidateRows = await tx
      .select({
        id: posts.id,
        tenantId: posts.tenantId,
        publishedAt: posts.publishedAt,
      })
      .from(posts)
      .where(
        and(
          eq(posts.status, "published"),
          sql`${posts.providerMessageId} IS NOT NULL`,
          sql`${posts.publishedAt} >= ${windowStart}`,
        ),
      )
      .orderBy(desc(posts.publishedAt))
      .limit(POST_ANALYTICS_SCAN_LIMIT);
    if (candidateRows.length === 0) {
      return { candidates: candidateRows, latest: [] as Array<{
        postId: string;
        status: string;
        fetchedAt: Date;
      }> };
    }
    const latestRows = await tx
      .selectDistinctOn([postMetricSnapshots.postId], {
        postId: postMetricSnapshots.postId,
        status: postMetricSnapshots.status,
        fetchedAt: postMetricSnapshots.fetchedAt,
      })
      .from(postMetricSnapshots)
      .where(
        inArray(
          postMetricSnapshots.postId,
          candidateRows.map((row) => row.id),
        ),
      )
      .orderBy(
        postMetricSnapshots.postId,
        desc(postMetricSnapshots.fetchedAt),
      );
    return { candidates: candidateRows, latest: latestRows };
  });

  const latestByPost = new Map(latest.map((row) => [row.postId, row]));
  const due: PostAnalyticsTarget[] = [];
  for (const candidate of candidates) {
    if (!candidate.publishedAt) continue;
    const last = latestByPost.get(candidate.id);
    if (last) {
      if (last.status === "unavailable") continue;
      const ageMs = now.getTime() - new Date(last.fetchedAt).getTime();
      if (last.status === "ok" && ageMs < POST_ANALYTICS_REFRESH_OK_MS) {
        continue;
      }
      if (
        last.status === "failed" &&
        ageMs < POST_ANALYTICS_RETRY_FAILED_MS
      ) {
        continue;
      }
    }
    due.push({
      postId: candidate.id,
      tenantId: candidate.tenantId,
      publishedAt: candidate.publishedAt,
    });
    if (due.length >= limit) break;
  }
  return due;
}

/**
 * Tulis SATU snapshot penarikan (selalu menambah baris). `metrics`
 * hanya disimpan untuk status `ok` dan selalu melewati penyaring
 * kunci ternormalisasi; status lain dipaksa null supaya tidak ada
 * angka yang menempel pada penarikan yang gagal/tidak tersedia.
 */
export async function recordPostMetricSnapshot(
  db: Database,
  input: {
    tenantId: string;
    postId: string;
    provider: string;
    status: PostMetricSnapshotStatus;
    reason?: string | null;
    metrics?: Record<string, unknown> | null;
    fetchedAt?: Date;
  },
): Promise<void> {
  const metrics =
    input.status === "ok"
      ? (sanitizePostMetricValues(input.metrics) ?? {})
      : null;
  await withTenantDb(db, input.tenantId, async (tx) => {
    await tx.insert(postMetricSnapshots).values({
      tenantId: input.tenantId,
      postId: input.postId,
      provider: input.provider,
      status: input.status,
      reason: input.reason ? input.reason.slice(0, 128) : null,
      metrics,
      ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
    });
  });
}

/**
 * Snapshot TERBARU per postingan untuk daftar id yang diberikan
 * (permukaan /posts). Id milik tenant lain tidak pernah bocor:
 * kueri berjalan di konteks tenant dan RLS menegakkannya.
 */
export async function listLatestPostAnalytics(
  db: Database,
  input: { tenantId: string; postIds: string[] },
): Promise<PostAnalyticsSnapshotView[]> {
  if (input.postIds.length === 0) return [];
  return withTenantDb(db, input.tenantId, async (tx) => {
    const rows = await tx
      .selectDistinctOn([postMetricSnapshots.postId], {
        postId: postMetricSnapshots.postId,
        provider: postMetricSnapshots.provider,
        status: postMetricSnapshots.status,
        reason: postMetricSnapshots.reason,
        metrics: postMetricSnapshots.metrics,
        fetchedAt: postMetricSnapshots.fetchedAt,
      })
      .from(postMetricSnapshots)
      .where(
        and(
          eq(postMetricSnapshots.tenantId, input.tenantId),
          inArray(postMetricSnapshots.postId, input.postIds),
        ),
      )
      .orderBy(
        postMetricSnapshots.postId,
        desc(postMetricSnapshots.fetchedAt),
      );
    return rows.map(toSnapshotView);
  });
}

/** Riwayat snapshot SATU postingan (terbaru dulu) + provider sasarannya. */
export async function listPostAnalyticsHistory(
  db: Database,
  input: { tenantId: string; postId: string; limit?: number },
): Promise<{ provider: string | null; items: PostAnalyticsSnapshotView[] }> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [target] = await tx
      .select({ provider: conversations.provider })
      .from(posts)
      .innerJoin(conversations, eq(conversations.id, posts.conversationId))
      .where(
        and(eq(posts.tenantId, input.tenantId), eq(posts.id, input.postId)),
      )
      .limit(1);
    if (!target) return { provider: null, items: [] };
    const rows = await tx
      .select({
        postId: postMetricSnapshots.postId,
        provider: postMetricSnapshots.provider,
        status: postMetricSnapshots.status,
        reason: postMetricSnapshots.reason,
        metrics: postMetricSnapshots.metrics,
        fetchedAt: postMetricSnapshots.fetchedAt,
      })
      .from(postMetricSnapshots)
      .where(
        and(
          eq(postMetricSnapshots.tenantId, input.tenantId),
          eq(postMetricSnapshots.postId, input.postId),
        ),
      )
      .orderBy(desc(postMetricSnapshots.fetchedAt))
      .limit(input.limit ?? 30);
    return { provider: target.provider, items: rows.map(toSnapshotView) };
  });
}

export interface PostPlatformAnalyticsEntryData {
  provider: string;
  metricsSupported: boolean;
  postsWithSnapshots: number;
  postsWithMetrics: number;
  totals: PostMetricValues;
  daily: Array<{ date: string; metrics: PostMetricValues }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayStart(date: Date): Date {
  const out = new Date(date.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addMetricsInto(
  target: PostMetricValues,
  source: PostMetricValues,
): void {
  for (const key of POST_METRIC_KEYS) {
    const value = source[key];
    if (typeof value === "number") {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

/**
 * Agregat per platform untuk halaman Analitik, murni dari snapshot
 * yang benar-benar tertarik:
 * - Populasi: postingan yang terbit dalam (days + jendela tarik 30
 *   hari) terakhir — postingan lebih tua tidak bisa punya snapshot
 *   di dalam jendela tren karena penarikan berhenti 30 hari sesudah
 *   terbit.
 * - `totals`: jumlah snapshot `ok` TERAKHIR per postingan (snapshot
 *   adalah penghitung kumulatif — menjumlah riwayat akan
 *   menggandakan angka).
 * - `daily`: carry-forward — nilai satu postingan pada satu hari =
 *   snapshot `ok` terakhir pada/ sebelum akhir hari itu; hari tanpa
 *   pengetahuan apa pun membawa objek metrik kosong.
 * Platform tanpa satu pun snapshot pada populasi tidak tampil.
 */
export async function getPostPlatformAnalytics(
  db: Database,
  input: { tenantId: string; days: number; now?: Date },
): Promise<{ days: number; platforms: PostPlatformAnalyticsEntryData[] }> {
  const now = input.now ?? new Date();
  const days = Math.max(1, Math.floor(input.days));
  const windowEnd = utcDayStart(now);
  const windowStart = new Date(windowEnd.getTime() - (days - 1) * DAY_MS);
  const populationStart = new Date(
    now.getTime() - (days + POST_ANALYTICS_WINDOW_DAYS) * DAY_MS,
  );
  return withTenantDb(db, input.tenantId, async (tx) => {
    const population = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.tenantId, input.tenantId),
          eq(posts.status, "published"),
          sql`${posts.publishedAt} >= ${populationStart}`,
        ),
      );
    if (population.length === 0) return { days, platforms: [] };
    const postIds = population.map((row) => row.id);
    const rows = await tx
      .select({
        postId: postMetricSnapshots.postId,
        provider: postMetricSnapshots.provider,
        status: postMetricSnapshots.status,
        metrics: postMetricSnapshots.metrics,
        fetchedAt: postMetricSnapshots.fetchedAt,
      })
      .from(postMetricSnapshots)
      .where(
        and(
          eq(postMetricSnapshots.tenantId, input.tenantId),
          inArray(postMetricSnapshots.postId, postIds),
        ),
      )
      .orderBy(asc(postMetricSnapshots.fetchedAt))
      .limit(50_000);

    interface PostTrack {
      provider: string;
      okSnapshots: Array<{ at: number; metrics: PostMetricValues }>;
      latestOk: PostMetricValues | null;
      hasAny: boolean;
    }
    const tracks = new Map<string, PostTrack>();
    for (const row of rows) {
      let track = tracks.get(row.postId);
      if (!track) {
        track = {
          provider: row.provider,
          okSnapshots: [],
          latestOk: null,
          hasAny: false,
        };
        tracks.set(row.postId, track);
      }
      track.hasAny = true;
      if (row.status === "ok") {
        const metrics = sanitizePostMetricValues(row.metrics) ?? {};
        track.okSnapshots.push({
          at: new Date(row.fetchedAt).getTime(),
          metrics,
        });
        track.latestOk = metrics;
      }
    }

    const byProvider = new Map<
      string,
      { postsWithSnapshots: number; posts: PostTrack[] }
    >();
    for (const track of tracks.values()) {
      if (!track.hasAny) continue;
      let bucket = byProvider.get(track.provider);
      if (!bucket) {
        bucket = { postsWithSnapshots: 0, posts: [] };
        byProvider.set(track.provider, bucket);
      }
      bucket.postsWithSnapshots += 1;
      bucket.posts.push(track);
    }

    const platforms: PostPlatformAnalyticsEntryData[] = [];
    for (const [provider, bucket] of byProvider) {
      if (!KNOWN_PROVIDERS.has(provider)) continue;
      const totals: PostMetricValues = {};
      let postsWithMetrics = 0;
      for (const track of bucket.posts) {
        if (track.latestOk) {
          postsWithMetrics += 1;
          addMetricsInto(totals, track.latestOk);
        }
      }
      const daily: Array<{ date: string; metrics: PostMetricValues }> = [];
      for (let i = 0; i < days; i++) {
        const dayStart = new Date(windowStart.getTime() + i * DAY_MS);
        const dayEndMs = dayStart.getTime() + DAY_MS - 1;
        const metrics: PostMetricValues = {};
        for (const track of bucket.posts) {
          // Snapshot ok terakhir pada/sebelum akhir hari ini.
          let value: PostMetricValues | null = null;
          for (const snap of track.okSnapshots) {
            if (snap.at <= dayEndMs) value = snap.metrics;
            else break;
          }
          if (value) addMetricsInto(metrics, value);
        }
        daily.push({ date: utcDayKey(dayStart), metrics });
      }
      platforms.push({
        provider,
        metricsSupported:
          POST_PROVIDER_METRICS_CAPABILITIES[provider as ChannelProvider]
            .metricsSupported,
        postsWithSnapshots: bucket.postsWithSnapshots,
        postsWithMetrics,
        totals,
        daily,
      });
    }
    platforms.sort((a, b) => a.provider.localeCompare(b.provider));
    return { days, platforms };
  });
}
