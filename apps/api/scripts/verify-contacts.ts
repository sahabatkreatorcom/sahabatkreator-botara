/**
 * Verifikasi gelombang Perbaikan /contacts — di atas PGlite.
 * Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan:
 *   [1] daftar utama (HTTP) menyaring kontak AKUN-SENDIRI (jangkar
 *       akun channel yang hanya punya percakapan channel), TETAPI
 *       kontak campuran (jangkar + DM) dan kontak non-jangkar yang
 *       hanya punya percakapan channel tetap tampil; filter tahap
 *       bekerja di atas daftar tersaring.
 *   [2] core `listContacts` TANPA opsi saringan mempertahankan
 *       perilaku lama (jalur API publik v1) — saringan hanya opt-in
 *       permukaan daftar utama.
 *   [3] deteksi duplikat tetap melihat kontak akun-sendiri.
 *   [4] keanggotaan segmen tetap memuat kontak akun-sendiri
 *       (evaluator tak berubah); daftar utama berkomposisi di atasnya
 *       (anggota segmen yang akun-sendiri tetap tersaring di daftar);
 *       pratinjau audiens broadcast segmen yang sama tetap menghitung
 *       kontak akun-sendiri sebagai kandidat.
 *   [5] sasaran postingan tetap memuat percakapan channel milik
 *       kontak akun-sendiri.
 *   [6] impor CSV: baris sah masuk (tag + opt-in yang dinyatakan
 *       berkas diterapkan), duplikat terhadap kontak lama & sesama
 *       berkas dilewati-terlapor, baris tidak sah terlapor beralasan,
 *       opt-in TIDAK dipaksa untuk baris tanpa pernyataan.
 *   [7] ekspor CSV mengikuti filter aktif (search/tahap) persis dan
 *       ikut tersaring akun-sendiri; kolom sesuai kontrak.
 *   [8] aksi massal: tag/tahap/opt-out/hapus berjalan tenant-scoped —
 *       id tenant lain dilaporkan not_found & tidak disentuh; hapus
 *       digerbang owner/admin (member → 403) dan cascade percakapan.
 *   [9] field kustom: gabung per kunci tetap, penghapusan kunci lewat
 *       customFieldsDelete bekerja dan tersimpan.
 *   [10] endpoint percakapan kontak mengembalikan semua kind apa
 *        adanya; kontak tak dikenal → 404.
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:contacts
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
import {
  effectiveOptInStatus,
  findDuplicateContacts,
  getContact,
  listContacts,
  listPostTargets,
  listSegmentMemberIds,
  previewBroadcastAudience,
} from "@sahabat-kreator/core";
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
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// Akun channel tenant A
const ACC_IG = "21000000-0000-4000-8000-000000000001";
const ACC_TG = "21000000-0000-4000-8000-000000000002";
const ACC_WA = "21000000-0000-4000-8000-000000000003";
// Kontak tenant A
const SELF_IG = "22000000-0000-4000-8000-000000000001";
const SELF_TG = "22000000-0000-4000-8000-000000000002";
const MIXED = "22000000-0000-4000-8000-000000000003";
const NONANCHOR = "22000000-0000-4000-8000-000000000004";
const CUST1 = "22000000-0000-4000-8000-000000000005";
const CUST2 = "22000000-0000-4000-8000-000000000006";
// Kontak tenant B (sasaran uji lintas-tenant)
const CUSTB = "22000000-0000-4000-8000-000000000101";
const UNKNOWN_ID = "22000000-0000-4000-8000-000000000999";
// Percakapan tenant A
const V_IG_CH = "23000000-0000-4000-8000-000000000001";
const V_TG_CH = "23000000-0000-4000-8000-000000000002";
const V_WA_CH = "23000000-0000-4000-8000-000000000003";
const V_MIXED_DM = "23000000-0000-4000-8000-000000000004";
const V_NA_CH = "23000000-0000-4000-8000-000000000005";
const V_C1_DM = "23000000-0000-4000-8000-000000000006";
const V_C2_DM = "23000000-0000-4000-8000-000000000007";
// Segmen tenant A: hanya cocok dengan tag milik kontak akun-sendiri IG.
const SEG1 = "24000000-0000-4000-8000-000000000001";

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'owner@sk.test', 'Pemilik A'), ($2, 'member@sk.test', 'Member A')`,
  [OWNER, MEMBER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'viewer')`,
  [TENANT, OWNER, MEMBER],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status) VALUES
   ($1, $4, 'instagram', 'ig-brand', 'IG Brand', 'connected'),
   ($2, $4, 'telegram', '424242', 'Bot Uji', 'connected'),
   ($3, $4, 'whatsapp', '62812000', 'WA Bisnis', 'connected')`,
  [ACC_IG, ACC_TG, ACC_WA, TENANT],
);
await client.query(
  `INSERT INTO contacts (id, tenant_id, name, phone, email, tags, pipeline_stage, opt_in_status, opt_in_at, consent_at) VALUES
   ($1, $8, 'IG Brand', NULL, NULL, ARRAY['selftag'], 'new', 'unknown', NULL, NULL),
   ($2, $8, 'Kanal Promo', '+62 812-0000-1111', NULL, ARRAY[]::text[], 'new', 'unknown', NULL, NULL),
   ($3, $8, 'Pemilik Campuran', NULL, NULL, ARRAY[]::text[], 'contacted', 'unknown', NULL, NULL),
   ($4, $8, 'Siaran Berita', NULL, NULL, ARRAY[]::text[], 'new', 'unknown', NULL, NULL),
   ($5, $8, 'Budi', '081200001111', 'budi@contoh.id', ARRAY['vip'], 'new', 'unknown', NULL, NULL),
   ($6, $8, 'Sari', NULL, 'sari@contoh.id', ARRAY['vip', 'webinar'], 'qualified', 'opted_in', now(), now()),
   ($7, $9, 'Orang B', '0899999999', NULL, ARRAY[]::text[], 'new', 'unknown', NULL, NULL)`,
  [SELF_IG, SELF_TG, MIXED, NONANCHOR, CUST1, CUST2, CUSTB, TENANT, TENANT_B],
);
// Identitas: SELF_* adalah akun itu sendiri (external_user_id ==
// external_id akun); MIXED jangkar di WA + pelanggan di Telegram;
// NONANCHOR hanya peserta siaran (bukan akun itu sendiri).
await client.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id) VALUES
   ($1, $2, $3, 'instagram', 'ig-brand'),
   ($1, $4, $5, 'telegram', '424242'),
   ($1, $6, $7, 'whatsapp', '62812000'),
   ($1, $6, $5, 'telegram', '777'),
   ($1, $8, $5, 'telegram', '-100123'),
   ($1, $9, $5, 'telegram', '888'),
   ($1, $10, $3, 'instagram', 'psid-1')`,
  [TENANT, SELF_IG, ACC_IG, SELF_TG, ACC_TG, MIXED, ACC_WA, NONANCHOR, CUST1, CUST2],
);
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind, status) VALUES
   ($1, $8, $9, $10, 'instagram', 'ig-brand', 'IG Brand', 'channel', 'open'),
   ($2, $8, $11, $12, 'telegram', '424242', 'Kanal Promo', 'channel', 'open'),
   ($3, $8, $13, $14, 'whatsapp', '62812000', 'Pemilik Campuran', 'channel', 'open'),
   ($4, $8, $11, $14, 'telegram', '777', NULL, 'private', 'open'),
   ($5, $8, $11, $15, 'telegram', '-100123', 'Siaran Berita', 'channel', 'open'),
   ($6, $8, $11, $16, 'telegram', '888', NULL, 'private', 'open'),
   ($7, $8, $9, $17, 'instagram', 'psid-1', NULL, 'private', 'open')`,
  [
    V_IG_CH, V_TG_CH, V_WA_CH, V_MIXED_DM, V_NA_CH, V_C1_DM, V_C2_DM,
    TENANT, ACC_IG, SELF_IG, ACC_TG, SELF_TG, ACC_WA, MIXED, NONANCHOR,
    CUST1, CUST2,
  ],
);
await client.query(
  `INSERT INTO segments (id, tenant_id, name, definition) VALUES ($1, $2, 'Jangkar IG', $3::jsonb)`,
  [SEG1, TENANT, JSON.stringify({ match: "all", conditions: [{ type: "tag", tag: "selftag" }] })],
);

// ---------------------------------------------------------------------------
// Aplikasi uji: rute kontak dengan sesi yang bisa ditukar per header
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? OWNER;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createContactsRoutes(bundle));

interface ContactRow {
  id: string;
  name: string;
  tags: string[];
  pipelineStage: string;
  customFields: Record<string, unknown>;
}
async function listHttp(query = "", user = OWNER): Promise<{ contacts: ContactRow[]; total: number }> {
  const res = await app.request(`/tenants/${TENANT}/contacts${query}`, {
    headers: { "x-test-user": user },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { contacts: ContactRow[]; total: number };
}
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

// ---------- [1] daftar utama menyaring akun-sendiri ----------
{
  const all = await listHttp();
  assert.deepEqual(
    ids(all.contacts),
    ids([{ id: MIXED }, { id: NONANCHOR }, { id: CUST1 }, { id: CUST2 }]),
    "daftar utama: campuran + non-jangkar + pelanggan tampil; dua jangkar murni tersaring",
  );
  assert.equal(all.total, 4, "total daftar utama ikut tersaring");
  const stageNew = await listHttp("?stage=new");
  assert.deepEqual(
    ids(stageNew.contacts),
    ids([{ id: NONANCHOR }, { id: CUST1 }]),
    "filter tahap bekerja di atas daftar tersaring",
  );
  const stageQualified = await listHttp("?stage=qualified");
  assert.deepEqual(ids(stageQualified.contacts), [CUST2]);
  console.log("[1] daftar utama tersaring akun-sendiri + filter tahap: OK");
}

// ---------- [2] core tanpa opsi = perilaku lama ----------
{
  const all = await listContacts(db, { tenantId: TENANT }, { limit: 50, offset: 0 });
  assert.equal(all.total, 6, "tanpa opsi, listContacts melihat semua kontak (jalur publik v1)");
  const filtered = await listContacts(
    db,
    { tenantId: TENANT },
    { limit: 50, offset: 0, excludeSelfChannelContacts: true },
  );
  assert.equal(filtered.total, 4, "dengan opsi, hasil sama seperti daftar utama HTTP");
  console.log("[2] saringan core bersifat opt-in permukaan: OK");
}

// ---------- [3] duplikat tetap melihat akun-sendiri ----------
{
  const groups = await findDuplicateContacts(db, { tenantId: TENANT });
  const group = groups.find((g) =>
    g.contacts.some((c) => c.id === SELF_TG),
  );
  assert.ok(group, "kontak akun-sendiri Telegram tetap muncul sebagai kandidat duplikat");
  assert.ok(
    group.contacts.some((c) => c.id === CUST1),
    "pasangan duplikatnya adalah pelanggan dengan telepon ternormalisasi sama",
  );
  assert.ok(
    group.reasons.some((r) => r.type === "phone" && r.value === "6281200001111"),
    "alasan duplikat = telepon ternormalisasi bersama",
  );
  console.log("[3] deteksi duplikat tetap melihat akun-sendiri: OK");
}

// ---------- [4] segmen & audiens broadcast tetap melihat akun-sendiri ----------
{
  const members = await listSegmentMemberIds(db, TENANT, SEG1);
  assert.deepEqual(members, [SELF_IG], "evaluator segmen memuat kontak akun-sendiri");
  const viaHttp = await listHttp(`?segmentId=${SEG1}`);
  assert.equal(
    viaHttp.total,
    0,
    "daftar utama berkomposisi: anggota segmen yang akun-sendiri tetap tersaring di daftar",
  );
  const preview = await previewBroadcastAudience(db, {
    tenantId: TENANT,
    channelAccountId: ACC_IG,
    filter: { audience: "segment", segmentId: SEG1 },
  });
  assert.equal(preview.kind, "ok");
  if (preview.kind === "ok") {
    assert.ok(
      preview.preview.totalCandidates >= 1,
      "audiens broadcast segmen tetap menghitung kontak akun-sendiri sebagai kandidat",
    );
  }
  console.log("[4] segmen + audiens broadcast tak berubah; komposisi daftar benar: OK");
}

// ---------- [5] sasaran postingan tetap utuh ----------
{
  const targets = await listPostTargets(db, { tenantId: TENANT });
  const targetIds = targets.map((t) => t.conversationId);
  for (const convId of [V_IG_CH, V_TG_CH]) {
    assert.ok(
      targetIds.includes(convId),
      `sasaran postingan tetap memuat percakapan channel ${convId}`,
    );
  }
  console.log("[5] sasaran postingan tetap memuat baris channel akun-sendiri: OK");
}

// ---------- [6] impor CSV ----------

{
  const csv = [
    "name,phone,email,tags,opt_in",
    "Dewi Lestari,0813-555-2222,dewi@contoh.id,lead; baru,opted_in",
    "Penipu,081200001111,penipu@contoh.id,,",
    "Pengikut Dewi,0813444444,dewi@contoh.id,,",
    ",0813000111,tanpa-nama@contoh.id,,",
    "Email Rusak,0813222111,bukan-email,,",
    "Rina,0813999888,,,",
    "Joko,0813777666,,,opted_out",
  ].join("\n");
  const res = await app.request(`/tenants/${TENANT}/contacts/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    imported: number;
    duplicates: Array<{ row: number; reason: string }>;
    invalid: Array<{ row: number; reason: string }>;
  };
  assert.equal(body.imported, 3, "tiga baris sah menjadi kontak");
  assert.deepEqual(
    body.duplicates,
    [
      { row: 2, reason: "duplicate_phone" },
      { row: 3, reason: "duplicate_email" },
    ],
    "duplikat lama (telepon) & intra-berkas (email) dilewati-terlapor",
  );
  assert.deepEqual(
    body.invalid,
    [
      { row: 4, reason: "missing_name" },
      { row: 5, reason: "invalid_email" },
    ],
    "baris tidak sah terlapor beralasan",
  );
  const findByName = async (name: string) => {
    const result = await listContacts(
      db,
      { tenantId: TENANT },
      { search: name, limit: 5, offset: 0 },
    );
    return result.contacts[0];
  };
  const dewi = await findByName("Dewi Lestari");
  assert.ok(dewi, "kontak impor Dewi ada");

  assert.deepEqual(dewi!.tags, ["lead", "baru"], "tag impor terbaca dari sel bertanda pisah");
  assert.equal(
    effectiveOptInStatus(dewi!),
    "opted_in",
    "opt-in yang dinyatakan berkas diterapkan",
  );
  const rina = await findByName("Rina");
  assert.equal(
    effectiveOptInStatus(rina!),
    "none",
    "baris tanpa pernyataan opt-in TIDAK dipaksa ikut serta",
  );
  const joko = await findByName("Joko");
  assert.equal(effectiveOptInStatus(joko!), "opted_out", "opt-out berkas diterapkan");
  console.log("[6] impor CSV (sah/duplikat/tidak sah/opt-in jujur): OK");
}

// ---------- [7] ekspor CSV mengikuti filter ----------
{
  const resAll = await app.request(`/tenants/${TENANT}/contacts/export`);
  assert.equal(resAll.status, 200);
  assert.match(resAll.headers.get("Content-Type") ?? "", /text\/csv/);
  assert.match(
    resAll.headers.get("Content-Disposition") ?? "",
    /filename="contacts\.csv"/,
  );
  const textAll = await resAll.text();
  const lines = textAll.trim().split("\r\n");
  assert.equal(
    lines[0],
    "name,phone,email,tags,pipeline_stage,opt_in_status",
    "judul kolom ekspor sesuai kontrak",
  );
  for (const name of ["Budi", "Sari", "Pemilik Campuran", "Siaran Berita", "Dewi Lestari"]) {
    assert.ok(textAll.includes(name), `ekspor memuat ${name}`);
  }
  for (const name of ["IG Brand", "Kanal Promo"]) {
    assert.ok(!textAll.includes(name), `ekspor TIDAK memuat kontak akun-sendiri ${name}`);
  }
  const resSearch = await app.request(`/tenants/${TENANT}/contacts/export?search=Budi`);
  const searchLines = (await resSearch.text()).trim().split("\r\n");
  assert.equal(searchLines.length, 2, "ekspor search=Budi: judul + tepat satu baris");
  assert.ok(searchLines[1]!.startsWith("Budi,"));
  const resStage = await app.request(`/tenants/${TENANT}/contacts/export?stage=qualified`);
  const stageText = await resStage.text();
  assert.ok(stageText.includes("Sari"), "ekspor tahap=qualified memuat Sari");
  assert.ok(!stageText.includes("Budi"), "ekspor tahap=qualified tidak memuat Budi");
  console.log("[7] ekspor CSV mengikuti filter + tersaring akun-sendiri: OK");
}

// ---------- [8] aksi massal tenant-scoped ----------
{
  const bulk = async (
    payload: unknown,
    user = OWNER,
  ): Promise<{ status: number; body: { succeeded: number; failed: Array<{ id: string; reason: string }> } }> => {
    const res = await app.request(`/tenants/${TENANT}/contacts/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": user },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as never };
  };

  const addTag = await bulk({
    action: "add_tag",
    tag: "promo",
    ids: [CUST1, CUST2, CUSTB, UNKNOWN_ID],
  });
  assert.equal(addTag.status, 200);
  assert.equal(addTag.body.succeeded, 2, "dua kontak tenant sendiri berhasil");
  assert.deepEqual(
    addTag.body.failed,
    [
      { id: CUSTB, reason: "not_found" },
      { id: UNKNOWN_ID, reason: "not_found" },
    ],
    "id tenant lain + id tak dikenal dilaporkan not_found, bukan menggagalkan panggilan",
  );
  const custBRow = await client.query(
    `SELECT tags FROM contacts WHERE id = $1`,
    [CUSTB],
  );
  assert.deepEqual(
    (custBRow.rows[0] as { tags: string[] }).tags,
    [],
    "kontak tenant lain tidak tersentuh aksi massal",
  );
  assert.ok((await getContact(db, { tenantId: TENANT }, CUST1))!.tags.includes("promo"));

  const removeTag = await bulk({ action: "remove_tag", tag: "vip", ids: [CUST2] });
  assert.equal(removeTag.body.succeeded, 1);
  const cust2AfterTag = (await getContact(db, { tenantId: TENANT }, CUST2))!;
  assert.ok(!cust2AfterTag.tags.includes("vip"), "tag vip terlepas");
  assert.ok(cust2AfterTag.tags.includes("webinar"), "tag lain dipertahankan");

  const setStage = await bulk({ action: "set_stage", stage: "customer", ids: [CUST1] });
  assert.equal(setStage.body.succeeded, 1);
  assert.equal(
    (await getContact(db, { tenantId: TENANT }, CUST1))!.pipelineStage,
    "customer",
  );

  const optOut = await bulk({ action: "opt_out", ids: [CUST2] });
  assert.equal(optOut.body.succeeded, 1);
  assert.equal(
    effectiveOptInStatus((await getContact(db, { tenantId: TENANT }, CUST2))!),
    "opted_out",
    "opt-out massal mengubah status efektif",
  );
  const auditRows = await client.query(
    `SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'contact.opt_in_changed' AND meta->>'contactId' = $2`,
    [TENANT, CUST2],
  );
  assert.equal(
    (auditRows.rows[0] as { n: number }).n,
    1,
    "opt-out massal menulis audit persetujuan (source manual)",
  );

  const deleteForeign = await bulk({ action: "delete", ids: [CUSTB] });
  assert.equal(deleteForeign.body.succeeded, 0);
  assert.deepEqual(deleteForeign.body.failed, [{ id: CUSTB, reason: "not_found" }]);
  const custBStill = await client.query(`SELECT count(*)::int AS n FROM contacts WHERE id = $1`, [CUSTB]);
  assert.equal((custBStill.rows[0] as { n: number }).n, 1, "kontak tenant lain utuh");

  const deleteAsMember = await bulk({ action: "delete", ids: [CUST1] }, MEMBER);
  assert.equal(deleteAsMember.status, 403, "hapus massal digerbang owner/admin");

  const deleteOwn = await bulk({ action: "delete", ids: [CUST1] });
  assert.equal(deleteOwn.body.succeeded, 1);
  assert.equal(await getContact(db, { tenantId: TENANT }, CUST1), null, "kontak terhapus");
  const convGone = await client.query(
    `SELECT count(*)::int AS n FROM conversations WHERE contact_id = $1`,
    [CUST1],
  );
  assert.equal(
    (convGone.rows[0] as { n: number }).n,
    0,
    "percakapan kontak terhapus ikut cascade",
  );
  console.log("[8] aksi massal (tag/tahap/opt-out/hapus, tenant-scoped, gerbang peran): OK");
}

// ---------- [9] field kustom: gabung + hapus kunci ----------
{
  const patch = async (payload: unknown) => {
    const res = await app.request(`/tenants/${TENANT}/contacts/${CUST2}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as { customFields: Record<string, unknown> };
  };
  const first = await patch({ customFields: { kota: "Bandung", skor: "5" } });
  assert.deepEqual(first.customFields, { kota: "Bandung", skor: "5" });
  const second = await patch({
    customFields: { skor: "7" },
    customFieldsDelete: ["kota"],
  });
  assert.deepEqual(
    second.customFields,
    { skor: "7" },
    "kunci terhapus hilang; kunci lain tergabung seperti biasa",
  );
  const stored = await getContact(db, { tenantId: TENANT }, CUST2);
  assert.deepEqual(stored!.customFields, { skor: "7" }, "hasil tersimpan di basis data");
  console.log("[9] field kustom gabung + hapus kunci: OK");
}

// ---------- [10] endpoint percakapan kontak ----------
{
  const resMixed = await app.request(`/tenants/${TENANT}/contacts/${MIXED}/conversations`);
  assert.equal(resMixed.status, 200);
  const mixedBody = (await resMixed.json()) as {
    conversations: Array<{ id: string; kind: string; provider: string }>;
  };
  assert.deepEqual(
    mixedBody.conversations.map((c) => c.kind).sort(),
    ["channel", "private"],
    "kontak campuran: percakapan channel + DM keduanya dikembalikan apa adanya",
  );
  const resCust = await app.request(`/tenants/${TENANT}/contacts/${CUST2}/conversations`);
  const custBody = (await resCust.json()) as {
    conversations: Array<{ id: string; kind: string; provider: string }>;
  };
  assert.deepEqual(
    custBody.conversations.map((c) => c.id),
    [V_C2_DM],
    "pelanggan: tepat percakapan DM-nya",
  );
  const res404 = await app.request(`/tenants/${TENANT}/contacts/${UNKNOWN_ID}/conversations`);
  assert.equal(res404.status, 404, "kontak tak dikenal → 404");
  console.log("[10] endpoint percakapan kontak: OK");
}

console.log("verify:contacts — SEMUA LULUS");
