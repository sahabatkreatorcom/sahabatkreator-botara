/**
 * Verifikasi Gelombang G14 — KODE DISKON & PENUKARAN (chat commerce),
 * di atas PGlite. Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan:
 *   [1] CRUD kode via HTTP: buat (kode ternormalisasi HURUF BESAR),
 *       duplikat → 409 DISCOUNT_CODE_DUPLICATE, payload tidak sah →
 *       400, tulis oleh agent → 403, non-member → 404
 *       TENANT_NOT_FOUND, PATCH tidak bisa mengubah teks kode, kode
 *       tak dikenal → 404 DISCOUNT_CODE_NOT_FOUND.
 *   [2] isolasi tenant: kode tenant lain tak terlihat & tak terbaca.
 *   [3] validasi per alasan (previewDiscount): not_found, inactive,
 *       not_started, expired, below_minimum — urutan + alasan persis.
 *   [4] hitungan: persen dibulatkan ke bawah (floor), nominal dibatasi
 *       subtotal (total tak pernah negatif).
 *   [5] integrasi checkout: order menyimpan subtotal/diskon/kode,
 *       tautan pembayaran memakai TOTAL SESUDAH DISKON, baris
 *       penukaran `redeemed` lahir, ringkasan keranjang memuat baris
 *       diskon.
 *   [6] balapan klaim: maxRedemptions=1 + dua checkout bersamaan →
 *       TEPAT SATU terapan + tepat satu baris redeemed; yang kalah
 *       checkout harga penuh dengan alasan `exhausted`.
 *   [7] perilaku pembatalan (keputusan G14): order berakhir
 *       expired/cancelled TANPA bayar → penukaran DILEPAS (kuota
 *       kembali, bisa dipakai kontak lain); order LUNAS mempertahankan
 *       penukarannya selamanya.
 *   [8] batas per kontak: penukaran kedua kontak yang sama ditolak
 *       `contact_limit`.
 *   [9] analitik: statistik per kode (jumlah redeemed, jumlah dilepas,
 *       total diskon diberikan) konsisten dengan baris penukaran.
 *
 * Keputusan permukaan (audit langkah 0): kode HANYA berlaku di
 * checkout keranjang flow (cart_checkout) — satu-satunya jalur yang
 * membuat order + tautan dari subtotal. Tautan produk tunggal dan
 * halaman /pay BUKAN permukaan kode (jumlah terkunci saat tautan
 * dibuat); tak ada pembuatan order manual.
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:discount-codes
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import {
  addToCartTx,
  checkoutCartTx,
  listPaymentLinks,
  previewDiscount,
  renderCartSummaryText,
  simulatePayByCode,
  withTenantDb,
} from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createDiscountCodesRoutes } from "../src/modules/discount-codes/routes";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../../packages/db/migrations");

const client = new PGlite({ extensions: { vector, btree_gist } });
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
  await client.exec(sqlText.replaceAll("--> statement-breakpoint", ""));
}
console.log(`[setup] migrasi teraplikasi: ${files.length} file`);
const db = drizzle(client, { schema }) as unknown as Database;

const TENANT = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "11111111-1111-4111-8111-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VIEWER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWNER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CUST1 = "22000000-0000-4000-8000-0000000000e1";
const CUST2 = "22000000-0000-4000-8000-0000000000e2";
const CUST3 = "22000000-0000-4000-8000-0000000000e3";
const UNKNOWN_ID = "22000000-0000-4000-8000-000000000999";

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug, default_locale) VALUES ($1, 'Tenant A', 'tenant-a', 'id'), ($2, 'Tenant B', 'tenant-b', 'en')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES
   ($1, 'owner@sk.test', 'Pemilik A'),
   ($2, 'agent@sk.test', 'Agen A'),
   ($3, 'viewer@sk.test', 'Penonton A'),
   ($4, 'ownerb@sk.test', 'Pemilik B')`,
  [OWNER, AGENT, VIEWER, OWNER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
   ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'viewer'), ($5, $6, 'owner')`,
  [TENANT, OWNER, AGENT, VIEWER, TENANT_B, OWNER_B],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name, source) VALUES
   ($1, $4, 'Budi Satu', 'manual'),
   ($2, $4, 'Sari Dua', 'manual'),
   ($3, $4, 'Tito Tiga', 'manual')`,
  [CUST1, CUST2, CUST3, TENANT],
);

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? OWNER;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createDiscountCodesRoutes(bundle));

interface CodeJson {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  minOrderIdr: number;
  maxRedemptions: number | null;
  maxPerContact: number | null;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  redemptionCount: number;
  releasedCount: number;
  totalDiscountIdr: number;
}
interface ErrJson {
  error: { code: string };
}

async function call(
  method: string,
  url: string,
  user = OWNER,
  body?: unknown,
): Promise<{ status: number; body: never }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": user,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as never,
  };
}

const base = `/tenants/${TENANT}/discount-codes`;
const actor = { actorType: "system" as const, actorId: "verify-g14" };

// --- helper commerce -------------------------------------------------------
async function seedProduct(priceIdr: number, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO products (id, tenant_id, name, price_idr, is_active) VALUES ($1, $2, $3, $4, true)`,
    [id, TENANT, name, priceIdr],
  );
  return id;
}

async function fillCart(contactId: string, productId: string, qty = 1) {
  const res = await client.query<{
    id: string;
    tenant_id: string;
    name: string;
    price_idr: number;
    is_active: boolean;
  }>(`SELECT * FROM products WHERE id = $1`, [productId]);
  const r = res.rows[0]!;
  const product = {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    priceIdr: Number(r.price_idr),
    isActive: r.is_active,
  } as never;
  await withTenantDb(db, TENANT, (tx) =>
    addToCartTx(tx, TENANT, contactId, product, qty),
  );
}

async function checkout(contactId: string, discountCode?: string) {
  return withTenantDb(db, TENANT, (tx) =>
    checkoutCartTx(tx, TENANT, {
      contactId,
      actor,
      ...(discountCode ? { discountCode } : {}),
    }),
  );
}

async function redemptionRows(codeId: string) {
  const res = await client.query<{
    status: string;
    discount_amount_idr: number;
    contact_id: string;
  }>(
    `SELECT status, discount_amount_idr, contact_id FROM discount_redemptions WHERE discount_code_id = $1 ORDER BY created_at`,
    [codeId],
  );
  return res.rows.map((r) => ({
    status: r.status,
    amount: Number(r.discount_amount_idr),
    contactId: r.contact_id,
  }));
}

// ===========================================================================
// [1] CRUD HTTP + normalisasi + gerbang peran
// ===========================================================================
let hemat10Id = "";
{
  const created = await call("POST", base, OWNER, {
    code: "hemat10",
    kind: "percent",
    value: 10,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const body = created.body as CodeJson;
  assert.equal(body.code, "HEMAT10", "kode ternormalisasi huruf besar");
  assert.equal(body.redemptionCount, 0);
  assert.equal(body.isActive, true);
  hemat10Id = body.id;

  const dup = await call("POST", base, OWNER, {
    code: "HEMAT10",
    kind: "percent",
    value: 5,
  });
  assert.equal(dup.status, 409);
  assert.equal((dup.body as ErrJson).error.code, "DISCOUNT_CODE_DUPLICATE");

  const badPercent = await call("POST", base, OWNER, {
    code: "SALAH1",
    kind: "percent",
    value: 150,
  });
  assert.equal(badPercent.status, 400);

  const agentWrite = await call("POST", base, AGENT, {
    code: "AGEN1",
    kind: "fixed",
    value: 1000,
  });
  assert.equal(agentWrite.status, 403, "agent tak boleh mengelola kode");

  const viewerRead = await call("GET", base, VIEWER);
  assert.equal(viewerRead.status, 200, "viewer (member) boleh membaca");

  const nonMember = await call("GET", base, OWNER_B);
  assert.equal(nonMember.status, 404);
  assert.equal((nonMember.body as ErrJson).error.code, "TENANT_NOT_FOUND");

  const patched = await call("PATCH", `${base}/${hemat10Id}`, OWNER, {
    value: 15,
    code: "GANTI99",
  });
  assert.equal(patched.status, 200);
  const patchedBody = patched.body as CodeJson;
  assert.equal(patchedBody.value, 15);
  assert.equal(
    patchedBody.code,
    "HEMAT10",
    "teks kode TIDAK bisa diubah lewat PATCH",
  );
  // kembalikan ke 10 untuk grup berikutnya
  await call("PATCH", `${base}/${hemat10Id}`, OWNER, { value: 10 });

  const missing = await call("PATCH", `${base}/${UNKNOWN_ID}`, OWNER, {
    value: 5,
  });
  assert.equal(missing.status, 404);
  assert.equal(
    (missing.body as ErrJson).error.code,
    "DISCOUNT_CODE_NOT_FOUND",
  );
  console.log("[1] CRUD + normalisasi + gerbang peran OK");
}

// ===========================================================================
// [2] Isolasi tenant
// ===========================================================================
{
  const createdB = await call(
    "POST",
    `/tenants/${TENANT_B}/discount-codes`,
    OWNER_B,
    { code: "MILIKB", kind: "fixed", value: 5000 },
  );
  assert.equal(createdB.status, 201);
  const idB = (createdB.body as CodeJson).id;

  const listA = await call("GET", base, OWNER);
  const codesA = (listA.body as { discountCodes: CodeJson[] }).discountCodes;
  assert.ok(
    !codesA.some((c) => c.id === idB),
    "kode tenant B tak muncul di daftar tenant A",
  );
  const crossRead = await call("GET", `${base}/${idB}`, OWNER);
  assert.equal(crossRead.status, 404, "kode tenant lain 404 di tenant ini");
  console.log("[2] isolasi tenant OK");
}

// ===========================================================================
// [3] Validasi per alasan + [4] hitungan
// ===========================================================================
const preview = (code: string, subtotalIdr: number, contactId = CUST1) =>
  previewDiscount(db, { tenantId: TENANT }, { code, contactId, subtotalIdr });
{
  assert.deepEqual(await preview("TAKADA", 100_000), {
    kind: "invalid",
    reason: "not_found",
  });

  await call("POST", base, OWNER, {
    code: "MATI10",
    kind: "percent",
    value: 10,
    isActive: false,
  });
  assert.deepEqual(await preview("MATI10", 100_000), {
    kind: "invalid",
    reason: "inactive",
  });

  const future = new Date(Date.now() + 86_400_000).toISOString();
  await call("POST", base, OWNER, {
    code: "BESOK10",
    kind: "percent",
    value: 10,
    startsAt: future,
  });
  assert.deepEqual(await preview("BESOK10", 100_000), {
    kind: "invalid",
    reason: "not_started",
  });

  const past = new Date(Date.now() - 86_400_000).toISOString();
  await call("POST", base, OWNER, {
    code: "KEMARIN10",
    kind: "percent",
    value: 10,
    endsAt: past,
  });
  assert.deepEqual(await preview("KEMARIN10", 100_000), {
    kind: "invalid",
    reason: "expired",
  });

  await call("POST", base, OWNER, {
    code: "MINIMAL50",
    kind: "fixed",
    value: 5000,
    minOrderIdr: 100_000,
  });
  assert.deepEqual(await preview("MINIMAL50", 50_000), {
    kind: "invalid",
    reason: "below_minimum",
  });
  const okMin = await preview("MINIMAL50", 100_000);
  assert.equal(okMin.kind, "ok");
  console.log("[3] alasan validasi persis OK");

  // persen floor: 10% dari 99.999 = 9.999 (bukan 10.000)
  const floorPreview = await preview("HEMAT10", 99_999);
  assert.equal(floorPreview.kind, "ok");
  if (floorPreview.kind === "ok") {
    assert.equal(floorPreview.code.id, hemat10Id);
    assert.equal(floorPreview.code.code, "HEMAT10");
    assert.equal(floorPreview.discountAmountIdr, 9_999);
    assert.equal(floorPreview.totalIdr, 90_000);
  }
  // nominal dibatasi subtotal: total tak pernah negatif
  await call("POST", base, OWNER, {
    code: "BESAR200",
    kind: "fixed",
    value: 200_000,
  });
  const capPreview = await preview("BESAR200", 50_000);
  assert.equal(capPreview.kind, "ok");
  if (capPreview.kind === "ok") {
    assert.equal(capPreview.discountAmountIdr, 50_000);
    assert.equal(capPreview.totalIdr, 0);
  }
  console.log("[4] hitungan persen floor + batas nominal OK");
}

// ===========================================================================
// [5] Integrasi checkout: order + tautan + penukaran + ringkasan
// ===========================================================================
{
  const product = await seedProduct(50_000, "Kelas A");
  await fillCart(CUST1, product, 2); // subtotal 100.000
  const result = await checkout(CUST1, "hemat10"); // huruf kecil pun jalan
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") throw new Error("unreachable");
  assert.equal(result.discount.kind, "applied");
  assert.equal(result.order.discountAmountIdr, 10_000);
  assert.equal(result.order.discountCode, "HEMAT10");
  assert.equal(result.order.totalIdr, 90_000, "total order sesudah diskon");

  const linkRes = await client.query<{ amount_idr: number }>(
    `SELECT amount_idr FROM payment_links WHERE id = $1`,
    [result.link.id],
  );
  assert.equal(
    Number(linkRes.rows[0]!.amount_idr),
    90_000,
    "jumlah tautan pembayaran = total sesudah diskon",
  );

  const rows = await redemptionRows(hemat10Id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "redeemed");
  assert.equal(rows[0]!.amount, 10_000);
  assert.equal(rows[0]!.contactId, CUST1);

  const text = renderCartSummaryText(result.view, {
    code: "HEMAT10",
    discountAmountIdr: 10_000,
  });
  assert.match(text, /Subtotal: Rp\s?100\.000/);
  assert.match(text, /Diskon \(HEMAT10\): -Rp\s?10\.000/);
  assert.match(text, /Total: Rp\s?90\.000/);
  console.log("[5] integrasi checkout + tautan + ringkasan OK");
}

// ===========================================================================
// [6] Balapan klaim: tepat satu pemenang
// ===========================================================================
let raceId = "";
{
  const created = await call("POST", base, OWNER, {
    code: "BALAPAN",
    kind: "percent",
    value: 10,
    maxRedemptions: 1,
  });
  raceId = (created.body as CodeJson).id;
  const product = await seedProduct(50_000, "Kelas Balapan");
  await fillCart(CUST2, product, 1);
  await fillCart(CUST3, product, 1);

  const [r1, r2] = await Promise.all([
    checkout(CUST2, "BALAPAN"),
    checkout(CUST3, "BALAPAN"),
  ]);
  const results = [r1, r2];
  const applied = results.filter(
    (r) => r.kind === "ok" && r.discount.kind === "applied",
  );
  const losers = results.filter(
    (r) => r.kind === "ok" && r.discount.kind === "invalid",
  );
  assert.equal(applied.length, 1, "tepat satu checkout mendapat diskon");
  assert.equal(losers.length, 1, "tepat satu checkout kalah dengan jujur");
  if (losers[0]!.kind === "ok") {
    assert.deepEqual(losers[0]!.discount, {
      kind: "invalid",
      code: "BALAPAN",
      reason: "exhausted",
    });
    assert.equal(
      losers[0]!.order.totalIdr,
      50_000,
      "yang kalah membayar harga penuh",
    );
  }
  const rows = await redemptionRows(raceId);
  assert.equal(
    rows.filter((r) => r.status === "redeemed").length,
    1,
    "tepat satu baris penukaran redeemed",
  );
  console.log("[6] balapan klaim tepat-satu OK");
}

// ===========================================================================
// [7] Pembatalan: kuota kembali saat order gagal bayar; lunas mengunci
// ===========================================================================
{
  // BALAPAN kuotanya habis; kontak ketiga (CUST1) kini ditolak.
  const product = await seedProduct(50_000, "Kelas Kuota");
  await fillCart(CUST1, product, 1);
  const blocked = await checkout(CUST1, "BALAPAN");
  assert.equal(blocked.kind, "ok");
  if (blocked.kind === "ok") {
    assert.deepEqual(blocked.discount, {
      kind: "invalid",
      code: "BALAPAN",
      reason: "exhausted",
    });
  }

  // Order pemenang balapan berakhir TANPA bayar: tautannya dibuat
  // kedaluwarsa, lalu penegakan malas listPaymentLinks membaliknya —
  // penukaran harus DILEPAS dan kuota kembali.
  const winner = await client.query<{ id: string; code: string }>(
    `SELECT pl.id, pl.code FROM payment_links pl
       JOIN orders o ON o.id = pl.order_id
      WHERE o.discount_code_id = $1 AND o.status = 'pending'`,
    [raceId],
  );
  assert.equal(winner.rows.length, 1);
  await client.query(
    `UPDATE payment_links SET expires_at = now() - interval '1 day' WHERE id = $1`,
    [winner.rows[0]!.id],
  );
  await listPaymentLinks(db, { tenantId: TENANT });
  const orderAfter = await client.query<{ status: string }>(
    `SELECT status FROM orders WHERE discount_code_id = $1 AND discount_code = 'BALAPAN' ORDER BY created_at DESC LIMIT 1`,
    [raceId],
  );
  assert.notEqual(orderAfter.rows[0]!.status, "pending");
  let rows = await redemptionRows(raceId);
  assert.equal(rows.filter((r) => r.status === "released").length, 1);
  assert.equal(rows.filter((r) => r.status === "redeemed").length, 0);

  // Kuota kembali: checkout baru dengan kode yang sama kini berhasil.
  await fillCart(CUST1, product, 1);
  const reused = await checkout(CUST1, "BALAPAN");
  assert.equal(reused.kind, "ok");
  let reusedLinkCode = "";
  if (reused.kind === "ok") {
    assert.equal(reused.discount.kind, "applied", "kuota hasil rilis bisa dipakai lagi");
    reusedLinkCode = reused.link.code;
  }
  rows = await redemptionRows(raceId);
  assert.equal(rows.filter((r) => r.status === "redeemed").length, 1);

  // LUNAS mengunci penukaran: bayar tautan pemenang baru, penukaran
  // tetap redeemed (tidak dilepas oleh sinkronisasi status).
  const paid = await simulatePayByCode(db, reusedLinkCode);
  assert.equal(paid?.kind, "paid");
  rows = await redemptionRows(raceId);
  assert.equal(
    rows.filter((r) => r.status === "redeemed").length,
    1,
    "order lunas mempertahankan penukaran",
  );
  assert.equal(rows.filter((r) => r.status === "released").length, 1);
  console.log("[7] rilis saat gagal bayar + kunci saat lunas OK");
}

// ===========================================================================
// [8] Batas per kontak
// ===========================================================================
{
  await call("POST", base, OWNER, {
    code: "SEKALI",
    kind: "percent",
    value: 10,
    maxPerContact: 1,
  });
  const product = await seedProduct(50_000, "Kelas Sekali");
  await fillCart(CUST2, product, 1);
  const first = await checkout(CUST2, "SEKALI");
  assert.equal(first.kind, "ok");
  if (first.kind === "ok") {
    assert.equal(first.discount.kind, "applied");
  }
  await fillCart(CUST2, product, 1);
  const second = await checkout(CUST2, "SEKALI");
  assert.equal(second.kind, "ok");
  if (second.kind === "ok") {
    assert.deepEqual(second.discount, {
      kind: "invalid",
      code: "SEKALI",
      reason: "contact_limit",
    });
    assert.equal(second.order.totalIdr, 50_000);
  }
  // Kontak lain tidak terkena batas per kontak ini.
  await fillCart(CUST3, product, 1);
  const other = await checkout(CUST3, "SEKALI");
  assert.equal(other.kind, "ok");
  if (other.kind === "ok") {
    assert.equal(other.discount.kind, "applied");
  }
  console.log("[8] batas per kontak OK");
}

// ===========================================================================
// [9] Analitik penukaran per kode
// ===========================================================================
{
  const list = await call("GET", base, OWNER);
  const codes = (list.body as { discountCodes: CodeJson[] }).discountCodes;
  const hemat = codes.find((c) => c.id === hemat10Id)!;
  assert.equal(hemat.redemptionCount, 1);
  assert.equal(hemat.totalDiscountIdr, 10_000);
  const race = codes.find((c) => c.id === raceId)!;
  assert.equal(race.redemptionCount, 1, "hanya penukaran aktif yang terhitung kuota");
  assert.equal(race.releasedCount, 1);
  assert.equal(race.totalDiscountIdr, 5_000);
  console.log("[9] analitik penukaran OK");
}

console.log("verify:discount-codes — SEMUA GRUP LULUS");
await client.close();
