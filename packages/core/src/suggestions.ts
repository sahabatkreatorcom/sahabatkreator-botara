import { and, desc, eq } from "drizzle-orm";
import {
  agentSuggestions,
  auditLogs,
  conversations,
  messages,
  outboxEvents,
  type AgentSuggestion,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service draf balasan agent mode 'suggest' (Fase 3A, RANCANGAN §9/§10:
 * manusia menyetujui draf sebelum terkirim).
 *
 * Aturan yang ditegakkan di sini:
 * - Approve HANYA mengirim teks saran sebagai pesan outbound
 *   sender_type='agent' berstatus 'queued' (+ event outbox
 *   `message.queued`; poller API mengirim sungguhan seperti automation).
 *   Status saran menjadi 'sent'. Tool call yang diusulkan agent saat
 *   draf dibuat TIDAK ikut dieksekusi — manusia menyetujui teks, bukan
 *   aksi data (keputusan disengaja, dicatat di detail saran).
 * - Approve/reject hanya berlaku untuk saran berstatus 'pending';
 *   selain itu dikembalikan sebagai outcome 'not_pending' (API → 400).
 * - Semua dalam konteks RLS tenant; saran tenant lain tidak terlihat.
 */

export async function listSuggestions(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: { status?: AgentSuggestion["status"]; limit: number },
): Promise<AgentSuggestion[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const conditions = [eq(agentSuggestions.tenantId, ctx.tenantId)];
    if (input.status) {
      conditions.push(eq(agentSuggestions.status, input.status));
    }
    return tx
      .select()
      .from(agentSuggestions)
      .where(and(...conditions))
      .orderBy(desc(agentSuggestions.createdAt))
      .limit(input.limit);
  });
}

/** Null bila saran tidak ada DI tenant ini. */
export async function getSuggestion(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  suggestionId: string,
): Promise<AgentSuggestion | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(agentSuggestions)
      .where(
        and(
          eq(agentSuggestions.tenantId, ctx.tenantId),
          eq(agentSuggestions.id, suggestionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export type ApproveSuggestionOutcome =
  | {
      kind: "sent";
      suggestion: AgentSuggestion;
      outboundMessageId: string;
    }
  | { kind: "not_pending"; suggestion: AgentSuggestion }
  | { kind: "not_found" };

export async function approveSuggestion(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  suggestionId: string,
): Promise<ApproveSuggestionOutcome> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(agentSuggestions)
      .where(
        and(
          eq(agentSuggestions.tenantId, ctx.tenantId),
          eq(agentSuggestions.id, suggestionId),
        ),
      )
      .limit(1);
    if (!suggestion) return { kind: "not_found" as const };
    if (suggestion.status !== "pending") {
      return { kind: "not_pending" as const, suggestion };
    }

    const [conv] = await tx
      .select({ provider: conversations.provider })
      .from(conversations)
      .where(eq(conversations.id, suggestion.conversationId))
      .limit(1);

    const [outbound] = await tx
      .insert(messages)
      .values({
        tenantId: ctx.tenantId,
        conversationId: suggestion.conversationId,
        direction: "outbound",
        senderType: "agent",
        type: "text",
        contentText: suggestion.suggestedText,
        status: "queued",
      })
      .returning();

    const now = new Date();
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, suggestion.conversationId));

    await tx.insert(outboxEvents).values({
      tenantId: ctx.tenantId,
      type: "message.queued",
      payload: {
        provider: conv?.provider ?? null,
        conversationId: suggestion.conversationId,
        messageId: outbound.id,
        via: "agent_suggestion",
        suggestionId: suggestion.id,
        agentId: suggestion.agentId,
      },
    });

    const detail = {
      ...(suggestion.detail as Record<string, unknown>),
      outboundMessageId: outbound.id,
      approvedAt: now.toISOString(),
    };
    const [updated] = await tx
      .update(agentSuggestions)
      .set({ status: "sent", detail, updatedAt: now })
      .where(eq(agentSuggestions.id, suggestion.id))
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: ctx.userId ? "user" : "system",
      actorId: ctx.userId ?? "api",
      action: "agent.suggestion_approved",
      meta: {
        suggestionId: suggestion.id,
        agentId: suggestion.agentId,
        conversationId: suggestion.conversationId,
        outboundMessageId: outbound.id,
      },
    });

    return {
      kind: "sent" as const,
      suggestion: updated,
      outboundMessageId: outbound.id,
    };
  });
}

export type RejectSuggestionOutcome =
  | { kind: "rejected"; suggestion: AgentSuggestion }
  | { kind: "not_pending"; suggestion: AgentSuggestion }
  | { kind: "not_found" };

export async function rejectSuggestion(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId">,
  suggestionId: string,
): Promise<RejectSuggestionOutcome> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(agentSuggestions)
      .where(
        and(
          eq(agentSuggestions.tenantId, ctx.tenantId),
          eq(agentSuggestions.id, suggestionId),
        ),
      )
      .limit(1);
    if (!suggestion) return { kind: "not_found" as const };
    if (suggestion.status !== "pending") {
      return { kind: "not_pending" as const, suggestion };
    }
    const [updated] = await tx
      .update(agentSuggestions)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(agentSuggestions.id, suggestion.id))
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: ctx.userId ? "user" : "system",
      actorId: ctx.userId ?? "api",
      action: "agent.suggestion_rejected",
      meta: {
        suggestionId: suggestion.id,
        agentId: suggestion.agentId,
        conversationId: suggestion.conversationId,
      },
    });
    return { kind: "rejected" as const, suggestion: updated };
  });
}
