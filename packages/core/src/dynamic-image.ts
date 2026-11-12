import { deflateSync } from "node:zlib";

/**
 * GAMBAR DINAMIS (G17 butir 4) — kartu PNG berisi teks dari konteks
 * run (kartu ucapan/kupon), dirender SEPENUHNYA dengan kemampuan
 * bawaan Node: encoder PNG ditulis tangan (zlib bawaan + CRC32) dan
 * font bitmap 5x7 tertanam. TIDAK ada dependensi raster baru.
 *
 * BATAS JUJUR (dinyatakan juga di UI builder + OWNER-ACTIONS):
 * - Huruf: ASCII tercetak + huruf Latin dasar tertentu saja; karakter
 *   lain dirender sebagai '?' — tidak ada emoji/warna kulit/aksara
 *   kompleks, tidak ada bold/italic (satu ketebalan goresan).
 * - Tata letak tetap: judul besar di atas, baris-baris isi di bawah,
 *   latar polos + garis aksen; tanpa gambar latar/logo dinamis.
 * - Ukuran tetap 1200x630 (rasio kartu tautan) agar konsisten.
 */

// ---- CRC32 (tabel standar PNG) ---------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// ---- Font bitmap 5x7 ---------------------------------------------------
// Setiap glyph: 7 baris string 5 char ('#' = piksel menyala).
const FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", ".#.#.", "..#..", "..#..", "..#..", ".#.#.", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#..##", "#.#.#", "##..#", "#...#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", "..#..", "..#..", "..#.."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  ";": [".....", ".##..", ".##..", ".....", ".##..", ".##..", ".#..."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "_": [".....", ".....", ".....", ".....", ".....", ".....", "#####"],
  "+": [".....", "..#..", "..#..", ".###.", "..#..", "..#..", "....."],
  "=": [".....", ".....", "#####", ".....", "#####", ".....", "....."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  "\\": ["#....", "#....", ".#...", "..#..", "...#.", "....#", "....#"],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "[": ["..##.", "..#..", "..#..", "..#..", "..#..", "..#..", "..##."],
  "]": [".##..", "..#..", "..#..", "..#..", "..#..", "..#..", ".##.."],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  '"': [".#.#.", ".#.#.", ".#.#.", ".....", ".....", ".....", "....."],
  "@": [".###.", "#...#", "#.###", "#.#.#", "#.##.", "#....", ".###."],
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
  "%": ["##..#", "##.#.", "....#", "...#.", "..#..", ".#...", "#..##"],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
  "*": [".....", ".#.#.", "..#..", "#####", "..#..", ".#.#.", "....."],
  "<": ["...#.", "..#..", ".#...", "#....", ".#...", "..#..", "...#."],
  ">": [".#...", "..#..", "...#.", "....#", "...#.", "..#..", ".#..."],
  "|": ["..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "~": [".....", ".....", ".##.#", "#..##", ".....", ".....", "....."],
  "°": [".##..", "#..#.", ".##..", ".....", ".....", ".....", "....."],
  "…": [".....", ".....", ".....", ".....", ".....", "#.#.#", "....."],
};

const FALLBACK_GLYPH = FONT["?"];

/**
 * Normalisasi satu karakter ke glyph yang tersedia: huruf kecil
 * memakai glyph huruf besar (font ini satu rupa), diakritik Latin
 * dilucuti (é→e), sisanya '?'.
 */
function glyphFor(ch: string): string[] {
  if (FONT[ch]) return FONT[ch];
  const lower = ch.toLowerCase();
  const upper = lower.toUpperCase();
  if (FONT[upper]) return FONT[upper];
  const stripped = lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const sUpper = stripped.toUpperCase();
  if (stripped.length === 1 && FONT[sUpper]) return FONT[sUpper];
  return FALLBACK_GLYPH;
}

type Rgb = [number, number, number];

function parseHexColor(value: string | undefined, fallback: Rgb): Rgb {
  if (!value) return fallback;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Bungkus kata sederhana pada batas kolom karakter. */
function wrapLine(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > maxChars) {
      if (current) out.push(current);
      for (let i = 0; i < word.length; i += maxChars) {
        out.push(word.slice(i, i + maxChars));
      }
      current = "";
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars) {
      out.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [""];
}

export interface DynamicCardSpec {
  title: string;
  lines: string[];
  /** #RRGGBB; bawaan ungu tua Botara. */
  backgroundColor?: string;
  /** #RRGGBB garis aksen + warna judul; bawaan emas lembut. */
  accentColor?: string;
  width?: number;
  height?: number;
}

export const DYNAMIC_CARD_WIDTH = 1200;
export const DYNAMIC_CARD_HEIGHT = 630;

/**
 * Render kartu teks menjadi buffer PNG RGB. Murni & deterministik —
 * aman dipanggil dari langkah flow mana pun (executor menjalankannya
 * di luar transaksi langkah, seperti node eksternal lain).
 */
export function renderDynamicCardPng(spec: DynamicCardSpec): Buffer {
  const width = spec.width ?? DYNAMIC_CARD_WIDTH;
  const height = spec.height ?? DYNAMIC_CARD_HEIGHT;
  const bg = parseHexColor(spec.backgroundColor, [38, 30, 66]);
  const accent = parseHexColor(spec.accentColor, [245, 197, 66]);
  const fg: Rgb = [245, 243, 238];

  const px = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = bg[0];
    px[i * 3 + 1] = bg[1];
    px[i * 3 + 2] = bg[2];
  }
  const setPx = (x: number, y: number, color: Rgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 3;
    px[o] = color[0];
    px[o + 1] = color[1];
    px[o + 2] = color[2];
  };
  const fillRect = (x: number, y: number, w: number, h: number, color: Rgb) => {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) setPx(xx, yy, color);
    }
  };
  // Garis aksen atas + bawah.
  fillRect(0, 0, width, 10, accent);
  fillRect(0, height - 10, width, 10, accent);

  const drawText = (
    text: string,
    startX: number,
    startY: number,
    scale: number,
    color: Rgb,
  ): number => {
    // Lebar satu glyph termasuk jarak antar huruf.
    const advance = 6 * scale;
    let cx = startX;
    let cy = startY;
    for (const ch of text) {
      if (ch === "\n") {
        cx = startX;
        cy += 9 * scale;
        continue;
      }
      const glyph = glyphFor(ch);
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === "#") {
            fillRect(cx + col * scale, cy + row * scale, scale, scale, color);
          }
        }
      }
      cx += advance;
    }
    return cy + 7 * scale;
  };

  const MARGIN = 72;
  const maxCharsTitle = Math.floor((width - MARGIN * 2) / (6 * 9));
  const titleLines = wrapLine(spec.title || " ", maxCharsTitle).slice(0, 2);
  let y = 84;
  for (const line of titleLines) {
    y = drawText(line, MARGIN, y, 9, accent) + 30;
  }
  // Garis pemisah.
  fillRect(MARGIN, y, 180, 6, accent);
  y += 44;
  const maxCharsBody = Math.floor((width - MARGIN * 2) / (6 * 6));
  const bodyLines: string[] = [];
  for (const raw of spec.lines) {
    for (const wrapped of wrapLine(raw, maxCharsBody)) bodyLines.push(wrapped);
  }
  for (const line of bodyLines.slice(0, 6)) {
    y = drawText(line, MARGIN, y, 6, fg) + 26;
    if (y > height - 80) break;
  }

  // Encode PNG: filter 0 per baris + deflate.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) {
    const outOff = row * (width * 3 + 1);
    raw[outOff] = 0;
    raw.set(px.subarray(row * width * 3, (row + 1) * width * 3), outOff + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}
