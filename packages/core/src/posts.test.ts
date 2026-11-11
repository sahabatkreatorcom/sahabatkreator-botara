import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryMediaStore } from "./media-storage";
import { pruneUnreferencedMedia } from "./media-gc";
import {
  PostDomainError,
  cancelPost,
  claimPostForPublish,
  createPost,
  createPostGroup,
  duplicatePost,
  getPost,
  getPostTargetProvider,
  listPostTargets,
  markPostFailed,
  markPostPublished,
  releaseStuckPost,
  retryPost,
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
const FB_ACCOUNT = "8a010000-0000-4000-8000-000000000023";
const IG_ACCOUNT = "8a020000-0000-4000-8000-000000000023";
const THREADS_ACCOUNT = "8a030000-0000-4000-8000-000000000023";
const BLUESKY_ACCOUNT = "8a040000-0000-4000-8000-000000000023";
const YOUTUBE_ACCOUNT = "8a050000-0000-4000-8000-000000000023";
const LINKEDIN_ACCOUNT = "8a060000-0000-4000-8000-000000000023";
const CONTACT = "8a100000-0000-4000-8000-000000000023";
const CONV_CHANNEL = "8a200000-0000-4000-8000-000000000023";
const CONV_CHANNEL_2 = "8a210000-0000-4000-8000-000000000023";
const USER_ID = "8a300000-0000-4000-8000-000000000023";
const MEDIA_PHOTO = "8a400000-0000-4000-8000-000000000023";
const MEDIA_DOC = "8a500000-0000-4000-8000-000000000023";
const MEDIA_VIDEO = "8b600000-0000-4000-8000-000000000023";

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
    `INSERT INTO channel_accounts
       (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted, public_handle)
     VALUES ($1, $2, 'messenger', '1234567890', 'Page Promo', 'connected', 'v1:page-token', 'pagepromo')`,
    [FB_ACCOUNT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO channel_accounts
       (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted, public_handle)
     VALUES ($1, $2, 'instagram', '17841400000000000', 'IG Promo', 'connected', 'v1:ig-token', 'igpromo')`,
    [IG_ACCOUNT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO channel_accounts
       (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted, public_handle)
     VALUES ($1, $2, 'threads', 'th_user_123', 'Threads Promo', 'connected', 'v1:threads-token', 'threadspromo')`,
    [THREADS_ACCOUNT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO channel_accounts
       (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted, public_handle)
     VALUES ($1, $2, 'bluesky', 'did:plc:promo123', 'Bluesky Promo', 'connected', 'v1:bluesky-app-password', 'promo.bsky.social')`,
    [BLUESKY_ACCOUNT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO channel_accounts
       (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted, public_handle)
     VALUES ($1, $2, 'youtube', 'UCpromo123456', 'Kanal Promo', 'connected', NULL, 'kanalpromo')`,
    [YOUTUBE_ACCOUNT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO channel_accounts
       (id, tenant_id, provider, external_id, display_name, status, access_token_encrypted, public_handle)
     VALUES ($1, $2, 'linkedin', 'member123abc', 'Profil Promo', 'connected', 'v1:linkedin-token', 'profilpromo')`,
    [LINKEDIN_ACCOUNT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO contacts (id, tenant_id, name) VALUES ($1, $2, 'Channel Promo')`,
    [CONTACT, TEST_TENANT_ID],
  );
  await q(
    `INSERT INTO conversations
       (id, tenant_id, channel_account_id, contact_id, provider, provider_chat_id, title, kind)
     VALUES ($1, $2, $3, $4, 'telegram', '-1009876543210', 'Channel Promo', 'channel'),
              ($5, $2, $3, $4, 'telegram', '-1009876543211', 'Channel Promo 2', 'channel')`,
    [CONV_CHANNEL, TEST_TENANT_ID, CH_ACCOUNT, CONTACT, CONV_CHANNEL_2],
  );
  await q(
    `INSERT INTO media (id, tenant_id, r2_key, file_name, mime_type, size_bytes)
     VALUES ($1, $2, 't/photo.jpg', 'photo.jpg', 'image/jpeg', 2048),
            ($3, $2, 't/doc.pdf', 'doc.pdf', 'application/pdf', 4096),
            ($4, $2, 't/video.mp4', 'video.mp4', 'video/mp4', 8192)`,
    [MEDIA_PHOTO, TEST_TENANT_ID, MEDIA_DOC, MEDIA_VIDEO],
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
    // Jangan mengasumsikan posisi indeks: daftar diurutkan judul, dan
    // sasaran linimasa lain (Meta/Threads/Bluesky) ikut termaterialisasi.
    expect(
      targets.find((t) => t.conversationId === CONV_CHANNEL)?.providerChatId,
    ).toBe("-1009876543210");
  });

  it("intipan provider untuk registry adapter: telegram, dan null untuk post yang tidak ada", async () => {
    const post = await draft();
    await expect(
      getPostTargetProvider(ctx.db, {
        tenantId: TEST_TENANT_ID,
        postId: post.id,
      }),
    ).resolves.toBe("telegram");
    await expect(
      getPostTargetProvider(ctx.db, {
        tenantId: TEST_TENANT_ID,
        postId: "8a900000-0000-4000-8000-000000000023",
      }),
    ).resolves.toBeNull();
  });
});

describe("sasaran Meta & Threads (Gelombang 1)", () => {
  it("Page terhubung menjadi sasaran channel dari external_id akun, idempoten", async () => {
    const first = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    const page = first.find((target) => target.provider === "messenger");
    expect(page).toBeDefined();
    expect(page?.channelAccountId).toBe(FB_ACCOUNT);
    expect(page?.providerChatId).toBe("1234567890");
    expect(page?.title).toBe("Page Promo");

    const second = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    const pages = second.filter((target) => target.provider === "messenger");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.conversationId).toBe(page?.conversationId);
  });

  it("akun IG Business terhubung menjadi sasaran; teks saja ditolak, foto terjadwal", async () => {
    const targets = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    const ig = targets.find((target) => target.provider === "instagram");
    expect(ig?.channelAccountId).toBe(IG_ACCOUNT);
    expect(ig?.providerChatId).toBe("17841400000000000");

    const textOnly = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: ig!.conversationId,
      title: "IG teks",
      caption: "Tidak akan terjadwal",
      mediaIds: [],
    });
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: textOnly.id,
      }),
    ).rejects.toMatchObject({ code: "POST_MEDIA_REQUIRED" });

    const photo = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: ig!.conversationId,
      title: "IG foto",
      caption: "Halo dari Instagram",
      mediaIds: [MEDIA_PHOTO],
    });
    const scheduled = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: photo.id,
    });
    expect(scheduled.post.status).toBe("scheduled");
  });

  it("akun Threads menjadi sasaran publikasi; teks saja terjadwal dan caption dibatasi 500", async () => {
    const targets = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    const threads = targets.find((target) => target.provider === "threads");
    expect(threads?.channelAccountId).toBe(THREADS_ACCOUNT);
    expect(threads?.providerChatId).toBe("th_user_123");

    const post = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: threads!.conversationId,
      title: "Threads teks",
      caption: "x".repeat(600),
      mediaIds: [],
    });
    expect(post.caption).toHaveLength(500);
    const scheduled = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    expect(scheduled.post.status).toBe("scheduled");
    expect(scheduled.post.target.provider).toBe("threads");
  });

  it("akun Bluesky menjadi sasaran publikasi (DID); teks saja terjadwal, caption dibatasi 300, dokumen ditolak", async () => {
    const targets = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    const bluesky = targets.find((target) => target.provider === "bluesky");
    expect(bluesky?.channelAccountId).toBe(BLUESKY_ACCOUNT);
    expect(bluesky?.providerChatId).toBe("did:plc:promo123");

    const post = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: bluesky!.conversationId,
      title: "Bluesky teks",
      caption: "y".repeat(400),
      mediaIds: [],
    });
    expect(post.caption).toHaveLength(300);
    const scheduled = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    expect(scheduled.post.status).toBe("scheduled");
    expect(scheduled.post.target.provider).toBe("bluesky");

    const docPost = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: bluesky!.conversationId,
      title: "Bluesky dokumen",
      caption: "Lampiran dokumen",
      mediaIds: [MEDIA_DOC],
    });
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: docPost.id,
      }),
    ).rejects.toMatchObject({ code: "POST_MEDIA_KIND_UNSUPPORTED" });
  });

  it("akun YouTube menjadi sasaran publikasi (channel ID); wajib video, foto ditolak, judul dibatasi 100", async () => {
    const targets = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    const youtube = targets.find((target) => target.provider === "youtube");
    expect(youtube?.channelAccountId).toBe(YOUTUBE_ACCOUNT);
    expect(youtube?.providerChatId).toBe("UCpromo123456");

    const video = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: youtube!.conversationId,
      title: "Review Produk Baru",
      caption: "Deskripsi video minggu ini",
      mediaIds: [MEDIA_VIDEO],
    });
    const scheduled = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: video.id,
    });
    expect(scheduled.post.status).toBe("scheduled");
    expect(scheduled.post.target.provider).toBe("youtube");

    const noMedia = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: youtube!.conversationId,
      title: "Tanpa video",
      caption: "Tidak akan terjadwal",
      mediaIds: [],
    });
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: noMedia.id,
      }),
    ).rejects.toMatchObject({ code: "POST_MEDIA_REQUIRED" });

    const photo = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: youtube!.conversationId,
      title: "Foto saja",
      caption: "YouTube tidak menerima foto",
      mediaIds: [MEDIA_PHOTO],
    });
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: photo.id,
      }),
    ).rejects.toMatchObject({ code: "POST_MEDIA_KIND_UNSUPPORTED" });

    const longTitle = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: youtube!.conversationId,
      title: "j".repeat(101),
      caption: "Judulnya kepanjangan untuk YouTube",
      mediaIds: [MEDIA_VIDEO],
    });
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: longTitle.id,
      }),
    ).rejects.toMatchObject({ code: "POST_TITLE_TOO_LONG" });
  });

  it("akun LinkedIn menjadi sasaran publikasi (member ID); teks terjadwal, caption dibatasi 3000, dokumen ditolak", async () => {
    const targets = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    const linkedin = targets.find((target) => target.provider === "linkedin");
    expect(linkedin?.channelAccountId).toBe(LINKEDIN_ACCOUNT);
    expect(linkedin?.providerChatId).toBe("member123abc");

    const post = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: linkedin!.conversationId,
      title: "LinkedIn teks",
      caption: "z".repeat(3200),
      mediaIds: [],
    });
    expect(post.caption).toHaveLength(3000);
    const scheduled = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    expect(scheduled.post.status).toBe("scheduled");
    expect(scheduled.post.target.provider).toBe("linkedin");

    const video = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: linkedin!.conversationId,
      title: "LinkedIn video",
      caption: "Video profil minggu ini",
      mediaIds: [MEDIA_VIDEO],
    });
    const scheduledVideo = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: video.id,
    });
    expect(scheduledVideo.post.status).toBe("scheduled");

    const docPost = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: linkedin!.conversationId,
      title: "LinkedIn dokumen",
      caption: "Lampiran dokumen",
      mediaIds: [MEDIA_DOC],
    });
    await expect(
      schedulePost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: docPost.id,
      }),
    ).rejects.toMatchObject({ code: "POST_MEDIA_KIND_UNSUPPORTED" });
  });

  it("post teks Facebook Page lolos penjadwalan lewat capability messenger", async () => {
    const targets = await listPostTargets(ctx.db, { tenantId: TEST_TENANT_ID });
    const page = targets.find((target) => target.provider === "messenger")!;
    const post = await createPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      conversationId: page.conversationId,
      title: "Promo Page",
      caption: "Halo dari Facebook Page",
      mediaIds: [],
    });
    const scheduled = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    expect(scheduled.post.status).toBe("scheduled");
    expect(scheduled.post.target.provider).toBe("messenger");
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

  it("caption dipotong menurut capability provider sasaran (telegram 1024), bukan konstanta global", async () => {
    const post = await draft({ caption: "x".repeat(1500) });
    expect(post.caption).toHaveLength(1024);
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

describe("grup multi-target", () => {
  it("satu konten induk menjadi N draft dalam satu grup; override caption per sasaran menang", async () => {
    const result = await createPostGroup(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      title: "Kampanye Grup",
      caption: "Caption induk untuk semua",
      mediaIds: [MEDIA_PHOTO],
      targets: [
        { conversationId: CONV_CHANNEL },
        { conversationId: CONV_CHANNEL_2, caption: "Caption khusus channel 2" },
      ],
    });
    expect(result.posts).toHaveLength(2);
    expect(result.posts.every((p) => p.groupId === result.groupId)).toBe(true);
    expect(result.posts.every((p) => p.status === "draft")).toBe(true);
    const byTarget = new Map(
      result.posts.map((p) => [p.target.conversationId, p.caption]),
    );
    expect(byTarget.get(CONV_CHANNEL)).toBe("Caption induk untuk semua");
    expect(byTarget.get(CONV_CHANNEL_2)).toBe("Caption khusus channel 2");
    // Media dipakai bersama: kedua anggota membawa lampiran yang sama.
    expect(result.posts.every((p) => p.media.length === 1)).toBe(true);
  });

  it("satu sasaran tidak dikenal menggagalkan SELURUH grup (tidak ada grup setengah jadi)", async () => {
    await expect(
      createPostGroup(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        title: "Grup Gagal",
        caption: "tidak akan pernah ada",
        mediaIds: [],
        targets: [
          { conversationId: CONV_CHANNEL },
          { conversationId: "8a900000-0000-4000-8000-000000000023" },
        ],
      }),
    ).rejects.toMatchObject({ code: "POST_TARGET_NOT_FOUND" });
    const groups = await ctx.pglite.query(
      `SELECT id FROM post_groups WHERE title = 'Grup Gagal'`,
    );
    expect(groups.rows).toHaveLength(0);
  });

  it("post tunggal tetap groupId null", async () => {
    const post = await draft();
    expect(post.groupId).toBeNull();
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

describe("pemulihan manual: retry, bebaskan macet, duplikat (Gelombang 0)", () => {
  /** Draft → terjadwal → ditandai gagal, seperti kegagalan nyata di worker. */
  async function failedPost() {
    const post = await draft({ mediaIds: [MEDIA_PHOTO] });
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
    return post;
  }

  it("retry menjadwalkan ulang post gagal dan membersihkan catatan errornya", async () => {
    const post = await failedPost();
    const at = new Date(Date.now() + 3_600_000);
    const result = await retryPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
      scheduledAt: at,
    });
    expect(result.post.status).toBe("scheduled");
    expect(result.post.errorCode).toBeNull();
    expect(result.post.scheduledAt!.getTime()).toBe(at.getTime());
  });

  it("retry menolak post yang tidak gagal (POST_NOT_RETRYABLE)", async () => {
    const post = await draft();
    await expect(
      retryPost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: post.id,
      }),
    ).rejects.toMatchObject({ code: "POST_NOT_RETRYABLE" });
  });

  it("bebaskan macet: publishing → failed publish_outcome_unknown, BUKAN terjadwal ulang", async () => {
    const post = await draft();
    const scheduled = await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    await claimPostForPublish(ctx.db, {
      tenantId: TEST_TENANT_ID,
      postId: post.id,
      expectedScheduledAt: scheduled.post.scheduledAt!,
    });
    const released = await releaseStuckPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    expect(released.status).toBe("failed");
    expect(released.errorCode).toBe("publish_outcome_unknown");
    // Setelah dilepas, operator BOLEH memutuskan retry secara sadar.
    const retried = await retryPost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: post.id,
    });
    expect(retried.post.status).toBe("scheduled");
  });

  it("bebaskan macet menolak post yang tidak sedang publishing", async () => {
    const post = await draft();
    await expect(
      releaseStuckPost(ctx.db, {
        tenantId: TEST_TENANT_ID,
        userId: USER_ID,
        postId: post.id,
      }),
    ).rejects.toMatchObject({ code: "POST_NOT_PUBLISHING" });
  });

  it("duplikat melahirkan draft baru: isi dan grup disalin, jadwal tidak", async () => {
    const group = await createPostGroup(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      title: "Sumber Duplikat",
      caption: "Isi yang akan disalin",
      mediaIds: [MEDIA_PHOTO],
      targets: [{ conversationId: CONV_CHANNEL }],
    });
    const source = group.posts[0]!;
    await schedulePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: source.id,
      scheduledAt: new Date(Date.now() + 3_600_000),
    });
    const copy = await duplicatePost(ctx.db, {
      tenantId: TEST_TENANT_ID,
      userId: USER_ID,
      postId: source.id,
    });
    expect(copy.id).not.toBe(source.id);
    expect(copy.status).toBe("draft");
    expect(copy.scheduledAt).toBeNull();
    expect(copy.caption).toBe("Isi yang akan disalin");
    expect(copy.media.map((m) => m.mediaId)).toEqual([MEDIA_PHOTO]);
    expect(copy.groupId).toBe(group.groupId);
    expect(copy.target.conversationId).toBe(CONV_CHANNEL);
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
