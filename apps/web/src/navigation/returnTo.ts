/**
 * Tujuan-kembali setelah login (Fase 6E).
 *
 * Bila pengguna membuka deep-link shell (mis. /inbox/:conversationId)
 * dalam keadaan belum login, Shell menyimpan path itu di sini sebelum
 * mengalihkan ke /login; LoginPage mengambilnya — sekali pakai — setelah
 * masuk berhasil, sehingga pengguna mendarat di tujuan awalnya, bukan
 * selalu di Dashboard.
 *
 * sessionStorage dipilih dengan sengaja: bertahan melewati navigasi di
 * tab yang sama (termasuk muat ulang halaman login), hilang saat tab
 * ditutup, dan tidak bocor ke tab lain.
 */
const RETURN_TO_KEY = "sk-return-to";

export function saveReturnTo(path: string): void {
  try {
    sessionStorage.setItem(RETURN_TO_KEY, path);
  } catch {
    /* penyimpanan tidak tersedia — kembali ke perilaku lama (Dashboard) */
  }
}

/** Ambil & hapus tujuan tersimpan. Hanya path shell internal yang sah. */
export function takeReturnTo(): string | null {
  try {
    const value = sessionStorage.getItem(RETURN_TO_KEY);
    if (value) sessionStorage.removeItem(RETURN_TO_KEY);
    if (
      value &&
      value.startsWith("/") &&
      !value.startsWith("/login") &&
      !value.startsWith("/register") &&
      !value.startsWith("/pay/") &&
      value !== "/webchat-demo"
    ) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}
