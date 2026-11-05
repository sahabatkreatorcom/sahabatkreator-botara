import { and, eq, gte, sql } from "drizzle-orm";
import { agents, usageLedger, type Database } from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";
import { AGENT_DAILY_RESPONSE_CAP, AGENT_USAGE_REF_TYPE } from "./agent-runtime";

/**
 * Agregasi pemakaian AI untuk dasbor /analytics (Fase 9B) — murni
 * pembacaan `usage_ledger` type='ai_token' dalam konteks RLS tenant.
 *
 * KEJUJURAN ANGKA (keputusan desain fase ini):
 * - `responses` & `tokensTotal` mencakup SEMUA baris era (kolom `qty`
 *   selalu terisi sejak Fase 3A).
 * - Rincian token masuk/keluar, per-agent, dan biaya hanya ada pada
 *   baris ber-`meta` (tulisan Fase 9B + hasil backfill baris lama dari
 *   audit `agent.responded`). Baris tanpa rincian dihitung terpisah
 *   sebagai `undetailedResponses` — UI menampilkannya apa adanya,
 *   tidak pernah membagi qty secara karangan ke in/out.
 * - Biaya (`costUsd`) adalah biaya AKTUAL yang dilaporkan provider
 *   pada responsnya (OpenRouter `usage.cost`). Bila provider tidak
 *   melaporkannya (mock, atau model/rute tanpa cost), baris itu tidak
 *   menyumbang biaya; `costReportedResponses` menunjukkan cakupannya.
 *   TIDAK ada tabel harga statis dan tidak ada estimasi karangan.
 * - Hari dihitung UTC dan dipatok EKSPLISIT ke UTC (`AT TIME ZONE 'UTC'`
 *   dua arah) sehingga semantik cap harian runtime & laporan TIDAK
 *   bergantung pada pengaturan TimeZone server Postgres — sebelumnya
 *   `date_trunc('day', now())` diam-diam mengikuti TZ server.
 */

export interface AiUsageDayPoint {
  /** Tanggal UTC, format YYYY-MM-DD. */
  date: string;
  responses: number;
  tokensIn: number;
  tokensOut: number;
  /** Biaya terlapor provider (USD) pada hari itu; null bila tak ada baris berbiaya. */
  costUsd: number | null;
}

export interface AiUsageAgentPoint {
  /** Null = baris warisan tanpa rincian agent (pra-9B, belum ter-backfill). */
  agentId: string | null;
  /** Nama agent saat ini; null bila agentId null atau agent sudah terhapus. */
  agentName: string | null;
  responses: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  /** Model berbeda yang tercatat untuk agent ini pada periode. */
  models: string[];
}

export interface AiUsageReport {
  days: number;
  responses: number;
  /** Total token dari kolom qty (semua baris, semua era). */
  tokensTotal: number;
  /** Token masuk dari baris ber-rincian meta saja. */
  tokensIn: number;
  /** Token keluar dari baris ber-rincian meta saja. */
  tokensOut: number;
  /** Respons yang punya rincian meta (tokensIn/tokensOut per baris). */
  detailedResponses: number;
  /** Respons tanpa rincian (baris warisan meta '{}'). */
  undetailedResponses: number;
  /** Jumlah biaya aktual terlapor provider (USD); null bila tak satu pun baris berbiaya. */
  costUsd: number | null;
  /** Berapa respons yang biayanya dilaporkan provider. */
  costReportedResponses: number;
  daily: AiUsageDayPoint[];
  perAgent: AiUsageAgentPoint[];
  cap: {
    dailyLimit: number;
    usedToday: number;
    remainingToday: number;
  };
}

interface UsageAggRow {
  responses: number;
  tokensTotal: number;
  tokensIn: number;
  tokensOut: number;
  detailed: number;
  costSum: number | null;
  costCount: number;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

/** Ekspresi agregat bersama untuk ringkasan/per-hari/per-agent. */
function aggSelect() {
  return {
    responses: sql<number>`count(*)::int`,
    tokensTotal: sql<number>`coalesce(sum(${usageLedger.qty}), 0)::float8`,
    tokensIn: sql<number>`coalesce(sum((${usageLedger.meta}->>'tokensIn')::numeric), 0)::float8`,
    tokensOut: sql<number>`coalesce(sum((${usageLedger.meta}->>'tokensOut')::numeric), 0)::float8`,
    detailed: sql<number>`count(*) filter (where ${usageLedger.meta} ? 'tokensIn')::int`,
    costSum: sql<number | null>`sum((${usageLedger.meta}->>'costUsd')::numeric)::float8`,
    costCount: sql<number>`count(*) filter (where ${usageLedger.meta} ? 'costUsd')::int`,
  };
}

function toAgg(row: Record<string, unknown> | undefined): UsageAggRow {
  return {
    responses: num(row?.responses),
    tokensTotal: num(row?.tokensTotal),
    tokensIn: num(row?.tokensIn),
    tokensOut: num(row?.tokensOut),
    detailed: num(row?.detailed),
    costSum:
      row?.costSum === null || row?.costSum === undefined
        ? null
        : num(row.costSum),
    costCount: num(row?.costCount),
  };
}

/**
 * Laporan pemakaian AI satu tenant untuk `days` hari terakhir (hari ini
 * UTC termasuk). Deret harian selalu lengkap `days` titik (hari tanpa
 * pemakaian = nol) agar UI bisa menampilkan tabel yang utuh.
 */
export async function getAiUsageReport(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: { days: number },
): Promise<AiUsageReport> {
  const days = Math.min(90, Math.max(1, Math.trunc(input.days) || 30));
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    // Batas "hari ini" dipatok UTC eksplisit: date_trunc pada now()
    // mengikuti TimeZone sesi server; AT TIME ZONE 'UTC' dua arah
    // (naikkan ke naive UTC, potong harinya, kembalikan ke timestamptz)
    // menghasilkan tengah malam UTC apa pun TZ server.
    const since =
      sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - (${days - 1} * interval '1 day')`;
    const baseWhere = and(
      eq(usageLedger.tenantId, ctx.tenantId),
      eq(usageLedger.type, "ai_token"),
      eq(usageLedger.refType, AGENT_USAGE_REF_TYPE),
      gte(usageLedger.createdAt, since),
    );

    const [summaryRow] = await tx
      .select(aggSelect())
      .from(usageLedger)
      .where(baseWhere);
    const summary = toAgg(summaryRow as Record<string, unknown>);

    const dailyRows = await tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageLedger.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        ...aggSelect(),
      })
      .from(usageLedger)
      .where(baseWhere)
      .groupBy(sql`date_trunc('day', ${usageLedger.createdAt} AT TIME ZONE 'UTC')`);
    const byDay = new Map(
      dailyRows.map((r) => [r.day, toAgg(r as Record<string, unknown>)]),
    );
    // Bangun deret lengkap dari (hari ini UTC - days + 1) sampai hari ini.
    const nowDate = new Date();
    const daily: AiUsageDayPoint[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(
        Date.UTC(
          nowDate.getUTCFullYear(),
          nowDate.getUTCMonth(),
          nowDate.getUTCDate() - i,
        ),
      );
      const key = d.toISOString().slice(0, 10);
      const agg = byDay.get(key);
      daily.push({
        date: key,
        responses: agg?.responses ?? 0,
        tokensIn: agg?.tokensIn ?? 0,
        tokensOut: agg?.tokensOut ?? 0,
        costUsd: agg && agg.costCount > 0 ? agg.costSum : null,
      });
    }

    const agentRows = await tx
      .select({
        agentId: sql<string | null>`${usageLedger.meta}->>'agentId'`,
        models: sql<string[]>`coalesce(array_agg(distinct ${usageLedger.meta}->>'model') filter (where ${usageLedger.meta}->>'model' is not null), '{}')`,
        ...aggSelect(),
      })
      .from(usageLedger)
      .where(baseWhere)
      .groupBy(sql`${usageLedger.meta}->>'agentId'`);
    const agentIds = agentRows
      .map((r) => r.agentId)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    const nameById = new Map<string, string>();
    if (agentIds.length > 0) {
      const found = await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.tenantId, ctx.tenantId));
      for (const a of found) nameById.set(a.id, a.name);
    }
    const perAgent: AiUsageAgentPoint[] = agentRows
      .map((r) => {
        const agg = toAgg(r as Record<string, unknown>);
        return {
          agentId: r.agentId ?? null,
          agentName: r.agentId ? (nameById.get(r.agentId) ?? null) : null,
          responses: agg.responses,
          tokensIn: agg.tokensIn,
          tokensOut: agg.tokensOut,
          costUsd: agg.costCount > 0 ? agg.costSum : null,
          models: (r.models ?? []).filter(
            (m): m is string => typeof m === "string",
          ),
        };
      })
      .sort((a, b) => b.responses - a.responses);

    const [capRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(usageLedger)
      .where(
        and(
          eq(usageLedger.tenantId, ctx.tenantId),
          eq(usageLedger.type, "ai_token"),
          eq(usageLedger.refType, AGENT_USAGE_REF_TYPE),
          gte(
            usageLedger.createdAt,
            sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
          ),
        ),
      );
    const usedToday = capRow?.n ?? 0;

    return {
      days,
      responses: summary.responses,
      tokensTotal: summary.tokensTotal,
      tokensIn: summary.tokensIn,
      tokensOut: summary.tokensOut,
      detailedResponses: summary.detailed,
      undetailedResponses: summary.responses - summary.detailed,
      costUsd: summary.costCount > 0 ? summary.costSum : null,
      costReportedResponses: summary.costCount,
      daily,
      perAgent,
      cap: {
        dailyLimit: AGENT_DAILY_RESPONSE_CAP,
        usedToday,
        remainingToday: Math.max(0, AGENT_DAILY_RESPONSE_CAP - usedToday),
      },
    };
  });
}
