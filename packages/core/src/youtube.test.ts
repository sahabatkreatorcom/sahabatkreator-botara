import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_OAUTH_SCOPES,
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_UPLOAD_SCOPE,
  deleteGoogleConnection,
  saveGoogleConnection,
  type GoogleDeps,
} from "./google-calendar";
import {
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
 * Yang dijaga di sini:
 * 1. Satu consent Google melayani Calendar + YouTube (scope youtube
 *    ada di GOOGLE_OAUTH_SCOPES) — tidak ada jalur OAuth kedua.
 * 2. Sinkronisasi memetakan koneksi Google menjadi baris akun channel
 *    youtube (identitas saja, TANPA token) secara idempoten.
 * 3. Gerbang publish membedakan "belum terhubung" dari "scope kurang"
 *    — koneksi Calendar lama tidak boleh tampak seperti kanal mati;
 *    ia harus bisa dijelaskan sebagai consent yang perlu diperbarui.
 */

const TOKEN_SECRET = Buffer.alloc(32, 7).toString("base64");
const FULL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  YOUTUBE_UPLOAD_SCOPE,
  YOUTUBE_READONLY_SCOPE,
].join(" ");
const CALENDAR_ONLY_SCOPES =
  "openid email https://www.googleapis.com/auth/calendar.events";

const deps: GoogleDeps = {
  platform: { env: {} },
  tokenSecret: TOKEN_SECRET,
  bases: { apiBase: "https://google.fake" },
};

let ctx: TestDb;

async function saveConnection(scopes: string): Promise<void> {
  await saveGoogleConnection(ctx.db, TEST_TENANT_ID, {
    tokens: {
      accessToken: "akses-uji",
      refreshToken: "refresh-uji",
      expiresInSec: 3600,
      scope: scopes,
    },
    accountEmail: "pemilik@example.com",
    tokenSecret: TOKEN_SECRET,
  });
}

beforeAll(async () => {
  ctx = await createTestDb();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://google.fake/youtube/v3/channels")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: "UCkanaluji123", snippet: { title: "Kanal Uji" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`fetch tak terduga di test youtube: ${url}`);
    }),
  );
  await saveConnection(FULL_SCOPES);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await ctx.close();
});

describe("koneksi Google → YouTube", () => {
  it("satu consent Google memuat scope YouTube", () => {
    expect(GOOGLE_OAUTH_SCOPES).toContain(YOUTUBE_UPLOAD_SCOPE);
    expect(GOOGLE_OAUTH_SCOPES).toContain(YOUTUBE_READONLY_SCOPE);
  });

  it("sinkron membuat akun channel youtube (identitas saja) dan idempoten", async () => {
    const first = await syncYouTubeChannelAccount(
      ctx.db,
      TEST_TENANT_ID,
      deps,
    );
    expect(first).toEqual({ id: "UCkanaluji123", title: "Kanal Uji" });
    const second = await syncYouTubeChannelAccount(
      ctx.db,
      TEST_TENANT_ID,
      deps,
    );
    expect(second?.id).toBe("UCkanaluji123");

    const rows = await ctx.pglite.query(
      `SELECT provider, external_id, display_name, status, access_token_encrypted
         FROM channel_accounts WHERE tenant_id = $1 AND provider = 'youtube'`,
      [TEST_TENANT_ID],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      external_id: "UCkanaluji123",
      display_name: "Kanal Uji",
      status: "connected",
      // Kredensial TIDAK tinggal di akun channel — ia di koneksi Google.
      access_token_encrypted: null,
    });
  });

  it("akses publish ok bila scope upload ada", async () => {
    const access = await getYouTubePublishAccess(ctx.db, TEST_TENANT_ID, deps);
    expect(access).toEqual({ kind: "ok", accessToken: "akses-uji" });
  });

  it("koneksi Calendar lama (tanpa scope YouTube) → scope_missing, bukan not_connected", async () => {
    await saveConnection(CALENDAR_ONLY_SCOPES);
    const access = await getYouTubePublishAccess(ctx.db, TEST_TENANT_ID, deps);
    expect(access).toEqual({ kind: "scope_missing" });
    // Tanpa readonly, channel ID tidak bisa diketahui → sinkron null.
    expect(
      await syncYouTubeChannelAccount(ctx.db, TEST_TENANT_ID, deps),
    ).toBeNull();
    await saveConnection(FULL_SCOPES);
  });

  it("tenant tanpa koneksi Google → not_connected", async () => {
    expect(
      await getYouTubePublishAccess(ctx.db, TEST_TENANT_B_ID, deps),
    ).toEqual({ kind: "not_connected" });
    expect(
      await syncYouTubeChannelAccount(ctx.db, TEST_TENANT_B_ID, deps),
    ).toBeNull();
    await deleteGoogleConnection(ctx.db, TEST_TENANT_B_ID).catch(
      () => undefined,
    );
  });
});
