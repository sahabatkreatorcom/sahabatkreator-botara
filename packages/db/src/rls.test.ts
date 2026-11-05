import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Uji isolasi tenant pada skema SUNGGUHAN.
 *
 * Ini test paling penting di repo: seluruh janji keamanan multi-tenant
 * bergantung pada policy RLS di packages/db/migrations. Test ini
 * menjalankan rantai migrasi dari nol di PGlite (Postgres asli, WASM),
 * lalu membuktikan bahwa role aplikasi non-pemilik:
 *   1. tidak melihat apa pun tanpa konteks tenant (fail closed),
 *   2. hanya melihat baris tenant-nya saat `app.tenant_id` di-set,
 *   3. ditolak saat menulis untuk tenant lain (WITH CHECK),
 *   4. tetap bisa memakai lengan lookup publik yang sempit.
 *
 * PGlite dipakai supaya test berjalan tanpa server Postgres — CI tidak
 * perlu service container, dan developer tidak perlu Docker.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "migrations");

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAN_ID = "99999999-9999-4999-8999-999999999999";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, btree_gist } });

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThanOrEqual(4);

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await db.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }

  await db.exec(`
    CREATE ROLE app_user NOLOGIN;
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
  `);

  await db.query(
    `INSERT INTO plans (id, code, name, limits) VALUES ($1, 'free', 'Free', '{}'::jsonb)`,
    [PLAN_ID],
  );
  await db.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
    [TENANT_A, TENANT_B],
  );
  await db.query(
    `INSERT INTO users (id, email, name) VALUES ($1, 'a@contoh.test', 'User A')`,
    [USER_A],
  );
  await db.query(
    `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [TENANT_A, USER_A],
  );
  await db.query(
    `INSERT INTO contacts (tenant_id, phone, name) VALUES
       ($1, '+628111111111', 'Kontak A'),
       ($2, '+628222222222', 'Kontak B')`,
    [TENANT_A, TENANT_B],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("RLS tenant isolation", () => {
  it("tanpa konteks tenant, role aplikasi melihat nol baris (fail closed)", async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      const contacts = await tx.query(`SELECT id FROM contacts`);
      const conversations = await tx.query(`SELECT id FROM conversations`);
      return { contacts: contacts.rows.length, conversations: conversations.rows.length };
    });
    expect(seen.contacts).toBe(0);
    expect(seen.conversations).toBe(0);
  });

  it("dengan app.tenant_id, hanya baris tenant itu yang terlihat", async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const rows = await tx.query<{ tenant_id: string; name: string }>(
        `SELECT tenant_id, name FROM contacts`,
      );
      return rows.rows;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tenant_id).toBe(TENANT_A);
    expect(seen[0]?.name).toBe("Kontak A");
  });

  it("insert untuk tenant lain ditolak WITH CHECK", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE app_user`);
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
        await tx.query(
          `INSERT INTO contacts (tenant_id, phone, name) VALUES ($1, '+628999', 'Selundupan')`,
          [TENANT_B],
        );
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it("update lintas tenant tidak mengenai baris apa pun", async () => {
    const affected = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const res = await tx.query(
        `UPDATE contacts SET name = 'Dibajak' WHERE tenant_id = $1`,
        [TENANT_B],
      );
      return res.affectedRows ?? 0;
    });
    expect(affected).toBe(0);
  });

  it("lengan lookup publik hanya membuka baris yang cocok", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      await tx.query(
        `SELECT set_config('app.api_key_hash', 'hash-tidak-ada', true)`,
      );
      const res = await tx.query(`SELECT id FROM api_keys`);
      return res.rows.length;
    });
    expect(rows).toBe(0);
  });

  it("tenant_members punya lengan baca keanggotaan sendiri lewat app.user_id", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      await tx.query(`SELECT set_config('app.user_id', $1, true)`, [USER_A]);
      const res = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_members`,
      );
      return res.rows;
    });
    expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
  });

  /**
   * Lengan `whatsapp_waba_lookup` (migrasi 0004) — dipakai event webhook
   * tingkat WABA (`message_template_status_update`) yang TIDAK membawa
   * phone_number_id, hanya WABA id. Lengan lama
   * (`provider_external_lookup`) tidak menolong di sana karena ia
   * mencocokkan `external_id`.
   *
   * Yang diuji bukan hanya "bisa membuka", tetapi juga "tidak membuka
   * lebih dari seharusnya": tanpa setting harus fail-closed, WABA lain
   * tidak boleh terlihat, dan provider lain dengan induk yang sama tidak
   * boleh ikut terbuka.
   */
  it("lengan WABA membuka akun WhatsApp yang tepat saja", async () => {
    await db.query(
      `INSERT INTO channel_accounts (tenant_id, provider, external_id, parent_external_id, status)
       VALUES ($1, 'whatsapp', 'phone-a', 'waba-a', 'connected'),
              ($2, 'whatsapp', 'phone-b', 'waba-b', 'connected'),
              ($1, 'telegram', 'bot-a', 'waba-a', 'connected')`,
      [TENANT_A, TENANT_B],
    );

    const visible = async (wabaId: string | null) =>
      db.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE app_user`);
        if (wabaId) {
          await tx.query(`SELECT set_config('app.whatsapp_waba_id', $1, true)`, [
            wabaId,
          ]);
        }
        const res = await tx.query<{ external_id: string }>(
          `SELECT external_id FROM channel_accounts`,
        );
        return res.rows.map((r) => r.external_id);
      });

    // Fail closed: tanpa setting tidak ada baris sama sekali.
    expect(await visible(null)).toEqual([]);
    // WABA yang cocok membuka akun WhatsApp-nya…
    expect(await visible("waba-a")).toEqual(["phone-a"]);
    // …tetapi TIDAK akun provider lain yang kebetulan berinduk sama.
    expect(await visible("waba-a")).not.toContain("bot-a");
    // WABA lain tidak ikut terbuka, dan WABA asing tidak membuka apa pun.
    expect(await visible("waba-b")).toEqual(["phone-b"]);
    expect(await visible("waba-tidak-ada")).toEqual([]);
  });
});
