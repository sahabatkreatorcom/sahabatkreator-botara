/**
 * Render teks pesan keluar (Fase 9A) — SATU helper bersama untuk semua
 * jalur pengiriman otomatis: balasan automation keyword, langkah
 * sequence, node flow `send_message`, dan dispatch broadcast. Sebelum
 * fase ini substitusi `{name}` tersebar sebagai `replaceAll` di empat
 * titik; sekarang semuanya lewat sini agar semantiknya tidak menyimpang.
 *
 * Dua fitur, urutan tetap:
 * 1. `{name}` → nama kontak penerima (kosong bila tak dikenal). Sengaja
 *    diganti DULU: pilihan spintax yang memuat {name} (mis.
 *    "{Halo {name}|Hai {name}}") tetap dikenali sebagai grup sesudah
 *    substitusi, karena kurung di dalam pilihan sudah hilang.
 * 2. Spintax: grup `{pilihan1|pilihan2|...}` diganti SATU pilihan yang
 *    dipilih acak per render. Beberapa grup per teks boleh. TANPA
 *    nesting — grup yang memuat kurung di dalamnya tidak dikenali dan
 *    dibiarkan apa adanya. Grup dengan satu pilihan (tanpa `|`) dan
 *    kurung tak berpasangan juga dibiarkan apa adanya: render TIDAK
 *    PERNAH gagal gara-gara spintax.
 *
 * Balasan manual dari dashboard TIDAK melewati helper ini (teks agen
 * adalah teks harfiah — mengacak kata-kata manusia tanpa diminta akan
 * mengejutkan); yang memakai helper ini hanya teks templat otomatis.
 *
 * `rng` bisa disuntik untuk uji deterministik; default Math.random.
 */
export function renderMessageText(
  text: string,
  vars?: { name?: string | null },
  rng: () => number = Math.random,
): string {
  const withName = text.replaceAll("{name}", vars?.name ?? "");
  return withName.replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
    if (!inner.includes("|")) return whole;
    const choices = inner.split("|");
    const idx = Math.min(
      choices.length - 1,
      Math.max(0, Math.floor(rng() * choices.length)),
    );
    return choices[idx];
  });
}
