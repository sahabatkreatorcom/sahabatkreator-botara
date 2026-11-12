import { createHash, createHmac } from "node:crypto";
import type { Database } from "@sahabat-kreator/db";
import {
  getProviderSecret,
  resolveR2Identity,
  type PlatformSettingsOptions,
  type R2Identity,
} from "./platform-settings";

/**
 * Klien objek Cloudflare R2 (S3-compatible) — jalur R2 SUNGGUHAN
 * pertama di repo (keputusan pemilik 2026-11-12, avatar TikTok).
 *
 * Sebelumnya R2 hanya ada sebagai isian Panel Admin + probe HeadBucket
 * (apps/api/modules/admin/probes.ts); penyimpanan media masih di disk
 * dan tidak ada satu pun konstruksi klien R2 untuk menulis objek.
 * Modul ini mengisi jalur tulis/baca objek pertama itu — dipakai
 * avatar TikTok (core/avatars.ts) yang URL CDN-nya bertanda tangan dan
 * kedaluwarsa. Slot R2 pada `media-storage.ts` (media inbox) adalah
 * urusan terpisah dan belum memakai klien ini.
 *
 * Keputusan teknis:
 * - TANPA dependensi AWS SDK: tanda tangan SigV4 ditulis tangan
 *   dengan node:crypto, pola yang sama persis dengan probe R2 panel
 *   (region 'auto', service 's3', gaya path `/{bucket}/{key}`).
 *   Permukaannya sengaja kecil — hanya `put` + `get` yang dibutuhkan
 *   jalur avatar (tulis saat connect/backfill, baca saat penyajian).
 * - Identitas (endpoint/bucket) dan kredensial TIDAK PERNAH dibaca
 *   dari konstanta boot: `resolveR2ObjectStore` menyelesaikannya per
 *   pemakaian lewat resolver Panel Admin (panel → env), jadi isian
 *   panel berlaku tanpa restart dalam jendela cache resolver.
 * - Kredensial TIDAK PERNAH masuk error/log: kegagalan dilempar
 *   sebagai `R2ObjectStoreError` berisi status HTTP + kode S3 resmi
 *   saja (kode S3 bukan rahasia), dan pemanggil (jalur avatar)
 *   memperlakukannya fail-soft.
 */

const R2_REQUEST_TIMEOUT_MS = 10_000;
const R2_REGION = "auto";
const R2_SERVICE = "s3";

export interface R2ObjectStoreConfig {
  /** Endpoint S3-compatible R2 efektif (dari `resolveR2Identity`). */
  endpoint: string;
  /** Bucket tujuan efektif (dari `resolveR2Identity`). */
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2ObjectData {
  data: Buffer;
  /** Content-Type yang tercatat pada objek; null bila tak dikirim R2. */
  contentType: string | null;
}

export interface R2ObjectStore {
  /** Tulis objek (menimpa bila kunci sudah ada). Melempar R2ObjectStoreError. */
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Baca objek; null bila tidak ada (404). Melempar untuk kegagalan lain. */
  get(key: string): Promise<R2ObjectData | null>;
}

/** Kegagalan operasi R2 — hanya status + kode S3, TANPA kredensial/URL bertanda tangan. */
export class R2ObjectStoreError extends Error {
  readonly status: number | null;
  readonly s3Code: string | null;
  constructor(
    message: string,
    init: { status: number | null; s3Code?: string | null },
  ) {
    super(message);
    this.name = "R2ObjectStoreError";
    this.status = init.status;
    this.s3Code = init.s3Code ?? null;
  }
}

// ---------------------------------------------------------------------------
// Tanda tangan SigV4 (pola probes.ts Panel Admin)
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

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

/** Path kanonik gaya-path: bucket apa adanya, tiap segmen kunci di-encode. */
function canonicalPathFor(bucket: string, key: string): string {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/${bucket}/${encodedKey}`;
}

export function createR2ObjectStore(
  config: R2ObjectStoreConfig,
): R2ObjectStore {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const host = new URL(endpoint).host;

  async function signedFetch(
    method: "PUT" | "GET",
    key: string,
    body: Buffer,
    contentType: string | null,
  ): Promise<Response> {
    const payloadHash = sha256Hex(body);
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[:-]/g, "")
      .replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const path = canonicalPathFor(config.bucket, key);

    // Header kanonik terurut alfabetis; content-type ikut ditandatangani
    // pada PUT agar metadata objek yang tersimpan persis yang terkirim.
    const headerPairs: Array<[string, string]> =
      method === "PUT" && contentType
        ? [
            ["content-type", contentType],
            ["host", host],
            ["x-amz-content-sha256", payloadHash],
            ["x-amz-date", amzDate],
          ]
        : [
            ["host", host],
            ["x-amz-content-sha256", payloadHash],
            ["x-amz-date", amzDate],
          ];
    const canonicalHeaders =
      headerPairs.map(([name, value]) => `${name}:${value}\n`).join("");
    const signedHeaders = headerPairs.map(([name]) => name).join(";");
    const canonicalRequest = [
      method,
      path,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signingKey = deriveSigV4SigningKey(
      config.secretAccessKey,
      dateStamp,
      R2_REGION,
      R2_SERVICE,
    );
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");

    const headers: Record<string, string> = {
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    };
    if (method === "PUT" && contentType) headers["content-type"] = contentType;

    try {
      return await fetch(`${endpoint}${path}`, {
        method,
        signal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS),
        headers,
        ...(method === "PUT" ? { body: new Uint8Array(body) } : {}),
      });
    } catch {
      throw new R2ObjectStoreError("R2 tidak terjangkau", { status: null });
    }
  }

  /** Kode error S3 dari body XML (bukan rahasia — aman masuk error). */
  async function readS3Code(res: Response): Promise<string | null> {
    const text = await res.text().catch(() => "");
    return text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? null;
  }

  return {
    async put(key, data, contentType) {
      const res = await signedFetch("PUT", key, data, contentType);
      if (res.ok) return;
      const s3Code = await readS3Code(res);
      throw new R2ObjectStoreError(
        `PUT objek R2 ditolak (status ${res.status}${s3Code ? `, ${s3Code}` : ""})`,
        { status: res.status, s3Code },
      );
    },
    async get(key) {
      const res = await signedFetch("GET", key, Buffer.alloc(0), null);
      if (res.status === 404) return null;
      if (!res.ok) {
        const s3Code = await readS3Code(res);
        if (s3Code === "NoSuchKey") return null;
        throw new R2ObjectStoreError(
          `GET objek R2 ditolak (status ${res.status}${s3Code ? `, ${s3Code}` : ""})`,
          { status: res.status, s3Code },
        );
      }
      const data = Buffer.from(await res.arrayBuffer());
      return { data, contentType: res.headers.get("content-type") };
    },
  };
}

// ---------------------------------------------------------------------------
// Resolver: identitas + kredensial dari Panel Admin (panel → env)
// ---------------------------------------------------------------------------

/**
 * Klien R2 efektif untuk konsumen: identitas dari `resolveR2Identity`
 * (panel → env → bawaan kode) dan kredensial access key/secret dari
 * `getProviderSecret` (panel → env). Mengembalikan null bila SALAH
 * SATU kredensial belum terisi di mana pun — keadaan produksi saat
 * modul ini lahir (Panel Admin grup R2 masih kosong) — dan pemanggil
 * WAJIB memperlakukan null sebagai "R2 belum aktif", bukan error:
 * jalur avatar TikTok jatuh ke penyimpanan bytea basis data persis
 * seperti sebelum jalur R2 ada.
 */
export async function resolveR2ObjectStore(
  db: Database,
  opts: PlatformSettingsOptions,
): Promise<{ store: R2ObjectStore; identity: R2Identity } | null> {
  const [identity, accessKeyId, secretAccessKey] = await Promise.all([
    resolveR2Identity(db, opts),
    getProviderSecret(db, "r2_access_key_id", opts),
    getProviderSecret(db, "r2_secret_access_key", opts),
  ]);
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    identity,
    store: createR2ObjectStore({
      endpoint: identity.endpoint,
      bucket: identity.bucket,
      accessKeyId,
      secretAccessKey,
    }),
  };
}
