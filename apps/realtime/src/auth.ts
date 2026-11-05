import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import {
  authAccount,
  authSession,
  authUser,
  authVerification,
  createDb,
  users,
  type Database,
  type User,
} from "@sahabat-kreator/db";
import { getTenantForUser, type TenantWithRole } from "@sahabat-kreator/core";

/**
 * Autentikasi socket dashboard (Fase 6G).
 *
 * Gateway ini TIDAK menerbitkan sesi — ia hanya MEMVALIDASI cookie sesi
 * Better Auth yang sama dengan yang dipakai apps/api, dengan instance
 * Better Auth lokal yang dikonfigurasi identik (secret + adapter yang
 * sama; pola yang sama seperti AuthBundle di apps/api, diduplikasi kecil
 * karena bundle itu milik aplikasi api). Setelah sesi valid, baris
 * `users` kita diselesaikan (lazy sync meniru `syncAppUser` di api) dan
 * keanggotaan tenant diverifikasi lewat core (`getTenantForUser`,
 * menyembunyikan tenant dari non-member seperti route REST).
 */

export interface RealtimeAuthBundle {
  auth: ReturnType<typeof createRealtimeAuthInstance>;
  db: Database;
}

function createRealtimeAuthInstance(
  db: Database,
  opts: { secret: string; baseURL: string },
) {
  return betterAuth({
    appName: "Sahabat Kreator",
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
      },
    }),
    emailAndPassword: { enabled: true },
  });
}

export function createRealtimeAuthBundle(opts: {
  databaseUrl: string;
  secret: string;
  baseURL: string;
}): RealtimeAuthBundle {
  const { db } = createDb(opts.databaseUrl);
  return {
    auth: createRealtimeAuthInstance(db, opts),
    db,
  };
}

/** Meniru lazy sync `syncAppUser` apps/api: upsert berbasis email. */
async function resolveAppUser(
  db: Database,
  sessionUser: { id: string; email: string; name?: string | null },
): Promise<User | null> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.authUserId, sessionUser.id))
    .limit(1);
  if (existing) return existing;
  await db
    .insert(users)
    .values({
      email: sessionUser.email,
      name: sessionUser.name ?? null,
      authUserId: sessionUser.id,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: { authUserId: sessionUser.id, updatedAt: new Date() },
    });
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.authUserId, sessionUser.id))
    .limit(1);
  return row ?? null;
}

export interface DashboardSocketIdentity {
  appUser: User;
  tenant: TenantWithRole;
}

/**
 * Validasi koneksi dashboard: cookie sesi pada header upgrade → sesi
 * Better Auth → user aplikasi → membership tenantId yang diminta.
 * Null = tolak handshake (pemanggil menjawab 401).
 */
export async function resolveDashboardSocketIdentity(
  bundle: RealtimeAuthBundle,
  headers: Headers,
  tenantId: string,
): Promise<DashboardSocketIdentity | null> {
  const session = await bundle.auth.api.getSession({ headers });
  if (!session?.user) return null;
  const appUser = await resolveAppUser(bundle.db, {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  });
  if (!appUser) return null;
  const tenant = await getTenantForUser(bundle.db, {
    tenantId,
    userId: appUser.id,
  });
  if (!tenant) return null;
  return { appUser, tenant };
}
