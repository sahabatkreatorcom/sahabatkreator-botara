import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  MEDIA_ORPHAN_GRACE_MS,
  pruneExpiredMedia,
  pruneMediaWithMissingObjects,
  pruneUnreferencedMedia,
  runMediaGcCycle,
  sweepOrphanMediaObjects,
} from "./media-gc";
import { createMemoryMediaStore } from "./media-storage";
import {
  createTestDb,
  TEST_TENANT_B_ID,
  TEST_TENANT_ID,
  type TestDb,
} from "./testing/pglite";

/**
 * Pembersihan media (Fase 19), diuji pada Postgres sungguhan (PGlite).
 *
 * Yang dibuktikan bukan "GC menghapus sesuatu", melainkan bahwa ia
 * TIDAK menghapus yang salah:
 *   1. berkas yang masih dirujuk tidak pernah tersapu, sekalipun usianya
 *      sudah lama;
 *   2. berkas yang baru ditulis tidak tersapu masa tenggang — barisnya
 *      bisa sedang dalam perjalanan ke database;
 *   3. penyimpanan yang tidak terpasang (semua berkas "hilang") TIDAK
 *      menghapus seluruh baris media: GC menolak dan melaporkannya;
 *   4. retensi tidak menghapus lampiran pesan yang masih menunggu
 *      dikirim, karena itu mengubah pesan yang akan terkirim menjadi
 *      gagal permanen.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-07T03:00:00Z");

let test: TestDb;
let pglite: PGlite;
let conversationByTenant: Map<string, string>;

const CHANNEL_A = "a0000000-0000-4000-8000-000000000001";
const CHANNEL_B = "a0000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  test = await createTestDb();
  pglite = test.pglite;

  conversationByTenant = new Map();
  for (const [tenantId, channelId] of [
    [TEST_TENANT_ID, CHANNEL_A],
    [TEST_TENANT_B_ID, CHANNEL_B],
  ] as const) {
    const contactId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    await pglite.query(
      `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
       VALUES ($1, $2, 'whatsapp', $3, 'connected')`,
      [channelId, tenantId, `phone-${channelId.slice(-1)}`],
    );
    await pglite.query(
      `INSERT INTO contacts (id, tenant_id, phone, name)
       VALUES ($1, $2, $3, 'Kontak GC')`,
      [contactId, tenantId, `+62812${channelId.slice(-1)}`],
    );
    await pglite.query(
      `INSERT INTO conversations
         (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
       VALUES ($1, $2, $3, $4, 'whatsapp', $5, 'private', 'open')`,
      [conversationId, tenantId, channelId, contactId, `chat-${channelId.slice(-1)}`],
    );
    conversationByTenant.set(tenantId, conversationId);
  }
});

afterAll(async () => {
  await test.close();
});

beforeEach(async () => {
  // Media dirujuk pesan lewat FK SET NULL, jadi pesan dihapus lebih dulu.
  await pglite.query(`DELETE FROM messages`);
  await pglite.query(`DELETE FROM media`);
});

async function seedMedia(opts: {
  tenantId?: string;
  key: string;
  createdAt?: Date;
  bytes?: string;
  store?: ReturnType<typeof createMemoryMediaStore>;
}): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = opts.createdAt ?? NOW;
  await pglite.query(
    `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes, created_at, updated_at)
     VALUES ($1, $2, $3, 'berkas.jpg', 'image/jpeg', 10, $4, $4)`,
    [id, opts.tenantId ?? TEST_TENANT_ID, opts.key, createdAt.toISOString()],
  );
  if (opts.store) {
    await opts.store.put(opts.key, Buffer.from(opts.bytes ?? "isi"), "image/jpeg");
  }
  return id;
}

async function seedMessage(opts: {
  tenantId?: string;
  status?: string;
  mediaId?: string | null;
  createdAt?: Date;
}): Promise<string> {
  const tenantId = opts.tenantId ?? TEST_TENANT_ID;
  const id = crypto.randomUUID();
  await pglite.query(
    `INSERT INTO messages
       (id, tenant_id, conversation_id, direction, sender_type, type, content_text,
        status, media_id, created_at)
     VALUES ($1, $2, $3, 'outbound', 'user', 'image', 'lihat', $4, $5, $6)`,
    [
      id,
      tenantId,
      conversationByTenant.get(tenantId),
      opts.status ?? "sent",
      opts.mediaId ?? null,
      (opts.createdAt ?? NOW).toISOString(),
    ],
  );
  return id;
}

async function countMedia(): Promise<number> {
  const rows = await pglite.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM media`,
  );
  return rows.rows[0]?.n ?? 0;
}

function key(tenantId: string, name: string): string {
  return `tenants/${tenantId}/media/2026-11/${name}`;
}

describe("sweepOrphanMediaObjects", () => {
  it("menghapus berkas tanpa baris, membiarkan yang masih dirujuk", async () => {
    const store = createMemoryMediaStore();
    const referenced = key(TEST_TENANT_ID, "dirujuk.jpg");
    const orphan = key(TEST_TENANT_ID, "yatim.jpg");
    await seedMedia({ key: referenced, createdAt: NOW, store });
    // Berkas yatim: ada di penyimpanan, tidak ada barisnya. Usianya
    // sudah melewati tenggang supaya layak dihapus.
    await store.put(orphan, Buffer.from("yatim"), "image/jpeg");
    store.objects.get(orphan)!.lastModified = new Date(
      NOW.getTime() - MEDIA_ORPHAN_GRACE_MS - 1000,
    );

    const result = await sweepOrphanMediaObjects(test.db, store, { now: NOW });

    expect(result.deleted).toBe(1);
    expect(await store.exists(orphan)).toBe(false);
    // Yang masih dirujuk TIDAK boleh tersentuh berapa pun usianya.
    expect(await store.exists(referenced)).toBe(true);
    expect(await countMedia()).toBe(1);
  });

  it("melewati berkas yang belum melewati masa tenggang", async () => {
    // Objek ditulis SEBELUM barisnya. Sapuan yang kebetulan berjalan di
    // jendela itu tidak boleh menghapus berkas yang barisnya baru masuk
    // sedetik kemudian.
    const store = createMemoryMediaStore();
    const fresh = key(TEST_TENANT_ID, "baru.jpg");
    await store.put(fresh, Buffer.from("baru"), "image/jpeg");

    const result = await sweepOrphanMediaObjects(test.db, store, { now: NOW });

    expect(result.deleted).toBe(0);
    expect(result.skippedRecent).toBe(1);
    expect(await store.exists(fresh)).toBe(true);
  });

  it("tidak menyentuh key di bawah tenants/ yang tata letaknya asing", async () => {
    // Berkas sisa versi lama (atau fitur lain) yang kebetulan berada di
    // bawah `tenants/` tetapi bukan `tenants/{uuid}/...`. Menghapusnya
    // karena "tidak ada barisnya" berarti GC media berhak menghapus data
    // yang bukan miliknya.
    const store = createMemoryMediaStore();
    const asing = "tenants/legacy/2026/laporan.csv";
    await store.put(asing, Buffer.from("x"), "text/csv");
    store.objects.get(asing)!.lastModified = new Date(NOW.getTime() - 10 * DAY);

    const result = await sweepOrphanMediaObjects(test.db, store, { now: NOW });

    expect(result.skippedUnknown).toBe(1);
    expect(result.deleted).toBe(0);
    expect(await store.exists(asing)).toBe(true);
  });

  it("menyapu berkas tenant yang barisnya sudah tidak ada", async () => {
    // Tenant dihapus → baris media ikut cascade, berkasnya tetap. Justru
    // inilah kebocoran yang paling lama tidak terlihat.
    const store = createMemoryMediaStore();
    const sisa = key(TEST_TENANT_B_ID, "sisa.jpg");
    await store.put(sisa, Buffer.from("sisa"), "image/jpeg");
    store.objects.get(sisa)!.lastModified = new Date(NOW.getTime() - 5 * DAY);

    const result = await sweepOrphanMediaObjects(test.db, store, { now: NOW });

    expect(result.deleted).toBe(1);
    expect(await store.exists(sisa)).toBe(false);
  });
});

describe("pruneMediaWithMissingObjects", () => {
  it("menghapus baris yang berkasnya hilang", async () => {
    const store = createMemoryMediaStore();
    const ada = key(TEST_TENANT_ID, "ada.jpg");
    const hilang = key(TEST_TENANT_ID, "hilang.jpg");
    await seedMedia({ key: ada, store });
    await seedMedia({ key: hilang }); // baris ada, berkas tidak pernah ditulis

    const result = await pruneMediaWithMissingObjects(test.db, store);

    expect(result.kind).toBe("pruned");
    if (result.kind !== "pruned") return;
    expect(result.missing).toBe(1);
    expect(result.deleted).toBe(1);
    expect(await countMedia()).toBe(1);
  });

  it("MENOLAK menghapus saat hampir semua berkas 'hilang'", async () => {
    // Ciri penyimpanan tidak ter-mount: semua baris tampak tanpa berkas.
    // Tanpa penjaga, satu salah konfigurasi menghapus seluruh riwayat
    // media tenant.
    const store = createMemoryMediaStore();
    for (let i = 0; i < 20; i += 1) {
      await seedMedia({ key: key(TEST_TENANT_ID, `hilang-${i}.jpg`) });
    }

    const result = await pruneMediaWithMissingObjects(test.db, store);

    expect(result.kind).toBe("aborted_ratio");
    expect(result.deleted).toBe(0);
    // Tidak satu baris pun hilang.
    expect(await countMedia()).toBe(20);
  });
});

describe("pruneUnreferencedMedia", () => {
  it("menghapus media tanpa pesan setelah tenggang, beserta berkasnya", async () => {
    const store = createMemoryMediaStore();
    const dipakai = key(TEST_TENANT_ID, "dipakai.jpg");
    const menganggur = key(TEST_TENANT_ID, "menganggur.jpg");
    const dipakaiId = await seedMedia({
      key: dipakai,
      createdAt: new Date(NOW.getTime() - 30 * DAY),
      store,
    });
    await seedMedia({
      key: menganggur,
      createdAt: new Date(NOW.getTime() - 30 * DAY),
      store,
    });
    await seedMessage({ mediaId: dipakaiId });

    const result = await pruneUnreferencedMedia(test.db, store, { now: NOW });

    expect(result.deleted).toBe(1);
    expect(result.objectsDeleted).toBe(1);
    expect(await store.exists(menganggur)).toBe(false);
    expect(await store.exists(dipakai)).toBe(true);
    expect(await countMedia()).toBe(1);
  });

  it("membiarkan media yang belum melewati tenggang", async () => {
    // Agen mengunggah lampiran lalu menutup tab sebelum menekan kirim.
    // Seminggu kemudian barulah wajar dianggap sampah.
    const store = createMemoryMediaStore();
    const baru = key(TEST_TENANT_ID, "baru.jpg");
    await seedMedia({
      key: baru,
      createdAt: new Date(NOW.getTime() - DAY),
      store,
    });

    const result = await pruneUnreferencedMedia(test.db, store, { now: NOW });

    expect(result.scanned).toBe(0);
    expect(result.deleted).toBe(0);
    expect(await countMedia()).toBe(1);
  });
});

describe("pruneExpiredMedia", () => {
  it("tidak melakukan apa pun saat retensi 0 (default)", async () => {
    const store = createMemoryMediaStore();
    await seedMedia({
      key: key(TEST_TENANT_ID, "tua.jpg"),
      createdAt: new Date(NOW.getTime() - 400 * DAY),
      store,
    });

    const result = await pruneExpiredMedia(test.db, store, {
      retentionDays: 0,
      now: NOW,
    });

    expect(result.kind).toBe("disabled");
    expect(await countMedia()).toBe(1);
  });

  it("menghapus media tua tetapi MEMPERTAHANKAN yang menunggu dikirim", async () => {
    const store = createMemoryMediaStore();
    const tuaSaja = key(TEST_TENANT_ID, "tua.jpg");
    const tuaAntre = key(TEST_TENANT_ID, "antre.jpg");
    const tuaSajaId = await seedMedia({
      key: tuaSaja,
      createdAt: new Date(NOW.getTime() - 400 * DAY),
      store,
    });
    const tuaAntreId = await seedMedia({
      key: tuaAntre,
      createdAt: new Date(NOW.getTime() - 400 * DAY),
      store,
    });
    await seedMessage({ mediaId: tuaSajaId, status: "sent" });
    await seedMessage({ mediaId: tuaAntreId, status: "queued" });

    const result = await pruneExpiredMedia(test.db, store, {
      retentionDays: 90,
      now: NOW,
    });

    expect(result.kind).toBe("pruned");
    if (result.kind !== "pruned") return;
    expect(result.deleted).toBe(1);
    expect(result.keptQueued).toBe(1);
    expect(await store.exists(tuaAntre)).toBe(true);
    expect(await store.exists(tuaSaja)).toBe(false);
  });

  it("pesan tetap ada setelah medianya dihapus", async () => {
    // Retensi menghapus BERKAS, bukan percakapan. Pesan dan caption-nya
    // harus tetap terbaca — kalau tidak, retensi berarti menghapus
    // riwayat pelanggan.
    const store = createMemoryMediaStore();
    const mediaId = await seedMedia({
      key: key(TEST_TENANT_ID, "tua.jpg"),
      createdAt: new Date(NOW.getTime() - 400 * DAY),
      store,
    });
    const messageId = await seedMessage({ mediaId, status: "sent" });

    await pruneExpiredMedia(test.db, store, { retentionDays: 90, now: NOW });

    const rows = await pglite.query<{ content_text: string; media_id: string | null }>(
      `SELECT content_text, media_id FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows.rows[0]?.content_text).toBe("lihat");
    // FK `set null`: rujukan hilang, pesannya tidak.
    expect(rows.rows[0]?.media_id).toBeNull();
  });
});

describe("runMediaGcCycle", () => {
  it("menjalankan keempat jalur dalam satu putaran", async () => {
    const store = createMemoryMediaStore();
    const dirujuk = key(TEST_TENANT_ID, "dirujuk.jpg");
    const yatim = key(TEST_TENANT_ID, "yatim.jpg");
    const dirujukId = await seedMedia({
      key: dirujuk,
      createdAt: new Date(NOW.getTime() - 400 * DAY),
      store,
    });
    await seedMessage({ mediaId: dirujukId, status: "sent" });
    await store.put(yatim, Buffer.from("yatim"), "image/jpeg");
    store.objects.get(yatim)!.lastModified = new Date(NOW.getTime() - 3 * DAY);

    const summary = await runMediaGcCycle(test.db, store, { now: NOW });

    expect(summary.missing.kind).toBe("pruned");
    expect(summary.orphans.deleted).toBe(1);
    // Retensi default mati: media tua yang masih dirujuk tetap ada.
    expect(summary.retention.kind).toBe("disabled");
    expect(await store.exists(dirujuk)).toBe(true);
    expect(await store.exists(yatim)).toBe(false);
  });
});
