/**
 * Verifikasi penerbitan TikTok melawan fake TikTok Content Posting
 * API.
 *
 * TikTok menerbitkan satu direct post video per post: adapter
 * memeriksa info kreator (gerbang privasi), membuka sesi unggah
 * FILE_UPLOAD, mengunggah biner per potongan dengan Content-Range,
 * lalu memolling status sampai selesai. Harness ini membuktikan
 * bagian yang menjadi tanggung jawab klien di paket channel-tiktok:
 * perencana potongan, pembangun post_info, gerbang privasi
 * (bawaan SELF_ONLY masa pra-audit), urutan protokol penuh, dan
 * pemetaan error — tanpa jaringan atau kredensial nyata, dan tanpa
 * token bocor.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/worker verify:tiktok-post
 */
import {
  TikTokApiError,
  TikTokClient,
  buildTikTokVideoPostInfo,
  planTikTokUploadChunks,
  resolveTikTokPrivacyLevel,
  tiktokErrorCode,
  type TikTokCreatorInfo,
} from "@sahabat-kreator/channel-tiktok";

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

const ACCESS_TOKEN = "<redacted>";
const MB = 1024 * 1024;

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  json: Record<string, unknown> | null;
  bodyBytes: number;
}

function okEnvelope(data: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ data, error: { code: "ok", message: "", log_id: "log-1" } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorEnvelope(
  code: string,
  message: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({ data: {}, error: { code, message, log_id: "log-2" } }),
    { status, headers: { "content-type": "application/json" } },
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
      bodyBytes:
        body instanceof Uint8Array
          ? body.byteLength
          : typeof body === "string"
            ? body.length
            : 0,
    };
    captured.push(call);
    return handler(call);
  }) as typeof fetch;
}

const CREATOR_INFO: TikTokCreatorInfo = {
  creatorUsername: "tiktokpromo",
  privacyLevelOptions: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"],
  commentDisabled: false,
  duetDisabled: true,
  stitchDisabled: false,
  maxVideoPostDurationSec: 600,
};

async function main(): Promise<void> {
  // --- Perencana potongan (murni) --------------------------------------
  const small = planTikTokUploadChunks(3 * MB);
  check(
    "potongan: video 3MB diunggah utuh satu potongan sebesar berkas",
    small.length === 1 && small[0]!.length === 3 * MB,
  );
  const even = planTikTokUploadChunks(25 * MB, 10 * MB);
  check(
    "potongan: 25MB @10MB menjadi 10+10+5",
    even.length === 3 &&
      even[0]!.length === 10 * MB &&
      even[1]!.length === 10 * MB &&
      even[2]!.length === 5 * MB &&
      even[2]!.offset === 20 * MB,
  );
  const tailed = planTikTokUploadChunks(23 * MB, 10 * MB);
  check(
    "potongan: sisa ekor 3MB (< minimum) digabung ke potongan terakhir",
    tailed.length === 2 &&
      tailed[0]!.length === 10 * MB &&
      tailed[1]!.length === 13 * MB,
  );

  // --- Pembangun post_info + gerbang privasi (murni) --------------------
  const postInfo = buildTikTokVideoPostInfo({
    title: "j".repeat(2500),
    privacyLevel: "SELF_ONLY",
    creatorInfo: CREATOR_INFO,
  });
  check(
    "post_info: judul dipotong 2200 dan disable_* meniru pengaturan kreator",
    postInfo.title.length === 2200 &&
      postInfo.privacy_level === "SELF_ONLY" &&
      postInfo.disable_duet === true &&
      postInfo.disable_comment === false &&
      postInfo.disable_stitch === false,
  );
  check(
    "privasi: level yang diizinkan akun lolos, yang tidak diizinkan ditolak",
    resolveTikTokPrivacyLevel("SELF_ONLY", CREATOR_INFO.privacyLevelOptions) ===
      "SELF_ONLY" &&
      resolveTikTokPrivacyLevel(
        "PUBLIC_TO_EVERYONE",
        CREATOR_INFO.privacyLevelOptions,
      ) === null,
  );

  // --- Alur penuh: creator_info → init → PUT per potongan → polling -----
  const videoData = new Uint8Array(12 * MB).fill(7);
  const captured: Captured[] = [];
  let statusCalls = 0;
  const client = new TikTokClient({
    baseUrl: "https://fake.tiktokapis.test",
    fetchImpl: fakeFetch(captured, (call) => {
      if (call.url.endsWith("/creator_info/query/")) {
        return okEnvelope({
          creator_username: "tiktokpromo",
          privacy_level_options: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"],
          comment_disabled: false,
          duet_disabled: true,
          stitch_disabled: false,
          max_video_post_duration_sec: 600,
        });
      }
      if (call.url.endsWith("/video/init/")) {
        return okEnvelope({
          publish_id: "v_pub_123",
          upload_url: "https://upload.fake.test/video?v=1",
        });
      }
      if (call.url.startsWith("https://upload.fake.test/")) {
        return new Response(null, { status: 201 });
      }
      if (call.url.endsWith("/status/fetch/")) {
        statusCalls += 1;
        return statusCalls === 1
          ? okEnvelope({ status: "PROCESSING_UPLOAD" })
          : okEnvelope({
              status: "PUBLISH_COMPLETE",
              publicaly_available_post_id: [7312345678901],
            });
      }
      return errorEnvelope("invalid_param", "unknown path", 400);
    }),
  });
  const result = await client.publishVideo({
    accessToken: ACCESS_TOKEN,
    title: "Caption promo #fyp",
    privacyLevel: "SELF_ONLY",
    data: videoData,
    contentType: "video/mp4",
    chunkSize: 5 * MB,
    pollIntervalMs: 1,
    maxPolls: 5,
  });
  const order = captured.map((call) =>
    call.url.includes("creator_info")
      ? "creator_info"
      : call.url.includes("video/init")
        ? "init"
        : call.url.includes("upload.fake")
          ? "put"
          : "status",
  );
  check(
    "alur: urutan creator_info → init → PUT per potongan → polling status",
    JSON.stringify(order) ===
      JSON.stringify(["creator_info", "init", "put", "put", "status", "status"]),
    order.join(","),
  );
  const initCall = captured.find((call) => call.url.includes("video/init"))!;
  const initPostInfo = initCall.json?.post_info as Record<string, unknown>;
  const initSource = initCall.json?.source_info as Record<string, unknown>;
  check(
    "init: post_info memakai caption sebagai judul + privasi; source FILE_UPLOAD dengan rencana potongan",
    initPostInfo.title === "Caption promo #fyp" &&
      initPostInfo.privacy_level === "SELF_ONLY" &&
      initPostInfo.disable_duet === true &&
      initSource.source === "FILE_UPLOAD" &&
      initSource.video_size === 12 * MB &&
      initSource.chunk_size === 5 * MB &&
      initSource.total_chunk_count === 2,
  );
  const puts = captured.filter((call) => call.url.includes("upload.fake"));
  check(
    "unggah: Content-Range dan ukuran tiap potongan tepat (5MB lalu 7MB gabungan ekor)",
    puts[0]!.headers.get("content-range") ===
      `bytes 0-${5 * MB - 1}/${12 * MB}` &&
      puts[0]!.bodyBytes === 5 * MB &&
      puts[1]!.headers.get("content-range") ===
        `bytes ${5 * MB}-${12 * MB - 1}/${12 * MB}` &&
      puts[1]!.bodyBytes === 7 * MB &&
      puts.every((put) => put.headers.get("authorization") === null),
  );
  check(
    "hasil: PUBLISH_COMPLETE memberi id postingan; panggilan API membawa Bearer",
    result.publishId === "v_pub_123" &&
      result.postId === "7312345678901" &&
      result.finalStatus === "PUBLISH_COMPLETE" &&
      captured
        .filter((call) => !call.url.includes("upload.fake"))
        .every(
          (call) =>
            call.headers.get("authorization") === `Bearer ${ACCESS_TOKEN}`,
        ),
  );

  // --- Gerbang privasi: level tak diizinkan berhenti SEBELUM init -------
  const mismatchCaptured: Captured[] = [];
  const mismatchClient = new TikTokClient({
    baseUrl: "https://fake.tiktokapis.test",
    fetchImpl: fakeFetch(mismatchCaptured, (call) => {
      if (call.url.endsWith("/creator_info/query/")) {
        return okEnvelope({
          creator_username: "tiktokpromo",
          privacy_level_options: ["SELF_ONLY"],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
        });
      }
      return okEnvelope({ publish_id: "x", upload_url: "https://u.test/" });
    }),
  });
  let mismatchCode = "";
  try {
    await mismatchClient.publishVideo({
      accessToken: ACCESS_TOKEN,
      title: "Ingin publik sebelum audit",
      privacyLevel: "PUBLIC_TO_EVERYONE",
      data: new Uint8Array(1024),
      contentType: "video/mp4",
      pollIntervalMs: 1,
    });
  } catch (err) {
    mismatchCode = tiktokErrorCode(err);
  }
  check(
    "gerbang audit: privasi publik pra-audit ditolak tiktok_privacy_option_mismatch sebelum init",
    mismatchCode === "tiktok_privacy_option_mismatch" &&
      mismatchCaptured.length === 1,
    mismatchCode,
  );

  // --- Pemetaan error ----------------------------------------------------
  async function errorCase(
    handler: Handler,
    run: (c: TikTokClient) => Promise<unknown>,
  ): Promise<{ code: string; err: unknown }> {
    const c = new TikTokClient({
      baseUrl: "https://fake.tiktokapis.test",
      fetchImpl: fakeFetch([], handler),
    });
    try {
      await run(c);
      return { code: "", err: null };
    } catch (err) {
      return { code: tiktokErrorCode(err), err };
    }
  }

  const expired = await errorCase(
    () => errorEnvelope("access_token_invalid", "token expired", 401),
    (c) => c.queryCreatorInfo(ACCESS_TOKEN),
  );
  check(
    "error: access_token_invalid → tiktok_unauthorized dan token tidak bocor ke pesan error",
    expired.code === "tiktok_unauthorized" &&
      expired.err instanceof TikTokApiError &&
      !expired.err.message.includes(ACCESS_TOKEN) &&
      !expired.err.description.includes(ACCESS_TOKEN),
    expired.code,
  );

  const scope = await errorCase(
    () => errorEnvelope("scope_not_authorized", "scope missing", 403),
    (c) => c.queryCreatorInfo(ACCESS_TOKEN),
  );
  check(
    "error: scope_not_authorized → tiktok_scope_missing",
    scope.code === "tiktok_scope_missing",
    scope.code,
  );

  const rateInit: Handler = (call) => {
    if (call.url.endsWith("/creator_info/query/")) {
      return okEnvelope({
        creator_username: "tiktokpromo",
        privacy_level_options: ["SELF_ONLY"],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
      });
    }
    return errorEnvelope("rate_limit_exceeded", "too many requests", 429);
  };
  const rate = await errorCase(rateInit, (c) =>
    c.publishVideo({
      accessToken: ACCESS_TOKEN,
      title: "kena batas",
      privacyLevel: "SELF_ONLY",
      data: new Uint8Array(1024),
      contentType: "video/mp4",
      pollIntervalMs: 1,
    }),
  );
  check(
    "error: rate_limit_exceeded pada init → tiktok_rate_limited",
    rate.code === "tiktok_rate_limited",
    rate.code,
  );

  const spamInit: Handler = (call) => {
    if (call.url.endsWith("/creator_info/query/")) {
      return okEnvelope({
        creator_username: "tiktokpromo",
        privacy_level_options: ["SELF_ONLY"],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
      });
    }
    return errorEnvelope("spam_risk_too_many_posts", "daily post cap", 400);
  };
  const spam = await errorCase(spamInit, (c) =>
    c.publishVideo({
      accessToken: ACCESS_TOKEN,
      title: "kena kuota harian",
      privacyLevel: "SELF_ONLY",
      data: new Uint8Array(1024),
      contentType: "video/mp4",
      pollIntervalMs: 1,
    }),
  );
  check(
    "error: spam_risk_too_many_posts (kuota posting harian) → tiktok_rate_limited",
    spam.code === "tiktok_rate_limited",
    spam.code,
  );

  const failedStatus: Handler = (call) => {
    if (call.url.endsWith("/creator_info/query/")) {
      return okEnvelope({
        creator_username: "tiktokpromo",
        privacy_level_options: ["SELF_ONLY"],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
      });
    }
    if (call.url.endsWith("/video/init/")) {
      return okEnvelope({
        publish_id: "v_pub_fail",
        upload_url: "https://upload.fake.test/video?v=2",
      });
    }
    if (call.url.startsWith("https://upload.fake.test/")) {
      return new Response(null, { status: 201 });
    }
    return okEnvelope({
      status: "FAILED",
      fail_reason: "video_duration_check_failed",
    });
  };
  const failed = await errorCase(failedStatus, (c) =>
    c.publishVideo({
      accessToken: ACCESS_TOKEN,
      title: "video terlalu pendek",
      privacyLevel: "SELF_ONLY",
      data: new Uint8Array(1024),
      contentType: "video/mp4",
      pollIntervalMs: 1,
      maxPolls: 3,
    }),
  );
  check(
    "error: status FAILED → tiktok_publish_failed dengan fail_reason terbawa aman",
    failed.code === "tiktok_publish_failed" &&
      failed.err instanceof TikTokApiError &&
      failed.err.publishFailReason === "video_duration_check_failed",
    failed.code,
  );

  const network = await errorCase(
    () => {
      throw new Error("socket hang up");
    },
    (c) => c.queryCreatorInfo(ACCESS_TOKEN),
  );
  check(
    "error: jaringan putus → tiktok_network_error",
    network.code === "tiktok_network_error",
    network.code,
  );

  console.log(`\n${passes} PASS, ${failures} GAGAL`);
  if (failures > 0) process.exit(1);
}

await main();
