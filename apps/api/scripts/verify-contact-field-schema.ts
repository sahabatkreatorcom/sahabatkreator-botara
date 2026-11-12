/**
 * Verifikasi Gelombang G18 butir 1 — SKEMA FIELD KUSTOM BERTIPE,
 * di atas PGlite. Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan:
 *   [1] CRUD definisi via HTTP: buat (201), kunci duplikat → 409
 *       CONTACT_FIELD_DEFINITION_DUPLICATE, select tanpa pilihan →
 *       400, tipe non-select membawa pilihan → 400, PATCH label/tipe
 *       (kunci TIDAK berubah walau body menyebutnya), beralih ke
 *       select tanpa pilihan → 400, DELETE → 204 dan definisi hilang.
 *   [2] validasi saat BUAT kontak: number kanonis ("1500,5" →
 *       "1500.5"), number tidak sah → 400 CONTACT_FIELD_INVALID
 *       (issues per field), tanggal kalender tidak nyata (30 Feb)
 *       → 400, boolean "ya" tersimpan "true", select di luar pilihan
 *       → 400, field wajib hilang → 400 required_missing, field
 *       bebas tanpa definisi lolos apa adanya.
 *   [3] validasi saat PATCH (gabung): nilai salah → 400; nilai
 *       TERSIMPAN lama yang melanggar skema TIDAK dinilai ulang
 *       (PATCH nama + field lain tetap 200 dan nilai lama utuh);
 *       nilai sah dinormalisasi saat digabung.
 *   [4] impor CSV menghormati skema: kolom berjudul kunci definisi
 *       menjadi field kustom (nilai ternormalisasi), baris dengan
 *       nilai salah tipe DITOLAK beralasan
 *       invalid_custom_field:<kunci>:<sebab>, baris tanpa field
 *       wajib ditolak, kontak lama tenant tidak berubah.
 *   [5] isolasi tenant: definisi tenant A tidak terlihat dan tidak
 *       menegakkan apa pun di tenant B.
 *   [6] menghapus definisi TIDAK menghapus nilai: kontak yang sudah
 *       menyimpan nilai field itu mempertahankannya (kini bebas —
 *       nilai yang sama yang tadinya ditolak kini diterima).
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:contact-field-schema
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
const LEGACY_CONTACT = "22000000-0000-4000-8000-0000000000a1";

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
// Kontak warisan tenant A: nilainya melanggar skema yang BARU akan
// dibuat di bawah (umur bukan angka) — data lama tidak boleh disentuh.
await client.query(
  `INSERT INTO contacts (id, tenant_id, name, custom_fields) VALUES ($1, $2, 'Kontak Warisan', '{"umur": "bukan-angka", "bebas": "tetap"}'::jsonb)`,
  [LEGACY_CONTACT, TENANT],
);

const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? OWNER;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createContactsRoutes(bundle));

interface DefJson {
  id: string;
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
}
interface ContactJson {
  id: string;
  name: string;
  customFields: Record<string, unknown>;
}
interface ErrJson {
  error: { code: string; details?: { issues?: { key: string; reason: string }[] } };
}

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

const defsBase = `/tenants/${TENANT}/contacts/field-definitions`;
const contactsBase = `/tenants/${TENANT}/contacts`;

// --- [1] CRUD definisi -----------------------------------------------------
{
  const created = await call("POST", defsBase, OWNER, {
    key: "umur",
    label: "Umur",
    type: "number",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const def = created.body as unknown as DefJson;
  assert.equal(def.key, "umur");
  assert.equal(def.type, "number");
  assert.deepEqual(def.options, []);

  const dup = await call("POST", defsBase, OWNER, {
    key: "umur",
    label: "Umur Lagi",
    type: "text",
  });
  assert.equal(dup.status, 409);
  assert.equal((dup.body as unknown as ErrJson).error.code, "CONTACT_FIELD_DEFINITION_DUPLICATE");

  const selectNoOptions = await call("POST", defsBase, OWNER, {
    key: "paket",
    label: "Paket",
    type: "select",
  });
  assert.equal(selectNoOptions.status, 400);

  const textWithOptions = await call("POST", defsBase, OWNER, {
    key: "kota",
    label: "Kota",
    type: "text",
    options: ["Jakarta"],
  });
  assert.equal(textWithOptions.status, 400);

  const select = await call("POST", defsBase, OWNER, {
    key: "paket",
    label: "Paket",
    type: "select",
    options: ["Basic", "Pro"],
    required: true,
  });
  assert.equal(select.status, 201, JSON.stringify(select.body));
  const selectDef = select.body as unknown as DefJson;

  await call("POST", defsBase, OWNER, { key: "lahir", label: "Tanggal Lahir", type: "date" });
  await call("POST", defsBase, OWNER, { key: "aktif", label: "Aktif", type: "boolean" });
  await call("POST", defsBase, OWNER, { key: "kota", label: "Kota", type: "text" });

  const list = await call("GET", defsBase);
  assert.equal(list.status, 200);
  const defs = (list.body as unknown as { definitions: DefJson[] }).definitions;
  assert.deepEqual(
    defs.map((d) => d.key),
    ["aktif", "kota", "lahir", "paket", "umur"],
  );

  // PATCH: label berubah, kunci TIDAK walau body menyebut kunci lain.
  const patched = await call("PATCH", `${defsBase}/${def.id}`, OWNER, {
    label: "Umur (tahun)",
    key: "diganti",
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal((patched.body as unknown as DefJson).label, "Umur (tahun)");
  assert.equal((patched.body as unknown as DefJson).key, "umur");

  // Beralih ke select tanpa pilihan yang tersimpan/dikirim → 400.
  const toSelect = await call("PATCH", `${defsBase}/${def.id}`, OWNER, {
    type: "select",
  });
  assert.equal(toSelect.status, 400);

  // Beralih ke select DENGAN pilihan → 200; kembali ke number membersihkan pilihan.
  const toSelectOk = await call("PATCH", `${defsBase}/${def.id}`, OWNER, {
    type: "select",
    options: ["muda", "dewasa"],
  });
  assert.equal(toSelectOk.status, 200);
  assert.deepEqual((toSelectOk.body as unknown as DefJson).options, ["muda", "dewasa"]);
  const backToNumber = await call("PATCH", `${defsBase}/${def.id}`, OWNER, {
    type: "number",
  });
  assert.equal(backToNumber.status, 200);
  assert.deepEqual((backToNumber.body as unknown as DefJson).options, []);

  const missing = await call("PATCH", `${defsBase}/22000000-0000-4000-8000-000000000999`, OWNER, { label: "X" });
  assert.equal(missing.status, 404);

  // Hapus definisi 'kota' (dipakai lagi di [6] lewat field lain).
  const kotaDef = defs.find((d) => d.key === "kota")!;
  const del = await call("DELETE", `${defsBase}/${kotaDef.id}`);
  assert.equal(del.status, 204);
  const delAgain = await call("DELETE", `${defsBase}/${kotaDef.id}`);
  assert.equal(delAgain.status, 404);
  void selectDef;
  console.log("[1] CRUD definisi + kunci immutable + gerbang select: OK");
}

// --- [2] validasi saat BUAT kontak ------------------------------------------
{
  const ok = await call("POST", contactsBase, OWNER, {
    name: "Budi",
    customFields: {
      umur: "27,5",
      paket: "Pro",
      lahir: "1998-05-17",
      aktif: "ya",
      hobi: "membaca",
    },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const contact = ok.body as unknown as ContactJson;
  assert.equal(contact.customFields.umur, "27.5");
  assert.equal(contact.customFields.aktif, "true");
  assert.equal(contact.customFields.paket, "Pro");
  assert.equal(contact.customFields.hobi, "membaca");

  const badNumber = await call("POST", contactsBase, OWNER, {
    name: "Salah Umur",
    customFields: { umur: "tiga puluh", paket: "Pro" },
  });
  assert.equal(badNumber.status, 400);
  const badNumberErr = badNumber.body as unknown as ErrJson;
  assert.equal(badNumberErr.error.code, "CONTACT_FIELD_INVALID");
  assert.deepEqual(badNumberErr.error.details?.issues, [
    { key: "umur", reason: "invalid_number" },
  ]);

  const badDate = await call("POST", contactsBase, OWNER, {
    name: "Salah Tanggal",
    customFields: { paket: "Basic", lahir: "2026-02-30" },
  });
  assert.equal(badDate.status, 400);
  assert.deepEqual(
    (badDate.body as unknown as ErrJson).error.details?.issues,
    [{ key: "lahir", reason: "invalid_date" }],
  );

  const badOption = await call("POST", contactsBase, OWNER, {
    name: "Salah Paket",
    customFields: { paket: "Enterprise" },
  });
  assert.equal(badOption.status, 400);
  assert.deepEqual(
    (badOption.body as unknown as ErrJson).error.details?.issues,
    [{ key: "paket", reason: "invalid_option" }],
  );

  const missingRequired = await call("POST", contactsBase, OWNER, {
    name: "Tanpa Paket",
    customFields: { umur: "30" },
  });
  assert.equal(missingRequired.status, 400);
  assert.deepEqual(
    (missingRequired.body as unknown as ErrJson).error.details?.issues,
    [{ key: "paket", reason: "required_missing" }],
  );
  console.log("[2] validasi BUAT: kanonisasi + semua alasan persis: OK");
}

// --- [3] validasi PATCH + nilai warisan tidak dinilai ulang ------------------
{
  const badPatch = await call("PATCH", `${contactsBase}/${LEGACY_CONTACT}`, OWNER, {
    customFields: { umur: "masih bukan angka" },
  });
  assert.equal(badPatch.status, 400);
  assert.equal((badPatch.body as unknown as ErrJson).error.code, "CONTACT_FIELD_INVALID");

  // PATCH nama + field bebas lain: nilai warisan 'umur' yang melanggar
  // skema TIDAK ikut dinilai — simpan berhasil dan nilai lama utuh.
  const okPatch = await call("PATCH", `${contactsBase}/${LEGACY_CONTACT}`, OWNER, {
    name: "Kontak Warisan Baru",
    customFields: { catatan: "halo" },
  });
  assert.equal(okPatch.status, 200, JSON.stringify(okPatch.body));
  const patched = okPatch.body as unknown as ContactJson;
  assert.equal(patched.customFields.umur, "bukan-angka");
  assert.equal(patched.customFields.catatan, "halo");

  // Nilai sah dinormalisasi saat digabung.
  const normPatch = await call("PATCH", `${contactsBase}/${LEGACY_CONTACT}`, OWNER, {
    customFields: { umur: "41" },
  });
  assert.equal(normPatch.status, 200);
  assert.equal((normPatch.body as unknown as ContactJson).customFields.umur, "41");
  console.log("[3] PATCH: nilai kiriman divalidasi, nilai warisan utuh: OK");
}

// --- [4] impor CSV menghormati skema -----------------------------------------
{
  const csv = [
    "name,phone,paket,umur",
    "Impor Sah,+628120000001,Pro,33",
    "Impor Salah Paket,+628120000002,Enterprise,33",
    "Impor Salah Umur,+628120000003,Basic,abc",
    "Impor Tanpa Paket,+628120000004,,33",
  ].join("\n");
  const res = await call("POST", `${contactsBase}/import`, OWNER, { csv });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const report = res.body as unknown as {
    imported: number;
    invalid: { row: number; reason: string }[];
    duplicates: unknown[];
  };
  assert.equal(report.imported, 1);
  const reasons = report.invalid.map((i) => `${i.row}:${i.reason}`).sort();
  assert.deepEqual(reasons, [
    "2:invalid_custom_field:paket:invalid_option",
    "3:invalid_custom_field:umur:invalid_number",
    "4:invalid_custom_field:paket:required_missing",
  ]);
  const rows = await client.query<{ custom_fields: Record<string, unknown> }>(
    `SELECT custom_fields FROM contacts WHERE tenant_id = $1 AND name = 'Impor Sah'`,
    [TENANT],
  );
  assert.equal(rows.rows[0]?.custom_fields.paket, "Pro");
  assert.equal(rows.rows[0]?.custom_fields.umur, "33");
  console.log("[4] impor CSV: kolom definisi tervalidasi + alasan per baris: OK");
}

// --- [5] isolasi tenant --------------------------------------------------------
{
  const listB = await call("GET", `/tenants/${TENANT_B}/contacts/field-definitions`, OWNER_B);
  assert.deepEqual(
    (listB.body as unknown as { definitions: DefJson[] }).definitions,
    [],
  );
  // Nilai yang ditolak di tenant A sah di tenant B (tanpa skema).
  const okB = await call("POST", `/tenants/${TENANT_B}/contacts`, OWNER_B, {
    name: "Kontak B",
    customFields: { umur: "bukan angka pun boleh" },
  });
  assert.equal(okB.status, 201, JSON.stringify(okB.body));
  console.log("[5] isolasi tenant definisi + penegakan: OK");
}

// --- [6] hapus definisi tidak menghapus nilai ----------------------------------
{
  const before = await call("GET", defsBase);
  const aktifDef = (before.body as unknown as { definitions: DefJson[] }).definitions.find(
    (d) => d.key === "aktif",
  )!;
  // Nilai boolean tidak sah ditolak selama definisi ada.
  const rejected = await call("POST", contactsBase, OWNER, {
    name: "Sebelum Hapus",
    customFields: { paket: "Pro", aktif: "mungkin" },
  });
  assert.equal(rejected.status, 400);
  const del = await call("DELETE", `${defsBase}/${aktifDef.id}`);
  assert.equal(del.status, 204);
  // Nilai tersimpan kontak yang dibuat di [2] tetap ada…
  const rows = await client.query<{ custom_fields: Record<string, unknown> }>(
    `SELECT custom_fields FROM contacts WHERE tenant_id = $1 AND name = 'Budi'`,
    [TENANT],
  );
  assert.equal(rows.rows[0]?.custom_fields.aktif, "true");
  // …dan nilai yang sama kini diterima sebagai field bebas.
  const accepted = await call("POST", contactsBase, OWNER, {
    name: "Sesudah Hapus",
    customFields: { paket: "Pro", aktif: "mungkin" },
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal((accepted.body as unknown as ContactJson).customFields.aktif, "mungkin");
  console.log("[6] hapus definisi: nilai kontak utuh, field menjadi bebas: OK");
}

console.log("verify-contact-field-schema: SEMUA LULUS");
process.exit(0);
