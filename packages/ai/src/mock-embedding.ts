import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "./types";

/**
 * MockEmbeddingProvider — provider embedding deterministik untuk
 * dev/test/rantai (Fase 12D). Ini BUKAN model embedding sungguhan dan
 * tidak berpura-pura jadi: vektor dibangun dari token teks dengan dua
 * aturan sederhana yang terdokumentasi —
 *
 * 1. PETA KONSEP kecil: token yang termasuk kelompok sinonim dwibahasa
 *    di bawah dipetakan ke token konsep kanonisnya (harga/biaya/tarif →
 *    "price", kelas/kursus/pelatihan → "course", …). Inilah yang
 *    membuat parafrase TANPA kata yang sama persis tetap dekat secara
 *    kosinus — cukup untuk MEMBUKTIKAN perilaku retrieval hibrida
 *    (fusi peringkat, fallback, isolasi) di rantai tanpa jaringan.
 *    Token di luar peta memakai dirinya sendiri (sinyal kata persis).
 * 2. HASHING: setiap token konsep di-hash (FNV-1a) ke satu indeks utama
 *    (bobot 1) + satu indeks sekunder (bobot 0,5) dalam ruang 1536
 *    dimensi, lalu vektor dinormalisasi L2. Deterministik murni:
 *    teks yang sama selalu menghasilkan vektor yang sama, di proses
 *    mana pun, tanpa jam/RNG/jaringan.
 *
 * Usage token adalah estimasi deterministik (panjang karakter / 4)
 * seperti MockProvider chat; biaya TIDAK dilaporkan (undefined) —
 * dasbor menampilkannya sebagai "tidak dilaporkan", bukan nol karangan.
 */

export const MOCK_EMBEDDING_MODEL = "mock-embedding-1";

const CONCEPT_GROUPS: Record<string, readonly string[]> = {
  price: [
    "harga", "biaya", "tarif", "price", "cost", "fee",
    "bayar", "pembayaran", "payment", "cicilan", "dicicil", "angsuran",
  ],
  course: [
    "kelas", "kursus", "pelatihan", "course", "class", "training",
    "belajar", "materi", "modul",
  ],
  schedule: ["jadwal", "schedule", "kapan", "tanggal", "sesi"],
  access: ["akses", "access", "login", "akun"],
  guarantee: ["garansi", "guarantee", "refund", "jaminan", "pengembalian"],
  discount: ["diskon", "discount", "promo", "potongan", "voucher"],
  duration: ["durasi", "duration", "menit", "minggu"],
};

const TOKEN_TO_CONCEPT = new Map<string, string>();
for (const [concept, tokens] of Object.entries(CONCEPT_GROUPS)) {
  for (const token of tokens) TOKEN_TO_CONCEPT.set(token, concept);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** FNV-1a 32-bit — hash string kecil, stabil lintas platform. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function embedOne(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    const concept = TOKEN_TO_CONCEPT.get(token) ?? token;
    vector[fnv1a(concept) % EMBEDDING_DIMENSIONS] += 1;
    vector[fnv1a(`${concept}#b`) % EMBEDDING_DIMENSIONS] += 0.5;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  }
  return vector;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = MOCK_EMBEDDING_MODEL;

  async embed(texts: string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map(embedOne),
      usage: {
        tokensIn: texts.reduce((sum, t) => sum + estimateTokens(t), 0),
      },
      model: this.model,
      provider: this.name,
    };
  }
}
