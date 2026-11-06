/**
 * Verifikasi observability & rate limit HTTP (Fase 16A) — tanpa server,
 * tanpa DB, tanpa Redis. Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan kontrak yang mudah rusak tanpa disadari:
 *  - /health tetap liveness murni dan mengembalikan x-request-id,
 *  - x-request-id dari klien dipertahankan bila bentuknya wajar,
 *  - header keamanan terpasang,
 *  - /ready menjawab 503 + checks.database="not_configured" tanpa DB,
 *  - route tak dikenal menjawab 404 berbentuk kontrak (bukan teks Hono),
 *  - limiter mengembalikan 429 + Retry-After + X-RateLimit-* saat batas
 *    terlampaui, dan TIDAK menghitung preflight OPTIONS.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:http
 */
import { Hono } from "hono";
import { createRateLimiter } from "../src/rate-limit";

// NODE_ENV=test mencegah index.ts memanggil serve(); env DB tidak diisi
// sehingga jalur "not_configured" yang diuji. LOG_LEVEL=error menjaga
// keluaran CI tetap terbaca (access log tidak perlu saat uji kontrak).
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
delete process.env.DATABASE_URL;
delete process.env.BETTER_AUTH_SECRET;
delete process.env.REDIS_URL;

const { app } = await import("../src/index");

let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1;
  else process.exitCode = 1;
}
function header(res: Response, name: string): string {
  return res.headers.get(name) ?? "";
}

const health = await app.request("/health");
const healthBody = (await health.json()) as { status?: string };
check("GET /health → 200", health.status === 200, `status=${health.status}`);
check("health status=ok", healthBody.status === "ok");
check("health punya x-request-id", /^[0-9a-f-]{36}$/.test(header(health, "x-request-id")));

const echoed = await app.request("/health", {
  headers: { "x-request-id": "trace-abc.123" },
});
check(
  "x-request-id klien dipertahankan",
  header(echoed, "x-request-id") === "trace-abc.123",
  header(echoed, "x-request-id"),
);

const maliciousId = await app.request("/health", {
  headers: { "x-request-id": "id with spaces & <script>" },
});
check(
  "x-request-id tidak wajar diganti UUID",
  maliciousId.headers.get("x-request-id") !== "id with spaces & <script>",
);

check(
  "header X-Content-Type-Options: nosniff",
  header(health, "x-content-type-options") === "nosniff",
  header(health, "x-content-type-options"),
);
check(
  "header X-Frame-Options terpasang",
  header(health, "x-frame-options").length > 0,
  header(health, "x-frame-options"),
);
check(
  "header Content-Security-Policy terpasang",
  header(health, "content-security-policy").includes("default-src 'self'"),
);

const ready = await app.request("/ready");
const readyBody = (await ready.json()) as {
  status?: string;
  checks?: { database?: string; redis?: string };
};
check("GET /ready tanpa DB → 503", ready.status === 503, `status=${ready.status}`);
check("ready status=degraded", readyBody.status === "degraded");
check("ready database=not_configured", readyBody.checks?.database === "not_configured");
check("ready redis=not_configured", readyBody.checks?.redis === "not_configured");

const notFound = await app.request("/tidak-ada-route-ini");
const notFoundBody = (await notFound.json()) as { error?: { code?: string } };
check("route tak dikenal → 404", notFound.status === 404, `status=${notFound.status}`);
check("404 berbentuk kontrak NOT_FOUND", notFoundBody.error?.code === "NOT_FOUND");

const version = await app.request("/version");
const versionBody = (await version.json()) as { metaGraphApiVersion?: string };
check("GET /version → 200", version.status === 200);
check(
  "versi Meta ter-pin v26.0",
  versionBody.metaGraphApiVersion === "v26.0",
  String(versionBody.metaGraphApiVersion),
);

// --- Rate limiter (memori, tanpa Redis) -----------------------------------
const limited = new Hono();
const limiter = createRateLimiter({
  rules: { test: { limit: 2, windowSeconds: 60 } },
  now: () => 1_000_000,
});
limited.use("/x/*", limiter.middleware("test"));
limited.get("/x/ping", (c) => c.text("ok"));

const first = await limited.request("/x/ping");
const second = await limited.request("/x/ping");
const third = await limited.request("/x/ping");
const preflight = await limited.request("/x/ping", { method: "OPTIONS" });

check("limiter: request ke-1 & ke-2 lolos", first.status === 200 && second.status === 200);
check(
  "limiter: request ke-3 → 429",
  third.status === 429,
  `status=${third.status}`,
);
check(
  "limiter: 429 berbentuk RATE_LIMITED",
  ((await third.json()) as { error?: { code?: string } }).error?.code === "RATE_LIMITED",
);
check("limiter: Retry-After terisi", Number(third.headers.get("retry-after")) > 0);
check(
  "limiter: X-RateLimit-Remaining=0 pada 429",
  third.headers.get("x-ratelimit-remaining") === "0",
  String(third.headers.get("x-ratelimit-remaining")),
);
check(
  "limiter: OPTIONS tidak dihitung",
  preflight.status !== 429,
  `status=${preflight.status}`,
);
// Fase 16H: tanpa Redis, penghitung memang per proses — dan respons harus
// mengatakannya. Batas efektif lintas replika menjadi `limit × replika`;
// menyembunyikan itu berarti membiarkan angka `Limit` berbohong.
check(
  "limiter: X-RateLimit-Scope=process tanpa Redis",
  first.headers.get("x-ratelimit-scope") === "process",
  String(first.headers.get("x-ratelimit-scope")),
);

limiter.close();

// Fase 18: route media tanpa DB/penyimpanan harus MENOLAK dengan bentuk
// kontrak, bukan 500 atau — lebih buruk — 200 kosong. Gelembung gambar
// di inbox akan tampak rusak tanpa penjelasan kalau ini salah.
const mediaNoStore = await app.request(
  "/api/tenants/11111111-1111-4111-8111-111111111111/media/22222222-2222-4222-8222-222222222222",
);
check(
  "media: tanpa penyimpanan → 503",
  mediaNoStore.status === 503,
  `status=${mediaNoStore.status}`,
);
check(
  "media: 503 berbentuk INTERNAL_ERROR",
  ((await mediaNoStore.json()) as { error?: { code?: string } }).error?.code ===
    "INTERNAL_ERROR",
);
check(
  "media: respons 503 tetap nosniff",
  header(mediaNoStore, "x-content-type-options") === "nosniff",
);

console.log(`\nverify-http: ${passes} PASS${process.exitCode ? " (ADA FAIL)" : ""}`);
