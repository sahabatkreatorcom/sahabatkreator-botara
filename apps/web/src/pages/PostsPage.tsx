import { useCallback, useEffect, useMemo, useState } from "react";
import type { Locale, createTranslator } from "@sahabat-kreator/i18n";
import type {
  PostResponse,
  PostStatus,
  PostTarget,
} from "@sahabat-kreator/contracts";

import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { formatDateTime } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

/**
 * Halaman Jadwal Konten (Fase 23).
 *
 * Satu halaman, dua bagian: formulir di kiri, kalender daftar di kanan.
 * Tidak ada modal — pola dua langkah sebaris (klik → tombol berubah jadi
 * konfirmasi) dipakai untuk aksi yang tidak bisa dibatalkan, sama seperti
 * halaman Broadcasts.
 *
 * Keputusan yang terlihat di UI:
 * - Pemilih channel KOSONG berarti bot belum menjadi admin di channel mana
 *   pun. Yang ditampilkan instruksi, bukan pemilih kosong tanpa penjelasan.
 * - Formulir tidak menyembunyikan batas 1024 karakter: penghitung tampil
 *   dan tombol berhenti sebelum batas itu, karena caption yang ditolak
 *   provider saat jam tayang adalah kegagalan yang paling merugikan.
 * - Draf bisa dijadwalkan langsung dari barisnya (input jam di baris),
 *   tanpa membuka formulir lagi.
 */

interface PostsPageProps {
  t: ReturnType<typeof createTranslator>;
  locale: Locale;
}

const STATUS_STYLE: Record<PostStatus, string> = {
  draft: "bg-neutral-100 text-neutral-700",
  scheduled: "bg-amber-100 text-amber-800",
  publishing: "bg-blue-100 text-blue-800",
  published: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-neutral-100 text-neutral-500",
};

const STATUS_KEY: Record<PostStatus, Parameters<PostsPageProps["t"]>[0]> = {
  draft: "posts.statusDraft",
  scheduled: "posts.statusScheduled",
  publishing: "posts.statusPublishing",
  published: "posts.statusPublished",
  failed: "posts.statusFailed",
  cancelled: "posts.statusCancelled",
};

/** `datetime-local` bekerja di waktu lokal browser; server menerima ISO UTC. */
function toIso(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function PostsPage({ t, locale }: PostsPageProps) {
  const { active } = useWorkspace();
  const tenantId = active?.id ?? null;
  const canManage = active?.role === "owner" || active?.role === "admin";

  const [posts, setPosts] = useState<PostResponse[]>([]);
  const [targets, setTargets] = useState<PostTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const [conversationId, setConversationId] = useState("");
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [scheduleAt, setScheduleAt] = useState("");

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
      setConversationId((current) => current || (targetList.items[0]?.conversationId ?? ""));
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const captionLeft = useMemo(() => 1024 - caption.length, [caption]);
  const canSubmit =
    canManage &&
    Boolean(tenantId) &&
    conversationId.length > 0 &&
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

  const createDraft = async () => {
    if (!tenantId || !canSubmit) return null;
    return api.posts.create(tenantId, {
      conversationId,
      title: title.trim(),
      caption,
      mediaIds,
    });
  };

  const resetForm = () => {
    setTitle("");
    setCaption("");
    setMediaIds([]);
    setScheduleAt("");
  };

  const onSaveDraft = () =>
    run(async () => {
      await createDraft();
      resetForm();
    });

  const onSchedule = () =>
    run(async () => {
      if (!tenantId) return;
      const created = await createDraft();
      if (!created) return;
      await api.posts.schedule(tenantId, created.id, toIso(scheduleAt));
      resetForm();
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

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">{t("posts.title")}</h1>
        <p className="mt-1 text-sm text-neutral-600">{t("posts.subtitle")}</p>
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
            <label className="block">
              <span className="text-xs font-medium text-neutral-600">{t("posts.target")}</span>
              <select
                className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                value={conversationId}
                onChange={(event) => setConversationId(event.target.value)}
                disabled={!canManage || targets.length === 0}
              >
                {targets.map((target) => (
                  <option key={target.conversationId} value={target.conversationId}>
                    {target.title ?? target.providerChatId ?? target.conversationId}
                  </option>
                ))}
              </select>
            </label>

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
                maxLength={1024}
                onChange={(event) => setCaption(event.target.value)}
                disabled={!canManage}
              />
              <span className="mt-1 flex justify-between text-xs text-neutral-500">
                <span>{t("posts.captionHint")}</span>
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
          {loading && posts.length === 0 ? (
            <p className="text-sm text-neutral-500">…</p>
          ) : posts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
              {t("posts.empty")}
            </div>
          ) : (
            <ul className="space-y-3">
              {posts.map((post) => (
                <li
                  key={post.id}
                  className="rounded-xl border border-neutral-200 bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[post.status]}`}
                        >
                          {t(STATUS_KEY[post.status])}
                        </span>
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
                        <p className="mt-2 line-clamp-2 text-sm text-neutral-700">
                          {post.caption}
                        </p>
                      )}
                      <p className="mt-2 text-xs text-neutral-500">
                        {post.status === "published" && post.publishedAt
                          ? formatDateTime(post.publishedAt, locale)
                          : post.scheduledAt
                            ? formatDateTime(post.scheduledAt, locale)
                            : "—"}
                        {post.errorCode ? ` · ${post.errorCode}` : ""}
                      </p>
                    </div>

                    {canManage && (
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        {post.status === "draft" && (
                          <button
                            type="button"
                            className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                api.posts.schedule(tenantId!, post.id, null),
                              )
                            }
                          >
                            {t("posts.publishNow")}
                          </button>
                        )}
                        {(post.status === "draft" || post.status === "scheduled") && (
                          <button
                            type="button"
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 disabled:opacity-40"
                            disabled={busy}
                            onClick={() =>
                              void run(() => api.posts.cancel(tenantId!, post.id))
                            }
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
                              if (confirming !== post.id) {
                                setConfirming(post.id);
                                return;
                              }
                              setConfirming(null);
                              void run(() => api.posts.remove(tenantId!, post.id));
                            }}
                          >
                            {confirming === post.id
                              ? t("posts.confirmDelete")
                              : t("posts.delete")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
