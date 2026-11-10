import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryMediaStore } from "./media-storage";
import { pruneUnreferencedMedia } from "./media-gc";
import {
  PostDomainError,
  cancelPost,
  claimPostForPublish,
  createPost,
  getPost,
  listPostTargets,
  markPostFailed,
  markPostPublished,
  schedulePost,
  updatePost,
} from "./posts";
import { createTestDb, TEST_TENANT_ID, type TestDb } from "./testing/pglite";

/**
 * Content Schedule (Fase 23) — state machine postingan channel.
 *
 * Yang diuji di sini adalah hal-hal yang, kalau salah, TIDAK bisa
 * ditarik kembali:
 *
 *   1. Postingan kosong atau album campuran tidak pernah sampai ke
 *      antrean. Kegagalan yang baru ketahuan saat jam tayang adalah
 *      kegagalan yang paling merugikan — pengguna sudah menunggu.
 *   2. Klaim `scheduled → publishing` hanya berhasil SEKALI. Menerbitkan
 *      dua kali ke linimasa publik tidak bisa dihapus oleh siapa pun.
 *   3. Job dari jadwal LAMA tidak boleh menerbitkan setelah pengguna
 *      menjadwal ulang.
 *   4. `media-gc` tidak boleh memakan aset postingan yang belum tayang.
 *
 * RLS tidak diuji di sini (koneksi test memakai peran pemilik); isolasi
 * tenant-nya diuji di `packages/db/scripts/verify.ts` cek [49].
 */

const CH_ACCOUNT = "8a000000-0000-4000-8000-000000000023";
const CONTACT = "8a100000-0000-4000-8000-000000000023";
const CONV_CHANNEL = "8a200000-0000-4000-8000-000000000023";
const USER_ID = "8a300000-0000-4000-8000-000000000023";
const MEDIA_PHOTO = "8a400000-0000-4000-8000-000000000023";
const MEDIA_DOC = "8a500000-0000-4000-8000-000000000023";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
  const q = (text: string, params: unknown[] = []) =>
    ctx.pglite.query(text, params);

  await q(
    `INSERT INTO users (id, email, name) VALUES ($1, 'poster@example.com', 'Poster')`,
    [USER_ID],
  );
  await q(
    `INSERT INTO channel_accounts
       (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted, bot_username)
     VALUES ($1, $2, 'telegram', 'post-test-bot', 'Bot Posting', 'connected', 'v1:token', 'post_test_bot')`,
    [CH_ACCOUNT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Channel Promo')`,
    [CONTACT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO conversations
       (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind)
     VALUES ($1, $2, $3, $4, 'telegram', '-1009876543210', 'Channel Promo', 'channel')`,
    [CONV_CHANNEL, TEST_TENANT_ID, CH_ACCOUNT, CONTACT],
  );
  await q(
    `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes)
     VALUES ($1, $2, 't/photo.jpg', 'photo.jpg', 'image/jpeg', 2048),
            ($3, $2, 't/doc.pdf', 'doc.pdf', 'application/pdf', 4096)`,
    [MEDIA_PHOTO, TEST_TENANT_ID, MEDIA_DOC],
  );
});

afterAll(async () => {
  await ctx.close();
});

function draft(overrides: { caption?: string; mediaIds?: string[] } = {}) {
  return createPost(ctx.db, {
    tenantId: TEST_TENANT_ID,
    userId: USER_ID,
    conversationId: CONV_CHANNEL,
    title: "Promo Senin",
    caption: overrides.caption ?? "Diskon 20% hari ini",
    mediaIds: overrides.mediaIds ?? [],
  });
}

describe("target", () => {
  it("hanya percakapan kind=channel pada akun terhubung yang bisa dituju", async () => {
    const targets = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    expect(targets.map((t) => t.conversationId)).toContain(CONV_CHANNEL);
    expect(targets[0]?.providerChatId).toBe("-1009876543210");
  });
});

describe("gerbang isi: yang tidak boleh sampai ke antrean", () => {
  it("menolak postingan tanpa teks dan tanpa media", async () => {
    const post = await draft({ caption: "   " });
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: post.id,
      }),
    ).rejects.toThrow(PostDomainError);
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: post.id,
      }),
    ).rejects.toMatchObject({ code: "POST_EMPTY" });
  });

  it("menolak album yang mencampur dokumen dengan foto", async () => {
    const post = await draft({ mediaIds: [MEDIA_PHOTO, MEDIA_DOC] });
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: post.id,
      }),
    ).rejects.toMatchObject({ code: "POST_MEDIA_ALBUM_UNSUPPORTED" });
  });

  it("menolak media milik tenant lain / tidak ada", async () => {
    await expect(
      draft({ mediaIds: ["8a600000-0000-4000-8000-000000000023"] }),
    ).rejects.toMatchObject({ code: "POST_MEDIA_NOT_FOUND" });
  });

  it("edit hanya berlaku untuk draft", async () => {
    const post = await draft({ mediaIds: [MEDIA_PHOTO] });
    const scheduled = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    expect(scheduled.post.status).toBe("scheduled");
    await expect(
      updatePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: post.id,
        caption: "diubah setelah dijadwalkan",
      }),
    ).rejects.toMatchObject({ code: "POST_NOT_EDITABLE" });
  });
});

describe("penjadwalan", () => {
  it("menulis event outbox post.publish_due dan menyimpan jam tayang", async () => {
    const post = await draft({ mediaIds: [MEDIA_PHOTO] });
    const at = new Date(Date.now() + 3_600_000);
    const result = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
      scheduledAt: at,
    });
    expect(result.post.status).toBe("scheduled");
    expect(result.post.scheduledAt?.toISOString()).toBe(at.toISOString());

    const events = await ctx.pglite.query<{ payload: { postId: string } }>(
      `SELECT payload FROM outbox_events WHERE type = 'post.publish_due' AND payload->>'postId' = $1`,
      [post.id],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("jam tayang di masa lalu diperlakukan sebagai terbit sekarang", async () => {
    const post = await draft();
    const result = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
      scheduledAt: new Date(Date.now() - 60_000),
    });
    expect(result.post.status).toBe("scheduled");
    expect(result.post.scheduledAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("klaim: satu postingan tidak pernah terbit dua kali", () => {
  it("klaim pertama berhasil, klaim kedua ditolak", async () => {
    const post = await draft();
    const result = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    const at = result.post.scheduledAt!;

    const first = await claimPostForPublish(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
      expectedScheduledAt: at,
    });
    expect(first.kind).toBe("claimed");

    const second = await claimPostForPublish(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
      expectedScheduledAt: at,
    });
    expect(second).toEqual({ kind: "skipped", status: "publishing" });
  });

  it("job dari jadwal lama ditolak setelah dijadwal ulang", async () => {
    const post = await draft();
    const first = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
      scheduledAt: new Date(Date.now() + 3_600_000),
    });
    const oldAt = first.post.scheduledAt!;
    const second = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
      scheduledAt: new Date(Date.now() + 7_200_000),
    });
    expect(second.post.scheduledAt!.getTime()).not.toBe(oldAt.getTime());

    const stale = await claimPostForPublish(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
      expectedScheduledAt: oldAt,
    });
    expect(stale.kind).toBe("skipped");

    const fresh = await claimPostForPublish(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
      expectedScheduledAt: second.post.scheduledAt!,
    });
    expect(fresh.kind).toBe("claimed");
  });

  it("postingan yang gagal tidak bisa dibatalkan (terminal)", async () => {
    const post = await draft();
    await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    await markPostFailed(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
      errorCode: "telegram_http_400",
    });
    const failed = await getPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("telegram_http_400");

    await expect(
      cancelPost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: post.id,
      }),
    ).rejects.toMatchObject({ code: "POST_NOT_CANCELLABLE" });
  });

  it("menandai terbit mengisi providerMessageId", async () => {
    const post = await draft();
    const result = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    await claimPostForPublish(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
      expectedScheduledAt: result.post.scheduledAt!,
    });
    await markPostPublished(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
      providerMessageId: "4242",
    });
    const published = await getPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
    });
    expect(published?.status).toBe("published");
    expect(published?.providerMessageId).toBe("4242");
    expect(published?.publishedAt).not.toBeNull();
  });
});

describe("media-gc: aset postingan terjadwal bukan sampah", () => {
  it("media yang dirujuk post TIDAK dihapus; yang tidak dirujuk tetap dihapus", async () => {
    const store = createMemoryMediaStore();
    const keep = "8a700000-0000-4000-8000-000000000023";
    const drop = "8a800000-0000-4000-8000-000000000023";
    await ctx.pglite.query(
      `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes, created_at)
       VALUES ($1, $2, 't/keep.jpg', 'keep.jpg', 'image/jpeg', 10, now() - interval '30 days'),
              ($3, $2, 't/drop.jpg', 'drop.jpg', 'image/jpeg', 10, now() - interval '30 days')`,
      [keep, TEST_TENANT_ID, drop],
    );
    await store.put("t/keep.jpg", Buffer.from("x"), "image/jpeg");
    await store.put("t/drop.jpg", Buffer.from("x"), "image/jpeg");

    const post = await draft({ mediaIds: [keep] });
    await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
      scheduledAt: new Date(Date.now() + 14 * 24 * 3600_000),
    });

    const result = await pruneUnreferencedMedia(ctx.db, store, { limit: 100 });
    const left = await ctx.pglite.query<{ id: string }>(
      `SELECT id FROM media WHERE id = ANY($1::uuid[])`,
      [[keep, drop]],
    );
    expect(left.rows.map((r) => r.id)).toEqual([keep]);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });
});
