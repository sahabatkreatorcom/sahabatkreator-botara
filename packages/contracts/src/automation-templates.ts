import { z } from "zod";

import {
  AutomationStepInputSchema,
  AutomationStepResponseSchema,
} from "./automations";

// ---------------------------------------------------------------------------
// Fase 16B — Galeri Template Automation
// Gelombang G2 — lapisan templat sequence: katalog sequence dwibahasa,
// pratinjau linimasa, penanda heuristik jendela WhatsApp, templat pribadi.
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
 * `nameKey`/`descriptionKey` adalah kunci i18n (paket i18n) — nama &
 * deskripsi kartu galeri dwibahasa tanpa string katalog ter-hardcode
 * di klien.
 *
 * ISI SEQUENCE DWIBAHASA PENUH (G2): berbeda dari katalog keyword yang
 * teks badannya satu bahasa, langkah sequence adalah rangkaian pesan
 * kerja yang terkirim berkali-kali ke pelanggan — bahasanya mengikuti
 * locale UI pemilik saat memakai template (pola isi-sebagai-data per
 * locale dari katalog templat instruction agent). Karena itu konten
 * sequence (nama bawaan, kata kunci, langkah) hidup sebagai
 * `content: Record<locale, …>`; instantiate memilih locale yang
 * diminta klien (bawaan "id"). Templat keyword TIDAK ikut diubah —
 * mereka bukan bagian gelombang ini dan tidak dimigrasi massal.
 *
 * Variabel kontak yang boleh dijanjikan teks langkah HANYA `{name}`
 * (+ spintax `{a|b}`): itulah seluruh yang benar-benar dirender
 * runtime lewat `renderMessageText` bersama di core. Fakta bisnis
 * ditulis sebagai PENANDA kurung siku ([nama bisnis], [link katalog],
 * [kode promo]) — peringatannya non-blokir di mana pun ia tampil.
 *
 * Template `kind: "comment"` TIDAK ada di katalog: aturan komentar
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

/** Jenis automation yang bisa berasal dari template. */
export const AutomationTemplateKindSchema = z.enum(["keyword", "sequence"]);
export type AutomationTemplateKind = z.infer<
  typeof AutomationTemplateKindSchema
>;

/** Locale isi katalog sequence — mengikuti locale UI pemilik. */
export const AutomationTemplateLocaleSchema = z.enum(["id", "en"]);
export type AutomationTemplateLocale = z.infer<
  typeof AutomationTemplateLocaleSchema
>;

interface AutomationTemplateBase {
  slug: string;
  nameKey: string;
  descriptionKey: string;
  category: AutomationTemplateCategory;
  match: "exact" | "contains";
}

/** Balasan langsung: satu pesan untuk satu kecocokan kata kunci. */
export interface AutomationTemplateKeyword extends AutomationTemplateBase {
  kind: "keyword";
  /** Nama automation bawaan (bahasa Indonesia) bila klien tak mengirim nama. */
  defaultName: string;
  keywords: string[];
  text: string;
}

/** Isi satu locale untuk template sequence: nama, kata kunci, langkah. */
export interface AutomationSequenceTemplateContent {
  /** Nama automation bawaan pada locale ini. */
  defaultName: string;
  keywords: string[];
  /** Langkah berurutan; jeda relatif terhadap langkah sebelumnya. */
  steps: { delayMinutes: number; text: string }[];
}

/** Rangkaian berjeda: beberapa pesan, tiap langkah punya jeda sendiri. */
export interface AutomationTemplateSequence extends AutomationTemplateBase {
  kind: "sequence";
  content: Record<AutomationTemplateLocale, AutomationSequenceTemplateContent>;
}

export type AutomationTemplateDefinition =
  | AutomationTemplateKeyword
  | AutomationTemplateSequence;

/** Isi sequence pada satu locale (jatuh ke "id" bila locale tak dikenal). */
export function resolveAutomationSequenceContent(
  tpl: AutomationTemplateSequence,
  locale: AutomationTemplateLocale,
): AutomationSequenceTemplateContent {
  return tpl.content[locale] ?? tpl.content.id;
}

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
    // G2: framing ditingkatkan dari "Pengingat Keranjang" menjadi
    // "Pengingat Pesanan Terbengkalai" (slug stabil, tidak diganti —
    // slug adalah identitas katalog, bukan label tampilan).
    slug: "pengingat-keranjang",
    nameKey: "automations.tplKeranjangName",
    descriptionKey: "automations.tplKeranjangDesc",
    category: "sales",
    match: "contains",
    kind: "sequence",
    content: {
      id: {
        defaultName: "Pengingat Pesanan Terbengkalai",
        keywords: ["keranjang", "cart", "belum jadi", "checkout"],
        steps: [
          {
            delayMinutes: 0,
            text: "Halo {name}! Pesananmu di [nama bisnis] belum selesai dibayar dan masih kami simpan. Selesaikan di sini: [link katalog]. Kalau ada kendala, balas saja pesan ini.",
          },
          {
            delayMinutes: 240,
            text: "Hai {name}, sekadar mengingatkan — pesananmu masih menunggu pembayaran. Stoknya tidak bisa kami tahan terlalu lama, jadi selesaikan selagi masih tersedia ya.",
          },
          {
            delayMinutes: 1_440,
            text: "Halo {name}, ini pengingat terakhir untuk pesananmu yang terbengkalai. Masih bisa diselesaikan hari ini di [link katalog]. Kalau sudah tidak perlu, abaikan saja pesan ini.",
          },
        ],
      },
      en: {
        defaultName: "Abandoned Order Reminder",
        keywords: ["cart", "checkout", "my order"],
        steps: [
          {
            delayMinutes: 0,
            text: "Hi {name}! Your order at [business name] is still waiting for payment and we are holding it for you. Complete it here: [catalog link]. If anything is in the way, just reply to this message.",
          },
          {
            delayMinutes: 240,
            text: "Hi {name}, just a reminder — your order is still awaiting payment. We cannot hold the stock for too long, so please complete it while it is still available.",
          },
          {
            delayMinutes: 1_440,
            text: "Hi {name}, this is the last reminder about your abandoned order. You can still complete it today at [catalog link]. If you no longer need it, simply ignore this message.",
          },
        ],
      },
    },
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
    match: "contains",
    kind: "sequence",
    content: {
      id: {
        defaultName: "Sambutan Pelanggan Baru",
        keywords: ["daftar", "member", "gabung"],
        steps: [
          {
            delayMinutes: 0,
            text: "Selamat datang, {name}! Terima kasih sudah bergabung dengan [nama bisnis]. Sebagai tanda sambutan, ini untukmu: [kode promo]. Jelajahi katalog kami di sini: [link katalog].",
          },
          {
            delayMinutes: 60,
            text: "Tips singkat untuk {name}: [tulis satu tips yang paling berguna di sini]. Simpan nomor ini ya, supaya mudah menghubungi kami lagi.",
          },
          {
            delayMinutes: 1_440,
            text: "Halo {name}, bagaimana pengalaman pertamamu dengan [nama bisnis]? Kalau ada kendala atau pertanyaan, balas pesan ini — kami bantu sampai beres.",
          },
        ],
      },
      en: {
        defaultName: "New Customer Welcome",
        keywords: ["sign up", "register", "join"],
        steps: [
          {
            delayMinutes: 0,
            text: "Welcome, {name}! Thank you for joining [business name]. As a welcome gift, this is for you: [promo code]. Browse our catalog here: [catalog link].",
          },
          {
            delayMinutes: 60,
            text: "A quick tip for you, {name}: [write the single most useful tip here]. Save this number so you can easily reach us again.",
          },
          {
            delayMinutes: 1_440,
            text: "Hi {name}, how was your first experience with [business name]? If anything is unclear or not working, just reply to this message — we will help until it is sorted.",
          },
        ],
      },
    },
  },
  {
    // G2: framing ditingkatkan dari "Tindak Lanjut Pertanyaan" menjadi
    // "Follow-up Lead Dingin" (slug stabil dipertahankan).
    slug: "follow-up-tanya",
    nameKey: "automations.tplFollowUpName",
    descriptionKey: "automations.tplFollowUpDesc",
    category: "followup",
    match: "contains",
    kind: "sequence",
    content: {
      id: {
        defaultName: "Follow-up Lead Dingin",
        keywords: ["tanya", "info", "konsultasi"],
        steps: [
          {
            delayMinutes: 0,
            text: "Halo {name}! Terima kasih sudah menghubungi [nama bisnis]. Supaya kami bisa membantu dengan tepat, boleh ceritakan kebutuhanmu? Atau lihat-lihat dulu katalog kami: [link katalog].",
          },
          {
            delayMinutes: 1_440,
            text: "Halo {name}, kami menindaklanjuti obrolan kemarin. Masih ada yang ingin ditanyakan soal [produk atau layanan yang diminati]? Balas saja — tidak ada kewajiban membeli kok.",
          },
          {
            delayMinutes: 2_880,
            text: "Hai {name}! Ini tindak lanjut terakhir dari kami. Kalau waktunya belum tepat, tidak apa-apa — simpan saja nomor ini. Saat kamu butuh nanti, kami di [nama bisnis] siap membantu.",
          },
        ],
      },
      en: {
        defaultName: "Cold Lead Follow-up",
        keywords: ["ask", "info", "consult"],
        steps: [
          {
            delayMinutes: 0,
            text: "Hi {name}! Thank you for contacting [business name]. So we can help you properly, could you tell us what you need? Or browse our catalog first: [catalog link].",
          },
          {
            delayMinutes: 1_440,
            text: "Hi {name}, we are following up on our chat yesterday. Is there anything else you would like to ask about [product or service they asked about]? Just reply — there is no obligation to buy.",
          },
          {
            delayMinutes: 2_880,
            text: "Hi {name}! This is our last follow-up. If the timing is not right, that is perfectly fine — just save this number. When you need us, [business name] is ready to help.",
          },
        ],
      },
    },
  },
  {
    slug: "edukasi-produk-bertahap",
    nameKey: "automations.tplEdukasiName",
    descriptionKey: "automations.tplEdukasiDesc",
    category: "sales",
    match: "contains",
    kind: "sequence",
    content: {
      id: {
        defaultName: "Edukasi Produk Bertahap",
        keywords: ["edukasi", "belajar", "materi"],
        steps: [
          {
            delayMinutes: 0,
            text: "Halo {name}! Selama beberapa hari ke depan, [nama bisnis] akan membagikan materi singkat supaya kamu makin paham [topik produk]. Mulai dari dasarnya dulu: [tulis materi pertama di sini]. Katalog lengkapnya ada di [link katalog].",
          },
          {
            delayMinutes: 1_440,
            text: "Materi hari ini untuk {name}: [tulis materi kedua di sini]. Intinya: [tulis satu kesimpulan praktis di sini]. Ada pertanyaan? Balas saja pesan ini.",
          },
          {
            delayMinutes: 2_880,
            text: "Lanjutan materi untuk {name}: [tulis materi ketiga di sini]. Banyak pelanggan kami memanfaatkannya untuk [manfaat utama] — semoga cocok juga untukmu.",
          },
          {
            delayMinutes: 2_880,
            text: "Materi penutup untuk {name}: [tulis rangkuman atau tawaran konsultasi di sini]. Kalau mau mulai, gunakan [kode promo] untuk pesanan pertamamu di [link katalog]. Terima kasih sudah mengikuti!",
          },
        ],
      },
      en: {
        defaultName: "Step-by-Step Product Education",
        keywords: ["learn", "education", "guide"],
        steps: [
          {
            delayMinutes: 0,
            text: "Hi {name}! Over the next few days, [business name] will share short lessons so you understand [product topic] better. Starting with the basics: [write the first lesson here]. The full catalog is at [catalog link].",
          },
          {
            delayMinutes: 1_440,
            text: "Today's lesson for you, {name}: [write the second lesson here]. The key takeaway: [write one practical takeaway here]. Any questions? Just reply to this message.",
          },
          {
            delayMinutes: 2_880,
            text: "The next lesson for you, {name}: [write the third lesson here]. Many of our customers use it for [main benefit] — we hope it suits you too.",
          },
          {
            delayMinutes: 2_880,
            text: "The closing lesson for you, {name}: [write a summary or a consultation offer here]. When you are ready to start, use [promo code] on your first order at [catalog link]. Thanks for following along!",
          },
        ],
      },
    },
  },
  {
    slug: "seri-materi-kreator",
    nameKey: "automations.tplKreatorName",
    descriptionKey: "automations.tplKreatorDesc",
    category: "followup",
    match: "contains",
    kind: "sequence",
    content: {
      id: {
        defaultName: "Seri Materi Kreator",
        keywords: ["kreator", "materi kreator", "kelas"],
        steps: [
          {
            delayMinutes: 0,
            text: "Hai {name}! Selamat datang di seri materi kreator dari [nama bisnis]. Episode pertama: [judul episode 1] — tonton di sini: [tautan episode 1].",
          },
          {
            delayMinutes: 1_440,
            text: "Episode 2 untuk {name}: [judul episode 2] — [tautan episode 2]. Sudah mencoba praktik dari episode pertama? Ceritakan hasilnya dengan membalas pesan ini ya.",
          },
          {
            delayMinutes: 2_880,
            text: "Episode 3 untuk {name}: [judul episode 3] — [tautan episode 3]. Episode ini membahas [satu hal yang paling ditunggu]. Selamat menonton!",
          },
          {
            delayMinutes: 2_880,
            text: "Episode penutup seri ini, {name}: [judul episode terakhir] — [tautan episode terakhir]. Terima kasih sudah mengikuti sampai akhir! Materi lain dari [nama bisnis] bisa kamu akses di [link katalog].",
          },
        ],
      },
      en: {
        defaultName: "Creator Content Series",
        keywords: ["creator", "creator series", "class"],
        steps: [
          {
            delayMinutes: 0,
            text: "Hi {name}! Welcome to the creator content series from [business name]. First episode: [episode 1 title] — watch it here: [episode 1 link].",
          },
          {
            delayMinutes: 1_440,
            text: "Episode 2 for you, {name}: [episode 2 title] — [episode 2 link]. Did you try the practice from the first episode? Tell us how it went by replying to this message.",
          },
          {
            delayMinutes: 2_880,
            text: "Episode 3 for you, {name}: [episode 3 title] — [episode 3 link]. This episode covers [the most anticipated topic]. Enjoy!",
          },
          {
            delayMinutes: 2_880,
            text: "The closing episode of this series, {name}: [final episode title] — [final episode link]. Thank you for following along to the end! More content from [business name] is available at [catalog link].",
          },
        ],
      },
    },
  },
  {
    slug: "reaktivasi-pelanggan-lama",
    nameKey: "automations.tplReaktivasiName",
    descriptionKey: "automations.tplReaktivasiDesc",
    category: "followup",
    match: "contains",
    kind: "sequence",
    content: {
      id: {
        defaultName: "Reaktivasi Pelanggan Lama",
        keywords: ["reaktivasi", "kembali", "pelanggan lama"],
        steps: [
          {
            delayMinutes: 0,
            text: "Halo {name}, sudah lama tidak berjumpa! Di [nama bisnis] sekarang ada [hal baru yang menarik]. Lihat-lihat dulu di sini: [link katalog] — siapa tahu ada yang cocok untukmu.",
          },
          {
            delayMinutes: 2_880,
            text: "Hai {name}! Khusus pelanggan lama seperti kamu, ada [kode promo] yang bisa dipakai sampai [tanggal berakhir]. Pakai di sini: [link katalog].",
          },
          {
            delayMinutes: 4_320,
            text: "Pesan terakhir dari kami, {name}: penawaran pelanggan lama berakhir pada [tanggal berakhir]. Kalau mau melewatkannya juga tidak apa-apa — kami tetap senang kamu pernah bersama [nama bisnis].",
          },
        ],
      },
      en: {
        defaultName: "Lapsed Customer Reactivation",
        keywords: ["comeback", "returning", "winback"],
        steps: [
          {
            delayMinutes: 0,
            text: "Hi {name}, it has been a while! At [business name] we now have [something new and exciting]. Take a look here: [catalog link] — something might be just right for you.",
          },
          {
            delayMinutes: 2_880,
            text: "Hi {name}! Especially for returning customers like you, there is [promo code] valid until [expiry date]. Use it here: [catalog link].",
          },
          {
            delayMinutes: 4_320,
            text: "Our last message, {name}: the returning-customer offer ends on [expiry date]. If you would rather skip it, that is completely fine — we are still glad you were with [business name].",
          },
        ],
      },
    },
  },
];

/** Template menurut slug stabilnya; null bila tidak dikenal. */
export function findAutomationTemplate(
  slug: string,
): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES.find((tpl) => tpl.slug === slug) ?? null;
}

// ---------------------------------------------------------------------------
// Pratinjau linimasa + heuristik jendela WhatsApp (G2)
// ---------------------------------------------------------------------------

/**
 * Jendela pesan bebas WhatsApp dalam menit (24 jam) — cerminan
 * `MESSAGING_WINDOW_MS` di `packages/core/src/messaging-window.ts`
 * (Fase 16C). Kontrak tidak mengimpor core, jadi konstanta ini dijaga
 * tetap sama nilainya dengan di sana; ubah keduanya bersama-sama.
 */
export const WA_FREE_WINDOW_MINUTES = 24 * 60;

export interface AutomationSequenceTimelineStep {
  /** Posisi langkah, mulai dari 1. */
  position: number;
  /** Jeda langkah ini relatif terhadap langkah sebelumnya (menit). */
  delayMinutes: number;
  /** Jeda kumulatif sejak pendaftaran (menit). */
  cumulativeMinutes: number;
  /** Hari kumulatif: Math.floor(cumulativeMinutes / 1440) — "Hari N". */
  dayOffset: number;
  text: string;
  /**
   * HEURISTIK RISIKO jendela WhatsApp — BUKAN kepastian. Sequence
   * tidak terikat kanal: langkah terkirim ke percakapan hasil
   * pendaftaran, dan jendela 24 jam WhatsApp berjangkar pada pesan
   * MASUK terakhir kontak di percakapan itu (yang bisa terjadi kapan
   * saja sesudah pendaftaran, termasuk sesudah langkah awal terkirim).
   * Yang bisa dikatakan templat hanyalah: langkah yang jatuh lebih
   * dari 24 jam sesudah pendaftaran BERISIKO berada di luar jendela
   * bebas bila kontak tidak menulis lagi — pada WhatsApp langkah
   * seperti itu gagal/dilewati kecuali diganti template WA. Langkah
   * pertama (dan yang ≤ 24 jam) tidak ditandai: pendaftaran sendiri
   * dipicu pesan masuk, jadi jendelanya terbuka saat rangkaian mulai.
   */
  exceedsWaWindow: boolean;
}

/**
 * Turunkan linimasa pratinjau dari langkah-langkah sequence: murni,
 * deterministik, tanpa migrasi — hari kumulatif adalah penjumlahan
 * `delayMinutes` (1.440 menit = 1 hari). Dipakai galeri web untuk
 * pratinjau sebelum memakai, dan diuji langsung sebagai invarian.
 */
export function buildSequenceTimeline(
  steps: { delayMinutes: number; text: string }[],
): AutomationSequenceTimelineStep[] {
  let cumulative = 0;
  return steps.map((step, i) => {
    cumulative += step.delayMinutes;
    return {
      position: i + 1,
      delayMinutes: step.delayMinutes,
      cumulativeMinutes: cumulative,
      dayOffset: Math.floor(cumulative / WA_FREE_WINDOW_MINUTES),
      text: step.text,
      exceedsWaWindow: cumulative > WA_FREE_WINDOW_MINUTES,
    };
  });
}

// ---------------------------------------------------------------------------
// Ringkasan katalog untuk API daftar
// ---------------------------------------------------------------------------

export const AutomationTemplateSummarySchema = z.object({
  slug: z.string(),
  nameKey: z.string(),
  descriptionKey: z.string(),
  category: AutomationTemplateCategorySchema,
  kind: AutomationTemplateKindSchema,
  keywordCount: z.number().int().positive(),
  /** 0 untuk kind='keyword'. */
  stepCount: z.number().int().nonnegative(),
  /**
   * Langkah sequence pada locale yang diminta (untuk pratinjau
   * linimasa galeri sebelum memakai); [] untuk kind='keyword'.
   */
  steps: z.array(
    z.object({
      delayMinutes: z.number().int().nonnegative(),
      text: z.string(),
    }),
  ),
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

/**
 * Ringkasan satu template (dipakai rute daftar). Isi sequence diambil
 * dari `locale` yang diminta (bawaan "id") — jumlah kata kunci &
 * langkah antar-locale dijaga sama oleh test katalog, teks langkah
 * pada ringkasan adalah teks locale itu untuk pratinjau.
 */
export function summarizeAutomationTemplate(
  tpl: AutomationTemplateDefinition,
  locale: AutomationTemplateLocale = "id",
): AutomationTemplateSummary {
  if (tpl.kind === "sequence") {
    const content = resolveAutomationSequenceContent(tpl, locale);
    return {
      slug: tpl.slug,
      nameKey: tpl.nameKey,
      descriptionKey: tpl.descriptionKey,
      category: tpl.category,
      kind: tpl.kind,
      keywordCount: content.keywords.length,
      stepCount: content.steps.length,
      steps: content.steps.map((s) => ({
        delayMinutes: s.delayMinutes,
        text: s.text,
      })),
    };
  }
  return {
    slug: tpl.slug,
    nameKey: tpl.nameKey,
    descriptionKey: tpl.descriptionKey,
    category: tpl.category,
    kind: tpl.kind,
    keywordCount: tpl.keywords.length,
    stepCount: 0,
    steps: [],
  };
}

export const InstantiateAutomationTemplateRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  /**
   * Locale isi sequence yang dipakai (nama bawaan, kata kunci,
   * langkah). Bawaan "id" — klien web mengirim locale UI pemilik.
   */
  locale: AutomationTemplateLocaleSchema.optional(),
});
export type InstantiateAutomationTemplateRequest = z.infer<
  typeof InstantiateAutomationTemplateRequestSchema
>;

// ---------------------------------------------------------------------------
// Templat sequence PRIBADI tenant (G2) — POLA BERSAMA "SIMPAN TEMPLAT
// PRIBADI" dari agents.ts (langkah 1 dari 5: skema di modul kontrak
// domain ini). Tabelnya SENDIRI (`sequence_templates`), bukan tabel
// bersama dengan templat agen — yang dibagi hanya polanya.
// Penunjuk pola juga ada di header berkas ini.
// ---------------------------------------------------------------------------

const SequenceTemplateNameSchema = z.string().trim().min(1).max(255);
const SequenceTemplateKeywordsSchema = z
  .array(z.string().trim().min(1).max(255))
  .min(1)
  .max(10);

/**
 * Simpan sequence dari formulir sebagai templat pribadi: salinan persis
 * keadaan formulir saat disimpan (nama templat bebas dari pemilik;
 * kata kunci + mode cocok + langkah adalah isi sequence-nya). Langkah
 * memakai skema langkah automation yang sama persis — termasuk batas
 * jeda & panjang teks — supaya templat yang tersimpan selalu bisa
 * di-instantiate menjadi automation yang sah. Penanda "[...]" yang
 * belum diganti BUKAN kesalahan: skema sengaja tidak menolaknya
 * (peringatan non-blokir adalah urusan UI).
 */
export const CreateSequenceTemplateRequestSchema = z.object({
  name: SequenceTemplateNameSchema,
  keywords: SequenceTemplateKeywordsSchema,
  match: z.enum(["exact", "contains"]).default("exact"),
  steps: z.array(AutomationStepInputSchema).min(1).max(10),
});
export type CreateSequenceTemplateRequest = z.infer<
  typeof CreateSequenceTemplateRequestSchema
>;

export const SequenceTemplateResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  keywords: z.array(z.string()),
  match: z.enum(["exact", "contains"]),
  steps: z.array(AutomationStepResponseSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SequenceTemplateResponse = z.infer<
  typeof SequenceTemplateResponseSchema
>;

export const SequenceTemplateListResponseSchema = z.object({
  templates: z.array(SequenceTemplateResponseSchema),
});
export type SequenceTemplateListResponse = z.infer<
  typeof SequenceTemplateListResponseSchema
>;

/** Pakai templat pribadi: nama automation boleh ditimpa klien. */
export const InstantiateSequenceTemplateRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
});
export type InstantiateSequenceTemplateRequest = z.infer<
  typeof InstantiateSequenceTemplateRequestSchema
>;
