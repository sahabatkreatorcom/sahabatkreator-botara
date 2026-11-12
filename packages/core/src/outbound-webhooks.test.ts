import { describe, expect, it } from "vitest";
import {
  buildOutboundWebhookSignatureHeader,
  generateOutboundWebhookSecret,
  isPublicIpAddress,
  signOutboundWebhookPayload,
  validateOutboundWebhookUrl,
  verifyOutboundWebhookSignature,
} from "./outbound-webhooks";

/**
 * Uji unit murni G11: tanda tangan HMAC pola Stripe + gerbang
 * anti-SSRF. Tanpa DB — perilaku integrasi penuh dibuktikan
 * verify:outbound-webhooks di worker.
 */

describe("tanda tangan webhook keluar", () => {
  it("v1 adalah HMAC-SHA256 atas `t.body` dan terverifikasi ulang dari body mentah", () => {
    const secret = "whsec_uji";
    const body = JSON.stringify({ id: "d1", type: "message.received" });
    const header = buildOutboundWebhookSignatureHeader(secret, 1_700_000_000, body);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyOutboundWebhookSignature(secret, body, header)).toBe(true);
  });

  it("body yang diubah, secret salah, dan header rusak semuanya ditolak", () => {
    const secret = "whsec_uji";
    const body = "{\"a\":1}";
    const header = buildOutboundWebhookSignatureHeader(secret, 42, body);
    expect(verifyOutboundWebhookSignature(secret, "{\"a\":2}", header)).toBe(false);
    expect(verifyOutboundWebhookSignature("whsec_lain", body, header)).toBe(false);
    expect(verifyOutboundWebhookSignature(secret, body, "bukan-header")).toBe(false);
    expect(verifyOutboundWebhookSignature(secret, body, "t=abc,v1=00")).toBe(false);
  });

  it("timestamp ikut tertandatangani — mengganti t menggagalkan verifikasi", () => {
    const secret = "whsec_uji";
    const body = "x";
    const sig = signOutboundWebhookPayload(secret, 100, body);
    expect(verifyOutboundWebhookSignature(secret, body, `t=101,v1=${sig}`)).toBe(false);
  });

  it("secret yang dihasilkan berawalan whsec_ dan unik", () => {
    const a = generateOutboundWebhookSecret();
    const b = generateOutboundWebhookSecret();
    expect(a.startsWith("whsec_")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("klasifikasi alamat IP publik", () => {
  it("menolak privat/loopback/link-local/CGNAT/dokumentasi/multicast", () => {
    for (const ip of [
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "192.0.2.10",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fc00::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "::ffff:10.1.2.3",
    ]) {
      expect(isPublicIpAddress(ip), ip).toBe(false);
    }
  });

  it("menerima alamat publik v4/v6 termasuk IPv4-mapped publik", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPublicIpAddress(ip), ip).toBe(true);
    }
  });

  it("menolak string yang bukan IP", () => {
    expect(isPublicIpAddress("bukan-ip")).toBe(false);
    expect(isPublicIpAddress("999.1.1.1")).toBe(false);
  });
});

describe("validasi URL anti-SSRF", () => {
  const publicResolver = async () => ["93.184.216.34"];
  const mixedResolver = async () => ["93.184.216.34", "10.0.0.1"];
  const failingResolver = async () => {
    throw new Error("ENOTFOUND");
  };

  it("menerima https dengan resolusi publik", async () => {
    const res = await validateOutboundWebhookUrl(
      "https://hooks.example.com/botara",
      publicResolver,
    );
    expect(res.ok).toBe(true);
  });

  it("menolak http dan skema lain", async () => {
    expect(
      (await validateOutboundWebhookUrl("http://hooks.example.com", publicResolver)).ok,
    ).toBe(false);
    const res = await validateOutboundWebhookUrl(
      "http://hooks.example.com",
      publicResolver,
    );
    expect(res).toEqual({ ok: false, code: "WEBHOOK_URL_NOT_HTTPS" });
  });

  it("menolak literal IP privat tanpa memanggil resolver", async () => {
    const res = await validateOutboundWebhookUrl(
      "https://169.254.169.254/latest/meta-data",
      failingResolver,
    );
    expect(res).toEqual({ ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" });
  });

  it("menolak literal IPv6 berbungkus kurung siku tanpa memanggil resolver", async () => {
    const res = await validateOutboundWebhookUrl(
      "https://[::1]/x",
      failingResolver,
    );
    expect(res).toEqual({ ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" });
    const ula = await validateOutboundWebhookUrl(
      "https://[fd00::1]/x",
      failingResolver,
    );
    expect(ula).toEqual({ ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" });
  });

  it("menolak localhost dan resolusi yang CAMPURAN privat (rebinding)", async () => {
    expect(
      (await validateOutboundWebhookUrl("https://localhost:8443/x", publicResolver)).ok,
    ).toBe(false);
    const res = await validateOutboundWebhookUrl(
      "https://hooks.example.com",
      mixedResolver,
    );
    expect(res).toEqual({ ok: false, code: "WEBHOOK_URL_UNSAFE_HOST" });
  });

  it("menolak resolusi gagal dan kredensial di URL", async () => {
    expect(
      (await validateOutboundWebhookUrl("https://hooks.example.com", failingResolver)).ok,
    ).toBe(false);
    const res = await validateOutboundWebhookUrl(
      "https://user:pass@hooks.example.com",
      publicResolver,
    );
    expect(res).toEqual({ ok: false, code: "WEBHOOK_URL_INVALID" });
  });
});
