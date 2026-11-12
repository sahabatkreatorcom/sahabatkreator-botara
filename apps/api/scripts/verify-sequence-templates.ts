/**
 * Verifikasi Gelombang G2 — lapisan templat sequence — di atas PGlite
 * + seluruh migrasi + aplikasi Hono dengan AuthBundle tiruan (pola
 * verify-agent-templates).
 *
 * Membuktikan modul automations untuk templat sequence pribadi +
 * katalog sequence dwibahasa:
 *   [1] POST /sequence-templates (tenant A) → 201, field ter-echo
 *       benar (name/keywords/match/steps berposisi 1..n), id uuid;
 *   [2] GET daftar A memuatnya; GET daftar tenant B kosong
 *       (isolasi keterlihatan);
 *   [3] B membuat templatnya; A DELETE templat B → 404 NOT_FOUND dan
 *       daftar B utuh; id bukan uuid → 404; B DELETE miliknya → 200;
 *   [4] user tanpa membership di A → 404 TENANT_NOT_FOUND untuk
 *       GET & POST templat pribadi;
 *   [5] langkah BERPENANDA diterima 201 (penanda tidak pernah
 *       ditolak) dan instantiate templat pribadi → 201 automation
 *       kind='sequence' NONAKTIF dengan langkah tersalin persis;
 *   [6] isolasi pakai: B instantiate templat A → 404 NOT_FOUND;
 *       A instantiate dengan timpaan nama → nama terterap;
 *   [7] katalog: GET /automations/templates memuat tepat 6 template
 *       sequence (termasuk 3 baru G2) dengan langkah pratinjau;
 *       ?locale=en mengembalikan teks Inggris; instantiate
 *       edukasi-produk-bertahap locale en → nama + langkah Inggris,
 *       locale id → Indonesia;
 *   [8] validasi templat pribadi: langkah kosong / >10 langkah /
 *       jeda 43201 / nama kosong / kata kunci kosong → 400.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:sequence-templates
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
import { createAutomationsRoutes } from "../src/modules/automations/routes";

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

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@sk.test', 'Pemilik A'), ($2, 'b@sk.test', 'Pemilik B'), ($3, 'luar@sk.test', 'Orang Luar')`,
  [USER_A, USER_B, USER_OUTSIDER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
  [TENANT_A, USER_A, TENANT_B, USER_B],
);

// ---------------------------------------------------------------------------
// Aplikasi uji: modul automations sungguhan + appUser dari header uji.
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? USER_A;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
app.route("/", createAutomationsRoutes({ db } as unknown as AuthBundle));

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StepBody {
  position: number;
  delayMinutes: number;
  text: string;
}
interface SeqTemplateBody {
  id: string;
  name: string;
  keywords: string[];
  match: string;
  steps: StepBody[];
  createdAt: string;
  updatedAt: string;
}
interface AutomationBody {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
  steps: StepBody[];
}
interface CatalogSummaryBody {
  slug: string;
  kind: string;
  stepCount: number;
  steps: { delayMinutes: number; text: string }[];
}
type AnyBody = SeqTemplateBody &
  AutomationBody & {
    templates?: (SeqTemplateBody | CatalogSummaryBody)[];
    error?: { code: string };
  };

async function call(
  method: string,
  url: string,
  userId: string,
  body?: unknown,
): Promise<{ status: number; body: AnyBody }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": userId,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as AnyBody };
}

const seqUrl = (tenantId: string) => `/tenants/${tenantId}/sequence-templates`;
const catalogUrl = (tenantId: string, qs = "") =>
  `/tenants/${tenantId}/automations/templates${qs}`;

const STEPS_A = [
  { delayMinutes: 0, text: "Halo {name}, selamat datang!" },
  { delayMinutes: 1440, text: "Hai {name}, cek lagi besok ya." },
];

let templateAId = "";
let templateBId = "";

// ---------- [1] POST buat templat → 201 + field ter-echo ----------
{
  const { status, body } = await call("POST", seqUrl(TENANT_A), USER_A, {
    name: "Sambutan Toko Saya",
    keywords: ["daftar", "gabung"],
    match: "contains",
    steps: STEPS_A,
  });
  assert.equal(status, 201);
  assert.match(body.id, UUID_RE);
  assert.equal(body.name, "Sambutan Toko Saya");
  assert.deepEqual(body.keywords, ["daftar", "gabung"]);
  assert.equal(body.match, "contains");
  assert.equal(body.steps.length, 2);
  assert.equal(body.steps[0]?.position, 1);
  assert.equal(body.steps[0]?.delayMinutes, 0);
  assert.equal(body.steps[0]?.text, STEPS_A[0]?.text);
  assert.equal(body.steps[1]?.position, 2);
  assert.equal(body.steps[1]?.delayMinutes, 1440);
  assert.ok(body.createdAt);
  assert.ok(body.updatedAt);
  templateAId = body.id;
  console.log("[1] POST templat A → 201; name/keywords/match/steps berposisi ter-echo; id uuid: OK");
}

// ---------- [2] GET daftar: A memuatnya, B kosong ----------
{
  const listA = await call("GET", seqUrl(TENANT_A), USER_A);
  assert.equal(listA.status, 200);
  assert.equal(listA.body.templates?.length, 1);
  assert.equal(
    (listA.body.templates?.[0] as SeqTemplateBody).id,
    templateAId,
  );

  const listB = await call("GET", seqUrl(TENANT_B), USER_B);
  assert.equal(listB.status, 200);
  assert.deepEqual(listB.body.templates, []);
  console.log("[2] GET daftar A memuat templatnya; daftar B kosong (isolasi keterlihatan): OK");
}

// ---------- [3] DELETE lintas tenant → 404; pemilik menghapus → 200 ----------
{
  const createdB = await call("POST", seqUrl(TENANT_B), USER_B, {
    name: "Templat B",
    keywords: ["halo"],
    steps: [{ delayMinutes: 0, text: "Halo dari B" }],
  });
  assert.equal(createdB.status, 201);
  // Bawaan kontrak: match 'exact' bila tak dikirim.
  assert.equal(createdB.body.match, "exact");
  templateBId = createdB.body.id;

  const cross = await call(
    "DELETE",
    `${seqUrl(TENANT_A)}/${templateBId}`,
    USER_A,
  );
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error?.code, "NOT_FOUND");

  const notUuid = await call(
    "DELETE",
    `${seqUrl(TENANT_A)}/bukan-uuid`,
    USER_A,
  );
  assert.equal(notUuid.status, 404);
  assert.equal(notUuid.body.error?.code, "NOT_FOUND");

  const listB = await call("GET", seqUrl(TENANT_B), USER_B);
  assert.equal(listB.body.templates?.length, 1);

  const own = await call(
    "DELETE",
    `${seqUrl(TENANT_B)}/${templateBId}`,
    USER_B,
  );
  assert.equal(own.status, 200);
  assert.equal(own.body.id, templateBId);

  const listBAfter = await call("GET", seqUrl(TENANT_B), USER_B);
  assert.deepEqual(listBAfter.body.templates, []);
  console.log("[3] DELETE lintas tenant → 404 & daftar B utuh; bukan-uuid → 404; hapus milik sendiri → 200: OK");
}

// ---------- [4] Outsider → 404 TENANT_NOT_FOUND ----------
{
  const getOut = await call("GET", seqUrl(TENANT_A), USER_OUTSIDER);
  assert.equal(getOut.status, 404);
  assert.equal(getOut.body.error?.code, "TENANT_NOT_FOUND");

  const postOut = await call("POST", seqUrl(TENANT_A), USER_OUTSIDER, {
    name: "Penyusup",
    keywords: ["x"],
    steps: [{ delayMinutes: 0, text: "x" }],
  });
  assert.equal(postOut.status, 404);
  assert.equal(postOut.body.error?.code, "TENANT_NOT_FOUND");
  console.log("[4] Non-member → 404 TENANT_NOT_FOUND untuk GET & POST templat pribadi: OK");
}

// ---------- [5] Penanda diterima + instantiate templat pribadi ----------
{
  const created = await call("POST", seqUrl(TENANT_A), USER_A, {
    name: "Berpenanda",
    keywords: ["promo"],
    match: "contains",
    steps: [
      {
        delayMinutes: 0,
        text: "Halo {name}! Di [nama bisnis] ada [kode promo] untukmu: [link katalog]",
      },
      { delayMinutes: 2880, text: "Terakhir, {name}: [kode promo] berakhir [tanggal berakhir]." },
    ],
  });
  assert.equal(created.status, 201);
  const berpenandaId = created.body.id;

  const used = await call(
    "POST",
    `${seqUrl(TENANT_A)}/${berpenandaId}/instantiate`,
    USER_A,
    {},
  );
  assert.equal(used.status, 201);
  assert.equal(used.body.kind, "sequence");
  // Keselamatan instantiate: selalu NONAKTIF.
  assert.equal(used.body.isActive, false);
  assert.equal(used.body.name, "Berpenanda");
  assert.equal(used.body.steps.length, 2);
  assert.equal(
    used.body.steps[0]?.text,
    "Halo {name}! Di [nama bisnis] ada [kode promo] untukmu: [link katalog]",
  );
  assert.equal(used.body.steps[1]?.delayMinutes, 2880);
  console.log("[5] Langkah berpenanda diterima 201; instantiate → automation sequence NONAKTIF, langkah tersalin persis: OK");
}

// ---------- [6] Isolasi pakai + timpaan nama ----------
{
  const crossUse = await call(
    "POST",
    `${seqUrl(TENANT_B)}/${templateAId}/instantiate`,
    USER_B,
    {},
  );
  assert.equal(crossUse.status, 404);
  assert.equal(crossUse.body.error?.code, "NOT_FOUND");

  const renamed = await call(
    "POST",
    `${seqUrl(TENANT_A)}/${templateAId}/instantiate`,
    USER_A,
    { name: "Nama Hasil Pakai" },
  );
  assert.equal(renamed.status, 201);
  assert.equal(renamed.body.name, "Nama Hasil Pakai");
  assert.equal(renamed.body.isActive, false);
  console.log("[6] Instantiate lintas tenant → 404; timpaan nama terterap pada automation baru: OK");
}

// ---------- [7] Katalog dwibahasa + instantiate per locale ----------
{
  const list = await call("GET", catalogUrl(TENANT_A), USER_A);
  assert.equal(list.status, 200);
  const summaries = (list.body.templates ?? []) as CatalogSummaryBody[];
  const sequences = summaries.filter((s) => s.kind === "sequence");
  assert.deepEqual(
    sequences.map((s) => s.slug).sort(),
    [
      "edukasi-produk-bertahap",
      "follow-up-tanya",
      "pengingat-keranjang",
      "reaktivasi-pelanggan-lama",
      "sambutan-pelanggan-baru",
      "seri-materi-kreator",
    ],
  );
  // Pratinjau: langkah ikut di ringkasan sequence; keyword kosong.
  const sambutan = sequences.find((s) => s.slug === "sambutan-pelanggan-baru");
  assert.equal(sambutan?.steps.length, sambutan?.stepCount);
  assert.ok(sambutan?.steps[0]?.text.includes("Selamat datang"));
  const keyword = summaries.find((s) => s.kind === "keyword");
  assert.deepEqual(keyword?.steps, []);

  const listEn = await call("GET", catalogUrl(TENANT_A, "?locale=en"), USER_A);
  const sambutanEn = (
    (listEn.body.templates ?? []) as CatalogSummaryBody[]
  ).find((s) => s.slug === "sambutan-pelanggan-baru");
  assert.ok(sambutanEn?.steps[0]?.text.includes("Welcome"));

  const useEn = await call(
    "POST",
    `${catalogUrl(TENANT_A)}/edukasi-produk-bertahap`,
    USER_A,
    { locale: "en" },
  );
  assert.equal(useEn.status, 201);
  assert.equal(useEn.body.name, "Step-by-Step Product Education");
  assert.equal(useEn.body.isActive, false);
  assert.ok(useEn.body.steps[0]?.text.includes("[business name]"));

  const useId = await call(
    "POST",
    `${catalogUrl(TENANT_A)}/edukasi-produk-bertahap`,
    USER_A,
    { locale: "id" },
  );
  assert.equal(useId.status, 201);
  assert.equal(useId.body.name, "Edukasi Produk Bertahap");
  assert.ok(useId.body.steps[0]?.text.includes("[nama bisnis]"));
  console.log("[7] Katalog memuat 6 sequence G2 + pratinjau per locale; instantiate en/id memakai isi locale itu: OK");
}

// ---------- [8] Validasi templat pribadi → 400 ----------
{
  const base = {
    name: "Uji",
    keywords: ["x"],
    steps: [{ delayMinutes: 0, text: "x" }],
  };
  for (const [label, payload] of [
    ["langkah kosong", { ...base, steps: [] }],
    [
      "11 langkah",
      {
        ...base,
        steps: Array.from({ length: 11 }, () => ({
          delayMinutes: 0,
          text: "x",
        })),
      },
    ],
    ["jeda 43201", { ...base, steps: [{ delayMinutes: 43201, text: "x" }] }],
    ["nama kosong", { ...base, name: "  " }],
    ["kata kunci kosong", { ...base, keywords: [] }],
  ] as const) {
    const res = await call("POST", seqUrl(TENANT_A), USER_A, payload);
    assert.equal(res.status, 400, label);
    assert.equal(res.body.error?.code, "VALIDATION_ERROR", label);
  }
  console.log("[8] Validasi: langkah kosong/>10, jeda di luar batas, nama & kata kunci kosong → 400 VALIDATION_ERROR: OK");
}

console.log("verify:sequence-templates — SEMUA LULUS");
