import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  adConnections,
  adConversionEvents,
  auditLogs,
  deals,
  googleConnections,
  orders,
  outboxEvents,
  tenants,
  type AdConversionEventRow,
  type AdConversionUserData,
  type AdPlatform,
} from "@sahabat-kreator/db";
import type { Database } from "@sahabat-kreator/db";
import { withTenantDb, type DbTx } from "./tx";
import {
  decryptChannelSecret,
  encryptChannelSecret,
} from "./channel-secrets";
import { normalizeContactEmail, normalizeContactPhone } from "./contacts";
import {
  getProviderSecret,
  type PlatformSettingsOptions,
} from "./platform-settings";
import {
  getValidGoogleServiceAccess,
  type GoogleBases,
} from "./google-calendar";
import { recordIntegrationLog } from "./integration-log";

/**
 * KONVERSI IKLAN DARI FLOW (Gelombang G16, Tier 3 butir 16).
 *
 * Node flow `send_ad_conversion` menandai momen bisnis nyata (prospek
 * masuk, deal menang, pesanan lunas) sebagai peristiwa konversi di
 * platform iklan TENANT, supaya pengukuran + optimasi iklan tenant
 * bekerja dari kejadian Botara, bukan dari klik saja.
 *
 * Arsitektur (pola repo, tanpa jalan pintas):
 * - Koneksi iklan = milik TENANT (`ad_connections`, satu baris per
 *   tenant): Meta dataset ID + access token CAPI TERENKRIPSI envelope
 *   (pola payment_provider_configs) + test event code; Google Ads
 *   customer ID + conversion action ID. Token Meta tidak pernah
 *   keluar lagi sesudah disimpan (view hanya memuat penanda).
 * - Kredensial Google terbagi menurut pemiliknya yang sebenarnya:
 *   developer token = PLATFORM (diterbitkan untuk akun manager
 *   platform; Panel Admin `google_ads_developer_token`, env fallback),
 *   otorisasi akun = consent OAuth tenant layanan Google 'ads'
 *   (scope adwords, mesin per-layanan google-calendar.ts), ID akun
 *   = isian tenant di atas.
 * - Pengiriman TIDAK sinkron di executor: node menulis baris ledger
 *   `ad_conversion_events` + event outbox `ad_conversion.requested`
 *   dalam transaksi langkahnya (pola send_message), relay worker
 *   mengantrrekan job `ad-conversion.send`, dan `deliverAdConversion`
 *   di modul ini yang berbicara ke platform. Kegagalan platform
 *   tercatat di ledger + log integrasi; run flow tidak pernah
 *   dibatalkan oleh iklan.
 * - Dedup: event_id deterministik dari (run, node) — lihat
 *   `adConversionEventId`. UNIQUE (tenant_id, event_id) di ledger
 *   menahan duplikat lokal; event_id yang sama diteruskan ke
 *   platform (Meta `event_id`, Google `orderId`) menahan duplikat
 *   di sisi platform.
 * - Kejujuran identitas: yang dikirim hanya pengenal yang benar-benar
 *   dimiliki Botara dari percakapan — HASH email/telepon kontak +
 *   external_id (Meta). fbp/fbc (cookie browser) dan gclid (klik
 *   iklan Google) TIDAK ada di konteks chat dan TIDAK dikarang.
 *   Akibatnya dinyatakan apa adanya: Meta tetap menerima peristiwa
 *   (pencocokan bertumpu pada em/ph/external_id); Google tanpa
 *   email/telepon tidak punya apa pun untuk dicocokkan → peristiwa
 *   di-skip tercatat (`google_no_identifier`), tidak dikirim.
 */

export const AD_CONVERSION_REQUESTED_OUTBOX_TYPE =
  "ad_conversion.requested";

/** Versi Graph API untuk CAPI — selaras META_GRAPH_API_VERSION (@sahabat-kreator/config). */
export const META_CAPI_GRAPH_VERSION = "v26.0";
export const META_DEFAULT_API_BASE = "https://graph.facebook.com";
/** Versi Google Ads API untuk uploadClickConversions. */
export const GOOGLE_ADS_API_VERSION = "v18";
export const GOOGLE_ADS_DEFAULT_API_BASE =
  "https://googleads.googleapis.com";

export interface AdConversionDeps {
  /** Secret enkripsi kredensial tenant (env CHANNEL_TOKEN_SECRET). */
  tokenSecret?: string;
  /** Opsi resolver kredensial platform (Panel Admin → env). */
  platform: PlatformSettingsOptions;
  /** Override base Graph API Meta (verify tiruan). */
  metaApiBase?: string;
  /** Override base Google (token refresh layanan 'ads' + Ads API). */
  googleBases?: GoogleBases;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Identitas (hash) — dibangun dari kontak nyata saat node berjalan
// ---------------------------------------------------------------------------

/**
 * Hash pengenal kontak untuk peristiwa konversi. Normalisasi
 * mengikuti aturan platform:
 * - email: trim + lowercase (normalizeContactEmail repo).
 * - telepon Meta `ph`: digit saja termasuk kode negara
 *   (normalizeContactPhone repo: "08…" → "62…").
 * - telepon Google: E.164 ("+" + digit yang sama).
 * - external_id (Meta): id kontak Botara — stabil per kontak, hanya
 *   bermakna untuk pencocokan lintas peristiwa Botara sendiri.
 * Nilai terang TIDAK pernah meninggalkan fungsi ini.
 */
export function buildAdConversionUserData(contact: {
  id: string;
  email: string | null;
  phone: string | null;
}): AdConversionUserData {
  const data: AdConversionUserData = {
    externalIdHash: sha256Hex(contact.id),
  };
  const email = normalizeContactEmail(contact.email);
  if (email) data.emailHash = sha256Hex(email);
  const phoneDigits = normalizeContactPhone(contact.phone);
  if (phoneDigits) {
    data.phoneHash = sha256Hex(phoneDigits);
    data.phoneE164Hash = sha256Hex(`+${phoneDigits}`);
  }
  return data;
}

/** event_id dedup: deterministik dari run + node (stabil lintas eksekusi ulang). */
export function adConversionEventId(runId: string, nodeId: string): string {
  return `evt_${sha256Hex(`${runId}:${nodeId}`).slice(0, 48)}`;
}

// ---------------------------------------------------------------------------
// Koneksi iklan tenant: view + simpan (token tidak pernah tampil lagi)
// ---------------------------------------------------------------------------

export interface AdConnectionsView {
  meta: {
    datasetId: string | null;
    accessTokenConfigured: boolean;
    testEventCode: string | null;
    ready: boolean;
  };
  google: {
    customerId: string | null;
    conversionActionId: string | null;
    adsAccountConnected: boolean;
    adsAccountEmail: string | null;
    developerTokenConfigured: boolean;
    ready: boolean;
  };
}

export interface UpdateAdConnectionsInput {
  metaDatasetId?: string | null;
  metaAccessToken?: string | null;
  metaTestEventCode?: string | null;
  googleCustomerId?: string | null;
  googleConversionActionId?: string | null;
}

export interface AdActor {
  actorType: "user" | "system";
  actorId: string;
}

/** Customer ID Google Ads disimpan sebagai digit saja (strip dibuang). */
export function normalizeGoogleCustomerId(raw: string): string {
  return raw.replace(/\D/g, "");
}

async function readConnectionRow(db: Database, tenantId: string) {
  return withTenantDb(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(adConnections)
      .where(eq(adConnections.tenantId, tenantId))
      .limit(1);
    return row ?? null;
  });
}

/** Status koneksi iklan tenant — TANPA nilai token (pola PaymentSettingsView). */
export async function getAdConnections(
  db: Database,
  tenantId: string,
  deps: AdConversionDeps,
): Promise<AdConnectionsView> {
  const [row, googleRows, developerToken] = await Promise.all([
    readConnectionRow(db, tenantId),
    // Email/status akun Google layanan 'ads' dibaca dari koneksi
    // OAuth per layanan (baris google_connections service='ads').
    withTenantDb(db, tenantId, async (tx) =>
      tx
        .select()
        .from(googleConnections)
        .where(eq(googleConnections.tenantId, tenantId)),
    ),
    getProviderSecret(db, "google_ads_developer_token", deps.platform),
  ]);
  const ads = googleRows.find((r) => r.service === "ads") ?? null;
  const metaDatasetId = row?.metaDatasetId ?? null;
  const metaToken = Boolean(row?.metaAccessTokenEncrypted);
  const customerId = row?.googleCustomerId ?? null;
  const conversionActionId = row?.googleConversionActionId ?? null;
  return {
    meta: {
      datasetId: metaDatasetId,
      accessTokenConfigured: metaToken,
      testEventCode: row?.metaTestEventCode ?? null,
      ready: Boolean(metaDatasetId && metaToken),
    },
    google: {
      customerId,
      conversionActionId,
      adsAccountConnected: Boolean(ads),
      adsAccountEmail: ads?.accountEmail ?? null,
      developerTokenConfigured: Boolean(developerToken),
      ready: Boolean(
        ads && customerId && conversionActionId && developerToken,
      ),
    },
  };
}

export type UpdateAdConnectionsResult =
  | { kind: "ok"; view: AdConnectionsView }
  | { kind: "secret_unconfigured" };

/**
 * Simpan koneksi iklan tenant. Per field tri-state (pola
 * updatePaymentSettings): tidak dikirim = tidak berubah; null/"" =
 * hapus; nilai = ganti (token dienkripsi di sini). Audit
 * `ad_connections.updated` mencatat NAMA field — nilai tidak pernah
 * masuk audit/log/respons.
 */
export async function updateAdConnections(
  db: Database,
  tenantId: string,
  input: UpdateAdConnectionsInput,
  actor: AdActor,
  deps: AdConversionDeps,
): Promise<UpdateAdConnectionsResult> {
  const tokenTouched =
    input.metaAccessToken !== undefined &&
    input.metaAccessToken !== null &&
    input.metaAccessToken !== "";
  if (tokenTouched && !deps.tokenSecret) {
    return { kind: "secret_unconfigured" };
  }
  await withTenantDb(db, tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(adConnections)
      .where(eq(adConnections.tenantId, tenantId))
      .limit(1);
    const changedFields: string[] = [];
    const values = {
      tenantId,
      metaDatasetId: existing?.metaDatasetId ?? null,
      metaAccessTokenEncrypted: existing?.metaAccessTokenEncrypted ?? null,
      metaTestEventCode: existing?.metaTestEventCode ?? null,
      googleCustomerId: existing?.googleCustomerId ?? null,
      googleConversionActionId: existing?.googleConversionActionId ?? null,
      updatedAt: new Date(),
    };
    if (input.metaDatasetId !== undefined) {
      values.metaDatasetId = input.metaDatasetId?.trim() || null;
      changedFields.push("metaDatasetId");
    }
    if (input.metaAccessToken !== undefined) {
      values.metaAccessTokenEncrypted =
        input.metaAccessToken === null || input.metaAccessToken === ""
          ? null
          : encryptChannelSecret(deps.tokenSecret!, input.metaAccessToken);
      changedFields.push("metaAccessToken");
    }
    if (input.metaTestEventCode !== undefined) {
      values.metaTestEventCode = input.metaTestEventCode?.trim() || null;
      changedFields.push("metaTestEventCode");
    }
    if (input.googleCustomerId !== undefined) {
      values.googleCustomerId = input.googleCustomerId
        ? normalizeGoogleCustomerId(input.googleCustomerId) || null
        : null;
      changedFields.push("googleCustomerId");
    }
    if (input.googleConversionActionId !== undefined) {
      values.googleConversionActionId =
        input.googleConversionActionId?.replace(/\D/g, "") || null;
      changedFields.push("googleConversionActionId");
    }
    if (existing) {
      await tx
        .update(adConnections)
        .set(values)
        .where(eq(adConnections.id, existing.id));
    } else {
      await tx.insert(adConnections).values(values);
    }
    await tx.insert(auditLogs).values({
      tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "ad_connections.updated",
      meta: { changedFields },
    });
  });
  return { kind: "ok", view: await getAdConnections(db, tenantId, deps) };
}

/** Riwayat pengiriman konversi tenant (terbaru dulu) untuk Pengaturan. */
export async function listAdConversionEvents(
  db: Database,
  tenantId: string,
  limit = 20,
): Promise<AdConversionEventRow[]> {
  return withTenantDb(db, tenantId, async (tx) =>
    tx
      .select()
      .from(adConversionEvents)
      .where(eq(adConversionEvents.tenantId, tenantId))
      .orderBy(desc(adConversionEvents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100)),
  );
}

// ---------------------------------------------------------------------------
// Nilai peristiwa dari konteks nyata (di dalam transaksi langkah flow)
// ---------------------------------------------------------------------------

export interface ResolvedAdValue {
  value: number | null;
  currency: string | null;
  source: "order" | "deal" | "static" | null;
}

/**
 * Resolusi nilai konversi dari konteks NYATA kontak (transaksi
 * langkah yang sama, jadi snapshot-nya konsisten):
 * 1. kandidat nyata: order LUNAS terbaru kontak (paid_at) dan deal
 *    terbaru kontak (updated_at, status apa pun — deal open adalah
 *    nilai peluang yang sah untuk peristiwa Lead) — yang LEBIH SEGAR
 *    menang; seri → order. Order berdenominasi IDR menurut skema
 *    commerce repo (total_idr), deal membawa mata uangnya sendiri.
 * 2. nilai statis node (+ mata uang node, atau bawaan tenant).
 * 3. tanpa nilai — peristiwa tetap terkirim tanpa value/currency.
 * Tidak ada nilai yang dikarang di jalur mana pun.
 */
export async function resolveAdConversionValueTx(
  tx: DbTx,
  input: {
    tenantId: string;
    contactId: string;
    staticValue?: number | undefined;
    staticCurrency?: string | undefined;
  },
): Promise<ResolvedAdValue> {
  const [order] = await tx
    .select({
      totalIdr: orders.totalIdr,
      paidAt: orders.paidAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, input.tenantId),
        eq(orders.contactId, input.contactId),
        eq(orders.status, "paid"),
      ),
    )
    .orderBy(desc(orders.paidAt))
    .limit(1);
  const [deal] = await tx
    .select({
      value: deals.value,
      currency: deals.currency,
      updatedAt: deals.updatedAt,
    })
    .from(deals)
    .where(
      and(
        eq(deals.tenantId, input.tenantId),
        eq(deals.contactId, input.contactId),
      ),
    )
    .orderBy(desc(deals.updatedAt))
    .limit(1);

  const orderTime = order?.paidAt?.getTime() ?? null;
  const dealTime = deal?.updatedAt?.getTime() ?? null;
  if (order && deal) {
    if (dealTime !== null && orderTime !== null && dealTime > orderTime) {
      return {
        value: Number(deal.value),
        currency: deal.currency,
        source: "deal",
      };
    }
    return {
      value: Number(order.totalIdr),
      currency: "IDR",
      source: "order",
    };
  }
  if (order) {
    return { value: Number(order.totalIdr), currency: "IDR", source: "order" };
  }
  if (deal) {
    return { value: Number(deal.value), currency: deal.currency, source: "deal" };
  }
  if (input.staticValue !== undefined) {
    let currency = input.staticCurrency ?? null;
    if (!currency) {
      const [tenant] = await tx
        .select({ defaultCurrency: tenants.defaultCurrency })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      currency = tenant?.defaultCurrency ?? "IDR";
    }
    return { value: input.staticValue, currency, source: "static" };
  }
  return { value: null, currency: null, source: null };
}

// ---------------------------------------------------------------------------
// Antrian peristiwa dari executor (di dalam transaksi langkah flow)
// ---------------------------------------------------------------------------

export interface QueueAdConversionInput {
  tenantId: string;
  platform: AdPlatform;
  eventName: string;
  flowId: string;
  runId: string;
  nodeId: string;
  contactId: string;
  userData: AdConversionUserData;
  value: ResolvedAdValue;
  occurredAt: Date;
}

export type QueueAdConversionResult =
  | { kind: "queued"; rowId: string; eventId: string }
  | { kind: "already_queued"; rowId: string; eventId: string };

/**
 * Tulis baris ledger + event outbox dalam transaksi pemanggil
 * (langkah flow). ON CONFLICT (tenant_id, event_id) DO NOTHING:
 * eksekusi ulang langkah yang sama (retry/resume run) menghasilkan
 * `already_queued` dan TIDAK menulis outbox kedua — dedup berlaku
 * sejak titik paling awal.
 */
export async function queueAdConversionTx(
  tx: DbTx,
  input: QueueAdConversionInput,
): Promise<QueueAdConversionResult> {
  const eventId = adConversionEventId(input.runId, input.nodeId);
  const inserted = await tx
    .insert(adConversionEvents)
    .values({
      tenantId: input.tenantId,
      eventId,
      platform: input.platform,
      eventName: input.eventName,
      flowId: input.flowId,
      flowRunId: input.runId,
      nodeId: input.nodeId,
      contactId: input.contactId,
      value:
        input.value.value !== null ? String(input.value.value) : null,
      currency: input.value.currency,
      valueSource: input.value.source,
      userData: input.userData,
      status: "queued",
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({
      target: [adConversionEvents.tenantId, adConversionEvents.eventId],
    })
    .returning({ id: adConversionEvents.id });
  const row = inserted[0];
  if (!row) {
    const [existing] = await tx
      .select({ id: adConversionEvents.id })
      .from(adConversionEvents)
      .where(
        and(
          eq(adConversionEvents.tenantId, input.tenantId),
          eq(adConversionEvents.eventId, eventId),
        ),
      )
      .limit(1);
    return {
      kind: "already_queued",
      rowId: existing!.id,
      eventId,
    };
  }
  await tx.insert(outboxEvents).values({
    tenantId: input.tenantId,
    type: AD_CONVERSION_REQUESTED_OUTBOX_TYPE,
    payload: {
      adConversionEventRowId: row.id,
      eventId,
      platform: input.platform,
    },
  });
  return { kind: "queued", rowId: row.id, eventId };
}

// ---------------------------------------------------------------------------
// Payload platform (fungsi murni — diuji verify tanpa jaringan)
// ---------------------------------------------------------------------------

export interface MetaCapiEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: "system_generated";
  user_data: {
    em?: string[];
    ph?: string[];
    external_id?: string[];
  };
  custom_data?: { value: number; currency: string };
}

export interface MetaCapiPayload {
  data: MetaCapiEvent[];
  test_event_code?: string;
}

/**
 * Payload Meta Conversions API untuk satu peristiwa ledger.
 * user_data hanya hash yang tersedia; custom_data hanya bila nilai
 * resolusi ada (value + currency selalu berpasangan di CAPI).
 */
export function buildMetaCapiPayload(input: {
  eventName: string;
  eventId: string;
  occurredAt: Date;
  userData: AdConversionUserData | null;
  value: number | null;
  currency: string | null;
  testEventCode?: string | null;
}): MetaCapiPayload {
  const userData: MetaCapiEvent["user_data"] = {};
  if (input.userData?.emailHash) userData.em = [input.userData.emailHash];
  if (input.userData?.phoneHash) userData.ph = [input.userData.phoneHash];
  if (input.userData?.externalIdHash) {
    userData.external_id = [input.userData.externalIdHash];
  }
  const event: MetaCapiEvent = {
    event_name: input.eventName,
    event_time: Math.floor(input.occurredAt.getTime() / 1000),
    event_id: input.eventId,
    action_source: "system_generated",
    user_data: userData,
  };
  if (input.value !== null && input.currency) {
    event.custom_data = { value: input.value, currency: input.currency };
  }
  const payload: MetaCapiPayload = { data: [event] };
  if (input.testEventCode) payload.test_event_code = input.testEventCode;
  return payload;
}

export interface GoogleAdsConversion {
  conversionAction: string;
  conversionDateTime: string;
  conversionValue?: number;
  currencyCode?: string;
  orderId: string;
  userIdentifiers: Array<{
    hashedEmail?: string;
    hashedPhoneNumber?: string;
  }>;
}

export interface GoogleAdsUploadPayload {
  conversions: GoogleAdsConversion[];
  partialFailure: boolean;
}

/** Format waktu Google Ads API: "yyyy-MM-dd HH:mm:ss±hh:mm" (UTC di sini). */
export function formatGoogleAdsDateTime(at: Date): string {
  const iso = at.toISOString(); // 2026-11-13T02:00:00.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`;
}

/**
 * Payload uploadClickConversions (enhanced conversions for leads):
 * pengenal ter-hash email/telepon E.164 + orderId = event_id ledger
 * (dedup sisi Google). Tanpa gclid — klik iklan tidak ada di chat;
 * pencocokan sepenuhnya bertumpu pada userIdentifiers.
 */
export function buildGoogleAdsPayload(input: {
  customerId: string;
  conversionActionId: string;
  eventId: string;
  occurredAt: Date;
  userData: AdConversionUserData | null;
  value: number | null;
  currency: string | null;
}): GoogleAdsUploadPayload {
  const identifiers: GoogleAdsConversion["userIdentifiers"] = [];
  if (input.userData?.emailHash) {
    identifiers.push({ hashedEmail: input.userData.emailHash });
  }
  if (input.userData?.phoneE164Hash) {
    identifiers.push({ hashedPhoneNumber: input.userData.phoneE164Hash });
  }
  const conversion: GoogleAdsConversion = {
    conversionAction: `customers/${input.customerId}/conversionActions/${input.conversionActionId}`,
    conversionDateTime: formatGoogleAdsDateTime(input.occurredAt),
    orderId: input.eventId,
    userIdentifiers: identifiers,
  };
  if (input.value !== null && input.currency) {
    conversion.conversionValue = input.value;
    conversion.currencyCode = input.currency;
  }
  return { conversions: [conversion], partialFailure: true };
}

/** Google punya sesuatu untuk dicocokkan hanya bila email/telepon ter-hash ada. */
export function googleHasIdentifier(
  userData: AdConversionUserData | null,
): boolean {
  return Boolean(userData?.emailHash || userData?.phoneE164Hash);
}

// ---------------------------------------------------------------------------
// Pengiriman (worker): klaim baris ledger → panggil platform → catat hasil
// ---------------------------------------------------------------------------

export type DeliverAdConversionResult =
  | { kind: "sent"; platform: AdPlatform; httpStatus: number }
  | { kind: "already_sent" }
  | { kind: "not_found" }
  | { kind: "skipped"; errorCode: string }
  | { kind: "failed"; errorCode: string; httpStatus: number | null };

interface FinalizeInput {
  status: "sent" | "failed" | "skipped";
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  payload: unknown;
}

async function finalizeDelivery(
  db: Database,
  tenantId: string,
  rowId: string,
  row: AdConversionEventRow,
  fin: FinalizeInput,
  sentAt: Date | null,
): Promise<void> {
  await withTenantDb(db, tenantId, async (tx) => {
    await tx
      .update(adConversionEvents)
      .set({
        status: fin.status,
        httpStatus: fin.httpStatus,
        errorCode: fin.errorCode,
        errorMessage: fin.errorMessage?.slice(0, 500) ?? null,
        payload: fin.payload ?? null,
        sentAt,
        updatedAt: new Date(),
      })
      .where(eq(adConversionEvents.id, rowId));
  });
  await recordIntegrationLog(db, {
    direction: "out",
    provider: row.platform === "meta" ? "meta_capi" : "google_ads",
    tenantId,
    outcome: fin.status === "sent" ? "sent" : "failed",
    errorCode: fin.errorCode,
    summary:
      fin.status === "sent"
        ? `Konversi ${row.eventName} terkirim ke ${row.platform}`
        : fin.status === "skipped"
          ? `Konversi ${row.eventName} dilewati: ${fin.errorCode}`
          : `Konversi ${row.eventName} gagal: ${fin.errorCode}`,
    payload: fin.payload ?? undefined,
  });
}

function errorMessageOf(body: unknown): string | null {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = b.error as Record<string, unknown> | undefined;
    if (err && typeof err.message === "string") return err.message;
    if (typeof b.message === "string") return b.message;
  }
  return null;
}

/**
 * Kirim satu baris ledger ke platformnya. IDEMPOTEN per baris: baris
 * yang sudah 'sent' tidak pernah dikirim ulang. Semua kegagalan
 * platform (konfigurasi hilang, token mati, HTTP error, jaringan)
 * berakhir sebagai status tercatat di baris + log integrasi — fungsi
 * ini hanya melempar untuk kegagalan DB yang memang harus di-retry
 * antrean.
 */
export async function deliverAdConversion(
  db: Database,
  input: { tenantId: string; eventRowId: string },
  deps: AdConversionDeps,
): Promise<DeliverAdConversionResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const row = await withTenantDb(db, input.tenantId, async (tx) => {
    const [found] = await tx
      .select()
      .from(adConversionEvents)
      .where(eq(adConversionEvents.id, input.eventRowId))
      .limit(1);
    if (!found || found.status === "sent") return found ?? null;
    await tx
      .update(adConversionEvents)
      .set({ attempts: found.attempts + 1, updatedAt: new Date() })
      .where(eq(adConversionEvents.id, found.id));
    return { ...found, attempts: found.attempts + 1 };
  });
  if (!row) return { kind: "not_found" };
  if (row.status === "sent") return { kind: "already_sent" };

  const connection = await readConnectionRow(db, input.tenantId);
  const value = row.value !== null ? Number(row.value) : null;

  if (row.platform === "meta") {
    if (!connection?.metaDatasetId || !connection.metaAccessTokenEncrypted) {
      await finalizeDelivery(
        db,
        input.tenantId,
        row.id,
        row,
        {
          status: "failed",
          httpStatus: null,
          errorCode: "meta_not_configured",
          errorMessage:
            "Dataset ID atau access token Meta tenant belum diatur",
          payload: null,
        },
        null,
      );
      return { kind: "failed", errorCode: "meta_not_configured", httpStatus: null };
    }
    const accessToken = deps.tokenSecret
      ? decryptChannelSecret(deps.tokenSecret, connection.metaAccessTokenEncrypted)
      : null;
    if (!accessToken) {
      await finalizeDelivery(
        db,
        input.tenantId,
        row.id,
        row,
        {
          status: "failed",
          httpStatus: null,
          errorCode: "meta_token_undecryptable",
          errorMessage:
            "Access token Meta tidak bisa didekripsi (kunci server berubah?) — simpan ulang token di Pengaturan",
          payload: null,
        },
        null,
      );
      return {
        kind: "failed",
        errorCode: "meta_token_undecryptable",
        httpStatus: null,
      };
    }
    const payload = buildMetaCapiPayload({
      eventName: row.eventName,
      eventId: row.eventId,
      occurredAt: row.occurredAt,
      userData: row.userData,
      value,
      currency: row.currency,
      testEventCode: connection.metaTestEventCode,
    });
    const base = (deps.metaApiBase ?? META_DEFAULT_API_BASE).replace(/\/+$/, "");
    let httpStatus: number | null = null;
    let body: unknown = null;
    try {
      const res = await fetchImpl(
        `${base}/${META_CAPI_GRAPH_VERSION}/${connection.metaDatasetId}/events?access_token=${encodeURIComponent(accessToken)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      httpStatus = res.status;
      body = await res.json().catch(() => null);
    } catch {
      await finalizeDelivery(
        db,
        input.tenantId,
        row.id,
        row,
        {
          status: "failed",
          httpStatus: null,
          errorCode: "meta_network_error",
          errorMessage: "Graph API Meta tidak terjangkau",
          payload,
        },
        null,
      );
      return { kind: "failed", errorCode: "meta_network_error", httpStatus: null };
    }
    if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
      await finalizeDelivery(
        db,
        input.tenantId,
        row.id,
        row,
        {
          status: "sent",
          httpStatus,
          errorCode: null,
          errorMessage: null,
          payload,
        },
        now(),
      );
      return { kind: "sent", platform: "meta", httpStatus };
    }
    const errorCode = `meta_http_${httpStatus ?? 0}`;
    await finalizeDelivery(
      db,
      input.tenantId,
      row.id,
      row,
      {
        status: "failed",
        httpStatus,
        errorCode,
        errorMessage: errorMessageOf(body) ?? "Meta menolak peristiwa",
        payload,
      },
      null,
    );
    return { kind: "failed", errorCode, httpStatus };
  }

  // --- Google Ads ---
  if (!googleHasIdentifier(row.userData)) {
    // JUJUR: tanpa gclid (tidak ada di chat) dan tanpa email/telepon
    // ter-hash, Google tidak punya sinyal pencocokan apa pun —
    // mengirimnya berarti mengarang atribusi. Dicatat skipped dengan
    // alasan persis, sebelum panggilan jaringan apa pun.
    await finalizeDelivery(
      db,
      input.tenantId,
      row.id,
      row,
      {
        status: "skipped",
        httpStatus: null,
        errorCode: "google_no_identifier",
        errorMessage:
          "Kontak tidak punya email/telepon dan gclid tidak tersedia dari chat — tidak ada pengenal untuk dicocokkan Google",
        payload: null,
      },
      null,
    );
    return { kind: "skipped", errorCode: "google_no_identifier" };
  }
  if (!connection?.googleCustomerId || !connection.googleConversionActionId) {
    await finalizeDelivery(
      db,
      input.tenantId,
      row.id,
      row,
      {
        status: "failed",
        httpStatus: null,
        errorCode: "google_ads_not_configured",
        errorMessage:
          "Customer ID atau conversion action ID Google Ads tenant belum diatur",
        payload: null,
      },
      null,
    );
    return {
      kind: "failed",
      errorCode: "google_ads_not_configured",
      httpStatus: null,
    };
  }
  const developerToken = await getProviderSecret(
    db,
    "google_ads_developer_token",
    deps.platform,
  );
  if (!developerToken) {
    await finalizeDelivery(
      db,
      input.tenantId,
      row.id,
      row,
      {
        status: "failed",
        httpStatus: null,
        errorCode: "google_developer_token_missing",
        errorMessage:
          "Developer token Google Ads milik platform belum diisi (Panel Admin)",
        payload: null,
      },
      null,
    );
    return {
      kind: "failed",
      errorCode: "google_developer_token_missing",
      httpStatus: null,
    };
  }
  const access = await getValidGoogleServiceAccess(db, input.tenantId, "ads", {
    platform: deps.platform,
    tokenSecret: deps.tokenSecret,
    bases: deps.googleBases,
  });
  if (!access) {
    await finalizeDelivery(
      db,
      input.tenantId,
      row.id,
      row,
      {
        status: "failed",
        httpStatus: null,
        errorCode: "google_ads_not_connected",
        errorMessage:
          "Akun Google Ads tenant belum terhubung (consent OAuth layanan 'ads') atau tokennya tidak bisa disegarkan",
        payload: null,
      },
      null,
    );
    return {
      kind: "failed",
      errorCode: "google_ads_not_connected",
      httpStatus: null,
    };
  }
  const payload = buildGoogleAdsPayload({
    customerId: connection.googleCustomerId,
    conversionActionId: connection.googleConversionActionId,
    eventId: row.eventId,
    occurredAt: row.occurredAt,
    userData: row.userData,
    value,
    currency: row.currency,
  });
  const adsBase = (
    deps.googleBases?.adsBase ?? GOOGLE_ADS_DEFAULT_API_BASE
  ).replace(/\/+$/, "");
  let httpStatus: number | null = null;
  let body: unknown = null;
  try {
    const res = await fetchImpl(
      `${adsBase}/${GOOGLE_ADS_API_VERSION}/customers/${connection.googleCustomerId}:uploadClickConversions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${access.accessToken}`,
          "developer-token": developerToken,
        },
        body: JSON.stringify(payload),
      },
    );
    httpStatus = res.status;
    body = await res.json().catch(() => null);
  } catch {
    await finalizeDelivery(
      db,
      input.tenantId,
      row.id,
      row,
      {
        status: "failed",
        httpStatus: null,
        errorCode: "google_network_error",
        errorMessage: "Google Ads API tidak terjangkau",
        payload,
      },
      null,
    );
    return { kind: "failed", errorCode: "google_network_error", httpStatus: null };
  }
  const partialFailureError =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).partialFailureError
      : undefined;
  if (
    httpStatus !== null &&
    httpStatus >= 200 &&
    httpStatus < 300 &&
    !partialFailureError
  ) {
    await finalizeDelivery(
      db,
      input.tenantId,
      row.id,
      row,
      {
        status: "sent",
        httpStatus,
        errorCode: null,
        errorMessage: null,
        payload,
      },
      now(),
    );
    return { kind: "sent", platform: "google", httpStatus };
  }
  const errorCode = partialFailureError
    ? "google_partial_failure"
    : `google_http_${httpStatus ?? 0}`;
  await finalizeDelivery(
    db,
    input.tenantId,
    row.id,
    row,
    {
      status: "failed",
      httpStatus,
      errorCode,
      errorMessage:
        errorMessageOf(partialFailureError ?? body) ??
        "Google Ads menolak konversi",
      payload,
    },
    null,
  );
  return { kind: "failed", errorCode, httpStatus };
}
