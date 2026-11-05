import { Hono, type Context } from "hono";
import { z } from "zod";
import { getProfilePhoto } from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul avatars (Fase 6D) — penyajian foto profil dari tabel
 * `profile_photos` (bytea di DB, lihat core/avatars.ts):
 *   GET /tenants/:tenantId/avatars/channels/:channelAccountId  foto bot/akun
 *   GET /tenants/:tenantId/avatars/contacts/:contactId          foto kontak
 *
 * Kenapa endpoint sendiri dan bukan URL provider: URL file Telegram
 * menyematkan token bot — kredensial penuh channel — jadi TIDAK PERNAH
 * boleh sampai ke klien. Yang diedarkan ke UI hanyalah URL di sini, yang
 * berada di balik sesi dashboard + membership workspace (pola modul
 * tenant lain: non-member → 404 TENANT_NOT_FOUND; foto tak ada / milik
 * tenant lain → 404 NOT_FOUND). Respons membawa ETag (SHA-256 byte foto)
 * + Cache-Control privat agar browser tidak mengunduh ulang foto yang
 * sama; If-None-Match yang cocok dijawab 304.
 */

export function channelAvatarUrl(tenantId: string, channelAccountId: string): string {
  return `/api/tenants/${tenantId}/avatars/channels/${channelAccountId}`;
}

export function contactAvatarUrl(tenantId: string, contactId: string): string {
  return `/api/tenants/${tenantId}/avatars/contacts/${contactId}`;
}

const AVATAR_CACHE_CONTROL = "private, max-age=3600";

export function createAvatarsRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/avatars";

  if (!bundle) {
    app.get(`${base}/channels/:channelAccountId`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    app.get(`${base}/contacts/:contactId`, (c) => apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"));
    return app;
  }


  const serve = async (
    c: Context<{ Variables: AppVariables }>,
    ownerType: "channel_account" | "contact",
    ownerId: string,
  ) => {
    const tenant = await resolveTenantForUser(bundle, c.req.param("tenantId") ?? "", c.get("appUser").id);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (!z.string().uuid().safeParse(ownerId).success) {
      return apiError(c, 404, "NOT_FOUND", "Avatar not found");
    }
    const photo = await getProfilePhoto(bundle.db, { tenantId: tenant.id }, ownerType, ownerId);
    if (!photo) return apiError(c, 404, "NOT_FOUND", "Avatar not found");

    const etag = `"${photo.etag}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304, {
        ETag: etag,
        "Cache-Control": AVATAR_CACHE_CONTROL,
      });
    }
    const bytes = Buffer.isBuffer(photo.data)
      ? new Uint8Array(photo.data)
      : new Uint8Array(Buffer.from(photo.data as Uint8Array));
    return c.body(bytes, 200, {
      "Content-Type": photo.contentType,
      "Cache-Control": AVATAR_CACHE_CONTROL,
      ETag: etag,
    });
  };

  app.get(`${base}/channels/:channelAccountId`, (c) =>
    serve(c, "channel_account", c.req.param("channelAccountId")),
  );
  app.get(`${base}/contacts/:contactId`, (c) =>
    serve(c, "contact", c.req.param("contactId")),
  );

  return app;
}
