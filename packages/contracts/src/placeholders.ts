// ---------------------------------------------------------------------------
// Penanda kurung siku pada teks templat — modul NETRAL lintas domain
// ---------------------------------------------------------------------------

/**
 * `extractInstructionPlaceholders` — daftar penanda kurung siku yang
 * belum diganti di dalam teks templat, mis. "[nama bisnis]".
 * Mengembalikan ISI penanda (tanpa kurung), terdedup, urut kemunculan
 * pertama.
 *
 * Fungsi ini lahir di `agent-templates.ts` untuk peringatan non-blokir
 * formulir agent, lalu DIPROMOSIKAN ke modul netral ini (ekstraksi G1)
 * karena konvensi penandanya dipakai teks templat lintas domain —
 * instruction agent, draf langkah automation/sequence, teks flow:
 * fakta bisnis ditulis sebagai penanda yang jelas agar pemilik tahu
 * persis apa yang harus diganti sebelum teks dikirim ke pelanggan.
 * `agent-templates.ts` me-re-export fungsi ini agar impor lama tetap
 * bekerja apa adanya; kode baru mengimpor dari modul ini.
 *
 * Sifatnya murni informatif: peringatan penanda TIDAK PERNAH
 * menggagalkan simpan di UI maupun API (keputusan pemilik 2026-11-12),
 * jadi fungsi ini tidak punya padanan validasi penolak di mana pun.
 */
export function extractInstructionPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const match of text.matchAll(/\[([^[\]\n]{1,80})\]/g)) {
    const value = (match[1] ?? "").trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      found.push(value);
    }
  }
  return found;
}
