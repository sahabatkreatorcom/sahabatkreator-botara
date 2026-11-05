import { z } from "zod";

// ---------------------------------------------------------------------------
// Fase 16B — Galeri Template Automation
// ---------------------------------------------------------------------------

/**
 * KATALOG TEMPLATE AUTOMATION — padanan `FLOW_TEMPLATES` untuk halaman
 * /automations. Bedanya dengan flow: automation TIDAK punya status
 * draf, jadi template di sini langsung membuat automation utuh
 * (bukan draf) — tetapi SELALU dibuat NONAKTIF. Alasan keselamatan:
 * teks bawaan template memuat placeholder yang wajib disesuaikan
 * pemilik (harga, alamat, tautan). Automation aktif akan langsung
 * membalas pelanggan sungguhan dengan teks yang belum disunting, dan
 * tidak ada pratinjau di antara klik dan pesan terkirim. Membuatnya
 * nonaktif membuat "Pakai template" = mengisi formulir, bukan
 * menembakkan pesan.
 *
 * `nameKey`/`descriptionKey` adalah kunci i18n (paket i18n) — katalog
 * dwibahasa tanpa string katalog ter-hardcode di klien. `defaultName`
 * adalah nama automation bawaan BAHASA INDONESIA yang dipakai API bila
 * klien tidak mengirim nama (klien web mengirim nama dari terjemahan
 * sesuai locale).
 *
 * `keywords`/`text`/`steps` sengaja berisi teks Indonesia yang netral
 * dan JELAS perlu disunting (placeholder dalam tanda kurung siku).
 *
 * Template `kind: "comment"` TIDAK ada di katalog v1: aturan komentar
 * wajib terikat ke SATU akun Instagram/Messenger milik tenant
 * (`channelAccountId`), yang tidak bisa ditentukan katalog statis —
 * pemilik harus memilih akunnya sendiri. Menyertakannya berarti
 * menambah parameter wajib pada instantiate hanya untuk satu jenis.
 */
export const AutomationTemplateCategorySchema = z.enum([
  "faq",
  "sales",
  "support",
  "followup",
]);
export type AutomationTemplateCategory = z.infer<
  typeof AutomationTemplateCategorySchema
>;

/** Jenis automation yang bisa berasal dari template (v1). */
export const AutomationTemplateKindSchema = z.enum(["keyword", "sequence"]);
export type AutomationTemplateKind = z.infer<
  typeof AutomationTemplateKindSchema
>;

interface AutomationTemplateBase {
  slug: string;
  nameKey: string;
  descriptionKey: string;
  category: AutomationTemplateCategory;
  defaultName: string;
  keywords: string[];
  match: "exact" | "contains";
}

/** Balasan langsung: satu pesan untuk satu kecocokan kata kunci. */
export interface AutomationTemplateKeyword extends AutomationTemplateBase {
  kind: "keyword";
  text: string;
}

/** Rangkaian berjeda: beberapa pesan, tiap langkah punya jeda sendiri. */
export interface AutomationTemplateSequence extends AutomationTemplateBase {
  kind: "sequence";
  steps: { delayMinutes: number; text: string }[];
}

export type AutomationTemplateDefinition =
  | AutomationTemplateKeyword
  | AutomationTemplateSequence;

export const AUTOMATION_TEMPLATES: AutomationTemplateDefinition[] = [
  // ---- FAQ (balasan langsung) ---------------------------------------------
  {
    slug: "harga-produk",
    nameKey: "automations.tplHargaName",
    descriptionKey: "automations.tplHargaDesc",
    category: "faq",
    defaultName: "Tanya Harga",
    keywords: ["harga", "berapa", "price"],
    match: "contains",
    kind: "keyword",
    text: "Halo {name}! Untuk harga terbaru, ini daftar kami: [tulis daftar harga atau tautan katalog di sini]. Kalau mau, saya bantu pilihkan yang paling sesuai kebutuhanmu.",
  },
  {
    slug: "jam-operasional",
    nameKey: "automations.tplJamName",
    descriptionKey: "automations.tplJamDesc",
    category: "faq",
    defaultName: "Jam Operasional",
    keywords: ["jam buka", "buka jam", "jam operasional", "open"],
    match: "contains",
    kind: "keyword",
    text: "Halo {name}! Kami buka [Senin–Sabtu, 09.00–17.00 WIB]. Di luar jam itu pesanmu tetap masuk dan kami balas pada hari kerja berikutnya ya.",
  },
  {
    slug: "lokasi-alamat",
    nameKey: "automations.tplLokasiName",
    descriptionKey: "automations.tplLokasiDesc",
    category: "faq",
    defaultName: "Lokasi & Alamat",
    keywords: ["lokasi", "alamat", "dimana", "di mana", "maps"],
    match: "contains",
    kind: "keyword",
    text: "Halo {name}! Lokasi kami di [isi alamat lengkap]. Ini titik petanya: [tautan Google Maps]. Kalau masih bingung, balas saja — nanti saya arahkan.",
  },
  // ---- Penjualan ----------------------------------------------------------
  {
    slug: "cara-pesan",
    nameKey: "automations.tplCaraPesanName",
    descriptionKey: "automations.tplCaraPesanDesc",
    category: "sales",
    defaultName: "Cara Pesan",
    keywords: ["cara pesan", "cara order", "gimana pesan", "how to order"],
    match: "contains",
    kind: "keyword",
    text: "Halo {name}! Cara pesannya gampang: sebutkan produk yang kamu mau di sini, lalu saya kirimkan tautan pembayarannya. Mau mulai dari produk yang mana?",
  },
  {
    slug: "pengingat-keranjang",
    nameKey: "automations.tplKeranjangName",
    descriptionKey: "automations.tplKeranjangDesc",
    category: "sales",
    defaultName: "Pengingat Keranjang",
    keywords: ["keranjang", "cart", "belum jadi"],
    match: "contains",
    kind: "sequence",
    steps: [
      {
        delayMinutes: 0,
        text: "Halo {name}! Pesananmu masih tersimpan di keranjang. Kalau mau lanjut, balas LANJUT ya.",
      },
      {
        delayMinutes: 240,
        text: "Hai {name}, keranjangmu masih kami simpan kok. Ada yang mau ditanyakan dulu sebelum lanjut?",
      },
      {
        delayMinutes: 1_440,
        text: "Halo {name}, ini pengingat terakhir dari kami. Kalau sudah tidak perlu, abaikan saja pesan ini ya.",
      },
    ],
  },
  // ---- Dukungan -----------------------------------------------------------
  {
    slug: "minta-admin",
    nameKey: "automations.tplAdminName",
    descriptionKey: "automations.tplAdminDesc",
    category: "support",
    defaultName: "Minta Admin",
    keywords: ["admin", "cs", "manusia", "customer service"],
    match: "contains",
    kind: "keyword",
    text: "Baik, {name} — saya sambungkan ke admin kami ya. Mohon tunggu sebentar, admin akan membalas langsung di percakapan ini.",
  },
  // ---- Tindak lanjut (rangkaian) ------------------------------------------
  {
    slug: "sambutan-pelanggan-baru",
    nameKey: "automations.tplSambutanSeqName",
    descriptionKey: "automations.tplSambutanSeqDesc",
    category: "followup",
    defaultName: "Sambutan Pelanggan Baru",
    keywords: ["daftar", "member", "gabung"],
    match: "contains",
    kind: "sequence",
    steps: [
      {
        delayMinutes: 0,
        text: "Selamat datang, {name}! Pendaftaranmu sudah kami catat. Langkah pertama yang bisa kamu lakukan: [tulis langkah pertama di sini].",
      },
      {
        delayMinutes: 60,
        text: "Tips singkat untuk {name}: [tulis satu tips yang paling berguna di sini].",
      },
      {
        delayMinutes: 1_440,
        text: "Halo {name}, sudah sempat mencoba? Kalau ada kendala, balas pesan ini — kami bantu sampai beres.",
      },
    ],
  },
  {
    slug: "follow-up-tanya",
    nameKey: "automations.tplFollowUpName",
    descriptionKey: "automations.tplFollowUpDesc",
    category: "followup",
    defaultName: "Tindak Lanjut Pertanyaan",
    keywords: ["tanya", "info", "konsultasi"],
    match: "contains",
    kind: "sequence",
    steps: [
      {
        delayMinutes: 0,
        text: "Halo {name}! Terima kasih sudah menghubungi kami. Ada yang bisa saya bantu?",
      },
      {
        delayMinutes: 1_440,
        text: "Halo {name}, saya ingin memastikan pertanyaanmu sudah terjawab. Kalau masih ada yang ingin ditanyakan, balas saja di sini ya.",
      },
      {
        delayMinutes: 2_880,
        text: "Hai {name}! Kalau nanti butuh bantuan lagi, kami siap. Terima kasih sudah mampir.",
      },
    ],
  },
];

/** Template menurut slug stabilnya; null bila tidak dikenal. */
export function findAutomationTemplate(
  slug: string,
): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES.find((tpl) => tpl.slug === slug) ?? null;
}

export const AutomationTemplateSummarySchema = z.object({
  slug: z.string(),
  nameKey: z.string(),
  descriptionKey: z.string(),
  category: AutomationTemplateCategorySchema,
  kind: AutomationTemplateKindSchema,
  keywordCount: z.number().int().positive(),
  /** 0 untuk kind='keyword'. */
  stepCount: z.number().int().nonnegative(),
});
export type AutomationTemplateSummary = z.infer<
  typeof AutomationTemplateSummarySchema
>;

export const AutomationTemplateListResponseSchema = z.object({
  templates: z.array(AutomationTemplateSummarySchema),
});
export type AutomationTemplateListResponse = z.infer<
  typeof AutomationTemplateListResponseSchema
>;

/** Ringkasan satu template (dipakai rute daftar). */
export function summarizeAutomationTemplate(
  tpl: AutomationTemplateDefinition,
): AutomationTemplateSummary {
  return {
    slug: tpl.slug,
    nameKey: tpl.nameKey,
    descriptionKey: tpl.descriptionKey,
    category: tpl.category,
    kind: tpl.kind,
    keywordCount: tpl.keywords.length,
    stepCount: tpl.kind === "sequence" ? tpl.steps.length : 0,
  };
}

export const InstantiateAutomationTemplateRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
});
export type InstantiateAutomationTemplateRequest = z.infer<
  typeof InstantiateAutomationTemplateRequestSchema
>;
