# Modul `pay`

API publik halaman bayar `/pay/:code` (Fase 4A) — TANPA sesi dashboard.

Status: **live sejak Fase 4A** — route di `routes.ts`:
- `GET /pay/:code` — ringkasan tautan (produk, harga, status, nama penjual)
- `POST /pay/:code/simulate-pay` — menandai lunas (idempoten)

Autentikasi = `code` tautan itu sendiri; resolusi code → tenant lewat
lengan RLS `app.payment_code` (migrasi 0012, meniru pola siteKey webchat
0006) di `@sahabat-kreator/core` (`products.ts`). Respons tidak memuat
data pribadi kontak.

**Ini SIMULASI** (provider `simulation`): tidak ada uang sungguhan yang
bergerak. Gerbang pembayaran Midtrans/Xendit menggantikan endpoint
simulate-pay pada fase billing, dengan kontrak halaman yang sama.
