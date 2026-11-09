import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Uji lengan RLS konsol admin platform (migrasi 0010).
 *
 * Yang dibuktikan di sini bukan "fitur jalan", melainkan BATAS kemampuan:
 *
 *   1. tanpa `app.platform_admin`, role aplikasi tetap melihat NOL baris —
 *      jadi menambah konsol tidak melemahkan isolasi tenant;
 *   2. dengan flag itu, baris SELURUH tenant terbaca (itulah gunanya);
 *   3. flag itu TIDAK membuka `platform_settings` — kemampuan konsol dan
 *      kemampuan kredensial terpisah, sehingga mencabut salah satunya
 *      tidak mematikan yang lain;
 *   4. konsol boleh MENULIS audit (jejak aksi admin) tetapi tidak boleh
 *      mengubah/menghapus riwayat yang sudah ada;
 *   5. status tenant default `active` dan penangguhan tidak menghapus apa pun.
 *
 * PGlite dipakai supaya rantai migrasi yang diuji adalah rantai SUNGGUHAN
 * (file .sql yang sama dengan produksi), bukan skema tiruan.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "migrations");

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAN_ID = "99999999-9999-4999-8999-999999999999";
const CONTACT_A = "c1111111-1111-4111-8111-111111111111";
const CONTACT_B = "c2222222-2222-4222-8222-222222222222";
const CHANNEL_A = "d1111111-1111-4111-8111-111111111111";
const CHANNEL_B = "d2222222-2222-4222-8222-222222222222";
const CONV_A = "e1111111-1111-4111-8111-111111111111";
const CONV_B = "e2222222-2222-4222-8222-222222222222";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, btree_gist } });

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
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
    `INSERT INTO users (id, email, name) VALUES ($1, 'a@contoh.test', 'User A'), ($2, 'b@contoh.test', 'User B')`,
    [USER_A, USER_B],
  );
  await db.query(
    `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'agent')`,
    [TENANT_A, USER_A, TENANT_B, USER_B],
  );
  await db.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1, $2, 'active')`,
    [TENANT_A, PLAN_ID],
  );
  await db.query(
    `INSERT INTO contacts (id, tenant_id, phone, name) VALUES ($1, $2, '+628111111111', 'Kontak A'), ($3, $4, '+628222222222', 'Kontak B')`,
    [CONTACT_A, TENANT_A, CONTACT_B, TENANT_B],
  );
  await db.query(
    `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
       VALUES ($1, $2, 'webchat', 'web-a', 'connected'), ($3, $4, 'webchat', 'web-b', 'connected')`,
    [CHANNEL_A, TENANT_A, CHANNEL_B, TENANT_B],
  );
  await db.query(
    `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider)
       VALUES ($1, $2, $3, $4, 'webchat'), ($5, $6, $7, $8, 'webchat')`,
    [CONV_A, TENANT_A, CHANNEL_A, CONTACT_A, CONV_B, TENANT_B, CHANNEL_B, CONTACT_B],
  );
  await db.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, type, status)
       VALUES ($1, $2, 'inbound', 'contact', 'text', 'received'),
              ($3, $4, 'inbound', 'contact', 'text', 'received')`,
    [TENANT_A, CONV_A, TENANT_B, CONV_B],
  );
});

afterAll(async () => {
  await db?.close();
});

describe("lengan RLS konsol admin platform (0010)", () => {
  it("tanpa app.platform_admin, seluruh tabel konsol tetap nol baris", async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      const members = await tx.query(`SELECT id FROM tenant_members`);
      const messages = await tx.query(`SELECT id FROM messages`);
      const subs = await tx.query(`SELECT id FROM subscriptions`);
      return {
        members: members.rows.length,
        messages: messages.rows.length,
        subs: subs.rows.length,
      };
    });
    expect(seen).toEqual({ members: 0, messages: 0, subs: 0 });
  });

  it("dengan app.platform_admin, baris SELURUH tenant terbaca", async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      await tx.query(`SELECT set_config('app.platform_admin', 'on', true)`);
      const members = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_members`,
      );
      const messages = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM messages`,
      );
      const subs = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM subscriptions`,
      );
      return {
        memberTenants: members.rows.map((r) => r.tenant_id).sort(),
        messageCount: messages.rows.length,
        subs: subs.rows.length,
      };
    });
    expect(seen.memberTenants).toEqual([TENANT_A, TENANT_B]);
    expect(seen.messageCount).toBe(2);
    expect(seen.subs).toBe(1);
  });

  it("flag konsol TIDAK membuka platform_settings (kemampuan terpisah)", async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      await tx.query(`SELECT set_config('app.platform_admin', 'on', true)`);
      const rows = await tx.query(`SELECT key FROM platform_settings`);
      return rows.rows.length;
    });
    expect(seen).toBe(0);
  });

  it("konsol boleh menulis audit, tetapi tidak boleh mengubah riwayat", async () => {
    const inserted = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      await tx.query(`SELECT set_config('app.platform_admin', 'on', true)`);
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, meta)
           VALUES ($1, 'user', $2, 'platform.tenant.suspended', '{}'::jsonb)`,
        [TENANT_B, USER_A],
      );
      const rows = await tx.query<{ id: string }>(
        `SELECT id FROM audit_logs WHERE action = 'platform.tenant.suspended'`,
      );
      return rows.rows.length;
    });
    expect(inserted).toBe(1);

    // UPDATE tidak punya policy untuk flag ini → nol baris tersentuh,
    // bukan error: itulah bentuk "tidak boleh" di PostgreSQL.
    const updated = await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL ROLE app_user`);
      await tx.query(`SELECT set_config('app.platform_admin', 'on', true)`);
      const res = await tx.query(
        `UPDATE audit_logs SET action = 'dipalsukan' WHERE action = 'platform.tenant.suspended'`,
      );
      return res.affectedRows ?? 0;
    });
    expect(updated).toBe(0);
  });

  it("status tenant default aktif dan penangguhan tidak menghapus data", async () => {
    const before = await db.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1`,
      [TENANT_A],
    );
    expect(before.rows[0]?.status).toBe("active");

    await db.query(
      `UPDATE tenants SET status = 'suspended', status_reason = 'ujian' WHERE id = $1`,
      [TENANT_A],
    );

    const after = await db.query<{ status: string; status_reason: string }>(
      `SELECT status, status_reason FROM tenants WHERE id = $1`,
      [TENANT_A],
    );
    expect(after.rows[0]).toEqual({ status: "suspended", status_reason: "ujian" });

    // Datanya utuh: penangguhan adalah status, bukan penghapusan.
    const members = await db.query(
      `SELECT id FROM tenant_members WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(members.rows.length).toBe(1);
  });
});
