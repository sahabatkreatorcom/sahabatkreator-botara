import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import {
  auditLogs,
  channelAccounts,
  type ChannelAccount,
  type Database,
} from "@sahabat-kreator/db";
import type { TenantContext } from "./tenant";
import { withTenantDb } from "./tx";

/**
 * Service domain TikTok (gelombang Semua OAuth — connect memakai
 * Login Kit dengan kredensial aplikasi TikTok dari Panel Admin).
 *
 * Model akun (sama seperti yang diasumsikan adapter penerbit
 * Gelombang 4 sejak awal):
 * - provider `tiktok`; external_id = open_id kreator pemilik token.
 * - Access token OAuth (scope `user.info.basic` + `video.publish`)
 *   berumur PENDEK (±24 jam) tersimpan TERENKRIPSI di
 *   `access_token_encrypted`; refresh token (±365 hari) tersimpan
 *   TERENKRIPSI di `refresh_token_encrypted` (migrasi 0022) — tidak
 *   ada token mentah di mana pun.
 * - public_handle = username TikTok; display_name = nama tampil dari
 *   user info (boleh kosong — TikTok tidak selalu mengisinya).
 * - token_type = `tiktok_user_token` (migrasi 0022) +
 *   token_expires_at dari `expires_in` grant — dasar lifecycle.
 *
 * TikTok BUKAN channel inbox: tidak ada webhook/pesan di sini. Baris
 * akun yang terhubung otomatis menjadi sasaran /posts lewat
 * materialisasi `ensureTimelineTargets` (posts.ts) — bentuknya
 * persis akun Gelombang 4, jadi tidak ada perubahan di posts.
 */

/** Varian token TikTok (lihat channelTokenTypeEnum di skema db). */
export type TikTokChannelTokenType = "tiktok_user_token";

export interface CreateTikTokChannelInput {
  /** open_id kreator pemilik token (dari token response Login Kit). */
  accountExternalId: string;
  /** Nama tampil kreator (`display_name` user info); null bila kosong. */
  profileName: string | null;
  /** Username TikTok (`username` user info); null bila kosong. */
  publicHandle: string | null;
  /** Envelope enkripsi access token — BUKAN token mentah. */
  encryptedAccessToken: string;
  /** Envelope enkripsi refresh token; null bila provider tak menerbitkan. */
  encryptedRefreshToken: string | null;
  /**
   * Kedaluwarsa access token dari `expires_in` grant; null =
   * provider tidak melaporkannya — disimpan jujur sebagai tanpa
   * expiry (tidak dipindai lifecycle), bukan ditebak.
   */
  tokenExpiresAt?: Date | null;
}

export async function createTikTokChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreateTikTokChannelInput,
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: "tiktok",
        externalId: input.accountExternalId,
        displayName: input.profileName,
        status: "connected",
        accessTokenEncrypted: input.encryptedAccessToken,
        refreshTokenEncrypted: input.encryptedRefreshToken,
        publicHandle: input.publicHandle,
        // Lifecycle token: varian + jadwal kedaluwarsa tersimpan saat
        // connect; token baru selalu dimulai sehat & bersih.
        tokenType: "tiktok_user_token",
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
        provider: "tiktok",
        publicHandle: input.publicHandle,
      },
    });

    return row;
  });
}

export interface UpdateTikTokCredentialsInput {
  /** Envelope enkripsi access token baru; undefined = jangan ubah. */
  encryptedAccessToken?: string;
  /** Envelope enkripsi refresh token baru; undefined = jangan ubah. */
  encryptedRefreshToken?: string | null;
  publicHandle?: string | null;
  /** Nama profil terbaru; undefined = jangan ubah. */
  profileName?: string | null;
  status?: ChannelAccount["status"];
  /** Kedaluwarsa token baru; undefined = jangan ubah. */
  tokenExpiresAt?: Date | null;
  /** Waktu refresh token terakhir; undefined = jangan ubah. */
  tokenRefreshedAt?: Date | null;
  /** Kode error koneksi; undefined = jangan ubah. */
  errorCode?: string | null;
}

/**
 * Menulis ulang kredensial/status akun TikTok yang SUDAH ada di
 * tenant ini — jalur "revive" connect OAuth (pola
 * `updateThreadsChannelAccountCredentials`): akun berstatus
 * 'disconnected'/'error' dihubungkan lagi tanpa baris duplikat.
 * Menghubungkan lagi selalu mengeluarkan akun dari Sampah.
 */
export async function updateTikTokChannelAccountCredentials(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  input: UpdateTikTokCredentialsInput,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = { updatedAt: new Date() };
    if (input.encryptedAccessToken !== undefined) {
      patch.accessTokenEncrypted = input.encryptedAccessToken;
      // Kredensial baru = siklus token dimulai ulang: varian tetap
      // tiktok_user_token, sehat & bersih.
      patch.tokenType = "tiktok_user_token";
      patch.tokenHealth = "ok";
      patch.errorCode = null;
    }
    if (input.encryptedRefreshToken !== undefined) {
      patch.refreshTokenEncrypted = input.encryptedRefreshToken;
    }
    if (input.publicHandle !== undefined) {
      patch.publicHandle = input.publicHandle;
    }
    if (input.profileName) {
      // Segarkan nama tampilan dari profil bila baris lama belum
      // punya — jangan menimpa nama yang sudah ada (pola Threads).
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
// Lifecycle token TikTok: pindai + keputusan (penyegaran di worker)
// ---------------------------------------------------------------------------

/** Ref hasil pemindaian lifecycle token TikTok (bentuk minimal worker). */
export interface TikTokTokenLifecycleRef {
  tenantId: string;
  channelAccountId: string;
  provider: "tiktok";
  externalId: string;
  tokenType: TikTokChannelTokenType | null;
  tokenExpiresAt: Date;
  tokenRefreshedAt: Date | null;
  /** Envelope access token terenkripsi — worker yang mendekripsi. */
  accessTokenEncrypted: string | null;
  /** Envelope refresh token terenkripsi — worker yang mendekripsi. */
  refreshTokenEncrypted: string | null;
}

/**
 * Keputusan worker lifecycle TikTok untuk SATU akun (fungsi murni):
 * - varian `tiktok_user_token` + refresh token tersimpan +
 *   konfigurasi refresh lengkap (client key + client secret aplikasi
 *   dari Panel Admin + kunci enkripsi channel) → "refresh"
 *   (grant `refresh_token` Login Kit SEBELUM access token mati —
 *   access token TikTok hanya ±24 jam, jadi penyegaran adalah jalur
 *   normal, bukan pengecualian);
 * - selain itu → "warn": worker hanya menandai kesehatan supaya
 *   pemilik menghubungkan ulang sebelum token mati.
 * Kesehatan: sudah lewat jadwal → "expired", mendekati → "expiring".
 */
export function tiktokTokenLifecycleDecision(input: {
  tokenType: TikTokChannelTokenType | null;
  tokenExpiresAt: Date;
  now: Date;
  canRefresh: boolean;
  hasRefreshToken: boolean;
}): { action: "refresh" | "warn"; health: "expiring" | "expired" } {
  const refreshable =
    input.tokenType === "tiktok_user_token" && input.hasRefreshToken;
  return {
    action: refreshable && input.canRefresh ? "refresh" : "warn",
    health: input.tokenExpiresAt <= input.now ? "expired" : "expiring",
  };
}

/**
 * Pindai akun TikTok AKTIF lintas tenant yang access token-nya
 * mendekati atau sudah melewati kedaluwarsa (dalam `withinDays`
 * hari ke depan). Access token TikTok berumur ±24 jam — jendela
 * bawaan pemanggil lifecycle memang harus mencakup token yang BARU
 * terhubung agar ia disegarkan sebelum mati (worker memakai jendela
 * yang sama seperti provider lain; lihat runner worker).
 *
 * Memakai lengan RLS yang sama dengan pemindaian Meta/Threads
 * (`meta_token_lifecycle_scan`, migrasi 0001): policy hanya
 * memeriksa nilai relay `app.system_relay = 'meta_token_lifecycle'`
 * — saringan provider hidup di kueri. Penulisan hasil lewat konteks
 * tenant masing-masing (applyMetaTokenLifecycleUpdate — penulis
 * generik kolom lifecycle, dipakai bersama; lihat worker).
 */
export async function listExpiringTikTokTokens(
  db: Database,
  opts: { withinDays?: number; limit?: number; now?: Date } = {},
): Promise<TikTokTokenLifecycleRef[]> {
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
        refreshTokenEncrypted: channelAccounts.refreshTokenEncrypted,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, "tiktok"),
          eq(channelAccounts.status, "connected"),
          isNotNull(channelAccounts.tokenExpiresAt),
          lte(channelAccounts.tokenExpiresAt, deadline),
        ),
      )
      .orderBy(asc(channelAccounts.tokenExpiresAt))
      .limit(opts.limit ?? 100);
    return rows.map((r) => ({
      ...r,
      provider: "tiktok" as const,
      tokenType: (r.tokenType ?? null) as TikTokChannelTokenType | null,
      // Guard tipe: WHERE sudah menjamin tokenExpiresAt tak null.
      tokenExpiresAt: r.tokenExpiresAt as Date,
    }));
  });
}
