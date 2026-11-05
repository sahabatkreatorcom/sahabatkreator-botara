import { describe, expect, it } from "vitest";
import type { Database } from "@sahabat-kreator/db";
import { handleMidtransWebhook, handleXenditWebhook } from "./payments";

/**
 * Jalur uang harus gagal-tertutup (fail closed).
 *
 * Test ini hanya menyentuh validasi paling awal: payload cacat harus
 * ditolak SEBELUM satu pun query berjalan. Itu sebabnya `db` di sini
 * sengaja objek kosong — kalau handler menyentuh database, test gagal
 * dengan TypeError, dan kita tahu urutan pemeriksaannya rusak.
 *
 * Verifikasi signature yang sesungguhnya butuh konfigurasi provider
 * terenkripsi per tenant; itu dicakup verify integrasi, bukan unit test.
 */
const untouchedDb = {} as Database;

describe("webhook Midtrans", () => {
  it("menolak payload kosong sebagai malformed tanpa menyentuh DB", async () => {
    const result = await handleMidtransWebhook(untouchedDb, undefined, {});
    expect(result.outcome).toBe("malformed");
    expect(result.tenantId).toBeNull();
  });

  it("menolak payload yang kehilangan signature_key", async () => {
    const result = await handleMidtransWebhook(untouchedDb, undefined, {
      order_id: "PL-123",
      status_code: "200",
      gross_amount: "50000.00",
      transaction_status: "settlement",
    });
    expect(result.outcome).toBe("malformed");
  });

  it("menolak payload yang kehilangan gross_amount", async () => {
    const result = await handleMidtransWebhook(untouchedDb, undefined, {
      order_id: "PL-123",
      status_code: "200",
      signature_key: "abc",
      transaction_status: "settlement",
    });
    expect(result.outcome).toBe("malformed");
  });

  it("menolak tipe non-objek", async () => {
    for (const payload of [null, undefined, "teks", 42, []]) {
      const result = await handleMidtransWebhook(untouchedDb, undefined, payload);
      expect(result.outcome).toBe("malformed");
    }
  });
});

describe("webhook Xendit", () => {
  it("menolak payload tanpa external_id", async () => {
    const result = await handleXenditWebhook(untouchedDb, undefined, "token", {
      status: "PAID",
      amount: 50000,
    });
    expect(result.outcome).toBe("malformed");
  });

  it("menolak amount yang bukan angka", async () => {
    const result = await handleXenditWebhook(untouchedDb, undefined, "token", {
      external_id: "PL-123",
      status: "PAID",
      amount: "50000",
    });
    expect(result.outcome).toBe("malformed");
  });

  it("menolak payload kosong", async () => {
    const result = await handleXenditWebhook(untouchedDb, undefined, null, {});
    expect(result.outcome).toBe("malformed");
  });
});
