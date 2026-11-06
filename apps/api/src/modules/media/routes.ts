import { Hono, type Context } from "hono";
import { z } from "zod";
import { getMediaForServing, type MediaObjectStore } from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Penyajian media (Fase 18):
 *   GET /tenants/:tenantId/media/:mediaId
 *
 * Kenapa lewat API, bukan URL object store: bucket privat dan key-nya
 * bukan rahasia yang layak diedarkan. Satu endpoint di balik sesi +
 * keanggotaan workspace membuat aturan aksesnya sama persis dengan
 * seluruh modul tenant lain (non-member → 404 TENANT_NOT_FOUND, media
 * milik tenant lain → 404 NOT_FOUND). Presigned URL akan memindahkan
 * keputusan otorisasi ke tanda tangan yang masa berlakunya tidak bisa
 * dicabut.
 *
 * Kenapa tidak ada `Content-Disposition: attachment`: media ini muncul
 * di dalam gelembung percakapan (gambar, audio, video) dan harus
 * dirender, bukan diunduh. Untuk dokumen, UI memakai atribut
 * `download` pada tautannya — di situ nama berkas asli dipakai.
 *
 * `Cache-Control: private, max-age=3600` + ETag: isi media tidak pernah
 * berubah untuk id yang sama (baris `media` tidak di-update), jadi
 * browser tidak perlu mengunduh ulang saat menggulir percakapan.
 */
const MEDIA_CACHE_CONTROL = "private, max-age=3600";

/** Tipe yang aman dirender inline; sisanya dipaksa jadi unduhan. */
const INLINE_SAFE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "video/mp4",
  "video/3gpp",
]);

export function mediaUrl(tenantId: string, mediaId: string): string {
  return `/api/tenants/${tenantId}/media/${mediaId}`;
}

export function createMediaRoutes(
  bundle: AuthBundle | null,
  store: MediaObjectStore | null,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/media";

  if (!bundle || !store) {
    app.get(`${base}/:mediaId`, (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Media storage is not configured"),
    );
    return app;
  }

  const serve = async (
    c: Context<{ Variables: AppVariables }>,
    mediaId: string,
  ) => {
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      c.get("appUser").id,
    );
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (!z.string().uuid().safeParse(mediaId).success) {
      return apiError(c, 404, "NOT_FOUND", "Media not found");
    }

    const row = await getMediaForServing(bundle.db, { tenantId: tenant.id }, mediaId);
    if (!row) return apiError(c, 404, "NOT_FOUND", "Media not found");

    const object = await store.get(row.r2Key);
    // Baris ada tetapi objeknya tidak: keadaan yang HARUS terlihat, bukan
    // dijawab 200 kosong. Bisa terjadi bila volume penyimpanan diganti
    // tanpa memindahkan berkas lama.
    if (!object) return apiError(c, 404, "NOT_FOUND", "Media object missing");

    const contentType = object.contentType ?? row.mimeType ?? "application/octet-stream";
    const bytes = new Uint8Array(object.data);
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": MEDIA_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    };
    // Dokumen (PDF, docx, …) dipaksa unduh: merender HTML/SVG dari
    // unggahan pengguna di origin dashboard adalah jalur XSS, dan
    // `nosniff` saja tidak menutup semua tipe.
    if (!INLINE_SAFE.has(contentType)) {
      const name = row.fileName?.replace(/["\\\r\n]/g, "_") ?? "berkas";
      headers["Content-Disposition"] = `attachment; filename="${name}"`;
    }
    return c.body(bytes, 200, headers);
  };

  app.get(`${base}/:mediaId`, (c) => serve(c, c.req.param("mediaId")));

  return app;
}
