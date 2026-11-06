import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WhatsAppTemplate } from "@sahabat-kreator/db/schema";
import {
  broadcastVariantFor,
  classifyBroadcastCandidate,
  type AudienceCandidate,
} from "./broadcasts";
import { createTestDb, seedContact, TEST_TENANT_ID, type TestDb } from "./testing/pglite";

/**
 * Broadcast: siapa yang BOLEH dikirimi, dan siapa yang tidak boleh
 * dikirimi dua kali.
 *
 * Dua kerusakan yang tidak bisa ditarik kembali setelah terjadi:
 *
 *   1. Mengirim promosi ke kontak yang sudah berhenti berlangganan.
 *      Selain melanggar aturan platform, ini langsung dirasakan
 *      pelanggan sebagai spam.
 *   2. Mengirim pesan yang sama dua kali ke orang yang sama. Dispatch
 *      ulang setelah retry adalah keadaan normal, jadi dedupe harus
 *      dijamin oleh database, bukan oleh ingatan proses.
 *
 * `classifyBroadcastCandidate` adalah satu-satunya gerbang keputusan —
 * fungsi yang sama dipakai pratinjau audiens dan dispatch — sehingga
 * menguji fungsi ini berarti menguji keduanya sekaligus.
 */

/**
 * Cast ini memusatkan pengetahuan tentang kolom template yang dibaca
 * `classifyBroadcastCandidate` ke satu tempat, alih-alih memaksa setiap
 * test membangun baris template lengkap dari database.
 *
 * `components` default kosong: test lama tidak perlu tahu soal komponen.
 * Test yang menguji header/tombol memberikannya eksplisit.
 */
function template(
  variableCount: number,
  bodyText: string | null,
  components: unknown[] = [],
): WhatsAppTemplate {
  return { variableCount, bodyText, components } as unknown as WhatsAppTemplate;
}

function candidate(overrides: Partial<AudienceCandidate> = {}): AudienceCandidate {
  return {
    contactId: "c-1",
    contactName: "Budi",
    customFields: { city: "Bandung" },
    optInStatus: "opted_in",
    optInAt: new Date("2026-01-01T00:00:00Z"),
    externalUserId: "+628111111111",
    conversationId: null,
    lastInboundAt: new Date("2026-11-05T00:00:00Z"),
    ...overrides,
  };
}

const NOW = new Date("2026-11-05T12:00:00Z");

describe("gerbang audiens: template yang broadcast belum bisa isi", () => {
  const base = {
    candidate: candidate(),
    provider: "whatsapp" as const,
    requireOptIn: false,
    templateVariableSources: ["name"],
    now: NOW,
  };

  it("melewati template ber-variabel HEADER dengan alasan yang tepat", () => {
    // Sebelum Fase 17 penerima ini LOLOS lalu pesannya gagal di Meta:
    // header `{{1}}` tidak pernah ikut dikirim. Ribuan `failed` dengan
    // kode Graph yang tidak menjelaskan apa pun.
    const result = classifyBroadcastCandidate({
      ...base,
      waTemplate: template(1, "Halo {{1}}", [
        { type: "HEADER", format: "TEXT", text: "Pesanan {{1}}" },
        { type: "BODY", text: "Halo {{1}}" },
      ]),
    });
    expect(result).toEqual({
      kind: "skip",
      reason: "template_component_unsupported",
    });
  });

  it("melewati template ber-variabel tombol URL", () => {
    const result = classifyBroadcastCandidate({
      ...base,
      waTemplate: template(1, "Halo {{1}}", [
        { type: "BODY", text: "Halo {{1}}" },
        { type: "BUTTONS", buttons: [{ type: "URL", url: "https://a.id/{{1}}" }] },
      ]),
    });
    expect(result).toEqual({
      kind: "skip",
      reason: "template_component_unsupported",
    });
  });

  it("tetap mengirim template yang semua variabelnya di BODY", () => {
    // Penjaga regresi: aturan baru tidak boleh memblokir template biasa,
    // yang justru mayoritas.
    const result = classifyBroadcastCandidate({
      ...base,
      waTemplate: template(1, "Halo {{1}}", [
        { type: "HEADER", format: "TEXT", text: "Promo" },
        { type: "BODY", text: "Halo {{1}}" },
      ]),
    });
    expect(result).toMatchObject({ kind: "send", templateBodyParams: ["Budi"] });
  });
});

describe("gerbang audiens: opt-in dan opt-out", () => {
  it("opt-out selalu dilewati, bahkan bila opt-in dimatikan", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate({ optInStatus: "opted_out" }),
      provider: "telegram",
      requireOptIn: false,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "opted_out" });
  });

  it("kontak tanpa jejak persetujuan dilewati saat opt-in diwajibkan", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate({ optInStatus: "unknown", optInAt: null }),
      provider: "telegram",
      requireOptIn: true,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "not_opted_in" });
  });

  it("jejak opt-in (optInAt) sudah cukup walau status masih unknown", () => {
    // Ini keputusan penting: kontak yang pernah menyetujui lewat kata
    // kunci tidak boleh hilang dari audiens hanya karena kolom status
    // belum diperbarui.
    const result = classifyBroadcastCandidate({
      candidate: candidate({
        optInStatus: "unknown",
        optInAt: new Date("2026-06-01T00:00:00Z"),
      }),
      provider: "telegram",
      requireOptIn: true,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result.kind).toBe("send");
  });

  it("tanpa kewajiban opt-in, kontak unknown tetap dikirimi", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate({ optInStatus: "unknown", optInAt: null }),
      provider: "telegram",
      requireOptIn: false,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result.kind).toBe("send");
  });
});

describe("gerbang audiens: jendela 24 jam Meta", () => {
  it("Messenger di luar 24 jam dilewati", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate({ lastInboundAt: new Date("2026-11-03T00:00:00Z") }),
      provider: "messenger",
      requireOptIn: false,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "outside_24h_window" });
  });

  it("Messenger di dalam 24 jam dikirimi", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate({ lastInboundAt: new Date("2026-11-05T00:00:00Z") }),
      provider: "messenger",
      requireOptIn: false,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result.kind).toBe("send");
  });

  it("Messenger tanpa pesan masuk sama sekali dilewati", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate({ lastInboundAt: null }),
      provider: "instagram",
      requireOptIn: false,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "outside_24h_window" });
  });

  it("jendela 24 jam tidak berlaku untuk Telegram", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate({ lastInboundAt: new Date("2026-10-01T00:00:00Z") }),
      provider: "telegram",
      requireOptIn: false,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result.kind).toBe("send");
  });
});

describe("gerbang audiens: WhatsApp", () => {
  it("tanpa template, penerima dilewati", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate(),
      provider: "whatsapp",
      requireOptIn: false,
      waTemplate: null,
      templateVariableSources: [],
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "template_variable_missing" });
  });

  it("tanpa nomor telepon, penerima dilewati", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate({ externalUserId: "   " }),
      provider: "whatsapp",
      requireOptIn: false,
      waTemplate: template(0, "Halo!"),
      templateVariableSources: [],
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "missing_phone_number" });
  });

  it("memetakan variabel template dari nama dan custom_fields", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate(),
      provider: "whatsapp",
      requireOptIn: false,
      waTemplate: template(2, "Halo {{1}}, promo khusus {{2}}"),
      templateVariableSources: ["name", "city"],
      now: NOW,
    });
    expect(result.kind).toBe("send");
    if (result.kind !== "send") return;
    expect(result.templateBodyParams).toEqual(["Budi", "Bandung"]);
    expect(result.templatePreview).toContain("Budi");
    expect(result.templatePreview).toContain("Bandung");
  });

  it("posisi pertama tanpa sumber jatuh ke nama kontak", () => {
    const result = classifyBroadcastCandidate({
      candidate: candidate(),
      provider: "whatsapp",
      requireOptIn: false,
      waTemplate: template(1, "Halo {{1}}"),
      templateVariableSources: [],
      now: NOW,
    });
    expect(result.kind).toBe("send");
    if (result.kind !== "send") return;
    expect(result.templateBodyParams).toEqual(["Budi"]);
  });

  it("variabel yang tidak punya nilai melewati penerima, bukan mengirim kosong", () => {
    // Mengirim "Halo , promo khusus " ke pelanggan lebih buruk daripada
    // melewatinya: template dengan placeholder kosong ditolak Meta.
    const result = classifyBroadcastCandidate({
      candidate: candidate({ customFields: {} }),
      provider: "whatsapp",
      requireOptIn: false,
      waTemplate: template(2, "Halo {{1}}, promo khusus {{2}}"),
      templateVariableSources: ["name", "city"],
      now: NOW,
    });
    expect(result).toEqual({ kind: "skip", reason: "template_variable_missing" });
  });
});

describe("pembagian varian A/B", () => {
  it("tanpa split yang sah, semua penerima mendapat varian A", () => {
    for (const split of [null, undefined, 0, 100, 12.5]) {
      expect(broadcastVariantFor("bc-1", "c-1", split)).toBe("a");
    }
  });

  it("penentuan varian deterministik untuk penerima yang sama", () => {
    // Penerima yang sama harus SELALU mendapat varian yang sama.
    // Kalau tidak, penerima yang di-dispatch ulang bisa berpindah
    // varian dan hasil eksperimennya tidak bisa dipercaya.
    const first = broadcastVariantFor("bc-1", "c-1", 50);
    for (let i = 0; i < 20; i++) {
      expect(broadcastVariantFor("bc-1", "c-1", 50)).toBe(first);
    }
  });

  it("pembagian mendekati persentase yang diminta", () => {
    const total = 2000;
    let b = 0;
    for (let i = 0; i < total; i++) {
      if (broadcastVariantFor("bc-1", `kontak-${i}`, 30) === "b") b++;
    }
    const share = (b / total) * 100;
    // Toleransi lebar: yang diuji adalah pembagiannya masuk akal,
    // bukan ketepatan algoritma hash.
    expect(share).toBeGreaterThan(22);
    expect(share).toBeLessThan(38);
  });

  it("broadcast berbeda membagi kontak yang sama secara berbeda", () => {
    // Kalau kunci eksperimen tidak memuat broadcastId, satu kontak akan
    // selalu masuk varian yang sama di semua eksperimen — hasilnya bias.
    const variants = new Set(
      Array.from({ length: 20 }, (_, i) =>
        broadcastVariantFor(`bc-${i}`, "kontak-tetap", 50),
      ),
    );
    expect(variants.size).toBeGreaterThan(1);
  });
});

describe("dedupe penerima ditegakkan database", () => {
  let ctx: TestDb;
  let broadcastId: string;
  let contactId: string;

  beforeAll(async () => {
    ctx = await createTestDb();
    contactId = await seedContact(ctx.pglite, TEST_TENANT_ID);
    const channelAccountId = crypto.randomUUID();
    await ctx.pglite.query(
      `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
       VALUES ($1, $2, 'telegram', 'bot-uji', 'connected')`,
      [channelAccountId, TEST_TENANT_ID],
    );
    broadcastId = crypto.randomUUID();
    await ctx.pglite.query(
      `INSERT INTO broadcasts
         (id, tenant_id, channel_account_id, name, message_text, status)
       VALUES ($1, $2, $3, 'Promo Uji', 'Halo semua', 'sending')`,
      [broadcastId, TEST_TENANT_ID, channelAccountId],
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const insertRecipient = (id: string) =>
    ctx.pglite.query(
      `INSERT INTO broadcast_recipients (id, tenant_id, broadcast_id, contact_id, status)
       VALUES ($1, $2, $3, $4, 'queued')`,
      [id, TEST_TENANT_ID, broadcastId, contactId],
    );

  it("satu kontak hanya boleh punya satu baris penerima per broadcast", async () => {
    await insertRecipient(crypto.randomUUID());
    // Dispatch ulang setelah retry menemukan baris yang sudah ada lalu
    // melewatinya. Kalau penjagaan itu gagal, database tetap menolak
    // baris kedua — jadi duplikat tidak bisa terjadi diam-diam.
    await expect(insertRecipient(crypto.randomUUID())).rejects.toThrow(
      /duplicate key|unique/i,
    );
  });
});
