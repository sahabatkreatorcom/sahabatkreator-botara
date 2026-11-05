import { and, asc, eq } from "drizzle-orm";
import {
  auditLogs,
  savedReplies,
  type Database,
  type SavedReply,
} from "@sahabat-kreator/db";
import { withTenantDb } from "./tx";

/**
 * Saved Replies (Fase 9A) — macro balasan tersimpan per workspace,
 * disisipkan ke composer Inbox lewat pemilih `/`.
 *
 * Keputusan akses (ditegakkan DI SINI, bukan hanya disembunyikan UI):
 * - Baca: semua member workspace (pustaka balasan adalah milik bersama).
 * - Buat: semua member workspace.
 * - Edit/hapus: hanya PEMBUAT baris itu, atau member berperan
 *   owner/admin di workspace ini. Member lain yang mencoba → hasil
 *   `forbidden` (route memetakannya ke 403). Baris yatim
 *   (created_by_user_id NULL karena pembuatnya terhapus) hanya bisa
 *   diubah owner/admin.
 * Setiap mutasi menulis audit `saved_reply.created|updated|deleted`
 * dengan actor user pemanggil (terlihat di viewer audit Fase 7B.4).
 *
 * Daftar dikembalikan utuh terurut judul (pustaka macro workspace
 * memang kecil; pemilih `/` memfilter di klien) — tanpa paginasi.
 */
export type { SavedReply };

/** Peran member yang boleh mengelola balasan milik orang lain. */
const MANAGER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

function canManage(reply: SavedReply, userId: string, role: string): boolean {
  return reply.createdByUserId === userId || MANAGER_ROLES.has(role);
}

export async function listSavedReplies(
  db: Database,
  input: { tenantId: string },
): Promise<SavedReply[]> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    return tx
      .select()
      .from(savedReplies)
      .where(eq(savedReplies.tenantId, input.tenantId))
      .orderBy(asc(savedReplies.title), asc(savedReplies.createdAt));
  });
}

export async function createSavedReply(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    title: string;
    body: string;
  },
): Promise<SavedReply> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(savedReplies)
      .values({
        tenantId: input.tenantId,
        title: input.title,
        body: input.body,
        createdByUserId: input.userId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "saved_reply.created",
      meta: { savedReplyId: row.id, title: row.title },
    });
    return row;
  });
}

export type UpdateSavedReplyResult =
  | { kind: "updated"; reply: SavedReply }
  | { kind: "not_found" }
  | { kind: "forbidden" };

export async function updateSavedReply(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    role: string;
    id: string;
    title?: string;
    body?: string;
  },
): Promise<UpdateSavedReplyResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(savedReplies)
      .where(
        and(
          eq(savedReplies.tenantId, input.tenantId),
          eq(savedReplies.id, input.id),
        ),
      )
      .limit(1);
    if (!row) return { kind: "not_found" as const };
    if (!canManage(row, input.userId, input.role)) {
      return { kind: "forbidden" as const };
    }
    const [updated] = await tx
      .update(savedReplies)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        updatedAt: new Date(),
      })
      .where(eq(savedReplies.id, row.id))
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "saved_reply.updated",
      meta: { savedReplyId: row.id, title: updated.title },
    });
    return { kind: "updated" as const, reply: updated };
  });
}

export type DeleteSavedReplyResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "forbidden" };

export async function deleteSavedReply(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    role: string;
    id: string;
  },
): Promise<DeleteSavedReplyResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(savedReplies)
      .where(
        and(
          eq(savedReplies.tenantId, input.tenantId),
          eq(savedReplies.id, input.id),
        ),
      )
      .limit(1);
    if (!row) return { kind: "not_found" as const };
    if (!canManage(row, input.userId, input.role)) {
      return { kind: "forbidden" as const };
    }
    await tx.delete(savedReplies).where(eq(savedReplies.id, row.id));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "saved_reply.deleted",
      meta: { savedReplyId: row.id, title: row.title },
    });
    return { kind: "deleted" as const };
  });
}
