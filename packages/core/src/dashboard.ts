import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@sahabat-kreator/db";
import type {
  DashboardSetup,
  DashboardSummaryResponse,
} from "@sahabat-kreator/contracts";
import {
  agents,
  automations,
  channelAccounts,
  contacts,
  conversations,
  messages,
  tenantMembers,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Ringkasan dashboard live (Fase 16A) — pengganti kartu statistik
 * placeholder DashboardPage. Semua angka dihitung dari tabel yang SUDAH
 * ada (inbox.ts, channels.ts) dalam SATU transaksi tenant RLS
 * (`withTenantDb`) — tanpa tabel baru, tanpa konfigurasi.
 *
 * Semantik kejujuran tiap angka terdokumentasi di kontrak
 * `DashboardSummaryResponseSchema`; ringkasnya:
 * - attention.unreadConversations  = percakapan unreadCount > 0.
 * - attention.idleOpenConversations = status 'open' + pesan terakhir
 *   lebih tua dari 24 jam (ambang UTC; pelanggan mungkin terlupakan).
 * - attention.failedMessages       = pesan keluar status 'failed'.
 * - channels                       = kesehatan akun channel per provider.
 * - activity (7 hari UTC penuh)    = pesan masuk/keluar per hari,
 *   balasan agent vs manusia (sender_type 'agent'/'user'), kontak baru.
 */

/** Ambang idle percakapan terbuka (jam) — satu sumber untuk core & UI. */
export const DASHBOARD_IDLE_HOURS = 24;
/** Lebar jendela aktivitas dashboard (hari). */
export const DASHBOARD_ACTIVITY_DAYS = 7;

export async function getDashboardSummary(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<DashboardSummaryResponse> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    // Tengah malam UTC hari ini (pola ai-usage): deret harian selalu
    // 7 titik penuh berbasis UTC apa pun TimeZone sesi server.
    const todayUtc =
      sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
    const since =
      sql`${todayUtc} - (${DASHBOARD_ACTIVITY_DAYS - 1} * interval '1 day')`;
    const idleCutoff =
      sql`now() - (${DASHBOARD_IDLE_HOURS} * interval '1 hour')`;

    const [unreadRow] = await tx
      .select({ n: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          sql`${conversations.unreadCount} > 0`,
        ),
      );

    const [idleRow] = await tx
      .select({ n: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          eq(conversations.status, "open"),
          sql`${conversations.lastMessageAt} IS NOT NULL`,
          sql`${conversations.lastMessageAt} < ${idleCutoff}`,
        ),
      );

    const [failedRow] = await tx
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          eq(messages.direction, "outbound"),
          eq(messages.status, "failed"),
        ),
      );

    const channelRows = await tx
      .select({
        provider: channelAccounts.provider,
        status: channelAccounts.status,
        n: count(),
      })
      .from(channelAccounts)
      .where(eq(channelAccounts.tenantId, ctx.tenantId))
      .groupBy(channelAccounts.provider, channelAccounts.status);

    const channels = new Map<
      string,
      { connected: number; disconnected: number }
    >();
    for (const row of channelRows) {
      const entry = channels.get(row.provider) ?? {
        connected: 0,
        disconnected: 0,
      };
      if (row.status === "connected") entry.connected += Number(row.n);
      else entry.disconnected += Number(row.n);
      channels.set(row.provider, entry);
    }

    const directionRows = await tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        direction: messages.direction,
        n: count(),
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          gte(messages.createdAt, since),
        ),
      )
      .groupBy(
        sql`date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC')`,
        messages.direction,
      );

    const [agentRow] = await tx
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          gte(messages.createdAt, since),
          eq(messages.senderType, "agent"),
        ),
      );

    const [manualRow] = await tx
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          gte(messages.createdAt, since),
          eq(messages.senderType, "user"),
        ),
      );

    const [newContactsRow] = await tx
      .select({ n: count() })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, ctx.tenantId),
          gte(contacts.createdAt, since),
        ),
      );

    // Deret lengkap 7 hari: hari tanpa pesan tetap muncul dengan 0.
    const dayMap = new Map<string, { inbound: number; outbound: number }>();
    for (const row of directionRows) {
      const entry = dayMap.get(row.day) ?? { inbound: 0, outbound: 0 };
      if (row.direction === "inbound") entry.inbound += Number(row.n);
      else entry.outbound += Number(row.n);
      dayMap.set(row.day, entry);
    }
    const daily: DashboardSummaryResponse["activity"]["daily"] = [];
    const cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCDate(cursor.getUTCDate() - (DASHBOARD_ACTIVITY_DAYS - 1));
    for (let i = 0; i < DASHBOARD_ACTIVITY_DAYS; i += 1) {
      const iso = cursor.toISOString().slice(0, 10);
      const entry = dayMap.get(iso) ?? { inbound: 0, outbound: 0 };
      daily.push({ date: iso, ...entry });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    let messagesIn = 0;
    let messagesOut = 0;
    for (const point of daily) {
      messagesIn += point.inbound;
      messagesOut += point.outbound;
    }

    // Checklist penyiapan (G13 butir 7): lima hitungan keberadaan dari
    // data sungguhan dalam transaksi yang sama — tanpa kolom penanda
    // "sudah selesai" di mana pun; keadaan data adalah sumbernya.
    const [agentCountRow] = await tx
      .select({ n: count() })
      .from(agents)
      .where(eq(agents.tenantId, ctx.tenantId));
    const [conversationCountRow] = await tx
      .select({ n: count() })
      .from(conversations)
      .where(eq(conversations.tenantId, ctx.tenantId));
    const [automationCountRow] = await tx
      .select({ n: count() })
      .from(automations)
      .where(eq(automations.tenantId, ctx.tenantId));
    const [memberCountRow] = await tx
      .select({ n: count() })
      .from(tenantMembers)
      .where(eq(tenantMembers.tenantId, ctx.tenantId));

    const setupSteps: DashboardSetup["steps"] = [
      {
        key: "channel",
        done: [...channels.values()].some((c) => c.connected > 0),
      },
      { key: "agent", done: Number(agentCountRow?.n ?? 0) > 0 },
      { key: "conversation", done: Number(conversationCountRow?.n ?? 0) > 0 },
      { key: "automation", done: Number(automationCountRow?.n ?? 0) > 0 },
      { key: "team", done: Number(memberCountRow?.n ?? 0) >= 2 },
    ];
    const setup: DashboardSetup = {
      steps: setupSteps,
      completedCount: setupSteps.filter((s) => s.done).length,
      totalCount: setupSteps.length,
      allDone: setupSteps.every((s) => s.done),
    };

    return {
      attention: {
        unreadConversations: Number(unreadRow?.n ?? 0),
        idleOpenConversations: Number(idleRow?.n ?? 0),
        failedMessages: Number(failedRow?.n ?? 0),
      },
      channels: [...channels.entries()].map(([provider, c]) => ({
        provider,
        ...c,
      })),
      activity: {
        messagesIn,
        messagesOut,
        agentReplies: Number(agentRow?.n ?? 0),
        manualReplies: Number(manualRow?.n ?? 0),
        newContacts: Number(newContactsRow?.n ?? 0),
        daily,
      },
      setup,
      generatedAt: new Date().toISOString(),
    };
  });
}
