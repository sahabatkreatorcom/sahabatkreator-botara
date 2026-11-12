/**
 * Verifikasi penerbitan YouTube melawan fake Google API.
 *
 * YouTube tidak memakai token pada akun channel: adapter menukar
 * refresh token KONEKSI GOOGLE tenant menjadi access token lewat core
 * (`getYouTubePublishAccess` — jalur refresh yang sama dengan Google
 * Calendar, tercakup rantai verifikasinya sendiri), lalu klien di
 * paket channel-youtube menjalankan `videos.insert` resumable.
 * Harness ini membuktikan bagian yang menjadi tanggung jawab klien:
 * urutan inisiasi sesi → PUT biner → resource video; bentuk metadata
 * (judul dari `title` post, deskripsi dari caption, dan field status
 * dari PILIHAN PENGGUNA per postingan — privasi hasil resolusi
 * adapter, `containsSyntheticMedia` dari pernyataan AI pengguna,
 * `selfDeclaredMadeForKids` tri-state); dan pemetaan error —
 * terutama kuota proyek (1600 unit per insert) ke
 * `youtube_quota_exceeded` — tanpa jaringan atau kredensial nyata.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:youtube-post
 */
import {
  YouTubeApiError,
  YouTubeClient,
  buildYouTubeVideoMetadata,
  youtubeErrorCode,
} from "@sahabat-kreator/channel-youtube";

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
const VIDEO_BYTES = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff]);
const SESSION_URL = "https://google.fake/upload/session/sesi-uji";

interface Captured {
  url: string;
  method: string;
  authHeader: string | null;
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

function googleError(status: number, reason: string, message: string): Response {
  return jsonResponse(
    { error: { code: status, message, errors: [{ reason, message }] } },
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
      authHeader: headers.get("authorization"),
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
  const metadata = buildYouTubeVideoMetadata({
    title: "Review Produk Baru",
    caption: "Deskripsi lengkap video minggu ini.\nTautan ada di bawah.",
    privacyStatus: "private",
    containsSyntheticMedia: true,
  });

  // --- Pemetaan metadata (murni) --------------------------------------
  check(
    "metadata: judul dari title post, deskripsi dari caption utuh",
    metadata.snippet.title === "Review Produk Baru" &&
      metadata.snippet.description.startsWith("Deskripsi lengkap") &&
      metadata.snippet.categoryId === "22" &&
      metadata.status.privacyStatus === "private" &&
      metadata.status.containsSyntheticMedia === true,
  );
  check(
    "metadata: madeForKids tidak ditetapkan pengguna → field TIDAK dikirim (penetapan level kanal berlaku, tri-state)",
    !("selfDeclaredMadeForKids" in metadata.status),
  );
  const withKids = buildYouTubeVideoMetadata({
    title: "Lagu anak",
    caption: "Video untuk anak",
    privacyStatus: "public",
    containsSyntheticMedia: false,
    madeForKids: true,
  });
  const notKids = buildYouTubeVideoMetadata({
    title: "Podcast dewasa",
    caption: "Bukan untuk anak",
    privacyStatus: "unlisted",
    containsSyntheticMedia: false,
    madeForKids: false,
  });
  check(
    "metadata: madeForKids eksplisit diteruskan apa adanya (true dan false sama-sama pernyataan pengguna)",
    withKids.status.selfDeclaredMadeForKids === true &&
      notKids.status.selfDeclaredMadeForKids === false &&
      withKids.status.containsSyntheticMedia === false,
  );
  const fallback = buildYouTubeVideoMetadata({
    title: "   ",
    caption: "\nBaris pertama caption\nBaris kedua",
    privacyStatus: "unlisted",
    containsSyntheticMedia: false,
  });
  check(
    "metadata: judul kosong jatuh ke baris pertama caption",
    fallback.snippet.title === "Baris pertama caption" &&
      fallback.status.privacyStatus === "unlisted",
  );
  const longTitle = buildYouTubeVideoMetadata({
    title: "j".repeat(150),
    caption: "x",
    privacyStatus: "private",
    containsSyntheticMedia: false,
  });
  check(
    "metadata: judul dipotong ke batas 100 (pertahanan terakhir)",
    longTitle.snippet.title.length === 100,
  );

  // --- Alur resumable bahagia ------------------------------------------
  {
    const captured: Captured[] = [];
    const client = new YouTubeClient({
      baseUrl: "https://google.fake",
      fetchImpl: fakeFetch(captured, (call) => {
        if (call.method === "POST") {
          return jsonResponse({}, 200, { location: SESSION_URL });
        }
        return jsonResponse({ id: "vid-uji-123" }, 201);
      }),
    });
    const { videoId } = await client.uploadVideo({
      accessToken: ACCESS_TOKEN,
      metadata,
      data: VIDEO_BYTES,
      contentType: "video/mp4",
    });
    check(
      "resumable: urutan inisiasi → PUT biner → id video",
      videoId === "vid-uji-123" &&
        captured.length === 2 &&
        captured[0]!.method === "POST" &&
        captured[1]!.method === "PUT" &&
        captured[1]!.url === SESSION_URL,
      `videoId=${videoId} panggilan=${captured.length}`,
    );
    check(
      "resumable: inisiasi membawa bearer + header unggah + metadata",
      captured[0]!.url.includes("uploadType=resumable") &&
        captured[0]!.url.includes("/upload/youtube/v3/videos") &&
        captured[0]!.authHeader === `Bearer ${ACCESS_TOKEN}` &&
        captured[0]!.headers.get("x-upload-content-type") === "video/mp4" &&
        captured[0]!.headers.get("x-upload-content-length") ===
          String(VIDEO_BYTES.byteLength) &&
        (captured[0]!.json?.snippet as { title?: string })?.title ===
          "Review Produk Baru" &&
        (captured[0]!.json?.status as { privacyStatus?: string })
          ?.privacyStatus === "private",
    );
    check(
      "resumable: pernyataan AI pengguna sampai ke payload inisiasi (containsSyntheticMedia true); madeForKids yang tidak ditetapkan tidak ada di payload",
      (captured[0]!.json?.status as { containsSyntheticMedia?: boolean })
        ?.containsSyntheticMedia === true &&
        !("selfDeclaredMadeForKids" in (captured[0]!.json?.status ?? {})),
    );
    check(
      "resumable: PUT mengirim biner video apa adanya",
      captured[1]!.binary !== null &&
        captured[1]!.binary.length === VIDEO_BYTES.length &&
        captured[1]!.binary.every((b, i) => b === VIDEO_BYTES[i]) &&
        captured[1]!.headers.get("content-type") === "video/mp4",
    );
  }

  // --- Kuota proyek habis ----------------------------------------------
  {
    const captured: Captured[] = [];
    const client = new YouTubeClient({
      baseUrl: "https://google.fake",
      fetchImpl: fakeFetch(captured, () =>
        googleError(403, "quotaExceeded", "The request cannot be completed."),
      ),
    });
    let caught: unknown;
    try {
      await client.uploadVideo({
        accessToken: ACCESS_TOKEN,
        metadata,
        data: VIDEO_BYTES,
        contentType: "video/mp4",
      });
    } catch (err) {
      caught = err;
    }
    check(
      "kuota: 403 quotaExceeded → youtube_quota_exceeded, tanpa token bocor",
      caught instanceof YouTubeApiError &&
        caught.status === 403 &&
        caught.reason === "quotaExceeded" &&
        youtubeErrorCode(caught) === "youtube_quota_exceeded" &&
        !caught.message.includes(ACCESS_TOKEN),
      caught instanceof Error ? caught.message : String(caught),
    );
    check(
      "kuota: kegagalan inisiasi tidak mencoba PUT",
      captured.length === 1,
    );
  }

  // --- Token ditolak -----------------------------------------------------
  {
    const client = new YouTubeClient({
      baseUrl: "https://google.fake",
      fetchImpl: fakeFetch([], () =>
        googleError(401, "unauthorized", "Invalid Credentials"),
      ),
    });
    let caught: unknown;
    try {
      await client.uploadVideo({
        accessToken: ACCESS_TOKEN,
        metadata,
        data: VIDEO_BYTES,
        contentType: "video/mp4",
      });
    } catch (err) {
      caught = err;
    }
    check(
      "auth: 401 → youtube_unauthorized",
      caught instanceof YouTubeApiError &&
        youtubeErrorCode(caught) === "youtube_unauthorized",
    );
  }

  // --- Sesi tanpa Location + unggahan tidak utuh + jaringan --------------
  {
    const noLocation = new YouTubeClient({
      baseUrl: "https://google.fake",
      fetchImpl: fakeFetch([], () => jsonResponse({}, 200)),
    });
    let caught: unknown;
    try {
      await noLocation.uploadVideo({
        accessToken: ACCESS_TOKEN,
        metadata,
        data: VIDEO_BYTES,
        contentType: "video/mp4",
      });
    } catch (err) {
      caught = err;
    }
    check(
      "sesi: Location hilang → youtube_upload_session_missing",
      caught instanceof YouTubeApiError &&
        youtubeErrorCode(caught) === "youtube_upload_session_missing",
    );

    const incomplete = new YouTubeClient({
      baseUrl: "https://google.fake",
      fetchImpl: fakeFetch([], (call) =>
        call.method === "POST"
          ? jsonResponse({}, 200, { location: SESSION_URL })
          : new Response(null, { status: 308 }),
      ),
    });
    caught = undefined;
    try {
      await incomplete.uploadVideo({
        accessToken: ACCESS_TOKEN,
        metadata,
        data: VIDEO_BYTES,
        contentType: "video/mp4",
      });
    } catch (err) {
      caught = err;
    }
    check(
      "unggah: PUT 308 → youtube_upload_incomplete",
      caught instanceof YouTubeApiError &&
        youtubeErrorCode(caught) === "youtube_upload_incomplete",
    );

    const offline = new YouTubeClient({
      baseUrl: "https://google.fake",
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    });
    caught = undefined;
    try {
      await offline.uploadVideo({
        accessToken: ACCESS_TOKEN,
        metadata,
        data: VIDEO_BYTES,
        contentType: "video/mp4",
      });
    } catch (err) {
      caught = err;
    }
    check(
      "jaringan: fetch gagal → youtube_network_error",
      caught instanceof YouTubeApiError &&
        caught.status === 0 &&
        youtubeErrorCode(caught) === "youtube_network_error",
    );
  }

  console.log(`\nverify-youtube-post: ${passes} PASS, ${failures} FAIL`);
  if (failures > 0) process.exitCode = 1;
}

await main();
