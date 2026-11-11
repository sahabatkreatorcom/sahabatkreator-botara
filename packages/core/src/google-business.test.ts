import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_BUSINESS_MANAGE_SCOPE,
  GOOGLE_OAUTH_SCOPES,
  YOUTUBE_UPLOAD_SCOPE,
  deleteGoogleConnection,
  saveGoogleConnection,
  type GoogleDeps,
} from "./google-calendar";
import {
  getGoogleBusinessPublishAccess,
  syncGoogleBusinessLocationAccounts,
} from "./google-business";
import {
  createTestDb,
  TEST_TENANT_B_ID,
  TEST_TENANT_ID,
  type TestDb,
} from "./testing/pglite";

/**
 * Google Business (Gelombang 3) — jembatan koneksi Google → akun lokasi.
 *
 * Yang dijaga di sini:
 * 1. Satu consent Google melayani Calendar + YouTube + Business
 *    Profile (scope business.manage ada di GOOGLE_OAUTH_SCOPES) —
 *    tidak ada jalur OAuth kedua.
 * 2. Sinkronisasi memetakan koneksi Google menjadi SATU baris akun
 *    channel google_business PER LOKASI (identitas saja, TANPA
 *    token) secara idempoten; lokasi yang hilang dari daftar segar
 *    turun ke disconnected.
 * 3. Gerbang publish membedakan "belum terhubung" dari "scope
 *    kurang" — koneksi Google lama tidak boleh tampak seperti
 *    lokasi mati; ia harus bisa dijelaskan sebagai consent yang
 *    perlu diperbarui.
 */

const TOKEN_SECRET = Buffer.alloc(32, 7).toString("base64");
const FULL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  YOUTUBE_UPLOAD_SCOPE,
  GOOGLE_BUSINESS_MANAGE_SCOPE,
].join(" ");
const NO_BUSINESS_SCOPES =
  "openid email https://www.googleapis.com/auth/calendar.events";

const deps: GoogleDeps = {
  platform: { env: {} },
  tokenSecret: TOKEN_SECRET,
  bases: {
    apiBase: "https://google.fake",
    businessBase: "https://business.fake",
    accountManagementBase: "https://accounts.fake",
  },
};

const LOCATION_ONE = {
  name: "accounts/111/locations/222",
  title: "Toko Uji Satu",
};
const LOCATION_TWO = {
  name: "accounts/111/locations/333",
  title: "Toko Uji Dua",
};

/** Daftar lokasi yang dibalas fake API — bisa diubah antar uji. */
let stubLocations: Array<{ name: string; title: string }> = [
  LOCATION_ONE,
  LOCATION_TWO,
];

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
      if (url === "https://accounts.fake/v1/accounts") {
        return new Response(
          JSON.stringify({ accounts: [{ name: "accounts/111" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url.startsWith("https://business.fake/v1/accounts/111/locations")
      ) {
        return new Response(
          JSON.stringify({ locations: stubLocations }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`fetch tak terduga di test google-business: ${url}`);
    }),
  );
  await saveConnection(FULL_SCOPES);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await ctx.close();
});

describe("koneksi Google → Google Business", () => {
  it("satu consent Google memuat scope business.manage", () => {
    expect(GOOGLE_OAUTH_SCOPES).toContain(GOOGLE_BUSINESS_MANAGE_SCOPE);
  });

  it("sinkron membuat satu akun lokasi per lokasi (identitas saja) dan idempoten", async () => {
    const first = await syncGoogleBusinessLocationAccounts(
      ctx.db,
      TEST_TENANT_ID,
      deps,
    );
    expect(first).toEqual([LOCATION_ONE, LOCATION_TWO]);
    const second = await syncGoogleBusinessLocationAccounts(
      ctx.db,
      TEST_TENANT_ID,
      deps,
    );
    expect(second).toHaveLength(2);

    const rows = await ctx.pglite.query(
      `SELECT provider, external_id, display_name, status, access_token_encrypted
         FROM channel_accounts WHERE tenant_id = $1 AND provider = 'google_business'
         ORDER BY external_id`,
      [TEST_TENANT_ID],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      external_id: LOCATION_ONE.name,
      display_name: LOCATION_ONE.title,
      status: "connected",
      // Kredensial TIDAK tinggal di akun channel — ia di koneksi Google.
      access_token_encrypted: null,
    });
  });

  it("lokasi yang hilang dari daftar segar turun ke disconnected", async () => {
    stubLocations = [LOCATION_ONE];
    try {
      const synced = await syncGoogleBusinessLocationAccounts(
        ctx.db,
        TEST_TENANT_ID,
        deps,
      );
      expect(synced).toEqual([LOCATION_ONE]);
      const rows = await ctx.pglite.query(
        `SELECT external_id, status FROM channel_accounts
          WHERE tenant_id = $1 AND provider = 'google_business'
          ORDER BY external_id`,
        [TEST_TENANT_ID],
      );
      expect(rows.rows).toEqual([
        { external_id: LOCATION_ONE.name, status: "connected" },
        { external_id: LOCATION_TWO.name, status: "disconnected" },
      ]);
    } finally {
      stubLocations = [LOCATION_ONE, LOCATION_TWO];
      await syncGoogleBusinessLocationAccounts(ctx.db, TEST_TENANT_ID, deps);
    }
  });

  it("akses publish ok bila scope business.manage ada", async () => {
    const access = await getGoogleBusinessPublishAccess(
      ctx.db,
      TEST_TENANT_ID,
      deps,
    );
    expect(access).toEqual({ kind: "ok", accessToken: "akses-uji" });
  });

  it("koneksi Google lama (tanpa scope business) → scope_missing, bukan not_connected", async () => {
    await saveConnection(NO_BUSINESS_SCOPES);
    const access = await getGoogleBusinessPublishAccess(
      ctx.db,
      TEST_TENANT_ID,
      deps,
    );
    expect(access).toEqual({ kind: "scope_missing" });
    // Tanpa business.manage, daftar lokasi tidak bisa diketahui → sinkron null.
    expect(
      await syncGoogleBusinessLocationAccounts(ctx.db, TEST_TENANT_ID, deps),
    ).toBeNull();
    await saveConnection(FULL_SCOPES);
  });

  it("tenant tanpa koneksi Google → not_connected", async () => {
    expect(
      await getGoogleBusinessPublishAccess(ctx.db, TEST_TENANT_B_ID, deps),
    ).toEqual({ kind: "not_connected" });
    expect(
      await syncGoogleBusinessLocationAccounts(ctx.db, TEST_TENANT_B_ID, deps),
    ).toBeNull();
    await deleteGoogleConnection(ctx.db, TEST_TENANT_B_ID).catch(
      () => undefined,
    );
  });
});
