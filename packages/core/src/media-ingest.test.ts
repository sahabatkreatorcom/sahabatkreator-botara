import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { encryptChannelSecret } from "./channel-secrets";
import {
  MEDIA_INGEST_MAX_ATTEMPTS,
  ingestMessageMedia,
  listPendingMediaIngestions,
  runMediaIngestCycle,
  type MediaIngestDeps,
} from "./media";
import { createMemoryMediaStore } from "./media-storage";
import {
  createTestDb,
  TEST_TENANT_B_ID,
  TEST_TENANT_ID,
  type TestDb,
} from "./testing/pglite";

/**
 * Ingest media masuk (Fase 18), diuji pada Postgres sungguhan (PGlite).
 *
 * Yang dibuktikan bukan hanya "berkas tersimpan", tetapi tiga sifat yang
 * membuat fase ini layak ada:
 *   1. media id yang dibuang parser lama benar-benar bisa dipulihkan
 *      menjadi berkas (baris `media` + `media_id` terisi);
 *   2. kegagalan unduh TIDAK menghilangkan pesan — pesan sudah ada
 *      sebelum ingest, dan yang berubah hanya penghitung percobaan;
 *   3. media yang gagal selamanya BERHENTI dicoba setelah batas,
 *      bukan dipindai tiap siklus sampai kapan pun.
 */

const SECRET = Buffer.alloc(32, 7).toString("base64");
const CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MESSAGE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MESSAGE_TEXT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let test: TestDb;
let pglite: PGlite;

beforeAll(async () => {
  test = await createTestDb();
  pglite = test.pglite;
  await pglite.query(
    `INSERT INTO channel_accounts
       (id, tenant_id, provider, external_id, display_name, status,
        access_token_encrypted, webhook_secret)
     VALUES ($1, $2, 'whatsapp', '1234567890', 'Nomor Uji', 'connected', $3, 'x')`,
    [CHANNEL_ID, TEST_TENANT_ID, encryptChannelSecret(SECRET, "token-uji")],
  );
  await pglite.query(
    `INSERT INTO contacts (id, tenant_id, phone, name) VALUES ($1, $2, '+62812', 'Pelanggan')`,
    [CONTACT_ID, TEST_TENANT_ID],
  );
  await pglite.query(
    `INSERT INTO conversations
       (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
     VALUES ($1, $2, $3, $4, 'whatsapp', '62812', 'private', 'open')`,
    [CONVERSATION_ID, TEST_TENANT_ID, CHANNEL_ID, CONTACT_ID],
  );
  await pglite.query(
    `INSERT INTO messages
       (id, tenant_id, conversation_id, direction, sender_type, type, content_text,
        provider_media_id, provider_media_mime, provider_media_file_name, status)
     VALUES ($1, $2, $3, 'inbound', 'contact', 'image', 'kerusakan',
             'media-abc', 'image/jpeg', NULL, 'received')`,
    [MESSAGE_ID, TEST_TENANT_ID, CONVERSATION_ID],
  );
  await pglite.query(
    `INSERT INTO messages
       (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status)
     VALUES ($1, $2, $3, 'inbound', 'contact', 'text', 'halo', 'received')`,
    [MESSAGE_TEXT_ID, TEST_TENANT_ID, CONVERSATION_ID],
  );
});

afterAll(async () => {
  await test.close();
});

function deps(
  overrides: Partial<MediaIngestDeps> = {},
): MediaIngestDeps & { store: ReturnType<typeof createMemoryMediaStore> } {
  const store = createMemoryMediaStore();
  return {
    store,
    channelTokenSecret: SECRET,
    fetchMedia: async () => ({
      data: Buffer.from("isi-gambar"),
      mimeType: "image/jpeg",
    }),
    ...overrides,
  } as MediaIngestDeps & { store: ReturnType<typeof createMemoryMediaStore> };
}

describe("listPendingMediaIngestions", () => {
  it("hanya memindai pesan yang punya referensi media tetapi belum tersimpan", async () => {
    const pending = await listPendingMediaIngestions(test.db, 50);
    const ids = pending.map((p) => p.messageId);
    expect(ids).toContain(MESSAGE_ID);
    // Pesan teks tidak pernah ikut — tanpa penyaring ini pindai akan
    // menyentuh seluruh tabel pesan tiap siklus.
    expect(ids).not.toContain(MESSAGE_TEXT_ID);
  });
});

describe("ingestMessageMedia", () => {
  it("mengunduh, menyimpan, dan menautkan media ke pesan", async () => {
    const d = deps();
    const outcome = await ingestMessageMedia(test.db, d, {
      tenantId: TEST_TENANT_ID,
      messageId: MESSAGE_ID,
    });
    expect(outcome.kind).toBe("stored");

    const [row] = (
      await pglite.query<{
        media_id: string | null;
        mime: string | null;
        size: number;
        key: string;
        file_name: string | null;
      }>(
        `SELECT m.media_id, md.mime_type AS mime, md.size_bytes AS size,
                md.r2_key AS key, md.file_name
           FROM messages m JOIN media md ON md.id = m.media_id
          WHERE m.id = $1`,
        [MESSAGE_ID],
      )
    ).rows;
    expect(row?.media_id).toBeTruthy();
    expect(row?.mime).toBe("image/jpeg");
    expect(row?.size).toBe(Buffer.from("isi-gambar").length);
    // Key tidak memakai nama berkas dari pengirim — hanya uuid.
    expect(row?.key).toMatch(
      /^tenants\/[0-9a-f-]+\/media\/\d{4}-\d{2}\/[0-9a-f-]{36}\.jpg$/,
    );

    // Byte-nya benar-benar tersimpan di object store.
    const stored = await d.store.get(row!.key);
    expect(stored?.data.toString()).toBe("isi-gambar");
    expect(stored?.contentType).toBe("image/jpeg");

    // Sudah tertaut → siklus berikutnya tidak memindainya lagi.
    const pending = await listPendingMediaIngestions(test.db, 50);
    expect(pending.map((p) => p.messageId)).not.toContain(MESSAGE_ID);
  });

  it("melewati pesan yang sudah punya media", async () => {
    const outcome = await ingestMessageMedia(test.db, deps(), {
      tenantId: TEST_TENANT_ID,
      messageId: MESSAGE_ID,
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "already_stored" });
  });

  it("melewati pesan tanpa referensi media", async () => {
    const outcome = await ingestMessageMedia(test.db, deps(), {
      tenantId: TEST_TENANT_ID,
      messageId: MESSAGE_TEXT_ID,
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "no_media_ref" });
  });
});

describe("kegagalan ingest", () => {
  const FAIL_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  beforeAll(async () => {
    await pglite.query(
      `INSERT INTO messages
         (id, tenant_id, conversation_id, direction, sender_type, type, content_text,
          provider_media_id, provider_media_mime, status)
       VALUES ($1, $2, $3, 'inbound', 'contact', 'document', NULL,
               'media-gagal', 'application/pdf', 'received')`,
      [FAIL_ID, TEST_TENANT_ID, CONVERSATION_ID],
    );
  });

  it("tidak melempar dan tetap mempertahankan pesan saat unduhan gagal", async () => {
    const outcome = await ingestMessageMedia(
      test.db,
      deps({
        fetchMedia: async () => {
          throw new Error("media_download_failed");
        },
      }),
      { tenantId: TEST_TENANT_ID, messageId: FAIL_ID },
    );
    expect(outcome).toMatchObject({ kind: "failed", attempts: 1 });

    const [row] = (
      await pglite.query<{ content_text: string | null; media_id: string | null; err: string | null }>(
        `SELECT content_text, media_id, media_ingest_error AS err
           FROM messages WHERE id = $1`,
        [FAIL_ID],
      )
    ).rows;
    // Pesan TIDAK hilang — hanya medianya yang belum ada.
    expect(row?.media_id).toBeNull();
    expect(row?.err).toContain("media_download_failed");
  });

  it("memberi jarak antar-percobaan — kegagalan sesaat tidak menghabiskan jatah", async () => {
    // Tanpa jarak, siklus worker 5 dtk menghabiskan 5 percobaan dalam
    // 25 detik; gangguan jaringan semenit sudah cukup membuat media
    // hilang permanen padahal berkasnya masih ada di Meta.
    const outcome = await ingestMessageMedia(
      test.db,
      deps({
        fetchMedia: async () => {
          throw new Error("media_download_failed");
        },
      }),
      { tenantId: TEST_TENANT_ID, messageId: FAIL_ID },
    );
    expect(outcome.kind).toBe("failed");

    // Baru gagal sedetik lalu → TIDAK boleh langsung dipindai lagi.
    const pendingNow = await listPendingMediaIngestions(test.db, 50);
    expect(pendingNow.map((p) => p.messageId)).not.toContain(FAIL_ID);

    // Setelah jeda lewat, baris kembali masuk antrean percobaan.
    await pglite.query(
      `UPDATE messages
          SET media_ingest_attempted_at = now() - interval '10 minutes'
        WHERE id = $1`,
      [FAIL_ID],
    );
    const pendingLater = await listPendingMediaIngestions(test.db, 50);
    expect(pendingLater.map((p) => p.messageId)).toContain(FAIL_ID);

    // Kembalikan ke keadaan "baru gagal" agar test berikutnya
    // (batas percobaan) tidak terpengaruh.
    await pglite.query(
      `UPDATE messages SET media_ingest_attempted_at = now() WHERE id = $1`,
      [FAIL_ID],
    );
  });

  it("berhenti dipindai setelah MEDIA_INGEST_MAX_ATTEMPTS", async () => {
    // Test ini menguji BATAS, bukan akumulasi dari test sebelumnya —
    // jadi keadaan awalnya ditetapkan eksplisit (1 percobaan sudah
    // terpakai, jeda sudah lewat) agar tidak bergantung urutan.
    await pglite.query(
      `UPDATE messages
          SET media_ingest_attempts = 1,
              media_ingest_attempted_at = now() - interval '10 minutes'
        WHERE id = $1`,
      [FAIL_ID],
    );
    // Sisa percobaan sampai batas.
    for (let i = 1; i < MEDIA_INGEST_MAX_ATTEMPTS; i += 1) {
      await ingestMessageMedia(
        test.db,
        deps({
          fetchMedia: async () => {
            throw new Error("media_download_failed");
          },
        }),
        { tenantId: TEST_TENANT_ID, messageId: FAIL_ID },
      );
    }
    const [row] = (
      await pglite.query<{ attempts: number }>(
        `SELECT media_ingest_attempts AS attempts FROM messages WHERE id = $1`,
        [FAIL_ID],
      )
    ).rows;
    expect(row?.attempts).toBe(MEDIA_INGEST_MAX_ATTEMPTS);

    // Inti perbaikan: baris yang sudah menyerah TIDAK menempati slot
    // pindai selamanya.
    const pending = await listPendingMediaIngestions(test.db, 50);
    expect(pending.map((p) => p.messageId)).not.toContain(FAIL_ID);
  });

  it("mencatat media yang kosong sebagai kegagalan, bukan berkas 0 byte", async () => {
    const emptyId = "11111111-2222-4333-8444-555555555555";
    await pglite.query(
      `INSERT INTO messages
         (id, tenant_id, conversation_id, direction, sender_type, type,
          provider_media_id, status)
       VALUES ($1, $2, $3, 'inbound', 'contact', 'audio', 'media-kosong', 'received')`,
      [emptyId, TEST_TENANT_ID, CONVERSATION_ID],
    );
    const outcome = await ingestMessageMedia(
      test.db,
      deps({
        fetchMedia: async () => ({ data: Buffer.alloc(0), mimeType: "audio/ogg" }),
      }),
      { tenantId: TEST_TENANT_ID, messageId: emptyId },
    );
    expect(outcome).toMatchObject({ kind: "failed", reason: "media_empty" });
  });
});

describe("recordWhatsAppInboundMessage — referensi media", () => {
  it("menyimpan media id, mime, dan nama berkas di baris pesan", async () => {
    const { recordWhatsAppInboundMessage } = await import("./whatsapp");
    const recorded = await recordWhatsAppInboundMessage(
      test.db,
      { id: CHANNEL_ID, tenantId: TEST_TENANT_ID, externalId: "1234567890" },
      {
        senderWaId: "62899",
        contactName: "Pengirim Foto",
        providerMessageId: "wamid.media-1",
        type: "document",
        text: null,
        media: {
          id: "media-dok-1",
          mimeType: "application/pdf",
          fileName: "nota.pdf",
        },
      },
    );
    expect(recorded?.duplicate).toBe(false);

    const [row] = (
      await pglite.query<{
        provider_media_id: string | null;
        provider_media_mime: string | null;
        provider_media_file_name: string | null;
      }>(
        `SELECT provider_media_id, provider_media_mime, provider_media_file_name
           FROM messages WHERE id = $1`,
        [recorded!.message.id],
      )
    ).rows;
    // Inti Fase 18: tanpa tiga kolom ini, berkas pelanggan hilang
    // permanen begitu request selesai.
    expect(row?.provider_media_id).toBe("media-dok-1");
    expect(row?.provider_media_mime).toBe("application/pdf");
    expect(row?.provider_media_file_name).toBe("nota.pdf");

    // Dan baris itu memang muncul di antrean ingest.
    const pending = await listPendingMediaIngestions(test.db, 50);
    expect(pending.map((p) => p.messageId)).toContain(recorded!.message.id);
  });

  it("pesan teks tidak meninggalkan referensi media apa pun", async () => {
    const { recordWhatsAppInboundMessage } = await import("./whatsapp");
    const recorded = await recordWhatsAppInboundMessage(
      test.db,
      { id: CHANNEL_ID, tenantId: TEST_TENANT_ID, externalId: "1234567890" },
      {
        senderWaId: "62899",
        contactName: "Pengirim Teks",
        providerMessageId: "wamid.text-1",
        type: "text",
        text: "halo",
      },
    );
    const [row] = (
      await pglite.query<{ provider_media_id: string | null }>(
        `SELECT provider_media_id FROM messages WHERE id = $1`,
        [recorded!.message.id],
      )
    ).rows;
    expect(row?.provider_media_id).toBeNull();
  });
});

describe("queueMediaMessage — kirim lampiran", () => {
  const PDF_ID = "44444444-5555-4666-8777-888888888888";
  const PNG_ID = "55555555-6666-4777-8888-999999999999";
  const USER_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

  beforeAll(async () => {
    // `messages.sent_by_user_id` ber-FK ke users — pengirim manual
    // memang harus user nyata.
    await pglite.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      USER_ID,
      "lampiran@example.com",
    ]);
    await pglite.query(
      `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes)
       VALUES ($1, $2, 'tenants/t/media/2026-11/a.pdf', 'invoice.pdf', 'application/pdf', 10),
              ($3, $2, 'tenants/t/media/2026-11/b.png', 'foto.png', 'image/png', 20)`,
      [PDF_ID, TEST_TENANT_ID, PNG_ID],
    );
  });

  it("mengantrekan lampiran dengan jenis pesan dari MIME, bukan dari klien", async () => {
    const { queueMediaMessage } = await import("./conversations");
    const result = await queueMediaMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { mediaId: PDF_ID, caption: "  nota pembelian  " },
    );
    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") return;
    // PDF → document; klien tidak bisa memaksa "image" untuk berkas ini.
    expect(result.message.type).toBe("document");
    expect(result.message.mediaId).toBe(PDF_ID);
    // Caption dipangkas, dan menjadi contentText (satu gelembung, bukan dua).
    expect(result.message.contentText).toBe("nota pembelian");
    expect(result.message.status).toBe("queued");
  });

  it("menerima lampiran tanpa caption", async () => {
    const { queueMediaMessage } = await import("./conversations");
    const result = await queueMediaMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { mediaId: PNG_ID, caption: "   " },
    );
    expect(result.kind).toBe("queued");
    if (result.kind !== "queued") return;
    expect(result.message.type).toBe("image");
    expect(result.message.contentText).toBeNull();
  });

  it("menolak lampiran yang tidak ada di workspace ini", async () => {
    const { queueMediaMessage } = await import("./conversations");
    const result = await queueMediaMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { mediaId: "99999999-9999-4999-8999-999999999998" },
    );
    // Ditolak SEBELUM insert: tanpa ini, pesan `queued` pasti gagal di
    // poller dan baru terlihat sebagai `failed` tanpa sebab.
    expect(result).toEqual({ kind: "media_not_found" });
  });

  it("menolak lampiran milik tenant lain", async () => {
    const otherMedia = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    await pglite.query(
      `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes)
       VALUES ($1, $2, 'tenants/b/media/2026-11/c.png', 'rahasia.png', 'image/png', 5)`,
      [otherMedia, TEST_TENANT_B_ID],
    );
    const { queueMediaMessage } = await import("./conversations");
    const result = await queueMediaMessage(
      test.db,
      { tenantId: TEST_TENANT_ID, userId: USER_ID },
      CONVERSATION_ID,
      { mediaId: otherMedia },
    );
    expect(result).toEqual({ kind: "media_not_found" });
  });
});

describe("runMediaIngestCycle", () => {
  it("tidak berhenti pada satu kegagalan — baris berikutnya tetap diproses", async () => {
    const okId = "22222222-3333-4444-8555-666666666666";
    const badId = "33333333-4444-4555-8666-777777777777";
    for (const [id, mediaId] of [
      [badId, "media-rusak"],
      [okId, "media-baik"],
    ] as const) {
      await pglite.query(
        `INSERT INTO messages
           (id, tenant_id, conversation_id, direction, sender_type, type,
            provider_media_id, provider_media_mime, status)
         VALUES ($1, $2, $3, 'inbound', 'contact', 'image', $4, 'image/png', 'received')`,
        [id, TEST_TENANT_ID, CONVERSATION_ID, mediaId],
      );
    }
    const d = deps({
      fetchMedia: async ({ mediaId }) => {
        if (mediaId === "media-rusak") throw new Error("graph_500");
        return { data: Buffer.from("png"), mimeType: "image/png" };
      },
    });
    const result = await runMediaIngestCycle(test.db, d, 50);
    // Baris baik tetap tersimpan meski ada baris gagal di depannya
    // (urutan created_at ASC → yang gagal lebih dulu).
    expect(result.stored).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const [row] = (
      await pglite.query<{ media_id: string | null }>(
        `SELECT media_id FROM messages WHERE id = $1`,
        [okId],
      )
    ).rows;
    expect(row?.media_id).toBeTruthy();
  });
});
