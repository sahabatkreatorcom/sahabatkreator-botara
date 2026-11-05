import { createEphemeralRedisConnection } from "@sahabat-kreator/queue";

/**
 * Penyimpanan nonce + sesi alur OAuth (dipakai Meta OAuth 7D dan
 * koneksi Google Calendar 13G).
 *
 * Latar belakang: state OAuth harus **sekali pakai** dan **lintas
 * replika**. Dua modul ini semula punya salinan sendiri; modul Meta
 * memakai Redis dengan fallback Map, modul janji temu memakai Map proses
 * saja. Konsekuensi versi Map-saja: bila API berjalan lebih dari satu
 * replika (atau proses restart di antara "connect" dan "callback"),
 * callback ditolak `GOOGLE_STATE_INVALID` walau penggunanya tidak salah
 * apa pun — bug yang hanya muncul di produksi.
 *
 * Karena itu satu implementasi dipakai bersama:
 * - `claimNonce` = `SET key 1 EX ttl NX` (atomik; false bila sudah ada).
 * - `consumeNonce` = `GETDEL` (atomik; true hanya untuk pemakaian
 *   pertama) — mencegah replay state yang sudah terpakai.
 * - sesi OAuth disimpan sebagai blob terenkripsi pemanggil (store ini
 *   tidak pernah membaca isinya).
 *
 * PELAJARAN INSIDEN 2026-11-03 (hotfix): fallback per-operasi ke Map
 * proses adalah perangkap otak-terbelah (split-brain). Klien Redis
 * "ephemeral" bisa mati diam-diam (socket basi sesudah idle/restart —
 * perintah pertama yang menyentuhnya melempar "Stream isn't writeable
 * and enableOfflineQueue options is false") sementara server Redis-nya
 * sendiri sehat. Saat itu `claimNonce` jatuh ke Map; semenit kemudian
 * klien pulih sendiri (reconnect ioredis) dan `consumeNonce` membaca
 * Redis yang kosong → nonce sah ditolak `META_OAUTH_STATE_INVALID`
 * ("This Facebook sign-in link has expired or was already used").
 * Arah sebaliknya sama fatalnya. Karena itu semantiknya sekarang:
 *
 * 1. RETRY KONEKSI SEGAR — perintah yang gagal pada klien basi dibuang
 *    kliennya dan diulang SATU kali pada koneksi baru sebelum fallback
 *    apa pun dipakai. Mayoritas "Redis mati" di jalur ini adalah
 *    socket basi, bukan server mati, jadi retry ini menutup jendela
 *    split-brain yang paling umum.
 * 2. CERMIN MEMORI (write-through) — klaim/sesi yang berhasil ditulis
 *    ke Redis juga dicerminkan ke Map proses (TTL sama). Baca selalu
 *    mencoba Redis dulu; meleset (null) atau gagal (sesudah retry)
 *    baru membaca cermin. Dengan begitu nilai yang ditulis di SATU
 *    keadaan dunia tetap ditemukan di keadaan lainnya.
 * 3. NISAN KONSUMSI (tombstone) — nonce yang terkonsumsi lewat cermin
 *    saat Redis mati dicatat sebagai "sudah terpakai" di memori,
 *    supaya salinan Redis-nya yang tertinggal (baru bisa dihapus saat
 *    Redis pulih) tidak bisa diputar ulang sesudah Redis hidup lagi.
 *    Sekali-pakai tetap berlaku di semua transisi naik/turun.
 *
 * Tetap FAIL-SOFT (bukan fail-open): nonce yang tidak ditemukan di
 * kedua store DITOLAK — pengguna mengulang "connect". Peringatan
 * "Redis tidak tersedia" dicatat sekali saja, dan sekarang hanya
 * menyala bila sebuah operasi benar-benar mendarat di fallback sesudah
 * retry koneksi segar pun gagal.
 *
 * Catatan: `createEphemeralRedisConnection` dipakai karena ini jalur
 * request — perintah tidak boleh menggantung menunggu Redis yang mati.
 */

/** Kontrak penyimpanan nonce + sesi OAuth. */
export interface OAuthKvStore {
  /** Klaim nonce baru; false bila nonce sudah pernah diklaim. */
  claimNonce(nonce: string): Promise<boolean>;
  /** Konsumsi nonce secara atomik; true hanya untuk pemakaian pertama. */
  consumeNonce(nonce: string): Promise<boolean>;
  putSession(id: string, encryptedPayload: string): Promise<void>;
  getSession(id: string): Promise<string | null>;
  deleteSession(id: string): Promise<void>;
}

/** Bentuk struktural minimum klien ioredis yang dipakai store ini. */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  del(key: string): Promise<number>;
  getdel(key: string): Promise<string | null>;
  /** ioredis adalah EventEmitter; listener "error" wajib ada agar event
   * error koneksi tidak menjadi unhandled error yang menjatuhkan proses. */
  on?(event: "error", listener: (err: unknown) => void): void;
  disconnect?(): void;
}

export interface OAuthKvStoreOptions {
  /** Prefiks key Redis, mis. `meta-oauth` → `meta-oauth:nonce:<n>`. */
  namespace: string;
  /** Umur nonce & sesi (detik). */
  ttlSeconds: number;
  /**
   * Jahitan uji: pabrik klien Redis pengganti
   * `createEphemeralRedisConnection`. Produksi tidak pernah mengisinya.
   */
  clientFactory?: (redisUrl: string) => RedisLike;
}

/** Batas tunggu satu perintah Redis pada jalur request. */
const STORE_TIMEOUT_MS = 3_000;

async function withStoreTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("oauth_store_timeout")),
        STORE_TIMEOUT_MS,
      ),
    ),
  ]);
}

interface MemoryKv {
  store: OAuthKvStore;
  /** Nonce punya entri hidup (klaim aktif) di memori. */
  hasNonce(nonce: string): boolean;
  /** Nonce pernah terkonsumsi (nisan masih dalam TTL). */
  wasConsumed(nonce: string): boolean;
  /** Tanam entri nonce tanpa cek (cermin dari klaim Redis yang sukses). */
  plantNonce(nonce: string): void;
  /** Hapus entri nonce (sesudah konsumsi Redis yang sukses). */
  forgetNonce(nonce: string): void;
}

/**
 * Map proses dengan kedaluwarsa malas + nisan konsumsi. Dipakai sebagai
 * store tunggal (tanpa Redis), sebagai fallback, DAN sebagai cermin
 * write-through dari Redis — tiga peran itu berbagi semantik yang sama.
 */
function createMemoryKv(options: OAuthKvStoreOptions): MemoryKv {
  const nonces = new Map<string, number>();
  const consumed = new Map<string, number>();
  const sessions = new Map<string, { value: string; expiresAt: number }>();
  const alive = (expiresAt: number) => expiresAt > Date.now();
  const ttlMs = options.ttlSeconds * 1000;

  const hasNonce = (nonce: string): boolean => {
    const existing = nonces.get(nonce);
    return existing !== undefined && alive(existing);
  };
  const wasConsumed = (nonce: string): boolean => {
    const at = consumed.get(nonce);
    return at !== undefined && alive(at);
  };

  const store: OAuthKvStore = {
    async claimNonce(nonce) {
      if (hasNonce(nonce) || wasConsumed(nonce)) return false;
      nonces.set(nonce, Date.now() + ttlMs);
      return true;
    },
    async consumeNonce(nonce) {
      if (wasConsumed(nonce)) return false;
      const existing = nonces.get(nonce);
      if (existing === undefined) return false;
      nonces.delete(nonce);
      // Nisan: salinan di store lain (Redis) yang mungkin tertinggal
      // tidak boleh bisa diputar ulang sesudah ini.
      consumed.set(nonce, Date.now() + ttlMs);
      return alive(existing);
    },
    async putSession(id, encryptedPayload) {
      sessions.set(id, {
        value: encryptedPayload,
        expiresAt: Date.now() + ttlMs,
      });
    },
    async getSession(id) {
      const entry = sessions.get(id);
      if (!entry) return null;
      if (!alive(entry.expiresAt)) {
        sessions.delete(id);
        return null;
      }
      return entry.value;
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
  };

  return {
    store,
    hasNonce,
    wasConsumed,
    plantNonce(nonce) {
      nonces.set(nonce, Date.now() + ttlMs);
    },
    forgetNonce(nonce) {
      nonces.delete(nonce);
    },
  };
}

/**
 * Membuat store OAuth. Tanpa `redisUrl` (pengembangan lokal tanpa Redis)
 * langsung memakai Map proses; dengan `redisUrl` memakai Redis sebagai
 * sumber utama dengan cermin + fallback Map (lihat catatan insiden di
 * kepala berkas untuk semantik lengkapnya).
 */
export function createOAuthKvStore(
  redisUrl: string | undefined,
  options: OAuthKvStoreOptions,
): OAuthKvStore {
  const memory = createMemoryKv(options);
  if (!redisUrl) return memory.store;

  const makeClient: (url: string) => RedisLike =
    options.clientFactory ??
    ((url) => createEphemeralRedisConnection(url) as unknown as RedisLike);

  let client: RedisLike | null = null;
  let warned = false;

  const redis = (): RedisLike => {
    if (!client) {
      client = makeClient(redisUrl);
      // Kegagalan koneksi dilaporkan lewat penolakan perintah; listener
      // ini hanya mencegah event "error" ioredis menjadi unhandled.
      client.on?.("error", () => {
        /* ditangani sebagai fallback di jalur operasi */
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

  const warnOnce = (err: unknown): void => {
    if (warned) return;
    warned = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[${options.namespace}] Redis tidak tersedia — nonce/sesi OAuth dialihkan ke memori proses sementara: ${message}`,
    );
  };

  const nonceKey = (nonce: string) => `${options.namespace}:nonce:${nonce}`;
  const sessionKey = (id: string) => `${options.namespace}:session:${id}`;

  /**
   * Jalankan operasi pada Redis. Kegagalan pertama dianggap socket
   * basi: buang klien, ulang SATU kali pada koneksi segar. Hanya
   * kegagalan retry yang dilempar ke pemanggil (yang lalu memakai
   * cermin/fallback memori) — dan hanya di titik itu peringatan
   * "tidak tersedia" dicatat.
   */
  const runRedis = async <T>(op: (c: RedisLike) => Promise<T>): Promise<T> => {
    try {
      return await withStoreTimeout(op(redis()));
    } catch {
      dropClient();
      try {
        return await withStoreTimeout(op(redis()));
      } catch (err) {
        warnOnce(err);
        throw err;
      }
    }
  };

  return {
    async claimNonce(nonce) {
      // Klaim yang masih hidup di cermin (klaim Redis terdahulu atau
      // klaim fallback saat Redis mati) tidak boleh diklaim ulang lewat
      // Redis yang baru pulih — Redis belum tentu tahu klaim fallback.
      if (memory.hasNonce(nonce) || memory.wasConsumed(nonce)) return false;
      try {
        const result = await runRedis((c) =>
          c.set(nonceKey(nonce), "1", "EX", options.ttlSeconds, "NX"),
        );
        if (result !== "OK") return false;
        memory.plantNonce(nonce);
        return true;
      } catch {
        return memory.store.claimNonce(nonce);
      }
    },
    async consumeNonce(nonce) {
      if (memory.wasConsumed(nonce)) {
        // Sudah terkonsumsi lewat cermin saat Redis mati. Bersihkan
        // salinan Redis yang tertinggal (best-effort) dan tetap tolak.
        try {
          await runRedis((c) => c.getdel(nonceKey(nonce)));
        } catch {
          /* pembersihan gagal tidak mengubah keputusan: tetap ditolak */
        }
        return false;
      }
      try {
        const value = await runRedis((c) => c.getdel(nonceKey(nonce)));
        if (value !== null) {
          memory.forgetNonce(nonce);
          return true;
        }
        // Redis sehat tapi tidak punya nonce ini — mungkin ia diklaim
        // ke cermin saat Redis mati (kasus regresi insiden 2026-11-03).
        return memory.store.consumeNonce(nonce);
      } catch {
        // Redis benar-benar mati sesudah retry: cermin adalah satu-
        // satunya harapan, dan klaim Redis pun tercermin di sana.
        return memory.store.consumeNonce(nonce);
      }
    },
    async putSession(id, encryptedPayload) {
      try {
        await runRedis((c) =>
          c.set(sessionKey(id), encryptedPayload, "EX", options.ttlSeconds),
        );
        await memory.store.putSession(id, encryptedPayload);
      } catch {
        await memory.store.putSession(id, encryptedPayload);
      }
    },
    async getSession(id) {
      try {
        const value = await runRedis((c) => c.get(sessionKey(id)));
        if (value !== null) return value;
        return memory.store.getSession(id);
      } catch {
        return memory.store.getSession(id);
      }
    },
    async deleteSession(id) {
      // Hapus dari KEDUA store: sesi tidak boleh hidup lagi hanya
      // karena salah satu salinannya tertinggal.
      try {
        await runRedis((c) => c.del(sessionKey(id)));
      } catch {
        /* Redis mati — cermin tetap dibersihkan di bawah */
      }
      await memory.store.deleteSession(id);
    },
  };
}
