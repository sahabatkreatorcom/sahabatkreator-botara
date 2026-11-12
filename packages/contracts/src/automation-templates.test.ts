import { describe, expect, it } from "vitest";

import {
  AUTOMATION_TEMPLATES,
  CreateSequenceTemplateRequestSchema,
  WA_FREE_WINDOW_MINUTES,
  buildSequenceTimeline,
  findAutomationTemplate,
  resolveAutomationSequenceContent,
  summarizeAutomationTemplate,
  type AutomationTemplateLocale,
  type AutomationTemplateSequence,
} from "./automation-templates";
import { extractInstructionPlaceholders } from "./placeholders";

/**
 * KATALOG SEQUENCE G2 — invarian struktural.
 *
 * Teks langkah DISALIN APA ADANYA menjadi pesan pelanggan berjadwal.
 * Kesalahan termahal di sini tidak terlihat saat typecheck: templat
 * yang menjanjikan variabel yang tidak dirender runtime (mis. {email})
 * akan mengirim teks mentah "{email}" ke pelanggan, dan templat yang
 * jeda antar-locale-nya menyimpang membuat pemilik berbahasa Inggris
 * menerima rangkaian yang berbeda dari yang ia pratinjau. Karena itu
 * kejujuran katalog ditegakkan sebagai test.
 */

/** Enam variasi sequence yang disetujui pemilik (2026-11-12). */
const EXPECTED_SEQUENCE_SLUGS = [
  "sambutan-pelanggan-baru",
  "pengingat-keranjang",
  "follow-up-tanya",
  "edukasi-produk-bertahap",
  "seri-materi-kreator",
  "reaktivasi-pelanggan-lama",
];

const LOCALES: AutomationTemplateLocale[] = ["id", "en"];

function sequenceTemplates(): AutomationTemplateSequence[] {
  return AUTOMATION_TEMPLATES.filter(
    (t): t is AutomationTemplateSequence => t.kind === "sequence",
  );
}

describe("katalog sequence G2", () => {
  it("memuat tepat enam variasi sequence yang disetujui, slug unik", () => {
    const slugs = sequenceTemplates().map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual([...EXPECTED_SEQUENCE_SLUGS].sort());
  });

  it("dwibahasa sejajar: jumlah langkah & jeda identik antar locale", () => {
    for (const tpl of sequenceTemplates()) {
      const id = tpl.content.id;
      const en = tpl.content.en;
      expect(en.steps.length, `${tpl.slug}: jumlah langkah en`).toBe(
        id.steps.length,
      );
      expect(
        en.steps.map((s) => s.delayMinutes),
        `${tpl.slug}: jeda en`,
      ).toEqual(id.steps.map((s) => s.delayMinutes));
      expect(en.defaultName.trim(), `${tpl.slug}: nama en kosong`).not.toBe("");
      expect(en.keywords.length, `${tpl.slug}: kata kunci en`).toBeGreaterThan(0);
    }
  });

  it("setiap templat memuat penanda fakta bisnis di kedua locale", () => {
    for (const tpl of sequenceTemplates()) {
      for (const locale of LOCALES) {
        const allText = tpl.content[locale].steps.map((s) => s.text).join("\n");
        expect(
          extractInstructionPlaceholders(allText).length,
          `${tpl.slug}/${locale}: tanpa penanda [...]`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("penanda inti [nama bisnis]/[link katalog]/[kode promo] hadir sesuai janji katalog", () => {
    const sambutan = findAutomationTemplate("sambutan-pelanggan-baru");
    expect(sambutan?.kind).toBe("sequence");
    if (sambutan?.kind !== "sequence") return;
    const idText = sambutan.content.id.steps.map((s) => s.text).join("\n");
    expect(idText).toContain("[nama bisnis]");
    expect(idText).toContain("[link katalog]");
    expect(idText).toContain("[kode promo]");
    const enText = sambutan.content.en.steps.map((s) => s.text).join("\n");
    expect(enText).toContain("[business name]");
    expect(enText).toContain("[catalog link]");
    expect(enText).toContain("[promo code]");
  });

  it("hanya menjanjikan variabel {name} (+ spintax) — variabel lain dilarang", () => {
    const curly = /\{([^{}]*)\}/g;
    for (const tpl of sequenceTemplates()) {
      for (const locale of LOCALES) {
        for (const step of tpl.content[locale].steps) {
          for (const match of step.text.matchAll(curly)) {
            const inner = match[1] ?? "";
            // Sah: {name} persis, atau spintax {a|b|…}.
            expect(
              inner === "name" || inner.includes("|"),
              `${tpl.slug}/${locale}: variabel tak didukung {${inner}}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("resolveAutomationSequenceContent memilih locale yang diminta", () => {
    const tpl = sequenceTemplates()[0]!;
    expect(resolveAutomationSequenceContent(tpl, "en")).toBe(tpl.content.en);
    expect(resolveAutomationSequenceContent(tpl, "id")).toBe(tpl.content.id);
  });
});

describe("buildSequenceTimeline (pratinjau G2)", () => {
  it("hari kumulatif edukasi = Hari 0 → 1 → 3 → 5", () => {
    const tpl = findAutomationTemplate("edukasi-produk-bertahap");
    expect(tpl?.kind).toBe("sequence");
    if (tpl?.kind !== "sequence") return;
    const timeline = buildSequenceTimeline(tpl.content.id.steps);
    expect(timeline.map((s) => s.dayOffset)).toEqual([0, 1, 3, 5]);
    expect(timeline.map((s) => s.cumulativeMinutes)).toEqual([
      0, 1_440, 4_320, 7_200,
    ]);
  });

  it("penanda jendela WA: hanya langkah kumulatif > 24 jam yang ditandai", () => {
    const timeline = buildSequenceTimeline([
      { delayMinutes: 0, text: "a" },
      { delayMinutes: WA_FREE_WINDOW_MINUTES, text: "b" },
      { delayMinutes: 1, text: "c" },
    ]);
    // Tepat 1440 menit masih di dalam jendela (kumulatif == batas).
    expect(timeline.map((s) => s.exceedsWaWindow)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe("summarizeAutomationTemplate per locale", () => {
  it("sequence: ringkasan en membawa langkah Inggris, id membawa Indonesia", () => {
    const tpl = findAutomationTemplate("sambutan-pelanggan-baru")!;
    const en = summarizeAutomationTemplate(tpl, "en");
    const id = summarizeAutomationTemplate(tpl, "id");
    expect(en.steps[0]!.text).toContain("Welcome");
    expect(id.steps[0]!.text).toContain("Selamat datang");
    expect(en.stepCount).toBe(id.stepCount);
    expect(en.steps).toHaveLength(en.stepCount);
  });

  it("keyword: steps selalu [] dan stepCount 0", () => {
    const tpl = findAutomationTemplate("harga-produk")!;
    const summary = summarizeAutomationTemplate(tpl);
    expect(summary.steps).toEqual([]);
    expect(summary.stepCount).toBe(0);
  });
});

describe("skema templat sequence pribadi (G2)", () => {
  const valid = {
    name: "Rangkaian saya",
    keywords: ["halo"],
    match: "contains" as const,
    steps: [{ delayMinutes: 0, text: "Halo {name} dari [nama bisnis]" }],
  };

  it("menerima langkah BERPENANDA — penanda tidak pernah ditolak skema", () => {
    expect(CreateSequenceTemplateRequestSchema.safeParse(valid).success).toBe(
      true,
    );
  });

  it("menolak langkah kosong, langkah > 10, jeda di luar batas, nama kosong", () => {
    expect(
      CreateSequenceTemplateRequestSchema.safeParse({ ...valid, steps: [] })
        .success,
    ).toBe(false);
    expect(
      CreateSequenceTemplateRequestSchema.safeParse({
        ...valid,
        steps: Array.from({ length: 11 }, () => ({
          delayMinutes: 0,
          text: "x",
        })),
      }).success,
    ).toBe(false);
    expect(
      CreateSequenceTemplateRequestSchema.safeParse({
        ...valid,
        steps: [{ delayMinutes: 43_201, text: "x" }],
      }).success,
    ).toBe(false);
    expect(
      CreateSequenceTemplateRequestSchema.safeParse({ ...valid, name: "  " })
        .success,
    ).toBe(false);
  });
});
