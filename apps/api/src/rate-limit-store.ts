import { createEphemeralRedisConnection } from "@sahabat-kreator/queue";

/**
 * Penyimpanan rate limit Better Auth di Redis (Fase 13D).
 *
 * Latar belakang: `rateLimit` Better Auth bawaannya in-memory PER PROSES
 * (`apps/api/src/auth.ts` mencatatnya sendiri). Dampaknya:
 * - penghitung reset setiap API restart, dan
 * - setiap replika punya ember sendiri, sehingga batas efektif menjadi
 *   `max × jumlah replika`.
 *
 * Better Auth menerima `rateLimit.customStorage` — objek `{ get, set }`
 * dengan bentuk record `{ key, count, lastRequest }`. Kita memakai jalur
 * itu (BUKAN `secondaryStorage`) supaya SESI tetap sepenuhnya di
 * Postgres dan tidak ada perilaku auth lain yang ikut berubah.
 *
 * Semantik yang dipertahankan persis seperti storage bawaan:
 * - `get` mengembalikan record mentah; Better Auth sendiri yang menilai
 *   kedaluwarsa lewat `lastRequest + window` (`shouldRateLimit`), jadi
 *   TTL Redis di sini hanya pembersih memori, bukan penentu kebijakan.
 * - `set` dipanggil pada SETIAP request (menaikkan `count`), sehingga
 *   TTL ikut diperpanjang selama key aktif.
 *
 * Batasan jujur: `get` lalu `set` bukan operasi atomik, jadi beberapa
 * request yang benar-benar bersamaan dapat sedikit menggeser hitungan
 * (under-count). Ini tetap jauh lebih baik daripada ember terpisah per
 * proses, dan sesuai dengan kontrak storage yang disediakan library.
 *
 * FAIL-OPEN: setiap kegagalan Redis (mati, timeout, data rusak)
 * diperlakukan sebagai "tidak ada data" dan `set` menjadi no-op. Jalur
 * auth TIDAK PERNAH gagal karena Redis; kita hanya kehilangan rate
 * limit bersama untuk sementara. Kegagalan pertama dicatat ke stderr
 * sekali agar tidak membanjiri log.
 */

/** Bentuk record yang dipertukarkan dengan Better Auth. */
export interface RateLimitRecord {
  key: string;
  count: number;
  lastRequest: number;
}

/** Kontrak `rateLimit.customStorage` Better Auth (subset yang kita pakai). */
export interface RateLimitStorage {
  get(key: string): Promise<RateLimitRecord | null | undefined>;
  set(key: string, value: RateLimitRecord, update?: boolean): Promise<void>;
}

/** Bentuk struktural minimum klien ioredis yang dipakai store ini. */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  /** Lihat oauth-kv.ts: listener "error" mencegah unhandled error. */
  on?(event: "error", listener: (err: unknown) => void): void;
  disconnect?(): void;
}

/** Prefiks key agar tidak bertabrakan dengan pemakaian Redis lain. */
const KEY_PREFIX = "auth-rl:";

/**
 * Umur key di Redis (detik). Semua jendela rate limit kita ≤ 60 detik;
 * 5 menit memberi ruang aman sekaligus membersihkan key yang sudah
 * tidak aktif tanpa sweeper.
 */
const KEY_TTL_SECONDS = 300;

function parseRecord(raw: string, key: string): RateLimitRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.count !== "number" ||
    !Number.isFinite(record.count) ||
    typeof record.lastRequest !== "number" ||
    !Number.isFinite(record.lastRequest)
  ) {
    return null;
  }
  return { key, count: record.count, lastRequest: record.lastRequest };
}

/**
 * Membuat storage rate limit Redis, atau `null` bila `redisUrl` kosong
 * (mode pengembangan tanpa Redis — pemanggil mempertahankan storage
 * in-memory bawaan Better Auth).
 */
export function createRedisRateLimitStorage(
  redisUrl: string | undefined,
): RateLimitStorage | null {
  if (!redisUrl) return null;

  let client: RedisLike | null = null;
  let warned = false;

  const redis = (): RedisLike => {
    if (!client) {
      client = createEphemeralRedisConnection(redisUrl) as unknown as RedisLike;
      client.on?.("error", () => {
        /* kegagalan ditangani fail-open di get/set */
      });
    }
    return client;
  };

  const dropClient = (): void => {
    try {
      client?.disconnect?.();
    } catch {
      /* klien sudah mati — itulah sebabnya dibuang */
    }
    client = null;
  };

  /**
   * Jalankan perintah dengan SATU retry pada koneksi segar. Klien
   * ephemeral bisa mati diam-diam (socket basi sesudah idle) sementara
   * server Redis sehat — perintah pertama yang menyentuh mayatnya
   * gagal, padahal koneksi baru langsung berhasil. Pola yang sama
   * seperti hotfix oauth-kv (insiden 2026-11-03); di sini dampaknya
   * hanya fail-open yang tidak perlu, jadi cukup retry sebelum
   * menyerah. Kegagalan retry dilempar ke pemanggil (fail-open).
   */
  const run = async <T>(op: (c: RedisLike) => Promise<T>): Promise<T> => {
    try {
      return await op(redis());
    } catch {
      dropClient();
      return await op(redis());
    }
  };

  const warnOnce = (err: unknown): void => {
    if (warned) return;
    warned = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[rate-limit] Redis tidak tersedia — rate limit bersama dimatikan sementara (fail-open): ${message}`,
    );
  };

  return {
    async get(key) {
      try {
        const raw = await run((c) => c.get(`${KEY_PREFIX}${key}`));
        return raw === null ? null : parseRecord(raw, key);
      } catch (err) {
        warnOnce(err);
        return null;
      }
    },
    async set(key, value) {
      try {
        await run((c) =>
          c.set(
            `${KEY_PREFIX}${key}`,
            JSON.stringify({ count: value.count, lastRequest: value.lastRequest }),
            "EX",
            KEY_TTL_SECONDS,
          ),
        );
      } catch (err) {
        warnOnce(err);
      }
    },
  };
}
