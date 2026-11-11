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
 * Service domain LinkedIn (gelombang Semua OAuth — connect memakai
 * OAuth LinkedIn dengan kredensial aplikasi dari Panel Admin).
 *
 * Model akun (sama seperti yang diasumsikan adapter penerbit
 * Gelombang 3 sejak awal):
 * - provider `linkedin`; external_id = member ID LinkedIn (klaim
 *   `sub` profil OIDC) — adapter menyusun author
 *   `urn:li:person:{external_id}` dari nilai ini. Sasaran connect
 *   SELALU profil pribadi: Company Page membutuhkan program
 *   Community Management terpisah dan tidak dibangun (lihat
 *   OWNER-ACTIONS).
 * - Access token OAuth (scope `openid profile w_member_social`)
 *   berumur ±60 hari tersimpan TERENKRIPSI di
 *   `access_token_encrypted`. TIDAK ada refresh token: LinkedIn
 *   tidak menerbitkannya untuk program standar, jadi
 *   `refresh_token_encrypted` selalu NULL untuk provider ini —
 *   kejujuran itu bagian dari model, bukan kekurangan yang ditutupi.
 * - public_handle tidak dipakai LinkedIn (profil OIDC tidak memberi
 *   vanity URL di scope ini); display_name = nama profil OIDC.
 * - token_type = `linkedin_user_token` (migrasi 0022) +
 *   token_expires_at dari `expires_in` grant — dasar lifecycle
 *   tandai-reconnect.
 *
 * LinkedIn BUKAN channel inbox: tidak ada webhook/pesan di sini.
 * Baris akun yang terhubung otomatis menjadi sasaran /posts lewat
 * materialisasi `ensureTimelineTargets` (posts.ts) — bentuknya
 * persis akun Gelombang 3, jadi tidak ada perubahan di posts.
 */

/** Varian token LinkedIn (lihat channelTokenTypeEnum di skema db). */
export type LinkedInChannelTokenType = "linkedin_user_token";

export interface CreateLinkedInChannelInput {
  /** Member ID LinkedIn (klaim `sub` profil OIDC /v2/userinfo). */
  accountExternalId: string;
  /** Nama profil OIDC (`name`); null bila kosong. */
  profileName: string | null;
  /** Envelope enkripsi access token — BUKAN token mentah. */
  encryptedAccessToken: string;
  /**
   * Kedaluwarsa access token dari `expires_in` grant; null =
   * provider tidak melaporkannya — disimpan jujur sebagai tanpa
   * expiry (tidak dipindai lifecycle), bukan ditebak.
   */
  tokenExpiresAt?: Date | null;
}

export async function createLinkedInChannelAccount(
  db: Database,
  ctx: Pick<TenantContext, "tenantId" | "userId"> & { userId: string },
  input: CreateLinkedInChannelInput,
): Promise<ChannelAccount> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        tenantId: ctx.tenantId,
        provider: "linkedin",
        externalId: input.accountExternalId,
        displayName: input.profileName,
        status: "connected",
        accessTokenEncrypted: input.encryptedAccessToken,
        // Selalu NULL untuk LinkedIn (lihat header modul).
        refreshTokenEncrypted: null,
        publicHandle: null,
        // Lifecycle token: varian + jadwal kedaluwarsa tersimpan saat
        // connect; token baru selalu dimulai sehat & bersih.
        tokenType: "linkedin_user_token",
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
      // Metadata aman: nama memang dari profil; token tidak dicatat.
      meta: {
        channelAccountId: row.id,
        provider: "linkedin",
        profileName: input.profileName,
      },
    });

    return row;
  });
}

export interface UpdateLinkedInCredentialsInput {
  /** Envelope enkripsi access token baru; undefined = jangan ubah. */
  encryptedAccessToken?: string;
  /** Nama profil terbaru; undefined = jangan ubah. */
  profileName?: string | null;
  status?: ChannelAccount["status"];
  /** Kedaluwarsa token baru; undefined = jangan ubah. */
  tokenExpiresAt?: Date | null;
  /** Kode error koneksi; undefined = jangan ubah. */
  errorCode?: string | null;
}

/**
 * Menulis ulang kredensial/status akun LinkedIn yang SUDAH ada di
 * tenant ini — jalur "revive" connect OAuth (pola
 * `updateTikTokChannelAccountCredentials`): akun berstatus
 * 'disconnected'/'error' dihubungkan lagi tanpa baris duplikat.
 * Menghubungkan lagi selalu mengeluarkan akun dari Sampah.
 */
export async function updateLinkedInChannelAccountCredentials(
  db: Database,
  ctx: Pick<TenantContext, "tenantId">,
  channelAccountId: string,
  input: UpdateLinkedInCredentialsInput,
): Promise<ChannelAccount | null> {
  return withTenantDb(db, ctx.tenantId, async (tx) => {
    const patch: Partial<ChannelAccount> = { updatedAt: new Date() };
    if (input.encryptedAccessToken !== undefined) {
      patch.accessTokenEncrypted = input.encryptedAccessToken;
      // Kredensial baru = siklus token dimulai ulang: varian tetap
      // linkedin_user_token, sehat & bersih.
      patch.tokenType = "linkedin_user_token";
      patch.tokenHealth = "ok";
      patch.errorCode = null;
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
// Lifecycle token LinkedIn: TANDAI-RECONNECT (tidak ada refresh)
// ---------------------------------------------------------------------------

/** Kode error koneksi saat token LinkedIn melewati kedaluwarsanya. */
export const LINKEDIN_TOKEN_EXPIRED_ERROR_CODE = "linkedin_token_expired";

/** Ref hasil pemindaian lifecycle token LinkedIn (bentuk minimal worker). */
export interface LinkedInTokenLifecycleRef {
  tenantId: string;
  channelAccountId: string;
  provider: "linkedin";
  externalId: string;
  tokenType: LinkedInChannelTokenType | null;
  tokenExpiresAt: Date;
  tokenRefreshedAt: Date | null;
}

/**
 * Keputusan worker lifecycle LinkedIn untuk SATU akun (fungsi
 * murni). LinkedIn TIDAK menerbitkan refresh token untuk program
 * standar — tidak ada grant yang bisa dipanggil — jadi satu-satunya
 * aksi yang jujur adalah "warn" (tandai kesehatan):
 * - belum kedaluwarsa tetapi masuk jendela peringatan → kesehatan
 *   "expiring": UI meminta hubungkan ulang SEBELUM token mati;
 * - sudah melewati jadwal → kesehatan "expired": runner sekaligus
 *   memindahkan akun ke status 'error' dengan kode
 *   `linkedin_token_expired` (markChannelAccountAuthError — pola
 *   mesin lifecycle menandai akun yang harus dihubungkan ulang),
 *   karena token mati tidak akan pernah bisa menerbitkan lagi.
 * Tipe pengembalian sengaja hanya "warn" agar tidak ada jalur kode
 * yang berpura-pura me-refresh LinkedIn.
 */
export function linkedinTokenLifecycleDecision(input: {
  tokenType: LinkedInChannelTokenType | null;
  tokenExpiresAt: Date;
  now: Date;
}): { action: "warn"; health: "expiring" | "expired" } {
  return {
    action: "warn",
    health: input.tokenExpiresAt <= input.now ? "expired" : "expiring",
  };
}

/**
 * Pindai akun LinkedIn AKTIF lintas tenant yang tokennya mendekati
 * atau sudah melewati kedaluwarsa. Memakai lengan RLS yang sama
 * dengan pemindaian Meta/Threads/TikTok/Pinterest
 * (`meta_token_lifecycle_scan`, migrasi 0001) — saringan provider
 * hidup di kueri. Penulisan hasil lewat konteks tenant
 * masing-masing (applyMetaTokenLifecycleUpdate + penandaan
 * auth-error; lihat worker).
 */
export async function listExpiringLinkedInTokens(
  db: Database,
  opts: { withinDays?: number; limit?: number; now?: Date } = {},
): Promise<LinkedInTokenLifecycleRef[]> {
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
      })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.provider, "linkedin"),
          eq(channelAccounts.status, "connected"),
          isNotNull(channelAccounts.tokenExpiresAt),
          lte(channelAccounts.tokenExpiresAt, deadline),
        ),
      )
      .orderBy(asc(channelAccounts.tokenExpiresAt))
      .limit(opts.limit ?? 100);
    return rows.map((r) => ({
      ...r,
      provider: "linkedin" as const,
      tokenType: (r.tokenType ?? null) as LinkedInChannelTokenType | null,
      // Guard tipe: WHERE sudah menjamin tokenExpiresAt tak null.
      tokenExpiresAt: r.tokenExpiresAt as Date,
    }));
  });
}
