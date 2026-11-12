import { and, desc, eq } from "drizzle-orm";
import {
  agentInstructionTemplates,
  type AgentInstructionTemplate,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service domain Templat Instruction Agent pribadi tenant (gelombang
 * Templat Instruction /agents) — sisi manajemen.
 * Transport-agnostic; semua query dalam konteks RLS tenant.
 *
 * Satu templat adalah SALINAN instruction + mode + bahasa yang disimpan
 * pemilik dari formulir agent untuk dipakai ulang dari galeri templat.
 * Templat bukan rujukan: menghapusnya tidak menyentuh agent mana pun,
 * dan mengubah templat tersimpan di v1 = hapus + simpan ulang (karena
 * itu CRUD di sini sengaja hanya buat/daftar/hapus).
 *
 * Isolasi tenant ditegakkan di sini (where tenant_id pada setiap query)
 * DAN oleh RLS migrasi 0027.
 */

export interface CreateAgentInstructionTemplateInput {
  name: string;
  systemPrompt: string;
  mode?: "auto" | "suggest";
  /** Bahasa saran templat; kosong/null/undefined = tanpa saran (NULL). */
  language?: string | null;
}

export async function createAgentInstructionTemplate(
  db: Database,
  ctx: Pick<TenantContext, "tenantId"> & { userId: string },
  input: CreateAgentInstructionTemplateInput,
): Promise<AgentInstructionTemplate> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const language = input.language?.trim() ? input.language.trim() : null;
    const [row] = await tx
      .insert(agentInstructionTemplates)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        systemPrompt: input.systemPrompt,
        mode: input.mode ?? "suggest",
        language,
        createdBy: ctx.userId,
      })
      .returning();
    return row;
  });
}

export async function listAgentInstructionTemplates(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<AgentInstructionTemplate[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(agentInstructionTemplates)
      .where(eq(agentInstructionTemplates.tenantId, ctx.tenantId))
      .orderBy(desc(agentInstructionTemplates.createdAt));
  });
}

/** Null bila templat tidak ada DI tenant ini. */
export async function deleteAgentInstructionTemplate(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  id: string,
): Promise<AgentInstructionTemplate | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .delete(agentInstructionTemplates)
      .where(
        and(
          eq(agentInstructionTemplates.tenantId, ctx.tenantId),
          eq(agentInstructionTemplates.id, id),
        ),
      )
      .returning();
    return row ?? null;
  });
}
