import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./testing/pglite";
import {
  addPlatformAdmin,
  getBackupStatus,
  isPlatformAdmin,
  listBackupRuns,
  listPlatformAdmins,
  removePlatformAdmin,
} from "./platform-admins";

/**
 * Uji daftar admin platform yang dikelola panel (migrasi 0011).
 *
 * Yang diuji bukan sekadar "tambah & hapus baris", melainkan aturan yang
 * mencegah pemilik platform mengunci dirinya sendiri: env tidak bisa
 * dicabut, diri sendiri tidak bisa dicabut, dan admin terakhir tidak bisa
 * dicabut bila env kosong. Ini tiga keadaan yang kalau lolos membuat
 * /admin tidak bisa dibuka lagi oleh siapa pun tanpa SSH.
 */

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR_EMAIL = "owner@contoh.test";

let test: TestDb;

beforeAll(async () => {
  test = await createTestDb();
  await test.pglite.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')`,
    [ACTOR_ID, ACTOR_EMAIL],
  );
});

afterAll(async () => {
  await test?.close();
});

describe("daftar admin platform", () => {
  it("env tetap menjadi admin bootstrap tanpa perlu baris di tabel", async () => {
    const ok = await isPlatformAdmin(test.db, "BOOT@Contoh.test", "boot@contoh.test");
    expect(ok).toBe(true);
    const no = await isPlatformAdmin(test.db, "lain@contoh.test", "boot@contoh.test");
    expect(no).toBe(false);
  });

  it("tambah admin dari panel langsung berlaku, walau email belum terdaftar", async () => {
    const added = await addPlatformAdmin(test.db, {
      email: "  Baru@Contoh.test  ",
      actorUserId: ACTOR_ID,
    });
    expect(added).toEqual({ email: "baru@contoh.test", created: true });

    expect(
      await isPlatformAdmin(test.db, "BARU@contoh.test", undefined),
    ).toBe(true);

    const rows = await listPlatformAdmins(test.db, undefined);
    const row = rows.find((r) => r.email === "baru@contoh.test");
    expect(row).toMatchObject({
      source: "panel",
      removable: true,
      registered: false,
    });
  });

  it("menambah email yang sama tidak menduplikasi baris", async () => {
    const second = await addPlatformAdmin(test.db, {
      email: "baru@contoh.test",
      actorUserId: ACTOR_ID,
    });
    expect(second.created).toBe(false);
    const count = await test.pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform_admins WHERE email = 'baru@contoh.test'`,
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("baris env terkunci dan tidak bisa dicabut dari panel", async () => {
    const rows = await listPlatformAdmins(test.db, "boot@contoh.test");
    const envRow = rows.find((r) => r.email === "boot@contoh.test");
    expect(envRow).toMatchObject({
      source: "env",
      removable: false,
      registered: false,
    });

    const result = await removePlatformAdmin(test.db, {
      email: "boot@contoh.test",
      actorUserId: ACTOR_ID,
      actorEmail: ACTOR_EMAIL,
      rawAllowlist: "boot@contoh.test",
    });
    expect(result).toEqual({ removed: false, reason: "env_locked" });
  });

  it("tidak bisa mencabut diri sendiri", async () => {
    await addPlatformAdmin(test.db, {
      email: ACTOR_EMAIL,
      actorUserId: ACTOR_ID,
    });
    const result = await removePlatformAdmin(test.db, {
      email: ACTOR_EMAIL,
      actorUserId: ACTOR_ID,
      actorEmail: ACTOR_EMAIL,
      rawAllowlist: "boot@contoh.test",
    });
    expect(result).toEqual({ removed: false, reason: "self" });
  });

  it("admin terakhir tidak bisa dicabut saat env kosong", async () => {
    // Sisakan tepat satu baris panel, lalu coba cabut dari akun lain.
    await test.pglite.query(`DELETE FROM platform_admins`);
    await addPlatformAdmin(test.db, {
      email: "satu@contoh.test",
      actorUserId: ACTOR_ID,
    });
    const result = await removePlatformAdmin(test.db, {
      email: "satu@contoh.test",
      actorUserId: ACTOR_ID,
      actorEmail: ACTOR_EMAIL,
      rawAllowlist: undefined,
    });
    expect(result).toEqual({ removed: false, reason: "last_admin" });
  });

  it("pencabutan berlaku segera bila masih ada admin lain", async () => {
    await addPlatformAdmin(test.db, {
      email: "dua@contoh.test",
      actorUserId: ACTOR_ID,
    });
    const result = await removePlatformAdmin(test.db, {
      email: "satu@contoh.test",
      actorUserId: ACTOR_ID,
      actorEmail: ACTOR_EMAIL,
      rawAllowlist: undefined,
    });
    expect(result).toEqual({ removed: true, email: "satu@contoh.test" });
    expect(await isPlatformAdmin(test.db, "satu@contoh.test", undefined)).toBe(
      false,
    );
  });
});

describe("status backup", () => {
  it("hanya baris sukses yang dihitung, dan drill/harian dibedakan", async () => {
    await test.pglite.query(`
      INSERT INTO backup_runs (kind, status, size_bytes, detail, created_at) VALUES
        ('daily', 'ok', 2048, 'lama', now() - interval '2 days'),
        ('daily', 'failed', 0, 'gagal', now() - interval '1 hour'),
        ('daily', 'ok', 4096, 'baru', now()),
        ('drill', 'ok', 4096, 'drill', now() - interval '30 minutes');
    `);

    const status = await getBackupStatus(test.db);
    const rows = await listBackupRuns(test.db, 10);
    const newestDaily = rows.find((r) => r.kind === "daily" && r.status === "ok");

    expect(status.lastDaily).toBe(newestDaily?.createdAt);
    expect(status.lastDrill).not.toBeNull();
    expect(rows).toHaveLength(4);
    expect(rows[0]?.detail).toBe("baru");
  });
});
