import { Hono } from "hono";
import { z } from "zod";
import {
  ContactBulkRequestSchema,
  ContactBulkResponseSchema,
  ContactConversationListResponseSchema,
  ContactDuplicatesResponseSchema,
  ContactFieldDefinitionListResponseSchema,
  ContactFieldDefinitionResponseSchema,
  ContactImportRequestSchema,
  ContactScanCandidateResponseSchema,
  ContactScanDetailResponseSchema,
  ContactScanImportRequestSchema,
  ContactScanImportResponseSchema,
  ContactScanRunListResponseSchema,
  ContactScanRunResponseSchema,
  ContactImportResponseSchema,
  ContactListResponseSchema,
  ContactNoteListResponseSchema,
  ContactNoteResponseSchema,
  ContactResponseSchema,
  ContactTimelineResponseSchema,
  CreateContactFieldDefinitionRequestSchema,
  CreateContactNoteRequestSchema,
  CreateContactRequestSchema,
  MergeContactRequestSchema,
  UpdateContactFieldDefinitionRequestSchema,
  UpdateContactRequestSchema,
  type ContactFieldDefinitionResponse,
  type ContactNoteResponse,
  type ContactResponse,
  type ContactScanCandidateResponse,
  type ContactScanRunResponse,
} from "@sahabat-kreator/contracts";
import {
  buildContactsCsv,
  bulkApplyContactsAction,
  ContactCustomFieldValidationError,
  ContactFieldDefinitionDuplicateError,
  ContactFieldDefinitionInvalidError,
  createContact,
  createContactFieldDefinition,
  createContactNote,
  createContactScan,
  getContactScan,
  importContactScanCandidates,
  listContactScans,
  readScanStats,
  deleteContactFieldDefinition,
  deleteContactNote,
  effectiveOptInStatus,
  findDuplicateContacts,
  getContact,
  getContactTimeline,
  importContactsFromCsv,
  listContactConversations,
  listContactFieldDefinitions,
  listContactNotes,
  listContactPlatforms,
  listContactPhotoFetchCandidates,
  listContacts,
  listContactsForExport,
  listProfilePhotoOwnerIds,
  listSegmentMemberIds,
  mapContactsToSelfChannelAccounts,
  mergeContacts,
  updateContact,
  updateContactFieldDefinition,
  type ContactNoteWithAuthor,
} from "@sahabat-kreator/core";
import type {
  Contact,
  ContactFieldDefinition,
  ContactScanCandidate,
  ContactScanRun,
} from "@sahabat-kreator/db";
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

/** Serialisasi definisi field kustom bertipe (G18 butir 1). */
export function serializeContactFieldDefinition(
  row: ContactFieldDefinition,
): ContactFieldDefinitionResponse {
  return ContactFieldDefinitionResponseSchema.parse({
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    options: row.options,
    required: row.required,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Serialisasi satu pindai pelanggan otomatis (G18 butir 2). */
export function serializeContactScanRun(
  row: ContactScanRun,
): ContactScanRunResponse {
  return ContactScanRunResponseSchema.parse({
    id: row.id,
    status: row.status,
    stats: readScanStats(row),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

/** Serialisasi satu kandidat pindai (G18 butir 2). */
export function serializeContactScanCandidate(
  row: ContactScanCandidate,
): ContactScanCandidateResponse {
  return ContactScanCandidateResponseSchema.parse({
    id: row.id,
    channelAccountId: row.channelAccountId,
    provider: row.provider,
    externalUserId: row.externalUserId,
    displayName: row.displayName,
    username: row.username,
    commentCount: row.commentCount,
    lastCommentAt: row.lastCommentAt?.toISOString() ?? null,
    sampleText: row.sampleText,
    status: row.status,
    importedContactId: row.importedContactId,
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
  /** Saring ke satu tahap pipeline persis (filter daftar utama). */
  stage: z.string().trim().min(1).max(64).optional(),
});

/** Query ekspor CSV: filter yang sama dengan daftar (tanpa pagination). */
const ExportContactsQuerySchema = z.object({
  search: z.string().max(255).optional(),
  segmentId: z.string().uuid().optional(),
  stage: z.string().trim().min(1).max(64).optional(),
});

/**
 * Modul contacts (Fase 1D) — semua route bersarang di workspace:
 *   POST  /tenants/:tenantId/contacts        buat kontak → 201
 *   GET   /tenants/:tenantId/contacts        daftar + total (?search=&limit=&offset=)
 *   GET   /tenants/:tenantId/contacts/:id    detail; bukan milik tenant → 404
 *   PATCH /tenants/:tenantId/contacts/:id    ubah name/tags/pipeline_stage/opt_in_status
 *
 * Daftar utama (GET di atas) adalah permukaan CRM: ia meneruskan
 * `excludeSelfChannelContacts` ke core sehingga kontak AKUN-SENDIRI
 * (jangkar akun channel yang hanya punya percakapan linimasa) tidak
 * tampil di sini — sejajar saringan Inbox kemarin. Permukaan lain
 * (duplikat di modul ini, segmen/broadcast/postingan di core, API
 * publik v1) TIDAK disaring dan perilakunya tidak berubah.
 *
 * Route tambahan gelombang perbaikan /contacts:
 *   GET   /tenants/:tenantId/contacts/export           unduh CSV sesuai filter daftar
 *   POST  /tenants/:tenantId/contacts/import           impor CSV (laporan per baris)
 *   POST  /tenants/:tenantId/contacts/bulk             satu aksi untuk banyak kontak
 *   GET   /tenants/:tenantId/contacts/:id/conversations  percakapan milik kontak
 *
 * Route tambahan Gelombang G8 (linimasa + catatan level kontak):
 *   GET    /tenants/:tenantId/contacts/:id/notes          catatan KONTAK (semua member)
 *   POST   /tenants/:tenantId/contacts/:id/notes          buat catatan kontak
 *   DELETE /tenants/:tenantId/contacts/:id/notes/:noteId  hapus (penulis / owner / admin)
 *   GET    /tenants/:tenantId/contacts/:id/timeline       linimasa aktivitas (baca-saja)
 *
 * Route tambahan Gelombang G18 butir 1 (skema field kustom bertipe):
 *   GET    /tenants/:tenantId/contacts/field-definitions            daftar definisi
 *   POST   /tenants/:tenantId/contacts/field-definitions            buat definisi
 *   PATCH  /tenants/:tenantId/contacts/field-definitions/:defId     ubah (key immutable)
 *   DELETE /tenants/:tenantId/contacts/field-definitions/:defId     hapus (nilai kontak utuh)
 * Penulisan kontak (POST/PATCH di atas + impor CSV) divalidasi core
 * terhadap definisi ini; pelanggaran → 400 CONTACT_FIELD_INVALID
 * dengan details.issues per field.
 *
 * Route tambahan Gelombang G18 butir 2 (pindai pelanggan otomatis):
 *   POST /tenants/:tenantId/contacts/scans                 minta pindai (202; eksekusi worker)
 *   GET  /tenants/:tenantId/contacts/scans                 daftar pindai terakhir
 *   GET  /tenants/:tenantId/contacts/scans/:scanId         detail + kandidat untuk ditinjau
 *   POST /tenants/:tenantId/contacts/scans/:scanId/import  impor kandidat pending terpilih
 * Sumber pindai adalah riwayat komentar kanal (satu-satunya lawan
 * bicara yang belum tentu menjadi kontak — lihat core/contact-scans).
 * Catatan kontak adalah keluarga TERPISAH dari catatan percakapan
 * (modul notes, /conversations/:id/notes) — subjeknya kontak, dan
 * kedua daftar tidak pernah dicampur; linimasa merakit peristiwa dari
 * data yang sudah tercatat (core contact-timeline), tanpa menulis.
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
    app.get(`${base}/export`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/import`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/bulk`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/field-definitions`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/field-definitions`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.patch(`${base}/field-definitions/:definitionId`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.delete(`${base}/field-definitions/:definitionId`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/scans`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/scans`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/scans/:scanId`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/scans/:scanId/import`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/:id`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/:id/conversations`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/:id/notes`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.post(`${base}/:id/notes`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.delete(`${base}/:id/notes/:noteId`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/:id/timeline`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
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
    try {
      const contact = await createContact(bundle.db, { tenantId: tenant.id }, parsed.data);
      return c.json(serializeContact(contact), 201);
    } catch (err) {
      // G18: nilai field kustom melanggar skema bertipe tenant.
      if (err instanceof ContactCustomFieldValidationError) {
        return apiError(c, 400, "CONTACT_FIELD_INVALID", "Custom field values violate the field schema", { issues: err.issues });
      }
      throw err;
    }
  });

  /**
   * Fase 13C: filter segmen — keanggotaan diselesaikan evaluator
   * core lebih dulu; segmen tak dikenal → null (route menjawab 404,
   * bukan daftar kosong, agar UI bisa membedakan segmen terhapus
   * dari segmen kosong). Dipakai daftar utama & ekspor agar filter
   * keduanya tidak pernah berbeda.
   */
  const resolveSegmentOnlyIds = async (
    tenantId: string,
    segmentId: string | undefined,
  ): Promise<string[] | undefined | null> => {
    if (!segmentId) return undefined;
    const memberIds = await listSegmentMemberIds(
      bundle.db,
      tenantId,
      segmentId,
    );
    return memberIds ?? null;
  };

  app.get(base, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const query = ListContactsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const onlyIds = await resolveSegmentOnlyIds(tenant.id, query.data.segmentId);
    if (onlyIds === null) {
      return apiError(c, 404, "NOT_FOUND", "Segment not found");
    }
    const result = await listContacts(
      bundle.db,
      { tenantId: tenant.id },
      {
        search: query.data.search,
        limit: query.data.limit,
        offset: query.data.offset,
        stage: query.data.stage,
        onlyIds,
        // Daftar utama CRM: kontak akun-sendiri tidak tampil (lihat
        // header modul). Total ikut tersaring — ia memang hitungan
        // daftar ini, bukan sensus kontak tenant.
        excludeSelfChannelContacts: true,
      },
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

  // GET /tenants/:tenantId/contacts/export — unduh CSV berisi
  // SELURUH kontak yang cocok dengan filter daftar utama yang aktif
  // (search/segmentId/stage + saringan akun-sendiri), bukan hanya
  // halaman yang sedang tampil. Didaftarkan sebelum "/:id".
  app.get(`${base}/export`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const query = ExportContactsQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid query parameters");
    }
    const onlyIds = await resolveSegmentOnlyIds(tenant.id, query.data.segmentId);
    if (onlyIds === null) {
      return apiError(c, 404, "NOT_FOUND", "Segment not found");
    }
    const rows = await listContactsForExport(
      bundle.db,
      { tenantId: tenant.id },
      {
        search: query.data.search,
        stage: query.data.stage,
        onlyIds,
        excludeSelfChannelContacts: true,
      },
    );
    const csv = buildContactsCsv(
      rows.map((row) => ({
        name: row.name,
        phone: row.phone,
        email: row.email,
        tags: row.tags,
        pipelineStage: row.pipelineStage,
        optInEffectiveStatus: effectiveOptInStatus(row),
      })),
    );
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="contacts.csv"',
    });
  });

  // POST /tenants/:tenantId/contacts/import — impor CSV (body JSON
  // {csv}); jawaban adalah LAPORAN: berapa masuk, baris duplikat
  // terlewat, baris tidak sah beralasan (mesin di core).
  app.post(`${base}/import`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = ContactImportRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid import payload");
    }
    const result = await importContactsFromCsv(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      parsed.data.csv,
    );
    if (result.kind === "too_many_rows") {
      return apiError(
        c,
        422,
        "CONTACTS_IMPORT_TOO_MANY_ROWS",
        "CSV file has too many rows",
      );
    }
    return c.json(
      ContactImportResponseSchema.parse({
        imported: result.imported,
        duplicates: result.duplicates,
        invalid: result.invalid,
      }),
    );
  });

  // POST /tenants/:tenantId/contacts/bulk — satu aksi untuk banyak
  // kontak. Aksi `delete` destruktif (cascade percakapan+pesan) →
  // digerbang owner/admin seperti merge; aksi lain boleh semua
  // member (sejajar PATCH kontak biasa).
  app.post(`${base}/bulk`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = ContactBulkRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid bulk payload");
    }
    if (
      parsed.data.action === "delete" &&
      tenant.role !== "owner" &&
      tenant.role !== "admin"
    ) {
      return apiError(c, 403, "FORBIDDEN", "Only workspace owners and admins can delete contacts");
    }
    const result = await bulkApplyContactsAction(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      parsed.data,
    );
    return c.json(
      ContactBulkResponseSchema.parse({
        action: parsed.data.action,
        succeeded: result.succeeded.length,
        failed: result.failed,
      }),
    );
  });

  // --- Skema field kustom bertipe (G18 butir 1) ---
  // Didaftarkan SEBELUM "/:id" agar segmen "field-definitions" tidak
  // tertangkap sebagai id kontak. Baca boleh semua member; tulis
  // sejajar tulis kontak biasa (semua member) — definisi adalah
  // konfigurasi CRM harian, bukan kredensial.

  app.get(`${base}/field-definitions`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listContactFieldDefinitions(bundle.db, { tenantId: tenant.id });
    return c.json(
      ContactFieldDefinitionListResponseSchema.parse({
        definitions: rows.map(serializeContactFieldDefinition),
      }),
    );
  });

  app.post(`${base}/field-definitions`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateContactFieldDefinitionRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid field definition payload");
    }
    try {
      const row = await createContactFieldDefinition(
        bundle.db,
        { tenantId: tenant.id },
        parsed.data,
      );
      return c.json(serializeContactFieldDefinition(row), 201);
    } catch (err) {
      if (err instanceof ContactFieldDefinitionDuplicateError) {
        return apiError(c, 409, "CONTACT_FIELD_DEFINITION_DUPLICATE", "A field with this key is already defined");
      }
      if (err instanceof ContactFieldDefinitionInvalidError) {
        return apiError(c, 400, "VALIDATION_ERROR", err.message);
      }
      throw err;
    }
  });

  app.patch(`${base}/field-definitions/:definitionId`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const definitionId = c.req.param("definitionId");
    if (!z.string().uuid().safeParse(definitionId).success) {
      return apiError(c, 404, "NOT_FOUND", "Field definition not found");
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateContactFieldDefinitionRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid field definition payload");
    }
    try {
      const row = await updateContactFieldDefinition(
        bundle.db,
        { tenantId: tenant.id },
        definitionId,
        parsed.data,
      );
      if (!row) return apiError(c, 404, "NOT_FOUND", "Field definition not found");
      return c.json(serializeContactFieldDefinition(row));
    } catch (err) {
      if (err instanceof ContactFieldDefinitionInvalidError) {
        return apiError(c, 400, "VALIDATION_ERROR", err.message);
      }
      throw err;
    }
  });

  app.delete(`${base}/field-definitions/:definitionId`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const definitionId = c.req.param("definitionId");
    if (!z.string().uuid().safeParse(definitionId).success) {
      return apiError(c, 404, "NOT_FOUND", "Field definition not found");
    }
    const deleted = await deleteContactFieldDefinition(
      bundle.db,
      { tenantId: tenant.id },
      definitionId,
    );
    if (!deleted) return apiError(c, 404, "NOT_FOUND", "Field definition not found");
    return c.body(null, 204);
  });

  // --- Pindai Pelanggan Otomatis (G18 butir 2) ---
  // POST membuat baris pindai + event outbox; eksekusinya pekerjaan
  // worker (relay → job contact-scan.run). GET membaca hasil +
  // kandidat untuk DITINJAU; impor adalah langkah terpisah yang
  // mengeksekusi kandidat pending terpilih.

  app.post(`${base}/scans`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const run = await createContactScan(bundle.db, {
      tenantId: tenant.id,
      userId: c.get("appUser").id,
    });
    return c.json(serializeContactScanRun(run), 202);
  });

  app.get(`${base}/scans`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listContactScans(bundle.db, { tenantId: tenant.id });
    return c.json(
      ContactScanRunListResponseSchema.parse({
        scans: rows.map(serializeContactScanRun),
      }),
    );
  });

  app.get(`${base}/scans/:scanId`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const scanId = c.req.param("scanId");
    if (!z.string().uuid().safeParse(scanId).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact scan not found");
    }
    const detail = await getContactScan(bundle.db, { tenantId: tenant.id }, scanId);
    if (!detail) return apiError(c, 404, "NOT_FOUND", "Contact scan not found");
    return c.json(
      ContactScanDetailResponseSchema.parse({
        scan: serializeContactScanRun(detail.run),
        candidates: detail.candidates.map(serializeContactScanCandidate),
      }),
    );
  });

  app.post(`${base}/scans/:scanId/import`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const scanId = c.req.param("scanId");
    if (!z.string().uuid().safeParse(scanId).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact scan not found");
    }
    let json: unknown = {};
    try {
      const text = await c.req.text();
      if (text.trim()) json = JSON.parse(text) as unknown;
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = ContactScanImportRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid scan import payload");
    }
    const result = await importContactScanCandidates(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      { scanRunId: scanId, candidateIds: parsed.data.candidateIds },
    );
    if (!result) return apiError(c, 404, "NOT_FOUND", "Contact scan not found");
    return c.json(ContactScanImportResponseSchema.parse(result));
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

  // GET /tenants/:tenantId/contacts/:id/conversations — percakapan
  // milik kontak untuk panel detail. Semua kind dikembalikan apa
  // adanya (termasuk `channel`); keputusan tautan Inbox ada di UI:
  // hanya percakapan pesan (private/group) yang boleh ditautkan,
  // baris channel adalah linimasa dan Inbox menyaringnya keluar.
  app.get(`${base}/:id/conversations`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    const contact = await getContact(bundle.db, { tenantId: tenant.id }, id);
    if (!contact) return apiError(c, 404, "NOT_FOUND", "Contact not found");
    const rows = await listContactConversations(
      bundle.db,
      { tenantId: tenant.id },
      id,
    );
    return c.json(
      ContactConversationListResponseSchema.parse({
        conversations: rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          kind: row.kind,
          title: row.title,
          status: row.status,
          lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
      }),
    );
  });

  // --- Catatan level kontak (G8) -----------------------------------
  // Keluarga terpisah dari catatan percakapan (modul notes): subjek
  // di sini KONTAK. Hapus ditegakkan di core (penulis atau
  // owner/admin; selain itu 403). Kontak tenant lain → 404 NOT_FOUND;
  // non-member → 404 TENANT_NOT_FOUND.
  const serializeContactNote = (
    note: ContactNoteWithAuthor,
  ): ContactNoteResponse =>
    ContactNoteResponseSchema.parse({
      id: note.id,
      contactId: note.contactId,
      authorUserId: note.authorUserId,
      authorName: note.authorName,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
    });

  app.get(`${base}/:id/notes`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    const notes = await listContactNotes(bundle.db, {
      tenantId: tenant.id,
      contactId: id,
    });
    if (!notes) return apiError(c, 404, "NOT_FOUND", "Contact not found");
    return c.json(
      ContactNoteListResponseSchema.parse({
        notes: notes.map(serializeContactNote),
      }),
    );
  });

  app.post(`${base}/:id/notes`, async (c) => {
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
    const parsed = CreateContactNoteRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid note payload");
    }
    const result = await createContactNote(bundle.db, {
      tenantId: tenant.id,
      userId: c.get("appUser").id,
      contactId: id,
      body: parsed.data.body,
    });
    if (result.kind === "contact_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    return c.json(serializeContactNote(result.note), 201);
  });

  app.delete(`${base}/:id/notes/:noteId`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    const noteId = c.req.param("noteId");
    if (
      !z.string().uuid().safeParse(id).success ||
      !z.string().uuid().safeParse(noteId).success
    ) {
      return apiError(c, 404, "NOT_FOUND", "Note not found");
    }
    const result = await deleteContactNote(bundle.db, {
      tenantId: tenant.id,
      userId: c.get("appUser").id,
      role: tenant.role,
      contactId: id,
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

  // GET /tenants/:tenantId/contacts/:id/timeline — linimasa aktivitas
  // kontak, dirakit baca-saja di core dari data yang sudah tercatat.
  app.get(`${base}/:id/timeline`, async (c) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId"), c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    const rawLimit = c.req.query("limit");
    const limit =
      rawLimit !== undefined && /^\d+$/.test(rawLimit)
        ? Number(rawLimit)
        : undefined;
    const timeline = await getContactTimeline(
      bundle.db,
      { tenantId: tenant.id, contactId: id },
      limit !== undefined ? { limit } : undefined,
    );
    if (!timeline) return apiError(c, 404, "NOT_FOUND", "Contact not found");
    return c.json(
      ContactTimelineResponseSchema.parse({
        events: timeline.events.map((event) => ({
          kind: event.kind,
          occurredAt: event.occurredAt.toISOString(),
          detail: event.detail,
        })),
        truncated: timeline.truncated,
      }),
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
    let contact;
    try {
      contact = await updateContact(
        bundle.db,
        { tenantId: tenant.id },
        id,
        // Fase 13C: pelaku sesi diteruskan agar audit toggle opt-in
        // manual menyebut user-nya (source "manual" di core).
        { ...parsed.data, actorUserId: c.get("appUser").id },
      );
    } catch (err) {
      // G18: nilai field kustom melanggar skema bertipe tenant.
      if (err instanceof ContactCustomFieldValidationError) {
        return apiError(c, 400, "CONTACT_FIELD_INVALID", "Custom field values violate the field schema", { issues: err.issues });
      }
      throw err;
    }
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
