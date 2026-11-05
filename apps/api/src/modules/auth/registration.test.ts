/**
 * Invarian registrasi autentikasi dashboard (2026-11-05).
 *
 * Insiden: 26 modul masing-masing mendaftarkan `app.use("/tenants/*", auth)`
 * ke sub-app `routes` yang sama. Hono menjalankan SEMUA handler yang cocok
 * dengan pola path itu, jadi satu request dashboard mengeksekusi
 * `getSession` + `select users` 26 kali (217 ms untuk `GET /api/tenants`).
 *
 * Perbaikannya: middleware dipasang SATU KALI di `index.ts`, sebelum modul
 * di-mount. Dua hal yang mudah rusak tanpa disadari:
 *   1. ada modul baru yang mendaftarkan ulang middleware itu, dan
 *   2. registrasi tunggal di `index.ts` tergeser ke SETELAH `routes.route(...)`
 *      — Hono menjalankan handler sesuai urutan registrasi, sehingga route
 *      akan terbuka tanpa sesi.
 *
 * Test ini membaca sumber dan mengunci keduanya.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API_SRC = path.join(process.cwd(), "apps", "api", "src");
const MODULES_DIR = path.join(API_SRC, "modules");

/** Daftar `modules/<nama>/routes.ts` — sumber kebenaran modul HTTP. */
function moduleRouteFiles(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(MODULES_DIR, entry.name, "routes.ts"))
    .filter((file) => {
      try {
        readFileSync(file);
        return true;
      } catch {
        return false;
      }
    });
}

describe("registrasi requireAuth untuk /tenants", () => {
  it("tidak ada modul yang mendaftarkan middleware /tenants sendiri", () => {
    const offenders = moduleRouteFiles().filter((file) =>
      /app\.use\(\s*"\/tenants\/?\*?"\s*,/.test(readFileSync(file, "utf8")),
    );

    expect(offenders.map((file) => path.relative(process.cwd(), file))).toEqual([]);
  });

  it("index.ts mendaftarkannya tepat satu kali, sebelum modul di-mount", () => {
    const source = readFileSync(path.join(API_SRC, "index.ts"), "utf8");

    // `^` + flag m: hanya pernyataan di awal baris (boleh berindentasi),
    // bukan penyebutan di dalam komentar — komentar di index.ts memang
    // menyebut pola ini.
    const registrations = source.match(/^\s*routes\.use\(\s*"\/tenants\/\*"/gm) ?? [];
    expect(registrations).toHaveLength(1);

    const registrationAt = source.search(/^\s*routes\.use\(\s*"\/tenants\/\*"/m);
    const firstMountAt = source.search(/^routes\.route\(/m);

    expect(firstMountAt).toBeGreaterThan(-1);
    // Urutan registrasi menentukan urutan eksekusi di Hono.
    expect(registrationAt).toBeLessThan(firstMountAt);
  });
});
