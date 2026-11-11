/**
 * Verifikasi penerbitan Pinterest melawan fake Pinterest API v5.
 *
 * Pinterest menerbitkan satu Pin per post ke board pertama akun:
 * adapter membaca daftar board, memutuskan sumber media (JPEG/PNG
 * sebagai `image_base64` dari biner privat; format lain sebagai
 * `image_url` publik), lalu membuat Pin. Harness ini membuktikan
 * bagian yang menjadi tanggung jawab klien di paket
 * channel-pinterest: pemetaan payload (judul dari title post,
 * deskripsi dari caption, tautan dari URL pertama caption), resolusi
 * board bawaan, bentuk kedua media_source, dan pemetaan error —
 * tanpa jaringan atau kredensial nyata, dan tanpa token bocor.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:pinterest-post
 */
import {
  PinterestApiError,
  PinterestClient,
  buildPinterestPinPayload,
  extractPinterestLink,
  pinterestErrorCode,
  uint8ToBase64,
} from "@sahabat-kreator/channel-pinterest";

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
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);

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
  check(
    "base64: uint8ToBase64 mengkodekan biner dengan benar",
    uint8ToBase64(IMAGE_BYTES) ===
      Buffer.from(IMAGE_BYTES).toString("base64"),
  );
  check(
    "tautan: URL pertama caption diekstrak, tanda baca ekor dibuang",
    extractPinterestLink("Beli di https://toko.example/produk-1, stok terbatas") ===
      "https://toko.example/produk-1" &&
      extractPinterestLink("tanpa tautan sama sekali") === null,
  );
  const pinPayload = buildPinterestPinPayload({
    boardId: "board-1",
    title: "Pin Produk Baru",
    caption: "Deskripsi pin. Beli di https://toko.example/produk-1",
    mediaSource: {
      source_type: "image_base64",
      content_type: "image/jpeg",
      data: uint8ToBase64(IMAGE_BYTES),
    },
    altText: "produk.jpg",
  });
  check(
    "payload: judul dari title, deskripsi dari caption, link + alt_text terisi",
    pinPayload.board_id === "board-1" &&
      pinPayload.title === "Pin Produk Baru" &&
      pinPayload.description.startsWith("Deskripsi pin.") &&
      pinPayload.link === "https://toko.example/produk-1" &&
      pinPayload.alt_text === "produk.jpg" &&
      pinPayload.media_source.source_type === "image_base64",
  );
  const sliced = buildPinterestPinPayload({
    boardId: "board-1",
    title: "j".repeat(150),
    caption: "d".repeat(900),
    mediaSource: { source_type: "image_url", url: "https://cdn.example/x.gif" },
  });
  check(
    "payload: judul dipotong 100 dan deskripsi 800 (pertahanan terakhir)",
    sliced.title.length === 100 && sliced.description.length === 800,
  );

  // --- Board bawaan -------------------------------------------------------
  {
    const captured: Captured[] = [];
    const client = new PinterestClient({
      baseUrl: "https://pinterest.fake",
      fetchImpl: fakeFetch(captured, () =>
        jsonResponse({
          items: [
            { id: "board-1", name: "Produk" },
            { id: "board-2", name: "Inspirasi" },
          ],
        }),
      ),
    });
    const boardId = await client.resolveDefaultBoardId(ACCESS_TOKEN);
    check(
      "board: board PERTAMA akun menjadi tujuan bawaan",
      boardId === "board-1" &&
        captured.length === 1 &&
        captured[0]!.method === "GET" &&
        captured[0]!.url.includes("/v5/boards") &&
        captured[0]!.headers.get("authorization") ===
          `Bearer ${ACCESS_TOKEN}`,
    );
  }
  {
    const client = new PinterestClient({
      baseUrl: "https://pinterest.fake",
      fetchImpl: fakeFetch([], () => jsonResponse({ items: [] })),
    });
    const boardId = await client.resolveDefaultBoardId(ACCESS_TOKEN);
    check(
      "board: akun tanpa board → null (adapter memetakan pinterest_board_missing)",
      boardId === null,
    );
  }

  // --- Buat Pin: base64 ----------------------------------------------------
  {
    const captured: Captured[] = [];
    const client = new PinterestClient({
      baseUrl: "https://pinterest.fake",
      fetchImpl: fakeFetch(captured, () => jsonResponse({ id: "pin-9001" }, 201)),
    });
    const { pinId } = await client.createPin({
      accessToken: ACCESS_TOKEN,
      payload: pinPayload,
    });
    const source = captured[0]!.json?.media_source as {
      source_type?: string;
      content_type?: string;
      data?: string;
    };
    check(
      "pin base64: id Pin dikembalikan; media_source membawa biner ter-base64",
      pinId === "pin-9001" &&
        captured[0]!.method === "POST" &&
        captured[0]!.url === "https://pinterest.fake/v5/pins" &&
        captured[0]!.json?.board_id === "board-1" &&
        source.source_type === "image_base64" &&
        source.content_type === "image/jpeg" &&
        source.data === Buffer.from(IMAGE_BYTES).toString("base64"),
    );
  }

  // --- Buat Pin: image_url ---------------------------------------------------
  {
    const captured: Captured[] = [];
    const client = new PinterestClient({
      baseUrl: "https://pinterest.fake",
      fetchImpl: fakeFetch(captured, () => jsonResponse({ id: "pin-9002" }, 201)),
    });
    const payload = buildPinterestPinPayload({
      boardId: "board-1",
      title: "Pin GIF",
      caption: "Gerak",
      mediaSource: {
        source_type: "image_url",
        url: "https://cdn.example/animasi.gif",
      },
    });
    const { pinId } = await client.createPin({
      accessToken: ACCESS_TOKEN,
      payload,
    });
    const source = captured[0]!.json?.media_source as {
      source_type?: string;
      url?: string;
    };
    check(
      "pin image_url: sumber URL publik diteruskan apa adanya",
      pinId === "pin-9002" &&
        source.source_type === "image_url" &&
        source.url === "https://cdn.example/animasi.gif",
    );
  }

  // --- Pemetaan error ---------------------------------------------------------
  for (const [status, expected, label] of [
    [401, "pinterest_unauthorized", "401 → pinterest_unauthorized"],
    [403, "pinterest_forbidden", "403 → pinterest_forbidden"],
    [429, "pinterest_rate_limited", "429 → pinterest_rate_limited"],
  ] as const) {
    const client = new PinterestClient({
      baseUrl: "https://pinterest.fake",
      fetchImpl: fakeFetch([], () =>
        jsonResponse({ code: status, message: "ditolak provider" }, status),
      ),
    });
    let caught: unknown;
    try {
      await client.createPin({ accessToken: ACCESS_TOKEN, payload: pinPayload });
    } catch (err) {
      caught = err;
    }
    check(
      `error: ${label}, tanpa token bocor`,
      caught instanceof PinterestApiError &&
        pinterestErrorCode(caught) === expected &&
        !caught.message.includes(ACCESS_TOKEN),
      caught instanceof Error ? caught.message : String(caught),
    );
  }

  {
    const client = new PinterestClient({
      baseUrl: "https://pinterest.fake",
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.listBoards(ACCESS_TOKEN);
    } catch (err) {
      caught = err;
    }
    check(
      "error: jaringan gagal → pinterest_network_error",
      caught instanceof PinterestApiError &&
        caught.status === 0 &&
        pinterestErrorCode(caught) === "pinterest_network_error",
    );
  }

  console.log(`\nverify-pinterest-post: ${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exitCode = 1;
}

await main();
