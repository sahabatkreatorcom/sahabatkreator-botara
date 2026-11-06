import { describe, expect, it } from "vitest";
import {
  parseWhatsAppWebhookEvents,
  whatsAppMediaRef,
} from "./index";

/**
 * Referensi media pada webhook WhatsApp (Fase 18).
 *
 * Sampai fase ini parser hanya memungut `caption` dan membuang `id`.
 * Akibatnya foto pelanggan tidak bisa diambil sama sekali — bahkan
 * secara manual — karena URL unduhan Meta hanya hidup ±5 menit dan
 * media id adalah satu-satunya kunci yang bertahan. Test di bawah
 * mengunci id, mime, dan nama berkas itu.
 */

function payload(message: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "1234567890" },
              contacts: [{ wa_id: "62812", profile: { name: "Pelanggan" } }],
              messages: [
                {
                  from: "62812",
                  id: "wamid.1",
                  timestamp: "1793870000",
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("whatsAppMediaRef", () => {
  it("mengambil id + mime gambar", () => {
    expect(
      whatsAppMediaRef("image", {
        image: { id: "media-1", mime_type: "image/JPEG", caption: "rusak" },
      }),
    ).toEqual({ id: "media-1", mimeType: "image/jpeg", fileName: null });
  });

  it("menyertakan nama berkas untuk dokumen", () => {
    expect(
      whatsAppMediaRef("document", {
        document: {
          id: "media-2",
          mime_type: "application/pdf",
          filename: "invoice.pdf",
        },
      }),
    ).toEqual({
      id: "media-2",
      mimeType: "application/pdf",
      fileName: "invoice.pdf",
    });
  });

  it("mengembalikan null untuk pesan teks", () => {
    expect(whatsAppMediaRef("text", {})).toBeNull();
  });

  it("mengembalikan null bila id tidak ada — bentuk yang tidak bisa diunduh", () => {
    expect(whatsAppMediaRef("image", { image: { caption: "tanpa id" } })).toBeNull();
    expect(whatsAppMediaRef("image", { image: { id: "   " } })).toBeNull();
  });
});

describe("parseWhatsAppWebhookEvents — media", () => {
  it("meneruskan referensi media pada pesan gambar", () => {
    const parsed = parseWhatsAppWebhookEvents(
      payload({
        type: "image",
        image: { id: "media-9", mime_type: "image/jpeg", caption: "kerusakan" },
      }),
    );
    expect(parsed.messages[0]).toMatchObject({
      type: "image",
      text: "kerusakan",
      media: { id: "media-9", mimeType: "image/jpeg", fileName: null },
    });
  });

  it("pesan teks tidak membawa media", () => {
    const parsed = parseWhatsAppWebhookEvents(
      payload({ type: "text", text: { body: "halo" } }),
    );
    expect(parsed.messages[0]?.media).toBeNull();
  });

  it("sticker ikut terangkut (sebelumnya hanya caption yang dipertahankan)", () => {
    const parsed = parseWhatsAppWebhookEvents(
      payload({
        type: "sticker",
        sticker: { id: "media-sticker", mime_type: "image/webp" },
      }),
    );
    expect(parsed.messages[0]?.media).toEqual({
      id: "media-sticker",
      mimeType: "image/webp",
      fileName: null,
    });
  });
});
