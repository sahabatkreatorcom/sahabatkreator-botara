import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  auditLogs,
  conversations,
  invitations,
  tenantMembers,
  tenants,
  users,
  type Database,
  type Invitation,
  type TenantMember,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";
import type { MemberRole } from "./tenants";

/**
 * Tim workspace (Fase 9C): daftar member, undangan bertoken, perubahan
 * peran, dan pengeluaran member.
 *
 * FONDASI YANG SUDAH ADA: tabel `invitations` (migrasi 0000) memang
 * dibuat sejak Fase 1A — email, role, token_hash (hanya HASH), expires_at,
 * accepted_at — tetapi tidak pernah punya API; fase ini melengkapinya
 * dengan `revoked_at` (0035) + seluruh permukaan kelolanya.
 *
 * Model undangan:
 * - Token mentah (32 byte acak, base64url) HANYA hidup di tautan
 *   `/invite/:token` yang ditampilkan SEKALI saat pembuatan (pola kunci
 *   API 5A: yang tersimpan hanya SHA-256-nya). Daftar undangan karena
 *   itu tidak bisa menampilkan ulang tautan lama — untuk tautan baru,
 *   cabut & undang ulang.
 * - Masa berlaku 7 hari. Mengundang email yang masih punya undangan
 *   pending MENIMPA undangan lamanya (yang lama dicabut otomatis) —
 *   hanya satu tautan yang hidup per email.
 * - Penerimaan: sesi login dengan email yang SAMA (dicocokkan dari baris
 *   `users` sesi, bukan dari klaim pemanggil). Lookup baris undangan
 *   berjalan lewat lengan RLS `invitation_token_lookup` (0035): transaksi
 *   menyetel `app.invitation_token_hash`, policy membuka tepat baris itu.
 *   Penulisan keanggotaan lalu berjalan dalam konteks tenant baris
 *   tersebut (pola lengan lookup 0006/0012/0016).
 * - Email undangan (Fase 11B): lapisan API mengantrekan pengiriman
 *   lewat event outbox `team.invitation_email_requested` ke job
 *   `team.invitation_email` (modul `email.ts`) yang mengirim via Resend
 *   bila platform terkonfigurasi; hasil kirim tercatat di kolom
 *   `email_sent_at` / `email_error` baris ini. Modul ini sendiri tetap
 *   tidak tahu email — invariant hash-only token dijaga dengan
 *   mengenkripsi token ke payload outbox (lihat email.ts).
 *
 * Invariant kepemilikan (ditegakkan DI SINI, bukan hanya UI):
 * - Peran `owner` tidak bisa diberikan, diturunkan, atau dikeluarkan
 *   lewat permukaan tim mana pun → workspace selalu punya ≥1 owner.
 * - Member tidak bisa mengeluarkan / mengubah peran dirinya lewat
 *   endpoint tim (self-action ditolak); keluar workspace bukan fitur v1.
 * - Mengeluarkan member men-NULL-kan penugasannya di percakapan tenant
 *   ini (percobaan kembali ke "belum ditugaskan", bukan menggantung ke
 *   user yang sudah bukan member).
 *
 * Audit: team.invited / team.invitation_revoked / team.member_joined /
 * team.role_changed / team.member_removed — meta berisi ID saja.
 */

export type InvitableRole = Exclude<MemberRole, "owner">;
export type { Invitation } from "@sahabat-kreator/db";
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/** Masa berlaku undangan: 7 hari sejak dibuat. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MANAGER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export function isTeamManager(role: string): boolean {
  return MANAGER_ROLES.has(role);
}

/** Status turunan undangan dari kolom-kolom waktunya (sumber kebenaran tunggal). */
export function invitationStatus(
  row: Pick<Invitation, "acceptedAt" | "revokedAt" | "expiresAt">,
  now: Date = new Date(),
): InvitationStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface TeamMemberRow {
  userId: string;
  email: string;
  name: string | null;
  role: MemberRole;
  /** Detak kehadiran terakhir (G13 butir 9); null = belum pernah tercatat. */
  lastSeenAt: Date | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Daftar member
// ---------------------------------------------------------------------------

export async function listTeamMembers(
  db: Database,
  input: { tenantId: string },
): Promise<TeamMemberRow[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const rows = await tx
      .select({
        userId: tenantMembers.userId,
        role: tenantMembers.role,
        createdAt: tenantMembers.createdAt,
        email: users.email,
        name: users.name,
        lastSeenAt: users.lastSeenAt,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(tenantMembers.userId, users.id))
      .where(eq(tenantMembers.tenantId, input.tenantId))
      .orderBy(asc(tenantMembers.createdAt), asc(users.email));
    // Owner selalu di atas (urutan pembuatan menaruhnya pertama dalam
    // praktik; sortir eksplisit menjaga itu saat owner bertambah jalur lain).
    return rows.sort((a, b) =>
      a.role === "owner" && b.role !== "owner"
        ? -1
        : b.role === "owner" && a.role !== "owner"
          ? 1
          : 0,
    );
  });
}

// ---------------------------------------------------------------------------
// Kehadiran tim (G13 butir 9)
// ---------------------------------------------------------------------------

/**
 * Jeda tulis minimum detak kehadiran: heartbeat klien boleh datang
 * tiap ±60 detik; baris `users` hanya ditulis ulang bila stempelnya
 * lebih tua dari ambang ini — satu UPDATE bersyarat, tanpa baca-tulis
 * terpisah, jadi detak bersamaan tidak saling menimpa mundur.
 */
export const PRESENCE_HEARTBEAT_MIN_INTERVAL_MS = 45_000;

/** Ambang "online" untuk tampilan: detak ≤2 menit yang lalu. */
export const PRESENCE_ONLINE_WINDOW_MS = 2 * 60_000;

/**
 * Mencatat detak kehadiran satu user (menulis `users.last_seen_at`).
 * Tabel users global tanpa RLS — tidak butuh konteks tenant; endpoint
 * heartbeat tetap memintanya lewat keanggotaan tenant (gerbang sesi).
 */
export async function touchUserPresence(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const staleBefore = new Date(
    now.getTime() - PRESENCE_HEARTBEAT_MIN_INTERVAL_MS,
  );
  await db
    .update(users)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.lastSeenAt), lt(users.lastSeenAt, staleBefore)),
      ),
    );
}

// ---------------------------------------------------------------------------
// Undangan — kelola (konteks tenant)
// ---------------------------------------------------------------------------

export async function listInvitations(
  db: Database,
  input: { tenantId: string },
): Promise<Invitation[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    return tx
      .select()
      .from(invitations)
      .where(eq(invitations.tenantId, input.tenantId))
      .orderBy(asc(invitations.createdAt));
  });
}

export type CreateInvitationResult =
  | { kind: "created"; invitation: Invitation; token: string }
  | { kind: "already_member" };

export async function createInvitation(
  db: Database,
  input: {
    tenantId: string;
    actorUserId: string;
    email: string;
    role: InvitableRole;
  },
): Promise<CreateInvitationResult> {
  const email = input.email.trim().toLowerCase();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInvitationToken(token);
  return withTenantDb(db, input.tenantId, async (tx) => {
    // Email yang sudah member tidak bisa diundang lagi.
    const [existingMember] = await tx
      .select({ id: tenantMembers.id })
      .from(tenantMembers)
      .innerJoin(users, eq(tenantMembers.userId, users.id))
      .where(
        and(
          eq(tenantMembers.tenantId, input.tenantId),
          sql`lower(${users.email}) = ${email}`,
        ),
      )
      .limit(1);
    if (existingMember) return { kind: "already_member" } as const;

    // Satu tautan hidup per email: undangan pending lama untuk email ini
    // dicabut otomatis (ditumpa), agar tidak ada dua token yang berlaku.
    const now = new Date();
    await tx
      .update(invitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(invitations.tenantId, input.tenantId),
          sql`lower(${invitations.email}) = ${email}`,
          sql`${invitations.acceptedAt} IS NULL`,
          sql`${invitations.revokedAt} IS NULL`,
        ),
      );

    const [row] = await tx
      .insert(invitations)
      .values({
        tenantId: input.tenantId,
        email,
        role: input.role,
        tokenHash,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "team.invited",
      meta: { invitationId: row.id, role: input.role },
    });
    return { kind: "created", invitation: row, token } as const;
  });
}

export type RevokeInvitationResult =
  | { kind: "revoked" }
  | { kind: "not_found" }
  | { kind: "not_pending" };

export async function revokeInvitation(
  db: Database,
  input: { tenantId: string; actorUserId: string; invitationId: string },
): Promise<RevokeInvitationResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, input.tenantId),
          eq(invitations.id, input.invitationId),
        ),
      )
      .limit(1);
    if (!row) return { kind: "not_found" } as const;
    if (invitationStatus(row) !== "pending") {
      return { kind: "not_pending" } as const;
    }
    const now = new Date();
    await tx
      .update(invitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(invitations.id, row.id));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "team.invitation_revoked",
      meta: { invitationId: row.id },
    });
    return { kind: "revoked" } as const;
  });
}

// ---------------------------------------------------------------------------
// Undangan — sisi penerima (lookup bertoken, tanpa konteks tenant lebih dulu)
// ---------------------------------------------------------------------------

export interface InvitationLookup {
  invitation: Invitation;
  tenantName: string;
}

/**
 * Transaksi lookup penerima undangan: menyetel `app.invitation_token_hash`
 * agar policy `invitation_token_lookup` (0035) membuka tepat satu baris
 * undangan pemilik hash itu — tanpa konteks tenant, tanpa membuka baris
 * lain. `tenants` tidak ber-RLS sehingga nama workspace ikut terbaca.
 */
async function withInvitationLookupTx<T>(
  db: Database,
  tokenHash: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.invitation_token_hash', ${tokenHash}, true)`,
    );
    return fn(tx as unknown as DbTx);
  });
}

export async function findInvitationByToken(
  db: Database,
  token: string,
): Promise<InvitationLookup | null> {
  const tokenHash = hashInvitationToken(token);
  return withInvitationLookupTx(db, tokenHash, async (tx) => {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    const [tenant] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId))
      .limit(1);
    return { invitation: row, tenantName: tenant?.name ?? "" };
  });
}

export type AcceptInvitationResult =
  | { kind: "accepted"; tenantId: string; role: MemberRole }
  | { kind: "not_found" }
  | { kind: "already_accepted" }
  | { kind: "revoked" }
  | { kind: "expired" }
  | { kind: "email_mismatch" };

export async function acceptInvitation(
  db: Database,
  input: { token: string; userId: string; email: string },
): Promise<AcceptInvitationResult> {
  const lookup = await findInvitationByToken(db, input.token);
  if (!lookup) return { kind: "not_found" } as const;
  const { invitation } = lookup;
  const status = invitationStatus(invitation);
  if (status === "accepted") return { kind: "already_accepted" } as const;
  if (status === "revoked") return { kind: "revoked" } as const;
  if (status === "expired") return { kind: "expired" } as const;
  if (invitation.email.toLowerCase() !== input.email.trim().toLowerCase()) {
    return { kind: "email_mismatch" } as const;
  }

  return withTenantDb(db, invitation.tenantId, async (tx) => {
    // Baca ulang dalam konteks tenant: status bisa berubah sejak lookup
    // (balapan dua tab) — keputusan akhir dari baris segar ini.
    const [fresh] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.id, invitation.id))
      .limit(1);
    if (!fresh) return { kind: "not_found" } as const;
    const freshStatus = invitationStatus(fresh);
    if (freshStatus === "accepted") return { kind: "already_accepted" } as const;
    if (freshStatus === "revoked") return { kind: "revoked" } as const;
    if (freshStatus === "expired") return { kind: "expired" } as const;

    const [existing] = await tx
      .select()
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, invitation.tenantId),
          eq(tenantMembers.userId, input.userId),
        ),
      )
      .limit(1);
    const now = new Date();
    await tx
      .update(invitations)
      .set({ acceptedAt: now, updatedAt: now })
      .where(eq(invitations.id, invitation.id));
    if (existing) {
      // Sudah member lewat jalur lain: undangan ditutup, peran yang ada
      // dipertahankan (bukan ditimpa peran undangan).
      return {
        kind: "accepted",
        tenantId: invitation.tenantId,
        role: existing.role,
      } as const;
    }
    const [member] = await tx
      .insert(tenantMembers)
      .values({
        tenantId: invitation.tenantId,
        userId: input.userId,
        role: fresh.role,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: invitation.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "team.member_joined",
      meta: { invitationId: invitation.id, role: member.role },
    });
    return {
      kind: "accepted",
      tenantId: invitation.tenantId,
      role: member.role,
    } as const;
  });
}

// ---------------------------------------------------------------------------
// Peran & pengeluaran member
// ---------------------------------------------------------------------------

export type UpdateMemberRoleResult =
  | { kind: "updated"; member: TenantMember }
  | { kind: "not_found" }
  | { kind: "owner_protected" }
  | { kind: "self_action" };

export async function updateMemberRole(
  db: Database,
  input: {
    tenantId: string;
    actorUserId: string;
    targetUserId: string;
    role: InvitableRole;
  },
): Promise<UpdateMemberRoleResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [target] = await tx
      .select()
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, input.tenantId),
          eq(tenantMembers.userId, input.targetUserId),
        ),
      )
      .limit(1);
    if (!target) return { kind: "not_found" } as const;
    // Fase 13A: cek DIRI didahulukan dari cek owner — pemilik yang
    // menargetkan dirinya sendiri menerima TEAM_SELF_ACTION (diagnosis
    // yang benar: aksinya ditolak karena self-action), bukan
    // TEAM_OWNER_PROTECTED. Perlindungan owner TIDAK berubah untuk
    // aktor lain: owner yang ditarget member/admin lain tetap
    // owner_protected karena cek diri hanya cocok bila aktor = target.
    if (input.targetUserId === input.actorUserId) {
      return { kind: "self_action" } as const;
    }
    if (target.role === "owner") return { kind: "owner_protected" } as const;
    if (target.role === input.role) {
      return { kind: "updated", member: target } as const;
    }
    const [updated] = await tx
      .update(tenantMembers)
      .set({ role: input.role, updatedAt: new Date() })
      .where(eq(tenantMembers.id, target.id))
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "team.role_changed",
      meta: {
        memberUserId: input.targetUserId,
        fromRole: target.role,
        toRole: input.role,
      },
    });
    return { kind: "updated", member: updated } as const;
  });
}

export type RemoveMemberResult =
  | { kind: "removed" }
  | { kind: "not_found" }
  | { kind: "owner_protected" }
  | { kind: "self_action" };

export async function removeMember(
  db: Database,
  input: { tenantId: string; actorUserId: string; targetUserId: string },
): Promise<RemoveMemberResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [target] = await tx
      .select()
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, input.tenantId),
          eq(tenantMembers.userId, input.targetUserId),
        ),
      )
      .limit(1);
    if (!target) return { kind: "not_found" } as const;
    // Fase 13A: cek diri sebelum cek owner — alasan sama seperti
    // updateMemberRole di atas.
    if (input.targetUserId === input.actorUserId) {
      return { kind: "self_action" } as const;
    }
    if (target.role === "owner") return { kind: "owner_protected" } as const;
    await tx.delete(tenantMembers).where(eq(tenantMembers.id, target.id));
    // Penugasan percakapan milik member yang keluar kembali ke kolam
    // "belum ditugaskan" — bukan menggantung ke non-member.
    await tx
      .update(conversations)
      .set({ assigneeUserId: null, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.tenantId, input.tenantId),
          eq(conversations.assigneeUserId, input.targetUserId),
        ),
      );
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "team.member_removed",
      meta: { memberUserId: input.targetUserId, role: target.role },
    });
    return { kind: "removed" } as const;
  });
}
