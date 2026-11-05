import { Hono } from "hono";
import { z } from "zod";
import {
  CreateKbDocumentRequestSchema,
  KbDocumentListResponseSchema,
  KbDocumentResponseSchema,
  KbFileDocumentListResponseSchema,
  KbFileDocumentResponseSchema,
  KbStatsResponseSchema,
  type KbDocumentResponse,
  type KbFileDocumentResponse,
} from "@sahabat-kreator/contracts";
import {
  createKbDocument,
  deleteKbDocument,
  deleteKbFile,
  extractKbFileText,
  getKbDocument,
  getKbEmbeddingStats,
  importKbFile,
  KB_FILE_MAX_BYTES,
  listKbDocuments,
  listKbFiles,
  resolveKbFileKind,
  resolveEmbeddingProvider,
  type KbDocumentWithChunkCount,
  type KbFileWithEntry,
  type PlatformSettingsOptions,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";

export function serializeDocument(row: KbDocumentWithChunkCount): KbDocumentResponse {
  return KbDocumentResponseSchema.parse({
    id: row.id,
    title: row.title,
    content: row.content,
    chunkCount: row.chunkCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function serializeFile(row: KbFileWithEntry): KbFileDocumentResponse {
  return KbFileDocumentResponseSchema.parse({
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    chunkCount: row.chunkCount,
    documentId: row.documentId,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Modul knowledge (Fase 3A) — basis pengetahuan agent per workspace:
 *   POST   /tenants/:tenantId/kb/documents        buat dokumen (+ chunking) → 201
 *   GET    /tenants/:tenantId/kb/documents        daftar + jumlah chunk
 *   GET    /tenants/:tenantId/kb/documents/:id    satu dokumen + jumlah chunk
 *   DELETE /tenants/:tenantId/kb/documents/:id    hapus (chunk ikut cascade) → 204
 *   POST   /tenants/:tenantId/kb/files            unggah berkas (multipart, Fase 12C) → 201
 *   GET    /tenants/:tenantId/kb/files            daftar berkas lampiran
 *   DELETE /tenants/:tenantId/kb/files/:id        hapus berkas + entri turunannya → 204
 *   GET    /tenants/:tenantId/kb/stats            statistik chunk + status indeks semantik (Fase 12D)
 * Wajib sesi + membership workspace (non-member → 404 TENANT_NOT_FOUND).
 * Retrieval-nya sendiri berjalan di worker saat agent menjawab
 * (full-text Postgres; hibrida full-text + vektor sejak Fase 12D bila
 * provider embedding aktif — lihat @sahabat-kreator/core kb.ts).
 *
 * Lampiran berkas (12C): hanya PDF/TXT/MD ≤5MB; teks hasil ekstraksi
 * menjadi entri dokumen biasa (judul = nama berkas) sehingga halaman
 * Knowledge menampilkannya di daftar dokumen yang sama. Berkas tanpa
 * teks yang bisa diekstrak (PDF pindaian, berkas rusak) ditolak 422
 * KB_DOCUMENT_NO_TEXT dan TIDAK disimpan sama sekali.
 */

/** Dependensi status semantik (Fase 12D): resolver Panel Admin proses API + env embedding. */
export interface KnowledgeRoutesDeps {
  platform?: PlatformSettingsOptions;
  embeddingProviderEnv?: string;
  embeddingModelEnv?: string;
}

export function createKnowledgeRoutes(
  bundle: AuthBundle | null,
  deps: KnowledgeRoutesDeps = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/kb/documents";

  if (!bundle) {
    const notConfigured = (c: Parameters<typeof apiError>[0]) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.post(base, notConfigured);
    app.get(base, notConfigured);
    app.get(`${base}/:id`, notConfigured);
    app.delete(`${base}/:id`, notConfigured);
    app.post("/tenants/:tenantId/kb/files", notConfigured);
    app.get("/tenants/:tenantId/kb/files", notConfigured);
    app.delete("/tenants/:tenantId/kb/files/:id", notConfigured);
    app.get("/tenants/:tenantId/kb/stats", notConfigured);
    return app;
  }

  const auth = requireAuth(bundle);
  app.use("/tenants/*", auth);

  const resolveTenant = async (c: AppContext) =>
    resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      c.get("appUser").id,
    );

  app.post(base, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateKbDocumentRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid knowledge document payload");
    }
    const created = await createKbDocument(
      bundle.db,
      { tenantId: tenant.id },
      parsed.data,
    );
    return c.json(serializeDocument(created), 201);
  });

  app.get(base, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listKbDocuments(bundle.db, { tenantId: tenant.id });
    const body = KbDocumentListResponseSchema.parse({
      documents: rows.map(serializeDocument),
    });
    return c.json(body);
  });

  app.get(`${base}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Knowledge document not found");
    }
    const doc = await getKbDocument(bundle.db, { tenantId: tenant.id }, id);
    if (!doc) return apiError(c, 404, "NOT_FOUND", "Knowledge document not found");
    return c.json(serializeDocument(doc));
  });

  app.delete(`${base}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Knowledge document not found");
    }
    const deleted = await deleteKbDocument(
      bundle.db,
      { tenantId: tenant.id },
      id,
    );
    if (!deleted) {
      return apiError(c, 404, "NOT_FOUND", "Knowledge document not found");
    }
    return c.body(null, 204);
  });

  // ——— Lampiran berkas (Fase 12C) ———
  const filesBase = "/tenants/:tenantId/kb/files";

  app.post(filesBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    // Tolak lebih dulu dari header sebelum body dibaca ke memori.
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (declaredLength > KB_FILE_MAX_BYTES + 65_536) {
      return apiError(
        c,
        422,
        "KB_DOCUMENT_TOO_LARGE",
        "File exceeds the 5 MB limit",
      );
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Request body must be multipart form data",
      );
    }
    const file = body.file;
    if (!(file instanceof File)) {
      return apiError(c, 400, "VALIDATION_ERROR", "A 'file' field is required");
    }
    if (file.size === 0) {
      return apiError(c, 422, "KB_DOCUMENT_NO_TEXT", "File is empty");
    }
    if (file.size > KB_FILE_MAX_BYTES) {
      return apiError(
        c,
        422,
        "KB_DOCUMENT_TOO_LARGE",
        "File exceeds the 5 MB limit",
      );
    }
    const kind = resolveKbFileKind(file.name, file.type);
    if (!kind) {
      return apiError(
        c,
        422,
        "KB_DOCUMENT_TYPE_UNSUPPORTED",
        "Only PDF, TXT, and Markdown files are supported",
      );
    }
    const data = Buffer.from(await file.arrayBuffer());
    let text: string;
    try {
      text = (await extractKbFileText(kind.kind, data)).trim();
    } catch {
      // PDF rusak/tidak terbaca diperlakukan sama seperti tanpa teks:
      // tidak ada yang disimpan dan user mendapat kode yang sama.
      return apiError(
        c,
        422,
        "KB_DOCUMENT_NO_TEXT",
        "No extractable text found in the file",
      );
    }
    if (!text) {
      return apiError(
        c,
        422,
        "KB_DOCUMENT_NO_TEXT",
        "No extractable text found in the file",
      );
    }
    const fileName = (file.name.trim() || "document").slice(0, 255);
    const created = await importKbFile(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      { fileName, mimeType: kind.mimeType, data, text },
    );
    return c.json(serializeFile(created), 201);
  });

  app.get(filesBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listKbFiles(bundle.db, { tenantId: tenant.id });
    const body = KbFileDocumentListResponseSchema.parse({
      files: rows.map(serializeFile),
    });
    return c.json(body);
  });

  app.delete(`${filesBase}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Knowledge file not found");
    }
    const deleted = await deleteKbFile(
      bundle.db,
      { tenantId: tenant.id, userId: c.get("appUser").id },
      id,
    );
    if (!deleted) {
      return apiError(c, 404, "NOT_FOUND", "Knowledge file not found");
    }
    return c.body(null, 204);
  });

  // ——— Statistik indeks semantik (Fase 12D) ———
  // Status provider di-resolve dengan resolver yang sama seperti
  // worker (cache panel ±60 dtk di core membuatnya murah per request):
  // halaman Knowledge menampilkan keadaan yang benar-benar akan
  // dipakai jalur agent, bukan tebakan dari konfigurasi statis.
  app.get("/tenants/:tenantId/kb/stats", async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const stats = await getKbEmbeddingStats(bundle.db, {
      tenantId: tenant.id,
    });
    let semanticSearch = {
      active: false,
      provider: null as string | null,
      model: null as string | null,
    };
    if (deps.platform) {
      const provider = await resolveEmbeddingProvider(bundle.db, {
        platform: deps.platform,
        providerEnv: deps.embeddingProviderEnv,
        modelEnv: deps.embeddingModelEnv,
      }).catch(() => null);
      if (provider) {
        semanticSearch = {
          active: true,
          provider: provider.name,
          model: provider.model,
        };
      }
    }
    return c.json(
      KbStatsResponseSchema.parse({ ...stats, semanticSearch }),
    );
  });

  return app;
}
