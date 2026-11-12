import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_SERVICE_SCOPES,
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_UPLOAD_SCOPE,
  deleteGoogleServiceConnection,
  saveGoogleServiceConnection,
  type GoogleDeps,
} from "./google-calendar";
import {
  backfillYouTubeChannelProfile,
  getYouTubePublishAccess,
  syncYouTubeChannelAccount,
} from "./youtube";
import {
  createTestDb,
  TEST_TENANT_B_ID,
  TEST_TENANT_ID,
  type TestDb,
} from "./testing/pglite";

/**
 * YouTube (Gelombang 2) — jembatan koneksi Google → akun channel.
 *
 * Yang dijaga di sini (diperbarui untuk pemisahan Google per
 * layanan, 2026-11-12):
 * 1. Consent YouTube adalah consent LAYANAN youtube sendiri — scope
 *    youtube ada di GOOGLE_SERVICE_SCOPES.youtube dan TIDAK
 *    tercampur scope calendar/business; sumber tokennya koneksi
 *    `google_connections` service='youtube', bukan koneksi gabungan.
 * 2. Sinkronisasi memetakan koneksi youtube menjadi baris akun
 *    channel youtube (identitas + @handle + FOTO kanal; TANPA token)
 *    secara idempoten.
 * 3. Gerbang publish membedakan "belum terhubung" dari "scope
 *    kurang" — dan koneksi CALENDAR saja TIDAK menerbitkan YouTube.
 * 4. Refresh memakai klien layanan youtube (per-layanan menang atas
 *    klien bersama).
 * 5. Backfill profil mengisi foto + handle akun lama tanpa reconnect;
 *    unduhan thumbnail gagal tidak menggagalkan sinkron.
 */

const TOKEN_SECRET = Buffer.alloc(32, 7).toString("base64");
const FULL_SCOPES = [
  "openid",
  "email",
  YOUTUBE_UPLOAD_SCOPE,
  YOUTUBE_READONLY_SCOPE,
].join(" ");
const NO_YOUTUBE_SCOPES =
  "openid email https://www.googleapis.com/auth/calendar.events";

const THUMBNAIL_URL = "https://img.fake/kanal-high.jpg";
const THUMBNAIL_BYTES = Buffer.from("byte-foto-kanal-uji");

const deps: GoogleDeps = {
  platform: { env: {} },
  tokenSecret: TOKEN_SECRET,
  bases: { apiBase: "https://google.fake", tokenBase: "https://google.fake" },
};

/** Form token endpoint terakhir yang terlihat stub (untuk bukti klien refresh). */
let lastTokenForm: URLSearchParams | null = null;
/** Bila true, unduhan thumbnail dibalas 500 (uji fail-soft foto). */
let thumbnailFails = false;

let ctx: TestDb;

async function saveYouTubeConnection(
  tenantId: string,
  scopes: string,
  overrides?: { accessToken?: string; expiresInSec?: number },
): Promise<void> {
  await saveGoogleServiceConnection(ctx.db, tenantId, "youtube", {
    tokens: {
      accessToken: overrides?.accessToken ?? "akses-uji",
      refreshToken: "refresh-uji",
      expiresInSec: overrides?.expiresInSec ?? 3600,
      scope: scopes,
    },
    accountEmail: "pemilik@example.com",
    tokenSecret: TOKEN_SECRET,
  });
}

async function youtubeAccountRow(): Promise<{
  id: string;
  external_id: string;
  display_name: string | null;
  public_handle: string | null;
  status: string;
  access_token_encrypted: string | null;
} | null> {
  const rows = await ctx.pglite.query<{
    id: string;
    external_id: string;
    display_name: string | null;
    public_handle: string | null;
    status: string;
    access_token_encrypted: string | null;
  }>(
    `SELECT id, external_id, display_name, public_handle, status, access_token_encrypted
       FROM channel_accounts WHERE tenant_id = $1 AND provider = 'youtube'`,
    [TEST_TENANT_ID],
  );
  return rows.rows[0] ?? null;
}

async function photoCount(accountId: string): Promise<number> {
  const rows = await ctx.pglite.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM profile_photos
      WHERE tenant_id = $1 AND owner_type = 'channel_account' AND owner_id = $2`,
    [TEST_TENANT_ID, accountId],
  );
  return Number(rows.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  ctx = await createTestDb();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://google.fake/youtube/v3/channels")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "UCkanaluji123",
                snippet: {
                  title: "Kanal Uji",
                  customUrl: "@kanaluji",
                  thumbnails: {
                    default: { url: "https://img.fake/kanal-default.jpg" },
                    high: { url: THUMBNAIL_URL },
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === THUMBNAIL_URL) {
        if (thumbnailFails) {
          return new Response("cdn rusak", { status: 500 });
        }
        return new Response(THUMBNAIL_BYTES, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url === "https://google.fake/token" && init?.method === "POST") {
        lastTokenForm = new URLSearchParams(String(init.body ?? ""));
        return new Response(
          JSON.stringify({
            access_token: "akses-segar",
            expires_in: 3600,
            scope: FULL_SCOPES,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`fetch tak terduga di test youtube: ${url}`);
    }),
  );
  await saveYouTubeConnection(TEST_TENANT_ID, FULL_SCOPES);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await ctx.close();
});

describe("koneksi YouTube → akun channel", () => {
  it("consent per layanan: scope YouTube hanya di set youtube, tidak tercampur", () => {
    expect(GOOGLE_SERVICE_SCOPES.youtube).toContain(YOUTUBE_UPLOAD_SCOPE);
    expect(GOOGLE_SERVICE_SCOPES.youtube).toContain(YOUTUBE_READONLY_SCOPE);
    expect(GOOGLE_SERVICE_SCOPES.youtube.join(" ")).not.toContain(
      "calendar.events",
    );
    expect(GOOGLE_SERVICE_SCOPES.youtube.join(" ")).not.toContain(
      "business.manage",
    );
    expect(GOOGLE_SERVICE_SCOPES.calendar.join(" ")).not.toContain(
      "youtube",
    );
  });

  it("sinkron membuat akun channel youtube (identitas + handle + foto) dan idempoten", async () => {
    const first = await syncYouTubeChannelAccount(
      ctx.db,
      TEST_TENANT_ID,
      deps,
    );
    expect(first).toEqual({
      id: "UCkanaluji123",
      title: "Kanal Uji",
      handle: "@kanaluji",
      thumbnailUrl: THUMBNAIL_URL,
    });
    const second = await syncYouTubeChannelAccount(
      ctx.db,
      TEST_TENANT_ID,
      deps,
    );
    expect(second?.id).toBe("UCkanaluji123");

    const row = await youtubeAccountRow();
    expect(row).toMatchObject({
      external_id: "UCkanaluji123",
      display_name: "Kanal Uji",
      public_handle: "@kanaluji",
      status: "connected",
      // Kredensial TIDAK tinggal di akun channel — ia di koneksi youtube.
      access_token_encrypted: null,
    });
    // Foto kanal tersimpan sebagai byte profile_photos (bukan URL CDN).
    expect(await photoCount(row!.id)).toBe(1);
    const photo = await ctx.pglite.query<{ content_type: string }>(
      `SELECT content_type FROM profile_photos
        WHERE tenant_id = $1 AND owner_type = 'channel_account' AND owner_id = $2`,
      [TEST_TENANT_ID, row!.id],
    );
    expect(photo.rows[0]?.content_type).toBe("image/jpeg");
  });

  it("akses publish ok bila scope upload ada", async () => {
    const access = await getYouTubePublishAccess(ctx.db, TEST_TENANT_ID, deps);
    expect(access).toEqual({ kind: "ok", accessToken: "akses-uji" });
  });

  it("koneksi youtube tanpa scope upload → scope_missing, bukan not_connected", async () => {
    await saveYouTubeConnection(TEST_TENANT_ID, NO_YOUTUBE_SCOPES);
    const access = await getYouTubePublishAccess(ctx.db, TEST_TENANT_ID, deps);
    expect(access).toEqual({ kind: "scope_missing" });
    // Tanpa readonly, channel ID tidak bisa diketahui → sinkron null.
    expect(
      await syncYouTubeChannelAccount(ctx.db, TEST_TENANT_ID, deps),
    ).toBeNull();
    await saveYouTubeConnection(TEST_TENANT_ID, FULL_SCOPES);
  });

  it("tenant yang hanya punya koneksi CALENDAR → YouTube not_connected (layanan terpisah)", async () => {
    await saveGoogleServiceConnection(ctx.db, TEST_TENANT_B_ID, "calendar", {
      tokens: {
        accessToken: "akses-kalender",
        refreshToken: "refresh-kalender",
        expiresInSec: 3600,
        scope: FULL_SCOPES,
      },
      accountEmail: "b@example.com",
      tokenSecret: TOKEN_SECRET,
    });
    expect(
      await getYouTubePublishAccess(ctx.db, TEST_TENANT_B_ID, deps),
    ).toEqual({ kind: "not_connected" });
    expect(
      await syncYouTubeChannelAccount(ctx.db, TEST_TENANT_B_ID, deps),
    ).toBeNull();
    await deleteGoogleServiceConnection(ctx.db, TEST_TENANT_B_ID, "youtube").catch(
      () => undefined,
    );
  });

  it("unduhan thumbnail gagal → akun tetap tersinkron, tanpa foto", async () => {
    const row = await youtubeAccountRow();
    await ctx.pglite.query(
      `DELETE FROM profile_photos WHERE tenant_id = $1 AND owner_id = $2`,
      [TEST_TENANT_ID, row!.id],
    );
    thumbnailFails = true;
    try {
      const identity = await syncYouTubeChannelAccount(
        ctx.db,
        TEST_TENANT_ID,
        deps,
      );
      expect(identity?.id).toBe("UCkanaluji123");
      expect(await photoCount(row!.id)).toBe(0);
    } finally {
      thumbnailFails = false;
    }
  });

  it("backfill mengisi foto + handle akun lama tanpa reconnect; akun asing ditolak", async () => {
    const row = await youtubeAccountRow();
    // Tiru akun warisan: handle dikosongkan, foto memang belum ada
    // (dari uji fail-soft di atas).
    await ctx.pglite.query(
      `UPDATE channel_accounts SET public_handle = NULL WHERE id = $1`,
      [row!.id],
    );
    const filled = await backfillYouTubeChannelProfile(
      ctx.db,
      TEST_TENANT_ID,
      row!.id,
      deps,
    );
    expect(filled).toBe(true);
    expect(await photoCount(row!.id)).toBe(1);
    const after = await youtubeAccountRow();
    expect(after?.public_handle).toBe("@kanaluji");
    // Id akun yang bukan baris youtube tenant ini → false, tanpa efek.
    expect(
      await backfillYouTubeChannelProfile(
        ctx.db,
        TEST_TENANT_ID,
        "99999999-9999-4999-8999-999999999999",
        deps,
      ),
    ).toBe(false);
  });

  it("refresh memakai klien layanan youtube (per-layanan menang atas bersama)", async () => {
    // Token kedaluwarsa → jalur publish harus me-refresh.
    await saveYouTubeConnection(TEST_TENANT_ID, FULL_SCOPES, {
      accessToken: "akses-mati",
      expiresInSec: -60,
    });
    const depsPerService: GoogleDeps = {
      ...deps,
      platform: {
        env: {
          google_oauth_client_id: "klien-bersama",
          google_oauth_client_secret: "secret-bersama",
          google_youtube_client_id: "klien-youtube",
          google_youtube_client_secret: "secret-youtube",
        },
      },
    };
    const access = await getYouTubePublishAccess(
      ctx.db,
      TEST_TENANT_ID,
      depsPerService,
    );
    expect(access).toEqual({ kind: "ok", accessToken: "akses-segar" });
    expect(lastTokenForm?.get("grant_type")).toBe("refresh_token");
    expect(lastTokenForm?.get("client_id")).toBe("klien-youtube");

    // Tanpa pasangan per-layanan, refresh jatuh ke klien bersama.
    await saveYouTubeConnection(TEST_TENANT_ID, FULL_SCOPES, {
      accessToken: "akses-mati",
      expiresInSec: -60,
    });
    const depsShared: GoogleDeps = {
      ...deps,
      platform: {
        env: {
          google_oauth_client_id: "klien-bersama",
          google_oauth_client_secret: "secret-bersama",
        },
      },
    };
    const accessShared = await getYouTubePublishAccess(
      ctx.db,
      TEST_TENANT_ID,
      depsShared,
    );
    expect(accessShared).toEqual({ kind: "ok", accessToken: "akses-segar" });
    expect(lastTokenForm?.get("client_id")).toBe("klien-bersama");
    await saveYouTubeConnection(TEST_TENANT_ID, FULL_SCOPES);
  });
});
