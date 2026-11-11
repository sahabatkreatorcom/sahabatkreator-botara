/**
 * Verifikasi penerbitan LinkedIn melawan fake LinkedIn API.
 *
 * LinkedIn menerbitkan ke PROFIL PRIBADI anggota (`urn:li:person:…`)
 * lewat Posts API: media biner diunggah dulu (Images API untuk
 * gambar, Videos API bertahap untuk video), lalu satu POST
 * /rest/posts merangkainya. Harness ini membuktikan bagian yang
 * menjadi tanggung jawab klien di paket channel-linkedin: urutan
 * inisiasi → PUT biner → buat post; bentuk payload (author person,
 * commentary, media vs multiImage); alur video potongan-per-potongan
 * sampai finalize; header versi ter-pin; dan pemetaan error
 * (401/403/429) — tanpa jaringan atau kredensial nyata, dan tanpa
 * token bocor ke pesan error.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:linkedin-post
 */
import {
  LINKEDIN_API_VERSION,
  LinkedInApiError,
  LinkedInClient,
  buildLinkedInPostPayload,
  linkedinErrorCode,
} from "@sahabat-kreator/channel-linkedin";

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
const MEMBER_ID = "member123abc";
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02]);
const VIDEO_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  json: Record<string, unknown> | null;
  binary: Uint8Array | null;
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
      binary: body instanceof Uint8Array ? body : null,
    };
    captured.push(call);
    return handler(call);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  // --- Pembangun payload (murni) ---------------------------------------
  const textPayload = buildLinkedInPostPayload({
    memberId: MEMBER_ID,
    caption: "Halo LinkedIn",
  });
  check(
    "payload: teks saja — author person, tanpa content, visibility PUBLIC",
    textPayload.author === `urn:li:person:${MEMBER_ID}` &&
      textPayload.commentary === "Halo LinkedIn" &&
      textPayload.content === undefined &&
      textPayload.visibility === "PUBLIC" &&
      textPayload.lifecycleState === "PUBLISHED",
  );
  const single = buildLinkedInPostPayload({
    memberId: MEMBER_ID,
    caption: "Satu gambar",
    images: [{ urn: "urn:li:image:AAA", alt: "foto.jpg" }],
  });
  check(
    "payload: 1 gambar → content.media dengan altText",
    single.content !== undefined &&
      "media" in single.content &&
      single.content.media.id === "urn:li:image:AAA" &&
      single.content.media.altText === "foto.jpg",
  );
  const album = buildLinkedInPostPayload({
    memberId: MEMBER_ID,
    caption: "Album",
    images: [
      { urn: "urn:li:image:AAA", alt: "" },
      { urn: "urn:li:image:BBB", alt: "" },
      { urn: "urn:li:image:CCC", alt: "" },
    ],
  });
  check(
    "payload: ≥2 gambar → content.multiImage berisi semua URN",
    album.content !== undefined &&
      "multiImage" in album.content &&
      album.content.multiImage.images.map((i) => i.id).join(",") ===
        "urn:li:image:AAA,urn:li:image:BBB,urn:li:image:CCC",
  );
  const videoPayload = buildLinkedInPostPayload({
    memberId: MEMBER_ID,
    caption: "Video",
    video: { urn: "urn:li:video:VVV", title: "demo.mp4" },
  });
  check(
    "payload: video → content.media dengan URN video + title",
    videoPayload.content !== undefined &&
      "media" in videoPayload.content &&
      videoPayload.content.media.id === "urn:li:video:VVV" &&
      videoPayload.content.media.title === "demo.mp4",
  );
  const longCaption = buildLinkedInPostPayload({
    memberId: MEMBER_ID,
    caption: "c".repeat(3500),
  });
  check(
    "payload: commentary dipotong ke batas 3000 (pertahanan terakhir)",
    longCaption.commentary.length === 3000,
  );

  // --- Post teks: satu panggilan /rest/posts ----------------------------
  {
    const captured: Captured[] = [];
    const client = new LinkedInClient({
      baseUrl: "https://linkedin.fake",
      fetchImpl: fakeFetch(captured, () =>
        jsonResponse({}, 201, { "x-restli-id": "urn:li:share:9001" }),
      ),
    });
    const { postUrn } = await client.createPost({
      accessToken: ACCESS_TOKEN,
      payload: textPayload,
    });
    check(
      "post teks: id terbit dari header x-restli-id",
      postUrn === "urn:li:share:9001" && captured.length === 1,
    );
    check(
      "post teks: header versi ter-pin + restli + bearer terkirim",
      captured[0]!.headers.get("linkedin-version") ===
        LINKEDIN_API_VERSION &&
        captured[0]!.headers.get("x-restli-protocol-version") === "2.0.0" &&
        captured[0]!.headers.get("authorization") ===
          `Bearer ${ACCESS_TOKEN}` &&
        captured[0]!.url === "https://linkedin.fake/rest/posts",
    );
  }

  // --- Gambar: inisiasi → PUT biner → URN --------------------------------
  {
    const captured: Captured[] = [];
    const client = new LinkedInClient({
      baseUrl: "https://linkedin.fake",
      fetchImpl: fakeFetch(captured, (call) => {
        if (call.url.includes("initializeUpload")) {
          return jsonResponse({
            value: {
              uploadUrl: "https://linkedin.fake/upload/img-1",
              image: "urn:li:image:IMG1",
            },
          });
        }
        return new Response(null, { status: 201 });
      }),
    });
    const urn = await client.uploadImage({
      accessToken: ACCESS_TOKEN,
      ownerUrn: `urn:li:person:${MEMBER_ID}`,
      data: IMAGE_BYTES,
      contentType: "image/jpeg",
    });
    check(
      "gambar: urutan initializeUpload → PUT → URN gambar",
      urn === "urn:li:image:IMG1" &&
        captured.length === 2 &&
        captured[0]!.url.includes("/rest/images?action=initializeUpload") &&
        (captured[0]!.json?.initializeUploadRequest as { owner?: string })
          ?.owner === `urn:li:person:${MEMBER_ID}` &&
        captured[1]!.method === "PUT" &&
        captured[1]!.url === "https://linkedin.fake/upload/img-1",
    );
    check(
      "gambar: PUT mengirim biner apa adanya dengan content-type media",
      captured[1]!.binary !== null &&
        captured[1]!.binary.length === IMAGE_BYTES.length &&
        captured[1]!.binary.every((b, i) => b === IMAGE_BYTES[i]) &&
        captured[1]!.headers.get("content-type") === "image/jpeg",
    );
  }

  // --- Video: inisiasi → PUT per potongan → finalize ----------------------
  {
    const captured: Captured[] = [];
    const client = new LinkedInClient({
      baseUrl: "https://linkedin.fake",
      fetchImpl: fakeFetch(captured, (call) => {
        if (call.url.includes("/rest/videos?action=initializeUpload")) {
          return jsonResponse({
            value: {
              video: "urn:li:video:VID1",
              uploadInstructions: [
                {
                  uploadUrl: "https://linkedin.fake/upload/vid-1/part-0",
                  firstByte: 0,
                  lastByte: 4,
                },
                {
                  uploadUrl: "https://linkedin.fake/upload/vid-1/part-1",
                  firstByte: 5,
                  lastByte: 9,
                },
              ],
            },
          });
        }
        if (call.method === "PUT") {
          const etag = call.url.endsWith("part-0") ? '"etag-0"' : '"etag-1"';
          return new Response(null, { status: 200, headers: { etag } });
        }
        return jsonResponse({}, 200);
      }),
    });
    const urn = await client.uploadVideo({
      accessToken: ACCESS_TOKEN,
      ownerUrn: `urn:li:person:${MEMBER_ID}`,
      data: VIDEO_BYTES,
      contentType: "video/mp4",
    });
    const puts = captured.filter((call) => call.method === "PUT");
    const finalize = captured[captured.length - 1]!;
    check(
      "video: initialize membawa fileSizeBytes; URN video dikembalikan",
      urn === "urn:li:video:VID1" &&
        (captured[0]!.json?.initializeUploadRequest as {
          fileSizeBytes?: number;
        })?.fileSizeBytes === VIDEO_BYTES.byteLength,
    );
    check(
      "video: tiap instruksi di-PUT dengan irisan byte yang tepat",
      puts.length === 2 &&
        puts[0]!.binary?.length === 5 &&
        puts[0]!.binary.every((b, i) => b === VIDEO_BYTES[i]) &&
        puts[1]!.binary?.length === 5 &&
        puts[1]!.binary.every((b, i) => b === VIDEO_BYTES[5 + i]),
    );
    check(
      "video: finalizeUpload membawa semua ETag potongan",
      finalize.url.includes("/rest/videos?action=finalizeUpload") &&
        JSON.stringify(
          (finalize.json?.finalizeUploadRequest as {
            uploadedPartIds?: string[];
          })?.uploadedPartIds,
        ) === JSON.stringify(['"etag-0"', '"etag-1"']) &&
        (finalize.json?.finalizeUploadRequest as { video?: string })
          ?.video === "urn:li:video:VID1",
    );
  }

  // --- Pemetaan error ------------------------------------------------------
  for (const [status, expected, label] of [
    [401, "linkedin_unauthorized", "401 → linkedin_unauthorized"],
    [403, "linkedin_forbidden", "403 → linkedin_forbidden"],
    [429, "linkedin_rate_limited", "429 → linkedin_rate_limited"],
  ] as const) {
    const client = new LinkedInClient({
      baseUrl: "https://linkedin.fake",
      fetchImpl: fakeFetch([], () =>
        jsonResponse({ status, message: "ditolak provider" }, status),
      ),
    });
    let caught: unknown;
    try {
      await client.createPost({
        accessToken: ACCESS_TOKEN,
        payload: textPayload,
      });
    } catch (err) {
      caught = err;
    }
    check(
      `error: ${label}, tanpa token bocor`,
      caught instanceof LinkedInApiError &&
        linkedinErrorCode(caught) === expected &&
        !caught.message.includes(ACCESS_TOKEN),
      caught instanceof Error ? caught.message : String(caught),
    );
  }

  {
    const client = new LinkedInClient({
      baseUrl: "https://linkedin.fake",
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.createPost({
        accessToken: ACCESS_TOKEN,
        payload: textPayload,
      });
    } catch (err) {
      caught = err;
    }
    check(
      "error: jaringan gagal → linkedin_network_error",
      caught instanceof LinkedInApiError &&
        caught.status === 0 &&
        linkedinErrorCode(caught) === "linkedin_network_error",
    );
  }

  console.log(`\nverify-linkedin-post: ${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exitCode = 1;
}

await main();
