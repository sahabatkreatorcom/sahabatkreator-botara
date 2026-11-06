import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { listQueuedMetaDeliveries } from "./meta";
import { listQueuedTelegramDeliveries } from "./telegram";
import {
  createTestDb,
  seedContact,
  TEST_TENANT_ID,
  type TestDb,
} from "./testing/pglite";

/**
 * Pemindaian antrean pengiriman lintas tenant (Fase 16G).
 *
 * Kedua pemindai memakai pola yang sama dan cacat yang sama: alamat
 * tujuan diambil dari `coalesce(conversations.provider_chat_id,
 * channel_identities.external_user_id)`, tetapi identitasnya diambil
 * lewat INNER JOIN. Artinya percakapan yang SUDAH punya alamat pasti
 * (`provider_chat_id`) tetap dibuang bila baris identitasnya tidak ada —
 * pesan berakhir `queued` selamanya tanpa satu pun error.
 *
 * Satu cacat lagi yang tidak kelihatan sampai diuji: `channel_identities`
 * tidak punya unique index pada (channel_account_id, contact_id), jadi
 * JOIN menggandakan baris pesan untuk kontak dengan lebih dari satu
 * identitas. Dengan `limit` 25, beberapa kontak saja bisa menahan
 * seluruh batch.
 */

const WA_CHANNEL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TG_CHANNEL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("pemindaian antrean pengiriman", () => {
  let test: TestDb;
  let pglite: PGlite;

  beforeAll(async () => {
    test = await createTestDb();
    pglite = test.pglite;
    await pglite.query(
      `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
       VALUES
         ($1, $2, 'whatsapp', 'phone-uji', 'connected'),
         ($3, $2, 'telegram', 'bot-uji', 'connected')`,
      [WA_CHANNEL_ID, TEST_TENANT_ID, TG_CHANNEL_ID],
    );
  });

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await pglite.query(`DELETE FROM messages`);
    await pglite.query(`DELETE FROM channel_identities`);
    await pglite.query(`DELETE FROM conversations`);
    await pglite.query(`DELETE FROM contacts`);
  });

  /** Percakapan + satu pesan outbound `queued`, tanpa identitas apa pun. */
  async function seedQueuedConversation(opts: {
    provider: "whatsapp" | "telegram";
    providerChatId: string | null;
    text: string;
    identities?: string[];
  }): Promise<{ conversationId: string; messageId: string }> {
    const contactId = await seedContact(pglite, TEST_TENANT_ID, {
      phone: `+62812${Math.floor(Math.random() * 1e7)}`,
    });
    const channelId = opts.provider === "whatsapp" ? WA_CHANNEL_ID : TG_CHANNEL_ID;
    const conversationId = crypto.randomUUID();
    await pglite.query(
      `INSERT INTO conversations
         (id, tenant_id, channel_account_id, contact_id, provider, status, provider_chat_id)
       VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
      [conversationId, TEST_TENANT_ID, channelId, contactId, opts.provider, opts.providerChatId],
    );
    for (const externalUserId of opts.identities ?? []) {
      await pglite.query(
        `INSERT INTO channel_identities
           (tenant_id, contact_id, channel_account_id, provider, external_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [TEST_TENANT_ID, contactId, channelId, opts.provider, externalUserId],
      );
    }
    const messageId = crypto.randomUUID();
    await pglite.query(
      `INSERT INTO messages
         (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status)
       VALUES ($1, $2, $3, 'outbound', 'user', 'text', $4, 'queued')`,
      [messageId, TEST_TENANT_ID, conversationId, opts.text],
    );
    return { conversationId, messageId };
  }

  it("mengirim percakapan yang punya alamat pasti meski identitasnya tidak ada", async () => {
    // Inilah baris yang dulu tidak pernah terkirim: alamatnya lengkap
    // (PSID tersimpan di percakapan), tetapi tidak ada baris
    // channel_identities — INNER JOIN membuangnya tanpa suara.
    const { messageId } = await seedQueuedConversation({
      provider: "whatsapp",
      providerChatId: "6281234567890",
      text: "Balasan tanpa identitas",
    });

    const rows = await listQueuedMetaDeliveries(test.db);

    expect(rows.map((r) => r.messageId)).toEqual([messageId]);
    expect(rows[0]!.recipientExternalId).toBe("6281234567890");
  });

  it("jatuh ke identitas kontak bila percakapan belum punya provider_chat_id", async () => {
    const { messageId } = await seedQueuedConversation({
      provider: "whatsapp",
      providerChatId: null,
      text: "Alamat dari identitas",
      identities: ["6289999999999"],
    });

    const rows = await listQueuedMetaDeliveries(test.db);

    expect(rows.map((r) => r.messageId)).toEqual([messageId]);
    expect(rows[0]!.recipientExternalId).toBe("6289999999999");
  });

  it("melewati percakapan tanpa alamat sama sekali", async () => {
    // Tanpa provider_chat_id DAN tanpa identitas tidak ada tujuan yang
    // bisa dipanggil. Baris seperti ini tidak boleh menempati slot batch
    // — kalau menempati, ia akan dipindai ulang setiap 2 detik selamanya.
    await seedQueuedConversation({
      provider: "whatsapp",
      providerChatId: null,
      text: "Tidak ada alamat",
    });

    expect(await listQueuedMetaDeliveries(test.db)).toEqual([]);
  });

  it("tidak menggandakan pesan saat kontak punya dua identitas", async () => {
    // Nomor berpindah / identitas ganda: JOIN lama mengembalikan pesan
    // yang sama dua kali. Klaim atomik mencegah kirim ganda, tetapi
    // baris duplikat tetap menghabiskan slot `limit` dan membuat batch
    // 25 pesan hanya berisi belasan pesan nyata.
    const { messageId } = await seedQueuedConversation({
      provider: "whatsapp",
      providerChatId: null,
      text: "Identitas ganda",
      identities: ["6281111111111", "6282222222222"],
    });

    const rows = await listQueuedMetaDeliveries(test.db);

    expect(rows.map((r) => r.messageId)).toEqual([messageId]);
    // Deterministik: identitas terlama, bukan baris sembarang.
    expect(rows[0]!.recipientExternalId).toBe("6281111111111");
  });

  it("memakai aturan yang sama pada pemindai Telegram", async () => {
    const { messageId } = await seedQueuedConversation({
      provider: "telegram",
      providerChatId: "987654321",
      text: "Telegram tanpa identitas",
    });

    const rows = await listQueuedTelegramDeliveries(test.db);

    expect(rows.map((r) => r.messageId)).toEqual([messageId]);
    expect(rows[0]!.chatExternalId).toBe("987654321");
  });
});
