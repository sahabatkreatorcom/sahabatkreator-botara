import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  auditLogs,
  contacts,
  discountRedemptions,
  orderItems,
  orders,
  paymentLinks,
  products,
  tenants,
  type Database,
  type PaymentLink,
  type Product,
} from "@sahabat-kreator/db";
import { releaseRedemptionsForOrderTx } from "./discount-codes";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";
import {
  createProviderCheckoutSession,
  PaymentProviderError,
  type PaymentDeps,
  type ProviderCheckoutSession,
} from "./payments";

/**
 * Service domain Produk & Tautan Bayar (Fase 4A, RANCANGAN §6 & §9).
 * Transport-agnostic; semua query tenant dalam konteks RLS.
 *
 * Keputusan yang dijaga di sini:
 * - Harga produk BOLEH berubah kapan pun; tautan yang sudah beredar tidak
 *   ikut berubah karena `payment_links.amount_idr` adalah snapshot.
 * - Hapus produk bersifat HARD delete hanya bila belum ada payment_links;
 *   bila sudah ada → 'has_links' (API menjawab 409 PRODUCT_HAS_LINKS dan
 *   menyarankan menonaktifkan produk, agar riwayat pembayaran utuh).
 * - Status 'expired' ditegakkan secara LAZY: baris pending yang expires_at
 *   nya lewat dianggap (dan ditandai) expired saat dibaca/dibayar — belum
 *   ada job penyapu di fase ini.
 * - Halaman bayar publik TANPA sesi: resolusi code → tenant meniru pola
 *   siteKey webchat (0006) — transaksi dengan `app.payment_code` hanya
 *   membuka SATU baris payment_links berkode itu (policy 0012
 *   `public_code_lookup`, FOR SELECT). Semua mutasi sesudahnya berjalan
 *   dalam konteks tenant pemilik lewat withTenantDb.
 * - Provider fase ini selalu 'simulation': TIDAK ada uang sungguhan yang
 *   bergerak. UI wajib berlabel simulasi (lihat halaman /pay di web).
 */

export const PAYMENT_LINK_TTL_DAYS = 7;
export const PAYMENT_PROVIDER_SIMULATION = "simulation";

// ---------------------------------------------------------------------------
// Produk
// ---------------------------------------------------------------------------

export interface CreateProductInput {
  name: string;
  description?: string;
  priceIdr: number;
  isActive?: boolean;
}

export interface UpdateProductInput {
  name?: string;
  description?: string | null;
  priceIdr?: number;
  isActive?: boolean;
}

export async function createProduct(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: CreateProductInput,
): Promise<Product> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(products)
      .values({
        tenantId: ctx.tenantId,
        name: input.name,
        description: input.description ?? null,
        priceIdr: input.priceIdr,
        isActive: input.isActive ?? true,
      })
      .returning();
    return row;
  });
}

export async function listProducts(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<Product[]> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(products)
      .where(eq(products.tenantId, ctx.tenantId))
      .orderBy(desc(products.createdAt));
  });
}

/** Null bila produk tidak ada DI tenant ini. */
export async function getProduct(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  productId: string,
): Promise<Product | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(products)
      .where(
        and(eq(products.tenantId, ctx.tenantId), eq(products.id, productId)),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Null bila produk tidak ada DI tenant ini. */
export async function updateProduct(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  productId: string,
  input: UpdateProductInput,
): Promise<Product | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<Product> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.priceIdr !== undefined) patch.priceIdr = input.priceIdr;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    const [row] = await tx
      .update(products)
      .set(patch)
      .where(
        and(eq(products.tenantId, ctx.tenantId), eq(products.id, productId)),
      )
      .returning();
    return row ?? null;
  });
}

export type DeleteProductResult = "deleted" | "not_found" | "has_links";

/**
 * Hard delete hanya bila produk belum punya payment_links sama sekali;
 * 'has_links' → penelepon menjawab 409 (riwayat pembayaran tidak boleh
 * hilang; nonaktifkan produk sebagai gantinya).
 */
export async function deleteProduct(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  productId: string,
): Promise<DeleteProductResult> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const existing = await getProductRow(tx, ctx.tenantId, productId);
    if (!existing) return "not_found";
    const [link] = await tx
      .select({ id: paymentLinks.id })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, ctx.tenantId),
          eq(paymentLinks.productId, productId),
        ),
      )
      .limit(1);
    if (link) return "has_links";
    await tx
      .delete(products)
      .where(
        and(eq(products.tenantId, ctx.tenantId), eq(products.id, productId)),
      );
    return "deleted";
  });
}

async function getProductRow(
  tx: DbTx,
  tenantId: string,
  productId: string,
): Promise<Product | null> {
  const [row] = await tx
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Tautan bayar — sisi tenant (dashboard)
// ---------------------------------------------------------------------------

/** `pay_` + 16 karakter acak URL-safe (kredensial publik tautan). */
export function generatePaymentCode(): string {
  return `pay_${randomBytes(12).toString("base64url")}`;
}

/** URL publik halaman bayar; tanpa baseUrl → path relatif (fallback jujur). */
export function buildPaymentUrl(
  baseUrl: string | undefined,
  code: string,
): string {
  if (!baseUrl) return `/pay/${code}`;
  return `${baseUrl.replace(/\/+$/, "")}/pay/${code}`;
}

export interface PaymentActor {
  actorType: "user" | "agent" | "system";
  actorId: string;
}

export interface CreatePaymentLinkInput {
  productId: string;
  contactId?: string;
  conversationId?: string;
}

export type CreatePaymentLinkResult =
  | { kind: "ok"; link: PaymentLink }
  | { kind: "product_not_found" }
  | { kind: "contact_not_found" }
  | { kind: "provider_error"; code: string; provider: string };

/**
 * Membuat tautan bayar: snapshot harga produk saat ini, code acak unik,
 * kedaluwarsa +7 hari, audit `payment_link.created` oleh actor pemanggil
 * (user dashboard / agent / system).
 *
 * Fase 14A: provider tautan mengikuti konfigurasi provider TENANT.
 * Untuk provider sungguhan (midtrans/xendit) sesi checkout dibuat
 * SEBELUM baris tautan ditulis (order_id/external_id provider = code
 * tautan); kegagalan panggilan provider membatalkan pembuatan dengan
 * { kind: 'provider_error', code } — tidak ada fallback diam-diam ke
 * simulasi. Untuk 'simulation' alurnya persis seperti sebelumnya.
 */
export async function createPaymentLink(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  input: CreatePaymentLinkInput,
  actor: PaymentActor,
  deps?: PaymentDeps,
): Promise<CreatePaymentLinkResult> {
  const prepared = await withTenantDb(db, ctx.tenantId, async (tx) => {
    const product = await getProductRow(tx, ctx.tenantId, input.productId);
    if (!product) return { kind: "product_not_found" as const };
    if (input.contactId) {
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, ctx.tenantId),
            eq(contacts.id, input.contactId),
          ),
        )
        .limit(1);
      if (!contact) return { kind: "contact_not_found" as const };
    }
    return { kind: "ready" as const, product };
  });
  if (prepared.kind !== "ready") return prepared;
  const product = prepared.product;
  const code = generatePaymentCode();
  let session: ProviderCheckoutSession;
  try {
    session = await createProviderCheckoutSession(db, ctx.tenantId, deps, {
      code,
      amountIdr: product.priceIdr,
      itemLabel: product.name,
    });
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      return {
        kind: "provider_error" as const,
        code: err.code,
        provider: err.provider,
      };
    }
    throw err;
  }
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [link] = await tx
      .insert(paymentLinks)
      .values({
        tenantId: ctx.tenantId,
        productId: product.id,
        contactId: input.contactId ?? null,
        conversationId: input.conversationId ?? null,
        code,
        amountIdr: product.priceIdr,
        status: "pending",
        provider: session.provider,
        providerEnvironment: session.environment,
        providerRef: session.providerRef,
        checkoutUrl: session.checkoutUrl,
        expiresAt: new Date(
          Date.now() + PAYMENT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
        ),
      })
      .returning();
    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "payment_link.created",
      meta: {
        paymentLinkId: link.id,
        code: link.code,
        productId: product.id,
        productName: product.name,
        amountIdr: link.amountIdr,
        contactId: link.contactId,
        conversationId: link.conversationId,
        provider: link.provider,
        environment: link.providerEnvironment,
      },
    });
    return { kind: "ok" as const, link };
  });
}

export interface PaymentLinkWithNames extends PaymentLink {
  productName: string;
  contactName: string | null;
}

/** Label tampil tautan varian order (Fase 13F): "Order <id pendek>". */
export function orderLinkLabel(orderId: string): string {
  return `Order ${orderId.slice(0, 8)}`;
}

/**
 * HOOK PENYELESAIAN ORDER (Fase 13F): status order mengikuti status
 * tautan bayarnya — dipanggil di SEMUA titik tempat status tautan
 * berubah (pembayaran selesai di simulatePayByCode, penegakan expired
 * malas di markExpiredIfDue). Penjaga `status = 'pending'` membuatnya
 * idempoten: peristiwa penyelesaian yang berulang (klik bayar ganda,
 * baca ulang tautan kedaluwarsa) tidak pernah membalik order yang
 * sudah final, dan paid_at hanya tertulis pada transisi pertama.
 */
export async function syncOrderStatusFromLink(
  tx: DbTx,
  link: PaymentLink,
): Promise<void> {
  if (!link.orderId) return;
  const now = new Date();
  if (link.status === "paid") {
    await tx
      .update(orders)
      .set({
        status: "paid",
        paidAt: link.paidAt ?? now,
        updatedAt: now,
      })
      .where(
        and(eq(orders.id, link.orderId), eq(orders.status, "pending")),
      );
  } else if (link.status === "expired" || link.status === "cancelled") {
    await tx
      .update(orders)
      .set({ status: link.status, updatedAt: now })
      .where(
        and(eq(orders.id, link.orderId), eq(orders.status, "pending")),
      );
    // G14: order berakhir TANPA dibayar → penukaran kode diskonnya
    // dilepas; kuota kode kembali bebas (keputusan G14, lihat
    // discount-codes.ts). Idempoten: hanya baris 'redeemed' bertransisi.
    await releaseRedemptionsForOrderTx(tx, link.tenantId, link.orderId);
  }
}

/**
 * Daftar tautan bayar terbaru tenant (dengan nama produk & kontak untuk
 * tampilan dashboard). Baris pending yang sudah lewat expires_at ditandai
 * 'expired' lebih dulu (penegakan lazy, satu update massal murah).
 */
export async function listPaymentLinks(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  opts?: { limit?: number },
): Promise<PaymentLinkWithNames[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    // Fase 13F: order di balik tautan pending yang kedaluwarsa ikut
    // dibalik expired bersama tautannya (hook penyelesaian order).
    const dueOrderIds = await tx
      .select({ orderId: paymentLinks.orderId })
      .from(paymentLinks)
      .where(
        and(
          eq(paymentLinks.tenantId, ctx.tenantId),
          eq(paymentLinks.status, "pending"),
          lt(paymentLinks.expiresAt, new Date()),
          isNotNull(paymentLinks.orderId),
        ),
      );
    await tx
      .update(paymentLinks)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          eq(paymentLinks.tenantId, ctx.tenantId),
          eq(paymentLinks.status, "pending"),
          lt(paymentLinks.expiresAt, new Date()),
        ),
      );
    const expiredOrderIds = dueOrderIds
      .map((r) => r.orderId)
      .filter((id): id is string => id !== null);
    if (expiredOrderIds.length > 0) {
      await tx
        .update(orders)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            inArray(orders.id, expiredOrderIds),
            eq(orders.status, "pending"),
          ),
        );
      // G14: jalur expired massal ini melewati syncOrderStatusFromLink,
      // jadi pelepasan penukaran diskon dilakukan eksplisit di sini.
      await tx
        .update(discountRedemptions)
        .set({ status: "released", releasedAt: new Date() })
        .where(
          and(
            eq(discountRedemptions.tenantId, ctx.tenantId),
            inArray(discountRedemptions.orderId, expiredOrderIds),
            eq(discountRedemptions.status, "redeemed"),
          ),
        );
    }
    const rows = await tx
      .select({
        link: paymentLinks,
        productName: products.name,
        contactName: contacts.name,
      })
      .from(paymentLinks)
      // LEFT join sejak Fase 13F: tautan order tidak punya produk —
      // nama tampilnya adalah label order.
      .leftJoin(products, eq(products.id, paymentLinks.productId))
      .leftJoin(contacts, eq(contacts.id, paymentLinks.contactId))
      .where(eq(paymentLinks.tenantId, ctx.tenantId))
      .orderBy(desc(paymentLinks.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      ...r.link,
      productName:
        r.productName ??
        (r.link.orderId ? orderLinkLabel(r.link.orderId) : ""),
      contactName: r.contactName,
    }));
  });
}

// ---------------------------------------------------------------------------
// Tautan bayar — sisi publik (halaman /pay/:code, TANPA sesi)
// ---------------------------------------------------------------------------

/**
 * Resolusi code → baris payment_links TANPA konteks tenant lebih dulu.
 * Satu-satunya query publik pembayaran: transaksi men-set
 * `app.payment_code` dan policy `public_code_lookup` (0012) hanya membuka
 * baris yang code-nya sama persis. Null bila code tidak dikenal.
 */
export async function resolvePaymentLinkByCode(
  db: Database,
  code: string,
): Promise<PaymentLink | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.payment_code', ${code}, true)`,
    );
    const [row] = await tx
      .select()
      .from(paymentLinks)
      .where(eq(paymentLinks.code, code))
      .limit(1);
    return row ?? null;
  });
}

export interface PublicPaymentView {
  code: string;
  productName: string;
  description: string | null;
  amountIdr: number;
  status: PaymentLink["status"];
  tenantName: string;
  provider: string;
  providerEnvironment: string;
  /** URL checkout provider; hanya untuk tautan pending ber-provider sungguhan. */
  checkoutUrl: string | null;
  paidAt: Date | null;
  expiresAt: Date;
}

/** Baris tautan ditandai expired bila pending & sudah lewat batasnya. */
async function markExpiredIfDue(tx: DbTx, link: PaymentLink): Promise<PaymentLink> {
  if (link.status !== "pending" || link.expiresAt.getTime() > Date.now()) {
    return link;
  }
  const [updated] = await tx
    .update(paymentLinks)
    .set({ status: "expired", updatedAt: new Date() })
    .where(eq(paymentLinks.id, link.id))
    .returning();
  const expired = updated ?? link;
  // Fase 13F: order di balik tautan ikut expired (hook penyelesaian).
  await syncOrderStatusFromLink(tx, expired);
  return expired;
}

/**
 * Isi tampilan publik dari satu baris tautan (konteks tenant pemilik).
 * Varian produk: nama + deskripsi produk. Varian order (Fase 13F):
 * label order + ringkasan item snapshot sebagai deskripsi — pembeli
 * melihat persis apa yang ia bayar, tanpa data pribadi kontak.
 */
async function buildPublicView(
  tx: DbTx,
  tenantId: string,
  link: PaymentLink,
): Promise<PublicPaymentView> {
  let productName = "";
  let description: string | null = null;
  if (link.productId) {
    const product = await getProductRow(tx, tenantId, link.productId);
    productName = product?.name ?? "";
    description = product?.description ?? null;
  } else if (link.orderId) {
    productName = orderLinkLabel(link.orderId);
    const items = await tx
      .select()
      .from(orderItems)
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orderItems.orderId, link.orderId),
        ),
      )
      .orderBy(asc(orderItems.createdAt));
    description =
      items.map((i) => `${i.qty} × ${i.productName}`).join(", ") || null;
  }
  const [tenant] = await tx
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return {
    code: link.code,
    productName,
    description,
    amountIdr: link.amountIdr,
    status: link.status,
    tenantName: tenant?.name ?? "",
    provider: link.provider,
    providerEnvironment: link.providerEnvironment,
    checkoutUrl: link.status === "pending" ? link.checkoutUrl : null,
    paidAt: link.paidAt,
    expiresAt: link.expiresAt,
  };
}

/** Isi halaman /pay/:code. Null bila code tidak dikenal (API → 404). */
export async function getPublicPaymentByCode(
  db: Database,
  code: string,
): Promise<PublicPaymentView | null> {
  const resolved = await resolvePaymentLinkByCode(db, code);
  if (!resolved) return null;
  return withTenantDb(db, resolved.tenantId, async (tx) => {
    const link = await markExpiredIfDue(tx, resolved);
    return buildPublicView(tx, resolved.tenantId, link);
  });
}

export type SimulatePayResult =
  | { kind: "paid"; view: PublicPaymentView }
  | { kind: "not_payable"; view: PublicPaymentView }
  | { kind: "not_simulation"; view: PublicPaymentView };

/**
 * SIMULASI pembayaran (BUKAN uang sungguhan — provider 'simulation'):
 * menandai tautan pending sebagai paid + paid_at dan menulis audit
 * `payment.paid` di tenant pemilik (actor system `pay-page-simulation`).
 * Idempoten: tautan yang sudah paid dikembalikan apa adanya ('paid',
 * tanpa audit ganda). Tautan expired/cancelled → 'not_payable'.
 */
export async function simulatePayByCode(
  db: Database,
  code: string,
): Promise<SimulatePayResult | null> {
  const resolved = await resolvePaymentLinkByCode(db, code);
  if (!resolved) return null;
  return withTenantDb(db, resolved.tenantId, async (tx) => {
    let link = await markExpiredIfDue(tx, resolved);
    // Fase 14A: endpoint simulasi HANYA untuk tautan provider
    // 'simulation'. Tautan Midtrans/Xendit diselesaikan lewat webhook
    // provider — mensimulasikannya di sini akan memalsukan pembayaran
    // sungguhan.
    if (link.provider !== PAYMENT_PROVIDER_SIMULATION) {
      const view = await buildPublicView(tx, resolved.tenantId, link);
      return { kind: "not_simulation", view } as const;
    }
    if (link.status === "pending") {
      const [updated] = await tx
        .update(paymentLinks)
        .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
        .where(eq(paymentLinks.id, link.id))
        .returning();
      link = updated ?? link;
      // Fase 13F: order di balik tautan (bila ada) ikut menjadi paid
      // + paid_at — tepat satu kali berkat penjaga status pending di
      // hook, walau penyelesaian ini dipanggil berulang.
      await syncOrderStatusFromLink(tx, link);
      await tx.insert(auditLogs).values({
        tenantId: resolved.tenantId,
        actorType: "system",
        actorId: "pay-page-simulation",
        action: "payment.paid",
        meta: {
          paymentLinkId: link.id,
          code: link.code,
          productId: link.productId,
          orderId: link.orderId,
          amountIdr: link.amountIdr,
          provider: link.provider,
          simulation: true,
        },
      });
    }
    const view = await buildPublicView(tx, resolved.tenantId, link);
    return link.status === "paid"
      ? ({ kind: "paid", view } as const)
      : ({ kind: "not_payable", view } as const);
  });
}

// ---------------------------------------------------------------------------
// Pencocokan produk untuk tool agent `send_payment_link`
// ---------------------------------------------------------------------------

export interface ProductMatch {
  product: Product;
  /** true bila nama produk benar-benar cocok dengan teks permintaan. */
  matchedByName: boolean;
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Memilih produk aktif untuk tool agent. Skor kecocokan nama (semua
 * case-insensitive): nama produk muncul utuh di teks permintaan (paling
 * kuat) > teks permintaan muncul di nama produk > jumlah token bersama.
 * Bila tidak ada yang cocok (atau teks kosong) → produk aktif TERTUA
 * sebagai fallback dengan matchedByName=false agar pemanggil mencatatnya
 * di audit. Null bila tenant tidak punya produk aktif sama sekali.
 */
export async function matchActiveProductForPayment(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  query?: string,
): Promise<ProductMatch | null> {
  const candidates = await withTenantDb(db, ctx.tenantId, async (tx) => {
    return tx
      .select()
      .from(products)
      .where(
        and(eq(products.tenantId, ctx.tenantId), eq(products.isActive, true)),
      )
      .orderBy(asc(products.createdAt));
  });
  if (candidates.length === 0) return null;
  const q = normalizeText(query ?? "");
  if (!q) return { product: candidates[0], matchedByName: false };

  const qTokens = new Set(q.split(" ").filter((t) => t.length >= 3));
  let best: { product: Product; score: number } | null = null;
  for (const product of candidates) {
    const name = normalizeText(product.name);
    let score = 0;
    if (q.includes(name)) score = 1000 + name.length;
    else if (name.includes(q)) score = 800 + q.length;
    else {
      const nameTokens = name.split(" ").filter((t) => t.length >= 3);
      const overlap = nameTokens.filter((t) => qTokens.has(t)).length;
      score = overlap * 10;
    }
    if (!best || score > best.score) best = { product, score };
  }
  if (best && best.score > 0) {
    return { product: best.product, matchedByName: true };
  }
  return { product: candidates[0], matchedByName: false };
}
