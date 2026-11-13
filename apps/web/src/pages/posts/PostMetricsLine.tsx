import {
  POST_METRIC_KEYS,
  type PostAnalyticsSnapshot,
  type PostMetricKey,
} from "@sahabat-kreator/contracts";
import {
  formatNumber,
  type Locale,
  type TranslationKey,
  type createTranslator,
} from "@sahabat-kreator/i18n";
import { formatDateTime } from "../../utils/format";

type Translate = ReturnType<typeof createTranslator>;

/** Label i18n per kunci metrik ternormalisasi (satu peta statis, aman tipe). */
export const POST_METRIC_LABEL_KEYS: Record<PostMetricKey, TranslationKey> = {
  views: "analytics.metrics.views",
  likes: "analytics.metrics.likes",
  comments: "analytics.metrics.comments",
  shares: "analytics.metrics.shares",
  reach: "analytics.metrics.reach",
  saves: "analytics.metrics.saves",
  clicks: "analytics.metrics.clicks",
  reposts: "analytics.metrics.reposts",
  quotes: "analytics.metrics.quotes",
  outboundClicks: "analytics.metrics.outboundClicks",
};

/**
 * Baris metrik satu postingan terbit (Fase Susulan S3) pada kartu
 * /posts. Menampilkan snapshot TERAKHIR yang ditarik penyapu worker:
 * - ok: angka yang benar-benar dilaporkan platform (hanya kunci yang
 *   hadir — kunci absen tidak digambar sebagai 0) + waktu tarik;
 * - unavailable: platform memang tidak menawarkan metrik postingan
 *   (Telegram, Google Business) — dinyatakan apa adanya;
 * - failed: penarikan terakhir gagal, dengan kode alasannya.
 * Tanpa snapshot (belum pernah ditarik) komponen tidak menggambar
 * apa pun — penyapu berjalan berkala, bukan atas permintaan halaman.
 */
export function PostMetricsLine({
  snapshot,
  t,
  locale,
  timezone,
}: {
  snapshot: PostAnalyticsSnapshot | null;
  t: Translate;
  locale: Locale;
  timezone: string;
}) {
  if (!snapshot) return null;
  if (snapshot.status === "unavailable") {
    return (
      <p className="mt-1 text-xs text-muted">
        {t("posts.analyticsUnavailable")}
      </p>
    );
  }
  if (snapshot.status === "failed") {
    return (
      <p className="mt-1 text-xs text-warning">
        {t("posts.analyticsFailed", { reason: snapshot.reason ?? "—" })}
      </p>
    );
  }
  const metrics = snapshot.metrics ?? {};
  const parts = POST_METRIC_KEYS.filter(
    (key) => typeof metrics[key] === "number",
  ).map(
    (key) =>
      `${t(POST_METRIC_LABEL_KEYS[key])} ${formatNumber(metrics[key]!, locale)}`,
  );
  return (
    <p className="mt-1 text-xs text-muted">
      {parts.length > 0 ? `${parts.join(" · ")} · ` : ""}
      {t("posts.analyticsUpdated", {
        when: formatDateTime(snapshot.fetchedAt, locale, timezone),
      })}
    </p>
  );
}
