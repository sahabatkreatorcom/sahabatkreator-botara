import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  conversations,
  integrationLog,
  messages,
} from "@sahabat-kreator/db";
import type { Database } from "@sahabat-kreator/db";
import type { ChannelProviderName } from "./channels";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Kesehatan operasional channel (Fase 7B.3) — fakta per akun channel
 * untuk kartu Channels, diturunkan dari data yang SUDAH tercatat:
 *
 * - Provider ber-webhook (telegram, messenger, instagram, whatsapp):
 *   SEMUA fakta dari `integration_log` (Fase 7B.1) per
 *   `channel_account_id` — hit arah masuk terakhir, pengiriman sukses
 *   terakhir, dan sinyal kegagalan terakhir. Hit Meta yang gagal di
 *   gerbang bersama ber-`channel_account_id` NULL (belum teratribusi ke
 *   akun mana pun) sehingga memang tidak menempel ke kartu mana pun.
 * - Webchat: flush gateway realtime BUKAN percobaan API provider dan
 *   by design tidak dicatat di integration_log (lihat 7B.1). Faktanya
 *   diambil dari jejak yang andal dan memang ada:
 *   - masuk terakhir = `messages.created_at` pesan inbound terakhir
 *     pada percakapan akun ini (waktu terima yang sesungguhnya);
 *   - terkirim terakhir = `audit_logs.created_at` baris audit
 *     `message.sent` dengan meta channel 'webchat' terakhir —
 *     `flushQueuedWebchatMessages` adalah SATU-SATUNYA penanda status
 *     `sent` webchat dan audit itu ditulis pada transaksi flush yang
 *     sama, jadi stempelnya adalah waktu antar yang sesungguhnya
 *     (bukan `messages.created_at` balasan, yang bisa jauh lebih awal
 *     bila pengunjung sedang luring);
 *   - kegagalan selalu null: pesan webchat tidak pernah berstatus
 *     `failed` (Fase 7B.2) — tidak ada sinyal kegagalan yang jujur
 *     untuk ditampilkan.
 *
 * Aturan status (fungsi murni `computeChannelHealthStatus`):
 * - `idle` — tidak ada aktivitas tercatat sama sekali;
 * - `attention` — ada sinyal kegagalan DAN (belum pernah ada aktivitas
 *   sehat ATAU kegagalan terakhir lebih baru daripada aktivitas sehat
 *   terakhir);
 * - `ok` — ada aktivitas, dan tidak ada kegagalan yang lebih baru dari
 *   aktivitas sehat terakhir.
 * "Aktivitas sehat" = webhook masuk ber-outcome recorded/duplicate atau
 * pengiriman keluar sukses (untuk webchat: pesan masuk atau flush
 * terkirim mana pun — keduanya memang keberhasilan).
 * "Sinyal kegagalan" = arah masuk ber-outcome rejected_signature /
 * rejected_unconfigured / unresolved_account / error /
 * ignored_disconnected, atau arah keluar ber-outcome failed.
 * `ignored_disconnected` masuk kelas kegagalan karena maknanya persis
 * "event tiba tetapi dibuang" — kartu menampilkannya sebagai masalah
 * terakhir; begitu channel terhubung lagi dan event tercatat, status
 * pulih menjadi `ok` dengan sendirinya.
 *
 * Performa: TIGA kueri agregat untuk seluruh daftar akun tenant (satu
 * untuk provider ber-log, dua untuk webchat), BUKAN N+1 per kartu.
 * Semua berjalan dalam SATU transaksi konteks tenant (RLS berlaku).
 */

export type ChannelHealthStatus = "ok" | "attention" | "idle";

export interface ChannelHealthInfo {
  status: ChannelHealthStatus;
  /** Hit webhook masuk terakhir (webchat: pesan pengunjung terakhir). */
  lastInboundAt: Date | null;
  /** Outcome hit masuk terakhir; null untuk webchat (tak ada konsepnya). */
  lastInboundOutcome: string | null;
  /** Pengiriman keluar sukses terakhir. */
  lastDeliveredAt: Date | null;
  /** Sinyal kegagalan terakhir; null bila tidak pernah ada. */
  lastFailureAt: Date | null;
  lastFailureOutcome: string | null;
  lastFailureErrorCode: string | null;
}

/** Kesehatan akun tanpa aktivitas apa pun. */
export const IDLE_CHANNEL_HEALTH: ChannelHealthInfo = {
  status: "idle",
  lastInboundAt: null,
  lastInboundOutcome: null,
  lastDeliveredAt: null,
  lastFailureAt: null,
  lastFailureOutcome: null,
  lastFailureErrorCode: null,
};

/**
 * Aturan status kesehatan — lihat komentar modul. Kesetaraan stempel
 * waktu (kegagalan dan keberhasilan pada milidetik yang sama) dianggap
 * BUKAN perhatian: perhatian mensyaratkan kegagalan yang KETAT lebih
 * baru, agar satu hit yang sama tidak pernah menandai dirinya sendiri.
 */
export function computeChannelHealthStatus(input: {
  hasActivity: boolean;
  lastHealthyAt: Date | null;
  lastFailureAt: Date | null;
}): ChannelHealthStatus {
  if (!input.hasActivity) return "idle";
  if (
    input.lastFailureAt &&
    (!input.lastHealthyAt ||
      input.lastFailureAt.getTime() > input.lastHealthyAt.getTime())
  ) {
    return "attention";
  }
  return "ok";
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Normalisasi nilai waktu dari proyeksi SQL mentah: agregat
 * `max(timestamptz)` lewat templat `sql` Drizzle TIDAK melewati pemeta
 * kolom, jadi driver mengembalikannya sebagai STRING format Postgres
 * ("2026-11-02 07:23:35.998333+00"), bukan objek Date — beda dari
 * pembacaan kolom biasa. Ubah kembali ke Date di sini; string yang
 * tidak dikenal diperlakukan null (fakta diabaikan, bukan ditebak).
 */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    // "2026-11-02 07:23:35.998333+00" → "2026-11-02T07:23:35.998333+00:00"
    const iso = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Kondisi SQL "baris ini adalah sinyal kegagalan" (lihat komentar modul). */
const FAILURE_CONDITION = sql`(
  (${integrationLog.direction} = 'in' and ${integrationLog.outcome} in ('rejected_signature', 'rejected_unconfigured', 'unresolved_account', 'error', 'ignored_disconnected'))
  or (${integrationLog.direction} = 'out' and ${integrationLog.outcome} = 'failed')
)`;

interface LogAggregateRow {
  channelAccountId: string | null;
  /** Stempel dari proyeksi SQL mentah — dinormalisasi lewat `toDate`. */
  lastInboundAt: unknown;
  lastInboundOutcome: string | null;
  lastHealthyAt: unknown;
  lastDeliveredAt: unknown;
  lastFailureAt: unknown;
  lastFailureOutcome: string | null;
  lastFailureErrorCode: string | null;
}

/**
 * Peta kesehatan untuk sekumpulan akun channel milik SATU tenant.
 * Setiap akun yang diminta SELALU punya entri di peta hasil (akun tanpa
 * data → `IDLE_CHANNEL_HEALTH`), agar serializer tidak perlu menebak.
 */
export async function getChannelHealthMap(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  accounts: Array<{ id: string; provider: ChannelProviderName }>,
): Promise<Map<string, ChannelHealthInfo>> {
  const result = new Map<string, ChannelHealthInfo>();
  for (const account of accounts) {
    result.set(account.id, IDLE_CHANNEL_HEALTH);
  }
  if (accounts.length === 0) return result;

  const loggedIds = accounts
    .filter((a) => a.provider !== "webchat")
    .map((a) => a.id);
  const webchatIds = accounts
    .filter((a) => a.provider === "webchat")
    .map((a) => a.id);

  return withTenantDb(db, ctx.tenantId, async (tx) => {
    // --- Provider ber-webhook: satu agregat integration_log ----------
    if (loggedIds.length > 0) {
      const rows = (await tx
        .select({
          channelAccountId: integrationLog.channelAccountId,
          lastInboundAt: sql<Date | null>`max(${integrationLog.createdAt}) filter (where ${integrationLog.direction} = 'in')`,
          lastInboundOutcome: sql<
            string | null
          >`(array_agg(${integrationLog.outcome} order by ${integrationLog.createdAt} desc, ${integrationLog.id} desc) filter (where ${integrationLog.direction} = 'in'))[1]`,
          lastHealthyAt: sql<Date | null>`max(${integrationLog.createdAt}) filter (where (${integrationLog.direction} = 'in' and ${integrationLog.outcome} in ('recorded', 'duplicate')) or (${integrationLog.direction} = 'out' and ${integrationLog.outcome} = 'sent'))`,
          lastDeliveredAt: sql<Date | null>`max(${integrationLog.createdAt}) filter (where ${integrationLog.direction} = 'out' and ${integrationLog.outcome} = 'sent')`,
          lastFailureAt: sql<Date | null>`max(${integrationLog.createdAt}) filter (where ${FAILURE_CONDITION})`,
          lastFailureOutcome: sql<
            string | null
          >`(array_agg(${integrationLog.outcome} order by ${integrationLog.createdAt} desc, ${integrationLog.id} desc) filter (where ${FAILURE_CONDITION}))[1]`,
          lastFailureErrorCode: sql<
            string | null
          >`(array_agg(${integrationLog.errorCode} order by ${integrationLog.createdAt} desc, ${integrationLog.id} desc) filter (where ${FAILURE_CONDITION}))[1]`,
        })
        .from(integrationLog)
        .where(
          and(
            eq(integrationLog.tenantId, ctx.tenantId),
            inArray(integrationLog.channelAccountId, loggedIds),
          ),
        )
        .groupBy(integrationLog.channelAccountId)) as LogAggregateRow[];

      for (const row of rows) {
        if (!row.channelAccountId) continue;
        const lastInboundAt = toDate(row.lastInboundAt);
        const lastHealthyAt = toDate(row.lastHealthyAt);
        const lastDeliveredAt = toDate(row.lastDeliveredAt);
        const lastFailureAt = toDate(row.lastFailureAt);
        const hasActivity = Boolean(
          lastInboundAt || lastDeliveredAt || lastFailureAt,
        );
        result.set(row.channelAccountId, {
          status: computeChannelHealthStatus({
            hasActivity,
            lastHealthyAt,
            lastFailureAt,
          }),
          lastInboundAt,
          lastInboundOutcome: row.lastInboundOutcome,
          lastDeliveredAt,
          lastFailureAt,
          lastFailureOutcome: row.lastFailureOutcome,
          lastFailureErrorCode: row.lastFailureErrorCode,
        });
      }
    }

    // --- Webchat: pesan masuk terakhir + flush terkirim terakhir -----
    if (webchatIds.length > 0) {
      const inboundRows = await tx
        .select({
          channelAccountId: conversations.channelAccountId,
          lastInboundAt: sql<Date | null>`max(${messages.createdAt})`,
        })
        .from(messages)
        .innerJoin(
          conversations,
          eq(messages.conversationId, conversations.id),
        )
        .where(
          and(
            eq(messages.tenantId, ctx.tenantId),
            eq(messages.direction, "inbound"),
            inArray(conversations.channelAccountId, webchatIds),
          ),
        )
        .groupBy(conversations.channelAccountId);

      const deliveredRows = await tx
        .select({
          channelAccountId: conversations.channelAccountId,
          lastDeliveredAt: sql<Date | null>`max(${auditLogs.createdAt})`,
        })
        .from(auditLogs)
        .innerJoin(
          conversations,
          sql`${conversations.id}::text = ${auditLogs.meta} ->> 'conversationId'`,
        )
        .where(
          and(
            eq(auditLogs.tenantId, ctx.tenantId),
            eq(conversations.tenantId, ctx.tenantId),
            eq(auditLogs.action, "message.sent"),
            sql`${auditLogs.meta} ->> 'channel' = 'webchat'`,
            inArray(conversations.channelAccountId, webchatIds),
          ),
        )
        .groupBy(conversations.channelAccountId);

      const inboundById = new Map(
        inboundRows.map((r) => [r.channelAccountId, toDate(r.lastInboundAt)]),
      );
      const deliveredById = new Map(
        deliveredRows.map((r) => [
          r.channelAccountId,
          toDate(r.lastDeliveredAt),
        ]),
      );
      for (const accountId of webchatIds) {
        const lastInboundAt = inboundById.get(accountId) ?? null;
        const lastDeliveredAt = deliveredById.get(accountId) ?? null;
        const healthyAt = laterOf(lastInboundAt, lastDeliveredAt);
        result.set(accountId, {
          status: computeChannelHealthStatus({
            hasActivity: healthyAt !== null,
            lastHealthyAt: healthyAt,
            lastFailureAt: null,
          }),
          lastInboundAt,
          lastInboundOutcome: null,
          lastDeliveredAt,
          lastFailureAt: null,
          lastFailureOutcome: null,
          lastFailureErrorCode: null,
        });
      }
    }

    return result;
  });
}
