import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  DiscountCodeResponse,
  OrderResponse,
  PaymentLinkResponse,
  ProductResponse,
} from "@sahabat-kreator/contracts";
import type { Locale, TranslationKey } from "@sahabat-kreator/i18n";
import { api } from "../api/client";
import { translateApiError } from "../api/errorText";
import { FieldError, inputClassName } from "../components/AuthLayout";
import { formatDateTime, formatIdr } from "../utils/format";
import { useWorkspace } from "../workspace/WorkspaceProvider";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface ProductsPageProps {
  t: Translate;
  locale: Locale;
}

/**
 * Halaman Products (Fase 4A): katalog produk workspace aktif + tautan
 * bayar — daftar produk (nama, harga IDR, chip aktif), buat/edit, hapus
 * (server menolak 409 bila produk sudah punya tautan), tombol buat tautan
 * bayar per produk (URL hasil + salin), dan daftar tautan bayar terbaru
 * dengan status diterjemahkan. Pembayaran fase ini SIMULASI — catatan
 * jujurnya tampil permanen di halaman (products.simulationNote).
 * Fase 13F menambahkan seksi Order (checkout keranjang dari flow chat):
 * daftar + modal detail (pembeli, item snapshot, total, status,
 * referensi tautan bayar, waktu lunas).
 */
export function ProductsPage({ t, locale }: ProductsPageProps) {
  const { status, tenants, active, reload } = useWorkspace();
  const tenantId = active?.id ?? null;

  const [products, setProducts] = useState<ProductResponse[]>([]);
  const [links, setLinks] = useState<PaymentLinkResponse[]>([]);
  const [orders, setOrders] = useState<OrderResponse[]>([]);
  const [discountCodes, setDiscountCodes] = useState<DiscountCodeResponse[]>(
    [],
  );
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [discountFormOpen, setDiscountFormOpen] = useState(false);
  const [discountEditTarget, setDiscountEditTarget] =
    useState<DiscountCodeResponse | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderDetail, setOrderDetail] = useState<OrderResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProductResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProductResponse | null>(
    null,
  );
  const [createdLink, setCreatedLink] = useState<PaymentLinkResponse | null>(
    null,
  );
  const [creatingLinkFor, setCreatingLinkFor] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!tenantId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    setLinksError(null);
    setOrdersError(null);
    try {
      const [productList, linkList, orderList, codeList] = await Promise.all([
        api.products.list(tenantId),
        api.paymentLinks.list(tenantId).catch((err: unknown) => {
          if (requestSeq.current === seq) {
            setLinksError(translateApiError(t, err));
          }
          return [] as PaymentLinkResponse[];
        }),
        api.orders.list(tenantId).catch((err: unknown) => {
          if (requestSeq.current === seq) {
            setOrdersError(translateApiError(t, err));
          }
          return [] as OrderResponse[];
        }),
        api.discountCodes.list(tenantId).catch((err: unknown) => {
          if (requestSeq.current === seq) {
            setDiscountError(translateApiError(t, err));
          }
          return [] as DiscountCodeResponse[];
        }),
      ]);
      if (requestSeq.current !== seq) return;
      setProducts(productList);
      setLinks(linkList);
      setOrders(orderList);
      setDiscountCodes(codeList);
    } catch (err) {
      if (requestSeq.current !== seq) return;
      setError(translateApiError(t, err));
      setProducts([]);
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreateLink = async (product: ProductResponse) => {
    if (!tenantId) return;
    setCreatingLinkFor(product.id);
    setError(null);
    try {
      const link = await api.paymentLinks.create(tenantId, {
        productId: product.id,
      });
      setCreatedLink(link);
      setLinks((prev) => [link, ...prev]);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setCreatingLinkFor(null);
    }
  };

  if (status === "loading") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("products.title")}</h1>
        <p className="mt-6 text-sm text-muted">{t("workspace.loading")}</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("products.title")}</h1>
        <div className="mt-6 rounded-xl border border-line bg-surface p-6">
          <p className="text-sm text-danger">{t("workspace.loadError")}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-3 rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.retry")}
          </button>
        </div>
      </section>
    );
  }
  if (tenants.length === 0 || !active) {
    return (
      <section>
        <h1 className="text-2xl font-bold text-ink">{t("products.title")}</h1>
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-6">
          <h2 className="text-lg font-semibold text-ink">{t("workspace.emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted">{t("workspace.emptyBody")}</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t("products.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("products.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
        >
          {t("products.addButton")}
        </button>
      </div>

      <div className="mt-4 rounded-xl border border-line bg-elevated p-4">
        <p className="text-xs leading-relaxed text-muted">
          {t("products.simulationNote")}
        </p>
      </div>

      <FieldError message={error} />

      {loading ? (
        <p className="mt-6 text-sm text-muted">{t("common.loading")}</p>
      ) : products.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface p-8 text-center">
          <h2 className="text-base font-semibold text-ink">
            {t("products.emptyTitle")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            {t("products.emptyBody")}
          </p>
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {t("products.addButton")}
          </button>
        </div>
      ) : (
        <ul className="mt-5 space-y-3">
          {products.map((product) => (
            <li
              key={product.id}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {product.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {t("products.createdLabel", {
                      date: formatDateTime(product.createdAt, locale),
                    })}
                  </span>
                </div>
                <span className="text-sm font-bold text-ink">
                  {formatIdr(product.priceIdr, locale)}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    product.isActive
                      ? "bg-accent text-white"
                      : "bg-elevated text-muted"
                  }`}
                >
                  {product.isActive
                    ? t("products.activeChip")
                    : t("products.inactiveChip")}
                </span>
              </div>
              {product.description ? (
                <p className="mt-2 line-clamp-2 text-sm text-muted">
                  {product.description}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={creatingLinkFor === product.id}
                  onClick={() => void handleCreateLink(product)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {creatingLinkFor === product.id
                    ? t("products.linkCreating")
                    : t("products.createLinkButton")}
                </button>
                <button
                  type="button"
                  onClick={() => setEditTarget(product)}
                  className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                >
                  {t("common.edit")}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(product)}
                  className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-danger"
                >
                  {t("common.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-ink">
          {t("products.discountTitle")}
        </h2>
        <button
          type="button"
          onClick={() => {
            setDiscountEditTarget(null);
            setDiscountFormOpen(true);
          }}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white"
        >
          {t("products.discountAddButton")}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">{t("products.discountHint")}</p>
      <FieldError message={discountError} />
      {discountCodes.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          {t("products.discountEmpty")}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {discountCodes.map((dc) => (
            <li
              key={dc.id}
              className="rounded-xl border border-line bg-surface p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-ink">
                  {dc.code}
                </span>
                <span className="text-sm font-semibold text-ink">
                  {dc.kind === "percent"
                    ? `${dc.value}%`
                    : formatIdr(dc.value, locale)}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    dc.isActive
                      ? "bg-accent text-white"
                      : "bg-elevated text-muted"
                  }`}
                >
                  {dc.isActive
                    ? t("products.activeChip")
                    : t("products.inactiveChip")}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {t("products.discountUsedLabel", {
                  used: dc.redemptionCount,
                  limit: dc.maxRedemptions != null ? `/${dc.maxRedemptions}` : "",
                })}
                {" · "}
                {t("products.discountGivenLabel", {
                  amount: formatIdr(dc.totalDiscountIdr, locale),
                })}
                {dc.releasedCount > 0
                  ? ` · ${t("products.discountReleasedLabel", {
                      count: dc.releasedCount,
                    })}`
                  : ""}
                {dc.startsAt
                  ? ` · ${formatDateTime(dc.startsAt, locale)}`
                  : ""}
                {dc.endsAt ? ` → ${formatDateTime(dc.endsAt, locale)}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (!tenantId) return;
                    try {
                      const updated = await api.discountCodes.update(
                        tenantId,
                        dc.id,
                        { isActive: !dc.isActive },
                      );
                      setDiscountCodes((prev) =>
                        prev.map((p) => (p.id === updated.id ? updated : p)),
                      );
                    } catch (err) {
                      setDiscountError(translateApiError(t, err));
                    }
                  }}
                  className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                >
                  {dc.isActive
                    ? t("products.inactiveChip")
                    : t("products.activeChip")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDiscountEditTarget(dc);
                    setDiscountFormOpen(true);
                  }}
                  className="rounded-lg bg-elevated px-3 py-1.5 text-xs font-medium text-ink"
                >
                  {t("common.edit")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-lg font-bold text-ink">
        {t("products.linksTitle")}
      </h2>
      <FieldError message={linksError} />
      {links.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("products.linksEmpty")}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {links.map((link) => (
            <li
              key={link.id}
              className="rounded-xl border border-line bg-surface p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                  {link.productName}
                </span>
                <span className="text-sm font-semibold text-ink">
                  {formatIdr(link.amountIdr, locale)}
                </span>
                <PaymentStatusChip t={t} status={link.status} />
              </div>
              <p className="mt-1 text-xs text-muted">
                {link.contactName
                  ? t("products.linkForLabel", { name: link.contactName })
                  : t("products.linkGenericBuyer")}
                {" · "}
                {formatDateTime(link.createdAt, locale)}
              </p>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block truncate font-mono text-xs text-accent underline"
              >
                {link.url}
              </a>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-lg font-bold text-ink">
        {t("products.ordersTitle")}
      </h2>
      <FieldError message={ordersError} />
      {orders.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("products.ordersEmpty")}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {orders.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                onClick={() => setOrderDetail(order)}
                className="w-full rounded-xl border border-line bg-surface p-3 text-left"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    {`Order ${order.id.slice(0, 8)}`}
                  </span>
                  <span className="text-sm font-semibold text-ink">
                    {formatIdr(order.totalIdr, locale)}
                  </span>
                  <PaymentStatusChip t={t} status={order.status} />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {order.contactName
                    ? t("products.linkForLabel", { name: order.contactName })
                    : t("products.linkGenericBuyer")}
                  {" · "}
                  {order.items.length} {t("products.orderItemsLabel")}
                  {" · "}
                  {formatDateTime(order.createdAt, locale)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}

      {orderDetail ? (
        <OrderDetailModal
          t={t}
          locale={locale}
          order={orderDetail}
          onClose={() => setOrderDetail(null)}
        />
      ) : null}

      {discountFormOpen ? (
        <DiscountCodeFormModal
          t={t}
          tenantId={active.id}
          discountCode={discountEditTarget}
          onClose={() => {
            setDiscountFormOpen(false);
            setDiscountEditTarget(null);
          }}
          onSaved={(saved) => {
            setDiscountFormOpen(false);
            setDiscountEditTarget(null);
            setDiscountCodes((prev) => {
              const exists = prev.some((p) => p.id === saved.id);
              return exists
                ? prev.map((p) => (p.id === saved.id ? saved : p))
                : [saved, ...prev];
            });
          }}
        />
      ) : null}

      {formOpen ? (
        <ProductFormModal
          t={t}
          tenantId={active.id}
          product={null}
          onClose={() => setFormOpen(false)}
          onSaved={(saved) => {
            setFormOpen(false);
            setProducts((prev) => [saved, ...prev]);
          }}
        />
      ) : null}

      {editTarget ? (
        <ProductFormModal
          t={t}
          tenantId={active.id}
          product={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={(saved) => {
            setEditTarget(null);
            setProducts((prev) =>
              prev.map((p) => (p.id === saved.id ? saved : p)),
            );
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ProductDeleteModal
          t={t}
          tenantId={active.id}
          product={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(id) => {
            setDeleteTarget(null);
            setProducts((prev) => prev.filter((p) => p.id !== id));
          }}
        />
      ) : null}

      {createdLink ? (
        <CreatedLinkModal
          t={t}
          link={createdLink}
          onClose={() => setCreatedLink(null)}
        />
      ) : null}
    </section>
  );
}

function PaymentStatusChip({
  t,
  status,
}: {
  t: Translate;
  status: PaymentLinkResponse["status"];
}) {
  const label =
    status === "paid"
      ? t("products.statusPaid")
      : status === "expired"
        ? t("products.statusExpired")
        : status === "cancelled"
          ? t("products.statusCancelled")
          : t("products.statusPending");
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        status === "paid"
          ? "bg-accent text-white"
          : "bg-elevated text-muted"
      }`}
    >
      {label}
    </span>
  );
}

function ProductFormModal({
  t,
  tenantId,
  product,
  onClose,
  onSaved,
}: {
  t: Translate;
  tenantId: string;
  product: ProductResponse | null;
  onClose: () => void;
  onSaved: (product: ProductResponse) => void;
}) {
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(
    product ? String(product.priceIdr) : "",
  );
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return setError(t("products.nameRequired"));
    const trimmedPrice = price.trim();
    if (!trimmedPrice) return setError(t("products.priceRequired"));
    const priceValue = Number(trimmedPrice);
    if (!Number.isInteger(priceValue) || priceValue < 0) {
      return setError(t("products.priceInvalid"));
    }
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        name: trimmedName,
        description: description.trim() ? description.trim() : undefined,
        priceIdr: priceValue,
        isActive,
      };
      const saved = product
        ? await api.products.update(tenantId, product.id, {
            ...payload,
            description: description.trim() ? description.trim() : null,
          })
        : await api.products.create(tenantId, payload);
      onSaved(saved);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">
            {product ? t("products.editTitle") : t("products.addTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("products.nameLabel")} *
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("products.namePlaceholder")}
              className={inputClassName}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("products.descriptionLabel")}
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("products.descriptionPlaceholder")}
              rows={4}
              className={inputClassName}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              {t("products.priceLabel")} *
            </span>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={t("products.pricePlaceholder")}
              inputMode="numeric"
              className={inputClassName}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4"
            />
            {t("products.activeLabel")}
          </label>
          <FieldError message={error} />
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {submitting
                ? t("products.saving")
                : product
                  ? t("products.saveButton")
                  : t("products.createButton")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProductDeleteModal({
  t,
  tenantId,
  product,
  onClose,
  onDeleted,
}: {
  t: Translate;
  tenantId: string;
  product: ProductResponse;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setError(null);
    setDeleting(true);
    try {
      await api.products.remove(tenantId, product.id);
      onDeleted(product.id);
    } catch (err) {
      // 409 PRODUCT_HAS_LINKS diterjemahkan di sini: produk bertaautan
      // tidak boleh dihapus; pengguna diarahkan menonaktifkannya.
      setError(translateApiError(t, err));
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <h2 className="text-lg font-bold text-ink">{t("products.deleteTitle")}</h2>
        <p className="mt-2 text-sm text-muted">
          {t("products.deleteBody", { title: product.name })}
        </p>
        <FieldError message={error} />
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={deleting}
            onClick={() => void handleDelete()}
            className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {deleting ? t("products.deleting") : t("common.delete")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrderDetailModal({
  t,
  locale,
  order,
  onClose,
}: {
  t: Translate;
  locale: Locale;
  order: OrderResponse;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">
            {`Order ${order.id.slice(0, 8)}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">
          {t("products.orderDetailHint")}
        </p>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t("products.orderBuyerLabel")}</dt>
            <dd className="font-medium text-ink">
              {order.contactName ?? t("products.linkGenericBuyer")}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{t("products.orderStatusLabel")}</dt>
            <dd>
              <PaymentStatusChip t={t} status={order.status} />
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-muted">
          {t("products.createdLabel", {
            date: formatDateTime(order.createdAt, locale),
          })}
          {order.paidAt
            ? ` · ${t("products.orderPaidAtLabel", {
                date: formatDateTime(order.paidAt, locale),
              })}`
            : ""}
        </p>
        <h3 className="mt-5 text-sm font-semibold text-ink">
          {t("products.orderItemsLabel")}
        </h3>
        <ul className="mt-2 space-y-1">
          {order.items.map((item, idx) => (
            <li
              key={`${item.productId ?? "deleted"}-${idx}`}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-ink">
                {item.qty} × {item.productName}
              </span>
              <span className="text-muted">
                {formatIdr(item.unitPriceIdr, locale)}
              </span>
              <span className="font-medium text-ink">
                {formatIdr(item.lineTotalIdr, locale)}
              </span>
            </li>
          ))}
        </ul>
        {order.discountAmountIdr > 0 ? (
          <div className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted">
                {t("products.orderSubtotalLabel")}
              </span>
              <span className="text-ink">
                {formatIdr(order.subtotalIdr, locale)}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted">
                {t("products.orderDiscountLabel", {
                  code: order.discountCode ?? "",
                })}
              </span>
              <span className="text-ink">
                −{formatIdr(order.discountAmountIdr, locale)}
              </span>
            </div>
          </div>
        ) : null}
        <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
          <span className="text-sm font-semibold text-ink">
            {t("products.orderTotalLabel")}
          </span>
          <span className="text-base font-bold text-ink">
            {formatIdr(order.totalIdr, locale)}
          </span>
        </div>
        {order.paymentUrl ? (
          <div className="mt-4">
            <p className="text-xs font-medium text-muted">
              {t("products.orderPaymentLinkLabel")}
              {order.paymentStatus
                ? ` · ${t("products.orderPaymentStatusLabel")}: ${order.paymentStatus}`
                : ""}
            </p>
            <a
              href={order.paymentUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate font-mono text-xs text-accent underline"
            >
              {order.paymentUrl}
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CreatedLinkModal({
  t,
  link,
  onClose,
}: {
  t: Translate;
  link: PaymentLinkResponse;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      // Clipboard tidak tersedia (konteks non-secure): URL tetap terlihat
      // & bisa disalin manual dari teks di bawah.
      setCopied(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">
            {t("products.linkCreatedTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">
          {t("products.linkCreatedBody")}
        </p>
        <p className="mt-3 break-all rounded-lg border border-line bg-elevated p-3 font-mono text-xs text-ink">
          {link.url}
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
          >
            {copied ? t("products.copiedLabel") : t("products.copyButton")}
          </button>
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.view")}
          </a>
        </div>
      </div>
    </div>
  );
}

function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function DiscountCodeFormModal({
  t,
  tenantId,
  discountCode,
  onClose,
  onSaved,
}: {
  t: Translate;
  tenantId: string;
  discountCode: DiscountCodeResponse | null;
  onClose: () => void;
  onSaved: (saved: DiscountCodeResponse) => void;
}) {
  const isEdit = discountCode !== null;
  const [code, setCode] = useState(discountCode?.code ?? "");
  const [kind, setKind] = useState<"percent" | "fixed">(
    discountCode?.kind ?? "percent",
  );
  const [value, setValue] = useState(
    discountCode ? String(discountCode.value) : "",
  );
  const [minOrder, setMinOrder] = useState(
    discountCode && discountCode.minOrderIdr > 0
      ? String(discountCode.minOrderIdr)
      : "",
  );
  const [maxRedemptions, setMaxRedemptions] = useState(
    discountCode?.maxRedemptions != null
      ? String(discountCode.maxRedemptions)
      : "",
  );
  const [maxPerContact, setMaxPerContact] = useState(
    discountCode?.maxPerContact != null
      ? String(discountCode.maxPerContact)
      : "",
  );
  const [startsAt, setStartsAt] = useState(
    toLocalInputValue(discountCode?.startsAt ?? null),
  );
  const [endsAt, setEndsAt] = useState(
    toLocalInputValue(discountCode?.endsAt ?? null),
  );
  const [isActive, setIsActive] = useState(discountCode?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const valueNum = Number(value);
    if (
      !Number.isInteger(valueNum) ||
      valueNum < 1 ||
      (kind === "percent" && valueNum > 100)
    ) {
      setError(t("products.discountValueInvalid"));
      return;
    }
    const optionalInt = (raw: string): number | null => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const n = Number(trimmed);
      return Number.isInteger(n) && n >= 0 ? n : null;
    };
    setSubmitting(true);
    setError(null);
    try {
      const shared = {
        kind,
        value: valueNum,
        minOrderIdr: optionalInt(minOrder) ?? 0,
        maxRedemptions: optionalInt(maxRedemptions),
        maxPerContact: optionalInt(maxPerContact),
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        isActive,
      };
      const saved = isEdit
        ? await api.discountCodes.update(tenantId, discountCode.id, shared)
        : await api.discountCodes.create(tenantId, {
            ...shared,
            code: code.trim(),
          });
      onSaved(saved);
    } catch (err) {
      setError(translateApiError(t, err));
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";
  const labelClass = "block text-sm font-medium text-ink";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-bold text-ink">
            {isEdit
              ? t("products.discountEditTitle")
              : t("products.discountAddTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium text-ink"
          >
            {t("common.close")}
          </button>
        </div>
        <FieldError message={error} />
        <div className="mt-4 space-y-3">
          <div>
            <label className={labelClass} htmlFor="dc-code">
              {t("products.discountCodeLabel")}
            </label>
            <input
              id="dc-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={isEdit}
              placeholder={t("products.discountCodePlaceholder")}
              className={`${inputClass} font-mono uppercase disabled:opacity-60`}
            />
            <p className="mt-1 text-xs text-muted">
              {t("products.discountCodeHint")}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="dc-kind">
                {t("products.discountKindLabel")}
              </label>
              <select
                id="dc-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as "percent" | "fixed")}
                className={inputClass}
              >
                <option value="percent">
                  {t("products.discountKindPercent")}
                </option>
                <option value="fixed">{t("products.discountKindFixed")}</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="dc-value">
                {t("products.discountValueLabel")}
              </label>
              <input
                id="dc-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                inputMode="numeric"
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="dc-min">
              {t("products.discountMinOrderLabel")}
            </label>
            <input
              id="dc-min"
              value={minOrder}
              onChange={(e) => setMinOrder(e.target.value)}
              inputMode="numeric"
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="dc-maxtotal">
                {t("products.discountMaxRedemptionsLabel")}
              </label>
              <input
                id="dc-maxtotal"
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
                inputMode="numeric"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="dc-maxcontact">
                {t("products.discountMaxPerContactLabel")}
              </label>
              <input
                id="dc-maxcontact"
                value={maxPerContact}
                onChange={(e) => setMaxPerContact(e.target.value)}
                inputMode="numeric"
                className={inputClass}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="dc-starts">
                {t("products.discountStartsLabel")}
              </label>
              <input
                id="dc-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="dc-ends">
                {t("products.discountEndsLabel")}
              </label>
              <input
                id="dc-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            {t("products.discountActiveLabel")}
          </label>
        </div>
        <div className="mt-5 flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {submitting
              ? t("products.saving")
              : isEdit
                ? t("products.discountSaveButton")
                : t("products.discountCreateButton")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-elevated px-4 py-2 text-sm font-medium text-ink"
          >
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}
