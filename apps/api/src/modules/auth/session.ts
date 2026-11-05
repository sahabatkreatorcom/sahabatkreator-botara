import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { users, type User } from "@sahabat-kreator/db";
import { syncAppUser, type AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";

/**
 * Middleware sesi: membaca sesi Better Auth dari cookie request.
 * - Tanpa sesi valid → 401 UNAUTHORIZED (format kontrak).
 * - Dengan sesi → menyelesaikan baris `users` kita (lazy sync bila hook
 *   sign-up terlewat) dan menyimpannya di konteks sebagai `appUser`.
 *
 * IDEMPOTEN — ini bukan hiasan, ini perbaikan performa yang terukur.
 *
 * Setiap modul mendaftarkan middleware ini sendiri pada pola path yang SAMA
 * (`app.use("/tenants/*", auth)`) di sub-app `routes` yang dipakai bersama,
 * dan 26 modul melakukannya. Hono menjalankan SEMUA handler yang cocok
 * dengan pola tersebut secara berurutan (dibuktikan: 26 pendaftaran → 26
 * eksekusi untuk satu request), sehingga tanpa penjaga di sini satu request
 * dashboard menjalankan `getSession` + `select users` 26 kali.
 *
 * Dampak terukur sebelum penjaga ini (produksi, 2026-11-05):
 * - `GET /api/tenants` dengan sesi valid: median 217 ms (26 eksekusi)
 * - request yang sama tanpa cookie: 8 ms (401 pada eksekusi pertama)
 * - request yang sama dengan cookie rusak: ~2,5 ms (idem)
 * Selisihnya bukan DB (query 1–11 ms) dan bukan spek server (load 0,7;
 * steal 0) — murni pengulangan ini.
 *
 * Karena `appUser` sudah tersimpan di konteks request, eksekusi kedua dan
 * seterusnya cukup meneruskan. Penjaga ini juga membuat pendaftaran ganda
 * di masa depan tidak lagi berbiaya.
 */
export function requireAuth(bundle: AuthBundle): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const alreadyResolved = c.get("appUser") as User | undefined;
    if (alreadyResolved) {
      await next();
      return;
    }

    const session = await bundle.auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (!session?.user) {
      return apiError(c, 401, "UNAUTHORIZED", "Authentication required");
    }

    let [appUser] = await bundle.db
      .select()
      .from(users)
      .where(eq(users.authUserId, session.user.id))
      .limit(1);
    if (!appUser) {
      appUser = await syncAppUser(bundle.db, {
        authUserId: session.user.id,
        email: session.user.email,
        name: session.user.name,
      });
    }

    c.set("appUser", appUser);
    c.set("authUserId", session.user.id);
    await next();
  };
}
