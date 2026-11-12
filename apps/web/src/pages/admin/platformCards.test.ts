import { describe, expect, it } from "vitest";
import { PlatformSettingKeySchema } from "@sahabat-kreator/contracts";
import {
  ADMIN_CARDS,
  OAUTH_CALLBACK_PATHS,
  WEBHOOK_PATHS,
  adminCardById,
} from "./platformCards";

/**
 * Bukti pemetaan Panel Admin per kartu (gelombang pengelompokan
 * formulir 2026-11-12): registry kartu di `platformCards.ts` adalah
 * satu-satunya daftar yang dirender AdminPage, jadi test ini menjaga
 * agar penataan ulang presentasi TIDAK menghilangkan kunci apa pun
 * dari panel dan tidak menggandakannya.
 */
describe("registry kartu Panel Admin", () => {
  const allRegistryKeys = [...PlatformSettingKeySchema.options];
  const cardKeys = ADMIN_CARDS.flatMap((card) =>
    card.fields.map((f) => f.key),
  );

  it("setiap kunci registry platform_settings tampil di tepat satu kartu", () => {
    expect(new Set(cardKeys).size).toBe(cardKeys.length);
    expect([...cardKeys].sort()).toEqual([...allRegistryKeys].sort());
  });

  it("kunci wajib kartu adalah subset kolom kartunya sendiri", () => {
    for (const card of ADMIN_CARDS) {
      const own = new Set(card.fields.map((f) => f.key));
      for (const required of card.requiredKeys) {
        expect(own.has(required)).toBe(true);
      }
    }
  });

  it("privasi bawaan postingan tinggal di kartu platformnya (koreksi pemilik: default panel, ditimpa per postingan)", () => {
    expect(
      adminCardById("youtube").fields.map((f) => f.key),
    ).toContain("youtube_privacy_status");
    expect(
      adminCardById("tiktok").fields.map((f) => f.key),
    ).toContain("tiktok_privacy_level");
  });

  it("base URL media publik menyatu di kartu R2, bukan grup tersendiri", () => {
    expect(adminCardById("r2").fields.map((f) => f.key)).toContain(
      "post_media_public_base_url",
    );
    expect(ADMIN_CARDS.map((c) => c.id)).not.toContain("content-schedule");
  });

  it("path callback semua kartu OAuth mengikuti skema kanonis /api/oauth/<provider>/callback", () => {
    for (const card of ADMIN_CARDS) {
      if (!card.callbackPath) continue;
      expect(card.callbackPath).toMatch(/^\/api\/oauth\/[a-z_]+\/callback$/);
    }
    expect(Object.values(OAUTH_CALLBACK_PATHS)).toContain(
      "/api/oauth/google_calendar/callback",
    );
    expect(Object.values(OAUTH_CALLBACK_PATHS)).toContain(
      "/api/oauth/google_business/callback",
    );
  });

  it("path webhook kanonis lengkap: meta, data-deletion, whatsapp, tiktok, threads", () => {
    expect(new Set(Object.values(WEBHOOK_PATHS))).toEqual(
      new Set([
        "/api/webhooks/meta",
        "/api/webhooks/meta/data-deletion",
        "/api/webhooks/whatsapp",
        "/api/webhooks/tiktok",
        "/api/webhooks/threads",
      ]),
    );
    const shown = new Set(
      ADMIN_CARDS.flatMap((card) => card.webhookPaths ?? []),
    );
    for (const path of Object.values(WEBHOOK_PATHS)) {
      expect(shown.has(path)).toBe(true);
    }
  });
});
