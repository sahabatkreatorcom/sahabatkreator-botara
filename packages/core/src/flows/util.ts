/**
 * Helper kecil lintas modul flow: predikat string non-kosong, pengenal
 * bergaya UUID, dan pembaca durasi parkir dari config node.
 *
 * Dipisah agar modul lain (questionnaire, catalog, appointment,
 * validate, evaluate, execute) tidak perlu saling impor hanya demi satu
 * fungsi satu baris.
 */

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Id rujukan yang bukan UUID pasti tidak ditemukan (menghindari error PG). */
export function isUuidLike(v: string): boolean {
  return UUID_LIKE_RE.test(v);
}
export function parkTimeoutMsOf(c: Record<string, unknown>): number {
  const amount = typeof c.amount === "number" ? c.amount : NaN;
  const unitMs =
    c.unit === "seconds"
      ? 1_000
      : c.unit === "minutes"
        ? 60_000
        : c.unit === "hours"
          ? 3_600_000
          : NaN;
  return Number.isFinite(amount) && Number.isFinite(unitMs)
    ? Math.max(0, Math.floor(amount * unitMs))
    : 3_600_000;
}
