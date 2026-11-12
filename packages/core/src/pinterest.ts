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
 * Service domain Pinterest (gelombang Semua OAuth — connect memakai
 * OAuth API v5 dengan kredensial aplikasi Pinterest dari Panel
 * Admin).
 *
 * Model akun (sama seperti yang diasumsikan adapter penerbit
 * Gelombang 3 sejak awal):
 * - provider `pinterest`; external_id = id akun Pinterest pemilik
 *   token (dari `GET /v5/user_account`).
 * - Access token OAuth (scope boards:read/write + pins:read/write)
 *   berumur 30 hari tersimpan TERENKRIPSI di
 *   `access_token_encrypted`; refresh token tersimpan TERENKRIPSI
 *   di `refresh_token_encrypted` (migrasi 0022). Pinterest mendukung
 *   penyegaran BERKELANJUTAN: grant `refresh_token` menerbitkan
 *   access token baru + refresh token baru tanpa batas umur refresh
 *   token selama tidak dicabut — jadi akun Pinterest yang terhubung
 *   tidak pernah perlu connect ulang hanya karena umur token.
 * - public_handle = username Pinterest; display_name tidak dipakai
 *   (user_account v5 tidak menjanjikan nama tampil — kartu memakai
 *   username).
 * - Board tujuan Pin bisa dipilih pemilik workspace per akun
 *   (kolom `pinterest_board_id` + snapshot `pinterest_board_name`,
 *   migrasi 0025); kosong = board pertama akun (perilaku awal
 *   Gelombang 3). Lihat bagian "Pilihan board tujuan Pin" di bawah.
 * - token_type = `pinterest_user_token` (migrasi 0022) +
 *   token_expires_at dari `expires_in` grant — dasar lifecycle.
 *
 * Pinterest BUKAN channel inbox: tidak ada webhook/pesan di sini.
 * Baris akun yang terhubung otomatis menjadi sasaran /posts lewat
 * materialisasi `ensureTimelineTargets` (posts.ts) — bentuknya
 * persis akun Gelombang 3, jadi tidak ada perubahan di posts.
 */

/** Varian token Pinterest (lihat channelTokenTypeEnum di skema db). */
export type PinterestChannelTokenType = "pinterest_user_token";

export interface CreatePinterestChannelInput {
  /** Id akun Pinterest pemilik token (dari `GET /v5/user_account`). */
  accountExternalId: string;
  /** Username Pinterest (`username` user_account); null bila kosong. */
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

export async function createPinterestChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreatePinterestChannelInput,
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: "pinterest",
        externalId: input.accountExternalId,
        displayName: input.publicHandle,
        status: "connected",
        accessTokenEncrypted: input.encryptedAccessToken,
        refreshTokenEncrypted: input.encryptedRefreshToken,
        publicHandle: input.publicHandle,
        // Lifecycle token: varian + jadwal kedaluwarsa tersimpan saat
        // connect; token baru selalu dimulai sehat & bersih.
        tokenType: "pinterest_user_token",
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
        provider: "pinterest",
        publicHandle: input.publicHandle,
      },
    });

    return row;
  });
}

export interface UpdatePinterestCredentialsInput {
  /** Envelope enkripsi access token baru; undefined = jangan ubah. */
  encryptedAccessToken?: string;
  /** Envelope enkripsi refresh token baru; undefined = jangan ubah. */
  encryptedRefreshToken?: string | null;
  publicHandle?: string | null;
  status?: ChannelAccount["status"];
  /** Kedaluwarsa token baru; undefined = jangan ubah. */
  tokenExpiresAt?: Date | null;
  /** Waktu refresh token terakhir; undefined = jangan ubah. */
  tokenRefreshedAt?: Date | null;
  /** Kode error koneksi; undefined = jangan ubah. */
  errorCode?: string | null;
}

/**
 * Menulis ulang kredensial/status akun Pinterest yang SUDAH ada di
 * tenant ini — jalur "revive" connect OAuth (pola
 * `updateTikTokChannelAccountCredentials`): akun berstatus
 * 'disconnected'/'error' dihubungkan lagi tanpa baris duplikat.
 * Menghubungkan lagi selalu mengeluarkan akun dari Sampah.
 */
export async function updatePinterestChannelAccountCredentials(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  input: UpdatePinterestCredentialsInput,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = { updatedAt: new Date() };
    if (input.encryptedAccessToken !== undefined) {
      patch.accessTokenEncrypted = input.encryptedAccessToken;
      // Kredensial baru = siklus token dimulai ulang: varian tetap
      // pinterest_user_token, sehat & bersih.
      patch.tokenType = "pinterest_user_token";
      patch.tokenHealth = "ok";
      patch.errorCode = null;
    }
    if (input.encryptedRefreshToken !== undefined) {
      patch.refreshTokenEncrypted = input.encryptedRefreshToken;
    }
    if (input.publicHandle !== undefined) {
      patch.publicHandle = input.publicHandle;
      // Nama tampilan akun Pinterest adalah username-nya (lihat
      // header modul); segarkan keduanya bersama.
      patch.displayName = input.publicHandle;
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
// Pilihan board tujuan Pin (pemilih board — lanjutan Gelombang 3)
// ---------------------------------------------------------------------------

/** Pilihan board tujuan Pin yang tersimpan untuk satu akun Pinterest. */
export interface PinterestBoardChoice {
  /** Id board API v5 (dari `GET /v5/boards` akun itu sendiri). */
  boardId: string;
  /** Snapshot nama board saat pilihan disimpan; null bila tak terbaca. */
  boardName: string | null;
}

/**
 * Baca pilihan board akun Pinterest. Mengembalikan null bila akun
 * tidak ada / bukan Pinterest / belum memilih — ketiganya bermakna
 * sama bagi penerbit: pakai board pertama akun (perilaku awal
 * Gelombang 3, didokumentasikan di kolom skema).
 */
export async function getPinterestBoardChoice(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
): Promise<PinterestBoardChoice | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        provider: channelAccounts.provider,
        boardId: channelAccounts.pinterestBoardId,
        boardName: channelAccounts.pinterestBoardName,
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
        ),
      )
      .limit(1);
    if (!row || row.provider !== "pinterest" || !row.boardId) return null;
    return { boardId: row.boardId, boardName: row.boardName };
  });
}

/**
 * Simpan (atau bersihkan, dengan `choice = null`) pilihan board
 * akun Pinterest + snapshot namanya, dan catat audit TANPA data
 * sensitif (id & nama board adalah data tampil akun itu sendiri).
 * Validasi bahwa board benar-benar milik akun adalah urusan
 * pemanggil (endpoint API memvalidasinya ke `GET /v5/boards`
 * sebelum memanggil ini). Mengembalikan baris akun terbaru, atau
 * null bila akun tidak ada di tenant ini / bukan Pinterest.
 */
export async function setPinterestBoardChoice(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  channelAccountId: string,
  choice: PinterestBoardChoice | null,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .update(channelAccounts)
      .set({
        pinterestBoardId: choice?.boardId ?? null,
        pinterestBoardName: choice?.boardName ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(channelAccounts.tenantId, ctx.tenantId),
          eq(channelAccounts.id, channelAccountId),
          eq(channelAccounts.provider, "pinterest"),
        ),
      )
      .returning();
    if (!row) return null;

    await tx.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorType: "user",
      actorId: ctx.userId,
      action: "channel.pinterest_board_updated",
      meta: {
        channelAccountId: row.id,
        provider: "pinterest",
        pinterestBoardId: choice?.boardId ?? null,
        pinterestBoardName: choice?.boardName ?? null,
      },
    });

    return row;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle token Pinterest: pindai + keputusan (penyegaran di worker)
// ---------------------------------------------------------------------------

/** Ref hasil pemindaian lifecycle token Pinterest (bentuk minimal worker). */
export interface PinterestTokenLifecycleRef {
  tenantId: string;
  channelAccountId: string;
  provider: "pinterest";
  externalId: string;
  tokenType: PinterestChannelTokenType | null;
  tokenExpiresAt: Date;
  tokenRefreshedAt: Date | null;
  /** Envelope access token terenkripsi — worker yang mendekripsi. */
  accessTokenEncrypted: string | null;
  /** Envelope refresh token terenkripsi — worker yang mendekripsi. */
  refreshTokenEncrypted: string | null;
}

/**
 * Keputusan worker lifecycle Pinterest untuk SATU akun (fungsi
 * murni):
 * - varian `pinterest_user_token` + refresh token tersimpan +
 *   konfigurasi refresh lengkap (app id + app secret aplikasi dari
 *   Panel Admin untuk Basic auth token endpoint + kunci enkripsi
 *   channel) → "refresh" (grant `refresh_token` API v5);
 * - selain itu → "warn": worker hanya menandai kesehatan supaya
 *   pemilik menghubungkan ulang sebelum token mati.
 * Kesehatan: sudah lewat jadwal → "expired", mendekati → "expiring".
 */
export function pinterestTokenLifecycleDecision(input: {
  tokenType: PinterestChannelTokenType | null;
  tokenExpiresAt: Date;
  now: Date;
  canRefresh: boolean;
  hasRefreshToken: boolean;
}): { action: "refresh" | "warn"; health: "expiring" | "expired" } {
  const refreshable =
    input.tokenType === "pinterest_user_token" && input.hasRefreshToken;
  return {
    action: refreshable && input.canRefresh ? "refresh" : "warn",
    health: input.tokenExpiresAt <= input.now ? "expired" : "expiring",
  };
}

/**
 * Pindai akun Pinterest AKTIF lintas tenant yang access token-nya
 * mendekati atau sudah melewati kedaluwarsa. Memakai lengan RLS
 * yang sama dengan pemindaian Meta/Threads/TikTok
 * (`meta_token_lifecycle_scan`, migrasi 0001) — saringan provider
 * hidup di kueri. Penulisan hasil lewat konteks tenant
 * masing-masing (applyMetaTokenLifecycleUpdate — penulis generik
 * kolom lifecycle, dipakai bersama; lihat worker).
 */
export async function listExpiringPinterestTokens(
  db: Database,
  opts: { withinDays?: number; limit?: number; now?: Date } = {},
): Promise<PinterestTokenLifecycleRef[]> {
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
          eq(channelAccounts.provider, "pinterest"),
          eq(channelAccounts.status, "connected"),
          isNotNull(channelAccounts.tokenExpiresAt),
          lte(channelAccounts.tokenExpiresAt, deadline),
        ),
      )
      .orderBy(asc(channelAccounts.tokenExpiresAt))
      .limit(opts.limit ?? 100);
    return rows.map((r) => ({
      ...r,
      provider: "pinterest" as const,
      tokenType: (r.tokenType ?? null) as PinterestChannelTokenType | null,
      // Guard tipe: WHERE sudah menjamin tokenExpiresAt tak null.
      tokenExpiresAt: r.tokenExpiresAt as Date,
    }));
  });
}
