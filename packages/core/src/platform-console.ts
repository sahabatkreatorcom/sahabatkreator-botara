import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  auditLogs,
  authSession,
  channelAccounts,
  contacts,
  conversations,
  messages,
  outboxEvents,
  plans,
  subscriptions,
  tenantMembers,
  tenants,
  users,
  type Database,
} from "@sahabat-kreator/db";
import type { DbTx } from "./tx";

/**
 * Konsol Admin Platform (migrasi 0010) — BACA LINTAS TENANT untuk pemilik
 * platform, plus tiga aksi yang tidak bisa diwakilkan ke tenant:
 * menangguhkan workspace, memaksa logout, dan mencoba ulang event outbox
 * yang sudah dikarantina.
 *
 * Pola keamanannya satu dan sama untuk seluruh berkas ini: setiap fungsi
 * membuka transaksi lalu menyalakan `app.platform_admin`. Tanpa flag itu
 * seluruh tabel ber-RLS mengembalikan nol baris — jadi "lupa menyalakan
 * flag" berakhir sebagai hasil kosong yang kelihatan, bukan kebocoran.
 *
 * Yang TIDAK dilakukan modul ini, dan sengaja: tidak ada satu pun query yang
 * membaca isi pesan pelanggan (hanya hitungan), tidak ada penulisan ke tabel
 * tenant selain `tenants.status*`, dan tidak ada jalur "login sebagai tenant".
 * Konsol mengawasi, bukan mengoperasikan.
 */

/** Jendela agregat yang dipakai konsol; diekspor agar route & UI sepakat. */
export const CONSOLE_WINDOW_HOURS = { day: 24, week: 24 * 7 } as const;

async function withPlatformAdminTx<T>(
  db: Database,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.platform_admin', 'on', true)`);
    return fn(tx as unknown as DbTx);
  });
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/** `count(*)::int` — drizzle mengembalikan bigint sebagai string tanpa cast. */
const intCount = sql<number>`count(*)::int`;

export interface PlatformOverview {
  tenants: { total: number; active: number; suspended: number; newLast7d: number };
  users: { total: number; newLast7d: number };
  channels: { total: number; connected: number };
  messages: { last24h: number; last7d: number; outbound24h: number };
  conversations: { open: number };
  outbox: { pending: number; deadLettered: number };
  audit: { last24h: number };
}

/**
 * Angka satu layar untuk halaman Ringkasan. Semua hitungan dijalankan dalam
 * SATU transaksi supaya angkanya saling konsisten (kalau dijalankan
 * terpisah, tenant bisa "hilang" di antara dua query dan angka tidak
 * pernah cocok dengan daftar di halaman sebelah).
 */
export async function getPlatformOverview(
  db: Database,
): Promise<PlatformOverview> {
  return withPlatformAdminTx(db, async (tx) => {
    const weekAgo = hoursAgo(CONSOLE_WINDOW_HOURS.week);
    const dayAgo = hoursAgo(CONSOLE_WINDOW_HOURS.day);

    const [tenantRows, userRow, channelRow, messageRow, outboundRow, convRow, outboxRow, auditRow] =
      await Promise.all([
        tx
          .select({ status: tenants.status, n: intCount })
          .from(tenants)
          .groupBy(tenants.status),
        tx.select({ n: intCount }).from(users),
        tx
          .select({ status: channelAccounts.status, n: intCount })
          .from(channelAccounts)
          .groupBy(channelAccounts.status),
        tx
          .select({ n: intCount })
          .from(messages)
          .where(gte(messages.createdAt, dayAgo)),
        tx
          .select({ n: intCount })
          .from(messages)
          .where(
            and(
              gte(messages.createdAt, dayAgo),
              eq(messages.direction, "outbound"),
            ),
          ),
        tx
          .select({ n: intCount })
          .from(conversations)
          .where(eq(conversations.status, "open")),
        tx
          .select({
            pending: sql<number>`count(*) FILTER (WHERE ${outboxEvents.publishedAt} IS NULL AND ${outboxEvents.deadLetteredAt} IS NULL)::int`,
            deadLettered: sql<number>`count(*) FILTER (WHERE ${outboxEvents.deadLetteredAt} IS NOT NULL)::int`,
          })
          .from(outboxEvents),
        tx
          .select({ n: intCount })
          .from(auditLogs)
          .where(gte(auditLogs.createdAt, dayAgo)),
      ]);

    const [newTenants] = await tx
      .select({ n: intCount })
      .from(tenants)
      .where(gte(tenants.createdAt, weekAgo));
    const [newUsers] = await tx
      .select({ n: intCount })
      .from(users)
      .where(gte(users.createdAt, weekAgo));
    const [weekMessages] = await tx
      .select({ n: intCount })
      .from(messages)
      .where(gte(messages.createdAt, weekAgo));

    const active = tenantRows.find((r) => r.status === "active")?.n ?? 0;
    const suspended = tenantRows.find((r) => r.status === "suspended")?.n ?? 0;

    return {
      tenants: {
        total: active + suspended,
        active,
        suspended,
        newLast7d: newTenants?.n ?? 0,
      },
      users: { total: userRow[0]?.n ?? 0, newLast7d: newUsers?.n ?? 0 },
      channels: {
        total: channelRow.reduce((sum, r) => sum + r.n, 0),
        connected: channelRow.find((r) => r.status === "connected")?.n ?? 0,
      },
      messages: {
        last24h: messageRow[0]?.n ?? 0,
        last7d: weekMessages?.n ?? 0,
        outbound24h: outboundRow[0]?.n ?? 0,
      },
      conversations: { open: convRow[0]?.n ?? 0 },
      outbox: {
        pending: outboxRow[0]?.pending ?? 0,
        deadLettered: outboxRow[0]?.deadLettered ?? 0,
      },
      audit: { last24h: auditRow[0]?.n ?? 0 },
    };
  });
}

export interface PlatformTenantRow {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  statusReason: string | null;
  createdAt: Date;
  members: number;
  channels: number;
  channelsConnected: number;
  messages7d: number;
  planCode: string | null;
  subscriptionStatus: string | null;
}

export interface ListPlatformTenantsOptions {
  /** Cari pada nama/slug/email owner (ILIKE, maks 100 karakter). */
  query?: string;
  status?: "active" | "suspended";
  limit?: number;
  offset?: number;
}

/**
 * Daftar tenant untuk konsol. N+1 sengaja dihindari: seluruh agregat
 * dikumpulkan dengan satu query per tabel lalu ditempel di JS, karena
 * jumlah tenant pada tahap ini masih kecil dan satu query gabungan yang
 * benar jauh lebih mudah dibaca daripada empat subquery berkorelasi.
 */
export async function listPlatformTenants(
  db: Database,
  options: ListPlatformTenantsOptions = {},
): Promise<{ rows: PlatformTenantRow[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const query = options.query?.trim().slice(0, 100) ?? "";

  return withPlatformAdminTx(db, async (tx) => {
    const filters = [];
    if (query) {
      const like = `%${query}%`;
      filters.push(
        or(ilike(tenants.name, like), ilike(tenants.slug, like)),
      );
    }
    if (options.status) filters.push(eq(tenants.status, options.status));
    const where = filters.length ? and(...filters) : undefined;

    const [totalRow] = await tx
      .select({ n: intCount })
      .from(tenants)
      .where(where);

    const base = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        statusReason: tenants.statusReason,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(where)
      .orderBy(desc(tenants.createdAt))
      .limit(limit)
      .offset(offset);

    const ids = base.map((r) => r.id);
    if (ids.length === 0) return { rows: [], total: totalRow?.n ?? 0 };

    const weekAgo = hoursAgo(CONSOLE_WINDOW_HOURS.week);
    const [memberRows, channelRows, messageRows, subRows] = await Promise.all([
      tx
        .select({ tenantId: tenantMembers.tenantId, n: intCount })
        .from(tenantMembers)
        .where(inArray(tenantMembers.tenantId, ids))
        .groupBy(tenantMembers.tenantId),
      tx
        .select({
          tenantId: channelAccounts.tenantId,
          total: intCount,
          connected:
            sql<number>`count(*) FILTER (WHERE ${channelAccounts.status} = 'connected')::int`,
        })
        .from(channelAccounts)
        .where(inArray(channelAccounts.tenantId, ids))
        .groupBy(channelAccounts.tenantId),
      tx
        .select({ tenantId: messages.tenantId, n: intCount })
        .from(messages)
        .where(
          and(
            inArray(messages.tenantId, ids),
            gte(messages.createdAt, weekAgo),
          ),
        )
        .groupBy(messages.tenantId),
      tx
        .select({
          tenantId: subscriptions.tenantId,
          status: subscriptions.status,
          planCode: plans.code,
        })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(inArray(subscriptions.tenantId, ids)),
    ]);

    const members = new Map(memberRows.map((r) => [r.tenantId, r.n]));
    const channelTotal = new Map(channelRows.map((r) => [r.tenantId, r.total]));
    const channelOk = new Map(channelRows.map((r) => [r.tenantId, r.connected]));
    const msg7d = new Map(messageRows.map((r) => [r.tenantId, r.n]));
    const subs = new Map(subRows.map((r) => [r.tenantId, r]));

    const rows: PlatformTenantRow[] = base.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      statusReason: t.statusReason,
      createdAt: t.createdAt,
      members: members.get(t.id) ?? 0,
      channels: channelTotal.get(t.id) ?? 0,
      channelsConnected: channelOk.get(t.id) ?? 0,
      messages7d: msg7d.get(t.id) ?? 0,
      planCode: subs.get(t.id)?.planCode ?? null,
      subscriptionStatus: subs.get(t.id)?.status ?? null,
    }));

    return { rows, total: totalRow?.n ?? 0 };
  });
}

export interface PlatformTenantMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: Date;
}

export interface PlatformTenantChannel {
  id: string;
  provider: string;
  displayName: string | null;
  status: string;
}

export interface PlatformTenantDetail {
  tenant: PlatformTenantRow;
  members: PlatformTenantMember[];
  channels: PlatformTenantChannel[];
  counts: { contacts: number; conversations: number; messages: number };
  recentAudit: Array<{
    id: string;
    action: string;
    actorType: string;
    actorId: string | null;
    createdAt: Date;
  }>;
}

/** Detail satu tenant. `null` bila id tidak ada — pemanggil menjawab 404. */
export async function getPlatformTenant(
  db: Database,
  tenantId: string,
): Promise<PlatformTenantDetail | null> {
  return withPlatformAdminTx(db, async (tx) => {
    const [tenant] = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        statusReason: tenants.statusReason,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) return null;

    const weekAgo = hoursAgo(CONSOLE_WINDOW_HOURS.week);
    const [memberRows, channelRows, contactRows, convRow, msgRow, msg7dRow, subRow, auditRows] =
      await Promise.all([
        tx
          .select({
            userId: tenantMembers.userId,
            role: tenantMembers.role,
            joinedAt: tenantMembers.createdAt,
            email: users.email,
            name: users.name,
          })
          .from(tenantMembers)
          .innerJoin(users, eq(tenantMembers.userId, users.id))
          .where(eq(tenantMembers.tenantId, tenantId))
          .orderBy(tenantMembers.createdAt),
        tx
          .select({
            id: channelAccounts.id,
            provider: channelAccounts.provider,
            displayName: channelAccounts.displayName,
            status: channelAccounts.status,
          })
          .from(channelAccounts)
          .where(eq(channelAccounts.tenantId, tenantId))
          .orderBy(channelAccounts.provider),
        tx
          .select({ n: intCount })
          .from(contacts)
          .where(eq(contacts.tenantId, tenantId)),
        tx
          .select({ n: intCount })
          .from(conversations)
          .where(eq(conversations.tenantId, tenantId)),
        tx
          .select({ n: intCount })
          .from(messages)
          .where(eq(messages.tenantId, tenantId)),
        tx
          .select({ n: intCount })
          .from(messages)
          .where(
            and(
              eq(messages.tenantId, tenantId),
              gte(messages.createdAt, weekAgo),
            ),
          ),
        tx
          .select({ status: subscriptions.status, planCode: plans.code })
          .from(subscriptions)
          .leftJoin(plans, eq(subscriptions.planId, plans.id))
          .where(eq(subscriptions.tenantId, tenantId))
          .limit(1),
        tx
          .select({
            id: auditLogs.id,
            action: auditLogs.action,
            actorType: auditLogs.actorType,
            actorId: auditLogs.actorId,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(eq(auditLogs.tenantId, tenantId))
          .orderBy(desc(auditLogs.createdAt))
          .limit(15),
      ]);

    return {
      tenant: {
        ...tenant,
        members: memberRows.length,
        channels: channelRows.length,
        channelsConnected: channelRows.filter((c) => c.status === "connected").length,
        messages7d: msg7dRow[0]?.n ?? 0,
        planCode: subRow[0]?.planCode ?? null,
        subscriptionStatus: subRow[0]?.status ?? null,
      },
      members: memberRows,
      channels: channelRows,
      counts: {
        contacts: contactRows[0]?.n ?? 0,
        conversations: convRow[0]?.n ?? 0,
        messages: msgRow[0]?.n ?? 0,
      },
      recentAudit: auditRows,
    };
  });
}

export interface SetTenantStatusInput {
  tenantId: string;
  status: "active" | "suspended";
  reason?: string | null;
  actorUserId: string;
}

/**
 * Menangguhkan / mengaktifkan kembali workspace.
 *
 * Penegakannya BUKAN di sini — fungsi ini hanya menulis status. Yang membuat
 * penangguhan nyata adalah `getTenantForUser` (packages/core/src/tenants.ts)
 * yang menolak tenant non-aktif, sehingga seluruh route bersarang menjawab
 * 404. Memisahkan keduanya penting: kalau penegakan ikut ditulis di sini,
 * jalur lain yang menyelesaikan konteks tenant akan melewatkannya.
 */
export async function setPlatformTenantStatus(
  db: Database,
  input: SetTenantStatusInput,
): Promise<{ id: string; status: "active" | "suspended"; changed: boolean }> {
  return withPlatformAdminTx(db, async (tx) => {
    const [current] = await tx
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    if (!current) throw new Error("TENANT_NOT_FOUND");
    if (current.status === input.status) {
      return { id: current.id, status: current.status, changed: false };
    }

    await tx
      .update(tenants)
      .set({
        status: input.status,
        statusReason:
          input.status === "suspended" ? (input.reason?.slice(0, 500) ?? null) : null,
        statusChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, input.tenantId));

    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.actorUserId,
      action:
        input.status === "suspended"
          ? "platform.tenant.suspended"
          : "platform.tenant.reactivated",
      meta: { reason: input.reason?.slice(0, 500) ?? null },
    });

    return { id: current.id, status: input.status, changed: true };
  });
}

export interface PlatformUserRow {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  memberships: Array<{ tenantId: string; tenantName: string; role: string }>;
  activeSessions: number;
}

/**
 * Cari pengguna lintas tenant (email/nama). Hasil dibatasi 20 dan wajib
 * memakai kata kunci minimal 2 karakter — daftar seluruh pengguna bukan
 * sesuatu yang perlu tersedia satu klik, dan query tanpa filter pada tabel
 * users akan jadi pemindaian penuh.
 */
export async function searchPlatformUsers(
  db: Database,
  rawQuery: string,
): Promise<PlatformUserRow[]> {
  const query = rawQuery.trim().slice(0, 100);
  if (query.length < 2) return [];

  return withPlatformAdminTx(db, async (tx) => {
    const like = `%${query}%`;
    const found = await tx
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
        authUserId: users.authUserId,
      })
      .from(users)
      .where(or(ilike(users.email, like), ilike(users.name, like)))
      .orderBy(users.createdAt)
      .limit(20);

    if (found.length === 0) return [];
    const ids = found.map((u) => u.id);

    const memberRows = await tx
      .select({
        userId: tenantMembers.userId,
        tenantId: tenantMembers.tenantId,
        tenantName: tenants.name,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .where(inArray(tenantMembers.userId, ids));

    const authIds = found
      .map((u) => u.authUserId)
      .filter((v): v is string => Boolean(v));
    const sessionRows = authIds.length
      ? await tx
          .select({ userId: authSession.userId, n: intCount })
          .from(authSession)
          .where(
            and(
              inArray(authSession.userId, authIds),
              gte(authSession.expiresAt, new Date()),
            ),
          )
          .groupBy(authSession.userId)
      : [];
    const sessionCount = new Map(sessionRows.map((r) => [r.userId, r.n]));

    return found.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt,
      memberships: memberRows
        .filter((m) => m.userId === u.id)
        .map((m) => ({
          tenantId: m.tenantId,
          tenantName: m.tenantName,
          role: m.role,
        })),
      activeSessions: u.authUserId ? (sessionCount.get(u.authUserId) ?? 0) : 0,
    }));
  });
}

export interface RevokeSessionsResult {
  revoked: number;
}

/**
 * Paksa logout: hapus SEMUA sesi Better Auth milik user.
 *
 * Sesi disimpan Better Auth di `auth_session` dengan id teks, dihubungkan
 * lewat `users.auth_user_id`. Menghapus barisnya membuat cookie yang masih
 * dipegang browser langsung tidak sah pada request berikutnya — tidak perlu
 * menunggu kedaluwarsa.
 */
export async function revokePlatformUserSessions(
  db: Database,
  input: { userId: string; actorUserId: string },
): Promise<RevokeSessionsResult> {
  return withPlatformAdminTx(db, async (tx) => {
    const [user] = await tx
      .select({ authUserId: users.authUserId, email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user) throw new Error("USER_NOT_FOUND");
    if (!user.authUserId) return { revoked: 0 };

    const deleted = await tx
      .delete(authSession)
      .where(eq(authSession.userId, user.authUserId))
      .returning({ id: authSession.id });

    await tx.insert(auditLogs).values({
      tenantId: null,
      actorType: "user",
      actorId: input.actorUserId,
      action: "platform.user.sessions_revoked",
      meta: { targetUserId: input.userId, targetEmail: user.email, revoked: deleted.length },
    });

    return { revoked: deleted.length };
  });
}

export interface DeadLetterOutboxRow {
  id: string;
  type: string;
  tenantId: string | null;
  tenantName: string | null;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: Date;
  createdAt: Date;
}

/** Event outbox yang menyerah setelah OUTBOX_MAX_ATTEMPTS — perlu tangan manusia. */
export async function listDeadLetterOutbox(
  db: Database,
  limit = 50,
): Promise<DeadLetterOutboxRow[]> {
  return withPlatformAdminTx(db, async (tx) => {
    const rows = await tx
      .select({
        id: outboxEvents.id,
        type: outboxEvents.type,
        tenantId: outboxEvents.tenantId,
        tenantName: tenants.name,
        attempts: outboxEvents.attempts,
        lastError: outboxEvents.lastError,
        deadLetteredAt: outboxEvents.deadLetteredAt,
        createdAt: outboxEvents.createdAt,
      })
      .from(outboxEvents)
      .leftJoin(tenants, eq(outboxEvents.tenantId, tenants.id))
      .where(isNotNull(outboxEvents.deadLetteredAt))
      .orderBy(desc(outboxEvents.deadLetteredAt))
      .limit(Math.min(Math.max(limit, 1), 200));

    return rows.map((r) => ({
      ...r,
      deadLetteredAt: r.deadLetteredAt as Date,
    }));
  });
}

/**
 * Coba ulang satu event yang dikarantina.
 *
 * Yang di-reset hanya `attempts`, `lastError`, dan `deadLetteredAt` — BUKAN
 * payload atau `publishedAt`. Baris yang sudah pernah terbit tidak boleh
 * kembali ke antrean lewat jalur ini; kalau `publishedAt` ikut di-nol-kan,
 * satu klik bisa mengirim ulang pesan yang sudah sampai ke pelanggan.
 */
export async function retryDeadLetterOutbox(
  db: Database,
  input: { id: string; actorUserId: string },
): Promise<{ id: string; retried: boolean }> {
  return withPlatformAdminTx(db, async (tx) => {
    const updated = await tx
      .update(outboxEvents)
      .set({ attempts: 0, lastError: null, deadLetteredAt: null })
      .where(
        and(
          eq(outboxEvents.id, input.id),
          isNotNull(outboxEvents.deadLetteredAt),
          isNull(outboxEvents.publishedAt),
        ),
      )
      .returning({ id: outboxEvents.id });

    if (updated.length === 0) return { id: input.id, retried: false };

    await tx.insert(auditLogs).values({
      tenantId: null,
      actorType: "user",
      actorId: input.actorUserId,
      action: "platform.outbox.retried",
      meta: { eventId: input.id },
    });

    return { id: input.id, retried: true };
  });
}

export interface PlatformSystemStats {
  databaseSize: string;
  serverVersion: string;
  serverTime: string;
  tables: { tenants: number; users: number; contacts: number; conversations: number; messages: number };
}

/**
 * Statistik yang hanya bisa dijawab database. Versi aplikasi & uptime
 * diambil route dari proses API — konsol menampilkan keduanya berdampingan
 * supaya "versi aplikasi" dan "versi Postgres" tidak tertukar.
 */
export async function getPlatformSystemStats(
  db: Database,
): Promise<PlatformSystemStats> {
  return withPlatformAdminTx(db, async (tx) => {
    // `execute` (bukan `select`) karena tidak ada tabel yang masuk akal
    // sebagai FROM: ini metadata cluster. Bentuk hasilnya dibaca lewat
    // `.rows` — sama pada driver node-postgres maupun PGlite, sehingga
    // fungsi ini tetap bisa diuji tanpa server.
    const metaResult = (await tx.execute(
      sql`select pg_size_pretty(pg_database_size(current_database())) as size,
                 version() as version,
                 now()::text as now`,
    )) as unknown as {
      rows: Array<{ size: string; version: string; now: string }>;
    };
    const meta = metaResult.rows?.[0];

    const [tenantCount] = await tx.select({ n: intCount }).from(tenants);
    const [userCount] = await tx.select({ n: intCount }).from(users);
    const [contactCount] = await tx.select({ n: intCount }).from(contacts);
    const [convCount] = await tx.select({ n: intCount }).from(conversations);
    const [msgCount] = await tx.select({ n: intCount }).from(messages);

    return {
      databaseSize: meta?.size ?? "unknown",
      serverVersion: (meta?.version ?? "unknown").split(" ").slice(0, 2).join(" "),
      serverTime: meta?.now ?? new Date().toISOString(),
      tables: {
        tenants: tenantCount?.n ?? 0,
        users: userCount?.n ?? 0,
        contacts: contactCount?.n ?? 0,
        conversations: convCount?.n ?? 0,
        messages: msgCount?.n ?? 0,
      },
    };
  });
}
