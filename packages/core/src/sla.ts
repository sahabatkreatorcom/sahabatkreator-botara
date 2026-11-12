import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  auditLogs,
  conversations,
  memberWorkSchedules,
  messages,
  tenantMembers,
  tenants,
  type Database,
  type WorkSchedule,
} from "@sahabat-kreator/db";
import type {
  SlaReportResponse,
  TenantSlaSettingsResponse,
} from "@sahabat-kreator/contracts";
import {
  localDateOf,
  weekdayOfDate,
  zonedWallToUtcMs,
} from "./appointments";
import { isTeamManager } from "./team";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";

export type { WorkSchedule } from "@sahabat-kreator/db";

/**
 * Jam kerja tim + SLA manusia (G15, Tier 3 butir 15).
 *
 * DEFINISI FINAL JENDELA SLA (juga ditampilkan di UI & kontrak):
 * - Jendela "menunggu balasan manusia" DIBUKA oleh pesan masuk
 *   pelanggan pertama yang belum terjawab manusia dalam sebuah
 *   percakapan (rangkaian pesan masuk sesudahnya tidak membuka
 *   jendela baru), dan DITUTUP HANYA oleh pesan keluar pertama
 *   dengan `sender_type = 'user'` (manusia). Balasan AI ('agent'),
 *   pesan sistem ('system'), dan catatan internal TIDAK PERNAH
 *   menutup jendela.
 * - Jendela hanya dihitung sebagai jendela SLA bila percakapan
 *   sedang menjadi TANGGUNG JAWAB MANUSIA pada saat ia terbuka.
 *   Tanggung jawab = AI percakapan mati (handoff / dinonaktifkan)
 *   ATAU percakapan ditugaskan ke anggota. Intervalnya direplay dari
 *   audit log (`agent.handoff`, `conversation.agent_disabled`,
 *   `conversation.agent_enabled`, `conversation.assigned`,
 *   `conversation.unassigned`) — bukan ditebak dari keadaan akhir.
 *   Percakapan tanpa satu pun peristiwa audit dinilai dari keadaan
 *   saat ini sejak dibuatnya (cadangan warisan pra-audit); bila
 *   replay audit dan keadaan saat ini berbeda, interval korektif
 *   dimulai dari `updated_at` percakapan.
 * - Menit yang terbakar dihitung sejak TANGGUNG JAWAB dimulai untuk
 *   jendela itu (maks antara waktu buka jendela dan awal interval
 *   tanggung jawabnya): tim tidak ditagih waktu sebelum serah terima.
 * - Jadwal yang berlaku: jadwal pribadi anggota PENERIMA TUGAS SAAT
 *   INI; penerima tugas tanpa jadwal pribadi (atau percakapan belum
 *   ditugaskan) memakai jadwal bawaan tenant; bila keduanya kosong,
 *   jam TIDAK berjalan dan jendela dilaporkan tidak terukur.
 * - Status dalam target/terlewat selalu dihitung saat baca dari
 *   messages + audit + jadwal. Tidak ada status SLA tersimpan.
 */

// ---------------------------------------------------------------------------
// Matematika jam kerja (murni, tanpa DB). Konversi zona memakai helper
// bersama dari appointments.ts (`zonedWallToUtcMs`, `localDateOf`,
// `weekdayOfDate`) — satu-satunya implementasi offset/DST di core.
// ---------------------------------------------------------------------------

function parseHhMm(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Total menit kerja per minggu — 0 berarti jam tidak pernah berjalan. */
export function weeklyWorkingMinutes(schedule: WorkSchedule): number {
  let total = 0;
  for (const ranges of Object.values(schedule.days)) {
    for (const r of ranges ?? []) total += parseHhMm(r.end) - parseHhMm(r.start);
  }
  return total;
}

const MAX_DAY_SCAN = 3700; // ±10 tahun — pengaman iterasi, bukan batas bisnis.

/**
 * Menit (pecahan) di antara dua instan yang jatuh di dalam jadwal
 * kerja `schedule` pada zona `timeZone`. Batas rentang bersifat
 * [start, end): tepat di ujung rentang tidak menambah menit.
 */
export function workingMinutesBetween(
  schedule: WorkSchedule,
  timeZone: string,
  from: Date,
  to: Date,
): number {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (toMs <= fromMs) return 0;
  if (weeklyWorkingMinutes(schedule) === 0) return 0;

  const startDate = localDateOf(timeZone, fromMs);
  let dayUtc = Date.UTC(startDate.year, startDate.month - 1, startDate.day);
  let totalMs = 0;
  for (let i = 0; i < MAX_DAY_SCAN; i += 1) {
    const day = new Date(dayUtc);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (i > 0 && zonedWallToUtcMs(timeZone, y, m, d, 0, 0) >= toMs) break;
    const ranges = schedule.days[String(weekdayOfDate(y, m, d))] ?? [];
    for (const range of ranges) {
      const startMin = parseHhMm(range.start);
      const endMin = parseHhMm(range.end);
      const rangeStart = zonedWallToUtcMs(
        timeZone,
        y,
        m,
        d,
        Math.floor(startMin / 60),
        startMin % 60,
      );
      const rangeEnd = zonedWallToUtcMs(
        timeZone,
        y,
        m,
        d,
        Math.floor(endMin / 60),
        endMin % 60,
      );
      const overlapStart = Math.max(rangeStart, fromMs);
      const overlapEnd = Math.min(rangeEnd, toMs);
      if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
    }
    dayUtc += 86_400_000;
  }
  return totalMs / 60_000;
}

/**
 * Instan ketika `targetMinutes` menit kerja terakumulasi sejak `from`
 * menurut jadwal — tenggat SLA. null bila jadwal tidak punya menit
 * kerja sama sekali (tenggat tidak pernah tiba).
 */
export function addWorkingMinutes(
  schedule: WorkSchedule,
  timeZone: string,
  from: Date,
  targetMinutes: number,
): Date | null {
  if (weeklyWorkingMinutes(schedule) === 0) return null;
  const fromMs = from.getTime();
  let remainingMs = targetMinutes * 60_000;
  const startDate = localDateOf(timeZone, fromMs);
  let dayUtc = Date.UTC(startDate.year, startDate.month - 1, startDate.day);
  for (let i = 0; i < MAX_DAY_SCAN; i += 1) {
    const day = new Date(dayUtc);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const ranges = schedule.days[String(weekdayOfDate(y, m, d))] ?? [];
    for (const range of ranges) {
      const startMin = parseHhMm(range.start);
      const endMin = parseHhMm(range.end);
      const rangeStart = zonedWallToUtcMs(
        timeZone,
        y,
        m,
        d,
        Math.floor(startMin / 60),
        startMin % 60,
      );
      const rangeEnd = zonedWallToUtcMs(
        timeZone,
        y,
        m,
        d,
        Math.floor(endMin / 60),
        endMin % 60,
      );
      const segStart = Math.max(rangeStart, fromMs);
      if (rangeEnd <= segStart) continue;
      const available = rangeEnd - segStart;
      if (remainingMs <= available) return new Date(segStart + remainingMs);
      remainingMs -= available;
    }
    dayUtc += 86_400_000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derivasi jendela & interval tanggung jawab (murni)
// ---------------------------------------------------------------------------

export interface SlaMessageLike {
  direction: "inbound" | "outbound";
  senderType: string;
  createdAt: Date;
}

export interface SlaWindow {
  openedAt: Date;
  closedAt: Date | null;
}

/**
 * Jendela menunggu dari arus pesan SATU percakapan (urut waktu naik):
 * dibuka pesan masuk pertama sesudah penutupan terakhir, ditutup
 * HANYA pesan keluar `senderType='user'`. Pesan keluar 'agent' dan
 * 'system' dilewati seolah tidak ada.
 */
export function deriveWindows(messagesAsc: SlaMessageLike[]): SlaWindow[] {
  const windows: SlaWindow[] = [];
  let open: SlaWindow | null = null;
  for (const msg of messagesAsc) {
    if (msg.direction === "inbound") {
      if (!open) {
        open = { openedAt: msg.createdAt, closedAt: null };
        windows.push(open);
      }
    } else if (msg.senderType === "user") {
      if (open) {
        open.closedAt = msg.createdAt;
        open = null;
      }
    }
  }
  return windows;
}

export interface ResponsibilityInterval {
  start: Date;
  end: Date | null;
}

const AUDIT_ON_AI_OFF = new Set(["agent.handoff", "conversation.agent_disabled"]);
const RESPONSIBILITY_ACTIONS = [
  "agent.handoff",
  "conversation.agent_disabled",
  "conversation.agent_enabled",
  "conversation.assigned",
  "conversation.unassigned",
] as const;

export interface ResponsibilityEvent {
  action: string;
  at: Date;
}

/**
 * Replay interval tanggung jawab manusia dari peristiwa audit SATU
 * percakapan. Keadaan awal: AI menyala + belum ditugaskan (bawaan
 * kolom). `current` adalah keadaan baris percakapan saat ini —
 * dipakai untuk (a) cadangan warisan bila tidak ada peristiwa sama
 * sekali, dan (b) interval korektif dari `updatedAt` bila replay
 * berakhir berbeda dari keadaan kini (penulis lama tanpa audit).
 */
export function responsibilityIntervals(
  eventsAsc: ResponsibilityEvent[],
  input: {
    createdAt: Date;
    updatedAt: Date;
    current: { aiOff: boolean; assigned: boolean };
  },
): ResponsibilityInterval[] {
  const intervals: ResponsibilityInterval[] = [];
  if (eventsAsc.length === 0) {
    if (input.current.aiOff || input.current.assigned) {
      intervals.push({ start: input.createdAt, end: null });
    }
    return intervals;
  }
  let aiOff = false;
  let assigned = false;
  let openStart: Date | null = null;
  const apply = (at: Date) => {
    const responsible = aiOff || assigned;
    if (responsible && openStart === null) openStart = at;
    if (!responsible && openStart !== null) {
      intervals.push({ start: openStart, end: at });
      openStart = null;
    }
  };
  for (const event of eventsAsc) {
    if (AUDIT_ON_AI_OFF.has(event.action)) aiOff = true;
    else if (event.action === "conversation.agent_enabled") aiOff = false;
    else if (event.action === "conversation.assigned") assigned = true;
    else if (event.action === "conversation.unassigned") assigned = false;
    else continue;
    apply(event.at);
  }
  // Koreksi warisan: replay berakhir ≠ keadaan baris saat ini.
  const replayResponsible = aiOff || assigned;
  const currentResponsible = input.current.aiOff || input.current.assigned;
  if (replayResponsible !== currentResponsible) {
    if (openStart !== null) {
      intervals.push({ start: openStart, end: input.updatedAt });
      openStart = null;
    }
    if (currentResponsible) openStart = input.updatedAt;
  }
  if (openStart !== null) intervals.push({ start: openStart, end: null });
  return intervals;
}

/** Interval yang memuat instan `at` (end null = masih berjalan). */
export function intervalAt(
  intervals: ResponsibilityInterval[],
  at: Date,
): ResponsibilityInterval | null {
  const t = at.getTime();
  for (const interval of intervals) {
    if (interval.start.getTime() <= t && (interval.end === null || interval.end.getTime() > t)) {
      return interval;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Jadwal kerja anggota & pengaturan SLA tenant
// ---------------------------------------------------------------------------

export interface MemberWorkScheduleView {
  userId: string;
  timezone: string | null;
  schedule: WorkSchedule | null;
  updatedAt: Date | null;
}

export async function getMemberWorkSchedule(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  userId: string,
): Promise<MemberWorkScheduleView> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(memberWorkSchedules)
      .where(
        and(
          eq(memberWorkSchedules.tenantId, ctx.tenantId),
          eq(memberWorkSchedules.userId, userId),
        ),
      )
      .limit(1);
    if (!row) {
      return { userId, timezone: null, schedule: null, updatedAt: null };
    }
    return {
      userId,
      timezone: row.timezone,
      schedule: row.week,
      updatedAt: row.updatedAt,
    };
  });
}

export type UpsertMemberScheduleResult =
  | { kind: "updated"; view: MemberWorkScheduleView }
  | { kind: "forbidden" }
  | { kind: "member_not_found" };

/**
 * Simpan jadwal pribadi seorang anggota. Gerbang (ditegakkan DI SINI):
 * aktor harus member tenant ini; menulis jadwal SENDIRI selalu boleh,
 * menulis jadwal ORANG LAIN hanya owner/admin. Sasaran harus member.
 */
export async function upsertMemberWorkSchedule(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: {
    targetUserId: string;
    timezone: string | null;
    schedule: WorkSchedule;
  },
): Promise<UpsertMemberScheduleResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const gate = await checkScheduleWriteGate(tx, ctx, input.targetUserId);
    if (gate !== "ok") return { kind: gate } as const;
    const [row] = await tx
      .insert(memberWorkSchedules)
      .values({
        tenantId: ctx.tenantId,
        userId: input.targetUserId,
        timezone: input.timezone,
        week: input.schedule,
      })
      .onConflictDoUpdate({
        target: [memberWorkSchedules.tenantId, memberWorkSchedules.userId],
        set: {
          timezone: input.timezone,
          week: input.schedule,
          updatedAt: new Date(),
        },
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "team.work_schedule_updated",
      meta: { userId: input.targetUserId },
    });
    return {
      kind: "updated",
      view: {
        userId: input.targetUserId,
        timezone: row!.timezone,
        schedule: row!.week,
        updatedAt: row!.updatedAt,
      },
    } as const;
  });
}

export type DeleteMemberScheduleResult =
  | { kind: "deleted" }
  | { kind: "forbidden" }
  | { kind: "member_not_found" };

/** Hapus jadwal pribadi → anggota kembali jatuh ke jadwal bawaan tenant. */
export async function deleteMemberWorkSchedule(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  targetUserId: string,
): Promise<DeleteMemberScheduleResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const gate = await checkScheduleWriteGate(tx, ctx, targetUserId);
    if (gate !== "ok") return { kind: gate } as const;
    await tx
      .delete(memberWorkSchedules)
      .where(
        and(
          eq(memberWorkSchedules.tenantId, ctx.tenantId),
          eq(memberWorkSchedules.userId, targetUserId),
        ),
      );
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "team.work_schedule_deleted",
      meta: { userId: targetUserId },
    });
    return { kind: "deleted" } as const;
  });
}

async function checkScheduleWriteGate(
  tx: DbTx,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  targetUserId: string,
): Promise<"ok" | "forbidden" | "member_not_found"> {
  const members = await tx
    .select({ userId: tenantMembers.userId, role: tenantMembers.role })
    .from(tenantMembers)
    .where(
      and(
        eq(tenantMembers.tenantId, ctx.tenantId),
        inArray(tenantMembers.userId, [ctx.userId, targetUserId]),
      ),
    );
  const actor = members.find((m) => m.userId === ctx.userId);
  if (!actor) return "forbidden";
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) return "member_not_found";
  if (ctx.userId !== targetUserId && !isTeamManager(actor.role)) {
    return "forbidden";
  }
  return "ok";
}

export async function getTenantSlaSettings(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<TenantSlaSettingsResponse> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [tenant] = await tx
      .select({
        slaTargetMinutes: tenants.slaTargetMinutes,
        defaultWorkSchedule: tenants.defaultWorkSchedule,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1);
    return {
      targetMinutes: tenant?.slaTargetMinutes ?? null,
      defaultSchedule: tenant?.defaultWorkSchedule ?? null,
      timezone: tenant?.timezone ?? "Asia/Jakarta",
    };
  });
}

/**
 * Ubah pengaturan SLA tenant (target + jadwal bawaan). Gerbang peran
 * owner/admin ditegakkan route; di sini pola transaksi baris tenant
 * yang sama dengan `updateTenantDefaultCurrency` + audit from/to
 * untuk target (jadwal tidak disalin ke audit — bentuknya besar dan
 * bukan rahasia, cukup penanda berubah).
 */
export async function updateTenantSlaSettings(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    targetMinutes: number | null;
    defaultSchedule: WorkSchedule | null;
  },
): Promise<TenantSlaSettingsResponse | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`,
    );
    const [before] = await tx
      .select({
        slaTargetMinutes: tenants.slaTargetMinutes,
        defaultWorkSchedule: tenants.defaultWorkSchedule,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    if (!before) return null;
    const [updated] = await tx
      .update(tenants)
      .set({
        slaTargetMinutes: input.targetMinutes,
        defaultWorkSchedule: input.defaultSchedule,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, input.tenantId))
      .returning({
        slaTargetMinutes: tenants.slaTargetMinutes,
        defaultWorkSchedule: tenants.defaultWorkSchedule,
        timezone: tenants.timezone,
      });
    if (!updated) return null;
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "tenant.sla_settings_updated",
      meta: {
        targetFrom: before.slaTargetMinutes,
        targetTo: input.targetMinutes,
        defaultScheduleChanged:
          JSON.stringify(before.defaultWorkSchedule) !==
          JSON.stringify(input.defaultSchedule),
      },
    });
    return {
      targetMinutes: updated.slaTargetMinutes,
      defaultSchedule: updated.defaultWorkSchedule,
      timezone: updated.timezone,
    };
  });
}

// ---------------------------------------------------------------------------
// Resolusi jadwal yang berlaku untuk sebuah percakapan
// ---------------------------------------------------------------------------

interface ResolvedSchedule {
  schedule: WorkSchedule;
  timeZone: string;
  source: "member" | "tenant";
}

function resolveSchedule(input: {
  assigneeUserId: string | null;
  memberSchedules: Map<string, { timezone: string | null; week: WorkSchedule }>;
  tenantDefault: WorkSchedule | null;
  tenantTimezone: string;
}): ResolvedSchedule | null {
  if (input.assigneeUserId) {
    const own = input.memberSchedules.get(input.assigneeUserId);
    if (own) {
      return {
        schedule: own.week,
        timeZone: own.timezone ?? input.tenantTimezone,
        source: "member",
      };
    }
  }
  if (input.tenantDefault) {
    return {
      schedule: input.tenantDefault,
      timeZone: input.tenantTimezone,
      source: "tenant",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keadaan SLA jendela terbuka per percakapan (untuk Inbox)
// ---------------------------------------------------------------------------

export interface ConversationSlaState {
  openedAt: Date;
  targetMinutes: number;
  scheduleSource: "member" | "tenant" | "none";
  measured: boolean;
  elapsedWorkingMinutes: number | null;
  remainingWorkingMinutes: number | null;
  deadlineAt: Date | null;
  breached: boolean;
}

interface ConversationRow {
  id: string;
  assigneeUserId: string | null;
  agentEnabled: boolean;
  kind: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

async function fetchResponsibilityEvents(
  tx: DbTx,
  tenantId: string,
  conversationIds: string[],
): Promise<Map<string, ResponsibilityEvent[]>> {
  const byConversation = new Map<string, ResponsibilityEvent[]>();
  if (conversationIds.length === 0) return byConversation;
  const rows = await tx
    .select({
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      meta: auditLogs.meta,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, tenantId),
        inArray(auditLogs.action, [...RESPONSIBILITY_ACTIONS]),
        sql`${auditLogs.meta}->>'conversationId' IN (${sql.join(
          conversationIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(asc(auditLogs.createdAt));
  for (const row of rows) {
    const conversationId = (row.meta as { conversationId?: unknown })
      ?.conversationId;
    if (typeof conversationId !== "string") continue;
    const list = byConversation.get(conversationId) ?? [];
    list.push({ action: row.action, at: row.createdAt });
    byConversation.set(conversationId, list);
  }
  return byConversation;
}

function intervalsFor(
  conv: ConversationRow,
  events: ResponsibilityEvent[],
): ResponsibilityInterval[] {
  return responsibilityIntervals(events, {
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    current: {
      aiOff: !conv.agentEnabled,
      assigned: conv.assigneeUserId !== null,
    },
  });
}

/**
 * Keadaan SLA untuk sekumpulan percakapan (satu halaman Inbox).
 * Mengembalikan entri hanya untuk percakapan dengan jendela SLA
 * terbuka; percakapan lain tidak ada di peta (= `sla: null` di API).
 */
export async function getConversationSlaStates(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  conversationIds: string[],
  now: Date = new Date(),
): Promise<Map<string, ConversationSlaState>> {
  const states = new Map<string, ConversationSlaState>();
  if (conversationIds.length === 0) return states;
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [tenant] = await tx
      .select({
        slaTargetMinutes: tenants.slaTargetMinutes,
        defaultWorkSchedule: tenants.defaultWorkSchedule,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1);
    const target = tenant?.slaTargetMinutes ?? null;
    if (!tenant || target === null) return states;

    const convs = await tx
      .select({
        id: conversations.id,
        assigneeUserId: conversations.assigneeUserId,
        agentEnabled: conversations.agentEnabled,
        kind: conversations.kind,
        status: conversations.status,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, ctx.tenantId),
          inArray(conversations.id, conversationIds),
        ),
      );
    const open = convs.filter((c) => c.kind !== "channel" && c.status !== "closed");
    if (open.length === 0) return states;
    const openIds = open.map((c) => c.id);

    const assigneeIds = [
      ...new Set(open.map((c) => c.assigneeUserId).filter((v) => v !== null)),
    ] as string[];
    const memberSchedules = new Map<
      string,
      { timezone: string | null; week: WorkSchedule }
    >();
    if (assigneeIds.length > 0) {
      const rows = await tx
        .select()
        .from(memberWorkSchedules)
        .where(
          and(
            eq(memberWorkSchedules.tenantId, ctx.tenantId),
            inArray(memberWorkSchedules.userId, assigneeIds),
          ),
        );
      for (const row of rows) {
        memberSchedules.set(row.userId, {
          timezone: row.timezone,
          week: row.week,
        });
      }
    }

    const eventsByConversation = await fetchResponsibilityEvents(
      tx,
      ctx.tenantId,
      openIds,
    );

    // Jendela terbuka per percakapan: pesan masuk pertama sesudah
    // balasan manusia terakhir (atau yang pertama sama sekali).
    const windowRows = await tx.execute(sql`
      SELECT m.conversation_id AS conversation_id,
             min(m.created_at) AS first_inbound
      FROM messages m
      LEFT JOIN (
        SELECT conversation_id, max(created_at) AS last_human_out
        FROM messages
        WHERE tenant_id = ${ctx.tenantId}
          AND direction = 'outbound'
          AND sender_type = 'user'
          AND conversation_id IN (${sql.join(
            openIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        GROUP BY conversation_id
      ) h ON h.conversation_id = m.conversation_id
      WHERE m.tenant_id = ${ctx.tenantId}
        AND m.direction = 'inbound'
        AND m.conversation_id IN (${sql.join(
          openIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND (h.last_human_out IS NULL OR m.created_at > h.last_human_out)
      GROUP BY m.conversation_id
    `);
    const firstInboundByConversation = new Map<string, Date>();
    for (const row of (
      windowRows as unknown as {
        rows: { conversation_id: string; first_inbound: Date | string }[];
      }
    ).rows) {
      firstInboundByConversation.set(
        row.conversation_id,
        new Date(row.first_inbound),
      );
    }

    for (const conv of open) {
      const openedAt = firstInboundByConversation.get(conv.id);
      if (!openedAt) continue;
      const intervals = intervalsFor(
        conv,
        eventsByConversation.get(conv.id) ?? [],
      );
      const interval = intervalAt(intervals, now);
      if (!interval) continue;
      const effectiveStart =
        openedAt.getTime() > interval.start.getTime()
          ? openedAt
          : interval.start;
      const resolved = resolveSchedule({
        assigneeUserId: conv.assigneeUserId,
        memberSchedules,
        tenantDefault: tenant.defaultWorkSchedule,
        tenantTimezone: tenant.timezone,
      });
      if (!resolved || weeklyWorkingMinutes(resolved.schedule) === 0) {
        states.set(conv.id, {
          openedAt,
          targetMinutes: target,
          scheduleSource: resolved?.source ?? "none",
          measured: false,
          elapsedWorkingMinutes: null,
          remainingWorkingMinutes: null,
          deadlineAt: null,
          breached: false,
        });
        continue;
      }
      const elapsed = workingMinutesBetween(
        resolved.schedule,
        resolved.timeZone,
        effectiveStart,
        now,
      );
      const remaining = target - elapsed;
      states.set(conv.id, {
        openedAt,
        targetMinutes: target,
        scheduleSource: resolved.source,
        measured: true,
        elapsedWorkingMinutes: elapsed,
        remainingWorkingMinutes: remaining,
        deadlineAt: addWorkingMinutes(
          resolved.schedule,
          resolved.timeZone,
          effectiveStart,
          target,
        ),
        breached: remaining < 0,
      });
    }
    return states;
  });
}

// ---------------------------------------------------------------------------
// Laporan SLA (Analitik)
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export async function getSlaReport(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: { days: number; now?: Date },
): Promise<SlaReportResponse> {
  const days = Math.min(90, Math.max(1, Math.floor(input.days) || 30));
  const now = input.now ?? new Date();
  const periodStart = new Date(now.getTime() - days * 86_400_000);
  const empty: SlaReportResponse = {
    days,
    targetMinutes: null,
    windowsOpened: 0,
    closedOnTime: 0,
    closedBreached: 0,
    openWithinTarget: 0,
    openBreached: 0,
    unmeasured: 0,
    medianWorkingResponseMinutes: null,
    closedMeasuredSamples: 0,
  };

  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [tenant] = await tx
      .select({
        slaTargetMinutes: tenants.slaTargetMinutes,
        defaultWorkSchedule: tenants.defaultWorkSchedule,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1);
    if (!tenant) return empty;
    const target = tenant.slaTargetMinutes;
    const report: SlaReportResponse = { ...empty, targetMinutes: target };

    const convs = await tx
      .select({
        id: conversations.id,
        assigneeUserId: conversations.assigneeUserId,
        agentEnabled: conversations.agentEnabled,
        kind: conversations.kind,
        status: conversations.status,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(eq(conversations.tenantId, ctx.tenantId));
    const scoped = convs.filter((c) => c.kind !== "channel");
    if (scoped.length === 0) return report;
    const scopedIds = scoped.map((c) => c.id);

    const assigneeIds = [
      ...new Set(scoped.map((c) => c.assigneeUserId).filter((v) => v !== null)),
    ] as string[];
    const memberSchedules = new Map<
      string,
      { timezone: string | null; week: WorkSchedule }
    >();
    if (assigneeIds.length > 0) {
      const rows = await tx
        .select()
        .from(memberWorkSchedules)
        .where(
          and(
            eq(memberWorkSchedules.tenantId, ctx.tenantId),
            inArray(memberWorkSchedules.userId, assigneeIds),
          ),
        );
      for (const row of rows) {
        memberSchedules.set(row.userId, {
          timezone: row.timezone,
          week: row.week,
        });
      }
    }

    const eventsByConversation = await fetchResponsibilityEvents(
      tx,
      ctx.tenantId,
      scopedIds,
    );

    // Keadaan awal periode per percakapan: apakah ada jendela yang
    // sudah terbuka saat periode mulai (dibuka sebelum periode →
    // tidak dihitung, tetapi menutupnya di periode juga tidak).
    const preRows = await tx.execute(sql`
      SELECT m.conversation_id AS conversation_id,
             min(m.created_at) AS first_inbound
      FROM messages m
      LEFT JOIN (
        SELECT conversation_id, max(created_at) AS last_human_out
        FROM messages
        WHERE tenant_id = ${ctx.tenantId}
          AND direction = 'outbound'
          AND sender_type = 'user'
          AND created_at < ${periodStart.toISOString()}
        GROUP BY conversation_id
      ) h ON h.conversation_id = m.conversation_id
      WHERE m.tenant_id = ${ctx.tenantId}
        AND m.direction = 'inbound'
        AND m.created_at < ${periodStart.toISOString()}
        AND (h.last_human_out IS NULL OR m.created_at > h.last_human_out)
      GROUP BY m.conversation_id
    `);
    const preOpenByConversation = new Map<string, Date>();
    for (const row of (
      preRows as unknown as {
        rows: { conversation_id: string; first_inbound: Date | string }[];
      }
    ).rows) {
      preOpenByConversation.set(row.conversation_id, new Date(row.first_inbound));
    }

    const periodMessages = await tx
      .select({
        conversationId: messages.conversationId,
        direction: messages.direction,
        senderType: messages.senderType,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, ctx.tenantId),
          inArray(messages.conversationId, scopedIds),
          gt(messages.createdAt, periodStart),
          lt(messages.createdAt, now),
          sql`(${messages.direction} = 'inbound' OR ${messages.senderType} = 'user')`,
        ),
      )
      .orderBy(asc(messages.createdAt));

    const messagesByConversation = new Map<string, SlaMessageLike[]>();
    for (const msg of periodMessages) {
      const list = messagesByConversation.get(msg.conversationId) ?? [];
      list.push({
        direction: msg.direction,
        senderType: msg.senderType,
        createdAt: msg.createdAt,
      });
      messagesByConversation.set(msg.conversationId, list);
    }

    const closedWorkingMinutes: number[] = [];
    for (const conv of scoped) {
      const stream: SlaMessageLike[] = [];
      const preOpen = preOpenByConversation.get(conv.id);
      if (preOpen) {
        stream.push({
          direction: "inbound",
          senderType: "contact",
          createdAt: preOpen,
        });
      }
      stream.push(...(messagesByConversation.get(conv.id) ?? []));
      if (stream.length === 0) continue;
      const intervals = intervalsFor(
        conv,
        eventsByConversation.get(conv.id) ?? [],
      );
      if (intervals.length === 0) continue;
      const resolved = resolveSchedule({
        assigneeUserId: conv.assigneeUserId,
        memberSchedules,
        tenantDefault: tenant.defaultWorkSchedule,
        tenantTimezone: tenant.timezone,
      });
      const measured =
        resolved !== null && weeklyWorkingMinutes(resolved.schedule) > 0;
      for (const window of deriveWindows(stream)) {
        if (window.openedAt.getTime() < periodStart.getTime()) continue;
        const interval = intervalAt(intervals, window.openedAt);
        if (!interval) continue;
        report.windowsOpened += 1;
        if (!measured || !resolved) {
          report.unmeasured += 1;
          continue;
        }
        if (target === null) continue;
        const effectiveStart =
          window.openedAt.getTime() > interval.start.getTime()
            ? window.openedAt
            : interval.start;
        if (window.closedAt) {
          const spent = workingMinutesBetween(
            resolved.schedule,
            resolved.timeZone,
            effectiveStart,
            window.closedAt,
          );
          closedWorkingMinutes.push(spent);
          if (spent > target) report.closedBreached += 1;
          else report.closedOnTime += 1;
        } else {
          const spent = workingMinutesBetween(
            resolved.schedule,
            resolved.timeZone,
            effectiveStart,
            now,
          );
          if (spent > target) report.openBreached += 1;
          else report.openWithinTarget += 1;
        }
      }
    }
    report.closedMeasuredSamples = closedWorkingMinutes.length;
    report.medianWorkingResponseMinutes = median(closedWorkingMinutes);
    return report;
  });
}
