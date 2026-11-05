/**
 * Readiness check (Fase 16A) — pisahkan "proses hidup" dari "siap melayani".
 *
 * `/health` tetap liveness murni (tanpa I/O) agar restart loop tidak
 * dipicu oleh DB yang sedang pulih. `/ready` memeriksa dependensi dengan
 * timeout pendek dan mengembalikan 503 saat tidak siap, sehingga load
 * balancer/orchestrator menarik replika dari rotasi.
 */
import type { ReadinessCheck } from "@sahabat-kreator/contracts";

/** Batas waktu satu pemeriksaan dependensi; cukup longgar untuk DB lokal. */
export const READINESS_TIMEOUT_MS = 1_500;

/** Menjalankan promise dengan batas waktu; timer tidak menahan proses. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Subset pool pg yang dipakai readiness — tanpa impor tipe `pg` di app. */
export interface ReadinessPool {
  query(sql: string): Promise<unknown>;
}

/** `SELECT 1` dengan timeout. Pool null = mode tanpa DB (Fase 0/dev). */
export async function checkDatabase(pool: ReadinessPool | null): Promise<ReadinessCheck> {
  if (!pool) return "not_configured";
  try {
    await withTimeout(pool.query("select 1"), READINESS_TIMEOUT_MS, "database");
    return "ok";
  } catch {
    return "error";
  }
}

/**
 * Gabungkan hasil pemeriksaan.
 *
 * - DB wajib untuk melayani request apa pun yang menyentuh data: bila
 *   `not_configured`, API tetap "hidup" tetapi TIDAK siap → degraded.
 * - Redis tidak wajib untuk liveness API (rate limit & realtime fail-open),
 *   tetapi di produksi ketiadaannya berarti antrean/outbox tidak berjalan
 *   → degraded.
 */
export function combineReadiness(
  database: ReadinessCheck,
  redis: ReadinessCheck,
  opts: { requireRedis: boolean },
): { status: "ok" | "degraded"; ok: boolean } {
  const redisOk = redis === "ok" || (!opts.requireRedis && redis === "not_configured");
  const ok = database === "ok" && redisOk;
  return { status: ok ? "ok" : "degraded", ok };
}
