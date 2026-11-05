import { z } from "zod";
import { getTenantForUser, type TenantWithRole } from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";

/**
 * Menyelesaikan konteks workspace untuk route bersarang
 * (/tenants/:tenantId/...): id harus UUID valid DAN user sesi harus member.
 * Mengembalikan null bila salah satu gagal — pemanggil menjawab 404
 * TENANT_NOT_FOUND agar eksistensi tenant tidak bocor ke non-member
 * (pola yang sama dengan GET /tenants/:id Fase 1B).
 */
export async function resolveTenantForUser(
  bundle: AuthBundle,
  tenantIdRaw: string,
  userId: string,
): Promise<TenantWithRole | null> {
  if (!z.string().uuid().safeParse(tenantIdRaw).success) return null;
  return getTenantForUser(bundle.db, { tenantId: tenantIdRaw, userId });
}
