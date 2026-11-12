/**
 * Seksi "Antrean konten rutin" pada halaman Posts (S2).
 *
 * Dua bagian: (1) ANTREAN — daftar item dalam urutan tarik dengan
 * tambah (judul + caption + media opsional), geser naik/turun, dan
 * hapus; di bawahnya riwayat item yang sudah tertarik (tertaut ke
 * postingannya lewat waktu tarik). (2) SLOT RUTIN — slot mingguan
 * (hari + jam + sasaran) yang menarik item teratas; daftar slot
 * dengan jeda/lanjut/batal dan riwayat tembakan per slot.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  PostQueueFiringResponse,
  PostQueueItemResponse,
  PostQueueSlotResponse,
  PostTarget,
} from "@sahabat-kreator/contracts";
import type {
  Locale,
  TranslationKey,
  createTranslator,
} from "@sahabat-kreator/i18n";
import { api } from "../../api/client";
import { translateApiError } from "../../api/errorText";
import { formatDateTime } from "../../utils/format";

type Translate = ReturnType<typeof createTranslator>;

const SLOT_STATUS_CHIP: Record<
  PostQueueSlotResponse["status"],
  { labelKey: TranslationKey; className: string }
> = {
  active: {
    labelKey: "postQueue.statusActive",
    className: "bg-success-soft text-success",
  },
  paused: {
    labelKey: "postQueue.statusPaused",
    className: "bg-warning-soft text-warning",
  },
  cancelled: {
    labelKey: "postQueue.statusCancelled",
    className: "bg-surface-2 text-muted",
  },
};

const FIRING_STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  pulled: "postQueue.firingPulled",
  empty: "postQueue.firingEmpty",
  skipped: "postQueue.firingSkipped",
  missed: "postQueue.firingMissed",
  claimed: "postQueue.firingClaimed",
};

const FIRING_REASON_LABEL_KEYS: Record<string, TranslationKey> = {
  queue_empty: "postRecurrence.reasonQueueEmpty",
  slot_paused: "postRecurrence.reasonSlotPaused",
  slot_expired: "postRecurrence.reasonSlotExpired",
  claim_stale: "postRecurrence.reasonClaimStale",
  POST_TARGET_NOT_FOUND: "postRecurrence.reasonTargetNotFound",
  POST_TARGET_NOT_CONNECTED: "postRecurrence.reasonTargetNotConnected",
  POST_MEDIA_NOT_FOUND: "postRecurrence.reasonMediaNotFound",
  POST_MEDIA_TOO_MANY: "postRecurrence.reasonMediaTooMany",
  POST_MEDIA_REQUIRED: "postRecurrence.reasonMediaRequired",
  POST_PUBLISH_OPTIONS_REQUIRED: "postRecurrence.reasonOptionsRequired",
  POST_CONTENT_REQUIRED: "postRecurrence.reasonContentRequired",
};

const WEEKDAY_KEYS = [
  "postRecurrence.weekdaySun",
  "postRecurrence.weekdayMon",
  "postRecurrence.weekdayTue",
  "postRecurrence.weekdayWed",
  "postRecurrence.weekdayThu",
  "postRecurrence.weekdayFri",
  "postRecurrence.weekdaySat",
] as const;

export interface PostQueueSectionProps {
  t: Translate;
  locale: Locale;
  tenantId: string | null;
  canManage: boolean;
  approvalRequired: boolean;
  /** Sasaran channel yang bisa dipilih untuk slot (dari daftar sasaran Posts). */
  targets: PostTarget[];
}

export function PostQueueSection({
  t,
  locale,
  tenantId,
  canManage,
  approvalRequired,
  targets,
}: PostQueueSectionProps) {
  const [items, setItems] = useState<PostQueueItemResponse[]>([]);
  const [pulled, setPulled] = useState<PostQueueItemResponse[]>([]);
  const [slots, setSlots] = useState<PostQueueSlotResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // Formulir tambah item.
  const [newTitle, setNewTitle] = useState("");
  const [newCaption, setNewCaption] = useState("");
  const [newMediaIds, setNewMediaIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [adding, setAdding] = useState(false);

  // Formulir slot.
  const [showSlotForm, setShowSlotForm] = useState(false);
  const [slotName, setSlotName] = useState("");
  const [slotDays, setSlotDays] = useState<number[]>([1]);
  const [slotTime, setSlotTime] = useState("09:00");
  const [slotTimezone, setSlotTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jakarta",
  );
  const [slotTargets, setSlotTargets] = useState<string[]>([]);
  const [savingSlot, setSavingSlot] = useState(false);

  // Riwayat tembakan per slot.
  const [openFiringsId, setOpenFiringsId] = useState<string | null>(null);
  const [firings, setFirings] = useState<PostQueueFiringResponse[]>([]);
  const [firingsCursor, setFiringsCursor] = useState<string | null>(null);
  const [firingsLoading, setFiringsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const [queuedPage, pulledPage, slotPage] = await Promise.all([
        api.postQueue.listItems(tenantId, { status: "queued", limit: 100 }),
        api.postQueue.listItems(tenantId, { status: "pulled", limit: 20 }),
        api.postQueue.listSlots(tenantId, { limit: 50 }),
      ]);
      setItems(queuedPage.items);
      setPulled(pulledPage.items);
      setSlots(slotPage.slots);
      setError(null);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onUpload = async (files: FileList | null) => {
    if (!tenantId || !files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files)) {
        const result = await api.media.upload(tenantId, file);
        uploaded.push(result.mediaId);
      }
      setNewMediaIds((current) => [...current, ...uploaded].slice(0, 10));
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setUploading(false);
    }
  };

  const addItem = async () => {
    if (!tenantId || adding || !newTitle.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await api.postQueue.addItem(tenantId, {
        title: newTitle.trim(),
        caption: newCaption,
        mediaIds: newMediaIds,
      });
      setNewTitle("");
      setNewCaption("");
      setNewMediaIds([]);
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setAdding(false);
    }
  };

  const itemAction = async (
    item: PostQueueItemResponse,
    action: "up" | "down" | "remove",
  ) => {
    if (!tenantId || busyId) return;
    if (action === "remove" && confirming !== `remove:${item.id}`) {
      setConfirming(`remove:${item.id}`);
      return;
    }
    setConfirming(null);
    setBusyId(item.id);
    setError(null);
    try {
      if (action === "remove") {
        await api.postQueue.removeItem(tenantId, item.id);
      } else {
        await api.postQueue.moveItem(tenantId, item.id, { direction: action });
      }
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusyId(null);
    }
  };

  const saveSlot = async () => {
    if (
      !tenantId ||
      savingSlot ||
      !slotName.trim() ||
      slotDays.length === 0 ||
      slotTargets.length === 0
    ) {
      return;
    }
    setSavingSlot(true);
    setError(null);
    try {
      await api.postQueue.createSlot(tenantId, {
        name: slotName.trim(),
        targets: slotTargets.map((conversationId) => ({ conversationId })),
        daysOfWeek: slotDays,
        timeOfDay: slotTime,
        timezone: slotTimezone.trim() || undefined,
      });
      setSlotName("");
      setSlotTargets([]);
      setShowSlotForm(false);
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSavingSlot(false);
    }
  };

  const slotAction = async (
    slot: PostQueueSlotResponse,
    action: "pause" | "resume" | "cancel",
  ) => {
    if (!tenantId || busyId) return;
    if (action === "cancel" && confirming !== `cancel-slot:${slot.id}`) {
      setConfirming(`cancel-slot:${slot.id}`);
      return;
    }
    setConfirming(null);
    setBusyId(slot.id);
    setError(null);
    try {
      if (action === "pause") {
        await api.postQueue.pauseSlot(tenantId, slot.id);
      } else if (action === "resume") {
        await api.postQueue.resumeSlot(tenantId, slot.id);
      } else {
        await api.postQueue.cancelSlot(tenantId, slot.id);
      }
      await load();
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleFirings = async (slotId: string) => {
    if (openFiringsId === slotId) {
      setOpenFiringsId(null);
      return;
    }
    setOpenFiringsId(slotId);
    setFirings([]);
    setFiringsCursor(null);
    if (!tenantId) return;
    setFiringsLoading(true);
    try {
      const page = await api.postQueue.listFirings(tenantId, slotId, {
        limit: 20,
      });
      setFirings(page.firings);
      setFiringsCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setFiringsLoading(false);
    }
  };

  const loadMoreFirings = async (slotId: string) => {
    if (!tenantId || !firingsCursor) return;
    setFiringsLoading(true);
    try {
      const page = await api.postQueue.listFirings(tenantId, slotId, {
        limit: 20,
        cursor: firingsCursor,
      });
      setFirings((prev) => [...prev, ...page.firings]);
      setFiringsCursor(page.nextCursor);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setFiringsLoading(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink";
  const labelClass = "block text-sm font-medium text-ink";
  const smallButtonClass =
    "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50";

  return (
    <section className="mt-10">
      <div>
        <h2 className="text-lg font-semibold text-ink">
          {t("postQueue.sectionTitle")}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {t("postQueue.sectionSubtitle")}
        </p>
        {approvalRequired ? (
          <p className="mt-1 max-w-2xl text-sm text-warning">
            {t("postQueue.approvalNote")}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* ---- Antrean ---- */}
      <h3 className="mt-6 text-sm font-semibold text-ink">
        {t("postQueue.itemsTitle")}
      </h3>
      {loading ? (
        <p className="mt-3 text-sm text-muted">{t("workspace.loading")}</p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("postQueue.itemsEmpty")}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item, index) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3"
            >
              <span className="text-xs font-semibold text-muted">
                #{index + 1}
              </span>
              <span className="text-sm font-medium text-ink">{item.title}</span>
              {item.mediaIds.length > 0 ? (
                <span className="text-xs text-muted">
                  {t("postQueue.mediaCount", { count: item.mediaIds.length })}
                </span>
              ) : null}
              {item.caption ? (
                <span className="w-full truncate text-xs text-muted">
                  {item.caption}
                </span>
              ) : null}
              {canManage ? (
                <span className="ml-auto flex gap-1.5">
                  <button
                    type="button"
                    disabled={busyId === item.id || index === 0}
                    onClick={() => void itemAction(item, "up")}
                    className={smallButtonClass}
                  >
                    {t("postQueue.moveUp")}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id || index === items.length - 1}
                    onClick={() => void itemAction(item, "down")}
                    className={smallButtonClass}
                  >
                    {t("postQueue.moveDown")}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void itemAction(item, "remove")}
                    className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
                  >
                    {confirming === `remove:${item.id}`
                      ? t("postQueue.confirmRemove")
                      : t("postQueue.removeAction")}
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="mt-4 max-w-2xl space-y-3 rounded-xl border border-border bg-surface p-4">
          <div>
            <label className={labelClass} htmlFor="pq-title">
              {t("postQueue.addTitleLabel")}
            </label>
            <input
              id="pq-title"
              className={inputClass}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              maxLength={255}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="pq-caption">
              {t("postQueue.addCaptionLabel")}
            </label>
            <textarea
              id="pq-caption"
              className={inputClass}
              rows={3}
              value={newCaption}
              onChange={(e) => setNewCaption(e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="pq-media">
              {t("postQueue.addMediaLabel")}
            </label>
            <input
              id="pq-media"
              type="file"
              multiple
              className="text-sm text-muted"
              onChange={(e) => void onUpload(e.target.files)}
            />
            {newMediaIds.length > 0 ? (
              <p className="mt-1 text-xs text-muted">
                {t("postQueue.addMediaCount", { count: newMediaIds.length })}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            disabled={adding || uploading || !newTitle.trim()}
            onClick={() => void addItem()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {t("postQueue.addButton")}
          </button>
        </div>
      ) : null}

      {pulled.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-ink">
            {t("postQueue.historyTitle")}
          </h3>
          <ul className="mt-2 space-y-1.5">
            {pulled.map((item) => (
              <li key={item.id} className="text-xs text-muted">
                <span className="font-medium text-ink">{item.title}</span>
                {item.pulledAt
                  ? ` · ${t("postQueue.pulledAt", {
                      when: formatDateTime(item.pulledAt, locale),
                    })}`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---- Slot rutin ---- */}
      <div className="mt-8 flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">
          {t("postQueue.slotsTitle")}
        </h3>
        {canManage && !showSlotForm ? (
          <button
            type="button"
            onClick={() => setShowSlotForm(true)}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2"
          >
            {t("postQueue.slotCreateButton")}
          </button>
        ) : null}
      </div>

      {showSlotForm ? (
        <div className="mt-4 max-w-2xl space-y-4 rounded-xl border border-border bg-surface p-4">
          <h4 className="text-base font-semibold text-ink">
            {t("postQueue.slotFormTitle")}
          </h4>
          <div>
            <label className={labelClass} htmlFor="pq-slot-name">
              {t("postQueue.slotNameLabel")}
            </label>
            <input
              id="pq-slot-name"
              className={inputClass}
              value={slotName}
              onChange={(e) => setSlotName(e.target.value)}
              maxLength={255}
            />
          </div>
          <div>
            <span className={labelClass}>{t("postQueue.slotDaysLabel")}</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {WEEKDAY_KEYS.map((key, day) => {
                const activeDay = slotDays.includes(day);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={activeDay}
                    onClick={() =>
                      setSlotDays((prev) =>
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="pq-slot-time">
                {t("postQueue.slotTimeLabel")}
              </label>
              <input
                id="pq-slot-time"
                type="time"
                className={inputClass}
                value={slotTime}
                onChange={(e) => setSlotTime(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="pq-slot-tz">
                {t("postQueue.slotTimezoneLabel")}
              </label>
              <input
                id="pq-slot-tz"
                className={inputClass}
                value={slotTimezone}
                onChange={(e) => setSlotTimezone(e.target.value)}
              />
            </div>
          </div>
          <div>
            <span className={labelClass}>{t("postQueue.slotTargetsLabel")}</span>
            <div className="mt-2 space-y-1">
              {targets.map((target) => (
                <label
                  key={target.conversationId}
                  className="flex items-center gap-2 text-sm text-ink"
                >
                  <input
                    type="checkbox"
                    checked={slotTargets.includes(target.conversationId)}
                    onChange={(e) =>
                      setSlotTargets((prev) =>
                        e.target.checked
                          ? [...prev, target.conversationId]
                          : prev.filter((id) => id !== target.conversationId),
                      )
                    }
                  />
                  {target.title ?? target.channelDisplayName ?? target.provider}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">
              {t("postQueue.slotTargetsHint")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={
                savingSlot ||
                !slotName.trim() ||
                slotDays.length === 0 ||
                slotTargets.length === 0
              }
              onClick={() => void saveSlot()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {t("postQueue.slotSaveButton")}
            </button>
            <button
              type="button"
              disabled={savingSlot}
              onClick={() => setShowSlotForm(false)}
              className="rounded-lg px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
            >
              {t("postQueue.slotCancelButton")}
            </button>
          </div>
        </div>
      ) : null}

      {!loading && slots.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("postQueue.slotsEmpty")}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {slots.map((slot) => {
            const chip = SLOT_STATUS_CHIP[slot.status];
            return (
              <li
                key={slot.id}
                className="rounded-xl border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">
                    {slot.name}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip.className}`}
                  >
                    {t(chip.labelKey)}
                  </span>
                  <span className="text-xs text-muted">
                    {slot.daysOfWeek
                      .map((d) => t(WEEKDAY_KEYS[d] ?? "postRecurrence.weekdaySun"))
                      .join(" ")}
                    {" · "}
                    {slot.timeOfDay}
                    {" · "}
                    {slot.timezone}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {t("postRecurrence.targetsLabel", {
                    targets: slot.targets
                      .map(
                        (target) =>
                          target.conversationTitle ??
                          target.channelDisplayName ??
                          target.provider ??
                          target.conversationId,
                      )
                      .join(", "),
                  })}
                  {slot.status !== "cancelled" && slot.nextRunAt
                    ? ` · ${t("postQueue.slotNextRun", {
                        when: formatDateTime(slot.nextRunAt, locale),
                      })}`
                    : ""}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void toggleFirings(slot.id)}
                    className={smallButtonClass}
                  >
                    {openFiringsId === slot.id
                      ? t("postQueue.hideFiringsAction")
                      : t("postQueue.firingsAction")}
                  </button>
                  {canManage && slot.status === "active" ? (
                    <button
                      type="button"
                      disabled={busyId === slot.id}
                      onClick={() => void slotAction(slot, "pause")}
                      className={smallButtonClass}
                    >
                      {t("postQueue.pauseAction")}
                    </button>
                  ) : null}
                  {canManage && slot.status === "paused" ? (
                    <button
                      type="button"
                      disabled={busyId === slot.id}
                      onClick={() => void slotAction(slot, "resume")}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      {t("postQueue.resumeAction")}
                    </button>
                  ) : null}
                  {canManage && slot.status !== "cancelled" ? (
                    <button
                      type="button"
                      disabled={busyId === slot.id}
                      onClick={() => void slotAction(slot, "cancel")}
                      className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
                    >
                      {confirming === `cancel-slot:${slot.id}`
                        ? t("postQueue.confirmCancel")
                        : t("postQueue.cancelAction")}
                    </button>
                  ) : null}
                </div>

                {openFiringsId === slot.id ? (
                  <div className="mt-3 border-t border-border pt-3">
                    {firingsLoading && firings.length === 0 ? (
                      <p className="text-sm text-muted">
                        {t("workspace.loading")}
                      </p>
                    ) : firings.length === 0 ? (
                      <p className="text-sm text-muted">
                        {t("postQueue.firingsEmpty")}
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {firings.map((firing) => (
                          <li
                            key={firing.id}
                            className="flex flex-wrap items-center gap-2 text-xs text-muted"
                          >
                            <span className="font-medium text-ink">
                              {formatDateTime(firing.slotAt, locale)}
                            </span>
                            <span>
                              {t(
                                FIRING_STATUS_LABEL_KEYS[firing.status] ??
                                  "postQueue.firingClaimed",
                              )}
                            </span>
                            {firing.reason ? (
                              <span>
                                —{" "}
                                {FIRING_REASON_LABEL_KEYS[firing.reason]
                                  ? t(FIRING_REASON_LABEL_KEYS[firing.reason])
                                  : firing.reason}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                    {firingsCursor ? (
                      <button
                        type="button"
                        disabled={firingsLoading}
                        onClick={() => void loadMoreFirings(slot.id)}
                        className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
                      >
                        {t("postQueue.loadMore")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
