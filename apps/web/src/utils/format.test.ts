import { describe, expect, it } from "vitest";

import { formatDateTime, zonedLocalToIso } from "./format";

/**
 * Zona waktu tenant di content schedule (Gelombang 0, butir 4).
 *
 * Yang dijaga test ini adalah janji paling dasar penjadwalan: "jam 9
 * pagi" yang diketik admin adalah jam 9 pagi di zona workspace —
 * bukan zona browser, bukan UTC mentah. Kesalahan satu jam saja di
 * sini berarti postingan tayang sebelum/sesudah momen yang dijanjikan,
 * dan tidak ada error apa pun yang menandainya.
 */
describe("zonedLocalToIso", () => {
  it("menafsirkan jam dinding Asia/Jakarta (UTC+7) dengan benar", () => {
    expect(zonedLocalToIso("2026-11-20T09:00", "Asia/Jakarta")).toBe(
      "2026-11-20T02:00:00.000Z",
    );
  });

  it("menghormati zona lain: Asia/Makassar (UTC+8) dan UTC", () => {
    expect(zonedLocalToIso("2026-11-20T09:00", "Asia/Makassar")).toBe(
      "2026-11-20T01:00:00.000Z",
    );
    expect(zonedLocalToIso("2026-11-20T09:00", "UTC")).toBe(
      "2026-11-20T09:00:00.000Z",
    );
  });

  it("tengah malam di zona tenant bisa jatuh pada hari sebelumnya di UTC", () => {
    expect(zonedLocalToIso("2026-01-01T00:30", "Asia/Jakarta")).toBe(
      "2025-12-31T17:30:00.000Z",
    );
  });

  it("input rusak menghasilkan null, bukan tanggal tebakan", () => {
    expect(zonedLocalToIso("besok pagi", "Asia/Jakarta")).toBeNull();
    expect(zonedLocalToIso("", "Asia/Jakarta")).toBeNull();
  });
});

describe("formatDateTime dengan zona waktu eksplisit", () => {
  it("menampilkan instant UTC sebagai jam dinding zona yang diminta", () => {
    // 02:00Z = 09:00 WIB.
    const label = formatDateTime("2026-11-20T02:00:00.000Z", "en", "Asia/Jakarta");
    expect(label).toContain("9:00 AM");
    const labelMakassar = formatDateTime(
      "2026-11-20T02:00:00.000Z",
      "en",
      "Asia/Makassar",
    );
    expect(labelMakassar).toContain("10:00 AM");
  });
});
