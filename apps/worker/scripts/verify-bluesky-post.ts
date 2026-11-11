/**
 * Verifikasi penerbitan Bluesky melawan fake XRPC (AT Protocol).
 *
 * Bluesky tidak memakai container/URL publik seperti keluarga Meta:
 * adapter menukar app password menjadi sesi, mengunggah BINER media
 * privat repo lewat `uploadBlob`, lalu menulis record
 * `app.bsky.feed.post`. Harness ini membuktikan urutan
 * createSession → uploadBlob → createRecord untuk teks saja,
 * teks+gambar, dan album 4 gambar; bentuk record & facet tautan
 * (offset byte UTF-8); serta pemetaan error — tanpa jaringan atau
 * kredensial nyata.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:bluesky-post
 */
import {
  BlueskyApiError,
  BlueskyClient,
  buildBlueskyPostRecord,
  buildLinkFacets,
  type BlueskyBlobRef,
} from "@sahabat-kreator/channel-bluesky";

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
  authorization: string | null;
  contentType: string | null;
  json: Record<string, unknown> | null;
  binary: Uint8Array | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DID = "did:plc:promo123";
const APP_PASSWORD = "app-password-uji";

function fakeFetch(captured: Captured[]): typeof fetch {
  let blobCount = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body;
    captured.push({
      url,
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      json:
        typeof body === "string"
          ? (JSON.parse(body) as Record<string, unknown>)
          : null,
      binary: body instanceof Uint8Array ? body : null,
    });
    if (url.endsWith("/xrpc/com.atproto.server.createSession")) {
      return jsonResponse({
        did: DID,
        handle: "promo.bsky.social",
        accessJwt: "jwt-akses",
        refreshJwt: "jwt-refresh",
      });
    }
    if (url.endsWith("/xrpc/com.atproto.repo.uploadBlob")) {
      blobCount += 1;
      return jsonResponse({
        blob: {
          $type: "blob",
          ref: { $link: `bafk-blob-${blobCount}` },
          mimeType: "image/jpeg",
          size: 3,
        },
      });
    }
    if (url.endsWith("/xrpc/com.atproto.repo.createRecord")) {
      return jsonResponse({
        uri: `at://${DID}/app.bsky.feed.post/3lxyz`,
        cid: "bafy-cid",
      });
    }
    return jsonResponse({ error: "Unknown", message: "unknown" }, 404);
  }) as typeof fetch;
}

function fakeBlob(link: string): BlueskyBlobRef {
  return {
    $type: "blob",
    ref: { $link: link },
    mimeType: "image/jpeg",
    size: 3,
  };
}

/** Tirukan alur adapter: sesi → unggah semua gambar → tulis record. */
async function publishLikeAdapter(
  client: BlueskyClient,
  text: string,
  images: Array<{ data: Uint8Array; contentType: string; alt: string }>,
): Promise<string> {
  const session = await client.createSession({
    identifier: DID,
    password: APP_PASSWORD,
  });
  const uploaded: Array<{ blob: BlueskyBlobRef; alt: string }> = [];
  for (const image of images) {
    const blob = await client.uploadBlob({
      accessJwt: session.accessJwt,
      data: image.data,
      contentType: image.contentType,
    });
    uploaded.push({ blob, alt: image.alt });
  }
  const record = buildBlueskyPostRecord({ text, images: uploaded });
  const created = await client.createRecord({
    accessJwt: session.accessJwt,
    repo: session.did,
    record,
  });
  return created.uri;
}

async function main(): Promise<void> {
  {
    const captured: Captured[] = [];
    const client = new BlueskyClient({ fetchImpl: fakeFetch(captured) });
    const uri = await publishLikeAdapter(client, "Halo Bluesky", []);
    const paths = captured.map((request) =>
      request.url.replace("https://bsky.social", ""),
    );
    check(
      "Bluesky teks: createSession → createRecord (tanpa uploadBlob)",
      paths.join(",") ===
        "/xrpc/com.atproto.server.createSession,/xrpc/com.atproto.repo.createRecord" &&
        uri === `at://${DID}/app.bsky.feed.post/3lxyz`,
      paths.join(","),
    );
    const createRecord = captured.at(-1)!;
    const record = createRecord.json?.record as
      | Record<string, unknown>
      | undefined;
    check(
      "Bluesky teks: repo/collection/$type/text benar, sesi tanpa auth, record dengan Bearer sesi",
      captured[0]?.json?.identifier === DID &&
        captured[0]?.authorization === null &&
        createRecord.authorization === "Bearer jwt-akses" &&
        createRecord.json?.repo === DID &&
        createRecord.json?.collection === "app.bsky.feed.post" &&
        record?.$type === "app.bsky.feed.post" &&
        record?.text === "Halo Bluesky" &&
        record?.embed === undefined,
      JSON.stringify(createRecord.json),
    );
  }

  {
    const captured: Captured[] = [];
    const client = new BlueskyClient({ fetchImpl: fakeFetch(captured) });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    await publishLikeAdapter(client, "Foto promo", [
      { data: bytes, contentType: "image/jpeg", alt: "foto.jpg" },
    ]);
    const upload = captured[1]!;
    const record = captured.at(-1)?.json?.record as
      | { embed?: { $type: string; images: Array<{ alt: string; image: BlueskyBlobRef }> } }
      | undefined;
    check(
      "Bluesky gambar: uploadBlob membawa biner mentah + content-type sebelum createRecord",
      captured.length === 3 &&
        upload.url.endsWith("/xrpc/com.atproto.repo.uploadBlob") &&
        upload.binary !== null &&
        Array.from(upload.binary ?? []).join(",") === "255,216,255" &&
        upload.contentType === "image/jpeg" &&
        upload.authorization === "Bearer jwt-akses",
      JSON.stringify(captured.map((request) => request.url)),
    );
    check(
      "Bluesky gambar: embed app.bsky.embed.images merujuk blob hasil unggah",
      record?.embed?.$type === "app.bsky.embed.images" &&
        record?.embed?.images.length === 1 &&
        record?.embed?.images[0]?.image.ref.$link === "bafk-blob-1" &&
        record?.embed?.images[0]?.alt === "foto.jpg",
      JSON.stringify(record?.embed),
    );
  }

  {
    const captured: Captured[] = [];
    const client = new BlueskyClient({ fetchImpl: fakeFetch(captured) });
    const images = [1, 2, 3, 4].map((n) => ({
      data: new Uint8Array([n]),
      contentType: "image/jpeg",
      alt: `foto-${n}.jpg`,
    }));
    await publishLikeAdapter(client, "Album promo", images);
    const record = captured.at(-1)?.json?.record as
      | { embed?: { images: Array<{ image: BlueskyBlobRef }> } }
      | undefined;
    const uploadCount = captured.filter((request) =>
      request.url.endsWith("/xrpc/com.atproto.repo.uploadBlob"),
    ).length;
    check(
      "Bluesky album: 4 uploadBlob lalu 1 createRecord dengan 4 gambar berurutan",
      captured.length === 6 &&
        uploadCount === 4 &&
        record?.embed?.images.map((image) => image.image.ref.$link).join(",") ===
          "bafk-blob-1,bafk-blob-2,bafk-blob-3,bafk-blob-4",
      JSON.stringify(captured.map((request) => request.url)),
    );
  }

  {
    const facets = buildLinkFacets("🔥 Promo https://toko.example/promo, gas!");
    const only = facets[0];
    check(
      "Facet tautan: offset BYTE UTF-8 (emoji di depan) dan tanda baca ekor terbuang",
      facets.length === 1 &&
        only?.index.byteStart === 11 &&
        only?.index.byteEnd === 37 &&
        only?.features[0]?.uri === "https://toko.example/promo",
      JSON.stringify(facets),
    );

    let threw = "";
    try {
      buildBlueskyPostRecord({
        text: "terlalu banyak",
        images: [1, 2, 3, 4, 5].map((n) => ({
          blob: fakeBlob(`bafk-${n}`),
          alt: "",
        })),
      });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check(
      "Record builder: gambar ke-5 ditolak lokal (bluesky_media_too_many)",
      threw === "bluesky_media_too_many",
      threw,
    );
  }

  {
    const client = new BlueskyClient({
      fetchImpl: async () =>
        jsonResponse(
          {
            error: "AuthenticationRequired",
            message: "Invalid identifier or password",
          },
          401,
        ),
    });
    let caught: unknown;
    try {
      await client.createSession({
        identifier: DID,
        password: APP_PASSWORD,
      });
    } catch (err) {
      caught = err;
    }
    check(
      "Bluesky error: BlueskyApiError AuthenticationRequired tanpa app password",
      caught instanceof BlueskyApiError &&
        caught.status === 401 &&
        caught.xrpcError === "AuthenticationRequired" &&
        !caught.message.includes(APP_PASSWORD),
      caught instanceof Error ? caught.message : String(caught),
    );
  }

  console.log(`\nverify-bluesky-post: ${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exitCode = 1;
}

await main();
