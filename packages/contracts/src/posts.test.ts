import { describe, expect, it } from "vitest";
import { ChannelProviderSchema } from "./inbox";
import {
  POST_CAPTION_HARD_MAX,
  POST_PROVIDER_CAPABILITIES,
  CreatePostRequestSchema,
  getPostProviderCapability,
} from "./posts";

/**
 * Capability penerbitan per provider (Gelombang 0, butir 2).
 *
 * Yang dijaga di sini adalah janji yang dipakai core untuk memvalidasi
 * SEBELUM jam tayang: tabel capability lengkap terhadap enum provider
 * (provider baru yang lupa dideklarasikan gagal di sini, bukan menjadi
 * `undefined` yang lolos diam-diam), dan hanya provider beradapter yang
 * boleh `publishSupported`.
 */
describe("capability post per provider", () => {
  it("terdeklarasi untuk SETIAP provider pada ChannelProviderSchema", () => {
    for (const provider of ChannelProviderSchema.options) {
      expect(
        POST_PROVIDER_CAPABILITIES[provider],
        `capability ${provider} hilang`,
      ).toBeDefined();
      expect(getPostProviderCapability(provider)?.maxCaption).toBeGreaterThan(0);
    }
    expect(getPostProviderCapability("provider-ngawur")).toBeUndefined();
  });

  it("hanya provider beradapter yang publishSupported (telegram + keluarga meta + bluesky + youtube + linkedin + pinterest + google business + tiktok)", () => {
    const supported = Object.entries(POST_PROVIDER_CAPABILITIES)
      .filter(([, capability]) => capability.publishSupported)
      .map(([provider]) => provider);
    expect(supported).toEqual([
      "telegram",
      "instagram",
      "messenger",
      "threads",
      "bluesky",
      "youtube",
      "linkedin",
      "pinterest",
      "google_business",
      "tiktok",
    ]);
  });

  it("tiktok: direct post wajib tepat satu video, caption (judul postingan) maks 2200, foto tidak dinyalakan", () => {
    const tiktok = getPostProviderCapability("tiktok")!;
    expect(tiktok.publishSupported).toBe(true);
    expect(tiktok.mediaRequired).toBe(true);
    expect(tiktok.maxCaption).toBe(2200);
    expect(tiktok.maxTitle).toBeNull();
    expect(tiktok.maxMedia).toBe(1);
    expect(tiktok.supportsPhotos).toBe(false);
    expect(tiktok.supportsVideo).toBe(true);
    expect(tiktok.supportsAlbum).toBe(false);
    expect(tiktok.supportsDocuments).toBe(false);
  });

  it("google_business: postingan lokal per lokasi — teks 1500, satu foto, tanpa video/album", () => {
    const gbp = getPostProviderCapability("google_business")!;
    expect(gbp.publishSupported).toBe(true);
    expect(gbp.mediaRequired).toBe(false);
    expect(gbp.maxCaption).toBe(1500);
    expect(gbp.maxTitle).toBeNull();
    expect(gbp.maxMedia).toBe(1);
    expect(gbp.supportsPhotos).toBe(true);
    expect(gbp.supportsVideo).toBe(false);
    expect(gbp.supportsAlbum).toBe(false);
    expect(gbp.supportsDocuments).toBe(false);
  });

  it("pinterest: satu Pin wajib tepat satu gambar, judul 100, deskripsi 800, video ditunda", () => {
    const pinterest = getPostProviderCapability("pinterest")!;
    expect(pinterest.publishSupported).toBe(true);
    expect(pinterest.mediaRequired).toBe(true);
    expect(pinterest.maxMedia).toBe(1);
    expect(pinterest.maxCaption).toBe(800);
    expect(pinterest.maxTitle).toBe(100);
    expect(pinterest.supportsPhotos).toBe(true);
    expect(pinterest.supportsVideo).toBe(false);
    expect(pinterest.supportsAlbum).toBe(false);
    expect(pinterest.supportsDocuments).toBe(false);
  });

  it("linkedin: profil pribadi — teks 3000, gambar/video didukung, dokumen tidak", () => {
    const linkedin = getPostProviderCapability("linkedin")!;
    expect(linkedin.publishSupported).toBe(true);
    expect(linkedin.mediaRequired).toBe(false);
    expect(linkedin.maxCaption).toBe(3000);
    expect(linkedin.maxTitle).toBeNull();
    expect(linkedin.supportsPhotos).toBe(true);
    expect(linkedin.supportsVideo).toBe(true);
    expect(linkedin.supportsAlbum).toBe(true);
    expect(linkedin.supportsDocuments).toBe(false);
  });

  it("youtube: wajib tepat satu video, deskripsi 5000, judul platform 100", () => {
    const youtube = getPostProviderCapability("youtube")!;
    expect(youtube.mediaRequired).toBe(true);
    expect(youtube.maxMedia).toBe(1);
    expect(youtube.maxCaption).toBe(5000);
    expect(youtube.maxTitle).toBe(100);
    expect(youtube.supportsVideo).toBe(true);
    expect(youtube.supportsPhotos).toBe(false);
    expect(youtube.supportsAlbum).toBe(false);
    expect(youtube.supportsDocuments).toBe(false);
    // Provider lain tidak memakai judul platform.
    expect(getPostProviderCapability("telegram")?.maxTitle).toBeNull();
  });

  it("bluesky: teks 300, gambar maks 4, video ditunda, dokumen tidak didukung", () => {
    const bluesky = getPostProviderCapability("bluesky")!;
    expect(bluesky.maxCaption).toBe(300);
    expect(bluesky.maxMedia).toBe(4);
    expect(bluesky.mediaRequired).toBe(false);
    expect(bluesky.supportsAlbum).toBe(true);
    expect(bluesky.supportsVideo).toBe(false);
    expect(bluesky.supportsDocuments).toBe(false);
  });

  it("telegram mempertahankan batas Fase 23: caption 1024, album 10, dokumen tidak boleh di album", () => {
    const telegram = getPostProviderCapability("telegram")!;
    expect(telegram.maxCaption).toBe(1024);
    expect(telegram.maxMedia).toBe(10);
    expect(telegram.mediaRequired).toBe(false);
    expect(telegram.supportsAlbumDocuments).toBe(false);
  });

  it("instagram wajib media — teks saja tidak pernah boleh terjadwal", () => {
    expect(getPostProviderCapability("instagram")?.mediaRequired).toBe(true);
  });

  it("langit-langit skema permintaan mengikuti capability paling longgar", () => {
    expect(POST_CAPTION_HARD_MAX).toBe(
      Math.max(
        ...Object.values(POST_PROVIDER_CAPABILITIES).map((c) => c.maxCaption),
      ),
    );
    const tooLong = "a".repeat(POST_CAPTION_HARD_MAX + 1);
    expect(
      CreatePostRequestSchema.safeParse({
        conversationId: "8a200000-0000-4000-8000-000000000023",
        title: "Promo",
        caption: tooLong,
      }).success,
    ).toBe(false);
  });
});
