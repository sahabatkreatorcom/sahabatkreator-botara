import { Hono } from "hono";
import { z } from "zod";
import {
  CreateGrowthLinkRequestSchema,
  GrowthLinkAttributedContactsResponseSchema,
  GrowthLinkListResponseSchema,
  GrowthLinkResponseSchema,
  UpdateGrowthLinkRequestSchema,
  type GrowthLinkResponse,
} from "@sahabat-kreator/contracts";
import {
  buildGrowthTargetUrl,
  createGrowthLink,
  deleteGrowthLink,
  getGrowthLink,
  listGrowthLinkAttributedContacts,
  listGrowthLinks,
  recordGrowthLinkEvent,
  resolveGrowthLinkBySlug,
  updateGrowthLink,
  type GrowthLinkDetailed,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { requireAuth } from "../auth/session";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul growth (Fase 13B) — Growth Tools:
 *   GET    /tenants/:tenantId/growth-links              daftar (semua member)
 *   POST   /tenants/:tenantId/growth-links              buat (owner/admin)
 *   GET    /tenants/:tenantId/growth-links/:id          detail (semua member)
 *   PATCH  /tenants/:tenantId/growth-links/:id          edit (owner/admin)
 *   DELETE /tenants/:tenantId/growth-links/:id          hapus (owner/admin)
 *   GET    /tenants/:tenantId/growth-links/:id/contacts kontak teratribusi
 *   GET    /go/:slug                                    PUBLIK: single → catat
 *          click + 302 ke platform; picker → halaman arahan (picker_view)
 *   GET    /go/:slug/c/:channelAccountId                PUBLIK: tombol picker →
 *          catat click + 302 (akun divalidasi anggota himpunan picker)
 *
 * Slug unik GLOBAL; tabrakan slug pilihan pengguna → 409
 * GROWTH_LINK_SLUG_TAKEN. Konfigurasi channel tidak sah → 422
 * GROWTH_LINK_CHANNEL_INVALID; URL tujuan tak bisa disusun dari data
 * akun (WA/IG tanpa handle publik) → 422 GROWTH_LINK_TARGET_UNAVAILABLE.
 * Rute publik TANPA autentikasi: resolusi slug lewat lengan RLS sempit
 * `growth_link_public_lookup`; slug tak dikenal/nonaktif → halaman 404
 * dwibahasa yang sopan. WhatsApp tidak punya jalur atribusi — di sini
 * hanya kliknya yang tercatat (jujur, dinyatakan juga di UI).
 */
export function serializeGrowthLink(link: GrowthLinkDetailed): GrowthLinkResponse {
  return GrowthLinkResponseSchema.parse({
    id: link.id,
    kind: link.kind,
    label: link.label,
    slug: link.slug,
    publicPath: `/go/${link.slug}`,
    channelAccountId: link.channelAccountId,
    channel: link.channel,
    pickerChannelIds: link.pickerChannelIds,
    pickerChannels: link.pickerChannels,
    autoTag: link.autoTag,
    prefillText: link.prefillText,
    isActive: link.isActive,
    stats: link.stats,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Halaman publik (dihosting API — endpoint redirect tidak bisa SPA)
// ---------------------------------------------------------------------------

type PublicLocale = "en" | "id";

function pickPublicLocale(c: AppContext): PublicLocale {
  const lang = c.req.query("lang");
  if (lang === "id" || lang === "en") return lang;
  const accept = c.req.header("accept-language") ?? "";
  return /\bid\b/.test(accept.toLowerCase()) ? "id" : "en";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PROVIDER_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  messenger: "Messenger",
  instagram: "Instagram",
  webchat: "Live Chat",
};

const PUBLIC_COPY = {
  en: {
    notFoundTitle: "Link not found",
    notFoundBody: "This link is no longer available. Please ask the creator for a new one.",
    pickerSubtitle: "Choose how you'd like to chat with us:",
    chatVia: "Chat via",
    poweredBy: "Powered by Sahabat Kreator",
  },
  id: {
    notFoundTitle: "Tautan tidak ditemukan",
    notFoundBody: "Tautan ini sudah tidak tersedia. Silakan minta tautan baru kepada kreatornya.",
    pickerSubtitle: "Pilih cara mengobrol dengan kami:",
    chatVia: "Ngobrol via",
    poweredBy: "Didukung oleh Sahabat Kreator",
  },
} as const;

function publicPageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #0b1220; color: #f1f5f9; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  @media (prefers-color-scheme: light) { body { background: #f8fafc; color: #0f172a; } .card { background: #ffffff; box-shadow: 0 8px 30px rgba(15,23,42,.08); } .btn { background: #f1f5f9; color: #0f172a; } }
  .card { background: #111c30; border-radius: 16px; padding: 32px 28px; max-width: 420px; width: calc(100% - 48px); text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p.sub { opacity: .75; margin: 0 0 20px; font-size: 15px; }
  .btn { display: block; background: #1e293b; color: #f8fafc; text-decoration: none; border-radius: 12px; padding: 14px 16px; margin: 10px 0; font-weight: 600; font-size: 16px; }
  .btn small { display: block; font-weight: 400; opacity: .7; font-size: 13px; margin-top: 2px; }
  .foot { margin-top: 22px; font-size: 12px; opacity: .5; }
</style>
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>`;
}

function notFoundPage(locale: PublicLocale): string {
  const copy = PUBLIC_COPY[locale];
  return publicPageShell(
    copy.notFoundTitle,
    `<h1>${copy.notFoundTitle}</h1><p class="sub">${copy.notFoundBody}</p><p class="foot">${copy.poweredBy}</p>`,
  );
}

export function createGrowthRoutes(bundle: AuthBundle | null) {
  const app = new Hono<{ Variables: AppVariables }>();

  // ---- Rute PUBLIK /go (tanpa sesi; dipasang sebelum guard sesi) --------
  app.get("/go/:slug", async (c) => {
    const locale = pickPublicLocale(c);
    if (!bundle) return c.html(notFoundPage(locale), 404);
    const slug = c.req.param("slug");
    const resolved = await resolveGrowthLinkBySlug(bundle.db, slug).catch(
      () => null,
    );
    if (!resolved || !resolved.link.isActive) {
      return c.html(notFoundPage(locale), 404);
    }
    const { link } = resolved;
    if (link.kind === "picker") {
      await recordGrowthLinkEvent(bundle.db, {
        tenantId: link.tenantId,
        growthLinkId: link.id,
        kind: "picker_view",
      }).catch(() => undefined);
      const copy = PUBLIC_COPY[locale];
      const buttons = resolved.accounts
        .map((account) => {
          const label = PROVIDER_LABEL[account.provider] ?? account.provider;
          const handle =
            account.provider === "telegram"
              ? account.botUsername
              : account.publicHandle;
          return `<a class="btn" href="/go/${encodeURIComponent(link.slug)}/c/${account.id}">${copy.chatVia} ${escapeHtml(label)}${handle ? `<small>@${escapeHtml(handle.replace(/^@/, ""))}</small>` : ""}</a>`;
        })
        .join("\n");
      const title = resolved.tenantName || link.label;
      return c.html(
        publicPageShell(
          title,
          `<h1>${escapeHtml(title)}</h1><p class="sub">${copy.pickerSubtitle}</p>${buttons}<p class="foot">${copy.poweredBy}</p>`,
        ),
      );
    }
    // kind 'single'
    const account = resolved.accounts[0];
    const target = account ? buildGrowthTargetUrl(link, account) : null;
    if (!account || !target) return c.html(notFoundPage(locale), 404);
    await recordGrowthLinkEvent(bundle.db, {
      tenantId: link.tenantId,
      growthLinkId: link.id,
      kind: "click",
    }).catch(() => undefined);
    return c.redirect(target, 302);
  });

  app.get("/go/:slug/c/:channelAccountId", async (c) => {
    const locale = pickPublicLocale(c);
    if (!bundle) return c.html(notFoundPage(locale), 404);
    const slug = c.req.param("slug");
    const channelAccountId = c.req.param("channelAccountId");
    const resolved = await resolveGrowthLinkBySlug(bundle.db, slug).catch(
      () => null,
    );
    if (!resolved || !resolved.link.isActive || resolved.link.kind !== "picker") {
      return c.html(notFoundPage(locale), 404);
    }
    const account = resolved.accounts.find((a) => a.id === channelAccountId);
    if (!account) return c.html(notFoundPage(locale), 404);
    const target = buildGrowthTargetUrl(resolved.link, account);
    if (!target) return c.html(notFoundPage(locale), 404);
    await recordGrowthLinkEvent(bundle.db, {
      tenantId: resolved.link.tenantId,
      growthLinkId: resolved.link.id,
      kind: "click",
    }).catch(() => undefined);
    return c.redirect(target, 302);
  });

  // ---- Rute dashboard (sesi + membership) --------------------------------
  const base = "/tenants/:tenantId/growth-links";

  if (!bundle) {
    const unavailable = (c: AppContext) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.get(base, unavailable);
    app.post(base, unavailable);
    app.get(`${base}/:id`, unavailable);
    app.patch(`${base}/:id`, unavailable);
    app.delete(`${base}/:id`, unavailable);
    app.get(`${base}/:id/contacts`, unavailable);
    return app;
  }

  const auth = requireAuth(bundle);
  app.use("/tenants/*", auth);

  type GuardOk = {
    tenant: NonNullable<Awaited<ReturnType<typeof resolveTenantForUser>>>;
    appUser: { id: string };
  };
  async function guard(
    c: AppContext,
    opts: { ownerAdmin: boolean },
  ): Promise<GuardOk | { error: Response }> {
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
    if (opts.ownerAdmin && tenant.role !== "owner" && tenant.role !== "admin") {
      return {
        error: apiError(
          c,
          403,
          "FORBIDDEN",
          "Only workspace owners and admins can manage growth links",
        ),
      };
    }
    return { tenant, appUser: { id: appUser.id } };
  }

  function parseUuidParam(c: AppContext): string | null {
    const id = c.req.param("id");
    return typeof id === "string" && z.string().uuid().safeParse(id).success
      ? id
      : null;
  }

  async function readJson(c: AppContext): Promise<unknown | { error: Response }> {
    try {
      return await c.req.json();
    } catch {
      return {
        error: apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON"),
      };
    }
  }

  function channelError(c: AppContext, kind: "channel_invalid" | "target_unavailable") {
    return kind === "channel_invalid"
      ? apiError(
          c,
          422,
          "GROWTH_LINK_CHANNEL_INVALID",
          "Growth link channels must be connected accounts of this workspace (picker needs at least 2)",
        )
      : apiError(
          c,
          422,
          "GROWTH_LINK_TARGET_UNAVAILABLE",
          "A public target URL cannot be built for one of the channels (missing public handle)",
        );
  }

  app.get(base, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const links = await listGrowthLinks(bundle.db, { tenantId: g.tenant.id });
    return c.json(
      GrowthLinkListResponseSchema.parse({
        links: links.map(serializeGrowthLink),
      }),
    );
  });

  app.post(base, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const body = await readJson(c);
    if (typeof body === "object" && body !== null && "error" in body) {
      return (body as { error: Response }).error;
    }
    const parsed = CreateGrowthLinkRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid growth link payload");
    }
    const result = await createGrowthLink(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      kind: parsed.data.kind,
      label: parsed.data.label,
      slug: parsed.data.slug,
      channelAccountId: parsed.data.channelAccountId,
      pickerChannelIds: parsed.data.pickerChannelIds,
      autoTag: parsed.data.autoTag,
      prefillText: parsed.data.prefillText,
    });
    if (result.kind === "slug_taken") {
      return apiError(c, 409, "GROWTH_LINK_SLUG_TAKEN", "That public slug is already in use");
    }
    if (result.kind === "channel_invalid" || result.kind === "target_unavailable") {
      return channelError(c, result.kind);
    }
    return c.json(serializeGrowthLink(result.link), 201);
  });

  app.get(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    const link = await getGrowthLink(bundle.db, { tenantId: g.tenant.id }, id);
    if (!link) return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    return c.json(serializeGrowthLink(link));
  });

  app.patch(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    const body = await readJson(c);
    if (typeof body === "object" && body !== null && "error" in body) {
      return (body as { error: Response }).error;
    }
    const parsed = UpdateGrowthLinkRequestSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid growth link payload");
    }
    const result = await updateGrowthLink(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      id,
      ...parsed.data,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    }
    if (result.kind === "slug_taken") {
      return apiError(c, 409, "GROWTH_LINK_SLUG_TAKEN", "That public slug is already in use");
    }
    if (result.kind === "channel_invalid" || result.kind === "target_unavailable") {
      return channelError(c, result.kind);
    }
    return c.json(serializeGrowthLink(result.link));
  });

  app.delete(`${base}/:id`, async (c) => {
    const g = await guard(c, { ownerAdmin: true });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    const result = await deleteGrowthLink(bundle.db, {
      tenantId: g.tenant.id,
      userId: g.appUser.id,
      id,
    });
    if (result.kind === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    }
    return c.json({ ok: true });
  });

  app.get(`${base}/:id/contacts`, async (c) => {
    const g = await guard(c, { ownerAdmin: false });
    if ("error" in g) return g.error;
    const id = parseUuidParam(c);
    if (!id) return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    const link = await getGrowthLink(bundle.db, { tenantId: g.tenant.id }, id);
    if (!link) return apiError(c, 404, "NOT_FOUND", "Growth link not found");
    const contacts = await listGrowthLinkAttributedContacts(
      bundle.db,
      { tenantId: g.tenant.id },
      id,
    );
    return c.json(
      GrowthLinkAttributedContactsResponseSchema.parse({
        contacts: contacts.map((row) => ({
          contactId: row.contactId,
          name: row.name,
          source: row.source,
          convertedAt: row.convertedAt.toISOString(),
        })),
      }),
    );
  });

  return app;
}
