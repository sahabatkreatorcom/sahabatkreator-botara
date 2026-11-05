import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AUTOMATION_TEMPLATES, findAutomationTemplate } from "./automation-templates";
import { FLOW_TEMPLATES, findFlowTemplate } from "./flow-templates";
import { FlowGraphSchema, FlowNodeTypeSchema, type FlowGraph } from "./flows";

/**
 * KATALOG TEMPLATE — invarian struktural.
 *
 * Template adalah graf/pesan yang disalin apa adanya ke data pelanggan.
 * Kesalahan yang paling mahal di sini TIDAK terlihat saat typecheck:
 * satu cabang edge yang lupa ditulis membuat flow tidak bisa
 * DIAKTIFKAN sama sekali (aktivasi menolak graf), dan pemilik baru
 * menemukannya setelah menekan "Pakai template" lalu "Aktifkan".
 * Karena itu aturan aktivasi yang bergantung pada bentuk graf
 * diulang di sini sebagai test, bukan diserahkan pada ingatan.
 */

/**
 * Cabang edge yang WAJIB ada keluar tiap tipe node bercabang —
 * cerminan `BRANCH_RULES` di `packages/core/src/flows/validate.ts`.
 * Bila keduanya menyimpang, test ini yang menangkapnya lebih dulu.
 */
const REQUIRED_BRANCHES: Record<string, string[]> = {
  condition: ["yes", "no"],
  ab_split: ["a", "b"],
  wait_reply: ["replied", "timeout"],
  questionnaire: ["completed", "invalid", "timeout"],
  show_catalog: ["added", "invalid", "timeout"],
  cart_checkout: ["checked_out", "empty_cart"],
  book_appointment: ["booked", "invalid", "timeout", "slot_taken"],
};

/** Node yang membawa placeholder tenant-spesifik (uuid entitas). */
const PLACEHOLDER_NODES: Record<string, { field: string; need: string }> = {
  send_payment_link: { field: "productId", need: "product" },
  book_appointment: { field: "serviceId", need: "service" },
};

function assertFlowTemplate(slug: string, graph: FlowGraph) {
  // Bentuk resmi graf (kontrak) harus menerima template apa adanya.
  const parsed = FlowGraphSchema.safeParse(graph);
  expect(parsed.success, `${slug}: graf tidak lolos FlowGraphSchema`).toBe(true);

  const ids = new Set(graph.nodes.map((n) => n.id));
  expect(ids.size, `${slug}: id node duplikat`).toBe(graph.nodes.length);

  // Tepat satu trigger per flow (aturan aktivasi).
  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  expect(triggers.length, `${slug}: harus tepat satu node trigger`).toBe(1);

  // Tiap node memakai tipe yang dikenal kontrak.
  for (const node of graph.nodes) {
    expect(
      FlowNodeTypeSchema.safeParse(node.type).success,
      `${slug}: tipe node '${node.type}' tidak dikenal`,
    ).toBe(true);
  }

  // Semua edge menunjuk node yang ada.
  for (const edge of graph.edges) {
    expect(ids.has(edge.from), `${slug}: edge dari '${edge.from}' tak ada`).toBe(
      true,
    );
    expect(ids.has(edge.to), `${slug}: edge ke '${edge.to}' tak ada`).toBe(true);
  }

  // Cabang wajib lengkap; node non-bercabang tidak boleh membawa cabang.
  for (const node of graph.nodes) {
    const out = graph.edges.filter((e) => e.from === node.id);
    const required = REQUIRED_BRANCHES[node.type];
    if (required) {
      const branches = out.map((e) => e.branch).filter(Boolean).sort();
      expect(branches, `${slug}/${node.id}: cabang wajib ${required.join("+")}`).toEqual(
        [...required].sort(),
      );
    } else {
      const withBranch = out.filter((e) => e.branch !== undefined);
      expect(
        withBranch.length,
        `${slug}/${node.id}: node ${node.type} tidak boleh punya edge bercabang`,
      ).toBe(0);
    }
  }
}

describe("katalog template flow", () => {
  it("slug unik", () => {
    const slugs = FLOW_TEMPLATES.map((tpl) => tpl.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("setiap template lolos invarian struktur graf", () => {
    for (const tpl of FLOW_TEMPLATES) {
      assertFlowTemplate(tpl.slug, tpl.graph);
    }
  });

  it("setiap placeholder tenant-spesifik dinyatakan di `needs`", () => {
    // Template yang membawa uuid kosong TIDAK bisa diaktifkan sebelum
    // pemilik memilih entitasnya. Itu sah — tetapi hanya bila template
    // juga mengatakannya lewat `needs`, karena UI memakai `needs` untuk
    // memberi tahu pemilik apa yang harus dilengkapi.
    for (const tpl of FLOW_TEMPLATES) {
      for (const node of tpl.graph.nodes) {
        const rule = PLACEHOLDER_NODES[node.type];
        if (!rule) continue;
        const value = node.config[rule.field];
        const empty = typeof value !== "string" || value.trim() === "";
        if (!empty) continue;
        expect(
          tpl.needs,
          `${tpl.slug}: node ${node.type} tanpa ${rule.field} tetapi needs tidak memuat '${rule.need}'`,
        ).toContain(rule.need);
      }
    }
  });

  it("tidak ada target kuesioner `custom:` (butuh field yang sudah dikenal tenant)", () => {
    // `custom:<kunci>` ditolak aktivasi (QUESTIONNAIRE_TARGET_UNKNOWN)
    // sampai ada kontak workspace yang membawa kunci itu. Template harus
    // bisa diaktifkan tanpa persiapan tersembunyi.
    for (const tpl of FLOW_TEMPLATES) {
      for (const node of tpl.graph.nodes) {
        if (node.type !== "questionnaire") continue;
        const questions = node.config.questions;
        expect(Array.isArray(questions)).toBe(true);
        for (const q of questions as { id: string; target: string }[]) {
          expect(
            q.target.startsWith("custom:"),
            `${tpl.slug}/${node.id}: pertanyaan '${q.id}' memakai target custom`,
          ).toBe(false);
        }
      }
    }
  });

  it("konversi eksperimen menunjuk node lain di graf yang sama", () => {
    for (const tpl of FLOW_TEMPLATES) {
      for (const node of tpl.graph.nodes) {
        if (node.type !== "ab_split" || node.config.experiment !== true) continue;
        const conv = node.config.conversionNodeId;
        if (conv === undefined) continue;
        expect(typeof conv).toBe("string");
        expect(conv, `${tpl.slug}: conversionNodeId menunjuk diri sendiri`).not.toBe(
          node.id,
        );
        expect(
          tpl.graph.nodes.some((n) => n.id === conv),
          `${tpl.slug}: conversionNodeId '${String(conv)}' tidak ada di graf`,
        ).toBe(true);
      }
    }
  });

  it("findFlowTemplate mengembalikan null untuk slug tak dikenal", () => {
    expect(findFlowTemplate(FLOW_TEMPLATES[0]!.slug)).not.toBeNull();
    expect(findFlowTemplate("tidak-ada-template-ini")).toBeNull();
  });
});

describe("katalog template automation", () => {
  it("slug unik", () => {
    const slugs = AUTOMATION_TEMPLATES.map((tpl) => tpl.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("setiap template memenuhi batas kontrak automation", () => {
    for (const tpl of AUTOMATION_TEMPLATES) {
      expect(tpl.defaultName.trim().length, `${tpl.slug}: defaultName kosong`).toBeGreaterThan(0);
      expect(tpl.defaultName.length, `${tpl.slug}: defaultName terlalu panjang`).toBeLessThanOrEqual(255);

      // Batas AutomationKeywordsSchema: 1..10 kata kunci, tiap 1..255.
      expect(tpl.keywords.length, `${tpl.slug}: jumlah kata kunci`).toBeGreaterThanOrEqual(1);
      expect(tpl.keywords.length).toBeLessThanOrEqual(10);
      for (const kw of tpl.keywords) {
        expect(kw.trim(), `${tpl.slug}: kata kunci kosong`).not.toBe("");
        expect(kw.length, `${tpl.slug}: kata kunci terlalu panjang`).toBeLessThanOrEqual(255);
      }

      if (tpl.kind === "keyword") {
        // AutomationStepInputSchema.text: 1..4096.
        expect(tpl.text.trim(), `${tpl.slug}: teks balasan kosong`).not.toBe("");
        expect(tpl.text.length, `${tpl.slug}: teks balasan terlalu panjang`).toBeLessThanOrEqual(4096);
      } else {
        // CreateSequenceAutomationRequestSchema: 1..10 langkah.
        expect(tpl.steps.length, `${tpl.slug}: jumlah langkah`).toBeGreaterThanOrEqual(1);
        expect(tpl.steps.length).toBeLessThanOrEqual(10);
        for (const step of tpl.steps) {
          // delayMinutes: 0..43200 (30 hari).
          expect(Number.isInteger(step.delayMinutes)).toBe(true);
          expect(step.delayMinutes).toBeGreaterThanOrEqual(0);
          expect(step.delayMinutes).toBeLessThanOrEqual(43_200);
          expect(step.text.trim(), `${tpl.slug}: langkah tanpa teks`).not.toBe("");
          expect(step.text.length).toBeLessThanOrEqual(4096);
        }
      }
    }
  });

  it("findAutomationTemplate mengembalikan null untuk slug tak dikenal", () => {
    expect(findAutomationTemplate(AUTOMATION_TEMPLATES[0]!.slug)).not.toBeNull();
    expect(findAutomationTemplate("tidak-ada-template-ini")).toBeNull();
  });
});

/**
 * KUNCI i18n — halaman memanggil `t(tpl.nameKey as TranslationKey)`, dan
 * cast itu MEMATIKAN pemeriksaan TypeScript: kunci yang salah ketik
 * tidak gagal compile, ia hanya tampil sebagai teks mentah
 * ("flows.tplSalahKetik") di kartu galeri.
 *
 * Pemeriksaan di bawah membaca berkas resource sebagai TEKS (paket
 * kontrak tidak boleh bergantung pada paket i18n) dan mencari nama kunci
 * daunnya. Yang dibuktikan: setiap kunci katalog ADA di kedua bahasa.
 * Yang TIDAK dibuktikan: kunci itu berada di namespace yang benar —
 * karena itu test ini juga menuntut setiap nama daun unik di seluruh
 * katalog, sehingga salah-namespace tidak bisa lolos diam-diam.
 */
describe("kunci i18n katalog template", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const resourcesDir = path.join(here, "../../i18n/src/resources");

  const catalogs = [
    ...FLOW_TEMPLATES.map((tpl) => ({
      slug: tpl.slug,
      nameKey: tpl.nameKey,
      descriptionKey: tpl.descriptionKey,
    })),
    ...AUTOMATION_TEMPLATES.map((tpl) => ({
      slug: tpl.slug,
      nameKey: tpl.nameKey,
      descriptionKey: tpl.descriptionKey,
    })),
  ];

  const leaf = (key: string) => key.slice(key.lastIndexOf(".") + 1);

  it("nama daun kunci unik di seluruh katalog", () => {
    const leaves = catalogs.flatMap((tpl) => [
      leaf(tpl.nameKey),
      leaf(tpl.descriptionKey),
    ]);
    expect(new Set(leaves).size).toBe(leaves.length);
  });

  it.each(["id", "en"] as const)(
    "semua kunci ada di resource %s",
    (locale) => {
      const source = readFileSync(
        path.join(resourcesDir, `${locale}.ts`),
        "utf8",
      );
      for (const tpl of catalogs) {
        for (const key of [tpl.nameKey, tpl.descriptionKey]) {
          // Entri resource ditulis `namaKunci: "…"`.
          expect(
            source.includes(`${leaf(key)}:`),
            `${tpl.slug}: kunci '${key}' tidak ada di ${locale}.ts`,
          ).toBe(true);
        }
      }
    },
  );
});
