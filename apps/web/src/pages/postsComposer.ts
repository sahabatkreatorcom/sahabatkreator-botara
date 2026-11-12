import type {
  PostPublishOptions,
  PostResponse,
} from "@sahabat-kreator/contracts";

/**
 * Logika murni komposer postingan (drawer /posts).
 *
 * Berkas ini memisahkan keputusan komposer dari rendering React
 * supaya bisa diuji sebagai fungsi murni (pola tes web repo ini):
 * keadaan awal formulir untuk buat-baru / klik-tanggal / mode ubah,
 * dan deteksi "kotor" yang menjadi dasar penjaga perubahan belum
 * tersimpan pada drawer.
 *
 * Keadaan formulir di sini adalah cermin persis state formulir
 * PostsPage: sasaran terpilih, judul, caption, media, jam tayang
 * (`datetime-local` pada zona tenant), dan opsi penerbitan per
 * sasaran.
 */

export interface ComposerFormState {
  selectedTargets: string[];
  title: string;
  caption: string;
  mediaIds: string[];
  /** Nilai `datetime-local` (jam dinding zona tenant); "" = belum diatur. */
  scheduleAt: string;
  optionsByTarget: Record<string, PostPublishOptions>;
}

/** Tupel hari kalender pada zona tenant (sama seperti DayTuple PostsPage). */
export interface ComposerDay {
  y: number;
  m: number;
  d: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `datetime-local` dari tupel hari + jam dinding. */
export function localDateTimeValue(
  day: ComposerDay,
  hh: number,
  mm: number,
): string {
  return `${day.y}-${pad2(day.m)}-${pad2(day.d)}T${pad2(hh)}:${pad2(mm)}`;
}

/**
 * ISO (UTC) → nilai `datetime-local` pada zona tenant. Kebalikan
 * `zonedLocalToIso`; dipakai mode ubah untuk menampilkan jam tayang
 * tersimpan sebagai jam dinding yang dilihat pengguna. ISO tidak
 * valid → "" (diperlakukan seperti belum diatur).
 */
export function isoToLocalDateTimeValue(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return localDateTimeValue(
    { y: value("year"), m: value("month"), d: value("day") },
    value("hour"),
    value("minute"),
  );
}

/** Formulir kosong; sasaran bawaan = sasaran pertama (perilaku muat halaman). */
export function emptyComposerForm(
  defaultTargetId?: string | null,
): ComposerFormState {
  return {
    selectedTargets: defaultTargetId ? [defaultTargetId] : [],
    title: "",
    caption: "",
    mediaIds: [],
    scheduleAt: "",
    optionsByTarget: {},
  };
}

/**
 * Klik tanggal pada kalender: formulir buat-baru dengan jam tayang
 * terisi awal pada tanggal itu. Jamnya 09:00 — konvensi jam bawaan
 * yang sama seperti jatuhan drag pada halaman ini (geser jadwal
 * mempertahankan jam lama, atau 09:00 bila belum ada jam).
 */
export function composerFormForDay(
  day: ComposerDay,
  defaultTargetId?: string | null,
): ComposerFormState {
  return {
    ...emptyComposerForm(defaultTargetId),
    scheduleAt: localDateTimeValue(day, 9, 0),
  };
}

/**
 * Mode ubah: muat satu postingan DRAF ke formulir. Sasaran terkunci
 * pada sasaran milik postingan itu (PATCH tidak bisa memindahkan
 * sasaran), media diambil dari `mediaId` tiap lampiran, dan opsi
 * penerbitan tersimpan menjadi opsi sasaran itu.
 */
export function composerFormForPost(
  post: PostResponse,
  timeZone: string,
): ComposerFormState {
  const conversationId = post.target.conversationId;
  return {
    selectedTargets: [conversationId],
    title: post.title,
    caption: post.caption,
    mediaIds: post.media.map((item) => item.mediaId),
    scheduleAt: post.scheduledAt
      ? isoToLocalDateTimeValue(post.scheduledAt, timeZone)
      : "",
    optionsByTarget: post.publishOptions
      ? { [conversationId]: { ...post.publishOptions } }
      : {},
  };
}

/**
 * Bentuk serial untuk perbandingan keadaan. Urutan sasaran
 * dinormalkan (urutan centang bukan isi), sedangkan urutan media
 * dipertahankan (urutan album bermakna). Opsi per sasaran
 * dinormalkan dengan semantik yang sama seperti bentuk kirim
 * formulir (`optionsFor` di PostsPage): nilai `undefined` dibuang,
 * dan sasaran yang opsinya kosong seluruhnya dianggap tidak punya
 * opsi — memilih lalu mengosongkan kembali sebuah opsi berarti
 * kembali bersih, bukan kotor.
 */
export function serializeComposerForm(state: ComposerFormState): string {
  const optionsByTarget: Record<string, PostPublishOptions> = {};
  for (const [conversationId, options] of Object.entries(
    state.optionsByTarget,
  )) {
    const clean = Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ) as PostPublishOptions;
    if (Object.keys(clean).length > 0) optionsByTarget[conversationId] = clean;
  }
  return JSON.stringify({
    selectedTargets: [...state.selectedTargets].sort(),
    title: state.title,
    caption: state.caption,
    mediaIds: state.mediaIds,
    scheduleAt: state.scheduleAt,
    optionsByTarget,
  });
}

/** Kotor = isi formulir sekarang berbeda dari keadaan awal saat dibuka. */
export function isComposerDirty(
  initial: ComposerFormState,
  current: ComposerFormState,
): boolean {
  return serializeComposerForm(initial) !== serializeComposerForm(current);
}
