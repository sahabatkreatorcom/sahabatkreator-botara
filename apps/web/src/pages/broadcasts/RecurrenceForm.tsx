/**
 * Formulir jadwal broadcast berulang (G9).
 *
 * Definisinya DISALIN dari broadcast sumber yang dipilih (keputusan
 * desain: aturan adalah snapshot — bukan formulir definisi kedua;
 * definisi dibuat/diubah di formulir broadcast, aturan hanya
 * menyimpan salinannya). Formulir ini hanya mengatur POLA: frekuensi,
 * interval, hari/tanggal, zona waktu, rentang, dan batas jumlah —
 * dengan pratinjau slot berikutnya yang dihitung SERVER dari pola
 * yang sama seperti penyapu (satu logika, tanpa tebakan klien).
 */
import { useEffect, useRef, useState } from "react";
import type {
  BroadcastRecurrenceFrequency,
  BroadcastResponse,
} from "@sahabat-kreator/contracts";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { formatDateTime } from "../../utils/format";
import type { Locale } from "@sahabat-kreator/i18n";
import type { Translate } from "./types";

export interface RecurrenceFormProps {
  t: Translate;
  locale: Locale;
  tenantId: string | null;
  /** Broadcast yang sudah dipilih dari daftar (tombol "Jadikan berulang"). */
  initialSourceId?: string;
  onDone: () => void;
  onCancel: () => void;
}

const WEEKDAY_KEYS = [
  "broadcastRecurrence.weekdaySun",
  "broadcastRecurrence.weekdayMon",
  "broadcastRecurrence.weekdayTue",
  "broadcastRecurrence.weekdayWed",
  "broadcastRecurrence.weekdayThu",
  "broadcastRecurrence.weekdayFri",
  "broadcastRecurrence.weekdaySat",
] as const;

const COMMON_TIMEZONES = [
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Bangkok",
  "Asia/Tokyo",
  "UTC",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
];

/** datetime-local → ISO; string lokal ditafsirkan zona perangkat (pola BroadcastForm). */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO → nilai awal datetime-local "sekarang + 1 jam" dalam zona perangkat. */
function defaultStartsAtLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RecurrenceForm({
  t,
  locale,
  tenantId,
  initialSourceId,
  onDone,
  onCancel,
}: RecurrenceFormProps) {
  const [sources, setSources] = useState<BroadcastResponse[]>([]);
  const [sourceId, setSourceId] = useState(initialSourceId ?? "");
  const [name, setName] = useState("");
  const [frequency, setFrequency] =
    useState<BroadcastRecurrenceFrequency>("daily");
  const [interval, setIntervalValue] = useState(1);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [lastDayOfMonth, setLastDayOfMonth] = useState(false);
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jakarta",
  );
  const [startsAtLocal, setStartsAtLocal] = useState(defaultStartsAtLocal);
  const [endsAtLocal, setEndsAtLocal] = useState("");
  const [maxOccurrences, setMaxOccurrences] = useState("");
  const [previewSlots, setPreviewSlots] = useState<string[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    api.broadcasts
      .list(tenantId, { limit: 100 })
      .then((page) => {
        if (cancelled) return;
        setSources(page.broadcasts);
        if (initialSourceId) setSourceId(initialSourceId);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, initialSourceId]);

  const startsAtIso = localInputToIso(startsAtLocal);
  const endsAtIso = endsAtLocal ? localInputToIso(endsAtLocal) : null;

  // Pratinjau slot dari server (debounce 400ms, pola pratinjau audiens).
  useEffect(() => {
    if (!tenantId || !startsAtIso) {
      setPreviewSlots(null);
      return;
    }
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      api.broadcastRecurrences
        .preview(tenantId, {
          frequency,
          interval,
          daysOfWeek: frequency === "weekly" ? daysOfWeek : undefined,
          dayOfMonth:
            frequency === "monthly" && !lastDayOfMonth ? dayOfMonth : null,
          lastDayOfMonth: frequency === "monthly" ? lastDayOfMonth : undefined,
          timezone,
          startsAt: startsAtIso,
          endsAt: endsAtIso,
          count: 5,
        })
        .then((res) => {
          if (previewSeq.current === seq) setPreviewSlots(res.slots);
        })
        .catch(() => {
          if (previewSeq.current === seq) setPreviewSlots(null);
        })
        .finally(() => {
          if (previewSeq.current === seq) setPreviewLoading(false);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [
    tenantId,
    frequency,
    interval,
    daysOfWeek,
    dayOfMonth,
    lastDayOfMonth,
    timezone,
    startsAtIso,
    endsAtIso,
  ]);

  const save = async () => {
    if (!tenantId || saving || !sourceId || !startsAtIso) return;
    setSaving(true);
    setError(null);
    try {
      await api.broadcastRecurrences.create(tenantId, {
        sourceBroadcastId: sourceId,
        ...(name.trim() ? { name: name.trim() } : {}),
        frequency,
        interval,
        ...(frequency === "weekly" ? { daysOfWeek } : {}),
        ...(frequency === "monthly"
          ? {
              dayOfMonth: lastDayOfMonth ? null : dayOfMonth,
              lastDayOfMonth,
            }
          : {}),
        timezone: timezone.trim() || undefined,
        startsAt: startsAtIso,
        endsAt: endsAtIso,
        maxOccurrences: maxOccurrences
          ? Math.max(1, Math.floor(Number(maxOccurrences) || 0))
          : null,
      });
      onDone();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink";
  const labelClass = "block text-sm font-medium text-ink";

  return (
    <div className="mt-4 rounded-xl border border-border bg-surface p-4">
      <h3 className="text-base font-semibold text-ink">
        {t("broadcastRecurrence.formCreateTitle")}
      </h3>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {t("broadcastRecurrence.formIntro")}
      </p>

      {error ? (
        <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-4 max-w-2xl space-y-4">
        <div>
          <label className={labelClass} htmlFor="rec-source">
            {t("broadcastRecurrence.sourceLabel")}
          </label>
          <select
            id="rec-source"
            className={inputClass}
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">
              {t("broadcastRecurrence.sourcePlaceholder")}
            </option>
            {sources.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.channelDisplayName ? ` · ${b.channelDisplayName}` : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">
            {t("broadcastRecurrence.sourceHint")}
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="rec-name">
            {t("broadcastRecurrence.nameLabel")}
          </label>
          <input
            id="rec-name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="rec-frequency">
              {t("broadcastRecurrence.frequencyLabel")}
            </label>
            <select
              id="rec-frequency"
              className={inputClass}
              value={frequency}
              onChange={(e) =>
                setFrequency(e.target.value as BroadcastRecurrenceFrequency)
              }
            >
              <option value="daily">
                {t("broadcastRecurrence.freqDaily")}
              </option>
              <option value="weekly">
                {t("broadcastRecurrence.freqWeekly")}
              </option>
              <option value="monthly">
                {t("broadcastRecurrence.freqMonthly")}
              </option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="rec-interval">
              {t("broadcastRecurrence.intervalLabel")}
            </label>
            <input
              id="rec-interval"
              type="number"
              min={1}
              max={365}
              className={inputClass}
              value={interval}
              onChange={(e) =>
                setIntervalValue(
                  Math.min(
                    365,
                    Math.max(1, Math.floor(Number(e.target.value) || 1)),
                  ),
                )
              }
            />
          </div>
        </div>

        {frequency === "weekly" ? (
          <div>
            <span className={labelClass}>
              {t("broadcastRecurrence.daysOfWeekLabel")}
            </span>
            <div className="mt-2 flex flex-wrap gap-2">
              {WEEKDAY_KEYS.map((key, day) => {
                const activeDay = daysOfWeek.includes(day);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={activeDay}
                    onClick={() =>
                      setDaysOfWeek((prev) =>
                        activeDay
                          ? prev.filter((d) => d !== day)
                          : [...prev, day].sort((a, b) => a - b),
                      )
                    }
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      activeDay
                        ? "bg-accent text-white"
                        : "border border-border text-ink hover:bg-surface-2"
                    }`}
                  >
                    {t(key)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {frequency === "monthly" ? (
          <div className="space-y-3">
            <div>
              <label className={labelClass} htmlFor="rec-day-of-month">
                {t("broadcastRecurrence.dayOfMonthLabel")}
              </label>
              <input
                id="rec-day-of-month"
                type="number"
                min={1}
                max={31}
                disabled={lastDayOfMonth}
                className={inputClass}
                value={dayOfMonth}
                onChange={(e) =>
                  setDayOfMonth(
                    Math.min(
                      31,
                      Math.max(1, Math.floor(Number(e.target.value) || 1)),
                    ),
                  )
                }
              />
              <p className="mt-1 text-xs text-muted">
                {t("broadcastRecurrence.dayOfMonthHint")}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={lastDayOfMonth}
                onChange={(e) => setLastDayOfMonth(e.target.checked)}
              />
              {t("broadcastRecurrence.lastDayLabel")}
            </label>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="rec-starts-at">
              {t("broadcastRecurrence.startsAtLabel")}
            </label>
            <input
              id="rec-starts-at"
              type="datetime-local"
              className={inputClass}
              value={startsAtLocal}
              onChange={(e) => setStartsAtLocal(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted">
              {t("broadcastRecurrence.startsAtHint")}
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="rec-timezone">
              {t("broadcastRecurrence.timezoneLabel")}
            </label>
            <input
              id="rec-timezone"
              className={inputClass}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              list="rec-timezones"
            />
            <datalist id="rec-timezones">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="rec-ends-at">
              {t("broadcastRecurrence.endsAtLabel")}
            </label>
            <input
              id="rec-ends-at"
              type="datetime-local"
              className={inputClass}
              value={endsAtLocal}
              onChange={(e) => setEndsAtLocal(e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="rec-max">
              {t("broadcastRecurrence.maxOccurrencesLabel")}
            </label>
            <input
              id="rec-max"
              type="number"
              min={1}
              className={inputClass}
              value={maxOccurrences}
              onChange={(e) => setMaxOccurrences(e.target.value)}
            />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface-2 p-4">
          <p className="text-sm font-medium text-ink">
            {t("broadcastRecurrence.previewTitle")}
          </p>
          {previewLoading ? (
            <p className="mt-1 text-sm text-muted">
              {t("broadcastRecurrence.previewLoading")}
            </p>
          ) : previewSlots && previewSlots.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-muted">
              {previewSlots.map((slot) => (
                <li key={slot}>{formatDateTime(slot, locale)}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted">
              {t("broadcastRecurrence.previewEmpty")}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={saving || !sourceId || !startsAtIso}
            onClick={() => void save()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {t("broadcastRecurrence.saveButton")}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
          >
            {t("broadcastRecurrence.cancelButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
