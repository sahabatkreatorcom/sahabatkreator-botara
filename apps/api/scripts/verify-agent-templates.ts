/**
 * Verifikasi Templat Instruction /agents (gelombang Templat
 * Instruction) — di atas PGlite + seluruh migrasi + aplikasi Hono
 * dengan AuthBundle tiruan (pola verify-pinterest-boards).
 *
 * Membuktikan modul agents untuk templat pribadi + playground draf:
 *   [1] POST buat templat (owner tenant A) → 201, field ter-echo
 *       benar (name/systemPrompt/mode/language), id uuid;
 *   [2] GET daftar A memuatnya; GET daftar tenant B kosong
 *       (isolasi keterlihatan);
 *   [3] B membuat templatnya; A DELETE templat B → 404 NOT_FOUND
 *       dan daftar B utuh; B DELETE miliknya → 200; daftar B kosong
 *       sesudahnya (id bukan uuid → 404 NOT_FOUND juga);
 *   [4] user tanpa membership di A → 404 TENANT_NOT_FOUND untuk
 *       GET & POST templat;
 *   [5] systemPrompt BERPENANDA ("Halo [nama bisnis], buka
 *       [jam operasional]") diterima 201 untuk templat DAN untuk
 *       POST /agents — tidak ada penolakan penanda di API;
 *   [6] POST /agents/playground-draft dengan provider mock → 200,
 *       replyText tak kosong, mode respons = mode draf yang dikirim
 *       ('auto' dan 'suggest'); draf berpenanda pun berjalan; usage
 *       playground draf tercatat berpenanda draft;
 *   [7] validasi: nama kosong → 400 VALIDATION_ERROR;
 *       systemPrompt > 20000 karakter → 400 VALIDATION_ERROR.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:agent-templates
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
import { createAgentsRoutes } from "../src/modules/agents/routes";

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
// Aplikasi uji: modul agents sungguhan + appUser dari header uji.
// Provider playground dipaksa mock lewat deps (llmProviderEnv) —
// resolusi yang sama seperti handler playground tersimpan.
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? USER_A;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
app.route(
  "/",
  createAgentsRoutes({ db } as unknown as AuthBundle, null, {
    llmProviderEnv: "mock",
  }),
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TemplateBody {
  id: string;
  name: string;
  systemPrompt: string;
  mode: string;
  language: string | null;
  createdAt: string;
  updatedAt: string;
}
interface ListBody {
  templates: TemplateBody[];
}
interface PlaygroundBody {
  replyText: string;
  mode: string;
}
type AnyBody = TemplateBody &
  ListBody &
  PlaygroundBody & {
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

const templatesUrl = (tenantId: string) =>
  `/tenants/${tenantId}/agent-templates`;
const PLACEHOLDER_PROMPT = "Halo [nama bisnis], buka [jam operasional]";

let templateAId = "";
let templateBId = "";

// ---------- [1] POST buat templat → 201 + field ter-echo ----------
{
  const { status, body } = await call("POST", templatesUrl(TENANT_A), USER_A, {
    name: "CS Ramah Pribadi",
    systemPrompt: "Kamu CS ramah toko kami.",
    mode: "auto",
    language: "id",
  });
  assert.equal(status, 201);
  assert.match(body.id, UUID_RE);
  assert.equal(body.name, "CS Ramah Pribadi");
  assert.equal(body.systemPrompt, "Kamu CS ramah toko kami.");
  assert.equal(body.mode, "auto");
  assert.equal(body.language, "id");
  assert.ok(body.createdAt);
  assert.ok(body.updatedAt);
  templateAId = body.id;
  console.log("[1] POST templat A → 201; name/systemPrompt/mode/language ter-echo; id uuid: OK");
}

// ---------- [2] GET daftar: A memuatnya, B kosong ----------
{
  const listA = await call("GET", templatesUrl(TENANT_A), USER_A);
  assert.equal(listA.status, 200);
  assert.equal(listA.body.templates.length, 1);
  assert.equal(listA.body.templates[0]?.id, templateAId);

  const listB = await call("GET", templatesUrl(TENANT_B), USER_B);
  assert.equal(listB.status, 200);
  assert.deepEqual(listB.body.templates, []);
  console.log("[2] GET daftar A memuat templatnya; daftar B kosong (isolasi keterlihatan): OK");
}

// ---------- [3] DELETE lintas tenant → 404; pemilik menghapus → 200 ----------
{
  const createdB = await call("POST", templatesUrl(TENANT_B), USER_B, {
    name: "Templat B",
    systemPrompt: "Instruction milik tenant B.",
  });
  assert.equal(createdB.status, 201);
  // Bawaan kontrak/core: mode 'suggest', language NULL.
  assert.equal(createdB.body.mode, "suggest");
  assert.equal(createdB.body.language, null);
  templateBId = createdB.body.id;

  const cross = await call(
    "DELETE",
    `${templatesUrl(TENANT_A)}/${templateBId}`,
    USER_A,
  );
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error?.code, "NOT_FOUND");

  const notUuid = await call(
    "DELETE",
    `${templatesUrl(TENANT_A)}/bukan-uuid`,
    USER_A,
  );
  assert.equal(notUuid.status, 404);
  assert.equal(notUuid.body.error?.code, "NOT_FOUND");

  const listBBefore = await call("GET", templatesUrl(TENANT_B), USER_B);
  assert.equal(listBBefore.body.templates.length, 1);
  assert.equal(listBBefore.body.templates[0]?.id, templateBId);

  const deleted = await call(
    "DELETE",
    `${templatesUrl(TENANT_B)}/${templateBId}`,
    USER_B,
  );
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.id, templateBId);
  assert.equal(deleted.body.name, "Templat B");

  const listBAfter = await call("GET", templatesUrl(TENANT_B), USER_B);
  assert.deepEqual(listBAfter.body.templates, []);
  console.log("[3] A DELETE templat B → 404 NOT_FOUND + daftar B utuh; id bukan uuid → 404; B DELETE miliknya → 200 + daftar kosong: OK");
}

// ---------- [4] Non-member → 404 TENANT_NOT_FOUND ----------
{
  const get = await call("GET", templatesUrl(TENANT_A), USER_OUTSIDER);
  assert.equal(get.status, 404);
  assert.equal(get.body.error?.code, "TENANT_NOT_FOUND");

  const post = await call("POST", templatesUrl(TENANT_A), USER_OUTSIDER, {
    name: "Penyusup",
    systemPrompt: "Tidak boleh tersimpan.",
  });
  assert.equal(post.status, 404);
  assert.equal(post.body.error?.code, "TENANT_NOT_FOUND");
  console.log("[4] user tanpa membership di A → 404 TENANT_NOT_FOUND untuk GET & POST: OK");
}

// ---------- [5] systemPrompt berpenanda diterima (templat + agent) ----------
{
  const tpl = await call("POST", templatesUrl(TENANT_A), USER_A, {
    name: "Berpenanda",
    systemPrompt: PLACEHOLDER_PROMPT,
  });
  assert.equal(tpl.status, 201);
  assert.equal(tpl.body.systemPrompt, PLACEHOLDER_PROMPT);

  const agent = await call("POST", `/tenants/${TENANT_A}/agents`, USER_A, {
    name: "Agent Berpenanda",
    systemPrompt: PLACEHOLDER_PROMPT,
  });
  assert.equal(agent.status, 201);
  assert.equal(agent.body.systemPrompt, PLACEHOLDER_PROMPT);
  console.log("[5] systemPrompt berpenanda → 201 untuk templat DAN POST /agents (tanpa penolakan penanda): OK");
}

// ---------- [6] Playground draf mock: mode mengikuti draf ----------
{
  const draftUrl = `/tenants/${TENANT_A}/agents/playground-draft`;

  const auto = await call("POST", draftUrl, USER_A, {
    draft: {
      name: "Draf Auto",
      systemPrompt: "Kamu CS uji.",
      mode: "auto",
      language: "id",
    },
    message: "Halo, bisa bantu?",
  });
  assert.equal(auto.status, 200);
  assert.ok(auto.body.replyText.length > 0);
  assert.equal(auto.body.mode, "auto");

  const suggest = await call("POST", draftUrl, USER_A, {
    draft: { systemPrompt: "Kamu CS uji.", mode: "suggest" },
    message: "Halo lagi",
  });
  assert.equal(suggest.status, 200);
  assert.ok(suggest.body.replyText.length > 0);
  assert.equal(suggest.body.mode, "suggest");

  const marked = await call("POST", draftUrl, USER_A, {
    draft: { systemPrompt: PLACEHOLDER_PROMPT, mode: "suggest" },
    message: "Jam buka?",
  });
  assert.equal(marked.status, 200);
  assert.ok(marked.body.replyText.length > 0);
  assert.equal(marked.body.mode, "suggest");

  // Metering draf: baris usage playground untuk tenant A pada skrip
  // ini semuanya lari draf — ketiganya wajib berpenanda draft: true.
  const usageRows = await client.query<{ meta: Record<string, unknown> }>(
    `SELECT meta FROM usage_ledger WHERE tenant_id = $1 AND ref_type = 'agent_playground'`,
    [TENANT_A],
  );
  assert.equal(usageRows.rows.length, 3);
  for (const row of usageRows.rows) {
    assert.equal(row.meta.playground, true);
    assert.equal(row.meta.draft, true);
  }
  console.log("[6] playground-draft mock → 200; replyText tak kosong; mode auto & suggest mengikuti draf; draf berpenanda berjalan; usage berpenanda draft: OK");
}

// ---------- [7] Validasi ----------
{
  const emptyName = await call("POST", templatesUrl(TENANT_A), USER_A, {
    name: "",
    systemPrompt: "Instruction sah.",
  });
  assert.equal(emptyName.status, 400);
  assert.equal(emptyName.body.error?.code, "VALIDATION_ERROR");

  const tooLong = await call("POST", templatesUrl(TENANT_A), USER_A, {
    name: "Terlalu Panjang",
    systemPrompt: "x".repeat(20_001),
  });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error?.code, "VALIDATION_ERROR");
  console.log("[7] nama kosong → 400 VALIDATION_ERROR; systemPrompt >20000 → 400 VALIDATION_ERROR: OK");
}

await client.close();
console.log("verify agent-templates (PGlite + modul agents): SEMUA LULUS");
