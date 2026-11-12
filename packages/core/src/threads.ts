import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  type ChannelAccount,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service domain Threads (integrasi Threads — connect/OAuth memakai
 * kredensial aplikasi Threads dari Panel Admin).
 *
 * Model akun (sama seperti yang diasumsikan adapter penerbit
 * Gelombang 1 sejak awal):
 * - provider `threads`; external_id = Threads user ID pemilik token.
 * - Token = Threads user access token BERUMUR PANJANG (±60 hari) hasil
 *   OAuth aplikasi Threads (authorize → code → token pendek →
 *   `th_exchange_token`), tersimpan TERENKRIPSI di
 *   `access_token_encrypted` — token pendek tidak pernah disimpan.
 * - public_handle = username Threads; display_name = nama profil.
 * - token_type = `threads_user_token` (migrasi 0021) +
 *   token_expires_at dari `expires_in` grant — dasar lifecycle.
 *
 * Threads BUKAN channel inbox: API-nya tidak menyediakan pesan
 * privat/DM, jadi tidak ada jalur pesan di sini. Yang ada (G7):
 * webhook balasan Threads di-ingest route API ke tabel `comments`
 * dan dievaluasi evaluator comment-to-DM bersama (comments.ts) —
 * resolver akun untuk jalur webhook itu tinggal di file ini
 * (`resolveThreadsAccountByExternalId`). Baris akun yang terhubung
 * otomatis menjadi sasaran /posts lewat materialisasi
 * `ensureTimelineTargets` (posts.ts) — bentuknya persis akun hasil
 * materialisasi Gelombang 1, jadi tidak ada perubahan di posts untuk
 * connect nyata ini.
 */

/** Potongan akun Threads untuk jalur webhook (tanpa konteks tenant). */
export interface ThreadsAccountRef {
  id: string;
  tenantId: string;
  provider: "threads";
  externalId: string;
  status: string;
  publicHandle: string | null;
}

/**
 * Resolusi akun Threads dari Threads user ID pemilik postingan
 * (`root_post.owner_id` pada webhook balasan) — pola yang sama dengan
 * `resolveMetaAccountByExternalId`: transaksi mengatur konteks lookup
 * RLS `provider_external_lookup` (migrasi 0020) lalu memilih baris
 * provider 'threads' dengan external_id itu. External_id yang sama
 * boleh hidup di beberapa tenant sebagai baris disconnected — baris
 * `connected` didahulukan; bila tidak ada, yang terbaru.
 */
export async function resolveThreadsAccountByExternalId(
  db: Database,
  externalId: string,
): Promise<ThreadsAccountRef | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.channel_provider', ${"threads"}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('app.channel_external_id', ${externalId}, true)`,
    );
    const [row] = await tx
      .select({
        id: channelAccounts.id,
        tenantId: channelAccounts.tenantId,
        provider: channelAccounts.provider,
        externalId: channelAccounts.externalId,
        status: channelAccounts.status,
        publicHandle: channelAccounts.publicHandle,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, "threads"),
          eq(channelAccounts.externalId, externalId),
        ),
      )
      .orderBy(
        sql`case when ${channelAccounts.status} = 'connected' then 0 else 1 end`,
        desc(channelAccounts.createdAt),
      )
      .limit(1);
    return row ? { ...row, provider: "threads" as const } : null;
  });
}

/** Varian token Threads (lihat channelTokenTypeEnum di skema db). */
export type ThreadsChannelTokenType = "threads_user_token";

export interface CreateThreadsChannelInput {
  /** Threads user ID pemilik token (dari exchange code / profil /me). */
  accountExternalId: string;
  /** Nama profil Threads (`GET /me` field `name`); null bila kosong. */
  profileName: string | null;
  /** Username Threads (`GET /me` field `username`); null bila kosong. */
  publicHandle: string | null;
  /** Envelope enkripsi token berumur panjang — BUKAN token mentah. */
  encryptedAccessToken: string;
  /** Versi API Threads ter-pin untuk akun ini (v1.0). */
  graphApiVersion: string;
  /**
   * Kedaluwarsa token dari `expires_in` grant th_exchange_token;
   * null = provider tidak melaporkannya — disimpan jujur sebagai
   * tanpa expiry (tidak dipindai lifecycle), bukan ditebak.
   */
  tokenExpiresAt?: Date | null;
}

export async function createThreadsChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreateThreadsChannelInput,
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: "threads",
        externalId: input.accountExternalId,
        displayName: input.profileName,
        status: "connected",
        accessTokenEncrypted: input.encryptedAccessToken,
        publicHandle: input.publicHandle,
        graphApiVersion: input.graphApiVersion,
        // Lifecycle token: varian + jadwal kedaluwarsa tersimpan saat
        // connect; token baru selalu dimulai sehat & bersih.
        tokenType: "threads_user_token",
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        tokenHealth: "ok",
        errorCode: null,
      })
      .returning();

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "channel.created",
      // Metadata aman: handle memang publik; token tidak dicatat.
      meta: {
        channelAccountId: row.id,
        provider: "threads",
        publicHandle: input.publicHandle,
      },
    });

    return row;
  });
}

export interface UpdateThreadsCredentialsInput {
  /** Envelope enkripsi token baru; undefined = jangan ubah. */
  encryptedAccessToken?: string;
  publicHandle?: string | null;
  /** Nama profil terbaru; undefined = jangan ubah. */
  profileName?: string | null;
  status?: ChannelAccount["status"];
  /** Kedaluwarsa token baru; undefined = jangan ubah. */
  tokenExpiresAt?: Date | null;
  /** Waktu refresh token terakhir; undefined = jangan ubah. */
  tokenRefreshedAt?: Date | null;
  /** Kode error koneksi (mis. threads_graph_190); undefined = jangan ubah. */
  errorCode?: string | null;
}

/**
 * Menulis ulang kredensial/status akun Threads yang SUDAH ada di
 * tenant ini — jalur "revive" connect OAuth (pola
 * `updateMetaChannelAccountCredentials`): akun berstatus
 * 'disconnected'/'error' dihubungkan lagi tanpa baris duplikat.
 * Menghubungkan lagi selalu mengeluarkan akun dari Sampah.
 */
export async function updateThreadsChannelAccountCredentials(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  input: UpdateThreadsCredentialsInput,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = { updatedAt: new Date() };
    if (input.encryptedAccessToken !== undefined) {
      patch.accessTokenEncrypted = input.encryptedAccessToken;
      // Kredensial baru = siklus token dimulai ulang: varian tetap
      // threads_user_token, sehat & bersih.
      patch.tokenType = "threads_user_token";
      patch.tokenHealth = "ok";
      patch.errorCode = null;
    }
    if (input.publicHandle !== undefined) {
      patch.publicHandle = input.publicHandle;
    }
    if (input.profileName) {
      // Segarkan nama tampilan dari profil bila baris lama belum
      // punya — jangan menimpa nama yang sudah ada (pola Meta).
      const [current] = await tx
        .select({ displayName: channelAccounts.displayName })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.tenantId, ctx.tenantId),
            eq(channelAccounts.id, channelAccountId),
          ),
        )
        .limit(1);
      if (current && !current.displayName) {
        patch.displayName = input.profileName;
      }
    }
    if (input.tokenExpiresAt !== undefined) {
      patch.tokenExpiresAt = input.tokenExpiresAt;
    }
    if (input.tokenRefreshedAt !== undefined) {
      patch.tokenRefreshedAt = input.tokenRefreshedAt;
    }
    if (input.errorCode !== undefined) patch.errorCode = input.errorCode;
    if (input.status !== undefined) patch.status = input.status;
    if (input.status === "connected") {
      patch.trashedAt = null;
      // Hubungkan ulang = kesalahan koneksi sebelumnya selesai.
      patch.errorCode = null;
    }

    const [row] = await tx
      .update(channelAccounts)
      .set(patch)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle token Threads: pindai + keputusan (penyegaran di worker)
// ---------------------------------------------------------------------------

/** Ref hasil pemindaian lifecycle token Threads (bentuk minimal worker). */
export interface ThreadsTokenLifecycleRef {
  tenantId: string;
  channelAccountId: string;
  provider: "threads";
  externalId: string;
  tokenType: ThreadsChannelTokenType | null;
  tokenExpiresAt: Date;
  tokenRefreshedAt: Date | null;
  /** Envelope token terenkripsi — worker yang mendekripsi. */
  accessTokenEncrypted: string | null;
}

/**
 * Keputusan worker lifecycle Threads untuk SATU akun (fungsi murni):
 * - varian `threads_user_token` + konfigurasi refresh lengkap →
 *   "refresh" (grant `th_refresh_token`; konfigurasinya hanya kunci
 *   enkripsi channel — grant ini TIDAK memakai app secret);
 * - selain itu → "warn": worker hanya menandai kesehatan supaya
 *   pemilik menghubungkan ulang sebelum token mati.
 * Kesehatan: sudah lewat jadwal → "expired", mendekati → "expiring".
 */
export function threadsTokenLifecycleDecision(input: {
  tokenType: ThreadsChannelTokenType | null;
  tokenExpiresAt: Date;
  now: Date;
  canRefresh: boolean;
}): { action: "refresh" | "warn"; health: "expiring" | "expired" } {
  const refreshable = input.tokenType === "threads_user_token";
  return {
    action: refreshable && input.canRefresh ? "refresh" : "warn",
    health: input.tokenExpiresAt <= input.now ? "expired" : "expiring",
  };
}

/**
 * Pindai akun Threads AKTIF lintas tenant yang tokennya mendekati atau
 * sudah melewati kedaluwarsa (dalam `withinDays` hari ke depan).
 *
 * Memakai lengan RLS yang sama dengan pemindaian Meta
 * (`meta_token_lifecycle_scan`, migrasi 0001): policy itu hanya
 * memeriksa nilai relay `app.system_relay = 'meta_token_lifecycle'`
 * (SELECT saja) — saringan provider hidup di kueri, bukan di policy,
 * jadi pemindaian Threads menyetel relay yang sama dan menyaring
 * provider `threads` di sini. Nama policy-nya historis; tidak ada
 * migrasi lengan baru yang dibutuhkan. Penulisan hasil lewat konteks
 * tenant masing-masing (applyMetaTokenLifecycleUpdate — penulis
 * generik kolom lifecycle, dipakai bersama; lihat worker).
 */
export async function listExpiringThreadsTokens(
  db: Database,
  opts: { withinDays?: number; limit?: number; now?: Date } = {},
): Promise<ThreadsTokenLifecycleRef[]> {
  const now = opts.now ?? new Date();
  const withinMs = (opts.withinDays ?? 7) * 24 * 60 * 60 * 1000;
  const deadline = new Date(now.getTime() + withinMs);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.system_relay', 'meta_token_lifecycle', true)`,
    );
    const rows = await tx
      .select({
        tenantId: channelAccounts.tenantId,
        channelAccountId: channelAccounts.id,
        provider: channelAccounts.provider,
        externalId: channelAccounts.externalId,
        tokenType: channelAccounts.tokenType,
        tokenExpiresAt: channelAccounts.tokenExpiresAt,
        tokenRefreshedAt: channelAccounts.tokenRefreshedAt,
        accessTokenEncrypted: channelAccounts.accessTokenEncrypted,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, "threads"),
          eq(channelAccounts.status, "connected"),
          isNotNull(channelAccounts.tokenExpiresAt),
          lte(channelAccounts.tokenExpiresAt, deadline),
        ),
      )
      .orderBy(asc(channelAccounts.tokenExpiresAt))
      .limit(opts.limit ?? 100);
    return rows.map((r) => ({
      ...r,
      provider: "threads" as const,
      tokenType: (r.tokenType ?? null) as ThreadsChannelTokenType | null,
      // Guard tipe: WHERE sudah menjamin tokenExpiresAt tak null.
      tokenExpiresAt: r.tokenExpiresAt as Date,
    }));
  });
}
