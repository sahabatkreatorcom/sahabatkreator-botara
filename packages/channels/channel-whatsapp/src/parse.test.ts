import { describe, expect, it } from "vitest";
import { parseWhatsAppWebhookEvents } from "./index";

/**
 * Parser webhook WhatsApp — regresi untuk dua field yang sebelumnya
 * dibuang diam-diam: `smb_message_echoes` (coexistence) dan
 * `message_template_status_update` (status template).
 *
 * Bentuk payload di sini disalin dari referensi Meta, bukan dikarang:
 * kesalahan yang paling mahal di jalur ini adalah membaca `from` pada
 * echo seperti pada `messages` (arahnya terbalik) dan lupa bahwa `to`
 * kadang berawalan '+' — keduanya menghasilkan kontak ganda untuk orang
 * yang sama. Tes ini mengunci keduanya.
 */

function wrap(field: string, value: unknown, wabaId = "102290129340398") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: wabaId, changes: [{ field, value }] }],
  };
}

describe("parseWhatsAppWebhookEvents — pesan masuk (regresi)", () => {
  it("membaca messages[] apa adanya: from = pelanggan", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("messages", {
        messaging_product: "whatsapp",
        metadata: {
          display_phone_number: "15550783881",
          phone_number_id: "106540352242922",
        },
        contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
        messages: [
          {
            from: "16505551234",
            id: "wamid.INBOUND",
            timestamp: "1749416383",
            type: "text",
            text: { body: "Does it come in another color?" },
          },
        ],
      }),
    );

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      senderWaId: "16505551234",
      contactName: "Sheena Nelson",
      providerMessageId: "wamid.INBOUND",
      type: "text",
      text: "Does it come in another color?",
    });
    expect(parsed.echoes).toHaveLength(0);
    expect(parsed.templateStatuses).toHaveLength(0);
  });

  it("caption media tetap menjadi teks", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("messages", {
        metadata: { phone_number_id: "106540352242922" },
        messages: [
          {
            from: "16505551234",
            id: "wamid.IMG",
            type: "image",
            image: { caption: "lihat ini" },
          },
        ],
      }),
    );
    expect(parsed.messages[0]?.type).toBe("image");
    expect(parsed.messages[0]?.text).toBe("lihat ini");
  });
});

describe("parseWhatsAppWebhookEvents — smb_message_echoes", () => {
  it("arah TERBALIK: to = pelanggan, bukan from", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("smb_message_echoes", {
        messaging_product: "whatsapp",
        metadata: {
          display_phone_number: "15550783881",
          phone_number_id: "106540352242922",
        },
        message_echoes: [
          {
            from: "15550783881",
            to: "16505551234",
            id: "wamid.ECHO",
            timestamp: "1739321024",
            type: "text",
            text: { body: "Here's the info you requested!" },
          },
        ],
      }),
    );

    expect(parsed.echoes).toHaveLength(1);
    expect(parsed.echoes[0]).toMatchObject({
      phoneNumberId: "106540352242922",
      toWaId: "16505551234",
      providerMessageId: "wamid.ECHO",
      type: "text",
      text: "Here's the info you requested!",
      isRevoke: false,
      isEdit: false,
    });
    // Nomor bisnis TIDAK boleh muncul sebagai pengirim.
    expect(parsed.echoes[0]?.toWaId).not.toBe("15550783881");
    // Echo bukan pesan masuk.
    expect(parsed.messages).toHaveLength(0);
  });

  it("'to' berawalan '+' dinormalkan supaya tidak jadi kontak ganda", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("smb_message_echoes", {
        metadata: { phone_number_id: "106540352242922" },
        message_echoes: [
          {
            from: "15550783881",
            to: "+16505551234",
            id: "wamid.PLUS",
            type: "text",
            text: { body: "halo" },
          },
        ],
      }),
    );
    expect(parsed.echoes[0]?.toWaId).toBe("16505551234");
  });

  it("revoke dan edit dikenali sebagai penanda, bukan pesan biasa", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("smb_message_echoes", {
        metadata: { phone_number_id: "106540352242922" },
        message_echoes: [
          {
            from: "15550783881",
            to: "16505551234",
            id: "wamid.REVOKE",
            type: "revoke",
            revoke: { original_message_id: "wamid.OLD" },
          },
          {
            from: "15550783881",
            to: "16505551234",
            id: "wamid.EDIT",
            type: "edit",
            edit: {
              original_message_id: "wamid.OLD2",
              message: { type: "image", image: { caption: "caption baru" } },
            },
          },
        ],
      }),
    );

    expect(parsed.echoes[0]?.isRevoke).toBe(true);
    expect(parsed.echoes[1]?.isEdit).toBe(true);
    // Isi hasil edit dibaca dari edit.message, bukan type tingkat atas.
    expect(parsed.echoes[1]?.type).toBe("image");
    expect(parsed.echoes[1]?.text).toBe("caption baru");
  });

  it("echo tanpa 'to' atau tanpa wamid dibuang", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("smb_message_echoes", {
        metadata: { phone_number_id: "106540352242922" },
        message_echoes: [
          { from: "15550783881", id: "wamid.NO_TO", type: "text" },
          { from: "15550783881", to: "16505551234", type: "text" },
        ],
      }),
    );
    expect(parsed.echoes).toHaveLength(0);
  });
});

describe("parseWhatsAppWebhookEvents — message_template_status_update", () => {
  it("membaca event, id, nama, bahasa, dan kategori", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("message_template_status_update", {
        event: "APPROVED",
        message_template_id: 1689556908129832,
        message_template_name: "order_confirmation",
        message_template_language: "en-US",
        reason: "NONE",
        message_template_category: "UTILITY",
      }),
    );

    expect(parsed.templateStatuses).toHaveLength(1);
    expect(parsed.templateStatuses[0]).toMatchObject({
      wabaId: "102290129340398",
      event: "APPROVED",
      templateId: "1689556908129832",
      templateName: "order_confirmation",
      language: "en-US",
      category: "UTILITY",
      reason: "NONE",
      rejectionReason: null,
      rejectionRecommendation: null,
    });
  });

  it("membawa rejection_info saat ditolak", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("message_template_status_update", {
        event: "REJECTED",
        message_template_id: 1689556908129835,
        message_template_name: "abandoned_cart",
        message_template_language: "en",
        reason: "INVALID_FORMAT",
        message_template_category: "MARKETING",
        rejection_info: {
          reason: "Your template has parameters placed next to each other.",
          recommendation: "Separate parameters with descriptive text.",
        },
      }),
    );

    expect(parsed.templateStatuses[0]).toMatchObject({
      event: "REJECTED",
      reason: "INVALID_FORMAT",
      rejectionReason:
        "Your template has parameters placed next to each other.",
      rejectionRecommendation: "Separate parameters with descriptive text.",
    });
  });

  it("event tanpa nama template dibuang (tidak ada yang bisa dicocokkan)", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("message_template_status_update", { event: "APPROVED" }),
    );
    expect(parsed.templateStatuses).toHaveLength(0);
  });
});

describe("parseWhatsAppWebhookEvents — field lain", () => {
  it("field yang belum ditangani tidak menghasilkan event apa pun", () => {
    const parsed = parseWhatsAppWebhookEvents(
      wrap("smb_app_state_sync", {
        metadata: { phone_number_id: "106540352242922" },
        state_sync: [{ type: "contact" }],
      }),
    );
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.statuses).toHaveLength(0);
    expect(parsed.echoes).toHaveLength(0);
    expect(parsed.templateStatuses).toHaveLength(0);
  });

  it("payload bukan whatsapp_business_account diabaikan", () => {
    const parsed = parseWhatsAppWebhookEvents({
      object: "page",
      entry: [{ id: "1", changes: [] }],
    });
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.templateStatuses).toHaveLength(0);
  });
});
