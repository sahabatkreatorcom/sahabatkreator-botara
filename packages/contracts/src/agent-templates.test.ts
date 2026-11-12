import { describe, expect, it } from "vitest";

import {
  AGENT_INSTRUCTION_TEMPLATES,
  AgentInstructionTemplateCatalogSchema,
  extractInstructionPlaceholders,
  findAgentInstructionTemplate,
  resolveAgentTemplateFill,
  type AgentTemplateLocale,
} from "./agent-templates";

/**
 * KATALOG TEMPLAT INSTRUCTION — invarian struktural.
 *
 * Instruction templat disalin APA ADANYA menjadi prompt agent pelanggan.
 * Kesalahan termahal di sini tidak terlihat saat typecheck: satu templat
 * yang kehilangan bagian "Kapan serahkan ke manusia" atau kalimat
 * pengaman akan menghasilkan agent yang mengarang harga dan tidak pernah
 * menyerahkan ke manusia — dan pemilik baru sadar setelah pelanggan
 * dirugikan. Karena itu kerangka seragam ditegakkan sebagai test.
 */

const EXPECTED_SLUGS = [
  "cs-ramah",
  "sales-penjual",
  "admin-booking",
  "faq-hemat",
  "penangan-komplain",
  "penyaring-prospek",
];

const SECTION_HEADERS: Record<AgentTemplateLocale, string[]> = {
  id: [
    "Peran:",
    "Gaya bicara:",
    "Yang harus dilakukan:",
    "Yang tidak boleh dilakukan:",
    "Kapan serahkan ke manusia:",
  ],
  en: [
    "Role:",
    "Communication style:",
    "What to do:",
    "What not to do:",
    "When to hand off to a human:",
  ],
};

const SAFETY_SENTENCE: Record<AgentTemplateLocale, string> = {
  id: "Jawab hanya berdasarkan Knowledge Base dan data yang tersedia; jangan mengarang harga, stok, jadwal, atau kebijakan yang tidak ada di sana.",
  en: "Answer only from the Knowledge Base and the data available to you; never invent prices, stock, schedules, or policies that are not there.",
};

const LOCALES: AgentTemplateLocale[] = ["id", "en"];

describe("katalog templat instruction agent", () => {
  it("memuat tepat enam templat bawaan dengan slug unik yang diharapkan", () => {
    expect(AGENT_INSTRUCTION_TEMPLATES).toHaveLength(6);
    expect(AGENT_INSTRUCTION_TEMPLATES.map((t) => t.slug)).toEqual(
      EXPECTED_SLUGS,
    );
    expect(new Set(EXPECTED_SLUGS).size).toBe(6);
    // Bentuk katalog lolos skema bentuknya sendiri.
    expect(
      AgentInstructionTemplateCatalogSchema.safeParse(
        AGENT_INSTRUCTION_TEMPLATES,
      ).success,
    ).toBe(true);
  });

  it("setiap templat punya kunci i18n galeri dan nama saran dua bahasa", () => {
    for (const tpl of AGENT_INSTRUCTION_TEMPLATES) {
      expect(tpl.nameKey).toMatch(/^agents\.tpl[A-Za-z]+Name$/);
      expect(tpl.descriptionKey).toMatch(/^agents\.tpl[A-Za-z]+Desc$/);
      for (const locale of LOCALES) {
        expect(tpl.suggestedName[locale].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("setiap instruction mengikuti kerangka lima bagian dalam dua bahasa", () => {
    for (const tpl of AGENT_INSTRUCTION_TEMPLATES) {
      for (const locale of LOCALES) {
        const text = tpl.instruction[locale];
        for (const header of SECTION_HEADERS[locale]) {
          expect(
            text.includes(header),
            `${tpl.slug}/${locale} kehilangan bagian "${header}"`,
          ).toBe(true);
        }
        // Kerangka adalah urutan, bukan sekadar kumpulan: bagian harus
        // muncul dalam urutan Peran → … → serahkan ke manusia.
        const positions = SECTION_HEADERS[locale].map((h) => text.indexOf(h));
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      }
    }
  });

  it("setiap instruction memuat kalimat pengaman anti-karangan", () => {
    for (const tpl of AGENT_INSTRUCTION_TEMPLATES) {
      for (const locale of LOCALES) {
        expect(
          tpl.instruction[locale].includes(SAFETY_SENTENCE[locale]),
          `${tpl.slug}/${locale} kehilangan kalimat pengaman`,
        ).toBe(true);
      }
    }
  });

  it("setiap instruction memuat penanda kurung siku yang jelas untuk diganti pemilik", () => {
    for (const tpl of AGENT_INSTRUCTION_TEMPLATES) {
      for (const locale of LOCALES) {
        const placeholders = extractInstructionPlaceholders(
          tpl.instruction[locale],
        );
        expect(
          placeholders.length,
          `${tpl.slug}/${locale} tanpa penanda`,
        ).toBeGreaterThanOrEqual(1);
        // Penanda pertama selalu nama bisnis — fakta paling dasar.
        expect(placeholders[0]).toBe(
          locale === "id" ? "nama bisnis" : "business name",
        );
      }
    }
  });

  it("templat sensitif (FAQ Hemat & Penangan Komplain) menyarankan mode suggest", () => {
    expect(findAgentInstructionTemplate("faq-hemat")?.mode).toBe("suggest");
    expect(findAgentInstructionTemplate("penangan-komplain")?.mode).toBe(
      "suggest",
    );
  });

  it("resolveAgentTemplateFill mengisi field formulir dari locale yang dipilih", () => {
    for (const tpl of AGENT_INSTRUCTION_TEMPLATES) {
      for (const locale of LOCALES) {
        const fill = resolveAgentTemplateFill(tpl, locale);
        expect(fill.name).toBe(tpl.suggestedName[locale]);
        expect(fill.systemPrompt).toBe(tpl.instruction[locale]);
        expect(fill.mode).toBe(tpl.mode);
        expect(fill.language).toBe(locale);
      }
    }
  });
});

describe("extractInstructionPlaceholders", () => {
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
