import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  OUTBOX_MAX_ATTEMPTS,
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
