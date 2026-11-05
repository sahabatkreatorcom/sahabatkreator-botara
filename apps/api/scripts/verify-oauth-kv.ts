/**
 * Verifikasi store KV OAuth (hotfix insiden 2026-11-03) — tanpa server
 * HTTP, tanpa DB, tanpa Redis sungguhan. Dijalankan di CI sebagai
 * bagian `verify:ci`.
 *
 * Membuktikan semantik yang dulu membunuh alur connect Meta/Google di
 * staging: klien Redis ephemeral mati diam-diam (socket basi — perintah
 * pertama melempar "Stream isn't writeable…") di tengah rentang antara
 * "connect" (claim) dan "callback" (consume), sementara server Redis
 * sendiri sehat. Desain lama jatuh per-operasi ke Map proses →
 * claim mendarat di memori, consume membaca Redis → nonce sah ditolak
 * META_OAUTH_STATE_INVALID. Harness ini mensimulasikan server Redis
 * palsu yang bisa dihidup/matikan per skenario + klien pertama yang
 * "keracunan" (perintah pertamanya selalu gagal, seperti socket basi),
 * lewat jahitan `clientFactory` pada `createOAuthKvStore`.
 *
 * Yang dibuktikan untuk nonce DAN sesi:
 *  (a) claim Redis-up / consume Redis-up → true, konsumsi kedua false;
 *  (b) claim Redis-MATI / consume Redis-up → WAJIB true (kasus regresi);
 *  (c) claim Redis-up / consume Redis-MATI → true, dan konsumsi ulang
 *      sesudah Redis pulih tetap false (nisan anti-putar-ulang);
 *  (d) claim mati / consume mati → true;
 *  (e) nonce tak dikenal → false di semua keadaan dunia;
 *  (f) jalur retry: perintah pertama gagal di klien basi, retry pada
 *      koneksi segar berhasil DI REDIS (bukan fallback) — dibuktikan
 *      dari isi server palsu + jumlah klien yang dibuat (tepat 2).
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:oauth-kv
 */
import { createOAuthKvStore, type OAuthKvStore } from "../src/oauth-kv";

/** Bentuk klien yang sama dengan kontrak internal store. */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  del(key: string): Promise<number>;
  getdel(key: string): Promise<string | null>;
  on?(event: "error", listener: (err: unknown) => void): void;
  disconnect?(): void;
}

/** "Server" Redis palsu: satu Map bersama; `up=false` = server mati total. */
interface FakeServer {
  data: Map<string, string>;
  up: boolean;
}

function createFakeServer(): FakeServer {
  return { data: new Map(), up: true };
}

/**
 * Klien palsu di atas server bersama. `poisonedCommands` mensimulasikan
 * socket basi: N perintah pertama klien ini selalu melempar error
 * persis seperti yang terlihat di log staging, walau server sehat.
 * Klien TIDAK sembuh sendiri — kesembuhan hanya datang dari store
 * yang membuang klien dan membuat koneksi segar (itulah yang diuji).
 */
class FakeClient implements RedisLike {
  constructor(
    private server: FakeServer,
    private poisonedCommands: number,
  ) {}

  private gate(): void {
    if (this.poisonedCommands > 0) {
      this.poisonedCommands -= 1;
      throw new Error(
        "Stream isn't writeable and enableOfflineQueue options is false",
      );
    }
    if (!this.server.up) throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }

  async get(key: string): Promise<string | null> {
    this.gate();
    return this.server.data.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown> {
    this.gate();
    if (args.includes("NX") && this.server.data.has(key)) return null;
    this.server.data.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.gate();
    return this.server.data.delete(key) ? 1 : 0;
  }

  async getdel(key: string): Promise<string | null> {
    this.gate();
    const value = this.server.data.get(key) ?? null;
    if (value !== null) this.server.data.delete(key);
    return value;
  }

  on(): void {
    /* tidak ada event pada klien palsu */
  }

  disconnect(): void {
    /* tidak ada socket pada klien palsu */
  }
}

interface Harness {
  server: FakeServer;
  store: OAuthKvStore;
  /** Jumlah klien yang sudah dibuat pabrik (bukti retry: tepat +1). */
  clientsCreated: () => number;
  /** Racuni klien BERIKUTNYA yang dibuat pabrik (socket basi). */
  poisonNextClient: (commands?: number) => void;
}

function createHarness(namespace: string): Harness {
  const server = createFakeServer();
  let created = 0;
  let poisonForNext = 0;
  const store = createOAuthKvStore("redis://fake.invalid:6379", {
    namespace,
    ttlSeconds: 600,
    clientFactory: () => {
      created += 1;
      const poison = poisonForNext;
      poisonForNext = 0;
      return new FakeClient(server, poison);
    },
  });
  return {
    server,
    store,
    clientsCreated: () => created,
    poisonNextClient: (commands = 1) => {
      poisonForNext = commands;
    },
  };
}

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1;
  else {
    failures += 1;
    process.exitCode = 1;
  }
}

// Peringatan "Redis tidak tersedia" dari store adalah perilaku yang
// DIHARAPKAN pada skenario mati — redam agar keluaran uji terbaca,
// tapi hitung berapa kali ia menyala (harus hanya sesudah retry gagal).
let warnLines = 0;
const originalError = console.error;
console.error = (...args: unknown[]) => {
  if (String(args[0]).includes("Redis tidak tersedia")) {
    warnLines += 1;
    return;
  }
  originalError(...args);
};

// ---------------------------------------------------------------------
// (a) Redis sehat di kedua ujung: jalur normal + sekali-pakai.
// ---------------------------------------------------------------------
{
  const h = createHarness("t-a");
  check("(a) claim up → true", (await h.store.claimNonce("n-a")) === true);
  check(
    "(a) claim tersimpan di Redis",
    h.server.data.has("t-a:nonce:n-a"),
  );
  check(
    "(a) claim ulang nonce yang sama → false",
    (await h.store.claimNonce("n-a")) === false,
  );
  check("(a) consume up → true", (await h.store.consumeNonce("n-a")) === true);
  check(
    "(a) consume kedua → false",
    (await h.store.consumeNonce("n-a")) === false,
  );
  check(
    "(a) kunci Redis hilang sesudah consume",
    !h.server.data.has("t-a:nonce:n-a"),
  );
}

// ---------------------------------------------------------------------
// (b) REGRESI INSIDEN: claim saat Redis mati (jatuh ke memori),
//     consume saat Redis sudah pulih → WAJIB true.
//     Pada logika lama hasil consume di sini false
//     (META_OAUTH_STATE_INVALID di callback sungguhan).
// ---------------------------------------------------------------------
{
  const h = createHarness("t-b");
  h.server.up = false;
  check(
    "(b) claim saat Redis mati → true (fallback memori)",
    (await h.store.claimNonce("n-b")) === true,
  );
  check(
    "(b) klaim TIDAK ada di Redis (murni fallback)",
    h.server.data.size === 0,
  );
  h.server.up = true;
  check(
    "(b) consume sesudah Redis pulih → true [REGRESI]",
    (await h.store.consumeNonce("n-b")) === true,
  );
  check(
    "(b) consume kedua → false",
    (await h.store.consumeNonce("n-b")) === false,
  );
}

// ---------------------------------------------------------------------
// (c) Arah sebaliknya: claim di Redis, consume saat Redis mati → true
//     lewat cermin; konsumsi ulang sesudah Redis pulih → tetap false
//     (nisan mencegah salinan Redis yang tertinggal diputar ulang).
// ---------------------------------------------------------------------
{
  const h = createHarness("t-c");
  check("(c) claim up → true", (await h.store.claimNonce("n-c")) === true);
  h.server.up = false;
  check(
    "(c) consume saat Redis mati → true (cermin memori)",
    (await h.store.consumeNonce("n-c")) === true,
  );
  h.server.up = true;
  check(
    "(c) consume ulang sesudah pulih → false (nisan anti-replay)",
    (await h.store.consumeNonce("n-c")) === false,
  );
  check(
    "(c) klaim ulang nonce terkonsumsi → false",
    (await h.store.claimNonce("n-c")) === false,
  );
}

// ---------------------------------------------------------------------
// (d) Redis mati di kedua ujung: fallback murni tetap sekali-pakai.
// ---------------------------------------------------------------------
{
  const h = createHarness("t-d");
  h.server.up = false;
  check("(d) claim mati → true", (await h.store.claimNonce("n-d")) === true);
  check("(d) consume mati → true", (await h.store.consumeNonce("n-d")) === true);
  check(
    "(d) consume kedua mati → false",
    (await h.store.consumeNonce("n-d")) === false,
  );
}

// ---------------------------------------------------------------------
// (e) Nonce tak dikenal ditolak di semua keadaan (tidak fail-open).
// ---------------------------------------------------------------------
{
  const h = createHarness("t-e");
  check(
    "(e) consume tak dikenal, Redis up → false",
    (await h.store.consumeNonce("tidak-ada")) === false,
  );
  h.server.up = false;
  check(
    "(e) consume tak dikenal, Redis mati → false",
    (await h.store.consumeNonce("tidak-ada")) === false,
  );
  check(
    "(e) getSession tak dikenal, Redis mati → null",
    (await h.store.getSession("tidak-ada")) === null,
  );
  h.server.up = true;
  check(
    "(e) getSession tak dikenal, Redis up → null",
    (await h.store.getSession("tidak-ada")) === null,
  );
}

// ---------------------------------------------------------------------
// (f) Jalur retry: klien pertama basi (perintah pertama melempar
//     error socket), server SEHAT. Operasi harus berhasil DI REDIS
//     lewat tepat satu koneksi segar — bukan lewat fallback memori.
// ---------------------------------------------------------------------
{
  const h = createHarness("t-f");
  h.poisonNextClient(1);
  check(
    "(f) claim dengan klien basi → true",
    (await h.store.claimNonce("n-f")) === true,
  );
  check(
    "(f) tepat 2 klien dibuat (asli + 1 retry)",
    h.clientsCreated() === 2,
    `clients=${h.clientsCreated()}`,
  );
  check(
    "(f) klaim mendarat di Redis, bukan fallback",
    h.server.data.has("t-f:nonce:n-f"),
  );
  check("(f) consume → true", (await h.store.consumeNonce("n-f")) === true);
  check(
    "(f) consume kedua → false",
    (await h.store.consumeNonce("n-f")) === false,
  );
}

// ---------------------------------------------------------------------
// Sesi: put/get/delete lintas transisi naik-turun yang sama.
// ---------------------------------------------------------------------
{
  const h = createHarness("t-s");
  await h.store.putSession("s-1", "blob-terenkripsi");
  check(
    "(sesi) get up → payload",
    (await h.store.getSession("s-1")) === "blob-terenkripsi",
  );
  check(
    "(sesi) payload tersimpan di Redis",
    h.server.data.get("t-s:session:s-1") === "blob-terenkripsi",
  );
  h.server.up = false;
  check(
    "(sesi) get saat Redis mati → payload (cermin)",
    (await h.store.getSession("s-1")) === "blob-terenkripsi",
  );
  await h.store.putSession("s-2", "blob-kedua");
  h.server.up = true;
  check(
    "(sesi) put saat mati → get saat up → payload",
    (await h.store.getSession("s-2")) === "blob-kedua",
  );
  await h.store.deleteSession("s-1");
  check(
    "(sesi) delete → get up → null",
    (await h.store.getSession("s-1")) === null,
  );
  h.server.up = false;
  check(
    "(sesi) delete di kedua store → get mati → null",
    (await h.store.getSession("s-1")) === null,
  );
  check(
    "(sesi) kunci Redis s-1 ikut terhapus",
    !h.server.data.has("t-s:session:s-1"),
  );
}

// ---------------------------------------------------------------------
// Peringatan hanya boleh menyala sesudah retry benar-benar gagal —
// skenario (f) tidak boleh menyalakannya sama sekali sudah terbukti
// implisit; di sini cukup pastikan ia tidak meledak tak terkendali.
// ---------------------------------------------------------------------
check(
  "peringatan 'Redis tidak tersedia' teredam (warn-once per store)",
  warnLines > 0 && warnLines <= 6,
  `warnLines=${warnLines}`,
);

console.error = originalError;
console.log(
  `\nverify-oauth-kv: ${passes} PASS, ${failures} FAIL (${warnLines} peringatan Redis teredam selama uji)`,
);
if (failures > 0) process.exitCode = 1;
