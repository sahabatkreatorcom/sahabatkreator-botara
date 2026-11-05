import { Hono } from "hono";
import { z } from "zod";
import {
  ContactDuplicatesResponseSchema,
  ContactListResponseSchema,
  ContactResponseSchema,
  CreateContactRequestSchema,
  MergeContactRequestSchema,
  UpdateContactRequestSchema,
  type ContactResponse,
} from "@sahabat-kreator/contracts";
import {
  createContact,
  effectiveOptInStatus,
  findDuplicateContacts,
  getContact,
  listContacts,
  listProfilePhotoOwnerIds,
  listSegmentMemberIds,
  mergeContacts,
  updateContact,
} from "@sahabat-kreator/core";
import type { Contact } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { contactAvatarUrl } from "../avatars/routes";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Serialisasi kontak. `avatarUrl` (Fase 6D) TIDAK lagi dari kolom warisan
 * `contacts.avatar_url` (tidak pernah terisi): nilainya adalah endpoint
 * avatar kita sendiri bila foto profil kontak tersimpan di
 * `profile_photos` (saat ini hanya kontak Telegram), selain itu null.
 * Pemanggil daftar menghitung himpunan pemilik berfoto lebih dulu
 * (listProfilePhotoOwnerIds) lalu meneruskannya ke sini.
 */
export function serializeContact(
  row: Contact,
  avatarUrl: string | null = null,
): ContactResponse {
  return ContactResponseSchema.parse({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    avatarUrl,
    tags: row.tags,
    customFields: row.customFields,
    pipelineStage: row.pipelineStage,
    optInStatus: row.optInStatus,
    // Fase 13C: status efektif + jejak opt-in (aditif; optInStatus
    // tersimpan tetap apa adanya untuk permukaan PATCH yang ada).
    optInEffectiveStatus: effectiveOptInStatus(row),
    optInSource: row.optInSource ?? null,
    optInAt: row.optInAt?.toISOString() ?? null,
    consentAt: row.consentAt?.toISOString() ?? null,
    lastContactedAt: row.lastContactedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** avatarUrl satu kontak: endpoint avatar bila fotonya tersimpan, else null. */
async function singleContactAvatarUrl(
  bundle: AuthBundle,
  tenantId: string,
  contactId: string,
): Promise<string | null> {
  const withPhoto = await listProfilePhotoOwnerIds(
    bundle.db,
    { tenantId },
    "contact",
    [contactId],
  );
  return withPhoto.has(contactId) ? contactAvatarUrl(tenantId, contactId) : null;
}

const ListContactsQuerySchema = z.object({
  search: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Fase 13C: saring ke anggota segmen ini (evaluator tunggal core). */
  segmentId: z.string().uuid().optional(),
});

/**
 * Modul contacts (Fase 1D) — semua route bersarang di workspace:
 *   POST  /tenants/:tenantId/contacts        buat kontak → 201
 *   GET   /tenants/:tenantId/contacts        daftar + total (?search=&limit=&offset=)
 *   GET   /tenants/:tenantId/contacts/:id    detail; bukan milik tenant → 404
 *   PATCH /tenants/:tenantId/contacts/:id    ubah name/tags/pipeline_stage/opt_in_status
 * Wajib sesi + membership workspace (non-member → 404 TENANT_NOT_FOUND,
 * pola Fase 1B). Logika domain ada di @sahabat-kreator/core (RLS tenant).
 */
export function createContactsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/contacts";

  if (!bundle) {
    app.post(base, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(base, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/duplicates`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/:id`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/:id/merge`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.patch(`${base}/:id`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    return app;
  }


  app.post(base, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateContactRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid contact payload");
    }
    const contact = await createContact(bundle.db, { tenantId: tenant.id }, parsed.data);
    return c.json(serializeContact(contact), 201);
  });

  app.get(base, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const query = ListContactsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    // Fase 13C: filter segmen — keanggotaan diselesaikan evaluator
    // core lebih dulu; segmen tak dikenal → 404 (bukan daftar kosong,
    // agar UI bisa membedakan segmen terhapus dari segmen kosong).
    let onlyIds: string[] | undefined;
    if (query.data.segmentId) {
      const memberIds = await listSegmentMemberIds(
        bundle.db,
        tenant.id,
        query.data.segmentId,
      );
      if (!memberIds) {
        return apiError(c, 404, "NOT_FOUND", "Segment not found");
      }
      onlyIds = memberIds;
    }
    const result = await listContacts(
      bundle.db,
      { tenantId: tenant.id },
      { ...query.data, onlyIds },
    );
    const withPhoto = await listProfilePhotoOwnerIds(
      bundle.db,
      { tenantId: tenant.id },
      "contact",
      result.contacts.map((row) => row.id),
    );
    const body = ContactListResponseSchema.parse({
      contacts: result.contacts.map((row) =>
        serializeContact(
          row,
          withPhoto.has(row.id) ? contactAvatarUrl(tenant.id, row.id) : null,
        ),
      ),
      total: result.total,
    });
    return c.json(body);
  });

  // GET /tenants/:tenantId/contacts/duplicates — kelompok kandidat
  // duplikat (Fase 9B). Didaftarkan SEBELUM "/:id" agar segmen
  // "duplicates" tidak tertangkap sebagai id kontak. Boleh dibaca
  // semua member; merge-nya yang digerbang owner/admin.
  app.get(`${base}/duplicates`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const groups = await findDuplicateContacts(bundle.db, { tenantId: tenant.id });
    const withPhoto = await listProfilePhotoOwnerIds(
      bundle.db,
      { tenantId: tenant.id },
      "contact",
      groups.flatMap((g) => g.contacts.map((row) => row.id)),
    );
    const body = ContactDuplicatesResponseSchema.parse({
      groups: groups.map((g) => ({
        contacts: g.contacts.map((row) =>
          serializeContact(
            row,
            withPhoto.has(row.id) ? contactAvatarUrl(tenant.id, row.id) : null,
          ),
        ),
        reasons: g.reasons,
      })),
    });
    return c.json(body);
  });

  app.get(`${base}/:id`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    const contact = await getContact(bundle.db, { tenantId: tenant.id }, id);
    if (!contact) return apiError(c, 404, "NOT_FOUND", "Contact not found");
    return c.json(
      serializeContact(contact, await singleContactAvatarUrl(bundle, tenant.id, id)),
    );
  });

  // POST /tenants/:tenantId/contacts/:id/merge — gabungkan kontak lain
  // (body.mergedId) KE kontak :id (survivor). Owner/admin saja; satu
  // transaksi di core (`mergeContacts`); audit contact.merged di sana.
  app.post(`${base}/:id/merge`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can merge contacts");
    }
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = MergeContactRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid contact payload");
    }
    if (parsed.data.mergedId === id) {
      return apiError(c, 422, "CONTACT_MERGE_SAME", "A contact cannot be merged into itself");
    }
    const result = await mergeContacts(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      { survivorId: id, mergedId: parsed.data.mergedId },
    );
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    if (result.kind === "same_contact") {
      return apiError(c, 422, "CONTACT_MERGE_SAME", "A contact cannot be merged into itself");
    }
    return c.json(
      serializeContact(
        result.survivor,
        await singleContactAvatarUrl(bundle, tenant.id, result.survivor.id),
      ),
    );
  });

  app.patch(`${base}/:id`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateContactRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid contact payload");
    }
    const contact = await updateContact(
      bundle.db,
      { tenantId: tenant.id },
      id,
      // Fase 13C: pelaku sesi diteruskan agar audit toggle opt-in
      // manual menyebut user-nya (source "manual" di core).
      { ...parsed.data, actorUserId: c.get("appUser").id },
    );
    if (!contact) return apiError(c, 404, "NOT_FOUND", "Contact not found");
    return c.json(
      serializeContact(contact, await singleContactAvatarUrl(bundle, tenant.id, id)),
    );
  });

  return app;
}
