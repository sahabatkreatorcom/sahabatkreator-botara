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
const TEMPLATE_HEADER_ID = "99999999-9999-4999-8999-999999999994";
const TEMPLATE_BUTTON_ID = "99999999-9999-4999-8999-999999999995";
const TEMPLATE_MEDIA_ID = "99999999-9999-4999-8999-999999999996";
const TEMPLATE_DOC_ID = "99999999-9999-4999-8999-999999999997";
const MEDIA_IMAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const MEDIA_PDF_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const MEDIA_AUDIO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

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
    // `components` WAJIB ikut disemai sejak Fase 17: spesifikasi parameter
    // diturunkan dari komponen asli (header/body/tombol), bukan dari
    // `variable_count` yang hanya menghitung BODY. Menyemai tanpa kolom
    // ini akan menguji jalur yang tidak pernah terjadi di produksi —
    // setiap baris cermin Meta selalu membawa komponennya.
    await pglite.query(
      `INSERT INTO whatsapp_templates
         (id, tenant_id, channel_account_id, name, language, category, status,
          body_text, variable_count, components)
       VALUES
         ($1, $2, $3, 'pesanan_dikirim', 'id', 'UTILITY', 'APPROVED',
          'Halo {{1}}, pesanan {{2}} sedang dikirim.', 2,
          '[{"type":"BODY","text":"Halo {{1}}, pesanan {{2}} sedang dikirim."}]'::jsonb),
         ($4, $2, $3, 'promo_menunggu', 'id', 'MARKETING', 'PENDING',
          'Promo {{1}}', 1,
          '[{"type":"BODY","text":"Promo {{1}}"}]'::jsonb),
         ($5, $2, $6, 'pesanan_akun_lain', 'id', 'UTILITY', 'APPROVED',
          'Halo {{1}}', 1,
          '[{"type":"BODY","text":"Halo {{1}}"}]'::jsonb),
         ($7, $2, $3, 'resi_dikirim', 'id', 'UTILITY', 'APPROVED',
          'Halo {{1}}, paket untuk pesanan {{2}} sedang dikirim.', 1,
          '[{"type":"HEADER","format":"TEXT","text":"Pesanan {{1}}"},
            {"type":"BODY","text":"Halo {{1}}, paket untuk pesanan {{2}} sedang dikirim."}]'::jsonb),
         ($8, $2, $3, 'lacak_pesanan', 'id', 'UTILITY', 'APPROVED',
          'Cek status pengiriman pesanan Anda.', 0,
          '[{"type":"BODY","text":"Cek status pengiriman pesanan Anda."},
            {"type":"BUTTONS","buttons":[{"type":"QUICK_REPLY","text":"Batal"},{"type":"URL","text":"Lacak","url":"https://toko.id/lacak/{{1}}"}]}]'::jsonb),
         ($9, $2, $3, 'promo_bergambar', 'id', 'MARKETING', 'APPROVED',
          'Lihat promo bulan ini.', 0,
          '[{"type":"HEADER","format":"IMAGE"},{"type":"BODY","text":"Lihat promo bulan ini."}]'::jsonb),
         ($10, $2, $3, 'katalog_pdf', 'id', 'UTILITY', 'APPROVED',
          'Katalog terbaru kami.', 0,
          '[{"type":"HEADER","format":"DOCUMENT"},{"type":"BODY","text":"Katalog terbaru kami."}]'::jsonb)`,
      [
        TEMPLATE_APPROVED_ID,
        TEST_TENANT_ID,
        CHANNEL_ID,
        TEMPLATE_PENDING_ID,
        TEMPLATE_OTHER_ACCOUNT_ID,
        OTHER_CHANNEL_ID,
        TEMPLATE_HEADER_ID,
        TEMPLATE_BUTTON_ID,
        TEMPLATE_MEDIA_ID,
        TEMPLATE_DOC_ID,
      ],
    );
    // Lampiran untuk header media (Fase 18C). Ketiganya disemai dengan
    // MIME berbeda supaya aturan "format header menentukan jenis berkas"
    // diuji pada data nyata, bukan pada cabang yang tidak pernah tercapai.
    await pglite.query(
      `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes)
       VALUES
         ($1, $4, 'tenants/t/media/2026-11/a.jpg', 'promo.jpg', 'image/jpeg', 1024),
         ($2, $4, 'tenants/t/media/2026-11/b.pdf', 'katalog.pdf', 'application/pdf', 2048),
         ($3, $4, 'tenants/t/media/2026-11/c.mp3', 'nada.mp3', 'audio/mpeg', 512)`,
      [MEDIA_IMAGE_ID, MEDIA_PDF_ID, MEDIA_AUDIO_ID, TEST_TENANT_ID],
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

  it("menolak template ber-header variabel bila headernya tidak diisi", async () => {
    // Inilah dead-end yang ditutup Fase 17: sebelum ini validasi hanya
    // memeriksa BODY, jadi kiriman ini LOLOS dan baru ditolak Meta —
    // pesan menjadi `failed` tanpa kolom untuk memperbaikinya.
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { templateId: TEMPLATE_HEADER_ID, bodyParams: ["Rina", "INV-42"] },
    );
    expect(result).toMatchObject({
      kind: "template_params_invalid",
      component: "header",
      expected: 1,
      received: 0,
    });
  });

  it("mengirim template ber-header dan menyimpan parameternya", async () => {
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      {
        templateId: TEMPLATE_HEADER_ID,
        headerParams: ["INV-42"],
        bodyParams: ["Rina", "INV-42"],
      },
    );
    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") return;
    // Header ikut dirender: inbox menampilkan content_text apa adanya,
    // dan pelanggan menerima header + body.
    expect(result.message.contentText).toBe(
      "Pesanan INV-42\n\nHalo Rina, paket untuk pesanan INV-42 sedang dikirim.",
    );

    const rows = await pglite.query<{
      template_payload: {
        headerParams?: string[];
        bodyParams: string[];
      };
    }>(`SELECT template_payload FROM messages WHERE id = $1`, [
      result.message.id,
    ]);
    // Tanpa headerParams di muatan, poller mengirim komponen body saja —
    // persis kiriman yang ditolak Meta.
    expect(rows.rows[0]?.template_payload.headerParams).toEqual(["INV-42"]);
    expect(rows.rows[0]?.template_payload.bodyParams).toEqual(["Rina", "INV-42"]);
  });

  it("mencocokkan variabel tombol URL berdasarkan INDEX, bukan urutan", async () => {
    // Tombol URL ada di posisi 1 (0-based) karena tombol pertama adalah
    // QUICK_REPLY. Mengirim index 0 berarti mengisi tombol yang salah —
    // jumlahnya sama, jadi pemeriksaan berbasis jumlah akan lolos.
    const wrong = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      {
        templateId: TEMPLATE_BUTTON_ID,
        bodyParams: [],
        buttonParams: [{ index: 0, text: "INV-42" }],
      },
    );
    expect(wrong).toMatchObject({
      kind: "template_params_invalid",
      component: "button",
    });

    const right = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      {
        templateId: TEMPLATE_BUTTON_ID,
        bodyParams: [],
        buttonParams: [{ index: 1, text: "INV-42" }],
      },
    );
    expect(right.kind).toBe("queued");
    if (right.kind !== "queued") return;
    const rows = await pglite.query<{
      template_payload: { buttonParams?: Array<{ index: number; text: string }> };
    }>(`SELECT template_payload FROM messages WHERE id = $1`, [
      right.message.id,
    ]);
    expect(rows.rows[0]?.template_payload.buttonParams).toEqual([
      { index: 1, text: "INV-42" },
    ]);
  });

  it("menolak template ber-header media TANPA lampiran, sebelum masuk antrean", async () => {
    // Header IMAGE butuh berkas, bukan teks. Membiarkannya lolos berarti
    // pesan masuk antrean lalu gagal di poller sebagai `failed` — pengguna
    // melihat kegagalan tanpa cara memperbaikinya.
    const before = await pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE type = 'template'`,
    );
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { templateId: TEMPLATE_MEDIA_ID, bodyParams: [] },
    );
    expect(result).toMatchObject({
      kind: "template_media_header_required",
      format: "IMAGE",
    });
    const after = await pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE type = 'template'`,
    );
    // Tidak ada baris yang ditulis: penolakan terjadi sebelum insert,
    // jadi tidak ada `failed` yang menunggu dibersihkan siapa pun.
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("menolak lampiran yang formatnya tidak cocok dengan header template", async () => {
    // PDF untuk header IMAGE. Meta menolaknya dengan kode yang tidak
    // menjelaskan apa pun ke pengguna, jadi pasangan yang salah harus
    // berhenti di sini — bukan setelah pesan menjadi `failed`.
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      {
        templateId: TEMPLATE_MEDIA_ID,
        bodyParams: [],
        headerMediaId: MEDIA_PDF_ID,
      },
    );
    expect(result).toMatchObject({
      kind: "template_media_header_mismatch",
      format: "IMAGE",
    });
  });

  it("menolak audio untuk header DOCUMENT", async () => {
    // Cloud API tidak punya header AUDIO sama sekali. Tanpa aturan ini,
    // berkas audio lolos sebagai DOCUMENT lalu ditolak Meta.
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      {
        templateId: TEMPLATE_DOC_ID,
        bodyParams: [],
        headerMediaId: MEDIA_AUDIO_ID,
      },
    );
    expect(result).toMatchObject({
      kind: "template_media_header_mismatch",
      format: "DOCUMENT",
    });
  });

  it("menolak lampiran yang bukan milik tenant ini", async () => {
    // RLS menyembunyikan baris tenant lain, tetapi pemeriksaan eksplisit
    // tetap perlu: tanpa itu id sembarang akan lolos sampai ke poller dan
    // gagal di sana sebagai "media_object_missing".
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      {
        templateId: TEMPLATE_MEDIA_ID,
        bodyParams: [],
        headerMediaId: "aaaaaaaa-aaaa-4aaa-8aaa-999999999999",
      },
    );
    expect(result.kind).toBe("media_not_found");
  });

  it("mengirim template ber-header media dengan lampiran yang cocok", async () => {
    const result = await queueTemplateMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      {
        templateId: TEMPLATE_MEDIA_ID,
        bodyParams: [],
        headerMediaId: MEDIA_IMAGE_ID,
      },
    );
    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") return;

    const rows = await pglite.query<{
      template_payload: { headerMediaId?: string; headerParams?: string[] };
    }>(`SELECT template_payload FROM messages WHERE id = $1`, [
      result.message.id,
    ]);
    // Poller butuh id lampiran untuk mengunggahnya ke Meta lebih dulu;
    // tanpa ini header media tidak punya isi dan pesannya gagal.
    expect(rows.rows[0]?.template_payload.headerMediaId).toBe(MEDIA_IMAGE_ID);
    // Header media tidak punya variabel teks — mengirim headerParams
    // kosong akan membuat poller menambah komponen header kedua.
    expect(rows.rows[0]?.template_payload.headerParams ?? []).toEqual([]);
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
