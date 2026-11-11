import { Hono } from "hono";
import {
  BlueskyConnectRequestSchema,
  BlueskyConnectResponseSchema,
} from "@sahabat-kreator/contracts";
import {
  createBlueskyChannelAccount,
  encryptChannelSecret,
  fetchAndStoreProfilePhotoFromUrl,
  lookupChannelAccountsByProviderExternalId,
  recordChannelConnectedAudit,
  updateBlueskyChannelAccountCredentials,
} from "@sahabat-kreator/core";
import {
  BlueskyApiError,
  BlueskyClient,
} from "@sahabat-kreator/channel-bluesky";
import type { AuthBundle } from "../../auth";
import { apiError, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

/**
 * Modul Bluesky Connect (gelombang Semua OAuth) — Bluesky TIDAK
 * punya OAuth, jadi connect-nya adalah FORMULIR handle + App
 * Password (pola blok connect non-OAuth), divalidasi server:
 *
 *   POST /tenants/:tenantId/bluesky-connect   validasi + hubungkan
 *
 * Alur: `com.atproto.server.createSession` dengan handle + app
 * password membuktikan kredensial sekaligus me-resolve DID (=
 * external_id stabil akun; handle bisa berubah, DID tidak). App
 * password disimpan TERENKRIPSI envelope CHANNEL_TOKEN_SECRET pada
 * kolom token akun — persis format yang dibaca adapter penerbit
 * Gelombang 1.5 (adapter membuat sesi segar tiap publish; accessJwt
 * connect TIDAK disimpan). Sesudah sesi valid, avatar diambil dari
 * `app.bsky.actor.getProfile` (fail-soft pola platform lain).
 *
 * App password TIDAK PERNAH masuk log/respons/audit; kesalahan
 * dibedakan jujur: kredensial ditolak (401/AuthenticationRequired/
 * akun tak ditemukan) → 422 BLUESKY_CREDENTIALS_INVALID; server
 * Bluesky tak terjangkau (jaringan/5xx) → 502 BLUESKY_UNREACHABLE;
 * kunci enkripsi server belum diatur → 503
 * BLUESKY_CONNECT_NOT_CONFIGURED. Penjaga satu akun = satu koneksi
 * lintas workspace sama seperti provider OAuth (409).
 *
 * Menghubungkan ulang akun SENDIRI (status apa pun, termasuk
 * 'error' karena app password lama dicabut) memperbarui app
 * password pada baris yang sama — formulir ini memang jalur rotasi
 * app password-nya; tidak ada baris duplikat.
 */
export interface BlueskyConnectModuleOptions {
  /** Kunci envelope kredensial channel (env CHANNEL_TOKEN_SECRET). */
  channelTokenSecret?: string;
  /** Base URL entryway/PDS Bluesky (env BLUESKY_API_BASE; default bsky.social). */
  blueskyApiBase?: string;
}

export function createBlueskyConnectRoutes(
  bundle: AuthBundle | null,
  opts: BlueskyConnectModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  if (!bundle) {
    app.post("/tenants/:tenantId/bluesky-connect", (c) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured"),
    );
    return app;
  }

  app.post("/tenants/:tenantId/bluesky-connect", async (c) => {
    const appUser = c.get("appUser");
    const tenant = await resolveTenantForUser(
      bundle,
      c.req.param("tenantId"),
      appUser.id,
    );
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    if (tenant.role !== "owner" && tenant.role !== "admin") {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only workspace owners and admins can connect channels",
      );
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = BlueskyConnectRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid Bluesky connect payload");
    }
    if (!opts.channelTokenSecret) {
      return apiError(
        c,
        503,
        "BLUESKY_CONNECT_NOT_CONFIGURED",
        "Bluesky connect is not configured on this server",
      );
    }

    // Handle boleh ditulis dengan '@' di depan; identifier juga
    // bisa berupa DID langsung — keduanya diterima createSession.
    const identifier = parsed.data.handle.replace(/^@+/, "").trim();
    const client = new BlueskyClient({ baseUrl: opts.blueskyApiBase });

    // Validasi kredensial lewat pembuatan sesi. Hanya label tahap +
    // status/nama error XRPC yang dicatat; app password tidak pernah.
    let session: Awaited<ReturnType<BlueskyClient["createSession"]>>;
    try {
      session = await client.createSession({
        identifier,
        password: parsed.data.appPassword,
      });
    } catch (err) {
      if (err instanceof BlueskyApiError) {
        console.error(
          `[bluesky-connect] createSession gagal (${err.status}${err.xrpcError ? ` ${err.xrpcError}` : ""})`,
        );
        if (
          err.status === 401 ||
          err.status === 400 ||
          err.xrpcError === "AuthenticationRequired" ||
          err.xrpcError === "AccountNotFound"
        ) {
          return apiError(
            c,
            422,
            "BLUESKY_CREDENTIALS_INVALID",
            "Bluesky rejected that handle or app password",
          );
        }
        return apiError(
          c,
          502,
          "BLUESKY_UNREACHABLE",
          "The Bluesky server could not be reached",
        );
      }
      console.error("[bluesky-connect] createSession gagal (non-xrpc error)");
      return apiError(
        c,
        502,
        "BLUESKY_UNREACHABLE",
        "The Bluesky server could not be reached",
      );
    }

    // Penjaga satu akun = satu koneksi (identitas = DID sesi).
    const existing = await lookupChannelAccountsByProviderExternalId(
      bundle.db,
      "bluesky",
      session.did,
    );
    const activeElsewhere = existing.find(
      (r) => r.tenantId !== tenant.id && r.status !== "disconnected",
    );
    if (activeElsewhere) {
      return apiError(
        c,
        409,
        "BLUESKY_ACCOUNT_ALREADY_CONNECTED",
        "This Bluesky account is already connected to another workspace",
      );
    }

    let encryptedAppPassword: string;
    try {
      encryptedAppPassword = encryptChannelSecret(
        opts.channelTokenSecret,
        parsed.data.appPassword,
      );
    } catch {
      return apiError(
        c,
        503,
        "BLUESKY_CONNECT_NOT_CONFIGURED",
        "Bluesky connect is not configured on this server",
      );
    }

    const own = existing.find((r) => r.tenantId === tenant.id);
    let rowId: string;
    let created = false;
    if (own) {
      // Baris yang sama: app password baru menggantikan yang lama
      // (jalur rotasi/revive formulir ini).
      const row = await updateBlueskyChannelAccountCredentials(
        bundle.db,
        { tenantId: tenant.id },
        own.id,
        {
          encryptedAppPassword,
          publicHandle: session.handle,
          status: "connected",
        },
      );
      if (!row) {
        return apiError(c, 500, "INTERNAL_ERROR", "Could not update the Bluesky account");
      }
      rowId = row.id;
    } else {
      const row = await createBlueskyChannelAccount(
        bundle.db,
        { tenantId: tenant.id, userId: appUser.id },
        {
          accountExternalId: session.did,
          publicHandle: session.handle,
          encryptedAppPassword,
        },
      );
      rowId = row.id;
      created = true;
    }

    await recordChannelConnectedAudit(
      bundle.db,
      { tenantId: tenant.id, userId: appUser.id },
      { channelAccountId: rowId, provider: "bluesky", method: "manual" },
    );

    // Avatar dari profil AT Protocol (fail-soft): sesi yang BARU
    // dibuat dipakai sekali untuk getProfile; kegagalannya tidak
    // menggagalkan connect (backfill daftar channel mencoba lagi).
    try {
      const profile = await client.getProfile({
        actor: session.did,
        accessJwt: session.accessJwt,
      });
      await fetchAndStoreProfilePhotoFromUrl(bundle.db, {
        tenantId: tenant.id,
        channelAccountId: rowId,
        pictureUrl: profile.avatarUrl,
      });
    } catch {
      console.error(
        `[bluesky-connect] pengambilan profil/avatar akun ${rowId} gagal (fail-soft)`,
      );
    }

    const body = BlueskyConnectResponseSchema.parse({
      channelAccountId: rowId,
      did: session.did,
      handle: session.handle,
      status: "connected",
    });
    return c.json(body, created ? 201 : 200);
  });

  return app;
}
