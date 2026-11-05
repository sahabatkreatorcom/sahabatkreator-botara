import { and, asc, eq } from "drizzle-orm";
import {
  auditLogs,
  conversationNotes,
  conversations,
  users,
  type ConversationNote,
  type Database,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Catatan internal percakapan (Fase 9C).
 *
 * KEPUTUSAN PEMISAHAN (inti fase ini): catatan hidup di tabelnya sendiri
 * `conversation_notes`, BUKAN sebagai baris `messages` bertanda khusus.
 * Alasannya struktural: setiap jalur yang bisa menjangkau kontak —
 * poller Telegram/Meta yang memindai `messages` berstatus `queued`,
 * flush realtime webchat, pengiriman broadcast, konteks riwayat agent —
 * hanya pernah membaca tabel `messages`. Catatan yang tidak berada di
 * tabel itu tidak bisa terkirim oleh bug filter mana pun; tidak ada
 * kolom direction/status di sini yang bisa salah diisi. Satu-satunya
 * permukaan baca/tulis catatan adalah modul ini + API inbox tim.
 *
 * Akses:
 * - Baca & buat: semua member workspace (catatan adalah milik tim).
 * - Hapus: hanya PENULIS catatan, atau member owner/admin (pola
 *   saved-replies 9A). Penulis yatim (author_user_id NULL) hanya bisa
 *   dihapus owner/admin.
 * Audit `conversation.note_created` / `conversation.note_deleted`
 * menulis id saja di meta — ISI catatan tidak pernah masuk audit.
 */

export interface ConversationNoteWithAuthor extends ConversationNote {
  /** Nama penulis, jatuh ke email; null bila penulis sudah terhapus. */
  authorName: string | null;
}

const MANAGER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export type CreateNoteResult =
  | { kind: "created"; note: ConversationNoteWithAuthor }
  | { kind: "conversation_not_found" };

export type DeleteNoteResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "forbidden" };

async function conversationExists(
  tx: DbTx,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.id, conversationId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function listConversationNotes(
  db: Database,
  input: { tenantId: string; conversationId: string },
): Promise<ConversationNoteWithAuthor[] | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    if (!(await conversationExists(tx, input.tenantId, input.conversationId))) {
      return null;
    }
    const rows = await tx
      .select({
        note: conversationNotes,
        authorName: users.name,
        authorEmail: users.email,
      })
      .from(conversationNotes)
      .leftJoin(users, eq(conversationNotes.authorUserId, users.id))
      .where(
        and(
          eq(conversationNotes.tenantId, input.tenantId),
          eq(conversationNotes.conversationId, input.conversationId),
        ),
      )
      .orderBy(asc(conversationNotes.createdAt), asc(conversationNotes.id));
    return rows.map((r) => ({
      ...r.note,
      authorName:
        r.note.authorUserId !== null
          ? (r.authorName ?? r.authorEmail ?? null)
          : null,
    }));
  });
}

export async function createConversationNote(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    conversationId: string;
    body: string;
  },
): Promise<CreateNoteResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    if (!(await conversationExists(tx, input.tenantId, input.conversationId))) {
      return { kind: "conversation_not_found" } as const;
    }
    const [row] = await tx
      .insert(conversationNotes)
      .values({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        authorUserId: input.userId,
        body: input.body,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "conversation.note_created",
      meta: { conversationId: input.conversationId, noteId: row.id },
    });
    const [author] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    return {
      kind: "created",
      note: {
        ...row,
        authorName: author ? (author.name ?? author.email) : null,
      },
    } as const;
  });
}

export async function deleteConversationNote(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    role: string;
    conversationId: string;
    noteId: string;
  },
): Promise<DeleteNoteResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [note] = await tx
      .select()
      .from(conversationNotes)
      .where(
        and(
          eq(conversationNotes.tenantId, input.tenantId),
          eq(conversationNotes.conversationId, input.conversationId),
          eq(conversationNotes.id, input.noteId),
        ),
      )
      .limit(1);
    if (!note) return { kind: "not_found" } as const;
    const allowed =
      note.authorUserId === input.userId || MANAGER_ROLES.has(input.role);
    if (!allowed) return { kind: "forbidden" } as const;
    await tx
      .delete(conversationNotes)
      .where(eq(conversationNotes.id, note.id));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "conversation.note_deleted",
      meta: { conversationId: input.conversationId, noteId: note.id },
    });
    return { kind: "deleted" } as const;
  });
}
