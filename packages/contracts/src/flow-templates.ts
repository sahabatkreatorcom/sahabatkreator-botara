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
 * diaktifkan. Nilai yang dikenal:
 * - "product" — node `send_payment_link` pada template sengaja membawa
 *   `productId` KOSONG (placeholder): aktivasi menolaknya dengan issue
 *   PAYMENT_PRODUCT_ID_REQUIRED yang menunjuk node itu sampai pemilik
 *   memilih produk aslinya di builder. Juga dipakai template katalog
 *   (`show_catalog` hanya bisa menampilkan produk AKTIF — tanpa produk
 *   daftarnya kosong), meski di sana tidak ada node yang diblokir.
 * - "service" — node `book_appointment` membawa `serviceId` KOSONG:
 *   aktivasi menolaknya dengan APPOINTMENT_SERVICE_INVALID sampai
 *   pemilik memilih layanan janji temu aslinya.
 */
export const FlowTemplateCategorySchema = z.enum([
  "onboarding",
  "sales",
  "support",
  "event",
  "lead",
]);
export type FlowTemplateCategory = z.infer<typeof FlowTemplateCategorySchema>;

export const FlowTemplateNeedSchema = z.enum(["product", "service"]);
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
  {
    // Fase 16B — kuesioner penangkap lead (node `questionnaire`).
    // Target pertanyaan SENGAJA hanya field bawaan (name/email/phone):
    // target `custom:<kunci>` akan ditolak aktivasi dengan
    // QUESTIONNAIRE_TARGET_UNKNOWN selama belum ada satu pun kontak
    // workspace yang membawa kunci itu — template harus bisa langsung
    // diaktifkan tanpa persiapan tersembunyi.
    slug: "kuesioner-lead",
    nameKey: "flows.tplKuesionerName",
    descriptionKey: "flows.tplKuesionerDesc",
    category: "lead",
    needs: [],
    defaultName: "Kuesioner Lead",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["daftar", "minat", "info"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "pembuka",
          type: "send_message",
          config: {
            text: "Halo {name}! Sebelum saya kirim detailnya, boleh saya kenal sedikit dulu? Cukup jawab tiga pertanyaan singkat ya.",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "kuesioner",
          type: "questionnaire",
          config: {
            questions: [
              {
                id: "nama",
                prompt: "Siapa nama lengkap kamu?",
                answerType: "text",
                target: "name",
                required: true,
              },
              {
                id: "email",
                prompt: "Alamat email yang bisa kami hubungi?",
                answerType: "email",
                target: "email",
                required: true,
              },
              {
                id: "wa",
                prompt: "Nomor WhatsApp aktif kamu? (contoh: 08123456789)",
                answerType: "phone",
                target: "phone",
                required: false,
              },
            ],
            amount: 6,
            unit: "hours",
            maxInvalidAttempts: 3,
            completionTag: "lead-lengkap",
          },
          position: { x: 580, y: 0 },
        },
        {
          id: "terima",
          type: "send_message",
          config: {
            text: "Terima kasih, {name}! Datanya sudah kami terima. Tim kami akan menghubungi kamu dalam 1×24 jam.",
          },
          position: { x: 870, y: 0 },
        },
        {
          id: "eskalasi",
          type: "handoff",
          config: {},
          position: { x: 870, y: 200 },
        },
        {
          id: "ingat",
          type: "send_message",
          config: {
            text: "Halo {name}, formulirnya masih terbuka kalau kamu mau lanjut kapan saja — cukup balas pesan ini.",
          },
          position: { x: 870, y: -200 },
        },
        { id: "end", type: "end", config: {}, position: { x: 1160, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "pembuka" },
        { from: "pembuka", to: "kuesioner" },
        { from: "kuesioner", to: "terima", branch: "completed" },
        { from: "terima", to: "end" },
        { from: "kuesioner", to: "eskalasi", branch: "invalid" },
        { from: "eskalasi", to: "end" },
        { from: "kuesioner", to: "ingat", branch: "timeout" },
        { from: "ingat", to: "end" },
      ],
    },
  },
  {
    // Fase 16B — katalog belanja + checkout keranjang (13F).
    // `needs: ["product"]`: show_catalog hanya menampilkan produk AKTIF,
    // jadi tanpa produk daftarnya kosong (tidak ada node yang diblokir
    // aktivasi — berbeda dari send_payment_link yang butuh productId).
    slug: "katalog-keranjang",
    nameKey: "flows.tplKatalogName",
    descriptionKey: "flows.tplKatalogDesc",
    category: "sales",
    needs: ["product"],
    defaultName: "Katalog + Keranjang",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["katalog", "produk", "beli"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "katalog",
          type: "show_catalog",
          config: {
            introText: "Ini daftar produk kami, {name}. Balas nomornya untuk menambah ke keranjang.",
            showDescription: true,
            amount: 12,
            unit: "hours",
            maxInvalidAttempts: 3,
            addedMessage: "Sudah masuk keranjang. Mau tambah lagi atau langsung checkout?",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "checkout",
          type: "cart_checkout",
          config: {
            emptyMessage: "Keranjangmu masih kosong. Balas KATALOG kalau mau pilih produk dulu.",
          },
          position: { x: 580, y: 0 },
        },
        {
          id: "kosong",
          type: "send_message",
          config: {
            text: "Keranjangmu masih kosong, {name}. Balas KATALOG kalau mau lihat pilihannya lagi.",
          },
          position: { x: 870, y: 200 },
        },
        {
          id: "eskalasi",
          type: "handoff",
          config: {},
          position: { x: 580, y: -200 },
        },
        { id: "end", type: "end", config: {}, position: { x: 1160, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "katalog" },
        { from: "katalog", to: "checkout", branch: "added" },
        { from: "checkout", to: "end", branch: "checked_out" },
        { from: "checkout", to: "kosong", branch: "empty_cart" },
        { from: "kosong", to: "end" },
        { from: "katalog", to: "eskalasi", branch: "invalid" },
        { from: "eskalasi", to: "end" },
        { from: "katalog", to: "end", branch: "timeout" },
      ],
    },
  },
  {
    // Fase 16B — pemesanan janji temu (13G). `serviceId` placeholder
    // kosong: aktivasi menolaknya (APPOINTMENT_SERVICE_INVALID) sampai
    // pemilik memilih layanan aslinya — pola yang sama dengan
    // send_payment_link, jadi template ini ditandai `needs: ["service"]`.
    slug: "booking-janji-temu",
    nameKey: "flows.tplBookingName",
    descriptionKey: "flows.tplBookingDesc",
    category: "event",
    needs: ["service"],
    defaultName: "Booking Janji Temu",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["jadwal", "booking", "janji"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "pembuka",
          type: "send_message",
          config: {
            text: "Siap, {name}! Berikut slot yang masih kosong. Balas nomornya untuk memesan ya.",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "jadwal",
          type: "book_appointment",
          // Placeholder SENGAJA kosong (lihat `needs`).
          config: {
            serviceId: "",
            daysAhead: 7,
            slotsPerMessage: 5,
            amount: 2,
            unit: "hours",
            maxInvalidAttempts: 3,
            bookedMessage: "Janji temumu sudah tercatat. Sampai jumpa!",
          },
          position: { x: 580, y: 0 },
        },
        {
          id: "konfirmasi",
          type: "send_message",
          config: {
            text: "Terima kasih, {name}! Kami akan mengirimkan pengingat menjelang jadwalnya.",
          },
          position: { x: 870, y: 0 },
        },
        {
          id: "eskalasi",
          type: "handoff",
          config: {},
          position: { x: 870, y: -200 },
        },
        { id: "end", type: "end", config: {}, position: { x: 1160, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "pembuka" },
        { from: "pembuka", to: "jadwal" },
        { from: "jadwal", to: "konfirmasi", branch: "booked" },
        { from: "konfirmasi", to: "end" },
        { from: "jadwal", to: "eskalasi", branch: "invalid" },
        { from: "eskalasi", to: "end" },
        { from: "jadwal", to: "end", branch: "timeout" },
        { from: "jadwal", to: "end", branch: "slot_taken" },
      ],
    },
  },
  {
    // Fase 16B — uji A/B mode EKSPERIMEN (13D): penugasan deterministik
    // per kontak, dan `conversionNodeId` menunjuk node tawaran sehingga
    // dashboard eksperimen flow bisa membandingkan kedua varian.
    slug: "uji-ab-pembuka",
    nameKey: "flows.tplAbSplitName",
    descriptionKey: "flows.tplAbSplitDesc",
    category: "sales",
    needs: [],
    defaultName: "Uji A/B Pesan Pembuka",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: { kind: "any_message" },
          position: { x: 0, y: 0 },
        },
        {
          id: "split",
          type: "ab_split",
          config: {
            percentA: 50,
            experiment: true,
            experimentLabel: "Pembuka A vs B",
            conversionNodeId: "tawaran",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "varianA",
          type: "send_message",
          config: {
            text: "Halo {name}! Lagi cari rekomendasi produk? Saya bantu pilihkan yang paling cocok.",
          },
          position: { x: 580, y: -160 },
        },
        {
          id: "varianB",
          type: "send_message",
          config: {
            text: "Hai {name}, selamat datang! Mau saya kirimkan katalog, atau mau tanya-tanya dulu?",
          },
          position: { x: 580, y: 160 },
        },
        {
          id: "tawaran",
          type: "send_message",
          config: {
            text: "Kalau mau, balas KATALOG dan saya kirimkan pilihan yang paling sesuai kebutuhanmu.",
          },
          position: { x: 870, y: 0 },
        },
        { id: "end", type: "end", config: {}, position: { x: 1160, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "split" },
        { from: "split", to: "varianA", branch: "a" },
        { from: "split", to: "varianB", branch: "b" },
        { from: "varianA", to: "tawaran" },
        { from: "varianB", to: "tawaran" },
        { from: "tawaran", to: "end" },
      ],
    },
  },
  {
    // Fase 16B — konfirmasi transfer: wait_reply + tag + serah ke admin.
    slug: "konfirmasi-transfer",
    nameKey: "flows.tplTransferName",
    descriptionKey: "flows.tplTransferDesc",
    category: "support",
    needs: [],
    defaultName: "Konfirmasi Transfer",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["sudah bayar", "sudah transfer", "bukti transfer"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "minta",
          type: "send_message",
          config: {
            text: "Terima kasih, {name}! Mohon kirimkan foto atau screenshot bukti transfernya di sini ya, supaya bisa kami verifikasi.",
          },
          position: { x: 290, y: 0 },
        },
        {
          id: "tunggu",
          type: "wait_reply",
          config: { amount: 12, unit: "hours" },
          position: { x: 580, y: 0 },
        },
        {
          id: "tandai",
          type: "add_tag",
          config: { tag: "perlu-verifikasi" },
          position: { x: 870, y: 0 },
        },
        {
          id: "serah",
          type: "handoff",
          config: {},
          position: { x: 1160, y: 0 },
        },
        {
          id: "ingat",
          type: "send_message",
          config: {
            text: "Halo {name}, kami belum menerima bukti transfernya. Kalau sudah sempat, kirim di sini ya.",
          },
          position: { x: 870, y: 200 },
        },
        { id: "end", type: "end", config: {}, position: { x: 1450, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "minta" },
        { from: "minta", to: "tunggu" },
        { from: "tunggu", to: "tandai", branch: "replied" },
        { from: "tandai", to: "serah" },
        { from: "serah", to: "end" },
        { from: "tunggu", to: "ingat", branch: "timeout" },
        { from: "ingat", to: "end" },
      ],
    },
  },
  {
    // Fase 16B — tindak lanjut promo bercabang menurut tag pelanggan.
    slug: "tindak-lanjut-pelanggan",
    nameKey: "flows.tplTindakLanjutName",
    descriptionKey: "flows.tplTindakLanjutDesc",
    category: "sales",
    needs: [],
    defaultName: "Tindak Lanjut Promo",
    graph: {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          config: {
            kind: "keyword",
            keywords: ["promo", "diskon"],
            match: "contains",
          },
          position: { x: 0, y: 0 },
        },
        {
          id: "cek",
          type: "condition",
          config: { predicate: "has_tag", tag: "pelanggan-lama" },
          position: { x: 290, y: 0 },
        },
        {
          id: "loyal",
          type: "send_message",
          config: {
            text: "Khusus kamu, {name}: ada potongan tambahan untuk pelanggan lama. Mau saya kirimkan detailnya?",
          },
          position: { x: 580, y: -160 },
        },
        {
          id: "umum",
          type: "send_message",
          config: {
            text: "Ada promo yang sedang berjalan, {name}! Saya kirimkan ringkasannya sebentar lagi ya.",
          },
          position: { x: 580, y: 160 },
        },
        {
          id: "jeda",
          type: "delay",
          config: { amount: 2, unit: "hours" },
          position: { x: 870, y: 160 },
        },
        {
          id: "ringkas",
          type: "send_message",
          config: {
            text: "Ini ringkasan promonya, {name}. Balas PROMO kalau mau saya bantu pilih yang paling pas.",
          },
          position: { x: 1160, y: 160 },
        },
        { id: "end", type: "end", config: {}, position: { x: 1450, y: 0 } },
      ],
      edges: [
        { from: "trigger", to: "cek" },
        { from: "cek", to: "loyal", branch: "yes" },
        { from: "loyal", to: "end" },
        { from: "cek", to: "umum", branch: "no" },
        { from: "umum", to: "jeda" },
        { from: "jeda", to: "ringkas" },
        { from: "ringkas", to: "end" },
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
