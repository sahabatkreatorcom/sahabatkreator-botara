import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { users } from "@sahabat-kreator/db";
import { syncAppUser, type AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";

/**
 * Middleware sesi: membaca sesi Better Auth dari cookie request.
 * - Tanpa sesi valid → 401 UNAUTHORIZED (format kontrak).
 * - Dengan sesi → menyelesaikan baris `users` kita (lazy sync bila hook
 *   sign-up terlewat) dan menyimpannya di konteks sebagai `appUser`.
 */
export function requireAuth(bundle: AuthBundle): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
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
