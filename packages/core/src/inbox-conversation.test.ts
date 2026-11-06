import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  computeMessagingWindow,
  MESSAGING_WINDOW_MS,
} from "./messaging-window";
import {
  listMessagesPage,
  queueOutboundMessage,
  queueTemplateMessage,
  setConversationAgentEnabled,
  setConversationStatus,
} from "./conversations";
import { createTestDb, seedContact, TEST_TENANT_ID, type TestDb } from "./testing/pglite";

/**
 * Tiga lubang inbox yang ditutup Fase 16C, diuji pada Postgres sungguhan
 * (PGlite) — bukan pada tiruan.
 *
 *   1. `agent_enabled` hanya pernah ditulis `false` (handoff flow & tool
 *      agent). Tanpa jalur balik, satu serah-terima mematikan AI untuk
 *      kontak itu SELAMANYA.
 *   2. `status` hanya bisa dibaca; filter "closed" selalu kosong karena
 *      tidak ada jalan menutup percakapan.
 *   3. Jendela 24 jam WhatsApp tidak pernah diperiksa saat membalas
 *      manual — pesan diantrekan lalu ditolak provider.
 *
 * Ketiganya punya satu sifat yang sama: kegagalannya SENYAP. Karena itu
 * yang diuji di sini bukan hanya hasil akhirnya, tetapi juga bahwa tidak
 * ada tulisan yang terjadi saat permintaan ditolak (untuk jendela) dan
 * bahwa audit tidak mencatat perubahan yang tidak terjadi.
 */

const USER_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_ID = "44444444-4444-4444-8444-444444444444";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const CONVERSATION_WEBCHAT_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_CHANNEL_ID = "88888888-8888-4888-8888-888888888888";
const TEMPLATE_APPROVED_ID = "99999999-9999-4999-8999-999999999991";
const TEMPLATE_PENDING_ID = "99999999-9999-4999-8999-999999999992";
const TEMPLATE_OTHER_ACCOUNT_ID = "99999999-9999-4999-8999-999999999993";

const HOUR = 60 * 60 * 1000;

describe("computeMessagingWindow", () => {
  const now = new Date("2026-11-06T12:00:00Z");

  it("membuka jendela WhatsApp selama pesan masuk terakhir < 24 jam", () => {
    const state = computeMessagingWindow(
      "whatsapp",
      new Date(now.getTime() - 23 * HOUR),
      now,
    );
    expect(state).toMatchObject({ enforced: true, open: true });
    // Masuk terakhir 05 Nov 13:00Z → jendela menutup 06 Nov 13:00Z.
    expect(state.expiresAt?.toISOString()).toBe("2026-11-06T13:00:00.000Z");
  });

  it("menutup jendela WhatsApp setelah 24 jam", () => {
    const state = computeMessagingWindow(
      "whatsapp",
      new Date(now.getTime() - 25 * HOUR),
      now,
    );
    expect(state).toMatchObject({ enforced: true, open: false });
  });

  it("menutup jendela WhatsApp bila kontak belum pernah menulis", () => {
    // Tidak ada pesan masuk = tidak ada jendela. Ini juga yang menangkap
    // percakapan yang dibuat dari API sebelum kontak pernah membalas.
    expect(computeMessagingWindow("whatsapp", null, now)).toMatchObject({
      enforced: true,
      open: false,
      lastInboundAt: null,
      expiresAt: null,
    });
  });

  it("tidak menegakkan jendela pada provider tanpa aturan itu", () => {
    // Telegram & webchat tidak punya batas 24 jam; menegakkannya di sana
    // akan MEMBLOKIR balasan yang sebenarnya sah.
    for (const provider of ["telegram", "webchat"] as const) {
      expect(computeMessagingWindow(provider, null, now)).toMatchObject({
        enforced: false,
        open: true,
      });
      expect(
        computeMessagingWindow(provider, new Date(now.getTime() - 400 * HOUR), now)
          .open,
      ).toBe(true);
    }
  });

  it("memakai batas 24 jam yang sama dengan broadcast", () => {
    expect(MESSAGING_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("mutasi percakapan & jendela pesan (Postgres sungguhan)", () => {
  let test: TestDb;
  let pglite: PGlite;

  async function insertMessage(opts: {
    conversationId: string;
    direction: "inbound" | "outbound";
    createdAt: string;
    contentText?: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await pglite.query(
      `INSERT INTO messages
         (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'text', $6, $7, $8)`,
      [
        id,
        TEST_TENANT_ID,
        opts.conversationId,
        opts.direction,
        opts.direction === "inbound" ? "contact" : "user",
        opts.contentText ?? "halo",
        opts.direction === "inbound" ? "received" : "sent",
        opts.createdAt,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    test = await createTestDb();
    pglite = test.pglite;

    await pglite.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      USER_ID,
      "uji@example.com",
    ]);
    await pglite.query(
      `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
       VALUES ($1, $2, 'whatsapp', 'phone-uji', 'connected')`,
      [CHANNEL_ID, TEST_TENANT_ID],
    );
    await seedContact(pglite, TEST_TENANT_ID, {
      id: CONTACT_ID,
      phone: "+6281200000000",
    });
    await pglite.query(
      `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, status, agent_enabled)
       VALUES
         ($1, $2, $3, $4, 'whatsapp', 'open', true),
         ($5, $2, $3, $4, 'webchat', 'open', true)`,
      [CONVERSATION_ID, TEST_TENANT_ID, CHANNEL_ID, CONTACT_ID, CONVERSATION_WEBCHAT_ID],
    );
    // Akun WhatsApp KEDUA di tenant yang sama: template milik WABA lain
    // tidak boleh bisa dikirim lewat nomor percakapan ini.
    await pglite.query(
      `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
       VALUES ($1, $2, 'whatsapp', 'phone-lain', 'connected')`,
      [OTHER_CHANNEL_ID, TEST_TENANT_ID],
    );
    await pglite.query(
      `INSERT INTO whatsapp_templates
         (id, tenant_id, channel_account_id, name, language, category, status, body_text, variable_count)
       VALUES
         ($1, $2, $3, 'pesanan_dikirim', 'id', 'UTILITY', 'APPROVED', 'Halo {{1}}, pesanan {{2}} sedang dikirim.', 2),
         ($4, $2, $3, 'promo_menunggu', 'id', 'MARKETING', 'PENDING', 'Promo {{1}}', 1),
         ($5, $2, $6, 'pesanan_akun_lain', 'id', 'UTILITY', 'APPROVED', 'Halo {{1}}', 1)`,
      [
        TEMPLATE_APPROVED_ID,
        TEST_TENANT_ID,
        CHANNEL_ID,
        TEMPLATE_PENDING_ID,
        TEMPLATE_OTHER_ACCOUNT_ID,
        OTHER_CHANNEL_ID,
      ],
    );
  }, 120_000);

  afterAll(async () => {
    await test.close();
  });

  it("menutup percakapan: status berubah dan audit tercatat", async () => {
    const result = await setConversationStatus(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      "closed",
    );
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.conversation.status).toBe("closed");

    const audits = await pglite.query<{ meta: { from: string; to: string } }>(
      `SELECT meta FROM audit_logs
        WHERE action = 'conversation.status_changed' AND actor_id = $1`,
      [USER_ID],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.meta).toMatchObject({ from: "open", to: "closed" });
  });

  it("menulis status yang sama TIDAK menambah audit palsu", async () => {
    // Idempoten: tanpa ini, setiap klik pada nilai yang sudah aktif
    // meninggalkan jejak "berubah" yang membingungkan saat menelusuri
    // riwayat.
    await setConversationStatus(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      "closed",
    );
    const audits = await pglite.query(
      `SELECT 1 FROM audit_logs WHERE action = 'conversation.status_changed'`,
    );
    expect(audits.rows).toHaveLength(1);
  });

  it("menyalakan kembali AI setelah handoff (lubang utama)", async () => {
    // Tiru keadaan setelah handoff: agent_enabled = false.
    await pglite.query(
      `UPDATE conversations SET agent_enabled = false WHERE id = $1`,
      [CONVERSATION_ID],
    );

    const result = await setConversationAgentEnabled(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      true,
    );
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    expect(result.conversation.agentEnabled).toBe(true);

    const audits = await pglite.query<{ meta: { previousAgentEnabled: boolean } }>(
      `SELECT meta FROM audit_logs WHERE action = 'conversation.agent_enabled'`,
    );
    expect(audits.rows).toHaveLength(1);
    // Nilai SEBELUMNYA ikut dicatat — pertanyaan "kenapa AI diam?" hanya
    // bisa dijawab kalau arah perubahannya tersimpan.
    expect(audits.rows[0]?.meta).toMatchObject({ previousAgentEnabled: false });
  });

  it("menolak balasan WhatsApp di luar jendela 24 jam TANPA menulis pesan", async () => {
    // Pesan masuk terakhir 30 jam lalu.
    await insertMessage({
      conversationId: CONVERSATION_ID,
      direction: "inbound",
      createdAt: new Date(Date.now() - 30 * HOUR).toISOString(),
    });

    const before = await pglite.query(`SELECT count(*)::int AS n FROM messages`);
    const result = await queueOutboundMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { contentText: "halo" },
    );
    expect(result.kind).toBe("messaging_window_closed");
    const after = await pglite.query(`SELECT count(*)::int AS n FROM messages`);
    expect(after.rows).toEqual(before.rows);
  });

  it("mengizinkan balasan WhatsApp di dalam jendela 24 jam", async () => {
    await insertMessage({
      conversationId: CONVERSATION_ID,
      direction: "inbound",
      createdAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    });

    const result = await queueOutboundMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { contentText: "siap, kak" },
    );
    expect(result.kind).toBe("queued");
  });

  it("tidak pernah memblokir webchat meski lama sepi", async () => {
    // Webchat tidak punya aturan jendela — satu-satunya pesan masuknya
    // berumur 10 hari dan balasan harus tetap lolos.
    await insertMessage({
      conversationId: CONVERSATION_WEBCHAT_ID,
      direction: "inbound",
      createdAt: new Date(Date.now() - 240 * HOUR).toISOString(),
    });
    const result = await queueOutboundMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_WEBCHAT_ID,
      { contentText: "halo lagi" },
    );
    expect(result.kind).toBe("queued");
  });

  it("halaman pesan mundur tanpa celah meski timestamp-nya sama", async () => {
    const conv = crypto.randomUUID();
    await pglite.query(
      `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider)
       VALUES ($1, $2, $3, $4, 'telegram')`,
      [conv, TEST_TENANT_ID, CHANNEL_ID, CONTACT_ID],
    );
    // Lima pesan dengan timestamp IDENTIK — keadaan nyata saat webhook
    // beruntun masuk dalam milidetik yang sama. Kursor berbasis
    // created_at saja akan melewati sebagian di antaranya.
    const sameTime = new Date("2026-11-01T00:00:00Z").toISOString();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await insertMessage({
          conversationId: conv,
          direction: "inbound",
          createdAt: sameTime,
          contentText: `pesan-${i}`,
        }),
      );
    }

    const first = await listMessagesPage(test.db, { tenantId: TEST_TENANT_ID }, conv, {
      limit: 2,
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.messages).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const second = await listMessagesPage(test.db, { tenantId: TEST_TENANT_ID }, conv, {
      limit: 2,
      before: first.messages[0]!.id,
    });
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.messages).toHaveLength(2);

    const third = await listMessagesPage(test.db, { tenantId: TEST_TENANT_ID }, conv, {
      limit: 2,
      before: second.messages[0]!.id,
    });
    expect(third.kind).toBe("ok");
    if (third.kind !== "ok") return;
    expect(third.messages).toHaveLength(1);
    expect(third.hasMore).toBe(false);

    // Kelima pesan terlihat tepat sekali — tidak ada yang hilang di batas
    // halaman, tidak ada yang terduplikasi.
    const seen = [
      ...first.messages,
      ...second.messages,
      ...third.messages,
    ].map((m) => m.id);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("mengirim template saat jendela 24 jam tertutup — satu-satunya jalan keluar", async () => {
    // Pesan masuk terakhir 30 jam lalu: teks bebas ditolak (test di atas),
    // template justru dikecualikan dari aturan itu oleh Meta.
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { templateId: TEMPLATE_APPROVED_ID, bodyParams: ["Rina", "INV-42"] },
    );
    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") return;
    expect(result.message.type).toBe("template");
    // Pratinjau ter-render: inbox menampilkan content_text apa adanya, jadi
    // "{{1}}" mentah akan terlihat seperti pesan yang belum jadi.
    expect(result.message.contentText).toBe(
      "Halo Rina, pesanan INV-42 sedang dikirim.",
    );

    const rows = await pglite.query<{
      template_payload: {
        name: string;
        languageCode: string;
        bodyParams: string[];
      };
    }>(`SELECT template_payload FROM messages WHERE id = $1`, [
      result.message.id,
    ]);
    // Muatan inilah yang dibaca poller untuk memanggil Meta — tanpa ini
    // pesan hanya teks yang tidak akan pernah dikirim sebagai template.
    expect(rows.rows[0]?.template_payload).toMatchObject({
      name: "pesanan_dikirim",
      languageCode: "id",
      bodyParams: ["Rina", "INV-42"],
    });
  });

  it("menolak template yang belum disetujui Meta", async () => {
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { templateId: TEMPLATE_PENDING_ID, bodyParams: ["Rina"] },
    );
    // Status dibawa serta supaya UI bisa menjelaskan apa yang sedang
    // ditunggu, bukan sekadar "gagal".
    expect(result).toMatchObject({
      kind: "template_not_approved",
      status: "PENDING",
    });
  });

  it("menolak template milik akun WhatsApp lain", async () => {
    // Keduanya milik tenant yang SAMA, jadi RLS tidak menolong: template
    // WABA lain hanya bisa dikirim lewat nomor WABA itu.
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { templateId: TEMPLATE_OTHER_ACCOUNT_ID, bodyParams: ["Rina"] },
    );
    expect(result.kind).toBe("template_not_found");
  });

  it("menolak jumlah variabel yang tidak cocok TANPA menulis pesan", async () => {
    const before = await pglite.query(`SELECT count(*)::int AS n FROM messages`);
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { templateId: TEMPLATE_APPROVED_ID, bodyParams: ["Rina"] },
    );
    expect(result).toMatchObject({
      kind: "template_params_invalid",
      expected: 2,
      received: 1,
    });
    const after = await pglite.query(`SELECT count(*)::int AS n FROM messages`);
    expect(after.rows).toEqual(before.rows);
  });

  it("menolak template untuk provider yang tidak memakai template", async () => {
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_WEBCHAT_ID,
      { templateId: TEMPLATE_APPROVED_ID, bodyParams: ["Rina", "INV-42"] },
    );
    expect(result.kind).toBe("provider_unsupported");
  });

  it("kursor yang bukan pesan percakapan ini ditolak terang-terangan", async () => {
    const page = await listMessagesPage(
      test.db,
      { tenantId: TEST_TENANT_ID },
      CONVERSATION_WEBCHAT_ID,
      { limit: 10, before: "99999999-9999-4999-8999-999999999999" },
    );
    // Bukan "sudah sampai awal" — itu akan menyembunyikan bug pemanggil.
    expect(page.kind).toBe("invalid_cursor");
  });
});
