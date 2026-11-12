import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@sahabat-kreator/db";
import type { Database } from "@sahabat-kreator/db";
import {
  activateFlow,
  createFlow,
  createMemoryMediaStore,
  executeFlowStep,
  startFlowRunsForInboundMessage,
  type FlowGraph,
  type MediaObjectStore,
} from "@sahabat-kreator/core";

/**
 * Verifikasi G17 butir 4 — GAMBAR DINAMIS.
 *
 * Bukti yang ditegakkan (tanpa jaringan):
 * A. Node send_dynamic_image merender kartu PNG SUNGGUHAN dengan
 *    encoder bawaan (tanda tangan PNG + IHDR 1200x630), menyimpannya
 *    ke object store tiruan lewat storeUploadedMedia (baris media
 *    lahir), dan mengantre pesan type "image" bermedia_id dengan
 *    caption yang sudah disubstitusi {name}. Run selesai.
 * B. Tanpa mediaStore di deps eksekutor: langkah tercatat
 *    skipped/media_store_unavailable dan run TETAP selesai — tidak
 *    ada pesan gambar, tidak ada kegagalan run.
 * C. Judul berisi emoji (di luar font bitmap) tetap menghasilkan
 *    PNG sah — karakter tak dikenal menjadi glyph '?', bukan crash.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_WA = "33333333-3333-4333-8333-333333333331";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../packages/db/migrations");

const client = new PGlite({ extensions: { vector, btree_gist } });
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of files) {
  const sql = await readFile(path.join(migrationsDir, file), "utf8");
  await client.exec(sql.replaceAll("--> statement-breakpoint", ""));
}
const db = drizzle(client, { schema }) as unknown as Database;

await client.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a')`,
  [TENANT],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@example.com', 'Pemilik A')`,
  [USER],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [TENANT, USER],
);
await client.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status)
   VALUES ($1, $2, 'whatsapp', '628110000000', 'WA Toko', 'connected')`,
  [ACC_WA, TENANT],
);

async function seedConversation(name: string): Promise<string> {
  const c = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name, opt_in_status) VALUES ($1, $2, 'unknown') RETURNING id`,
    [TENANT, name],
  );
  const conv = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
     VALUES ($1, $2, $3, 'whatsapp', $4, 'private', 'open') RETURNING id`,
    [TENANT, ACC_WA, c.rows[0].id, `chat-${name}`],
  );
  return conv.rows[0].id;
}

async function makeFlow(
  name: string,
  keyword: string,
  imageConfig: Record<string, unknown>,
): Promise<void> {
  const graph: FlowGraph = {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        config: { kind: "keyword", keywords: [keyword], match: "exact" },
      },
      { id: "gambar", type: "send_dynamic_image", config: imageConfig },
      { id: "selesai", type: "send_message", config: { text: "Selesai" } },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "gambar" },
      { id: "e2", from: "gambar", to: "selesai" },
    ],
  };
  const created = await createFlow(db, {
    tenantId: TENANT,
    userId: USER,
    name,
    graph,
  });
  assert.equal(
    (
      await activateFlow(db, {
        tenantId: TENANT,
        flowId: created.flow.id,
        userId: USER,
      })
    ).kind,
    "activated",
  );
}

await makeFlow("Kartu ucapan", "KARTU", {
  titleTemplate: "Selamat, {name}!",
  bodyTemplate: "Kupon spesial untuk {name}",
  captionTemplate: "Kartu untuk {name}",
});
await makeFlow("Kartu emoji", "EMOJI", {
  titleTemplate: "Halo 🎉 {name}",
});

async function inbound(
  conversationId: string,
  text: string,
  deps: { mediaStore?: MediaObjectStore },
): Promise<string> {
  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId));
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, conversation.contactId));
  const msg = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, status)
     VALUES ($1, $2, 'inbound', 'contact', $3, 'received') RETURNING id`,
    [TENANT, conversationId, text],
  );
  const outcome = await startFlowRunsForInboundMessage(db, {
    tenantId: TENANT,
    conversationId,
    messageId: msg.rows[0].id,
    messageText: text,
    contact,
    conversation,
  });
  const runId = outcome.startedRunIds[0];
  assert.ok(runId, "run mulai");
  for (let i = 0; i < 10; i++) {
    const [run] = await db
      .select()
      .from(schema.flowRuns)
      .where(eq(schema.flowRuns.id, runId));
    if (!run || run.status !== "running") break;
    await executeFlowStep(
      db,
      { tenantId: TENANT, runId, stepSeq: run.nextStepSeq },
      deps,
    );
  }
  const [finalRun] = await db
    .select()
    .from(schema.flowRuns)
    .where(eq(schema.flowRuns.id, runId));
  assert.equal(finalRun.status, "completed", "run selesai");
  return runId;
}

async function imageStepDetail(runId: string): Promise<Record<string, unknown>> {
  const r = await client.query<{ detail: Record<string, unknown> }>(
    `SELECT detail FROM flow_run_steps WHERE run_id = $1 AND node_type = 'send_dynamic_image' ORDER BY seq DESC LIMIT 1`,
    [runId],
  );
  assert.ok(r.rows.length > 0, "langkah gambar ada");
  return r.rows[0].detail;
}

// ---- A: render + store + antre -------------------------------------
const store = createMemoryMediaStore();
{
  const convId = await seedConversation("Sinta");
  const runId = await inbound(convId, "KARTU", { mediaStore: store });
  const detail = await imageStepDetail(runId);
  assert.equal(detail.outcome, "image_sent");
  assert.equal(detail.title, "Selamat, Sinta!");
  assert.ok(typeof detail.bytes === "number" && detail.bytes > 500);

  const img = await client.query<{
    content_text: string;
    media_id: string;
  }>(
    `SELECT content_text, media_id FROM messages
      WHERE conversation_id = $1 AND direction = 'outbound' AND type = 'image'`,
    [convId],
  );
  assert.equal(img.rows.length, 1, "satu pesan gambar terantre");
  assert.equal(img.rows[0].content_text, "Kartu untuk Sinta");
  assert.ok(img.rows[0].media_id, "media_id terisi");

  const mediaRow = await client.query<{ mime_type: string; size_bytes: number }>(
    `SELECT mime_type, size_bytes FROM media WHERE id = $1`,
    [img.rows[0].media_id],
  );
  assert.equal(mediaRow.rows[0].mime_type, "image/png");
  assert.equal(mediaRow.rows[0].size_bytes, detail.bytes);

  assert.equal(store.objects.size, 1, "satu objek tersimpan di store");
  const stored = [...store.objects.values()][0];
  assert.equal(stored.contentType, "image/png");
  const png = stored.data;
  // Tanda tangan PNG + IHDR.
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "tanda tangan PNG sah",
  );
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 1200, "lebar kartu 1200");
  assert.equal(png.readUInt32BE(20), 630, "tinggi kartu 630");
}

// ---- B: tanpa mediaStore → skipped, run tetap selesai ----------------
{
  const convId = await seedConversation("Bima");
  const runId = await inbound(convId, "KARTU", {});
  const detail = await imageStepDetail(runId);
  assert.equal(detail.outcome, "skipped");
  assert.equal(detail.code, "media_store_unavailable");
  const img = await client.query(
    `SELECT id FROM messages WHERE conversation_id = $1 AND type = 'image'`,
    [convId],
  );
  assert.equal(img.rows.length, 0, "tidak ada pesan gambar");
  const done = await client.query(
    `SELECT id FROM messages WHERE conversation_id = $1 AND content_text = 'Selesai'`,
    [convId],
  );
  assert.equal(done.rows.length, 1, "alur tetap lanjut ke node berikutnya");
}

// ---- C: emoji di judul → tetap PNG sah --------------------------------
{
  const convId = await seedConversation("Rara");
  const runId = await inbound(convId, "EMOJI", { mediaStore: store });
  const detail = await imageStepDetail(runId);
  assert.equal(detail.outcome, "image_sent");
  assert.equal(store.objects.size, 2, "objek kedua tersimpan");
}

console.log(
  "verify-flow-dynamic-image: SEMUA LULUS — PNG sah 1200x630 terbit di object store tiruan + baris media + pesan gambar ber-caption tersubstitusi; tanpa store langkah skipped dan run tetap selesai; emoji di judul tidak merusak render.",
);
