/**
 * Rate limit in-app untuk permukaan publik (Fase 16A).
 *
 * Lapisan edge Cloudflare di docs/PRODUCTION.md §2 tetap dianjurkan, tetapi
 * TIDAK boleh menjadi satu-satunya perlindungan: konfigurasi edge hidup di
 * luar repo dan bisa belum terpasang. Middleware ini memberi batas dasar
 * yang selalu aktif untuk `/v1/*`, `/webchat/*`, `/pay/*`, dan `/go/*`.
 *
 * Semantik:
 * - Fixed window per (aturan, IP) — cukup untuk meredam banjir/abuse,
 *   bukan kuota billing.
 * - Redis lintas replika bila `REDIS_URL` ada (INCR + EXPIRE). Bila Redis
 *   gagal, limiter FAIL-OPEN ke memori per proses dan berhenti mencoba
 *   Redis selama 30 detik — request pengguna tidak pernah gagal karena
 *   Redis bermasalah (sama seperti rate limit auth di rate-limit-store.ts).
 * - `OPTIONS` tidak dihitung (preflight CORS widget).
 * - Respons 429 memakai kontrak `{ error: { code: "RATE_LIMITED" } }` plus
 *   `Retry-After` dan `X-RateLimit-*`.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Logger } from "@sahabat-kreator/config";
import { createEphemeralRedisConnection } from "@sahabat-kreator/queue";
import { apiError, type AppVariables } from "./http";
import { resolveClientIp } from "./observability";

/** Subset klien Redis yang dipakai — menjaga batas modul tetap tipis. */
interface RedisLike {
  status: string;
  on(event: "error", listener: (err: unknown) => void): void;
  connect(): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ping(): Promise<string>;
  disconnect(): void;
}

export interface RateLimitRule {
  /** Jumlah request maksimum per window per IP. */
  limit: number;
  /** Panjang window dalam detik. */
  windowSeconds: number;
}

export interface RateLimiterOptions {
  /** Redis opsional; tanpa ini limiter memakai memori per proses. */
  redisUrl?: string;
  rules: Record<string, RateLimitRule>;
  /** Prefix key Redis; default "sk:rl". */
  keyPrefix?: string;
  /** Sumber waktu (ms) — dipakai uji deterministik. */
  now?: () => number;
  logger?: Logger;
}

export interface RateLimiter {
  /** Middleware untuk satu nama aturan di `rules`. */
  middleware(ruleName: string): MiddlewareHandler<{ Variables: AppVariables }>;
  /** Status Redis untuk `/ready`: ok | error | not_configured. */
  health(): Promise<"ok" | "error" | "not_configured">;
  /** Tutup koneksi Redis (dipanggil saat shutdown/uji). */
  close(): void;
}

interface MemoryBucket {
  count: number;
  resetAt: number;
}

const REDIS_RETRY_AFTER_MS = 30_000;
const MEMORY_PRUNE_THRESHOLD = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const keyPrefix = options.keyPrefix ?? "sk:rl";
  const now = options.now ?? (() => Date.now());
  const memory = new Map<string, MemoryBucket>();
  let redis: RedisLike | null = null;
  let redisRetryAt = 0;
  let redisFailureLogged = false;

  if (options.redisUrl) {
    redis = spawnClient(options.redisUrl);
  }

  function spawnClient(url: string): RedisLike {
    const client = createEphemeralRedisConnection(url) as unknown as RedisLike;
    // Tanpa listener, event "error" ioredis akan menjadi unhandled error.
    client.on("error", () => {
      /* kegagalan ditangani fail-open di jalur request; jangan crash proses */
    });
    return client;
  }

  /** Buang klien basi dan buat koneksi segar (socket bisa mati diam-diam). */
  function resetClient(): void {
    if (!options.redisUrl) return;
    try {
      redis?.disconnect();
    } catch {
      /* sudah tertutup */
    }
    redis = spawnClient(options.redisUrl);
  }

  function logRedisFailure(reason: unknown): void {
    if (redisFailureLogged) return;
    redisFailureLogged = true;
    options.logger?.warn("ratelimit.redis_unavailable", {
      reason,
      retryAfterMs: REDIS_RETRY_AFTER_MS,
    });
  }

  async function ensureConnected(client: RedisLike): Promise<void> {
    if (client.status === "wait" || client.status === "end") {
      await client.connect();
    }
  }

  async function hitRedis(key: string, windowSeconds: number): Promise<MemoryBucket> {
    const client = redis;
    if (!client) throw new Error("redis not configured");
    await ensureConnected(client);
    const count = await client.incr(key);
    // TTL 2x window: key lama dibersihkan otomatis oleh Redis, bukan oleh
    // proses (tidak ada negara yang perlu dijaga di memori aplikasi).
    if (count === 1) await client.expire(key, windowSeconds * 2);
    return { count, resetAt: 0 };
  }

  function hitMemory(key: string, resetAt: number): MemoryBucket {
    const current = memory.get(key);
    if (!current || current.resetAt <= now()) {
      if (memory.size >= MEMORY_PRUNE_THRESHOLD) {
        const currentTime = now();
        for (const [bucketKey, bucket] of memory) {
          if (bucket.resetAt <= currentTime) memory.delete(bucketKey);
        }
      }
      const fresh: MemoryBucket = { count: 1, resetAt };
      memory.set(key, fresh);
      return fresh;
    }
    current.count += 1;
    return current;
  }

  async function take(
    bucketKey: string,
    windowSeconds: number,
    windowStart: number,
  ): Promise<MemoryBucket> {
    const resetAt = windowStart + windowSeconds * 1000;
    const key = `${keyPrefix}:${bucketKey}:${windowStart}`;

    if (redis && now() >= redisRetryAt) {
      try {
        const result = await hitRedis(key, windowSeconds);
        redisFailureLogged = false;
        return { count: result.count, resetAt };
      } catch (firstErr) {
        // Socket basi adalah penyebab tersering (server Redis sehat,
        // klien ephemeral mati sesudah idle — pola insiden oauth-kv
        // 2026-11-03): buang klien, ulang SATU kali pada koneksi
        // segar sebelum menyerah ke memori + backoff 30 detik.
        resetClient();
        try {
          const result = await hitRedis(key, windowSeconds);
          redisFailureLogged = false;
          return { count: result.count, resetAt };
        } catch {
          redisRetryAt = now() + REDIS_RETRY_AFTER_MS;
          logRedisFailure(firstErr);
        }
      }
    }

    return hitMemory(key, resetAt);
  }

  function middleware(
    ruleName: string,
  ): MiddlewareHandler<{ Variables: AppVariables }> {
    return async (c, next) => {
      const rule = options.rules[ruleName];
      if (!rule) return next();
      if (c.req.method === "OPTIONS") return next();

      const currentTime = now();
      const windowMs = rule.windowSeconds * 1000;
      const windowStart = Math.floor(currentTime / windowMs) * windowMs;
      const ip = resolveClientIp(c as Context);
      const result = await take(`${ruleName}:${ip}`, rule.windowSeconds, windowStart);

      const remaining = Math.max(0, rule.limit - result.count);
      c.header("X-RateLimit-Limit", String(rule.limit));
      c.header("X-RateLimit-Remaining", String(remaining));
      c.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

      if (result.count > rule.limit) {
        const retryAfter = Math.max(1, Math.ceil((result.resetAt - now()) / 1000));
        c.header("Retry-After", String(retryAfter));
        return apiError(c, 429, "RATE_LIMITED", "Too many requests");
      }

      return next();
    };
  }

  return {
    middleware,
    async health() {
      if (!redis) return "not_configured";
      try {
        await ensureConnected(redis);
        await redis.ping();
        return "ok";
      } catch {
        return "error";
      }
    },
    close() {
      try {
        redis?.disconnect();
      } catch {
        /* sudah tertutup */
      }
    },
  };
}
