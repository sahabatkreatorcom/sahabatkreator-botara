import { sql } from "drizzle-orm";
import type { Database } from "@sahabat-kreator/db";
import type {
  ReplyTimeBucket,
  ReplyTimeReportResponse,
} from "@sahabat-kreator/contracts";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * KPI waktu balas (G13 butir 8) — median latensi balasan manusia vs AI,
 * periode berjalan vs periode sebelumnya yang sama lebar.
 *
 * Definisi (jujur dari stempel yang tersedia — `messages.created_at`
 * adalah satu-satunya jam yang kita punya; tidak ada stempel "dibaca"
 * per pesan masuk yang andal lintas provider):
 * - Untuk tiap pesan MASUK dalam jendela 2×`days`, pasangannya adalah
 *   pesan KELUAR PERTAMA sesudahnya di percakapan yang sama.
 * - Balasan dikreditkan ke kelas pengirim pesan keluar itu:
 *   sender_type 'user' → manusia, 'agent' → AI. 'system' (notifikasi
 *   mesin) dan pesan keluar tanpa pendahulu masuk (broadcast, pesan
 *   pembuka) tidak pernah menjadi pasangan.
 * - Pesan masuk tanpa balasan keluar TIDAK menyumbang sampel: ini
 *   median atas balasan yang terjadi, bukan SLA dan bukan janji —
 *   kontrak + UI menyatakannya begitu.
 * - Pasangan masuk ke periode menurut waktu pesan MASUKnya; latensi
 *   boleh melewati batas periode (balasan memang bisa datang sesudah
 *   jendela bergeser) — yang dihitung periodenya adalah pertanyaannya.
 *
 * Implementasi: SATU kueri LATERAL untuk seluruh jendela (bukan N+1
 * per percakapan), median dihitung di JS dari latensi terurut — volume
 * baris pasangan sebanding dengan pesan masuk 2 periode, wajar untuk
 * laporan analitik berkala.
 */

interface ReplyPairRow {
  in_at: Date | string;
  out_at: Date | string;
  sender_type: string;
}

/** Median daftar detik; null untuk daftar kosong (tidak ada angka karangan). */
export function medianSeconds(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function bucket(values: number[]): ReplyTimeBucket {
  return { medianSeconds: medianSeconds(values), samples: values.length };
}

export async function getReplyTimeReport(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: { days: number; now?: Date },
): Promise<ReplyTimeReportResponse> {
  const days = Math.min(90, Math.max(1, Math.floor(input.days) || 30));
  const now = input.now ?? new Date();
  const currentStart = new Date(now.getTime() - days * 86_400_000);
  const previousStart = new Date(now.getTime() - 2 * days * 86_400_000);

  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT i.created_at AS in_at, o.created_at AS out_at, o.sender_type AS sender_type
      FROM messages i
      JOIN LATERAL (
        SELECT m.sender_type, m.created_at
        FROM messages m
        WHERE m.conversation_id = i.conversation_id
          AND m.tenant_id = i.tenant_id
          AND m.direction = 'outbound'
          AND m.sender_type IN ('user', 'agent')
          AND m.created_at > i.created_at
        ORDER BY m.created_at ASC
        LIMIT 1
      ) o ON true
      WHERE i.tenant_id = ${ctx.tenantId}
        AND i.direction = 'inbound'
        AND i.created_at >= ${previousStart.toISOString()}
        AND i.created_at < ${now.toISOString()}
    `);
    const rows = (result as unknown as { rows: ReplyPairRow[] }).rows ?? [];

    const latencies: Record<
      "human" | "agent",
      Record<"current" | "previous", number[]>
    > = {
      human: { current: [], previous: [] },
      agent: { current: [], previous: [] },
    };
    for (const row of rows) {
      const inAt = new Date(row.in_at).getTime();
      const outAt = new Date(row.out_at).getTime();
      if (Number.isNaN(inAt) || Number.isNaN(outAt)) continue;
      const side = row.sender_type === "user" ? "human" : "agent";
      const period = inAt >= currentStart.getTime() ? "current" : "previous";
      latencies[side][period].push(Math.max(0, (outAt - inAt) / 1000));
    }

    return {
      days,
      human: {
        current: bucket(latencies.human.current),
        previous: bucket(latencies.human.previous),
      },
      agent: {
        current: bucket(latencies.agent.current),
        previous: bucket(latencies.agent.previous),
      },
    };
  });
}
