import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addToCartTx,
  checkoutCartTx,
  formatIdrId,
  getCartViewTx,
  parseCatalogSelection,
  type PreparedOrderLink,
} from "./commerce";
import { PaymentProviderError } from "./payments";
import { createTestDb, seedContact, seedProduct, TEST_TENANT_ID, type TestDb } from "./testing/pglite";
import { withTenantDb } from "./tx";

/**
 * Jalur uang: keranjang dan checkout.
 *
 * Dua hal yang mahal bila salah dan tidak terlihat dari tipe:
 *
 *   1. HARGA. Baris keranjang menyimpan snapshot harga saat item PERTAMA
 *      ditambahkan. Kalau snapshot ini tertimpa harga baru di tengah
 *      jalan, pelanggan melihat satu angka di ringkasan lalu ditagih
 *      angka lain.
 *   2. CHECKOUT GANDA. Kontak menekan "checkout" dua kali, atau node
 *      flow dieksekusi ulang. Tanpa klaim atomik, satu keranjang bisa
 *      melahirkan dua order dan dua tautan bayar.
 *
 * Keduanya diuji di Postgres sungguhan (PGlite) karena keduanya
 * bergantung pada perilaku DB: partial unique index keranjang terbuka
 * dan syarat `status = 'open'` pada UPDATE.
 */

const PRICE_A = 50_000;
const PRICE_B = 20_000;

describe("format harga", () => {
  it("memakai Rupiah tanpa desimal", () => {
    // Intl memakai spasi tak-terputus (U+00A0) di beberapa versi ICU;
    // dinormalkan supaya test tidak rapuh terhadap perbedaan itu.
    const normalize = (s: string) => s.replace(/\u00a0/g, " ");
    expect(normalize(formatIdrId(50_000))).toBe("Rp 50.000");
    expect(normalize(formatIdrId(1_234_567))).toBe("Rp 1.234.567");
    expect(normalize(formatIdrId(0))).toBe("Rp 0");
  });

  it("tidak menampilkan pecahan sen untuk nilai bulat", () => {
    expect(formatIdrId(50_000)).not.toMatch(/[.,]00\b/);
  });
});

describe("parsing pilihan katalog", () => {
  it("menerima nomor polos sebagai qty 1", () => {
    expect(parseCatalogSelection("1", 3)).toEqual({ index: 0, qty: 1 });
    expect(parseCatalogSelection("3", 3)).toEqual({ index: 2, qty: 1 });
  });

  it("menerima bentuk NxM dengan x besar maupun kecil", () => {
    expect(parseCatalogSelection("2x3", 3)).toEqual({ index: 1, qty: 3 });
    expect(parseCatalogSelection("2X3", 3)).toEqual({ index: 1, qty: 3 });
    expect(parseCatalogSelection(" 2 x 3 ", 3)).toEqual({ index: 1, qty: 3 });
  });

  it("menolak nomor di luar katalog", () => {
    expect(parseCatalogSelection("0", 3)).toBeNull();
    expect(parseCatalogSelection("4", 3)).toBeNull();
  });

  it("menolak qty di luar 1..999", () => {
    expect(parseCatalogSelection("1x0", 3)).toBeNull();
    expect(parseCatalogSelection("1x1000", 3)).toBeNull();
  });

  it("menolak teks yang bukan pilihan", () => {
    expect(parseCatalogSelection("halo", 3)).toBeNull();
    expect(parseCatalogSelection("", 3)).toBeNull();
    expect(parseCatalogSelection("1.5", 3)).toBeNull();
  });
});

describe("keranjang dan checkout", () => {
  let ctx: TestDb;
  let contactId: string;
  let productA: string;
  let productB: string;

  const actor = { actorType: "system" as const, actorId: "test-system" };

  beforeAll(async () => {
    ctx = await createTestDb();
    contactId = await seedContact(ctx.pglite, TEST_TENANT_ID);
    productA = await seedProduct(ctx.pglite, TEST_TENANT_ID, {
      name: "Kaos",
      priceIdr: PRICE_A,
    });
    productB = await seedProduct(ctx.pglite, TEST_TENANT_ID, {
      name: "Topi",
      priceIdr: PRICE_B,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * Baris produk seperti yang dibaca pemanggil dari katalog.
   *
   * PENTING: dibaca SEBELUM transaksi dibuka. PGlite hanya punya satu
   * koneksi, jadi kueri langsung di dalam callback `db.transaction` akan
   * menunggu koneksi yang sedang dipegang transaksi itu sendiri dan
   * menggantung sampai timeout.
   */
  const productRow = async (id: string) => {
    const res = await ctx.pglite.query<{
      id: string;
      tenant_id: string;
      name: string;
      price_idr: number;
      is_active: boolean;
    }>(`SELECT * FROM products WHERE id = $1`, [id]);
    const r = res.rows[0]!;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      priceIdr: Number(r.price_idr),
      isActive: r.is_active,
    } as never;
  };

  const addFor = async (forContact: string, productId: string, qty: number) => {
    const product = await productRow(productId);
    return withTenantDb(ctx.db, TEST_TENANT_ID, (tx) =>
      addToCartTx(tx, TEST_TENANT_ID, forContact, product, qty),
    );
  };

  const addToCart = (productId: string, qty: number) =>
    addFor(contactId, productId, qty);

  const checkout = (preparedLink?: unknown) =>
    withTenantDb(ctx.db, TEST_TENANT_ID, (tx) =>
      checkoutCartTx(tx, TEST_TENANT_ID, {
        contactId,
        actor,
        preparedLink: (preparedLink ?? null) as never,
      }),
    );

  const orderCount = async () => {
    const res = await ctx.pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1`,
      [TEST_TENANT_ID],
    );
    return Number(res.rows[0]!.n);
  };

  it("keranjang kosong menghasilkan empty_cart tanpa menulis order", async () => {
    const freshContact = await seedContact(ctx.pglite, TEST_TENANT_ID, {
      phone: "+6281200000001",
    });
    const before = await orderCount();
    const result = await withTenantDb(ctx.db, TEST_TENANT_ID, (tx) =>
      checkoutCartTx(tx, TEST_TENANT_ID, { contactId: freshContact, actor }),
    );
    expect(result.kind).toBe("empty_cart");
    expect(await orderCount()).toBe(before);
  });

  it("menghitung total dari harga produk saat item ditambahkan", async () => {
    const view = await addToCart(productA, 2);
    expect(view.itemCount).toBe(2);
    expect(view.totalIdr).toBe(PRICE_A * 2);
    expect(view.items[0]?.unitPriceIdr).toBe(PRICE_A);
  });

  it("menambah produk yang sama menaikkan qty, bukan membuat baris baru", async () => {
    const view = await addToCart(productA, 1);
    expect(view.items).toHaveLength(1);
    expect(view.itemCount).toBe(3);
    expect(view.totalIdr).toBe(PRICE_A * 3);
  });

  it("snapshot harga pertama menang walau harga produk naik", async () => {
    // Harga katalog naik SETELAH item masuk keranjang.
    await ctx.pglite.query(`UPDATE products SET price_idr = 70000 WHERE id = $1`, [
      productA,
    ]);
    const view = await addToCart(productA, 1);
    expect(view.items[0]?.unitPriceIdr).toBe(PRICE_A);
    expect(view.totalIdr).toBe(PRICE_A * 4);

    // Kembalikan harga supaya test berikutnya tidak bergantung urutan.
    await ctx.pglite.query(`UPDATE products SET price_idr = $2 WHERE id = $1`, [
      productA,
      PRICE_A,
    ]);
  });

  it("checkout memakai snapshot baris, bukan harga katalog terkini", async () => {
    await addToCart(productB, 2);
    await ctx.pglite.query(`UPDATE products SET price_idr = 99000 WHERE id = $1`, [
      productB,
    ]);

    const before = await orderCount();
    const result = await checkout();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const expected = PRICE_A * 4 + PRICE_B * 2;
    expect(result.order.totalIdr).toBe(expected);
    expect(result.link.amountIdr).toBe(expected);
    expect(result.order.status).toBe("pending");
    expect(await orderCount()).toBe(before + 1);

    // Snapshot nama ikut tersimpan: riwayat order tidak boleh berubah
    // bila produknya kelak diganti nama atau dihapus.
    const topi = result.items.find((i) => i.productId === productB);
    expect(topi?.productName).toBe("Topi");
    expect(topi?.unitPriceIdr).toBe(PRICE_B);

    await ctx.pglite.query(`UPDATE products SET price_idr = $2 WHERE id = $1`, [
      productB,
      PRICE_B,
    ]);
  });

  it("checkout kedua pada keranjang yang sama tidak melahirkan order baru", async () => {
    const freshContact = await seedContact(ctx.pglite, TEST_TENANT_ID, {
      phone: "+6281200000002",
    });
    await addFor(freshContact, productB, 1);

    const before = await orderCount();
    const first = await withTenantDb(ctx.db, TEST_TENANT_ID, (tx) =>
      checkoutCartTx(tx, TEST_TENANT_ID, { contactId: freshContact, actor }),
    );
    expect(first.kind).toBe("ok");

    // Inilah yang terjadi saat kontak menekan "checkout" dua kali.
    const second = await withTenantDb(ctx.db, TEST_TENANT_ID, (tx) =>
      checkoutCartTx(tx, TEST_TENANT_ID, { contactId: freshContact, actor }),
    );
    expect(second.kind).toBe("empty_cart");
    expect(await orderCount()).toBe(before + 1);

    // Keranjang lama tidak lagi terbuka, jadi ringkasan pun kosong.
    const view = await withTenantDb(ctx.db, TEST_TENANT_ID, (tx) =>
      getCartViewTx(tx, TEST_TENANT_ID, freshContact),
    );
    expect(view).toBeNull();
  });

  it("menolak sesi provider yang jumlahnya tidak cocok dengan keranjang", async () => {
    const freshContact = await seedContact(ctx.pglite, TEST_TENANT_ID, {
      phone: "+6281200000003",
    });
    await addFor(freshContact, productA, 1);

    // Sesi provider disiapkan untuk jumlah lama; keranjang sudah berubah.
    const stale: PreparedOrderLink = {
      code: "SK-STALE-001",
      amountIdr: PRICE_A - 1,
      session: {
        provider: "midtrans",
        environment: "sandbox",
        providerRef: "snap-token-uji",
        checkoutUrl: "https://contoh.test/pay/SK-STALE-001",
      },
    };

    await expect(
      withTenantDb(ctx.db, TEST_TENANT_ID, (tx) =>
        checkoutCartTx(tx, TEST_TENANT_ID, {
          contactId: freshContact,
          actor,
          preparedLink: stale,
        }),
      ),
    ).rejects.toBeInstanceOf(PaymentProviderError);

    // Transaksi dibatalkan: tidak ada order, dan keranjang tetap terbuka
    // sehingga pelanggan dapat mencoba lagi dengan sesi yang benar.
    const view = await withTenantDb(ctx.db, TEST_TENANT_ID, (tx) =>
      getCartViewTx(tx, TEST_TENANT_ID, freshContact),
    );
    expect(view?.itemCount).toBe(1);
  });
});
