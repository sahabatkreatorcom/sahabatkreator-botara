/**
 * Verifikasi Gelombang G8 — catatan LEVEL KONTAK + linimasa aktivitas
 * kontak, di atas PGlite. Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan:
 *   [1] catatan kontak CRUD via HTTP: buat (penulis tercatat), daftar,
 *       hapus ditegakkan (penulis lain yang bukan owner/admin → 403;
 *       penulis → 204; owner menghapus catatan orang lain → 204);
 *       badan catatan TIDAK pernah masuk audit log.
 *   [2] isolasi tenant: kontak tenant lain tak terlihat (404 di bawah
 *       tenant sendiri), non-member → 404 TENANT_NOT_FOUND, kontak tak
 *       dikenal → 404.
 *   [3] linimasa merakit SEMUA jenis peristiwa yang tercakup dari data
 *       semai nyata (pesan, audit opt-in/merge/handoff, enrollment +
 *       transisi sequence, kedua keluarga catatan) dalam urutan
 *       terbaru→terlama dengan detail yang benar.
 *   [4] kontak tanpa aktivitas: linimasa hanya memuat `contact_created`
 *       (keadaan kosong yang jujur — tidak ada peristiwa karangan) dan
 *       daftar catatan kosong.
 *   [5] catatan kontak TIDAK bocor ke catatan percakapan dan sebaliknya
 *       (dua keluarga terpisah); linimasa membedakan kedua jenis
 *       peristiwa catatan.
 *   [6] pemotongan: sumber yang meluber → `truncated: true` dan jumlah
 *       peristiwa tepat pada batas.
 *
 * Kredensial di skrip ini nilai uji, BUKAN kredensial sungguhan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:contact-timeline
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
  createConversationNote,
  listConversationNotes,
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
const ACC_TG = "21000000-0000-4000-8000-000000000002";
// Kontak kaya aktivitas (linimasa penuh) & kontak polos (kosong).
const RICH = "22000000-0000-4000-8000-000000000201";
const PLAIN = "22000000-0000-4000-8000-000000000202";
const CUSTB = "22000000-0000-4000-8000-000000000203";
const UNKNOWN_ID = "22000000-0000-4000-8000-000000000999";
const CONV1 = "23000000-0000-4000-8000-000000000201";
const AUTO1 = "25000000-0000-4000-8000-000000000201";
const AUTO2 = "25000000-0000-4000-8000-000000000202";
const ENR1 = "26000000-0000-4000-8000-000000000201";
const ENR2 = "26000000-0000-4000-8000-000000000202";
const MERGED_VICTIM = "22000000-0000-4000-8000-000000000777";

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
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status)
   VALUES ($1, $2, 'telegram', '424242', 'Bot Uji', 'connected')`,
  [ACC_TG, TENANT],
);
// Kontak dengan waktu pembuatan yang ditetapkan agar urutan peristiwa
// semai deterministik.
await client.query(
  `INSERT INTO contacts (id, tenant_id, name, source, created_at) VALUES
   ($1, $4, 'Budi Kaya', 'manual', '2026-11-01T09:00:00Z'),
   ($2, $4, 'Polos Saja', 'manual', '2026-11-10T09:00:00Z'),
   ($3, $5, 'Orang B', 'manual', '2026-11-01T09:00:00Z')`,
  [RICH, PLAIN, CUSTB, TENANT, TENANT_B],
);
await client.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
   VALUES ($1, $2, $3, $4, 'telegram', '888', 'private', 'open')`,
  [CONV1, TENANT, ACC_TG, RICH],
);
// Pesan pertama (masuk) & terakhir (keluar) kontak kaya.
await client.query(
  `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, content_text, created_at) VALUES
   ($1, $2, 'inbound', 'contact', 'Halo, mau tanya harga', '2026-11-02T10:00:00Z'),
   ($1, $2, 'outbound', 'user', 'Halo! Ini daftar harganya', '2026-11-05T11:00:00Z')`,
  [TENANT, CONV1],
);
await client.query(
  `INSERT INTO automations (id, tenant_id, name) VALUES
   ($1, $3, 'Urutan Sambutan'), ($2, $3, 'Pengingat Keranjang')`,
  [AUTO1, AUTO2, TENANT],
);
await client.query(
  `INSERT INTO sequence_enrollments (id, tenant_id, automation_id, contact_id, conversation_id, status, created_at) VALUES
   ($1, $3, $4, $5, $6, 'completed', '2026-11-03T08:00:00Z'),
   ($2, $3, $7, $5, $6, 'cancelled', '2026-11-09T08:00:00Z')`,
  [ENR1, ENR2, TENANT, AUTO1, RICH, CONV1, AUTO2],
);
// Audit semai: persis bentuk meta yang ditulis core produksi.
const seedAudit = async (
  action: string,
  at: string,
  meta: Record<string, unknown>,
) => {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, meta, created_at)
     VALUES ($1, 'user', $2, $3, $4::jsonb, $5)`,
    [TENANT, OWNER, action, JSON.stringify(meta), at],
  );
};
await seedAudit("contact.opt_in_changed", "2026-11-04T09:00:00Z", {
  contactId: RICH,
  from: "none",
  to: "opted_in",
  source: "keyword",
});
await seedAudit("contact.merged", "2026-11-06T09:00:00Z", {
  contactId: RICH,
  mergedContactId: MERGED_VICTIM,
  mergedContactName: "Duplikat Budi",
  reasons: ["email"],
  movedIdentities: 1,
  movedConversations: 0,
});
await seedAudit("agent.handoff", "2026-11-07T09:00:00Z", {
  reason: "minta manusia",
  contactId: RICH,
  conversationId: CONV1,
  via: "keyword",
});
await seedAudit("sequence.completed", "2026-11-08T09:00:00Z", {
  automationId: AUTO1,
  enrollmentId: ENR1,
});
await seedAudit("sequence.cancelled_opt_out", "2026-11-09T09:00:00Z", {
  automationId: AUTO2,
  enrollmentId: ENR2,
});

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

interface NoteJson {
  id: string;
  contactId: string;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}
interface TimelineEventJson {
  kind: string;
  occurredAt: string;
  detail: Record<string, unknown>;
}
interface TimelineJson {
  events: TimelineEventJson[];
  truncated: boolean;
}

const getNotes = async (contactId: string, user = OWNER, tenant = TENANT) =>
  app.request(`/tenants/${tenant}/contacts/${contactId}/notes`, {
    headers: { "x-test-user": user },
  });
const postNote = async (
  contactId: string,
  body: unknown,
  user = OWNER,
  tenant = TENANT,
) =>
  app.request(`/tenants/${tenant}/contacts/${contactId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": user },
    body: JSON.stringify(body),
  });
const deleteNote = async (contactId: string, noteId: string, user = OWNER) =>
  app.request(`/tenants/${TENANT}/contacts/${contactId}/notes/${noteId}`, {
    method: "DELETE",
    headers: { "x-test-user": user },
  });
const getTimeline = async (contactId: string, query = "", user = OWNER) =>
  app.request(`/tenants/${TENANT}/contacts/${contactId}/timeline${query}`, {
    headers: { "x-test-user": user },
  });

// ---------------------------------------------------------------------------
// [1] CRUD catatan kontak + aturan hapus + audit tanpa badan catatan
// ---------------------------------------------------------------------------
{
  const createdRes = await postNote(RICH, {
    body: "Pelanggan setia sejak 2024, suka promo pagi.",
  });
  assert.equal(createdRes.status, 201, "buat catatan kontak → 201");
  const ownerNote = (await createdRes.json()) as NoteJson;
  assert.equal(ownerNote.body, "Pelanggan setia sejak 2024, suka promo pagi.");
  assert.equal(ownerNote.contactId, RICH);
  assert.equal(ownerNote.authorUserId, OWNER);
  assert.equal(ownerNote.authorName, "Pemilik A");

  const memberRes = await postNote(RICH, { body: "Catatan dari member." }, MEMBER);
  assert.equal(memberRes.status, 201, "member boleh membuat catatan");
  const memberNote = (await memberRes.json()) as NoteJson;
  assert.equal(memberNote.authorName, "Member A");

  const listRes = await getNotes(RICH);
  assert.equal(listRes.status, 200);
  const list = (await listRes.json()) as { notes: NoteJson[] };
  assert.equal(list.notes.length, 2, "daftar memuat kedua catatan");
  assert.equal(list.notes[0]?.id, ownerNote.id, "urutan pembuatan (lama→baru)");

  // Audit: aksi tercatat, tetapi badan catatan TIDAK ikut tersimpan.
  const auditRows = await client.query<{ meta: Record<string, unknown> }>(
    `SELECT meta FROM audit_logs WHERE action = 'contact.note_created'`,
  );
  assert.equal(auditRows.rows.length, 2, "dua audit note_created");
  for (const row of auditRows.rows) {
    assert.equal(row.meta.contactId, RICH);
    assert.equal(typeof row.meta.noteId, "string");
    assert.ok(
      !JSON.stringify(row.meta).includes("Pelanggan setia"),
      "badan catatan tidak bocor ke audit log",
    );
  }

  // Hapus: member bukan penulis catatan owner → 403, catatan tetap ada.
  const forbidden = await deleteNote(RICH, ownerNote.id, MEMBER);
  assert.equal(forbidden.status, 403, "member menghapus catatan orang lain → 403");
  // Penulis menghapus catatannya sendiri → 204.
  const ownDelete = await deleteNote(RICH, memberNote.id, MEMBER);
  assert.equal(ownDelete.status, 204, "penulis menghapus catatannya → 204");
  // Owner menghapus catatan (siapa pun) → 204.
  const repost = await postNote(RICH, { body: "Catatan kedua member." }, MEMBER);
  const memberNote2 = (await repost.json()) as NoteJson;
  const ownerDelete = await deleteNote(RICH, memberNote2.id, OWNER);
  assert.equal(ownerDelete.status, 204, "owner menghapus catatan member → 204");
  const ownerDeleteOwn = await deleteNote(RICH, ownerNote.id, OWNER);
  assert.equal(ownerDeleteOwn.status, 204);

  const after = (await (await getNotes(RICH)).json()) as { notes: NoteJson[] };
  assert.equal(after.notes.length, 0, "semua catatan terhapus");

  // Validasi: badan kosong → 400.
  const invalid = await postNote(RICH, { body: "   " });
  assert.equal(invalid.status, 400, "badan kosong → 400");
  console.log("[1] catatan kontak CRUD + aturan hapus + audit bersih OK");
}

// ---------------------------------------------------------------------------
// [2] Isolasi tenant
// ---------------------------------------------------------------------------
{
  // Kontak tenant B diminta di bawah tenant A → 404 (RLS + cek kontak).
  const crossNotes = await getNotes(CUSTB);
  assert.equal(crossNotes.status, 404, "catatan kontak tenant lain → 404");
  const crossTimeline = await getTimeline(CUSTB);
  assert.equal(crossTimeline.status, 404, "linimasa kontak tenant lain → 404");
  const crossCreate = await postNote(CUSTB, { body: "bocor?" });
  assert.equal(crossCreate.status, 404, "buat catatan kontak tenant lain → 404");

  // OWNER bukan member tenant B → TENANT_NOT_FOUND.
  const notMember = await getNotes(CUSTB, OWNER, TENANT_B);
  assert.equal(notMember.status, 404);
  const notMemberBody = (await notMember.json()) as { error: { code: string } };
  assert.equal(notMemberBody.error.code, "TENANT_NOT_FOUND");

  // Kontak tak dikenal → 404.
  const unknown = await getNotes(UNKNOWN_ID);
  assert.equal(unknown.status, 404);
  const unknownTimeline = await getTimeline(UNKNOWN_ID);
  assert.equal(unknownTimeline.status, 404);
  console.log("[2] isolasi tenant catatan + linimasa OK");
}

// ---------------------------------------------------------------------------
// [3] Perakitan linimasa: semua jenis tercakup, urutan & detail benar
// ---------------------------------------------------------------------------
{
  // Satu catatan kontak & satu catatan percakapan dibuat lewat core/HTTP
  // agar peristiwa "catatan ditambahkan" ikut terbit (waktu = sekarang,
  // jadi keduanya peristiwa terbaru).
  const noteRes = await postNote(RICH, { body: "Catatan untuk linimasa." });
  assert.equal(noteRes.status, 201);
  const convNote = await createConversationNote(db, {
    tenantId: TENANT,
    userId: OWNER,
    conversationId: CONV1,
    body: "Catatan percakapan untuk linimasa.",
  });
  assert.equal(convNote.kind, "created");

  const res = await getTimeline(RICH);
  assert.equal(res.status, 200);
  const timeline = (await res.json()) as TimelineJson;
  assert.equal(timeline.truncated, false);
  const kinds = timeline.events.map((e) => e.kind);
  for (const expected of [
    "contact_created",
    "first_message",
    "last_message",
    "opt_in_changed",
    "merged_in",
    "sequence_enrolled",
    "sequence_completed",
    "sequence_cancelled",
    "handoff",
    "contact_note_added",
    "conversation_note_added",
  ]) {
    assert.ok(kinds.includes(expected), `jenis tercakup hadir: ${expected}`);
  }
  assert.equal(
    kinds.filter((k) => k === "sequence_enrolled").length,
    2,
    "dua enrollment tampil",
  );

  // Urutan global terbaru→terlama.
  const times = timeline.events.map((e) => Date.parse(e.occurredAt));
  for (let i = 1; i < times.length; i++) {
    assert.ok(
      (times[i - 1] ?? 0) >= (times[i] ?? 0),
      "urutan menurun berdasarkan waktu",
    );
  }
  // Urutan relatif peristiwa semai (waktu tetap).
  const idx = (kind: string, autoId?: string) =>
    timeline.events.findIndex(
      (e) => e.kind === kind && (!autoId || e.detail.automationId === autoId),
    );
  assert.ok(idx("merged_in") < idx("last_message"), "merge sesudah pesan terakhir semai");
  assert.ok(idx("last_message") < idx("opt_in_changed"), "pesan terakhir sesudah opt-in");
  assert.ok(idx("opt_in_changed") < idx("first_message"), "opt-in sesudah pesan pertama");
  assert.ok(idx("sequence_completed") < idx("sequence_enrolled", AUTO1), "selesai sesudah masuk");
  assert.ok(idx("sequence_cancelled") < idx("sequence_enrolled", AUTO2), "batal sesudah masuk");
  assert.equal(
    kinds[kinds.length - 1],
    "contact_created",
    "peristiwa tertua = kontak dibuat",
  );

  // Detail spot-check.
  const byKind = (kind: string) =>
    timeline.events.find((e) => e.kind === kind);
  assert.deepEqual(byKind("opt_in_changed")?.detail, {
    from: "none",
    to: "opted_in",
    source: "keyword",
  });
  assert.equal(byKind("merged_in")?.detail.mergedContactName, "Duplikat Budi");
  assert.equal(byKind("first_message")?.detail.direction, "inbound");
  assert.equal(byKind("first_message")?.detail.provider, "telegram");
  assert.equal(byKind("last_message")?.detail.direction, "outbound");
  assert.equal(byKind("handoff")?.detail.reason, "minta manusia");
  assert.equal(
    timeline.events.find(
      (e) => e.kind === "sequence_enrolled" && e.detail.automationId === AUTO1,
    )?.detail.automationName,
    "Urutan Sambutan",
  );
  assert.equal(
    timeline.events.find(
      (e) => e.kind === "sequence_enrolled" && e.detail.automationId === AUTO2,
    )?.detail.automationName,
    "Pengingat Keranjang",
  );
  assert.equal(byKind("sequence_cancelled")?.detail.reason, "opt_out");
  assert.equal(byKind("contact_created")?.detail.source, "manual");
  console.log("[3] perakitan linimasa lengkap + urutan + detail OK");
}

// ---------------------------------------------------------------------------
// [4] Kontak tanpa aktivitas → linimasa kosong yang jujur
// ---------------------------------------------------------------------------
{
  const res = await getTimeline(PLAIN);
  assert.equal(res.status, 200);
  const timeline = (await res.json()) as TimelineJson;
  assert.equal(timeline.events.length, 1, "hanya peristiwa pembuatan kontak");
  assert.equal(timeline.events[0]?.kind, "contact_created");
  assert.equal(timeline.truncated, false);
  const notes = (await (await getNotes(PLAIN)).json()) as { notes: NoteJson[] };
  assert.equal(notes.notes.length, 0, "daftar catatan kosong");
  console.log("[4] kontak tanpa aktivitas OK");
}

// ---------------------------------------------------------------------------
// [5] Dua keluarga catatan tidak saling bocor
// ---------------------------------------------------------------------------
{
  const contactNotes = (await (await getNotes(RICH)).json()) as {
    notes: NoteJson[];
  };
  assert.equal(contactNotes.notes.length, 1);
  assert.equal(
    contactNotes.notes[0]?.body,
    "Catatan untuk linimasa.",
    "daftar catatan kontak hanya memuat catatan kontak",
  );
  const convNotes = await listConversationNotes(db, {
    tenantId: TENANT,
    conversationId: CONV1,
  });
  assert.ok(convNotes, "daftar catatan percakapan ada");
  assert.equal(convNotes.length, 1);
  assert.equal(
    convNotes[0]?.body,
    "Catatan percakapan untuk linimasa.",
    "daftar catatan percakapan hanya memuat catatan percakapan",
  );
  console.log("[5] catatan kontak ⟂ catatan percakapan OK");
}

// ---------------------------------------------------------------------------
// [6] Pemotongan: sumber meluber → penanda truncated + batas ditegakkan
// ---------------------------------------------------------------------------
{
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, meta, created_at)
     SELECT $1, 'user', $2, 'contact.note_created',
            jsonb_build_object('contactId', $3::text, 'noteId', gen_random_uuid()::text),
            '2026-11-11T00:00:00Z'::timestamptz + (g || ' minutes')::interval
       FROM generate_series(1, 150) AS g`,
    [TENANT, OWNER, PLAIN],
  );
  const res = await getTimeline(PLAIN);
  assert.equal(res.status, 200);
  const timeline = (await res.json()) as TimelineJson;
  assert.equal(timeline.truncated, true, "penanda terpotong menyala");
  assert.equal(timeline.events.length, 100, "tepat pada batas bawaan 100");
  assert.ok(
    timeline.events.every((e) => e.kind === "contact_note_added"),
    "100 peristiwa terbaru semuanya catatan (pembuatan kontak terpotong)",
  );
  const limited = (await (await getTimeline(PLAIN, "?limit=5")).json()) as TimelineJson;
  assert.equal(limited.events.length, 5, "parameter limit dihormati");
  assert.equal(limited.truncated, true);
  console.log("[6] pemotongan linimasa OK");
}

console.log("verify-contact-timeline: SEMUA LULUS");
