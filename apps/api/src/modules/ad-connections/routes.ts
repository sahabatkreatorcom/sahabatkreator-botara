import { Hono } from "hono";
import {
  AdConnectionsResponseSchema,
  AdConversionEventListResponseSchema,
  UpdateAdConnectionsRequestSchema,
  type AdConnectionsResponse,
} from "@sahabat-kreator/contracts";
import {
  getAdConnections,
  listAdConversionEvents,
  updateAdConnections,
  type AdConnectionsView,
  type AdConversionDeps,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

export interface AdConnectionsModuleOptions {
  /** Secret enkripsi kredensial tenant (env CHANNEL_TOKEN_SECRET). */
  tokenSecret?: string;
  /** Opsi resolver kredensial platform (Panel Admin → env). */
  platform: AdConversionDeps["platform"];
}

function serializeView(view: AdConnectionsView): AdConnectionsResponse {
  return AdConnectionsResponseSchema.parse(view);
}

/**
 * Modul ad-connections (Gelombang G16) — koneksi iklan MILIK TENANT
 * untuk node flow `send_ad_conversion`:
 *   GET /tenants/:tenantId/ad-connections          status koneksi
 *        (semua member; HANYA penanda terkonfigurasi + identifier
 *        publik — token Meta tidak pernah keluar dari server)
 *   PUT /tenants/:tenantId/ad-connections          simpan
 *        (owner/admin; token dienkripsi core)
 *   GET /tenants/:tenantId/ad-connections/events   riwayat pengiriman
 *        konversi terbaru (semua member; status operasional saja)
 *
 * Koneksi Google Ads tenant TIDAK disimpan modul ini: consent OAuth
 * akun Ads berjalan lewat rute generik per layanan yang sudah ada
 * (POST /tenants/:tenantId/google/ads/connect, callback kanonis
 * /api/oauth/google_ads/callback) dan statusnya dibaca core dari
 * baris google_connections layanan 'ads'. Developer token Google
 * Ads adalah kredensial PLATFORM (Panel Admin) — di sini hanya
 * terlihat status terkonfigurasinya, bukan nilainya.
 */
export function createAdConnectionsRoutes(
  bundle: AuthBundle | null,
  opts: AdConnectionsModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const base = "/tenants/:tenantId/ad-connections";
  const deps: AdConversionDeps = {
    tokenSecret: opts.tokenSecret,
    platform: opts.platform,
  };

  if (!bundle) {
    const notConfigured = (c: Parameters<typeof apiError>[0]) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, notConfigured);
    app.put(base, notConfigured);
    app.get(`${base}/events`, notConfigured);
    return app;
  }

  async function guard(c: AppContext, o: { ownerAdmin: boolean }) {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle!,
      c.req.param("tenantId") ?? "",
      appUser.id,
    );
    if (!tenant) {
      return {
        error: apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found"),
      } as const;
    }
    if (o.ownerAdmin && tenant.role !== "owner" && tenant.role !== "admin") {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage ad connections",
        ),
      } as const;
    }
    return { tenant, appUser: { id: appUser.id } } as const;
  }

  async function readJson(c: AppContext): Promise<unknown | null> {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  }

  app.get(base, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const view = await getAdConnections(bundle.db, g.tenant.id, deps);
    return c.json(serializeView(view));
  });

  app.put(base, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const json = await readJson(c);
    if (json === null) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Request body must be valid JSON",
      );
    }
    const parsed = UpdateAdConnectionsRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "VALIDATION_ERROR",
        "Invalid ad connections payload",
      );
    }
    const result = await updateAdConnections(
      bundle.db,
      g.tenant.id,
      parsed.data,
      { actorType: "user", actorId: g.appUser.id },
      deps,
    );
    if (result.kind === "secret_unconfigured") {
      return apiError(
        c,
        503,
        "INTERNAL_ERROR",
        "Server encryption secret is not configured; the Meta access token cannot be stored",
      );
    }
    return c.json(serializeView(result.view));
  });

  app.get(`${base}/events`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const limitRaw = Number(c.req.query("limit") ?? 20);
    const rows = await listAdConversionEvents(
      bundle.db,
      g.tenant.id,
      Number.isFinite(limitRaw) ? limitRaw : 20,
    );
    return c.json(
      AdConversionEventListResponseSchema.parse({
        events: rows.map((row) => ({
          id: row.id,
          platform: row.platform,
          eventName: row.eventName,
          status: row.status,
          value: row.value !== null ? Number(row.value) : null,
          currency: row.currency,
          valueSource: row.valueSource,
          errorCode: row.errorCode,
          createdAt: row.createdAt.toISOString(),
          sentAt: row.sentAt?.toISOString() ?? null,
        })),
      }),
    );
  });

  return app;
}
