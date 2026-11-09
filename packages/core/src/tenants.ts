import { and, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  tenantMembers,
  tenants,
  type Database,
  type Tenant,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";

/**
 * Service domain tenants/workspace (RANCANGAN §6) — transport-agnostic.
 *
 * Pola RLS yang dipakai (lihat packages/db README + migrasi 0001 & 0003):
 * - Query dalam satu tenant: transaksi diawali set_config('app.tenant_id').
 * - Query keanggotaan lintas workspace milik SATU user (daftar workspace):
 *   transaksi diawali set_config('app.user_id') — policy tenant_members
 *   (migrasi 0003) membuat baris terlihat hanya bila user_id baris = user
 *   sesi. Penulisan tetap tidak diizinkan dari konteks user.
 */

export type MemberRole = "owner" | "admin" | "agent" | "viewer";

export interface TenantWithRole extends Tenant {
  role: MemberRole;
}

/** Membuat slug URL dari nama workspace: huruf kecil, strip, tanpa diakritik. */
export function slugifyWorkspaceName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : "workspace";
}

function isUniqueViolation(err: unknown): boolean {
  const text = `${(err as { message?: string })?.message ?? ""} ${(err as { cause?: { message?: string } })?.cause?.message ?? ""}`;
  return /duplicate key|unique constraint|unique violation/i.test(text) || (err as { code?: string })?.code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505";
}

/**
 * Membuat workspace baru: baris `tenants`, membership `owner` untuk pembuat,
 * dan catatan audit `tenant.created` — semuanya dalam SATU transaksi.
 * Slug dibuat unik otomatis: nama sama → suffix -2, -3, ... (atau retry bila
 * balapan dengan insert lain yang memakai slug yang sama).
 */
export async function createTenant(
  db: Database,
  input: { userId: string; name: string },
): Promise<TenantWithRole> {
  const base = slugifyWorkspaceName(input.name);
  for (let attempt = 0; attempt < 50; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      const tenant = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(tenants)
          .values({ name: input.name, slug })
          .returning();
        // Konteks tenant untuk baris tenant-scoped dalam transaksi ini.
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${created.id}, true)`,
        );
        await tx.insert(tenantMembers).values({
          tenantId: created.id,
          userId: input.userId,
          role: "owner",
        });
        await tx.insert(auditLogs).values({
          tenantId: created.id,
          actorType: "user",
          actorId: input.userId,
          action: "tenant.created",
          meta: { slug: created.slug, name: created.name },
        });
        return created;
      });
      return { ...tenant, role: "owner" };
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new Error("createTenant: tidak dapat menemukan slug unik");
}

/** Daftar workspace milik user (dari tenant_members miliknya sendiri). */
export async function listTenantsForUser(
  db: Database,
  userId: string,
): Promise<TenantWithRole[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    const rows = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        defaultLocale: tenants.defaultLocale,
        timezone: tenants.timezone,
        // Status ikut dikirim supaya dashboard bisa MENJELASKAN kenapa
        // workspace tidak bisa dibuka (migrasi 0010), bukan sekadar
        // menghilangkannya dari daftar tanpa alasan.
        status: tenants.status,
        statusReason: tenants.statusReason,
        statusChangedAt: tenants.statusChangedAt,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .where(eq(tenantMembers.userId, userId))
      .orderBy(tenants.createdAt);
    return rows as TenantWithRole[];
  });
}

/**
 * Detail satu workspace untuk user — null bila user BUKAN member.
 * Pemanggil (API) menerjemahkan null menjadi 404 agar eksistensi tenant
 * tidak bocor ke non-member.
 */
export async function getTenantForUser(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
): Promise<TenantWithRole | null> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId}, true)`);
    return tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        defaultLocale: tenants.defaultLocale,
        timezone: tenants.timezone,
        status: tenants.status,
        statusReason: tenants.statusReason,
        statusChangedAt: tenants.statusChangedAt,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .where(
        and(
          eq(tenantMembers.tenantId, ctx.tenantId),
          eq(tenantMembers.userId, ctx.userId),
          // Penangguhan ditegakkan DI SINI, satu tempat, karena seluruh route
          // bersarang memakai fungsi ini untuk menyelesaikan konteks. Tenant
          // non-aktif karena itu menjawab 404 — sama seperti non-member —
          // sehingga status tidak bisa dilewati lewat jalur lain.
          eq(tenants.status, "active"),
        ),
      )
      .limit(1);
  });
  return (rows[0] as TenantWithRole | undefined) ?? null;
}
