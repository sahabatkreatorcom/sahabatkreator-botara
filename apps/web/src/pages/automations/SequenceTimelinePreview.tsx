import {
  buildSequenceTimeline,
  extractInstructionPlaceholders,
} from "@sahabat-kreator/contracts";
import type { TranslationKey } from "@sahabat-kreator/i18n";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Pratinjau linimasa sequence (G2) — ditampilkan dari galeri SEBELUM
 * pemilik memakai template: hari kumulatif tiap langkah (Hari 0 → 1 →
 * 3 → 5, penjumlahan jeda relatif oleh `buildSequenceTimeline` di
 * kontrak) + ringkasan isi langkahnya, supaya "Pakai template" bukan
 * kotak hitam.
 *
 * Dua kejujuran yang ikut dirender dari data yang sama:
 * - Penanda kurung siku yang belum diganti dikumpulkan dengan
 *   `extractInstructionPlaceholders` (modul placeholders bersama) dan
 *   ditampilkan sebagai peringatan NON-BLOKIR — persis pola formulir
 *   agent; tidak ada yang dicegah di sini.
 * - Langkah yang kumulatifnya melewati 24 jam ditandai risiko jendela
 *   WhatsApp sebagai HEURISTIK (lihat `exceedsWaWindow` di kontrak):
 *   sequence tidak terikat kanal dan jendela berjangkar pesan masuk
 *   terakhir, jadi ini peringatan risiko — bukan janji gagal. Tautan
 *   mengarah ke manajemen template WA (halaman Siaran).
 */
export function SequenceTimelinePreview({
  t,
  steps,
  onOpenWaTemplates,
}: {
  t: Translate;
  steps: { delayMinutes: number; text: string }[];
  onOpenWaTemplates?: () => void;
}) {
  const timeline = buildSequenceTimeline(steps);
  const placeholders = extractInstructionPlaceholders(
    steps.map((s) => s.text).join("\n"),
  );
  const anyWaRisk = timeline.some((s) => s.exceedsWaWindow);

  const delayLabel = (delayMinutes: number, isFirst: boolean): string => {
    if (delayMinutes === 0) {
      return isFirst
        ? t("automations.tplTimelineDelayNow")
        : t("automations.tplTimelineDelayMinutes", { count: 0 });
    }
    if (delayMinutes % 1440 === 0) {
      return t("automations.tplTimelineDelayDays", {
        count: delayMinutes / 1440,
      });
    }
    if (delayMinutes % 60 === 0) {
      return t("automations.tplTimelineDelayHours", {
        count: delayMinutes / 60,
      });
    }
    return t("automations.tplTimelineDelayMinutes", { count: delayMinutes });
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      <ol className="space-y-2.5">
        {timeline.map((step) => (
          <li key={step.position} className="flex gap-2.5">
            <span className="mt-0.5 shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
              {t("automations.tplTimelineDay", { day: step.dayOffset })}
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                {delayLabel(step.delayMinutes, step.position === 1)}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">
                {step.text}
              </p>
              {step.exceedsWaWindow ? (
                <span className="mt-1 inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
                  {t("automations.tplWaWindowRisk")}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {placeholders.length > 0 ? (
        <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
          <p className="text-xs font-semibold text-warning">
            {t("automations.tplPlaceholderWarningTitle")}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink">
            {t("automations.tplPlaceholderWarningBody", {
              placeholders: placeholders.map((p) => `[${p}]`).join(", "),
            })}
          </p>
        </div>
      ) : null}

      {anyWaRisk ? (
        <div className="mt-3 rounded-lg bg-elevated/60 px-3 py-2">
          <p className="text-xs leading-relaxed text-muted">
            {t("automations.tplWaWindowRiskBody")}
          </p>
          {onOpenWaTemplates ? (
            <button
              type="button"
              onClick={onOpenWaTemplates}
              className="mt-1.5 text-xs font-semibold text-accent hover:underline"
            >
              {t("automations.tplWaWindowManageLink")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
