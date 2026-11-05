import { Hono } from "hono";
import { z } from "zod";
import {
  CreatePaymentLinkRequestSchema,
  CreateProductRequestSchema,
  OrderListResponseSchema,
  OrderResponseSchema,
  PaymentLinkListResponseSchema,
  PaymentLinkResponseSchema,
  ProductListResponseSchema,
  ProductResponseSchema,
  UpdateProductRequestSchema,
  type OrderResponse,
  type PaymentLinkResponse,
  type ProductResponse,
} from "@sahabat-kreator/contracts";
import {
  buildPaymentUrl,
  createPaymentLink,
  createProduct,
  deleteProduct,
  getContact,
  getOrder,
  getProduct,
  listOrders,
  listPaymentLinks,
  listProducts,
  updateProduct,
  type OrderWithDetails,
  type PaymentLinkWithNames,
  type PaymentDeps,
} from "@sahabat-kreator/core";
import type { Product } from "@sahabat-kreator/db";
import type { AuthBundle } from "../../auth";
import { apiError, type AppContext, type AppVariables } from "../../http";
import { resolveTenantForUser } from "../tenants/guard";

export interface ProductsModuleOptions {
  /** Base URL publik aplikasi (env BETTER_AUTH_URL) untuk merangkai url tautan bayar. */
  publicBaseUrl?: string;
  /** Dependensi gerbang pembayaran (Fase 14A) untuk pembuatan tautan provider sungguhan. */
  payments?: PaymentDeps;
}

export function serializeProduct(row: Product): ProductResponse {
  return ProductResponseSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    priceIdr: row.priceIdr,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Serializer order (Fase 13F) — dipakai rute dashboard di modul ini
 * DAN rute publik /v1/orders (baseUrl kosong → url relatif /pay/…).
 * Baris item membawa snapshot nama+harga checkout; lineTotalIdr
 * dihitung dari snapshot yang sama.
 */
export function serializeOrder(
  detailed: OrderWithDetails,
  baseUrl?: string,
): OrderResponse {
  const { order, items, contactName, paymentLink } = detailed;
  return OrderResponseSchema.parse({
    id: order.id,
    contactId: order.contactId,
    contactName,
    conversationId: order.conversationId,
    status: order.status,
    items: items.map((i) => ({
      productId: i.productId,
      productName: i.productName,
      qty: i.qty,
      unitPriceIdr: i.unitPriceIdr,
      lineTotalIdr: i.qty * i.unitPriceIdr,
    })),
    totalIdr: order.totalIdr,
    paymentLinkId: paymentLink?.id ?? null,
    paymentCode: paymentLink?.code ?? null,
    paymentUrl: paymentLink
      ? buildPaymentUrl(baseUrl, paymentLink.code)
      : null,
    paymentStatus: paymentLink?.status ?? null,
    // Provider hidup di tautan bayar (sumber kebenaran tunggal
    // pembayaran); order mewarisinya dari tautannya. 'simulation'
    // hanya untuk order warisan tanpa tautan (tidak lahir dari
    // checkout 13F).
    provider: paymentLink?.provider ?? "simulation",
    paidAt: order.paidAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  });
}

/**
 * Modul products (Fase 4A) — katalog produk + tautan bayar per workspace:
 *   POST   /tenants/:tenantId/products          buat produk → 201
 *   GET    /tenants/:tenantId/products          daftar produk
 *   PATCH  /tenants/:tenantId/products/:id      ubah produk
 *   DELETE /tenants/:tenantId/products/:id      hapus → 204; 409
 *          PRODUCT_HAS_LINKS bila produk sudah punya tautan bayar
 *   POST   /tenants/:tenantId/payment-links     buat tautan bayar → 201
 *   GET    /tenants/:tenantId/payment-links     daftar tautan terbaru
 *   GET    /tenants/:tenantId/orders            daftar order (Fase 13F)
 *   GET    /tenants/:tenantId/orders/:id        detail order (Fase 13F)
 * Wajib sesi + membership workspace (non-member → 404 TENANT_NOT_FOUND).
 * Tautan bayar fase ini ber-provider 'simulation' — halaman publiknya di
 * modul `pay`. Logika domain di @sahabat-kreator/core (products.ts).
 */
export function createProductsRoutes(
  bundle: AuthBundle | null,
  opts: ProductsModuleOptions,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const productsBase = "/tenants/:tenantId/products";
  const linksBase = "/tenants/:tenantId/payment-links";
  const ordersBase = "/tenants/:tenantId/orders";

  if (!bundle) {
    const notConfigured = (c: Parameters<typeof apiError>[0]) =>
      apiError(c, 503, "INTERNAL_ERROR", "Database is not configured");
    app.post(productsBase, notConfigured);
    app.get(productsBase, notConfigured);
    app.patch(`${productsBase}/:id`, notConfigured);
    app.delete(`${productsBase}/:id`, notConfigured);
    app.post(linksBase, notConfigured);
    app.get(linksBase, notConfigured);
    app.get(ordersBase, notConfigured);
    app.get(`${ordersBase}/:id`, notConfigured);
    return app;
  }

  const serializeLink = (row: PaymentLinkWithNames): PaymentLinkResponse =>
    PaymentLinkResponseSchema.parse({
      id: row.id,
      productId: row.productId,
      // Fase 13F: tautan order (varian checkout keranjang) — null
      // untuk tautan produk tunggal; tautan milik order punya
      // productId null dan orderId terisi (CHECK tepat satu target).
      orderId: row.orderId,
      productName: row.productName,
      contactId: row.contactId,
      contactName: row.contactName,
      conversationId: row.conversationId,
      code: row.code,
      url: buildPaymentUrl(opts.publicBaseUrl, row.code),
      amountIdr: row.amountIdr,
      status: row.status,
      provider: row.provider,
      providerEnvironment: row.providerEnvironment,
      paidAt: row.paidAt?.toISOString() ?? null,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });


  const resolveTenant = async (c: AppContext) =>
    resolveTenantForUser(
      bundle,
      c.req.param("tenantId") ?? "",
      c.get("appUser").id,
    );

  const parseJson = async (c: AppContext): Promise<unknown | null> => {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  };

  // ------------------------------------------------------------- products
  app.post(productsBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const json = await parseJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreateProductRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid product payload");
    }
    const created = await createProduct(
      bundle.db,
      { tenantId: tenant.id },
      parsed.data,
    );
    return c.json(serializeProduct(created), 201);
  });

  app.get(productsBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listProducts(bundle.db, { tenantId: tenant.id });
    return c.json(
      ProductListResponseSchema.parse({ products: rows.map(serializeProduct) }),
    );
  });

  app.patch(`${productsBase}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Product not found");
    }
    const json = await parseJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = UpdateProductRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid product payload");
    }
    const updated = await updateProduct(
      bundle.db,
      { tenantId: tenant.id },
      id,
      parsed.data,
    );
    if (!updated) return apiError(c, 404, "NOT_FOUND", "Product not found");
    return c.json(serializeProduct(updated));
  });

  app.delete(`${productsBase}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Product not found");
    }
    const result = await deleteProduct(bundle.db, { tenantId: tenant.id }, id);
    if (result === "not_found") {
      return apiError(c, 404, "NOT_FOUND", "Product not found");
    }
    if (result === "has_links") {
      return apiError(
        c,
        409,
        "PRODUCT_HAS_LINKS",
        "Product already has payment links; deactivate it instead of deleting",
      );
    }
    return c.body(null, 204);
  });

  // --------------------------------------------------------- payment-links
  app.post(linksBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const json = await parseJson(c);
    if (json === null) {
      return apiError(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON");
    }
    const parsed = CreatePaymentLinkRequestSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(c, 400, "VALIDATION_ERROR", "Invalid payment link payload");
    }
    const result = await createPaymentLink(
      bundle.db,
      { tenantId: tenant.id },
      parsed.data,
      { actorType: "user", actorId: c.get("appUser").id },
      {
        ...opts.payments,
        publicBaseUrl: opts.payments?.publicBaseUrl ?? opts.publicBaseUrl,
      },
    );
    if (result.kind === "product_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Product not found");
    }
    if (result.kind === "contact_not_found") {
      return apiError(c, 404, "NOT_FOUND", "Contact not found");
    }
    if (result.kind === "provider_error") {
      // Fase 14A: provider sungguhan menolak/gagal dihubungi saat
      // pembuatan — tautan TIDAK dibuat dan kode provider diteruskan
      // apa adanya (tidak ada fallback diam-diam ke simulasi).
      const providerCodes = [
        "PAYMENT_NOT_CONFIGURED",
        "MIDTRANS_AUTH_FAILED",
        "MIDTRANS_CREATE_FAILED",
        "MIDTRANS_UNREACHABLE",
        "XENDIT_AUTH_FAILED",
        "XENDIT_CREATE_FAILED",
        "XENDIT_UNREACHABLE",
      ] as const;
      const code = (providerCodes as readonly string[]).includes(result.code)
        ? (result.code as (typeof providerCodes)[number])
        : "INTERNAL_ERROR";
      return apiError(
        c,
        502,
        code,
        `Payment provider failed while creating the link (${result.provider}: ${result.code})`,
      );
    }
    // Rangkai respons dari baris yang baru dibuat + nama produk/kontak.
    // Jalur buat-selalu-produk: productId terisi (varian order hanya
    // lahir dari checkout flow — Fase 13F).
    const product = result.link.productId
      ? await getProduct(bundle.db, { tenantId: tenant.id }, result.link.productId)
      : null;
    const contact = result.link.contactId
      ? await getContact(bundle.db, { tenantId: tenant.id }, result.link.contactId)
      : null;
    return c.json(
      serializeLink({
        ...result.link,
        productName: product?.name ?? "",
        contactName: contact?.name ?? null,
      }),
      201,
    );
  });

  app.get(linksBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listPaymentLinks(bundle.db, { tenantId: tenant.id });
    return c.json(
      PaymentLinkListResponseSchema.parse({
        paymentLinks: rows.map(serializeLink),
      }),
    );
  });

  // ---------------------------------------------------------------- orders
  app.get(ordersBase, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const rows = await listOrders(bundle.db, { tenantId: tenant.id });
    return c.json(
      OrderListResponseSchema.parse({
        orders: rows.map((r) => serializeOrder(r, opts.publicBaseUrl)),
      }),
    );
  });

  app.get(`${ordersBase}/:id`, async (c) => {
    const tenant = await resolveTenant(c);
    if (!tenant) return apiError(c, 404, "TENANT_NOT_FOUND", "Tenant not found");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return apiError(c, 404, "NOT_FOUND", "Order not found");
    }
    const detailed = await getOrder(bundle.db, { tenantId: tenant.id }, id);
    if (!detailed) return apiError(c, 404, "NOT_FOUND", "Order not found");
    return c.json(serializeOrder(detailed, opts.publicBaseUrl));
  });

  return app;
}
