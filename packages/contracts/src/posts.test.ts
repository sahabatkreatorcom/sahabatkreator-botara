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

  it("hanya provider beradapter yang publishSupported (telegram + keluarga meta sejauh ini)", () => {
    const supported = Object.entries(POST_PROVIDER_CAPABILITIES)
      .filter(([, capability]) => capability.publishSupported)
      .map(([provider]) => provider);
    expect(supported).toEqual(["telegram", "instagram", "messenger", "threads"]);
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
