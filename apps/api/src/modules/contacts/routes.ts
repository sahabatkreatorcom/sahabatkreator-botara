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
  listContactPlatforms,
  listContactPhotoFetchCandidates,
  listContacts,
  listProfilePhotoOwnerIds,
  listSegmentMemberIds,
  mapContactsToSelfChannelAccounts,
  mergeContacts,
  updateContact,
} from "@sahabat-kreator/core";
import type { Contact } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import {
  pendingContactPhotoBackfillIds,
  scheduleContactPhotoBackfills,
  type ContactPhotoBackfillOptions,
} from "../avatars/contact-photo-backfill";
import { channelAvatarUrl, contactAvatarUrl } from "../avatars/routes";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Serialisasi kontak. `avatarUrl` (Fase 6D) TIDAK lagi dari kolom warisan
 * `contacts.avatar_url` (tidak pernah terisi): nilainya adalah endpoint
 * avatar kita sendiri untuk AVATAR EFEKTIF kontak — foto profil kontak
 * di `profile_photos` lebih dulu (kontak Telegram/Meta dari jalur pesan
 * masuk & backfill), lalu, khusus kontak yang ADALAH akun channel itu
 * sendiri (jangkar sasaran linimasa), foto akun channel-nya; selain itu
 * null. Pemanggil menghitung peta avatar efektif lebih dulu
 * (resolveContactAvatarUrls) lalu meneruskannya ke sini.
 */
export function serializeContact(
  row: Contact,
  avatarUrl: string | null = null,
  /**
   * Kanal tempat kontak ini punya percakapan. Default kosong supaya
   * pemanggil yang belum menghitungnya tetap sah — badge hanya muncul bila
   * datanya memang disediakan.
   */
  platforms: ContactResponse["platforms"] = [],
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
    platforms,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Peta avatar EFEKTIF sekelompok kontak (lihat header serializeContact):
 * foto kontak → foto akun channel bagi kontak akun-dirinya → null.
 * Dengan `scheduleBackfill`, kontak DM yang belum berfoto dan punya
 * jalur resmi (telegram/messenger/instagram) dijadwalkan pengambilan
 * fotonya di latar — pola backfill malas yang sama seperti daftar
 * channel; permukaan administratif (duplikat) tidak menjadwalkan.
 */
async function resolveContactAvatarUrls(
  bundle: AuthBundle,
  tenantId: string,
  contactIds: string[],
  opts?: {
    scheduleBackfill?: boolean;
    photoBackfillOpts?: ContactPhotoBackfillOptions;
  },
): Promise<Map<string, string | null>> {
  const urls = new Map<string, string | null>();
  if (contactIds.length === 0) return urls;
  const contactPhotos = await listProfilePhotoOwnerIds(
    bundle.db,
    { tenantId },
    "contact",
    contactIds,
  );
  const missingContactIds = contactIds.filter(
    (id) => !contactPhotos.has(id),
  );
  let selfAccounts = new Map<string, string>();
  let channelPhotos = new Set<string>();
  if (missingContactIds.length > 0) {
    selfAccounts = await mapContactsToSelfChannelAccounts(
      bundle.db,
      { tenantId },
      missingContactIds,
    );
    const selfAccountIds = [...new Set(selfAccounts.values())];
    if (selfAccountIds.length > 0) {
      channelPhotos = await listProfilePhotoOwnerIds(
        bundle.db,
        { tenantId },
        "channel_account",
        selfAccountIds,
      );
    }
    if (opts?.scheduleBackfill) {
      const pending = pendingContactPhotoBackfillIds(
        missingContactIds.filter((id) => !selfAccounts.has(id)),
      );
      if (pending.length > 0) {
        const candidates = await listContactPhotoFetchCandidates(
          bundle.db,
          { tenantId },
          pending,
        );
        scheduleContactPhotoBackfills(
          bundle,
          opts.photoBackfillOpts,
          tenantId,
          candidates,
        );
      }
    }
  }
  for (const contactId of contactIds) {
    if (contactPhotos.has(contactId)) {
      urls.set(contactId, contactAvatarUrl(tenantId, contactId));
      continue;
    }
    const selfAccountId = selfAccounts.get(contactId);
    urls.set(
      contactId,
      selfAccountId !== undefined && channelPhotos.has(selfAccountId)
        ? channelAvatarUrl(tenantId, selfAccountId)
        : null,
    );
  }
  return urls;
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
export function createContactsRoutes(
  bundle: AuthBundle | null,
  photoBackfillOpts?: ContactPhotoBackfillOptions,
) {
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

  /** avatarUrl efektif satu kontak (+ jadwalkan backfill fotonya). */
  const singleContactAvatarUrl = async (
    tenantId: string,
    contactId: string,
  ): Promise<string | null> =>
    (await resolveContactAvatarUrls(bundle, tenantId, [contactId], {
      scheduleBackfill: true,
      photoBackfillOpts,
    })).get(contactId) ?? null;


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
    const listedIds = result.contacts.map((row) => row.id);
    // Avatar efektif & platform dihitung bersamaan: keduanya query
    // independen, dan daftar kontak adalah endpoint terpanas di
    // halaman ini. Resolusi avatar sekaligus menjadwalkan backfill
    // foto bagi kontak yang belum berfoto.
    const [avatarUrls, platforms] = await Promise.all([
      resolveContactAvatarUrls(bundle, tenant.id, listedIds, {
        scheduleBackfill: true,
        photoBackfillOpts,
      }),
      listContactPlatforms(bundle.db, { tenantId: tenant.id }, listedIds),
    ]);
    const body = ContactListResponseSchema.parse({
      contacts: result.contacts.map((row) =>
        serializeContact(
          row,
          avatarUrls.get(row.id) ?? null,
          platforms.get(row.id) ?? [],
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
    const groupIds = groups.flatMap((g) => g.contacts.map((row) => row.id));
    // Avatar efektif yang sama seperti daftar (tanpa menjadwalkan
    // backfill — ini permukaan administratif pembersihan duplikat).
    const [avatarUrls, platforms] = await Promise.all([
      resolveContactAvatarUrls(bundle, tenant.id, groupIds),
      listContactPlatforms(bundle.db, { tenantId: tenant.id }, groupIds),
    ]);
    const body = ContactDuplicatesResponseSchema.parse({
      groups: groups.map((g) => ({
        contacts: g.contacts.map((row) =>
          serializeContact(
            row,
            avatarUrls.get(row.id) ?? null,
            platforms.get(row.id) ?? [],
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
    const [avatarUrl, platforms] = await Promise.all([
      singleContactAvatarUrl(tenant.id, id),
      listContactPlatforms(bundle.db, { tenantId: tenant.id }, [id]),
    ]);
    return c.json(
      serializeContact(contact, avatarUrl, platforms.get(id) ?? []),
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
    // Platform dihitung ULANG untuk survivor: merge memindahkan
    // percakapan kontak yang digabung ke survivor, jadi badge-nya
    // berubah — mengembalikan nilai lama akan menampilkan badge basi.
    const [avatarUrl, platforms] = await Promise.all([
      singleContactAvatarUrl(tenant.id, result.survivor.id),
      listContactPlatforms(bundle.db, { tenantId: tenant.id }, [result.survivor.id]),
    ]);
    return c.json(
      serializeContact(
        result.survivor,
        avatarUrl,
        platforms.get(result.survivor.id) ?? [],
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
    // UI menimpa baris daftar dengan respons PATCH ini, jadi platform
    // harus ikut dihitung — kalau tidak, badge hilang sesudah menyunting.
    const [avatarUrl, platforms] = await Promise.all([
      singleContactAvatarUrl(tenant.id, id),
      listContactPlatforms(bundle.db, { tenantId: tenant.id }, [id]),
    ]);
    return c.json(
      serializeContact(contact, avatarUrl, platforms.get(id) ?? []),
    );
  });

  return app;
}
