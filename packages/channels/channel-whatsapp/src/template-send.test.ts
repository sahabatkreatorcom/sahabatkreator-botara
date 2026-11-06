import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppCloudClient } from "./index";

/**
 * Bentuk payload template (Fase 17).
 *
 * Yang dijaga di sini adalah URUTAN dan BENTUK komponen yang diterima
 * Meta — bukan sekadar "tidak melempar". Kesalahan di sini tidak
 * terlihat di test core (yang menguji sampai baris antrean), dan di
 * produksi muncul sebagai `failed` dengan kode Graph yang tidak
 * menjelaskan apa pun.
 *
 * Meta memvalidasi PER KOMPONEN: template ber-header `{{1}}` yang
 * dikirim dengan komponen body saja ditolak meski jumlah parameternya
 * "benar" bila dihitung sebagai satu daftar.
 */

function clientWithCapture(): {
  client: WhatsAppCloudClient;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.uji" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const client = new WhatsAppCloudClient({ accessToken: "token-uji" });
  return { client, calls };
}

function componentsOf(call: Record<string, unknown>): unknown {
  const template = call.template as { components?: unknown } | undefined;
  return template?.components;
}

describe("payload template WhatsApp per komponen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tidak mengirim komponen sama sekali untuk template tanpa variabel", async () => {
    const { client, calls } = clientWithCapture();
    await client.sendTemplateMessage({
      phoneNumberId: "pn-1",
      to: "628111",
      templateName: "promo",
      languageCode: "id",
      bodyParams: [],
    });
    // Array kosong ditolak Meta sebagai parameter-mismatch; absennya
    // komponen justru yang benar.
    expect(componentsOf(calls[0]!)).toBeUndefined();
  });

  it("menyusun header → body → button sesuai urutan Meta", async () => {
    const { client, calls } = clientWithCapture();
    await client.sendTemplateMessage({
      phoneNumberId: "pn-1",
      to: "628111",
      templateName: "resi",
      languageCode: "id",
      headerParams: ["INV-42"],
      bodyParams: ["Rina", "INV-42"],
      buttonParams: [{ index: 1, text: "INV-42" }],
    });
    expect(componentsOf(calls[0]!)).toEqual([
      { type: "header", parameters: [{ type: "text", text: "INV-42" }] },
      {
        type: "body",
        parameters: [
          { type: "text", text: "Rina" },
          { type: "text", text: "INV-42" },
        ],
      },
      {
        type: "button",
        sub_type: "url",
        // String, bukan angka: Graph membaca `index` sebagai string dan
        // menolak tipe yang salah.
        index: "1",
        parameters: [{ type: "text", text: "INV-42" }],
      },
    ]);
  });

  it("hanya mengirim komponen header bila body tidak ber-variabel", async () => {
    const { client, calls } = clientWithCapture();
    await client.sendTemplateMessage({
      phoneNumberId: "pn-1",
      to: "628111",
      templateName: "judul",
      languageCode: "id",
      headerParams: ["Promo"],
      bodyParams: [],
    });
    expect(componentsOf(calls[0]!)).toEqual([
      { type: "header", parameters: [{ type: "text", text: "Promo" }] },
    ]);
  });
});
