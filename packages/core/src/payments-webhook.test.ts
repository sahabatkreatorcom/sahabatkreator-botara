import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleMidtransWebhook, updatePaymentSettings } from "./payments";
import { createTestDb, seedContact, TEST_TENANT_ID, type TestDb } from "./testing/pglite";

/**
 * Idempotensi webhook pembayaran.
 *
 * Provider pembayaran mengirim ulang webhook: retry saat timeout,
 * pengiriman ganda saat status berubah cepat, dan replay manual dari
 * dashboard provider. Kalau handler tidak idempoten, satu pembayaran
 * bisa menghasilkan dua baris audit, dua notifikasi, dan — yang paling
 * mahal — order yang "dibayar" dua kali.
 *
 * Test ini menjalankan jalur SUNGGUHAN, bukan simulasi: kredensial
 * tenant disimpan lewat `updatePaymentSettings` (terenkripsi), dan
 * signature SHA512 dihitung sendiri persis seperti yang dilakukan
 * Midtrans. Dengan begitu urutan verifikasi — signature → jumlah →
 * status → transisi atomik — ikut teruji, bukan hanya fungsi terakhirnya.
 */

/**
 * Kunci enkripsi kredensial. `channel-secrets` mensyaratkan base64 dari
 * TEPAT 32 byte, jadi nilainya diturunkan di sini alih-alih diketik
 * manual — kunci yang salah panjang menggagalkan setup, bukan test.
 */
const TOKEN_SECRET = Buffer.alloc(32, 7).toString("base64");
const SERVER_KEY = "SB-Mid-server-UJI";
const AMOUNT = 75_000;
const CODE = "SK-WEBHOOK-0001";

const deps = { tokenSecret: TOKEN_SECRET };

/** Signature Midtrans: SHA512(order_id + status_code + gross_amount + serverKey). */
function midtransSignature(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  serverKey = SERVER_KEY,
): string {
  return createHash("sha512")
    .update(`${orderId}${statusCode}${grossAmount}${serverKey}`, "utf8")
    .digest("hex");
}

function settlementPayload(overrides: Record<string, unknown> = {}) {
  const grossAmount = `${AMOUNT}.00`;
  return {
    order_id: CODE,
    status_code: "200",
    gross_amount: grossAmount,
    transaction_status: "settlement",
    fraud_status: "accept",
    signature_key: midtransSignature(CODE, "200", grossAmount),
    ...overrides,
  };
}

describe("webhook Midtrans pada database sungguhan", () => {
  let ctx: TestDb;
  let orderId: string;
  let linkId: string;

  beforeAll(async () => {
    ctx = await createTestDb();
    const contactId = await seedContact(ctx.pglite, TEST_TENANT_ID);

    const saved = await updatePaymentSettings(
      ctx.db,
      { tenantId: TEST_TENANT_ID },
      {
        provider: "midtrans",
        environment: "sandbox",
        midtransSandboxServerKey: SERVER_KEY,
      },
      { actorType: "user", actorId: "uji" },
      deps,
    );
    expect(saved.kind).toBe("ok");

    orderId = crypto.randomUUID();
    await ctx.pglite.query(
      `INSERT INTO orders (id, tenant_id, contact_id, status, total_idr)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [orderId, TEST_TENANT_ID, contactId, AMOUNT],
    );
    linkId = crypto.randomUUID();
    await ctx.pglite.query(
      `INSERT INTO payment_links
         (id, tenant_id, order_id, contact_id, code, amount_idr, status,
          provider, provider_environment, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'midtrans', 'sandbox', now() + interval '1 day')`,
      [linkId, TEST_TENANT_ID, orderId, contactId, CODE, AMOUNT],
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const linkStatus = async () => {
    const res = await ctx.pglite.query<{ status: string }>(
      `SELECT status FROM payment_links WHERE id = $1`,
      [linkId],
    );
    return res.rows[0]!.status;
  };

  const orderRow = async () => {
    const res = await ctx.pglite.query<{ status: string; paid_at: Date | null }>(
      `SELECT status, paid_at FROM orders WHERE id = $1`,
      [orderId],
    );
    return res.rows[0]!;
  };

  const paidAuditCount = async () => {
    const res = await ctx.pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
       WHERE tenant_id = $1 AND action = 'payment.paid'`,
      [TEST_TENANT_ID],
    );
    return Number(res.rows[0]!.n);
  };

  beforeEach(async () => {
    // Setiap test mulai dari tautan yang masih pending.
    await ctx.pglite.query(
      `UPDATE payment_links SET status = 'pending', paid_at = NULL WHERE id = $1`,
      [linkId],
    );
    await ctx.pglite.query(
      `UPDATE orders SET status = 'pending', paid_at = NULL WHERE id = $1`,
      [orderId],
    );
    await ctx.pglite.query(
      `DELETE FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'payment.%'`,
      [TEST_TENANT_ID],
    );
  });

  it("menolak signature yang tidak cocok tanpa mengubah status", async () => {
    const payload = settlementPayload({
      signature_key: midtransSignature(CODE, "200", `${AMOUNT}.00`, "kunci-palsu"),
    });
    const result = await handleMidtransWebhook(ctx.db, deps, payload);

    expect(result.outcome).toBe("rejected_signature");
    expect(await linkStatus()).toBe("pending");
    expect((await orderRow()).status).toBe("pending");
  });

  it("menolak jumlah yang tidak sama dengan tautan", async () => {
    // Signature sah, tetapi jumlahnya berbeda dari amount tautan: ini
    // bentuk serangan yang paling mudah diremehkan — penyerang yang
    // memegang server key bisa "membayar" Rp1 untuk tagihan Rp75.000.
    const grossAmount = "1.00";
    const payload = settlementPayload({
      gross_amount: grossAmount,
      signature_key: midtransSignature(CODE, "200", grossAmount),
    });
    const result = await handleMidtransWebhook(ctx.db, deps, payload);

    expect(result.outcome).toBe("rejected_amount");
    expect(await linkStatus()).toBe("pending");
  });

  it("menerapkan settlement dan menyinkronkan order", async () => {
    const result = await handleMidtransWebhook(ctx.db, deps, settlementPayload());

    expect(result.outcome).toBe("applied");
    expect(result.linkStatus).toBe("paid");
    expect(await linkStatus()).toBe("paid");

    const order = await orderRow();
    expect(order.status).toBe("paid");
    expect(order.paid_at).toBeInstanceOf(Date);
    expect(await paidAuditCount()).toBe(1);
  });

  it("webhook yang dikirim ulang menghasilkan duplicate, bukan pembayaran kedua", async () => {
    const payload = settlementPayload();
    const first = await handleMidtransWebhook(ctx.db, deps, payload);
    const second = await handleMidtransWebhook(ctx.db, deps, payload);
    const third = await handleMidtransWebhook(ctx.db, deps, payload);

    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("duplicate");
    expect(third.outcome).toBe("duplicate");
    expect(second.linkStatus).toBe("paid");

    // Inti idempotensi: tepat satu audit, bukan tiga.
    expect(await paidAuditCount()).toBe(1);
  });

  it("status final tidak bisa ditimpa webhook berikutnya", async () => {
    await handleMidtransWebhook(ctx.db, deps, settlementPayload());

    // Provider mengirim 'expire' setelah 'settlement' (urutan yang
    // sebenarnya bisa terjadi saat retry tertinggal).
    const grossAmount = `${AMOUNT}.00`;
    const expire = {
      order_id: CODE,
      status_code: "407",
      gross_amount: grossAmount,
      transaction_status: "expire",
      signature_key: midtransSignature(CODE, "407", grossAmount),
    };
    const result = await handleMidtransWebhook(ctx.db, deps, expire);

    expect(result.outcome).toBe("duplicate");
    expect(await linkStatus()).toBe("paid");
    expect((await orderRow()).status).toBe("paid");
  });

  it("capture dengan fraud challenge TIDAK menandai lunas", async () => {
    const grossAmount = `${AMOUNT}.00`;
    const payload = {
      order_id: CODE,
      status_code: "201",
      gross_amount: grossAmount,
      transaction_status: "capture",
      fraud_status: "challenge",
      signature_key: midtransSignature(CODE, "201", grossAmount),
    };
    const result = await handleMidtransWebhook(ctx.db, deps, payload);

    expect(result.outcome).toBe("ignored_pending");
    expect(await linkStatus()).toBe("pending");
  });

  it("status pending dari provider tidak mengubah apa pun", async () => {
    const grossAmount = `${AMOUNT}.00`;
    const payload = {
      order_id: CODE,
      status_code: "201",
      gross_amount: grossAmount,
      transaction_status: "pending",
      signature_key: midtransSignature(CODE, "201", grossAmount),
    };
    const result = await handleMidtransWebhook(ctx.db, deps, payload);

    expect(result.outcome).toBe("ignored_pending");
    expect(await linkStatus()).toBe("pending");
  });

  it("kode tautan yang tidak dikenal dilaporkan not_found", async () => {
    const grossAmount = `${AMOUNT}.00`;
    const result = await handleMidtransWebhook(ctx.db, deps, {
      order_id: "SK-TIDAK-ADA",
      status_code: "200",
      gross_amount: grossAmount,
      transaction_status: "settlement",
      signature_key: midtransSignature("SK-TIDAK-ADA", "200", grossAmount),
    });
    expect(result.outcome).toBe("not_found");
  });
});
