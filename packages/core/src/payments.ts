import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  paymentLinks,
  paymentProviderConfigs,
  type Database,
  type PaymentLink,
  type PaymentProviderConfig,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";
import {
  decryptChannelSecret,
  encryptChannelSecret,
} from "./channel-secrets";
import {
  PAYMENT_PROVIDER_SIMULATION,
  resolvePaymentLinkByCode,
  syncOrderStatusFromLink,
  type PaymentActor,
} from "./products";

/**
 * Gerbang pembayaran sungguhan (Fase 14A) — Midtrans & Xendit
 * menggantikan 'simulation' sebagai provider hidup.
 *
 * Keputusan yang dijaga di sini:
 * - KREDENSIAL MILIK TENANT: setiap kreator menerima uang ke akun
 *   merchant-nya sendiri. Konfigurasi hidup di `payment_provider_configs`
 *   (satu baris per tenant), kunci sandbox & production TERPISAH, semua
 *   nilai kunci envelope terenkripsi AES-256-GCM (channel-secrets,
 *   env CHANNEL_TOKEN_SECRET) — tidak pernah masuk log/audit/respons.
 * - PROVIDER DIPILIH SAAT TAUTAN DIBUAT: sesi checkout provider dibuat
 *   serentak dengan pembuatan tautan (Snap transaction / invoice).
 *   Kegagalan panggilan provider = pembuatan tautan GAGAL dengan kode
 *   provider yang jujur — TIDAK ada fallback diam-diam ke simulasi.
 * - order_id Midtrans & external_id Xendit = `code` tautan kita
 *   (`pay_...`, kredensial publik tautan): webhook me-resolve tautan
 *   dari kode itu lewat lengan RLS `app.payment_code`, lalu tenant
 *   dari baris tautan — klaim tenant di payload TIDAK pernah dipercaya.
 * - VERIFIKASI WEBHOOK: Midtrans signature_key = SHA512(order_id +
 *   status_code + gross_amount + server_key) dengan server key TENANT
 *   pemilik tautan & environment tautan; Xendit header
 *   `x-callback-token` dibandingkan timing-safe dengan token callback
 *   tenant. Jumlah di webhook WAJIB sama dengan amount tautan, kalau
 *   tidak ditolak & dicatat. Pemrosesan IDEMPOTEN: transisi hanya dari
 *   status 'pending' (disiplin yang sama dengan hook order 13F) —
 *   pengiriman ulang tidak mengubah apa pun dan audit hanya sekali.
 * - Base URL provider bisa dioverride env (MIDTRANS_API_BASE /
 *   XENDIT_API_BASE) untuk mock rantai uji — pola Resend/Google.
 *   Override berlaku untuk KEDUA environment (mock tidak membedakan).
 */

export const PAYMENT_PROVIDER_MIDTRANS = "midtrans";
export const PAYMENT_PROVIDER_XENDIT = "xendit";

export type PaymentProviderId =
  | typeof PAYMENT_PROVIDER_SIMULATION
  | typeof PAYMENT_PROVIDER_MIDTRANS
  | typeof PAYMENT_PROVIDER_XENDIT;

export type PaymentEnvironment = "sandbox" | "production";

export const MIDTRANS_SANDBOX_API_BASE = "https://app.sandbox.midtrans.com";
export const MIDTRANS_PRODUCTION_API_BASE = "https://app.midtrans.com";
export const XENDIT_API_BASE = "https://api.xendit.co";

/** Dependensi transport untuk jalur provider (diisi API/worker dari env). */
export interface PaymentDeps {
  /** Secret enkripsi kredensial tenant (env CHANNEL_TOKEN_SECRET). */
  tokenSecret?: string;
  /** Override base URL Midtrans untuk mock; default per environment. */
  midtransApiBase?: string;
  /** Override base URL Xendit untuk mock; default https://api.xendit.co. */
  xenditApiBase?: string;
  /** Base URL publik aplikasi untuk URL kembali (finish/redirect) provider. */
  publicBaseUrl?: string;
}

/** Kegagalan provider berkode stabil — pemanggil memetakannya ke permukaan. */
export class PaymentProviderError extends Error {
  readonly code: string;
  readonly provider: string;
  constructor(code: string, provider: string, message: string) {
    super(message);
    this.name = "PaymentProviderError";
    this.code = code;
    this.provider = provider;
  }
}

// ---------------------------------------------------------------------------
// Konfigurasi provider tenant — baca/tulis (dashboard Settings → Payments)
// ---------------------------------------------------------------------------

/** Baris konfigurasi tenant, dibuat malas dengan default aman. */
async function getOrCreateConfigRowTx(
  tx: DbTx,
  tenantId: string,
): Promise<PaymentProviderConfig> {
  const [existing] = await tx
    .select()
    .from(paymentProviderConfigs)
    .where(eq(paymentProviderConfigs.tenantId, tenantId))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx
    .insert(paymentProviderConfigs)
    .values({ tenantId })
    .returning();
  return created;
}

async function getConfigRowTx(
  tx: DbTx,
  tenantId: string,
): Promise<PaymentProviderConfig | null> {
  const [row] = await tx
    .select()
    .from(paymentProviderConfigs)
    .where(eq(paymentProviderConfigs.tenantId, tenantId))
    .limit(1);
  return row ?? null;
}

type CredentialField =
  | "midtransSandboxServerKeyEncrypted"
  | "midtransSandboxClientKeyEncrypted"
  | "midtransProductionServerKeyEncrypted"
  | "midtransProductionClientKeyEncrypted"
  | "xenditSandboxServerKeyEncrypted"
  | "xenditSandboxClientKeyEncrypted"
  | "xenditProductionServerKeyEncrypted"
  | "xenditProductionClientKeyEncrypted"
  | "xenditSandboxCallbackTokenEncrypted"
  | "xenditProductionCallbackTokenEncrypted";

export interface PaymentSettingsView {
  provider: PaymentProviderId;
  environment: PaymentEnvironment;
  midtrans: Record<
    PaymentEnvironment,
    { serverKeyConfigured: boolean; clientKeyConfigured: boolean }
  >;
  xendit: Record<
    PaymentEnvironment,
    {
      serverKeyConfigured: boolean;
      clientKeyConfigured: boolean;
      callbackTokenConfigured: boolean;
    }
  >;
}

function credentialSetView(
  row: PaymentProviderConfig | null,
  serverField: CredentialField,
  clientField: CredentialField,
): { serverKeyConfigured: boolean; clientKeyConfigured: boolean } {
  return {
    serverKeyConfigured: Boolean(row?.[serverField]),
    clientKeyConfigured: Boolean(row?.[clientField]),
  };
}

function toSettingsView(row: PaymentProviderConfig | null): PaymentSettingsView {
  return {
    provider: (row?.provider ?? PAYMENT_PROVIDER_SIMULATION) as PaymentProviderId,
    environment: (row?.environment ?? "sandbox") as PaymentEnvironment,
    midtrans: {
      sandbox: credentialSetView(
        row,
        "midtransSandboxServerKeyEncrypted",
        "midtransSandboxClientKeyEncrypted",
      ),
      production: credentialSetView(
        row,
        "midtransProductionServerKeyEncrypted",
        "midtransProductionClientKeyEncrypted",
      ),
    },
    xendit: {
      sandbox: {
        ...credentialSetView(
          row,
          "xenditSandboxServerKeyEncrypted",
          "xenditSandboxClientKeyEncrypted",
        ),
        callbackTokenConfigured: Boolean(
          row?.xenditSandboxCallbackTokenEncrypted,
        ),
      },
      production: {
        ...credentialSetView(
          row,
          "xenditProductionServerKeyEncrypted",
          "xenditProductionClientKeyEncrypted",
        ),
        callbackTokenConfigured: Boolean(
          row?.xenditProductionCallbackTokenEncrypted,
        ),
      },
    },
  };
}

/** Tampilan konfigurasi untuk dashboard — TANPA nilai kunci apa pun. */
export async function getPaymentSettings(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<PaymentSettingsView> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return toSettingsView(await getConfigRowTx(tx, ctx.tenantId));
  });
}

export interface UpdatePaymentSettingsInput {
  provider?: PaymentProviderId;
  environment?: PaymentEnvironment;
  midtransSandboxServerKey?: string;
  midtransSandboxClientKey?: string;
  midtransProductionServerKey?: string;
  midtransProductionClientKey?: string;
  xenditSandboxServerKey?: string;
  xenditSandboxClientKey?: string;
  xenditProductionServerKey?: string;
  xenditProductionClientKey?: string;
  xenditSandboxCallbackToken?: string;
  xenditProductionCallbackToken?: string;
}

const KEY_FIELD_MAP: Record<
  string,
  { input: keyof UpdatePaymentSettingsInput; column: CredentialField }
> = {
  midtransSandboxServerKey: {
    input: "midtransSandboxServerKey",
    column: "midtransSandboxServerKeyEncrypted",
  },
  midtransSandboxClientKey: {
    input: "midtransSandboxClientKey",
    column: "midtransSandboxClientKeyEncrypted",
  },
  midtransProductionServerKey: {
    input: "midtransProductionServerKey",
    column: "midtransProductionServerKeyEncrypted",
  },
  midtransProductionClientKey: {
    input: "midtransProductionClientKey",
    column: "midtransProductionClientKeyEncrypted",
  },
  xenditSandboxServerKey: {
    input: "xenditSandboxServerKey",
    column: "xenditSandboxServerKeyEncrypted",
  },
  xenditSandboxClientKey: {
    input: "xenditSandboxClientKey",
    column: "xenditSandboxClientKeyEncrypted",
  },
  xenditProductionServerKey: {
    input: "xenditProductionServerKey",
    column: "xenditProductionServerKeyEncrypted",
  },
  xenditProductionClientKey: {
    input: "xenditProductionClientKey",
    column: "xenditProductionClientKeyEncrypted",
  },
  xenditSandboxCallbackToken: {
    input: "xenditSandboxCallbackToken",
    column: "xenditSandboxCallbackTokenEncrypted",
  },
  xenditProductionCallbackToken: {
    input: "xenditProductionCallbackToken",
    column: "xenditProductionCallbackTokenEncrypted",
  },
};

export type UpdatePaymentSettingsResult =
  | { kind: "ok"; view: PaymentSettingsView }
  | { kind: "secret_unconfigured" };

/**
 * Menyimpan konfigurasi provider tenant. Per field kunci: tidak dikirim
 * = tidak berubah; "" = hapus; nilai = ganti (dienkripsi di sini).
 * Audit `payment.settings_updated` mencatat NAMA field yang berubah —
 * nilai kunci tidak pernah masuk audit. Menyimpan kunci tanpa
 * CHANNEL_TOKEN_SECRET di server → 'secret_unconfigured' (jujur,
 * bukan simpan-plaintext diam-diam).
 */
export async function updatePaymentSettings(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: UpdatePaymentSettingsInput,
  actor: PaymentActor,
  deps?: PaymentDeps,
): Promise<UpdatePaymentSettingsResult> {
  const keyChanges = Object.values(KEY_FIELD_MAP).filter(
    (f) => input[f.input] !== undefined,
  );
  if (keyChanges.length > 0 && !deps?.tokenSecret) {
    return { kind: "secret_unconfigured" };
  }
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const row = await getOrCreateConfigRowTx(tx, ctx.tenantId);
    const patch: Partial<PaymentProviderConfig> = { updatedAt: new Date() };
    const changedFields: string[] = [];
    if (input.provider !== undefined && input.provider !== row.provider) {
      patch.provider = input.provider;
      changedFields.push("provider");
    }
    if (
      input.environment !== undefined &&
      input.environment !== row.environment
    ) {
      patch.environment = input.environment;
      changedFields.push("environment");
    }
    for (const field of Object.values(KEY_FIELD_MAP)) {
      const raw = input[field.input];
      if (raw === undefined) continue;
      patch[field.column] =
        raw === ""
          ? null
          : encryptChannelSecret(deps!.tokenSecret!, raw);
      changedFields.push(field.input);
    }
    const [updated] = await tx
      .update(paymentProviderConfigs)
      .set(patch)
      .where(eq(paymentProviderConfigs.id, row.id))
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "payment.settings_updated",
      meta: {
        provider: updated?.provider ?? row.provider,
        environment: updated?.environment ?? row.environment,
        changedFields,
      },
    });
    return {
      kind: "ok" as const,
      view: toSettingsView(updated ?? row),
    };
  });
}

// ---------------------------------------------------------------------------
// Resolusi kredensial aktif (internal — nilai terang hanya di memori)
// ---------------------------------------------------------------------------

export interface ResolvedPaymentCredentials {
  provider: PaymentProviderId;
  environment: PaymentEnvironment;
  serverKey: string | null;
  clientKey: string | null;
  callbackToken: string | null;
}

function decryptOrNull(
  tokenSecret: string | undefined,
  stored: string | null,
): string | null {
  if (!stored) return null;
  if (!tokenSecret) return null;
  return decryptChannelSecret(tokenSecret, stored);
}

function resolveCredentialsFromRow(
  row: PaymentProviderConfig | null,
  tokenSecret: string | undefined,
  linkEnvironment?: PaymentEnvironment,
): ResolvedPaymentCredentials {
  const provider = (row?.provider ??
    PAYMENT_PROVIDER_SIMULATION) as PaymentProviderId;
  const environment = (linkEnvironment ??
    row?.environment ??
    "sandbox") as PaymentEnvironment;
  if (!row) {
    return { provider, environment, serverKey: null, clientKey: null, callbackToken: null };
  }
  const pick = (
    sandbox: string | null,
    production: string | null,
  ): string | null =>
    decryptOrNull(tokenSecret, environment === "production" ? production : sandbox);
  if (provider === PAYMENT_PROVIDER_MIDTRANS) {
    return {
      provider,
      environment,
      serverKey: pick(
        row.midtransSandboxServerKeyEncrypted,
        row.midtransProductionServerKeyEncrypted,
      ),
      clientKey: pick(
        row.midtransSandboxClientKeyEncrypted,
        row.midtransProductionClientKeyEncrypted,
      ),
      callbackToken: null,
    };
  }
  if (provider === PAYMENT_PROVIDER_XENDIT) {
    return {
      provider,
      environment,
      serverKey: pick(
        row.xenditSandboxServerKeyEncrypted,
        row.xenditProductionServerKeyEncrypted,
      ),
      clientKey: pick(
        row.xenditSandboxClientKeyEncrypted,
        row.xenditProductionClientKeyEncrypted,
      ),
      callbackToken: pick(
        row.xenditSandboxCallbackTokenEncrypted,
        row.xenditProductionCallbackTokenEncrypted,
      ),
    };
  }
  return { provider, environment, serverKey: null, clientKey: null, callbackToken: null };
}

/** Kredensial aktif tenant (provider + environment dari konfigurasi). */
export async function resolvePaymentCredentials(
  db: Database,
  tenantId: string,
  deps?: PaymentDeps,
): Promise<ResolvedPaymentCredentials> {
  return withTenantDb(db, tenantId, async (tx) => {
    return resolveCredentialsFromRow(
      await getConfigRowTx(tx, tenantId),
      deps?.tokenSecret,
    );
  });
}

// ---------------------------------------------------------------------------
// Klien provider — HTTP polos (pola Resend/Google), base bisa dioverride
// ---------------------------------------------------------------------------

function midtransBase(deps: PaymentDeps | undefined, env: PaymentEnvironment): string {
  if (deps?.midtransApiBase) return deps.midtransApiBase.replace(/\/+$/, "");
  return env === "production"
    ? MIDTRANS_PRODUCTION_API_BASE
    : MIDTRANS_SANDBOX_API_BASE;
}

function xenditBase(deps: PaymentDeps | undefined): string {
  return (deps?.xenditApiBase ?? XENDIT_API_BASE).replace(/\/+$/, "");
}

function basicAuthHeader(serverKey: string): string {
  // Kedua provider memakai Basic auth dengan server key sebagai
  // username dan password kosong.
  return `Basic ${Buffer.from(`${serverKey}:`, "utf8").toString("base64")}`;
}

export interface ProviderCheckoutSession {
  provider: PaymentProviderId;
  environment: PaymentEnvironment;
  /** Token Snap (midtrans) / id invoice (xendit); null untuk simulasi. */
  providerRef: string | null;
  /** URL checkout provider; null untuk simulasi. */
  checkoutUrl: string | null;
}

async function midtransCreateSnap(
  deps: PaymentDeps | undefined,
  creds: ResolvedPaymentCredentials,
  input: { code: string; amountIdr: number; itemLabel: string },
): Promise<ProviderCheckoutSession> {
  const serverKey = creds.serverKey;
  if (!serverKey) {
    throw new PaymentProviderError(
      "PAYMENT_NOT_CONFIGURED",
      PAYMENT_PROVIDER_MIDTRANS,
      "Midtrans server key belum terkonfigurasi untuk environment aktif",
    );
  }
  const base = midtransBase(deps, creds.environment);
  const finishUrl = deps?.publicBaseUrl
    ? `${deps.publicBaseUrl.replace(/\/+$/, "")}/pay/${input.code}`
    : undefined;
  let res: Response;
  try {
    res = await fetch(`${base}/snap/v1/transactions`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(serverKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        transaction_details: {
          order_id: input.code,
          gross_amount: input.amountIdr,
        },
        item_details: [
          {
            id: input.code,
            price: input.amountIdr,
            quantity: 1,
            name: input.itemLabel.slice(0, 50),
          },
        ],
        ...(finishUrl
          ? { callbacks: { finish: finishUrl } }
          : {}),
      }),
    });
  } catch {
    throw new PaymentProviderError(
      "MIDTRANS_UNREACHABLE",
      PAYMENT_PROVIDER_MIDTRANS,
      "Midtrans tidak terjangkau saat membuat transaksi Snap",
    );
  }
  const body = (await res.json().catch(() => null)) as {
    token?: string;
    redirect_url?: string;
    error_messages?: string[];
  } | null;
  if (!res.ok || !body?.redirect_url) {
    throw new PaymentProviderError(
      res.status === 401 || res.status === 403
        ? "MIDTRANS_AUTH_FAILED"
        : "MIDTRANS_CREATE_FAILED",
      PAYMENT_PROVIDER_MIDTRANS,
      `Midtrans menolak pembuatan transaksi Snap (HTTP ${res.status})`,
    );
  }
  return {
    provider: PAYMENT_PROVIDER_MIDTRANS,
    environment: creds.environment,
    providerRef: body.token ?? null,
    checkoutUrl: body.redirect_url,
  };
}

async function xenditCreateInvoice(
  deps: PaymentDeps | undefined,
  creds: ResolvedPaymentCredentials,
  input: { code: string; amountIdr: number; itemLabel: string },
): Promise<ProviderCheckoutSession> {
  const serverKey = creds.serverKey;
  if (!serverKey) {
    throw new PaymentProviderError(
      "PAYMENT_NOT_CONFIGURED",
      PAYMENT_PROVIDER_XENDIT,
      "Xendit server key belum terkonfigurasi untuk environment aktif",
    );
  }
  const base = xenditBase(deps);
  const returnUrl = deps?.publicBaseUrl
    ? `${deps.publicBaseUrl.replace(/\/+$/, "")}/pay/${input.code}`
    : undefined;
  let res: Response;
  try {
    res = await fetch(`${base}/v2/invoices`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(serverKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_id: input.code,
        amount: input.amountIdr,
        description: input.itemLabel.slice(0, 255),
        ...(returnUrl
          ? {
              success_redirect_url: returnUrl,
              failure_redirect_url: returnUrl,
            }
          : {}),
      }),
    });
  } catch {
    throw new PaymentProviderError(
      "XENDIT_UNREACHABLE",
      PAYMENT_PROVIDER_XENDIT,
      "Xendit tidak terjangkau saat membuat invoice",
    );
  }
  const body = (await res.json().catch(() => null)) as {
    id?: string;
    invoice_url?: string;
    error_code?: string;
  } | null;
  if (!res.ok || !body?.invoice_url) {
    throw new PaymentProviderError(
      res.status === 401 || res.status === 403
        ? "XENDIT_AUTH_FAILED"
        : "XENDIT_CREATE_FAILED",
      PAYMENT_PROVIDER_XENDIT,
      `Xendit menolak pembuatan invoice (HTTP ${res.status})`,
    );
  }
  return {
    provider: PAYMENT_PROVIDER_XENDIT,
    environment: creds.environment,
    providerRef: body.id ?? null,
    checkoutUrl: body.invoice_url,
  };
}

/**
 * Membuat sesi checkout untuk satu tautan BARU sesuai konfigurasi
 * provider tenant. Simulasi → sesi kosong (halaman /pay membayar di
 * tempat). Provider sungguhan → panggilan API sekarang juga; kegagalan
 * melempar PaymentProviderError berkode dan PEMANGGIL membatalkan
 * pembuatan tautan (tidak ada fallback diam-diam).
 */
export async function createProviderCheckoutSession(
  db: Database,
  tenantId: string,
  deps: PaymentDeps | undefined,
  input: { code: string; amountIdr: number; itemLabel: string },
): Promise<ProviderCheckoutSession> {
  const creds = await resolvePaymentCredentials(db, tenantId, deps);
  if (creds.provider === PAYMENT_PROVIDER_MIDTRANS) {
    return midtransCreateSnap(deps, creds, input);
  }
  if (creds.provider === PAYMENT_PROVIDER_XENDIT) {
    return xenditCreateInvoice(deps, creds, input);
  }
  return {
    provider: PAYMENT_PROVIDER_SIMULATION,
    environment: "sandbox",
    providerRef: null,
    checkoutUrl: null,
  };
}

// ---------------------------------------------------------------------------
// Uji koneksi (preseden probe Resend 11B: kode hasil jujur)
// ---------------------------------------------------------------------------

export interface PaymentConnectionTestResult {
  ok: boolean;
  code:
    | "OK"
    | "NOT_CONFIGURED"
    | "MIDTRANS_AUTH_FAILED"
    | "MIDTRANS_UNREACHABLE"
    | "XENDIT_AUTH_FAILED"
    | "XENDIT_UNREACHABLE";
  provider: PaymentProviderId;
  environment: PaymentEnvironment;
}

/**
 * Menguji kredensial provider AKTIF tenant (provider + environment dari
 * konfigurasi tersimpan) tanpa membuat transaksi apa pun:
 * - Midtrans: GET status order_id yang pasti tidak ada — 404 dari
 *   Midtrans berarti kredensial DITERIMA (auth lolos, order memang
 *   tidak ada); 401/403 berarti kunci salah.
 * - Xendit: GET daftar invoice limit 1 — 200 berarti diterima.
 * - Simulation: selalu OK (tidak ada yang diuji).
 */
export async function testPaymentConnection(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  deps?: PaymentDeps,
): Promise<PaymentConnectionTestResult> {
  const creds = await resolvePaymentCredentials(db, ctx.tenantId, deps);
  const base = { provider: creds.provider, environment: creds.environment };
  if (creds.provider === PAYMENT_PROVIDER_SIMULATION) {
    return { ...base, ok: true, code: "OK" };
  }
  if (!creds.serverKey) {
    return { ...base, ok: false, code: "NOT_CONFIGURED" };
  }
  if (creds.provider === PAYMENT_PROVIDER_MIDTRANS) {
    let res: Response;
    try {
      res = await fetch(
        `${midtransBase(deps, creds.environment)}/v2/sk-connection-probe/status`,
        {
          headers: {
            Authorization: basicAuthHeader(creds.serverKey),
            Accept: "application/json",
          },
        },
      );
    } catch {
      return { ...base, ok: false, code: "MIDTRANS_UNREACHABLE" };
    }
    if (res.status === 401 || res.status === 403) {
      return { ...base, ok: false, code: "MIDTRANS_AUTH_FAILED" };
    }
    // 404 = order probe tidak ada = auth diterima. Status lain yang
    // bukan auth-error juga berarti server menjawab untuk kunci ini.
    return { ...base, ok: true, code: "OK" };
  }
  // Xendit
  let res: Response;
  try {
    res = await fetch(`${xenditBase(deps)}/v2/invoices?limit=1`, {
      headers: { Authorization: basicAuthHeader(creds.serverKey) },
    });
  } catch {
    return { ...base, ok: false, code: "XENDIT_UNREACHABLE" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...base, ok: false, code: "XENDIT_AUTH_FAILED" };
  }
  if (!res.ok) {
    return { ...base, ok: false, code: "XENDIT_UNREACHABLE" };
  }
  return { ...base, ok: true, code: "OK" };
}

// ---------------------------------------------------------------------------
// Webhook — transisi status tautan (idempoten, disiplin hook order 13F)
// ---------------------------------------------------------------------------

export type PaymentWebhookOutcome =
  | "applied"
  | "duplicate"
  | "ignored_pending"
  | "rejected_signature"
  | "rejected_amount"
  | "not_found"
  | "malformed"
  | "not_configured";

export interface PaymentWebhookResult {
  outcome: PaymentWebhookOutcome;
  tenantId: string | null;
  code: string | null;
  /** Status tautan sesudah pemrosesan (bila tautan ada). */
  linkStatus: PaymentLink["status"] | null;
}

type LinkTargetStatus = "paid" | "expired" | "cancelled";

/**
 * Menerapkan transisi status dari webhook di dalam konteks tenant
 * pemilik tautan. Idempoten: hanya tautan 'pending' yang bertransisi;
 * tautan yang sudah final menghasilkan 'duplicate' tanpa audit kedua.
 * Order di balik tautan mengikuti lewat hook 13F yang sama seperti
 * jalur simulasi.
 */
async function applyWebhookTransition(
  db: Database,
  link: PaymentLink,
  target: LinkTargetStatus,
  provider: string,
): Promise<PaymentWebhookResult> {
  return withTenantDb(db, link.tenantId, async (tx) => {
    const [fresh] = await tx
      .select()
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, link.tenantId),
          eq(paymentLinks.id, link.id),
        ),
      )
      .limit(1);
    const current = fresh ?? link;
    if (current.status !== "pending") {
      return {
        outcome: "duplicate" as const,
        tenantId: link.tenantId,
        code: link.code,
        linkStatus: current.status,
      };
    }
    const now = new Date();
    // Klaim transisi secara ATOMIK: syarat `status = 'pending'` ikut di
    // WHERE, bukan hanya di percabangan di atas. Tanpa ini dua webhook
    // provider yang tiba bersamaan (mis. settlement lalu retry) sama-sama
    // lolos pembacaan `current.status === 'pending'` dan sama-sama
    // menerapkan transisi — dua baris audit dan dua kali sinkronisasi
    // order. Dengan syarat ini hanya satu yang mendapat baris kembali.
    const [updated] = await tx
      .update(paymentLinks)
      .set({
        status: target,
        paidAt: target === "paid" ? (current.paidAt ?? now) : current.paidAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentLinks.id, current.id),
          eq(paymentLinks.status, "pending"),
        ),
      )
      .returning();
    if (!updated) {
      // Kalah balapan: proses lain sudah mentransisikan tautan ini.
      // Laporkan duplicate dengan status terbaru, tanpa audit/hook kedua.
      const [latest] = await tx
        .select({ status: paymentLinks.status })
        .from(paymentLinks)
        .where(eq(paymentLinks.id, current.id))
        .limit(1);
      return {
        outcome: "duplicate" as const,
        tenantId: link.tenantId,
        code: link.code,
        linkStatus: latest?.status ?? current.status,
      };
    }
    const finalLink = updated;
    await syncOrderStatusFromLink(tx, finalLink);
    await tx.insert(auditLogs).values({
      tenantId: link.tenantId,
      actorType: "system",
      actorId: `${provider}-webhook`,
      action:
        target === "paid"
          ? "payment.paid"
          : target === "expired"
            ? "payment.expired"
            : "payment.cancelled",
      meta: {
        paymentLinkId: finalLink.id,
        code: finalLink.code,
        productId: finalLink.productId,
        orderId: finalLink.orderId,
        amountIdr: finalLink.amountIdr,
        provider: finalLink.provider,
        environment: finalLink.providerEnvironment,
        simulation: false,
      },
    });
    return {
      outcome: "applied" as const,
      tenantId: link.tenantId,
      code: link.code,
      linkStatus: finalLink.status,
    };
  });
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

function stringField(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Webhook Midtrans. Verifikasi berlapis sebelum status berubah:
 * tautan dari order_id (lengan publik) → server key TENANT pemilik
 * tautan untuk environment TAUTAN → signature_key SHA512 dibandingkan
 * timing-safe → jumlah (gross_amount dibulatkan) wajib sama dengan
 * amount tautan → pemetaan transaction_status:
 *   settlement | capture(fraud accept) → paid
 *   expire                             → expired
 *   deny | cancel                      → cancelled (enum status tautan
 *                                        tidak punya 'failed'; penolakan
 *                                        terminal terdekat yang jujur)
 *   pending / lainnya                  → no-op (ignored_pending)
 * capture dengan fraud_status 'challenge'/'deny' TIDAK menandai paid.
 */
export async function handleMidtransWebhook(
  db: Database,
  deps: PaymentDeps | undefined,
  payload: unknown,
): Promise<PaymentWebhookResult> {
  const rec = asRecord(payload);
  const orderId = rec ? stringField(rec, "order_id") : null;
  const statusCode = rec ? stringField(rec, "status_code") : null;
  const grossAmount = rec ? stringField(rec, "gross_amount") : null;
  const signatureKey = rec ? stringField(rec, "signature_key") : null;
  const transactionStatus = rec ? stringField(rec, "transaction_status") : null;
  if (!rec || !orderId || !statusCode || !grossAmount || !signatureKey || !transactionStatus) {
    return { outcome: "malformed", tenantId: null, code: orderId, linkStatus: null };
  }
  const link = await resolvePaymentLinkByCode(db, orderId);
  if (!link) {
    return { outcome: "not_found", tenantId: null, code: orderId, linkStatus: null };
  }
  const base = { tenantId: link.tenantId, code: link.code, linkStatus: link.status };
  if (link.provider !== PAYMENT_PROVIDER_MIDTRANS) {
    return { ...base, outcome: "not_configured" };
  }
  const creds = await withTenantDb(db, link.tenantId, async (tx) =>
    resolveCredentialsFromRow(
      await getConfigRowTx(tx, link.tenantId),
      deps?.tokenSecret,
      link.providerEnvironment as PaymentEnvironment,
    ),
  );
  if (!creds.serverKey || creds.provider !== PAYMENT_PROVIDER_MIDTRANS) {
    return { ...base, outcome: "not_configured" };
  }
  const expected = createHash("sha512")
    .update(`${orderId}${statusCode}${grossAmount}${creds.serverKey}`, "utf8")
    .digest("hex");
  if (!timingSafeStringEqual(expected, signatureKey.toLowerCase())) {
    return { ...base, outcome: "rejected_signature" };
  }
  const webhookAmount = Math.round(Number(grossAmount));
  if (!Number.isFinite(webhookAmount) || webhookAmount !== link.amountIdr) {
    return { ...base, outcome: "rejected_amount" };
  }
  const fraudStatus = stringField(rec, "fraud_status");
  let target: LinkTargetStatus | null = null;
  if (transactionStatus === "settlement") target = "paid";
  else if (transactionStatus === "capture") {
    if (!fraudStatus || fraudStatus === "accept") target = "paid";
    else if (fraudStatus === "deny") target = "cancelled";
  } else if (transactionStatus === "expire") target = "expired";
  else if (transactionStatus === "deny" || transactionStatus === "cancel") {
    target = "cancelled";
  }
  if (!target) {
    return { ...base, outcome: "ignored_pending" };
  }
  return applyWebhookTransition(db, link, target, PAYMENT_PROVIDER_MIDTRANS);
}

/**
 * Webhook Xendit (invoice callback). Verifikasi: tautan dari
 * external_id → header `x-callback-token` WAJIB sama (timing-safe)
 * dengan token callback tenant untuk environment TAUTAN → jumlah
 * wajib sama → pemetaan status invoice: PAID | SETTLED → paid,
 * EXPIRED → expired, selain itu no-op.
 */
export async function handleXenditWebhook(
  db: Database,
  deps: PaymentDeps | undefined,
  callbackTokenHeader: string | null,
  payload: unknown,
): Promise<PaymentWebhookResult> {
  const rec = asRecord(payload);
  const externalId = rec ? stringField(rec, "external_id") : null;
  const status = rec ? stringField(rec, "status") : null;
  const amountRaw = rec?.["amount"];
  if (!rec || !externalId || !status || typeof amountRaw !== "number") {
    return { outcome: "malformed", tenantId: null, code: externalId, linkStatus: null };
  }
  const link = await resolvePaymentLinkByCode(db, externalId);
  if (!link) {
    return { outcome: "not_found", tenantId: null, code: externalId, linkStatus: null };
  }
  const base = { tenantId: link.tenantId, code: link.code, linkStatus: link.status };
  if (link.provider !== PAYMENT_PROVIDER_XENDIT) {
    return { ...base, outcome: "not_configured" };
  }
  const creds = await withTenantDb(db, link.tenantId, async (tx) =>
    resolveCredentialsFromRow(
      await getConfigRowTx(tx, link.tenantId),
      deps?.tokenSecret,
      link.providerEnvironment as PaymentEnvironment,
    ),
  );
  if (!creds.callbackToken || creds.provider !== PAYMENT_PROVIDER_XENDIT) {
    return { ...base, outcome: "not_configured" };
  }
  if (
    !callbackTokenHeader ||
    !timingSafeStringEqual(callbackTokenHeader, creds.callbackToken)
  ) {
    return { ...base, outcome: "rejected_signature" };
  }
  if (Math.round(amountRaw) !== link.amountIdr) {
    return { ...base, outcome: "rejected_amount" };
  }
  let target: LinkTargetStatus | null = null;
  if (status === "PAID" || status === "SETTLED") target = "paid";
  else if (status === "EXPIRED") target = "expired";
  if (!target) {
    return { ...base, outcome: "ignored_pending" };
  }
  return applyWebhookTransition(db, link, target, PAYMENT_PROVIDER_XENDIT);
}
