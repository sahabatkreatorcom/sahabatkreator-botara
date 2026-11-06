import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { flushQueuedWebchatMessages } from "./webchat";
import {
  createTestDb,
  seedContact,
  TEST_TENANT_ID,
  type TestDb,
} from "./testing/pglite";

/**
 * Kebenaran pengiriman webchat (Fase 16F).
 *
 * Yang diuji di sini adalah SATU pernyataan yang sebelumnya tidak benar:
 * "`queued` pada webchat berarti pesan belum sampai ke pengunjung".
 *
 * Widget memuat riwayat lewat REST setiap 4 detik dan merender SETIAP
 * pesan yang dikembalikan — statusnya tidak pernah ia baca. Jadi pesan
 * `queued` sudah tampil di layar pengunjung, sementara dashboard
 * menampilkan "Queued" dan agen menyimpulkan balasannya belum keluar.
 * `flushQueuedWebchatMessages` dipanggil dari polling itu sendiri
 * (`via: "widget-poll"`), bukan hanya dari socket connect.
 *
 * Konsekuensi yang dijaga: `queued` yang TERSISA kini benar-benar berarti
 * "pengunjung belum membuka widget", sehingga label "Menunggu pengunjung"
 * di inbox tidak berbohong.
 */

const CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("pengiriman webchat: polling widget = bukti terkirim", () => {
  let test: TestDb;
  let pglite: PGlite;

  beforeAll(async () => {
    test = await createTestDb();
    pglite = test.pglite;
    await seedContact(pglite, TEST_TENANT_ID, { id: CONTACT_ID });
    await pglite.query(
      `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
       VALUES ($1, $2, 'webchat', 'sk_webchat_uji', 'connected')`,
      [CHANNEL_ID, TEST_TENANT_ID],
    );
    await pglite.query(
      `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, status)
       VALUES ($1, $2, $3, $4, 'webchat', 'open')`,
      [CONVERSATION_ID, TEST_TENANT_ID, CHANNEL_ID, CONTACT_ID],
    );
  });

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await pglite.query(`DELETE FROM messages`);
    await pglite.query(`DELETE FROM audit_logs`);
    await pglite.query(
      `UPDATE channel_accounts SET status = 'connected' WHERE id = $1`,
      [CHANNEL_ID],
    );
  });

  async function insertQueued(contentText: string): Promise<string> {
    const id = crypto.randomUUID();
    await pglite.query(
      `INSERT INTO messages
         (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status)
       VALUES ($1, $2, $3, 'outbound', 'agent', 'text', $4, 'queued')`,
      [id, TEST_TENANT_ID, CONVERSATION_ID, contentText],
    );
    return id;
  }

  async function statusOf(id: string): Promise<string> {
    const rows = await pglite.query<{ status: string }>(
      `SELECT status FROM messages WHERE id = $1`,
      [id],
    );
    return rows.rows[0]!.status;
  }

  it("menandai balasan queued sebagai sent dan mencatat pemicunya", async () => {
    const id = await insertQueued("Halo, ada yang bisa dibantu?");

    const flushed = await flushQueuedWebchatMessages(
      test.db,
      { tenantId: TEST_TENANT_ID, conversationId: CONVERSATION_ID },
      { via: "widget-poll" },
    );

    expect(flushed.map((m) => m.id)).toEqual([id]);
    expect(await statusOf(id)).toBe("sent");

    // Audit harus bisa membedakan "pengunjung connect lewat socket" dari
    // "widget memuat riwayat" — dua jalur berbeda saat menelusuri insiden.
    const audit = await pglite.query<{ meta: { via: string; messageIds: string[] } }>(
      `SELECT meta FROM audit_logs WHERE action = 'message.sent'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.meta.via).toBe("widget-poll");
    expect(audit.rows[0]!.meta.messageIds).toEqual([id]);
  });

  it("membedakan pemicu socket dari pemicu polling", async () => {
    await insertQueued("Balasan kedua");
    await flushQueuedWebchatMessages(test.db, {
      tenantId: TEST_TENANT_ID,
      conversationId: CONVERSATION_ID,
    });
    // Tanpa opsi `via`, perilaku lama (socket connect) dipertahankan.
    const audit = await pglite.query<{ meta: { via: string } }>(
      `SELECT meta FROM audit_logs WHERE action = 'message.sent'`,
    );
    expect(audit.rows[0]!.meta.via).toBe("ws-connect-flush");
  });

  it("tidak menandai apa pun saat channel sedang terputus", async () => {
    // Gerbang disconnect: pesan tidak hilang dan tidak dianggap terkirim.
    // Kalau ini bocor, pengunjung yang membuka widget pada channel mati
    // akan melihat "sent" untuk pesan yang tidak pernah bisa dikirim.
    await pglite.query(
      `UPDATE channel_accounts SET status = 'disconnected' WHERE id = $1`,
      [CHANNEL_ID],
    );
    const id = await insertQueued("Menunggu channel hidup");

    const flushed = await flushQueuedWebchatMessages(
      test.db,
      { tenantId: TEST_TENANT_ID, conversationId: CONVERSATION_ID },
      { via: "widget-poll" },
    );

    expect(flushed).toEqual([]);
    expect(await statusOf(id)).toBe("queued");
  });

  it("tidak mengulang pesan yang sudah terkirim pada polling berikutnya", async () => {
    await insertQueued("Sekali saja");
    const first = await flushQueuedWebchatMessages(
      test.db,
      { tenantId: TEST_TENANT_ID, conversationId: CONVERSATION_ID },
      { via: "widget-poll" },
    );
    const second = await flushQueuedWebchatMessages(
      test.db,
      { tenantId: TEST_TENANT_ID, conversationId: CONVERSATION_ID },
      { via: "widget-poll" },
    );

    expect(first).toHaveLength(1);
    // Polling berjalan tiap 4 detik; kalau ini tidak kosong, setiap poll
    // menulis audit `message.sent` palsu untuk pesan yang sama.
    expect(second).toEqual([]);
  });
});
