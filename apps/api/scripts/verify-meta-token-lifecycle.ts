/**
 * Verifikasi lifecycle token Meta (migrasi 0010) — regresi tanpa DB:
 *
 *  (a) pemetaan varian tersimpan → System User? (pemilihan objek kirim
 *      IG tanpa panggilan Graph apa pun);
 *  (b) resolver IG dengan varian TERSIMPAN: nol request `/me` (jalur
 *      warisan tetap satu probe per akun);
 *  (c) resolver warisan (varian NULL): probe `/me` + write-back varian
 *      yang terbaca (Page token 400 → page_access_token; SUAT 200 →
 *      system_user_token);
 *  (d) klien refresh `tbft`: endpoint/param/header Bearer yang tepat
 *      (token TIDAK pernah di query), hasil token + expires_in, dan
 *      penolakan Graph 190 terpetakan ke MetaGraphError code 190;
 *  (e) keputusan worker (metaTokenLifecycleDecision): refreshable
 *      (system_user_token/business_token) + konfigurasi lengkap →
 *      "refresh"; Page token/warisan/konfigurasi kurang → "warn";
 *      kesehatan expired vs expiring mengikuti jadwal;
 *  (f) hook isAuthError runner: Graph 190 → true, code lain → false,
 *      WhatsAppGraphError 190 → true.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:meta-token-lifecycle
 */
import {
  MetaGraphClient,
  MetaGraphError,
} from "@sahabat-kreator/channel-messenger";
import { WhatsAppCloudClient, WhatsAppGraphError } from "@sahabat-kreator/channel-whatsapp";
import {
  instagramSendVariantFromTokenType,
  metaSendSpecIsAuthError,
  resolveInstagramSendObjectId,
} from "../src/modules/meta/poller";
import { metaTokenLifecycleDecision } from "@sahabat-kreator/core";

let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passes += 1;
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`GAGAL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

interface Captured {
  url: string;
  authHeader: string | null;
  query: URLSearchParams;
}

function captureFetch(captured: Captured[], respond: () => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url);
    const headerAuth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    captured.push({
      url,
      authHeader: headerAuth,
      query: parsed.searchParams,
    });
    return respond();
  }) as typeof fetch;
}

const IG_ACCOUNT_ID = "17841402278755050";

async function main(): Promise<void> {
  // (a) pemetaan varian tersimpan.
  check(
    "system_user_token → SUAT",
    instagramSendVariantFromTokenType("system_user_token") === true,
  );
  check(
    "business_token → SUAT (non-Page)",
    instagramSendVariantFromTokenType("business_token") === true,
  );
  check(
    "page_access_token → Page",
    instagramSendVariantFromTokenType("page_access_token") === false,
  );
  check(
    "warisan (null) → perlu probe",
    instagramSendVariantFromTokenType(null) === null,
  );

  // (b) varian tersimpan → resolusi TANPA panggilan Graph.
  {
    let fetchCalls = 0;
    const client = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-uji",
      fetchImpl: (input) => {
        fetchCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ message_id: "m_1" }), { status: 200 }),
        );
      },
    });
    const suatTarget = await resolveInstagramSendObjectId(client, {
      channelAccountId: "acc-lc-suat",
      accountExternalId: IG_ACCOUNT_ID,
      tokenType: "system_user_token",
    });
    const pageTarget = await resolveInstagramSendObjectId(client, {
      channelAccountId: "acc-lc-page",
      accountExternalId: IG_ACCOUNT_ID,
      tokenType: "page_access_token",
    });
    check(
      "varian tersimpan SUAT → id akun IG tanpa probe",
      suatTarget === IG_ACCOUNT_ID && fetchCalls === 0,
      `target=${suatTarget} fetch=${fetchCalls}`,
    );
    check(
      "varian tersimpan Page → 'me' tanpa probe",
      pageTarget === "me" && fetchCalls === 0,
      `target=${pageTarget} fetch=${fetchCalls}`,
    );
  }

  // (c) warisan: probe + write-back varian yang terbaca.
  {
    const persisted: Array<string> = [];
    const client = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-uji",
      fetchImpl: captureFetch([], () =>
        new Response(JSON.stringify({ error: { code: 100 } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    const target = await resolveInstagramSendObjectId(
      client,
      {
        channelAccountId: "acc-lc-legacy-page",
        accountExternalId: IG_ACCOUNT_ID,
        tokenType: null,
      },
      async (tokenType) => {
        persisted.push(tokenType);
      },
    );
    check(
      "warisan Page token: probe → 'me' + write-back page_access_token",
      target === "me" &&
        persisted.length === 1 &&
        persisted[0] === "page_access_token",
      `target=${target} persist=${persisted.join(",")}`,
    );
  }
  {
    const persisted: Array<string> = [];
    const client = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-uji",
      fetchImpl: captureFetch([], () =>
        new Response(
          JSON.stringify({
            id: "su_user_1",
            client_business_id: "7567009423375835",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    });
    const target = await resolveInstagramSendObjectId(
      client,
      {
        channelAccountId: "acc-lc-legacy-suat",
        accountExternalId: IG_ACCOUNT_ID,
        tokenType: null,
      },
      async (tokenType) => {
        persisted.push(tokenType);
      },
    );
    check(
      "warisan SUAT: probe → id akun IG + write-back system_user_token",
      target === IG_ACCOUNT_ID &&
        persisted.length === 1 &&
        persisted[0] === "system_user_token",
      `target=${target} persist=${persisted.join(",")}`,
    );
  }

  // (d) klien refresh tbft.
  {
    const captured: Captured[] = [];
    const client = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-lama",
      fetchImpl: captureFetch(captured, () =>
        new Response(
          JSON.stringify({ access_token: "token-baru", expires_in: 5184000 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    });
    const result = await client.refreshSystemUserToken({
      clientId: "app-id-uji",
      clientSecret: "app-secret-uji",
    });
    const req = captured[0];
    check(
      "refresh: endpoint /v26.0/refresh_access_token",
      req?.url.includes("/v26.0/refresh_access_token") === true,
      req?.url,
    );
    check(
      "refresh: grant_type=tbft + client_id/secret di query",
      req?.query.get("grant_type") === "tbft" &&
        req?.query.get("client_id") === "app-id-uji" &&
        req?.query.get("client_secret") === "app-secret-uji",
    );
    check(
      "refresh: token lama via Bearer header (BUKAN query)",
      req?.authHeader === "Bearer token-lama" &&
        req?.query.get("access_token") === null,
      `auth=${req?.authHeader}`,
    );
    check(
      "refresh: hasil token baru + expires_in",
      result.accessToken === "token-baru" && result.expiresInSeconds === 5184000,
    );
    // Penolakan Graph 190 terpetakan dengan code utuh.
    const rejecting = new MetaGraphClient({
      apiVersion: "v26.0",
      accessToken: "token-mati",
      fetchImpl: captureFetch([], () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Error validating access token",
              code: 190,
              error_subcode: 463,
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      ),
    });
    let caught: MetaGraphError | null = null;
    try {
      await rejecting.refreshSystemUserToken({
        clientId: "app-id-uji",
        clientSecret: "app-secret-uji",
      });
    } catch (err) {
      caught = err instanceof MetaGraphError ? err : null;
    }
    check(
      "refresh: token mati → MetaGraphError code 190 subcode 463",
      caught?.graphCode === 190 && caught?.graphSubcode === 463,
      `code=${caught?.graphCode} subcode=${caught?.graphSubcode}`,
    );
  }

  // (e) keputusan worker.
  const now = new Date("2026-11-05T00:00:00Z");
  const soon = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
  const past = new Date(now.getTime() - 24 * 3600 * 1000);
  const d1 = metaTokenLifecycleDecision({
    tokenType: "system_user_token",
    tokenExpiresAt: soon,
    now,
    canRefresh: true,
  });
  check(
    "SUAT ber-kedaluwarsa + konfigurasi lengkap → refresh",
    d1.action === "refresh" && d1.health === "expiring",
    JSON.stringify(d1),
  );
  const d2 = metaTokenLifecycleDecision({
    tokenType: "business_token",
    tokenExpiresAt: past,
    now,
    canRefresh: true,
  });
  check(
    "business_token lewat jadwal → refresh dengan kesehatan expired",
    d2.action === "refresh" && d2.health === "expired",
    JSON.stringify(d2),
  );
  const d3 = metaTokenLifecycleDecision({
    tokenType: "page_access_token",
    tokenExpiresAt: soon,
    now,
    canRefresh: true,
  });
  check(
    "Page token → warn (hubungkan ulang), health expiring",
    d3.action === "warn" && d3.health === "expiring",
    JSON.stringify(d3),
  );
  const d4 = metaTokenLifecycleDecision({
    tokenType: null,
    tokenExpiresAt: past,
    now,
    canRefresh: true,
  });
  check(
    "warisan lewat jadwal → warn dengan health expired",
    d4.action === "warn" && d4.health === "expired",
    JSON.stringify(d4),
  );
  const d5 = metaTokenLifecycleDecision({
    tokenType: "system_user_token",
    tokenExpiresAt: soon,
    now,
    canRefresh: false,
  });
  check(
    "konfigurasi refresh kurang → warn, bukan refresh",
    d5.action === "warn" && d5.health === "expiring",
    JSON.stringify(d5),
  );

  // (f) hook isAuthError runner.
  const graph190 = new MetaGraphError(400, 190, "token invalid");
  const graph100 = new MetaGraphError(400, 100, "other", 2534014);
  const wa190 = new WhatsAppGraphError(400, 190, "wa token invalid");
  check(
    "isAuthError: MetaGraphError 190 → true",
    metaSendSpecIsAuthError(graph190) === true,
  );
  check(
    "isAuthError: MetaGraphError 100 → false",
    metaSendSpecIsAuthError(graph100) === false,
  );
  check(
    "isAuthError: WhatsAppGraphError 190 → true",
    metaSendSpecIsAuthError(wa190) === true,
  );
  check(
    "isAuthError: error lain → false",
    metaSendSpecIsAuthError(new Error("boom")) === false,
  );
  // Sanity: klien WhatsApp tersedia untuk hook (impor terpakai).
  check(
    "klien WhatsApp diekspor (hook lintas klien)",
    typeof WhatsAppCloudClient === "function",
  );

  console.log(`\nverify-meta-token-lifecycle: ${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exitCode = 1;
}

await main();
