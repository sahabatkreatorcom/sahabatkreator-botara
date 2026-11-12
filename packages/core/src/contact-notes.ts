import { and, asc, eq } from "drizzle-orm";
import {
  auditLogs,
  contactNotes,
  contacts,
  users,
  type ContactNote,
  type Database,
} from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";

/**
 * Catatan internal KONTAK (Gelombang G8).
 *
 * Saudara `conversation_notes` (Fase 9C) yang menempel pada kontak,
 * bukan percakapan: ingatan tim tentang ORANGNYA — berlaku lintas
 * semua percakapan dan kanal milik kontak itu. Keputusan pemisahan
 * yang sama berlaku penuh:
 * - Tabelnya sendiri (`contact_notes`), BUKAN `messages` dan BUKAN
 *   tabel catatan percakapan: tidak ada jalur pengiriman yang membaca
 *   tabel ini, dan daftar catatan kontak tidak pernah dicampur dengan
 *   daftar catatan percakapan (keduanya keluarga berbeda; linimasa
 *   kontak pun mencatat peristiwa "catatan ditambahkan" dari keduanya
 *   sebagai jenis yang berbeda label).
 * - Akses meniru 9C: baca & buat untuk semua member workspace; hapus
 *   hanya PENULIS catatan atau member owner/admin; penulis yatim
 *   (author_user_id NULL) hanya bisa dihapus owner/admin. Tidak ada
 *   ubah — pola 9C memang tidak punya ubah (salah tulis = hapus +
 *   tulis ulang), dan catatan kontak mengikuti pola yang sama.
 * Audit `contact.note_created` / `contact.note_deleted` menulis id
 * saja di meta — ISI catatan tidak pernah masuk audit.
 */

export interface ContactNoteWithAuthor extends ContactNote {
  /** Nama penulis, jatuh ke email; null bila penulis sudah terhapus. */
  authorName: string | null;
}

const MANAGER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export type CreateContactNoteResult =
  | { kind: "created"; note: ContactNoteWithAuthor }
  | { kind: "contact_not_found" };

export type DeleteContactNoteResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "forbidden" };

async function contactExists(
  tx: DbTx,
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
    .limit(1);
  return row !== undefined;
}

/** Null bila kontak tidak ada di tenant ini. */
export async function listContactNotes(
  db: Database,
  input: { tenantId: string; contactId: string },
): Promise<ContactNoteWithAuthor[] | null> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    if (!(await contactExists(tx, input.tenantId, input.contactId))) {
      return null;
    }
    const rows = await tx
      .select({
        note: contactNotes,
        authorName: users.name,
        authorEmail: users.email,
      })
      .from(contactNotes)
      .leftJoin(users, eq(contactNotes.authorUserId, users.id))
      .where(
        and(
          eq(contactNotes.tenantId, input.tenantId),
          eq(contactNotes.contactId, input.contactId),
        ),
      )
      .orderBy(asc(contactNotes.createdAt), asc(contactNotes.id));
    return rows.map((r) => ({
      ...r.note,
      authorName:
        r.note.authorUserId !== null
          ? (r.authorName ?? r.authorEmail ?? null)
          : null,
    }));
  });
}

export async function createContactNote(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    contactId: string;
    body: string;
  },
): Promise<CreateContactNoteResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    if (!(await contactExists(tx, input.tenantId, input.contactId))) {
      return { kind: "contact_not_found" } as const;
    }
    const [row] = await tx
      .insert(contactNotes)
      .values({
        tenantId: input.tenantId,
        contactId: input.contactId,
        authorUserId: input.userId,
        body: input.body,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "contact.note_created",
      meta: { contactId: input.contactId, noteId: row.id },
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

export async function deleteContactNote(
  db: Database,
  input: {
    tenantId: string;
    userId: string;
    role: string;
    contactId: string;
    noteId: string;
  },
): Promise<DeleteContactNoteResult> {
  return withTenantDb(db, input.tenantId, async (tx) => {
    const [note] = await tx
      .select()
      .from(contactNotes)
      .where(
        and(
          eq(contactNotes.tenantId, input.tenantId),
          eq(contactNotes.contactId, input.contactId),
          eq(contactNotes.id, input.noteId),
        ),
      )
      .limit(1);
    if (!note) return { kind: "not_found" } as const;
    const allowed =
      note.authorUserId === input.userId || MANAGER_ROLES.has(input.role);
    if (!allowed) return { kind: "forbidden" } as const;
    await tx.delete(contactNotes).where(eq(contactNotes.id, note.id));
    await tx.insert(auditLogs).values({
      tenantId: input.tenantId,
      actorType: "user",
      actorId: input.userId,
      action: "contact.note_deleted",
      meta: { contactId: input.contactId, noteId: note.id },
    });
    return { kind: "deleted" } as const;
  });
}
