import { describe, expect, it } from "vitest";

import { extractInstructionPlaceholders } from "./placeholders";

/**
 * PENANDA KURUNG SIKU — modul netral (ekstraksi G1).
 *
 * Kasus-kasus ini SENGAJA menduplikasi blok `extractInstructionPlaceholders`
 * di agent-templates.test.ts: berkas ini membuktikan jalur impor langsung
 * dari modul netral `./placeholders`, sedangkan blok lama membuktikan
 * shim re-export di `./agent-templates` tetap berperilaku identik.
 * Perilaku regex tidak boleh berubah di salah satu jalur.
 */
describe("extractInstructionPlaceholders (modul placeholders)", () => {
  it("menemukan penanda, terdedup, urut kemunculan pertama", () => {
    expect(
      extractInstructionPlaceholders(
        "Halo [nama bisnis], buka [jam operasional]. Sekali lagi [nama bisnis].",
      ),
    ).toEqual(["nama bisnis", "jam operasional"]);
  });

  it("mengabaikan kurung kosong dan kurung lintas baris", () => {
    expect(extractInstructionPlaceholders("kosong [] di sini")).toEqual([]);
    expect(extractInstructionPlaceholders("[dua\nbaris]")).toEqual([]);
    expect(extractInstructionPlaceholders("tanpa penanda")).toEqual([]);
  });

  it("memangkas spasi di dalam penanda", () => {
    expect(extractInstructionPlaceholders("[ kebijakan refund ]")).toEqual([
      "kebijakan refund",
    ]);
  });
});
