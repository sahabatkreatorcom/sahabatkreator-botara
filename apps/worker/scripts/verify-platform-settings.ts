/**
 * Uji integrasi Panel Admin Platform (Fase 6C) di atas PGlite.
 *
 * Yang dibuktikan langsung terhadap service core `platform-settings`:
 *  1. Urutan resolusi nilai efektif: PANEL > env > null (persis usulan
 *     user: panel sumber utama, env fallback).
 *  2. Nilai tersimpan TERENKRIPSI: baris mentah di DB tidak memuat nilai
 *     dummy; status tidak pernah memuat nilai/potongan/panjangnya.
 *  3. Jalur agent: kunci dummy di panel → resolveOpenRouterConfig
 *     mengembalikannya → provider yang terbentuk adalah OpenRouter
 *     (bukan mock); setelah kunci DICABUT → null → provider mock lagi.
 *  4. Audit `platform_settings.*` tertulis TANPA nilai (meta hanya key).
 *  5. Allowlist admin: pencocokan email case-insensitive + koma.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:platform-settings
 * (Nilai dummy di skrip ini adalah fixture uji yang jelas-jelas palsu.)
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  clearPlatformSetting,
  clearPlatformSettingsCache,
  getProviderSecret,
  isPlatformAdminEmail,
  isValidPlatformSettingValue,
  listPlatformSettingStatuses,
  recordPlatformSettingTest,
  resolveOpenRouterConfig,
  resolvePostMediaPublicBaseUrl,
  resolveTikTokPrivacyLevel,
  resolveYouTubePrivacyStatus,
  setPlatformSetting,
} from "@sahabat-kreator/core";
import { createLlmProvider } from "@sahabat-kreator/ai";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../../packages/db/migrations");

// btree_gist wajib didaftarkan (Fase 13G): migrasi 0006 menjalankan
// CREATE EXTENSION btree_gist untuk constraint eksklusi anti-double-booking.
const client = new PGlite({ extensions: { vector, btree_gist } });
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
  await client.exec(sqlText.replaceAll("--> statement-breakpoint", ""));
}
console.log(`[setup] migrasi teraplikasi: ${files.length} file`);

const db = drizzle(client, { schema }) as unknown as Database;

const ADMIN_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'pemilik@sk.test', 'Pemilik Uji')`,
  [ADMIN_USER],
);

// Fixture uji (BUKAN kredensial sungguhan).
const DUMMY_KEY = "sk-or-dummy-6c-verify-000000";
const ENV_KEY = "sk-or-env-fallback-6c-verify";
const MASTER = randomBytes(32).toString("base64");

const baseOpts = { masterSecret: MASTER, env: {} };
const envOpts = {
  masterSecret: MASTER,
  env: { openrouter_api_key: ENV_KEY },
};

// ---------- 1. Resolusi: null → env → panel → (cabut) env ----------
clearPlatformSettingsCache();
assert.equal(await getProviderSecret(db, "openrouter_api_key", baseOpts), null);
assert.equal(
  await getProviderSecret(db, "openrouter_api_key", envOpts),
  ENV_KEY,
);
console.log("[1a] tanpa panel & tanpa env → null; env saja → nilai env: OK");

await setPlatformSetting(
  db,
  { key: "openrouter_api_key", value: DUMMY_KEY, updatedByUserId: ADMIN_USER },
  baseOpts,
);
clearPlatformSettingsCache();
assert.equal(
  await getProviderSecret(db, "openrouter_api_key", envOpts),
  DUMMY_KEY,
);
console.log("[1b] panel terpasang → panel MENANG atas env: OK");

// ---------- 2. Enkripsi saat diam + status tanpa nilai ----------
const raw = await client.query<{ value_encrypted: string }>(
  `SELECT value_encrypted FROM platform_settings WHERE key = 'openrouter_api_key'`,
);
assert.equal(raw.rows.length, 1);
assert.ok(raw.rows[0].value_encrypted.startsWith("v1:"));
assert.ok(!raw.rows[0].value_encrypted.includes(DUMMY_KEY));
const statuses = await listPlatformSettingStatuses(db, envOpts);
const orStatus = statuses.find((s) => s.key === "openrouter_api_key")!;
assert.equal(orStatus.isSet, true);
assert.equal(orStatus.source, "panel");
assert.equal(orStatus.updatedBy, "pemilik@sk.test");
assert.ok(!JSON.stringify(statuses).includes(DUMMY_KEY));
assert.ok(!JSON.stringify(statuses).includes(ENV_KEY));
const r2Status = statuses.find((s) => s.key === "r2_access_key_id")!;
assert.deepEqual(
  { isSet: r2Status.isSet, source: r2Status.source },
  { isSet: false, source: null },
);
console.log("[2] baris DB terenkripsi envelope v1 (tanpa nilai mentah); status isSet/source benar & bebas nilai: OK");

// ---------- 3. Jalur agent: panel → OpenRouter; cabut → mock ----------
const orConfig = await resolveOpenRouterConfig(db, envOpts);
assert.equal(orConfig?.apiKey, DUMMY_KEY);
const providerWithPanel = createLlmProvider({
  provider: orConfig ? "openrouter" : "mock",
  openrouterApiKey: orConfig?.apiKey,
  openrouterModel: orConfig?.model,
});
assert.equal(providerWithPanel.name, "openrouter");

const existed = await clearPlatformSetting(db, {
  key: "openrouter_api_key",
  updatedByUserId: ADMIN_USER,
});
assert.equal(existed, true);
clearPlatformSettingsCache();
assert.equal(await resolveOpenRouterConfig(db, baseOpts), null);
const providerAfterClear = createLlmProvider({ provider: "mock" });
assert.equal(providerAfterClear.name, "mock");
// Setelah cabut, env fallback hidup lagi.
assert.equal(
  await getProviderSecret(db, "openrouter_api_key", envOpts),
  ENV_KEY,
);
console.log("[3] kunci panel → provider OpenRouter; dicabut → null/mock & env fallback kembali: OK");

// ---------- 4. Audit tanpa nilai ----------
await recordPlatformSettingTest(db, {
  key: "openrouter_api_key",
  actorUserId: ADMIN_USER,
  ok: false,
  code: "OPENROUTER_AUTH_FAILED",
});
const audits = await client.query<{ action: string; meta: unknown }>(
  `SELECT action, meta FROM audit_logs WHERE tenant_id IS NULL ORDER BY created_at, action`,
);
assert.deepEqual(
  audits.rows.map((r) => r.action).sort(),
  ["platform_settings.cleared", "platform_settings.set", "platform_settings.test"],
);
const auditJson = JSON.stringify(audits.rows);
assert.ok(!auditJson.includes(DUMMY_KEY) && !auditJson.includes(ENV_KEY));
for (const row of audits.rows) {
  assert.equal((row.meta as { key?: string }).key, "openrouter_api_key");
}
console.log("[4] audit platform_settings.set/cleared/test tertulis, meta hanya key — tanpa nilai: OK");

// ---------- 5. Allowlist ----------
assert.equal(isPlatformAdminEmail("Mas@Romo.com", " lain@x.id , mas@romo.com"), true);
assert.equal(isPlatformAdminEmail("orang@lain.id", "mas@romo.com"), false);
assert.equal(isPlatformAdminEmail("mas@romo.com", undefined), false);
assert.equal(isPlatformAdminEmail("mas@romo.com", ""), false);
console.log("[5] allowlist: case-insensitive, koma-terpisah, kosong = terkunci: OK");

// ---------- 6. Kunci baru 2026-11-12: verify token + pengaturan berbentuk ----------
// Semua kredensial integrasi lewat panel dengan env fallback yang sama:
// verify token Meta mengikuti urutan panel > env > null persis kunci lain.
const ENV_VERIFY_TOKEN = "dummy-env-verify-token-bukan-asli";
const PANEL_VERIFY_TOKEN = "dummy-panel-verify-token-bukan-asli";
const csOpts = {
  masterSecret: MASTER,
  env: {
    meta_webhook_verify_token: ENV_VERIFY_TOKEN,
    youtube_privacy_status: "unlisted",
    tiktok_privacy_level: "SELF_ONLY",
    post_media_public_base_url: "https://media-contoh.invalid/env",
  },
};
clearPlatformSettingsCache();
assert.equal(
  await getProviderSecret(db, "meta_webhook_verify_token", csOpts),
  ENV_VERIFY_TOKEN,
);
await setPlatformSetting(
  db,
  { key: "meta_webhook_verify_token", value: PANEL_VERIFY_TOKEN, updatedByUserId: ADMIN_USER },
  csOpts,
);
clearPlatformSettingsCache();
assert.equal(
  await getProviderSecret(db, "meta_webhook_verify_token", csOpts),
  PANEL_VERIFY_TOKEN,
);
await clearPlatformSetting(db, { key: "meta_webhook_verify_token", updatedByUserId: ADMIN_USER });
clearPlatformSettingsCache();
assert.equal(
  await getProviderSecret(db, "meta_webhook_verify_token", csOpts),
  ENV_VERIFY_TOKEN,
);
console.log("[6a] meta_webhook_verify_token: env → panel menang → cabut → env lagi: OK");

// Resolver bertipe: bawaan aman tanpa apa pun; env sah dipakai; panel sah
// menang; nilai panel TIDAK sah (ditulis di luar API) diabaikan → env.
assert.equal(await resolveYouTubePrivacyStatus(db, baseOpts), "private");
assert.equal(await resolveTikTokPrivacyLevel(db, baseOpts), "SELF_ONLY");
assert.equal(await resolvePostMediaPublicBaseUrl(db, baseOpts), null);
assert.equal(await resolveYouTubePrivacyStatus(db, csOpts), "unlisted");
await setPlatformSetting(
  db,
  { key: "youtube_privacy_status", value: "public", updatedByUserId: ADMIN_USER },
  csOpts,
);
clearPlatformSettingsCache();
assert.equal(await resolveYouTubePrivacyStatus(db, csOpts), "public");
await setPlatformSetting(
  db,
  { key: "youtube_privacy_status", value: "bukan-status-sah", updatedByUserId: ADMIN_USER },
  csOpts,
);
clearPlatformSettingsCache();
assert.equal(await resolveYouTubePrivacyStatus(db, csOpts), "unlisted");
await setPlatformSetting(
  db,
  { key: "post_media_public_base_url", value: "bukan-url", updatedByUserId: ADMIN_USER },
  csOpts,
);
clearPlatformSettingsCache();
assert.equal(
  await resolvePostMediaPublicBaseUrl(db, csOpts),
  "https://media-contoh.invalid/env",
);
await setPlatformSetting(
  db,
  { key: "post_media_public_base_url", value: "https://cdn-contoh.invalid/panel", updatedByUserId: ADMIN_USER },
  csOpts,
);
clearPlatformSettingsCache();
assert.equal(
  await resolvePostMediaPublicBaseUrl(db, csOpts),
  "https://cdn-contoh.invalid/panel",
);
assert.equal(isValidPlatformSettingValue("youtube_privacy_status", "public"), true);
assert.equal(isValidPlatformSettingValue("youtube_privacy_status", "publik"), false);
assert.equal(isValidPlatformSettingValue("tiktok_privacy_level", "SELF_ONLY"), true);
assert.equal(isValidPlatformSettingValue("post_media_public_base_url", "https://x.invalid"), true);
assert.equal(isValidPlatformSettingValue("post_media_public_base_url", "bukan-url"), false);
assert.equal(isValidPlatformSettingValue("openrouter_api_key", "apa-saja"), true);
const csStatuses = await listPlatformSettingStatuses(db, csOpts);
assert.ok(!JSON.stringify(csStatuses).includes(PANEL_VERIFY_TOKEN));
console.log("[6b] resolver bertipe: bawaan aman, panel sah menang, nilai tidak sah diabaikan → env; status bebas nilai: OK");

await client.close();
console.log("verify platform-settings (PGlite): SEMUA LULUS");
