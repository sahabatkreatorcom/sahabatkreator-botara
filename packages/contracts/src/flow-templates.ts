import { z } from "zod";

import type { FlowGraph } from "./flows";

// ---------------------------------------------------------------------------
// Fase 12B — Galeri Template Flow
// ---------------------------------------------------------------------------

/**
 * KATALOG TEMPLATE FLOW — definisi statis di kontrak sebagai sumber
 * kebenaran bersama (API daftar/instantiate; builder menerimanya lewat
 * API). Template adalah graf LENGKAP (termasuk `position` builder)
 * yang disalin apa adanya saat instantiate; id node diregenerasi di
 * server agar dua hasil instantiate tidak pernah bertabrakan.
 *
 * `nameKey`/`descriptionKey` adalah kunci i18n (paket i18n) — nama &
 * deskripsi katalog dwibahasa tanpa string katalog ter-hardcode di
 * klien. `defaultName` adalah nama flow bawaan BAHASA INDONESIA yang
 * dipakai API bila klien tidak mengirim nama (nama flow adalah data
 * pengguna; klien web mengirim nama dari terjemahan sesuai locale).
 *
 * Teks node di dalam graf ditulis dalam Bahasa Indonesia yang netral
 * (audiens utama kreator Indonesia); graf memang hanya menyimpan SATU
 * teks per node — pemilik flow mengeditnya di builder.
 *
 * `needs` = daftar hal yang WAJIB dilengkapi pemilik sebelum flow bisa
 * diaktifkan. Satu-satunya nilai v1: "product" — node
 * `send_payment_link` pada template sengaja membawa `productId`
 * KOSONG (placeholder): aktivasi menolaknya dengan issue
 * PAYMENT_PRODUCT_ID_REQUIRED yang menunjuk node itu sampai pemilik
 * memilih produk aslinya di builder.
 */
export const FlowTemplateCategorySchema = z.enum([
  "onboarding",
  "sales",
  "support",
  "event",
  "lead",
]);
export type FlowTemplateCategory = z.infer<typeof FlowTemplateCategorySchema>;

export const FlowTemplateNeedSchema = z.enum(["product"]);
export type FlowTemplateNeed = z.infer<typeof FlowTemplateNeedSchema>;

export interface FlowTemplateDefinition {
  slug: string;
  nameKey: string;
  descriptionKey: string;
  category: FlowTemplateCategory;
  needs: FlowTemplateNeed[];
  defaultName: string;
  graph: FlowGraph;
}

export const FLOW_TEMPLATES: FlowTemplateDefinition[] = [
  {
    slug: "sambutan-tag-minat",
    nameKey: "flows.tplSambutanName",
    descriptionKey: "flows.tplSambutanDesc",
    category: "onboarding",
    needs: [],
    defaultName: "Sambutan + Tag Minat",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: { kind: "any_message" },
          position: { x: 0, y: 0 },
        },
        {
          id: "sambutan",
          type: "send_message",
          config: {
            text: "{Halo|Hai|Halo kak} {name}! Selamat datang — senang bisa menyapa. Saya bantu carikan yang kamu butuhkan ya.",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "tag",
          type: "add_tag",
          config: { tag: "lead-baru" },
          position: { x: 580, y: 0 },
        },
        {
          id: "tanya",
          type: "send_message",
          config: {
            text: "Boleh tahu, {name} sedang cari apa? Balas saja dengan kata kunci: produk, harga, atau jadwal — nanti saya arahkan.",
          },
          position: { x: 870, y: 0 },
        },
        { id: "end", type: "end", config: {}, position: { x: 1160, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "sambutan" },
        { from: "sambutan", to: "tag" },
        { from: "tag", to: "tanya" },
        { from: "tanya", to: "end" },
      ],
    },
  },
  {
    slug: "checkout-link-bayar",
    nameKey: "flows.tplCheckoutName",
    descriptionKey: "flows.tplCheckoutDesc",
    category: "sales",
    needs: ["product"],
    defaultName: "Checkout — Kirim Link Bayar",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["beli", "order", "checkout"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "bayar",
          type: "send_payment_link",
          // Placeholder SENGAJA kosong: pemilik wajib memilih produk
          // asli sebelum aktivasi (lihat `needs`).
          config: { productId: "" },
          position: { x: 290, y: 0 },
        },
        {
          id: "tunggu",
          type: "wait_reply",
          config: { amount: 24, unit: "hours" },
          position: { x: 580, y: 0 },
        },
        { id: "end", type: "end", config: {}, position: { x: 870, y: 0 } },
        {
          id: "ingat",
          type: "send_message",
          config: {
            text: "Halo {name}, pesananmu masih kami simpan. Kalau masih ingin lanjut, cukup balas pesan ini ya — atau abaikan saja bila sudah tidak perlu.",
          },
          position: { x: 870, y: 180 },
        },
      ],
      edges: [
        { from: "trigger", to: "bayar" },
        { from: "bayar", to: "tunggu" },
        { from: "tunggu", to: "end", branch: "replied" },
        { from: "tunggu", to: "ingat", branch: "timeout" },
        { from: "ingat", to: "end" },
      ],
    },
  },
  {
    slug: "tanya-jawab-ai",
    nameKey: "flows.tplTanyaJawabName",
    descriptionKey: "flows.tplTanyaJawabDesc",
    category: "support",
    needs: [],
    defaultName: "Tanya-Jawab AI",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: { kind: "any_message" },
          position: { x: 0, y: 0 },
        },
        {
          id: "ai",
          type: "ai_response",
          config: {},
          position: { x: 290, y: 0 },
        },
        { id: "end", type: "end", config: {}, position: { x: 580, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "ai" },
        { from: "ai", to: "end" },
      ],
    },
  },
  {
    slug: "pengingat-webinar",
    nameKey: "flows.tplWebinarName",
    descriptionKey: "flows.tplWebinarDesc",
    category: "event",
    needs: [],
    defaultName: "Pengingat Webinar",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["webinar", "kelas"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "info",
          type: "send_message",
          config: {
            text: "Siap, {name}! Kamu masuk daftar info webinar/kelas kami. Detail acara akan kami kirim di sini — sampai jumpa di kelasnya!",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "sumber",
          type: "set_field",
          config: { field: "custom:sumber", value: "webinar" },
          position: { x: 580, y: 0 },
        },
        {
          id: "jeda1",
          type: "delay",
          config: { amount: 24, unit: "hours" },
          position: { x: 870, y: 0 },
        },
        {
          id: "ingat",
          type: "send_message",
          config: {
            text: "Pengingat untuk {name}: webinar/kelas kita dimulai besok. Siapkan pertanyaanmu dari sekarang ya.",
          },
          position: { x: 1160, y: 0 },
        },
        {
          id: "jeda2",
          type: "delay",
          config: { amount: 2, unit: "hours" },
          position: { x: 1450, y: 0 },
        },
        {
          id: "rekaman",
          type: "send_message",
          config: {
            text: "Terima kasih sudah ikut, {name}! Ini tautan rekamannya: https://contoh.id/rekaman — silakan ganti dengan tautan aslimu.",
          },
          position: { x: 1740, y: 0 },
        },
        { id: "end", type: "end", config: {}, position: { x: 2030, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "info" },
        { from: "info", to: "sumber" },
        { from: "sumber", to: "jeda1" },
        { from: "jeda1", to: "ingat" },
        { from: "ingat", to: "jeda2" },
        { from: "jeda2", to: "rekaman" },
        { from: "rekaman", to: "end" },
      ],
    },
  },
  {
    slug: "lead-magnet-ebook",
    nameKey: "flows.tplEbookName",
    descriptionKey: "flows.tplEbookDesc",
    category: "lead",
    needs: [],
    defaultName: "Lead Magnet — Ebook Gratis",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["ebook", "gratis"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "pembuka",
          type: "send_message",
          config: {
            text: "Halo {name}! Ebook gratisnya sudah siap. Balas MAU untuk menerima tautan unduhnya ya.",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "tunggu",
          type: "wait_reply",
          config: { amount: 48, unit: "hours" },
          position: { x: 580, y: 0 },
        },
        {
          id: "unduh",
          type: "send_message",
          config: {
            text: "Ini tautan unduh ebook-mu, {name}: https://contoh.id/ebook — selamat membaca! (Ganti tautan ini dengan tautan aslimu.)",
          },
          position: { x: 870, y: 0 },
        },
        {
          id: "tag",
          type: "add_tag",
          config: { tag: "lead-ebook" },
          position: { x: 1160, y: 0 },
        },
        {
          id: "ingat",
          type: "send_message",
          config: {
            text: "Halo {name}, ebook gratisnya masih menunggu lho. Balas MAU kapan saja untuk menerimanya.",
          },
          position: { x: 870, y: 180 },
        },
        { id: "end", type: "end", config: {}, position: { x: 1450, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "pembuka" },
        { from: "pembuka", to: "tunggu" },
        { from: "tunggu", to: "unduh", branch: "replied" },
        { from: "unduh", to: "tag" },
        { from: "tag", to: "end" },
        { from: "tunggu", to: "ingat", branch: "timeout" },
        { from: "ingat", to: "end" },
      ],
    },
  },
  {
    slug: "eskalasi-admin",
    nameKey: "flows.tplEskalasiName",
    descriptionKey: "flows.tplEskalasiDesc",
    category: "support",
    needs: [],
    defaultName: "Eskalasi ke Admin",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["admin", "manusia", "cs"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "info",
          type: "send_message",
          config: {
            text: "Baik, {name} — saya sambungkan ke admin manusia ya. Mohon tunggu sebentar, admin akan membalas langsung dari sini.",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "serah",
          type: "handoff",
          config: {},
          position: { x: 580, y: 0 },
        },
        { id: "end", type: "end", config: {}, position: { x: 870, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "info" },
        { from: "info", to: "serah" },
        { from: "serah", to: "end" },
      ],
    },
  },
];

/** Template menurut slug stabilnya; null bila tidak dikenal. */
export function findFlowTemplate(slug: string): FlowTemplateDefinition | null {
  return FLOW_TEMPLATES.find((tpl) => tpl.slug === slug) ?? null;
}

export const FlowTemplateSummarySchema = z.object({
  slug: z.string(),
  nameKey: z.string(),
  descriptionKey: z.string(),
  category: FlowTemplateCategorySchema,
  nodeCount: z.number().int().positive(),
  needs: z.array(FlowTemplateNeedSchema),
});
export type FlowTemplateSummary = z.infer<typeof FlowTemplateSummarySchema>;

export const FlowTemplateListResponseSchema = z.object({
  templates: z.array(FlowTemplateSummarySchema),
});
export type FlowTemplateListResponse = z.infer<
  typeof FlowTemplateListResponseSchema
>;

export const InstantiateFlowTemplateRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
});
export type InstantiateFlowTemplateRequest = z.infer<
  typeof InstantiateFlowTemplateRequestSchema
>;
