import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  cartItems,
  carts,
  contacts,
  orderItems,
  orders,
  paymentLinks,
  products,
  type Cart,
  type Database,
  type Order,
  type OrderItem,
  type PaymentLink,
  type Product,
} from "@sahabat-kreator/db";
import { CATALOG_REPLY_HINT } from "@sahabat-kreator/contracts";
import type { TenantContext } from "./tenant";
import { withTenantDb, type DbTx } from "./tx";
import {
  generatePaymentCode,
  PAYMENT_LINK_TTL_DAYS,
  PAYMENT_PROVIDER_SIMULATION,
  type PaymentActor,
} from "./products";
import {
  createProviderCheckoutSession,
  PaymentProviderError,
  type PaymentDeps,
  type ProviderCheckoutSession,
} from "./payments";
import {
  claimDiscountTx,
  DiscountClaimLostError,
} from "./discount-codes";
import type { DiscountRejectReason } from "@sahabat-kreator/contracts";

/**
 * Service domain Keranjang & Order (Fase 13F, katalog + keranjang
 * commerce). Transport-agnostic; semua query tenant dalam konteks RLS.
 *
 * Keputusan yang dijaga di sini:
 * - Keranjang adalah keadaan sesi per (tenant, kontak): tepat SATU
 *   keranjang `open` (partial unique index di DB). Item adalah BARIS
 *   cart_items (bukan jsonb) agar bisa dirujuk per produk dan dilipat
 *   merge kontak 9B.
 * - ATURAN SNAPSHOT HARGA: baris item menyimpan harga produk saat item
 *   PERTAMA ditambahkan. Menambah produk yang sama lagi hanya menaikkan
 *   qty — snapshot pertama menang, perubahan harga produk di tengah
 *   jalan TIDAK menulis ulang keranjang maupun checkout (checkout
 *   memakai snapshot baris, total dihitung server di sini).
 * - Checkout bersifat atomik dalam satu transaksi pemanggil: order +
 *   order_items (snapshot nama/harga) + SATU payment_links varian
 *   order (mesin tautan yang sama dengan produk tunggal; provider
 *   mengikuti konfigurasi tenant — Fase 14A: sesi provider sungguhan
 *   disiapkan di luar transaksi lewat prepareOrderCheckoutLink dan
 *   diteruskan sebagai preparedLink) + keranjang ditandai checked_out. Status order sesudahnya mengikuti tautan
 *   bayarnya lewat hook di products.ts (simulatePayByCode & penegakan
 *   expired malas) — di sini order selalu lahir `pending`.
 * - Keranjang SENGAJA tidak diekspos permukaan publik v1 (keadaan
 *   sesi ephemeral — lihat docs/COVERAGE-MATRIX.md); order BACA saja
 *   yang publik (orders:read).
 */

/** Format Rupiah kanonis sisi server (id-ID, tanpa desimal) — cermin formatIdrId web. */
export function formatIdrId(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

// ---------------------------------------------------------------------------
// Keranjang — tampilan & helper transaksi
// ---------------------------------------------------------------------------

export interface CartLineView {
  id: string;
  productId: string;
  /** Nama produk SAAT INI (tampilan saja — harga snapshot yang otoritatif). */
  productName: string;
  qty: number;
  unitPriceIdr: number;
  lineTotalIdr: number;
}

export interface CartView {
  cartId: string;
  contactId: string;
  items: CartLineView[];
  totalIdr: number;
  /** Jumlah qty semua baris. */
  itemCount: number;
}

/** Produk AKTIF tenant terurut pembuatan (urutan nomor katalog yang stabil). */
export async function listActiveCatalogProductsTx(
  tx: DbTx,
  tenantId: string,
): Promise<Product[]> {
  return tx
    .select()
    .from(products)
    .where(
      and(eq(products.tenantId, tenantId), eq(products.isActive, true)),
    )
    .orderBy(asc(products.createdAt));
}

async function getOpenCartRowTx(
  tx: DbTx,
  tenantId: string,
  contactId: string,
): Promise<Cart | null> {
  const [row] = await tx
    .select()
    .from(carts)
    .where(
      and(
        eq(carts.tenantId, tenantId),
        eq(carts.contactId, contactId),
        eq(carts.status, "open"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Keranjang terbuka kontak, dibuat malas bila belum ada. Partial
 * unique index menjamin satu baris `open` per kontak — balapan insert
 * diselesaikan onConflictDoNothing + baca ulang.
 */
export async function getOrCreateOpenCartTx(
  tx: DbTx,
  tenantId: string,
  contactId: string,
): Promise<Cart> {
  const existing = await getOpenCartRowTx(tx, tenantId, contactId);
  if (existing) return existing;
  const [created] = await tx
    .insert(carts)
    .values({ tenantId, contactId, status: "open" })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const raced = await getOpenCartRowTx(tx, tenantId, contactId);
  if (!raced) throw new Error("keranjang terbuka tidak dapat dibuat");
  return raced;
}

/** Tampilan keranjang terbuka kontak; null bila belum ada keranjang terbuka. */
export async function getCartViewTx(
  tx: DbTx,
  tenantId: string,
  contactId: string,
): Promise<CartView | null> {  const cart = await getOpenCartRowTx(tx, tenantId, contactId);
  if (!cart) return null;
  const rows = await tx
    .select({ item: cartItems, productName: products.name })
    .from(cartItems)
    .innerJoin(products, eq(products.id, cartItems.productId))
    .where(
      and(eq(cartItems.tenantId, tenantId), eq(cartItems.cartId, cart.id)),
    )
    .orderBy(asc(cartItems.createdAt));
  const items: CartLineView[] = rows.map((r) => ({
    id: r.item.id,
    productId: r.item.productId,
    productName: r.productName,
    qty: r.item.qty,
    unitPriceIdr: r.item.unitPriceIdr,
    lineTotalIdr: r.item.qty * r.item.unitPriceIdr,
  }));
  return {
    cartId: cart.id,
    contactId,
    items,
    totalIdr: items.reduce((sum, i) => sum + i.lineTotalIdr, 0),
    itemCount: items.reduce((sum, i) => sum + i.qty, 0),
  };
}

/**
 * Tampilan keranjang dalam transaksi tenant mandiri (Fase 14A) —
 * dipakai node cart_checkout untuk membaca total SEBELUM sesi checkout
 * provider dibuat di luar transaksi langkah.
 */
export async function getCartView(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  contactId: string,
): Promise<CartView | null> {
  return withTenantDb(db, ctx.tenantId, (tx) =>
    getCartViewTx(tx, ctx.tenantId, contactId),
  );
}

/**
 * Sesi tautan order yang disiapkan SEBELUM transaksi checkout (Fase
 * 14A): code + sesi provider dibuat di luar transaksi karena memanggil
 * API provider tidak boleh menahan transaksi DB. `amountIdr` adalah
 * total yang dibaca saat persiapan; checkout MENOLAK (throw
 * PaymentProviderError 'PAYMENT_AMOUNT_CHANGED') bila total di dalam
 * transaksi berbeda — tautan tidak pernah lahir dengan jumlah yang
 * tidak cocok dengan sesi providernya.
 */
export interface PreparedOrderLink {
  code: string;
  amountIdr: number;
  session: ProviderCheckoutSession;
}

/**
 * Menyiapkan tautan order untuk checkout: mengembalikan null bila
 * provider tenant adalah simulasi (checkout berjalan persis seperti
 * Fase 13F). Untuk provider sungguhan, code dibuat di sini dan sesi
 * checkout provider dibuat sekarang; kegagalan provider melempar
 * PaymentProviderError dan checkout TIDAK boleh dilanjutkan.
 */
export async function prepareOrderCheckoutLink(
  db: Database,
  tenantId: string,
  deps: PaymentDeps | undefined,
  input: { amountIdr: number; itemLabel: string },
): Promise<PreparedOrderLink | null> {
  const code = generatePaymentCode();
  const session = await createProviderCheckoutSession(db, tenantId, deps, {
    code,
    amountIdr: input.amountIdr,
    itemLabel: input.itemLabel,
  });
  if (session.provider === PAYMENT_PROVIDER_SIMULATION) return null;
  return { code, amountIdr: input.amountIdr, session };
}

/**
 * Menambahkan qty produk ke keranjang terbuka kontak (dibuat malas).
 * Baris baru mengambil snapshot harga produk SAAT INI; baris yang
 * sudah ada mempertahankan snapshot pertamanya (hanya qty naik).
 * Mengembalikan tampilan keranjang sesudah penambahan.
 */
export async function addToCartTx(
  tx: DbTx,
  tenantId: string,
  contactId: string,
  product: Product,
  qty: number,
): Promise<CartView> {
  const cart = await getOrCreateOpenCartTx(tx, tenantId, contactId);
  const [existing] = await tx
    .select()
    .from(cartItems)
    .where(
      and(
        eq(cartItems.tenantId, tenantId),
        eq(cartItems.cartId, cart.id),
        eq(cartItems.productId, product.id),
      ),
    )
    .limit(1);
  const now = new Date();
  if (existing) {
    await tx
      .update(cartItems)
      .set({ qty: existing.qty + qty, updatedAt: now })
      .where(eq(cartItems.id, existing.id));
  } else {
    await tx.insert(cartItems).values({
      tenantId,
      cartId: cart.id,
      productId: product.id,
      qty,
      unitPriceIdr: product.priceIdr,
    });
  }
  await tx
    .update(carts)
    .set({ updatedAt: now })
    .where(eq(carts.id, cart.id));
  const view = await getCartViewTx(tx, tenantId, contactId);
  if (!view) throw new Error("keranjang hilang sesudah penambahan item");
  return view;
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** Hasil penerapan kode diskon pada sebuah checkout (G14). */
export type CheckoutDiscountOutcome =
  | {
      kind: "applied";
      code: string;
      discountAmountIdr: number;
      subtotalIdr: number;
    }
  | { kind: "invalid"; code: string; reason: DiscountRejectReason }
  | { kind: "none" };

export type CheckoutCartResult =
  | {
      kind: "ok";
      order: Order;
      items: OrderItem[];
      link: PaymentLink;
      view: CartView;
      discount: CheckoutDiscountOutcome;
    }
  | { kind: "empty_cart" };

/**
 * Checkout keranjang terbuka kontak DALAM transaksi pemanggil:
 * keranjang kosong/tidak ada → { kind: "empty_cart" } tanpa menulis
 * apa pun. Selain itu: order `pending` dengan total dari snapshot
 * baris, order_items snapshot (nama + harga dari baris keranjang),
 * SATU tautan bayar varian order, payment_link_id order diisi, dan
 * keranjang ditandai `checked_out`. Audit `order.created` oleh actor
 * pemanggil (flow sistem / agent / user).
 */
export async function checkoutCartTx(
  tx: DbTx,
  tenantId: string,
  input: {
    contactId: string;
    conversationId?: string | null;
    actor: PaymentActor;
    /**
     * Fase 14A: sesi tautan yang disiapkan di luar transaksi
     * (prepareOrderCheckoutLink) untuk provider sungguhan. Tanpa ini
     * tautan lahir sebagai simulasi persis seperti Fase 13F.
     */
    preparedLink?: PreparedOrderLink | null;
    /**
     * G14: teks kode diskon yang diberikan untuk checkout ini (dari
     * config node flow / field kustom kontak). Klaim atomik terjadi
     * di dalam transaksi ini; total order & tautan memakai total
     * SESUDAH diskon hasil klaim.
     */
    discountCode?: string | null;
  },
): Promise<CheckoutCartResult> {
  const view = await getCartViewTx(tx, tenantId, input.contactId);
  if (!view || view.items.length === 0) return { kind: "empty_cart" };
  const now = new Date();
  // Klaim keranjang secara ATOMIK sebelum melahirkan order: hanya
  // transisi open → checked_out yang boleh melanjutkan. Tanpa syarat
  // `status = 'open'` di WHERE, dua checkout yang berjalan hampir
  // bersamaan (kontak menekan "checkout" dua kali, atau node flow
  // cart_checkout dieksekusi ulang) sama-sama melihat keranjang terbuka
  // dan melahirkan DUA order + dua tautan bayar untuk satu keranjang.
  const [claimedCart] = await tx
    .update(carts)
    .set({ status: "checked_out", updatedAt: now })
    .where(and(eq(carts.id, view.cartId), eq(carts.status, "open")))
    .returning({ id: carts.id });
  if (!claimedCart) return { kind: "empty_cart" };
  const [order] = await tx
    .insert(orders)
    .values({
      tenantId,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      status: "pending",
      totalIdr: view.totalIdr,
    })
    .returning();
  // G14: klaim kode diskon ATOMIK di dalam transaksi yang sama
  // (baris kode dikunci FOR UPDATE oleh claimDiscountTx). Hasil
  // klaim — bukan pratinjau — yang menentukan total final.
  let discount: CheckoutDiscountOutcome = { kind: "none" };
  let appliedCodeId: string | null = null;
  let finalTotalIdr = view.totalIdr;
  if (input.discountCode) {
    const claim = await claimDiscountTx(tx, tenantId, {
      code: input.discountCode,
      contactId: input.contactId,
      orderId: order.id,
      subtotalIdr: view.totalIdr,
    });
    if (claim.kind === "ok") {
      discount = {
        kind: "applied",
        code: claim.code.code,
        discountAmountIdr: claim.discountAmountIdr,
        subtotalIdr: view.totalIdr,
      };
      appliedCodeId = claim.code.id;
      finalTotalIdr = view.totalIdr - claim.discountAmountIdr;
    } else if (
      input.preparedLink &&
      input.preparedLink.amountIdr !== view.totalIdr
    ) {
      // Sesi provider disiapkan dengan total SESUDAH diskon
      // (pratinjau lolos) tetapi klaim atomiknya kalah di sini —
      // lanjut tanpa diskon akan melahirkan tautan yang jumlahnya
      // tidak cocok dengan sesinya. Batalkan seluruh checkout.
      throw new DiscountClaimLostError(claim.reason);
    } else {
      // Tanpa sesi provider (simulasi) atau sesi memang disiapkan
      // pada total penuh: checkout lanjut TANPA diskon dan alasannya
      // dilaporkan apa adanya lewat hasil + detail run pemanggil.
      discount = {
        kind: "invalid",
        code: input.discountCode,
        reason: claim.reason,
      };
    }
  }
  if (
    input.preparedLink &&
    input.preparedLink.amountIdr !== finalTotalIdr
  ) {
    // Total berubah sejak sesi provider disiapkan — membatalkan
    // seluruh transaksi checkout lebih jujur daripada melahirkan
    // tautan yang jumlahnya tidak cocok dengan sesi providernya.
    throw new PaymentProviderError(
      "PAYMENT_AMOUNT_CHANGED",
      input.preparedLink.session.provider,
      "Total keranjang berubah sejak sesi checkout provider disiapkan",
    );
  }
  const items = await tx
    .insert(orderItems)
    .values(
      view.items.map((item) => ({
        tenantId,
        orderId: order.id,
        productId: item.productId,
        productName: item.productName,
        qty: item.qty,
        unitPriceIdr: item.unitPriceIdr,
      })),
    )
    .returning();
  const prepared = input.preparedLink ?? null;
  const [link] = await tx
    .insert(paymentLinks)
    .values({
      tenantId,
      productId: null,
      orderId: order.id,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      code: prepared?.code ?? generatePaymentCode(),
      amountIdr: finalTotalIdr,
      status: "pending",
      provider: prepared?.session.provider ?? PAYMENT_PROVIDER_SIMULATION,
      providerEnvironment: prepared?.session.environment ?? "sandbox",
      providerRef: prepared?.session.providerRef ?? null,
      checkoutUrl: prepared?.session.checkoutUrl ?? null,
      expiresAt: new Date(
        Date.now() + PAYMENT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
    })
    .returning();
  const [orderWithLink] = await tx
    .update(orders)
    .set({
      paymentLinkId: link.id,
      totalIdr: finalTotalIdr,
      discountAmountIdr:
        discount.kind === "applied" ? discount.discountAmountIdr : 0,
      discountCode: discount.kind === "applied" ? discount.code : null,
      discountCodeId: appliedCodeId,
      updatedAt: now,
    })
    .where(eq(orders.id, order.id))
    .returning();
  await tx.insert(auditLogs).values({
    tenantId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    action: "order.created",
    meta: {
      orderId: order.id,
      paymentLinkId: link.id,
      code: link.code,
      totalIdr: finalTotalIdr,
      itemCount: view.itemCount,
      contactId: input.contactId,
      conversationId: input.conversationId ?? null,
      provider: link.provider,
      environment: link.providerEnvironment,
      ...(discount.kind === "applied"
        ? {
            discountCode: discount.code,
            discountAmountIdr: discount.discountAmountIdr,
            subtotalIdr: view.totalIdr,
          }
        : {}),
      ...(discount.kind === "invalid"
        ? { discountRejected: discount.reason, discountCode: discount.code }
        : {}),
    },
  });
  return {
    kind: "ok",
    order: orderWithLink ?? order,
    items,
    link,
    view,
    discount,
  };
}

// ---------------------------------------------------------------------------
// Order — bacaan dashboard & API v1
// ---------------------------------------------------------------------------

export interface OrderWithDetails {
  order: Order;
  items: OrderItem[];
  contactName: string | null;
  paymentLink: PaymentLink | null;
}

async function attachOrderDetails(
  tx: DbTx,
  tenantId: string,
  rows: Order[],
  contactNames: Map<string, string | null>,
): Promise<OrderWithDetails[]> {
  if (rows.length === 0) return [];
  const orderIds = rows.map((r) => r.id);
  const itemRows = await tx
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        inArray(orderItems.orderId, orderIds),
      ),
    )
    .orderBy(asc(orderItems.createdAt));
  const linkIds = rows
    .map((r) => r.paymentLinkId)
    .filter((id): id is string => id !== null);
  const linkRows =
    linkIds.length > 0
      ? await tx
          .select()
          .from(paymentLinks)
          .where(
            and(
              eq(paymentLinks.tenantId, tenantId),
              inArray(paymentLinks.id, linkIds),
            ),
          )
      : [];
  const itemsByOrder = new Map<string, OrderItem[]>();
  for (const item of itemRows) {
    const list = itemsByOrder.get(item.orderId) ?? [];
    list.push(item);
    itemsByOrder.set(item.orderId, list);
  }
  const linkById = new Map(linkRows.map((l) => [l.id, l]));
  return rows.map((order) => ({
    order,
    items: itemsByOrder.get(order.id) ?? [],
    contactName: contactNames.get(order.contactId) ?? null,
    paymentLink: order.paymentLinkId
      ? (linkById.get(order.paymentLinkId) ?? null)
      : null,
  }));
}

/** Daftar order terbaru tenant (dengan item, nama kontak, tautan bayar). */
export async function listOrders(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  opts?: { limit?: number; status?: Order["status"] },
): Promise<OrderWithDetails[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ order: orders, contactName: contacts.name })
      .from(orders)
      .leftJoin(contacts, eq(contacts.id, orders.contactId))
      .where(
        and(
          eq(orders.tenantId, ctx.tenantId),
          ...(opts?.status ? [eq(orders.status, opts.status)] : []),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(limit);
    const contactNames = new Map(
      rows.map((r) => [r.order.contactId, r.contactName] as const),
    );
    return attachOrderDetails(
      tx,
      ctx.tenantId,
      rows.map((r) => r.order),
      contactNames,
    );
  });
}

/** Satu order tenant dengan rincian; null bila tidak ada DI tenant ini. */
export async function getOrder(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  orderId: string,
): Promise<OrderWithDetails | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ order: orders, contactName: contacts.name })
      .from(orders)
      .leftJoin(contacts, eq(contacts.id, orders.contactId))
      .where(
        and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, orderId)),
      )
      .limit(1);
    if (!row) return null;
    const [detailed] = await attachOrderDetails(
      tx,
      ctx.tenantId,
      [row.order],
      new Map([[row.order.contactId, row.contactName]]),
    );
    return detailed ?? null;
  });
}

// ---------------------------------------------------------------------------
// Render teks katalog & keranjang (node flow show_catalog / cart_checkout)
// ---------------------------------------------------------------------------

/**
 * Daftar katalog bernomor untuk node show_catalog: intro (sudah
 * dirender pemanggil) + satu baris per produk (nama — harga Rupiah;
 * deskripsi pada baris lanjutan bila diminta) + petunjuk balasan
 * kanonis dwibahasa dari kontrak. Penomoran mengikuti urutan daftar
 * yang diberikan pemanggil (produk aktif, terurut pembuatan).
 */
export function renderCatalogText(
  list: Product[],
  opts?: { introText?: string | null; showDescription?: boolean },
): string {
  const parts: string[] = [];
  if (opts?.introText) parts.push(opts.introText);
  const lines = list.map((product, i) => {
    const base = `${i + 1}. ${product.name} — ${formatIdrId(product.priceIdr)}`;
    return opts?.showDescription && product.description
      ? `${base}\n   ${product.description}`
      : base;
  });
  parts.push(lines.join("\n"));
  parts.push(CATALOG_REPLY_HINT);
  return parts.join("\n");
}

/**
 * Ringkasan keranjang: baris item bernomor + total (dari snapshot).
 * Dengan diskon terapan (G14), rincian subtotal + potongan kode
 * ditampilkan eksplisit agar pelanggan melihat total final yang
 * sama dengan jumlah tautan bayarnya.
 */
export function renderCartSummaryText(
  view: CartView,
  discount?: { code: string; discountAmountIdr: number } | null,
): string {
  const lines = view.items.map(
    (item, i) =>
      `${i + 1}. ${item.productName} x${item.qty} — ${formatIdrId(item.lineTotalIdr)}`,
  );
  if (discount && discount.discountAmountIdr > 0) {
    return [
      "Keranjang kamu:",
      ...lines,
      `Subtotal: ${formatIdrId(view.totalIdr)}`,
      `Diskon (${discount.code}): -${formatIdrId(discount.discountAmountIdr)}`,
      `Total: ${formatIdrId(view.totalIdr - discount.discountAmountIdr)}`,
    ].join("\n");
  }
  return [
    "Keranjang kamu:",
    ...lines,
    `Total: ${formatIdrId(view.totalIdr)}`,
  ].join("\n");
}

/**
 * Sintaks balasan node show_catalog: "N" (nomor produk, qty 1) atau
 * "NxM" (nomor N sebanyak M; 'x' huruf besar/kecil, spasi toleran).
 * qty sah 1..999; nomor di luar 1..productCount tidak sah.
 * Mengembalikan indeks 0-based + qty, atau null bila tidak sah.
 */
export function parseCatalogSelection(
  text: string,
  productCount: number,
): { index: number; qty: number } | null {
  const match = /^\s*(\d+)\s*(?:[xX]\s*(\d+))?\s*$/.exec(text);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  const qty = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
  if (!Number.isInteger(num) || num < 1 || num > productCount) return null;
  if (!Number.isInteger(qty) || qty < 1 || qty > 999) return null;
  return { index: num - 1, qty };
}

// ---------------------------------------------------------------------------
// Konteks katalog untuk agent AI
// ---------------------------------------------------------------------------

/** Batas produk aktif yang disuntikkan ke konteks agent per balasan. */
export const AGENT_CATALOG_CONTEXT_LIMIT = 20;

/**
 * Blok konteks katalog untuk agent: daftar produk AKTIF (nama + harga
 * terformat) yang disisipkan ke prompt sistem jalur draft agent —
 * inilah "akses baca katalog" agent di fase ini. Runtime agent
 * berjalan SATU completion tanpa putaran hasil-tool (tool dieksekusi
 * sesudah teks dibuat), jadi tool baca `list_products` tidak akan
 * pernah dilihat model pada balasan yang sama — konteks prompt adalah
 * satu-satunya jalur baca yang nyata, dan dipilih dengan sadar.
 * Keranjang TIDAK disuntikkan: ia berubah di tengah percakapan dan
 * dikelola node flow katalog; agent menutup penjualan satu produk
 * lewat tool send_payment_link yang sudah ada. Null bila tenant tidak
 * punya produk aktif. Kegagalan baca tidak boleh menggagalkan balasan
 * — pemanggil membungkusnya dengan catch.
 */
export async function buildAgentCatalogContext(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
): Promise<string | null> {
  const rows = await withTenantDb(db, ctx.tenantId, async (tx) =>
    listActiveCatalogProductsTx(tx, ctx.tenantId),
  );
  if (rows.length === 0) return null;
  const shown = rows.slice(0, AGENT_CATALOG_CONTEXT_LIMIT);
  const lines = shown.map(
    (p) => `- ${p.name} — ${formatIdrId(p.priceIdr)}`,
  );
  return [
    "Katalog produk aktif workspace ini (fakta harga — jangan menyebut harga produk di luar daftar ini):",
    ...lines,
    ...(rows.length > shown.length
      ? [`…dan ${rows.length - shown.length} produk aktif lain.`]
      : []),
    "Bila kontak ingin membeli SATU produk, gunakan tool send_payment_link. Keranjang multi-item dikelola alur katalog pada flow — arahkan kontak mengikuti petunjuk katalog bila ia ingin membeli beberapa item sekaligus; jangan mengarang isi keranjang kontak.",
  ].join("\n");
}
