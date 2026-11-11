import { useCallback, useEffect, useMemo, useState } from "react";
import type { Locale, createTranslator } from "@sahabat-kreator/i18n";
import {
  getPostProviderCapability,
  type PostResponse,
  type PostStatus,
  type PostTarget,
} from "@sahabat-kreator/contracts";

import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { formatDateTime, formatTime, zonedLocalToIso } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * Halaman Jadwal Konten (Fase 23, diperluas Gelombang 0).
 *
 * Satu halaman: formulir di kiri, tampilan jadwal di kanan dengan tiga
 * mode — Kalender (bulan), Minggu, Daftar. Tidak ada modal — pola dua
 * langkah sebaris (klik → tombol berubah jadi konfirmasi) dipakai
 * untuk aksi yang tidak bisa dibatalkan, sama seperti Broadcasts.
 *
 * Keputusan yang terlihat di UI:
 * - Pemilih channel KOSONG berarti bot belum menjadi admin di channel
 *   mana pun. Yang ditampilkan instruksi, bukan pemilih kosong.
 * - Sasaran adalah daftar centang MULTI-target: satu sasaran memakai
 *   jalur pembuatan biasa; lebih dari satu membuat grup multi-target
 *   (satu konten induk, satu baris posts per sasaran, status per
 *   platform). Batas caption formulir mengikuti capability provider
 *   TERSEMPIT dari sasaran terpilih — bukan konstanta Telegram.
 * - SEMUA jam adalah jam zona waktu TENANT (`tenants.timezone`,
 *   default Asia/Jakarta): tampilan, pengelompokan kalender, dan
 *   penafsiran input `datetime-local` memakai zona itu, ditampilkan
 *   eksplisit di kepala halaman.
 * - Geser jadwal di kalender memakai drag-and-drop bawaan browser
 *   pada chip postingan (draft/terjadwal); menjatuhkannya di tanggal
 *   lain memanggil schedule ulang dengan jam tayang yang sama pada
 *   tanggal baru. Alternatif tanpa drag: input tanggal di kartu
 *   postingan pada tampilan Daftar (juga dipakai untuk retry terjadwal).
 * - Pemulihan bersifat manual dan terlihat: post gagal punya tombol
 *   Coba Lagi, post macet di `publishing` punya tombol Bebaskan
 *   (dua langkah) — tidak ada retry otomatis yang disembunyikan.
 */

interface PostsPageProps {
  t: ReturnType<typeof createTranslator>;
  locale: Locale;
}

type Translate = PostsPageProps["t"];

const STATUS_STYLE: Record<PostStatus, string> = {
  draft: "bg-neutral-100 text-neutral-700",
  scheduled: "bg-amber-100 text-amber-800",
  publishing: "bg-blue-100 text-blue-800",
  published: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-neutral-100 text-neutral-500",
};

const STATUS_KEY: Record<PostStatus, Parameters<Translate>[0]> = {
  draft: "posts.statusDraft",
  scheduled: "posts.statusScheduled",
  publishing: "posts.statusPublishing",
  published: "posts.statusPublished",
  failed: "posts.statusFailed",
  cancelled: "posts.statusCancelled",
};

// ---------------------------------------------------------------------------
// Matematika kalender pada zona waktu tenant.
//
// Instant (UTC) tidak punya "tanggal" sampai dipasangkan dengan zona.
// Karena itu pengelompokan bekerja pada tupel (tahun, bulan, hari)
// hasil proyeksi Intl di zona tenant; aritmetika antar-tupel sendiri
// zona-netral (satu tupel = satu hari kalender, titik).
// ---------------------------------------------------------------------------

interface DayTuple {
  y: number;
  m: number;
  d: number;
}

function zonedDayTuple(iso: string, timeZone: string): DayTuple | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { y: value("year"), m: value("month"), d: value("day") };
}

function zonedTimeParts(
  iso: string,
  timeZone: string,
): { hh: number; mm: number } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { hh: value("hour"), mm: value("minute") };
}

function dayKey(day: DayTuple): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.y}-${pad(day.m)}-${pad(day.d)}`;
}

function addDays(day: DayTuple, n: number): DayTuple {
  const date = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
  };
}

/** Senin sebagai awal minggu (konvensi perencanaan kerja). */
function mondayOf(day: DayTuple): DayTuple {
  const dow = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

function localDateTimeValue(day: DayTuple, hh: number, mm: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.y}-${pad(day.m)}-${pad(day.d)}T${pad(hh)}:${pad(mm)}`;
}

type ViewMode = "month" | "week" | "list";

export function PostsPage({ t, locale }: PostsPageProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";
  // Zona waktu tenant dari settings workspace; fallback Asia/Jakarta
  // (default kolomnya di basis data) untuk nilai kosong.
  const timezone = active?.timezone ? active.timezone : "Asia/Jakarta";

  /** `datetime-local` → ISO UTC, ditafsirkan sebagai jam dinding zona tenant. */
  const toIso = (local: string): string | null =>
    local ? zonedLocalToIso(local, timezone) : null;

  const [posts, setPosts] = useState<PostResponse[]>([]);
  const [targets, setTargets] = useState<PostTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewMode>("month");

  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [scheduleAt, setScheduleAt] = useState("");

  const todayTuple = useMemo(
    () => zonedDayTuple(new Date().toISOString(), timezone) ?? { y: 1970, m: 1, d: 1 },
    [timezone],
  );
  const [monthCursor, setMonthCursor] = useState<DayTuple>(todayTuple);
  const [weekCursor, setWeekCursor] = useState<DayTuple>(todayTuple);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const [list, targetList] = await Promise.all([
        api.posts.list(tenantId),
        api.posts.targets(tenantId),
      ]);
      setPosts(list.items);
      setTargets(targetList.items);
      setSelectedTargets((current) =>
        current.length > 0
          ? current
          : targetList.items[0]
            ? [targetList.items[0].conversationId]
            : [],
      );
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Batas caption = capability tersempit dari sasaran terpilih. Dulu
  // angka ini ditulis tangan 1024 (batas Telegram) untuk semua kasus.
  const captionMax = useMemo(() => {
    const selected = targets.filter((target) =>
      selectedTargets.includes(target.conversationId),
    );
    if (selected.length === 0) return 1024;
    return Math.min(
      ...selected.map(
        (target) =>
          getPostProviderCapability(target.provider)?.maxCaption ?? 1024,
      ),
    );
  }, [targets, selectedTargets]);
  const captionLeft = captionMax - caption.length;
  const canSubmit =
    canManage &&
    Boolean(tenantId) &&
    selectedTargets.length > 0 &&
    title.trim().length > 0 &&
    captionLeft >= 0 &&
    (caption.trim().length > 0 || mediaIds.length > 0);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(translateApiError(t, err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Buat draft: satu sasaran = jalur biasa; banyak = grup multi-target. */
  const createDrafts = async (): Promise<PostResponse[]> => {
    if (!tenantId || !canSubmit) return [];
    if (selectedTargets.length === 1) {
      const created = await api.posts.create(tenantId, {
        conversationId: selectedTargets[0]!,
        title: title.trim(),
        caption,
        mediaIds,
      });
      return [created];
    }
    const group = await api.posts.createGroup(tenantId, {
      title: title.trim(),
      caption,
      mediaIds,
      targets: selectedTargets.map((conversationId) => ({ conversationId })),
    });
    return group.items;
  };

  const resetForm = () => {
    setTitle("");
    setCaption("");
    setMediaIds([]);
    setScheduleAt("");
  };

  const onSaveDraft = () =>
    run(async () => {
      await createDrafts();
      resetForm();
    });

  const onSchedule = () =>
    run(async () => {
      if (!tenantId) return;
      const created = await createDrafts();
      const iso = toIso(scheduleAt);
      for (const post of created) {
        await api.posts.schedule(tenantId, post.id, iso);
      }
      if (created.length > 0) resetForm();
    });

  const onUpload = async (files: FileList | null) => {
    if (!tenantId || !files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files)) {
        const result = await api.media.upload(tenantId, file);
        uploaded.push(result.mediaId);
      }
      setMediaIds((current) => [...current, ...uploaded].slice(0, 10));
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setBusy(false);
    }
  };

  const toggleTarget = (conversationId: string) =>
    setSelectedTargets((current) =>
      current.includes(conversationId)
        ? current.filter((id) => id !== conversationId)
        : [...current, conversationId],
    );

  // -- Pengelompokan kalender ------------------------------------------------
  const timedPosts = useMemo(
    () =>
      posts.filter(
        (post) => post.status !== "cancelled" && (post.scheduledAt ?? post.publishedAt),
      ),
    [posts],
  );
  const postsByDay = useMemo(() => {
    const map = new Map<string, PostResponse[]>();
    for (const post of timedPosts) {
      const tuple = zonedDayTuple((post.scheduledAt ?? post.publishedAt)!, timezone);
      if (!tuple) continue;
      const key = dayKey(tuple);
      map.set(key, [...(map.get(key) ?? []), post]);
    }
    return map;
  }, [timedPosts, timezone]);
  const unscheduledCount = posts.filter(
    (post) =>
      (post.status === "draft" || post.status === "failed") && !post.scheduledAt,
  ).length;

  /** Pindah jadwal lewat drag: tanggal baru, jam tayang lama (zona tenant). */
  const movePostToDay = (post: PostResponse, day: DayTuple) => {
    if (!tenantId) return;
    const time = post.scheduledAt
      ? zonedTimeParts(post.scheduledAt, timezone)
      : null;
    const iso = zonedLocalToIso(
      localDateTimeValue(day, time?.hh ?? 9, time?.mm ?? 0),
      timezone,
    );
    void run(() => api.posts.schedule(tenantId, post.id, iso));
  };

  const monthTitle = new Intl.DateTimeFormat(
    locale === "id" ? "id-ID" : "en-US",
    { month: "long", year: "numeric", timeZone: timezone },
  ).format(new Date(Date.UTC(monthCursor.y, monthCursor.m - 1, 1, 12)));
  const weekStart = mondayOf(weekCursor);
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-US", {
      weekday: "short",
      timeZone: timezone,
    });
    // 2026-01-05 adalah hari Senin.
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(Date.UTC(2026, 0, 5 + i, 12))),
    );
  }, [locale, timezone]);

  const viewButton = (mode: ViewMode, label: string) => (
    <button
      key={mode}
      type="button"
      onClick={() => setView(mode)}
      className={`rounded-md px-3 py-1.5 text-xs font-medium ${
        view === mode
          ? "bg-neutral-900 text-white"
          : "border border-neutral-300 text-neutral-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">{t("posts.title")}</h1>
        <p className="mt-1 text-sm text-neutral-600">{t("posts.subtitle")}</p>
        <p className="mt-1 text-xs text-neutral-500">
          {t("posts.timezoneNote", { timezone })}
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {targets.length === 0 && !loading && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t("posts.targetEmpty")}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-neutral-200 bg-white p-5 lg:col-span-1">
          <h2 className="text-sm font-semibold text-neutral-900">{t("posts.newPost")}</h2>
          <div className="mt-4 space-y-4">
            <div>
              <span className="text-xs font-medium text-neutral-600">
                {t("posts.targets")}
              </span>
              <div className="mt-1 space-y-1">
                {targets.map((target) => (
                  <label
                    key={target.conversationId}
                    className="flex items-center gap-2 text-sm text-neutral-800"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTargets.includes(target.conversationId)}
                      onChange={() => toggleTarget(target.conversationId)}
                      disabled={!canManage}
                    />
                    <span className="truncate">
                      {target.title ?? target.providerChatId ?? target.conversationId}
                    </span>
                    <span className="text-xs text-neutral-400">{target.provider}</span>
                  </label>
                ))}
              </div>
              {selectedTargets.length > 1 && (
                <p className="mt-1 text-xs text-neutral-500">{t("posts.groupHint")}</p>
              )}
            </div>

            <label className="block">
              <span className="text-xs font-medium text-neutral-600">{t("posts.internalTitle")}</span>
              <input
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                value={title}
                maxLength={255}
                onChange={(event) => setTitle(event.target.value)}
                disabled={!canManage}
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-neutral-600">{t("posts.caption")}</span>
              <textarea
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                rows={5}
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                disabled={!canManage}
              />
              <span className="mt-1 flex justify-between text-xs text-neutral-500">
                <span>{t("posts.captionHint", { max: captionMax })}</span>
                <span className={captionLeft < 0 ? "text-red-600" : ""}>{captionLeft}</span>
              </span>
            </label>

            <div>
              <span className="text-xs font-medium text-neutral-600">{t("posts.media")}</span>
              <p className="text-xs text-neutral-500">{t("posts.mediaHint")}</p>
              <input
                type="file"
                multiple
                className="mt-2 block w-full text-xs"
                onChange={(event) => void onUpload(event.target.files)}
                disabled={!canManage || busy}
              />
              {mediaIds.length > 0 && (
                <p className="mt-2 text-xs text-neutral-600">
                  {t("posts.mediaCount", { count: mediaIds.length })}
                </p>
              )}
            </div>

            <label className="block">
              <span className="text-xs font-medium text-neutral-600">{t("posts.scheduleAt")}</span>
              <input
                type="datetime-local"
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                value={scheduleAt}
                onChange={(event) => setScheduleAt(event.target.value)}
                disabled={!canManage}
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                onClick={() => void onSchedule()}
                disabled={!canSubmit || busy}
              >
                {scheduleAt ? t("posts.schedule") : t("posts.publishNow")}
              </button>
              <button
                type="button"
                className="rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 disabled:opacity-40"
                onClick={() => void onSaveDraft()}
                disabled={!canSubmit || busy}
              >
                {t("posts.saveDraft")}
              </button>
            </div>
            {!canManage && (
              <p className="text-xs text-neutral-500">{t("posts.ownerOnly")}</p>
            )}
          </div>
        </section>

        <section className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {viewButton("month", t("posts.viewCalendar"))}
            {viewButton("week", t("posts.viewWeek"))}
            {viewButton("list", t("posts.viewList"))}
            {view !== "list" && (
              <>
                <span className="mx-1 text-sm font-medium text-neutral-800">
                  {view === "month"
                    ? monthTitle
                    : `${dayKey(weekStart)} — ${dayKey(addDays(weekStart, 6))}`}
                </span>
                <button
                  type="button"
                  className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-700"
                  onClick={() => {
                    if (view === "month") {
                      const prev = addDays({ y: monthCursor.y, m: monthCursor.m, d: 1 }, -1);
                      setMonthCursor({ y: prev.y, m: prev.m, d: 1 });
                    } else {
                      setWeekCursor((cur) => addDays(cur, -7));
                    }
                  }}
                >
                  {t("posts.prevPeriod")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-700"
                  onClick={() => {
                    setMonthCursor(todayTuple);
                    setWeekCursor(todayTuple);
                  }}
                >
                  {t("posts.today")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-700"
                  onClick={() => {
                    if (view === "month") {
                      const next = addDays(
                        { y: monthCursor.y, m: monthCursor.m, d: 1 },
                        32,
                      );
                      setMonthCursor({ y: next.y, m: next.m, d: 1 });
                    } else {
                      setWeekCursor((cur) => addDays(cur, 7));
                    }
                  }}
                >
                  {t("posts.nextPeriod")}
                </button>
              </>
            )}
          </div>

          {view !== "list" && unscheduledCount > 0 && (
            <p className="mb-3 text-xs text-neutral-500">
              {t("posts.unscheduledNote", { count: unscheduledCount })}
            </p>
          )}

          {loading && posts.length === 0 ? (
            <p className="text-sm text-neutral-500">…</p>
          ) : view === "list" ? (
            posts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
                {t("posts.empty")}
              </div>
            ) : (
              <ul className="space-y-3">
                {posts.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    t={t}
                    locale={locale}
                    timezone={timezone}
                    canManage={canManage}
                    busy={busy}
                    toIso={toIso}
                    run={run}
                    tenantId={tenantId}
                  />
                ))}
              </ul>
            )
          ) : (
            <CalendarGrid
              view={view}
              monthCursor={monthCursor}
              weekStart={weekStart}
              todayKey={dayKey(todayTuple)}
              weekdayLabels={weekdayLabels}
              postsByDay={postsByDay}
              t={t}
              locale={locale}
              timezone={timezone}
              canManage={canManage}
              onDropPost={movePostToDay}
            />
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kisi kalender (bulan / minggu). Sel menerima jatuhan drag dari chip
// postingan; chip hanya bisa diseret untuk draft/terjadwal oleh
// owner/admin — status lain adalah riwayat atau sedang berjalan.
// ---------------------------------------------------------------------------

interface CalendarGridProps {
  view: "month" | "week";
  monthCursor: DayTuple;
  weekStart: DayTuple;
  todayKey: string;
  weekdayLabels: string[];
  postsByDay: Map<string, PostResponse[]>;
  t: Translate;
  locale: Locale;
  timezone: string;
  canManage: boolean;
  onDropPost: (post: PostResponse, day: DayTuple) => void;
}

function CalendarGrid({
  view,
  monthCursor,
  weekStart,
  todayKey,
  weekdayLabels,
  postsByDay,
  t,
  locale,
  timezone,
  canManage,
  onDropPost,
}: CalendarGridProps) {
  const cells: DayTuple[] = useMemo(() => {
    if (view === "week") {
      return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    }
    const start = mondayOf({ y: monthCursor.y, m: monthCursor.m, d: 1 });
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [view, monthCursor, weekStart]);

  const postById = useMemo(() => {
    const map = new Map<string, PostResponse>();
    for (const items of postsByDay.values()) {
      for (const post of items) map.set(post.id, post);
    }
    return map;
  }, [postsByDay]);

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="grid grid-cols-7 border-b border-neutral-200 bg-neutral-50">
        {weekdayLabels.map((label, i) => (
          <div
            key={i}
            className="px-2 py-1.5 text-center text-xs font-medium text-neutral-500"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day) => {
          const key = dayKey(day);
          const items = postsByDay.get(key) ?? [];
          const inMonth = view === "week" || day.m === monthCursor.m;
          return (
            <div
              key={key}
              className={`min-h-24 border-b border-r border-neutral-100 p-1.5 ${
                inMonth ? "" : "bg-neutral-50 text-neutral-400"
              } ${key === todayKey ? "bg-amber-50" : ""}`}
              onDragOver={(event) => {
                if (canManage) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const postId = event.dataTransfer.getData("text/post-id");
                const post = postId ? postById.get(postId) : undefined;
                if (post) onDropPost(post, day);
              }}
            >
              <div className="text-xs font-medium">{day.d}</div>
              <div className="mt-1 space-y-1">
                {items.map((post) => {
                  const draggable =
                    canManage &&
                    (post.status === "draft" || post.status === "scheduled");
                  return (
                    <div
                      key={post.id}
                      draggable={draggable}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/post-id", post.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      title={post.title}
                      className={`rounded px-1.5 py-0.5 text-[11px] leading-tight ${STATUS_STYLE[post.status]} ${
                        draggable ? "cursor-grab" : ""
                      }`}
                    >
                      <span className="font-medium">
                        {post.scheduledAt
                          ? formatTime(post.scheduledAt, locale, timezone)
                          : ""}
                      </span>{" "}
                      <span className="break-words">{post.title}</span>
                      {post.groupId && (
                        <span className="ml-1 rounded bg-white/60 px-1">
                          {t("posts.groupBadge")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kartu postingan pada tampilan Daftar — semua aksi baris tinggal di
// sini, termasuk pemulihan manual (retry / bebaskan) dan duplikat.
// ---------------------------------------------------------------------------

interface PostCardProps {
  post: PostResponse;
  t: Translate;
  locale: Locale;
  timezone: string;
  canManage: boolean;
  busy: boolean;
  tenantId: string | null;
  toIso: (local: string) => string | null;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}

function PostCard({
  post,
  t,
  locale,
  timezone,
  canManage,
  busy,
  tenantId,
  toIso,
  run,
}: PostCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [moveAt, setMoveAt] = useState("");
  const movable =
    post.status === "draft" || post.status === "scheduled" || post.status === "failed";

  return (
    <li className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[post.status]}`}
            >
              {t(STATUS_KEY[post.status])}
            </span>
            {post.groupId && (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
                {t("posts.groupBadge")}
              </span>
            )}
            <span className="truncate text-sm font-medium text-neutral-900">
              {post.title}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {post.target.title ?? post.target.providerChatId}
            {post.media.length > 0
              ? ` · ${t("posts.mediaCount", { count: post.media.length })}`
              : ""}
          </p>
          {post.caption && (
            <p className="mt-2 line-clamp-2 text-sm text-neutral-700">{post.caption}</p>
          )}
          <p className="mt-2 text-xs text-neutral-500">
            {post.status === "published" && post.publishedAt
              ? formatDateTime(post.publishedAt, locale, timezone)
              : post.scheduledAt
                ? formatDateTime(post.scheduledAt, locale, timezone)
                : "—"}
            {post.errorCode ? ` · ${post.errorCode}` : ""}
          </p>
          {post.errorCode === "publish_outcome_unknown" && (
            <p className="mt-1 text-xs text-amber-700">
              {t("posts.outcomeUnknownHint")}
            </p>
          )}
        </div>

        {canManage && tenantId && (
          <div className="flex shrink-0 flex-col items-end gap-2">
            {post.status === "draft" && (
              <button
                type="button"
                className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                disabled={busy}
                onClick={() =>
                  void run(() => api.posts.schedule(tenantId, post.id, null))
                }
              >
                {t("posts.publishNow")}
              </button>
            )}
            {post.status === "failed" && (
              <button
                type="button"
                className="rounded-md bg-red-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                disabled={busy}
                onClick={() =>
                  void run(() => api.posts.retry(tenantId, post.id, toIso(moveAt)))
                }
              >
                {t("posts.retry")}
              </button>
            )}
            {post.status === "publishing" && (
              <button
                type="button"
                className="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 disabled:opacity-40"
                disabled={busy}
                onClick={() => {
                  if (!confirmingRelease) {
                    setConfirmingRelease(true);
                    return;
                  }
                  setConfirmingRelease(false);
                  void run(() => api.posts.releaseStuck(tenantId, post.id));
                }}
              >
                {confirmingRelease
                  ? t("posts.confirmReleaseStuck")
                  : t("posts.releaseStuck")}
              </button>
            )}
            <button
              type="button"
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 disabled:opacity-40"
              disabled={busy}
              onClick={() => void run(() => api.posts.duplicate(tenantId, post.id))}
            >
              {t("posts.duplicate")}
            </button>
            {(post.status === "draft" || post.status === "scheduled") && (
              <button
                type="button"
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 disabled:opacity-40"
                disabled={busy}
                onClick={() => void run(() => api.posts.cancel(tenantId, post.id))}
              >
                {t("posts.cancelScheduled")}
              </button>
            )}
            {(post.status === "draft" || post.status === "cancelled") && (
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs text-red-700 disabled:opacity-40"
                disabled={busy}
                onClick={() => {
                  if (!confirmingDelete) {
                    setConfirmingDelete(true);
                    return;
                  }
                  setConfirmingDelete(false);
                  void run(() => api.posts.remove(tenantId, post.id));
                }}
              >
                {confirmingDelete ? t("posts.confirmDelete") : t("posts.delete")}
              </button>
            )}
            {movable && (
              <label className="flex items-center gap-1 text-xs text-neutral-500">
                <span>{t("posts.moveTo")}</span>
                <input
                  type="datetime-local"
                  className="rounded-md border border-neutral-300 px-1.5 py-1 text-xs"
                  value={moveAt}
                  onChange={(event) => setMoveAt(event.target.value)}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 disabled:opacity-40"
                  disabled={busy || !moveAt}
                  onClick={() => {
                    const iso = toIso(moveAt);
                    if (!iso) return;
                    if (post.status === "failed") {
                      void run(() => api.posts.retry(tenantId, post.id, iso));
                    } else {
                      void run(() => api.posts.schedule(tenantId, post.id, iso));
                    }
                  }}
                >
                  {t("posts.moveApply")}
                </button>
              </label>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
