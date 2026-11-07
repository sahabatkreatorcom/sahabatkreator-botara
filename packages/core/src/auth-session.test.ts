import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  AUTH_SESSION_GRACE_DAYS,
  pruneExpiredAuthSessions,
} from "./auth-session";
import { createTestDb, type TestDb } from "./testing/pglite";

/**
 * Pembersihan sesi login (Fase 22, audit A5), diuji pada Postgres
 * sungguhan (PGlite).
 *
 * Yang dijaga: sapuan ini TIDAK boleh menyentuh sesi yang masih berlaku.
 * Menghapus sesi aktif berarti mengeluarkan pengguna secara acak — bug
 * yang jauh lebih merusak daripada tabel yang membesar.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-07T03:00:00Z");
const AUTH_USER_ID = "c0000000-0000-4000-8000-000000000022";

describe("pruneExpiredAuthSessions", () => {
  let test: TestDb;
  let pglite: PGlite;

  beforeAll(async () => {
    test = await createTestDb();
    pglite = test.pglite;
    await pglite.query(
      `INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'Pengguna Uji', 'sesi@example.com', true, now(), now())`,
      [AUTH_USER_ID],
    );
  }, 120_000);

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await pglite.query(`DELETE FROM auth_session`);
  });

  async function seedSession(expiresAt: Date): Promise<string> {
    const id = crypto.randomUUID();
    await pglite.query(
      `INSERT INTO auth_session (id, token, user_id, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [id, `tok-${id}`, AUTH_USER_ID, expiresAt.toISOString()],
    );
    return id;
  }

  async function count(): Promise<number> {
    const res = await pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_session`,
    );
    return res.rows[0]?.n ?? 0;
  }

  it("menghapus sesi yang kedaluwarsa melewati masa tenggang", async () => {
    const mati = await seedSession(new Date(NOW.getTime() - 30 * DAY));

    const result = await pruneExpiredAuthSessions(test.db, { now: NOW });

    expect(result.deleted).toBe(1);
    const sisa = await pglite.query<{ id: string }>(
      `SELECT id FROM auth_session`,
    );
    expect(sisa.rows.map((r) => r.id)).not.toContain(mati);
    expect(await count()).toBe(0);
  });

  it("TIDAK menyentuh sesi yang masih berlaku", async () => {
    // Menghapus sesi aktif = mengeluarkan pengguna secara acak. Ini
    // kesalahan yang jauh lebih mahal daripada tabel yang membesar.
    const aktif = await seedSession(new Date(NOW.getTime() + 5 * DAY));

    const result = await pruneExpiredAuthSessions(test.db, { now: NOW });

    expect(result.deleted).toBe(0);
    expect(await count()).toBe(1);
    expect(aktif).toBeTruthy();
  });

  it("mempertahankan sesi yang baru kedaluwarsa selama masa tenggang", async () => {
    // Jeda ini yang menjawab "kenapa saya tiba-tiba diminta login lagi":
    // barisnya masih ada saat pengguna melapor.
    const baru = await seedSession(new Date(NOW.getTime() - 2 * DAY));

    const result = await pruneExpiredAuthSessions(test.db, { now: NOW });

    expect(result.deleted).toBe(0);
    const sisa = await pglite.query<{ id: string }>(
      `SELECT id FROM auth_session`,
    );
    expect(sisa.rows.map((r) => r.id)).toEqual([baru]);
  });

  it("menghapus per batch sampai habis", async () => {
    for (let i = 0; i < 7; i += 1) {
      await seedSession(new Date(NOW.getTime() - (30 + i) * DAY));
    }

    const result = await pruneExpiredAuthSessions(test.db, {
      now: NOW,
      batchSize: 3,
    });

    expect(result.deleted).toBe(7);
    expect(await count()).toBe(0);
  });

  it("memakai masa tenggang 7 hari sebagai default", async () => {
    // Batas yang dijanjikan dokumentasi harus sama dengan yang dijalankan.
    expect(AUTH_SESSION_GRACE_DAYS).toBe(7);
    const tepatDiBatas = await seedSession(
      new Date(NOW.getTime() - 8 * DAY),
    );
    const masihDalam = await seedSession(new Date(NOW.getTime() - 6 * DAY));

    await pruneExpiredAuthSessions(test.db, { now: NOW });

    const sisa = await pglite.query<{ id: string }>(
      `SELECT id FROM auth_session`,
    );
    const ids = sisa.rows.map((r) => r.id);
    expect(ids).toEqual([masihDalam]);
    expect(ids).not.toContain(tepatDiBatas);
  });
});
