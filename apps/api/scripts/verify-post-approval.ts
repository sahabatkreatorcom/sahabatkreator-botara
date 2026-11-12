/**
 * Verifikasi Fase Susulan S1 — ALUR PERSETUJUAN POSTINGAN, di atas
 * PGlite. Dijalankan di CI sebagai bagian `verify:ci`.
 *
 * Membuktikan:
 *   [1] pengaturan: bawaan OFF; baca oleh member biasa 200; PATCH
 *       oleh agent → 403; PATCH owner → 200 dan terbaca kembali.
 *   [2] sakelar OFF: perilaku lama utuh — postingan terjadwal lolos
 *       gerbang (blockUnapprovedPostPublish tidak menghalangi) dan
 *       klaim penerbit berhasil seperti sebelum S1.
 *   [3] sakelar ON + belum disetujui: gerbang MEMBLOKIR pada jam
 *       tayang — post menjadi failed berkode persis
 *       `post_approval_required`, audit system tercatat dan terbaca
 *       lewat riwayat, klaim penerbit tidak lagi mungkin.
 *   [4] alur penuh: buat → ajukan → setujui peninjau lain → jadwal →
 *       gerbang lolos → klaim berhasil. Pembuat yang mencoba menyetujui
 *       postingannya sendiri saat ada admin lain → 403
 *       POST_APPROVAL_SELF_REVIEW.
 *   [5] tolak: tanpa catatan ditolak (HTTP 400; core 422
 *       POST_APPROVAL_NOTE_REQUIRED); dengan catatan → status
 *       rejected dan catatan tampil pada postingan ke pembuat.
 *   [6] minta revisi: postingan terjadwal diturunkan kembali ke
 *       draft (jam tayang bersih); menyunting isi post yang pernah
 *       disetujui mengatur ulang persetujuannya ke draft.
 *   [7] transisi liar: setujui tanpa ajukan → 409; ajukan dua kali →
 *       409; tolak post yang sudah disetujui → 409.
 *   [8] tenant solo: pemilik tunggal BOLEH menyetujui postingannya
 *       sendiri (tidak ada penyetuju lain) — tenant tidak terkunci.
 *   [9] grup multi-target: satu pengajuan + satu keputusan berlaku
 *       untuk SEMUA anggota; penolakan menurunkan jadwal semua
 *       anggota.
 *   [10] isolasi tenant: postingan tenant lain → 404 di semua jalur
 *       persetujuan; daftar tenant asing → 404 TENANT_NOT_FOUND.
 *   [11] riwayat keputusan dari audit: urutan diajukan → disetujui
 *       terbaca lewat endpoint riwayat dengan label pelaku.
 *   [12] persetujuan terlambat: post yang terlanjur terblokir TIDAK
 *       terbit otomatis sesudah disetujui — pembuat menjadwalkan
 *       ulang (retry) dan gerbang kemudian lolos.
 *   [13] antrean tinjauan: saringan ?approvalStatus=pending_review
 *       hanya mengembalikan postingan yang menunggu keputusan.
 *
 * Jalankan: pnpm --filter @sahabat-kreator/api verify:post-approval
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
  PostDomainError,
  blockUnapprovedPostPublish,
  claimPostForPublish,
  rejectPost,
} from "@sahabat-kreator/core";
import type { PostResponse } from "@sahabat-kreator/contracts";
import type { AuthBundle } from "../src/auth";
import type { AppVariables } from "../src/http";
import { createPostsRoutes } from "../src/modules/posts/routes";

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
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

await client.query(
  `INSERT INTO plans (id, code, name, limits) VALUES ('99999999-9999-4999-8999-999999999999', 'test', 'Test', '{}'::jsonb)`,
);
await client.query(
  `INSERT INTO tenants (id, name, slug, default_locale) VALUES ($1, 'Tenant A', 'tenant-a', 'id'), ($2, 'Tenant B', 'tenant-b', 'id')`,
  [TENANT_A, TENANT_B],
);
await client.query(
  `INSERT INTO users (id, email, name) VALUES
   ($1, 'owner-a@sk.test', 'Pemilik A'),
   ($2, 'admin-a@sk.test', 'Admin A'),
   ($3, 'agent-a@sk.test', 'Agen A'),
   ($4, 'owner-b@sk.test', 'Pemilik B')`,
  [OWNER_A, ADMIN_A, AGENT_A, OWNER_B],
);
await client.query(
  `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
   ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'agent'), ($5, $6, 'owner')`,
  [TENANT_A, OWNER_A, ADMIN_A, AGENT_A, TENANT_B, OWNER_B],
);

// Sasaran linimasa: akun Telegram terhubung + percakapan channel.
// Tenant A punya DUA channel (untuk grup multi-target), B satu.
async function seedChannel(
  tenantId: string,
  suffix: string,
  chatId: string,
): Promise<string> {
  const account = await client.query<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, provider, external_id, display_name, status)
     VALUES ($1, 'telegram', $2, 'Bot Uji', 'connected') RETURNING id`,
    [tenantId, `bot-${suffix}`],
  );
  const contact = await client.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `Channel ${suffix}`],
  );
  const conversation = await client.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind, status)
     VALUES ($1, $2, $3, 'telegram', $4, $5, 'channel', 'open') RETURNING id`,
    [tenantId, account.rows[0]!.id, contact.rows[0]!.id, chatId, `Channel ${suffix}`],
  );
  return conversation.rows[0]!.id;
}
const CONV_A1 = await seedChannel(TENANT_A, "a1", "-100111");
const CONV_A2 = await seedChannel(TENANT_A, "a2", "-100222");
const CONV_B1 = await seedChannel(TENANT_B, "b1", "-100333");

// ---------------------------------------------------------------------------
// Aplikasi uji: modul posts sungguhan + appUser dari header uji
// ---------------------------------------------------------------------------
const app = new Hono<{ Variables: AppVariables }>();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user") ?? OWNER_A;
  c.set("appUser", { id: userId } as unknown as AppVariables["appUser"]);
  await next();
});
const bundle = { db } as unknown as AuthBundle;
app.route("/", createPostsRoutes(bundle));

async function call(
  method: string,
  url: string,
  user = OWNER_A,
  body?: unknown,
): Promise<{ status: number; body: Record<string, never> }> {
  const res = await app.request(url, {
    method,
    headers: {
      "x-test-user": user,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, never>,
  };
}

const postsUrl = (tenantId: string) => `/tenants/${tenantId}/posts`;
const postUrl = (tenantId: string, postId: string) =>
  `/tenants/${tenantId}/posts/${postId}`;

async function createPost(
  tenantId: string,
  conversationId: string,
  user: string,
  title: string,
): Promise<PostResponse> {
  const r = await call("POST", postsUrl(tenantId), user, {
    conversationId,
    title,
    caption: `Isi ${title}`,
    mediaIds: [],
  });
  assert.equal(r.status, 201, `buat post ${title}`);
  return r.body as unknown as PostResponse;
}

async function getPost(
  tenantId: string,
  postId: string,
  user: string,
): Promise<PostResponse> {
  const r = await call("GET", postUrl(tenantId, postId), user);
  assert.equal(r.status, 200, "baca post");
  return r.body as unknown as PostResponse;
}

async function scheduleNow(
  tenantId: string,
  postId: string,
  user: string,
): Promise<PostResponse> {
  const r = await call("POST", `${postUrl(tenantId, postId)}/schedule`, user, {});
  assert.equal(r.status, 200, "jadwalkan post");
  return r.body as unknown as PostResponse;
}

const errCode = (body: Record<string, never>) =>
  (body as { error?: { code?: string } }).error?.code;

// --- [1] pengaturan -------------------------------------------------------------
{
  let r = await call("GET", `${postsUrl(TENANT_A)}/settings`, AGENT_A);
  assert.equal(r.status, 200);
  assert.equal(
    (r.body as unknown as { approvalRequired: boolean }).approvalRequired,
    false,
    "bawaan sakelar = nonaktif",
  );

  r = await call("PATCH", `${postsUrl(TENANT_A)}/settings`, AGENT_A, {
    approvalRequired: true,
  });
  assert.equal(r.status, 403, "agent tidak boleh mengubah sakelar");

  r = await call("PATCH", `${postsUrl(TENANT_A)}/settings`, OWNER_A, {
    approvalRequired: true,
  });
  assert.equal(r.status, 200);
  assert.equal(
    (r.body as unknown as { approvalRequired: boolean }).approvalRequired,
    true,
  );
  r = await call("GET", `${postsUrl(TENANT_A)}/settings`, OWNER_A);
  assert.equal(
    (r.body as unknown as { approvalRequired: boolean }).approvalRequired,
    true,
    "sakelar terbaca kembali aktif",
  );
  console.log("[1] pengaturan sakelar persetujuan: OK");
}

// --- [2] sakelar OFF: perilaku lama utuh (tenant B) ------------------------------
{
  const post = await createPost(TENANT_B, CONV_B1, OWNER_B, "B tanpa gerbang");
  assert.equal(post.approvalStatus, "draft");
  const scheduled = await scheduleNow(TENANT_B, post.id, OWNER_B);
  assert.ok(scheduled.scheduledAt);
  const gate = await blockUnapprovedPostPublish(db, {
    tenantId: TENANT_B,
    postId: post.id,
    expectedScheduledAt: new Date(scheduled.scheduledAt!),
  });
  assert.equal(gate.blocked, false, "sakelar mati → gerbang tidak menghalangi");
  const claim = await claimPostForPublish(db, {
    tenantId: TENANT_B,
    postId: post.id,
    expectedScheduledAt: new Date(scheduled.scheduledAt!),
  });
  assert.equal(claim.kind, "claimed");
  console.log("[2] sakelar OFF — perilaku lama utuh: OK");
}

// --- [3] sakelar ON + belum disetujui → terblokir tercatat -----------------------
{
  const post = await createPost(TENANT_A, CONV_A1, OWNER_A, "A belum disetujui");
  const scheduled = await scheduleNow(TENANT_A, post.id, OWNER_A);
  const gate = await blockUnapprovedPostPublish(db, {
    tenantId: TENANT_A,
    postId: post.id,
    expectedScheduledAt: new Date(scheduled.scheduledAt!),
  });
  assert.equal(gate.blocked, true, "gerbang menghalangi post belum disetujui");
  const after = await getPost(TENANT_A, post.id, OWNER_A);
  assert.equal(after.status, "failed");
  assert.equal(after.errorCode, "post_approval_required");
  const claim = await claimPostForPublish(db, {
    tenantId: TENANT_A,
    postId: post.id,
    expectedScheduledAt: new Date(scheduled.scheduledAt!),
  });
  assert.equal(claim.kind, "skipped", "klaim penerbit tidak lagi mungkin");
  const history = await call(
    "GET",
    `${postUrl(TENANT_A, post.id)}/approval-history`,
    OWNER_A,
  );
  assert.equal(history.status, 200);
  const items = (
    history.body as unknown as {
      items: Array<{ action: string; actorType: string }>;
    }
  ).items;
  assert.ok(
    items.some(
      (item) =>
        item.action === "post.publish_blocked_approval" &&
        item.actorType === "system",
    ),
    "pemblokiran tercatat di audit sebagai aksi system",
  );
  console.log("[3] gerbang memblokir + alasan tercatat: OK");
}

// --- [4] alur penuh + anti-setuju-sendiri ------------------------------------------
let approvedPostId = "";
{
  const post = await createPost(TENANT_A, CONV_A1, OWNER_A, "A alur penuh");
  approvedPostId = post.id;

  let r = await call("POST", `${postUrl(TENANT_A, post.id)}/submit-review`, OWNER_A, {});
  assert.equal(r.status, 200);
  assert.equal((r.body as unknown as PostResponse).approvalStatus, "pending_review");
  assert.equal(
    (r.body as unknown as PostResponse).approvalSubmittedByUserId,
    OWNER_A,
  );

  // Pembuat menyetujui sendiri padahal ADMIN_A tersedia → 403.
  r = await call("POST", `${postUrl(TENANT_A, post.id)}/approve`, OWNER_A, {});
  assert.equal(r.status, 403);
  assert.equal(errCode(r.body), "POST_APPROVAL_SELF_REVIEW");

  r = await call("POST", `${postUrl(TENANT_A, post.id)}/approve`, ADMIN_A, {});
  assert.equal(r.status, 200);
  const approved = r.body as unknown as PostResponse;
  assert.equal(approved.approvalStatus, "approved");
  assert.equal(approved.approvalReviewedByUserId, ADMIN_A);

  const scheduled = await scheduleNow(TENANT_A, post.id, OWNER_A);
  const gate = await blockUnapprovedPostPublish(db, {
    tenantId: TENANT_A,
    postId: post.id,
    expectedScheduledAt: new Date(scheduled.scheduledAt!),
  });
  assert.equal(gate.blocked, false, "sudah disetujui → gerbang lolos");
  const claim = await claimPostForPublish(db, {
    tenantId: TENANT_A,
    postId: post.id,
    expectedScheduledAt: new Date(scheduled.scheduledAt!),
  });
  assert.equal(claim.kind, "claimed");
  console.log("[4] alur penuh + anti-setuju-sendiri: OK");
}

// --- [5] tolak: catatan wajib + tampil ke pembuat -----------------------------------
{
  const post = await createPost(TENANT_A, CONV_A1, OWNER_A, "A ditolak");
  await call("POST", `${postUrl(TENANT_A, post.id)}/submit-review`, OWNER_A, {});

  let r = await call("POST", `${postUrl(TENANT_A, post.id)}/reject`, ADMIN_A, {});
  assert.equal(r.status, 400, "tolak tanpa catatan ditolak skema");

  // Lapisan core menegakkan hal yang sama untuk jalur non-HTTP.
  await assert.rejects(
    rejectPost(db, {
      tenantId: TENANT_A,
      userId: ADMIN_A,
      postId: post.id,
      note: "   ",
    }),
    (err: unknown) =>
      err instanceof PostDomainError &&
      err.code === "POST_APPROVAL_NOTE_REQUIRED",
  );

  r = await call("POST", `${postUrl(TENANT_A, post.id)}/reject`, ADMIN_A, {
    note: "Caption menyesatkan, perbaiki klaimnya.",
  });
  assert.equal(r.status, 200);
  const rejected = r.body as unknown as PostResponse;
  assert.equal(rejected.approvalStatus, "rejected");
  assert.equal(rejected.approvalNote, "Caption menyesatkan, perbaiki klaimnya.");
  const readBack = await getPost(TENANT_A, post.id, OWNER_A);
  assert.equal(
    readBack.approvalNote,
    "Caption menyesatkan, perbaiki klaimnya.",
    "catatan penolakan tampil ke pembuat",
  );
  console.log("[5] tolak + catatan wajib: OK");
}

// --- [6] minta revisi menurunkan jadwal + edit mengatur ulang persetujuan ------------
{
  const post = await createPost(TENANT_A, CONV_A1, OWNER_A, "A minta revisi");
  const scheduled = await scheduleNow(TENANT_A, post.id, OWNER_A);
  assert.equal(scheduled.status, "scheduled");
  await call("POST", `${postUrl(TENANT_A, post.id)}/submit-review`, OWNER_A, {});
  const r = await call(
    "POST",
    `${postUrl(TENANT_A, post.id)}/request-changes`,
    ADMIN_A,
    { note: "Tambahkan harga di caption." },
  );
  assert.equal(r.status, 200);
  const changed = r.body as unknown as PostResponse;
  assert.equal(changed.approvalStatus, "changes_requested");
  assert.equal(changed.status, "draft", "yang terjadwal diturunkan ke draft");
  assert.equal(changed.scheduledAt, null, "jam tayang dibersihkan");

  // Post lain yang SUDAH disetujui: menyunting isinya membatalkan
  // persetujuan (yang disetujui harus sama dengan yang terbit).
  const post2 = await createPost(TENANT_A, CONV_A1, OWNER_A, "A edit sesudah setuju");
  await call("POST", `${postUrl(TENANT_A, post2.id)}/submit-review`, OWNER_A, {});
  await call("POST", `${postUrl(TENANT_A, post2.id)}/approve`, ADMIN_A, {});
  const edited = await call("PATCH", postUrl(TENANT_A, post2.id), OWNER_A, {
    caption: "Caption yang sama sekali baru",
  });
  assert.equal(edited.status, 200);
  assert.equal(
    (edited.body as unknown as PostResponse).approvalStatus,
    "draft",
    "edit isi mengatur ulang persetujuan ke draft",
  );
  console.log("[6] minta revisi + reset oleh edit: OK");
}

// --- [7] transisi liar -----------------------------------------------------------------
{
  const post = await createPost(TENANT_A, CONV_A1, OWNER_A, "A transisi liar");
  let r = await call("POST", `${postUrl(TENANT_A, post.id)}/approve`, ADMIN_A, {});
  assert.equal(r.status, 409, "setujui tanpa ajukan");
  assert.equal(errCode(r.body), "POST_APPROVAL_INVALID_STATE");

  r = await call("POST", `${postUrl(TENANT_A, post.id)}/submit-review`, OWNER_A, {});
  assert.equal(r.status, 200);
  r = await call("POST", `${postUrl(TENANT_A, post.id)}/submit-review`, OWNER_A, {});
  assert.equal(r.status, 409, "ajukan dua kali");
  assert.equal(errCode(r.body), "POST_APPROVAL_INVALID_STATE");

  r = await call("POST", `${postUrl(TENANT_A, post.id)}/approve`, ADMIN_A, {});
  assert.equal(r.status, 200);
  r = await call("POST", `${postUrl(TENANT_A, post.id)}/reject`, ADMIN_A, {
    note: "terlambat",
  });
  assert.equal(r.status, 409, "tolak sesudah disetujui");
  console.log("[7] transisi liar ditolak: OK");
}

// --- [8] tenant solo: setuju sendiri diizinkan ------------------------------------------
{
  let r = await call("PATCH", `${postsUrl(TENANT_B)}/settings`, OWNER_B, {
    approvalRequired: true,
  });
  assert.equal(r.status, 200);
  const post = await createPost(TENANT_B, CONV_B1, OWNER_B, "B solo");
  r = await call("POST", `${postUrl(TENANT_B, post.id)}/submit-review`, OWNER_B, {});
  assert.equal(r.status, 200);
  r = await call("POST", `${postUrl(TENANT_B, post.id)}/approve`, OWNER_B, {});
  assert.equal(r.status, 200, "pemilik tunggal boleh menyetujui sendiri");
  assert.equal((r.body as unknown as PostResponse).approvalStatus, "approved");
  const scheduled = await scheduleNow(TENANT_B, post.id, OWNER_B);
  const gate = await blockUnapprovedPostPublish(db, {
    tenantId: TENANT_B,
    postId: post.id,
    expectedScheduledAt: new Date(scheduled.scheduledAt!),
  });
  assert.equal(gate.blocked, false);
  console.log("[8] tenant solo tidak terkunci: OK");
}

// --- [9] grup multi-target: satu keputusan untuk semua anggota ---------------------------
{
  const created = await call("POST", `${postsUrl(TENANT_A)}/group`, OWNER_A, {
    title: "Grup S1",
    caption: "Konten grup",
    mediaIds: [],
    targets: [{ conversationId: CONV_A1 }, { conversationId: CONV_A2 }],
  });
  assert.equal(created.status, 201);
  const group = created.body as unknown as {
    groupId: string;
    items: PostResponse[];
  };
  assert.equal(group.items.length, 2);
  const [m1, m2] = group.items as [PostResponse, PostResponse];

  // Jadwalkan keduanya, ajukan lewat anggota pertama.
  await scheduleNow(TENANT_A, m1.id, OWNER_A);
  await scheduleNow(TENANT_A, m2.id, OWNER_A);
  let r = await call("POST", `${postUrl(TENANT_A, m1.id)}/submit-review`, OWNER_A, {});
  assert.equal(r.status, 200);
  const other = await getPost(TENANT_A, m2.id, OWNER_A);
  assert.equal(
    other.approvalStatus,
    "pending_review",
    "pengajuan berlaku ke seluruh grup",
  );

  // Tolak lewat anggota kedua → keduanya tertolak + jadwal turun.
  r = await call("POST", `${postUrl(TENANT_A, m2.id)}/reject`, ADMIN_A, {
    note: "Visual grup belum final.",
  });
  assert.equal(r.status, 200);
  const first = await getPost(TENANT_A, m1.id, OWNER_A);
  assert.equal(first.approvalStatus, "rejected");
  assert.equal(first.status, "draft", "jadwal anggota lain ikut turun");
  assert.equal(first.approvalNote, "Visual grup belum final.");

  // Ajukan lagi + setujui → keduanya approved.
  await call("POST", `${postUrl(TENANT_A, m1.id)}/submit-review`, OWNER_A, {});
  r = await call("POST", `${postUrl(TENANT_A, m1.id)}/approve`, ADMIN_A, {});
  assert.equal(r.status, 200);
  const second = await getPost(TENANT_A, m2.id, OWNER_A);
  assert.equal(second.approvalStatus, "approved");
  console.log("[9] grup multi-target satu keputusan: OK");
}

// --- [10] isolasi tenant ------------------------------------------------------------------
{
  // Post tenant A dibaca/ditinjau lewat jalur tenant B → 404.
  let r = await call("GET", postUrl(TENANT_B, approvedPostId), OWNER_B);
  assert.equal(r.status, 404);
  r = await call("POST", `${postUrl(TENANT_B, approvedPostId)}/approve`, OWNER_B, {});
  assert.equal(r.status, 404);
  // User tenant B membuka daftar tenant A → bukan member → 404.
  r = await call("GET", postsUrl(TENANT_A), OWNER_B);
  assert.equal(r.status, 404);
  assert.equal(errCode(r.body), "TENANT_NOT_FOUND");
  console.log("[10] isolasi tenant: OK");
}

// --- [11] riwayat keputusan dari audit ------------------------------------------------------
{
  const r = await call(
    "GET",
    `${postUrl(TENANT_A, approvedPostId)}/approval-history`,
    AGENT_A,
  );
  assert.equal(r.status, 200, "member biasa boleh membaca riwayat");
  const items = (
    r.body as unknown as {
      items: Array<{
        action: string;
        actorType: string;
        actorLabel: string | null;
      }>;
    }
  ).items;
  const actions = items.map((item) => item.action);
  assert.deepEqual(actions, [
    "post.approval_approved",
    "post.approval_submitted",
  ]);
  assert.equal(items[0]!.actorLabel, "Admin A", "label peninjau ter-resolve");
  assert.equal(items[1]!.actorLabel, "Pemilik A");
  console.log("[11] riwayat keputusan dari audit: OK");
}

// --- [12] persetujuan terlambat: tidak terbit otomatis ------------------------------------------------
{
  const post = await createPost(TENANT_A, CONV_A1, OWNER_A, "A terlambat disetujui");
  const scheduled = await scheduleNow(TENANT_A, post.id, OWNER_A);
  const gate = await blockUnapprovedPostPublish(db, {
    tenantId: TENANT_A,
    postId: post.id,
    expectedScheduledAt: new Date(scheduled.scheduledAt!),
  });
  assert.equal(gate.blocked, true);
  assert.equal((await getPost(TENANT_A, post.id, OWNER_A)).status, "failed");

  // Disetujui SESUDAH terblokir → tetap failed (tidak terbit kejutan).
  await call("POST", `${postUrl(TENANT_A, post.id)}/submit-review`, OWNER_A, {});
  const approved = await call(
    "POST",
    `${postUrl(TENANT_A, post.id)}/approve`,
    ADMIN_A,
    {},
  );
  assert.equal(approved.status, 200);
  const stillFailed = await getPost(TENANT_A, post.id, OWNER_A);
  assert.equal(stillFailed.status, "failed");
  assert.equal(stillFailed.approvalStatus, "approved");

  // Pembuat menjadwalkan ulang secara eksplisit (retry) → gerbang lolos.
  const retried = await call(
    "POST",
    `${postUrl(TENANT_A, post.id)}/retry`,
    OWNER_A,
    {},
  );
  assert.equal(retried.status, 200);
  const retriedPost = retried.body as unknown as PostResponse;
  assert.equal(retriedPost.status, "scheduled");
  const gate2 = await blockUnapprovedPostPublish(db, {
    tenantId: TENANT_A,
    postId: post.id,
    expectedScheduledAt: new Date(retriedPost.scheduledAt!),
  });
  assert.equal(gate2.blocked, false);
  console.log("[12] persetujuan terlambat lewat retry eksplisit: OK");
}

// --- [13] antrean tinjauan ---------------------------------------------------------------------------
{
  const post = await createPost(TENANT_A, CONV_A1, OWNER_A, "A antrean");
  await call("POST", `${postUrl(TENANT_A, post.id)}/submit-review`, OWNER_A, {});
  const r = await call(
    "GET",
    `${postsUrl(TENANT_A)}?approvalStatus=pending_review`,
    AGENT_A,
  );
  assert.equal(r.status, 200);
  const items = (r.body as unknown as { items: PostResponse[] }).items;
  assert.ok(items.length >= 1);
  assert.ok(
    items.every((item) => item.approvalStatus === "pending_review"),
    "saringan hanya mengembalikan yang menunggu tinjauan",
  );
  assert.ok(items.some((item) => item.id === post.id));
  assert.ok(
    !items.some((item) => item.id === approvedPostId),
    "post yang sudah disetujui tidak masuk antrean",
  );
  console.log("[13] antrean tinjauan tersaring: OK");
}

console.log("\nverify-post-approval: SEMUA LULUS");
