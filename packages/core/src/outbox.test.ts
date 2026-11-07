import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  OUTBOX_MAX_ATTEMPTS,
  pruneOutboxEvents,
  relayUnpublishedOutboxEvents,
} from "./outbox";
import { createTestDb, TEST_TENANT_ID, type TestDb } from "./testing/pglite";

/**
 * Relay outbox — Fase 16D, diuji pada Postgres sungguhan (PGlite).
 *
 * Yang dijaga di sini bukan "handler dipanggil", melainkan sifat yang
 * membuat kegagalan satu event tidak menjatuhkan seluruh pipa:
 *
 *   1. satu handler yang melempar TIDAK menghentikan event lain di batch
 *      yang sama (sebelumnya: seluruh batch rollback, dan karena urutannya
 *      `created_at ASC` event yang sama diambil lagi selamanya — event
 *      yang lebih baru tidak pernah diproses);
 *   2. kegagalan tercatat (`attempts`, `last_error`), bukan hanya di log;
 *   3. setelah `OUTBOX_MAX_ATTEMPTS` event dikarantina dan berhenti
 *      menempati slot batch, TANPA dianggap published.
 *
 * Test pertama meniru bentuk kegagalan yang paling berbahaya: event
 * "beracun" di TENGAH batch. Bila isolasi per event hilang, event ketiga
 * tidak akan pernah ter-relay dan test ini gagal.
 */

const POISON = "flow.step_due";
const HEALTHY = "message.received";

describe("relay outbox: isolasi per event", () => {
  let test: TestDb;
  let pglite: PGlite;
  let sequence = 0;

  async function insertEvent(
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    // created_at eksplisit dan menaik: urutan relay ditentukan waktu, bukan
    // urutan insert, jadi test tidak boleh bergantung pada jam sistem.
    sequence += 1;
    await pglite.query(
      `INSERT INTO outbox_events (id, tenant_id, type, payload, created_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5 * interval '1 millisecond'))`,
      [id, TEST_TENANT_ID, type, JSON.stringify(payload), sequence],
    );
    return id;
  }

  async function row(id: string): Promise<{
    published_at: Date | null;
    attempts: number;
    last_error: string | null;
    dead_lettered_at: Date | null;
  }> {
    const res = await pglite.query<{
      published_at: Date | null;
      attempts: number;
      last_error: string | null;
      dead_lettered_at: Date | null;
    }>(
      `SELECT published_at, attempts, last_error, dead_lettered_at
         FROM outbox_events WHERE id = $1`,
      [id],
    );
    return res.rows[0]!;
  }

  beforeAll(async () => {
    test = await createTestDb();
    pglite = test.pglite;
  }, 120_000);

  afterAll(async () => {
    await test.close();
  });

  // Tiap test mulai dari outbox kosong: sisa event beracun dari test
  // sebelumnya akan ikut terpindai dan membuat hitungan `attempts`
  // menyesatkan — persis jenis kebingungan yang ingin dihindari.
  beforeEach(async () => {
    await pglite.query(`DELETE FROM outbox_events`);
  });

  it("event beracun di tengah batch tidak menahan event sesudahnya", async () => {
    const first = await insertEvent(HEALTHY, { conversationId: "a" });
    const poison = await insertEvent(POISON, { runId: "rusak" });
    const third = await insertEvent(HEALTHY, { conversationId: "c" });

    const handled: string[] = [];
    const result = await relayUnpublishedOutboxEvents(
      test.db,
      async (_tx, event) => {
        if (event.type === POISON) throw new Error("payload rusak permanen");
        handled.push(event.id);
      },
    );

    // Inti perbaikan: DUA event sehat ter-relay, bukan nol.
    expect(handled).toEqual([first, third]);
    expect(result.relayed).toBe(2);
    expect(result.deadLettered).toHaveLength(0);

    expect(await row(first)).toMatchObject({ attempts: 0, last_error: null });
    expect((await row(first)).published_at).not.toBeNull();
    expect((await row(third)).published_at).not.toBeNull();

    const poisonRow = await row(poison);
    expect(poisonRow.published_at).toBeNull();
    expect(poisonRow.attempts).toBe(1);
    // Pesan error disimpan supaya operator tahu SEBABNYA, bukan hanya
    // bahwa "ada yang gagal".
    expect(poisonRow.last_error).toContain("payload rusak permanen");
  });

  it("tidak mengulang event yang sudah ter-relay", async () => {
    const id = await insertEvent(HEALTHY, { conversationId: "sekali" });
    const firstPass: string[] = [];
    await relayUnpublishedOutboxEvents(test.db, async (_tx, event) => {
      firstPass.push(event.id);
    });
    const secondPass: string[] = [];
    await relayUnpublishedOutboxEvents(test.db, async (_tx, event) => {
      secondPass.push(event.id);
    });

    expect(firstPass).toEqual([id]);
    // Sudah published → tidak dipanggil lagi. Tanpa ini, setiap siklus
    // relay akan mengirim ulang job yang sama.
    expect(secondPass).toEqual([]);
  });

  it("mengarantina event setelah batas percobaan, tanpa menganggapnya published", async () => {
    const poison = await insertEvent(POISON, { runId: "rusak-2" });

    const attemptsSeen: number[] = [];
    let deadLetteredAt = 0;
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      const result = await relayUnpublishedOutboxEvents(
        test.db,
        async (_tx, event) => {
          if (event.type === POISON) {
            attemptsSeen.push(event.attempts);
            throw new Error("selalu gagal");
          }
        },
      );
      deadLetteredAt += result.deadLettered.length;
    }

    // Handler melihat hitungan yang NAIK — bukan selalu 0, yang berarti
    // `attempts` tidak pernah tersimpan.
    expect(attemptsSeen).toEqual([0, 1, 2, 3, 4]);
    expect(deadLetteredAt).toBe(1);

    const quarantined = await row(poison);
    expect(quarantined.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(quarantined.dead_lettered_at).not.toBeNull();
    // Dikarantina BUKAN berarti published: operator masih bisa membedakan
    // "sudah diproses" dari "menyerah".
    expect(quarantined.published_at).toBeNull();

    // Dan yang terpenting: tidak dipindai lagi, jadi tidak menempati slot
    // batch selamanya.
    const callsAfterQuarantine: string[] = [];
    await relayUnpublishedOutboxEvents(test.db, async (_tx, event) => {
      callsAfterQuarantine.push(event.id);
    });
    expect(callsAfterQuarantine).not.toContain(poison);
  });

  it("tidak memanggil handler untuk event tingkat sistem tanpa tenant", async () => {
    // Event tanpa tenantId bukan urusan relay (mis. penanda platform):
    // handler di worker melewatinya, tetapi relay tetap menandainya
    // published supaya tidak menumpuk.
    const id = crypto.randomUUID();
    sequence += 1;
    await pglite.query(
      `INSERT INTO outbox_events (id, tenant_id, type, payload, created_at)
       VALUES ($1, NULL, 'platform.tick', '{}'::jsonb, now() + ($2 * interval '1 millisecond'))`,
      [id, sequence],
    );
    const result = await relayUnpublishedOutboxEvents(test.db, async () => {
      /* handler sistem: tidak melakukan apa pun */
    });
    expect(result.relayed).toBe(1);
    expect((await row(id)).published_at).not.toBeNull();
  });
});

/**
 * Retensi outbox (Fase 20).
 *
 * Temuan audit: tabel ini TIDAK PERNAH dihapus sama sekali — bukan hanya
 * baris dead-letter, baris yang sudah terbit pun tidak. Yang diuji di
 * sini adalah batas-batasnya, karena retensi yang salah arah jauh lebih
 * merusak daripada tidak ada retensi:
 *
 *   1. event yang BELUM terbit tidak boleh tersentuh berapa pun usianya —
 *      itu pekerjaan yang belum selesai, bukan sampah;
 *   2. jendela dead-letter harus lebih panjang dari jendela terbit, karena
 *      baris itu bukti kegagalan yang sedang ditelusuri operator;
 *   3. penghapusan berjalan per batch sampai habis, bukan hanya batch
 *      pertama.
 */
describe("retensi outbox_events", () => {
  let test: TestDb;
  let pglite: PGlite;

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date("2026-11-07T03:00:00Z");

  beforeAll(async () => {
    test = await createTestDb();
    pglite = test.pglite;
  }, 120_000);

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await pglite.query(`DELETE FROM outbox_events`);
  });

  async function insertEvent(opts: {
    createdAt: Date;
    publishedAt?: Date | null;
    deadLetteredAt?: Date | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await pglite.query(
      `INSERT INTO outbox_events
         (id, tenant_id, type, payload, created_at, published_at, dead_lettered_at)
       VALUES ($1, $2, 'message.sent', '{}'::jsonb, $3, $4, $5)`,
      [
        id,
        TEST_TENANT_ID,
        opts.createdAt.toISOString(),
        opts.publishedAt ? opts.publishedAt.toISOString() : null,
        opts.deadLetteredAt ? opts.deadLetteredAt.toISOString() : null,
      ],
    );
    return id;
  }

  async function count(): Promise<number> {
    const res = await pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events`,
    );
    return res.rows[0]?.n ?? 0;
  }

  it("membuang baris terbit yang lewat retensi, menyisakan yang baru", async () => {
    await insertEvent({
      createdAt: new Date(NOW.getTime() - 9 * DAY),
      publishedAt: new Date(NOW.getTime() - 8 * DAY),
    });
    await insertEvent({
      createdAt: new Date(NOW.getTime() - 2 * DAY),
      publishedAt: new Date(NOW.getTime() - 1 * DAY),
    });

    const result = await pruneOutboxEvents(test.db, { now: NOW });

    expect(result.publishedDeleted).toBe(1);
    expect(await count()).toBe(1);
  });

  it("TIDAK menyentuh event yang belum terbit, seberapa pun tuanya", async () => {
    // Event yang belum terbit adalah pekerjaan yang belum selesai. Kalau
    // retensi menyentuhnya, relay yang sempat mati berhari-hari akan
    // kehilangan event yang seharusnya masih bisa diproses — tanpa error.
    const pending = await insertEvent({
      createdAt: new Date(NOW.getTime() - 60 * DAY),
    });

    const result = await pruneOutboxEvents(test.db, { now: NOW });

    expect(result.publishedDeleted).toBe(0);
    expect(result.deadLetterDeleted).toBe(0);
    const res = await pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE id = $1`,
      [pending],
    );
    expect(res.rows[0]?.n).toBe(1);
  });

  it("mempertahankan dead-letter lebih lama daripada baris terbit", async () => {
    // Baris dead-letter adalah bukti kegagalan yang sedang ditelusuri.
    // Menyamakan jendelanya dengan baris terbit berarti bukti itu hilang
    // seminggu setelah masalahnya muncul.
    const bukti = await insertEvent({
      createdAt: new Date(NOW.getTime() - 20 * DAY),
      deadLetteredAt: new Date(NOW.getTime() - 10 * DAY),
    });
    const kedaluwarsa = await insertEvent({
      createdAt: new Date(NOW.getTime() - 60 * DAY),
      deadLetteredAt: new Date(NOW.getTime() - 40 * DAY),
    });

    const result = await pruneOutboxEvents(test.db, { now: NOW });

    expect(result.deadLetterDeleted).toBe(1);
    const sisa = await pglite.query<{ id: string }>(
      `SELECT id FROM outbox_events`,
    );
    expect(sisa.rows.map((r) => r.id)).toEqual([bukti]);
    expect(sisa.rows.map((r) => r.id)).not.toContain(kedaluwarsa);
  });

  it("menghapus per batch sampai habis", async () => {
    // Batch kecil menyembunyikan bug "hanya batch pertama terhapus":
    // angkanya terlihat masuk akal, sisanya tertinggal selamanya.
    for (let i = 0; i < 7; i += 1) {
      await insertEvent({
        createdAt: new Date(NOW.getTime() - 30 * DAY),
        publishedAt: new Date(NOW.getTime() - 20 * DAY),
      });
    }

    const result = await pruneOutboxEvents(test.db, {
      now: NOW,
      batchSize: 3,
    });

    expect(result.publishedDeleted).toBe(7);
    expect(await count()).toBe(0);
  });
});
