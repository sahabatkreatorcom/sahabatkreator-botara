import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRateLimiter } from "./rate-limit";

/**
 * Degradasi rate limit harus TERBACA (Fase 16H).
 *
 * Saat Redis mati, limiter fail-open ke memori per proses — keputusan
 * yang disengaja: menolak semua request karena Redis bermasalah lebih
 * merugikan daripada batas yang sementara melemah. Yang tidak boleh
 * terjadi adalah melemahnya tanpa jejak. `limit × jumlah replika` adalah
 * batas efektif yang berbeda dari yang tertulis di `X-RateLimit-Limit`,
 * dan satu baris log mudah terlewat.
 *
 * Diuji dengan Redis yang TIDAK ADA (port 1) — bukan tiruan: yang
 * dibuktikan adalah perilaku nyata klien saat koneksi ditolak.
 */

function build(redisUrl: string | undefined, limit: number) {
  const app = new Hono();
  const warnings: Array<{ event: string; meta: unknown }> = [];
  const limiter = createRateLimiter({
    redisUrl,
    rules: { test: { limit, windowSeconds: 60 } },
    now: () => 1_000_000,
    logger: {
      warn: (event: string, meta?: unknown) => {
        warnings.push({ event, meta });
      },
    } as never,
  });
  app.use("/x/*", limiter.middleware("test"));
  app.get("/x/ping", (c) => c.text("ok"));
  return { app, limiter, warnings };
}

describe("rate limit: cakupan penghitung", () => {
  it("melabeli respons sebagai process saat Redis tidak dapat dihubungi", async () => {
    const { app, limiter } = build("redis://127.0.0.1:1", 5);
    try {
      const res = await app.request("/x/ping");
      expect(res.status).toBe(200);
      // Inilah kontraknya: klien/operator bisa melihat bahwa angka
      // `Limit` yang sama berlaku per proses, bukan lintas replika.
      expect(res.headers.get("x-ratelimit-scope")).toBe("process");
    } finally {
      limiter.close();
    }
  });

  it("tetap menegakkan batas meski sedang terdegradasi", async () => {
    // Fail-open BUKAN fail-off: kalau ini lolos, satu IP bisa membanjiri
    // satu replika tanpa batas sama sekali selama Redis mati.
    const { app, limiter } = build("redis://127.0.0.1:1", 2);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push((await app.request("/x/ping")).status);
      }
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      limiter.close();
    }
  });

  it("mencatat degradasi sekali, dengan cakupan yang dijelaskan", async () => {
    const { app, limiter, warnings } = build("redis://127.0.0.1:1", 5);
    try {
      await app.request("/x/ping");
      await app.request("/x/ping");
      const redisWarnings = warnings.filter(
        (w) => w.event === "ratelimit.redis_unavailable",
      );
      // Sekali per periode degradasi: peringatan per request akan
      // menenggelamkan log justru saat insiden.
      expect(redisWarnings).toHaveLength(1);
      expect(redisWarnings[0]!.meta).toMatchObject({ degradedScope: "process" });
    } finally {
      limiter.close();
    }
  });

  it("melabeli process juga saat Redis memang tidak dikonfigurasi", async () => {
    // Mode pengembangan tanpa Redis: perilakunya sama-sama per proses,
    // jadi labelnya harus jujur, bukan "global" karena tidak ada error.
    const { app, limiter } = build(undefined, 5);
    try {
      const res = await app.request("/x/ping");
      expect(res.headers.get("x-ratelimit-scope")).toBe("process");
    } finally {
      limiter.close();
    }
  });
});
