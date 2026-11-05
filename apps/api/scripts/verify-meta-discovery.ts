/**
 * Verifikasi rantai penemuan Instagram fase penemuan SU — tanpa server
 * HTTP, tanpa DB, tanpa Redis. Dijalankan manual & di CI sebagai
 * bagian `verify:ci`.
 *
 * Membuktikan dua tepi baru penemuan yang menutup kasus BISU satu
 * portofolio (app + akun IG dalam portofolio yang sama → BISU hasil
 * dialog tidak memegang penugasan aset: tepi /me kosong, /me/businesses
 * graph_100, TOTAL=0 padahal hibah konfigurasi sah):
 *   e. `business_instagram_accounts` — /{client_business_id}/
 *      instagram_accounts (+ jatuh owned_/client_ pada graph_100).
 *   f. `grant_target_instagram_accounts` — target hibah dari
 *      debug_token (disebut dengan TOKEN APLIKASI), diselesaikan
 *      per akun lewat profil objek.
 * …dan bahwa jalur token user TIDAK berubah sama sekali: kedua tepi
 * inert (tanpa panggilan, tanpa entri jejak) bila client_business_id
 * kosong, urutan label lama persis.
 *
 * Graph ditiru di jahitan `fetchImpl` klien (pola fixture mock Graph
 * meta-oauth): URL + header Authorization diperiksa per skenario —
 * debug_token yang tidak membawa token aplikasi ditolak 190 seperti
 * Graph asli, jadi keberhasilan persona SU sekaligus membuktikan
 * konstruksi panggilan token aplikasi.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:meta-discovery
 */
import {
  MetaGraphClient,
  MetaGraphError,
  type MetaDiscoveryTraceEntry,
  type MetaInstagramDiscoveryContext,
} from "@sahabat-kreator/channel-messenger";

const APP_ID = "100000000000001";
const APP_SECRET = "mock_app_secret";
const SU_TOKEN = "SU_TOKEN_MOCK";
const USER_TOKEN = "USER_TOKEN_MOCK";
const BIZ = "800000000000001";
const BIZ2 = "800000000000002";
const IG = "900000000000001";
const IG2 = "900000000000002";
const IG3 = "900000000000003";
const IG_USER = "900000000000009";
const PAGE = "700000000000001";
const PAGE_TOKEN = "PAGE_TOKEN_MOCK";
const BASE = "https://mock.graph.test";

let passes = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes += 1;
  else process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Mock Graph (fetchImpl) — persona dipilih per skenario.
// ---------------------------------------------------------------------------

type MockReply = { status: number; body: unknown };
const ok = (body: unknown): MockReply => ({ status: 200, body });
const graphError = (status: number, code: number, message: string): MockReply => ({
  status,
  body: { error: { message, type: "OAuthException", code } },
});

interface Persona {
  me: MockReply;
  businessesIgEdge: MockReply; // /me/businesses fields∋instagram_accounts (tepi c)
  businessesPagesEdge: MockReply; // /me/businesses fields∋owned_pages (rantai Page)
  accounts: MockReply; // /me/accounts (kedua varian field)
  debugToken: MockReply;
  businessEdges: Record<string, MockReply>; // "{biz}/{edge}"
  profiles: Record<string, MockReply>; // GET /{ig-id}?fields=id,username
}

let persona: Persona;
let calls: string[] = [];
let debugTokenAuth: string | null = null;

function route(path: string, url: URL, auth: string | null): MockReply {
  const fields = url.searchParams.get("fields") ?? "";
  if (path === "me") return persona.me;
  if (path === "me/assigned_instagram_accounts") return ok({ data: [] });
  if (path === "me/assigned_pages") return ok({ data: [] });
  if (path === "me/accounts") return persona.accounts;
  if (path === "me/businesses") {
    return fields.includes("instagram_accounts")
      ? persona.businessesIgEdge
      : persona.businessesPagesEdge;
  }
  if (path === "debug_token") {
    debugTokenAuth = auth;
    if (auth !== `Bearer ${APP_ID}|${APP_SECRET}`) {
      return graphError(400, 190, "debug_token requires an app access token");
    }
    return persona.debugToken;
  }
  const businessEdge = path.match(
    /^(\d+)\/(instagram_accounts|owned_instagram_accounts|client_instagram_accounts)$/,
  );
  if (businessEdge) {
    return (
      persona.businessEdges[`${businessEdge[1]}/${businessEdge[2]}`] ??
      graphError(404, 803, "unknown business edge")
    );
  }
  if (/^\d+$/.test(path) && fields === "id,username") {
    return persona.profiles[path] ?? graphError(400, 100, "unknown object");
  }
  return graphError(404, 803, `unmocked route: ${path}`);
}

const mockFetch = (async (
  input: string | URL,
  init?: { headers?: Record<string, string> },
): Promise<Response> => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v26\.0\//, "");
  calls.push(path);
  const reply = route(path, url, init?.headers?.authorization ?? null);
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

function clientFor(token: string): MetaGraphClient {
  return new MetaGraphClient({
    baseUrl: BASE,
    accessToken: token,
    fetchImpl: mockFetch,
  });
}

function suContext(clientBusinessId: string | null): MetaInstagramDiscoveryContext {
  return {
    clientBusinessId,
    appId: APP_ID,
    appSecret: APP_SECRET,
    grantTargetCount: 0,
  };
}

const suMe = ok({ id: "SU_ACTOR", client_business_id: BIZ });
const emptyData = ok({ data: [] });
const graph100 = graphError(400, 100, "(#100) identity shape error");

// ---------------------------------------------------------------------------
// Persona A — SU penuh (fixture spesifikasi): /me SU, tepi /me kosong,
// /me/businesses graph_100, debug_token menghibahkan 1 akun IG,
// /{biz}/instagram_accounts memuat akun itu.
// ---------------------------------------------------------------------------
{
  persona = {
    me: suMe,
    businessesIgEdge: graph100,
    businessesPagesEdge: graph100,
    accounts: emptyData,
    debugToken: ok({
      data: {
        granular_scopes: [
          { scope: "instagram_basic", target_ids: [IG] },
          { scope: "instagram_manage_messages", target_ids: [IG] },
          { scope: "instagram_manage_comments", target_ids: [IG] },
          { scope: "business_management", target_ids: [BIZ] },
        ],
      },
    }),
    businessEdges: {
      [`${BIZ}/instagram_accounts`]: ok({
        data: [{ id: IG, username: "su.ig" }],
      }),
    },
    profiles: { [IG]: ok({ id: IG, username: "su.ig" }) },
  };
  calls = [];
  debugTokenAuth = null;
  const client = clientFor(SU_TOKEN);

  const profile = await client.getTokenProfile();
  check("A: probe /me → client_business_id terbaca", profile.clientBusinessId === BIZ);

  const grants = await client.getTokenGrantTargets({
    appId: APP_ID,
    appSecret: APP_SECRET,
  });
  check(
    "A: debug_token → target IG = union 3 scope instagram",
    JSON.stringify(grants.instagramTargetIds) === JSON.stringify([IG]),
    grants.instagramTargetIds.join(","),
  );
  check(
    "A: debug_token → target bisnis = business_management (cek silang)",
    JSON.stringify(grants.businessTargetIds) === JSON.stringify([BIZ]),
  );
  check("A: debug_token tanpa error", grants.error === null);
  check(
    "A: debug_token dipanggil dengan token aplikasi",
    debugTokenAuth === `Bearer ${APP_ID}|${APP_SECRET}`,
  );

  const trace: MetaDiscoveryTraceEntry[] = [];
  const context = suContext(profile.clientBusinessId);
  const candidates = await client.discoverInstagramAccounts(trace, context);
  check("A: total kandidat = 1", candidates.length === 1, `total=${candidates.length}`);
  check(
    "A: kandidat = akun dari tepi bisnis, username benar",
    candidates[0]?.id === IG && candidates[0]?.username === "su.ig",
  );
  check(
    "A: kandidat pageAccessToken=null (kredensial jatuh ke SUAT sesi)",
    candidates[0]?.pageAccessToken === null,
  );
  const labels = trace.map((e) => e.label);
  check(
    "A: urutan label persis (e)(f) sesudah (c), sebelum (d)",
    JSON.stringify(labels) ===
      JSON.stringify([
        "assigned_instagram_accounts",
        "accounts_instagram_business_account",
        "businesses_instagram_accounts",
        "business_instagram_accounts",
        "grant_target_instagram_accounts",
        "pages_accounts",
        "pages_assigned_pages",
        "pages_businesses",
        "pages_backfill",
        "page_instagram_business_account",
      ]),
    labels.join(" → "),
  );
  const edgeE = trace.find((e) => e.label === "business_instagram_accounts");
  const edgeF = trace.find((e) => e.label === "grant_target_instagram_accounts");
  const edgeC = trace.find((e) => e.label === "businesses_instagram_accounts");
  check("A: tepi (e) count=1 tanpa error", edgeE?.count === 1 && edgeE?.error === null);
  check(
    "A: tepi (f) count=0 — target sudah ditemukan (e), dedupe menang",
    edgeF?.count === 0 && edgeF?.error === null,
  );
  check("A: tepi (c) tercatat graph_100", edgeC?.error === "graph_100");
  check(
    "A: grants untuk baris log = 1",
    context.grantTargetCount === 1,
    `grants=${context.grantTargetCount}`,
  );
}

// ---------------------------------------------------------------------------
// Persona B — regresi SU: granular_scopes kosong + tepi bisnis kosong
// → total=0, grants=0 (keadaan kosong yang sah, bukan error).
// ---------------------------------------------------------------------------
{
  persona = {
    me: suMe,
    businessesIgEdge: emptyData,
    businessesPagesEdge: emptyData,
    accounts: emptyData,
    debugToken: ok({ data: { granular_scopes: [] } }),
    businessEdges: { [`${BIZ}/instagram_accounts`]: emptyData },
    profiles: {},
  };
  calls = [];
  const client = clientFor(SU_TOKEN);
  const trace: MetaDiscoveryTraceEntry[] = [];
  const context = suContext(BIZ);
  const candidates = await client.discoverInstagramAccounts(trace, context);
  const edgeE = trace.find((e) => e.label === "business_instagram_accounts");
  const edgeF = trace.find((e) => e.label === "grant_target_instagram_accounts");
  check("B: total kandidat = 0", candidates.length === 0);
  check("B: grants = 0", context.grantTargetCount === 0);
  check(
    "B: tepi (e)+(f) berjalan bersih (count 0, tanpa error)",
    edgeE?.count === 0 && edgeE?.error === null && edgeF?.count === 0 && edgeF?.error === null,
  );
}

// ---------------------------------------------------------------------------
// Persona C — hanya hibah yang menemukan akun: tepi bisnis kosong,
// debug_token menghibahkan akun, profil objek menyelesaikan username.
// ---------------------------------------------------------------------------
{
  persona = {
    me: suMe,
    businessesIgEdge: emptyData,
    businessesPagesEdge: emptyData,
    accounts: emptyData,
    debugToken: ok({
      data: {
        granular_scopes: [
          { scope: "instagram_basic", target_ids: [IG2] },
          { scope: "instagram_manage_messages", target_ids: [IG2] },
        ],
      },
    }),
    businessEdges: { [`${BIZ}/instagram_accounts`]: emptyData },
    profiles: { [IG2]: ok({ id: IG2, username: "grant.only" }) },
  };
  calls = [];
  const client = clientFor(SU_TOKEN);
  const trace: MetaDiscoveryTraceEntry[] = [];
  const context = suContext(BIZ);
  const candidates = await client.discoverInstagramAccounts(trace, context);
  const edgeF = trace.find((e) => e.label === "grant_target_instagram_accounts");
  check(
    "C: total kandidat = 1 lewat tepi (f)",
    candidates.length === 1 && candidates[0]?.id === IG2,
  );
  check(
    "C: username dari panggilan profil objek, token Page null",
    candidates[0]?.username === "grant.only" && candidates[0]?.pageAccessToken === null,
  );
  check("C: tepi (f) count=1, grants=1", edgeF?.count === 1 && context.grantTargetCount === 1);
}

// ---------------------------------------------------------------------------
// Persona D — tepi bisnis utama graph_100 → jatuh ke owned_/client_;
// error non-100 pada tepi utama WAJIB diteruskan (bukan ditelan).
// ---------------------------------------------------------------------------
{
  persona = {
    me: suMe,
    businessesIgEdge: graph100,
    businessesPagesEdge: graph100,
    accounts: emptyData,
    debugToken: ok({ data: { granular_scopes: [] } }),
    businessEdges: {
      [`${BIZ}/instagram_accounts`]: graph100,
      [`${BIZ}/owned_instagram_accounts`]: emptyData,
      [`${BIZ}/client_instagram_accounts`]: ok({
        data: [{ id: IG3, username: "client.ig" }],
      }),
      [`${BIZ2}/instagram_accounts`]: graphError(400, 200, "(#200) permission"),
    },
    profiles: {},
  };
  calls = [];
  const client = clientFor(SU_TOKEN);
  const direct = await client.getBusinessInstagramAccounts(BIZ);
  check(
    "D: graph_100 tepi utama → union fallback menemukan akun client_",
    direct.length === 1 && direct[0]?.id === IG3 && direct[0]?.username === "client.ig",
  );
  let propagated: unknown = null;
  try {
    await client.getBusinessInstagramAccounts(BIZ2);
  } catch (err) {
    propagated = err;
  }
  check(
    "D: error non-100 diteruskan apa adanya",
    propagated instanceof MetaGraphError && propagated.graphCode === 200,
  );
  const trace: MetaDiscoveryTraceEntry[] = [];
  const context = suContext(BIZ);
  const candidates = await client.discoverInstagramAccounts(trace, context);
  const edgeE = trace.find((e) => e.label === "business_instagram_accounts");
  check(
    "D: rantai menemukan akun fallback, tepi (e) count=1 tanpa error",
    candidates.length === 1 && edgeE?.count === 1 && edgeE?.error === null,
  );
}

// ---------------------------------------------------------------------------
// Persona E — paritas token user: TANPA konteks & dengan konteks
// clientBusinessId=null, jejak harus PERSIS urutan lama, debug_token
// tidak pernah dipanggil, kandidat membawa Page token seperti dulu.
// ---------------------------------------------------------------------------
{
  persona = {
    me: ok({ id: "USER_ACTOR" }),
    businessesIgEdge: emptyData,
    businessesPagesEdge: emptyData,
    accounts: ok({
      data: [
        {
          id: PAGE,
          name: "Page One",
          username: "page.one",
          access_token: PAGE_TOKEN,
          instagram_business_account: { id: IG_USER, username: "user.ig" },
        },
      ],
    }),
    debugToken: graphError(500, 1, "must never be called"),
    businessEdges: {},
    profiles: {},
  };
  const legacyLabels = [
    "assigned_instagram_accounts",
    "accounts_instagram_business_account",
    "businesses_instagram_accounts",
    "pages_accounts",
    "pages_assigned_pages",
    "pages_businesses",
    "pages_backfill",
    "page_instagram_business_account",
  ];
  const client = clientFor(USER_TOKEN);

  calls = [];
  const traceLegacy: MetaDiscoveryTraceEntry[] = [];
  const candidatesLegacy = await client.discoverInstagramAccounts(traceLegacy);
  check(
    "E: kandidat user = IG-di-Page dengan Page token (perilaku lama)",
    candidatesLegacy.length === 1 &&
      candidatesLegacy[0]?.id === IG_USER &&
      candidatesLegacy[0]?.username === "user.ig" &&
      candidatesLegacy[0]?.pageAccessToken === PAGE_TOKEN,
  );
  check(
    "E: jejak tanpa konteks = urutan lama persis",
    JSON.stringify(traceLegacy.map((e) => e.label)) === JSON.stringify(legacyLabels),
    traceLegacy.map((e) => e.label).join(" → "),
  );
  check(
    "E: debug_token tidak dipanggil tanpa konteks SU",
    !calls.includes("debug_token"),
  );

  calls = [];
  const traceNullCtx: MetaDiscoveryTraceEntry[] = [];
  const nullContext = suContext(null);
  const candidatesNullCtx = await client.discoverInstagramAccounts(
    traceNullCtx,
    nullContext,
  );
  check(
    "E: konteks clientBusinessId=null → jejak & hasil identik, grants tetap 0",
    JSON.stringify(traceNullCtx.map((e) => e.label)) === JSON.stringify(legacyLabels) &&
      candidatesNullCtx.length === 1 &&
      nullContext.grantTargetCount === 0 &&
      !calls.includes("debug_token"),
  );
}

console.log(`\nverify-meta-discovery: ${passes} PASS${process.exitCode ? " (ADA FAIL)" : ""}`);
