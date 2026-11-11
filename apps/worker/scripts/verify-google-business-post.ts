/**
 * Verifikasi penerbitan Google Business melawan fake Business
 * Profile API.
 *
 * Google Business menerbitkan postingan lokal per LOKASI lewat
 * `localPosts.create` dengan access token dari koneksi Google
 * tenant (penukaran refresh token-nya adalah tanggung jawab core,
 * tercakup `google-business.test.ts`). Harness ini membuktikan
 * bagian yang menjadi tanggung jawab klien di paket
 * channel-google-business: URL v4 per lokasi, bentuk payload
 * (summary dari caption, topicType STANDARD, media foto dari
 * sourceUrl publik, CTA LEARN_MORE dari URL caption), dan pemetaan
 * error gerbang platform — PERMISSION_DENIED (akses API belum
 * disetujui / kuota 0) dan RESOURCE_EXHAUSTED mendapat kode khusus —
 * tanpa jaringan atau kredensial nyata, dan tanpa token bocor.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:google-business-post
 */
import {
  GoogleBusinessApiError,
  GoogleBusinessClient,
  buildGoogleBusinessLocalPostPayload,
  googleBusinessErrorCode,
} from "@sahabat-kreator/channel-google-business";

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

const ACCESS_TOKEN = "token-akses-uji";
const LOCATION_NAME = "accounts/111/locations/222";
const PHOTO_URL = "https://cdn.example/etalase.jpg";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  json: Record<string, unknown> | null;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function googleError(
  status: number,
  googleStatus: string,
  message: string,
): Response {
  return jsonResponse(
    { error: { code: status, status: googleStatus, message } },
    status,
  );
}

type Handler = (call: Captured) => Response;

function fakeFetch(captured: Captured[], handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body;
    const call: Captured = {
      url,
      method: init?.method ?? "GET",
      headers,
      json:
        typeof body === "string"
          ? (JSON.parse(body) as Record<string, unknown>)
          : null,
    };
    captured.push(call);
    return handler(call);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  // --- Pembangun payload (murni) ---------------------------------------
  const full = buildGoogleBusinessLocalPostPayload({
    caption: "Promo kopi minggu ini. Detail di https://toko.example/promo.",
    photoUrl: PHOTO_URL,
  });
  check(
    "payload: STANDARD + summary utuh + bahasa id bawaan",
    full.topicType === "STANDARD" &&
      full.languageCode === "id" &&
      full.summary.startsWith("Promo kopi minggu ini."),
  );
  check(
    "payload: foto menjadi media PHOTO sourceUrl; CTA LEARN_MORE dari URL caption",
    full.media?.[0]?.mediaFormat === "PHOTO" &&
      full.media[0].sourceUrl === PHOTO_URL &&
      full.callToAction?.actionType === "LEARN_MORE" &&
      full.callToAction.url === "https://toko.example/promo",
  );
  const textOnly = buildGoogleBusinessLocalPostPayload({
    caption: "Tutup lebih awal hari ini",
  });
  check(
    "payload: tanpa foto & tanpa URL → tanpa media dan tanpa CTA",
    textOnly.media === undefined && textOnly.callToAction === undefined,
  );
  const long = buildGoogleBusinessLocalPostPayload({
    caption: "s".repeat(1700),
  });
  check(
    "payload: summary dipotong ke batas 1500 (pertahanan terakhir)",
    long.summary.length === 1500,
  );

  // --- Buat postingan lokal ------------------------------------------------
  {
    const captured: Captured[] = [];
    const client = new GoogleBusinessClient({
      baseUrl: "https://business.fake",
      fetchImpl: fakeFetch(captured, () =>
        jsonResponse({ name: `${LOCATION_NAME}/localPosts/9001` }, 200),
      ),
    });
    const { localPostName } = await client.createLocalPost({
      accessToken: ACCESS_TOKEN,
      locationName: LOCATION_NAME,
      payload: full,
    });
    check(
      "create: nama resource postingan terbit dikembalikan sebagai id",
      localPostName === `${LOCATION_NAME}/localPosts/9001` &&
        captured.length === 1 &&
        captured[0]!.method === "POST",
    );
    check(
      "create: URL v4 per lokasi + bearer + payload terkirim",
      captured[0]!.url ===
        `https://business.fake/v4/${LOCATION_NAME}/localPosts` &&
        captured[0]!.headers.get("authorization") ===
          `Bearer ${ACCESS_TOKEN}` &&
        captured[0]!.json?.topicType === "STANDARD" &&
        (captured[0]!.json?.media as Array<{ sourceUrl?: string }>)?.[0]
          ?.sourceUrl === PHOTO_URL,
    );
  }

  // --- Pemetaan error gerbang platform --------------------------------------
  for (const [status, googleStatus, expected, label] of [
    [
      403,
      "PERMISSION_DENIED",
      "google_business_permission_denied",
      "403 PERMISSION_DENIED (akses belum disetujui/kuota 0) → google_business_permission_denied",
    ],
    [
      429,
      "RESOURCE_EXHAUSTED",
      "google_business_quota_exceeded",
      "429 RESOURCE_EXHAUSTED → google_business_quota_exceeded",
    ],
    [401, "UNAUTHENTICATED", "google_business_unauthorized", "401 → google_business_unauthorized"],
  ] as const) {
    const client = new GoogleBusinessClient({
      baseUrl: "https://business.fake",
      fetchImpl: fakeFetch([], () =>
        googleError(status, googleStatus, "ditolak provider"),
      ),
    });
    let caught: unknown;
    try {
      await client.createLocalPost({
        accessToken: ACCESS_TOKEN,
        locationName: LOCATION_NAME,
        payload: full,
      });
    } catch (err) {
      caught = err;
    }
    check(
      `error: ${label}, tanpa token bocor`,
      caught instanceof GoogleBusinessApiError &&
        googleBusinessErrorCode(caught) === expected &&
        !caught.message.includes(ACCESS_TOKEN),
      caught instanceof Error ? caught.message : String(caught),
    );
  }

  {
    const client = new GoogleBusinessClient({
      baseUrl: "https://business.fake",
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.createLocalPost({
        accessToken: ACCESS_TOKEN,
        locationName: LOCATION_NAME,
        payload: full,
      });
    } catch (err) {
      caught = err;
    }
    check(
      "error: jaringan gagal → google_business_network_error",
      caught instanceof GoogleBusinessApiError &&
        caught.status === 0 &&
        googleBusinessErrorCode(caught) === "google_business_network_error",
    );
  }

  console.log(
    `\nverify-google-business-post: ${passes} PASS, ${failures} FAIL`,
  );
  if (failures > 0) process.exitCode = 1;
}

await main();
