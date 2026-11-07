/**
 * Verifikasi Fase 1A untuk @sahabat-kreator/db.
 *
 * Jalur: PGlite (@electric-sql/pglite) — Postgres asli (WASM) yang berjalan
 * lokal di VM ini karena Docker tidak tersedia. Yang dibuktikan:
 *  1. Semua file migrasi (termasuk migrasi RLS) teraplikasi bersih dari nol.
 *  2. Insert dasar 2 tenant + member + data sistem bekerja.
 *  3. Constraint unik webhook_inbox (provider + provider_event_id) menolak duplikat.
 *  4. Isolasi RLS SUNGGUHAN: sebagai role non-superuser `app_user` dengan
 *     konteks app.tenant_id = tenant A, query hanya melihat data tenant A,
 *     dan insert untuk tenant B ditolak policy (WITH CHECK).
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "migrations");

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAN_ID = "99999999-9999-4999-8999-999999999999";

// Ekstensi `vector` (pgvector) didaftarkan eksplisit: baseline 0000 menjalankan
// CREATE EXTENSION vector dan membuat kolom vector(1536) di kb_chunks.
// Di staging ekstensi yang sama tersedia dari image pgvector/pgvector:pg16.
// Ekstensi `btree_gist` (Fase 13G) didaftarkan juga: migrasi 0006
// menjalankan CREATE EXTENSION btree_gist untuk constraint eksklusi
// anti-double-booking pada tabel bookings.
const db = new PGlite({ extensions: { vector, btree_gist } });

// ---------- 1. Terapkan migrasi dari nol ----------
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
assert.ok(files.length >= 1, `diharapkan >=1 file migrasi, ditemukan ${files.length}`);

/**
 * Penjaga: `drizzle-kit migrate` TIDAK membaca direktori ini — ia membaca
 * `meta/_journal.json`. Berkas .sql yang tidak terdaftar di journal akan
 * dilewati tanpa suara saat deploy, sementara harness ini (yang memutar
 * semua .sql) tetap lulus. Itu pernah terjadi: 0001 (RLS), 0002 (role
 * aplikasi), dan 0003 (constraint booking) tidak pernah masuk journal,
 * sehingga database produksi berjalan TANPA isolasi tenant walau
 * `db verify` hijau. Perbandingan di bawah membuat kelas kesalahan itu
 * gagal keras di sini.
 */
const journalPath = path.join(migrationsDir, "meta", "_journal.json");
const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const journalTags = journal.entries
  .slice()
  .sort((a, b) => a.idx - b.idx)
  .map((e) => e.tag);
const fileTags = files.map((f) => f.replace(/\.sql$/, ""));
assert.deepEqual(
  journalTags,
  fileTags,
  "meta/_journal.json tidak selaras dengan berkas .sql — drizzle-kit migrate " +
    "hanya menjalankan yang tercatat di journal. Daftarkan migrasi yang hilang " +
    `(berkas: ${fileTags.join(", ")}; journal: ${journalTags.join(", ")}).`,
);

for (const file of files) {
  const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
  await db.exec(sqlText.replaceAll("--> statement-breakpoint", ""));
}
console.log(`[1] migrasi teraplikasi bersih: ${files.join(", ")}`);

const tablesRes = await db.query<{ count: string }>(
  `SELECT count(*)::text AS count FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
);
console.log(`    jumlah tabel public: ${tablesRes.rows[0].count}`);
// 11 tabel Fase 1A + 4 tabel Better Auth Fase 1B (auth_user/session/account/verification)
// + 6 tabel Fase 1D (channel_accounts, channel_identities, contacts, media,
// conversations, messages) + 2 tabel Fase 2A (automations, automation_runs)
// + 4 tabel Fase 3A (agents, kb_documents, kb_chunks, agent_suggestions)
// + 2 tabel Fase 4A (products, payment_links)
// + 2 tabel Fase 2C (automation_steps, sequence_enrollments)
// + 1 tabel Fase 6C (platform_settings)
// + 1 tabel Fase 6D (profile_photos)
// + 1 tabel Fase 7B.1 (integration_log)
// + 2 tabel Fase 7C (broadcasts, broadcast_recipients)
// + 3 tabel Fase 8A (flows, flow_runs, flow_run_steps)
// + 1 tabel Fase 9A (saved_replies)
// + 1 tabel Fase 9C (conversation_notes)
// + 1 tabel Fase 10A (whatsapp_templates)
// + 1 tabel Fase 10B (comments)
// + 1 tabel Fase 12C (kb_source_documents)
// + 2 tabel Fase 13B (growth_links, growth_link_events)
// + 2 tabel Fase 13C (segments, tenant_opt_in_settings)
// + 1 tabel Fase 13D (flow_experiment_assignments)
// + 4 tabel Fase 13F (carts, cart_items, orders, order_items)
// + 5 tabel Fase 13G (appointment_services, appointment_settings,
//   appointment_availability, bookings, google_calendar_connections)
// + 1 tabel Fase 14A (payment_provider_configs)
assert.equal(Number(tablesRes.rows[0].count), 59);

// ---------- 2. Seed 2 tenant ----------
await db.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ($1, 'pro', 'Pro', '{"contacts": 5000}')`,
  [PLAN_ID],
);
await db.query(
  `INSERT INTO users (id, email, name) VALUES ($1, 'a@example.com', 'User A'), ($2, 'b@example.com', 'User B')`,
  [USER_A, USER_B],
);
await db.query(
  `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Tenant A', 'tenant-a'), ($2, 'Tenant B', 'tenant-b')`,
  [TENANT_A, TENANT_B],
);
await db.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $3, 'owner'), ($2, $4, 'owner')`,
  [TENANT_A, TENANT_B, USER_A, USER_B],
);
await db.query(
  `INSERT INTO usage_ledger (tenant_id, type, qty) VALUES ($1, 'message', 10), ($2, 'message', 99)`,
  [TENANT_A, TENANT_B],
);
await db.query(
  `INSERT INTO audit_logs (tenant_id, actor_type, action) VALUES ($1, 'system', 'seed.a'), ($2, 'system', 'seed.b')`,
  [TENANT_A, TENANT_B],
);
await db.query(
  `INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1, 'message.received', '{}'), ($2, 'message.received', '{}')`,
  [TENANT_A, TENANT_B],
);
await db.query(
  `INSERT INTO contacts (tenant_id, name, phone) VALUES ($1, 'Kontak A', '+628110000001'), ($2, 'Kontak B', '+628110000002')`,
  [TENANT_A, TENANT_B],
);
console.log("[2] seed 2 tenant + member + usage + audit + outbox + contacts: OK");

// ---------- 3. Dedup webhook_inbox ----------
await db.query(
  `INSERT INTO webhook_inbox (tenant_id, provider, provider_event_id, payload)
   VALUES ($1, 'whatsapp', 'evt-1', '{}')`,
  [TENANT_A],
);
await assert.rejects(
  db.query(
    `INSERT INTO webhook_inbox (tenant_id, provider, provider_event_id, payload)
     VALUES ($1, 'whatsapp', 'evt-1', '{}')`,
    [TENANT_B],
  ),
  /duplicate key|unique/i,
);
console.log("[3] webhook_inbox: duplikat (provider, provider_event_id) ditolak: OK");

// ---------- 4. Isolasi RLS sebagai role non-superuser ----------
const policies = await db.query<{ count: string }>(
  `SELECT count(*)::text AS count FROM pg_policies WHERE schemaname = 'public'`,
);
// 14 policy Fase 1A–1F + automations & automation_runs (Fase 2A)
// + policy kedua `system_relay` pada outbox_events (Fase 2A)
// + agents, kb_documents, kb_chunks, agent_suggestions (Fase 3A)
// + products & payment_links tenant_isolation + lengan publik
// `public_code_lookup` pada payment_links (Fase 4A)
// + automation_steps & sequence_enrollments tenant_isolation (Fase 2C)
// + lengan publik `public_key_lookup` pada api_keys (Fase 5A)
// + lengan webhook `telegram_webhook_lookup` pada channel_accounts dan
//   4 policy `system_delivery_scan` (Fase 6A)
// + lengan lookup `provider_external_lookup` pada channel_accounts
//   (hotfix Telegram, migrasi 0020)
// + policy `platform_settings_admin` pada platform_settings dan
//   `platform_audit` pada audit_logs (Fase 6C, migrasi 0022)
// + lengan pindai `system_purge_scan` pada channel_accounts
//   (Fase 6I, migrasi 0023)
// + `tenant_isolation` pada profile_photos (Fase 6D, migrasi 0025)
// + 4 policy `meta_delivery_scan` (Fase 7A, migrasi 0026; migrasi 0027
//   membuatnya ulang termasuk provider whatsapp — jumlah tetap)
// + 4 policy integration_log (Fase 7B.1, migrasi 0028: tenant_isolation,
//   integration_log_ingest, platform_integration_log,
//   integration_log_prune)
// + tenant_isolation pada broadcasts & broadcast_recipients dan lengan
//   baca `system_broadcast_scan` pada broadcasts (Fase 7C, migrasi
//   0030) = 48.
// + tenant_isolation pada flows, flow_runs, flow_run_steps (Fase 8A,
//   migrasi 0031) = 51.
// + tenant_isolation pada saved_replies (Fase 9A, migrasi 0033) = 52.
// + tenant_isolation pada conversation_notes dan lengan baca
//   `invitation_token_lookup` pada invitations (Fase 9C, migrasi
//   0035) = 54.
// + tenant_isolation pada whatsapp_templates (Fase 10A, migrasi
//   0036) = 55.
// + tenant_isolation pada comments (Fase 10B, migrasi 0037) = 56.
// + tenant_isolation pada kb_source_documents (Fase 12C, migrasi
//   0039) = 57.
// + tenant_isolation pada growth_links & growth_link_events dan
//   lengan publik `growth_link_public_lookup` pada growth_links
//   (Fase 13B, migrasi 0002 lineage baseline) = 60.
// + tenant_isolation pada segments & tenant_opt_in_settings
//   (Fase 13C, migrasi 0003) = 62.
// + tenant_isolation pada flow_experiment_assignments
//   (Fase 13D, migrasi 0004) = 63.
// + tenant_isolation pada carts, cart_items, orders, order_items
//   (Fase 13F, migrasi 0005) = 67.
// + tenant_isolation pada appointment_services, appointment_settings,
//   appointment_availability, bookings, google_calendar_connections
//   (Fase 13G, migrasi 0006) = 72.
// + tenant_isolation pada payment_provider_configs
//   (Fase 14A, migrasi 0007) = 73.
//
// 2026-11-05: rantai migrasi dibangun ulang dari schema Drizzle setelah
// folder migrasi lama dihapus. Policy kini dihasilkan dari daftar tabel
// ber-`tenant_id` + lengan lintas-tenant yang benar-benar dipakai kode:
// 51 tenant_isolation + 25 lengan = 76. Angka ini bukan target desain,
// melainkan hasil; yang dijaga adalah setiap lengan tetap ada (diuji di
// bawah) dan tidak ada policy `USING (true)` yang membocorkan tenant.
//
// 2026-11-06: + lengan `whatsapp_waba_lookup` pada channel_accounts
// (migrasi 0004) untuk event webhook tingkat WABA yang tidak membawa
// phone_number_id = 77.
//
// 2026-11-07: + lengan `system_media_gc_scan` pada media (migrasi 0007)
// untuk pembersihan media lintas tenant = 78. SELECT saja — hak hapus
// lintas tenant sengaja TIDAK diberikan (diuji di [46]).
assert.equal(Number(policies.rows[0].count), 78);
console.log(`[4] policy RLS terpasang: ${policies.rows[0].count} (termasuk system_relay outbox)`);

await db.exec(`
  CREATE ROLE app_user NOLOGIN;
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    tenants, users, plans, tenant_members, invitations, api_keys,
    subscriptions, webhook_inbox, outbox_events, audit_logs, usage_ledger,
    auth_user, auth_session, auth_account, auth_verification,
    channel_accounts, channel_identities, contacts, media, conversations, messages,
    automations, automation_runs,
    agents, kb_documents, kb_chunks, agent_suggestions,
    products, payment_links,
    automation_steps, sequence_enrollments,
    platform_settings, profile_photos, integration_log,
    broadcasts, broadcast_recipients,
    flows, flow_runs, flow_run_steps,
    saved_replies,
    conversation_notes,
    whatsapp_templates,
    comments,
    kb_source_documents,
    growth_links, growth_link_events,
    segments, tenant_opt_in_settings,
    flow_experiment_assignments,
    carts, cart_items, orders, order_items,
    appointment_services, appointment_settings, appointment_availability,
    bookings, google_calendar_connections,
    payment_provider_configs
  TO app_user;
`);

interface Seen {
  members: string[];
  usageTenants: string[];
  auditTenants: string[];
  contactTenants: string[];
  contactCrossInsertBlocked: boolean;
  crossInsertBlocked: boolean;
}

const seen = await db.transaction(async (tx): Promise<Seen> => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);

  const members = await tx.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant_members`,
  );
  const usage = await tx.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM usage_ledger`,
  );
  const audit = await tx.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM audit_logs`,
  );
  const contactRows = await tx.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM contacts`,
  );

  let contactCrossInsertBlocked = false;
  await tx.query(`SAVEPOINT sp0`);
  try {
    await tx.query(
      `INSERT INTO contacts (tenant_id, name) VALUES ($1, 'Kontak Lintas')`,
      [TENANT_B],
    );
  } catch (err) {
    contactCrossInsertBlocked = /row-level security/i.test(String(err));
    await tx.query(`ROLLBACK TO SAVEPOINT sp0`);
  }

  let crossInsertBlocked = false;
  // savepoint agar kegagalan insert tidak membatalkan seluruh transaksi uji
  await tx.query(`SAVEPOINT sp1`);
  try {
    await tx.query(
      `INSERT INTO usage_ledger (tenant_id, type, qty) VALUES ($1, 'message', 1)`,
      [TENANT_B],
    );
  } catch (err) {
    crossInsertBlocked = /row-level security/i.test(String(err));
    await tx.query(`ROLLBACK TO SAVEPOINT sp1`);
  }

  return {
    members: members.rows.map((r) => r.tenant_id),
    usageTenants: usage.rows.map((r) => r.tenant_id),
    auditTenants: audit.rows.map((r) => r.tenant_id),
    contactTenants: contactRows.rows.map((r) => r.tenant_id),
    contactCrossInsertBlocked,
    crossInsertBlocked,
  };
});

assert.deepEqual(seen.members, [TENANT_A]);
assert.deepEqual(seen.usageTenants, [TENANT_A]);
assert.deepEqual(seen.auditTenants, [TENANT_A]);
assert.deepEqual(seen.contactTenants, [TENANT_A]);
assert.equal(seen.contactCrossInsertBlocked, true);
assert.equal(seen.crossInsertBlocked, true);
console.log(
  "[5] RLS: konteks tenant A hanya melihat data A (members/usage/audit/contacts), insert lintas tenant ditolak: OK",
);

// ---------- 5. Lengan app.user_id pada policy tenant_members (Fase 1B) ----------
// Konteks daftar-keanggotaan: tanpa app.tenant_id, hanya app.user_id.
// User A harus melihat HANYA baris keanggotaannya sendiri (tenant A),
// dan tetap tidak bisa menulis member lintas konteks (WITH CHECK tenant-only).
const selfSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.user_id', $1, true)`, [USER_A]);
  const members = await tx.query<{ tenant_id: string; user_id: string }>(
    `SELECT tenant_id, user_id FROM tenant_members`,
  );
  let crossInsertBlocked = false;
  await tx.query(`SAVEPOINT sp2`);
  try {
    await tx.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [TENANT_B, USER_B],
    );
  } catch (err) {
    crossInsertBlocked = /row-level security/i.test(String(err));
    await tx.query(`ROLLBACK TO SAVEPOINT sp2`);
  }
  return { members: members.rows, crossInsertBlocked };
});
assert.deepEqual(
  selfSeen.members.map((r) => `${r.tenant_id}:${r.user_id}`),
  [`${TENANT_A}:${USER_A}`],
);
assert.equal(selfSeen.crossInsertBlocked, true);
console.log(
  "[6] RLS app.user_id: user hanya melihat keanggotaannya sendiri, insert via konteks user ditolak: OK",
);

// ---------- 6. Lengan system_relay pada outbox_events (Fase 2A) ----------
// Worker relay berjalan TANPA konteks tenant, tetapi dengan setting
// app.system_relay='outbox' ia harus melihat event SEMUA tenant; tanpa
// setting itu (dan tanpa app.tenant_id) ia tidak boleh melihat apa pun.
const relaySeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const withoutSetting = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox_events`,
  );
  await tx.query(`SELECT set_config('app.system_relay', 'outbox', true)`);
  const withSetting = await tx.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM outbox_events ORDER BY tenant_id`,
  );
  return { without: withoutSetting.rows[0].n, tenants: withSetting.rows.map((r) => r.tenant_id) };
});
assert.equal(relaySeen.without, "0");
assert.deepEqual(relaySeen.tenants, [TENANT_A, TENANT_B]);
console.log(
  "[7] RLS system_relay: tanpa setting outbox tak terlihat; dengan app.system_relay='outbox' event semua tenant terbaca: OK",
);

// ---------- 7. Fase 3A: RLS agents/KB + retrieval full-text ----------
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const KB_DOC_A = "44444444-4444-4444-8444-444444444444";
await db.query(
  `INSERT INTO agents (id, tenant_id, name, system_prompt, mode, is_active)
   VALUES ($1, $2, 'Agent A', 'Kamu CS Kelas Rekaman Kilat.', 'auto', true)`,
  [AGENT_A, TENANT_A],
);
await db.query(
  `INSERT INTO agents (tenant_id, name, mode, is_active) VALUES ($1, 'Agent B', 'suggest', true)`,
  [TENANT_B],
);
await db.query(
  `INSERT INTO kb_documents (id, tenant_id, title, content)
   VALUES ($1, $2, 'Harga', 'Harga kelas Rekaman Kilat adalah Rp349 ribu dan garansi 7 hari.')`,
  [KB_DOC_A, TENANT_A],
);
await db.query(
  `INSERT INTO kb_chunks (tenant_id, document_id, chunk_index, content)
   VALUES ($1, $2, 0, 'Harga kelas Rekaman Kilat adalah Rp349 ribu dan garansi 7 hari.')`,
  [TENANT_A, KB_DOC_A],
);
// search_vector harus ter-generate dan memuat leksem '349' & 'harga'.
const sv = await db.query<{ ok: boolean }>(
  `SELECT (search_vector @@ to_tsquery('simple', 'harga | 349')) AS ok FROM kb_chunks`,
);
assert.equal(sv.rows[0].ok, true);

const kbSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
  const agentsA = await tx.query<{ name: string }>(`SELECT name FROM agents`);
  const chunksA = await tx.query<{ content: string }>(
    `SELECT content FROM kb_chunks
     WHERE search_vector @@ to_tsquery('simple', 'berapa | harga | kelas | rekaman | kilat')
     ORDER BY ts_rank(search_vector, to_tsquery('simple', 'berapa | harga | kelas | rekaman | kilat')) DESC
     LIMIT 5`,
  );
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
  const agentsB = await tx.query<{ name: string }>(`SELECT name FROM agents`);
  const chunksB = await tx.query<{ content: string }>(`SELECT content FROM kb_chunks`);
  return { agentsA, chunksA, agentsB, chunksB };
});
assert.deepEqual(kbSeen.agentsA.rows.map((r) => r.name), ["Agent A"]);
assert.equal(kbSeen.chunksA.rows.length, 1);
assert.ok(kbSeen.chunksA.rows[0].content.includes("349"));
assert.deepEqual(kbSeen.agentsB.rows.map((r) => r.name), ["Agent B"]);
assert.equal(kbSeen.chunksB.rows.length, 0);
console.log(
  "[8] Fase 3A: RLS agents/KB per tenant + search_vector ter-generate + retrieval FTS (OR + ts_rank) menemukan chunk yang benar: OK",
);

// ---------- 8. Fase 4A: RLS products/payment_links + lengan publik code ----------
// Produk + tautan bayar tenant A; tenant B punya produk sendiri. Uji:
// konteks tenant hanya melihat miliknya; TANPA konteks tenant tetapi dengan
// app.payment_code, hanya baris tautan berkode itu yang terlihat (dan tabel
// products TETAP tertutup — lengan publik hanya di payment_links); tanpa
// setting apa pun, payment_links tak terlihat sama sekali.
const PRODUCT_A = "55555555-5555-4555-8555-555555555555";
const LINK_CODE_A = "pay_uji4aKodeA001";
await db.query(
  `INSERT INTO products (id, tenant_id, name, price_idr) VALUES ($1, $2, 'Kelas Rekaman Kilat', 349000)`,
  [PRODUCT_A, TENANT_A],
);
await db.query(
  `INSERT INTO products (tenant_id, name, price_idr) VALUES ($1, 'Produk B', 1000)`,
  [TENANT_B],
);
await db.query(
  `INSERT INTO payment_links (tenant_id, product_id, code, amount_idr, expires_at)
   VALUES ($1, $2, $3, 349000, now() + interval '7 days')`,
  [TENANT_A, PRODUCT_A, LINK_CODE_A],
);
// Check constraint: harga negatif wajib ditolak DB.
await assert.rejects(
  db.query(
    `INSERT INTO products (tenant_id, name, price_idr) VALUES ($1, 'Negatif', -5)`,
    [TENANT_A],
  ),
  /check|products_price_idr_nonnegative/i,
);
const paySeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  // Tanpa konteks apa pun: kosong.
  const noCtxLinks = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment_links`,
  );
  const noCtxProducts = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM products`,
  );
  // Konteks publik: hanya tautan berkode itu; products tetap tertutup.
  await tx.query(`SELECT set_config('app.payment_code', $1, true)`, [LINK_CODE_A]);
  const pubLinks = await tx.query<{ code: string; tenant_id: string }>(
    `SELECT code, tenant_id FROM payment_links`,
  );
  const pubProducts = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM products`,
  );
  // Konteks tenant B: produk B saja, tautan kosong.
  await tx.query(`SELECT set_config('app.payment_code', '', true)`);
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
  const productsB = await tx.query<{ name: string }>(`SELECT name FROM products`);
  const linksB = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment_links`,
  );
  return { noCtxLinks, noCtxProducts, pubLinks, pubProducts, productsB, linksB };
});
assert.equal(paySeen.noCtxLinks.rows[0].n, "0");
assert.equal(paySeen.noCtxProducts.rows[0].n, "0");
assert.deepEqual(
  paySeen.pubLinks.rows.map((r) => `${r.code}:${r.tenant_id}`),
  [`${LINK_CODE_A}:${TENANT_A}`],
);
assert.equal(paySeen.pubProducts.rows[0].n, "0");
assert.deepEqual(paySeen.productsB.rows.map((r) => r.name), ["Produk B"]);
assert.equal(paySeen.linksB.rows[0].n, "0");
console.log(
  "[9] Fase 4A: RLS products/payment_links per tenant + lengan publik app.payment_code hanya membuka baris berkode itu (products tetap tertutup) + check harga >= 0: OK",
);

// ---------- 9. Fase 2C: sequence — kind, steps, enrollment aktif unik, RLS ----------
// Automation sequence tenant A dengan 2 langkah; enrollment aktif untuk
// kontak tenant A. Uji: kind default automation lama = 'keyword'; index unik
// parsial menolak enrollment aktif kedua untuk (automation, kontak) yang
// sama tetapi MEMBOLEHKAN setelah yang pertama tidak aktif; check delay >= 0;
// konteks tenant B tidak melihat steps/enrollments tenant A.
const SEQ_AUTO_A = "66666666-6666-4666-8666-666666666666";
const CONV_A = "77777777-7777-4777-8777-777777777777";
const contactA = await db.query<{ id: string }>(
  `SELECT id FROM contacts WHERE tenant_id = $1 LIMIT 1`,
  [TENANT_A],
);
const CONTACT_A = contactA.rows[0].id;
await db.query(
  `INSERT INTO automations (tenant_id, name) VALUES ($1, 'Keyword Lama')`,
  [TENANT_A],
);
await db.query(
  `INSERT INTO automations (id, tenant_id, name, kind) VALUES ($1, $2, 'Sequence Uji', 'sequence')`,
  [SEQ_AUTO_A, TENANT_A],
);
await db.query(
  `INSERT INTO automation_steps (tenant_id, automation_id, position, delay_minutes, text)
   VALUES ($1, $2, 1, 0, 'Langkah satu'), ($1, $2, 2, 60, 'Langkah dua')`,
  [TENANT_A, SEQ_AUTO_A],
);
await assert.rejects(
  db.query(
    `INSERT INTO automation_steps (tenant_id, automation_id, position, delay_minutes, text)
     VALUES ($1, $2, 3, -1, 'Negatif')`,
    [TENANT_A, SEQ_AUTO_A],
  ),
  /check|delay_minutes_nonnegative/i,
);
await db.query(
  `INSERT INTO channel_accounts (tenant_id, provider, external_id, display_name)
   VALUES ($1, 'webchat', 'wc_verify2c', 'Webchat Uji')`,
  [TENANT_A],
);
const chanA = await db.query<{ id: string }>(
  `SELECT id FROM channel_accounts WHERE tenant_id = $1 LIMIT 1`,
  [TENANT_A],
);
await db.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider)
   VALUES ($1, $2, $3, $4, 'webchat')`,
  [CONV_A, TENANT_A, chanA.rows[0].id, CONTACT_A],
);
await db.query(
  `INSERT INTO sequence_enrollments (tenant_id, automation_id, contact_id, conversation_id)
   VALUES ($1, $2, $3, $4)`,
  [TENANT_A, SEQ_AUTO_A, CONTACT_A, CONV_A],
);
await assert.rejects(
  db.query(
    `INSERT INTO sequence_enrollments (tenant_id, automation_id, contact_id, conversation_id)
     VALUES ($1, $2, $3, $4)`,
    [TENANT_A, SEQ_AUTO_A, CONTACT_A, CONV_A],
  ),
  /duplicate key|sequence_enrollments_active_unique/i,
);
// Setelah enrollment pertama dibatalkan, enrollment aktif baru diperbolehkan.
await db.query(
  `UPDATE sequence_enrollments SET status = 'cancelled' WHERE automation_id = $1`,
  [SEQ_AUTO_A],
);
await db.query(
  `INSERT INTO sequence_enrollments (tenant_id, automation_id, contact_id, conversation_id)
   VALUES ($1, $2, $3, $4)`,
  [TENANT_A, SEQ_AUTO_A, CONTACT_A, CONV_A],
);
const kindDefault = await db.query<{ kind: string }>(
  `SELECT kind FROM automations WHERE name = 'Keyword Lama'`,
);
assert.equal(kindDefault.rows[0].kind, "keyword");
const seqSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
  const steps = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM automation_steps`,
  );
  const enrollments = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sequence_enrollments`,
  );
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
  const stepsA = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM automation_steps`,
  );
  const enrollmentsA = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sequence_enrollments`,
  );
  return { steps, enrollments, stepsA, enrollmentsA };
});
assert.equal(seqSeen.steps.rows[0].n, "0");
assert.equal(seqSeen.enrollments.rows[0].n, "0");
assert.equal(seqSeen.stepsA.rows[0].n, "2");
assert.equal(seqSeen.enrollmentsA.rows[0].n, "2");
console.log(
  "[10] Fase 2C: kind default 'keyword' + steps (check delay >= 0) + index unik enrollment aktif per (automation, kontak) + RLS steps/enrollments per tenant: OK",
);

// ---------- 10. Fase 5A: lengan publik api_keys (lookup by hash) ----------
// API key tenant A & B (hash uji tetap). Uji sebagai app_user: tanpa konteks
// apa pun api_keys tak terlihat; dengan app.api_key_hash = hash A, HANYA
// baris A yang terlihat; konteks tenant B tetap hanya melihat kunci B
// (lengan hash tidak membocorkan lintas tenant); nilai enum audit baru
// 'api_key' (migrasi 0015) bisa dipakai pada transaksi berikutnya.
const KEY_HASH_A = "hash-uji-5a-tenant-a";
const KEY_HASH_B = "hash-uji-5a-tenant-b";
await db.query(
  `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes)
   VALUES ($1, 'Kunci A', $3, 'sk_live_aaa1', '{contacts:read}'),
          ($2, 'Kunci B', $4, 'sk_live_bbb2', '{contacts:read}')`,
  [TENANT_A, TENANT_B, KEY_HASH_A, KEY_HASH_B],
);
const keySeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const noCtx = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM api_keys`,
  );
  await tx.query(`SELECT set_config('app.api_key_hash', $1, true)`, [KEY_HASH_A]);
  const byHash = await tx.query<{ tenant_id: string; key_hash: string }>(
    `SELECT tenant_id, key_hash FROM api_keys`,
  );
  // Konteks tenant B + setting hash A yang masih terpasang: policy OR —
  // baris A terlihat KARENA hash-nya disajikan (itu memang buktinya), tetapi
  // baris B juga hanya terlihat lewat konteks tenantnya; uji kuncinya:
  // dengan hash tenant B yang SALAH (tidak dikenal), tidak ada baris ekstra.
  await tx.query(`SELECT set_config('app.api_key_hash', 'hash-tidak-dikenal', true)`);
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
  const tenantB = await tx.query<{ key_hash: string }>(
    `SELECT key_hash FROM api_keys`,
  );
  // Enum audit 'api_key' harus bisa dipakai sekarang (transaksi terpisah
  // dari migrasi yang menambahkannya).
  await tx.query(
    `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action)
     VALUES ($1, 'api_key', 'key-uji', 'message.queued')`,
    [TENANT_B],
  );
  return { noCtx, byHash, tenantB };
});
assert.equal(keySeen.noCtx.rows[0].n, "0");
assert.deepEqual(
  keySeen.byHash.rows.map((r) => `${r.key_hash}:${r.tenant_id}`),
  [`${KEY_HASH_A}:${TENANT_A}`],
);
assert.deepEqual(keySeen.tenantB.rows.map((r) => r.key_hash), [KEY_HASH_B]);
console.log(
  "[11] Fase 5A: lengan publik app.api_key_hash hanya membuka baris ber-hash yang disajikan; tanpa konteks api_keys tertutup; konteks tenant tetap terisolasi; enum audit 'api_key' terpakai: OK",
);

// ---------- 12. Fase 6A: lengan Telegram (webhook lookup + pindai pengiriman) ----------
// Akun telegram tenant A & B + percakapan telegram A dengan pesan outbound
// `queued`, plus identitas chat-nya. Uji sebagai app_user:
//  - tanpa konteks: channel_accounts tertutup;
//  - app.telegram_channel_account_id = id A → HANYA baris A yang terbuka;
//  - kolom bot_username (migrasi 0017) terbaca;
//  - app.system_delivery='telegram' → poller melihat akun/percakapan/
//    identitas telegram lintas tenant, dan JOIN antrean hanya menghasilkan
//    pesan queued milik percakapan telegram (bukan webchat).
const TG_ACC_A = "88888888-8888-4888-8888-888888888888";
const TG_ACC_B = "99999999-9999-4999-8999-999999999999";
const TG_CONV_A = "12121212-1212-4212-8212-121212121212";
await db.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, webhook_secret, bot_username)
   VALUES ($1, $2, 'telegram', '555001', 'Bot Uji A', 'connected', 'hash-uji-a', 'bot_uji_a'),
          ($3, $4, 'telegram', '555002', 'Bot Uji B', 'connected', 'hash-uji-b', 'bot_uji_b')`,
  [TG_ACC_A, TENANT_A, TG_ACC_B, TENANT_B],
);
await db.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider)
   VALUES ($1, $2, $3, $4, 'telegram')`,
  [TG_CONV_A, TENANT_A, TG_ACC_A, CONTACT_A],
);
await db.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id)
   VALUES ($1, $2, $3, 'telegram', '424242')`,
  [TENANT_A, CONTACT_A, TG_ACC_A],
);
await db.query(
  `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, type, content_text, status)
   VALUES ($1, $2, 'outbound', 'user', 'text', 'Balasan telegram uji', 'queued'),
          ($1, $3, 'outbound', 'user', 'text', 'Balasan webchat uji', 'queued')`,
  [TENANT_A, TG_CONV_A, CONV_A],
);
const tgSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const noCtx = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM channel_accounts`,
  );
  await tx.query(`SELECT set_config('app.telegram_channel_account_id', $1, true)`, [TG_ACC_A]);
  const byId = await tx.query<{ id: string; bot_username: string }>(
    `SELECT id, bot_username FROM channel_accounts`,
  );
  await tx.query(`SELECT set_config('app.telegram_channel_account_id', '', true)`);
  await tx.query(`SELECT set_config('app.system_delivery', 'telegram', true)`);
  const scanAccounts = await tx.query<{ id: string }>(
    `SELECT id FROM channel_accounts ORDER BY id`,
  );
  const scanConvs = await tx.query<{ id: string; provider: string }>(
    `SELECT id, provider FROM conversations`,
  );
  const scanQueue = await tx.query<{ content_text: string; chat_id: string }>(
    `SELECT m.content_text, ci.external_user_id AS chat_id
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN channel_identities ci
         ON ci.channel_account_id = cv.channel_account_id
        AND ci.contact_id = cv.contact_id
      WHERE m.direction = 'outbound' AND m.status = 'queued'`,
  );
  return { noCtx, byId, scanAccounts, scanConvs, scanQueue };
});
assert.equal(tgSeen.noCtx.rows[0].n, "0");
assert.deepEqual(
  tgSeen.byId.rows.map((r) => `${r.id}:${r.bot_username}`),
  [`${TG_ACC_A}:bot_uji_a`],
);
assert.deepEqual(
  tgSeen.scanAccounts.rows.map((r) => r.id),
  [TG_ACC_A, TG_ACC_B],
);
assert.deepEqual(
  tgSeen.scanConvs.rows.map((r) => `${r.id}:${r.provider}`),
  [`${TG_CONV_A}:telegram`],
);
assert.deepEqual(
  tgSeen.scanQueue.rows.map((r) => `${r.content_text}:${r.chat_id}`),
  ["Balasan telegram uji:424242"],
);
console.log(
  "[12] Fase 6A: lengan app.telegram_channel_account_id hanya membuka baris akun itu; bot_username terbaca; pindai app.system_delivery='telegram' hanya menghasilkan antrean percakapan telegram lintas tenant: OK",
);

// ---------- 13. Fase 6A.1: grup Telegram (provider_chat_id + sender_name) ----------
// Kolom baru migrasi 0019 harus ada; percakapan grup tenant A
// (provider_chat_id negatif + title) dengan pesan outbound `queued` harus
// teresolusi alamat balasannya ke ID GRUP lewat query poller
// (coalesce provider_chat_id → external_user_id identitas), sementara
// percakapan privat lama (provider_chat_id NULL) jatuh kembali ke id
// kontak. Pesan masuk grup membawa sender_name; pesan privat NULL.
const TG_GROUP_CONV = "34343434-3434-4434-8434-343434343434";
await db.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title)
   VALUES ($1, $2, $3, $4, 'telegram', '-1001234567890', 'Grup Uji 6A.1')`,
  [TG_GROUP_CONV, TENANT_A, TG_ACC_A, CONTACT_A],
);
await db.query(
  `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, sender_name, type, content_text, status)
   VALUES ($1, $2, 'inbound', 'contact', 'Anggota Satu', 'text', 'Halo dari grup', 'received'),
          ($1, $2, 'outbound', 'user', NULL, 'text', 'Balasan ke grup', 'queued'),
          ($1, $3, 'inbound', 'contact', NULL, 'text', 'Halo privat', 'received')`,
  [TENANT_A, TG_GROUP_CONV, TG_CONV_A],
);
const colCheck = await db.query<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name IN ('conversations', 'messages')
      AND column_name IN ('provider_chat_id', 'title', 'sender_name')
    ORDER BY column_name`,
);
assert.deepEqual(
  colCheck.rows.map((r) => r.column_name),
  ["provider_chat_id", "sender_name", "title"],
);
const groupSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.system_delivery', 'telegram', true)`);
  // Cerminan query core `listQueuedTelegramDeliveries` (Fase 6A.1):
  // alamat = coalesce(provider_chat_id percakapan, identitas kontak).
  return tx.query<{ content_text: string; chat_id: string }>(
    `SELECT m.content_text,
            coalesce(cv.provider_chat_id, ci.external_user_id) AS chat_id
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN channel_accounts ca ON ca.id = cv.channel_account_id
       JOIN channel_identities ci
         ON ci.channel_account_id = cv.channel_account_id
        AND ci.contact_id = cv.contact_id
      WHERE m.direction = 'outbound' AND m.status = 'queued'
      ORDER BY m.content_text`,
  );
});
assert.deepEqual(
  groupSeen.rows.map((r) => `${r.content_text}:${r.chat_id}`),
  ["Balasan ke grup:-1001234567890", "Balasan telegram uji:424242"],
);
const senderNames = await db.query<{ sender_name: string | null }>(
  `SELECT sender_name FROM messages WHERE conversation_id = $1 AND direction = 'inbound'`,
  [TG_GROUP_CONV],
);
assert.deepEqual(senderNames.rows.map((r) => r.sender_name), ["Anggota Satu"]);
console.log(
  "[13] Fase 6A.1: kolom provider_chat_id/title/sender_name ada; alamat balasan grup teresolusi ke id grup negatif lewat coalesce & privat lama jatuh ke identitas kontak; sender_name tersimpan per pesan grup: OK",
);

// ---------- 14. Hotfix Telegram: satu bot = satu koneksi ----------
// Migrasi 0020: (a) index unik parsial (provider, external_id) WHERE
// status <> 'disconnected' menolak baris AKTIF kedua untuk pasangan yang
// sama — lintas tenant maupun 'error' — tetapi membolehkan baris
// 'disconnected' kembar; (b) lengan RLS provider_external_lookup hanya
// membuka baris yang (provider, external_id)-nya persis pasangan yang
// di-set transaksi (fondasi lookup connect lintas tenant).
const TG_ACC_B_DUPE = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
await assert.rejects(
  db.query(
    `INSERT INTO channel_accounts (tenant_id, provider, external_id, status)
     VALUES ($1, 'telegram', '555001', 'connected')`,
    [TENANT_B],
  ),
  /channel_accounts_provider_external_active_unique/,
);
await assert.rejects(
  db.query(
    `INSERT INTO channel_accounts (tenant_id, provider, external_id, status)
     VALUES ($1, 'telegram', '555001', 'error')`,
    [TENANT_B],
  ),
  /channel_accounts_provider_external_active_unique/,
);
await db.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
   VALUES ($1, $2, 'telegram', '555001', 'disconnected')`,
  [TG_ACC_B_DUPE, TENANT_B],
);
const guardSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const noCtx = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM channel_accounts`,
  );
  await tx.query(`SELECT set_config('app.channel_provider', 'telegram', true)`);
  await tx.query(`SELECT set_config('app.channel_external_id', '555001', true)`);
  const pair = await tx.query<{ id: string; status: string }>(
    `SELECT id, status FROM channel_accounts ORDER BY status`,
  );
  await tx.query(`SELECT set_config('app.channel_external_id', 'tidak-ada', true)`);
  const none = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM channel_accounts`,
  );
  return { noCtx, pair, none };
});
assert.equal(guardSeen.noCtx.rows[0].n, "0");
assert.deepEqual(
  guardSeen.pair.rows.map((r) => `${r.id}:${r.status}`),
  [`${TG_ACC_A}:connected`, `${TG_ACC_B_DUPE}:disconnected`],
);
assert.equal(guardSeen.none.rows[0].n, "0");
console.log(
  "[14] Hotfix Telegram: index unik parsial menolak bot aktif ganda lintas tenant (connected & error), membolehkan baris disconnected; lengan provider_external_lookup hanya membuka pasangan persis: OK",
);

// ---------- 15. Fase 6A.2: percakapan channel (kolom kind) ----------
// Migrasi 0021: (a) kolom `kind` ada, default 'private' (baris TG_CONV_A
// dari seksi [12] yang di-insert tanpa kind membuktikannya); (b) CHECK
// menolak nilai di luar private/group/channel; (c) pernyataan backfill
// migrasi (title terisi → 'group') diterapkan pada baris bergaya
// pra-0021 — percakapan grup seksi [13] di-insert dengan title + kind
// default, persis bentuk data warisan — dan mengubahnya menjadi 'group'
// sementara baris tanpa title tetap 'private'; (d) percakapan channel
// dengan kontak jangkar = channel itu sendiri (identitas
// external_user_id = id channel) menresolusi alamat posting dashboard
// lewat query poller ke ID CHANNEL.
const kindCol = await db.query<{ data_type: string; column_default: string }>(
  `SELECT data_type, column_default FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'kind'`,
);
assert.equal(kindCol.rows.length, 1);
const defaultKind = await db.query<{ kind: string }>(
  `SELECT kind FROM conversations WHERE id = $1`,
  [TG_CONV_A],
);
assert.equal(defaultKind.rows[0].kind, "private");
await assert.rejects(
  db.query(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, kind)
     VALUES ($1, $2, $3, 'telegram', 'bogus')`,
    [TENANT_A, TG_ACC_A, CONTACT_A],
  ),
  /conversations_kind_valid/,
);
// Simulasi backfill migrasi 0021 atas data warisan bergaya pra-0021.
await db.query(`UPDATE conversations SET kind = 'group' WHERE title IS NOT NULL`);
const backfilled = await db.query<{ id: string; kind: string }>(
  `SELECT id, kind FROM conversations WHERE id IN ($1, $2) ORDER BY id`,
  [TG_GROUP_CONV, TG_CONV_A],
);
assert.deepEqual(
  backfilled.rows.map((r) => `${r.id}:${r.kind}`),
  [`${TG_CONV_A}:private`, `${TG_GROUP_CONV}:group`],
);
const CHAN_CONTACT_A = "45454545-4545-4454-8454-454545454545";
const CHAN_CONV_A = "46464646-4646-4464-8464-464646464646";
await db.query(
  `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Kanal Uji 6A.2')`,
  [CHAN_CONTACT_A, TENANT_A],
);
await db.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id)
   VALUES ($1, $2, $3, 'telegram', '-100555000111')`,
  [TENANT_A, CHAN_CONTACT_A, TG_ACC_A],
);
await db.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind)
   VALUES ($1, $2, $3, $4, 'telegram', '-100555000111', 'Kanal Uji 6A.2', 'channel')`,
  [CHAN_CONV_A, TENANT_A, TG_ACC_A, CHAN_CONTACT_A],
);
await db.query(
  `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, sender_name, type, content_text, provider_message_id, status)
   VALUES ($1, $2, 'inbound', 'contact', 'Kanal Uji 6A.2', 'text', 'Postingan admin lain', 'telegram:555001:501', 'received'),
          ($1, $2, 'outbound', 'user', NULL, 'text', 'Postingan dari dashboard', NULL, 'queued')`,
  [TENANT_A, CHAN_CONV_A],
);
const chanSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.system_delivery', 'telegram', true)`);
  return tx.query<{ chat_id: string }>(
    `SELECT coalesce(cv.provider_chat_id, ci.external_user_id) AS chat_id
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN channel_accounts ca ON ca.id = cv.channel_account_id
       JOIN channel_identities ci
         ON ci.channel_account_id = cv.channel_account_id
        AND ci.contact_id = cv.contact_id
      WHERE m.conversation_id = $1
        AND m.direction = 'outbound' AND m.status = 'queued'`,
    [CHAN_CONV_A],
  );
});
assert.deepEqual(chanSeen.rows.map((r) => r.chat_id), ["-100555000111"]);
console.log(
  "[15] Fase 6A.2: kolom kind ada + default 'private' + CHECK menolak nilai liar; backfill title→'group' tepat; percakapan channel (jangkar = channel sendiri) teresolusi alamat postingnya ke id channel lewat query poller: OK",
);

// ---------- 16. Fase 6C: platform_settings RLS fail-closed + audit platform ----------
// Tabel platform_settings BUKAN tenant-scoped: tanpa flag transaksi
// `app.platform_settings='admin'`, role aplikasi tidak melihat satu baris
// pun dan tidak bisa menulis — walau barisnya ada (ditanam superuser).
// Dengan flag, akses penuh. Audit platform (tenant_id NULL) tunduk pada
// gerbang yang sama dan TIDAK pernah terlihat dari konteks tenant.
await db.query(
  `INSERT INTO platform_settings (key, value_encrypted, updated_by)
   VALUES ('openrouter_api_key', 'v1:seed.seed.seed', $1)`,
  [USER_A],
);
const psNoFlag = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const seenRows = await tx.query<{ key: string }>(
    `SELECT key FROM platform_settings`,
  );
  let insertBlocked = false;
  await tx.query(`SAVEPOINT sp_ps`);
  try {
    await tx.query(
      `INSERT INTO platform_settings (key, value_encrypted) VALUES ('r2_access_key_id', 'v1:x.y.z')`,
    );
  } catch (err) {
    insertBlocked = /row-level security/i.test(String(err));
  }
  await tx.query(`ROLLBACK TO SAVEPOINT sp_ps`);
  return { count: seenRows.rows.length, insertBlocked };
});
assert.equal(psNoFlag.count, 0);
assert.equal(psNoFlag.insertBlocked, true);
const psFlag = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.platform_settings', 'admin', true)`);
  const seenRows = await tx.query<{ key: string }>(
    `SELECT key FROM platform_settings`,
  );
  await tx.query(
    `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, meta)
     VALUES (NULL, 'user', $1, 'platform_settings.set', '{"key":"openrouter_api_key"}')`,
    [USER_A],
  );
  return seenRows.rows.map((r) => r.key);
});
assert.deepEqual(psFlag, ["openrouter_api_key"]);
const psTenantView = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
  return tx.query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE action LIKE 'platform_settings.%'`,
  );
});
assert.equal(psTenantView.rows.length, 0);
console.log(
  "[16] Fase 6C: platform_settings fail-closed tanpa flag (0 baris + insert ditolak), terbuka dengan flag app.platform_settings='admin'; audit platform tenant_id NULL tertulis ber-flag dan tak terlihat dari konteks tenant: OK",
);

// ---------- 17. Fase 6I: kolom trashed_at + lengan pindai purge ----------
// Worker purge memindai akun Sampah dari SEMUA tenant tanpa konteks
// tenant. Lengan `system_purge_scan` (migrasi 0023) menuntut flag
// app.system_relay='channel_purge' dan HANYA membuka baris trashed —
// baris aktif tidak pernah terlihat lewat lengan ini, dan tanpa flag
// role aplikasi tidak melihat apa pun di luar konteks tenantnya.
await db.query(
  `INSERT INTO channel_accounts (tenant_id, provider, external_id, status, trashed_at)
   VALUES ($1, 'webchat', 'wc_verify_trashed_a', 'disconnected', now() - interval '31 days'),
          ($1, 'webchat', 'wc_verify_active_a', 'connected', NULL),
          ($2, 'telegram', '777123', 'disconnected', now() - interval '40 days')`,
  [TENANT_A, TENANT_B],
);
const purgeNoFlag = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  return tx.query<{ external_id: string }>(
    `SELECT external_id FROM channel_accounts`,
  );
});
assert.equal(purgeNoFlag.rows.length, 0);
const purgeScan = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.system_relay', 'channel_purge', true)`);
  return tx.query<{ external_id: string }>(
    `SELECT external_id FROM channel_accounts ORDER BY external_id`,
  );
});
assert.deepEqual(
  purgeScan.rows.map((r) => r.external_id),
  ["777123", "wc_verify_trashed_a"],
);
const purgeTenantView = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
  return tx.query<{ external_id: string }>(
    `SELECT external_id FROM channel_accounts ORDER BY external_id`,
  );
});
const tenantAExternalIds = purgeTenantView.rows.map((r) => r.external_id);
assert.ok(tenantAExternalIds.includes("wc_verify_active_a"));
assert.ok(tenantAExternalIds.includes("wc_verify_trashed_a"));
assert.ok(!tenantAExternalIds.includes("777123"));
console.log(
  "[17] Fase 6I: channel_accounts.trashed_at ada; tanpa flag pindai purge buta (0 baris), dengan app.system_relay='channel_purge' hanya baris trashed lintas tenant yang terlihat; konteks tenant tetap melihat semua barisnya sendiri: OK",
);

// ---------- 18. Fase 6D: profile_photos — RLS tenant + bytea + unik per pemilik ----------
// Foto profil disimpan sebagai bytea di DB dan hanya boleh terlihat dari
// konteks tenant pemiliknya. Ditanam untuk tenant A & B (superuser), lalu
// dibaca sebagai app_user: konteks A hanya melihat baris A (byte kembali
// utuh), konteks B hanya baris B, insert lintas tenant ditolak WITH CHECK,
// dan index unik (tenant_id, owner_type, owner_id) menolak foto kedua
// untuk pemilik yang sama (jalur simpan harus upsert).
const PHOTO_OWNER_A = "66666666-6666-4666-8666-666666666666";
const PHOTO_OWNER_B = "77777777-7777-4777-8777-777777777777";
await db.query(
  `INSERT INTO profile_photos (tenant_id, owner_type, owner_id, content_type, data, etag)
   VALUES ($1, 'contact', $3, 'image/png', '\\x89504e47'::bytea, 'etag-a'),
          ($2, 'channel_account', $4, 'image/jpeg', '\\xffd8ffe0'::bytea, 'etag-b')`,
  [TENANT_A, TENANT_B, PHOTO_OWNER_A, PHOTO_OWNER_B],
);
const photoViewA = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
  const rows = await tx.query<{ owner_id: string; len: number }>(
    `SELECT owner_id, octet_length(data) AS len FROM profile_photos`,
  );
  let crossInsertBlocked = false;
  await tx.query(`SAVEPOINT sp_photo`);
  try {
    await tx.query(
      `INSERT INTO profile_photos (tenant_id, owner_type, owner_id, content_type, data, etag)
       VALUES ($1, 'contact', $2, 'image/png', '\\x00'::bytea, 'etag-x')`,
      [TENANT_B, PHOTO_OWNER_B],
    );
  } catch (err) {
    crossInsertBlocked = /row-level security/i.test(String(err));
  }
  await tx.query(`ROLLBACK TO SAVEPOINT sp_photo`);
  return { rows: rows.rows, crossInsertBlocked };
});
assert.equal(photoViewA.rows.length, 1);
assert.equal(photoViewA.rows[0].owner_id, PHOTO_OWNER_A);
assert.equal(photoViewA.rows[0].len, 4);
assert.equal(photoViewA.crossInsertBlocked, true);
let photoDupeBlocked = false;
try {
  await db.query(
    `INSERT INTO profile_photos (tenant_id, owner_type, owner_id, content_type, data, etag)
     VALUES ($1, 'contact', $2, 'image/png', '\\x01'::bytea, 'etag-dupe')`,
    [TENANT_A, PHOTO_OWNER_A],
  );
} catch (err) {
  photoDupeBlocked = /profile_photos_tenant_owner_unique/i.test(String(err));
}
assert.equal(photoDupeBlocked, true);
console.log(
  "[18] Fase 6D: profile_photos terisolasi per tenant (konteks A hanya baris A, bytea utuh 4 byte, insert lintas ditolak), unik satu foto per (tenant, jenis pemilik, pemilik): OK",
);

// ---------- 19. Fase 7A: Meta (Messenger + Instagram) ----------
// Migrasi 0026: (a) kolom public_handle ada di channel_accounts;
// (b) lengan `meta_delivery_scan` — tanpa flag app.system_delivery,
// role aplikasi tidak melihat baris Meta apa pun di luar konteks
// tenant; dengan 'meta' hanya baris messenger/instagram lintas tenant
// yang terbuka (akun telegram TIDAK ikut), dan query cerminan poller
// core hanya menghasilkan antrean Meta dengan alamat penerima yang
// teresolusi (coalesce provider_chat_id → identitas kontak).
const META_ACC_A = "12121212-1212-4121-8121-121212121212";
const META_ACC_B = "34343434-3434-4343-8434-343434343434";
const META_CONV_A = "56565656-5656-4565-8565-565656565656";
const META_CONV_B = "78787878-7878-4787-8787-787878787878";
const contactB = await db.query<{ id: string }>(
  `SELECT id FROM contacts WHERE tenant_id = $1 LIMIT 1`,
  [TENANT_B],
);
const CONTACT_B = contactB.rows[0].id;
await db.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, public_handle)
   VALUES ($1, $3, 'messenger', 'page_verify_a', 'Page Uji A', 'connected', 'pageujia'),
          ($2, $4, 'instagram', 'ig_verify_b', 'IG Uji B', 'connected', 'igujib'),
          ('90909090-9090-4909-8909-909090909090', $3, 'telegram', '777999', 'Bot Uji Meta', 'connected', 'bot_meta')`,
  [META_ACC_A, META_ACC_B, TENANT_A, TENANT_B],
);
await db.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id)
   VALUES ($1, $3, $5, $7, 'messenger', 'psid_verify_a'),
          ($2, $4, $6, $8, 'instagram', 'igsid_verify_b')`,
  [META_CONV_A, META_CONV_B, TENANT_A, TENANT_B, META_ACC_A, META_ACC_B, CONTACT_A, CONTACT_B],
);
await db.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id)
   VALUES ($1, $3, $5, 'messenger', 'psid_verify_a'),
          ($2, $4, $6, 'instagram', 'igsid_verify_b')`,
  [TENANT_A, TENANT_B, CONTACT_A, CONTACT_B, META_ACC_A, META_ACC_B],
);
await db.query(
  `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, type, content_text, status)
   VALUES ($1, $3, 'outbound', 'user', 'text', 'Balasan messenger uji', 'queued'),
          ($2, $4, 'outbound', 'user', 'text', 'Balasan instagram uji', 'queued')`,
  [TENANT_A, TENANT_B, META_CONV_A, META_CONV_B],
);
const metaCol = await db.query<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name = 'channel_accounts' AND column_name = 'public_handle'`,
);
assert.deepEqual(metaCol.rows.map((r) => r.column_name), ["public_handle"]);
const metaSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const noFlag = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM channel_accounts
      WHERE provider IN ('messenger', 'instagram')`,
  );
  await tx.query(`SELECT set_config('app.system_delivery', 'meta', true)`);
  const scanAccounts = await tx.query<{ id: string }>(
    `SELECT id FROM channel_accounts ORDER BY id`,
  );
  const scanConvs = await tx.query<{ id: string }>(
    `SELECT id FROM conversations ORDER BY id`,
  );
  const scanQueue = await tx.query<{ content_text: string; recipient: string }>(
    `SELECT m.content_text,
            coalesce(cv.provider_chat_id, ci.external_user_id) AS recipient
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN channel_accounts ca ON ca.id = cv.channel_account_id
       JOIN channel_identities ci
         ON ci.channel_account_id = cv.channel_account_id
        AND ci.contact_id = cv.contact_id
      WHERE m.direction = 'outbound' AND m.status = 'queued'
      ORDER BY m.content_text`,
  );
  await tx.query(`SELECT set_config('app.system_delivery', 'telegram', true)`);
  const telegramFlagMeta = await tx.query<{ id: string }>(
    `SELECT id FROM channel_accounts
      WHERE provider IN ('messenger', 'instagram')`,
  );
  return { noFlag, scanAccounts, scanConvs, scanQueue, telegramFlagMeta };
});
assert.equal(metaSeen.noFlag.rows[0].n, "0");
assert.deepEqual(
  metaSeen.scanAccounts.rows.map((r) => r.id),
  [META_ACC_A, META_ACC_B],
);
assert.deepEqual(
  metaSeen.scanConvs.rows.map((r) => r.id),
  [META_CONV_A, META_CONV_B],
);
assert.deepEqual(
  metaSeen.scanQueue.rows.map((r) => `${r.content_text}:${r.recipient}`),
  ["Balasan instagram uji:igsid_verify_b", "Balasan messenger uji:psid_verify_a"],
);
assert.equal(metaSeen.telegramFlagMeta.rows.length, 0);
console.log(
  "[19] Fase 7A: kolom public_handle ada; pindai app.system_delivery='meta' hanya membuka akun/percakapan messenger+instagram lintas tenant (telegram tertutup), antrean poller Meta teresolusi penerimanya; flag 'telegram' tidak membuka baris Meta: OK",
);

// ---------- 20. Fase 7B: WhatsApp menumpang rel Meta ----------
// (a) kolom `parent_external_id` (WABA ID) ada di channel_accounts;
// (b) lengan `meta_delivery_scan` sesudah migrasi 0027 ikut membuka
// akun/percakapan whatsapp di bawah flag 'meta' yang sama, dan antrean
// poller menyelesaikan pesan queued WhatsApp ke wa_id penerimanya;
// flag 'telegram' tetap tidak membuka baris WhatsApp.
const WA_ACC = "23232323-2323-4232-8232-232323232323";
const WA_CONV = "45454545-4545-4454-8454-454545454545";
const WA_WABA = "waba_verify_1";
const WA_PHONE_ID = "phone_verify_1";
await db.query(
  `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, parent_external_id, display_name, status, public_handle)
   VALUES ($1, $2, 'whatsapp', $3, $4, 'WA Uji', 'connected', '+62 812-3456-7890')`,
  [WA_ACC, TENANT_A, WA_PHONE_ID, WA_WABA],
);
await db.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id)
   VALUES ($1, $2, $3, $4, 'whatsapp', '6281234567890')`,
  [WA_CONV, TENANT_A, WA_ACC, CONTACT_A],
);
await db.query(
  `INSERT INTO channel_identities (tenant_id, contact_id, channel_account_id, provider, external_user_id)
   VALUES ($1, $2, $3, 'whatsapp', '6281234567890')`,
  [TENANT_A, CONTACT_A, WA_ACC],
);
await db.query(
  `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, type, content_text, status, provider_message_id)
   VALUES ($1, $2, 'outbound', 'user', 'text', 'Balasan whatsapp uji', 'sent', 'meta:phone_verify_1:wamid.verify.1')`,
  [TENANT_A, WA_CONV],
);
const waCol = await db.query<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name = 'channel_accounts' AND column_name = 'parent_external_id'`,
);
assert.deepEqual(waCol.rows.map((r) => r.column_name), ["parent_external_id"]);
const waParent = await db.query<{ parent_external_id: string }>(
  `SELECT parent_external_id FROM channel_accounts WHERE id = $1`,
  [WA_ACC],
);
assert.equal(waParent.rows[0].parent_external_id, WA_WABA);
const waSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const noFlag = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM channel_accounts WHERE provider = 'whatsapp'`,
  );
  await tx.query(`SELECT set_config('app.system_delivery', 'meta', true)`);
  const scanAccounts = await tx.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE provider = 'whatsapp' ORDER BY id`,
  );
  const scanQueue = await tx.query<{ content_text: string; recipient: string }>(
    `SELECT m.content_text,
            coalesce(cv.provider_chat_id, ci.external_user_id) AS recipient
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN channel_accounts ca ON ca.id = cv.channel_account_id
       JOIN channel_identities ci
         ON ci.channel_account_id = cv.channel_account_id
        AND ci.contact_id = cv.contact_id
      WHERE m.direction = 'outbound' AND m.status = 'queued'
        AND cv.provider = 'whatsapp'
      ORDER BY m.content_text`,
  );
  await tx.query(`SELECT set_config('app.system_delivery', 'telegram', true)`);
  const telegramFlagWa = await tx.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE provider = 'whatsapp'`,
  );
  return { noFlag, scanAccounts, scanQueue, telegramFlagWa };
});
assert.equal(waSeen.noFlag.rows[0].n, "0");
assert.deepEqual(waSeen.scanAccounts.rows.map((r) => r.id), [WA_ACC]);
assert.deepEqual(waSeen.scanQueue.rows, []);
assert.equal(waSeen.telegramFlagWa.rows.length, 0);
// Antrean queued WhatsApp: tambahkan satu pesan queued lalu pastikan
// query cerminan poller (flag 'meta') menyelesaikannya ke wa_id.
await db.query(
  `INSERT INTO messages (tenant_id, conversation_id, direction, sender_type, type, content_text, status)
   VALUES ($1, $2, 'outbound', 'user', 'text', 'Antre whatsapp uji', 'queued')`,
  [TENANT_A, WA_CONV],
);
const waQueue = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.system_delivery', 'meta', true)`);
  return tx.query<{ content_text: string; recipient: string }>(
    `SELECT m.content_text,
            coalesce(cv.provider_chat_id, ci.external_user_id) AS recipient
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN channel_accounts ca ON ca.id = cv.channel_account_id
       JOIN channel_identities ci
         ON ci.channel_account_id = cv.channel_account_id
        AND ci.contact_id = cv.contact_id
      WHERE m.direction = 'outbound' AND m.status = 'queued'
        AND cv.provider = 'whatsapp'`,
  );
});
assert.deepEqual(
  waQueue.rows.map((r) => `${r.content_text}:${r.recipient}`),
  ["Antre whatsapp uji:6281234567890"],
);
console.log(
  "[20] Fase 7B: kolom parent_external_id (WABA) ada & terisi; pindai app.system_delivery='meta' membuka akun whatsapp lintas tenant dan antrean queued WhatsApp teresolusi ke wa_id penerima; flag 'telegram' tidak membuka baris WhatsApp: OK",
);

// ---------- 21. Fase 7B.1: integration_log — RLS berlapis ----------
// Log integrasi ditulis dari konteks tanpa tenant (webhook/poller) dan
// dibaca dari konteks tenant + platform. Ditanam sebagai superuser:
// baris bertenant A & B, baris platform (tenant NULL) segar, dan satu
// baris platform kedaluwarsa (31 hari) untuk prune. Sebagai app_user:
// (a) tanpa konteks apa pun terlihat 0 baris;
// (b) insert TANPA flag ingest ditolak; dengan flag ingest diterima
//     (termasuk untuk tenant lain — penulis memang lintas tenant);
// (c) konteks tenant A hanya melihat baris A (bukan B, bukan platform);
// (d) flag platform admin hanya melihat baris tenant NULL;
// (e) DELETE di bawah flag prune hanya menghapus baris kedaluwarsa.
await db.query(
  `INSERT INTO integration_log (direction, provider, tenant_id, outcome, summary)
   VALUES ('in', 'telegram', $1, 'recorded', 'text message from Verify A'),
          ('in', 'telegram', $2, 'recorded', 'text message from Verify B'),
          ('in', 'meta', NULL, 'unresolved_account', 'unknown account'),
          ('in', 'meta', NULL, 'unresolved_account', 'old unresolved')`,
  [TENANT_A, TENANT_B],
);
await db.query(
  `UPDATE integration_log SET created_at = now() - interval '31 days'
    WHERE summary = 'old unresolved'`,
);
const logViews = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const noContext = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM integration_log`,
  );
  let bareInsertBlocked = false;
  await tx.query(`SAVEPOINT sp_log_bare`);
  try {
    await tx.query(
      `INSERT INTO integration_log (direction, provider, tenant_id, outcome)
       VALUES ('in', 'telegram', $1, 'recorded')`,
      [TENANT_A],
    );
  } catch (err) {
    bareInsertBlocked = /row-level security/i.test(String(err));
  }
  await tx.query(`ROLLBACK TO SAVEPOINT sp_log_bare`);
  await tx.query(`SELECT set_config('app.integration_log', 'ingest', true)`);
  await tx.query(
    `INSERT INTO integration_log (direction, provider, tenant_id, outcome, summary)
     VALUES ('out', 'telegram', $1, 'sent', 'ingested by verify')`,
    [TENANT_B],
  );
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
  const tenantA = await tx.query<{ summary: string }>(
    `SELECT summary FROM integration_log ORDER BY summary`,
  );
  await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
  await tx.query(
    `SELECT set_config('app.platform_settings', 'admin', true)`,
  );
  const platform = await tx.query<{ summary: string }>(
    `SELECT summary FROM integration_log ORDER BY summary`,
  );
  await tx.query(
    `SELECT set_config('app.platform_settings', '', true)`,
  );
  await tx.query(`SELECT set_config('app.integration_log', 'prune', true)`);
  await tx.query(
    `DELETE FROM integration_log WHERE created_at < now() - interval '30 days'`,
  );
  await tx.query(`SELECT set_config('app.integration_log', '', true)`);
  const remaining = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM integration_log`,
  );
  return { noContext, bareInsertBlocked, tenantA, platform, remaining };
});
assert.equal(logViews.noContext.rows[0].n, "0");
assert.equal(logViews.bareInsertBlocked, true);
assert.deepEqual(
  logViews.tenantA.rows.map((r) => r.summary),
  ["text message from Verify A"],
);
assert.deepEqual(
  logViews.platform.rows.map((r) => r.summary),
  ["old unresolved", "unknown account"],
);
// 5 baris ditanam/ditulis (A, B, platform segar, platform lama, ingest B);
// prune membuang tepat 1 (yang kedaluwarsa). Sisa terlihat 0 karena
// konteks sudah bersih — hitungan dicek sebagai superuser di bawah.
assert.equal(logViews.remaining.rows[0].n, "0");
const logTotal = await db.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM integration_log`,
);
assert.equal(logTotal.rows[0].n, "4");
console.log(
  "[21] Fase 7B.1: integration_log — tanpa konteks 0 baris; insert tanpa flag ingest ditolak, dengan flag diterima lintas tenant; konteks A hanya baris A; flag platform hanya baris tenant NULL; prune ber-flag hanya membuang baris >30 hari: OK",
);

// ---------- 22. Fase 7B.5: messages.reply_to_message_id ----------
// Kolom kutipan (migrasi 0029): (a) kolom ada di messages;
// (b) tautan balasan→target tersimpan & terbaca dalam konteks tenant
//     pemilik lewat policy tenant_isolation yang SUDAH ada (tidak ada
//     policy baru — kolom otomatis ternaungi policy baris tabelnya);
// (c) konteks tenant LAIN tidak melihat baris-baris itu sama sekali;
// (d) FK ON DELETE SET NULL terbukti: menghapus pesan target membuat
//     reply_to_message_id balasan menjadi NULL dan baris balasan TETAP
//     ADA (purge 6I tidak gagal & riwayat kehilangan kutipan dengan
//     anggun).
const REPLY_TARGET_ID = "60606060-6060-4060-8060-606060606060";
const REPLY_MSG_ID = "61616161-6161-4161-8161-616161616161";
{
  const colCheck = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'reply_to_message_id'`,
  );
  assert.equal(colCheck.rows[0].n, "1");
  await db.query(
    `INSERT INTO messages (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status)
     VALUES ($1, $3, $4, 'inbound', 'contact', 'text', 'Pesan target kutipan verify', 'received'),
            ($2, $3, $4, 'outbound', 'user', 'text', 'Balasan berkutipan verify', 'queued')`,
    [REPLY_TARGET_ID, REPLY_MSG_ID, TENANT_A, CONV_A],
  );
  await db.query(
    `UPDATE messages SET reply_to_message_id = $1 WHERE id = $2`,
    [REPLY_TARGET_ID, REPLY_MSG_ID],
  );
  const replyViews = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const own = await tx.query<{ id: string; reply: string | null }>(
      `SELECT id, reply_to_message_id AS reply FROM messages
        WHERE id = $1`,
      [REPLY_MSG_ID],
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM messages WHERE id = $1`,
      [REPLY_MSG_ID],
    );
    return { own, other };
  });
  assert.equal(replyViews.own.rows[0].reply, REPLY_TARGET_ID);
  assert.equal(replyViews.other.rows[0].n, "0");
  // Hapus target sebagai superuser → SET NULL, balasan tetap ada.
  await db.query(`DELETE FROM messages WHERE id = $1`, [REPLY_TARGET_ID]);
  const afterDelete = await db.query<{ reply: string | null }>(
    `SELECT reply_to_message_id AS reply FROM messages WHERE id = $1`,
    [REPLY_MSG_ID],
  );
  assert.equal(afterDelete.rows.length, 1);
  assert.equal(afterDelete.rows[0].reply, null);
  console.log(
    "[22] Fase 7B.5: kolom messages.reply_to_message_id ada; tautan kutipan terbaca dalam konteks tenant pemilik lewat policy yang ada; tenant lain melihat 0 baris; hapus target → FK SET NULL (balasan tetap ada, kutipan lepas): OK",
  );
}

// ---------- 23. Fase 7C: broadcasts + broadcast_recipients ----------
// Migrasi 0030: (a) kedua tabel ada dengan enum status; (b) konteks
// tenant A hanya melihat broadcast/penerima tenant A pada KEDUA tabel
// dan insert lintas tenant ditolak WITH CHECK; (c) tanpa konteks: 0
// baris; (d) lengan baca `system_broadcast_scan` (flag
// app.system_broadcast='reconcile') membuka SELECT broadcast lintas
// tenant untuk penyapu worker, tetapi TIDAK membuka broadcast_
// recipients dan TIDAK membuka tulis apa pun; (e) unik
// (broadcast_id, contact_id) menolak penerima ganda; (f) hapus pesan
// queued membuat message_id penerima NULL (FK SET NULL — semantik
// cancel), baris penerima tetap ada.
const BC_ID = "71717171-7171-4171-8171-717171717171";
const BC_ID_B = "72727272-7272-4272-8272-727272727272";
const BC_MSG_ID = "73737373-7373-4373-8373-737373737373";
{
  const chanRow = await db.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE tenant_id = $1 LIMIT 1`,
    [TENANT_A],
  );
  const CHAN_ANY = chanRow.rows[0].id;
  const chanB = await db.query<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, provider, external_id, status)
     VALUES ($1, 'telegram', 'bc_verify_bot_b', 'connected') RETURNING id`,
    [TENANT_B],
  );
  await db.query(
    `INSERT INTO broadcasts (id, tenant_id, channel_account_id, name, message_text, status)
     VALUES ($1, $3, $4, 'Kampanye Verify A', 'Halo {name}', 'sending'),
            ($2, $5, $6, 'Kampanye Verify B', 'Halo B', 'scheduled')`,
    [BC_ID, BC_ID_B, TENANT_A, CHAN_ANY, TENANT_B, chanB.rows[0].id],
  );
  await db.query(
    `INSERT INTO messages (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status)
     VALUES ($1, $2, $3, 'outbound', 'system', 'text', 'Halo Verify', 'queued')`,
    [BC_MSG_ID, TENANT_A, CONV_A],
  );
  await db.query(
    `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, conversation_id, message_id, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')`,
    [TENANT_A, BC_ID, CONTACT_A, CONV_A, BC_MSG_ID],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, status)
       VALUES ($1, $2, $3, 'queued')`,
      [TENANT_A, BC_ID, CONTACT_A],
    ),
    /duplicate key|broadcast_recipients_broadcast_contact_unique/i,
  );

  const bcViews = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    // Konteks tenant A: hanya milik A di kedua tabel.
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const ownB = await tx.query<{ id: string }>(
      `SELECT id FROM broadcasts ORDER BY id`,
    );
    const ownR = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM broadcast_recipients`,
    );
    // Insert untuk tenant B dari konteks A ditolak WITH CHECK
    // (savepoint agar kegagalannya tidak membatalkan transaksi uji).
    await tx.query(`SAVEPOINT sp_bc1`);
    let crossBlocked = false;
    try {
      await tx.query(
        `INSERT INTO broadcasts (tenant_id, channel_account_id, name, message_text)
         VALUES ($1, $2, 'Siluman', 'x')`,
        [TENANT_B, CHAN_ANY],
      );
    } catch {
      crossBlocked = true;
      await tx.query(`ROLLBACK TO SAVEPOINT sp_bc1`);
    }
    // Tanpa konteks & tanpa flag: 0 baris di kedua tabel.
    await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
    const bareB = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM broadcasts`,
    );
    const bareR = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM broadcast_recipients`,
    );
    // Flag reconcile: SELECT broadcasts lintas tenant terbuka (2 baris),
    // recipients tetap tertutup, dan UPDATE tetap ditolak (FOR SELECT).
    await tx.query(
      `SELECT set_config('app.system_broadcast', 'reconcile', true)`,
    );
    const scanB = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM broadcasts`,
    );
    const scanR = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM broadcast_recipients`,
    );
    // UPDATE di bawah flag scan: policy lengan ini FOR SELECT, jadi
    // UPDATE tidak melempar — ia hanya tidak melihat baris apa pun
    // (0 baris terpengaruh; status dibuktikan utuh sebagai superuser
    // sesudah transaksi).
    const scanUpd = await tx.query<{ id: string }>(
      `UPDATE broadcasts SET status = 'cancelled' WHERE id = $1 RETURNING id`,
      [BC_ID],
    );
    const scanWriteBlocked = scanUpd.rows.length === 0;
    await tx.query(`SELECT set_config('app.system_broadcast', '', true)`);
    return { ownB, ownR, crossBlocked, bareB, bareR, scanB, scanR, scanWriteBlocked };
  });
  assert.deepEqual(
    bcViews.ownB.rows.map((r) => r.id),
    [BC_ID],
  );
  assert.equal(bcViews.ownR.rows[0].n, "1");
  assert.equal(bcViews.crossBlocked, true);
  assert.equal(bcViews.bareB.rows[0].n, "0");
  assert.equal(bcViews.bareR.rows[0].n, "0");
  assert.equal(bcViews.scanB.rows[0].n, "2");
  assert.equal(bcViews.scanR.rows[0].n, "0");
  assert.equal(bcViews.scanWriteBlocked, true);
  const bcStatusAfter = await db.query<{ status: string }>(
    `SELECT status FROM broadcasts WHERE id = $1`,
    [BC_ID],
  );
  assert.equal(bcStatusAfter.rows[0].status, "sending");
  // Hapus pesan → message_id penerima SET NULL, baris tetap ada.
  await db.query(`DELETE FROM messages WHERE id = $1`, [BC_MSG_ID]);
  const recipAfter = await db.query<{ message_id: string | null }>(
    `SELECT message_id FROM broadcast_recipients WHERE broadcast_id = $1`,
    [BC_ID],
  );
  assert.equal(recipAfter.rows.length, 1);
  assert.equal(recipAfter.rows[0].message_id, null);
  console.log(
    "[23] Fase 7C: broadcasts/broadcast_recipients — isolasi tenant kedua tabel + insert silang ditolak; lengan system_broadcast_scan hanya SELECT broadcasts lintas tenant (recipients tertutup, tulis ditolak); unik (broadcast, kontak) menolak ganda; hapus pesan → message_id SET NULL: OK",
  );
}

// ---------- 24. Fase 8A: flows + flow_runs + flow_run_steps ----------
// Migrasi 0031: (a) ketiga tabel ada dengan enum status; (b) konteks
// tenant A hanya melihat flow/run/langkah tenant A pada KETIGA tabel
// dan insert lintas tenant ditolak WITH CHECK; (c) tanpa konteks: 0
// baris; (d) unik parsial (flow_id, trigger_message_id) menolak run
// kedua untuk pesan pemicu yang sama (idempotensi eksekusi); (e)
// hapus flow → run & langkah ikut terhapus (FK cascade).
const FLOW_ID = "81818181-8181-4181-8181-818181818181";
const FLOW_ID_B = "82828282-8282-4282-8282-828282828282";
const FLOW_RUN_ID = "83838383-8383-4383-8383-838383838383";
const FLOW_MSG_ID = "84848484-8484-4484-8484-848484848484";
{
  await db.query(
    `INSERT INTO flows (id, tenant_id, name, status, graph)
     VALUES ($1, $3, 'Flow Verify A', 'active', '{"nodes":[{"id":"t","type":"trigger","config":{"kind":"any_message"}}],"edges":[]}'),
            ($2, $4, 'Flow Verify B', 'draft', '{"nodes":[],"edges":[]}')`,
    [FLOW_ID, FLOW_ID_B, TENANT_A, TENANT_B],
  );
  await db.query(
    `INSERT INTO messages (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status)
     VALUES ($1, $2, $3, 'inbound', 'contact', 'text', 'pemicu flow', 'received')`,
    [FLOW_MSG_ID, TENANT_A, CONV_A],
  );
  await db.query(
    `INSERT INTO flow_runs (id, tenant_id, flow_id, conversation_id, contact_id, trigger_message_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'waiting')`,
    [FLOW_RUN_ID, TENANT_A, FLOW_ID, CONV_A, CONTACT_A, FLOW_MSG_ID],
  );
  await db.query(
    `INSERT INTO flow_run_steps (tenant_id, run_id, seq, node_id, node_type, detail)
     VALUES ($1, $2, 1, 's1', 'send_message', '{"outcome":"queued"}')`,
    [TENANT_A, FLOW_RUN_ID],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO flow_runs (tenant_id, flow_id, conversation_id, contact_id, trigger_message_id, status)
       VALUES ($1, $2, $3, $4, $5, 'running')`,
      [TENANT_A, FLOW_ID, CONV_A, CONTACT_A, FLOW_MSG_ID],
    ),
    /duplicate key|flow_runs_flow_trigger_message_unique/i,
  );

  const flowViews = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const ownF = await tx.query<{ id: string }>(`SELECT id FROM flows ORDER BY id`);
    const ownR = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flow_runs`,
    );
    const ownS = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flow_run_steps`,
    );
    await tx.query(`SAVEPOINT sp_fl1`);
    let crossBlocked = false;
    try {
      await tx.query(
        `INSERT INTO flows (tenant_id, name) VALUES ($1, 'Siluman')`,
        [TENANT_B],
      );
    } catch {
      crossBlocked = true;
      await tx.query(`ROLLBACK TO SAVEPOINT sp_fl1`);
    }
    await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
    const bareF = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flows`,
    );
    const bareR = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flow_runs`,
    );
    const bareS = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flow_run_steps`,
    );
    return { ownF, ownR, ownS, crossBlocked, bareF, bareR, bareS };
  });
  assert.deepEqual(
    flowViews.ownF.rows.map((r) => r.id),
    [FLOW_ID],
  );
  assert.equal(flowViews.ownR.rows[0].n, "1");
  assert.equal(flowViews.ownS.rows[0].n, "1");
  assert.equal(flowViews.crossBlocked, true);
  assert.equal(flowViews.bareF.rows[0].n, "0");
  assert.equal(flowViews.bareR.rows[0].n, "0");
  assert.equal(flowViews.bareS.rows[0].n, "0");
  // Hapus flow → run & langkah cascade.
  await db.query(`DELETE FROM flows WHERE id = $1`, [FLOW_ID]);
  const runsAfter = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM flow_runs WHERE flow_id = $1`,
    [FLOW_ID],
  );
  const stepsAfter = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM flow_run_steps WHERE run_id = $1`,
    [FLOW_RUN_ID],
  );
  assert.equal(runsAfter.rows[0].n, "0");
  assert.equal(stepsAfter.rows[0].n, "0");
  console.log(
    "[24] Fase 8A: flows/flow_runs/flow_run_steps — isolasi tenant ketiga tabel + insert silang ditolak; unik (flow, pesan pemicu) menolak run ganda; hapus flow → run & langkah cascade: OK",
  );
}

// ---------- 25. Hotfix 7B.6: messages.reply_to_snapshot ----------
// Kolom snapshot kutipan cadangan (migrasi 0032): (a) kolom ada di
// messages; (b) nilai jsonb {authorLabel, contentPreview} tersimpan &
// terbaca utuh dalam konteks tenant pemilik lewat policy
// tenant_isolation yang SUDAH ada (tidak ada policy baru — kolom
// otomatis ternaungi policy baris tabelnya); (c) konteks tenant LAIN
// tidak melihat baris itu sama sekali; (d) baris tanpa snapshot tetap
// terbaca NULL (pesan lama & provider tanpa teks kutipan tidak berubah).
const SNAPSHOT_MSG_ID = "62626262-6262-4262-8262-626262626262";
{
  const colCheck = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'reply_to_snapshot'`,
  );
  assert.equal(colCheck.rows[0].n, "1");
  await db.query(
    `INSERT INTO messages (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status, reply_to_snapshot)
     VALUES ($1, $2, $3, 'inbound', 'contact', 'text', 'Test balas quota', 'received',
             '{"authorLabel":"@botaramyid_bot","contentPreview":"Pagi juga gaes"}'::jsonb)`,
    [SNAPSHOT_MSG_ID, TENANT_A, CONV_A],
  );
  const snapshotViews = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const own = await tx.query<{ snap: unknown }>(
      `SELECT reply_to_snapshot AS snap FROM messages WHERE id = $1`,
      [SNAPSHOT_MSG_ID],
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM messages WHERE id = $1`,
      [SNAPSHOT_MSG_ID],
    );
    return { own, other };
  });
  assert.deepEqual(snapshotViews.own.rows[0].snap, {
    authorLabel: "@botaramyid_bot",
    contentPreview: "Pagi juga gaes",
  });
  assert.equal(snapshotViews.other.rows[0].n, "0");
  console.log(
    "[25] Hotfix 7B.6: kolom messages.reply_to_snapshot ada; snapshot jsonb tersimpan & terbaca utuh dalam konteks tenant pemilik lewat policy yang ada; tenant lain melihat 0 baris: OK",
  );
}

// ---------- 26. Fase 9A: saved_replies ----------
// Tabel macro balasan tersimpan (migrasi 0033): (a) baris terbaca dalam
// konteks tenant pemilik; (b) konteks tenant LAIN melihat 0 baris;
// (c) insert lintas tenant ditolak WITH CHECK; (d) tanpa konteks: 0 baris.
const SAVED_REPLY_ID = "93939393-9393-4393-8393-939393939393";
{
  await db.query(
    `INSERT INTO saved_replies (id, tenant_id, title, body, created_by_user_id)
     VALUES ($1, $2, 'Sapaan', 'Halo {name}, terima kasih sudah menghubungi kami!', $3)`,
    [SAVED_REPLY_ID, TENANT_A, USER_A],
  );
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const own = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM saved_replies WHERE id = $1`,
      [SAVED_REPLY_ID],
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM saved_replies WHERE id = $1`,
      [SAVED_REPLY_ID],
    );
    let crossBlocked = false;
    await tx.query(`SAVEPOINT sp_sr1`);
    try {
      await tx.query(
        `INSERT INTO saved_replies (tenant_id, title, body) VALUES ($1, 'Silang', 'x')`,
        [TENANT_A],
      );
    } catch {
      crossBlocked = true;
      await tx.query(`ROLLBACK TO SAVEPOINT sp_sr1`);
    }
    await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
    const bare = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM saved_replies`,
    );
    return { own, other, crossBlocked, bare };
  });
  assert.equal(views.own.rows[0].n, "1");
  assert.equal(views.other.rows[0].n, "0");
  assert.equal(views.crossBlocked, true);
  assert.equal(views.bare.rows[0].n, "0");
  console.log(
    "[26] Fase 9A: saved_replies — terbaca oleh tenant pemilik; tenant lain 0 baris; insert silang ditolak; tanpa konteks 0 baris: OK",
  );
}

// ---------- 27. Fase 9B: usage_ledger.meta ----------
// Kolom rincian metering (migrasi 0034): (a) kolom ada dengan default
// '{}' untuk baris yang tidak menyebutnya; (b) meta jsonb ai_token
// (agentId/provider/model/tokensIn/tokensOut/costUsd) tersimpan & bisa
// diagregasi per tenant lewat policy usage_ledger yang ada; (c) tenant
// lain tidak melihat barisnya.
{
  const USAGE_ID = "94949494-9494-4494-8494-949494949494";
  await db.query(
    `INSERT INTO usage_ledger (tenant_id, type, qty)
     VALUES ($1, 'ai_token', 10)`,
    [TENANT_A],
  );
  await db.query(
    `INSERT INTO usage_ledger (id, tenant_id, type, qty, ref_type, ref_id, meta)
     VALUES ($1, $2, 'ai_token', 42, 'agent_response', 'msg-9b', $3::jsonb)`,
    [
      USAGE_ID,
      TENANT_A,
      JSON.stringify({
        agentId: "95959595-9595-4595-8595-959595959595",
        provider: "mock",
        model: "mock-model",
        tokensIn: 30,
        tokensOut: 12,
      }),
    ],
  );
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const agg = await tx.query<{
      responses: string;
      tokens_in: string;
      tokens_out: string;
      plain_meta: unknown;
    }>(
      `SELECT count(*)::text AS responses,
              coalesce(sum((meta->>'tokensIn')::numeric), 0)::text AS tokens_in,
              coalesce(sum((meta->>'tokensOut')::numeric), 0)::text AS tokens_out,
              (SELECT meta FROM usage_ledger
                WHERE tenant_id = $1 AND ref_id IS NULL LIMIT 1) AS plain_meta
         FROM usage_ledger
        WHERE tenant_id = $1 AND type = 'ai_token' AND ref_type = 'agent_response'`,
      [TENANT_A],
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM usage_ledger WHERE id = $1`,
      [USAGE_ID],
    );
    return { agg, other };
  });
  assert.equal(views.agg.rows[0].responses, "1");
  assert.equal(views.agg.rows[0].tokens_in, "30");
  assert.equal(views.agg.rows[0].tokens_out, "12");
  assert.deepEqual(views.agg.rows[0].plain_meta, {});
  assert.equal(views.other.rows[0].n, "0");
  console.log(
    "[27] Fase 9B: usage_ledger.meta — default '{}' untuk baris lama; rincian ai_token teragregasi dalam konteks tenant pemilik; tenant lain 0 baris: OK",
  );
}

// ---------- 28. Fase 9C: conversation_notes + lengan undangan ----------
{
  const NOTE_ID = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
  const NOTE_HASH =
    "9c1111111111111111111111111111111111111111111111111111111111aaaa";
  const OTHER_HASH =
    "9c2222222222222222222222222222222222222222222222222222222222bbbb";
  // Undangan di tenant A dengan hash yang diketahui + satu undangan
  // lain (hash berbeda) sebagai kontrol negatif lengan token.
  await db.query(
    `INSERT INTO invitations (tenant_id, email, role, token_hash, expires_at)
     VALUES ($1, 'invitee-9c@example.com', 'agent', $2, now() + interval '7 days'),
            ($1, 'lain-9c@example.com', 'viewer', $3, now() + interval '7 days')`,
    [TENANT_A, NOTE_HASH, OTHER_HASH],
  );
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    // Catatan di bawah konteks tenant pemilik (CONV_A milik TENANT_A).
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    await tx.query(
      `INSERT INTO conversation_notes (id, tenant_id, conversation_id, author_user_id, body)
       VALUES ($1, $2, $3, $4, 'catatan internal verify 9C')`,
      [NOTE_ID, TENANT_A, CONV_A, USER_A],
    );
    const own = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM conversation_notes WHERE id = $1`,
      [NOTE_ID],
    );
    // Insert catatan silang (tenant konteks A, baris ber-tenant B) ditolak RLS.
    let crossInsertBlocked = false;
    await tx.query(`SAVEPOINT sp_notes1`);
    try {
      await tx.query(
        `INSERT INTO conversation_notes (tenant_id, conversation_id, body)
         VALUES ($1, $2, 'silang')`,
        [TENANT_B, CONV_A],
      );
    } catch {
      crossInsertBlocked = true;
      await tx.query(`ROLLBACK TO SAVEPOINT sp_notes1`);
    }
    // Tenant B tidak melihat catatan A.
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM conversation_notes WHERE id = $1`,
      [NOTE_ID],
    );
    // Tanpa konteks tenant: catatan 0 baris (fail-closed)…
    await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
    const noCtx = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM conversation_notes`,
    );
    // …tetapi lengan undangan membuka TEPAT baris pemilik hash token.
    await tx.query(
      `SELECT set_config('app.invitation_token_hash', $1, true)`,
      [NOTE_HASH],
    );
    const byToken = await tx.query<{ email: string }>(
      `SELECT email FROM invitations`,
    );
    // Hash yang tidak cocok tidak membuka apa pun.
    await tx.query(
      `SELECT set_config('app.invitation_token_hash', $1, true)`,
      ["9cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    );
    const wrongToken = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invitations`,
    );
    return { own, other, noCtx, byToken, wrongToken, crossInsertBlocked };
  });
  assert.equal(views.own.rows[0].n, "1");
  assert.equal(views.other.rows[0].n, "0");
  assert.equal(views.noCtx.rows[0].n, "0");
  assert.equal(views.crossInsertBlocked, true);
  assert.equal(views.byToken.rows.length, 1);
  assert.equal(views.byToken.rows[0].email, "invitee-9c@example.com");
  assert.equal(views.wrongToken.rows[0].n, "0");
  // Kolom revoked_at (Fase 9C) ada di invitations.
  const revokedCol = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_name = 'invitations' AND column_name = 'revoked_at'`,
  );
  assert.equal(revokedCol.rows[0].n, "1");
  console.log(
    "[28] Fase 9C: conversation_notes terisolasi per tenant (insert silang ditolak, tanpa konteks 0 baris); lengan invitation_token_lookup membuka tepat baris pemilik hash & menolak hash lain; invitations.revoked_at ada: OK",
  );
}

// ---------- 29. Fase 10A: whatsapp_templates + kolom template ----------
{
  const TPL_WA_CHAN = "10101010-1010-4101-8101-101010101010";
  const TPL_ID = "10101010-1010-4101-8101-101010101011";
  await db.query(
    `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, parent_external_id, display_name, status)
     VALUES ($1, $2, 'whatsapp', '628120000001', 'WABA-VERIFY-10A', 'WA Verify 10A', 'connected')`,
    [TPL_WA_CHAN, TENANT_A],
  );
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    await tx.query(
      `INSERT INTO whatsapp_templates (id, tenant_id, channel_account_id, meta_template_id, name, language, category, status, components, body_text, variable_count)
       VALUES ($1, $2, $3, 'mtpl-1', 'promo_10a', 'id', 'MARKETING', 'APPROVED', '[]'::jsonb, 'Halo {{1}}, promo di {{2}}', 2)`,
      [TPL_ID, TENANT_A, TPL_WA_CHAN],
    );
    const own = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM whatsapp_templates WHERE id = $1`,
      [TPL_ID],
    );
    // Insert silang (konteks A, baris ber-tenant B) ditolak RLS.
    let crossInsertBlocked = false;
    await tx.query(`SAVEPOINT sp_tpl1`);
    try {
      await tx.query(
        `INSERT INTO whatsapp_templates (tenant_id, channel_account_id, name, language, category, status)
         VALUES ($1, $2, 'silang_10a', 'id', 'UTILITY', 'PENDING')`,
        [TENANT_B, TPL_WA_CHAN],
      );
    } catch {
      crossInsertBlocked = true;
      await tx.query(`ROLLBACK TO SAVEPOINT sp_tpl1`);
    }
    // Unik (akun, nama, bahasa) menolak ganda dalam tenant pemilik.
    let uniqueBlocked = false;
    await tx.query(`SAVEPOINT sp_tpl2`);
    try {
      await tx.query(
        `INSERT INTO whatsapp_templates (tenant_id, channel_account_id, name, language, category, status)
         VALUES ($1, $2, 'promo_10a', 'id', 'UTILITY', 'PENDING')`,
        [TENANT_A, TPL_WA_CHAN],
      );
    } catch {
      uniqueBlocked = true;
      await tx.query(`ROLLBACK TO SAVEPOINT sp_tpl2`);
    }
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM whatsapp_templates WHERE id = $1`,
      [TPL_ID],
    );
    await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
    const noCtx = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM whatsapp_templates`,
    );
    return { own, other, noCtx, crossInsertBlocked, uniqueBlocked };
  });
  assert.equal(views.own.rows[0].n, "1");
  assert.equal(views.other.rows[0].n, "0");
  assert.equal(views.noCtx.rows[0].n, "0");
  assert.equal(views.crossInsertBlocked, true);
  assert.equal(views.uniqueBlocked, true);
  // Kolom Fase 10A pada broadcasts & messages ada.
  const cols = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE (table_name = 'broadcasts' AND column_name IN ('whatsapp_template_id', 'template_variable_sources'))
         OR (table_name = 'messages' AND column_name = 'template_payload')`,
  );
  assert.equal(cols.rows[0].n, "3");
  console.log(
    "[29] Fase 10A: whatsapp_templates terisolasi per tenant (insert silang ditolak, tanpa konteks 0 baris); unik (akun, nama, bahasa) menolak ganda; kolom broadcasts.whatsapp_template_id/template_variable_sources + messages.template_payload ada: OK",
  );
}

// ---------- 30. Fase 10B: comments + kolom provider_comment_id + enum comment ----------
{
  const CMT_IG_CHAN = "10101010-1010-4101-8101-1010101010b0";
  const CMT_ID = "10101010-1010-4101-8101-1010101010b1";
  await db.query(
    `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, public_handle)
     VALUES ($1, $2, 'instagram', '17841400008460057', 'IG Verify 10B', 'connected', '@verify10b')`,
    [CMT_IG_CHAN, TENANT_A],
  );
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    await tx.query(
      `INSERT INTO comments (id, tenant_id, channel_account_id, provider, provider_comment_id, media_id, author_external_id, author_username, text)
       VALUES ($1, $2, $3, 'instagram', 'cmt-10b-1', 'media-10b-1', 'ig-user-10b', 'komentator10b', 'info harga dong')`,
      [CMT_ID, TENANT_A, CMT_IG_CHAN],
    );
    const own = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM comments WHERE id = $1`,
      [CMT_ID],
    );
    const ownStatus = await tx.query<{ moderation_status: string }>(
      `SELECT moderation_status FROM comments WHERE id = $1`,
      [CMT_ID],
    );
    // Insert silang (konteks A, baris ber-tenant B) ditolak RLS.
    let crossInsertBlocked = false;
    await tx.query(`SAVEPOINT sp_cmt1`);
    try {
      await tx.query(
        `INSERT INTO comments (tenant_id, channel_account_id, provider, provider_comment_id, author_external_id, text)
         VALUES ($1, $2, 'instagram', 'cmt-10b-silang', 'ig-user-x', 'silang')`,
        [TENANT_B, CMT_IG_CHAN],
      );
    } catch {
      crossInsertBlocked = true;
      await tx.query(`ROLLBACK TO SAVEPOINT sp_cmt1`);
    }
    // Unik (akun, provider_comment_id) menolak ganda — penjaga dedup webhook.
    let uniqueBlocked = false;
    await tx.query(`SAVEPOINT sp_cmt2`);
    try {
      await tx.query(
        `INSERT INTO comments (tenant_id, channel_account_id, provider, provider_comment_id, author_external_id, text)
         VALUES ($1, $2, 'instagram', 'cmt-10b-1', 'ig-user-10b', 'duplikat')`,
        [TENANT_A, CMT_IG_CHAN],
      );
    } catch {
      uniqueBlocked = true;
      await tx.query(`ROLLBACK TO SAVEPOINT sp_cmt2`);
    }
    // Enum automation menerima nilai 'comment' (trigger + kind).
    await tx.query(
      `INSERT INTO automations (tenant_id, name, trigger_type, kind, trigger_config, action_type, action_config)
       VALUES ($1, 'Aturan Komentar 10B', 'comment', 'comment',
               '{"keywords":["harga"],"match":"contains","channelAccountId":"x"}'::jsonb, 'send_message',
               '{"text":"Halo!","sendDm":true,"publicReplyText":null,"hideComment":false}'::jsonb)`,
      [TENANT_A],
    );
    const rule = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automations WHERE trigger_type = 'comment' AND kind = 'comment'`,
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM comments WHERE id = $1`,
      [CMT_ID],
    );
    await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
    const noCtx = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM comments`,
    );
    return {
      own,
      other,
      noCtx,
      ownStatus,
      rule,
      crossInsertBlocked,
      uniqueBlocked,
    };
  });
  assert.equal(views.own.rows[0].n, "1");
  assert.equal(views.ownStatus.rows[0].moderation_status, "visible");
  assert.equal(views.other.rows[0].n, "0");
  assert.equal(views.noCtx.rows[0].n, "0");
  assert.equal(views.crossInsertBlocked, true);
  assert.equal(views.uniqueBlocked, true);
  assert.equal(views.rule.rows[0].n, "1");
  // Kolom Fase 10B pada messages ada.
  const col = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'provider_comment_id'`,
  );
  assert.equal(col.rows[0].n, "1");
  console.log(
    "[30] Fase 10B: comments terisolasi per tenant (insert silang ditolak, tanpa konteks 0 baris); unik (akun, provider_comment_id) menolak ganda; enum automation menerima 'comment'; messages.provider_comment_id ada: OK",
  );
}

// ---------- 31. Fase 12A: flow_runs.trigger_message_id NULLABLE ----------
// Dulu migrasi 0038 (prasyarat node goto_flow), kini bagian baseline:
// (a) kolom trigger_message_id
// kini is_nullable = YES; (b) run goto (trigger NULL) bisa ditulis dalam
// konteks tenant pemilik; (c) DUA run NULL pada flow yang sama sama-sama
// diterima — index unik parsial memang mengabaikan NULL, sehingga
// rantai goto tidak mati oleh constraint idempotensi pesan; (d) tenant
// lain tidak melihat run-run itu.
const FLOW12_ID = "a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0";
const GOTO_RUN_1 = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const GOTO_RUN_2 = "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2";
{
  const col = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'flow_runs' AND column_name = 'trigger_message_id'`,
  );
  assert.equal(col.rows[0].is_nullable, "YES");
  await db.query(
    `INSERT INTO flows (id, tenant_id, name, status, graph)
     VALUES ($1, $2, 'Flow 12A', 'active', '{"nodes":[],"edges":[]}')`,
    [FLOW12_ID, TENANT_A],
  );
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    await tx.query(
      `INSERT INTO flow_runs (id, tenant_id, flow_id, conversation_id, contact_id, trigger_message_id, status, context)
       VALUES ($1, $2, $3, $4, $5, NULL, 'running', '{"gotoDepth":1}'::jsonb),
              ($6, $2, $3, $4, $5, NULL, 'completed', '{"gotoDepth":2}'::jsonb)`,
      [GOTO_RUN_1, TENANT_A, FLOW12_ID, CONV_A, CONTACT_A, GOTO_RUN_2],
    );
    const own = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flow_runs WHERE flow_id = $1 AND trigger_message_id IS NULL`,
      [FLOW12_ID],
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flow_runs WHERE flow_id = $1`,
      [FLOW12_ID],
    );
    return { own, other };
  });
  assert.equal(views.own.rows[0].n, "2");
  assert.equal(views.other.rows[0].n, "0");
  console.log(
    "[31] Fase 12A: flow_runs.trigger_message_id nullable (baseline; dulu migrasi 0038) — run goto tanpa pesan pemicu tersimpan; dua run NULL pada flow sama diterima (unik parsial abaikan NULL); tenant lain 0 baris: OK",
  );
}

// ---------- 32. Fase 12C: lampiran berkas KB (kb_source_documents) ----------
// Dulu migrasi 0039, kini bagian baseline: (a) kolom kb_documents.source_document_id nullable ada;
// (b) baris berkas + entri turunan + chunk bisa ditulis dalam konteks
// tenant pemilik, byte bytea terbaca kembali utuh; (c) tenant lain 0
// baris dan insert lintas tenant ditolak RLS; (d) menghapus baris
// berkas men-cascade ke entri turunan + chunk-nya, sementara entri
// tulis tangan (source NULL) di tenant yang sama TIDAK terpengaruh.
const KB_SRC_12C = "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1";
const KB_ENTRY_12C = "d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2";
const KB_MANUAL_12C = "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3";
{
  const col = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'kb_documents' AND column_name = 'source_document_id'`,
  );
  assert.equal(col.rows[0].is_nullable, "YES");

  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    await tx.query(
      `INSERT INTO kb_source_documents (id, tenant_id, file_name, mime_type, byte_size, data, chunk_count, created_by)
       VALUES ($1, $2, 'panduan.txt', 'text/plain', 4, '\\x01020304', 2, $3)`,
      [KB_SRC_12C, TENANT_A, USER_A],
    );
    await tx.query(
      `INSERT INTO kb_documents (id, tenant_id, title, content, source_document_id)
       VALUES ($1, $2, 'panduan.txt', 'isi panduan', $3),
              ($4, $2, 'Entri Manual', 'tulis tangan', NULL)`,
      [KB_ENTRY_12C, TENANT_A, KB_SRC_12C, KB_MANUAL_12C],
    );
    await tx.query(
      `INSERT INTO kb_chunks (tenant_id, document_id, chunk_index, content)
       VALUES ($1, $2, 0, 'potongan satu'), ($1, $2, 1, 'potongan dua')`,
      [TENANT_A, KB_ENTRY_12C],
    );
    const back = await tx.query<{ data: Uint8Array; chunk_count: number }>(
      `SELECT data, chunk_count FROM kb_source_documents WHERE id = $1`,
      [KB_SRC_12C],
    );

    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const otherFiles = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM kb_source_documents`,
    );
    const otherDocs = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM kb_documents`,
    );
    let crossBlocked = false;
    await tx.query(`SAVEPOINT sp32`);
    try {
      await tx.query(
        `INSERT INTO kb_source_documents (tenant_id, file_name, mime_type, byte_size, data)
         VALUES ($1, 'lintas.txt', 'text/plain', 1, '\\x00')`,
        [TENANT_A],
      );
    } catch (err) {
      crossBlocked = /row-level security/i.test(String(err));
      await tx.query(`ROLLBACK TO SAVEPOINT sp32`);
    }
    return { back, otherFiles, otherDocs, crossBlocked };
  });
  assert.equal(Buffer.from(views.back.rows[0].data).toString("hex"), "01020304");
  assert.equal(views.back.rows[0].chunk_count, 2);
  assert.equal(views.otherFiles.rows[0].n, "0");
  assert.equal(views.otherDocs.rows[0].n, "0");
  assert.equal(views.crossBlocked, true);

  // Hapus berkas (superuser — cascade murni FK, tanpa konteks RLS):
  // entri turunan + chunk hilang, entri manual tetap.
  await db.query(`DELETE FROM kb_source_documents WHERE id = $1`, [KB_SRC_12C]);
  const after = await db.query<{ files: string; derived: string; chunks: string; manual: string }>(
    `SELECT
       (SELECT count(*)::text FROM kb_source_documents WHERE id = $1) AS files,
       (SELECT count(*)::text FROM kb_documents WHERE id = $2) AS derived,
       (SELECT count(*)::text FROM kb_chunks WHERE document_id = $2) AS chunks,
       (SELECT count(*)::text FROM kb_documents WHERE id = $3) AS manual`,
    [KB_SRC_12C, KB_ENTRY_12C, KB_MANUAL_12C],
  );
  assert.equal(after.rows[0].files, "0");
  assert.equal(after.rows[0].derived, "0");
  assert.equal(after.rows[0].chunks, "0");
  assert.equal(after.rows[0].manual, "1");
  console.log(
    "[32] Fase 12C: kb_source_documents (baseline; dulu migrasi 0039) — berkas+entri+chunk tertulis dalam konteks pemilik, bytea utuh, tenant lain 0 baris & insert lintas ditolak RLS; hapus berkas men-cascade entri+chunk, entri manual tetap: OK",
  );
}

// ---------- 33. Fase 12D: embedding KB (vector(1536) di kb_chunks) ----------
// Kolom `embedding` sudah ada sejak migrasi 0009 (Fase 3A) — fase ini
// membuktikan operasi pgvector-nya di level skema: (a) vektor 1536
// dimensi tersimpan & vector_dims benar; (b) pencarian tetangga
// terdekat (operator cosine <=>) mengembalikan chunk yang vektornya
// identik dengan kueri; (c) dalam konteks RLS tenant lain, kueri
// vektor melihat 0 baris (isolasi berlaku juga untuk jalur semantik);
// (d) chunk ber-embedding NULL tidak ikut hasil vektor tetapi tetap
// terhitung sebagai tertunda.
const KB_DOC_12D = "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1";
function oneHotVector(index: number): string {
  const parts = new Array<string>(1536).fill("0");
  parts[index] = "1";
  return `[${parts.join(",")}]`;
}
{
  const VEC_A = oneHotVector(0);
  const VEC_B = oneHotVector(1);
  await db.query(
    `INSERT INTO kb_documents (id, tenant_id, title, content)
     VALUES ($1, $2, 'Dokumen 12D', 'isi dokumen uji vektor')`,
    [KB_DOC_12D, TENANT_A],
  );
  const inserted = await db.query<{ id: string; chunk_index: number }>(
    `INSERT INTO kb_chunks (tenant_id, document_id, chunk_index, content, embedding)
     VALUES ($1, $2, 0, 'chunk vektor a', $3::vector),
            ($1, $2, 1, 'chunk vektor b', $4::vector),
            ($1, $2, 2, 'chunk tanpa vektor', NULL)
     RETURNING id, chunk_index`,
    [TENANT_A, KB_DOC_12D, VEC_A, VEC_B],
  );
  const chunkA = inserted.rows.find((r) => r.chunk_index === 0)!.id;
  const dims = await db.query<{ d: number }>(
    `SELECT vector_dims(embedding) AS d FROM kb_chunks WHERE id = $1`,
    [chunkA],
  );
  assert.equal(dims.rows[0].d, 1536);

  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const nearest = await tx.query<{ id: string; dist: number }>(
      `SELECT id, (embedding <=> $1::vector) AS dist FROM kb_chunks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 1`,
      [VEC_A],
    );
    const counts = await tx.query<{ embedded: string; pending: string }>(
      `SELECT
         (SELECT count(*)::text FROM kb_chunks WHERE embedding IS NOT NULL) AS embedded,
         (SELECT count(*)::text FROM kb_chunks WHERE embedding IS NULL AND document_id = $1) AS pending`,
      [KB_DOC_12D],
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM kb_chunks WHERE embedding IS NOT NULL`,
    );
    return { nearest, counts, other };
  });
  assert.equal(views.nearest.rows[0].id, chunkA);
  assert.ok(Math.abs(views.nearest.rows[0].dist) < 1e-6);
  assert.equal(views.counts.rows[0].pending, "1");
  assert.ok(Number(views.counts.rows[0].embedded) >= 2);
  assert.equal(views.other.rows[0].n, "0");
  console.log(
    "[33] Fase 12D: kb_chunks.embedding vector(1536) — vector_dims 1536, tetangga cosine terdekat = chunk identik (jarak ~0), chunk NULL terhitung tertunda, tenant lain 0 baris pada kueri vektor: OK",
  );
}

// ---------- 34. Fase 11A + 11A.1: normalisasi & baseline squash ----------
{
  // Dua kolom warisan yang dijatuhkan 0040 (pra-squash) tidak boleh ada
  // lagi — ketiadaannya kini bagian dari baseline 0000.
  const dropped = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'contacts' AND column_name = 'avatar_url')
          OR (table_name = 'messages' AND column_name = 'provider_cost'))`,
  );
  assert.equal(dropped.rows[0].count, "0");

  // 12 index FK baru dari 0040 (kini bagian baseline) semuanya terpasang.
  const idx = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'agent_suggestions_agent_id_idx', 'agent_suggestions_contact_id_idx',
        'automation_runs_contact_id_idx', 'automation_runs_conversation_id_idx',
        'broadcast_recipients_contact_id_idx',
        'broadcast_recipients_conversation_id_idx',
        'comments_contact_id_idx', 'comments_conversation_id_idx',
        'flow_runs_contact_id_idx',
        'payment_links_contact_id_idx', 'payment_links_conversation_id_idx',
        'sequence_enrollments_contact_id_idx')`,
  );
  assert.equal(idx.rows.length, 12);

  // Jumlah tabel & policy: normalisasi sendiri tidak mengubahnya
  // (44 / 57 pada titik 11A.1); Fase 13B menambah 2 tabel growth +
  // 3 policy (2 tenant_isolation + 1 lengan lookup publik) → 46 / 60;
  // Fase 13C menambah 2 tabel (segments, tenant_opt_in_settings) +
  // 2 policy tenant_isolation → 48 / 62; Fase 13D menambah 1 tabel
  // (flow_experiment_assignments) + 1 policy → 49 / 63; Fase 13F
  // menambah 4 tabel commerce (carts, cart_items, orders,
  // order_items) + 4 policy tenant_isolation → 53 / 67; Fase 13G
  // menambah 5 tabel janji temu (appointment_services,
  // appointment_settings, appointment_availability, bookings,
  // google_calendar_connections) + 5 policy tenant_isolation → 58 / 72.
  // Fase 14A menambah 1 tabel (payment_provider_configs) + 1 policy
  // tenant_isolation → 59 / 73.
  // 2026-11-05: rantai migrasi dibangun ulang dari schema Drizzle; jumlah
  // policy menjadi 76 (lihat catatan di bagian 4). Angka tabel tetap 59.
  // 2026-11-06: migrasi 0004 menambah lengan `whatsapp_waba_lookup` → 77
  // (kolom baru `whatsapp_templates.status_reason` tidak menambah policy).
  // 2026-11-07: migrasi 0007 menambah lengan `system_media_gc_scan` → 78.
  const counts = await db.query<{ tables: string; policies: string }>(
    `SELECT
       (SELECT count(*)::text FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
       (SELECT count(*)::text FROM pg_policies
         WHERE schemaname = 'public') AS policies`,
  );
  assert.equal(counts.rows[0].tables, "59");
  assert.equal(counts.rows[0].policies, "78");
  console.log(
    "[34] Fase 11A+11A.1: baseline squash — contacts.avatar_url & messages.provider_cost tidak ada (dijatuhkan 0040), 12 index FK terpasang, tabel & policy global sesuai hitungan berjalan: OK",
  );
}

// ---------- 35. Fase 11B: kolom status email undangan (migrasi generate) ----------
{
  // Kolom email_sent_at + email_error (migrasi 0001_invitation_email,
  // hasil `pnpm db:generate`) ada di invitations.
  const cols = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'invitations'
        AND column_name IN ('email_sent_at', 'email_error')`,
  );
  assert.equal(cols.rows[0].count, "2");

  // Baris undangan baru: kedua kolom NULL secara bawaan; nilai yang
  // ditulis job email terbaca dalam konteks tenant pemilik dan tidak
  // terlihat dari tenant lain (isolasi invitations tidak berubah).
  const EMAIL_HASH =
    "11b111111111111111111111111111111111111111111111111111111111aaaa";
  await db.query(
    `INSERT INTO invitations (tenant_id, email, role, token_hash, expires_at, email_error)
     VALUES ($1, 'invitee-11b@example.com', 'agent', $2, now() + interval '7 days',
             'RESEND_HTTP_500: mock failure')`,
    [TENANT_A, EMAIL_HASH],
  );
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const own = await tx.query<{ email_error: string; email_sent_at: unknown }>(
      `SELECT email_error, email_sent_at FROM invitations WHERE token_hash = $1`,
      [EMAIL_HASH],
    );
    await tx.query(
      `UPDATE invitations SET email_sent_at = now(), email_error = NULL
        WHERE token_hash = $1`,
      [EMAIL_HASH],
    );
    const after = await tx.query<{ ok: boolean }>(
      `SELECT (email_sent_at IS NOT NULL AND email_error IS NULL) AS ok
         FROM invitations WHERE token_hash = $1`,
      [EMAIL_HASH],
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invitations WHERE token_hash = $1`,
      [EMAIL_HASH],
    );
    return { own, after, other };
  });
  assert.equal(views.own.rows[0].email_error, "RESEND_HTTP_500: mock failure");
  assert.equal(views.own.rows[0].email_sent_at, null);
  assert.equal(views.after.rows[0].ok, true);
  assert.equal(views.other.rows[0].n, "0");
  console.log(
    "[35] Fase 11B: invitations.email_sent_at/email_error ada (migrasi hasil generate); status kirim tertulis & terbaca dalam konteks pemilik, tenant lain 0 baris: OK",
  );
}

// ---------- 36. Fase 13B: growth links + events + contacts.source ----------
{
  // Kolom atribusi kontak ada.
  const srcCol = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'contacts'
        AND column_name = 'source'`,
  );
  assert.equal(srcCol.rows[0].count, "1");

  // Seed: satu akun channel tenant A + link single + link picker.
  const CHAN_A = "13b00000-0000-4000-8000-0000000000a1";
  await db.query(
    `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, display_name, status, bot_username)
     VALUES ($1, $2, 'telegram', '8800000013', 'Bot Uji 13B', 'connected', 'bot13b_bot')`,
    [CHAN_A, TENANT_A],
  );
  const LINK_SINGLE = "13b00000-0000-4000-8000-0000000000b1";
  const LINK_PICKER = "13b00000-0000-4000-8000-0000000000b2";
  await db.query(
    `INSERT INTO growth_links (id, tenant_id, kind, label, slug, channel_account_id, auto_tag)
     VALUES ($1, $2, 'single', 'Promo', 'promo-13b', $3, 'lead-promo')`,
    [LINK_SINGLE, TENANT_A, CHAN_A],
  );
  await db.query(
    `INSERT INTO growth_links (id, tenant_id, kind, label, slug, picker_channel_ids)
     VALUES ($1, $2, 'picker', 'Semua Channel', 'semua-13b', $3::jsonb)`,
    [LINK_PICKER, TENANT_A, JSON.stringify([CHAN_A, CHAN_A.replace("a1", "a2")])],
  );

  // Slug unik GLOBAL: tenant lain tidak bisa memakai slug yang sama.
  await assert.rejects(
    db.query(
      `INSERT INTO growth_links (tenant_id, kind, label, slug, channel_account_id)
       VALUES ($1, 'single', 'Tiru', 'promo-13b', $2)`,
      [TENANT_B, CHAN_A],
    ),
    /duplicate key|unique/i,
  );
  // CHECK kind/channel: single tanpa channel_account_id ditolak;
  // picker dengan <2 channel ditolak.
  await assert.rejects(
    db.query(
      `INSERT INTO growth_links (tenant_id, kind, label, slug)
       VALUES ($1, 'single', 'Yatim', 'yatim-13b')`,
      [TENANT_A],
    ),
    /check|violates/i,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO growth_links (tenant_id, kind, label, slug, picker_channel_ids)
       VALUES ($1, 'picker', 'Kurang', 'kurang-13b', '[]'::jsonb)`,
      [TENANT_A],
    ),
    /check|violates/i,
  );
  // picker_channel_ids & is_active NOT NULL ber-default (aturan NOT
  // NULL user 2026-11-03): baris single di atas menyimpan [] & true.
  const defaults = await db.query<{ picker_channel_ids: unknown; is_active: boolean }>(
    `SELECT picker_channel_ids, is_active FROM growth_links WHERE id = $1`,
    [LINK_SINGLE],
  );
  assert.deepEqual(defaults.rows[0].picker_channel_ids, []);
  assert.equal(defaults.rows[0].is_active, true);

  // Event: klik anonim (contact NULL) sah; konversi sekali per kontak
  // per link — sisipan kedua ditolak index unik parsial.
  const CONTACT_A = "13b00000-0000-4000-8000-0000000000c1";
  await db.query(
    `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Kontak 13B')`,
    [CONTACT_A, TENANT_A],
  );
  await db.query(
    `INSERT INTO growth_link_events (tenant_id, growth_link_id, kind)
     VALUES ($1, $2, 'click')`,
    [TENANT_A, LINK_SINGLE],
  );
  await db.query(
    `INSERT INTO growth_link_events (tenant_id, growth_link_id, kind, contact_id)
     VALUES ($1, $2, 'conversion', $3)`,
    [TENANT_A, LINK_SINGLE, CONTACT_A],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO growth_link_events (tenant_id, growth_link_id, kind, contact_id)
       VALUES ($1, $2, 'conversion', $3)`,
      [TENANT_A, LINK_SINGLE, CONTACT_A],
    ),
    /duplicate key|unique/i,
  );

  // RLS: konteks tenant A melihat link+event-nya; tenant B nol baris;
  // insert lintas tenant ditolak WITH CHECK.
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const ownLinks = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM growth_links`,
    );
    const ownEvents = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM growth_link_events`,
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const otherLinks = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM growth_links`,
    );
    const otherEvents = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM growth_link_events`,
    );
    let crossBlocked = false;
    await tx.query(`SAVEPOINT sp36`);
    try {
      await tx.query(
        `INSERT INTO growth_links (tenant_id, kind, label, slug, channel_account_id)
         VALUES ($1, 'single', 'Lintas', 'lintas-13b', $2)`,
        [TENANT_A, CHAN_A],
      );
    } catch (err) {
      crossBlocked = /row-level security/i.test(String(err));
      await tx.query(`ROLLBACK TO SAVEPOINT sp36`);
    }
    return { ownLinks, ownEvents, otherLinks, otherEvents, crossBlocked };
  });
  assert.equal(views.ownLinks.rows[0].n, "2");
  assert.equal(views.ownEvents.rows[0].n, "2");
  assert.equal(views.otherLinks.rows[0].n, "0");
  assert.equal(views.otherEvents.rows[0].n, "0");
  assert.equal(views.crossBlocked, true);

  // Lengan publik: TANPA konteks tenant, app.growth_slug membuka tepat
  // baris slug itu (dan bukan slug lain / bukan events).
  const pub = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.growth_slug', 'promo-13b', true)`);
    const hit = await tx.query<{ slug: string }>(
      `SELECT slug FROM growth_links`,
    );
    await tx.query(`SELECT set_config('app.growth_slug', 'tidak-ada', true)`);
    const miss = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM growth_links`,
    );
    return { hit, miss };
  });
  assert.deepEqual(pub.hit.rows.map((r) => r.slug), ["promo-13b"]);
  assert.equal(pub.miss.rows[0].n, "0");
  console.log(
    "[36] Fase 13B: growth_links/growth_link_events — slug unik global, CHECK kind/channel, konversi unik per kontak, isolasi tenant, lengan lookup publik per slug, contacts.source ada: OK",
  );
}

// ---------- 37. Fase 13C: segments + tenant_opt_in_settings + kolom opt-in ----------
{
  // Kolom baru ada: contacts.opt_in_source/opt_in_at (nullable —
  // kondisional), broadcasts.require_opt_in (NOT NULL, default false).
  const cols = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'contacts' AND column_name IN ('opt_in_source', 'opt_in_at'))
          OR (table_name = 'broadcasts' AND column_name = 'require_opt_in'
              AND is_nullable = 'NO' AND column_default LIKE '%false%'))`,
  );
  assert.equal(cols.rows[0].n, "3");

  // Seed tenant A: satu segmen + satu baris pengaturan opt-in.
  const SEG_A = "13c00000-0000-4000-8000-0000000000a1";
  await db.query(
    `INSERT INTO segments (id, tenant_id, name, definition)
     VALUES ($1, $2, 'Lead Webinar', '{"match":"all","conditions":[{"type":"tag","tag":"webinar"}]}'::jsonb)`,
    [SEG_A, TENANT_A],
  );
  await db.query(
    `INSERT INTO tenant_opt_in_settings (tenant_id, opt_in_keywords, opt_in_confirmation_text, opt_out_extra_keywords)
     VALUES ($1, '["ikut"]'::jsonb, 'Siap, kamu ikut!', '[]'::jsonb)`,
    [TENANT_A],
  );
  // Kontak tenant A menyimpan jejak opt-in keyword.
  const CONTACT_13C = "13c00000-0000-4000-8000-0000000000c1";
  await db.query(
    `INSERT INTO contacts (id, tenant_id, name, opt_in_status, opt_in_source, opt_in_at)
     VALUES ($1, $2, 'Kontak 13C', 'opted_in', 'keyword', now())`,
    [CONTACT_13C, TENANT_A],
  );
  const trail = await db.query<{ opt_in_source: string }>(
    `SELECT opt_in_source FROM contacts WHERE id = $1`,
    [CONTACT_13C],
  );
  assert.equal(trail.rows[0].opt_in_source, "keyword");

  // Isolasi RLS sebagai app_user: tenant A melihat barisnya; tenant B
  // 0 baris; insert lintas tenant ditolak WITH CHECK.
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const ownSegments = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM segments`,
    );
    const ownSettings = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_opt_in_settings`,
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const otherSegments = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM segments`,
    );
    const otherSettings = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_opt_in_settings`,
    );
    let crossBlocked = false;
    try {
      await tx.query(
        `INSERT INTO segments (tenant_id, name, definition)
         VALUES ($1, 'Silang', '{"match":"all","conditions":[]}'::jsonb)`,
        [TENANT_A],
      );
    } catch {
      crossBlocked = true;
    }
    return { ownSegments, ownSettings, otherSegments, otherSettings, crossBlocked };
  });
  assert.equal(views.ownSegments.rows[0].n, "1");
  assert.equal(views.ownSettings.rows[0].n, "1");
  assert.equal(views.otherSegments.rows[0].n, "0");
  assert.equal(views.otherSettings.rows[0].n, "0");
  assert.equal(views.crossBlocked, true);
  console.log(
    "[37] Fase 13C: segments & tenant_opt_in_settings terisolasi tenant (insert silang ditolak); contacts.opt_in_source/opt_in_at ada; broadcasts.require_opt_in NOT NULL default false: OK",
  );
}

// ---------- 38. Fase 13D: flow_experiment_assignments + kolom A/B broadcast ----------
{
  // Kolom baru: broadcasts.ab_split_percent_b (nullable — kondisional),
  // variant_b_message_text (nullable), variant_b_whatsapp_template_id
  // (nullable), variant_b_template_variable_sources (NOT NULL default
  // '[]'), broadcast_recipients.variant (NOT NULL default 'a').
  const cols = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'broadcasts' AND column_name IN
               ('ab_split_percent_b', 'variant_b_message_text',
                'variant_b_whatsapp_template_id')
              AND is_nullable = 'YES')
          OR (table_name = 'broadcasts' AND column_name = 'variant_b_template_variable_sources'
              AND is_nullable = 'NO')
          OR (table_name = 'broadcast_recipients' AND column_name = 'variant'
              AND is_nullable = 'NO' AND column_default LIKE '%''a''%'))`,
  );
  assert.equal(cols.rows[0].n, "5");

  // Seed mandiri tenant A: channel + kontak + percakapan + flow + run.
  const CH_13D = "13d00000-0000-4000-8000-0000000000a0";
  const CONTACT_13D = "13d00000-0000-4000-8000-0000000000c1";
  const CONV_13D = "13d00000-0000-4000-8000-0000000000d1";
  const FLOW_13D = "13d00000-0000-4000-8000-0000000000f1";
  const RUN_13D = "13d00000-0000-4000-8000-0000000000e1";
  await db.query(
    `INSERT INTO channel_accounts (id, tenant_id, provider, external_id, status)
     VALUES ($1, $2, 'telegram', 'bot13d', 'connected')`,
    [CH_13D, TENANT_A],
  );
  await db.query(
    `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Kontak 13D')`,
    [CONTACT_13D, TENANT_A],
  );
  await db.query(
    `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, kind, status)
     VALUES ($1, $2, $3, $4, 'telegram', 'chat-13d', 'private', 'open')`,
    [CONV_13D, TENANT_A, CH_13D, CONTACT_13D],
  );
  await db.query(
    `INSERT INTO flows (id, tenant_id, name, status, graph)
     VALUES ($1, $2, 'Flow Eksperimen 13D', 'active',
       '{"nodes":[{"id":"t","type":"trigger","config":{"kind":"any_message"}},{"id":"split1","type":"ab_split","config":{"percentA":50,"experiment":true}}],"edges":[]}')`,
    [FLOW_13D, TENANT_A],
  );
  await db.query(
    `INSERT INTO flow_runs (id, tenant_id, flow_id, conversation_id, contact_id, status)
     VALUES ($1, $2, $3, $4, $5, 'running')`,
    [RUN_13D, TENANT_A, FLOW_13D, CONV_13D, CONTACT_13D],
  );
  await db.query(
    `INSERT INTO flow_experiment_assignments (tenant_id, flow_id, node_id, contact_id, run_id, branch, label, percent_a)
     VALUES ($1, $2, 'split1', $3, $4, 'a', 'Judul A/B', 50)`,
    [TENANT_A, FLOW_13D, CONTACT_13D, RUN_13D],
  );
  // Unik lengket: penugasan kedua untuk (flow, node, kontak) yang sama
  // ditolak — penugasan pertama menang selamanya.
  await assert.rejects(
    db.query(
      `INSERT INTO flow_experiment_assignments (tenant_id, flow_id, node_id, contact_id, run_id, branch, percent_a)
       VALUES ($1, $2, 'split1', $3, $4, 'b', 50)`,
      [TENANT_A, FLOW_13D, CONTACT_13D, RUN_13D],
    ),
    /duplicate key|flow_experiment_assignments_sticky_unique/i,
  );

  // broadcast_recipients.variant: bawaan 'a' tanpa dinyatakan.
  const BC_13D = "13d00000-0000-4000-8000-0000000000b1";
  await db.query(
    `INSERT INTO broadcasts (id, tenant_id, channel_account_id, name, message_text, ab_split_percent_b, variant_b_message_text)
     VALUES ($1, $2, $3, 'Broadcast A/B 13D', 'Isi A', 50, 'Isi B')`,
    [BC_13D, TENANT_A, CH_13D],
  );
  const recIns = await db.query<{ variant: string }>(
    `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, status)
     VALUES ($1, $2, $3, 'queued') RETURNING variant`,
    [TENANT_A, BC_13D, CONTACT_13D],
  );
  assert.equal(recIns.rows[0].variant, "a");

  // Isolasi RLS penugasan: A melihat barisnya; B 0 baris; insert
  // lintas tenant ditolak WITH CHECK.
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const own = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flow_experiment_assignments`,
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const other = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM flow_experiment_assignments`,
    );
    let crossBlocked = false;
    try {
      await tx.query(
        `INSERT INTO flow_experiment_assignments (tenant_id, flow_id, node_id, contact_id, run_id, branch, percent_a)
         VALUES ($1, $2, 'split1', $3, $4, 'a', 50)`,
        [TENANT_A, FLOW_13D, CONTACT_13D, RUN_13D],
      );
    } catch {
      crossBlocked = true;
    }
    return { own, other, crossBlocked };
  });
  assert.equal(views.own.rows[0].n, "1");
  assert.equal(views.other.rows[0].n, "0");
  assert.equal(views.crossBlocked, true);
  console.log(
    "[38] Fase 13D: flow_experiment_assignments terisolasi tenant + unik lengket (flow,node,kontak); kolom A/B broadcasts ada (nullable kondisional); broadcast_recipients.variant NOT NULL default 'a': OK",
  );
}

// ---------- 39. Fase 13F: carts/orders + payment_links dual-varian ----------
{
  // Kolom varian: payment_links.product_id sekarang NULLABLE dan
  // order_id ada (NULLABLE — varian kondisional yang ditegakkan CHECK
  // tepat-satu-target, bukan dua-duanya wajib).
  const cols = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_links'
        AND column_name IN ('product_id', 'order_id')
        AND is_nullable = 'YES'`,
  );
  assert.equal(cols.rows[0].n, "2");

  // Seed mandiri tenant A: produk + kontak + order.
  const PROD_13F = "13f00000-0000-4000-8000-0000000000a1";
  const CONTACT_13F = "13f00000-0000-4000-8000-0000000000c1";
  const ORDER_13F = "13f00000-0000-4000-8000-0000000000d1";
  await db.query(
    `INSERT INTO products (id, tenant_id, name, price_idr)
     VALUES ($1, $2, 'Produk 13F', 150000)`,
    [PROD_13F, TENANT_A],
  );
  await db.query(
    `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Kontak 13F')`,
    [CONTACT_13F, TENANT_A],
  );
  await db.query(
    `INSERT INTO orders (id, tenant_id, contact_id, total_idr)
     VALUES ($1, $2, $3, 300000)`,
    [ORDER_13F, TENANT_A, CONTACT_13F],
  );
  await db.query(
    `INSERT INTO order_items (tenant_id, order_id, product_id, product_name, qty, unit_price_idr)
     VALUES ($1, $2, $3, 'Produk 13F', 2, 150000)`,
    [TENANT_A, ORDER_13F, PROD_13F],
  );

  // Varian tautan: produk saja OK; order saja OK.
  await db.query(
    `INSERT INTO payment_links (tenant_id, product_id, code, amount_idr, expires_at)
     VALUES ($1, $2, 'link13fprod', 150000, now() + interval '7 days')`,
    [TENANT_A, PROD_13F],
  );
  await db.query(
    `INSERT INTO payment_links (tenant_id, order_id, contact_id, code, amount_idr, expires_at)
     VALUES ($1, $2, $3, 'link13forder', 300000, now() + interval '7 days')`,
    [TENANT_A, ORDER_13F, CONTACT_13F],
  );
  // Keduanya terisi → CHECK menolak; keduanya kosong → CHECK menolak.
  await assert.rejects(
    db.query(
      `INSERT INTO payment_links (tenant_id, product_id, order_id, code, amount_idr, expires_at)
       VALUES ($1, $2, $3, 'link13fboth', 1, now() + interval '7 days')`,
      [TENANT_A, PROD_13F, ORDER_13F],
    ),
    /check constraint|payment_links_exactly_one_target/i,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO payment_links (tenant_id, code, amount_idr, expires_at)
       VALUES ($1, 'link13fnone', 1, now() + interval '7 days')`,
      [TENANT_A],
    ),
    /check constraint|payment_links_exactly_one_target/i,
  );

  // Keranjang: satu keranjang TERBUKA per kontak (unik parsial).
  const CART_13F = "13f00000-0000-4000-8000-0000000000e1";
  await db.query(
    `INSERT INTO carts (id, tenant_id, contact_id) VALUES ($1, $2, $3)`,
    [CART_13F, TENANT_A, CONTACT_13F],
  );
  await db.query(
    `INSERT INTO cart_items (tenant_id, cart_id, product_id, qty, unit_price_idr)
     VALUES ($1, $2, $3, 2, 150000)`,
    [TENANT_A, CART_13F, PROD_13F],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO carts (tenant_id, contact_id) VALUES ($1, $2)`,
      [TENANT_A, CONTACT_13F],
    ),
    /duplicate key|carts_one_open_per_contact/i,
  );
  // Keranjang checked_out kedua untuk kontak yang sama DIIZINKAN
  // (riwayat checkout tidak menghalangi keranjang terbuka baru).
  await db.query(
    `INSERT INTO carts (tenant_id, contact_id, status) VALUES ($1, $2, 'checked_out')`,
    [TENANT_A, CONTACT_13F],
  );

  // Isolasi RLS sebagai app_user: tenant A melihat keranjang+ordernya;
  // konteks B melihat 0; sisip lintas tenant ditolak.
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const ownCarts = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM carts`,
    );
    const ownOrders = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders`,
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const otherCarts = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM carts`,
    );
    const otherOrders = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders`,
    );
    let crossBlocked = false;
    try {
      await tx.query(
        `INSERT INTO carts (tenant_id, contact_id) VALUES ($1, $2)`,
        [TENANT_A, CONTACT_13F],
      );
    } catch {
      crossBlocked = true;
    }
    return { ownCarts, ownOrders, otherCarts, otherOrders, crossBlocked };
  });
  assert.equal(views.ownCarts.rows[0].n, "2");
  assert.equal(views.ownOrders.rows[0].n, "1");
  assert.equal(views.otherCarts.rows[0].n, "0");
  assert.equal(views.otherOrders.rows[0].n, "0");
  assert.equal(views.crossBlocked, true);
  console.log(
    "[39] Fase 13F: payment_links dual-varian (CHECK tepat satu target); carts/cart_items/orders/order_items terisolasi tenant; satu keranjang terbuka per kontak (unik parsial): OK",
  );
}


// ---------- 40. Fase 13G: janji temu + eksklusi anti-double-booking ----------
{
  // Seed mandiri: layanan + kontak untuk tenant A dan B.
  const SVC_13G_A = "13a00000-0000-4000-8000-0000000000a1";
  const SVC_13G_B = "13a00000-0000-4000-8000-0000000000b1";
  const CONTACT_13G_A = "13a00000-0000-4000-8000-0000000000c1";
  const CONTACT_13G_B = "13a00000-0000-4000-8000-0000000000c2";
  await db.query(
    `INSERT INTO appointment_services (id, tenant_id, name, duration_minutes)
     VALUES ($1, $2, 'Konsultasi 13G', 30)`,
    [SVC_13G_A, TENANT_A],
  );
  await db.query(
    `INSERT INTO appointment_services (id, tenant_id, name, duration_minutes)
     VALUES ($1, $2, 'Konsultasi 13G B', 30)`,
    [SVC_13G_B, TENANT_B],
  );
  await db.query(
    `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Kontak 13G A')`,
    [CONTACT_13G_A, TENANT_A],
  );
  await db.query(
    `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Kontak 13G B')`,
    [CONTACT_13G_B, TENANT_B],
  );
  await db.query(
    `INSERT INTO appointment_settings (tenant_id, timezone, min_lead_minutes)
     VALUES ($1, 'Asia/Jakarta', 120)`,
    [TENANT_A],
  );

  // CHECK ketersediaan: weekday di luar 0..6 ditolak; end <= start
  // ditolak; format jam buruk ditolak.
  await assert.rejects(
    db.query(
      `INSERT INTO appointment_availability (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 7, '09:00', '17:00')`,
      [TENANT_A],
    ),
    /check constraint|weekday/i,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO appointment_availability (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 1, '17:00', '09:00')`,
      [TENANT_A],
    ),
    /check constraint|end_after_start/i,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO appointment_availability (tenant_id, weekday, start_time, end_time)
       VALUES ($1, 1, '9:00', '17:00')`,
      [TENANT_A],
    ),
    /check constraint|start_format/i,
  );
  await db.query(
    `INSERT INTO appointment_availability (tenant_id, weekday, start_time, end_time)
     VALUES ($1, 2, '00:30', '02:00')`,
    [TENANT_A],
  );

  // Booking terkonfirmasi pertama: Selasa 2030-01-01 02:00–02:30 UTC.
  const BK_13G_1 = "13a00000-0000-4000-8000-0000000000d1";
  await db.query(
    `INSERT INTO bookings (id, tenant_id, service_id, contact_id, starts_at, ends_at, source)
     VALUES ($1, $2, $3, $4, '2030-01-01T02:00:00Z', '2030-01-01T02:30:00Z', 'flow')`,
    [BK_13G_1, TENANT_A, SVC_13G_A, CONTACT_13G_A],
  );
  // Tumpang tindih (mulai di dalam rentang) → constraint EKSKLUSI menolak.
  await assert.rejects(
    db.query(
      `INSERT INTO bookings (tenant_id, service_id, contact_id, starts_at, ends_at, source)
       VALUES ($1, $2, $3, '2030-01-01T02:15:00Z', '2030-01-01T02:45:00Z', 'dashboard')`,
      [TENANT_A, SVC_13G_A, CONTACT_13G_A],
    ),
    /bookings_no_overlap_confirmed|exclusion constraint/i,
  );
  // Bersebelahan persis (mulai == akhir booking lain) DIIZINKAN
  // (tstzrange [) tidak tumpang tindih).
  await db.query(
    `INSERT INTO bookings (tenant_id, service_id, contact_id, starts_at, ends_at, source)
     VALUES ($1, $2, $3, '2030-01-01T02:30:00Z', '2030-01-01T03:00:00Z', 'dashboard')`,
    [TENANT_A, SVC_13G_A, CONTACT_13G_A],
  );
  // Rentang yang sama untuk TENANT LAIN diizinkan (eksklusi per tenant).
  await db.query(
    `INSERT INTO bookings (tenant_id, service_id, contact_id, starts_at, ends_at, source)
     VALUES ($1, $2, $3, '2030-01-01T02:00:00Z', '2030-01-01T02:30:00Z', 'flow')`,
    [TENANT_B, SVC_13G_B, CONTACT_13G_B],
  );
  // Membatalkan booking pertama MEMBEBASKAN rentangnya (predikat
  // parsial status='confirmed'): sisip di rentang yang persis bebas
  // itu (02:00–02:30, berbatasan [) dengan booking 02:30) kini lolos.
  await db.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
    [BK_13G_1],
  );
  await db.query(
    `INSERT INTO bookings (tenant_id, service_id, contact_id, starts_at, ends_at, source)
     VALUES ($1, $2, $3, '2030-01-01T02:00:00Z', '2030-01-01T02:30:00Z', 'dashboard')`,
    [TENANT_A, SVC_13G_A, CONTACT_13G_A],
  );

  // Koneksi Google: satu baris per tenant (unik); token hanya envelope.
  await db.query(
    `INSERT INTO google_calendar_connections
       (tenant_id, account_email, calendar_id, access_token_encrypted, refresh_token_encrypted, token_expires_at)
     VALUES ($1, 'coach@example.com', 'primary', 'v1:deadbeef', 'v1:cafebabe', now() + interval '1 hour')`,
    [TENANT_A],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO google_calendar_connections
         (tenant_id, access_token_encrypted, token_expires_at)
       VALUES ($1, 'v1:lain', now() + interval '1 hour')`,
      [TENANT_A],
    ),
    /duplicate key|google_calendar_connections_tenant_unique/i,
  );

  // Isolasi RLS sebagai app_user pada kelima tabel baru.
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const aBookings = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bookings`,
    );
    const aServices = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointment_services`,
    );
    const aSettings = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointment_settings`,
    );
    const aAvail = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointment_availability`,
    );
    const aGoogle = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM google_calendar_connections`,
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const bBookings = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bookings`,
    );
    const bGoogle = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM google_calendar_connections`,
    );
    let crossBlocked = false;
    try {
      await tx.query(
        `INSERT INTO bookings (tenant_id, service_id, contact_id, starts_at, ends_at, source)
         VALUES ($1, $2, $3, '2030-02-01T02:00:00Z', '2030-02-01T02:30:00Z', 'flow')`,
        [TENANT_A, SVC_13G_A, CONTACT_13G_A],
      );
    } catch {
      crossBlocked = true;
    }
    return { aBookings, aServices, aSettings, aAvail, aGoogle, bBookings, bGoogle, crossBlocked };
  });
  // Tenant A: 3 baris booking (yang dibatalkan + bersebelahan 02:30
  // + pengisi rentang bebas 02:00–02:30).
  assert.equal(views.aBookings.rows[0].n, "3");
  assert.equal(views.aServices.rows[0].n, "1");
  assert.equal(views.aSettings.rows[0].n, "1");
  assert.equal(views.aAvail.rows[0].n, "1");
  assert.equal(views.aGoogle.rows[0].n, "1");
  assert.equal(views.bBookings.rows[0].n, "1");
  assert.equal(views.bGoogle.rows[0].n, "0");
  assert.equal(views.crossBlocked, true);
  console.log(
    "[40] Fase 13G: 5 tabel janji temu terisolasi tenant; eksklusi GiST menolak booking confirmed tumpang tindih (mengizinkan bersebelahan, tenant lain, dan sesudah batal); CHECK ketersediaan (weekday/format/end>start) + koneksi Google unik per tenant: OK",
  );
}

// ---------- 41. Fase 14A: payment_provider_configs + kolom provider tautan ----------
{
  // Kolom Fase 14A di payment_links: provider_environment NOT NULL
  // default 'sandbox', provider_ref + checkout_url nullable (hanya ada
  // bila provider sungguhan membuat sesi checkout).
  const linkCols = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_links'
        AND column_name IN ('provider_environment', 'provider_ref', 'checkout_url')`,
  );
  assert.equal(linkCols.rows[0].count, "3");
  const envCol = await db.query<{ is_nullable: string; column_default: string }>(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_links'
        AND column_name = 'provider_environment'`,
  );
  assert.equal(envCol.rows[0].is_nullable, "NO");
  assert.match(envCol.rows[0].column_default, /sandbox/);

  // Konfigurasi bawaan: satu baris per tenant (unik); provider &
  // environment tervalidasi CHECK; kolom kunci hanya envelope/null.
  await db.query(
    `INSERT INTO payment_provider_configs (tenant_id, provider, environment,
       midtrans_sandbox_server_key_encrypted)
     VALUES ($1, 'midtrans', 'sandbox', 'v1:deadbeef')`,
    [TENANT_A],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO payment_provider_configs (tenant_id) VALUES ($1)`,
      [TENANT_A],
    ),
    /duplicate key|payment_provider_configs_tenant_unique/i,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO payment_provider_configs (tenant_id, provider)
       VALUES ($1, 'paypal')`,
      [TENANT_B],
    ),
    /check constraint|provider_valid/i,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO payment_provider_configs (tenant_id, environment)
       VALUES ($1, 'staging')`,
      [TENANT_B],
    ),
    /check constraint|environment_valid/i,
  );
  await db.query(
    `INSERT INTO payment_provider_configs (tenant_id) VALUES ($1)`,
    [TENANT_B],
  );
  const defaults = await db.query<{ provider: string; environment: string }>(
    `SELECT provider, environment FROM payment_provider_configs WHERE tenant_id = $1`,
    [TENANT_B],
  );
  assert.equal(defaults.rows[0].provider, "simulation");
  assert.equal(defaults.rows[0].environment, "sandbox");

  // Isolasi RLS sebagai app_user: A melihat konfigurasinya, B hanya
  // miliknya; sisip lintas tenant ditolak WITH CHECK.
  const views = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const aRows = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payment_provider_configs`,
    );
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const bRows = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payment_provider_configs`,
    );
    let crossBlocked = false;
    try {
      await tx.query(
        `INSERT INTO payment_provider_configs (tenant_id, provider) VALUES ($1, 'xendit')`,
        [TENANT_A],
      );
    } catch {
      crossBlocked = true;
    }
    return { aRows, bRows, crossBlocked };
  });
  assert.equal(views.aRows.rows[0].n, "1");
  assert.equal(views.bRows.rows[0].n, "1");
  assert.equal(views.crossBlocked, true);
  console.log(
    "[41] Fase 14A: payment_provider_configs unik per tenant + CHECK provider/environment + default simulation/sandbox; payment_links.provider_environment NOT NULL default 'sandbox' (+ provider_ref/checkout_url); isolasi RLS konfigurasi provider: OK",
  );
}

// ---------- 38. Hotfix analisis: klaim pengiriman outbound (claimed_at) ----------
{
  // Kolom klaim ada dan nullable (NULL = belum pernah diklaim).
  const col = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'messages'
        AND column_name = 'claimed_at'`,
  );
  assert.equal(col.rows[0]?.is_nullable, "YES");

  // Seed: satu pesan outbound `queued` milik tenant A.
  const MSG = "c1a10000-0000-4000-8000-0000000000c1";
  await db.query(
    `INSERT INTO messages (id, tenant_id, conversation_id, direction, sender_type, type, content_text, status)
     VALUES ($1, $2, $3, 'outbound', 'user', 'text', 'Klaim uji', 'queued')`,
    [MSG, TENANT_A, CONV_A],
  );

  // Syarat klaim yang sama persis dengan claimOutboundMessage di core.
  const claimSql = `UPDATE messages SET claimed_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'queued'
       AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
     RETURNING id`;

  // Klaim pertama menang; klaim kedua atas baris yang sama KALAH — inilah
  // yang mencegah dua replica API mengirim pesan yang sama.
  const first = await db.query(claimSql, [MSG, TENANT_A]);
  const second = await db.query(claimSql, [MSG, TENANT_A]);
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 0);

  // Klaim basi (pengirim mati di tengah jalan) boleh diambil alih.
  await db.query(
    `UPDATE messages SET claimed_at = now() - interval '5 minutes' WHERE id = $1`,
    [MSG],
  );
  const reclaimed = await db.query(claimSql, [MSG, TENANT_A]);
  assert.equal(reclaimed.rows.length, 1);

  // Status TETAP `queued` selama klaim → jalur penandaan sent yang sudah
  // ada (WHERE status = 'queued') tetap bekerja tanpa perubahan.
  const sent = await db.query(
    `UPDATE messages SET status = 'sent' WHERE id = $1 AND status = 'queued' RETURNING id`,
    [MSG],
  );
  assert.equal(sent.rows.length, 1);

  // Tenant lain tidak bisa mengklaim pesan tenant A (RLS).
  const cross = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    return tx.query(
      `UPDATE messages SET claimed_at = now() WHERE id = $1 RETURNING id`,
      [MSG],
    );
  });
  assert.equal(cross.rows.length, 0);
  console.log(
    "[42] Hotfix analisis: messages.claimed_at ada; klaim atomik hanya satu pemenang, klaim basi boleh diambil alih, status tetap queued (penandaan sent tetap jalan), tenant lain tidak bisa mengklaim: OK",
  );
}

// ---------- 43. Lengan WABA (event webhook tingkat WABA) ----------
// Migrasi 0004: `message_template_status_update` hanya membawa WABA id,
// tanpa phone_number_id, sehingga akun harus dicari lewat
// parent_external_id. Cakupan lengan ini harus tetap sempit — tanpa
// setting tidak ada baris, WABA lain tidak terbuka, dan provider lain
// yang kebetulan berinduk sama tidak ikut terbuka.
const WABA_COL = await db.query(
  `SELECT 1 FROM information_schema.columns
   WHERE table_name = 'whatsapp_templates' AND column_name = 'status_reason'`,
);
assert.equal(WABA_COL.rows.length, 1);

await db.query(
  `INSERT INTO channel_accounts (tenant_id, provider, external_id, parent_external_id, status)
   VALUES ($1, 'whatsapp', 'waba-phone-a', 'waba-001', 'connected'),
          ($2, 'whatsapp', 'waba-phone-b', 'waba-002', 'connected'),
          ($1, 'telegram', 'waba-bot-a', 'waba-001', 'connected')`,
  [TENANT_A, TENANT_B],
);
const wabaSeen = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  const noCtx = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM channel_accounts`,
  );
  await tx.query(`SELECT set_config('app.whatsapp_waba_id', 'waba-001', true)`);
  const match = await tx.query<{ external_id: string }>(
    `SELECT external_id FROM channel_accounts`,
  );
  await tx.query(`SELECT set_config('app.whatsapp_waba_id', 'waba-tidak-ada', true)`);
  const none = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM channel_accounts`,
  );
  return { noCtx, match, none };
});
assert.equal(wabaSeen.noCtx.rows[0].n, "0");
// Hanya akun WhatsApp milik WABA itu — bot Telegram berinduk sama TIDAK ikut.
assert.deepEqual(
  wabaSeen.match.rows.map((r) => r.external_id),
  ["waba-phone-a"],
);
assert.equal(wabaSeen.none.rows[0].n, "0");
console.log(
  "[43] Fase 10B: kolom whatsapp_templates.status_reason ada; lengan whatsapp_waba_lookup hanya membuka akun WhatsApp milik WABA yang di-set (fail-closed, provider lain tidak ikut): OK",
);

// ---------- 44. Outbox: hitungan percobaan + karantina (Fase 16D) ----------
// Migrasi 0005. Yang dijaga di sini adalah BENTUK skema: relay memakai
// `attempts` untuk berhenti mengulang dan `dead_lettered_at` untuk
// mengeluarkan event rusak dari pemindaian tanpa mengakuinya published.
// Perilaku relay-nya sendiri diuji di packages/core/src/outbox.test.ts.
const OUTBOX_COLS = await db.query<{ column_name: string; column_default: string | null }>(
  `SELECT column_name, column_default FROM information_schema.columns
    WHERE table_name = 'outbox_events'
      AND column_name IN ('attempts', 'last_error', 'dead_lettered_at')
    ORDER BY column_name`,
);
assert.deepEqual(
  OUTBOX_COLS.rows.map((r) => r.column_name),
  ["attempts", "dead_lettered_at", "last_error"],
);
// Default 0 penting: baris lama (yang ditulis sebelum migrasi) harus
// dianggap belum pernah gagal, bukan NULL yang membuat perbandingan
// `attempts >= batas` menjadi false selamanya.
assert.ok(OUTBOX_COLS.rows[0]!.column_default?.includes("0"));

const OUTBOX_IDX = await db.query(
  `SELECT 1 FROM pg_indexes
    WHERE tablename = 'outbox_events' AND indexname = 'outbox_events_pending_idx'`,
);
assert.equal(OUTBOX_IDX.rows.length, 1);

const outboxDefaults = await db.query<{
  attempts: number;
  last_error: string | null;
  dead_lettered_at: Date | null;
}>(
  `INSERT INTO outbox_events (tenant_id, type, payload)
   VALUES ($1, 'verify.outbox', '{}'::jsonb)
   RETURNING attempts, last_error, dead_lettered_at`,
  [TENANT_A],
);
assert.equal(Number(outboxDefaults.rows[0]!.attempts), 0);
assert.equal(outboxDefaults.rows[0]!.last_error, null);
assert.equal(outboxDefaults.rows[0]!.dead_lettered_at, null);
console.log(
  "[44] Fase 16D: kolom outbox_events.attempts (default 0)/last_error/dead_lettered_at ada + index parsial outbox_events_pending_idx terpasang: OK",
);

// ---------- 45. Media masuk: referensi provider + pindai ingest (Fase 18) ----------
// Migrasi 0006. Yang dijaga BENTUK skema dan AKSESNYA: ingest media
// berjalan di worker dengan pindai lintas tenant (policy
// meta_delivery_scan), sementara isolasi tenant tetap utuh untuk semua
// pembacaan biasa. Perilaku ingest-nya diuji di
// packages/core/src/media-ingest.test.ts.
const MEDIA_COLS = await db.query<{ column_name: string; column_default: string | null }>(
  `SELECT column_name, column_default FROM information_schema.columns
    WHERE table_name = 'messages'
      AND column_name IN (
        'provider_media_id', 'provider_media_mime',
        'provider_media_file_name', 'media_ingest_attempts', 'media_ingest_error',
        'media_ingest_attempted_at'
      )
    ORDER BY column_name`,
);
assert.deepEqual(
  MEDIA_COLS.rows.map((r) => r.column_name),
  [
    "media_ingest_attempted_at",
    "media_ingest_attempts",
    "media_ingest_error",
    "provider_media_file_name",
    "provider_media_id",
    "provider_media_mime",
  ],
);
// Default 0 penting: baris lama dianggap belum pernah dicoba, bukan NULL
// yang membuat `attempts < batas` selalu false (media tidak pernah dicoba).
const attemptsDefault = MEDIA_COLS.rows.find(
  (r) => r.column_name === "media_ingest_attempts",
);
assert.ok(attemptsDefault?.column_default?.includes("0"));

const MEDIA_IDX = await db.query(
  `SELECT 1 FROM pg_indexes
    WHERE tablename = 'messages' AND indexname = 'messages_pending_media_idx'`,
);
assert.equal(MEDIA_IDX.rows.length, 1);

const MEDIA_CONV = "7a000000-0000-4000-8000-000000000045";
const MEDIA_MSG = "7b000000-0000-4000-8000-000000000045";
await db.query(
  `INSERT INTO conversations (id, tenant_id, channel_account_id, contact_id, provider)
   VALUES ($1, $2, $3, $4, 'webchat')`,
  [MEDIA_CONV, TENANT_A, chanA.rows[0].id, CONTACT_A],
);
await db.query(
  `INSERT INTO messages
     (id, tenant_id, conversation_id, direction, sender_type, type, content_text,
      provider_media_id, provider_media_mime, provider_media_file_name, status)
   VALUES ($1, $2, $3, 'inbound', 'contact', 'image', 'foto rusak',
           'media-verif', 'image/jpeg', 'foto.jpg', 'received')`,
  [MEDIA_MSG, TENANT_A, MEDIA_CONV],
);

const mediaScan = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  // Tanpa konteks apa pun: tertutup sepenuhnya.
  const noCtx = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE provider_media_id = 'media-verif'`,
  );
  // Konteks tenant B: baris milik A tidak boleh terlihat.
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
  const otherTenant = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE provider_media_id = 'media-verif'`,
  );
  // Konteks pemilik: terlihat.
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
  const owner = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE provider_media_id = 'media-verif'`,
  );
  // Lengan pindai ingest: worker melihat baris ini lintas tenant.
  await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
  await tx.query(`SELECT set_config('app.system_delivery', 'whatsapp', true)`);
  const relay = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE provider_media_id = 'media-verif'`,
  );
  return { noCtx, otherTenant, owner, relay };
});
assert.equal(mediaScan.noCtx.rows[0].n, "0");
assert.equal(mediaScan.otherTenant.rows[0].n, "0");
assert.equal(mediaScan.owner.rows[0].n, "1");
// Inti Fase 18: tanpa lengan ini, worker tidak akan pernah melihat media
// yang menunggu diunduh — berkasnya hilang tanpa satu pun error.
assert.equal(mediaScan.relay.rows[0].n, "1");
console.log(
  "[45] Fase 18: kolom media masuk (provider_media_id/mime/file_name + media_ingest_attempts default 0) ada, index parsial messages_pending_media_idx terpasang; isolasi tenant utuh dan lengan pindai ingest membuka tepat baris yang menunggu: OK",
);

// ---------------------------------------------------------------------------
// [46] Fase 19: lengan pindai GC media — MEMBACA lintas tenant, TIDAK
// menghapus lintas tenant.
//
// Dua sifat yang harus terbukti bersamaan. Tanpa lengan ini worker tidak
// bisa menemukan baris media tenant lain (media tanpa berkas, media tak
// dirujuk, retensi) — semuanya mustahil dideteksi. Tetapi kalau lengannya
// ikut memberi hak hapus, satu bug di jalur GC bisa menghapus media
// seluruh tenant sekaligus. Karena itu policy-nya SELECT saja dan
// penghapusan tetap terjadi di konteks tenant masing-masing.
// ---------------------------------------------------------------------------
const GC_MEDIA_A = "7c000000-0000-4000-8000-000000000046";
await db.query(
  `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes)
   VALUES ($1, $2, 'tenants/uji/media/2026-11/gc.jpg', 'gc.jpg', 'image/jpeg', 10)`,
  [GC_MEDIA_A, TENANT_A],
);

const gcScan = await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  // Tanpa konteks: tertutup.
  const noCtx = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM media WHERE id = $1`,
    [GC_MEDIA_A],
  );
  // Konteks tenant B: baris milik A tidak terlihat.
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
  const otherTenant = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM media WHERE id = $1`,
    [GC_MEDIA_A],
  );
  // Lengan GC: terlihat lintas tenant.
  await tx.query(`SELECT set_config('app.tenant_id', '', true)`);
  await tx.query(`SELECT set_config('app.system_media_gc', 'on', true)`);
  const arm = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM media WHERE id = $1`,
    [GC_MEDIA_A],
  );
  // Lengan yang sama TIDAK boleh memberi hak hapus lintas tenant.
  await tx.query(`DELETE FROM media WHERE id = $1`, [GC_MEDIA_A]);
  return { noCtx, otherTenant, arm };
});
assert.equal(gcScan.noCtx.rows[0].n, "0");
assert.equal(gcScan.otherTenant.rows[0].n, "0");
assert.equal(gcScan.arm.rows[0].n, "1");
const gcSurvived = await db.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM media WHERE id = $1`,
  [GC_MEDIA_A],
);
assert.equal(gcSurvived.rows[0].n, "1");
await db.query(`DELETE FROM media WHERE id = $1`, [GC_MEDIA_A]);
console.log(
  "[46] Fase 19: lengan system_media_gc_scan membuka media lintas tenant untuk GC, tetapi TIDAK memberi hak hapus lintas tenant (penghapusan tetap di konteks tenant): OK",
);

// ---------------------------------------------------------------------------
// [47] Fase 20: retensi outbox_events — index parsial terpasang, dan lengan
// relay mengizinkan penghapusan lintas tenant TANPA menyentuh event yang
// belum terbit.
//
// Sebelum Fase 20 tabel ini tidak pernah dihapus sama sekali. Yang dijaga di
// sini: penghapusan berjalan lewat lengan yang sudah ada (`system_relay`),
// dan predikatnya berbasis `published_at`/`dead_lettered_at` sehingga event
// yang belum terbit — pekerjaan yang belum selesai — tidak mungkin ikut
// terbuang.
// ---------------------------------------------------------------------------
const OUTBOX_DEAD_IDX = await db.query(
  `SELECT 1 FROM pg_indexes
    WHERE tablename = 'outbox_events'
      AND indexname = 'outbox_events_dead_letter_idx'`,
);
assert.equal(OUTBOX_DEAD_IDX.rows.length, 1);

const OB_PUBLISHED = "7d000000-0000-4000-8000-000000000047";
const OB_DEAD = "7d100000-0000-4000-8000-000000000047";
const OB_PENDING = "7d200000-0000-4000-8000-000000000047";
await db.query(
  `INSERT INTO outbox_events (id, tenant_id, type, payload, created_at, published_at, dead_lettered_at)
   VALUES
     ($1, $4, 'message.sent', '{}'::jsonb, now() - interval '10 days', now() - interval '10 days', NULL),
     ($2, $4, 'message.sent', '{}'::jsonb, now() - interval '40 days', NULL, now() - interval '40 days'),
     ($3, $4, 'message.sent', '{}'::jsonb, now() - interval '60 days', NULL, NULL)`,
  [OB_PUBLISHED, OB_DEAD, OB_PENDING, TENANT_A],
);

await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL ROLE app_user`);
  await tx.query(`SELECT set_config('app.system_relay', 'outbox', true)`);
  // Dua predikat yang sama dengan `pruneOutboxEvents` di core.
  await tx.query(
    `DELETE FROM outbox_events
      WHERE published_at IS NOT NULL AND dead_lettered_at IS NULL
        AND published_at < now() - interval '7 days'`,
  );
  await tx.query(
    `DELETE FROM outbox_events
      WHERE dead_lettered_at IS NOT NULL
        AND dead_lettered_at < now() - interval '30 days'`,
  );
});

const outboxGcLeft = await db.query<{ id: string }>(
  `SELECT id FROM outbox_events WHERE id = ANY($1::uuid[]) ORDER BY id`,
  [[OB_PUBLISHED, OB_DEAD, OB_PENDING]],
);
assert.deepEqual(
  outboxGcLeft.rows.map((r) => r.id),
  [OB_PENDING],
);
await db.query(`DELETE FROM outbox_events WHERE id = $1`, [OB_PENDING]);
console.log(
  "[47] Fase 20: index parsial outbox_events_dead_letter_idx terpasang; lengan system_relay menghapus baris terbit & dead-letter yang lewat retensi, dan event yang belum terbit TIDAK tersentuh: OK",
);

await db.close();
console.log("db verify (PGlite): SEMUA LULUS");
