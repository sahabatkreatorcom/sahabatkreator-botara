import { and, asc, desc, eq } from "drizzle-orm";
import {
  agents,
  type Agent,
  type AgentConfig,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service domain AI Agent (Fase 3A, RANCANGAN §5.1 & §6) — sisi manajemen.
 * Transport-agnostic; semua query dalam konteks RLS tenant.
 *
 * Aturan pemilihan agent runtime: tenant boleh punya banyak agent, tetapi
 * yang menjawab pesan adalah agent AKTIF TERTUA (is_active=true, urutan
 * created_at menaik) — satu penanggung jawab per tenant di fase ini.
 * Sisi runtime (loop + tools + metering) ada di `agent-runtime.ts`.
 */

export interface CreateAgentInput {
  name: string;
  systemPrompt?: string;
  model?: string;
  mode?: "auto" | "suggest";
  isActive?: boolean;
  config?: AgentConfig;
}

export interface UpdateAgentInput {
  name?: string;
  systemPrompt?: string;
  model?: string;
  mode?: "auto" | "suggest";
  isActive?: boolean;
  config?: AgentConfig;
}

export async function createAgent(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: CreateAgentInput,
): Promise<Agent> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        systemPrompt: input.systemPrompt ?? "",
        model: input.model ?? "",
        mode: input.mode ?? "suggest",
        isActive: input.isActive ?? false,
        config: input.config ?? {},
      })
      .returning();
    return row;
  });
}

export async function listAgents(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<Agent[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(agents)
      .where(eq(agents.tenantId, ctx.tenantId))
      .orderBy(desc(agents.createdAt));
  });
}

/** Null bila agent tidak ada DI tenant ini. */
export async function getAgent(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  agentId: string,
): Promise<Agent | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.tenantId, ctx.tenantId), eq(agents.id, agentId)))
      .limit(1);
    return row ?? null;
  });
}

/** Null bila agent tidak ada DI tenant ini. */
export async function updateAgent(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  agentId: string,
  input: UpdateAgentInput,
): Promise<Agent | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<Agent> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
    if (input.model !== undefined) patch.model = input.model;
    if (input.mode !== undefined) patch.mode = input.mode;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.config !== undefined) patch.config = input.config;
    const [row] = await tx
      .update(agents)
      .set(patch)
      .where(and(eq(agents.tenantId, ctx.tenantId), eq(agents.id, agentId)))
      .returning();
    return row ?? null;
  });
}

/**
 * Agent yang dipakai runtime untuk tenant ini: aktif tertua.
 * Null bila tenant belum punya agent aktif (pesan tidak dijawab AI).
 */
export async function getActiveAgent(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<Agent | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(agents)
      .where(
        and(eq(agents.tenantId, ctx.tenantId), eq(agents.isActive, true)),
      )
      .orderBy(asc(agents.createdAt))
      .limit(1);
    return row ?? null;
  });
}
