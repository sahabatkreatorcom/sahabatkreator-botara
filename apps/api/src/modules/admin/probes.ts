import { createHash, createHmac } from "node:crypto";

/**
 * Probe uji koneksi Panel Admin (Fase 6C).
 *
 * Kedua probe memakai kunci EFEKTIF hasil resolver core (panel → env)
 * yang diserahkan pemanggil. Aturan keras: kunci TIDAK PERNAH masuk
 * hasil probe, pesan error, atau log — hasil hanya berisi kode stabil +
 * info non-rahasia dari provider. Kegagalan upstream menjadi hasil
 * { ok: false, code } yang jujur, bukan exception.
 */

export interface ProbeResult {
  ok: boolean;
  code: string;
  info?: Record<string, unknown>;
}

const PROBE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// OpenRouter — GET /api/v1/auth/key (status kunci: label, tier, sisa limit)
// ---------------------------------------------------------------------------

interface OpenRouterKeyInfo {
  label?: string;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number;
  is_free_tier?: boolean;
}

export async function probeOpenRouterKey(
  apiKey: string | null,
): Promise<ProbeResult> {
  if (!apiKey) return { ok: false, code: "NOT_CONFIGURED" };
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return { ok: false, code: "OPENROUTER_UNREACHABLE" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "OPENROUTER_AUTH_FAILED" };
  }
  if (!res.ok) {
    // Body upstream tidak digemakan (bisa berisi konteks tak terduga).
    return {
      ok: false,
      code: "OPENROUTER_UNEXPECTED_STATUS",
      info: { status: res.status },
    };
  }
  const body = (await res.json().catch(() => null)) as {
    data?: OpenRouterKeyInfo;
  } | null;
  const data = body?.data ?? {};
  return {
    ok: true,
    code: "OK",
    info: {
      label: data.label ?? null,
      isFreeTier: data.is_free_tier ?? null,
      limit: data.limit ?? null,
      limitRemaining: data.limit_remaining ?? null,
      usage: data.usage ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Resend — GET /domains (Fase 11B): memvalidasi kunci API email; jumlah
// domain terverifikasi adalah info non-rahasia yang berguna bagi pemilik
// (domain pengirim WAJIB terverifikasi di Resend agar kirim berhasil).
// ---------------------------------------------------------------------------

export async function probeResendKey(
  key: string | null,
  apiBase?: string,
): Promise<ProbeResult> {
  if (!key) return { ok: false, code: "NOT_CONFIGURED" };
  const base = (apiBase ?? "https://api.resend.com").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/domains`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    return { ok: false, code: "RESEND_UNREACHABLE" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "RESEND_AUTH_FAILED" };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "RESEND_UNEXPECTED_STATUS",
      info: { status: res.status },
    };
  }
  const body = (await res.json().catch(() => null)) as {
    data?: unknown[];
  } | null;
  return {
    ok: true,
    code: "OK",
    info: { domains: Array.isArray(body?.data) ? body.data.length : 0 },
  };
}

// ---------------------------------------------------------------------------
// Cloudflare R2 — HeadBucket bertanda tangan SigV4 (tanpa dependensi AWS SDK)
// ---------------------------------------------------------------------------

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Turunan kunci penanda tangan SigV4 untuk region 'auto' (konvensi R2). */
function deriveSigV4SigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export interface R2ProbeConfig {
  endpoint: string;
  bucket: string;
}

export async function probeR2Bucket(
  credentials: { accessKeyId: string | null; secretAccessKey: string | null },
  config: R2ProbeConfig,
): Promise<ProbeResult> {
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    return { ok: false, code: "NOT_CONFIGURED" };
  }
  const region = "auto";
  const service = "s3";
  const host = new URL(config.endpoint).host;
  const payloadHash = sha256Hex("");

  /** Satu request bertanda tangan SigV4 untuk method yang diminta. */
  const signedFetch = (method: "HEAD" | "GET"): Promise<Response> => {
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[:-]/g, "")
      .replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      `/${config.bucket}`,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signingKey = deriveSigV4SigningKey(
      credentials.secretAccessKey!,
      dateStamp,
      region,
      service,
    );
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");
    return fetch(`${config.endpoint}/${config.bucket}`, {
      method,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        Authorization:
          `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
      },
    });
  };

  let res: Response;
  try {
    res = await signedFetch("HEAD");
  } catch {
    return { ok: false, code: "R2_UNREACHABLE" };
  }
  if (res.status === 200) return { ok: true, code: "OK" };
  if (res.status === 403 || res.status === 401) {
    return { ok: false, code: "R2_AUTH_FAILED" };
  }
  if (res.status === 404) return { ok: false, code: "R2_BUCKET_NOT_FOUND" };

  // Status lain (mis. 400): HEAD tidak membawa body, jadi baca kode error
  // S3 lewat GET bertanda tangan agar penolakan auth yang dibungkus 400
  // (InvalidAccessKeyId dsb.) tetap terpetakan dengan jujur. Kode error
  // S3 bukan rahasia — hanya ia yang boleh masuk `info`.
  let s3Code: string | undefined;
  try {
    const getRes = await signedFetch("GET");
    const text = await getRes.text();
    s3Code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    if (getRes.status === 404 || s3Code === "NoSuchBucket") {
      return { ok: false, code: "R2_BUCKET_NOT_FOUND" };
    }
  } catch {
    // Abaikan — laporkan status HEAD apa adanya di bawah.
  }
  if (
    s3Code === "InvalidAccessKeyId" ||
    s3Code === "SignatureDoesNotMatch" ||
    s3Code === "AccessDenied"
  ) {
    return { ok: false, code: "R2_AUTH_FAILED" };
  }
  return {
    ok: false,
    code: "R2_UNEXPECTED_STATUS",
    info: { status: res.status, ...(s3Code ? { s3Code } : {}) },
  };
}
