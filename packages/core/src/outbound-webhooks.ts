import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  conversations,
  messages,
  outboundWebhookDeliveries,
  outboundWebhookEndpoints,
  type Database,
  type OutboundWebhookDelivery,
  type OutboundWebhookEndpoint,
} from "@sahabat-kreator/db";
import { decryptChannelSecret, encryptChannelSecret } from "./channel-secrets";
import { withTenantDb } from "./tx";

/**
 * Webhook KELUAR (outbound) tenant (Gelombang G11, Tier 2 butir 10).
 *
 * Tenant mendaftarkan endpoint HTTPS miliknya; peristiwa internal
 * Botara yang dilanggan diteruskan sebagai POST JSON tertandatangani
 * HMAC-SHA256 (format Stripe: header `t=<unix>,v1=<hex>` atas
 * `t + "." + body`).
 *
 * Arsitektur — BUKAN mesin antrean kedua, menumpang fondasi yang ada:
 * - Produsen peristiwa adalah OUTBOX yang sama seperti automation:
 *   `message.received` ditulis semua jalur ingest; relay worker
 *   meng-enqueue job BullMQ `outbound-webhook.fanout` (jobId
 *   deterministik dari id event outbox) di samping job yang sudah ada.
 * - Job fan-out memanggil `dispatchOutboundWebhookEvent`: untuk tiap
 *   endpoint aktif yang melanggan, SATU baris
 *   `outbound_webhook_deliveries` dibuat (UNIQUE parsial
 *   (endpoint_id, source_event_id) = kunci idempotensi) lalu percobaan
 *   pertama dilakukan seketika.
 * - Percobaan ulang adalah penyapu worker
 *   (`processDueOutboundWebhookRetries`) di atas kolom
 *   `next_attempt_at` — pola penyapu yang sama seperti broadcast
 *   berulang (G9), dengan klaim sewa (lease) per baris agar dua
 *   pemroses tidak mengirim baris yang sama bersamaan.
 *
 * Katalog peristiwa — JUJUR terhadap sumber yang ada hari ini:
 * - `message.received`: produsen outbox di semua jalur ingest
 *   (Meta/Telegram/WhatsApp/webchat). DITAWARKAN.
 * - `message.status_updated`: produsen outbox ditambahkan gelombang
 *   ini di titik transisi status yang benar-benar tercatat sistem:
 *   penanda pusat pesan keluar `markOutboundMessageSent`/
 *   `markOutboundMessageFailed` (semua provider, lewat delivery
 *   runner) dan resi WhatsApp `applyWhatsAppMessageStatus`
 *   (delivered/read/failed dari webhook). Transisi yang tidak pernah
 *   dicatat sistem (mis. resi baca Meta — webhook-nya tidak diproses
 *   hari ini) tidak melahirkan peristiwa ini. DITAWARKAN.
 * - `conversation.created`: TIDAK ditawarkan — pembuatan percakapan
 *   tersebar di ±10 titik sisip lintas modul ingest (termasuk
 *   materialisasi percakapan channel untuk postingan/broadcast yang
 *   BUKAN percakapan pelanggan), tanpa satu titik produsen outbox;
 *   menawarkannya berarti menjanjikan cakupan yang tidak bisa
 *   dibuktikan. Katalog ini daftar eksplisit agar penambahan kelak
 *   adalah keputusan sadar, bukan efek samping.
 *
 * Keamanan:
 * - Rahasia penanda tangan dihasilkan server (`whsec_…`), disimpan
 *   TERENKRIPSI envelope CHANNEL_TOKEN_SECRET (channel-secrets),
 *   ditampilkan SATU KALI saat pembuatan, dan TIDAK PERNAH muncul di
 *   daftar/log/audit sesudahnya.
 * - Anti-SSRF: URL divalidasi saat simpan DAN ulang saat kirim —
 *   hanya https:, tanpa kredensial URL, host tidak boleh localhost /
 *   IP privat / loopback / link-local / reserved, dan resolusi DNS
 *   tidak boleh mengarah ke alamat non-publik (setiap alamat hasil
 *   resolusi diperiksa). Redirect TIDAK diikuti (3xx = gagal) agar
 *   validasi tidak bisa dilewati lewat pengalihan. Sisa risiko yang
 *   diterima & didokumentasikan: fetch men-resolve ulang nama host
 *   sesudah pemeriksaan (jendela TOCTOU DNS rebinding sempit) —
 *   mitigasi penuh (pin IP + SNI manual) di luar pola HTTP repo ini.
 * - Endpoint nonaktif OTOMATIS sesudah
 *   OUTBOUND_WEBHOOK_AUTO_DISABLE_THRESHOLD pengiriman gagal FINAL
 *   beruntun (bukan per percobaan); keberhasilan meng-nol-kan
 *   penghitung. Tenant bisa mengaktifkan lagi secara manual.
 */

// ---------------------------------------------------------------------------
// Konstanta & katalog
// ---------------------------------------------------------------------------

/** Peristiwa outbox yang boleh dilanggan tenant (lihat catatan katalog di atas). */
export const OUTBOUND_WEBHOOK_EVENT_TYPES = [
  "message.received",
  "message.status_updated",
] as const;
export type OutboundWebhookEventType =
  (typeof OUTBOUND_WEBHOOK_EVENT_TYPES)[number];

/** Jenis peristiwa untuk pengiriman uji manual (bukan langganan). */
export const OUTBOUND_WEBHOOK_TEST_EVENT_TYPE = "ping";

/** Timeout satu percobaan HTTP (sama seperti node http_request flow, Fase 12A). */
export const OUTBOUND_WEBHOOK_TIMEOUT_MS = 10_000;
/** Total percobaan HTTP per pengiriman, termasuk percobaan pertama. */
export const OUTBOUND_WEBHOOK_MAX_ATTEMPTS = 5;
/**
 * Jeda percobaan ulang sesudah percobaan ke-1..4 gagal secara
 * retryable (indeks = jumlah percobaan yang sudah selesai − 1):
 * 30 dtk, 2 mnt, 10 mnt, 30 mnt.
 */
export const OUTBOUND_WEBHOOK_RETRY_DELAYS_MS = [
  30_000, 120_000, 600_000, 1_800_000,
] as const;
/** Gagal final beruntun yang mematikan endpoint secara otomatis. */
export const OUTBOUND_WEBHOOK_AUTO_DISABLE_THRESHOLD = 5;
/** Sewa klaim satu baris pengiriman saat percobaan berjalan. */
export const OUTBOUND_WEBHOOK_CLAIM_LEASE_MS = 2 * 60 * 1000;
/** Batas baris yang dipindai penyapu percobaan ulang per sapuan. */
export const OUTBOUND_WEBHOOK_SWEEP_LIMIT = 50;
/** Batas endpoint per tenant (daftar wajar; bukan kuota penagihan). */
export const OUTBOUND_WEBHOOK_MAX_ENDPOINTS_PER_TENANT = 20;

const LAST_ERROR_MAX = 500;

// ---------------------------------------------------------------------------
// Tanda tangan HMAC (pola Stripe)
// ---------------------------------------------------------------------------

/** Nilai `v1`: HMAC-SHA256 hex atas `${timestamp}.${rawBody}`. */
export function signOutboundWebhookPayload(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
}

/** Header lengkap `t=<unix>,v1=<hex>` untuk satu badan mentah. */
export function buildOutboundWebhookSignatureHeader(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return `t=${timestampSeconds},v1=${signOutboundWebhookPayload(secret, timestampSeconds, rawBody)}`;
}

/**
 * Verifikasi sisi penerima (dipakai uji kami; juga referensi resmi bagi
 * tenant): parse header, hitung ulang dari badan MENTAH, bandingkan
 * aman-timing. Header rusak / stempel waktu bukan angka → false.
 */
export function verifyOutboundWebhookSignature(
  secret: string,
  rawBody: string,
  header: string,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  const expected = Buffer.from(
    signOutboundWebhookPayload(secret, t, rawBody),
    "utf8",
  );
  const presented = Buffer.from(v1, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** Rahasia penanda tangan baru: awalan terbaca `whsec_` + 32 byte entropi. */
export function generateOutboundWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// Anti-SSRF: klasifikasi alamat IP + validasi URL
// ---------------------------------------------------------------------------

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return octets;
}

/** Alamat IPv4 yang TIDAK boleh dituju: privat, loopback, link-local, CGNAT, dokumentasi, multicast, reserved. */
export function isPublicIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return false; // 0.0.0.0/8 "jaringan ini"
  if (a === 10) return false; // privat
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local (termasuk metadata cloud)
  if (a === 172 && b >= 16 && b <= 31) return false; // privat 172.16/12
  if (a === 192 && b === 0 && (o[2] === 0 || o[2] === 2)) return false; // 192.0.0/24 + TEST-NET-1
  if (a === 192 && b === 88 && o[2] === 99) return false; // 6to4 relay (deprecated)
  if (a === 192 && b === 168) return false; // privat
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
  if (a === 198 && b === 51 && o[2] === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast 224/4 + reserved 240/4 + broadcast
  return true;
}

/** Alamat IP (v4/v6) yang aman dituju dari internet publik. */
export function isPublicIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version !== 6) return false;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return false;
  // IPv4-mapped (::ffff:a.b.c.d) dinilai sebagai IPv4-nya.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]!);
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return false; // link-local fe80::/10
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // ULA fc00::/7
  if (lower.startsWith("ff")) return false; // multicast
  if (lower.startsWith("2001:db8")) return false; // dokumentasi
  return true;
}

/** Fungsi resolusi host yang bisa disuntikkan (uji); bawaan: DNS sistem. */
export type OutboundWebhookHostResolver = (
  hostname: string,
) => Promise<string[]>;

export const defaultOutboundWebhookHostResolver: OutboundWebhookHostResolver =
  async (hostname) => {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((r) => r.address);
  };

export type OutboundWebhookUrlValidation =
  | { ok: true; url: string }
  | {
      ok: false;
      code:
        | "WEBHOOK_URL_INVALID"
        | "WEBHOOK_URL_NOT_HTTPS"
        | "WEBHOOK_URL_UNSAFE_HOST";
    };

/**
 * Validasi URL endpoint: format sah, skema https:, tanpa kredensial,
 * dan host — literal maupun SELURUH hasil resolusi DNS-nya — publik.
 * Dipakai saat simpan (API) dan diulang saat kirim (core pengiriman).
 * Resolusi yang gagal/kosong ditolak: keamanan tidak boleh bergantung
 * pada "mungkin aman".
 */
export async function validateOutboundWebhookUrl(
  rawUrl: string,
  resolveHost: OutboundWebhookHostResolver = defaultOutboundWebhookHostResolver,
): Promise<OutboundWebhookUrlValidation> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, code: "WEBHOOK_URL_INVALID" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, code: "WEBHOOK_URL_NOT_HTTPS" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: "WEBHOOK_URL_INVALID" };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return { ok: false, code: "WEBHOOK_URL_INVALID" };
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" };
  }
  if (isIP(hostname)) {
    return isPublicIpAddress(hostname)
      ? { ok: true, url: parsed.toString() }
      : { ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" };
  }
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return { ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" };
  }
  if (addresses.length === 0) {
    return { ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" };
  }
  if (!addresses.every((addr) => isPublicIpAddress(addr))) {
    return { ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" };
  }
  return { ok: true, url: parsed.toString() };
}

// ---------------------------------------------------------------------------
// Tipe tampilan publik (TANPA rahasia — rahasia tidak pernah keluar core)
// ---------------------------------------------------------------------------

export type OutboundWebhookEndpointView = Omit<
  OutboundWebhookEndpoint,
  "secretEncrypted"
>;

function toEndpointView(row: OutboundWebhookEndpoint): OutboundWebhookEndpointView {
  const { secretEncrypted: _secret, ...view } = row;
  return view;
}

export interface OutboundWebhookTenantContext {
  tenantId: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// CRUD endpoint (konteks tenant)
// ---------------------------------------------------------------------------

export type CreateOutboundWebhookEndpointResult =
  | {
      ok: true;
      endpoint: OutboundWebhookEndpointView;
      /** Nilai terang — ditampilkan SATU KALI oleh API, lalu hilang selamanya. */
      signingSecret: string;
    }
  | {
      ok: false;
      code:
        | "WEBHOOK_URL_INVALID"
        | "WEBHOOK_URL_NOT_HTTPS"
        | "WEBHOOK_URL_UNSAFE_HOST"
        | "WEBHOOK_EVENT_UNKNOWN"
        | "WEBHOOK_EVENTS_EMPTY"
        | "WEBHOOK_ENDPOINT_LIMIT";
    };

export function isOutboundWebhookEventType(
  value: string,
): value is OutboundWebhookEventType {
  return (OUTBOUND_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export async function createOutboundWebhookEndpoint(
  db: Database,
  ctx: OutboundWebhookTenantContext,
  deps: {
    encryptionSecret: string;
    resolveHost?: OutboundWebhookHostResolver;
  },
  input: { name: string; url: string; events: string[] },
): Promise<CreateOutboundWebhookEndpointResult> {
  const events = [...new Set(input.events)];
  if (events.length === 0) return { ok: false, code: "WEBHOOK_EVENTS_EMPTY" };
  if (!events.every(isOutboundWebhookEventType)) {
    return { ok: false, code: "WEBHOOK_EVENT_UNKNOWN" };
  }
  const validation = await validateOutboundWebhookUrl(
    input.url,
    deps.resolveHost,
  );
  if (!validation.ok) return validation;

  const signingSecret = generateOutboundWebhookSecret();
  const secretEncrypted = encryptChannelSecret(
    deps.encryptionSecret,
    signingSecret,
  );

  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const existing = await tx
      .select({ id: outboundWebhookEndpoints.id })
      .from(outboundWebhookEndpoints)
      .where(eq(outboundWebhookEndpoints.tenantId, ctx.tenantId));
    if (existing.length >= OUTBOUND_WEBHOOK_MAX_ENDPOINTS_PER_TENANT) {
      return { ok: false, code: "WEBHOOK_ENDPOINT_LIMIT" } as const;
    }
    const [row] = await tx
      .insert(outboundWebhookEndpoints)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        url: validation.url,
        events,
        secretEncrypted,
        createdByUserId: ctx.userId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "outbound_webhook.created",
      meta: { endpointId: row!.id, events },
    });
    return {
      ok: true,
      endpoint: toEndpointView(row!),
      signingSecret,
    } as const;
  });
}

export async function listOutboundWebhookEndpoints(
  db: Database,
  tenantId: string,
): Promise<OutboundWebhookEndpointView[]> {
  return withTenantDb(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(outboundWebhookEndpoints)
      .where(eq(outboundWebhookEndpoints.tenantId, tenantId))
      .orderBy(desc(outboundWebhookEndpoints.createdAt));
    return rows.map(toEndpointView);
  });
}

export async function getOutboundWebhookEndpoint(
  db: Database,
  tenantId: string,
  endpointId: string,
): Promise<OutboundWebhookEndpointView | null> {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(outboundWebhookEndpoints)
      .where(
        and(
          eq(outboundWebhookEndpoints.tenantId, tenantId),
          eq(outboundWebhookEndpoints.id, endpointId),
        ),
      )
      .limit(1);
    return row ? toEndpointView(row) : null;
  });
}

/**
 * Aktif/nonaktifkan manual. Mengaktifkan lagi meng-nol-kan penghitung
 * kegagalan (awal yang bersih) dan membersihkan disabled_reason;
 * menonaktifkan mencatat reason 'manual'. Mengembalikan tampilan
 * terbaru atau null bila endpoint tidak ada.
 */
export async function setOutboundWebhookEndpointEnabled(
  db: Database,
  ctx: OutboundWebhookTenantContext,
  endpointId: string,
  enabled: boolean,
): Promise<OutboundWebhookEndpointView | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .update(outboundWebhookEndpoints)
      .set({
        status: enabled ? "active" : "disabled",
        disabledReason: enabled ? null : "manual",
        ...(enabled ? { consecutiveFailures: 0 } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outboundWebhookEndpoints.tenantId, ctx.tenantId),
          eq(outboundWebhookEndpoints.id, endpointId),
        ),
      )
      .returning();
    if (!row) return null;
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: enabled
        ? "outbound_webhook.enabled"
        : "outbound_webhook.disabled",
      meta: { endpointId },
    });
    return toEndpointView(row);
  });
}

export async function deleteOutboundWebhookEndpoint(
  db: Database,
  ctx: OutboundWebhookTenantContext,
  endpointId: string,
): Promise<boolean> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .delete(outboundWebhookEndpoints)
      .where(
        and(
          eq(outboundWebhookEndpoints.tenantId, ctx.tenantId),
          eq(outboundWebhookEndpoints.id, endpointId),
        ),
      )
      .returning({ id: outboundWebhookEndpoints.id });
    if (rows.length === 0) return false;
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "outbound_webhook.deleted",
      meta: { endpointId },
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Log pengiriman (bacaan tenant)
// ---------------------------------------------------------------------------

export async function listOutboundWebhookDeliveries(
  db: Database,
  tenantId: string,
  endpointId: string,
  limit = 20,
): Promise<OutboundWebhookDelivery[]> {
  const clamped = Math.min(100, Math.max(1, Math.floor(limit) || 20));
  return withTenantDb(db, tenantId, async (tx) => {
    return tx
      .select()
      .from(outboundWebhookDeliveries)
      .where(
        and(
          eq(outboundWebhookDeliveries.tenantId, tenantId),
          eq(outboundWebhookDeliveries.endpointId, endpointId),
        ),
      )
      .orderBy(desc(outboundWebhookDeliveries.createdAt))
      .limit(clamped);
  });
}

// ---------------------------------------------------------------------------
// Pembentukan payload peristiwa
// ---------------------------------------------------------------------------

/**
 * Badan envelope yang dikirim ke tenant. `id` adalah id baris
 * pengiriman (kunci dedup sisi penerima), `type` jenis peristiwa,
 * `data` isi peristiwa. Objek ini disimpan apa adanya di kolom
 * payload pengiriman — yang ditandatangani saat kirim adalah
 * serialisasi persis dari objek ini.
 */
export interface OutboundWebhookEnvelope {
  id: string;
  type: string;
  created_at: string;
  tenant_id: string;
  data: Record<string, unknown>;
}

/**
 * Merakit `data` untuk satu peristiwa outbox dari payload sumbernya,
 * diperkaya dari baris pesan/percakapan (konteks tenant). Baris yang
 * sudah tidak ada (purge) tidak menggagalkan pengiriman — data jatuh
 * kembali ke id yang dibawa payload sumber.
 */
async function buildEventData(
  db: Database,
  tenantId: string,
  eventType: string,
  sourcePayload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const conversationId =
    typeof sourcePayload.conversationId === "string"
      ? sourcePayload.conversationId
      : null;
  const messageId =
    typeof sourcePayload.messageId === "string"
      ? sourcePayload.messageId
      : null;

  const enrichment = await withTenantDb(db, tenantId, async (tx) => {
    let message: typeof messages.$inferSelect | null = null;
    let conversation: typeof conversations.$inferSelect | null = null;
    if (messageId) {
      const [row] = await tx
        .select()
        .from(messages)
        .where(
          and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)),
        )
        .limit(1);
      message = row ?? null;
    }
    const convId = conversationId ?? message?.conversationId ?? null;
    if (convId) {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            eq(conversations.id, convId),
          ),
        )
        .limit(1);
      conversation = row ?? null;
    }
    return { message, conversation };
  });

  const { message, conversation } = enrichment;
  const base: Record<string, unknown> = {
    provider:
      (typeof sourcePayload.provider === "string"
        ? sourcePayload.provider
        : null) ?? conversation?.provider ?? null,
    channel_account_id:
      (typeof sourcePayload.channelAccountId === "string"
        ? sourcePayload.channelAccountId
        : null) ?? conversation?.channelAccountId ?? null,
    conversation_id: conversation?.id ?? conversationId,
    contact_id: conversation?.contactId ?? null,
    message_id: message?.id ?? messageId,
  };

  if (eventType === "message.status_updated") {
    return {
      ...base,
      previous_status:
        typeof sourcePayload.from === "string" ? sourcePayload.from : null,
      status:
        (typeof sourcePayload.to === "string" ? sourcePayload.to : null) ??
        message?.status ??
        null,
      provider_message_id: message?.providerMessageId ?? null,
      error_code:
        (typeof sourcePayload.errorCode === "string"
          ? sourcePayload.errorCode
          : null) ?? message?.errorCode ?? null,
    };
  }

  // message.received (bawaan): sertakan isi pesan seperlunya.
  return {
    ...base,
    message: message
      ? {
          id: message.id,
          direction: message.direction,
          sender_type: message.senderType,
          type: message.type,
          text: message.contentText,
          status: message.status,
          provider_message_id: message.providerMessageId,
          created_at: message.createdAt.toISOString(),
        }
      : null,
    conversation: conversation
      ? {
          id: conversation.id,
          kind: conversation.kind,
          status: conversation.status,
          provider: conversation.provider,
          channel_account_id: conversation.channelAccountId,
          contact_id: conversation.contactId,
          created_at: conversation.createdAt.toISOString(),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Dependensi pengiriman (bisa disuntikkan untuk uji)
// ---------------------------------------------------------------------------

export interface OutboundWebhookDeliveryDeps {
  /** Material kunci env CHANNEL_TOKEN_SECRET untuk membuka rahasia endpoint. */
  encryptionSecret: string;
  fetchFn?: typeof fetch;
  resolveHost?: OutboundWebhookHostResolver;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Fan-out: satu event outbox → baris pengiriman per endpoint berlangganan
// ---------------------------------------------------------------------------

export interface DispatchOutboundWebhookEventResult {
  /** Endpoint aktif yang melanggan peristiwa ini. */
  matched: number;
  /** Baris pengiriman BARU yang lahir (fan-out ulang tidak menggandakan). */
  created: number;
}

export async function dispatchOutboundWebhookEvent(
  db: Database,
  input: {
    tenantId: string;
    eventType: string;
    /** Id event outbox sumber — kunci idempotensi fan-out. */
    sourceEventId: string;
    sourcePayload: Record<string, unknown>;
  },
  deps: OutboundWebhookDeliveryDeps,
): Promise<DispatchOutboundWebhookEventResult> {
  if (!isOutboundWebhookEventType(input.eventType)) {
    return { matched: 0, created: 0 };
  }
  const endpoints = await withTenantDb(db, input.tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(outboundWebhookEndpoints)
      .where(
        and(
          eq(outboundWebhookEndpoints.tenantId, input.tenantId),
          eq(outboundWebhookEndpoints.status, "active"),
        ),
      );
    return rows.filter((row) =>
      (row.events ?? []).includes(input.eventType),
    );
  });
  if (endpoints.length === 0) return { matched: 0, created: 0 };

  const data = await buildEventData(
    db,
    input.tenantId,
    input.eventType,
    input.sourcePayload,
  );
  const occurredAt = (deps.now?.() ?? new Date()).toISOString();

  let created = 0;
  for (const endpoint of endpoints) {
    const deliveryId = await withTenantDb(db, input.tenantId, async (tx) => {
      const [row] = await tx
        .insert(outboundWebhookDeliveries)
        .values({
          tenantId: input.tenantId,
          endpointId: endpoint.id,
          eventType: input.eventType,
          sourceEventId: input.sourceEventId,
          // Payload final butuh id baris sendiri → sisip dulu dengan
          // envelope ber-id kosong, lalu ditimpa dalam transaksi sama.
          payload: {},
        })
        .onConflictDoNothing()
        .returning({ id: outboundWebhookDeliveries.id });
      if (!row) return null;
      const envelope: OutboundWebhookEnvelope = {
        id: row.id,
        type: input.eventType,
        created_at: occurredAt,
        tenant_id: input.tenantId,
        data,
      };
      await tx
        .update(outboundWebhookDeliveries)
        .set({ payload: envelope })
        .where(eq(outboundWebhookDeliveries.id, row.id));
      return row.id;
    });
    if (!deliveryId) continue;
    created += 1;
    await attemptOutboundWebhookDelivery(db, input.tenantId, deliveryId, deps);
  }
  return { matched: endpoints.length, created };
}

// ---------------------------------------------------------------------------
// Satu percobaan pengiriman
// ---------------------------------------------------------------------------

export type OutboundWebhookAttemptOutcome =
  | "delivered"
  | "retry_scheduled"
  | "failed"
  | "skipped";

function describeAttemptError(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string"
        ? err
        : "unknown_error";
  return raw.length > LAST_ERROR_MAX ? raw.slice(0, LAST_ERROR_MAX) : raw;
}

/**
 * Melakukan SATU percobaan HTTP untuk satu baris pengiriman yang
 * masih `pending`, lalu mencatat hasilnya:
 * - Klaim sewa atomik lebih dulu (UPDATE kondisional): baris yang
 *   sedang dikerjakan pemroses lain dilewati (`skipped`).
 * - 2xx → `delivered`; penghitung gagal endpoint di-nol-kan.
 * - Jaringan/timeout/408/429/5xx → retryable: tetap `pending` dengan
 *   `next_attempt_at` menurut tangga backoff, sampai
 *   OUTBOUND_WEBHOOK_MAX_ATTEMPTS percobaan.
 * - 4xx lain, URL yang tidak lagi aman, rahasia tak terbuka → GAGAL
 *   FINAL seketika (`failed`): penghitung gagal endpoint +1, dan
 *   pada ambang threshold endpoint dinonaktifkan otomatis + audit.
 * Endpoint yang sedang `disabled` tidak ditembak untuk peristiwa
 * biasa (pengiriman ditutup `failed`/`endpoint_disabled` tanpa
 * HTTP); peristiwa uji `ping` tetap ditembak — itu memang alat
 * diagnostik manual tenant.
 */
export async function attemptOutboundWebhookDelivery(
  db: Database,
  tenantId: string,
  deliveryId: string,
  deps: OutboundWebhookDeliveryDeps,
): Promise<OutboundWebhookAttemptOutcome> {
  const now = deps.now?.() ?? new Date();

  // --- Klaim sewa (transaksi tenant) ---
  const claimed = await withTenantDb(db, tenantId, async (tx) => {
    const rows = await tx
      .update(outboundWebhookDeliveries)
      .set({
        nextAttemptAt: new Date(now.getTime() + OUTBOUND_WEBHOOK_CLAIM_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(outboundWebhookDeliveries.tenantId, tenantId),
          eq(outboundWebhookDeliveries.id, deliveryId),
          eq(outboundWebhookDeliveries.status, "pending"),
          sql`(${outboundWebhookDeliveries.nextAttemptAt} IS NULL OR ${outboundWebhookDeliveries.nextAttemptAt} <= ${now})`,
        ),
      )
      .returning({ id: outboundWebhookDeliveries.id });
    return rows.length > 0;
  });
  if (!claimed) return "skipped";

  // --- Muat baris + endpoint ---
  const loaded = await withTenantDb(db, tenantId, async (tx) => {
    const [delivery] = await tx
      .select()
      .from(outboundWebhookDeliveries)
      .where(
        and(
          eq(outboundWebhookDeliveries.tenantId, tenantId),
          eq(outboundWebhookDeliveries.id, deliveryId),
        ),
      )
      .limit(1);
    if (!delivery) return null;
    const [endpoint] = await tx
      .select()
      .from(outboundWebhookEndpoints)
      .where(
        and(
          eq(outboundWebhookEndpoints.tenantId, tenantId),
          eq(outboundWebhookEndpoints.id, delivery.endpointId),
        ),
      )
      .limit(1);
    return endpoint ? { delivery, endpoint } : null;
  });
  if (!loaded) return "skipped";
  const { delivery, endpoint } = loaded;
  const attemptNumber = delivery.attempts + 1;

  const finalizeFailed = async (
    error: string,
    statusCode: number | null,
    countTowardDisable: boolean,
  ): Promise<OutboundWebhookAttemptOutcome> => {
    await withTenantDb(db, tenantId, async (tx) => {
      await tx
        .update(outboundWebhookDeliveries)
        .set({
          status: "failed",
          attempts: attemptNumber,
          nextAttemptAt: null,
          lastStatusCode: statusCode,
          lastError: error.slice(0, LAST_ERROR_MAX),
          updatedAt: new Date(),
        })
        .where(eq(outboundWebhookDeliveries.id, deliveryId));
      if (!countTowardDisable) return;
      const [updated] = await tx
        .update(outboundWebhookEndpoints)
        .set({
          consecutiveFailures: sql`${outboundWebhookEndpoints.consecutiveFailures} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(outboundWebhookEndpoints.id, endpoint.id))
        .returning({
          consecutiveFailures: outboundWebhookEndpoints.consecutiveFailures,
          status: outboundWebhookEndpoints.status,
        });
      if (
        updated &&
        updated.status === "active" &&
        updated.consecutiveFailures >= OUTBOUND_WEBHOOK_AUTO_DISABLE_THRESHOLD
      ) {
        await tx
          .update(outboundWebhookEndpoints)
          .set({
            status: "disabled",
            disabledReason: "consecutive_failures",
            updatedAt: new Date(),
          })
          .where(eq(outboundWebhookEndpoints.id, endpoint.id));
        await tx.insert(auditLogs).values({
          tenantId,
          actorType: "system",
          actorId: "outbound-webhook",
          action: "outbound_webhook.auto_disabled",
          meta: {
            endpointId: endpoint.id,
            consecutiveFailures: updated.consecutiveFailures,
          },
        });
      }
    });
    return "failed";
  };

  // Endpoint nonaktif: jangan tembak peristiwa biasa.
  if (endpoint.status !== "active" && delivery.eventType !== OUTBOUND_WEBHOOK_TEST_EVENT_TYPE) {
    return finalizeFailed("endpoint_disabled", null, false);
  }

  // Validasi anti-SSRF diulang saat kirim (DNS bisa berubah).
  const validation = await validateOutboundWebhookUrl(
    endpoint.url,
    deps.resolveHost,
  );
  if (!validation.ok) {
    return finalizeFailed(`url_unsafe: ${validation.code}`, null, true);
  }

  const secret = deps.encryptionSecret
    ? decryptChannelSecret(deps.encryptionSecret, endpoint.secretEncrypted)
    : null;
  if (!secret) {
    return finalizeFailed("secret_undecryptable", null, true);
  }

  const rawBody = JSON.stringify(delivery.payload);
  const timestampSeconds = Math.floor(now.getTime() / 1000);
  const signature = buildOutboundWebhookSignatureHeader(
    secret,
    timestampSeconds,
    rawBody,
  );

  let statusCode: number | null = null;
  let networkError: string | null = null;
  const fetchFn = deps.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    OUTBOUND_WEBHOOK_TIMEOUT_MS,
  );
  try {
    const res = await fetchFn(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Botara-Webhooks/1.0",
        "x-botara-event": delivery.eventType,
        "x-botara-delivery": delivery.id,
        "x-botara-signature": signature,
      },
      body: rawBody,
      signal: controller.signal,
      // Redirect TIDAK diikuti: pengalihan bisa mengarah ke host
      // privat yang tidak lolos validasi. 3xx tercatat sebagai gagal.
      redirect: "manual",
    });
    statusCode = res.status;
    // Badan respons tidak dipakai; konsumsi seperlunya agar koneksi lepas.
    await res.text().catch(() => "");
  } catch (err) {
    networkError = describeAttemptError(err);
  } finally {
    clearTimeout(timer);
  }

  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    await withTenantDb(db, tenantId, async (tx) => {
      await tx
        .update(outboundWebhookDeliveries)
        .set({
          status: "delivered",
          attempts: attemptNumber,
          nextAttemptAt: null,
          lastStatusCode: statusCode,
          lastError: null,
          deliveredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(outboundWebhookDeliveries.id, deliveryId));
      await tx
        .update(outboundWebhookEndpoints)
        .set({ consecutiveFailures: 0, updatedAt: new Date() })
        .where(eq(outboundWebhookEndpoints.id, endpoint.id));
    });
    return "delivered";
  }

  const retryable =
    networkError !== null ||
    statusCode === 408 ||
    statusCode === 429 ||
    (statusCode !== null && statusCode >= 500);
  const error =
    networkError ?? `http_${statusCode ?? "unknown"}`;

  if (retryable && attemptNumber < OUTBOUND_WEBHOOK_MAX_ATTEMPTS) {
    const delay =
      OUTBOUND_WEBHOOK_RETRY_DELAYS_MS[attemptNumber - 1] ??
      OUTBOUND_WEBHOOK_RETRY_DELAYS_MS[
        OUTBOUND_WEBHOOK_RETRY_DELAYS_MS.length - 1
      ];
    await withTenantDb(db, tenantId, async (tx) => {
      await tx
        .update(outboundWebhookDeliveries)
        .set({
          status: "pending",
          attempts: attemptNumber,
          nextAttemptAt: new Date(now.getTime() + delay),
          lastStatusCode: statusCode,
          lastError: error.slice(0, LAST_ERROR_MAX),
          updatedAt: new Date(),
        })
        .where(eq(outboundWebhookDeliveries.id, deliveryId));
    });
    return "retry_scheduled";
  }

  return finalizeFailed(error, statusCode, true);
}

// ---------------------------------------------------------------------------
// Peristiwa uji manual
// ---------------------------------------------------------------------------

/**
 * Membuat + menembak satu peristiwa uji `ping` ke endpoint (alat
 * diagnostik tenant dari UI). Berbeda dari fan-out: dikirim juga ke
 * endpoint `disabled` (justru untuk memeriksa pemulihan), dan
 * hasilnya tercatat di log pengiriman yang sama bertanda type `ping`.
 * Mengembalikan baris pengiriman final, atau null bila endpoint
 * tidak ada.
 */
export async function sendOutboundWebhookTestEvent(
  db: Database,
  ctx: OutboundWebhookTenantContext,
  deps: OutboundWebhookDeliveryDeps,
  endpointId: string,
): Promise<OutboundWebhookDelivery | null> {
  const deliveryId = await withTenantDb(db, ctx.tenantId, async (tx) => {
    const [endpoint] = await tx
      .select({ id: outboundWebhookEndpoints.id })
      .from(outboundWebhookEndpoints)
      .where(
        and(
          eq(outboundWebhookEndpoints.tenantId, ctx.tenantId),
          eq(outboundWebhookEndpoints.id, endpointId),
        ),
      )
      .limit(1);
    if (!endpoint) return null;
    const [row] = await tx
      .insert(outboundWebhookDeliveries)
      .values({
        tenantId: ctx.tenantId,
        endpointId,
        eventType: OUTBOUND_WEBHOOK_TEST_EVENT_TYPE,
        sourceEventId: null,
        payload: {},
      })
      .returning({ id: outboundWebhookDeliveries.id });
    const envelope: OutboundWebhookEnvelope = {
      id: row!.id,
      type: OUTBOUND_WEBHOOK_TEST_EVENT_TYPE,
      created_at: (deps.now?.() ?? new Date()).toISOString(),
      tenant_id: ctx.tenantId,
      data: {
        test: true,
        note: "Test event from Botara — no customer data.",
        endpoint_id: endpointId,
      },
    };
    await tx
      .update(outboundWebhookDeliveries)
      .set({ payload: envelope })
      .where(eq(outboundWebhookDeliveries.id, row!.id));
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "outbound_webhook.test_sent",
      meta: { endpointId, deliveryId: row!.id },
    });
    return row!.id;
  });
  if (!deliveryId) return null;
  await attemptOutboundWebhookDelivery(db, ctx.tenantId, deliveryId, deps);
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(outboundWebhookDeliveries)
      .where(eq(outboundWebhookDeliveries.id, deliveryId))
      .limit(1);
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// Penyapu percobaan ulang (worker)
// ---------------------------------------------------------------------------

export interface ProcessDueOutboundWebhookRetriesResult {
  scanned: number;
  delivered: number;
  retryScheduled: number;
  failed: number;
  skipped: number;
}

/**
 * Satu sapuan percobaan ulang: pindai pengiriman `pending` yang jatuh
 * tempo LINTAS tenant di bawah flag `app.outbound_webhook='scan'`
 * (policy system_outbound_webhook_scan), lalu proses tiap baris di
 * konteks tenant-nya lewat jalur percobaan yang sama. Baris yang
 * belum pernah dicoba dan sudah berumur (fan-out mati di tengah)
 * ikut dipindai — pengiriman adalah at-least-once; penerima
 * menduplikat berdasarkan id pengiriman.
 */
export async function processDueOutboundWebhookRetries(
  db: Database,
  deps: OutboundWebhookDeliveryDeps,
  opts: { now?: Date; limit?: number } = {},
): Promise<ProcessDueOutboundWebhookRetriesResult> {
  const now = opts.now ?? deps.now?.() ?? new Date();
  const limit = opts.limit ?? OUTBOUND_WEBHOOK_SWEEP_LIMIT;
  const targets = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.outbound_webhook', 'scan', true)`,
    );
    return tx
      .select({
        id: outboundWebhookDeliveries.id,
        tenantId: outboundWebhookDeliveries.tenantId,
      })
      .from(outboundWebhookDeliveries)
      .where(
        and(
          eq(outboundWebhookDeliveries.status, "pending"),
          sql`(
            ${outboundWebhookDeliveries.nextAttemptAt} <= ${now}
            OR (
              ${outboundWebhookDeliveries.nextAttemptAt} IS NULL
              AND ${outboundWebhookDeliveries.attempts} = 0
              AND ${outboundWebhookDeliveries.createdAt} <= ${new Date(now.getTime() - 60_000)}
            )
          )`,
        ),
      )
      .orderBy(asc(outboundWebhookDeliveries.nextAttemptAt))
      .limit(limit);
  });

  const result: ProcessDueOutboundWebhookRetriesResult = {
    scanned: targets.length,
    delivered: 0,
    retryScheduled: 0,
    failed: 0,
    skipped: 0,
  };
  for (const target of targets) {
    const outcome = await attemptOutboundWebhookDelivery(
      db,
      target.tenantId,
      target.id,
      deps,
    );
    if (outcome === "delivered") result.delivered += 1;
    else if (outcome === "retry_scheduled") result.retryScheduled += 1;
    else if (outcome === "failed") result.failed += 1;
    else result.skipped += 1;
  }
  return result;
}
