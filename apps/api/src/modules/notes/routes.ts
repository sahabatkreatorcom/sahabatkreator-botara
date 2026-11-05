import { Hono } from "hono";
import { z } from "zod";
import {
  ConversationNoteListResponseSchema,
  ConversationNoteResponseSchema,
  CreateConversationNoteRequestSchema,
  type ConversationNoteResponse,
} from "@sahabat-kreator/contracts";
import {
  createConversationNote,
  deleteConversationNote,
  listConversationNotes,
  type ConversationNoteWithAuthor,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul notes (Fase 9C) — catatan internal percakapan:
 *   GET    /tenants/:tenantId/conversations/:id/notes          daftar (semua member)
 *   POST   /tenants/:tenantId/conversations/:id/notes          buat (semua member)
 *   DELETE /tenants/:tenantId/conversations/:id/notes/:noteId  hapus (penulis / owner / admin)
 *
 * Catatan BUKAN pesan: tidak ada endpoint di sini yang bisa mengantrekan
 * apa pun ke provider — catatan hidup di tabel `conversation_notes`
 * (modul core conversation-notes) yang tidak dibaca jalur pengiriman
 * mana pun. Hapus ditegakkan di core (penulis atau owner/admin; selain
 * itu 403). Non-member selalu 404 TENANT_NOT_FOUND; percakapan tenant
 * lain 404 NOT_FOUND.
 */
function serializeNote(note: ConversationNoteWithAuthor): ConversationNoteResponse {
  return ConversationNoteResponseSchema.parse({
    id: note.id,
    conversationId: note.conversationId,
    authorUserId: note.authorUserId,
    authorName: note.authorName,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  });
}

export function createNotesRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/conversations/:id/notes";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.delete(`${base}/:noteId`, unavailable);
    return app;
  }


  type GuardOk = {
    tenant: NonNullable<Awaited<ReturnType<typeof resolveTenantForUser>>>;
    appUser: { id: string; email: string };
    conversationId: string;
  };
  async function guard(c: AppContext): Promise<GuardOk | { error: Response }> {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle!,
      c.req.param("tenantId") ?? "",
      appUser.id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      };
    }
    const conversationId = c.req.param("id") ?? "";
    if (!z.string().uuid().safeParse(conversationId).success) {
      return {
        error: apiError(c, 404, "NOT_FOUND", "Conversation not found"),
      };
    }
    return {
      tenant,
      appUser: { id: appUser.id, email: appUser.email },
      conversationId,
    };
  }

  app.get(base, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    const notes = await listConversationNotes(bundle.db, {
      tenantId: g.tenant.id,
      conversationId: g.conversationId,
    });
    if (!notes) return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    const body = ConversationNoteListResponseSchema.parse({
      notes: notes.map(serializeNote),
    });
    return c.json(body);
  });

  app.post(base, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateConversationNoteRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid note payload");
    }
    const result = await createConversationNote(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      conversationId: g.conversationId,
      body: parsed.data.body,
    });
    if (result.kind === "conversation_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Conversation not found");
    }
    return c.json(serializeNote(result.note), 201);
  });

  app.delete(`${base}/:noteId`, async (c) => {
    const g = await guard(c);
    if ("error" in g) return g.error;
    const noteId = c.req.param("noteId") ?? "";
    if (!z.string().uuid().safeParse(noteId).success) {
      return apiError(c, 404, "NOT_FOUND", "Note not found");
    }
    const result = await deleteConversationNote(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      role: g.tenant.role,
      conversationId: g.conversationId,
      noteId,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Note not found");
    }
    if (result.kind === "forbidden") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only the note's author or a workspace owner/admin can delete this note",
      );
    }
    return c.body(null, 204);
  });

  return app;
}
