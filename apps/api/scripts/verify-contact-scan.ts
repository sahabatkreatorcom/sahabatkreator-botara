/**
 * Verifikasi Gelombang G18 butir 2 — PINDAI PELANGGAN OTOMATIS,
 * di atas PGlite. Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan:
 *   [1] POST /contacts/scans → 202 + baris pindai 'queued' + event
 *       outbox contact_scan.requested (pola pekerjaan latar repo).
 *   [2] executeContactScan (fungsi yang dipanggil job worker)
 *       mengklasifikasikan penulis komentar dengan BENAR dari
 *       riwayat semai: penulis baru → pending; penulis yang
 *       identitasnya sudah tertaut kontak → already_contact;
 *       penulis = akun kanal tenant sendiri → self_account;
 *       komentar yang contact_id-nya sudah terisi tidak masuk
 *       pindai sama sekali. Statistik cocok dengan baris kandidat.
 *   [3] eksekusi idempoten: jalan kedua → already_completed dan
 *       kandidat tidak berlipat.
 *   [4] impor kandidat pending: kontak dibuat (nama dari username,
 *       source 'scan:comments'), identitas kanal dibuat, komentar
 *       penulis ditautkan ke kontak baru; impor ulang tidak membuat
 *       duplikat.
 *   [5] kandidat self_account TIDAK bisa diimpor walau diminta
 *       eksplisit (terhitung notPending, tak ada kontak lahir).
 *   [6] tinjauan ulang saat impor: penulis yang menjadi kontak
 *       SESUDAH pindai (identitas dibuat jalur DM) dilewati sebagai
 *       skipped_existing — bukan diduplikatkan.
 *   [7] isolasi tenant: pindai tenant B hanya melihat komentar
 *       tenant B.
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:contact-scan
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@sahabat-kreator/db/schema";
import type { Database } from "@sahabat-kreator/db";
import { executeContactScan } from "@sahabat-kreator/core";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createContactsRoutes } from "../src/modules/contacts/routes";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../../packages/db/migrations");

const client = new PGlite({ extensions: { vector, btree_gist } });
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
  await client.exec(sqlText.replaceAll("--> statement-breakpoint", ""));
}
console.log(`[setup] migrasi teraplikasi: ${files.length} file`);
const db = drizzle(client, { schema }) as unknown as Database;

const TENANT = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "11111111-1111-4111-8111-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ACCOUNT = "33000000-0000-4000-8000-0000000000a1";
const ACCOUNT_B = "33000000-0000-4000-8000-0000000000b1";
const KNOWN_CONTACT = "22000000-0000-4000-8000-0000000000c1";
const LINKED_CONTACT = "22000000-0000-4000-8000-0000000000c2";

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug, default_locale) VALUES ($1, 'Tenant A', 'tenant-a', 'id'), ($2, 'Tenant B', 'tenant-b', 'en')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'owner@sk.test', 'Pemilik A'), ($2, 'ownerb@sk.test', 'Pemilik B')`,
  [OWNER, OWNER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
  [TENANT, OWNER, TENANT_B, OWNER_B],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status) VALUES
   ($1, $2, 'instagram', 'IG_SELF', 'Akun IG Tenant', 'connected'),
   ($3, $4, 'instagram', 'IG_SELF_B', 'Akun IG Tenant B', 'connected')`,
  [ACCOUNT, TENANT, ACCOUNT_B, TENANT_B],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Budi Dikenal'), ($3, $2, 'Kontak Tertaut')`,
  [KNOWN_CONTACT, TENANT, LINKED_CONTACT],
);
await client.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id, username) VALUES
   ($1, $2, $3, 'instagram', 'IGSID_KNOWN', 'budi')`,
  [TENANT, KNOWN_CONTACT, ACCOUNT],
);

let commentSeq = 0;
async function seedComment(
  tenantId: string,
  accountId: string,
  authorExternalId: string,
  username: string | null,
  text: string,
  contactId: string | null = null,
): Promise<void> {
  commentSeq += 1;
  await client.query(
    `INSERT INTO comments (tenant_id, channel_account_id, provider, provider_comment_id, author_external_id, author_username, text, contact_id)
     VALUES ($1, $2, 'instagram', $3, $4, $5, $6, $7)`,
    [
      tenantId,
      accountId,
      `comment-${commentSeq}`,
      authorExternalId,
      username,
      text,
      contactId,
    ],
  );
}

// Penulis baru (2 komentar), penulis dikenal, akun sendiri, penulis
// yang komentarnya sudah tertaut kontak (di luar pindai).
await seedComment(TENANT, ACCOUNT, "IGSID_NEW", "sari", "Kak, harga berapa?");
await seedComment(TENANT, ACCOUNT, "IGSID_NEW", "sari", "Ada warna lain?");
await seedComment(TENANT, ACCOUNT, "IGSID_KNOWN", "budi", "Mantap kak");
await seedComment(TENANT, ACCOUNT, "IG_SELF", "tenant.ig", "Balasan admin sendiri");
await seedComment(TENANT, ACCOUNT, "IGSID_LINKED", "linked", "Sudah tertaut", LINKED_CONTACT);
// Tenant B: satu penulis baru miliknya.
await seedComment(TENANT_B, ACCOUNT_B, "IGSID_B_NEW", "rani", "Halo dari B");

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? OWNER;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createContactsRoutes(bundle));

async function call(
  method: string,
  url: string,
  user = OWNER,
  body?: unknown,
): Promise<{ status: number; body: never }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": user,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as never };
}

interface ScanJson {
  id: string;
  status: string;
  stats: {
    commentsSeen: number;
    distinctAuthors: number;
    pending: number;
    alreadyContact: number;
    selfAccount: number;
  };
}
interface CandidateJson {
  id: string;
  externalUserId: string;
  displayName: string | null;
  commentCount: number;
  status: string;
  importedContactId: string | null;
}

const scansBase = `/tenants/${TENANT}/contacts/scans`;

// --- [1] buat pindai -----------------------------------------------------------
const created = await call("POST", scansBase, OWNER, {});
assert.equal(created.status, 202, JSON.stringify(created.body));
const scan = created.body as unknown as ScanJson;
assert.equal(scan.status, "queued");
{
  const outbox = await client.query<{ payload: { scanRunId: string } }>(
    `SELECT payload FROM outbox_events WHERE tenant_id = $1 AND type = 'contact_scan.requested'`,
    [TENANT],
  );
  assert.equal(outbox.rows.length, 1);
  assert.equal(outbox.rows[0]!.payload.scanRunId, scan.id);
}
console.log("[1] POST scans → 202 + event outbox contact_scan.requested: OK");

// --- [2] eksekusi + klasifikasi ---------------------------------------------------
const exec1 = await executeContactScan(db, { tenantId: TENANT, scanRunId: scan.id });
assert.equal(exec1.kind, "completed");
if (exec1.kind === "completed") {
  assert.deepEqual(exec1.stats, {
    commentsSeen: 4,
    distinctAuthors: 3,
    pending: 1,
    alreadyContact: 1,
    selfAccount: 1,
  });
}
const detail = await call("GET", `${scansBase}/${scan.id}`);
assert.equal(detail.status, 200);
const candidates = (detail.body as unknown as { candidates: CandidateJson[] }).candidates;
const byAuthor = new Map(candidates.map((k) => [k.externalUserId, k]));
assert.equal(byAuthor.get("IGSID_NEW")?.status, "pending");
assert.equal(byAuthor.get("IGSID_NEW")?.commentCount, 2);
assert.equal(byAuthor.get("IGSID_NEW")?.displayName, "@sari");
assert.equal(byAuthor.get("IGSID_KNOWN")?.status, "already_contact");
assert.equal(byAuthor.get("IGSID_KNOWN")?.importedContactId, KNOWN_CONTACT);
assert.equal(byAuthor.get("IG_SELF")?.status, "self_account");
assert.equal(byAuthor.has("IGSID_LINKED"), false);
console.log("[2] klasifikasi kandidat dari riwayat semai: OK");

// --- [3] eksekusi idempoten ---------------------------------------------------------
const exec2 = await executeContactScan(db, { tenantId: TENANT, scanRunId: scan.id });
assert.equal(exec2.kind, "already_completed");
{
  const count = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM contact_scan_candidates WHERE scan_run_id = $1`,
    [scan.id],
  );
  assert.equal(count.rows[0]!.n, "3");
}
console.log("[3] eksekusi ulang idempoten, kandidat tidak berlipat: OK");

// --- [4] impor kandidat pending -------------------------------------------------------
const pendingCandidate = byAuthor.get("IGSID_NEW")!;
const imported = await call("POST", `${scansBase}/${scan.id}/import`, OWNER, {
  candidateIds: [pendingCandidate.id],
});
assert.equal(imported.status, 200, JSON.stringify(imported.body));
assert.deepEqual(imported.body, { imported: 1, skippedExisting: 0, notPending: 0 });
{
  const contactRows = await client.query<{ id: string; name: string; source: string }>(
    `SELECT id, name, source FROM contacts WHERE tenant_id = $1 AND name = '@sari'`,
    [TENANT],
  );
  assert.equal(contactRows.rows.length, 1);
  assert.equal(contactRows.rows[0]!.source, "scan:comments");
  const newContactId = contactRows.rows[0]!.id;
  const identity = await client.query(
    `SELECT 1 FROM channel_identities WHERE channel_account_id = $1 AND external_user_id = 'IGSID_NEW' AND contact_id = $2`,
    [ACCOUNT, newContactId],
  );
  assert.equal(identity.rows.length, 1);
  const linked = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM comments WHERE tenant_id = $1 AND author_external_id = 'IGSID_NEW' AND contact_id = $2`,
    [TENANT, newContactId],
  );
  assert.equal(linked.rows[0]!.n, "2");
}
// Impor ulang: tidak ada duplikat, kandidat terhitung notPending.
const reimport = await call("POST", `${scansBase}/${scan.id}/import`, OWNER, {
  candidateIds: [pendingCandidate.id],
});
assert.deepEqual(reimport.body, { imported: 0, skippedExisting: 0, notPending: 1 });
{
  const count = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM contacts WHERE tenant_id = $1 AND name = '@sari'`,
    [TENANT],
  );
  assert.equal(count.rows[0]!.n, "1");
}
console.log("[4] impor: kontak + identitas + tautan komentar; ulang tanpa duplikat: OK");

// --- [5] self_account tidak bisa diimpor ------------------------------------------------
const selfCandidate = byAuthor.get("IG_SELF")!;
const selfImport = await call("POST", `${scansBase}/${scan.id}/import`, OWNER, {
  candidateIds: [selfCandidate.id],
});
assert.deepEqual(selfImport.body, { imported: 0, skippedExisting: 0, notPending: 1 });
{
  const count = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM channel_identities WHERE channel_account_id = $1 AND external_user_id = 'IG_SELF'`,
    [ACCOUNT],
  );
  assert.equal(count.rows[0]!.n, "0");
}
console.log("[5] kandidat akun-sendiri tidak pernah diimpor: OK");

// --- [6] tinjauan ulang saat impor → skipped_existing --------------------------------------
await seedComment(TENANT, ACCOUNT, "IGSID_LATE", "laras", "Baru komentar");
const scan2Res = await call("POST", scansBase, OWNER, {});
const scan2 = scan2Res.body as unknown as ScanJson;
const execScan2 = await executeContactScan(db, { tenantId: TENANT, scanRunId: scan2.id });
assert.equal(execScan2.kind, "completed");
const detail2 = await call("GET", `${scansBase}/${scan2.id}`);
const lateCandidate = (
  detail2.body as unknown as { candidates: CandidateJson[] }
).candidates.find((k) => k.externalUserId === "IGSID_LATE")!;
assert.equal(lateCandidate.status, "pending");
// Penulis menjadi kontak lewat jalur DM di antara pindai dan impor.
await client.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES ('22000000-0000-4000-8000-0000000000c9', $1, 'Laras DM')`,
  [TENANT],
);
await client.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id, username)
   VALUES ($1, '22000000-0000-4000-8000-0000000000c9', $2, 'instagram', 'IGSID_LATE', 'laras')`,
  [TENANT, ACCOUNT],
);
const lateImport = await call("POST", `${scansBase}/${scan2.id}/import`, OWNER, {
  candidateIds: [lateCandidate.id],
});
assert.deepEqual(lateImport.body, { imported: 0, skippedExisting: 1, notPending: 0 });
{
  const count = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM contacts WHERE tenant_id = $1 AND name = '@laras'`,
    [TENANT],
  );
  assert.equal(count.rows[0]!.n, "0");
  const status = await client.query<{ status: string }>(
    `SELECT status FROM contact_scan_candidates WHERE id = $1`,
    [lateCandidate.id],
  );
  assert.equal(status.rows[0]!.status, "skipped_existing");
}
console.log("[6] impor meninjau ulang: skipped_existing tanpa duplikat: OK");

// --- [7] isolasi tenant ---------------------------------------------------------------------
const scanBRes = await call("POST", `/tenants/${TENANT_B}/contacts/scans`, OWNER_B, {});
assert.equal(scanBRes.status, 202);
const scanB = scanBRes.body as unknown as ScanJson;
const execB = await executeContactScan(db, { tenantId: TENANT_B, scanRunId: scanB.id });
assert.equal(execB.kind, "completed");
if (execB.kind === "completed") {
  assert.deepEqual(execB.stats, {
    commentsSeen: 1,
    distinctAuthors: 1,
    pending: 1,
    alreadyContact: 0,
    selfAccount: 0,
  });
}
const listA = await call("GET", scansBase, OWNER);
assert.equal(
  (listA.body as unknown as { scans: ScanJson[] }).scans.every(
    (s) => s.id !== scanB.id,
  ),
  true,
);
console.log("[7] isolasi tenant pindai: OK");

console.log("verify-contact-scan: SEMUA LULUS");
process.exit(0);
