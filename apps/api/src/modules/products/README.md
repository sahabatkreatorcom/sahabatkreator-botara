# Modul `products`

Katalog produk per tenant + tautan bayar (Fase 4A).

Status: **live sejak Fase 4A** — route di `routes.ts`:
- `POST/GET /tenants/:tenantId/products`, `PATCH/DELETE .../products/:id`
  (DELETE → 409 `PRODUCT_HAS_LINKS` bila produk sudah punya tautan bayar;
  nonaktifkan produk sebagai gantinya)
- `POST/GET /tenants/:tenantId/payment-links`

Service domainnya di `@sahabat-kreator/core` (`products.ts`): harga produk
boleh berubah, tetapi `amount_idr` tautan adalah snapshot saat dibuat.
Provider tautan fase ini selalu `simulation` — halaman publiknya ada di
modul `pay`; tool agent `send_payment_link` memakai service yang sama.
