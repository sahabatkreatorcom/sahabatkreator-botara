import { describe, expect, it } from "vitest";
import type { PostResponse } from "@sahabat-kreator/contracts";

import {
  composerFormForDay,
  composerFormForPost,
  emptyComposerForm,
  isComposerDirty,
  isoToLocalDateTimeValue,
  localDateTimeValue,
  serializeComposerForm,
} from "./postsComposer";

/**
 * Komposer postingan sebagai drawer (gelombang Drawer /posts).
 *
 * Yang dijaga test ini adalah janji perilaku drawer yang tidak
 * terlihat dari tipe saja: klik tanggal mengisi awal jam tayang pada
 * tanggal itu (jam bawaan 09:00 zona tenant), mode ubah memuat isi
 * postingan apa adanya dengan sasaran terkunci, dan penjaga
 * perubahan belum tersimpan hanya berbunyi saat isi BENAR-BENAR
 * berbeda dari keadaan awal — memilih opsi lalu mengosongkannya
 * lagi bukan perubahan.
 */

const day = { y: 2026, m: 11, d: 20 };

describe("localDateTimeValue / isoToLocalDateTimeValue", () => {
  it("membentuk nilai datetime-local dengan nol di depan", () => {
    expect(localDateTimeValue(day, 9, 5)).toBe("2026-11-20T09:05");
  });

  it("memproyeksikan ISO ke jam dinding zona tenant", () => {
    // 02:00 UTC = 09:00 Asia/Jakarta (UTC+7).
    expect(
      isoToLocalDateTimeValue("2026-11-20T02:00:00.000Z", "Asia/Jakarta"),
    ).toBe("2026-11-20T09:00");
  });

  it("ISO tidak valid menjadi string kosong", () => {
    expect(isoToLocalDateTimeValue("bukan-tanggal", "Asia/Jakarta")).toBe("");
  });
});

describe("keadaan awal formulir", () => {
  it("buat-baru dari tombol: kosong, sasaran bawaan terpilih", () => {
    const form = emptyComposerForm("conv-1");
    expect(form.selectedTargets).toEqual(["conv-1"]);
    expect(form.title).toBe("");
    expect(form.scheduleAt).toBe("");
    expect(emptyComposerForm(null).selectedTargets).toEqual([]);
  });

  it("klik tanggal: jam tayang terisi awal pukul 09:00 tanggal itu", () => {
    const form = composerFormForDay(day, "conv-1");
    expect(form.scheduleAt).toBe("2026-11-20T09:00");
    expect(form.selectedTargets).toEqual(["conv-1"]);
    expect(form.title).toBe("");
  });
});

function draftPost(overrides: Partial<PostResponse> = {}): PostResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    groupId: null,
    title: "Judul lama",
    caption: "Caption lama",
    status: "draft",
    scheduledAt: null,
    publishedAt: null,
    providerMessageId: null,
    errorCode: null,
    publishOptions: { aiGenerated: false, tiktokPrivacyLevel: "SELF_ONLY" },
    target: {
      channelAccountId: "22222222-2222-4222-8222-222222222222",
      conversationId: "conv-9",
      provider: "tiktok",
      providerChatId: "@akun",
      title: "Akun TikTok",
      channelDisplayName: null,
    },
    media: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        mediaId: "media-1",
        fileName: "a.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        kind: "photo",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        mediaId: "media-2",
        fileName: "b.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        kind: "photo",
      },
    ],
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("mode ubah", () => {
  it("memuat isi postingan: sasaran terkunci, media dari mediaId, opsi ikut", () => {
    const form = composerFormForPost(draftPost(), "Asia/Jakarta");
    expect(form.selectedTargets).toEqual(["conv-9"]);
    expect(form.title).toBe("Judul lama");
    expect(form.caption).toBe("Caption lama");
    expect(form.mediaIds).toEqual(["media-1", "media-2"]);
    expect(form.optionsByTarget).toEqual({
      "conv-9": { aiGenerated: false, tiktokPrivacyLevel: "SELF_ONLY" },
    });
    expect(form.scheduleAt).toBe("");
  });

  it("jam tayang tersimpan ditampilkan sebagai jam dinding zona tenant", () => {
    const form = composerFormForPost(
      draftPost({ scheduledAt: "2026-11-21T02:30:00.000Z" }),
      "Asia/Jakarta",
    );
    expect(form.scheduleAt).toBe("2026-11-21T09:30");
  });

  it("postingan tanpa opsi menghasilkan peta opsi kosong", () => {
    const form = composerFormForPost(
      draftPost({ publishOptions: null }),
      "Asia/Jakarta",
    );
    expect(form.optionsByTarget).toEqual({});
  });
});

describe("penjaga perubahan belum tersimpan", () => {
  it("keadaan awal persis = bersih", () => {
    const initial = composerFormForPost(draftPost(), "Asia/Jakarta");
    expect(isComposerDirty(initial, { ...initial })).toBe(false);
    expect(serializeComposerForm(initial)).toBe(
      serializeComposerForm({ ...initial }),
    );
  });

  it("mengubah judul = kotor", () => {
    const initial = emptyComposerForm("conv-1");
    expect(isComposerDirty(initial, { ...initial, title: "Baru" })).toBe(true);
  });

  it("opsi dipilih lalu dikosongkan lagi (undefined) = tetap bersih", () => {
    const initial = emptyComposerForm("conv-1");
    const touched = {
      ...initial,
      optionsByTarget: {
        "conv-1": { youtubePrivacyStatus: undefined },
      } as typeof initial.optionsByTarget,
    };
    expect(isComposerDirty(initial, touched)).toBe(false);
  });

  it("urutan sasaran tidak bermakna; urutan media bermakna", () => {
    const initial = {
      ...emptyComposerForm(null),
      selectedTargets: ["a", "b"],
      mediaIds: ["m1", "m2"],
    };
    expect(
      isComposerDirty(initial, { ...initial, selectedTargets: ["b", "a"] }),
    ).toBe(false);
    expect(
      isComposerDirty(initial, { ...initial, mediaIds: ["m2", "m1"] }),
    ).toBe(true);
  });

  it("menambah media lewat unggahan = kotor", () => {
    const initial = composerFormForDay(day, "conv-1");
    expect(
      isComposerDirty(initial, { ...initial, mediaIds: ["media-1"] }),
    ).toBe(true);
  });
});
