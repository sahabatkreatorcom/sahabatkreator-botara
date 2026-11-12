import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale, createTranslator } from "@sahabat-kreator/i18n";
import {
  getPostProviderCapability,
  type PinterestBoard,
  type PinterestBoardPrivacy,
  type PostApprovalHistoryEntry,
  type PostApprovalStatus,
  type PostPublishOptions,
  type PostResponse,
  type PostStatus,
  type PostTarget,
} from "@sahabat-kreator/contracts";

import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { formatDateTime, formatTime, zonedLocalToIso } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import {
  composerFormForDay,
  composerFormForPost,
  emptyComposerForm,
  isComposerDirty,
  localDateTimeValue,
  type ComposerFormState,
} from "./postsComposer";
import { PostRecurrenceSection } from "./posts/PostRecurrenceSection";
import { PostQueueSection } from "./posts/PostQueueSection";

/**
 * Halaman Jadwal Konten (Fase 23, diperluas Gelombang 0).
 *
 * Satu halaman: tampilan jadwal LEBAR PENUH dengan tiga mode —
 * Kalender (bulan), Minggu, Daftar — dan komposer postingan sebagai
 * DRAWER geser dari kanan (gelombang Drawer). Kalender adalah
 * permukaan kerja utama; formulir hanya muncul saat dibutuhkan:
 * tombol "Postingan baru", klik tanggal pada kalender (jam tayang
 * terisi awal pada tanggal itu), atau klik postingan draf (mode
 * ubah — edit memang hanya berlaku untuk draf, ditegakkan core).
 * Menutup drawer dengan isi yang berubah dari keadaan awal membuka
 * konfirmasi buang perubahan; drawer bersih menutup tanpa tanya.
 * Aksi baris yang tidak bisa dibatalkan tetap memakai pola dua
 * langkah sebaris (klik → tombol berubah jadi konfirmasi), sama
 * seperti Broadcasts.
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
 * - Opsi penerbitan per sasaran (gelombang Pilihan Privasi & AI):
 *   sasaran YouTube/TikTok/Pinterest menampilkan sub-formulir dari
 *   capability providernya — privasi + pernyataan AI (YouTube:
 *   privasi mulai dari bawaan platform; TikTok: privasi mulai
 *   KOSONG karena guidelines mewajibkan kreator memilih sendiri),
 *   toggle interaksi + pengungkapan komersial TikTok, dan board
 *   tujuan Pin (dropdown akun + buat board baru sebaris). Pilihan
 *   wajib diperiksa lokal sebelum penjadwalan; server menegakkan
 *   gerbang yang sama.
 */

interface PostsPageProps {
  t: ReturnType<typeof createTranslator>;
  locale: Locale;
}

type Translate = PostsPageProps["t"];

const STATUS_STYLE: Record<PostStatus, string> = {
  draft: "bg-elevated text-muted",
  scheduled: "bg-warning/15 text-warning",
  publishing: "bg-accent/15 text-accent",
  published: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-elevated text-muted opacity-60",
};

const STATUS_KEY: Record<PostStatus, Parameters<Translate>[0]> = {
  draft: "posts.statusDraft",
  scheduled: "posts.statusScheduled",
  publishing: "posts.statusPublishing",
  published: "posts.statusPublished",
  failed: "posts.statusFailed",
  cancelled: "posts.statusCancelled",
};

// Lencana persetujuan (Fase Susulan S1) — mesin status kedua di
// samping status publikasi: "sudah boleh tayang atau belum".
const APPROVAL_STYLE: Record<PostApprovalStatus, string> = {
  draft: "bg-elevated text-muted",
  pending_review: "bg-accent/15 text-accent",
  approved: "bg-success/15 text-success",
  rejected: "bg-danger/15 text-danger",
  changes_requested: "bg-warning/15 text-warning",
};

const APPROVAL_KEY: Record<PostApprovalStatus, Parameters<Translate>[0]> = {
  draft: "posts.approvalDraft",
  pending_review: "posts.approvalPending",
  approved: "posts.approvalApproved",
  rejected: "posts.approvalRejected",
  changes_requested: "posts.approvalChanges",
};

/** Label riwayat keputusan dari aksi audit (S1). */
const APPROVAL_HISTORY_KEY: Record<string, Parameters<Translate>[0]> = {
  "post.approval_submitted": "posts.approvalHistorySubmitted",
  "post.approval_approved": "posts.approvalHistoryApproved",
  "post.approval_rejected": "posts.approvalHistoryRejected",
  "post.approval_changes_requested": "posts.approvalHistoryChanges",
  "post.publish_blocked_approval": "posts.approvalHistoryBlocked",
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

// `localDateTimeValue` tinggal di ./postsComposer (logika murni
// komposer) dan diimpor di atas — satu-satunya pemakai lain di sini
// adalah geser jadwal drag di bawah.

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
  // Persetujuan (S1): sakelar tenant + saringan antrean tinjauan.
  // Sakelar mati (bawaan) → seluruh permukaan persetujuan halaman ini
  // tidak digambar, perilaku halaman persis seperti sebelum S1.
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);

  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [scheduleAt, setScheduleAt] = useState("");
  /**
   * Opsi penerbitan per sasaran (gelombang Pilihan Privasi & AI):
   * pilihan pengguna pada formulir ini, dikunci per conversationId
   * sasaran — grup multi-target membawa pilihan platformnya
   * masing-masing, persis model data di core.
   */
  const [optionsByTarget, setOptionsByTarget] = useState<
    Record<string, PostPublishOptions>
  >({});
  const setTargetOption = (
    conversationId: string,
    patch: Partial<PostPublishOptions>,
  ) =>
    setOptionsByTarget((current) => ({
      ...current,
      [conversationId]: { ...current[conversationId], ...patch },
    }));
  /** Bentuk kirim: field tak terisi (undefined) dibuang; kosong = tanpa opsi. */
  const optionsFor = (
    conversationId: string,
  ): PostPublishOptions | undefined => {
    const raw = optionsByTarget[conversationId];
    if (!raw) return undefined;
    const clean = Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined),
    ) as PostPublishOptions;
    return Object.keys(clean).length > 0 ? clean : undefined;
  };

  // -- Drawer komposer -------------------------------------------------------
  // Komposer tidak lagi kolom permanen: ia drawer dari kanan dengan
  // tiga keadaan — tertutup, buat-baru, ubah (draf). `composerInitial`
  // adalah potret keadaan formulir saat drawer dibuka; penjaga tutup
  // membandingkan isi sekarang terhadap potret itu (postsComposer).
  type ComposerMode =
    | { kind: "closed" }
    | { kind: "create" }
    | { kind: "edit"; postId: string };
  const [composer, setComposer] = useState<ComposerMode>({ kind: "closed" });
  const [composerInitial, setComposerInitial] =
    useState<ComposerFormState | null>(null);
  const composerOpen = composer.kind !== "closed";

  const currentForm = (): ComposerFormState => ({
    selectedTargets,
    title,
    caption,
    mediaIds,
    scheduleAt,
    optionsByTarget,
  });
  const composerDirty =
    composerInitial !== null && isComposerDirty(composerInitial, currentForm());

  const applyForm = (form: ComposerFormState) => {
    setSelectedTargets(form.selectedTargets);
    setTitle(form.title);
    setCaption(form.caption);
    setMediaIds(form.mediaIds);
    setScheduleAt(form.scheduleAt);
    setOptionsByTarget(form.optionsByTarget);
  };

  /** Buka buat-baru; `day` terisi = klik tanggal (jam tayang terisi awal). */
  const openCreate = (day?: DayTuple) => {
    const fallbackTarget = targets[0]?.conversationId ?? null;
    const form = day
      ? composerFormForDay(day, fallbackTarget)
      : emptyComposerForm(fallbackTarget);
    applyForm(form);
    setComposerInitial(form);
    setError(null);
    setComposer({ kind: "create" });
  };

  /** Buka mode ubah untuk satu draf (edit di core memang draf saja). */
  const openEdit = (post: PostResponse) => {
    if (post.status !== "draft") return;
    const form = composerFormForPost(post, timezone);
    applyForm(form);
    setComposerInitial(form);
    setError(null);
    setComposer({ kind: "edit", postId: post.id });
  };

  const closeComposer = () => {
    setComposer({ kind: "closed" });
    setComposerInitial(null);
  };

  /**
   * Semua jalur tutup (×, Esc, klik scrim) lewat sini: isi yang
   * berubah dari keadaan awal wajib dikonfirmasi buangnya dulu —
   * pola konfirmasi dialog belum ada di aplikasi ini, jadi memakai
   * window.confirm yang sudah diterjemahkan (pesan posts.discardChanges).
   */
  const requestCloseComposer = () => {
    if (composerDirty && !window.confirm(t("posts.discardChanges"))) return;
    closeComposer();
  };
  const requestCloseRef = useRef(requestCloseComposer);
  requestCloseRef.current = requestCloseComposer;

  // Esc menutup drawer (tunduk pada penjaga kotor lewat ref di atas).
  useEffect(() => {
    if (!composerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [composerOpen]);

  // Fokus awal ke kolom judul setiap drawer dibuka (mode tidak bisa
  // berganti selagi drawer terbuka, jadi transisi terbuka saja cukup).
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (composerOpen) titleInputRef.current?.focus();
  }, [composerOpen]);

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
      const [list, targetList, approvalSettings] = await Promise.all([
        api.posts.list(tenantId),
        api.posts.targets(tenantId),
        // Pengaturan persetujuan gagal dimuat TIDAK boleh menjatuhkan
        // halaman jadwal: halaman jatuh ke perilaku tanpa gerbang.
        api.posts.getApprovalSettings(tenantId).catch(() => null),
      ]);
      if (approvalSettings) {
        setApprovalRequired(approvalSettings.approvalRequired);
      }
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
        publishOptions: optionsFor(selectedTargets[0]!),
      });
      return [created];
    }
    const group = await api.posts.createGroup(tenantId, {
      title: title.trim(),
      caption,
      mediaIds,
      targets: selectedTargets.map((conversationId) => ({
        conversationId,
        publishOptions: optionsFor(conversationId),
      })),
    });
    return group.items;
  };

  const resetForm = () => {
    setTitle("");
    setCaption("");
    setMediaIds([]);
    setScheduleAt("");
    setOptionsByTarget({});
  };

  /**
   * Pilihan wajib SEBELUM penjadwalan (cermin gerbang core, agar
   * pengguna tidak ditinggal dengan draft setengah terjadwal):
   * pengungkapan AI untuk YouTube/TikTok, privasi untuk TikTok
   * (guidelines: dipilih pengguna, tanpa nilai bawaan), dan
   * larangan konten bermerek privat di TikTok. Mengembalikan pesan
   * error siap tampil atau null bila lengkap.
   */
  const optionsScheduleError = (): string | null => {
    for (const target of targets) {
      if (!selectedTargets.includes(target.conversationId)) continue;
      const capability = getPostProviderCapability(target.provider);
      if (!capability) continue;
      const options = optionsFor(target.conversationId);
      if (
        capability.publishOptions.supportsAiDisclosure &&
        typeof options?.aiGenerated !== "boolean"
      ) {
        return t("posts.optionsAiRequired", {
          target: target.title ?? target.provider,
        });
      }
      if (target.provider === "tiktok") {
        if (!options?.tiktokPrivacyLevel) {
          return t("posts.optionsTiktokPrivacyRequired", {
            target: target.title ?? target.provider,
          });
        }
        if (
          options.tiktokBrandContent === true &&
          options.tiktokPrivacyLevel === "SELF_ONLY"
        ) {
          return t("posts.optionsTiktokBrandedPrivate");
        }
      }
    }
    return null;
  };

  /**
   * Simpan dari drawer — satu-satunya jalur kirim komposer sekarang.
   * `scheduleAfter` = tombol utama (jadwalkan / terbitkan sekarang);
   * tanpa itu tombol sekunder (simpan draf / simpan perubahan).
   * Drawer HANYA menutup bila simpan berhasil; kegagalan meninggalkan
   * drawer terbuka dengan banner error di dalamnya.
   */
  const submitComposer = async (scheduleAfter: boolean) => {
    // Pilihan wajib diperiksa LOKAL lebih dulu sebelum penjadwalan:
    // tanpa ini pengguna ditinggal dengan draft yang gagal di tengah
    // penjadwalan (server menegakkan gerbang yang sama persis lewat API).
    if (scheduleAfter) {
      const optionsError = optionsScheduleError();
      if (optionsError) {
        setError(optionsError);
        return;
      }
    }
    if (composer.kind === "edit") {
      const postId = composer.postId;
      const ok = await run(async () => {
        if (!tenantId) return;
        // Sasaran terkunci pada sasaran postingan; opsi dikirim apa
        // adanya dari formulir (kosong = null eksplisit = kosongkan,
        // semantik PATCH di kontrak).
        await api.posts.update(tenantId, postId, {
          title: title.trim(),
          caption,
          mediaIds,
          publishOptions: optionsFor(selectedTargets[0]!) ?? null,
        });
        if (scheduleAfter) {
          await api.posts.schedule(tenantId, postId, toIso(scheduleAt));
        }
      });
      if (ok) closeComposer();
      return;
    }
    const ok = await run(async () => {
      if (!tenantId) return;
      const created = await createDrafts();
      if (scheduleAfter) {
        const iso = toIso(scheduleAt);
        for (const post of created) {
          await api.posts.schedule(tenantId, post.id, iso);
        }
      }
      if (created.length > 0) resetForm();
    });
    if (ok) closeComposer();
  };

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

  // Antrean tinjauan (S1): saringan tampilan Daftar ke postingan yang
  // menunggu keputusan. Hitungan selalu dari daftar penuh yang sudah
  // dimuat — bukan panggilan API kedua.
  const pendingReviewCount = posts.filter(
    (post) => post.approvalStatus === "pending_review",
  ).length;
  const visiblePosts = reviewOnly
    ? posts.filter((post) => post.approvalStatus === "pending_review")
    : posts;

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
      onClick={() => {
        setView(mode);
        // Saringan antrean tinjauan adalah modus tampilan Daftar;
        // berpindah ke kalender membersihkannya agar tidak membingungkan.
        if (mode !== "list") setReviewOnly(false);
      }}
      className={`rounded-md px-3 py-1.5 text-xs font-medium ${
        view === mode
          ? "bg-accent text-white"
          : "border border-line bg-surface text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <h1 className="text-xl font-semibold text-ink">{t("posts.title")}</h1>
          <p className="mt-0.5 text-sm text-muted">{t("posts.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted">
            {t("posts.timezoneNote", { timezone })}
          </p>
          {canManage && (
            <button
              type="button"
              onClick={() => openCreate()}
              className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-white"
            >
              + {t("posts.newPost")}
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {targets.length === 0 && !loading && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {t("posts.targetEmpty")}
        </div>
      )}

      {composerOpen && (
        <PostComposerDrawer
          t={t}
          title={
            composer.kind === "edit" ? t("posts.editPost") : t("posts.newPost")
          }
          onClose={requestCloseComposer}
        >
          {error && (
            <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
          <div className="space-y-3">
            <div>
              <span className="text-xs font-medium text-muted">
                {t("posts.targets")}
              </span>
              <div className="mt-1 space-y-1">
                {targets.map((target) => (
                  <label
                    key={target.conversationId}
                    className="flex items-center gap-2 text-sm text-ink"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTargets.includes(target.conversationId)}
                      onChange={() => toggleTarget(target.conversationId)}
                      disabled={!canManage || composer.kind === "edit"}
                    />
                    <span className="truncate">
                      {target.title ?? target.providerChatId ?? target.conversationId}
                    </span>
                    <span className="text-xs text-muted">{target.provider}</span>
                  </label>
                ))}
              </div>
              {selectedTargets.length > 1 && (
                <p className="mt-1 text-xs text-muted">{t("posts.groupHint")}</p>
              )}
            </div>

            {targets
              .filter((target) =>
                selectedTargets.includes(target.conversationId),
              )
              .map((target) => {
                const capability = getPostProviderCapability(target.provider);
                if (!capability) return null;
                const surface = capability.publishOptions;
                const hasSurface =
                  surface.privacyValues.length > 0 ||
                  surface.supportsAiDisclosure ||
                  surface.supportsBoardChoice;
                if (!hasSurface) return null;
                return (
                  <PublishOptionsFields
                    key={target.conversationId}
                    t={t}
                    tenantId={tenantId}
                    target={target}
                    options={optionsByTarget[target.conversationId] ?? {}}
                    onChange={(patch) =>
                      setTargetOption(target.conversationId, patch)
                    }
                    disabled={!canManage}
                  />
                );
              })}

            <label className="block">
              <span className="text-xs font-medium text-muted">{t("posts.internalTitle")}</span>
              <input
                ref={titleInputRef}
                className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                value={title}
                maxLength={255}
                onChange={(event) => setTitle(event.target.value)}
                disabled={!canManage}
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-muted">{t("posts.caption")}</span>
              <textarea
                className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                rows={7}
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                disabled={!canManage}
              />
              <span className="mt-1 flex items-start justify-between gap-2 text-xs text-muted">
                <span>{t("posts.captionHint", { max: captionMax })}</span>
                <span className={`shrink-0 ${captionLeft < 0 ? "text-danger" : ""}`}>
                  {captionLeft}
                </span>
              </span>
            </label>

            <div>
              <span className="text-xs font-medium text-muted">{t("posts.media")}</span>
              <p className="text-xs text-muted">{t("posts.mediaHint")}</p>
              <input
                type="file"
                multiple
                className="mt-2 block w-full text-xs text-muted"
                onChange={(event) => void onUpload(event.target.files)}
                disabled={!canManage || busy}
              />
              {mediaIds.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  {t("posts.mediaCount", { count: mediaIds.length })}
                </p>
              )}
            </div>

            <label className="block">
              <span className="text-xs font-medium text-muted">{t("posts.scheduleAt")}</span>
              <input
                type="datetime-local"
                className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
                value={scheduleAt}
                onChange={(event) => setScheduleAt(event.target.value)}
                disabled={!canManage}
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                onClick={() => void submitComposer(true)}
                disabled={!canSubmit || busy}
              >
                {scheduleAt ? t("posts.schedule") : t("posts.publishNow")}
              </button>
              <button
                type="button"
                className="rounded-md border border-line bg-surface px-3 py-2 text-xs font-medium text-ink disabled:opacity-40"
                onClick={() => void submitComposer(false)}
                disabled={!canSubmit || busy}
              >
                {composer.kind === "edit"
                  ? t("posts.saveChanges")
                  : t("posts.saveDraft")}
              </button>
            </div>
            {!canManage && (
              <p className="text-xs text-muted">{t("posts.ownerOnly")}</p>
            )}
          </div>
        </PostComposerDrawer>
      )}

      <section>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {viewButton("month", t("posts.viewCalendar"))}
            {viewButton("week", t("posts.viewWeek"))}
            {viewButton("list", t("posts.viewList"))}
            {approvalRequired && (
              <button
                type="button"
                onClick={() => {
                  setReviewOnly((current) => !current);
                  setView("list");
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  reviewOnly
                    ? "bg-accent text-white"
                    : "border border-line bg-surface text-ink"
                }`}
              >
                {t("posts.approvalQueue", { count: pendingReviewCount })}
              </button>
            )}
            {view !== "list" && (
              <>
                <span className="mx-1 text-sm font-medium text-ink">
                  {view === "month"
                    ? monthTitle
                    : `${dayKey(weekStart)} — ${dayKey(addDays(weekStart, 6))}`}
                </span>
                <button
                  type="button"
                  className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
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
                  className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                  onClick={() => {
                    setMonthCursor(todayTuple);
                    setWeekCursor(todayTuple);
                  }}
                >
                  {t("posts.today")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
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
            <p className="mb-2 text-xs text-muted">
              {t("posts.unscheduledNote", { count: unscheduledCount })}
            </p>
          )}

          {loading && posts.length === 0 ? (
            <p className="text-sm text-muted">…</p>
          ) : view === "list" ? (
            visiblePosts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
                {reviewOnly ? t("posts.approvalQueueEmpty") : t("posts.empty")}
              </div>
            ) : (
              <ul className="space-y-3">
                {visiblePosts.map((post) => (
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
                    approvalRequired={approvalRequired}
                    onEdit={openEdit}
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
              onSelectDay={openCreate}
              onSelectPost={openEdit}
            />
          )}
      </section>

      <PostRecurrenceSection
        t={t}
        locale={locale}
        tenantId={tenantId}
        canManage={canManage}
        approvalRequired={approvalRequired}
      />
      <PostQueueSection
        t={t}
        locale={locale}
        tenantId={tenantId}
        canManage={canManage}
        approvalRequired={approvalRequired}
        targets={targets}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer komposer — panel geser dari kanan di atas scrim, mengikuti
// pola overlay aplikasi (fixed inset-0 + bg-black/50 seperti modal
// AgentsPage & lembar More). Lebar lapang ±700px (maks 94vw); di
// layar kecil memenuhi layar. Klik pada scrim (area di luar panel)
// adalah jalur tutup — semua jalur tutup melewati penjaga kotor di
// PostsPage, komponen ini hanya meneruskan niat menutup.
// ---------------------------------------------------------------------------

interface PostComposerDrawerProps {
  t: Translate;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function PostComposerDrawer({
  t,
  title,
  onClose,
  children,
}: PostComposerDrawerProps) {
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full flex-col bg-surface shadow-xl sm:w-[700px] sm:max-w-[94vw]">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kisi kalender (bulan / minggu). Sel menerima jatuhan drag dari chip
// postingan; chip hanya bisa diseret untuk draft/terjadwal oleh
// owner/admin — status lain adalah riwayat atau sedang berjalan.
// Klik sel membuka komposer buat-baru pada tanggal itu; klik chip
// draf membuka mode ubah — klik tidak ikut campur drag (drag
// berakhir tanpa klik, jatuhan ditangani onDrop seperti biasa).
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
  onSelectDay: (day: DayTuple) => void;
  onSelectPost: (post: PostResponse) => void;
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
  onSelectDay,
  onSelectPost,
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

  // Sorotan sel tujuan saat chip diseret di atasnya — murni presentasi,
  // tidak mengubah logika jatuhan (drop tetap lewat onDrop di bawah).
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="grid grid-cols-7 border-b border-line bg-elevated">
        {weekdayLabels.map((label, i) => (
          <div
            key={i}
            className="px-2 py-1.5 text-center text-xs font-medium text-muted"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day) => {
          const key = dayKey(day);
          const items = postsByDay.get(key) ?? [];
          // Batas chip yang DITAMPILKAN per sel (murni presentasi):
          // pengelompokan dan drag tidak berubah; kelebihan chip
          // diringkas "+N lagi" dan daftar lengkapnya ada di tampilan
          // Daftar. Sel minggu lebih tinggi, jadi memuat lebih banyak.
          const maxChips = view === "week" ? 6 : 3;
          const visibleItems = items.slice(0, maxChips);
          const inMonth = view === "week" || day.m === monthCursor.m;
          return (
            <div
              key={key}
              className={`${view === "week" ? "min-h-44" : "min-h-28"} border-b border-r border-line p-1.5 ${
                inMonth ? "" : "bg-elevated/50 text-muted"
              } ${key === todayKey ? "bg-warning/10" : ""} ${
                dragOverKey === key ? "bg-accent/10" : ""
              } ${canManage ? "cursor-pointer" : ""}`}
              onDragOver={(event) => {
                if (canManage) {
                  event.preventDefault();
                  setDragOverKey(key);
                }
              }}
              onDragLeave={() => {
                setDragOverKey((current) => (current === key ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragOverKey(null);
                const postId = event.dataTransfer.getData("text/post-id");
                const post = postId ? postById.get(postId) : undefined;
                if (post) onDropPost(post, day);
              }}
              onClick={() => {
                if (canManage) onSelectDay(day);
              }}
            >
              <div className="text-xs font-medium">{day.d}</div>
              <div className="mt-1 space-y-1">
                {visibleItems.map((post) => {
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
                      onClick={(event) => {
                        // Chip draf = pintu mode ubah; hentikan
                        // rambatannya agar tidak ikut membuka
                        // buat-baru tanggal selnya. Chip status lain
                        // tidak menahan klik — kliknya milik sel.
                        if (canManage && post.status === "draft") {
                          event.stopPropagation();
                          onSelectPost(post);
                        }
                      }}
                      className={`rounded px-1.5 py-0.5 text-[11px] leading-tight ${STATUS_STYLE[post.status]} ${
                        canManage && post.status === "draft"
                          ? "cursor-pointer"
                          : draggable
                            ? "cursor-grab"
                            : ""
                      }`}
                    >
                      <span className="font-medium">
                        {post.scheduledAt
                          ? formatTime(post.scheduledAt, locale, timezone)
                          : ""}
                      </span>{" "}
                      <span className="break-words">{post.title}</span>
                      {post.groupId && (
                        <span className="ml-1 rounded bg-surface/60 px-1">
                          {t("posts.groupBadge")}
                        </span>
                      )}
                      {post.approvalStatus === "pending_review" && (
                        <span className="ml-1 rounded bg-surface/60 px-1">
                          {t("posts.approvalPendingShort")}
                        </span>
                      )}
                    </div>
                  );
                })}
                {items.length > visibleItems.length && (
                  <div className="px-1.5 text-[11px] font-medium text-muted">
                    {t("posts.moreCount", {
                      count: items.length - visibleItems.length,
                    })}
                  </div>
                )}
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
  /** Sakelar persetujuan wajib tenant (S1) — mati = permukaan persetujuan disembunyikan. */
  approvalRequired: boolean;
  toIso: (local: string) => string | null;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  onEdit: (post: PostResponse) => void;
}

function PostCard({
  post,
  t,
  locale,
  timezone,
  canManage,
  busy,
  tenantId,
  approvalRequired,
  toIso,
  run,
  onEdit,
}: PostCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [moveAt, setMoveAt] = useState("");
  const movable =
    post.status === "draft" || post.status === "scheduled" || post.status === "failed";

  // -- Persetujuan (S1) -------------------------------------------------------
  const [decisionMode, setDecisionMode] = useState<"reject" | "changes" | null>(
    null,
  );
  const [decisionNote, setDecisionNote] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<
    PostApprovalHistoryEntry[] | null
  >(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const actionablePost =
    post.status === "draft" ||
    post.status === "scheduled" ||
    post.status === "failed";
  const showApprovalBadge =
    approvalRequired || post.approvalStatus !== "draft";
  const canSubmitReview =
    approvalRequired &&
    actionablePost &&
    (post.approvalStatus === "draft" ||
      post.approvalStatus === "rejected" ||
      post.approvalStatus === "changes_requested");
  // Keputusan tetap ditawarkan untuk postingan yang telanjur menunggu
  // walau sakelar tenant kemudian dimatikan — keadaannya harus bisa
  // diselesaikan, bukan menggantung.
  const canReview = post.approvalStatus === "pending_review";
  const showHistory =
    post.approvalStatus !== "draft" ||
    post.errorCode === "post_approval_required";

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && tenantId && historyItems === null) {
      setHistoryLoading(true);
      api.posts
        .approvalHistory(tenantId, post.id)
        .then((data) => setHistoryItems(data.items))
        .catch(() => setHistoryItems([]))
        .finally(() => setHistoryLoading(false));
    }
  };

  const sendDecision = () => {
    if (!tenantId || !decisionMode) return;
    const note = decisionNote.trim();
    if (note.length === 0) return;
    const mode = decisionMode;
    void run(async () => {
      if (mode === "reject") {
        await api.posts.reject(tenantId, post.id, note);
      } else {
        await api.posts.requestChanges(tenantId, post.id, note);
      }
      setDecisionMode(null);
      setDecisionNote("");
      // Riwayat berubah oleh keputusan ini — muat ulang saat dibuka lagi.
      setHistoryItems(null);
    });
  };

  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[post.status]}`}
            >
              {t(STATUS_KEY[post.status])}
            </span>
            {post.groupId && (
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                {t("posts.groupBadge")}
              </span>
            )}
            {showApprovalBadge && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${APPROVAL_STYLE[post.approvalStatus]}`}
              >
                {t(APPROVAL_KEY[post.approvalStatus])}
              </span>
            )}
            <span className="truncate text-sm font-medium text-ink">
              {post.title}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            {post.target.title ?? post.target.providerChatId}
            {post.media.length > 0
              ? ` · ${t("posts.mediaCount", { count: post.media.length })}`
              : ""}
          </p>
          {publishOptionsSummary(t, post) ? (
            <p className="mt-1 text-xs text-muted">
              {publishOptionsSummary(t, post)}
            </p>
          ) : null}
          {post.caption && (
            <p className="mt-2 line-clamp-2 text-sm text-ink">{post.caption}</p>
          )}
          <p className="mt-2 text-xs text-muted">
            {post.status === "published" && post.publishedAt
              ? formatDateTime(post.publishedAt, locale, timezone)
              : post.scheduledAt
                ? formatDateTime(post.scheduledAt, locale, timezone)
                : "—"}
            {post.errorCode ? ` · ${post.errorCode}` : ""}
          </p>
          {post.errorCode === "publish_outcome_unknown" && (
            <p className="mt-1 text-xs text-warning">
              {t("posts.outcomeUnknownHint")}
            </p>
          )}
          {post.errorCode === "post_approval_required" && (
            <p className="mt-1 text-xs text-warning">
              {t("posts.approvalBlockedHint")}
            </p>
          )}
          {post.approvalStatus === "pending_review" &&
            post.approvalSubmittedAt && (
              <p className="mt-1 text-xs text-muted">
                {t("posts.approvalSubmittedInfo", {
                  when: formatDateTime(
                    post.approvalSubmittedAt,
                    locale,
                    timezone,
                  ),
                })}
              </p>
            )}
          {(post.approvalStatus === "rejected" ||
            post.approvalStatus === "changes_requested") &&
            post.approvalNote && (
              <p
                className={`mt-1 text-xs ${
                  post.approvalStatus === "rejected"
                    ? "text-danger"
                    : "text-warning"
                }`}
              >
                {t("posts.approvalNoteShown", { note: post.approvalNote })}
              </p>
            )}
        </div>

        {canManage && tenantId && (
          <div className="flex shrink-0 flex-col items-end gap-2">
            {canSubmitReview && (
              <button
                type="button"
                className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                disabled={busy}
                onClick={() =>
                  void run(() => api.posts.submitReview(tenantId, post.id))
                }
              >
                {t("posts.approvalSubmit")}
              </button>
            )}
            {canReview && (
              <>
                <button
                  type="button"
                  className="rounded-md bg-success px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.posts.approve(tenantId, post.id))
                  }
                >
                  {t("posts.approvalApprove")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-danger/40 bg-surface px-2 py-1 text-xs font-medium text-danger disabled:opacity-40"
                  disabled={busy}
                  onClick={() => {
                    setDecisionMode("reject");
                    setDecisionNote("");
                  }}
                >
                  {t("posts.approvalReject")}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-40"
                  disabled={busy}
                  onClick={() => {
                    setDecisionMode("changes");
                    setDecisionNote("");
                  }}
                >
                  {t("posts.approvalRequestChanges")}
                </button>
              </>
            )}
            {post.status === "draft" && (
              <button
                type="button"
                className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-40"
                disabled={busy}
                onClick={() => onEdit(post)}
              >
                {t("common.edit")}
              </button>
            )}
            {post.status === "draft" && (
              <button
                type="button"
                className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
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
                className="rounded-md bg-danger px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
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
                className="rounded-md border border-danger/40 bg-surface px-2 py-1 text-xs font-medium text-danger disabled:opacity-40"
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
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-40"
              disabled={busy}
              onClick={() => void run(() => api.posts.duplicate(tenantId, post.id))}
            >
              {t("posts.duplicate")}
            </button>
            {(post.status === "draft" || post.status === "scheduled") && (
              <button
                type="button"
                className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-40"
                disabled={busy}
                onClick={() => void run(() => api.posts.cancel(tenantId, post.id))}
              >
                {t("posts.cancelScheduled")}
              </button>
            )}
            {(post.status === "draft" || post.status === "cancelled") && (
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs text-danger disabled:opacity-40"
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
              <label className="flex items-center gap-1 text-xs text-muted">
                <span>{t("posts.moveTo")}</span>
                <input
                  type="datetime-local"
                  className="rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-ink"
                  value={moveAt}
                  onChange={(event) => setMoveAt(event.target.value)}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-40"
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

      {decisionMode && canManage && tenantId && (
        <div className="mt-3 rounded-lg border border-line bg-elevated/50 p-3">
          <label className="block">
            <span className="text-xs font-medium text-muted">
              {decisionMode === "reject"
                ? t("posts.approvalReject")
                : t("posts.approvalRequestChanges")}{" "}
              — {t("posts.approvalNoteLabel")}
            </span>
            <textarea
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
              rows={3}
              maxLength={2000}
              value={decisionNote}
              placeholder={t("posts.approvalNotePlaceholder")}
              onChange={(event) => setDecisionNote(event.target.value)}
            />
          </label>
          {post.groupId && (
            <p className="mt-1 text-xs text-muted">
              {t("posts.approvalGroupHint")}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
              disabled={busy || decisionNote.trim().length === 0}
              onClick={sendDecision}
            >
              {t("posts.approvalSendDecision")}
            </button>
            <button
              type="button"
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
              onClick={() => setDecisionMode(null)}
            >
              {t("posts.approvalCancel")}
            </button>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="mt-3 border-t border-line pt-2">
          <button
            type="button"
            className="text-xs font-medium text-accent"
            onClick={toggleHistory}
          >
            {t("posts.approvalHistoryTitle")}
          </button>
          {historyOpen &&
            (historyLoading ? (
              <p className="mt-1 text-xs text-muted">…</p>
            ) : !historyItems || historyItems.length === 0 ? (
              <p className="mt-1 text-xs text-muted">
                {t("posts.approvalHistoryEmpty")}
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {historyItems.map((item) => (
                  <li key={item.id} className="text-xs text-muted">
                    <span className="font-medium text-ink">
                      {t(
                        APPROVAL_HISTORY_KEY[item.action] ??
                          "posts.approvalHistoryTitle",
                      )}
                    </span>
                    {item.actorLabel
                      ? ` ${t("posts.approvalByActor", { actor: item.actorLabel })}`
                      : ""}
                    {" · "}
                    {formatDateTime(item.createdAt, locale, timezone)}
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Opsi penerbitan per sasaran (gelombang Pilihan Privasi & AI per
// Postingan) — sub-formulir yang digambar dari capability provider:
// platformlah yang menentukan pilihan apa yang ada, formulir hanya
// menampilkannya per sasaran yang dipilih.
// ---------------------------------------------------------------------------

const inputClassName =
  "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink";

/** Ringkasan satu baris opsi pada kartu daftar (indikator seperlunya). */
function publishOptionsSummary(t: Translate, post: PostResponse): string | null {
  const options = post.publishOptions;
  if (!options) return null;
  const parts: string[] = [];
  const privacy = options.youtubePrivacyStatus ?? options.tiktokPrivacyLevel;
  if (privacy) parts.push(`${t("posts.optionsPrivacyLabel")}: ${privacy}`);
  if (options.aiGenerated) parts.push(t("posts.optionsAiBadge"));
  if (options.pinterestBoardId) {
    parts.push(`${t("posts.optionsBoardLabel")}: ${options.pinterestBoardId}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function AiDisclosureField({
  t,
  name,
  value,
  onChange,
  disabled,
}: {
  t: Translate;
  name: string;
  value: boolean | undefined;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <span className="text-xs font-medium text-muted">
        {t("posts.optionsAiLabel")}
      </span>
      <div className="mt-1 space-y-1">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="radio"
            name={name}
            checked={value === true}
            onChange={() => onChange(true)}
            disabled={disabled}
          />
          <span>{t("posts.optionsAiYes")}</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="radio"
            name={name}
            checked={value === false}
            onChange={() => onChange(false)}
            disabled={disabled}
          />
          <span>{t("posts.optionsAiNo")}</span>
        </label>
      </div>
      <p className="mt-1 text-xs text-muted">{t("posts.optionsAiHint")}</p>
    </div>
  );
}

function PublishOptionsFields({
  t,
  tenantId,
  target,
  options,
  onChange,
  disabled,
}: {
  t: Translate;
  tenantId: string | null;
  target: PostTarget;
  options: PostPublishOptions;
  onChange: (patch: Partial<PostPublishOptions>) => void;
  disabled: boolean;
}) {
  const provider = target.provider;
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <p className="text-xs font-semibold text-ink">
        {t("posts.optionsTitle")} — {target.title ?? target.providerChatId}
      </p>

      {provider === "youtube" && (
        <>
          <label className="block">
            <span className="text-xs font-medium text-muted">
              {t("posts.optionsPrivacyLabel")}
            </span>
            <select
              className={inputClassName}
              value={options.youtubePrivacyStatus ?? ""}
              onChange={(event) =>
                onChange({
                  youtubePrivacyStatus:
                    event.target.value === ""
                      ? undefined
                      : (event.target.value as NonNullable<
                          PostPublishOptions["youtubePrivacyStatus"]
                        >),
                })
              }
              disabled={disabled}
            >
              <option value="">{t("posts.optionsYoutubePrivacyDefault")}</option>
              <option value="private">{t("posts.optionsPrivacyPrivate")}</option>
              <option value="unlisted">{t("posts.optionsPrivacyUnlisted")}</option>
              <option value="public">{t("posts.optionsPrivacyPublic")}</option>
            </select>
          </label>
          <AiDisclosureField
            t={t}
            name={`ai-${target.conversationId}`}
            value={options.aiGenerated}
            onChange={(next) => onChange({ aiGenerated: next })}
            disabled={disabled}
          />
          <label className="block">
            <span className="text-xs font-medium text-muted">
              {t("posts.optionsMadeForKidsLabel")}
            </span>
            <select
              className={inputClassName}
              value={
                options.madeForKids === undefined
                  ? ""
                  : String(options.madeForKids)
              }
              onChange={(event) =>
                onChange({
                  madeForKids:
                    event.target.value === ""
                      ? undefined
                      : event.target.value === "true",
                })
              }
              disabled={disabled}
            >
              <option value="">{t("posts.optionsMadeForKidsChannel")}</option>
              <option value="true">{t("posts.optionsMadeForKidsYes")}</option>
              <option value="false">{t("posts.optionsMadeForKidsNo")}</option>
            </select>
          </label>
        </>
      )}

      {provider === "tiktok" && (
        <>
          <label className="block">
            <span className="text-xs font-medium text-muted">
              {t("posts.optionsPrivacyLabel")}
            </span>
            <select
              className={inputClassName}
              value={options.tiktokPrivacyLevel ?? ""}
              onChange={(event) =>
                onChange({
                  tiktokPrivacyLevel:
                    event.target.value === ""
                      ? undefined
                      : (event.target.value as NonNullable<
                          PostPublishOptions["tiktokPrivacyLevel"]
                        >),
                })
              }
              disabled={disabled}
            >
              {/* Guidelines TikTok: privasi dipilih kreator sendiri —
                  pemilih ini SENGAJA mulai kosong, tanpa nilai bawaan. */}
              <option value="">
                {t("posts.optionsTiktokPrivacyPlaceholder")}
              </option>
              <option value="PUBLIC_TO_EVERYONE">
                {t("posts.optionsTiktokPrivacyPublic")}
              </option>
              <option value="FOLLOWER_OF_CREATOR">
                {t("posts.optionsTiktokPrivacyFollowers")}
              </option>
              <option value="MUTUAL_FOLLOW_FRIENDS">
                {t("posts.optionsTiktokPrivacyFriends")}
              </option>
              <option value="SELF_ONLY">
                {t("posts.optionsTiktokPrivacySelfOnly")}
              </option>
            </select>
          </label>
          <AiDisclosureField
            t={t}
            name={`ai-${target.conversationId}`}
            value={options.aiGenerated}
            onChange={(next) => onChange({ aiGenerated: next })}
            disabled={disabled}
          />
          <div>
            <span className="text-xs font-medium text-muted">
              {t("posts.optionsInteractionsLabel")}
            </span>
            <div className="mt-1 space-y-1">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={options.tiktokAllowComment === true}
                  onChange={(event) =>
                    onChange({ tiktokAllowComment: event.target.checked })
                  }
                  disabled={disabled}
                />
                <span>{t("posts.optionsAllowComment")}</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={options.tiktokAllowDuet === true}
                  onChange={(event) =>
                    onChange({ tiktokAllowDuet: event.target.checked })
                  }
                  disabled={disabled}
                />
                <span>{t("posts.optionsAllowDuet")}</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={options.tiktokAllowStitch === true}
                  onChange={(event) =>
                    onChange({ tiktokAllowStitch: event.target.checked })
                  }
                  disabled={disabled}
                />
                <span>{t("posts.optionsAllowStitch")}</span>
              </label>
            </div>
            <p className="mt-1 text-xs text-muted">
              {t("posts.optionsInteractionsHint")}
            </p>
          </div>
          <div>
            <span className="text-xs font-medium text-muted">
              {t("posts.optionsCommercialLabel")}
            </span>
            <div className="mt-1 space-y-1">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={options.tiktokBrandOrganic === true}
                  onChange={(event) =>
                    onChange({ tiktokBrandOrganic: event.target.checked })
                  }
                  disabled={disabled}
                />
                <span>{t("posts.optionsBrandOrganic")}</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={options.tiktokBrandContent === true}
                  onChange={(event) =>
                    onChange({ tiktokBrandContent: event.target.checked })
                  }
                  disabled={disabled}
                />
                <span>{t("posts.optionsBrandContent")}</span>
              </label>
            </div>
            {options.tiktokBrandContent === true &&
              options.tiktokPrivacyLevel === "SELF_ONLY" && (
                <p className="mt-1 text-xs text-warning">
                  {t("posts.optionsBrandedPrivateHint")}
                </p>
              )}
          </div>
        </>
      )}

      {provider === "pinterest" && (
        <PinterestBoardField
          t={t}
          tenantId={tenantId}
          target={target}
          value={options.pinterestBoardId}
          onChange={(boardId) => onChange({ pinterestBoardId: boardId })}
          disabled={disabled}
        />
      )}
    </div>
  );
}

/**
 * Pemilih board Pinterest pada formulir postingan: dropdown board
 * milik akun sasaran (endpoint daftar board Channels yang sama —
 * akun-scope, bukan jalur API kedua) + buat board baru sebaris.
 * Pilihan di sini adalah OPSI POSTINGAN (tidak menimpa bawaan akun);
 * board hasil buat dipilih untuk postingan ini dan — perilaku
 * endpoint Channels yang dipakai — juga menjadi bawaan akun.
 * Daftar gagal dimuat → catatan jujur dan formulir tetap bisa
 * disimpan dengan board kosong (= resolusi bawaan penerbit).
 */
function PinterestBoardField({
  t,
  tenantId,
  target,
  value,
  onChange,
  disabled,
}: {
  t: Translate;
  tenantId: string | null;
  target: PostTarget;
  value: string | undefined;
  onChange: (boardId: string | undefined) => void;
  disabled: boolean;
}) {
  const [boards, setBoards] = useState<PinterestBoard[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPrivacy, setNewPrivacy] =
    useState<PinterestBoardPrivacy>("PUBLIC");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoadFailed(false);
    try {
      const data = await api.channels.pinterestBoards(
        tenantId,
        target.channelAccountId,
      );
      setBoards(data.boards);
    } catch {
      // Kegagalan memuat daftar TIDAK mengunci formulir: board
      // kosong berarti penerbit memakai resolusi bawaannya.
      setLoadFailed(true);
    }
  }, [tenantId, target.channelAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!tenantId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.channels.pinterestBoardCreate(
        tenantId,
        target.channelAccountId,
        {
          name: newName.trim(),
          ...(newDesc.trim() ? { description: newDesc.trim() } : {}),
          privacy: newPrivacy,
        },
      );
      setBoards(created.boards);
      onChange(created.createdBoard.id);
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
      setNewPrivacy("PUBLIC");
    } catch (err) {
      setCreateError(translateApiError(t, err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="text-xs font-medium text-muted">
          {t("posts.optionsBoardLabel")}
        </span>
        <select
          className={inputClassName}
          value={value ?? ""}
          onChange={(event) =>
            onChange(
              event.target.value === "" ? undefined : event.target.value,
            )
          }
          disabled={disabled || boards === null}
        >
          <option value="">{t("posts.optionsBoardDefault")}</option>
          {boards?.map((board) => (
            <option key={board.id} value={board.id}>
              {board.name ?? board.id}
            </option>
          ))}
        </select>
      </label>
      {boards === null && !loadFailed && (
        <p className="text-xs text-muted">{t("posts.optionsBoardLoading")}</p>
      )}
      {loadFailed && (
        <p className="text-xs text-warning">
          {t("posts.optionsBoardLoadFailed")}
        </p>
      )}
      {!showCreate ? (
        <button
          type="button"
          className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-40"
          onClick={() => setShowCreate(true)}
          disabled={disabled}
        >
          {t("channels.pinterestBoardCreateToggle")}
        </button>
      ) : (
        <form onSubmit={(event) => void handleCreate(event)} className="space-y-2">
          <label className="block">
            <span className="text-xs text-muted">
              {t("channels.pinterestBoardNameLabel")}
            </span>
            <input
              className={inputClassName}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t("channels.pinterestBoardNamePlaceholder")}
              maxLength={180}
              required
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">
              {t("channels.pinterestBoardDescLabel")}
            </span>
            <input
              className={inputClassName}
              value={newDesc}
              onChange={(event) => setNewDesc(event.target.value)}
              maxLength={500}
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">
              {t("channels.pinterestBoardPrivacyLabel")}
            </span>
            <select
              className={inputClassName}
              value={newPrivacy}
              onChange={(event) =>
                setNewPrivacy(event.target.value as PinterestBoardPrivacy)
              }
            >
              <option value="PUBLIC">
                {t("channels.pinterestBoardPrivacyPublic")}
              </option>
              <option value="PROTECTED">
                {t("channels.pinterestBoardPrivacyProtected")}
              </option>
            </select>
          </label>
          <p className="text-xs text-muted">
            {t("posts.optionsBoardCreateNote")}
          </p>
          {createError && (
            <p className="text-xs text-danger">{createError}</p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
              disabled={creating || !newName.trim()}
            >
              {creating
                ? t("channels.pinterestBoardCreating")
                : t("channels.pinterestBoardCreateButton")}
            </button>
            <button
              type="button"
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
              onClick={() => setShowCreate(false)}
            >
              {t("posts.cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
